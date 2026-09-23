// Discover possible NPC shops from the entities this client has actually loaded, then move to
// one on observed solid ground. A GUI opened by the NPC is the only reliable way to identify
// which shop it is, so discovery returns *all* candidates instead of choosing one by name.

import { stripLegacy } from '../util.js'
import { walkToWaypoint } from './bedwars_navigation.js'

const DEFAULT_SEARCH_DISTANCE = 24
const DEFAULT_INTERACTION_DISTANCE = 3
const DEFAULT_APPROACH_TIMEOUT_MS = 15_000

function textOf (value, depth = 0) {
  if (value == null || depth > 5) return ''
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^[{[]/.test(trimmed)) {
      try { return textOf(JSON.parse(trimmed), depth + 1) } catch {}
    }
    return stripLegacy(value).trim()
  }
  if (Array.isArray(value)) return value.map((part) => textOf(part, depth + 1)).filter(Boolean).join(' ')
  if (typeof value === 'object') {
    return [value.text, value.translate, value.extra, value.with]
      .map((part) => textOf(part, depth + 1)).filter(Boolean).join(' ').trim()
  }
  return ''
}

function normalized (value) { return textOf(value).toLocaleLowerCase().replace(/[\s_-]+/g, '') }

function finitePosition (position) {
  return position && ['x', 'y', 'z'].every((axis) => Number.isFinite(position[axis]))
}

function distance (a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) }

function kindOf (entity) {
  const names = [entity.name, entity.type, entity.entityType].map(normalized)
  if (names.some((name) => name.includes('villager'))) return 'villager'
  if (names.some((name) => name.includes('armorstand'))) return 'armor_stand'
  if (names.some((name) => name === 'player') || entity.username) return 'player'
  return 'named_entity'
}

/**
 * Rank loaded entities that might open a shop. No localized shop text or fixed NPC position is
 * required. A name hint improves order, but never excludes a villager/player/armor stand.
 *
 * Each result also keeps the raw entity identity; the transport rejects it if it despawns or
 * belongs to a previous connection. The caller must inspect the GUI before buying anything.
 */
export function findShopCandidates (bot, {
  maxDistance = DEFAULT_SEARCH_DISTANCE, nameHint = '', entityType = '', excludeIds = []
} = {}) {
  const transport = bot?.transport
  const me = transport?.pos ?? transport?.mc?.entity?.position
  if (!transport?.connected || typeof transport.loadedEntities !== 'function' || !finitePosition(me)) return []
  const radius = Number.isFinite(Number(maxDistance)) && Number(maxDistance) > 0
    ? Number(maxDistance) : DEFAULT_SEARCH_DISTANCE
  const omitted = new Set((excludeIds instanceof Set ? [...excludeIds] : Array.isArray(excludeIds) ? excludeIds : []).map(String))
  const hint = normalized(nameHint)
  const typeHint = normalized(entityType)
  const selfId = transport.mc?.entity?.id
  const candidates = []

  for (const entity of transport.loadedEntities()) {
    if (entity?.id == null || entity.id === selfId || omitted.has(String(entity.id)) || !finitePosition(entity.position)) continue
    const kind = kindOf(entity)
    const customName = textOf(entity.metadata?.[2] ?? entity.customName ?? entity.nameTag)
    if (kind === 'named_entity' && !customName) continue
    const entityKinds = [entity.name, entity.type, entity.entityType].map(normalized)
    if (typeHint && !entityKinds.includes(typeHint) && normalized(kind) !== typeHint) continue
    const away = distance(me, entity.position)
    if (away > radius) continue

    const labels = [customName, textOf(entity.username), textOf(entity.displayName), textOf(entity.name)]
    const label = labels.find(Boolean) ?? kind
    const hinted = !!hint && labels.some((part) => normalized(part).includes(hint))
    // Villagers are interactable shop NPCs on many 1.8 servers. Named player NPCs are next;
    // armor stands often display holograms and are retained as lower-priority candidates.
    const base = { villager: 100, player: 70, armor_stand: 35, named_entity: 20 }[kind]
    const score = base + (customName ? 15 : 0) + (hinted ? 100 : 0)
    candidates.push({
      id: entity.id, kind, label, position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
      distance: away, score, entity, session: transport.entitySession
    })
  }

  return candidates.sort((a, b) => b.score - a.score || a.distance - b.distance || Number(a.id) - Number(b.id))
}

function stopReason (bot, signal) {
  if (signal?.aborted) return 'aborted'
  if (!bot?.transport?.connected) return 'transport disconnected'
  if (!bot?.isReady?.()) return `bot is ${bot?.fsm?.state ?? 'not READY'}`
  return null
}

function safeCell (transport, x, y, z) {
  const floor = transport.blockAt(x, y - 1, z)
  const feet = transport.blockAt(x, y, z)
  const head = transport.blockAt(x, y + 1, z)
  return floor?.boundingBox === 'block' && feet?.boundingBox === 'empty' && head?.boundingBox === 'empty'
}

function destinations (transport, entityPosition, interactionDistance) {
  const me = transport.pos
  const radius = Math.ceil(interactionDistance)
  const cx = Math.floor(entityPosition.x)
  const cz = Math.floor(entityPosition.z)
  const cy = Math.floor(entityPosition.y)
  const options = []
  for (let y = cy - 1; y <= cy + 1; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      for (let z = cz - radius; z <= cz + radius; z++) {
        const center = { x: x + 0.5, y, z: z + 0.5 }
        const horizontal = Math.hypot(center.x - entityPosition.x, center.z - entityPosition.z)
        if (horizontal < 1 || distance(center, entityPosition) > interactionDistance - 0.1) continue
        if (!safeCell(transport, x, y, z)) continue
        options.push({ x, y, z, fromBot: distance(center, me), fromNpc: horizontal })
      }
    }
  }
  return options.sort((a, b) => a.fromBot - b.fromBot || a.fromNpc - b.fromNpc)
}

/**
 * Walk to a safe loaded block within NPC reach. The existing BedWars navigator prohibits digging,
 * bridging, jumping gaps and dropping, and is interrupted on abort or disconnect.
 */
export async function approachShopCandidate (bot, candidate, {
  signal, interactionDistance = DEFAULT_INTERACTION_DISTANCE, timeoutMs = DEFAULT_APPROACH_TIMEOUT_MS
} = {}) {
  const at = Date.now()
  const transport = bot?.transport
  const base = { action: 'approachShopCandidate', bot: bot?.username, botId: bot?.id,
    candidateId: candidate?.id, candidateLabel: candidate?.label }
  const fail = (error) => ({ ...base, status: 'FAILED', error, latencyMs: Date.now() - at })
  const stopped = stopReason(bot, signal)
  if (stopped) return fail(stopped)
  if (!transport?.physics || typeof transport.resolveEntityCandidate !== 'function') return fail('shop NPC approach requires mineflayer transport')
  if (!finitePosition(transport.pos)) return fail('bot position is unknown')
  const reach = Number(interactionDistance)
  if (!Number.isFinite(reach) || reach < 1.5 || reach > 4) return fail('interactionDistance must be between 1.5 and 4 blocks')
  const limit = Number(timeoutMs)
  if (!Number.isFinite(limit) || limit <= 0) return fail('timeoutMs must be positive')
  const deadline = at + limit

  let live = transport.resolveEntityCandidate(candidate)
  if (!live || !finitePosition(live.position)) return fail('shop NPC is no longer loaded')
  if (distance(transport.pos, live.position) > reach) {
    const cells = destinations(transport, live.position, reach)
    if (!cells.length) return fail('no observed safe floor within shop NPC reach')
    let lastError = 'no safe route to shop NPC'
    // Several safe endpoints can exist around an NPC. Try alternatives if a wall blocks one.
    for (const cell of cells) {
      const reason = stopReason(bot, signal)
      if (reason) return fail(reason)
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      const walked = await walkToWaypoint(bot, cell, { signal, timeoutMs: remaining })
      if (walked.status !== 'OK') { lastError = walked.error ?? lastError; continue }
      live = transport.resolveEntityCandidate(candidate)
      if (!live || !finitePosition(live.position)) return fail('shop NPC despawned during approach')
      if (distance(transport.pos, live.position) <= reach) break
      lastError = 'shop NPC moved out of reach'
    }
    if (!live || distance(transport.pos, live.position) > reach) return fail(lastError)
  }

  const reason = stopReason(bot, signal)
  if (reason) return fail(reason)
  live = transport.resolveEntityCandidate(candidate)
  if (!live || distance(transport.pos, live.position) > reach) return fail('shop NPC is no longer in interaction range')
  return { ...base, status: 'OK', entity: live, candidate,
    distance: distance(transport.pos, live.position), latencyMs: Date.now() - at }
}
