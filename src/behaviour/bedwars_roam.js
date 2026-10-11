// Conservative, map-independent BedWars exploration.
//
// This behaviour never writes a position or a velocity packet. It looks in randomly chosen safe
// directions and holds Mineflayer's normal forward input across ordinary segments. Before and
// during movement it requires a loaded, solid floor plus empty feet/head space, so an unknown
// edge is a reason to release the keys rather than a place to discover the void.

import { sleep } from '../util.js'
import { observeIronGenerator, resourceCounts } from './bedwars_shop.js'
import { nativeFallReason, nativePosition, nativeVelocity } from './motion_safety.js'

export const DEFAULT_BEDWARS_ROAM = Object.freeze({
  enabled: true,
  tickMs: 50,
  telemetryIntervalMs: 250,
  minSegmentMs: 650,
  maxSegmentMs: 1400,
  // At normal Mineflayer walking speed this is roughly one natural 0.6–1.3 second stride.
  // Shorter segments stopped after only a few ticks and made velocity look visibly jerky.
  minSegmentBlocks: 2,
  maxSegmentBlocks: 4,
  // Continuous mode is the normal BedWars behaviour. A finite maxSegments remains available as
  // an operator-selected diagnostic cap by setting continuous: false.
  continuous: true,
  maxSegments: 64,
  // `false` means a confirmed-match roam owns one supervised lease until it finds a generator,
  // loses a safe floor, is preempted, or match presence ends. Cancellation is still bounded by
  // the ActionSupervisor; an operator can set a positive value for a periodic lease rollover.
  maxSessionMs: false,
  directionWaitMs: 10000,
  // Prefer a gradual curve through available safe headings. A nearest safe fallback remains
  // possible when an edge leaves only a reverse route, but ordinary random turns do not snap 180 degrees.
  maxTurnRadians: Math.PI / 2,
  headingAttempts: 8,
  lookAheadBlocks: 1,
  noProgressMs: 750,
  progressDistance: 0.08,
  maxHorizontalSpeed: 0.34,
  settleSpeed: 0.04,
  settleTimeoutMs: 1200,
  lookTimeoutMs: 750,
  fallRecoveryTimeoutMs: 5000,
  scanIntervalMs: 250
})

const HEADINGS = Object.freeze([
  { dx: 0, dz: -1, label: 'north' },
  { dx: 1, dz: -1, label: 'north-east' },
  { dx: 1, dz: 0, label: 'east' },
  { dx: 1, dz: 1, label: 'south-east' },
  { dx: 0, dz: 1, label: 'south' },
  { dx: -1, dz: 1, label: 'south-west' },
  { dx: -1, dz: 0, label: 'west' },
  { dx: -1, dz: -1, label: 'north-west' }
])

function integer (value, fallback, min, max) {
  const number = Number(value)
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback
}

function decimal (value, fallback, min, max) {
  const number = Number(value)
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback
}

function copyPosition (position) {
  return position && ['x', 'y', 'z'].every((axis) => Number.isFinite(position[axis]))
    ? { x: position.x, y: position.y, z: position.z }
    : null
}

function copyVelocity (velocity) {
  return velocity && ['x', 'y', 'z', 'horizontal'].every((axis) => Number.isFinite(velocity[axis]))
    ? { x: velocity.x, y: velocity.y, z: velocity.z, horizontal: velocity.horizontal }
    : null
}

function cellAt (position) {
  const point = copyPosition(position)
  return point ? { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) } : null
}

function cellKey (cell) { return cell ? `${cell.x}:${cell.y}:${cell.z}` : '' }

function randomBetween (min, max) {
  return min + (Math.random() * Math.max(0, max - min))
}

function shuffled (items) {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1))
    ;[copy[index], copy[other]] = [copy[other], copy[index]]
  }
  return copy
}

function currentLease (isCurrent) {
  if (typeof isCurrent !== 'function') return true
  try { return isCurrent() === true } catch { return false }
}

function mayCleanup (canCleanup) {
  if (typeof canCleanup !== 'function') return true
  try { return canCleanup() === true } catch { return false }
}

/** Read and clamp the live config once per action. */
export function bedwarsRoamSpec (bedwarsCfg = {}) {
  const raw = bedwarsCfg?.roam ?? {}
  const minSegmentMs = integer(raw.minSegmentMs, DEFAULT_BEDWARS_ROAM.minSegmentMs, 100, 5000)
  const maxSegmentMs = integer(raw.maxSegmentMs, DEFAULT_BEDWARS_ROAM.maxSegmentMs, minSegmentMs, 10000)
  const minSegmentBlocks = decimal(raw.minSegmentBlocks, DEFAULT_BEDWARS_ROAM.minSegmentBlocks, 0.1, 4)
  const maxSegmentBlocks = decimal(raw.maxSegmentBlocks, DEFAULT_BEDWARS_ROAM.maxSegmentBlocks, minSegmentBlocks, 6)
  const settleTimeoutMs = integer(raw.settleTimeoutMs, DEFAULT_BEDWARS_ROAM.settleTimeoutMs, 100, 10000)
  const fallRecoveryTimeoutMs = integer(raw.fallRecoveryTimeoutMs, DEFAULT_BEDWARS_ROAM.fallRecoveryTimeoutMs, settleTimeoutMs, 15000)
  const maxSessionMs = raw.maxSessionMs === false
    ? false
    : integer(raw.maxSessionMs, DEFAULT_BEDWARS_ROAM.maxSessionMs, 5000, 120000)
  return {
    ...DEFAULT_BEDWARS_ROAM,
    ...raw,
    enabled: raw.enabled !== false,
    tickMs: integer(raw.tickMs, DEFAULT_BEDWARS_ROAM.tickMs, 25, 250),
    telemetryIntervalMs: integer(raw.telemetryIntervalMs, DEFAULT_BEDWARS_ROAM.telemetryIntervalMs, 100, 2000),
    minSegmentMs,
    maxSegmentMs,
    minSegmentBlocks,
    maxSegmentBlocks,
    continuous: raw.continuous !== false,
    maxSegments: integer(raw.maxSegments, DEFAULT_BEDWARS_ROAM.maxSegments, 1, 1000),
    maxSessionMs,
    directionWaitMs: integer(raw.directionWaitMs, DEFAULT_BEDWARS_ROAM.directionWaitMs, 500, 30000),
    maxTurnRadians: decimal(raw.maxTurnRadians, DEFAULT_BEDWARS_ROAM.maxTurnRadians, 0.1, Math.PI),
    headingAttempts: integer(raw.headingAttempts, DEFAULT_BEDWARS_ROAM.headingAttempts, 1, HEADINGS.length),
    lookAheadBlocks: decimal(raw.lookAheadBlocks, DEFAULT_BEDWARS_ROAM.lookAheadBlocks, 0.5, 2),
    noProgressMs: integer(raw.noProgressMs, DEFAULT_BEDWARS_ROAM.noProgressMs, 100, 10000),
    progressDistance: decimal(raw.progressDistance, DEFAULT_BEDWARS_ROAM.progressDistance, 0.02, 1),
    maxHorizontalSpeed: decimal(raw.maxHorizontalSpeed, DEFAULT_BEDWARS_ROAM.maxHorizontalSpeed, 0.05, 1),
    settleSpeed: decimal(raw.settleSpeed, DEFAULT_BEDWARS_ROAM.settleSpeed, 0.005, 0.2),
    settleTimeoutMs,
    lookTimeoutMs: integer(raw.lookTimeoutMs, DEFAULT_BEDWARS_ROAM.lookTimeoutMs, 100, 5000),
    fallRecoveryTimeoutMs,
    scanIntervalMs: integer(raw.scanIntervalMs, DEFAULT_BEDWARS_ROAM.scanIntervalMs, 100, 5000),
    actionTimeoutMs: maxSessionMs === false ? false : Math.min(125000, maxSessionMs + 2500)
  }
}

function runtimeError (bot, signal, isCurrent, { allowFalling = false } = {}) {
  if (!currentLease(isCurrent)) return 'action lease is no longer current'
  if (signal?.aborted) return 'cancelled'
  if (!bot?.transport?.connected) return 'connection lost'
  if (!bot?.isReady?.()) return `bot is ${bot?.fsm?.state ?? 'not READY'}`
  return allowFalling ? null : nativeFallReason(bot.transport)
}

function isOpenSupportedCell (transport, cell) {
  if (!cell || typeof transport?.blockAt !== 'function') return false
  try {
    const floor = transport.blockAt(cell.x, cell.y - 1, cell.z)
    const feet = transport.blockAt(cell.x, cell.y, cell.z)
    const head = transport.blockAt(cell.x, cell.y + 1, cell.z)
    return floor?.boundingBox === 'block' && feet?.boundingBox === 'empty' && head?.boundingBox === 'empty'
  } catch {
    return false
  }
}

function headingYaw (heading) {
  // The same Mineflayer yaw conversion used by directed BedWars navigation: 0 is -Z.
  return Math.atan2(-heading.dx, -heading.dz)
}

function yawDistance (left, right) {
  let delta = (left - right) % (Math.PI * 2)
  if (delta < -Math.PI) delta += Math.PI * 2
  if (delta > Math.PI) delta -= Math.PI * 2
  return Math.abs(delta)
}

function sweptCells (position, heading, lookAheadBlocks) {
  const length = Math.hypot(heading.dx, heading.dz)
  const unitX = heading.dx / length
  const unitZ = heading.dz / length
  const distances = [0, Math.min(0.35, lookAheadBlocks), lookAheadBlocks]
  const cells = new Map()
  for (const distance of distances) {
    const cell = cellAt({ x: position.x + unitX * distance, y: position.y, z: position.z + unitZ * distance })
    if (cell) cells.set(cellKey(cell), cell)
  }
  // Diagonal input can clip a corner even when the diagonal destination itself is open. Requiring
  // both orthogonal neighbours to be loaded and supported keeps the physical path unambiguous.
  if (heading.dx && heading.dz) {
    const start = cellAt(position)
    if (start) {
      for (const cell of [
        { x: start.x + heading.dx, y: start.y, z: start.z },
        { x: start.x, y: start.y, z: start.z + heading.dz }
      ]) cells.set(cellKey(cell), cell)
    }
  }
  return [...cells.values()]
}

function hasSafeSweep (transport, position, heading, lookAheadBlocks) {
  return sweptCells(position, heading, lookAheadBlocks).every((cell) => isOpenSupportedCell(transport, cell))
}

function chooseHeading (transport, position, spec, { avoid = null } = {}) {
  const candidates = shuffled(HEADINGS)
    .slice(0, spec.headingAttempts)
    .filter((heading) => hasSafeSweep(transport, position, heading, spec.lookAheadBlocks))
  // At a normal segment boundary, choose a different safe direction when available. Keeping the
  // existing one remains valid for a narrow island where it is the only confirmed route.
  const different = candidates.filter((heading) => !avoid || heading.label !== avoid.label)
  if (!different.length) return candidates[0] ?? null
  const yaw = Number(transport?.mc?.entity?.yaw)
  if (!Number.isFinite(yaw)) return different[0]
  const gradual = different.filter((heading) => yawDistance(headingYaw(heading), yaw) <= spec.maxTurnRadians)
  if (gradual.length) return gradual[0]
  // An obstacle can leave no gradual route. Prefer the nearest confirmed fallback over a random
  // reversal, while retaining the loaded-floor requirement above.
  return [...different].sort((left, right) => yawDistance(headingYaw(left), yaw) - yawDistance(headingYaw(right), yaw))[0]
}

function currentIron (bot) {
  try {
    const iron = Number(resourceCounts(bot)?.iron)
    return Number.isFinite(iron) ? Math.max(0, iron) : null
  } catch {
    return null
  }
}

function generatorEvidence (bot, discoveryCfg, sightings, initialIron) {
  return observeIronGenerator(bot, discoveryCfg, sightings, { initialIron })
}

async function settleOnObservedFloor (bot, spec, {
  signal, isCurrent, canCleanup, allowFalling = false, timeoutMs = spec.settleTimeoutMs
} = {}) {
  const transport = bot.transport
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const error = runtimeError(bot, signal, isCurrent, { allowFalling })
    if (error) return { error }
    const position = nativePosition(transport)
    const velocity = nativeVelocity(transport)
    const grounded = transport?.mc?.entity?.onGround === true
    if (grounded && isOpenSupportedCell(transport, cellAt(position)) &&
      (!velocity || velocity.horizontal <= spec.settleSpeed)) {
      return { position, velocity }
    }
    if (mayCleanup(canCleanup)) transport.clearControls?.()
    await sleep(spec.tickMs)
  }
  return { error: 'native physics did not settle on a loaded supporting cell' }
}

async function lookWithin (transport, yaw, timeoutMs) {
  // With `force`, Mineflayer normally updates the local view immediately. Bound the await for
  // alternate transports anyway; if it stalls, the caller releases controls and never starts
  // walking on an unconfirmed heading. A rejection handler contains a late socket failure.
  return new Promise((resolve) => {
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => finish({ settled: false, ok: false }), timeoutMs)
    timer.unref?.()
    let attempt
    try {
      attempt = transport?.look?.(yaw, 0, true)
    } catch {
      finish({ settled: true, ok: false })
      return
    }
    Promise.resolve(attempt).then(
      (ok) => finish({ settled: true, ok: ok === true }),
      () => finish({ settled: true, ok: false })
    )
  })
}

/**
 * Move one short random segment on floor that the client has actually loaded.  The caller owns
 * the ActionSupervisor lease.  A normal edge, obstacle, or lack of progress returns OK so the
 * planner can pick a different direction; an unsupported current footing returns BLOCKED.
 */
export async function roamSupportedSegment (bot, bedwarsCfg = {}, {
  signal, isCurrent, canCleanup, segment = 1, generatorSightings = new Map(), onProgress = () => {}
} = {}) {
  const spec = bedwarsRoamSpec(bedwarsCfg)
  const transport = bot?.transport
  const startedAt = Date.now()
  const base = { action: 'bedwarsRoam', bot: bot?.username, botId: bot?.id, segment }
  let lastEmitAt = 0
  let telemetry = null
  let heading = null

  const snapshot = (state, extra = {}) => {
    const position = nativePosition(transport)
    const velocity = nativeVelocity(transport)
    return {
      state,
      segment,
      // Heading is retained for diagnostics after a safety release; input reports only a key
      // that this action is actively holding, so dashboard/API state cannot claim forward while
      // controls have already been cleared.
      input: state === 'moving' && heading ? 'forward' : null,
      heading: heading?.label ?? null,
      yaw: heading ? headingYaw(heading) : null,
      position: copyPosition(position),
      velocity: copyVelocity(velocity),
      onGround: transport?.mc?.entity?.onGround === true,
      updatedAt: Date.now(),
      ...extra
    }
  }
  const publish = (state, extra = {}, force = false) => {
    telemetry = snapshot(state, extra)
    const now = Date.now()
    if (force || now - lastEmitAt >= spec.telemetryIntervalMs) {
      lastEmitAt = now
      try { onProgress(telemetry) } catch {}
    }
    return telemetry
  }
  const finish = (status, error = null, extra = {}) => {
    const roam = publish(extra.roamState ?? (status === 'OK' ? 'paused' : 'stopped'), {
      ...(extra.roam ?? {}),
      ...(extra.replan ? { replan: extra.replan } : {}),
      ...(error ? { lastSafetyStop: { reason: error, at: Date.now() } } : {})
    }, true)
    return { ...base, status, ...(error ? { error } : {}), ...extra, roam, latencyMs: Date.now() - startedAt }
  }
  const release = () => { if (mayCleanup(canCleanup)) transport?.clearControls?.() }

  if (!spec.enabled) return finish('BLOCKED', 'BedWars roaming is disabled by configuration')
  if (!transport?.physics) return finish('BLOCKED', 'BedWars roaming needs the Mineflayer physics transport')
  if (!transport?.connected) return finish('STOPPED', 'connection lost')
  if (!bot?.isReady?.()) return finish('STOPPED', `bot is ${bot?.fsm?.state ?? 'not READY'}`)

  try {
    release()
    publish('settling')
    // A match entry or server correction can leave Mineflayer airborne for a few ticks. This is
    // a wait-only phase: no input is issued until the server/client physics reports a safe floor.
    const settled = await settleOnObservedFloor(bot, spec, {
      signal, isCurrent, canCleanup, allowFalling: true, timeoutMs: spec.fallRecoveryTimeoutMs
    })
    if (settled.error) {
      const status = /cancelled|lease is no longer current|connection lost|not READY/.test(settled.error) ? 'STOPPED' : 'BLOCKED'
      return finish(status, settled.error)
    }

    const start = settled.position
    heading = chooseHeading(transport, start, spec)
    if (!heading) {
      // Chunks can arrive a few ticks after the BedWars scoreboard. Remain still and retry the
      // loaded-world scan rather than converting a transient chunk gap into a terminal autoplay
      // failure or guessing a direction beyond the known floor.
      return finish('OK', null, {
        replan: 'awaiting_supported_direction', roamState: 'paused', segmentCompleted: false,
        retryAfterMs: 1000,
        roam: { lastSafetyStop: { reason: 'no loaded, supported direction is available near the bot', at: Date.now() } }
      })
    }
    const looked = await lookWithin(transport, headingYaw(heading), spec.lookTimeoutMs)
    if (!looked.settled) return finish('FAILED', `view update did not settle within ${spec.lookTimeoutMs}ms`)
    if (!looked.ok) return finish('FAILED', 'cannot turn toward a safe roaming direction')
    // Give Mineflayer one physics tick to emit the view update before it receives a movement
    // input. A forced handoff can happen during that tick, so recheck before changing a key.
    await sleep(spec.tickMs)
    const afterLook = runtimeError(bot, signal, isCurrent)
    if (afterLook) {
      const status = /cancelled|lease is no longer current|connection lost|not READY/.test(afterLook) ? 'STOPPED' : 'BLOCKED'
      return finish(status, afterLook)
    }

    const initialIron = currentIron(bot)
    const sightings = generatorSightings instanceof Map ? generatorSightings : new Map()
    // Check the already-loaded view before moving. A confirmed nearby drop cluster lets the
    // planner route directly to the real generator instead of taking an unnecessary random step.
    const initialGenerator = generatorEvidence(bot, bedwarsCfg.generatorDiscovery ?? {}, sightings, initialIron)
    if (initialGenerator) {
      return finish('OK', null, { generator: initialGenerator, replan: 'generator_observed', roamState: 'paused' })
    }
    const deadline = Date.now() + randomBetween(spec.minSegmentMs, spec.maxSegmentMs)
    const targetDistance = randomBetween(spec.minSegmentBlocks, spec.maxSegmentBlocks)
    let lastProgressAt = Date.now()
    let progressAnchor = start
    let lastScanAt = Date.now()

    if (!transport.setControl('forward', true)) return finish('FAILED', 'cannot apply forward movement input')
    publish('moving')
    while (Date.now() < deadline) {
      await sleep(spec.tickMs)
      const error = runtimeError(bot, signal, isCurrent)
      if (error) {
        release()
        if (error === nativeFallReason(transport)) {
          publish('recovering', { lastSafetyStop: { reason: error, at: Date.now() } }, true)
          const recovered = await settleOnObservedFloor(bot, spec, {
            signal, isCurrent, canCleanup, allowFalling: true, timeoutMs: spec.fallRecoveryTimeoutMs
          })
          if (recovered.error) return finish('BLOCKED', recovered.error)
          return finish('OK', null, { replan: 'fall_recovered', roamState: 'paused' })
        }
        const status = /cancelled|lease is no longer current|connection lost|not READY/.test(error) ? 'STOPPED' : 'BLOCKED'
        return finish(status, error)
      }

      const position = nativePosition(transport)
      if (!position) {
        release()
        return finish('BLOCKED', 'native position is unavailable during roaming')
      }
      if (!isOpenSupportedCell(transport, cellAt(position))) {
        release()
        return finish('BLOCKED', 'current roaming cell no longer has loaded, clear support')
      }

      const velocity = nativeVelocity(transport)
      if (transport.mc?.entity?.onGround !== true ||
        (velocity && velocity.horizontal > spec.maxHorizontalSpeed)) {
        release()
        publish('settling', { lastSafetyStop: { reason: 'native velocity was unsettled', at: Date.now() } }, true)
        const resettled = await settleOnObservedFloor(bot, spec, {
          signal, isCurrent, canCleanup, allowFalling: true, timeoutMs: spec.fallRecoveryTimeoutMs
        })
        if (resettled.error) return finish('BLOCKED', resettled.error)
        return finish('OK', null, { replan: 'velocity_settled', roamState: 'paused' })
      }

      if (!hasSafeSweep(transport, position, heading, spec.lookAheadBlocks)) {
        release()
        return finish('OK', null, {
          replan: 'supported_boundary', roamState: 'paused',
          roam: { lastSafetyStop: { reason: 'released before an unloaded or unsupported direction', at: Date.now() } }
        })
      }

      const moved = Math.hypot(position.x - start.x, position.z - start.z)
      const movedSinceAnchor = Math.hypot(position.x - progressAnchor.x, position.z - progressAnchor.z)
      if (movedSinceAnchor >= spec.progressDistance) {
        progressAnchor = position
        lastProgressAt = Date.now()
      } else if (Date.now() - lastProgressAt >= spec.noProgressMs) {
        release()
        return finish('OK', null, { replan: 'no_progress', roamState: 'paused' })
      }

      if (Date.now() - lastScanAt >= spec.scanIntervalMs) {
        lastScanAt = Date.now()
        const generator = generatorEvidence(bot, bedwarsCfg.generatorDiscovery ?? {}, sightings, initialIron)
        if (generator) {
          release()
          return finish('OK', null, { generator, replan: 'generator_observed', roamState: 'paused' })
        }
      }

      if (moved >= targetDistance) {
        release()
        return finish('OK', null, { replan: 'segment_complete', moved, roamState: 'paused' })
      }
      publish('moving')
    }
    release()
    return finish('OK', null, { replan: 'segment_timeout', roamState: 'paused' })
  } finally {
    release()
  }
}

/**
 * Continuous, supervised version of the map-independent roam. It keeps one ActionSupervisor
 * lease across ordinary directional changes, so Mineflayer's natural movement packets do not
 * have a lease-release/cooldown gap after every stride. Full controls are released only for a
 * safety recovery, cancellation, connection loss, or final return.
 */
export async function roamSupportedLoop (bot, bedwarsCfg = {}, {
  signal, isCurrent, canCleanup, initialSegments = 0, generatorSightings = new Map(),
  shouldYield = null, onProgress = () => {}
} = {}) {
  const spec = bedwarsRoamSpec(bedwarsCfg)
  const transport = bot?.transport
  const startedAt = Date.now()
  const sessionDeadline = spec.maxSessionMs === false ? Number.POSITIVE_INFINITY : startedAt + spec.maxSessionMs
  const completedBefore = Math.max(0, Math.floor(Number(initialSegments) || 0))
  const base = { action: 'bedwarsRoamLoop', bot: bot?.username, botId: bot?.id, initialSegments: completedBefore }
  let segment = completedBefore + 1
  let segmentsStarted = 0
  let heading = null
  let forward = false
  let lastEmitAt = 0
  let telemetry = null
  let lastPosition = null
  let lastMovementAt = null
  let totalMoved = 0
  let segmentStart = null
  let segmentDeadline = 0
  let targetDistance = 0
  let progressAnchor = null
  let lastProgressAt = 0
  let lastScanAt = 0
  let initialIron = null
  const sightings = generatorSightings instanceof Map ? generatorSightings : new Map()

  const snapshot = (state, extra = {}) => {
    const position = nativePosition(transport)
    const velocity = nativeVelocity(transport)
    return {
      state,
      segment,
      segments: completedBefore + segmentsStarted,
      input: state === 'moving' && forward ? 'forward' : null,
      heading: heading?.label ?? null,
      yaw: heading ? headingYaw(heading) : null,
      position: copyPosition(position),
      velocity: copyVelocity(velocity),
      onGround: transport?.mc?.entity?.onGround === true,
      lastMovementAt,
      updatedAt: Date.now(),
      ...extra
    }
  }
  const publish = (state, extra = {}, force = false) => {
    telemetry = snapshot(state, extra)
    const now = Date.now()
    if (force || now - lastEmitAt >= spec.telemetryIntervalMs) {
      lastEmitAt = now
      try { onProgress(telemetry) } catch {}
    }
    return telemetry
  }
  const finish = (status, error = null, extra = {}) => {
    const roam = publish(extra.roamState ?? (status === 'OK' ? 'paused_safe' : 'stopped'), {
      ...(extra.roam ?? {}),
      ...(extra.replan ? { replan: extra.replan } : {}),
      ...(error ? { lastSafetyStop: { reason: error, at: Date.now() } } : {})
    }, true)
    return {
      ...base,
      status,
      ...(error ? { error } : {}),
      ...extra,
      // Keep the returned count aligned with the live telemetry. `newSegments` lets a caller
      // account for the work completed by this particular invocation without losing the total.
      segments: completedBefore + segmentsStarted,
      newSegments: segmentsStarted,
      moved: totalMoved,
      roam,
      latencyMs: Date.now() - startedAt
    }
  }
  const stopStatus = (error) => /cancelled|lease is no longer current|connection lost|not READY/.test(String(error))
    ? 'STOPPED'
    : 'BLOCKED'
  const release = () => {
    forward = false
    if (mayCleanup(canCleanup)) transport?.clearControls?.()
  }
  const releaseForward = () => {
    forward = false
    if (!mayCleanup(canCleanup)) return false
    try { return transport?.setControl?.('forward', false) === true } catch { return false }
  }
  const recordPosition = (position) => {
    if (!position) return
    if (lastPosition) {
      const delta = Math.hypot(position.x - lastPosition.x, position.z - lastPosition.z)
      // Server corrections should not make the movement telemetry claim a huge walked distance.
      if (delta >= 0.002 && delta <= 1.5) {
        totalMoved += delta
        lastMovementAt = Date.now()
      }
    }
    lastPosition = copyPosition(position)
  }
  const actionError = (error, status = null) => ({ error, status: status ?? stopStatus(error) })
  const combatHandoff = () => {
    if (typeof shouldYield !== 'function') return null
    try {
      const detail = shouldYield()
      if (!detail) return null
      return typeof detail === 'string' ? { reason: detail } : detail
    } catch {
      return null
    }
  }

  const waitForSafeHeading = async (reason, { avoid = heading } = {}) => {
    const waitDeadline = Math.min(sessionDeadline, Date.now() + spec.directionWaitMs)
    publish('paused_safe', {
      replan: reason,
      lastSafetyStop: { reason: 'waiting for a loaded, supported direction', at: Date.now() }
    }, true)
    while (Date.now() < waitDeadline && Date.now() < sessionDeadline) {
      const lifecycleError = runtimeError(bot, signal, isCurrent, { allowFalling: true })
      if (lifecycleError) return actionError(lifecycleError)
      const position = nativePosition(transport)
      if (!position) return actionError('native position is unavailable while waiting for a safe direction')
      recordPosition(position)

      const velocity = nativeVelocity(transport)
      const falling = nativeFallReason(transport)
      if (falling || transport.mc?.entity?.onGround !== true ||
        (velocity && velocity.horizontal > spec.maxHorizontalSpeed)) {
        publish('recovering', { lastSafetyStop: { reason: falling ?? 'native physics was unsettled', at: Date.now() } }, true)
        const settled = await settleOnObservedFloor(bot, spec, {
          signal, isCurrent, canCleanup, allowFalling: true, timeoutMs: spec.fallRecoveryTimeoutMs
        })
        if (settled.error) return actionError(settled.error)
        recordPosition(settled.position)
        continue
      }
      if (!isOpenSupportedCell(transport, cellAt(position))) {
        return actionError('current roaming cell no longer has loaded, clear support')
      }
      // A normal turn can carry some velocity. When waiting because every direction was unsafe,
      // wait for that old momentum to settle before a new chunk direction is accepted.
      if (velocity && velocity.horizontal > spec.settleSpeed) {
        publish('settling', { replan: reason }, true)
        const settled = await settleOnObservedFloor(bot, spec, {
          signal, isCurrent, canCleanup, allowFalling: true, timeoutMs: spec.settleTimeoutMs
        })
        if (settled.error) return actionError(settled.error)
        recordPosition(settled.position)
        continue
      }
      if (Date.now() - lastScanAt >= spec.scanIntervalMs) {
        lastScanAt = Date.now()
        const generator = generatorEvidence(bot, bedwarsCfg.generatorDiscovery ?? {}, sightings, initialIron)
        if (generator) return { generator }
      }
      const handoff = combatHandoff()
      if (handoff) return { handoff }
      const next = chooseHeading(transport, position, spec, { avoid })
      if (next) return { position, heading: next }
      await sleep(spec.tickMs)
    }
    return { waiting: true }
  }

  const beginSegment = async (position, requestedHeading, replan) => {
    if (Date.now() >= sessionDeadline) return { expired: true }
    if (!spec.continuous && completedBefore + segmentsStarted >= spec.maxSegments) return { limit: true }
    const nextHeading = requestedHeading ?? chooseHeading(transport, position, spec, { avoid: heading })
    if (!nextHeading) return { waiting: true }

    // A turn deliberately releases only forward for one normal physics tick. This prevents the
    // body from advancing into a new direction while an alternate transport is still resolving
    // look(), without the full clearControls/lease gap that caused the visible idle pauses.
    if (!releaseForward()) {
      const releaseError = runtimeError(bot, signal, isCurrent)
      return actionError(releaseError ?? 'cannot release forward movement input before turning', releaseError ? null : 'FAILED')
    }
    publish('turning', { replan }, true)
    const looked = await lookWithin(transport, headingYaw(nextHeading), spec.lookTimeoutMs)
    // A lost socket or preemption during the look must be reported as such, not as a generic
    // turning failure. This also makes the following key mutation stale-safe.
    const afterLookError = runtimeError(bot, signal, isCurrent)
    if (afterLookError) return actionError(afterLookError)
    if (!looked.settled) return actionError(`view update did not settle within ${spec.lookTimeoutMs}ms`, 'FAILED')
    if (!looked.ok) return actionError('cannot turn toward a safe roaming direction', 'FAILED')
    await sleep(spec.tickMs)
    const lifecycleError = runtimeError(bot, signal, isCurrent)
    if (lifecycleError) return actionError(lifecycleError)
    if (Date.now() >= sessionDeadline) return { expired: true }
    const current = nativePosition(transport)
    if (!current) return actionError('native position is unavailable before roaming input')
    recordPosition(current)
    if (!isOpenSupportedCell(transport, cellAt(current))) {
      return actionError('current roaming cell no longer has loaded, clear support')
    }
    if (!hasSafeSweep(transport, current, nextHeading, spec.lookAheadBlocks)) return { waiting: true }
    if (!transport.setControl('forward', true)) return actionError('cannot apply forward movement input', 'FAILED')

    heading = nextHeading
    segmentsStarted++
    segment = completedBefore + segmentsStarted
    segmentStart = current
    segmentDeadline = Date.now() + randomBetween(spec.minSegmentMs, spec.maxSegmentMs)
    targetDistance = randomBetween(spec.minSegmentBlocks, spec.maxSegmentBlocks)
    progressAnchor = current
    lastProgressAt = Date.now()
    forward = true
    publish('moving', { replan: segmentsStarted === 1 ? 'segment_started' : replan }, true)
    return { ok: true }
  }

  const resume = async (reason, { avoid = heading } = {}) => {
    release()
    const ready = await waitForSafeHeading(reason, { avoid })
    if (ready.error || ready.waiting || ready.generator || ready.handoff) return ready
    return beginSegment(ready.position, ready.heading, reason)
  }
  const concludeAdvance = (result) => {
    if (result?.generator) return finish('OK', null, { generator: result.generator, replan: 'generator_observed' })
    if (result?.handoff) {
      return finish('OK', null, {
        replan: 'combat_handoff', retryAfterMs: 0, roamState: 'paused_safe', combat: result.handoff
      })
    }
    if (result?.expired) {
      return finish('OK', null, { replan: 'session_rollover', retryAfterMs: 0, roamState: 'paused_safe' })
    }
    if (result?.waiting) {
      return finish('OK', null, {
        replan: 'awaiting_supported_direction', retryAfterMs: 1000, roamState: 'paused_safe'
      })
    }
    if (result?.limit) {
      return finish('BLOCKED', `no generator evidence after ${completedBefore + segmentsStarted} safe roaming segments`)
    }
    return finish(result?.status ?? 'BLOCKED', result?.error ?? 'could not resume safe roaming')
  }

  if (!spec.enabled) return finish('BLOCKED', 'BedWars roaming is disabled by configuration')
  if (!transport?.physics) return finish('BLOCKED', 'BedWars roaming needs the Mineflayer physics transport')
  if (!transport?.connected) return finish('STOPPED', 'connection lost')
  if (!bot?.isReady?.()) return finish('STOPPED', `bot is ${bot?.fsm?.state ?? 'not READY'}`)

  try {
    release()
    publish('settling')
    const settled = await settleOnObservedFloor(bot, spec, {
      signal, isCurrent, canCleanup, allowFalling: true, timeoutMs: spec.fallRecoveryTimeoutMs
    })
    if (settled.error) return finish(stopStatus(settled.error), settled.error)
    recordPosition(settled.position)

    initialIron = currentIron(bot)
    const initialGenerator = generatorEvidence(bot, bedwarsCfg.generatorDiscovery ?? {}, sightings, initialIron)
    if (initialGenerator) return finish('OK', null, { generator: initialGenerator, replan: 'generator_observed' })
    lastScanAt = Date.now()

    let next = await beginSegment(settled.position, null, 'segment_started')
    if (next.waiting) next = await resume('awaiting_supported_direction', { avoid: null })
    if (!next.ok) return concludeAdvance(next)

    while (Date.now() < sessionDeadline) {
      await sleep(spec.tickMs)
      const lifecycleError = runtimeError(bot, signal, isCurrent)
      if (lifecycleError) {
        if (lifecycleError === nativeFallReason(transport)) {
          next = await resume('fall_recovered')
          if (!next.ok) return concludeAdvance(next)
          continue
        }
        return finish(stopStatus(lifecycleError), lifecycleError)
      }

      const position = nativePosition(transport)
      if (!position) return finish('BLOCKED', 'native position is unavailable during roaming')
      recordPosition(position)
      if (!isOpenSupportedCell(transport, cellAt(position))) {
        return finish('BLOCKED', 'current roaming cell no longer has loaded, clear support')
      }

      const handoff = combatHandoff()
      if (handoff) {
        return finish('OK', null, {
          replan: 'combat_handoff', retryAfterMs: 0, roamState: 'paused_safe', combat: handoff
        })
      }

      const velocity = nativeVelocity(transport)
      if (transport.mc?.entity?.onGround !== true ||
        (velocity && velocity.horizontal > spec.maxHorizontalSpeed)) {
        next = await resume('physics_recovered')
        if (!next.ok) return concludeAdvance(next)
        continue
      }

      if (Date.now() - lastScanAt >= spec.scanIntervalMs) {
        lastScanAt = Date.now()
        const generator = generatorEvidence(bot, bedwarsCfg.generatorDiscovery ?? {}, sightings, initialIron)
        if (generator) return finish('OK', null, { generator, replan: 'generator_observed' })
      }

      if (!hasSafeSweep(transport, position, heading, spec.lookAheadBlocks)) {
        // The old heading has reached an unconfirmed boundary. It may still carry normal walking
        // momentum, so use the full recovery path here rather than a one-tick normal turn.
        next = await resume('supported_boundary')
        if (!next.ok) return concludeAdvance(next)
        continue
      }

      const moved = Math.hypot(position.x - segmentStart.x, position.z - segmentStart.z)
      const movedSinceAnchor = Math.hypot(position.x - progressAnchor.x, position.z - progressAnchor.z)
      if (movedSinceAnchor >= spec.progressDistance) {
        progressAnchor = position
        lastProgressAt = Date.now()
      } else if (Date.now() - lastProgressAt >= spec.noProgressMs) {
        next = await beginSegment(position, null, 'no_progress')
        if (next.waiting) next = await resume('awaiting_supported_direction')
        if (!next.ok) return concludeAdvance(next)
        continue
      }

      if (moved >= targetDistance || Date.now() >= segmentDeadline) {
        next = await beginSegment(position, null, moved >= targetDistance ? 'segment_complete' : 'segment_timeout')
        if (next.waiting) next = await resume('awaiting_supported_direction')
        if (!next.ok) return concludeAdvance(next)
        continue
      }
      publish('moving')
    }
    // A finite operator-selected session rolls directly into the next plan. The default is an
    // unbounded supervised loop, so this branch is only reached when maxSessionMs is configured.
    return finish('OK', null, { replan: 'session_rollover', retryAfterMs: 0, roamState: 'paused_safe' })
  } finally {
    release()
  }
}
