// behaviour/menu.js — the area gate.
//
// Some servers do not let you do anything meaningful until you have walked through a menu: pick the
// server-selector item, right-click, click the gamemode. On those servers a bot that skips the menu
// is in the wrong world, and a party built from bots in the wrong world is worse than no party —
// it looks formed and is not.
//
// So the menu is a GATE, not a button. When cfg.menu.enabled and cfg.menu.gateParty are on, a bot
// must complete the flow after authenticating before it will invite or accept anything. The engine
// refuses party commands for a bot that has not (see the gate in engine/engine.js), and the
// arrival sweep skips it, so the party count on the dashboard reflects bots that actually got in.
//
// A failure is not silent: the reason is on the bus, in the log, in the state the dashboard reads,
// and on the bot's card. `retries` exists because an area can be slow to open on a busy server.

import { EV } from '../bus.js'
import { STATUS } from '../engine/classify.js'
import { openMenu } from '../menu.js'

export class MenuBehaviour {
  constructor ({ cfg, bus, log = console, presence = null, supervisor = null, movement = null }) {
    this.cfg = cfg
    this.bus = bus
    this.log = log
    this.presence = presence
    this.supervisor = supervisor
    this.movement = movement
    this.recoveryHandler = null
    this.#subs = []
    this.runs = new Map()
    this.recoveryTimers = new Map()
    this.recoveryAttempts = new Map()
    /** botId -> { state: 'pending'|'done'|'failed', result } */
    this.byBot = new Map()
  }

  #subs = []
  #sub (topic, fn) { this.#subs.push(this.bus.on(topic, fn)) }
  dispose () {
    for (const controller of this.runs.values()) controller.abort()
    this.runs.clear()
    for (const timer of this.recoveryTimers.values()) clearTimeout(timer)
    this.recoveryTimers.clear()
    this.recoveryAttempts.clear()
    for (const off of this.#subs) { try { off() } catch {} }
    this.#subs = []
    return this
  }

  get enabled () { return this.cfg.menu?.enabled !== false }
  get gates () { return this.enabled && this.cfg.menu?.gateParty !== false }

  setRecoveryHandler (fn) {
    this.recoveryHandler = typeof fn === 'function' ? fn : null
    return this
  }

  attach (bot) {
    this.byBot.set(bot.id, { state: this.enabled ? 'pending' : 'done', result: null })
    this.#sub(EV.BOT_READY, (e) => {
      if (e.botId !== bot.id) return
      this.recoveryAttempts.delete(bot.id)
      clearTimeout(this.recoveryTimers.get(bot.id))
      this.recoveryTimers.delete(bot.id)
      void this.#run(bot)
    })

    // Auto-mark done when BedWars lobby presence is positively detected
    this.#sub('bedwars:presence', (e) => {
      if (e.botId === bot.id && e.joined === true) {
        if (this.runs.has(bot.id)) return
        if (this.stateOf(bot.id).state !== 'done') {
          const res = { status: STATUS.OK, note: 'BedWars lobby confirmed' }
          this.byBot.set(bot.id, { state: 'done', result: res })
          bot.menuDone = true
          this.bus.emit('menu:state', { botId: bot.id, bot: bot.username, state: 'done', result: res })
        }
      }
    })

    // A reconnect invalidates the area: the server puts you back at spawn, so the menu has to be
    // walked again before the bot can act.
    this.#sub(EV.BOT_STATE, (e) => {
      if (e.botId !== bot.id || e.to !== 'DEAD') return
      this.#abort(bot.id)
      clearTimeout(this.recoveryTimers.get(bot.id))
      this.recoveryTimers.delete(bot.id)
      const want = this.enabled ? 'pending' : 'done'
      if (this.stateOf(bot.id).state === want) return
      this.byBot.set(bot.id, { state: want, result: null })
      bot.menuDone = false
      this.bus.emit('menu:state', { botId: bot.id, bot: bot.username, state: want })
    })
    return bot
  }

  stateOf (botId) { return this.byBot.get(botId) ?? { state: 'pending', result: null } }
  isRunning (botId) { return this.runs.has(botId) }

  /** Reason string when this bot must not act yet, or null when it may. Read by the engine gate. */
  blockReason (bot) {
    if (!this.gates) return null
    const st = this.stateOf(bot.id)
    if (st.state === 'done') return null
    if (st.state === 'failed') {
      return `${bot.username} never joined the menu area (${st.result?.error ?? 'the menu flow failed'})`
    }
    return `${bot.username} has not joined the menu area yet`
  }

  #abort (botId) {
    const controller = this.runs.get(botId)
    if (!controller) return false
    controller.abort()
    this.runs.delete(botId)
    return true
  }

  #scheduleRecovery (bot) {
    if (!this.enabled || !bot?.isReady() || this.stateOf(bot.id).state === 'done' || this.recoveryTimers.has(bot.id)) return
    const attempt = (this.recoveryAttempts.get(bot.id) ?? 0) + 1
    this.recoveryAttempts.set(bot.id, attempt)
    const maxAttempts = Math.max(0, Number(this.cfg.menu?.maxRecoveryAttempts ?? 0))
    if (maxAttempts > 0 && attempt > maxAttempts) return
    const base = Math.max(500, Number(this.cfg.menu?.recoveryBaseMs ?? 3000))
    const max = Math.max(base, Number(this.cfg.menu?.recoveryMaxMs ?? 30000))
    const delay = Math.min(max, base * (2 ** Math.min(attempt - 1, 4)))
    const timer = setTimeout(() => {
      this.recoveryTimers.delete(bot.id)
      if (!bot.isReady() || this.stateOf(bot.id).state === 'done') return
      const reconnectEvery = Math.max(0, Number(this.cfg.menu?.reconnectEveryRecoveryAttempts ?? 3))
      if (reconnectEvery > 0 && attempt % reconnectEvery === 0 && this.recoveryHandler) {
        this.log.warn?.(`[${bot.username}] BedWars entry recovery escalating to a clean reconnect`)
        Promise.resolve(this.recoveryHandler(bot, 'bedwars-entry-recovery'))
          .catch((error) => this.log.warn?.(`[${bot.username}] BedWars reconnect recovery failed: ${error.message}`))
        return
      }
      void this.#run(bot)
    }, delay)
    timer.unref?.()
    this.recoveryTimers.set(bot.id, timer)
    this.log.warn?.(`[${bot.username}] BedWars entry recovery scheduled in ${delay}ms (attempt ${attempt})`)
  }

  #wait (ms, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) { resolve(false); return }
      const onAbort = () => { clearTimeout(timer); resolve(false) }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve(true)
      }, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  #cancelled (bot) {
    return { action: 'menu', bot: bot.username, botId: bot.id, status: STATUS.BLOCKED, error: 'menu flow cancelled' }
  }

  /**
   * The selector owns a hotbar slot and a window, so it enters the same action lane as autoplay.
   * A reconnect may otherwise start this flow while a delayed BedWars task is still releasing its
   * keys or shop GUI. `supervised` is reserved for a caller that already owns a compatible lease.
   */
  async runForBot (bot, settleMs = 0, {
    signal = null, owner = 'menu', priority = 'safety', preempt = false, supervised = false, force = false
  } = {}) {
    if (!bot?.id) return this.#cancelled(bot ?? { username: 'bot', id: null })
    if (supervised || typeof this.supervisor?.run !== 'function') {
      return this.#runFlow(bot, settleMs, { signal, force })
    }
    return this.supervisor.run(bot, {
      owner,
      action: 'server_menu',
      priority,
      preempt,
      blocksCombat: true,
      // Selector verification includes a bounded BedWars-presence wait and optional retries.
      timeoutMs: 90_000
    }, async (context = {}) => {
      if (this.movement?.isWalking?.(bot.id) && typeof this.movement?.stopAndWait === 'function') {
        await this.movement.stopAndWait(bot)
      }
      if (typeof context.isCurrent === 'function' && !context.isCurrent()) return this.#cancelled(bot)
      return this.#runFlow(bot, settleMs, { signal: context.signal ?? signal, force })
    })
  }

  async #runFlow (bot, settleMs = 0, { signal: leaseSignal = null, force = false } = {}) {
    this.#abort(bot.id)
    const controller = new AbortController()
    const signal = controller.signal
    const abortFromLease = () => controller.abort(leaseSignal?.reason)
    if (leaseSignal?.aborted) abortFromLease()
    else leaseSignal?.addEventListener?.('abort', abortFromLease, { once: true })
    this.runs.set(bot.id, controller)
    let last = null
    try {
      if (settleMs > 0 && !(await this.#wait(settleMs, signal))) return this.#cancelled(bot)
      if (signal.aborted || !bot.isReady()) return this.#cancelled(bot)
      if (!this.enabled) { bot.menuDone = true; return null }
      if (!force && this.presence?.stateOf(bot.id)?.joined === true) {
        const res = { status: STATUS.OK, note: 'already in BedWars lobby' }
        if (this.runs.get(bot.id) !== controller) return this.#cancelled(bot)
        this.byBot.set(bot.id, { state: 'done', result: res })
        bot.menuDone = true
        this.bus.emit('menu:state', { botId: bot.id, bot: bot.username, state: 'done', result: res })
        return res
      }

      const attempts = Math.max(1, Number(this.cfg.menu?.retries ?? 3) + 1)
      for (let i = 1; i <= attempts; i++) {
        const r = await openMenu(bot, this.cfg, this.log, signal)
        last = r
        if (signal.aborted || this.runs.get(bot.id) !== controller) return this.#cancelled(bot)
        if (r.status === STATUS.OK) {
          if (this.presence && this.cfg.menu?.verifyBedwars !== false) {
            const deadline = Date.now() + 15000
            let verified = false
            while (Date.now() < deadline) {
              if (signal.aborted || this.runs.get(bot.id) !== controller) return this.#cancelled(bot)
              if (this.presence.stateOf(bot.id)?.joined === true) {
                verified = true
                break
              }
              if (!(await this.#wait(300, signal))) return this.#cancelled(bot)
            }
            if (!verified) {
              this.log.warn?.(`[${bot.username}] menu click OK but BedWars lobby not confirmed (attempt ${i}/${attempts})`)
              if (i < attempts) {
                if (!(await this.#wait(2000, signal))) return this.#cancelled(bot)
                continue
              }
              const failRes = { ...r, status: STATUS.FAILED, error: 'clicked menu but BedWars lobby was not confirmed' }
              this.byBot.set(bot.id, { state: 'failed', result: failRes })
              bot.menuDone = false
              this.bus.emit('menu:state', { botId: bot.id, bot: bot.username, state: 'failed', result: failRes })
              return failRes
            }
          }
          this.byBot.set(bot.id, { state: 'done', result: r })
          this.recoveryAttempts.delete(bot.id)
          clearTimeout(this.recoveryTimers.get(bot.id))
          this.recoveryTimers.delete(bot.id)
          bot.menuDone = true
          this.bus.emit('menu:state', { botId: bot.id, bot: bot.username, state: 'done', result: r })
          this.log.info?.(`[${bot.username}] in the area: "${r.opened?.title}" slot ${r.slot} (row ${r.row}, col ${r.col}) - BedWars confirmed!`)
          return r
        }
        this.log.warn?.(`[${bot.username}] menu attempt ${i}/${attempts} failed: ${r.error}`)
        if (i < attempts && !(await this.#wait(2000, signal))) return this.#cancelled(bot)
      }
      this.byBot.set(bot.id, { state: 'failed', result: last })
      bot.menuDone = false
      this.bus.emit('menu:state', { botId: bot.id, bot: bot.username, state: 'failed', result: last })
      return last
    } finally {
      leaseSignal?.removeEventListener?.('abort', abortFromLease)
      if (this.runs.get(bot.id) === controller) this.runs.delete(bot.id)
    }
  }

  async #run (bot) {
    const result = await this.runForBot(bot, 2000)
    if (bot.isReady() && this.enabled && this.stateOf(bot.id).state !== 'done') this.#scheduleRecovery(bot)
    return result
  }
}
