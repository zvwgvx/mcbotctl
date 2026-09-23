// One BedWars opening: collect iron, discover a nearby shop NPC and its menu, buy wool,
// then bridge to configured nearby islands. A missing map route stops the run before movement.

import { EV } from '../bus.js'
import { waitForIron, buyWool } from './bedwars_shop.js'
import { walkToWaypoint, selectNeighborIsland, bridgeToNeighbor } from './bedwars_navigation.js'

const point = (p) => p && ['x', 'y', 'z'].every((k) => Number.isFinite(p[k]))

export class BedWarsBehaviour {
  constructor ({ cfg, bus, menu, movement, log = console }) {
    this.cfg = cfg
    this.bus = bus
    this.menu = menu
    this.movement = movement
    this.log = log
    this.fleet = null
    this.byBot = new Map()
    this.active = new Map()
    this.matchSeen = new Set()
    this.subs = []
  }

  get spec () { return this.cfg.bedwars ?? {} }

  stateOf (botId) {
    return this.byBot.get(botId) ?? { phase: 'idle', result: null, target: null, visited: [] }
  }

  isRunning (botId) { return this.active.has(botId) }

  #sub (topic, fn) { this.subs.push(this.bus.on(topic, fn)) }

  #set (bot, phase, extra = {}) {
    const state = { ...this.stateOf(bot.id), ...extra, phase }
    this.byBot.set(bot.id, state)
    this.bus.emit('bedwars:state', { botId: bot.id, bot: bot.username, ...state })
    return state
  }

  #actor () {
    const wanted = this.spec.actor
    if (wanted) return this.fleet?.bots.find((b) => b.username === wanted)
    return this.fleet?.leader
  }

  attach (fleet) {
    this.fleet = fleet
    for (const bot of fleet.bots) this.byBot.set(bot.id, { phase: 'idle', result: null, target: null, visited: [] })
    const maybeStart = (e) => {
      if (this.spec.enabled !== true || this.spec.autoStart === false) return
      const bot = this.#actor()
      if (!bot || e.botId !== bot.id || !bot.isReady()) return
      if (this.menu.stateOf(bot.id).state !== 'done') return
      if (String(this.spec.startMessage ?? '').trim() && !this.matchSeen.has(bot.id)) return
      if (this.stateOf(bot.id).phase !== 'idle') return
      this.start(bot)
    }
    this.#sub(EV.BOT_READY, maybeStart)
    this.#sub('menu:state', (e) => { if (e.state === 'done') maybeStart(e) })
    this.#sub(EV.MC_CHAT, (e) => {
      const text = String(this.spec.startMessage ?? '').trim()
      if (!text || !String(e.text ?? '').toLowerCase().includes(text.toLowerCase())) return
      this.matchSeen.add(e.botId)
      maybeStart(e)
    })
    // Intentional disconnects suppress MC_END, so the FSM is the reliable reset signal.
    this.#sub(EV.BOT_STATE, (e) => {
      if (e.to !== 'DEAD') return
      const bot = fleet.bots.find((b) => b.id === e.botId)
      if (!bot) return
      this.matchSeen.delete(bot.id)
      this.stop(bot, 'disconnected')
      this.#set(bot, 'idle', { result: null, target: null, visited: [], iron: null, wool: null, bridge: null })
    })
    return this
  }

  #preflight (bot) {
    if (!bot) return 'no BedWars bot selected'
    if (!bot.isReady() || !bot.transport?.connected) return `${bot.username} is not READY`
    if (!bot.transport.physics) return 'BedWars requires transport: "mineflayer"'
    if (this.menu.stateOf(bot.id).state !== 'done') return `${bot.username} has not completed the server selector`
    const g = this.spec.geometry
    if (!g?.home?.id || typeof g.home.id !== 'string') return 'bedwars.geometry.home.id is required'
    if (!point(g?.home?.generator)) return 'bedwars.geometry.home.generator requires x, y, z'
    if (!point(g?.home?.bridgeStart)) return 'bedwars.geometry.home.bridgeStart requires x, y, z'
    if (!Array.isArray(g?.islands) || !g.islands.length) return 'bedwars.geometry.islands must contain a target island'
    if (g.islands.some((i) => !i?.id || typeof i.id !== 'string')) return 'each bedwars.geometry.islands entry needs an id'
    if (!g.islands.some((i) => point(i?.bridgeEnd) || point(i?.center))) {
      return 'bedwars.geometry.islands needs a bridgeEnd or center coordinate'
    }
    if (!selectNeighborIsland(g, g.home.id, [g.home.id])) return 'no cardinal bridge route is configured from the home island'
    if (!Number.isInteger(this.spec.maxIslands ?? 1) || (this.spec.maxIslands ?? 1) < 1) {
      return 'bedwars.maxIslands must be a positive integer'
    }
    if (!Number.isInteger(this.spec.ironRequired ?? 16) || (this.spec.ironRequired ?? 16) < 1) {
      return 'bedwars.ironRequired must be a positive integer'
    }
    if (!Number.isInteger(this.spec.maxBridgeLength ?? 96) || (this.spec.maxBridgeLength ?? 96) < 1) {
      return 'bedwars.maxBridgeLength must be a positive integer'
    }
    if (!Number.isInteger(this.spec.bridgeStepTimeoutMs ?? 3000) || (this.spec.bridgeStepTimeoutMs ?? 3000) < 100) {
      return 'bedwars.bridgeStepTimeoutMs must be at least 100ms'
    }
    const shop = this.spec.shop ?? {}
    const mode = shop.mode || 'auto'
    if (!['auto', 'entity', 'block', 'hotbar'].includes(mode)) return 'bedwars.shop.mode must be auto, entity, block or hotbar'
    if (shop.woolSlot != null && (!Number.isInteger(shop.woolSlot) || shop.woolSlot < 0)) {
      return 'bedwars.shop.woolSlot must be a non-negative window slot when provided'
    }
    if (shop.maxDistance != null && (!Number.isFinite(shop.maxDistance) || shop.maxDistance <= 0)) {
      return 'bedwars.shop.maxDistance must be positive'
    }
    if (shop.interactionDistance != null && (!Number.isFinite(shop.interactionDistance) || shop.interactionDistance < 1.5 || shop.interactionDistance > 4)) {
      return 'bedwars.shop.interactionDistance must be between 1.5 and 4 blocks'
    }
    if (shop.maxMenuDepth != null && (!Number.isInteger(shop.maxMenuDepth) || shop.maxMenuDepth < 0 || shop.maxMenuDepth > 6)) {
      return 'bedwars.shop.maxMenuDepth must be an integer from 0 to 6'
    }
    if (shop.button != null && !['left', 'right'].includes(shop.button)) return 'bedwars.shop.button must be left or right'
    if (mode === 'block' && !point(shop.block)) return 'bedwars.shop.block requires x, y, z'
    if (mode === 'hotbar' && (!Number.isInteger(shop.hotbarSlot) || shop.hotbarSlot < 1 || shop.hotbarSlot > 9)) {
      return 'bedwars.shop.hotbarSlot must be 1–9'
    }
    return null
  }

  /** Starts in the background. Status is available through stateOf() and the bus. */
  start (bot = this.#actor()) {
    if (bot && this.active.has(bot.id)) return { ok: false, error: `${bot.username} already has a BedWars run` }
    const error = this.#preflight(bot)
    if (error) {
      if (bot) this.#set(bot, 'failed', { result: { status: 'FAILED', error } })
      return { ok: false, error }
    }
    const controller = new AbortController()
    this.active.set(bot.id, controller)
    this.#set(bot, 'starting', { result: null, target: null, visited: [], iron: null, wool: null, bridge: null })
    this.#run(bot, controller).catch((e) => {
      if (this.active.get(bot.id) === controller) {
        if (!controller.signal.aborted) this.#set(bot, 'failed', {
          result: { status: 'FAILED', error: e.message }
        })
      }
    }).finally(() => {
      if (this.active.get(bot.id) === controller) {
        this.active.delete(bot.id)
        bot.transport?.clearControls?.()
      }
    })
    return { ok: true, bot: bot.username }
  }

  stop (bot = this.#actor(), reason = 'stopped by operator') {
    if (!bot) return false
    const controller = this.active.get(bot.id)
    if (!controller || controller.signal.aborted) return false
    controller.abort()
    bot.transport?.clearControls?.()
    this.#set(bot, 'stopped', { result: { status: 'STOPPED', error: reason } })
    return true
  }

  async #run (bot, controller) {
    const signal = controller.signal
    const cfg = this.spec
    const geometry = cfg.geometry
    // A random-walk loop can still be finishing after stop(); wait until it releases controls.
    await this.movement.stopAndWait(bot)
    const moveOpts = { signal, timeoutMs: cfg.walkTimeoutMs ?? 30000 }
    const step = async (phase, fn) => {
      if (signal.aborted || !bot.isReady()) throw new Error('BedWars run stopped')
      this.#set(bot, phase)
      const result = await fn()
      if (signal.aborted || !bot.isReady()) throw new Error('BedWars run stopped')
      if (result?.status !== 'OK') {
        throw new Error(result.error ?? `${phase} failed`)
      }
      return result
    }

    await step('to_generator', () => walkToWaypoint(bot, geometry.home.generator, moveOpts))
    const iron = await step('collecting_iron', () => waitForIron(bot, cfg, { signal }))
    this.#set(bot, 'iron_ready', { iron: iron.iron ?? iron.count ?? null })
    const purchase = await step('finding_shop', () => buyWool(bot, cfg, this.log, {
      signal,
      onPhase: (phase, detail = {}) => {
        if (this.active.get(bot.id) === controller && !signal.aborted) this.#set(bot, phase, detail)
      }
    }))
    this.#set(bot, 'wool_ready', { iron: purchase.iron ?? null, wool: purchase.wool ?? null })

    const visited = new Set([geometry.home.id ?? 'home'])
    let fromId = geometry.home.id ?? 'home'
    const limit = Math.min(Math.max(1, Number(cfg.maxIslands ?? 1)), geometry.islands.length)
    for (let n = 0; n < limit; n++) {
      const target = selectNeighborIsland(geometry, fromId, visited)
      if (!target) throw new Error(`no reachable neighboring island from ${fromId}`)
      this.#set(bot, 'bridging', { target: target.id, visited: [...visited] })
      const result = await step('bridging', () => bridgeToNeighbor(bot, geometry, {
        fromId, targetId: target.id, signal,
        maxDistance: cfg.maxBridgeLength ?? 96,
        stepTimeoutMs: cfg.bridgeStepTimeoutMs ?? 3000
      }, this.log))
      if (result?.status !== 'OK') throw new Error(`${result?.error ?? `did not reach ${target.id}`} (placed ${result?.placed ?? 0}, steps ${result?.steps ?? 0})`)
      visited.add(target.id)
      fromId = target.id
      this.#set(bot, 'island_reached', { target: target.id, visited: [...visited], bridge: result })
    }
    if (this.active.get(bot.id) === controller) {
      this.#set(bot, 'done', {
        result: { status: 'OK', response: `reached ${visited.size - 1} neighboring island(s)` },
        target: fromId, visited: [...visited]
      })
    }
  }

  dispose () {
    for (const controller of this.active.values()) controller.abort()
    this.active.clear()
    this.matchSeen.clear()
    for (const off of this.subs) { try { off() } catch {} }
    this.subs = []
  }
}
