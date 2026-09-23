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

export class Fleet {
  constructor ({ cfg, accounts, bus, engine, log = console }) {
    this.cfg = cfg
    this.bus = bus
    this.engine = engine
    this.log = log
    this.bots = accounts.map((a, i) => new Bot({ ...a, index: i, cfg, bus, engine, log }))
    this.leader = this.bots[cfg.fleet.leaderIndex ?? 0] ?? this.bots[0]
    this.results = []
    this.rejoinAttempts = new Map()   // botId -> attempts since the last deliberate connect
    this.rejoining = new Set()
    this.rejoinSubs = []
    this.shuttingDown = false
    bus.on(EV.CMD_RESULT, (e) => this.results.push(e))
    this.#installRejoin()
  }

  get size () { return this.bots.length }
  get ready () { return this.bots.filter((b) => b.isReady()) }
  members () { return this.bots.filter((b) => b !== this.leader) }

  /** Connect every bot with a stagger, then wait for all of them to finish authenticating.
   *
   *  STAGGER MATH: AuthMe's AntiBot flips at the 11th connection inside a 5 s sliding window
   *  and then kicks every join for 10 minutes. 7 bots at 350 ms apart is 7 connections over
   *  ~2.1 s — comfortably inside the window. A naive reconnect-on-kick loop IS the way to
   *  cross the bar, which is why a kicked bot never retries without a real backoff.
   *  (AntiBot is disabled in this test server's config; the stagger is kept because the
   *  production default is enabled.) */
  async bringOnline () {
    const { connectStaggerMs = 350, readyTimeoutMs = 20000 } = this.cfg.fleet
    this.bus.emit(EV.FLEET_PHASE, { phase: 'connect', bots: this.size })

    const failed = []
    // ONLY connect the bots that are not already up. Connecting a bot that is already in play
    // opens a SECOND login under the same name, and the server answers by dropping BOTH:
    // "The same username is already playing on the server!" — so a re-run would take a healthy
    // fleet down instead of reusing it. Re-running a plan is normal (Run, then Form party), so
    // this has to be idempotent.
    const needConnect = this.bots.filter((b) => {
      const st = b.fsm.state
      return st === S.DISCONNECTED || st === S.DEAD
    })
    if (needConnect.length !== this.bots.length) {
      this.log.info?.(`${this.bots.length - needConnect.length} bot(s) already online, connecting ${needConnect.length}`)
    }
    for (const bot of needConnect) {
      try {
        await bot.start()
        this.log.info?.(`[${bot.username}] in play (protocol ${bot.protocolState})`)
      } catch (e) {
        failed.push({ bot: bot.username, kind: e.kind ?? 'connect', error: e.text ?? e.message })
        this.log.warn?.(`[${bot.username}] connect failed: ${e.text ?? e.message}`)
      }
      await sleep(connectStaggerMs)
    }

    // Authentication runs from the AuthBehaviour on MC_JOIN, in parallel across bots. Wait for
    // a quorum: every bot that got into PLAY must reach READY, otherwise the party step would
    // invite a bot that cannot accept.
    if (this.cfg.auth?.enabled) {
      const deadline = Date.now() + readyTimeoutMs
      while (Date.now() < deadline) {
        const pending = this.bots.filter((b) => !b.isReady() && b.fsm.state === S.AUTH)
        if (!pending.length) break
        await sleep(150)
      }
    }

    const ready = this.ready
    this.bus.emit(EV.FLEET_PHASE, { phase: 'online', ready: ready.length, total: this.size, failed })
    return { ready, failed, notReady: this.bots.filter((b) => !ready.includes(b)) }
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
  async reconnectAll () {
    this.shuttingDown = true
    for (const b of this.bots) b.stop('reconnect')
    await sleep(300)
    this.rejoinAttempts.clear()
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
    if (!f.rejoinOnKick) return
    const onDead = async (e) => {
      const bot = this.bots.find((b) => b.id === e.botId)
      if (!bot || bot.stopping || bot.superseded) return
      if (this.shuttingDown || this.rejoining.has(bot.id)) return
      const attempt = (this.rejoinAttempts.get(bot.id) ?? 0) + 1
      this.rejoinAttempts.set(bot.id, attempt)
      const cap = f.maxRejoinAttempts ?? 3
      if (attempt > cap) {
        this.bus.emit(EV.MC_WARN, { botId: bot.id, bot: bot.username, text: null,
          why: `rejoin abandoned after ${cap} attempts: ${e.text ?? e.reason ?? 'unknown reason'}` })
        return
      }
      this.rejoining.add(bot.id)
      this.bus.emit(EV.FLEET_PHASE, { phase: 'rejoin', bot: bot.username, attempt, cap })
      this.log.info?.(`[${bot.username}] dropped -> rejoining in ${f.rejoinDelayMs ?? 3000}ms (attempt ${attempt}/${cap})`)
      await sleep(f.rejoinDelayMs ?? 3000)
      try {
        await bot.start()
        this.bus.emit(EV.FLEET_PHASE, { phase: 'rejoined', bot: bot.username, attempt, cap })
      } catch (err) {
        this.bus.emit(EV.MC_WARN, { botId: bot.id, bot: bot.username, text: null,
          why: `rejoin failed: ${err.text ?? err.message}` })
      } finally { this.rejoining.delete(bot.id) }
    }
    for (const t of [EV.MC_KICK, EV.MC_DISCONNECT, EV.MC_END]) this.rejoinSubs.push(this.bus.on(t, onDead))
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
    for (const off of this.rejoinSubs) { try { off() } catch {} }
    this.rejoinSubs = []
  }

  async shutdown (reason = 'shutdown') {
    this.shuttingDown = true
    for (const b of this.bots) b.stop(reason)
    await sleep(50)
  }
}
