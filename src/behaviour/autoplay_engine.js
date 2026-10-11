// autoplay_engine.js — conservative per-bot BedWars policy.
//
// The policy chooses a task; ActionSupervisor owns the lease that permits that task to use
// movement, inventory, menus, or view controls.  This separation prevents a stale task from
// interfering with a manual action, a reconnect, or a new match.

import { EV } from '../bus.js'
import { resourceCounts, waitForIron, buyWool, locateIronGenerator } from './bedwars_shop.js'
import { walkToWaypoint, selectNeighborIsland, bridgeToNeighbor } from './bedwars_navigation.js'
import { bedwarsRoamSpec, roamSupportedLoop } from './bedwars_roam.js'
import { nativePosition, nativeVelocity } from './motion_safety.js'

const DEFAULTS = Object.freeze({
  enabled: false,
  autoStart: false,
  matchDebounceMs: 1750,
  actionCooldownMs: 350,
  recoverDelayMs: 1000,
  maxActionFailures: 3,
  maxIslands: 1,
  minWool: 16,
  bridgeWoolBuffer: 2,
  combatWindowMs: 1000,
  cancelGraceMs: 1500
})

function finitePoint (point) {
  return !!point && ['x', 'y', 'z'].every((axis) => Number.isFinite(point[axis]))
}

function int (value, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value)
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback
}

function number (value, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const result = Number(value)
  return Number.isFinite(result) && result >= min && result <= max ? result : fallback
}

function resultStatus (result, fallback = 'FAILED') {
  const status = String(result?.status ?? fallback).trim().toUpperCase()
  return status || fallback
}

function errorText (error, fallback = 'task failed') {
  const text = String(error?.message ?? error ?? fallback).trim()
  return (text || fallback).slice(0, 280)
}

function connectionToken (bot) {
  const generation = Number(bot?.transport?.connectionGeneration)
  if (Number.isInteger(generation) && generation >= 0) return `generation:${generation}`
  const joinedAt = Number(bot?.joinedAt)
  if (Number.isFinite(joinedAt) && joinedAt > 0) return `joined:${joinedAt}`
  // Fixtures and alternate transports do not always expose a connection generation.
  return `state:${String(bot?.fsm?.state ?? '')}:${String(bot?.transport?.state ?? '')}`
}

function inventory (bot) {
  try {
    const items = resourceCounts(bot) ?? {}
    return {
      iron: Math.max(0, Number(items.iron) || 0),
      gold: Math.max(0, Number(items.gold) || 0),
      diamond: Math.max(0, Number(items.diamond) || 0),
      emerald: Math.max(0, Number(items.emerald) || 0),
      wool: Math.max(0, Number(items.wool) || 0)
    }
  } catch {
    return { iron: 0, gold: 0, diamond: 0, emerald: 0, wool: 0 }
  }
}

function emptyRoam () {
  return {
    state: 'idle',
    segments: 0,
    input: null,
    heading: null,
    yaw: null,
    position: null,
    velocity: null,
    onGround: null,
    replan: null,
    updatedAt: null,
    lastSafetyStop: null
  }
}

function copyRoam (roam) {
  if (!roam || typeof roam !== 'object') return emptyRoam()
  return {
    ...emptyRoam(),
    ...roam,
    position: roam.position && typeof roam.position === 'object' ? { ...roam.position } : null,
    velocity: roam.velocity && typeof roam.velocity === 'object' ? { ...roam.velocity } : null,
    lastSafetyStop: roam.lastSafetyStop && typeof roam.lastSafetyStop === 'object' ? { ...roam.lastSafetyStop } : null
  }
}

function wait (ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false)
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => done(false)
    const timer = setTimeout(() => done(true), Math.max(0, ms))
    timer.unref?.()
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * MVP autoplay is intentionally a small policy loop: generator -> wool shop -> configured
 * neighboring bridge.  Shop discovery remains dynamic in buyWool(); map traversal fails closed
 * when the server/map has no configured safe route instead of wandering in a lobby or void.
 */
export class AutoplayEngine {
  constructor ({ cfg, bus, supervisor = null, presence = null, menu = null, bedwars = null, movement = null, combat = null, log = console } = {}) {
    if (!bus?.on || !bus?.emit) throw new Error('AutoplayEngine needs an event bus')
    this.cfg = cfg ?? {}
    this.bus = bus
    this.supervisor = supervisor
    this.presence = presence
    this.menu = menu
    this.bedwars = bedwars
    this.movement = movement
    this.combat = combat
    this.log = log
    this.fleet = null
    this.states = new Map()
    // Generator observations span a roam session within one match, but are deliberately kept out
    // of the public state/API and discarded on every match or connection boundary.
    this.generatorSightings = new Map()
    this.runs = new Map()
    this.startTimers = new Map()
    this.subs = []
    this.disposed = false
  }

  get enabled () { return this.cfg.autoplay?.enabled === true }

  get spec () {
    const raw = this.cfg.autoplay ?? {}
    // Sandbox configs called this tickMs.  Retain it as a cooldown alias during migration.
    const cooldown = raw.actionCooldownMs ?? raw.tickMs
    return {
      ...DEFAULTS,
      ...raw,
      matchDebounceMs: int(raw.matchDebounceMs ?? raw.startDebounceMs, DEFAULTS.matchDebounceMs, 0, 15000),
      actionCooldownMs: int(cooldown, DEFAULTS.actionCooldownMs, 0, 10000),
      recoverDelayMs: int(raw.recoverDelayMs, DEFAULTS.recoverDelayMs, 0, 30000),
      maxActionFailures: int(raw.maxActionFailures, DEFAULTS.maxActionFailures, 1, 20),
      maxIslands: int(raw.maxIslands ?? this.cfg.bedwars?.maxIslands, DEFAULTS.maxIslands, 1, 32),
      minWool: int(raw.minWool, DEFAULTS.minWool, 1, 512),
      bridgeWoolBuffer: int(raw.bridgeWoolBuffer, DEFAULTS.bridgeWoolBuffer, 0, 64),
      combatWindowMs: int(raw.combatWindowMs, DEFAULTS.combatWindowMs, 100, 10_000),
      cancelGraceMs: int(raw.cancelGraceMs, DEFAULTS.cancelGraceMs, 100, 10000)
    }
  }

  #sub (topic, listener) { this.subs.push(this.bus.on(topic, listener)) }
  #botFor (id) { return this.fleet?.bots?.find((bot) => bot.id === id) ?? null }

  #presence (botId) {
    try { return this.presence?.stateOf?.(botId) ?? { stage: null } } catch { return { stage: null } }
  }

  #inMatch (botId) {
    return this.#presence(botId).stage === 'match'
  }

  #newState (bot) {
    return {
      bot: bot.username,
      botId: bot.id,
      phase: this.enabled ? 'idle' : 'disabled',
      status: this.enabled ? 'IDLE' : 'DISABLED',
      action: null,
      armed: false,
      force: false,
      source: null,
      reason: null,
      presenceStage: this.#presence(bot.id).stage ?? null,
      matchEpoch: 0,
      connection: connectionToken(bot),
      currentIsland: null,
      target: null,
      visited: [],
      generator: null,
      atGenerator: false,
      roam: emptyRoam(),
      actions: 0,
      failures: 0,
      collections: 0,
      interactions: 0,
      bridges: 0,
      startedAt: null,
      stoppedAt: null,
      updatedAt: Date.now(),
      lastObservation: null,
      lastResult: null
    }
  }

  #state (bot) {
    if (!bot?.id) return null
    let state = this.states.get(bot.id)
    if (!state) {
      state = this.#newState(bot)
      this.states.set(bot.id, state)
    }
    return state
  }

  #copyState (state) {
    if (!state) return null
    return {
      ...state,
      // Keep the wire format explicit. The browser and external dashboard clients should not
      // need intimate knowledge of the planner's internal `action`/`reason` field names.
      task: state.action ?? null,
      blockedReason: state.phase === 'blocked' ? state.reason ?? null : null,
      error: state.phase === 'failed' ? state.reason ?? state.lastResult?.error ?? null : null,
      visited: [...(state.visited ?? [])],
      generator: state.generator ? { ...state.generator, point: state.generator.point ? { ...state.generator.point } : null } : null,
      roam: copyRoam(state.roam),
      lastObservation: state.lastObservation ? {
        ...state.lastObservation,
        position: state.lastObservation.position ? { ...state.lastObservation.position } : null,
        velocity: state.lastObservation.velocity ? { ...state.lastObservation.velocity } : null,
        resources: { ...(state.lastObservation.resources ?? {}) },
        combat: state.lastObservation.combat ? { ...state.lastObservation.combat } : null
      } : null,
      lastResult: state.lastResult ? { ...state.lastResult } : null
    }
  }

  #set (bot, patch = {}) {
    const current = this.#state(bot)
    if (!current) return null
    const next = { ...current, ...patch, updatedAt: Date.now() }
    if (patch.visited) next.visited = [...patch.visited]
    if (patch.generator) next.generator = { ...patch.generator, point: patch.generator.point ? { ...patch.generator.point } : null }
    if (Object.prototype.hasOwnProperty.call(patch, 'roam')) next.roam = copyRoam(patch.roam)
    this.states.set(bot.id, next)
    this.bus.emit('autoplay:state', this.#copyState(next))
    return next
  }

  #phase (bot, phase, action = null, patch = {}) {
    return this.#set(bot, { phase, status: String(phase ?? 'idle').toUpperCase(), action, ...patch })
  }

  attach (fleet) {
    if (!fleet?.bots || !Array.isArray(fleet.bots)) throw new Error('AutoplayEngine.attach needs a fleet')
    if (this.fleet && this.fleet !== fleet) this.dispose()
    this.disposed = false
    this.fleet = fleet
    for (const bot of fleet.bots) {
      const state = this.#state(bot)
      if (this.enabled && this.spec.autoStart && !state.armed) this.#set(bot, { armed: true, source: 'autoStart', reason: null })
    }
    this.#sub(EV.BOT_READY, (event) => this.#onReady(event))
    this.#sub(EV.BOT_STATE, (event) => {
      if (event.to === 'DEAD' || event.to === 'DISCONNECTED') this.#onDead(event)
    })
    this.#sub('bedwars:presence', (event) => this.#onPresence(event))
    this.#sub('menu:state', (event) => this.#onMenu(event))
    this.#sub(EV.ACTION_LEASE, (event) => this.#onLease(event))
    for (const bot of fleet.bots) {
      const state = this.#state(bot)
      if (state.armed) this.#maybeStart(bot, state.source ?? 'attach')
    }
    return this
  }

  dispose () {
    this.disposed = true
    this.generatorSightings.clear()
    for (const handle of this.startTimers.values()) clearTimeout(handle.timer)
    this.startTimers.clear()
    for (const bot of this.fleet?.bots ?? []) void this.requestStop(bot, { source: 'dispose', disarm: true })
    for (const off of this.subs.splice(0)) { try { off() } catch {} }
    return this
  }

  /** Arm now; execute only after READY and positive `presence.stage === 'match'` evidence.
   * `force` is an expedited debounce for a confirmed match, never a bypass for that evidence. */
  requestStart (bot, { source = 'operator', arm = true, force = false } = {}) {
    if (!bot?.id) return { ok: false, error: 'bot is required' }
    if (!this.enabled) {
      this.#phase(bot, 'disabled', null, { armed: false, source, reason: 'autoplay is disabled by configuration' })
      return { ok: false, botId: bot.id, error: 'autoplay is disabled by configuration' }
    }
    const state = this.#state(bot)
    this.generatorSightings.delete(bot.id)
    const armed = arm === false ? state.armed : true
    const isForced = force === true && this.#presence(bot.id).stage === 'match'
    const forceNote = force === true && !isForced ? 'start requested; waiting for confirmed BedWars match' : null
    this.#set(bot, { armed, force: isForced, source, reason: forceNote, stoppedAt: null })
    if (isForced && this.runs.has(bot.id)) {
      void this.#cancelRun(bot, 'forced restart').then(() => {
        if (!this.disposed && this.#state(bot).armed) {
          this.#maybeStart(bot, source)
        }
      })
    } else {
      this.#maybeStart(bot, source)
    }
    const next = this.#state(bot)
    return { ok: true, bot: bot.username, botId: bot.id, armed: next.armed, force: next.force, phase: next.phase, alreadyRunning: this.runs.has(bot.id) }
  }

  /** Stop the active lease and, by default, disarm future BedWars matches as well. */
  async requestStop (bot, { source = 'operator', disarm = true } = {}) {
    if (!bot?.id) return { ok: false, error: 'bot is required' }
    this.#clearStartTimer(bot.id)
    const state = this.#state(bot)
    const armed = disarm === false ? state.armed : false
    const stopping = this.runs.has(bot.id)
    this.#set(bot, { armed, force: false, source, stoppedAt: Date.now(), reason: `stopped by ${source}` })
    await this.#cancelRun(bot, `stopped by ${source}`)
    this.#phase(bot, armed ? 'armed_waiting_match' : 'stopped', null, { armed, force: false, source, reason: `stopped by ${source}` })
    return { ok: true, bot: bot.username, botId: bot.id, armed, stopping, phase: this.#state(bot).phase }
  }

  start (bot, options = {}) { return this.requestStart(bot, { source: 'api', arm: true, ...options }) }
  stop (bot, options = {}) { return this.requestStop(bot, { source: 'api', disarm: true, ...options }) }
  isRunning (botId) { return this.runs.has(botId) }
  stateOf (botId) { return this.#copyState(this.states.get(botId) ?? null) }
  snapshot () { return [...this.states.values()].map((state) => this.#copyState(state)) }

  #onReady (event) {
    const bot = this.#botFor(event.botId)
    if (!bot || this.disposed) return
    const state = this.#state(bot)
    this.#set(bot, { connection: connectionToken(bot), stoppedAt: null })
    if (this.enabled && this.spec.autoStart && !state.armed) {
      this.requestStart(bot, { source: 'autoStart', arm: true })
    } else if (state.armed) {
      this.#maybeStart(bot, state.source ?? 'ready')
    }
  }

  #onDead (event) {
    const bot = this.#botFor(event.botId)
    if (!bot) return
    this.#clearStartTimer(bot.id)
    const state = this.#state(bot)
    this.generatorSightings.delete(bot.id)
    void this.#cancelRun(bot, 'bot disconnected')
    this.#phase(bot, state.armed ? 'armed_waiting_ready' : 'stopped', null, {
      matchEpoch: state.matchEpoch + 1,
      connection: connectionToken(bot),
      presenceStage: null,
      generator: null,
      atGenerator: false,
      roam: emptyRoam(),
      reason: 'bot disconnected'
    })
  }

  #onPresence (event) {
    const bot = this.#botFor(event.botId)
    if (!bot || this.disposed) return
    const state = this.#state(bot)
    const oldMatch = state.presenceStage === 'match'
    const nextStage = event.stage ?? null
    const nextMatch = nextStage === 'match'
    const matchEpoch = oldMatch === nextMatch ? state.matchEpoch : state.matchEpoch + 1
    if (oldMatch !== nextMatch) this.generatorSightings.delete(bot.id)
    this.#set(bot, {
      presenceStage: nextStage,
      matchEpoch,
      ...(oldMatch !== nextMatch ? {
        currentIsland: null, target: null, visited: [], generator: null, atGenerator: false,
        roam: emptyRoam(), failures: 0
      } : {})
    })
    if (!nextMatch) {
      this.#clearStartTimer(bot.id)
      if (this.runs.has(bot.id)) void this.#cancelRun(bot, 'BedWars match evidence ended')
      if (this.#state(bot).armed) this.#phase(bot, 'armed_waiting_match', null, {
        force: false, reason: 'waiting for confirmed BedWars match'
      })
      return
    }
    if (this.#state(bot).armed) this.#maybeStart(bot, this.#state(bot).source ?? 'presence')
  }

  #onMenu (event) {
    if (event?.state !== 'done') return
    const bot = this.#botFor(event.botId)
    if (!bot || this.disposed) return
    const state = this.#state(bot)
    if (state.armed && this.#inMatch(bot.id)) this.#maybeStart(bot, state.source ?? 'menu-ready')
  }

  #onLease (event) {
    if (!['completed', 'cancelled', 'failed', 'forced-release'].includes(event?.phase)) return
    const bot = this.#botFor(event.botId)
    if (!bot || this.disposed) return
    const state = this.#state(bot)
    if (state.armed && this.#inMatch(bot.id) && !this.runs.has(bot.id) && !this.startTimers.has(bot.id)) {
      this.#maybeStart(bot, state.source ?? 'action-released')
    }
  }

  #clearStartTimer (botId) {
    const handle = this.startTimers.get(botId)
    if (!handle) return false
    clearTimeout(handle.timer)
    this.startTimers.delete(botId)
    return true
  }

  #guard (bot) {
    const state = this.#state(bot)
    return { matchEpoch: state.matchEpoch, connection: connectionToken(bot) }
  }

  #guardCurrent (bot, guard) {
    const state = this.#state(bot)
    return !this.disposed && !!state?.armed && bot?.isReady?.() === true && bot?.transport?.connected === true &&
      this.#inMatch(bot.id) && state.matchEpoch === guard.matchEpoch && connectionToken(bot) === guard.connection
  }

  #maybeStart (bot, source) {
    if (!bot?.id || this.disposed) return
    const state = this.#state(bot)
    if (!this.enabled) {
      this.#phase(bot, 'disabled', null, { armed: false, reason: 'autoplay is disabled by configuration' })
      return
    }
    if (!state.armed) {
      this.#phase(bot, 'idle', null, { reason: null })
      return
    }
    if (!bot.isReady?.() || !bot.transport?.connected) {
      this.#phase(bot, 'armed_waiting_ready', null, { reason: 'waiting for READY connection' })
      return
    }
    if (!this.#inMatch(bot.id)) {
      this.#phase(bot, 'armed_waiting_match', null, { reason: 'waiting for confirmed BedWars match' })
      return
    }
    if (this.runs.has(bot.id) || this.startTimers.has(bot.id)) return
    if (typeof this.supervisor?.run !== 'function') {
      this.#phase(bot, 'blocked', null, { reason: 'autoplay ActionSupervisor is not available' })
      return
    }
    const active = this.supervisor.activeOf?.(bot.id)
    if (active) {
      this.#phase(bot, 'armed_waiting_action', null, {
        source, reason: `waiting for ${active.owner}:${active.action} to release controls`
      })
      return
    }
    const guard = this.#guard(bot)
    const debounceMs = state.force ? 100 : this.spec.matchDebounceMs
    this.#phase(bot, 'starting', null, {
      source,
      reason: state.force ? 'match confirmed; expedited start in 100ms' : `match confirmed; starting in ${this.spec.matchDebounceMs}ms`
    })
    const timer = setTimeout(() => {
      this.startTimers.delete(bot.id)
      if (this.#guardCurrent(bot, guard)) this.#begin(bot, guard, source)
    }, debounceMs)
    timer.unref?.()
    this.startTimers.set(bot.id, { timer, guard })
  }

  #preflight (bot) {
    if (!bot?.isReady?.() || !bot.transport?.connected) return 'bot is no longer READY'
    if (!bot.transport?.physics) return 'autoplay needs the Mineflayer physics transport'
    if (typeof this.supervisor?.run !== 'function') return 'autoplay ActionSupervisor is not available'
    const menuState = this.menu?.stateOf?.(bot.id)
    if (menuState?.state && menuState.state !== 'done') {
      return this.menu?.isRunning?.(bot.id)
        ? 'the server selector menu is still active'
        : 'the server selector menu has not completed'
    }
    if (this.bedwars?.isRunning?.(bot.id)) return 'the legacy BedWars opening is still active'
    return null
  }

  #begin (bot, guard, source) {
    if (!this.#guardCurrent(bot, guard) || this.runs.has(bot.id)) return
    const active = this.supervisor?.activeOf?.(bot.id)
    if (active) {
      this.#phase(bot, 'armed_waiting_action', null, {
        source, reason: `waiting for ${active.owner}:${active.action} to release controls`
      })
      return
    }
    const error = this.#preflight(bot)
    if (error) {
      this.#phase(bot, 'blocked', null, { source, reason: error })
      return
    }
    const home = this.cfg.bedwars?.geometry?.home ?? { id: 'spawn' }
    const homeId = String(home.id ?? '').trim() || 'spawn'
    this.generatorSightings.delete(bot.id)
    const controller = new AbortController()
    const run = { bot, controller, guard, source, done: null }
    this.runs.set(bot.id, run)
    this.#phase(bot, 'starting', null, {
      source,
      reason: null,
      startedAt: Date.now(),
      currentIsland: homeId,
      target: null,
      visited: [homeId],
      generator: null,
      atGenerator: false,
      roam: emptyRoam(),
      failures: 0,
      lastResult: null
    })
    run.done = this.#run(bot, run)
      .catch((error) => {
        if (!controller.signal.aborted && this.#guardCurrent(bot, guard)) {
          this.#phase(bot, 'failed', null, { reason: errorText(error), lastResult: { status: 'FAILED', error: errorText(error) } })
        }
      })
      .finally(() => {
        if (this.runs.get(bot.id) !== run) return
        this.runs.delete(bot.id)
        // A new match may arrive while the old action settles.  Only reevaluate after release.
        const state = this.#state(bot)
        // Restart only for a newer match epoch.  A normal BLOCKED result deliberately stays
        // visible instead of spinning through the same unsafe plan, while a transfer that
        // completed during cancellation gets a fresh start after this lease releases.
        if (state.armed && this.#inMatch(bot.id) && !this.disposed && state.matchEpoch !== guard.matchEpoch) {
          this.#maybeStart(bot, state.source ?? 'settled')
        }
      })
  }

  async #cancelRun (bot, reason) {
    const run = this.runs.get(bot?.id)
    if (!run) return false
    try { run.controller.abort(reason) } catch {}
    try {
      await this.supervisor?.cancel?.(bot, reason)
    } catch (error) {
      this.log.warn?.(`[${bot.username}] autoplay cancellation failed: ${errorText(error)}`)
    } finally {
      // A supervisor may force-release an executor that ignored AbortSignal. The controller and
      // helper guards make that old run inert; removing its bookkeeping now lets a preserved arm
      // start cleanly after a selector/menu transition instead of being stuck behind a stale map.
      if (this.runs.get(bot.id) === run) this.runs.delete(bot.id)
    }
    return true
  }

  #observe (bot) {
    const position = nativePosition(bot.transport)
    const velocity = nativeVelocity(bot.transport)
    let combat = null
    try { combat = this.combat?.stateOf?.(bot.id) ?? null } catch {}
    return {
      at: Date.now(),
      position: position ? { x: position.x, y: position.y, z: position.z } : null,
      velocity: velocity ? { ...velocity } : null,
      resources: inventory(bot),
      onGround: bot.transport?.mc?.entity?.onGround === true,
      health: number(bot.transport?.mc?.health ?? bot.transport?.mc?.entity?.health, null, 0, 100),
      openWindow: bot.transport?.openWindow ? {
        title: String(bot.transport.openWindow.title ?? '').slice(0, 120),
        windowId: bot.transport.openWindow.windowId ?? null
      } : null,
      combat: combat ? {
        state: combat.state ?? null,
        target: combat.target ?? null,
        distance: Number.isFinite(combat.distance) ? combat.distance : null,
        reason: combat.reason ?? null
      } : null
    }
  }

  #plan (bot, observation) {
    const state = this.#state(bot)
    const cfg = this.cfg.bedwars ?? {}
    const geometry = cfg.geometry ?? null
    const home = geometry?.home ?? { id: 'spawn' }
    const homeId = String(home.id ?? '').trim() || 'spawn'
    if (observation.openWindow) return { status: 'BLOCKED', error: `another menu is open: ${observation.openWindow.title || 'unknown window'}` }

    // A roam action yields its lease as soon as CombatBehaviour observes an approved nearby
    // enemy. Keep the lease free briefly so combat can acquire, turn, and use normal Mineflayer
    // attack packets without competing with movement controls or a view update.
    const combatState = observation.combat?.state
    if (observation.combat?.target && ['nearby', 'acquiring', 'targeting', 'cooldown', 'attacked'].includes(combatState)) {
      return {
        action: 'combat_window', passive: true, target: observation.combat.target,
        delayMs: this.spec.combatWindowMs, reason: `yielding controls to combat for ${observation.combat.target}`
      }
    }

    const fromId = state.currentIsland ?? homeId

    const configuredGenerator = finitePoint(home.generator)
      ? { point: { ...home.generator }, source: 'configured', sightings: null, distance: null }
      : null
    const discoveredGenerator = finitePoint(state.generator?.point) ? state.generator : null
    const generator = configuredGenerator ?? discoveredGenerator
    const walkTimeoutMs = int(cfg.walkTimeoutMs, 30000, 2000, 120000)

    // A missing map coordinate is not permission to claim the spawn is a generator. Explore in
    // one continuous, floor-checked native-input session while looking for distinct iron drops
    // or a time-separated pickup cadence at one cell, then route only to that observed cell.
    // This keeps unknown maps active without walking blindly into an unloaded edge.
    if (!generator && fromId === homeId) {
      if (cfg.generatorDiscovery?.enabled === false) {
        return { status: 'BLOCKED', error: 'no generator coordinate is configured and dynamic generator discovery is disabled' }
      }
      const roam = bedwarsRoamSpec(cfg)
      const completedSegments = Math.max(0, Number(state.roam?.segments) || 0)
      if (roam.enabled) {
        if (!roam.continuous && completedSegments >= roam.maxSegments) {
          return {
            status: 'BLOCKED',
            error: `no generator evidence after ${completedSegments} safe roaming segments; configure bedwars.geometry.home.generator or adjust bedwars.roam.maxSegments`
          }
        }
        const generatorSightings = this.generatorSightings.get(bot.id) ?? new Map()
        this.generatorSightings.set(bot.id, generatorSightings)
        return {
          action: 'roam_match', target: 'loaded supported floor', timeoutMs: roam.actionTimeoutMs,
          execute: async (signal, context = {}) => roamSupportedLoop(bot, cfg, {
            signal,
            isCurrent: context.isCurrent,
            canCleanup: context.canCleanup,
            initialSegments: completedSegments,
            generatorSightings,
            shouldYield: () => {
              const combat = this.combat?.stateOf?.(bot.id)
              return combat?.state === 'nearby' && combat?.target
                ? { target: combat.target, distance: Number.isFinite(combat.distance) ? combat.distance : null }
                : null
            },
            onProgress: (nextRoam) => {
              const run = this.runs.get(bot.id)
              const leaseCurrent = typeof context.isCurrent !== 'function' || context.isCurrent() !== false
              // The supervisor has its own AbortSignal, so identity-comparing it with the
              // engine run's controller would suppress every live telemetry update. Lease
              // currentness is the authoritative stale-action guard here.
              if (!run || signal?.aborted || !leaseCurrent) return
              const reportedSegments = Math.max(completedSegments, Number(nextRoam?.segments) || 0)
              this.#set(bot, { roam: { ...nextRoam, segments: reportedSegments } })
            }
          }),
          apply: (result, before) => {
            const generator = result?.generator ?? null
            const distance = Number(generator?.distance)
            const resultSegments = Math.max(completedSegments, Math.floor(Number(result?.segments) || completedSegments))
            const segmentCount = roam.continuous
              ? resultSegments
              : Math.min(roam.maxSegments, resultSegments)
            return {
              generator: generator ? { ...generator, point: generator.point ? { ...generator.point } : null } : before.generator,
              atGenerator: !!generator && Number.isFinite(distance) && distance <= 1.25,
              currentIsland: homeId,
              roam: { ...copyRoam(result?.roam), segments: segmentCount }
            }
          }
        }
      }
      const timeoutMs = int(cfg.generatorDiscovery?.timeoutMs, 8000, 1000, 30000)
      return {
        action: 'locate_generator', timeoutMs,
        execute: async (signal, context = {}) => locateIronGenerator(bot, cfg, {
          signal, isCurrent: context.isCurrent
        }),
        apply: (result) => ({
          generator: result?.generator ?? null,
          atGenerator: result?.atGenerator === true,
          currentIsland: homeId
        })
      }
    }

    if (!state.atGenerator && fromId === homeId && generator) {
      const destination = generator.point
      return {
        action: 'to_generator', target: `${destination.x},${destination.y},${destination.z}`, timeoutMs: walkTimeoutMs,
        execute: async (signal, context = {}) => walkToWaypoint(bot, destination, {
          signal, timeoutMs: walkTimeoutMs, isCurrent: context.isCurrent, canCleanup: context.canCleanup
        }),
        apply: { generator, atGenerator: true, currentIsland: homeId }
      }
    }

    const ironRequired = int(cfg.ironRequired, 16, 1, 256)
    const target = geometry
      ? selectNeighborIsland(geometry, fromId, new Set(state.visited ?? [homeId]))
      : null
    // This is only a purchase target.  bridgeToNeighbor independently validates the exact route.
    const roughDistance = target?.bridgeEnd && home?.bridgeStart
      ? Math.abs(target.bridgeEnd.x - home.bridgeStart.x) + Math.abs(target.bridgeEnd.z - home.bridgeStart.z)
      : 0
    const woolNeeded = Math.max(this.spec.minWool, roughDistance + this.spec.bridgeWoolBuffer)
    if (observation.resources.wool < woolNeeded) {
      if (observation.resources.iron < ironRequired) {
        const timeoutMs = int(cfg.collectTimeoutMs, 120000, 2000, 300000)
        return {
          action: 'collect_iron', timeoutMs,
          execute: async (signal, context = {}) => waitForIron(bot, cfg, {
            signal, isCurrent: context.isCurrent, timeoutStatus: 'BLOCKED'
          }),
          apply: { collections: state.collections + 1, atGenerator: true, currentIsland: fromId }
        }
      }
      const collectTimeoutMs = int(cfg.collectTimeoutMs, 120000, 2000, 300000)
      return {
        action: 'buy_wool', timeoutMs: Math.min(300000, collectTimeoutMs + 45000),
        execute: async (signal, context = {}) => buyWool(bot, cfg, this.log, {
          signal,
          isCurrent: context.isCurrent,
          canCleanup: context.canCleanup,
          onPhase: (phase, detail = {}) => {
            if (this.runs.has(bot.id) && !signal?.aborted) this.#phase(bot, 'acting', 'buy_wool', { shopPhase: phase, shopDetail: { ...detail } })
          }
        }),
        apply: { interactions: state.interactions + 1 }
      }
    }

    const completed = Math.max(0, (state.visited?.length ?? 1) - 1)
    if (completed >= this.spec.maxIslands) {
      return { status: 'BLOCKED', error: 'configured opening route completed; waiting for combat or a new match' }
    }
    if (!target) return { status: 'BLOCKED', error: `no configured neighboring bridge route from ${fromId}` }

    const stepTimeoutMs = int(cfg.bridgeStepTimeoutMs, 3000, 100, 15000)
    return {
      action: 'bridge_neighbor', target: target.id,
      timeoutMs: Math.min(300000, Math.max(20000, stepTimeoutMs * 110)),
      execute: async (signal, context = {}) => bridgeToNeighbor(bot, geometry, {
        fromId,
        targetId: target.id,
        visitedIds: state.visited ?? [homeId],
        signal,
        isCurrent: context.isCurrent,
        canCleanup: context.canCleanup,
        maxDistance: int(cfg.maxBridgeLength, 96, 1, 512),
        stepTimeoutMs
      }, this.log),
      apply: {
        currentIsland: target.id,
        target: target.id,
        visited: [...(state.visited ?? [homeId]), target.id],
        bridges: state.bridges + 1,
        atGenerator: false
      }
    }
  }

  async #runTask (bot, run, plan) {
    if (typeof this.supervisor?.run !== 'function') return { status: 'BLOCKED', error: 'autoplay ActionSupervisor is not available' }
    try {
      // Helpers own their semantic deadline. Give a finite helper a small extra window to return
      // its own result before the supervisor invalidates the lease; `false` deliberately keeps
      // a supervised continuous loop alive until it is cancelled or returns on its own.
      const leaseTimeoutMs = plan.timeoutMs === false
        ? false
        : plan.timeoutMs == null
          ? null
          : Math.min(300000, plan.timeoutMs + Math.max(1000, this.spec.cancelGraceMs))
      const result = await this.supervisor.run(bot, {
        owner: 'autoplay',
        action: plan.action,
        priority: 'autoplay',
        timeoutMs: leaseTimeoutMs,
        cancelGraceMs: this.spec.cancelGraceMs,
        // Combat can observe, but cannot turn or attack while a move/menu/bridge lease is live.
        blocksCombat: true
      }, async (context = {}) => {
        const signal = context.signal ?? run.controller.signal
        const leaseCurrent = typeof context.isCurrent === 'function' ? context.isCurrent() !== false : true
        if (signal?.aborted || !leaseCurrent || !this.#guardCurrent(bot, run.guard)) {
          return { status: 'STOPPED', error: 'autoplay lease is no longer current' }
        }
        // Random movement predates the supervisor.  Stop and await its own cleanup only after
        // this lease is acquired, so its final clearControls cannot race the task we are about
        // to start.  The engine never writes controls itself.
        if (this.movement?.isWalking?.(bot.id) && typeof this.movement?.stopAndWait === 'function') {
          await this.movement.stopAndWait(bot)
          if (signal?.aborted || (typeof context.isCurrent === 'function' && context.isCurrent() === false)) {
            return { status: 'STOPPED', error: 'autoplay lease is no longer current' }
          }
        }
        this.#phase(bot, 'acting', plan.action, { target: plan.target ?? this.#state(bot).target, reason: null })
        const execute = () => plan.execute(signal, {
          isCurrent: context.isCurrent,
          canCleanup: context.isOwner
        })
        // guard() provides an additional pre-mutation lease check in supervisor implementations
        // that expose it.  The task helpers themselves use the abort signal through all awaits.
        return typeof context.guard === 'function' ? await context.guard(execute) : await execute()
      })
      return result || { status: 'BLOCKED', error: 'autoplay task lost its supervisor lease' }
    } catch (error) {
      return { status: run.controller.signal.aborted ? 'STOPPED' : 'FAILED', error: errorText(error) }
    }
  }

  async #run (bot, run) {
    while (!run.controller.signal.aborted && this.#guardCurrent(bot, run.guard)) {
      const observation = this.#observe(bot)
      this.#phase(bot, 'playing', 'observe', { lastObservation: observation, reason: null })
      // Teleports, knockback and respawns are owned by the server. Do not issue another movement,
      // GUI or bridge action while Mineflayer still reports an airborne body; wait for the native
      // physics listener to settle it instead of synthesising a correction packet.
      const motionSpec = bedwarsRoamSpec(this.cfg.bedwars ?? {})
      const velocityUnsettled = Number.isFinite(observation.velocity?.horizontal) &&
        observation.velocity.horizontal > motionSpec.maxHorizontalSpeed
      if (observation.onGround !== true || velocityUnsettled) {
        this.#phase(bot, 'recovering', 'wait_for_physics', {
          lastObservation: observation,
          reason: observation.onGround !== true
            ? 'waiting for native physics to settle on the ground'
            : 'waiting for native horizontal velocity to settle'
        })
        if (!await wait(Math.max(100, this.spec.recoverDelayMs), run.controller.signal)) return
        continue
      }
      let plan
      try {
        plan = this.#plan(bot, observation)
      } catch (error) {
        this.log.error?.(`[${bot.username}] autoplay plan failed: ${errorText(error)}`)
        this.#phase(bot, 'failed', null, {
          reason: errorText(error),
          lastObservation: observation,
          lastResult: { status: 'FAILED', error: errorText(error) }
        })
        return
      }
      if (plan?.status === 'BLOCKED') {
        this.#phase(bot, 'blocked', null, { reason: plan.error, lastObservation: observation, lastResult: { status: 'BLOCKED', error: plan.error } })
        return
      }
      if (plan?.passive) {
        this.#phase(bot, 'playing', plan.action, {
          target: plan.target ?? this.#state(bot).target,
          reason: plan.reason ?? null
        })
        if (!await wait(Number(plan.delayMs) || this.spec.combatWindowMs, run.controller.signal)) return
        continue
      }

      const before = this.#state(bot)
      this.#set(bot, { actions: before.actions + 1, target: plan.target ?? before.target })
      const result = await this.#runTask(bot, run, plan)
      if (run.controller.signal.aborted || !this.#guardCurrent(bot, run.guard)) return

      const status = resultStatus(result)
      const summary = {
        status,
        action: result?.action ?? plan.action,
        error: result?.error ? errorText(result.error) : null,
        response: result?.response ?? null,
        iron: Number.isFinite(result?.iron) ? result.iron : undefined,
        wool: Number.isFinite(result?.wool) ? result.wool : undefined,
        placed: Number.isFinite(result?.placed) ? result.placed : undefined,
        steps: Number.isFinite(result?.steps) ? result.steps : undefined,
        moved: Number.isFinite(result?.moved) ? result.moved : undefined,
        replan: result?.replan ?? null,
        latencyMs: Number.isFinite(result?.latencyMs) ? result.latencyMs : undefined
      }
      if (status === 'OK') {
        const applied = typeof plan.apply === 'function' ? plan.apply(result, before) : plan.apply
        this.#phase(bot, 'playing', 'observe', {
          failures: 0,
          lastResult: summary,
          ...(applied && typeof applied === 'object' ? applied : {})
        })
        const retryAfterMs = Number(result?.retryAfterMs)
        const cooldownMs = Number.isFinite(retryAfterMs)
          ? Math.max(0, Math.min(10000, retryAfterMs))
          : this.spec.actionCooldownMs
        if (!await wait(cooldownMs, run.controller.signal)) return
        continue
      }
      if (status === 'BLOCKED') {
        if (result?.active) {
          this.#phase(bot, 'armed_waiting_action', null, {
            reason: `waiting for ${result.active.owner}:${result.active.action} to release controls`, lastResult: summary
          })
          return
        }
        this.#phase(bot, 'blocked', null, { reason: summary.error ?? 'supervisor blocked autoplay task', lastResult: summary })
        return
      }
      if (status === 'STOPPED' || status === 'CANCELLED' || status === 'ABORTED') return

      const failures = this.#state(bot).failures + 1
      if (failures >= this.spec.maxActionFailures) {
        this.#phase(bot, 'blocked', null, {
          failures,
          reason: `${plan.action} failed ${failures} times: ${summary.error ?? 'unknown error'}`,
          lastResult: summary
        })
        return
      }
      this.#phase(bot, 'recovering', plan.action, { failures, reason: summary.error ?? 'task failed', lastResult: summary })
      if (!await wait(this.spec.recoverDelayMs, run.controller.signal)) return
    }
  }
}
