import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const MODES = new Set(['off', 'balanced', 'manual'])

function cleanBotNames (values) {
  return [...new Set((values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))]
}

function proxyLabel (proxy) {
  return proxy.name || `${proxy.host}:${proxy.port}`
}

function normalizeProxy (value, previousById) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('each proxy must be an object')
  const id = String(value.id ?? '').trim()
  const host = String(value.host ?? '').trim()
  const port = Number(value.port)
  if (!id) throw new Error('proxy id is required')
  if (!host) throw new Error(`proxy ${id}: host is required`)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`proxy ${id}: port must be an integer from 1 to 65535`)
  const previous = previousById.get(id)
  let password = previous?.password ?? ''
  if (value.clearPassword === true) password = ''
  else if (Object.hasOwn(value, 'password')) password = String(value.password ?? '')
  return {
    id,
    name: String(value.name ?? '').trim() || `${host}:${port}`,
    host,
    port,
    username: String(value.username ?? '').trim(),
    password,
    enabled: value.enabled !== false
  }
}

function normalizeState (input, previous = { proxies: [] }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('proxy settings must be an object')
  const mode = String(input.mode ?? 'off').trim().toLowerCase()
  if (!MODES.has(mode)) throw new Error('proxy mode must be off, balanced, or manual')
  const previousById = new Map((previous.proxies ?? []).map((proxy) => [proxy.id, proxy]))
  if (!Array.isArray(input.proxies ?? [])) throw new Error('proxies must be an array')
  const proxies = (input.proxies ?? []).map((proxy) => normalizeProxy(proxy, previousById))
  const ids = new Set()
  for (const proxy of proxies) {
    if (ids.has(proxy.id)) throw new Error(`duplicate proxy id: ${proxy.id}`)
    ids.add(proxy.id)
  }
  const enabledIds = new Set(proxies.filter((proxy) => proxy.enabled).map((proxy) => proxy.id))
  if (mode !== 'off' && enabledIds.size === 0) throw new Error(`${mode} mode requires at least one enabled proxy`)
  const rawAssignments = input.assignments ?? {}
  if (!rawAssignments || typeof rawAssignments !== 'object' || Array.isArray(rawAssignments)) throw new Error('proxy assignments must be an object')
  const assignments = Object.create(null)
  for (const [rawBot, rawProxyId] of Object.entries(rawAssignments)) {
    const bot = String(rawBot ?? '').trim()
    const proxyId = String(rawProxyId ?? '').trim()
    if (!bot || !proxyId) continue
    if (!enabledIds.has(proxyId)) throw new Error(`bot ${bot}: assignment references an unknown or disabled proxy (${proxyId})`)
    assignments[bot] = proxyId
  }
  return { version: 1, mode, proxies, assignments }
}

function planRoutes (state, botNames) {
  const plan = new Map()
  if (state.mode !== 'balanced') return plan
  const proxies = state.proxies.filter((proxy) => proxy.enabled)
  const bots = cleanBotNames(botNames)
  for (let i = 0; i < bots.length; i++) plan.set(bots[i], proxies[i % proxies.length].id)
  return plan
}

function publicProxy (proxy) {
  return {
    id: proxy.id,
    name: proxy.name,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    enabled: proxy.enabled,
    hasPassword: !!proxy.password
  }
}

function proxyFailureText (error) {
  return String(error?.message ?? error?.reason ?? error?.text ?? error ?? '').toLowerCase()
}

function globalProxyFailure (error) {
  const code = String(error?.code ?? error?.errno ?? '').toUpperCase()
  if (['EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(code)) return true
  return /socks5|dns|timed? out|timeout|socket ?closed|connection reset|connection refused|network unreachable|host unreachable|eai_again|enotfound/.test(proxyFailureText(error))
}

function transientProxyFailure (error) {
  // A server verification challenge is not evidence that the SOCKS route is unhealthy.
  // Rotating the account to another exit after a challenge can create a new connection identity
  // and makes a manual verification less predictable. Verification is handled by Fleet hold.
  return globalProxyFailure(error)
}

export class ProxyManager {
  static async open ({ file, botNames = [] } = {}) {
    if (!file) throw new Error('proxy file is required')
    let raw = { version: 1, mode: 'off', proxies: [], assignments: {} }
    try {
      raw = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`cannot read proxy settings: ${error.message}`, { cause: error })
    }
    const state = normalizeState(raw)
    return new ProxyManager({ file, state, botNames })
  }

  constructor ({ file, state, botNames = [] }) {
    this.file = file
    this.state = state
    this.botNames = cleanBotNames(botNames)
    this.plan = planRoutes(this.state, this.botNames)
    this.saveChain = Promise.resolve()
    this.routeOffsets = new Map()
    this.failures = new Map()
    this.proxyFailures = new Map()
  }

  setBotNames (botNames) {
    this.botNames = cleanBotNames(botNames)
    this.plan = planRoutes(this.state, this.botNames)
    const keep = new Set(this.botNames)
    for (const bot of this.routeOffsets.keys()) if (!keep.has(bot)) this.routeOffsets.delete(bot)
    for (const key of this.failures.keys()) if (!keep.has(key.split('\u0000')[0])) this.failures.delete(key)
  }

  #failureKey (bot, proxyId) {
    return `${bot}\u0000${proxyId}`
  }

  routeFor (username) {
    const bot = String(username ?? '').trim()
    if (this.state.mode === 'off') return { kind: 'direct', mode: 'off', blocked: false, proxy: null }
    if (this.state.mode === 'manual') {
      const proxyId = this.state.assignments[bot]
      const proxy = this.state.proxies.find((candidate) => candidate.id === proxyId && candidate.enabled)
      if (!proxy) return { kind: 'blocked', mode: this.state.mode, blocked: true, proxy: null, reason: `SOCKS5 manual mode: no enabled proxy assigned to ${bot || 'this bot'}` }
      return { kind: 'proxy', mode: this.state.mode, blocked: false, proxy: { ...proxy } }
    }
    const proxies = this.state.proxies.filter((proxy) => proxy.enabled)
    const baseId = this.plan.get(bot)
    const foundBase = proxies.findIndex((proxy) => proxy.id === baseId)
    const base = foundBase >= 0 ? foundBase : 0
    const now = Date.now()
    const healthy = proxies.filter((proxy) => {
      const local = this.failures.get(this.#failureKey(bot, proxy.id))
      const global = this.proxyFailures.get(proxy.id)
      return (!local || local.retryAt <= now) && (!global || global.retryAt <= now)
    })
    if (healthy.length) {
      const baseProxy = proxies[base]
      const baseHealthy = healthy.find((proxy) => proxy.id === baseProxy.id)
      if (baseHealthy && !this.routeOffsets.has(bot)) {
        return { kind: 'proxy', mode: this.state.mode, blocked: false, proxy: { ...baseHealthy } }
      }
      const botIndex = Math.max(0, this.botNames.indexOf(bot))
      const groupIndex = Math.floor(botIndex / Math.max(1, proxies.length))
      const proxy = healthy[groupIndex % healthy.length]
      return { kind: 'proxy', mode: this.state.mode, blocked: false, proxy: { ...proxy } }
    }
    const retryAt = Math.min(...proxies.map((proxy) => {
      const local = this.failures.get(this.#failureKey(bot, proxy.id))?.retryAt ?? now
      const global = this.proxyFailures.get(proxy.id)?.retryAt ?? now
      return Math.max(local, global)
    }))
    return {
      kind: 'blocked',
      mode: this.state.mode,
      blocked: true,
      proxy: null,
      reason: `SOCKS5 balanced mode: every proxy for ${bot || 'this bot'} is cooling down for ${Math.max(1, Math.ceil((retryAt - now) / 1000))}s`
    }
  }

  reportFailure (username, route, error) {
    if (this.state.mode !== 'balanced' || route?.kind !== 'proxy' || !route.proxy || !transientProxyFailure(error)) return false
    const bot = String(username ?? '').trim()
    const key = this.#failureKey(bot, route.proxy.id)
    const previous = this.failures.get(key)
    const count = (previous?.count ?? 0) + 1
    const delay = Math.min(30000, 2000 * (2 ** Math.min(count - 1, 4)))
    this.failures.set(key, { count, retryAt: Date.now() + delay })
    if (globalProxyFailure(error)) {
      const globalPrevious = this.proxyFailures.get(route.proxy.id)
      const globalCount = (globalPrevious?.count ?? 0) + 1
      const globalDelay = Math.min(300000, 5000 * (2 ** Math.min(globalCount - 1, 6)))
      this.proxyFailures.set(route.proxy.id, { count: globalCount, retryAt: Date.now() + globalDelay })
    }
    const enabled = this.state.proxies.filter((proxy) => proxy.enabled)
    if (enabled.length > 1) this.routeOffsets.set(bot, (this.routeOffsets.get(bot) ?? 0) + 1)
    return true
  }

  reportSuccess (username, route) {
    if (route?.kind !== 'proxy' || !route.proxy) return false
    const bot = String(username ?? '').trim()
    this.failures.delete(this.#failureKey(bot, route.proxy.id))
    this.proxyFailures.delete(route.proxy.id)
    this.routeOffsets.delete(bot)
    return true
  }

  publicState (botNames = this.botNames) {
    const names = cleanBotNames(botNames)
    return {
      mode: this.state.mode,
      proxies: this.state.proxies.map(publicProxy),
      assignments: { ...this.state.assignments },
      routes: names.map((bot) => this.publicRouteFor(bot))
    }
  }

  publicRouteFor (username) {
    const bot = String(username ?? '').trim()
    const route = this.routeFor(bot)
    return route.kind === 'proxy'
      ? {
          bot,
          kind: route.kind,
          mode: route.mode,
          proxyId: route.proxy.id,
          proxyName: proxyLabel(route.proxy),
          address: `${route.proxy.host}:${route.proxy.port}`,
          blocked: false
        }
      : {
          bot,
          kind: route.kind,
          mode: route.mode,
          proxyId: null,
          proxyName: null,
          address: null,
          blocked: route.kind === 'blocked',
          reason: route.reason ?? null
        }
  }

  replace (input, botNames = this.botNames) {
    const run = async () => {
      const nextBotNames = cleanBotNames(botNames)
      const candidate = normalizeState(input, this.state)
      const candidatePlan = planRoutes(candidate, nextBotNames)
      await this.#write(candidate)
      this.state = candidate
      this.botNames = nextBotNames
      this.plan = candidatePlan
      this.routeOffsets.clear()
      this.failures.clear()
      this.proxyFailures.clear()
      return this.publicState()
    }
    this.saveChain = this.saveChain.then(run, run)
    return this.saveChain
  }

  async #write (state) {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, this.file)
  }
}
