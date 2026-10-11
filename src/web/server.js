// server.js — the mcbotctl web console.
//
// NO WebSocket and NO new dependency. Server -> client is SSE (one direction, which is all
// this needs); client -> server is a plain POST. The Node standard library does the rest.
// That is the "lightest stack" choice the project asked for, and it means the console costs
// zero packages and runs inside the same process as the bots.

import { createServer } from 'node:http'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'
import { EV } from '../bus.js'
import { S } from '../fsm.js'
import { applyCommands } from '../config/load.js'
import { parseAccounts, formatAccounts, generateAccounts } from '../accounts.js'
import { defaultPartyPlan, masterPartyPlan } from '../behaviour/party.js'
import { parseAddress } from '../runtime.js'
import { sneakBridge } from '../behaviour/bridge.js'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
}

// Only forward the topics an operator can act on. Forwarding everything floods SSE with
// per-tick noise and buries the lines that matter.
const FORWARD = new Set([
  EV.MC_CHAT, EV.MC_SENT, EV.MC_KICK, EV.MC_DISCONNECT, EV.MC_END, EV.MC_WARN, EV.MC_ERROR,
  EV.CMD_RESULT, EV.BOT_STATE, EV.BOT_READY, EV.AUTH_OK, EV.AUTH_FAIL, EV.AUTH_PROMPT,
  EV.FLEET_PHASE, EV.FLEET_DONE, EV.BUS_ERROR,
  EV.MC_WINDOW_OPEN, EV.MC_WINDOW_CLOSE, 'menu:state', 'menu:result', 'party:full',
  'bedwars:state', 'combat:state', 'combat:attack', 'match:debug', EV.AUTOPLAY_STATE, EV.ACTION_LEASE
])

// Keep the Bots card useful without copying an arbitrary server message (which can echo a
// command or credential) into the state API. The unabridged transport event stays in Log.
function disconnectSummary (event) {
  const socket = event.socket ?? {}
  // Do not expose the raw error text on the card: a server can echo a command there. It is only
  // used for classification alongside the first TCP event observed by the session trace.
  const evidence = [event.text, event.reason, event.error?.message, socket.errorCode, socket.errorMessage, socket.clientReason]
    .filter((value) => value != null).join(' ').toLowerCase()
  if (/\b(?:wrong|incorrect|invalid) password\b/.test(evidence)) return 'Incorrect login password'
  if (/same username|already playing|duplicate login/.test(evidence)) return 'Account connected elsewhere'
  if (/verify your connection|complete the verification process|v4g\.to/.test(evidence)) return 'Connection verification required'
  if (/too many connections|throttl|anti.?bot/.test(evidence)) return 'Server connection limit'
  if (/spam|too many packets|bad.?packets/.test(evidence)) return 'Server rejected packet rate'
  if (/socks5/.test(evidence)) return 'SOCKS5 proxy connection failed'
  if (/timed? out|timeout|keep.?alive/.test(evidence)) return 'Connection timed out'
  if (/econnreset|connection reset|reset by peer/.test(evidence)) return 'Connection reset'
  if (/bann?ed/.test(evidence)) return 'Account banned by server'
  if (Array.isArray(socket.sequence) && socket.sequence.includes('transport:force-close')) {
    return 'TCP close did not finish; socket was forcibly released'
  }
  if (socket.event === 'timeout') return 'TCP socket timed out'
  if (socket.event === 'error') return socket.errorCode
    ? `TCP socket error (${socket.errorCode})` : 'TCP socket error'
  if (socket.event === 'end') return 'Remote TCP stream ended without a Minecraft kick message'
  if (socket.event === 'close') return socket.hadError
    ? 'TCP socket closed after a transport error'
    : 'TCP socket closed without a Minecraft kick message'
  if (/socketclosed|socket closed|connection closed|closed by/.test(evidence)) return 'Socket closed without a Minecraft kick reason'
  return event.topic === EV.MC_KICK ? 'Kicked by server (see Log)' : 'Disconnected (see Log)'
}

function shouldReplaceDisconnectSummary (previous, next) {
  // A reconnect failure such as "logging in too fast" must not hide an earlier server ban.
  // MC_JOIN clears the record, so a later successful connection is still represented correctly.
  return previous !== 'Account banned by server' || next === 'Account banned by server'
}

function mergeBedwars (base = {}, delta = {}) {
  return {
    ...base, ...delta,
    shop: delta.shop ? { ...(base.shop ?? {}), ...delta.shop } : base.shop,
    presence: delta.presence ? { ...(base.presence ?? {}), ...delta.presence } : base.presence,
    geometry: delta.geometry ? {
      ...(base.geometry ?? {}), ...delta.geometry,
      home: delta.geometry.home
        ? { ...(base.geometry?.home ?? {}), ...delta.geometry.home }
        : base.geometry?.home
    } : base.geometry
  }
}

const ACCOUNTS_HEADER =
  '# Bot accounts, one per line: username:password\n' +
  '# Blank lines and lines starting with # are ignored.\n' +
  '#\n' +
  '# RULES (each one was found by connecting to a live PaperSpigot 1.8.8 server with AuthMe):\n' +
  '#   - AuthMe minNicknameLength defaults to 3: shorter names are disconnected at join with\n' +
  '#     "Your username is either too short or too long!" before the bot reaches PLAY.\n' +
  '#   - Minecraft caps a name at 16 characters of [A-Za-z0-9_].\n' +
  '#   - Duplicate names are a hard error: with offline auth the UUID comes from the name, so\n' +
  '#     two bots sharing one name are one account and the second is refused at login.\n' +
  '#   - Case matters: AuthMe rejects a join whose case differs from the registered name.'

export class WebConsole {
  constructor ({ app, publicDir }) {
    this.app = app
    this.publicDir = publicDir
    this.log = app.log
    this.clients = new Set()
    this.lastLearn = null
    this.running = false
    // Keep the result of the current login attempt, rather than treating READY as proof that
    // AuthMe explicitly accepted /login. READY can also come from the quiet-prompt fallback or
    // from a server with authentication disabled.
    this.authByBot = new Map()
    this.lastDisconnectByBot = new Map()
    this.verificationByBot = new Map()
    app.bus.on('*', (e) => this.#push(e))
    // A party change can happen WITHOUT any HTTP request: the human master kicks someone in
    // game, a member types /p leave, or the server drops a bot mid-party. The tracker sees it on
    // the bus, but the browser only ever re-read state after an API call — so the badge stayed
    // stale exactly when the operator most needed to see the party had lost a member.
    // Throttled, because a disband fans out one event per member.
    this._statePush = null
    const pushState = () => {
      if (this._statePush) return
      this._statePush = setTimeout(async () => {
        this._statePush = null
        try { this.#broadcast('state', await this.#state()) } catch {}
      }, 400)
    }
    app.bus.on(EV.BOT_STATE, (e) => {
      if (e.to === S.CONNECTING || e.to === S.DEAD || e.to === S.DISCONNECTED) {
        this.authByBot.delete(e.botId)
      }
      pushState()
    })
    app.bus.on(EV.AUTH_OK, (e) => {
      const state = e.via === 'quiet' ? 'assumed' : e.via === 'not_required' ? 'not_required' : 'confirmed'
      this.authByBot.set(e.botId, { state, via: e.via })
      pushState()
    })
    app.bus.on(EV.AUTH_FAIL, (e) => {
      this.authByBot.set(e.botId, { state: 'failed', via: null })
      pushState()
    })
    app.bus.on(EV.MC_JOIN, (e) => { this.lastDisconnectByBot.delete(e.botId); this.verificationByBot.delete(e.botId); pushState() })
    for (const topic of [EV.MC_KICK, EV.MC_DISCONNECT, EV.MC_END]) {
      app.bus.on(topic, (e) => {
        const next = disconnectSummary(e)
        const previous = this.lastDisconnectByBot.get(e.botId)
        if (shouldReplaceDisconnectSummary(previous, next)) this.lastDisconnectByBot.set(e.botId, next)
        const evidence = [e.text, e.reason, e.error?.message, e.socket?.errorMessage].filter(Boolean).join(' ')
        const verification = evidence.match(/https:\/\/v4g\.to\/[A-Za-z0-9]+/i)?.[0] ?? null
        if (verification) this.verificationByBot.set(e.botId, verification)
        pushState()
      })
    }
    app.bus.on(EV.FLEET_PHASE, pushState)
    app.bus.on('party:membership', pushState)
    app.bus.on('menu:state', pushState)
    app.bus.on('bedwars:state', pushState)
    app.bus.on('bedwars:presence', pushState)
    // Motion updates arrive at most twice a second per bot. Refresh the state card through the
    // existing 400 ms coalescer instead of forwarding each update as an individual SSE log line.
    app.bus.on('movement:state', pushState)
    app.bus.on('combat:state', pushState)
    app.bus.on(EV.AUTOPLAY_STATE, pushState)
    app.bus.on(EV.ACTION_LEASE, pushState)
  }

  get cfg () { return this.app.cfg }

  /** The bot that should issue a party command.
   *
   *  NOT simply fleet.leader. After a transfer the party is led by the master — a human, not a
   *  fleet bot — so the fleet's nominal leader is no longer the leader of anything and every
   *  command from it comes back "you are not the party leader". So: whoever the tracker says is
   *  leading, if that is one of our bots; otherwise the fleet leader as before. */
  #partyActor (explicit) {
    const fleet = this.app.fleet
    if (explicit) return fleet.bots.find((b) => b.username === explicit)
    const tracker = this.app.runtime.tracker
    const leading = fleet.bots.filter((b) => tracker?.entry(b.username).role === 'leader' && b.isReady())
    if (leading.length) return leading[0]
    if (fleet.leader?.isReady()) return fleet.leader
    // The nominal leader is not up. Any ready bot can invite - it just leads the party it
    // creates - and refusing here left the operator with no control that could form a party at
    // all, because every button resolved its actor back to the same unreachable bot.
    return fleet.bots.find((b) => b.isReady()) ?? fleet.leader
  }

  #push (e) {
    if (!FORWARD.has(e.topic)) return
    const slim = { topic: e.topic, at: e.at, ...e }
    delete slim.seq
    if (e.topic === EV.MC_ERROR && e.error instanceof Error) slim.error = { message: e.error.message }
    if (e.topic === EV.MC_CHAT && typeof slim.raw === 'string' && slim.raw.length > 400) {
      slim.raw = slim.raw.slice(0, 400) + '…'
    }
    this.#broadcast('event', slim)
  }

  #broadcast (name, data) {
    const payload = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of this.clients) { try { res.write(payload) } catch { this.clients.delete(res) } }
  }

  async #accountsText () {
    try { return await readFile(this.app.accountsFile, 'utf8') } catch { return ACCOUNTS_HEADER + '\n' }
  }

  async #state () {
    const fleet = this.app.fleet
    const botNames = fleet.bots.map((bot) => bot.username)
    const proxy = this.app.proxyManager?.publicState(botNames) ?? {
      mode: 'off', proxies: [], assignments: {}, routes: botNames.map((bot) => ({
        bot, kind: 'direct', mode: 'off', proxyId: null, proxyName: null,
        address: null, blocked: false, reason: null
      }))
    }
    const rejoin = fleet.rejoinStatus?.() ?? {
      enabled: !!this.cfg.fleet.rejoinOnKick, blocked: false, cause: null, label: null, detectedAt: null
    }
    return {
      server: { host: this.cfg.server.host, port: this.cfg.server.port, version: this.cfg.server.version },
      fleetCapacity: {
        requested: Number(this.cfg.fleet?.requestedSize ?? fleet.size),
        available: Number(this.cfg.fleet?.availableAccounts ?? fleet.size),
        active: fleet.size
      },
      master: this.cfg.fleet.master ?? '',
      rejoinOnKick: !!this.cfg.fleet.rejoinOnKick,
      rejoin,
      proxy,
      running: this.running,
      auth: { enabled: !!this.cfg.auth?.enabled, strategy: this.cfg.auth?.strategy, register: this.cfg.auth?.register?.enabled !== false },
      bedwars: { enabled: this.cfg.bedwars?.enabled === true, autoStart: this.cfg.bedwars?.autoStart !== false,
        actor: this.cfg.bedwars?.actor ?? fleet.leader?.username ?? null },
      autoplay: {
        enabled: this.cfg.autoplay?.enabled === true,
        autoStart: this.cfg.autoplay?.autoStart === true
      },
      bots: fleet.bots.map((b) => {
        const connected = b.transport?.connected === true && b.fsm.state !== S.DEAD
        const authRecord = this.authByBot.get(b.id)
        const authDetail = !connected ? (b.fsm.state === S.CONNECTING ? 'pending' : 'disconnected')
          : !this.cfg.auth?.enabled ? 'not_required'
            : authRecord?.state === 'not_required' ? 'not_required'
              : b.fsm.state === S.AUTH_FAILED || authRecord?.state === 'failed' ? 'failed'
                : b.isReady() && authRecord?.state === 'confirmed' ? 'confirmed'
                  : b.isReady() && authRecord?.state === 'assumed' ? 'assumed'
                    : 'pending'
        const party = this.app.runtime.tracker?.entry(b.username) ?? { role: 'none', leader: null }
        const bedwarsPresence = this.app.runtime.bedwarsPresence?.stateOf(b.id)
        return {
          name: b.username,
          proxy: b.proxyStatus?.() ?? proxy.routes.find((route) => route.bot === b.username) ?? null,
          state: b.fsm.state,
          ready: b.isReady(),
          protocol: b.protocolState,
          progress: {
            connected,
            authenticated: authDetail === 'confirmed' ? true
              : authDetail === 'assumed' || authDetail === 'not_required' ? null : false,
            authDetail,
            bedwarsJoined: !connected ? false : bedwarsPresence?.joined ?? null,
            bedwarsStage: connected ? bedwarsPresence?.stage ?? null : null,
            bedwarsDetail: !connected ? 'disconnected' : bedwarsPresence?.detail ?? bedwarsPresence?.source ?? null,
            partyJoined: !connected ? false
              : party.role === 'leader' || party.role === 'member' ? true
                : party.confirmedAbsent === true ? false : null,
            lastDisconnectReason: connected ? null : this.lastDisconnectByBot.get(b.id) ?? null,
            verificationUrl: connected ? null : this.verificationByBot.get(b.id) ?? null,
            fleetBlockReason: connected || !rejoin.blocked ? null : rejoin.label
          },
          // Colour contract for the dashboard: green = up and usable, yellow = on the way,
          // red = not in yet (either not started, or it failed and stopped trying).
          party,
          // Whether this bot got through the area gate. A bot that has not is deliberately excluded
          // from the party, so the dashboard has to show why it is standing out.
          menu: this.app.runtime.menu?.stateOf(b.id) ?? { state: 'done', result: null },
          walking: !!this.app.runtime.movement?.isWalking(b.id),
          movement: this.app.runtime.movement?.stateOf(b.id) ?? { state: 'disabled' },
          bedwars: this.app.runtime.bedwars?.stateOf(b.id) ?? { phase: 'idle' },
          autoplay: this.app.runtime.autoplay?.stateOf(b.id) ?? { phase: 'off', task: null },
          actionLease: this.app.runtime.supervisor?.activeOf(b.id) ?? null,
          combat: this.app.runtime.combat?.stateOf(b.id) ?? { state: 'disabled', target: null, reason: null },
          offline: b.offline === true,
          phase: b.isReady() ? 'done'
            : (b.fsm.state === S.CONNECTING || b.fsm.state === S.PLAY || b.fsm.state === S.AUTH) ? 'waiting'
              : 'pending'
        }
      }),
      commands: Object.fromEntries(
        this.app.engine.list().filter((s) => !s.action.startsWith('__')).map((s) => [s.action, {
          template: s.template, timeoutMs: s.timeoutMs, enabled: s.enabled !== false
        }])
      ),
      accounts: await this.#accountsText(),
      patterns: this.cfg.patterns,
      learn: this.lastLearn
    }
  }

  async #body (req) {
    const chunks = []
    for await (const c of req) chunks.push(c)
    if (!chunks.length) return {}
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return null }
  }

  #json (res, code, obj) {
    const s = JSON.stringify(obj)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) })
    res.end(s)
  }

  async #static (res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    const full = join(this.publicDir, normalize(rel))
    if (!full.startsWith(this.publicDir)) { res.writeHead(403).end('forbidden'); return }
    try {
      const buf = await readFile(full)
      res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream' })
      res.end(buf)
    } catch { res.writeHead(404).end('not found') }
  }

  /** Persist ONLY the keys the caller actually changed.
   *
   *  Writing the whole in-memory config over the file was a real regression source: any field
   *  that was stale in memory (the operator edited the file by hand, or another tab had an old
   *  value) got written back on the next unrelated save. That silently reverted two command
   *  templates during development. Now a save of the master's name cannot touch a template. */
  /** Serialised and atomic.
   *
   *  Two saves in flight at once (two tabs, or a script firing changes) each read the file, each
   *  merged their own view and each wrote the whole thing, so the later write dropped the
   *  earlier one's change — or, when the writes interleaved mid-file, left invalid JSON that the
   *  tool could not start from. Writes now queue, and land via rename so the file is never
   *  observed half-written. */
  async #saveConfig (delta = {}) {
    this._saveChain = (this._saveChain ?? Promise.resolve())
      .then(() => this.#doSave(delta), () => this.#doSave(delta))
    return this._saveChain
  }

  async #doSave (delta = {}) {
    const disk = JSON.parse(await readFile(this.app.cfgPath, 'utf8'))
    for (const [action, spec] of Object.entries(delta.commands ?? {})) {
      disk.commands = disk.commands ?? {}
      disk.commands[action] = { ...(disk.commands[action] ?? {}), ...spec }
    }
    if (delta.patterns) disk.patterns = { ...(disk.patterns ?? {}), ...delta.patterns }
    if (delta.master !== undefined || delta.masterAcceptWaitMs !== undefined) {
      disk.fleet = { ...(disk.fleet ?? {}) }
      if (delta.master !== undefined) disk.fleet.master = String(delta.master).trim()
      if (delta.masterAcceptWaitMs !== undefined) disk.fleet.masterAcceptWaitMs = delta.masterAcceptWaitMs
    }
    if (delta.server) disk.server = { ...(disk.server ?? {}), host: delta.server.host, port: delta.server.port }
    if (delta.menu) disk.menu = { ...(disk.menu ?? {}), ...delta.menu }
    if (delta.movement) disk.movement = { ...(disk.movement ?? {}), ...delta.movement }
    if (delta.bridge) disk.bridge = { ...(disk.bridge ?? {}), ...delta.bridge }
    if (delta.bedwars) disk.bedwars = mergeBedwars(disk.bedwars, delta.bedwars)
    const tmp = `${this.app.cfgPath}.tmp`
    await writeFile(tmp, JSON.stringify(disk, null, 2) + '\n')
    await rename(tmp, this.app.cfgPath)
  }

  #handler (req, res) {
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname

    if (req.method === 'GET' && p === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      })
      res.write('retry: 2000\n\n')
      this.clients.add(res)
      this.#state().then((s) => res.write(`event: state\ndata: ${JSON.stringify(s)}\n\n`))
      req.on('close', () => this.clients.delete(res))
      return
    }

    if (req.method === 'GET' && p === '/api/state') {
      return this.#state().then((s) => this.#json(res, 200, s)).catch((e) => this.#json(res, 500, { error: e.message }))
    }

    if (req.method === 'POST' && p === '/api/bedwars') {
      return this.#body(req).then(async (b) => {
        if (!b || !['start', 'stop'].includes(b.action)) return this.#json(res, 400, { error: 'action must be start or stop' })
        const fleet = this.app.fleet
        const name = b.bot ?? this.cfg.bedwars?.actor
        const bot = name ? fleet.bots.find((x) => x.username === name) : fleet.leader
        if (!bot) return this.#json(res, 404, { error: `BedWars bot ${name ?? '(leader)'} is not in the fleet` })
        const bedwars = this.app.runtime.bedwars
        if (b.action === 'stop') {
          const stopped = bedwars.stop(bot)
          this.#broadcast('state', await this.#state())
          return this.#json(res, 200, { ok: true, stopped, bot: bot.username })
        }
        if (this.running) return this.#json(res, 409, { error: 'wait for the current fleet run to finish' })
        await this.app.runtime.autoplay?.requestStop?.(bot, { source: 'opening sequence', disarm: true })
        const started = bedwars.start(bot)
        this.#broadcast('state', await this.#state())
        return this.#json(res, started.ok ? 202 : 409, started)
      }).catch((e) => this.#json(res, 500, { error: e.message }))
    }

    // The dashboard and the in-game `=play` command both call the same public autoplay API.
    // Starting only arms a bot; the engine itself waits for positive match evidence before it
    // obtains any movement or inventory controls.
    if (req.method === 'POST' && p === '/api/autoplay') {
      return this.#body(req).then(async (b) => {
        if (!b || !['start', 'stop'].includes(b.action)) {
          return this.#json(res, 400, { error: 'action must be start or stop' })
        }
        const autoplay = this.app.runtime.autoplay
        if (!autoplay) return this.#json(res, 500, { error: 'autoplay is not wired' })
        const requested = String(b.bot ?? 'all').trim()
        const targets = !requested || requested.toLowerCase() === 'all'
          ? this.app.fleet.bots
          : this.app.fleet.bots.filter((bot) => bot.username.toLowerCase() === requested.toLowerCase())
        if (!targets.length) return this.#json(res, 404, { error: `no such bot: ${requested}` })
        const method = b.action === 'start' ? 'requestStart' : 'requestStop'
        if (typeof autoplay[method] !== 'function') return this.#json(res, 500, { error: `autoplay does not provide ${method}` })
        const results = []
        for (const bot of targets) {
          const result = await autoplay[method](bot, {
            source: 'dashboard', ...(b.action === 'start' ? { arm: true, force: b.force === true } : { disarm: true })
          })
          results.push({ bot: bot.username, ...(result ?? { ok: false, error: 'empty autoplay response' }) })
        }
        this.#broadcast('state', await this.#state())
        const accepted = results.filter((result) => result.ok).length
        return this.#json(res, accepted ? 202 : 409, { ok: accepted === results.length, action: b.action, results })
      }).catch((e) => this.#json(res, 500, { error: e.message }))
    }

    // ---- SOCKS5 proxy pool and per-bot routing ----
    if (req.method === 'POST' && p === '/api/proxies') {
      if (!this.app.proxyManager) return this.#json(res, 500, { error: 'proxy manager is not available' })
      if (this.running) return this.#json(res, 409, { error: 'wait for the current fleet operation to finish' })
      this.running = true
      return this.#body(req).then(async (b) => {
        if (!b) {
          this.running = false
          return this.#json(res, 400, { error: 'invalid JSON' })
        }
        if (typeof b.mode !== 'string' || !Array.isArray(b.proxies)) {
          this.running = false
          return this.#json(res, 400, { error: 'mode and proxies are required' })
        }
        const reconnect = b.reconnect === true
        const rejoin = this.app.fleet.rejoinStatus?.()
        if (reconnect && rejoin?.blocked) {
          this.running = false
          return this.#json(res, 409, { error: rejoin.label })
        }

        const botNames = this.app.fleet.bots.map((bot) => bot.username)
        const proxy = await this.app.proxyManager.replace({
          mode: b.mode,
          proxies: b.proxies,
          assignments: b.assignments
        }, botNames)

        if (!reconnect) {
          this.running = false
          this.#broadcast('state', await this.#state())
          return this.#json(res, 200, { ok: true, proxy, reconnecting: false })
        }

        this.#broadcast('state', await this.#state())
        const fleet = this.app.fleet
        Promise.resolve().then(async () => {
          await this.app.runtime.partyStatus?.prepareDisconnect(fleet.bots)
          return fleet.reconnectAll()
        })
          .then((result) => this.#broadcast('connected', {
            ready: result.ready.length,
            total: fleet.size,
            failed: result.failed,
            proxy: true
          }))
          .catch((error) => this.#broadcast('runerror', { error: error.message }))
          .finally(async () => {
            this.running = false
            this.#broadcast('state', await this.#state())
          })
        return this.#json(res, 202, { ok: true, proxy, reconnecting: true })
      }).catch((error) => {
        this.running = false
        this.#json(res, 400, { error: error.message })
      })
    }

    // ---- command templates + patterns ----
    if (req.method === 'POST' && p === '/api/config') {
      return this.#body(req).then(async (b) => {
        if (!b) return this.#json(res, 400, { error: 'invalid JSON' })
        const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype'])
        for (const [action, spec] of Object.entries(b.commands ?? {})) {
          // Writing to "__proto__" replaces the prototype of cfg.commands, and a later
          // per-action merge then materialises an inherited spec as a live command.
          if (DANGEROUS.has(action)) continue
          if (!spec || typeof spec !== 'object') continue
          // A non-string template deletes the command at the next start, because applyCommands
          // skips any spec without a string template. Refuse it at the door instead.
          if ('template' in spec && typeof spec.template !== 'string') {
            return this.#json(res, 400, { error: `command "${action}": template must be a string` })
          }
          this.cfg.commands[action] = { ...(this.cfg.commands[action] ?? {}), ...spec }
        }
        if (b.patterns) {
          this.cfg.patterns = { ...this.cfg.patterns, ...b.patterns }
          // Registering them in cfg alone did NOTHING: the classifier resolves a pattern key
          // through the static PATTERNS registry, so an operator-defined key fell through to
          // `new RegExp('myServerKick')` — a literal-string regex that can never match. The
          // documented feature was inert. Publish them into the registry the engine reads.
          const { PATTERNS } = await import('../patterns.js')
          for (const [key, val] of Object.entries(b.patterns)) {
            PATTERNS[key] = typeof val === 'string'
              ? { re: val, kind: 'operator', src: '[OPERATOR] posted to /api/config' }
              : { ...(val ?? {}), src: '[OPERATOR] posted to /api/config' }
          }
        }
        if (b.master !== undefined) this.cfg.fleet.master = String(b.master).trim()
        if (b.masterAcceptWaitMs !== undefined) this.cfg.fleet.masterAcceptWaitMs = Number(b.masterAcceptWaitMs)
        // The menu block has to be merged EXPLICITLY. It was silently dropped here, so every
        // menu setting posted by the dashboard was ignored and the flow kept using the shipped
        // default - the button worked, the numbers did nothing, and nothing said so.
        if (b.menu !== undefined) {
          if (!b.menu || typeof b.menu !== 'object') return this.#json(res, 400, { error: 'menu must be an object' })
          const cur = this.cfg.menu ?? {}
          const next = { ...cur }
          // Every settable key has to be listed here. `enabled` and `gateParty` were missing from
          // this list at first, so turning the gate off from the dashboard did nothing at all —
          // the same silent-ignore that already bit this block once.
          const STRING_KEYS = ['button', 'expectTitle']
          const BOOL_KEYS = ['enabled', 'gateParty']
          for (const k of ['hotbarSlot', 'row', 'col', 'button', 'expectTitle', 'openTimeoutMs', 'settleMs', ...BOOL_KEYS]) {
            if (b.menu[k] === undefined) continue
            next[k] = STRING_KEYS.includes(k) ? String(b.menu[k])
              : BOOL_KEYS.includes(k) ? !!b.menu[k]
                : Number(b.menu[k])
          }
          const num = (k, lo, hi) => {
            if (next[k] === undefined) return null
            if (!Number.isFinite(next[k]) || next[k] < lo || next[k] > hi) return `${k} must be a number between ${lo} and ${hi}, got ${b.menu[k]}`
            return null
          }
          for (const [k, lo, hi] of [['hotbarSlot', 1, 9], ['row', 1, 6], ['col', 1, 9], ['openTimeoutMs', 100, 60000], ['settleMs', 0, 60000]]) {
            const err = num(k, lo, hi)
            if (err) return this.#json(res, 400, { error: err })
          }
          if (!['right', 'left'].includes(next.button)) return this.#json(res, 400, { error: `button must be "right" or "left", got "${next.button}"` })
          this.cfg.menu = next
        }
        if (b.bedwars !== undefined) {
          if (!b.bedwars || typeof b.bedwars !== 'object' || Array.isArray(b.bedwars)) {
            return this.#json(res, 400, { error: 'bedwars must be an object' })
          }
          this.cfg.bedwars = mergeBedwars(this.cfg.bedwars, b.bedwars)
        }
        applyCommands(this.app.engine, this.cfg)
        if (b.persist) {
          await this.#saveConfig({
            commands: b.commands, patterns: b.patterns,
            master: b.master, masterAcceptWaitMs: b.masterAcceptWaitMs, menu: b.menu,
            movement: b.movement, bridge: b.bridge, bedwars: b.bedwars
          })
        }
        this.#broadcast('state', await this.#state())
        this.#json(res, 200, { ok: true })
      }).catch((e) => this.#json(res, 500, { error: e.message }))
    }

    // ---- accounts ----
    if (req.method === 'POST' && p === '/api/accounts/generate') {
      return this.#body(req).then((b) => {
        if (!b) return this.#json(res, 400, { error: 'invalid JSON' })
        const list = generateAccounts({
          count: b.count, prefix: b.prefix, password: b.password, start: b.start
        })
        // Generated, NOT saved: the operator sees the list, edits it if they want, then saves.
        this.#json(res, 200, { accounts: list, text: formatAccounts(list, ACCOUNTS_HEADER) })
      }).catch((e) => this.#json(res, 400, { error: e.message }))
    }

    if (req.method === 'POST' && p === '/api/accounts') {
      return this.#body(req).then(async (b) => {
        if (!b) return this.#json(res, 400, { error: 'invalid JSON' })
        let list
        try { list = parseAccounts(b.text ?? '', 'accounts') }
        catch (e) { return this.#json(res, 400, { error: e.message }) }
        if (b.persist !== false) await writeFile(this.app.accountsFile, b.text)
        let rebuilt = false
        if (b.rebuild) {
          await this.app.rebuild(list)
          this.lastDisconnectByBot.clear()
          this.verificationByBot.clear()
          rebuilt = true
          this.log.info?.(`console: fleet rebuilt with ${list.length} account(s)`)
        }
        this.#broadcast('state', await this.#state())
        this.#json(res, 200, { ok: true, count: list.length, rebuilt })
      }).catch((e) => this.#json(res, 500, { error: e.message }))
    }

    // ---- connect every bot to an address, then register ----
    if (req.method === 'POST' && p === '/api/connect') {
      const rejoin = this.app.fleet.rejoinStatus?.()
      if (rejoin?.blocked && rejoin.cause === 'connection_verification') this.app.fleet.clearRejoinBlock?.('connection_verification')
      else if (rejoin?.blocked) return this.#json(res, 409, { error: rejoin.label })
      // Claimed BEFORE the body is read. Checking after an await let two requests both observe
      // running === false, and both then drive reconnectAll() over the same bots.
      if (this.running) return this.#json(res, 409, { error: 'a run is in progress' })
      this.running = true
      return this.#body(req).then(async (b) => {
        if (!b) { this.running = false; return this.#json(res, 400, { error: 'invalid JSON' }) }
        let addr = null
        let addressChanged = false
        if (b.address !== undefined) {
          try { addr = parseAddress(b.address) }
          catch (e) { this.running = false; return this.#json(res, 400, { error: e.message }) }
          // A bare host silently becomes 25565, and loadConfig REFUSES 25565 on this machine
          // because that port belongs to an unrelated production server. Persisting the guess
          // would write a config the tool cannot start from. Ask for the port instead.
          if (addr.defaulted) {
            this.running = false
            return this.#json(res, 400, {
              error: `"${b.address}" has no port. Write it as host:port — a bare host would be assumed to be 25565, which this tool refuses to use.`
            })
          }
          addressChanged = String(this.cfg.server.host).toLowerCase() !== addr.host.toLowerCase() ||
            Number(this.cfg.server.port) !== addr.port
          this.cfg.server.host = addr.host
          this.cfg.server.port = addr.port
          if (b.persist) await this.#saveConfig({ server: { host: this.cfg.server.host, port: this.cfg.server.port } })
          this.log.info?.(`console: server set to ${addr.host}:${addr.port}`)
        }
        this.#broadcast('state', await this.#state())
        const fleet = this.app.fleet
        // "Join server" is safe to press again for the current address. Only a real server
        // switch needs to close healthy in-game sockets; bringOnline skips bots already up.
        Promise.resolve().then(async () => {
          let result
          if (!addressChanged) result = await fleet.bringOnline()
          else {
            await this.app.runtime.partyStatus?.prepareDisconnect(fleet.bots)
            result = await fleet.reconnectAll()
          }
          if (this.cfg.fleet?.progressiveParty !== false) await this.app.runtime.autoparty?.waitForFull()
          return result
        })
          .then((r) => this.#broadcast('connected', { ready: r.ready.length, total: fleet.size, failed: r.failed, party: true }))
          .catch((e) => this.#broadcast('runerror', { error: e.message }))
          .finally(async () => { this.running = false; this.#broadcast('state', await this.#state()) })
        this.#json(res, 202, {
          ok: true,
          address: `${this.cfg.server.host}:${this.cfg.server.port}`,
          ...(addr?.defaulted ? { note: `no port given, so ${addr.port} was assumed` } : {})
        })
      }).catch((e) => {
        // Every early exit must release the flag. An unreleased one bricks connect AND run
        // permanently: both answer 409 forever, and only a process restart recovers.
        this.running = false
        this.#json(res, 500, { error: e.message })
      })
    }

    // ---- "Learn": send one command from a live bot and capture the raw replies ----
    if (req.method === 'POST' && p === '/api/learn') {
      return this.#body(req).then(async (b) => {
        if (!b) return this.#json(res, 400, { error: 'invalid JSON' })
        const fleet = this.app.fleet
        const named = b.bot ? fleet.bots.find((x) => x.username === b.bot) : null
        if (b.bot && !named) return this.#json(res, 404, { error: `no such bot: ${b.bot}` })
        const bot = named ?? fleet.bots.find((x) => x.isReady())
        if (!bot) return this.#json(res, 409, { error: 'no bot is READY yet — connect first' })
        // Learn puts an arbitrary line on the wire, so it has to pass the same gates as any
        // command: a bot still authenticating must not send, and the per-bot send gap applies
        // or Learn becomes the one control that can trip the server's chat-spam kick.
        if (!bot.isReady()) {
          return this.#json(res, 409, { error: `${bot.username} is ${bot.fsm.state}, not READY — a command now would be cancelled or kicked` })
        }
        if (!bot.sendable()) {
          return this.#json(res, 409, { error: `${bot.username} is not in PLAY (transport ${bot.protocolState})` })
        }
        const text = String(b.text ?? '').trim()
        if (!text) return this.#json(res, 400, { error: 'no command text' })
        const windowMs = Math.min(Math.max(Number(b.windowMs) || 2500, 300), 15000)

        const capture = await this.app.engine.serialize(bot, async () => {
          const lines = []
          const off = this.app.bus.on(EV.MC_CHAT, (e) => {
            if (e.botId !== bot.id) return
            lines.push({ text: e.text, position: e.position, raw: e.raw, at: e.at })
          })
          await new Promise((r) => setTimeout(r, 150))
          await this.app.engine.pace(bot)
          const sent = bot.send(text)
          if (sent) this.app.engine.noteSent(bot)
          await new Promise((r) => setTimeout(r, windowMs))
          off()
          return { lines, sent }
        })

        this.lastLearn = { bot: bot.username, command: text, lines: capture.lines, sent: capture.sent, windowMs }
        this.#broadcast('learn', this.lastLearn)
        this.#json(res, 200, this.lastLearn)
      }).catch((e) => this.#json(res, 500, { error: e.message }))
    }

    // ---- one-shot actions: the buttons on the Party panel ----
    //
    // Deliberately generic. Every button sends {action, actor, target} and is resolved through
    // the same CommandEngine the plan uses, so a button can never do something a plan step
    // could not, and every result is classified and reported identically.
    if (req.method === 'POST' && p === '/api/action') {
      return this.#body(req).then(async (b) => {
        if (!b) return this.#json(res, 400, { error: 'invalid JSON' })
        const fleet = this.app.fleet
        const ready = fleet.bots.filter((x) => x.isReady())
        const leader = fleet.leader

        // p join ... - every OTHER bot runs the accept command with bot 1's name. This is the
        // manual version of what the members do by themselves when they read an invite in chat,
        // and it is the button to reach for when the invite wording is not recognised yet.
        if (b.action === 'join-all') {
          const lead = fleet.leader
          if (!lead?.isReady()) return this.#json(res, 409, { error: `${lead?.username ?? 'bot 1'} is not READY` })
          const joining = fleet.bots.filter((x) => x !== lead && x.isReady())
          if (!joining.length) return this.#json(res, 409, { error: 'no other bot is READY to join' })
          const results = []
          const failed = []
          for (const m of joining) {
            const r = await m.run('accept', { player: lead.username })
            results.push(r)
            if (r.status !== 'OK') failed.push({ bot: m.username, status: r.status, response: r.response ?? r.error })
            await new Promise((res) => setTimeout(res, 250))
          }
          this.#broadcast('state', await this.#state())
          return this.#json(res, 200, { ok: failed.length === 0, joined: joining.length - failed.length, failed, results })
        }

        // Special: continuous background movement. Turning it on is an explicit profile change:
        // stop/disarm old gameplay owners first instead of answering 409 and leaving a bot parked
        // at a generator. The movement loop itself then waits behind any current menu/manual lease.
        if (b.action === 'walk') {
          const rejoin = fleet.rejoinStatus?.()
          if (b.enabled === true && rejoin?.blocked) return this.#json(res, 409, { error: rejoin.label })
          const mov = this.app.runtime.movement
          if (!mov) return this.#json(res, 500, { error: 'movement is not wired' })
          const stoppedAutoplay = []
          const stoppedBedwars = []
          if (b.enabled) {
            for (const bot of fleet.bots) {
              const result = await this.app.runtime.autoplay?.requestStop?.(bot, {
                source: 'continuous movement enabled', disarm: true
              })
              if (result?.stopping || result?.phase === 'stopped') stoppedAutoplay.push(bot.username)
              if (this.app.runtime.bedwars?.stop?.(bot, 'continuous movement enabled')) stoppedBedwars.push(bot.username)
            }
          }
          if (b.enabled !== undefined) {
            if (!this.cfg.movement) this.cfg.movement = {}
            this.cfg.movement.enabled = !!b.enabled
            if (b.persist) await this.#saveConfig({ movement: { enabled: !!b.enabled } })
          }
          const changed = []
          for (const bot of fleet.bots) {
            if (mov.enabled) { if (mov.start(bot)) changed.push(bot.username) }
            else if (mov.stop(bot)) changed.push(bot.username)
          }
          this.log.info?.(`console: walking ${mov.enabled ? 'enabled' : 'disabled'} (${changed.length} bot(s) changed)`)
          this.#broadcast('state', await this.#state())
          return this.#json(res, 200, { ok: true, walking: mov.enabled, changed, stoppedAutoplay, stoppedBedwars })
        }

        // Special: not a command, it drops the socket.
        if (b.action === 'disconnect') {
          const targets = b.bot === 'all' || !b.bot ? fleet.bots : fleet.bots.filter((x) => x.username === b.bot)
          if (!targets.length) return this.#json(res, 404, { error: `no such bot: ${b.bot}` })
          await this.app.runtime.partyStatus?.prepareDisconnect(targets)
          for (const t of targets) t.stop('operator')
          this.log.info?.(`console: disconnected ${targets.length} bot(s)`)
          this.#broadcast('state', await this.#state())
          return this.#json(res, 200, { ok: true, disconnected: targets.map((t) => t.username) })
        }

        // p inv all: the first bot sends an invite to every other configured account.
        // Keep this separate from invite-all, which also makes each member accept.
        if (b.action === 'party-invite-all') {
          const inviter = fleet.leader
          if (!inviter?.isReady()) {
            return this.#json(res, 409, { error: `${inviter?.username ?? 'bot 1'} is not READY` })
          }
          const members = fleet.bots.filter((bot) => bot !== inviter)
          const invited = []
          const alreadyIn = []
          const alreadyInvited = []
          const failed = []
          for (const member of members) {
            const result = await inviter.run('invite', { player: member.username })
            if (result.pattern === 'mbpAlreadyInParty') {
              const knownLeader = this.app.runtime.tracker?.entry(member.username).leader
              if (knownLeader?.toLowerCase() === inviter.username.toLowerCase() || /\bis already in your party\b/i.test(result.response ?? '')) {
                alreadyIn.push(member.username)
              } else {
                failed.push({
                  bot: member.username,
                  status: result.status,
                  response: result.response ?? 'Already in a party; its owner is not confirmed'
                })
              }
            }
            else if (result.pattern === 'mbpAlreadyInvited') alreadyInvited.push(member.username)
            else if (result.status === 'OK') invited.push(member.username)
            else failed.push({
              bot: member.username,
              status: result.status,
              response: result.response ?? result.error
            })
            await new Promise((resolve) => setTimeout(resolve, 250))
          }
          this.#broadcast('state', await this.#state())
          return this.#json(res, 200, {
            ok: failed.length === 0,
            actor: inviter.username,
            attempted: members.length,
            invited,
            alreadyIn,
            alreadyInvited,
            failed
          })
        }

        // Special: the leader re-invites everyone in turn, then each accepts.
        // p inv ... - BOT 1 invites every other member. Explicitly bot 1, not "whoever leads":
        // the flow is that the first account owns the party.
        if (b.action === 'invite-all') {
          const inviter = fleet.leader
          if (!inviter?.isReady()) return this.#json(res, 409, { error: 'no bot is in a position to invite' })
          const results = []
          const alreadyIn = []
          const failed = []
          // Iterate every bot and skip the inviter, rather than starting from fleet.members().
          // members() is anchored on fleet.leader, but the inviter is chosen by #partyActor(),
          // which prefers the tracked party leader — so as soon as those two diverge this loop
          // skipped the fleet leader and made the inviter invite ITSELF.
          for (const m of fleet.bots) {
            if (m === inviter) continue
            if (!m.isReady()) continue
            const inv = await inviter.run('invite', { player: m.username })
            results.push(inv)
            // "Already IN a party" and "already INVITED into your party" are NOT the same thing,
            // and conflating them was a silent success: a member holding a pending invite is not
            // in the party, so skipping the accept left them outside while the button reported ok.
            // The plugin's invites are durable, so that state persists until something accepts it.
            // Only the first is a no-op; the second still needs its accept.
            if (inv.pattern === 'mbpAlreadyInParty') {
              const knownLeader = this.app.runtime.tracker?.entry(m.username).leader
              if (knownLeader?.toLowerCase() === inviter.username.toLowerCase() || /\bis already in your party\b/i.test(inv.response ?? '')) {
                alreadyIn.push(m.username)
              } else {
                failed.push({
                  bot: m.username,
                  status: inv.status,
                  response: inv.response ?? 'Already in a party; its owner is not confirmed'
                })
              }
              continue
            }
            if (inv.status !== 'OK' && inv.pattern !== 'mbpAlreadyInvited') {
              failed.push({ bot: m.username, status: inv.status, response: inv.response ?? inv.error })
              continue
            }
            await new Promise((r) => setTimeout(r, 250))
            const acc = await m.run('accept', { player: inviter.username })
            results.push(acc)
            if (acc.status !== 'OK' && acc.pattern !== 'mbpAlreadyInParty' && acc.pattern !== 'mbpAlreadyInvited') {
              failed.push({ bot: m.username, status: acc.status, response: acc.response ?? acc.error })
            }
          }
          this.#broadcast('state', await this.#state())
          return this.#json(res, 200, {
            ok: failed.length === 0, invited: results.filter((r) => r.action === 'invite' && r.status === 'OK').length,
            alreadyIn, failed, results
          })
        }

        // Every ready bot without confirmed BedWars presence runs the selector flow.
        if (b.action === 'join-bedwars-all') {
          const results = []
          for (const bot of ready) {
            if (this.app.runtime.bedwarsPresence?.stateOf(bot.id)?.joined === true) {
              results.push({ bot: bot.username, status: 'OK', note: 'already in BedWars lobby' })
              continue
            }
            // Preserve an armed autoplay request: once the selector confirms the match, its
            // menu-state event will let autoplay begin again under a fresh lease.
            await this.app.runtime.autoplay?.requestStop?.(bot, { source: 'join BedWars selector', disarm: false })
            const r = await this.app.runtime.menu.runForBot(bot, 0, {
              owner: 'manual', priority: 'safety', preempt: true
            })
            results.push(r)
            await new Promise((res) => setTimeout(res, 350))
          }
          this.#broadcast('state', await this.#state())
          return this.#json(res, 200, { ok: true, results })
        }

        // The menu is not a chat command: it drives packets, so it takes its own path. It is
        // still reported through the same status vocabulary so the dashboard reads it the same way.
        if (b.action === 'menu') {
          const who = b.bot ? fleet.bots.find((x) => x.username === b.bot) : (ready[0] ?? leader)
          if (!who) return this.#json(res, 409, { error: 'no bot is available' })
          if (this.app.runtime.bedwars.isRunning(who.id)) return this.#json(res, 409, { error: `${who.username} is running the BedWars opening` })
          await this.app.runtime.autoplay?.requestStop?.(who, { source: 'manual menu', disarm: true })
          const result = await this.app.runtime.menu.runForBot(who, 0, {
            owner: 'manual', priority: 'safety', preempt: true, force: true
          })
          this.#broadcast('state', await this.#state())
          return this.#json(res, result.status === 'OK' ? 200 : 409, { ok: result.status === 'OK', result })
        }

        // Sneak-bridge: packet work, not chat, so it takes its own path.
        if (b.action === 'bridge') {
          const who = b.bot ? fleet.bots.find((x) => x.username === b.bot) : (ready[0] ?? leader)
          if (!who) return this.#json(res, 409, { error: 'no bot is available' })
          if (this.app.runtime.bedwars.isRunning(who.id)) return this.#json(res, 409, { error: `${who.username} is running the BedWars opening` })
          const spec = { ...(this.cfg.bridge ?? {}) }
          for (const k of ['blocks', 'yaw']) if (b[k] !== undefined) spec[k] = Number(b[k])
          if (b.onObstacle !== undefined) spec.onObstacle = String(b.onObstacle)
          if (!['stop', 'back', 'up'].includes(spec.onObstacle)) {
            return this.#json(res, 400, { error: `onObstacle must be stop, back or up - got "${spec.onObstacle}"` })
          }
          if (b.persist) await this.#saveConfig({ bridge: { blocks: spec.blocks, yaw: spec.yaw, onObstacle: spec.onObstacle } })
          // A manual bridge has higher priority than autoplay. Disarm it first, then enter the
          // same exclusive control lane that autoplay uses so a stale task cannot turn or move
          // the bot while it is at a bridge edge.
          await this.app.runtime.autoplay?.requestStop?.(who, { source: 'manual bridge', disarm: true })
          const supervisor = this.app.runtime.supervisor
          if (!supervisor) return this.#json(res, 500, { error: 'action supervisor is not wired' })
          const result = await supervisor.run(who, {
            owner: 'manual', action: 'bridge', priority: 'manual', blocksCombat: true,
            timeoutMs: Math.min(120000, Math.max(15000, Number(spec.blocks ?? 8) * Number(spec.stepTimeoutMs ?? 2500) * 2))
          }, async ({ signal, isCurrent, isOwner, cleanup }) => {
            await this.app.runtime.movement?.stopAndWait?.(who)
            if (!isCurrent()) return { status: 'CANCELLED', error: 'manual bridge was cancelled' }
            const combat = this.app.runtime.combat
            combat?.stop(who, 'manual bridge')
            try {
              return await sneakBridge(who, {
                bridge: spec, signal, isCurrent, canCleanup: isOwner
              }, this.log)
            } finally {
              cleanup()
              if (isCurrent() && who.isReady()) combat?.start(who)
            }
          })
          this.#broadcast('state', await this.#state())
          return this.#json(res, result.status === 'OK' ? 200 : 409, { ok: result.status === 'OK', result })
        }

        // Everything else is a configured command.
        const actor = (b.actor === 'leader' || !b.actor)
          ? this.#partyActor()
          : fleet.bots.find((x) => x.username === b.actor)
        if (!actor) return this.#json(res, 404, { error: `no such actor: ${b.actor}` })
        if (!actor.isReady()) return this.#json(res, 409, { error: `${actor.username} is not READY` })
        if (!this.app.engine.get(b.action)) return this.#json(res, 404, { error: `no such command: ${b.action}` })

        const vars = { ...(b.vars ?? {}) }
        if (b.target !== undefined) vars.player = b.target
        if (b.message !== undefined) vars.message = b.message
        if (b.warp !== undefined) vars.warp = b.warp
        // Refuse a command whose template still has an unfilled placeholder — checked AFTER every
        // var is assigned, or the check would reject the very fields it is meant to allow.
        // Otherwise the engine renders "/p inv undefined" and the server answers "That player
        // cannot be found", which reads like a server problem instead of a missing argument.
        const template = this.app.engine.get(b.action)?.template ?? ''
        const missing = [...template.matchAll(/\{(\w+)\}/g)]
          .map((m) => m[1])
          .filter((k) => vars[k] === undefined || vars[k] === '')
        if (missing.length) {
          return this.#json(res, 400, {
            error: `missing value for {${missing.join('}, {')}} on command "${b.action}" (template "${template}")`
          })
        }
        const result = await actor.run(b.action, vars)
        this.#broadcast('state', await this.#state())
        this.#json(res, result.status === 'OK' ? 200 : 409, { ok: result.status === 'OK', result })
      }).catch((e) => this.#json(res, 500, { error: e.message }))
    }

    // ---- run a plan: plain party, or formation with a human master ----
    if (req.method === 'POST' && p === '/api/run') {
      return this.#body(req).then(async (b) => {
        if (this.running) return this.#json(res, 409, { error: 'a run is already in progress' })
        let plan
        try {
          plan = (b?.mode === 'master')
            ? masterPartyPlan(this.cfg.fleet.master, {
                acceptWaitMs: this.cfg.fleet.masterAcceptWaitMs,
                promote: b?.promote !== false
              })
            : (this.cfg.plan ?? defaultPartyPlan())
        } catch (e) { return this.#json(res, 400, { error: e.message }) }

        // Refuse rather than accept-and-do-nothing. fleet#resolveActors returns [] for a leader
        // that is not READY, so a run would issue no commands at all while answering 202 - a
        // green response over an empty result, which is the failure this project exists to stop.
        if ((b?.mode === 'master' || plan.some((st) => st.type === 'command'))) {
          const actor = this.#partyActor()
          if (!actor?.isReady()) {
            return this.#json(res, 409, {
              error: `no bot is READY to run the plan (leader ${this.app.fleet.leader?.username} is ${this.app.fleet.leader?.fsm?.state})`
            })
          }
        }
        this.running = true
        this.#broadcast('state', await this.#state())
        Promise.resolve()
          .then(async () => {
            await this.app.fleet.bringOnline()
            if (this.cfg.fleet?.progressiveParty !== false) await this.app.runtime.autoparty?.waitForFull()
            return this.app.fleet.execute(plan)
          })
          .then((results) => {
            const bad = results.filter((r) => r.status !== 'OK')
            this.#broadcast('done', { total: results.length, bad: bad.length })
          })
          .catch((e) => this.#broadcast('runerror', { error: e.message }))
          .finally(async () => { this.running = false; this.#broadcast('state', await this.#state()) })
        this.#json(res, 202, { ok: true, mode: b?.mode === 'master' ? 'master' : 'default' })
      }).catch((e) => this.#json(res, 500, { error: e.message }))
    }

    if (req.method === 'GET') return this.#static(res, p)
    res.writeHead(405).end('method not allowed')
  }

  start (port = 4599, host = '127.0.0.1') {
    this.http = createServer((req, res) => {
      try { this.#handler(req, res) } catch (e) { this.#json(res, 500, { error: e.message }) }
    })
    return new Promise((resolve, reject) => {
      this.http.once('error', reject)
      this.http.listen(port, host, () => {
        this.log.info?.(`console: http://${host}:${port}`)
        resolve(this.http.address())
      })
    })
  }

  stop () { for (const r of this.clients) { try { r.end() } catch {} } ; this.http?.close() }
}

export { S }
