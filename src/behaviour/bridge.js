// behaviour/bridge.js — sneak-bridge: walk out over nothing, placing the floor as you go.
//
// THE SHAPE OF IT, as the operator described it: stand at the edge, hold sneak so falling off is
// impossible, move in the chosen direction, place a block into the gap ahead of every step, and
// when the bot can no longer move, let go of sneak - the bridge is finished.
//
// WHY SNEAK IS THE WHOLE TRICK. Sneaking stops a player walking off a ledge, which is what makes
// bridging possible at all: the bot can stand with nothing under the next square without falling,
// place into it, and only then step. The sneak is held for the entire crossing and released at the
// end - which is exactly the operator's spec, and also why releasing it early would be a bug.
//
// ONE BLOCK, THEN THE NEXT. Every iteration is the same four questions, asked about the square one
// step ahead:
//
//     ahead, at feet level   solid?   -> obstacle: go up, turn back, or stop
//     ahead, at head level   solid?   -> obstacle: cannot walk through it
//     ahead, one level down  solid?   -> the floor is already there, just step
//     ahead, one level down  air?     -> place a block, then step
//
// The step itself waits for the bot to ARRIVE rather than sleeping a fixed time: sneak speed is
// 0.0648 blocks/tick, a third of walking, and a bridge that steps early walks off its own work.

import { sleep } from '../util.js'

export const DEFAULT_BRIDGE = {
  blocks: 8,              // how many blocks to lay before stopping
  yaw: 0,                 // 1.8 yaw: 0 faces +z (south), 90 faces -x (west)
  onObstacle: 'stop',     // 'stop' | 'back' | 'up'
  placeDelayMs: 250,      // after placing, give the server time to confirm before stepping
  stepTimeoutMs: 2500,
  maxStuckSteps: 2        // consecutive failed steps before calling it finished
}

/** Unit vector for a 1.8 yaw, in the xz plane. */
export function headingOf (yawDeg) {
  const r = yawDeg * Math.PI / 180
  return { dx: Math.round(-Math.sin(r)), dz: Math.round(Math.cos(r)) }
}

/**
 * @returns {Promise<object>} a result shaped like a command result, so the dashboard and the
 *   reporter read it the same way as everything else.
 */
export async function sneakBridge (bot, cfg = {}, log = console) {
  const spec = { ...DEFAULT_BRIDGE, ...(cfg.bridge ?? {}), ...cfg }
  const t = bot.transport
  const startedAt = Date.now()
  const base = {
    action: 'bridge', bot: bot.username, botId: bot.id, target: null, at: startedAt,
    yaw: spec.yaw, placed: 0, steps: 0, path: []
  }
  const fail = (error) => ({ ...base, status: 'FAILED', error, latencyMs: Date.now() - startedAt })

  if (!t) return fail('bot has no transport')
  if (!t.physics) return fail('bridging needs a physics transport (transport: "mineflayer")')
  if (!bot.isReady()) return fail(`${bot.username} is ${bot.fsm?.state}, not READY`)
  if (!t.connected) return fail('transport not in PLAY')

  let heading = headingOf(spec.yaw)
  const item = await t.equipBlock()
  if (!item) return fail('no placeable block in the inventory')

  log.info?.(`[${bot.username}] bridging up to ${spec.blocks} block(s) at yaw ${spec.yaw}, holding ${item.name}`)

  // Sneak on for the whole crossing. Nothing below the bot can be trusted while bridging.
  t.setControl('sneak', true)
  let stuck = 0
  try {
    while (base.placed < spec.blocks && stuck < spec.maxStuckSteps) {
      if (!t.connected) return fail('connection lost mid-bridge')
      await t.look(spec.yaw * Math.PI / 180, 0, false)

      const p = t.pos
      if (!p) return fail('no position')
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
      const ax = x + heading.dx, az = z + heading.dz

      // ---- obstacle: something solid at the level we would walk into
      if (t.isSolid(ax, y, az) || t.isSolid(ax, y + 1, az)) {
        log.info?.(`[${bot.username}] obstacle ahead at ${ax},${y},${az} - ${spec.onObstacle}`)
        if (spec.onObstacle === 'stop') break
        if (spec.onObstacle === 'back') {
          heading = { dx: -heading.dx, dz: -heading.dz }
          spec.yaw = (spec.yaw + 180 + 360) % 360
          log.info?.(`[${bot.username}] turning back to yaw ${spec.yaw}`)
          continue
        }
        if (spec.onObstacle === 'up') {
          // Step up onto it: jump, and place a block under ourselves so the step is one block.
          const under = { x, y: y - 1, z }
          t.setControl('jump', true)
          await sleep(120)
          t.setControl('jump', false)
          await sleep(280)
          const ok = await t.placeBlockAt(under, { x: heading.dx, y: 0, z: heading.dz })
          if (ok) { base.placed++; base.path.push(`${under.x},${under.y},${under.z}`) }
          await sleep(spec.placeDelayMs)
          continue
        }
      }

      // ---- floor ahead
      const floorOk = t.isSolid(ax, y - 1, az)
      if (!floorOk) {
        // Place into the gap by clicking the side face of the block the bot is standing on,
        // pointing toward the gap. Verified working on 1.8.9 against the live server.
        const under = { x, y: y - 1, z }
        const ok = await t.placeBlockAt(under, { x: heading.dx, y: 0, z: heading.dz })
        if (!ok) {
          log.warn?.(`[${bot.username}] could not place into ${ax},${y - 1},${az}`)
          stuck++
          await sleep(spec.placeDelayMs)
          continue
        }
        base.placed++
        base.path.push(`${ax},${y - 1},${az}`)
        log.info?.(`[${bot.username}] placed ${base.placed}/${spec.blocks} at ${ax},${y - 1},${az}`)
        await sleep(spec.placeDelayMs)
      }

      // ---- step onto it
      const moved = await t.advance(0.9, spec.stepTimeoutMs)
      if (moved < 0.5) {
        // Sneaking into a wall, or out of blocks. Either way this bridge is done.
        log.info?.(`[${bot.username}] could not step forward (moved ${moved.toFixed(2)}) - bridge complete`)
        stuck++
      } else {
        base.steps++
        stuck = 0
      }
    }
  } finally {
    t.setControl('sneak', false)
    t.clearControls?.()
  }

  const moved = base.path.length
    ? (() => {
        const [fx, , fz] = base.path[0].split(',').map(Number)
        const [lx, , lz] = base.path[base.path.length - 1].split(',').map(Number)
        return Math.round(Math.hypot(lx - fx, lz - fz) * 10) / 10
      })()
    : 0
  return {
    ...base,
    status: base.placed > 0 ? 'OK' : 'FAILED',
    response: base.placed > 0
      ? `bridged ${base.placed} block(s) in ${base.steps} step(s)` + (moved ? `, spanning ~${moved} blocks` : '')
      : 'nothing was placed',
    latencyMs: Date.now() - startedAt
  }
}
