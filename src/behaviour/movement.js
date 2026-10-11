// behaviour/movement.js — continuous, safe background roaming.
//
// The fleet can join, authenticate, chat and drive menus while standing perfectly still at spawn.
// This keeps it wandering. It is not pathfinding and does not try to be — the requirement is
// "move around", not "go somewhere".
//
// Mineflayer owns all player position and velocity. This behaviour supplies only the same inputs a
// client would: forward and view direction. Writing calculated position packets alongside
// Mineflayer's physics creates two competing predictions, which is most visible while falling.

import { EV } from '../bus.js'
import { sleep } from '../util.js'
import { fallingWithoutSupport, nativePosition, nativeVelocity } from './motion_safety.js'

export const DEFAULT_MOVEMENT = {
  // This is the fleet's normal idle behaviour. Every READY bot keeps a Mineflayer control loop
  // in both the BedWars lobby and a match unless an operator deliberately switches it off.
  enabled: true,
  directionChangeMs: 1600,  // how long a heading is held before it is re-rolled
  tickMs: 50,               // 20 packets per second, matching the server's tick
  safetyScanMs: 150,
  lookAheadBlocks: 1,
  // prismarine-physics uses a 0.6-block native step height. Permit that exact physical step
  // while scanning stairs/slabs; anything larger is still treated as an unsafe ledge.
  maxStepHeight: 0.6,
  // Native sneak is an edge guard, not a fabricated correction. Keep it on in the stability
  // profile so a late chunk/collision update cannot carry a roaming bot off a narrow ledge.
  sneakGuard: true,
  // A geometry ambiguity is tried briefly with native sneak edge protection before the loop
  // gives up on a direction. This prevents a decorative lobby block from parking a bot forever.
  cautiousProbeMs: 250,
  headingAttempts: 8,
  fallLandingTimeoutMs: 5000,
  restartDelayMs: 750,
  pauseDuringCommands: false
}

function finiteNumber (value) { return typeof value === 'number' && Number.isFinite(value) }

function bounded (value, fallback, min, max) {
  const number = Number(value)
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback
}

function integer (value, fallback, min, max) {
  const number = Number(value)
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback
}

function angleDistance (left, right) {
  let delta = (left - right) % (Math.PI * 2)
  if (delta < -Math.PI) delta += Math.PI * 2
  if (delta > Math.PI) delta -= Math.PI * 2
  return Math.abs(delta)
}

function shuffled (items) {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

const FLAT_GROUND = Object.freeze({ down: 0.12, up: 0.12, variance: 0.12 })

export class Movement {
  constructor ({ cfg, bus, supervisor = null, log = console }) {
    this.cfg = cfg
    this.bus = bus
    this.supervisor = supervisor
    this.log = log
    this.loops = new Map()     // botId -> per-connection background-input handle
    this.restartTimers = new Map()
    this.states = new Map()
    this.#subs = []
  }

  #subs = []
  #sub (topic, fn) { this.#subs.push(this.bus.on(topic, fn)) }
  dispose () {
    for (const handle of this.loops.values()) {
      handle.stop = true
      this.#releaseControls(handle)
    }
    this.loops.clear()
    for (const timer of this.restartTimers.values()) clearTimeout(timer)
    this.restartTimers.clear()
    this.states.clear()
    for (const off of this.#subs) { try { off() } catch {} }
    this.#subs = []
    return this
  }

  get enabled () { return this.cfg.movement?.enabled !== false }
  get spec () {
    const raw = this.cfg.movement ?? {}
    return {
      ...DEFAULT_MOVEMENT,
      ...raw,
      enabled: raw.enabled !== false,
      directionChangeMs: integer(raw.directionChangeMs, DEFAULT_MOVEMENT.directionChangeMs, 250, 10000),
      tickMs: integer(raw.tickMs, DEFAULT_MOVEMENT.tickMs, 25, 250),
      safetyScanMs: integer(raw.safetyScanMs, DEFAULT_MOVEMENT.safetyScanMs, 50, 2000),
      lookAheadBlocks: bounded(raw.lookAheadBlocks, DEFAULT_MOVEMENT.lookAheadBlocks, 0.5, 2),
      maxStepHeight: bounded(raw.maxStepHeight, DEFAULT_MOVEMENT.maxStepHeight, 0.1, 0.6),
      sneakGuard: raw.sneakGuard !== false,
      cautiousProbeMs: integer(raw.cautiousProbeMs, DEFAULT_MOVEMENT.cautiousProbeMs, 50, 1000),
      headingAttempts: integer(raw.headingAttempts, DEFAULT_MOVEMENT.headingAttempts, 1, 16),
      fallLandingTimeoutMs: integer(raw.fallLandingTimeoutMs, DEFAULT_MOVEMENT.fallLandingTimeoutMs, 1000, 15000),
      restartDelayMs: integer(raw.restartDelayMs, DEFAULT_MOVEMENT.restartDelayMs, 100, 10000)
    }
  }

  attach (bot) {
    this.#sub(EV.BOT_READY, (e) => { if (e.botId === bot.id) this.start(bot) })
    // Stop on every path out. There is nothing worse than a walk loop still firing packets at a
    // socket that has gone, and a bot that reconnects must get a fresh loop or none at all.
    this.#sub(EV.BOT_STATE, (e) => {
      if (e.botId !== bot.id || e.to !== 'DEAD') return
      this.#cancelRestart(bot.id)
      this.stop(bot)
      this.#recordMotion(bot, null, 'disconnected', { reason: 'connection ended', heading: null })
    })
    // The selector briefly owns the controls. It used to stop walking successfully and then
    // leave the bot parked forever, because the only automatic start was BOT_READY. Resume after
    // a confirmed lobby entry, and do the same when the sidebar changes from lobby to match.
    this.#sub('menu:state', (e) => {
      if (e.botId === bot.id && e.state === 'done') this.#scheduleStart(bot, 0)
    })
    this.#sub('bedwars:presence', (e) => {
      if (e.botId === bot.id && e.joined === true && (e.stage === 'mode' || e.stage === 'match')) {
        this.#scheduleStart(bot, 0)
      }
    })
    return bot
  }

  attachAll (fleet) {
    for (const b of fleet.bots) this.attach(b)
    return this
  }

  isWalking (botId) { return this.loops.has(botId) }

  stateOf (botId) {
    const state = this.states.get(botId)
    if (!state) return {
      state: this.enabled ? 'idle' : 'disabled', heading: null, position: null, velocity: null,
      onGround: null, lastMovementAt: null, reason: null, updatedAt: null
    }
    return {
      ...state,
      position: state.position ? { ...state.position } : null,
      velocity: state.velocity ? { ...state.velocity } : null
    }
  }

  #recordMotion (bot, handle, state, patch = {}) {
    if (!bot?.id) return null
    const previous = this.states.get(bot.id) ?? {}
    const position = nativePosition(handle?.transport ?? bot.transport)
    const velocity = nativeVelocity(handle?.transport ?? bot.transport)
    const now = Date.now()
    const moved = position && previous.position && Math.hypot(
      position.x - previous.position.x, position.z - previous.position.z
    ) >= 0.03
    const next = {
      state,
      heading: Number.isFinite(patch.heading) ? patch.heading : (patch.heading === null ? null : previous.heading ?? null),
      position: position ? { ...position } : null,
      velocity: velocity ? { ...velocity } : null,
      onGround: (handle?.transport ?? bot.transport)?.mc?.entity?.onGround === true,
      lastMovementAt: moved ? now : (previous.lastMovementAt ?? null),
      reason: patch.reason ?? null,
      updatedAt: now
    }
    this.states.set(bot.id, next)
    if (state !== previous.state || now - (handle?.lastMotionEmitAt ?? 0) >= 500) {
      if (handle) handle.lastMotionEmitAt = now
      this.bus.emit('movement:state', { botId: bot.id, bot: bot.username, ...next })
    }
    return next
  }

  start (bot) {
    if (!bot?.id || !this.enabled || this.loops.has(bot.id)) return false
    this.#cancelRestart(bot.id)
    if (!bot.isReady()) return false
    if (!bot.transport?.physics) {
      this.log.warn?.(`[${bot.username}] continuous movement needs the Mineflayer physics transport`)
      this.#recordMotion(bot, null, 'blocked', { reason: 'Mineflayer physics transport is unavailable' })
      return false
    }
    // A selector, bridge, or other higher-priority action owns the same keys and view. Do not
    // race it; retry after the lane becomes free instead of letting a background loop press keys.
    if (this.supervisor?.activeOf?.(bot.id)) {
      this.#recordMotion(bot, null, 'waiting_lane', { reason: 'waiting for the active action lease to release controls' })
      this.#scheduleStart(bot)
      return false
    }
    const transport = bot.transport
    // The transport wrapper survives reconnects, while its Mineflayer/session identity does not.
    // Capture that identity so a delayed background-loop cleanup cannot touch a later socket.
    const handle = {
      stop: false,
      bot,
      transport,
      mc: transport?.mc ?? null,
      session: transport?.activeSession ?? null,
      generation: Number.isFinite(Number(transport?.connectionGeneration)) ? Number(transport.connectionGeneration) : null,
      controlsOwned: false,
      pendingLook: null,
      signal: null,
      isCurrent: null,
      isOwner: null,
      lastMotionEmitAt: 0,
      started: false
    }
    this.loops.set(bot.id, handle)
    this.#recordMotion(bot, handle, 'starting', { reason: null, heading: null })
    this.log.info?.(`[${bot.username}] walking`)
    handle.done = this.#walk(bot, handle).catch((e) => this.log.warn?.(`[${bot.username}] walk loop ended: ${e.message}`))
    return true
  }

  stop (bot) {
    this.#cancelRestart(bot?.id)
    const h = this.loops.get(bot?.id)
    if (!h) return false
    h.stop = true
    this.loops.delete(bot.id)
    // Revoke this loop's ownership before clearing keys. Its delayed look/finally callback may
    // complete after a supervised action has acquired the lane, and must then leave that action's
    // controls untouched.
    this.#releaseControls(h)
    this.#recordMotion(bot, h, 'stopped', { reason: 'movement paused' })
    // Cancel only a lease this exact background handle owns. A manual successor may already have
    // preempted it, and must never be cancelled by a late stop request.
    if (this.supervisor?.activeOf?.(bot.id)?.owner === 'movement') {
      void this.supervisor.cancel(bot, 'continuous movement stopped').catch(() => {})
    }
    return true
  }

  /** Give a directed movement behaviour exclusive control of the keys. */
  async stopAndWait (bot) {
    const h = this.loops.get(bot.id)
    if (!h) return false
    this.stop(bot)
    await h.done
    return true
  }

  #sameConnection (handle) {
    const transport = handle?.transport
    if (!handle?.bot || handle.bot.transport !== transport) return false
    if (handle.mc && transport?.mc !== handle.mc) return false
    if (handle.session && transport?.activeSession !== handle.session) return false
    if (handle.generation != null && Number(transport?.connectionGeneration) !== handle.generation) return false
    return true
  }

  #isActive (handle) {
    if (!this.#sameConnection(handle) || handle?.signal?.aborted) return false
    if (typeof handle?.isCurrent === 'function') {
      try { return handle.isCurrent() === true } catch { return false }
    }
    return true
  }

  #canCleanup (handle) {
    if (!this.#sameConnection(handle)) return false
    if (typeof handle?.isOwner === 'function') {
      try { return handle.isOwner() === true } catch { return false }
    }
    return true
  }

  #releaseControls (handle) {
    if (!handle?.controlsOwned) return false
    // Flip first: after this point, no delayed finally block can clear a successor's controls.
    handle.controlsOwned = false
    if (!this.#canCleanup(handle)) return false
    try {
      handle.transport?.clearControls?.()
      return true
    } catch {
      return false
    }
  }

  #cancelRestart (botId) {
    const timer = this.restartTimers.get(botId)
    if (!timer) return false
    clearTimeout(timer)
    this.restartTimers.delete(botId)
    return true
  }

  /** Re-enter the input loop after a safety recovery or a menu releases its control lane. */
  #scheduleStart (bot, delayMs = this.spec.restartDelayMs) {
    if (!bot?.id || !this.enabled || this.loops.has(bot.id)) return false
    this.#cancelRestart(bot.id)
    const delay = Math.max(0, Number(delayMs) || 0)
    const timer = setTimeout(() => {
      if (this.restartTimers.get(bot.id) !== timer) return
      this.restartTimers.delete(bot.id)
      if (this.enabled && !this.loops.has(bot.id) && bot.isReady?.()) this.start(bot)
    }, delay)
    timer.unref?.()
    this.restartTimers.set(bot.id, timer)
    return true
  }

  #shapes (block) {
    const shapes = Array.isArray(block?.shapes)
      ? block.shapes.filter((shape) => Array.isArray(shape) && shape.length >= 6)
      : []
    // Some 1.8 registry entries only expose boundingBox. Treat those collision blocks as a full
    // cube, while air and unknown blocks remain empty/unsafe.
    return shapes.length ? shapes : (block?.boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : [])
  }

  /** Highest loaded collision top under one footprint point within a bounded height band. */
  #supportTopAt (transport, x, feetY, z, { down, up }) {
    if (typeof transport?.blockAt !== 'function') return false
    const lower = feetY - Math.max(0, Number(down) || 0) - 0.01
    const upper = feetY + Math.max(0, Number(up) || 0) + 0.01
    let highest = null
    // A player standing on a half slab has feet at blockY + 0.5. Inspect collision tops around
    // the actual foot height rather than assuming the support is always y - 1.
    for (let blockX = Math.floor(x - 0.001); blockX <= Math.floor(x + 0.001); blockX++) {
      for (let blockZ = Math.floor(z - 0.001); blockZ <= Math.floor(z + 0.001); blockZ++) {
        for (let blockY = Math.floor(lower) - 1; blockY <= Math.floor(upper); blockY++) {
          const block = transport.blockAt(blockX, blockY, blockZ)
          for (const shape of this.#shapes(block)) {
            const [minX, minY, minZ, maxX, maxY, maxZ] = shape.map(Number)
            if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) continue
            const top = blockY + maxY
            const coversX = x >= blockX + minX && x <= blockX + maxX
            const coversZ = z >= blockZ + minZ && z <= blockZ + maxZ
            if (coversX && coversZ && top >= lower && top <= upper &&
              (highest == null || top > highest)) highest = top
          }
        }
      }
    }
    return highest
  }

  #bodyClear (transport, point) {
    if (typeof transport?.blockAt !== 'function') return false
    // prismarine-physics uses a 0.6-wide, 1.8-high player box. Check the full native width so
    // an apparently-open corner cannot clip the real collision box on the following physics tick.
    const half = 0.3
    const minX = point.x - half
    const maxX = point.x + half
    const minY = point.y + 0.01
    const maxY = point.y + 1.79
    const minZ = point.z - half
    const maxZ = point.z + half
    for (let x = Math.floor(minX); x <= Math.floor(maxX); x++) {
      for (let y = Math.floor(minY); y <= Math.floor(maxY); y++) {
        for (let z = Math.floor(minZ); z <= Math.floor(maxZ); z++) {
          const block = transport.blockAt(x, y, z)
          for (const shape of this.#shapes(block)) {
            const [shapeMinX, shapeMinY, shapeMinZ, shapeMaxX, shapeMaxY, shapeMaxZ] = shape.map(Number)
            if (![shapeMinX, shapeMinY, shapeMinZ, shapeMaxX, shapeMaxY, shapeMaxZ].every(Number.isFinite)) continue
            const overlaps = x + shapeMaxX > minX && x + shapeMinX < maxX &&
              y + shapeMaxY > minY && y + shapeMinY < maxY &&
              z + shapeMaxZ > minZ && z + shapeMinZ < maxZ
            if (overlaps) return false
          }
        }
      }
    }
    return true
  }

  /** Return the physical ground height for a fully-supported player footprint, or null. */
  #groundAt (transport, point, limits = FLAT_GROUND) {
    if (!point || !['x', 'y', 'z'].every((axis) => finiteNumber(point[axis]))) return false
    // Sample the centre and the player's footprint. Every probe must find a real collision top;
    // that keeps an unloaded cell or an ordinary one-block edge unsafe. A stair may legitimately
    // give neighboring probes two heights within the native 0.6-block step limit.
    const footprint = [[0, 0], [0.22, 0.22], [0.22, -0.22], [-0.22, 0.22], [-0.22, -0.22]]
    const tops = footprint.map(([dx, dz]) => this.#supportTopAt(transport, point.x + dx, point.y, point.z, limits))
    if (tops.some((top) => !finiteNumber(top))) return null
    const highest = Math.max(...tops)
    const lowest = Math.min(...tops)
    const down = Math.max(0, Number(limits.down) || 0)
    const up = Math.max(0, Number(limits.up) || 0)
    const variance = Math.max(0, Number(limits.variance) || 0)
    if (highest < point.y - down - 0.01 || highest > point.y + up + 0.01 || highest - lowest > variance + 0.01) {
      return null
    }
    return { x: point.x, y: highest, z: point.z }
  }

  #isOpenSupportedPoint (transport, point, limits) {
    const ground = this.#groundAt(transport, point, limits)
    return !!ground && this.#bodyClear(transport, ground)
  }

  /** Read only loaded collision shapes before driving into a point; unknown terrain is unsafe. */
  #hasSafeSweep (transport, yaw, lookAheadBlocks, limits = FLAT_GROUND) {
    const position = nativePosition(transport)
    if (!position) return false
    const dx = -Math.sin(yaw)
    const dz = -Math.cos(yaw)
    const distances = [0, Math.min(0.35, lookAheadBlocks), lookAheadBlocks]
    const points = distances.map((distance) => ({
      x: position.x + dx * distance,
      y: position.y,
      z: position.z + dz * distance
    }))
    // A diagonal direction can collide with a corner even when its endpoint is open. Verify both
    // cardinal approaches at the same look-ahead distance using the real player collision box.
    if (Math.abs(dx) > 0.35 && Math.abs(dz) > 0.35) {
      points.push(
        { x: position.x + Math.sign(dx) * lookAheadBlocks, y: position.y, z: position.z },
        { x: position.x, y: position.y, z: position.z + Math.sign(dz) * lookAheadBlocks }
      )
    }
    return points.every((point) => this.#isOpenSupportedPoint(transport, point, limits))
  }

  #safeYaw (transport, desiredYaw, spec, limits = FLAT_GROUND) {
    // Try the intended curve first, then fan out through a complete circle. The order is shuffled
    // after the intended yaw so several bots do not all take the same recovery turn.
    const offsets = shuffled([
      Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2,
      (Math.PI * 3) / 4, -(Math.PI * 3) / 4, Math.PI
    ]).slice(0, Math.max(0, spec.headingAttempts - 1))
    for (const yaw of [desiredYaw, ...offsets.map((offset) => desiredYaw + offset)]) {
      if (this.#hasSafeSweep(transport, yaw, spec.lookAheadBlocks, limits)) return yaw
    }
    return null
  }

  async #lookForOneTick (handle, yaw, tickMs) {
    if (!handle?.pendingLook && this.#isActive(handle) && !handle.stop) {
      // With `force`, Mineflayer normally applies and resolves the local view update immediately.
      // Keep one pending promise for alternate transports, but never let a stalled socket keep
      // the owner transition blocked indefinitely.
      let attempt = false
      try { attempt = handle.transport?.look?.(yaw, 0, true) } catch {}
      const pending = Promise.resolve(attempt).catch(() => false)
      handle.pendingLook = pending
      void pending.finally(() => {
        if (handle.pendingLook === pending) handle.pendingLook = null
      })
    }
    if (handle?.pendingLook) await Promise.race([handle.pendingLook, sleep(tickMs)])
  }

  /** Walk using Mineflayer controls only. */
  async #walkWithControls (bot, handle) {
    const s = this.spec
    const t = bot.transport
    await sleep(600)
    if (handle.stop || !this.#isActive(handle)) return
    this.#recordMotion(bot, handle, 'settling', { reason: 'waiting for a safe, loaded direction', heading: null })
    let yaw = (Math.random() * Math.PI * 2) - Math.PI
    let lastRoll = Date.now()
    let lastSafetyCheck = 0
    let lastProgress = Date.now()
    let anchor = nativePosition(t)
    let fallingSince = 0
    let ticks = 0
    let forward = false
    let sneaking = false
    let cautiousProbeUntil = 0
    let cautiousProbeStart = null
    const releaseForward = () => {
      const wasSneaking = sneaking
      forward = false
      sneaking = false
      cautiousProbeUntil = 0
      cautiousProbeStart = null
      if (this.#canCleanup(handle)) {
        try { handle.transport?.setControl?.('forward', false) } catch {}
        if (wasSneaking) {
          try { handle.transport?.setControl?.('sneak', false) } catch {}
        }
      }
    }
    const steer = async (desiredYaw) => {
      // Flat floor is the normal route. Only when it finds no flat route do we allow a native
      // half-step/stair transition. The stability profile holds Mineflayer sneak throughout, so
      // its own edge guard remains the final authority if terrain changes beneath the player.
      let limits = FLAT_GROUND
      let guardedStep = false
      let safeYaw = this.#safeYaw(t, desiredYaw, s, limits)
      if (!finiteNumber(safeYaw) && t.mc?.entity?.onGround === true) {
        limits = { down: s.maxStepHeight, up: s.maxStepHeight, variance: s.maxStepHeight }
        safeYaw = this.#safeYaw(t, desiredYaw, s, limits)
        guardedStep = finiteNumber(safeYaw)
      }
      if (!finiteNumber(safeYaw)) return false
      const edgeGuard = s.sneakGuard || guardedStep
      // A normal client briefly releases forward while it turns at an edge. This gives existing
      // velocity one physics tick to settle without fabricating a position or velocity packet.
      if (!forward || sneaking !== edgeGuard || angleDistance(safeYaw, yaw) > 0.03) {
        releaseForward()
        await this.#lookForOneTick(handle, safeYaw, s.tickMs)
        if (handle.stop || !this.#isActive(handle)) return false
      }
      if (!this.#hasSafeSweep(t, safeYaw, s.lookAheadBlocks, limits)) return false
      if (edgeGuard && !t.setControl('sneak', true)) return false
      if (!t.setControl('forward', true)) {
        if (edgeGuard && this.#canCleanup(handle)) {
          try { t.setControl('sneak', false) } catch {}
        }
        return false
      }
      handle.controlsOwned = true
      forward = true
      sneaking = edgeGuard
      yaw = safeYaw
      return true
    }
    const startCautiousProbe = async (desiredYaw) => {
      // A valid native ground state is required before asking Mineflayer's sneak edge guard to
      // test a decorative/stair-shaped boundary. This is a bounded input probe, never a position
      // prediction: the next physics tick and the normal fall guard decide whether it continues.
      if (t.mc?.entity?.onGround !== true || !this.#isActive(handle) || handle.stop) return false
      releaseForward()
      await this.#lookForOneTick(handle, desiredYaw, s.tickMs)
      if (handle.stop || !this.#isActive(handle) || t.mc?.entity?.onGround !== true) return false
      const start = nativePosition(t)
      if (!start || !t.setControl('sneak', true)) return false
      if (!t.setControl('forward', true)) {
        if (this.#canCleanup(handle)) {
          try { t.setControl('sneak', false) } catch {}
        }
        return false
      }
      handle.controlsOwned = true
      forward = true
      sneaking = true
      yaw = desiredYaw
      cautiousProbeStart = start
      cautiousProbeUntil = Date.now() + s.cautiousProbeMs
      return true
    }
    try {
      while (!handle.stop && this.#isActive(handle)) {
        if (!bot.isReady() || !t.connected) break
        // Never let an ambiguous-floor probe become a sustained blind walk. A changed ground
        // state releases input immediately; otherwise it lasts at most cautiousProbeMs and then
        // returns to the loaded-collision scan.
        if (cautiousProbeUntil && Date.now() >= cautiousProbeUntil) releaseForward()
        if (cautiousProbeStart) {
          const probePosition = nativePosition(t)
          const leftGround = t.mc?.entity?.onGround !== true
          const steppedTooFar = probePosition && probePosition.y < cautiousProbeStart.y - s.maxStepHeight
          if (leftGround || steppedTooFar) {
            releaseForward()
            this.#recordMotion(bot, handle, 'recovering', { reason: 'native sneak probe released after a ground change', heading: null })
            await sleep(s.tickMs)
            continue
          }
        }
        // Never attempt to steer a falling body. Let Mineflayer and the server resolve the fall,
        // then resume only after it is grounded. This deliberately does not write position or
        // velocity, so it cannot rubber-band the client back upward.
        if (fallingWithoutSupport(t)) {
          if (!fallingSince) {
            fallingSince = Date.now()
            releaseForward()
            this.log.warn?.(`[${bot.username}] unsupported fall detected; movement paused`)
            this.#recordMotion(bot, handle, 'recovering', { reason: 'unsupported fall', heading: null })
          }
        }
        if (fallingSince) {
          if (t.mc?.entity?.onGround === true) {
            fallingSince = 0
            const p = nativePosition(t)
            anchor = p && { x: p.x, z: p.z }
            lastProgress = Date.now()
            lastSafetyCheck = 0
            this.#recordMotion(bot, handle, 'settling', { reason: 'landed; selecting a safe direction', heading: null })
          } else if (Date.now() - fallingSince >= s.fallLandingTimeoutMs) {
            this.log.warn?.(`[${bot.username}] did not land after an unsupported fall; ending this movement pass for safe recovery`)
            break
          } else {
            await sleep(s.tickMs)
            continue
          }
        }
        const velocity = nativeVelocity(t)
        // Do not add input while native physics is resolving an external knockback or correction.
        // It resumes on the same connection once the observed speed is normal again.
        if (velocity && velocity.horizontal > 0.34) {
          releaseForward()
          this.#recordMotion(bot, handle, 'recovering', { reason: 'native velocity is settling', heading: null })
          await sleep(s.tickMs)
          continue
        }
        const now = Date.now()
        if (now - lastRoll > s.directionChangeMs) {
          yaw += (Math.random() - 0.5) * (Math.PI / 2) // curve rather than jitter
          lastRoll = now
          releaseForward()
        }
        const p = nativePosition(t)
        if (p && anchor && Math.hypot(p.x - anchor.x, p.z - anchor.z) > 0.3) {
          anchor = { x: p.x, z: p.z }
          lastProgress = Date.now()
        } else if (p && Date.now() - lastProgress > 1200) {
          // A small curved turn can leave a bot pressing into the same wall indefinitely.
          // Make a wide turn after a full second without server-visible progress.
          yaw += (Math.random() < 0.5 ? -1 : 1) * ((Math.PI * 3) / 4 + Math.random() * (Math.PI / 2))
          anchor = { x: p.x, z: p.z }
          lastProgress = now
          lastRoll = now
          releaseForward()
        } else if (p && !anchor) {
          anchor = { x: p.x, z: p.z }
        }
        // Re-read the loaded floor regularly, before the body can walk over an unobserved edge.
        // A no-safe-heading state keeps the controls released and retries on the next physics tick.
        if (!forward || now - lastSafetyCheck >= s.safetyScanMs) {
          lastSafetyCheck = now
          if (!(await steer(yaw))) {
            releaseForward()
            yaw += (Math.random() < 0.5 ? -1 : 1) * (Math.PI / 4 + Math.random() * ((Math.PI * 3) / 4))
            if (await startCautiousProbe(yaw)) {
              this.#recordMotion(bot, handle, 'probing_safe', { reason: 'testing an ambiguous boundary with native sneak protection', heading: yaw })
              await sleep(s.tickMs)
              continue
            }
            this.#recordMotion(bot, handle, 'paused_safe', { reason: 'no loaded, supported direction is available', heading: null })
            await this.#lookForOneTick(handle, yaw, s.tickMs)
            await sleep(s.tickMs)
            continue
          }
        }
        this.#recordMotion(bot, handle, 'moving', { reason: null, heading: yaw })
        ticks++
        await sleep(s.tickMs)
      }
    } finally {
      // Only the currently registered handle may perform its normal cleanup. stop() deletes the
      // handle and revokes `controlsOwned` synchronously, which makes an old async look harmless.
      if (this.loops.get(bot.id) === handle) {
        this.#releaseControls(handle)
        this.loops.delete(bot.id)
        // A transient unloaded chunk, a natural fall recovery, or a short control handoff must
        // not leave a still-READY bot parked. An explicit stop marks the handle and suppresses
        // this restart; menu completion and match presence also independently re-arm it.
        if (!handle.stop && this.enabled && bot.isReady?.()) {
          this.#recordMotion(bot, handle, 'restarting', { reason: 're-entering continuous movement after safety recovery', heading: null })
          this.#scheduleStart(bot, s.restartDelayMs)
        } else if (!handle.stop) {
          this.#recordMotion(bot, handle, 'stopped', { reason: 'movement loop ended', heading: null })
        }
      }
    }
    if (ticks) this.log.info?.(`[${bot.username}] stopped walking after ${(ticks * s.tickMs / 1000).toFixed(1)}s`)
  }

  async #walk (bot, handle) {
    const t = bot.transport
    if (!t.physics) return
    // Background movement has the lowest-priority lease. A selector, bridge, or future gameplay
    // task preempts it through the same lane rather than competing over Mineflayer controls.
    if (typeof this.supervisor?.run !== 'function') {
      this.log.warn?.(`[${bot.username}] continuous movement needs the action supervisor`)
      return
    }
    try {
      const result = await this.supervisor.run(bot, {
        owner: 'movement',
        action: 'continuous_roam',
        priority: 'background',
        blocksCombat: true,
        timeoutMs: false,
        metadata: { background: true }
      }, async ({ signal, isCurrent, isOwner }) => {
        handle.signal = signal
        handle.isCurrent = isCurrent
        handle.isOwner = isOwner
        handle.started = true
        if (handle.stop || !isCurrent()) return { status: 'STOPPED', error: 'continuous movement stopped before lease start' }
        return this.#walkWithControls(bot, handle)
      })

      // A higher-priority action may occupy the lane while a menu/match event asks us to resume.
      // Leave no stale handle behind; the bounded retry waits for that owner to release control.
      if (this.loops.get(bot.id) === handle) {
        const waitingForLane = result?.status === 'BLOCKED' || !handle.started
        this.#releaseControls(handle)
        this.loops.delete(bot.id)
        if (!handle.stop && this.enabled && bot.isReady?.()) {
          this.#recordMotion(bot, handle, waitingForLane ? 'waiting_lane' : 'restarting', {
            reason: result?.error ?? (waitingForLane ? 'waiting for the active action lease to release controls' : 'movement pass completed'),
            heading: null
          })
          this.#scheduleStart(bot, this.spec.restartDelayMs)
        }
      }
      return result
    } catch (error) {
      if (this.loops.get(bot.id) === handle) {
        this.#releaseControls(handle)
        this.loops.delete(bot.id)
        if (!handle.stop && this.enabled && bot.isReady?.()) {
          this.#recordMotion(bot, handle, 'restarting', { reason: error.message, heading: null })
          this.#scheduleStart(bot, this.spec.restartDelayMs)
        }
      }
      throw error
    }
  }
}
