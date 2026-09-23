// behaviour/movement.js — a random walk.
//
// The fleet had never sent a position packet: it could join, authenticate, chat and drive menus
// while standing perfectly still at spawn. This makes it wander. It is not pathfinding and does
// not try to be — the requirement is "move around", not "go somewhere".
//
// WHAT THE CLIENT HAS TO DO ON 1.8.9. Protocol 47 predates the 1.9 teleport-confirm handshake, so
// movement is just one `position_look` packet per tick (x, y, z, yaw, pitch, onGround) at 20 Hz.
// There is no acknowledgement to wait for. MEASURED against the live server (test/move-probe.mjs):
// 160 packets over 8 s moved the bot 7.91 blocks as far as the SERVER was concerned, with zero
// corrections and no kick. (Less than the 34 blocks the packets asked for, because a random walk
// re-rolls its heading every directionChangeMs and net displacement is much shorter than the path
// walked — which is the whole point of a wander.)
//
// WHERE THE TRUTH LIVES. The bot's own idea of its position is only what it last told the server.
// The server is free to disagree, and it says so with a `position` packet — that is also how the
// bot learns where it is at all, since it has never asked. So y, and any correction, come from the
// server: the walk takes y from the last position the server sent, and adopts a correction whole.
// That is what keeps the bot from walking into the floor or floating away without any world data.

import { EV } from '../bus.js'
import { sleep } from '../util.js'

export const DEFAULT_MOVEMENT = {
  enabled: false,
  speed: 0.215,             // blocks per tick; a walking player is ~0.215 (4.3 blocks/second)
  directionChangeMs: 900,   // how long a heading is held before it is re-rolled
  tickMs: 50,               // 20 packets per second, matching the server's tick
  pauseDuringCommands: false
}

export class Movement {
  constructor ({ cfg, bus, log = console }) {
    this.cfg = cfg
    this.bus = bus
    this.log = log
    this.loops = new Map()     // botId -> { stop: true } handle
    this.#subs = []
  }

  #subs = []
  #sub (topic, fn) { this.#subs.push(this.bus.on(topic, fn)) }
  dispose () { for (const h of this.loops.values()) h.stop = true; this.loops.clear(); for (const off of this.#subs) { try { off() } catch {} } this.#subs = []; return this }

  get enabled () { return this.cfg.movement?.enabled === true }
  get spec () { return { ...DEFAULT_MOVEMENT, ...(this.cfg.movement ?? {}) } }

  attach (bot) {
    this.#sub(EV.BOT_READY, (e) => { if (e.botId === bot.id) this.start(bot) })
    // Stop on every path out. There is nothing worse than a walk loop still firing packets at a
    // socket that has gone, and a bot that reconnects must get a fresh loop or none at all.
    this.#sub(EV.BOT_STATE, (e) => { if (e.botId === bot.id && e.to === 'DEAD') this.stop(bot) })
    return bot
  }

  attachAll (fleet) {
    for (const b of fleet.bots) this.attach(b)
    return this
  }

  isWalking (botId) { return this.loops.has(botId) }

  start (bot) {
    if (!this.enabled || this.loops.has(bot.id)) return false
    if (this.cfg.bedwars?.enabled === true && (!this.cfg.bedwars.actor || this.cfg.bedwars.actor === bot.username)) return false
    if (!bot.isReady()) return false
    const handle = { stop: false }
    this.loops.set(bot.id, handle)
    this.log.info?.(`[${bot.username}] walking`)
    handle.done = this.#walk(bot, handle).catch((e) => this.log.warn?.(`[${bot.username}] walk loop ended: ${e.message}`))
    return true
  }

  stop (bot) {
    const h = this.loops.get(bot.id)
    if (!h) return false
    h.stop = true
    this.loops.delete(bot.id)
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

  /** Walk using key presses when the transport has a physics engine behind it.
   *
   *  This is the same walk, expressed as intent rather than positions: hold forward and turn, and
   *  let the physics move the bot. Measured at 4.2 blocks/second - a walking player is 4.3 - with
   *  the acceleration ramp intact, which is what an anti-cheat expects to see. The raw transport
   *  has no physics, so it keeps writing positions directly; that path still works and is still
   *  what runs when transport is 'raw'. */
  async #walkWithControls (bot, handle) {
    const s = this.spec
    const t = bot.transport
    await sleep(600)
    if (handle.stop) return
    let yaw = (Math.random() * 360) - 180
    let lastRoll = Date.now()
    let lastProgress = Date.now()
    let anchor = t.pos && { x: t.pos.x, z: t.pos.z }
    let ticks = 0
    try {
      t.setControl('forward', true)
      while (!handle.stop) {
        if (!bot.isReady() || !t.connected) break
        if (Date.now() - lastRoll > s.directionChangeMs) {
          yaw += (Math.random() - 0.5) * 90           // curve rather than jitter
          lastRoll = Date.now()
        }
        const p = t.pos
        if (p && anchor && Math.hypot(p.x - anchor.x, p.z - anchor.z) > 0.3) {
          anchor = { x: p.x, z: p.z }
          lastProgress = Date.now()
        } else if (p && Date.now() - lastProgress > 1200) {
          // A small curved turn can leave a bot pressing into the same wall indefinitely.
          // Make a wide turn after a full second without server-visible progress.
          yaw += (Math.random() < 0.5 ? -1 : 1) * (135 + Math.random() * 90)
          anchor = { x: p.x, z: p.z }
          lastProgress = Date.now()
          lastRoll = Date.now()
        } else if (p && !anchor) {
          anchor = { x: p.x, z: p.z }
        }
        await t.look(yaw * Math.PI / 180, 0, false)
        ticks++
        await sleep(s.tickMs)
      }
    } finally {
      t.clearControls?.()
    }
    this.loops.delete(bot.id)
    if (ticks) this.log.info?.(`[${bot.username}] stopped walking after ${(ticks * s.tickMs / 1000).toFixed(1)}s`)
  }

  async #walk (bot, handle) {
    const s = this.spec
    const t = bot.transport
    if (t.physics) return this.#walkWithControls(bot, handle)
    // Wait for the server to say where we are. It does so on spawn; without it there is no y to
    // walk on and every packet would be a guess the server would immediately undo.
    const waitUntil = Date.now() + 5000
    while (!t.pos && Date.now() < waitUntil && !handle.stop) await sleep(100)
    if (!t.pos) { this.log.warn?.(`[${bot.username}] no position from the server - not walking`); this.loops.delete(bot.id); return }

    let dir = Math.random() * Math.PI * 2
    let lastRoll = Date.now()
    let sent = 0
    while (!handle.stop) {
      if (!bot.isReady() || !t.connected) break
      if (Date.now() - lastRoll > s.directionChangeMs) {
        // Re-roll, but keep some of the old heading so the walk curves instead of jittering.
        dir += (Math.random() - 0.5) * Math.PI
        lastRoll = Date.now()
      }
      const p = t.pos
      const nx = p.x + Math.cos(dir) * s.speed
      const nz = p.z + Math.sin(dir) * s.speed
      // 1.8 yaw: 0 faces +z (south) and increases counter-clockwise, so -cos/sin maps the heading.
      const yaw = (Math.atan2(-Math.cos(dir), Math.sin(dir)) * 180 / Math.PI + 360) % 360
      // y is never invented: it stays whatever the server last said, which is also how a fall or a
      // step is picked up (the server corrects, we adopt, and the next step is from the new y).
      t.moveTo(nx, p.y, nz, yaw, p.pitch, true)
      // Write our belief straight back so the next step continues from it rather than from the
      // server's older value, and a correction arriving mid-walk simply overrides it.
      t.pos = { x: nx, y: p.y, z: nz, yaw, pitch: p.pitch }
      sent++
      await sleep(s.tickMs)
    }
    this.loops.delete(bot.id)
    if (sent) this.log.info?.(`[${bot.username}] stopped walking after ${sent} packets`)
  }
}
