import { EV } from '../bus.js'
import { STATUS } from '../engine/classify.js'

export class PartyStatusBehaviour {
  constructor ({ cfg, bus, engine, tracker, log = console }) {
    this.cfg = cfg
    this.bus = bus
    this.engine = engine
    this.tracker = tracker
    this.log = log
    this.fleet = null
    this.states = new Map()
    this.inflight = new Map()
    this.suspended = new Set()
    this.retryAfter = new Map()
    this.subs = []
    this.timer = null
  }

  get enabled () {
    return !!this.engine.get('on') && !!this.engine.get('off')
  }

  attach (fleet) {
    this.fleet = fleet
    this.#sub(EV.BOT_READY, (e) => {
      const bot = this.#bot(e.botId)
      if (!bot) return
      this.suspended.delete(bot.id)
      this.states.set(bot.id, 'unknown')
      void this.#reconcile(bot)
    })
    this.#sub(EV.BOT_STATE, (e) => {
      if (e.to !== 'DEAD') return
      this.states.set(e.botId, 'unknown')
      this.inflight.delete(e.botId)
      this.suspended.delete(e.botId)
      this.retryAfter.delete(e.botId)
    })
    this.#sub('party:membership', (e) => {
      const bot = this.fleet?.bots.find((b) => b.username === e.bot)
      if (bot?.isReady()) void this.#reconcile(bot)
    })
    this.timer = setInterval(() => {
      if (!this.enabled) return
      for (const bot of this.fleet?.bots ?? []) {
        if (bot.isReady() && !this.suspended.has(bot.id)) void this.#reconcile(bot)
      }
    }, 3000)
    this.timer.unref?.()
    for (const bot of fleet.bots) {
      if (bot.isReady()) void this.#reconcile(bot)
    }
    return this
  }

  dispose () {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const off of this.subs) { try { off() } catch {} }
    this.subs = []
    this.inflight.clear()
    this.suspended.clear()
    this.retryAfter.clear()
    return this
  }

  stateOf (botId) {
    return this.states.get(botId) ?? 'unknown'
  }

  blockReason (bot) {
    if (!this.enabled) return null
    const role = this.tracker.entry(bot.username).role
    if (role === 'member' || role === 'leader') return null
    return this.stateOf(bot.id) === 'online' && bot.offline !== true
      ? null : `${bot.username} is not confirmed online yet`
  }

  async ensureOnline (bot, force = false) {
    return this.#ensure(bot, 'online', force)
  }

  async ensureOffline (bot, force = false) {
    return this.#ensure(bot, 'offline', force)
  }

  async prepareDisconnect (targets) {
    const bots = Array.isArray(targets) ? targets : [targets]
    return Promise.all(bots.map(async (bot) => {
      if (!bot?.isReady?.() || !bot.sendable?.()) return null
      this.suspended.add(bot.id)
      return this.ensureOnline(bot, true)
    }))
  }

  #sub (topic, fn) {
    this.subs.push(this.bus.on(topic, fn))
  }

  #bot (botId) {
    return this.fleet?.bots.find((b) => b.id === botId) ?? null
  }

  #desired (bot) {
    const role = this.tracker.entry(bot.username).role
    return role === 'member' || role === 'leader' ? 'offline' : 'online'
  }

  async #reconcile (bot) {
    if (!this.enabled || this.suspended.has(bot.id) || !bot.isReady()) return null
    if (Date.now() < (this.retryAfter.get(bot.id) ?? 0)) return null
    const desired = this.#desired(bot)
    const result = await this.#ensure(bot, desired, false)
    if (this.suspended.has(bot.id) || !bot.isReady()) return result
    const next = this.#desired(bot)
    if (next !== desired) return this.#ensure(bot, next, false)
    return result
  }

  async #ensure (bot, desired, force) {
    if (!this.enabled || !bot?.isReady?.() || !bot.sendable?.()) return null
    if (!force && Date.now() < (this.retryAfter.get(bot.id) ?? 0)) return null
    const pending = this.inflight.get(bot.id)
    if (pending) await pending
    if (!bot.isReady() || !bot.sendable()) return null
    if (!force && this.stateOf(bot.id) === desired && bot.offline === (desired === 'offline')) {
      return { status: STATUS.OK, note: `already ${desired}` }
    }
    const action = desired === 'online' ? 'on' : 'off'
    const run = bot.run(action, {}).then((result) => {
      if (result.status === STATUS.OK) {
        this.states.set(bot.id, desired)
        bot.offline = desired === 'offline'
        this.bus.emit('party:status', { botId: bot.id, bot: bot.username, state: desired, result })
        this.log.info?.(`[party] ${bot.username} status -> ${desired}`)
      } else {
        this.states.set(bot.id, 'unknown')
        this.log.warn?.(`[party] ${bot.username} could not switch status to ${desired}: ${result.status} ${result.response ?? result.error ?? ''}`)
      }
      return result
    }).catch((error) => {
      this.states.set(bot.id, 'unknown')
      this.log.warn?.(`[party] ${bot.username} status ${desired} failed: ${error.message}`)
      return { status: STATUS.ERROR, error: error.message }
    }).finally(() => {
      if (this.inflight.get(bot.id) === run) this.inflight.delete(bot.id)
    })
    this.inflight.set(bot.id, run)
    return run
  }
}
