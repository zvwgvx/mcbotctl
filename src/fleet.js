// fleet.js — N bots as one system: bring them online, then run a plan.
//
// The plan is DATA (see behaviour/party.js for the shape). That is the V2 seam: "many more
// scripted behaviours and dozens of configurable commands" is new plan steps plus new command
// specs, not new orchestration code.

import { Bot } from './bot.js'
import { EV } from './bus.js'
import { S } from './fsm.js'
import { sleep } from './util.js'
import { defaultPartyPlan } from './behaviour/party.js'

const TERMINAL_TOPICS = [EV.MC_KICK, EV.MC_DISCONNECT, EV.MC_END]

// These are server-side enforcement or connection-throttle responses. They are deliberately
// handled as a fleet-wide stop condition: retrying a whole fleet after either response amplifies
// traffic and cannot make the server accept the original connection.
const REJOIN_BLOCKS = [
  {
    cause: 'connection_verification',
    label: 'Connection verification required; automatic reconnect is paused. Complete the server verification, then press Connect again.',
    re: /verify your connection|complete the verification process|v4g\.to/i
  },
  {
    cause: 'server_enforcement',
    label: 'Server enforcement detected; automatic reconnect is suspended',
    re: /\b(?:temporarily|permanently)?\s*banned\b|\bcheating is not allowed\b|\bclient modifications?\b/i
  }
]

function reconnectCooldownMs (reason) {
  const text = String(reason?.text ?? reason?.reason ?? reason?.message ?? reason ?? '').toLowerCase()
  if (/logging in too fast|too many connections|anti.?bot|connection limit|throttl/.test(text)) return 30000
  if (/already logged on|already logged in|same username|already playing/.test(text)) return 20000
  if (/already connected to this proxy/.test(text)) return 15000
  return 0
}

function rejoinBlockFor (reason) {
  const text = String(reason ?? '')
  return REJOIN_BLOCKS.find((block) => block.re.test(text)) ?? null
}

function configuredRejoinBlock (value) {
  if (!value || value.active !== true) return null
  const label = typeof value.label === 'string' && value.label.trim()
    ? value.label.trim()
    : 'Automatic reconnect is suspended by the operator'
  return {
    cause: typeof value.cause === 'string' && value.cause ? value.cause : 'operator_hold',
    label,
    detectedAt: Number.isFinite(value.detectedAt) ? value.detectedAt : null
  }
}

export class Fleet {
  constructor ({ cfg, accounts, proxyManager = null, bus, engine, log = console }) {
    this.cfg = cfg
    this.bus = bus
    this.engine = engine
    this.log = log
    this.bots = accounts.map((a, i) => new Bot({ ...a, index: i, cfg, proxyManager, bus, engine, log }))
    this.leader = this.bots[cfg.fleet.leaderIndex ?? 0] ?? this.bots[0]
    this.results = []
    this.rejoinAttempts = new Map()   // botId -> attempts since the last deliberate connect
    this.rejoining = new Map() // botId -> reconnect epoch
    this.rejoinEpoch = 0
    this.stableTimers = new Map()
    this.fatalAuth = new Set()
    this.rejoinSubs = []
    this.rejoinBlock = configuredRejoinBlock(cfg.fleet?.rejoinBlock)
    this.shuttingDown = false
    this.bringOnlinePromise = null
    this.rejoinLane = Promise.resolve()
    this.nextRejoinAt = 0
    this.rejoinCooldownUntil = 0
    this.resultSub = bus.on(EV.CMD_RESULT, (e) => this.results.push(e))
    this.#installRejoin()
  }

  get size () { return this.bots.length }
  get ready () { return this.bots.filter((b) => b.isReady()) }
  members () { return this.bots.filter((b) => b !== this.leader) }

  clearRejoinBlock (cause = null) {
    if (!this.rejoinBlock) return false
    if (cause && this.rejoinBlock.cause !== cause) return false
    this.rejoinBlock = null
    this.rejoinEpoch++
    this.rejoining.clear()
    this.rejoinAttempts.clear()
    return true
  }

  rejoinStatus () {
    const block = this.rejoinBlock
    return {
      enabled: this.cfg.fleet?.rejoinOnKick === true,
      blocked: !!block,
      cause: block?.cause ?? null,
      label: block?.label ?? null,
      detectedAt: block?.detectedAt ?? null
    }
  }

  /** Connect every bot with a stagger, then wait for all of them to finish authenticating.
   *
   *  STAGGER MATH: AuthMe's AntiBot flips at the 11th connection inside a 5 s sliding window
   *  and then kicks every join for 10 minutes. 7 bots at 350 ms apart is 7 connections over
   *  ~2.1 s — comfortably inside the window. A naive reconnect-on-kick loop IS the way to
   *  cross the bar, which is why a kicked bot never retries without a real backoff.
   *  (AntiBot is disabled in this test server's config; the stagger is kept because the
   *  production default is enabled.) */
  async bringOnline () {
    if (this.bringOnlinePromise) return this.bringOnlinePromise
    const run = this.#bringOnlineUntilReady()
    this.bringOnlinePromise = run
    try {
      return await run
    } finally {
      if (this.bringOnlinePromise === run) this.bringOnlinePromise = null
    }
  }

  async #bringOnlineUntilReady () {
    const f = this.cfg.fleet ?? {}
    const stagger = Math.max(0, Number(f.connectStaggerMs ?? 1000))
    const readyTimeout = Math.max(1000, Number(f.readyTimeoutMs ?? 20000))
    const baseRetry = Math.max(500, Number(f.connectRetryBaseMs ?? 3000))
    const maxRetry = Math.max(baseRetry, Number(f.connectRetryMaxMs ?? 30000))
    const maxRounds = Math.max(0, Number(f.connectMaxRounds ?? 0))
    const readyStallMs = Math.max(readyTimeout, Number(f.readyStallMs ?? 60000))
    let round = 0
    let serverCooldown = 0

    while (!this.shuttingDown) {
      if (this.rejoinBlock) throw Object.assign(new Error(this.rejoinBlock.label), { kind: 'blocked', cause: this.rejoinBlock.cause })
      const fatal = this.bots.find((bot) => this.fatalAuth.has(bot.id))
      if (fatal) throw Object.assign(new Error(`${fatal.username}: permanent authentication failure`), { kind: 'auth', bot: fatal.username })

      const missing = this.bots.filter((bot) => !bot.isReady())
      if (!missing.length) {
        const ready = this.ready
        this.bus.emit(EV.FLEET_PHASE, { phase: 'online', ready: ready.length, total: this.size, failed: [] })
        return { ready, failed: [], notReady: [] }
      }

      round++
      if (maxRounds > 0 && round > maxRounds) {
        const names = this.bots.filter((bot) => !bot.isReady()).map((bot) => bot.username)
        throw Object.assign(new Error(`fleet did not converge after ${maxRounds} rounds: ${names.join(', ')}`), { kind: 'connect' })
      }

      this.bus.emit(EV.FLEET_PHASE, {
        phase: round === 1 ? 'connect' : 'recover',
        bots: this.size,
        missing: missing.length,
        round
      })

      const starts = []
      for (const bot of missing) {
        if (this.shuttingDown || this.rejoinBlock || this.fatalAuth.has(bot.id)) break
        if (this.#connectionNeedsReset(bot, readyStallMs)) await this.#resetBot(bot, 'connect-recovery')
        if (![S.DISCONNECTED, S.DEAD].includes(bot.fsm.state)) continue
        starts.push((async () => {
          try {
            await bot.start()
            this.log.info?.(`[${bot.username}] in play (protocol ${bot.protocolState})`)
          } catch (error) {
            serverCooldown = Math.max(serverCooldown, reconnectCooldownMs(error))
            this.log.warn?.(`[${bot.username}] connect failed: ${error.text ?? error.message}`)
          }
        })())
        if (stagger > 0) await sleep(stagger)
      }
      await Promise.allSettled(starts)

      const deadline = Date.now() + readyTimeout
      while (Date.now() < deadline && !this.shuttingDown && !this.rejoinBlock) {
        if (this.bots.every((bot) => bot.isReady())) break
        if (this.bots.some((bot) => this.fatalAuth.has(bot.id))) break
        await sleep(150)
      }

      if (this.bots.every((bot) => bot.isReady())) continue
      if (this.shuttingDown || this.rejoinBlock) continue

      for (const bot of this.bots.filter((candidate) => !candidate.isReady())) {
        if (this.fatalAuth.has(bot.id)) continue
        if (this.#connectionNeedsReset(bot, readyStallMs)) await this.#resetBot(bot, 'ready-timeout')
      }

      const delay = Math.max(serverCooldown, Math.min(maxRetry, baseRetry * (2 ** Math.min(Math.max(0, round - 1), 4))))
      serverCooldown = 0
      this.bus.emit(EV.FLEET_PHASE, {
        phase: 'retry_wait',
        round,
        delay,
        ready: this.ready.length,
        total: this.size,
        missing: this.bots.filter((bot) => !bot.isReady()).map((bot) => bot.username)
      })
      await sleep(delay)
    }

    throw Object.assign(new Error('fleet connection cancelled'), { kind: 'cancelled' })
  }

  #connectionNeedsReset (bot, readyStallMs) {
    if (bot.fsm.state === S.AUTH_FAILED) return true
    if (bot.fsm.state !== S.PLAY && bot.fsm.state !== S.AUTH) return false
    if (!bot.transport?.connected) return true
    const joinedAt = Number(bot.joinedAt)
    return Number.isFinite(joinedAt) && joinedAt > 0 && Date.now() - joinedAt >= readyStallMs
  }

  async #resetBot (bot, reason) {
    bot.stop(reason)
    const transport = bot.transport
    try {
      if (typeof transport?.endAndWait === 'function') await transport.endAndWait(reason)
      else if (typeof transport?.waitForClose === 'function') await transport.waitForClose()
    } catch (error) {
      this.log.warn?.(`[${bot.username}] socket reset failed: ${error.message}`)
    }
    await sleep(Math.max(0, Number(this.cfg.fleet?.reconnectSettleMs ?? 300)))
  }

  #resolveActors (spec) {
    const all = this.bots.filter((b) => b.isReady())
    const leader = this.leader.isReady() ? [this.leader] : []
    const members = all.filter((b) => b !== this.leader)
    switch (spec.actor) {
      case 'leader': return leader
      case 'members': return members
      case 'all': return all
      default: return all.filter((b) => b.username === spec.actor)
    }
  }

  #resolveTargets (spec, actor) {
    const all = this.bots.filter((b) => b.isReady())
    switch (spec.target) {
      case 'members': return all.filter((b) => b !== actor)
      case 'leader': return all.filter((b) => b === this.leader)
      case undefined:
      case null: return [null]
      default: {
        const mine = all.filter((b) => b.username === spec.target)
        if (mine.length) return mine
        // A literal account name that is not in the fleet — the human party master. The engine
        // only ever reads `.username`, so hand it a plain stand-in rather than inventing a Bot
        // (which would drag a transport and an FSM along for a player we do not control).
        return [{ username: spec.target, foreign: true }]
      }
    }
  }

  /** Reconnect every bot to the current cfg.server address.
   *
   *  Used by the dashboard's console when the operator pastes the address of a different test
   *  server. The transports hold a reference to cfg.server, so mutating it is enough for the
   *  NEXT connect; existing sockets must be dropped first or the fleet would be split across
   *  two servers. Rejoin is suppressed for the duration so the driver does not fight us. */
  async recoverBot (bot, reason = 'recovery') {
    if (!bot || !this.bots.includes(bot) || this.shuttingDown || this.rejoinBlock) return false
    return this.#runInRejoinLane(bot, async () => {
      bot.stop(reason)
      const transport = bot.transport
      if (typeof transport?.endAndWait === 'function') await transport.endAndWait(reason)
      else if (typeof transport?.waitForClose === 'function') await transport.waitForClose()
      await sleep(Math.max(0, Number(this.cfg.fleet?.reconnectSettleMs ?? 500)))
      if (this.shuttingDown || this.rejoinBlock) return false
      await bot.start()
      return true
    })
  }

  async reconnectAll () {
    if (this.rejoinBlock) throw Object.assign(new Error(this.rejoinBlock.label), { kind: 'blocked', cause: this.rejoinBlock.cause })
    this.rejoinEpoch++
    this.rejoining.clear()
    this.shuttingDown = true
    // A replacement transport cannot know about a socket owned by the old Bot object. Wait for
    // every Mineflayer transport to release its TCP session (or use its bounded destroy fallback)
    // before a new login uses the same username. This prevents a server from dropping both as a
    // duplicate account during an address change or a runtime rebuild.
    await this.#stopAndRelease('reconnect')
    await sleep(this.cfg.fleet?.reconnectSettleMs ?? 300)
    this.rejoinAttempts.clear()
    this.fatalAuth.clear()
    for (const timer of this.stableTimers.values()) clearTimeout(timer)
    this.stableTimers.clear()
    this.shuttingDown = false
    return this.bringOnline()
  }

  /** Rejoin a bot that the SERVER dropped, with a delay and an attempt cap.
   *
   *  Rejoining blindly is its own hazard: AuthMe's AntiBot flips on at the 11th connection
   *  inside a 5s window and then refuses every join for 10 minutes, so a tight reconnect loop
   *  is exactly how a fleet bans itself. Hence the delay, the cap, and no retry at all during
   *  an intentional shutdown. */
  #installRejoin () {
    const f = this.cfg.fleet ?? {}
    // Observe terminal responses even when retries are disabled. This keeps a durable fleet
    // status for the dashboard and prevents a later config toggle from immediately retrying a
    // server response that explicitly told us to stop.
    const observeTerminal = (e) => {
      const bot = this.bots.find((candidate) => candidate.id === e.botId)
      if (bot?.acceptsConnectionEvent?.(e) === false) return
      const block = rejoinBlockFor(e.text ?? e.reason)
      if (block) this.#blockAutoRejoin(block, e)
    }
    for (const topic of TERMINAL_TOPICS) this.rejoinSubs.push(this.bus.on(topic, observeTerminal))
    this.rejoinSubs.push(this.bus.on(EV.AUTH_FAIL, (e) => {
      if (e.fatal) this.fatalAuth.add(e.botId)
    }))
    if (!f.rejoinOnKick) return
    // The cap applies to a *series* of drops, not to the entire life of a bot. A full minute
    // READY on the same connection establishes that a reconnect was stable.
    this.rejoinSubs.push(this.bus.on(EV.BOT_READY, (e) => {
      const bot = this.bots.find((b) => b.id === e.botId)
      if (!bot) return
      this.fatalAuth.delete(bot.id)
      clearTimeout(this.stableTimers.get(bot.id))
      const joinedAt = bot.joinedAt
      const timer = setTimeout(() => {
        this.stableTimers.delete(bot.id)
        if (!this.shuttingDown && bot.isReady() && bot.joinedAt === joinedAt) this.rejoinAttempts.delete(bot.id)
      }, f.stableRejoinResetMs ?? 60000)
      timer.unref?.()
      this.stableTimers.set(bot.id, timer)
    }))
    const onDead = async (e) => {
      const bot = this.bots.find((b) => b.id === e.botId)
      if (!bot || bot.stopping || bot.superseded || bot.acceptsConnectionEvent?.(e) === false) return
      if (this.bringOnlinePromise) return
      if (this.rejoinBlock || this.shuttingDown || this.rejoining.has(bot.id)) return
      clearTimeout(this.stableTimers.get(bot.id))
      this.stableTimers.delete(bot.id)
      const reason = String(e.text ?? e.reason ?? '')
      if (/\b(?:wrong|incorrect|invalid) password\b/i.test(reason)) this.fatalAuth.add(bot.id)
      if (this.fatalAuth.has(bot.id)) {
        this.bus.emit(EV.MC_WARN, { botId: bot.id, bot: bot.username, text: null,
          why: 'rejoin stopped after a permanent authentication failure' })
        return
      }
      const configuredCap = Number(f.maxRejoinAttempts ?? 3)
      const cap = Number.isFinite(configuredCap) ? Math.max(0, configuredCap) : 3
      const epoch = this.rejoinEpoch
      this.rejoining.set(bot.id, epoch)
      try {
        while (epoch === this.rejoinEpoch && !this.rejoinBlock && !this.shuttingDown && !bot.stopping && !bot.superseded && !this.fatalAuth.has(bot.id)) {
          const attempt = (this.rejoinAttempts.get(bot.id) ?? 0) + 1
          this.rejoinAttempts.set(bot.id, attempt)
          if (cap > 0 && attempt > cap) {
            this.bus.emit(EV.MC_WARN, { botId: bot.id, bot: bot.username, text: null,
              why: `rejoin abandoned after ${cap} attempts: ${e.text ?? e.reason ?? 'unknown reason'}` })
            return
          }
          const delay = Math.min(Number(f.rejoinMaxDelayMs ?? 30000), (f.rejoinDelayMs ?? 3000) * Math.min(2 ** (attempt - 1), 8))
          this.bus.emit(EV.FLEET_PHASE, { phase: 'rejoin', bot: bot.username, attempt, cap: cap || null })
          this.log.info?.(`[${bot.username}] dropped -> rejoining in ${delay}ms (attempt ${attempt}${cap ? '/' + cap : ''})`)
          await sleep(delay)
          if (epoch !== this.rejoinEpoch || this.rejoinBlock || this.shuttingDown || bot.stopping || bot.superseded || this.fatalAuth.has(bot.id)) return
          try {
            await this.#runInRejoinLane(bot, () => bot.start())
            this.bus.emit(EV.FLEET_PHASE, { phase: 'rejoined', bot: bot.username, attempt, cap: cap || null })
            return
          } catch (err) {
            this.bus.emit(EV.MC_WARN, { botId: bot.id, bot: bot.username, text: null,
              why: `rejoin attempt ${attempt}${cap ? '/' + cap : ''} failed: ${err.text ?? err.message}` })
          }
        }
      } finally { if (this.rejoining.get(bot.id) === epoch) this.rejoining.delete(bot.id) }
    }
    for (const topic of TERMINAL_TOPICS) this.rejoinSubs.push(this.bus.on(topic, onDead))
  }

  async #runInRejoinLane (bot, task) {
    const previous = this.rejoinLane
    let release
    const mine = new Promise((resolve) => { release = resolve })
    this.rejoinLane = mine
    await previous.catch(() => {})
    try {
      const now = Date.now()
      const wait = Math.max(0, this.nextRejoinAt - now, this.rejoinCooldownUntil - now)
      if (wait > 0) await sleep(wait)
      return await task()
    } catch (error) {
      const cooldown = reconnectCooldownMs(error)
      if (cooldown > 0) {
        this.rejoinCooldownUntil = Math.max(this.rejoinCooldownUntil, Date.now() + cooldown)
        this.log.warn?.(`[${bot.username}] reconnect cooldown raised to ${cooldown}ms after server refusal`)
      }
      throw error
    } finally {
      this.nextRejoinAt = Date.now() + Math.max(0, Number(this.cfg.fleet?.connectStaggerMs ?? 1000))
      release()
    }
  }

  #blockAutoRejoin (block, event) {
    if (this.rejoinBlock) return
    this.rejoinBlock = { ...block, detectedAt: event.at ?? Date.now() }
    // Every pending retry captures the old epoch and exits before it opens another socket.
    this.rejoinEpoch++
    this.rejoining.clear()
    for (const timer of this.stableTimers.values()) clearTimeout(timer)
    this.stableTimers.clear()

    // Freeze any connection attempt that was already in flight when the hold arrived.
    // READY sessions are left untouched; only incomplete CONNECTING/AUTH/PLAY sessions are
    // cancelled so the server does not receive more login traffic after a verification gate.
    for (const bot of this.bots) {
      if (bot.isReady?.()) continue
      if ([S.DISCONNECTED, S.DEAD].includes(bot.fsm?.state)) continue
      try { bot.stop('fleet-hold') } catch (error) {
        this.log.warn?.(`[${bot.username}] could not stop in-flight connection after fleet hold: ${error.message}`)
      }
    }

    this.bus.emit(EV.FLEET_PHASE, {
      phase: 'rejoin_blocked', cause: block.cause, label: block.label
    })
    this.bus.emit(EV.MC_WARN, {
      botId: event.botId, bot: event.bot, text: null, why: block.label
    })
    this.log.warn?.(`automatic rejoin suspended for fleet: ${block.cause}`)
  }

  #blockedConnectResult (phase) {
    const ready = this.ready
    const failed = this.bots.filter((bot) => !bot.isReady()).map((bot) => ({
      bot: bot.username, kind: 'blocked', error: this.rejoinBlock.label
    }))
    this.bus.emit(EV.FLEET_PHASE, {
      phase: `${phase}_blocked`, cause: this.rejoinBlock.cause, label: this.rejoinBlock.label
    })
    return { ready, failed, notReady: this.bots.filter((bot) => !ready.includes(bot)) }
  }

  /** Run a plan. Steps are sequential; within a step, actors run concurrently but each bot's
   *  own commands are serialised by the engine. A step never throws: one bot failing must not
   *  abandon the other six. */
  async execute (plan = this.cfg.plan ?? defaultPartyPlan()) {
    for (const step of plan) {
      if (step.type === 'auth') {
        const r = await this.bringOnline()
        this.log.info?.(`auth: ${r.ready.length}/${this.size} READY${r.failed.length ? `, ${r.failed.length} failed` : ''}`)
        continue
      }
      if (step.type === 'barrier') { await sleep(0); continue }
      if (step.type === 'wait') { await sleep(step.ms ?? 0); continue }
      if (step.type !== 'command') { this.log.warn?.(`unknown plan step: ${step.type}`); continue }
      if (this.cfg.fleet?.progressiveParty !== false && step.phase === 'party') {
        const duplicateInvite = step.actor === 'leader' && step.action === 'invite' && step.target === 'members'
        const duplicateAccept = step.actor === 'members' && step.action === 'accept' && step.target === 'leader'
        if (duplicateInvite || duplicateAccept) continue
      }

      this.bus.emit(EV.FLEET_PHASE, { phase: step.phase ?? 'command', action: step.action, actor: step.actor })
      const actors = this.#resolveActors(step)

      // Actors run in parallel; targets within one actor run sequentially by design, because
      // 1.8.9 replies carry no command echo and can only be attributed by time.
      await Promise.all(actors.map(async (actor) => {
        const targets = this.#resolveTargets(step, actor)
        const out = []
        for (const t of targets) {
          out.push(await actor.run(step.action, t ? { player: t.username, message: t.username } : {}))
          if (step.paceMs) await sleep(step.paceMs)
        }
        return out
      }))
    }
    this.bus.emit(EV.FLEET_PHASE, { phase: 'done' })
    return this.results
  }

  /** Drop the rejoin subscriptions so a replaced fleet stops reacting to its old bots. */
  dispose () {
    this.rejoinEpoch++
    this.rejoining.clear()
    for (const off of this.rejoinSubs) { try { off() } catch {} }
    this.rejoinSubs = []
    for (const timer of this.stableTimers.values()) clearTimeout(timer)
    this.stableTimers.clear()
    try { this.resultSub?.() } catch {}
    this.resultSub = null
    for (const bot of this.bots) bot.dispose?.()
  }

  async shutdown (reason = 'shutdown') {
    this.rejoinEpoch++
    this.rejoining.clear()
    this.shuttingDown = true
    for (const timer of this.stableTimers.values()) clearTimeout(timer)
    this.stableTimers.clear()
    await this.#stopAndRelease(reason)
  }

  async #stopAndRelease (reason) {
    for (const bot of this.bots) bot.stop(reason)
    const outcomes = await Promise.allSettled(this.bots.map(async (bot) => {
      const transport = bot.transport
      if (typeof transport?.endAndWait === 'function') return transport.endAndWait(reason)
      if (typeof transport?.waitForClose === 'function') return transport.waitForClose()
      return false
    }))
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') this.log.warn?.(`socket teardown wait failed: ${outcome.reason?.message ?? outcome.reason}`)
    }
  }
}
