// behaviour/auth.js — authentication against an AuthMe-style login plugin.
//
// TIMING, MEASURED (PaperSpigot 1.8.8 + AuthMe 5.6.0, 7 bots, live):
//   * PLAY (join_game) arrives ~170-240 ms after connect.
//   * AuthMe's first limbo prompt arrives join + 2077..2097 ms — extremely stable, because it
//     is gated on AuthMe's ASYNC database lookup, not on the client.
//   * BUT the prompt is not a precondition to acting: a /register sent at join + 101 ms
//     succeeded at join + 277 ms. AuthMe's PlayerJoinEvent handling completes before the client
//     can send anything, so /login and /register are accepted immediately. Both are on AuthMe's
//     allowCommands list, so they are also exempt from the 1000 ms quick-command kick.
//   => Start the configured sequence after the join settle delay. A prompt is a retry signal,
//      never permission to skip /register in a register-first sequence.
//
// AuthMe may auto-login a newly registered account. We still send /login after /register so
// READY means the login step was confirmed (including its "already logged in" reply).

import { EV } from '../bus.js'
import { STATUS } from '../engine/classify.js'
import { S } from '../fsm.js'

export class AuthBehaviour {
  constructor ({ cfg, bus, engine, log = console }) {
    this.cfg = cfg
    this.bus = bus
    this.engine = engine
    this.log = log
    this.settled = new Set()
  }

// Handlers registered on the bus are NOT garbage collected when this object is dropped, and a
  // rebuilt fleet reuses bot ids ("0:Bot01" again), so a stale handler keyed on botId WILL fire
  // for the new bot while its closure still holds the retired one. Collect the unsubscribers and
  // drop them when the runtime is replaced.
  #subs = []
  #sub (topic, fn) { this.#subs.push(this.bus.on(topic, fn)) }
  dispose () { for (const off of this.#subs) { try { off() } catch {} } this.#subs = []; return this }

  attach (bot) {
    const a = this.cfg.auth
    if (!a?.enabled) {
      // No login plugin: PLAY is as far as we go, and READY immediately.
      this.#sub(EV.MC_JOIN, (e) => {
        if (e.botId !== bot.id) return
        bot.fsm.to(S.READY)
      })
      return bot
    }

    const state = {
      bot, generation: 0, strategy: null, busy: false, sentAt: null,
      last: null, lastKind: null, lastPromptAt: null, result: null,
      registerAttempted: false, loginAttempted: false, loginRetries: 0
    }

    // MC_JOIN fires again after a rejoin, so the per-connection auth state MUST be cleared
    // first: #attempt returns immediately when state.result is already set, which would leave
    // a reconnected bot stuck in PLAY and never authenticated.
    this.#sub(EV.MC_JOIN, (e) => {
      if (e.botId !== bot.id) return
      const generation = ++state.generation
      state.strategy = this.cfg.auth.strategy ?? 'register-first'
      state.result = null; state.busy = false; state.sentAt = null
      state.last = null; state.lastKind = null; state.lastPromptAt = null
      state.registerAttempted = false; state.loginAttempted = false; state.loginRetries = 0
      this.#begin(state, generation)
      this.#quietTimer(state, generation)
    })

    // A prompt can retry a silent /login once. It cannot start /login ahead of /register.
    this.#sub(EV.MC_CHAT, (e) => {
      if (e.botId !== bot.id || state.result || !state.generation) return
      const kind = this.#promptKind(e.text)
      if (!kind) return
      state.lastPromptAt = Date.now()
      if (kind !== 'login' || !state.loginAttempted || state.busy) return
      if (state.lastKind !== 'login' || state.last?.status !== STATUS.NO_RESPONSE) return
      if (state.loginRetries >= 1) return
      state.loginRetries++
      this.#attempt(state, 'login', state.generation)
    })

    // Language-independent fallback: AuthMe re-sends the limbo prompt every messageInterval
    // (default 5 s) while unauthenticated and stops the moment auth succeeds. If we have
    // sent /login and the prompt has been quiet for 2+ intervals, a silent login may be
    // treated as authenticated. An explicit failure or a repeating prompt prevents that.
    return bot
  }

  #current (state, generation) {
    return state.generation === generation && state.bot.fsm.state === S.AUTH && state.bot.sendable()
  }

  async #begin (state, generation) {
    const { bot } = state
    bot.fsm.to(S.AUTH)
    // Wait out the join burst (chunk + background setup). Measured: sending /login right at PLAY
    // makes ~15-30% of the bots get dropped by the server with a netty IndexOutOfBoundsException.
    // With a 1500ms wait there is not a single case left.
    const settle = this.cfg.auth.settleMs ?? 1500
    if (settle > 0) await new Promise(r => setTimeout(r, settle))
    if (!this.#current(state, generation)) return
    if (state.strategy === 'register-first' && this.engine.get('__register')) {
      return this.#attempt(state, 'register', generation)
    }
    if (state.strategy === 'register-first') {
      this.log.warn?.(`[${bot.username}] /register is disabled; attempting /login`)
    }
    return this.#attempt(state, 'login', generation)
  }

  #promptKind (text) {
    const P = this.engine.constructor.PATTERNS
    if (P.loginRequired.re && new RegExp(P.loginRequired.re).test(text)) return 'login'
    if (P.registerRequired.re && new RegExp(P.registerRequired.re).test(text)) return 'register'
    return null
  }

  #ready (state, generation, kind, r) {
    if (!this.#current(state, generation)) return r
    const via = r.pattern === 'unknownCommand' ? 'not_required' : kind
    state.result = r
    state.bot.fsm.to(S.READY)
    this.bus.emit(EV.AUTH_OK, {
      botId: state.bot.id, bot: state.bot.username, via,
      pattern: r.pattern, ms: Date.now() - (state.bot.joinedAt ?? Date.now())
    })
    if (via === 'not_required') {
      this.log.info?.(`[${state.bot.username}] no auth command on this server; login is not required`)
    } else {
      this.log.info?.(`[${state.bot.username}] authenticated via ${kind} at join+${Date.now() - state.bot.joinedAt}ms (${r.response ?? r.status})`)
    }
    return r
  }

  #fail (state, generation, r, fatal = false) {
    if (!this.#current(state, generation)) return r
    state.result = r
    state.bot.fsm.to(S.AUTH_FAILED)
    this.bus.emit(EV.AUTH_FAIL, {
      botId: state.bot.id, bot: state.bot.username, fatal,
      pattern: r.pattern ?? 'authUnavailable', response: r.response ?? r.error
    })
    return r
  }

  async #attempt (state, kind, generation) {
    const { bot } = state
    if (!this.#current(state, generation) || state.result || state.busy) return

    const action = kind === 'register' ? '__register' : '__login'
    if (!this.engine.get(action)) {
      if (kind === 'register') return this.#attempt(state, 'login', generation)
      return this.#fail(state, generation, { status: STATUS.ERROR, error: '/login is not configured' })
    }

    state.busy = true
    state.sentAt = Date.now()
    if (kind === 'register') state.registerAttempted = true
    else state.loginAttempted = true
    bot.authAttempts++

    let r
    try { r = await bot.run(action, { password: bot.password }) } catch (error) {
      r = { status: STATUS.ERROR, error: error?.message ?? String(error) }
    }
    // A previous connection can finish after the next MC_JOIN. It must not clear that
    // connection's busy flag, consume its result, or mark the new session READY.
    if (!this.#current(state, generation)) return r
    state.busy = false
    state.last = r
    state.lastKind = kind

    if (kind === 'login' && r.status === STATUS.OK) return this.#ready(state, generation, kind, r)
    if (r.pattern === "unknownCommand") {
      this.log.info?.(`[${bot.username}] auth command is unknown on this server; login is not required`)
      return this.#ready(state, generation, kind, r)
    }

    // A wrong password is a HARD stop, not a retry: kickOnWrongPassword=true kicks on the
    // first bad attempt, and every attempt increments a counter that, with tempban enabled,
    // IP-bans ALL bots for 480 minutes because they share 127.0.0.1.
    if (r.pattern === 'wrongPassword') {
      this.log.warn?.(`[${bot.username}] BAD PASSWORD — not retrying (tempban counter)`)
      return this.#fail(state, generation, r, true)
    }
    // Register-first always continues to /login, including an already-registered reply,
    // a successful registration (which may auto-login), or an unrecognised response.
    // The login-first fallback also verifies /login after registering.
    if (kind === 'register') {
      this.log.info?.(`[${bot.username}] /register -> /login (${r.pattern ?? r.status})`)
      return this.#attempt(state, 'login', generation)
    }
    if (r.pattern === 'alreadyLoggedIn') return this.#ready(state, generation, kind, r)

    if (r.pattern === 'notRegistered' && !state.registerAttempted && this.engine.get('__register')) {
      this.log.info?.(`[${bot.username}] not registered -> /register`)
      return this.#attempt(state, 'register', generation)
    }
    if (r.pattern === 'notRegistered') {
      this.log.warn?.(`[${bot.username}] account is still unregistered after auth sequence`)
      return this.#fail(state, generation, r)
    }

    // Anything else: leave the prompt retry + quiet fallback to decide.
    this.log.warn?.(`[${bot.username}] auth attempt "${kind}" -> ${r.status} (${r.pattern ?? r.error ?? '-'})`)
    return r
  }

  #quietTimer (state, generation) {
    const interval = (this.cfg.auth.messageIntervalMs ?? 5000) * 2
    const t = setInterval(() => {
      if (state.generation !== generation) return clearInterval(t)
      if (state.result) return clearInterval(t)
      const { bot } = state
      if (!this.#current(state, generation)) return clearInterval(t)
      if (!state.loginAttempted || state.lastKind !== 'login') return
      if (Date.now() - state.sentAt < interval) return
      if (state.lastPromptAt != null && Date.now() - state.lastPromptAt < interval) return
      const r = state.last
      if (!r || r.status !== STATUS.NO_RESPONSE || r.pattern) return
      state.result = r
      bot.fsm.to(S.READY)
      this.bus.emit(EV.AUTH_OK, { botId: bot.id, bot: bot.username, via: 'quiet', note: 'no prompt for 2 message intervals after /login' })
      this.log.info?.(`[${bot.username}] assumed authenticated (prompt went quiet)`)
      clearInterval(t)
    }, 1000)
    t.unref?.()
  }
}
