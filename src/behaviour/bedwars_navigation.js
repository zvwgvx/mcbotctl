// BedWars movement between configured islands. Coordinates describe the block at the bot's
// feet, not the supporting block below it. A map may use one bridgeStart per island, or a
// routes[targetId] entry with { start, end } when an island has several exits.

import pathfinderPackage from 'mineflayer-pathfinder'
import { sleep } from '../util.js'

const { Movements, goals } = pathfinderPackage
const { GoalBlock } = goals
const DEFAULT_WALK_TIMEOUT_MS = 15_000
const DEFAULT_STEP_TIMEOUT_MS = 3_000
const DEFAULT_MAX_BRIDGE_LENGTH = 96

function cell (point) {
  if (!point || !['x', 'y', 'z'].every((axis) => Number.isFinite(point[axis]))) return null
  return { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) }
}

function sameCell (a, b) {
  return a?.x === b?.x && a?.y === b?.y && a?.z === b?.z
}

function currentCell (transport) { return cell(transport.pos) }

function nodes (geometry) {
  return [geometry?.home, ...(Array.isArray(geometry?.islands) ? geometry.islands : [])]
    .filter((island) => island && typeof island.id === 'string' && island.id)
}

function byId (geometry, id) { return nodes(geometry).find((island) => island.id === id) }

function neighborIds (island) {
  if (!Array.isArray(island?.neighbors)) return null
  return new Set(island.neighbors.map((entry) => typeof entry === 'string' ? entry : entry?.id).filter(Boolean))
}

function distanceSquared (a, b) {
  const dx = a.x - b.x, dz = a.z - b.z
  return dx * dx + dz * dz
}

/** Pick the nearest unvisited, explicitly adjacent island when neighbors are supplied. */
export function selectNeighborIsland (geometry, fromId = geometry?.home?.id, visitedIds = []) {
  const source = byId(geometry, fromId)
  if (!source) return null
  const visited = new Set(visitedIds)
  const adjacent = neighborIds(source)
  return (Array.isArray(geometry?.islands) ? geometry.islands : [])
    .filter((target) => target?.id && target.id !== source.id && !visited.has(target.id))
    .filter((target) => !adjacent || adjacent.has(target.id))
    .map((target) => {
      const route = routeFor(geometry, source, target)
      return { target, route, origin: cell(source.center ?? source.generator) ?? route.start, point: cell(target.center) ?? route.end }
    })
    .filter(({ route, origin, point }) => origin && point && route.start && route.end && cardinalRoute(route.start, route.end))
    .sort((a, b) => distanceSquared(a.origin, a.point) - distanceSquared(b.origin, b.point) || a.target.id.localeCompare(b.target.id))[0]?.target ?? null
}

function reasonToStop (bot, signal) {
  if (signal?.aborted) return 'cancelled'
  if (!bot?.transport?.connected) return 'connection lost'
  if (!bot.isReady?.()) return `bot is ${bot?.fsm?.state ?? 'not READY'}`
  return null
}

function clearPathGoal (mc, goal) {
  if (mc?.pathfinder?.goal === goal) mc.pathfinder.setGoal(null)
}

/** Walk on known solid floor only. Pathfinder cannot dig, place, sprint, jump gaps, or drop. */
export async function walkToWaypoint (bot, point, { signal, timeoutMs = DEFAULT_WALK_TIMEOUT_MS } = {}) {
  const startedAt = Date.now()
  const destination = cell(point)
  const base = { action: 'bedwarsWalk', bot: bot?.username, botId: bot?.id, destination }
  const fail = (error) => ({ ...base, status: 'FAILED', error, latencyMs: Date.now() - startedAt })
  if (!destination) return fail('waypoint needs finite x, y, z coordinates')

  const transport = bot?.transport
  const mc = transport?.mc
  if (!transport?.physics || !mc?.pathfinder) return fail('walking needs the mineflayer physics transport')
  const stopReason = reasonToStop(bot, signal)
  if (stopReason) return fail(stopReason)

  // Do not ask pathfinder to navigate to a point whose floor has not been observed. In BedWars an
  // unloaded or missing floor can mean the void. Paths themselves will be planned without blocks
  // or jumps, so every selected node already has a supporting floor.
  // Teleport and chunk packets can arrive after the fixture's chat reply. Wait for observation,
  // while still refusing to move if the floor never loads.
  const loadDeadline = Date.now() + Math.min(timeoutMs, 10000)
  let floor, feet, head
  do {
    const stopped = reasonToStop(bot, signal)
    if (stopped) return fail(stopped)
    floor = transport.blockAt(destination.x, destination.y - 1, destination.z)
    feet = transport.blockAt(destination.x, destination.y, destination.z)
    head = transport.blockAt(destination.x, destination.y + 1, destination.z)
    if (transport.pos && floor && feet && head) break
    await sleep(100)
  } while (Date.now() < loadDeadline)
  if (!transport.pos) return fail('bot position is unknown')
  if (!floor) return fail('waypoint floor is not loaded')
  if (floor.boundingBox !== 'block') return fail('waypoint has no solid floor')
  if (!feet || !head) return fail('waypoint space is not loaded')
  if (feet.boundingBox !== 'empty' || head.boundingBox !== 'empty') return fail('waypoint is obstructed')

  if (sameCell(currentCell(transport), destination)) {
    return { ...base, status: 'OK', reached: true, latencyMs: Date.now() - startedAt }
  }

  const movements = new Movements(mc)
  movements.canDig = false
  movements.scafoldingBlocks = []
  movements.allow1by1towers = false
  movements.allowParkour = false
  movements.allowSprinting = false
  movements.allowFreeMotion = false
  movements.maxDropDown = 0
  movements.infiniteLiquidDropdownDistance = false
  movements.canOpenDoors = false
  mc.pathfinder.setMovements(movements)

  const goal = new GoalBlock(destination.x, destination.y, destination.z)
  let timer
  let poll
  let onAbort
  try {
    const interruption = new Promise((_, reject) => {
      onAbort = () => { clearPathGoal(mc, goal); reject(new Error('cancelled')) }
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => { clearPathGoal(mc, goal); reject(new Error('waypoint timed out')) }, timeoutMs)
      poll = setInterval(() => {
        const stopped = reasonToStop(bot, signal)
        if (stopped) { clearPathGoal(mc, goal); reject(new Error(stopped)) }
      }, 100)
    })
    const walking = mc.pathfinder.goto(goal)
    if (signal?.aborted) onAbort()
    await Promise.race([walking, interruption])
    if (!sameCell(currentCell(transport), destination)) return fail('pathfinder stopped before the waypoint')
    return { ...base, status: 'OK', reached: true, latencyMs: Date.now() - startedAt }
  } catch (error) {
    clearPathGoal(mc, goal)
    return fail(error.message)
  } finally {
    clearTimeout(timer)
    clearInterval(poll)
    signal?.removeEventListener('abort', onAbort)
  }
}

function routeFor (geometry, source, target) {
  const sourceRoute = Array.isArray(source.routes)
    ? source.routes.find((route) => route.to === target.id || route.targetId === target.id)
    : source.routes?.[target.id]
  const mapRoute = geometry.routes?.find?.((route) => route.from === source.id && route.to === target.id)
  const route = sourceRoute ?? mapRoute ?? {}
  return {
    start: cell(route.start ?? source.bridgeStart),
    end: cell(route.end ?? target.bridgeEnd ?? target.center)
  }
}

function cardinalRoute (start, end) {
  if (start.y !== end.y) return null
  const dx = end.x - start.x, dz = end.z - start.z
  if ((dx === 0) === (dz === 0)) return null
  const dir = { dx: Math.sign(dx), dz: Math.sign(dz) }
  // Mineflayer's internal yaw is 0 toward -Z (see its lookAt implementation), whereas the
  // raw 1.8 packet yaw described by the manual bridge control is 0 toward +Z.
  const yaw = Math.atan2(-dir.dx, -dir.dz)
  return { ...dir, yaw, distance: Math.abs(dx) + Math.abs(dz) }
}

function observedBlock (transport, x, y, z) {
  const block = transport.blockAt(x, y, z)
  if (!block) throw new Error(`world block ${x},${y},${z} is not loaded`)
  return block
}

function requireSafeCell (transport, position) {
  const floor = observedBlock(transport, position.x, position.y - 1, position.z)
  if (floor.boundingBox !== 'block') throw new Error(`no solid floor at ${position.x},${position.y - 1},${position.z}`)
  for (const y of [position.y, position.y + 1]) {
    if (observedBlock(transport, position.x, y, position.z).boundingBox !== 'empty') {
      throw new Error(`bridge path obstructed at ${position.x},${y},${position.z}`)
    }
  }
}

function woolItems (transport) {
  return transport.mc.inventory.items().filter((item) => /wool/i.test(item.name))
}

async function equipWool (transport) {
  const item = woolItems(transport)[0]
  if (!item) return null
  try { await transport.mc.equip(item, 'hand'); return item } catch { return null }
}

async function waitForSolidFloor (transport, position, signal) {
  const until = Date.now() + 1000
  do {
    if (signal?.aborted) throw new Error('cancelled')
    if (!transport.connected) throw new Error('connection lost')
    const block = transport.blockAt(position.x, position.y - 1, position.z)
    if (block?.boundingBox === 'block') return true
    await sleep(50)
  } while (Date.now() < until)
  return false
}

async function moveOnSupportedFloor (bot, target, { signal, timeoutMs, tolerance = 0.15 } = {}) {
  const t = bot.transport
  const position = t.pos
  if (!position) throw new Error('bot position is unknown')
  const dx = target.x - position.x, dz = target.z - position.z
  const distance = Math.hypot(dx, dz)
  if (distance <= tolerance) return
  const unitX = dx / distance, unitZ = dz / distance
  const yaw = Math.atan2(-dx, -dz)
  if (!await t.look(yaw, 0, true)) throw new Error('cannot face the waypoint')
  const startedAt = Date.now()
  if (!t.setControl('forward', true)) throw new Error('cannot move forward')
  try {
    while (Date.now() - startedAt < timeoutMs) {
      const stopped = reasonToStop(bot, signal)
      if (stopped) throw new Error(stopped)
      const p = t.pos
      if (!p) throw new Error('bot position is unknown')
      if (Math.abs(p.y - target.y) > 0.6) throw new Error('bot changed height while crossing')
      const movedX = p.x - position.x, movedZ = p.z - position.z
      const forward = movedX * unitX + movedZ * unitZ
      const sideways = Math.abs(movedX * unitZ - movedZ * unitX)
      if (sideways > 0.3) throw new Error('bot drifted sideways while crossing')
      if (forward >= distance - tolerance) return
      await sleep(50)
    }
    const p = t.pos
    throw new Error(`movement timed out near ${p?.x?.toFixed(2)},${p?.y?.toFixed(2)},${p?.z?.toFixed(2)} toward ${target.x},${target.y},${target.z}`)
  } finally { t.setControl('forward', false) }
}

/** Bridge to a configured neighboring island, stopping only after the endpoint is reached. */
export async function bridgeToNeighbor (bot, geometry, { fromId = geometry?.home?.id, targetId, visitedIds = [], signal, maxDistance = DEFAULT_MAX_BRIDGE_LENGTH, stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS } = {}, log = console) {
  const startedAt = Date.now()
  const base = { action: 'bedwarsBridge', bot: bot?.username, botId: bot?.id, fromId, targetId: targetId ?? null, placed: 0, steps: 0, reached: false }
  const fail = (error) => ({ ...base, status: 'FAILED', error, latencyMs: Date.now() - startedAt })
  const source = byId(geometry, fromId)
  if (!source) return fail(`source island ${fromId ?? '(missing)'} is not configured`)
  const target = targetId ? byId(geometry, targetId) : selectNeighborIsland(geometry, fromId, visitedIds)
  if (!target || target === geometry?.home) {
    return fail(targetId
      ? `target island ${targetId} is not configured`
      : `no unvisited island has a configured cardinal bridge route from ${source.id}`)
  }
  base.targetId = target.id
  const adjacent = neighborIds(source)
  if (adjacent && !adjacent.has(target.id)) return fail(`${target.id} is not adjacent to ${source.id}`)

  const { start, end } = routeFor(geometry, source, target)
  if (!start) return fail(`bridge start from ${source.id} to ${target.id} is not configured`)
  if (!end) return fail(`bridge end for ${target.id} is not configured`)
  const route = cardinalRoute(start, end)
  if (!route) return fail('bridge start and end must share a Y level and one X or Z axis')
  if (!Number.isInteger(maxDistance) || maxDistance < 1 || route.distance > maxDistance) {
    return fail(`bridge distance ${route.distance} exceeds configured maximum ${maxDistance}`)
  }

  const t = bot?.transport
  if (!t?.physics || !t.mc) return fail('bridging needs the mineflayer physics transport')
  const stopped = reasonToStop(bot, signal)
  if (stopped) return fail(stopped)

  const approach = await walkToWaypoint(bot, start, { signal })
  if (approach.status !== 'OK') return fail(`cannot reach bridge start: ${approach.error}`)

  try {
    requireSafeCell(t, start)
    if (!t.setControl('sneak', true)) throw new Error('cannot hold sneak')
    // Pathfinder reaches a block, not its center. Align while standing on its known solid floor
    // before approaching the first gap; later steps also end near block centers.
    await moveOnSupportedFloor(bot, { x: start.x + 0.5, y: start.y, z: start.z + 0.5 }, { signal, timeoutMs: stepTimeoutMs, tolerance: 0.12 })
    if (!sameCell(currentCell(t), start)) throw new Error('bot left the configured bridge start')
    if (!await equipWool(t)) throw new Error('no wool in the inventory')

    for (let n = 1; n <= route.distance; n++) {
      const stopped = reasonToStop(bot, signal)
      if (stopped) throw new Error(stopped)
      const here = { x: start.x + route.dx * (n - 1), y: start.y, z: start.z + route.dz * (n - 1) }
      const next = { x: here.x + route.dx, y: here.y, z: here.z + route.dz }
      if (!sameCell(currentCell(t), here)) throw new Error(`bot drifted off bridge at step ${n}`)
      requireSafeCell(t, here)

      const feet = observedBlock(t, next.x, next.y, next.z)
      const head = observedBlock(t, next.x, next.y + 1, next.z)
      if (feet.boundingBox !== 'empty' || head.boundingBox !== 'empty') {
        throw new Error(`bridge path obstructed at ${next.x},${next.y},${next.z}`)
      }
      const floor = observedBlock(t, next.x, next.y - 1, next.z)
      // The configured endpoint must already belong to the destination island. Otherwise a
      // misplaced coordinate could make a finished bridge over empty space look like arrival.
      if (n === route.distance && floor.boundingBox !== 'block') {
        throw new Error(`island endpoint ${next.x},${next.y - 1},${next.z} has no solid floor`)
      }
      if (floor.boundingBox !== 'block') {
        if (floor.name !== 'air') throw new Error(`cannot place wool into ${floor.name} at ${next.x},${next.y - 1},${next.z}`)
        if (!woolItems(t).length) throw new Error('ran out of wool before reaching the island')
        if (!await equipWool(t)) throw new Error('cannot equip wool')
        const placed = await t.placeBlockAt({ x: here.x, y: here.y - 1, z: here.z }, { x: route.dx, y: 0, z: route.dz })
        if (!placed || !await waitForSolidFloor(t, next, signal)) {
          throw new Error(`wool placement was not confirmed at ${next.x},${next.y - 1},${next.z}`)
        }
        base.placed++
      }

      if (!await t.look(route.yaw, 0, true)) throw new Error('cannot face bridge direction')
      await moveOnSupportedFloor(bot, { x: next.x + 0.5, y: next.y, z: next.z + 0.5 }, { signal, timeoutMs: stepTimeoutMs, tolerance: 0.17 })
      if (!sameCell(currentCell(t), next)) throw new Error(`bot did not reach bridge step ${n}`)
      requireSafeCell(t, next)
      base.steps++
    }
    if (!sameCell(currentCell(t), end)) throw new Error('bot did not reach the island endpoint')
    base.reached = true
    log.info?.(`[${bot.username}] reached ${target.id} via bridge: ${base.placed} wool, ${base.steps} steps`)
    return { ...base, status: 'OK', destination: end, latencyMs: Date.now() - startedAt }
  } catch (error) {
    log.warn?.(`[${bot?.username}] bridge to ${target.id} stopped after ${base.placed} placed/${base.steps} steps: ${error.message}`)
    return fail(error.message)
  } finally {
    t.setControl('forward', false)
    t.setControl('sneak', false)
    t.clearControls?.()
  }
}
