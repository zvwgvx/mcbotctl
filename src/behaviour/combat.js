// combat.js — a small, deliberately conservative Mineflayer melee behaviour.
//
// This module owns target selection and attack timing only. It never moves a bot, changes its
// inventory, or writes raw packets. That keeps it safe to attach beside the BedWars navigator:
// callers provide a synchronous gate while the bot is collecting, pathfinding, or bridging.

import { EV } from '../bus.js'

export const DEFAULT_COMBAT = Object.freeze({
  enabled: false,
  // Leave margin below the 1.8 survival reach. A server that receives a legitimate attack at
  // exactly 3 blocks can still reject it after its next movement reconciliation.
  range: 2.8,
  cooldownMs: 700,
  scanIntervalMs: 150,
  acquireMs: 250,
  lookTimeoutMs: 750,
  lineOfSight: true,
  lookAtTarget: true,
  // View changes and attacks must not compete with pathfinding, manual movement, or sneak
  // bridging. An operator may opt out only after deliberately providing a stronger gate.
  pauseWhileMoving: true,
  // A stationary bot can still be in the generator/shop phase of the BedWars opening. Requiring
  // the runtime gate protects that case too; set false only for a separately controlled arena.
  requireGate: true,
  // Generic Minecraft entities do not contain team allegiance. Fail closed until an explicit
  // allow-list or the runtime's team-aware hostile filter says this player is an enemy.
  requireTargetApproval: true,
  // Player NPCs are common in BedWars lobbies. Mineflayer's player-info map normally contains
  // real remote clients but not those NPCs, so require it unless a server needs an override.
  requirePlayerInfo: true,
  // An empty target list means every non-protected real player is a candidate. Supplying names
  // makes this an allow-list, which is useful until a team-aware hostile filter is wired in.
  targets: [],
  friends: []
})

function finitePoint (point) {
  return !!point && ['x', 'y', 'z'].every((axis) => Number.isFinite(point[axis]))
}

function normalizedName (value) {
  return String(value ?? '').trim().toLocaleLowerCase()
}

function nameSet (values) {
  return new Set((Array.isArray(values) ? values : [])
    .map(normalizedName)
    .filter(Boolean))
}

function boundedNumber (value, fallback, min, max) {
  const n = Number(value)
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback
}

function playerName (entity) {
  // Do not fall back to custom names or metadata here. Those are exactly what many lobby NPCs
  // use, while username is supplied by Mineflayer only for a player entity.
  return typeof entity?.username === 'string' ? entity.username.trim() : ''
}

function isPlayerEntity (entity) {
  return entity?.type === 'player' || entity?.name === 'player'
}

function isLiveEntity (mc, entity) {
  return !!(mc && entity && entity.id != null && mc.entities?.[entity.id] === entity && finitePoint(entity.position))
}

function distanceTo (a, b) {
  if (!finitePoint(a) || !finitePoint(b)) return Infinity
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function eyePoint (entity) {
  if (!finitePoint(entity?.position)) return null
  const height = boundedNumber(entity.eyeHeight ?? entity.height, 1.62, 0.25, 3)
  return entity.position.offset
    ? entity.position.offset(0, height, 0)
    : { x: entity.position.x, y: entity.position.y + height, z: entity.position.z }
}

/**
 * Check the loaded world between the two players. Mineflayer has canSeeBlock(), but no
 * canSeeEntity(), so use its synchronous world raycaster and stop at a real block shape.
 *
 * At melee range both entities and the intervening chunks are already loaded. If that invariant
 * is not true, this returns false rather than sending a hit through an unknown wall.
 */
function hasLineOfSight (mc, entity) {
  const from = eyePoint(mc?.entity)
  const to = eyePoint(entity)
  if (!from || !to || typeof mc?.world?.raycast !== 'function') return false
  // prismarine-world expects a Vec3-like object with clone/normalize methods. The position
  // object supplied by Mineflayer is a Vec3, so derive the direction from it when possible.
  const vec = to.minus?.(from)
  if (!vec?.normalize) return false
  const range = Math.hypot(vec.x, vec.y, vec.z)
  if (!Number.isFinite(range) || range <= 0) return false
  try {
    // raycast skips an unloaded column. Check the few columns crossed at melee range first, so
    // an unknown gap can never be mistaken for a clear line of sight.
    if (typeof mc.world.getColumnAt !== 'function') return false
    const steps = Math.max(1, Math.ceil(range * 2))
    for (let step = 0; step <= steps; step++) {
      const point = from.offset?.(vec.x * step / steps, vec.y * step / steps, vec.z * step / steps)
      if (!point || !mc.world.getColumnAt(point)) return false
    }
    const hit = mc.world.raycast(from, vec.normalize(), range, (block, iterator) => {
      return !!iterator.intersect(block.shapes, block.position)
    })
    return hit == null
  } catch {
    return false
  }
}

function angleDifference (left, right) {
  let value = (left - right) % (Math.PI * 2)
  if (value < -Math.PI) value += Math.PI * 2
  if (value > Math.PI) value -= Math.PI * 2
  return Math.abs(value)
}

/** A hit is only emitted after the normal Mineflayer turn has actually faced the target. */
function isAimedAt (mc, entity, tolerance = 0.17) {
  const from = eyePoint(mc?.entity)
  const to = eyePoint(entity)
  if (!from || !to || !Number.isFinite(mc?.entity?.yaw) || !Number.isFinite(mc?.entity?.pitch)) return false
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const horizontal = Math.hypot(dx, dz)
  if (!horizontal) return false
  const yaw = Math.atan2(-dx, -dz)
  const pitch = Math.atan2(dy, horizontal)
  return angleDifference(mc.entity.yaw, yaw) <= tolerance && Math.abs(mc.entity.pitch - pitch) <= tolerance
}

function gateDecision (gate, bot, context, required = false) {
  if (typeof gate !== 'function') {
    return required
      ? { allowed: false, reason: 'combat gate is required' }
      : { allowed: true, reason: null }
  }
  try {
    const result = gate(bot, context)
    // Gates run on physicsTick, so asynchronous decisions would let a stale combat action race
    // a bridge start. Reject them explicitly and require the caller to maintain synchronous state.
    if (result && typeof result.then === 'function') return { allowed: false, reason: 'combat gate must be synchronous' }
    if (result === false) return { allowed: false, reason: 'combat gated' }
    if (typeof result === 'string') return { allowed: false, reason: result || 'combat gated' }
    if (result && typeof result === 'object' && result.allowed === false) {
      return { allowed: false, reason: String(result.reason ?? 'combat gated') }
    }
    return { allowed: true, reason: null }
  } catch (error) {
    return { allowed: false, reason: `combat gate failed: ${error.message}` }
  }
}

/**
 * Mineflayer melee behaviour.
 *
 * `gate(bot, context)` may return true/undefined to allow a hit, false to pause, a reason string,
 * or `{ allowed: false, reason }`. Typical BedWars wiring is:
 *
 *   combat.setGate((bot) => !bedwars.isRunning(bot.id))
 *
 * A team-aware caller can use `setHostileFilter((bot, entity) => boolean)`. The filter runs after
 * fleet/master/friend protection and cannot make those protected identities attackable.
 */
export class CombatBehaviour {
  constructor ({ cfg = {}, bus, log = console, gate = null, isHostile = null } = {}) {
    if (!bus?.on) throw new Error('CombatBehaviour needs an event bus')
    this.cfg = cfg
    this.bus = bus
    this.log = log
    this.fleet = null
    this.gate = typeof gate === 'function' ? gate : null
    this.hostileFilter = typeof isHostile === 'function' ? isHostile : null
    this.handles = new Map() // botId -> { bot, mc, onTick, busy, nextScanAt }
    this.states = new Map()
    this.attached = new Set()
    this.subs = []
  }

  get enabled () { return this.cfg.combat?.enabled === true }

  get spec () {
    const raw = this.cfg.combat ?? {}
    return {
      ...DEFAULT_COMBAT,
      ...raw,
      range: boundedNumber(raw.range, DEFAULT_COMBAT.range, 1, 3.1),
      cooldownMs: boundedNumber(raw.cooldownMs, DEFAULT_COMBAT.cooldownMs, 350, 10_000),
      scanIntervalMs: boundedNumber(raw.scanIntervalMs, DEFAULT_COMBAT.scanIntervalMs, 50, 5_000),
      acquireMs: boundedNumber(raw.acquireMs, DEFAULT_COMBAT.acquireMs, 0, 5_000),
      lookTimeoutMs: boundedNumber(raw.lookTimeoutMs, DEFAULT_COMBAT.lookTimeoutMs, 150, 3_000),
      lineOfSight: raw.lineOfSight !== false,
      lookAtTarget: raw.lookAtTarget !== false,
      pauseWhileMoving: raw.pauseWhileMoving !== false,
      requireGate: raw.requireGate !== false,
      requireTargetApproval: raw.requireTargetApproval !== false,
      requirePlayerInfo: raw.requirePlayerInfo !== false
    }
  }

  setGate (gate) {
    this.gate = typeof gate === 'function' ? gate : null
    return this
  }

  setHostileFilter (filter) {
    this.hostileFilter = typeof filter === 'function' ? filter : null
    return this
  }

  stateOf (botId) {
    return this.states.get(botId) ?? {
      state: this.enabled ? 'idle' : 'disabled', target: null, distance: null,
      attacks: 0, lastAttackAt: null, reason: null
    }
  }

  attach (fleet) {
    if (!fleet?.bots || !Array.isArray(fleet.bots)) throw new Error('CombatBehaviour.attach needs a fleet')
    this.fleet = fleet
    for (const bot of fleet.bots) this.attachBot(bot)
    return this
  }

  attachBot (bot) {
    if (!bot?.id || this.attached.has(bot.id)) return bot
    this.attached.add(bot.id)
    this.#sub(EV.BOT_READY, (event) => {
      if (event.botId === bot.id) this.start(bot)
    })
    this.#sub(EV.BOT_STATE, (event) => {
      if (event.botId === bot.id && event.to === 'DEAD') this.stop(bot, 'disconnected')
    })
    if (bot.isReady?.()) this.start(bot)
    return bot
  }

  /** Start only after the bot reaches READY, so no combat packet can race login/authentication. */
  start (bot) {
    this.stop(bot, null)
    if (!this.enabled) {
      this.#setState(bot, { state: 'disabled', target: null, distance: null, reason: 'combat disabled' })
      return false
    }
    const mc = bot?.transport?.mc
    if (!bot?.isReady?.() || !bot.transport?.connected || !bot.transport?.physics || !mc?.entity || typeof mc.attack !== 'function') {
      this.#setState(bot, { state: 'waiting', target: null, distance: null, reason: 'Mineflayer player is not ready' })
      return false
    }
    const handle = {
      bot, mc, busy: false, nextScanAt: 0, targetId: null, targetSince: 0,
      cancelled: false, abortLook: null, onTick: null
    }
    handle.onTick = () => this.#scheduleScan(handle)
    mc.on('physicsTick', handle.onTick)
    this.handles.set(bot.id, handle)
    this.#setState(bot, { state: 'watching', target: null, distance: null, reason: null })
    return true
  }

  stop (bot, reason = 'stopped') {
    const handle = this.handles.get(bot?.id)
    if (handle) {
      handle.cancelled = true
      this.#abortTargetLook(handle, reason ?? 'combat stopped')
      try { handle.mc.removeListener('physicsTick', handle.onTick) } catch {}
      this.handles.delete(bot.id)
    }
    if (bot && reason) this.#setState(bot, { state: 'stopped', target: null, distance: null, reason })
    return !!handle
  }

  dispose () {
    for (const handle of [...this.handles.values()]) this.stop(handle.bot)
    for (const off of this.subs) { try { off() } catch {} }
    this.subs = []
    this.attached.clear()
    this.fleet = null
  }

  #sub (topic, fn) { this.subs.push(this.bus.on(topic, fn)) }

  #setState (bot, patch) {
    if (!bot?.id) return
    const before = this.stateOf(bot.id)
    const after = { ...before, ...patch }
    const changed = Object.keys(after).some((key) => after[key] !== before[key])
    this.states.set(bot.id, after)
    if (changed) this.bus.emit('combat:state', { botId: bot.id, bot: bot.username, ...after })
  }

  #scheduleScan (handle) {
    if (this.handles.get(handle.bot.id) !== handle || handle.busy) return
    const now = Date.now()
    if (now < handle.nextScanAt) return
    handle.nextScanAt = now + this.spec.scanIntervalMs
    handle.busy = true
    Promise.resolve(this.#scan(handle)).catch((error) => {
      this.#setState(handle.bot, { state: 'error', target: null, distance: null, reason: error.message })
      this.log.warn?.(`[${handle.bot.username}] combat scan failed: ${error.message}`)
    }).finally(() => { handle.busy = false })
  }

  #readyForCombat (handle) {
    const { bot, mc } = handle
    if (this.handles.get(bot.id) !== handle) return 'combat handler was replaced'
    if (handle.cancelled) return 'combat handler was stopped'
    if (bot.transport?.mc !== mc || !bot.isReady?.() || !bot.transport?.connected) return 'bot is no longer ready'
    if (mc._client && mc._client.state !== 'play') return 'Mineflayer socket is not in PLAY'
    if (!mc.entity || typeof mc.attack !== 'function') return 'Mineflayer player is unavailable'
    if (!finitePoint(mc.entity.position)) return 'Mineflayer position is unavailable'
    return null
  }

  #protectedNames (bot) {
    const names = new Set()
    for (const member of this.fleet?.bots ?? []) names.add(normalizedName(member.username))
    names.add(normalizedName(bot?.username))
    names.add(normalizedName(this.cfg.fleet?.master))
    for (const name of nameSet(this.spec.friends)) names.add(name)
    names.delete('')
    return names
  }

  #listedPlayer (mc, username) {
    const wanted = normalizedName(username)
    return Object.keys(mc?.players ?? {}).some((name) => normalizedName(name) === wanted)
  }

  #eligible (bot, mc, entity, protectedNames, targets) {
    if (!isLiveEntity(mc, entity) || entity.id === mc.entity?.id || !isPlayerEntity(entity)) return false
    const username = playerName(entity)
    const normalized = normalizedName(username)
    if (!normalized || protectedNames.has(normalized)) return false
    if (this.spec.requirePlayerInfo && !this.#listedPlayer(mc, username)) return false
    if (targets.size && !targets.has(normalized)) return false
    if (!this.hostileFilter) return true
    try {
      const answer = this.hostileFilter(bot, entity, { mc, username })
      // A promise would give an old target time to vanish or cross a bridge. Team state should be
      // maintained by the caller and exposed synchronously to this hot path.
      return !(answer && typeof answer.then === 'function') && answer === true
    } catch (error) {
      this.log.warn?.(`[${bot.username}] hostile filter failed: ${error.message}`)
      return false
    }
  }

  #findTarget (bot, mc) {
    const spec = this.spec
    const protectedNames = this.#protectedNames(bot)
    const targets = nameSet(spec.targets)
    if (spec.requireTargetApproval && !targets.size && !this.hostileFilter) {
      return { entity: null, reason: 'no hostile filter or target allow-list configured' }
    }
    const candidate = (entity) => {
      if (!this.#eligible(bot, mc, entity, protectedNames, targets)) return false
      return distanceTo(mc.entity?.position, entity.position) <= spec.range
    }
    const nearest = typeof mc.nearestEntity === 'function' ? mc.nearestEntity(candidate) : null
    const possible = nearest ? [nearest] : []
    // The nearest valid player can be behind a wall while another enemy within reach is visible.
    // Consider all loaded candidates in distance order after the inexpensive nearestEntity pass.
    for (const entity of Object.values(mc.entities ?? {})) {
      if (entity !== nearest && candidate(entity)) possible.push(entity)
    }
    possible.sort((a, b) => distanceTo(mc.entity.position, a.position) - distanceTo(mc.entity.position, b.position))
    let blocked = false
    for (const entity of possible) {
      if (!spec.lineOfSight || hasLineOfSight(mc, entity)) return { entity, reason: null }
      blocked = true
    }
    return { entity: null, reason: blocked ? 'enemy is behind a block' : 'no hostile player in reach' }
  }

  #movementReason (mc) {
    if (mc.currentWindow) return 'a menu is open'
    if (mc.entity?.onGround !== true) return 'bot is airborne'
    const velocity = mc.entity?.velocity
    if (velocity && Number.isFinite(velocity.x) && Number.isFinite(velocity.y) && Number.isFinite(velocity.z) &&
      (Math.hypot(velocity.x, velocity.z) > 0.08 || Math.abs(velocity.y) > 0.08)) {
      return 'bot velocity is unsettled'
    }
    if (!this.spec.pauseWhileMoving) return null
    try {
      if (mc.pathfinder?.isMoving?.()) return 'pathfinder is moving'
      if (mc.pathfinder?.isBuilding?.()) return 'pathfinder is building'
      if (mc.pathfinder?.isMining?.()) return 'pathfinder is mining'
    } catch {
      // A pathfinder being torn down during a disconnect is not evidence that combat is safe.
      return 'movement state is changing'
    }
    const controls = mc.controlState
    if (controls && ['forward', 'back', 'left', 'right', 'jump', 'sneak'].some((name) => controls[name])) {
      return 'movement controls are active'
    }
    return null
  }

  #clearCandidate (handle) {
    handle.targetId = null
    handle.targetSince = 0
  }

  #abortTargetLook (handle, reason = 'target look cancelled') {
    const abort = handle?.abortLook
    handle.abortLook = null
    if (typeof abort === 'function') {
      try { abort(reason) } catch {}
    }
  }

  /**
   * Mineflayer's non-forced look waits for a later physics tick. That is useful for a natural
   * rotation, but can wait forever when a connection dies or its chunk unloads mid-turn. Keep
   * the underlying promise observed and race it against both a small timeout and stop(). The
   * post-look guards below make a late completion harmless: it no longer owns this handle.
   */
  async #lookAtTarget (handle, target) {
    const point = eyePoint(target)
    if (!point) return { ok: false, reason: 'target position is unavailable' }
    let look
    try { look = handle.mc.lookAt(point, false) } catch (error) {
      return { ok: false, reason: `could not turn to target: ${error.message}` }
    }
    let timer = null
    let abort = null
    const result = await new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      abort = (reason) => finish({ ok: false, reason })
      handle.abortLook = abort
      Promise.resolve(look).then(
        () => finish({ ok: true, reason: null }),
        (error) => finish({ ok: false, reason: `could not turn to target: ${error.message}` })
      )
      timer = setTimeout(() => finish({ ok: false, reason: 'target look timed out' }), this.spec.lookTimeoutMs)
      timer.unref?.()
    })
    clearTimeout(timer)
    if (handle.abortLook === abort) handle.abortLook = null
    return result
  }

  async #scan (handle) {
    if (!this.enabled) {
      this.stop(handle.bot, 'combat disabled')
      return
    }
    const inactive = this.#readyForCombat(handle)
    if (inactive) {
      this.stop(handle.bot, inactive)
      return
    }
    const { bot, mc } = handle
    // Discovery is read-only. Do it before the control/lease gates so roaming can yield safely
    // for an approved nearby enemy instead of holding its movement lease indefinitely.
    const found = this.#findTarget(bot, mc)
    const nearby = found.entity
      ? { target: playerName(found.entity), distance: distanceTo(mc.entity.position, found.entity.position) }
      : null
    const moving = this.#movementReason(mc)
    if (moving) {
      this.#clearCandidate(handle)
      this.#setState(bot, nearby
        ? { state: 'nearby', target: nearby.target, distance: nearby.distance, reason: moving }
        : { state: 'paused', target: null, distance: null, reason: moving })
      return
    }
    const before = gateDecision(this.gate, bot, { phase: 'scan', mc, combat: this.stateOf(bot.id) }, this.spec.requireGate)
    if (!before.allowed) {
      this.#clearCandidate(handle)
      this.#setState(bot, nearby
        ? { state: 'nearby', target: nearby.target, distance: nearby.distance, reason: before.reason }
        : { state: 'paused', target: null, distance: null, reason: before.reason })
      return
    }
    if (!found.entity) {
      this.#clearCandidate(handle)
      this.#setState(bot, { state: 'watching', target: null, distance: null, reason: found.reason })
      return
    }
    const target = found.entity
    const username = playerName(target)
    let distance = distanceTo(mc.entity.position, target.position)
    if (distance > this.spec.range) return
    const now = Date.now()
    if (handle.targetId !== String(target.id)) {
      handle.targetId = String(target.id)
      handle.targetSince = now
      this.#setState(bot, { state: 'acquiring', target: username, distance, reason: null })
      return
    }
    if (now - handle.targetSince < this.spec.acquireMs) {
      this.#setState(bot, { state: 'acquiring', target: username, distance, reason: null })
      return
    }
    const prior = this.stateOf(bot.id)
    if (prior.lastAttackAt && now - prior.lastAttackAt < this.spec.cooldownMs) {
      this.#setState(bot, { state: 'cooldown', target: username, distance, reason: null })
      return
    }
    this.#setState(bot, { state: 'targeting', target: username, distance, reason: null })
    if (this.spec.lookAtTarget) {
      // Let Mineflayer apply its normal per-tick turn limit. A forced rotation can skip the
      // client-side smoothing path and looks unlike the same user's regular movement packets.
      const looked = await this.#lookAtTarget(handle, target)
      if (this.#readyForCombat(handle)) return
      if (!looked.ok) {
        this.#clearCandidate(handle)
        this.#setState(bot, { state: 'watching', target: null, distance: null, reason: looked.reason })
        return
      }
    }
    const afterLook = this.#readyForCombat(handle)
    if (afterLook || !isLiveEntity(mc, target)) return
    const movingAfterLook = this.#movementReason(mc)
    if (movingAfterLook) {
      this.#clearCandidate(handle)
      this.#setState(bot, { state: 'paused', target: null, distance: null, reason: movingAfterLook })
      return
    }
    const afterGate = gateDecision(this.gate, bot, { phase: 'attack', mc, target, combat: this.stateOf(bot.id) }, this.spec.requireGate)
    if (!afterGate.allowed) {
      this.#clearCandidate(handle)
      this.#setState(bot, { state: 'paused', target: null, distance: null, reason: afterGate.reason })
      return
    }
    distance = distanceTo(mc.entity.position, target.position)
    if (distance > this.spec.range || (this.spec.lineOfSight && !hasLineOfSight(mc, target))) {
      this.#clearCandidate(handle)
      this.#setState(bot, { state: 'watching', target: null, distance: null, reason: 'target left reach or sight' })
      return
    }
    if (!isAimedAt(mc, target)) {
      this.#clearCandidate(handle)
      this.#setState(bot, { state: 'watching', target: null, distance: null, reason: 'target moved while turning' })
      return
    }
    const current = this.stateOf(bot.id)
    if (current.lastAttackAt && Date.now() - current.lastAttackAt < this.spec.cooldownMs) return
    try {
      // Mineflayer emits the 1.8 arm-animation and use-entity packet in the correct order.
      // No raw socket access is needed here.
      mc.attack(target, true)
      this.#setState(bot, {
        state: 'attacked', target: username, distance,
        attacks: (current.attacks ?? 0) + 1, lastAttackAt: Date.now(), reason: null
      })
      this.bus.emit('combat:attack', { botId: bot.id, bot: bot.username, target: username, distance })
    } catch (error) {
      this.#setState(bot, { state: 'watching', target: null, distance: null, reason: `attack failed: ${error.message}` })
    }
  }
}
