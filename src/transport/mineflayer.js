// transport/mineflayer.js — the same transport surface as client.js, backed by mineflayer.
//
// WHY THIS EXISTS. A raw minecraft-protocol client was measured against a real anti-cheat and
// found silent at exactly the packets that separate a client from a bot: it never answered
// `transaction`, and Kauri flagged every raw bot `BadPackets (N)` about twelve times per tick,
// past VL 1200 in a minute, while a mineflayer bot on the same server was never flagged once.
// mineflayer also brings real physics (measured to match vanilla 1.8 to four decimals, ramp
// included) and block placement, which is what bridging and combat need.
//
// WHAT IT KEEPS. Everything above this file - the engine, the behaviours, the party tracker, the
// area gate, the web console, all 63 flow assertions - talks to a transport through a narrow
// surface, so none of it has to know which implementation it has. The surface is:
//
//   connect() send(text) writePacket(name,params) moveTo(...) setControl(...) look(...)
//   placeBlockAt(...) selectHotbar(n) useItem() clickWindow(slot,button) closeWindow() end()
//   inventoryItems() clickWindowConfirmed(slot,button) activateBlockAt(x,y,z)
//   pos  state  connected  openWindow  username
//
// and the bus events: MC_JOIN MC_CHAT MC_SENT MC_KICK MC_DISCONNECT MC_END MC_ERROR MC_WARN
// MC_WINDOW_OPEN MC_WINDOW_CLOSE MC_WINDOW_ITEMS MC_POSITION
//
// WHAT IT CHANGES. Mineflayer owns physics. Where the raw transport let a behaviour write a
// position directly, this one takes the input instead - setControl and look - and lets the
// physics engine move the bot. That is the point: pressing keys is what a player does, and it is
// what an anti-cheat expects to see.

import mineflayer from 'mineflayer'
import { EventEmitter } from 'node:events'
import { pathfinder } from 'mineflayer-pathfinder'
import { Vec3 as Vec3Class } from 'vec3'
import { EV } from '../bus.js'
import { stripLegacy } from '../util.js'

export class MineflayerTransport extends EventEmitter {
  constructor ({ botId, username, server, log, bus }) {
    super()
    this.botId = botId
    this.username = username
    this.server = server
    this.log = log ?? console
    this.bus = bus
    this.state = 'disconnected'
    this.pos = null
    this.openWindow = null
    this.windowAction = 0
    this.joinedAt = null
    this.lastError = null
    this.stopped = false
    // Tells a behaviour that this transport owns real physics, so movement should be requested
    // as input (setControl/look) rather than written as positions.
    this.physics = true
    this.mc = null
    this.mcData = null
    // Entity IDs are reused after reconnect. A shop candidate belongs to one connection only.
    this.entitySession = 0
  }

  get connected () { return this.state === 'play' }

  /** Mineflayer's version string normalises 1.8.9 to 1.8.8 internally (same protocol 47), so the
   *  declared value and the resolved one differ. Report the resolved one. */
  get protocolState () { return this.state }

  async connect () {
    const { host, port, version } = this.server
    this.entitySession += 1
    this.stopped = false
    this.pos = null
    this.openWindow = null
    const bot = mineflayer.createBot({
      host, port, username: this.username, version: version ?? '1.8.9', auth: 'offline',
      // Keep mineflayer's own logging out of our console; the bus is the channel.
      hideErrors: false
    })
    this.mc = bot
    bot.loadPlugin(pathfinder)

    await new Promise((resolve, reject) => {
      const done = (fn, arg) => { cleanup(); fn(arg) }
      const onSpawn = () => done(resolve)
      const onError = (e) => done(reject, e)
      const onEnd = (r) => done(reject, new Error(`ended before spawn: ${r}`))
      const cleanup = () => {
        bot.removeListener('spawn', onSpawn)
        bot.removeListener('error', onError)
        bot.removeListener('end', onEnd)
      }
      // An error listener has to be attached before anything else can go wrong, or Node throws.
      bot.on('error', (e) => { this.lastError = e; this.bus.emit(EV.MC_ERROR, { botId: this.botId, bot: this.username, error: e }) })
      bot.once('spawn', onSpawn)
      bot.once('error', onError)
      bot.once('end', onEnd)
    })

    this.state = 'play'
    this.joinedAt = Date.now()
    this.#wire(bot)
    this.bus.emit(EV.MC_JOIN, { botId: this.botId, bot: this.username })
    return this
  }

  #wire (bot) {
    // Track position from mineflayer's own entity, which its physics keeps current.
    const onMove = () => {
      const p = bot.entity?.position
      if (!p) return
      this.pos = { x: p.x, y: p.y, z: p.z, yaw: bot.entity.yaw ?? 0, pitch: bot.entity.pitch ?? 0 }
    }
    bot.on('physicsTick', onMove)
    bot.on('move', onMove)

    // Chat. `messagestr` is already flattened by mineflayer; `message` carries the JSON component,
    // which the Learn flow needs for discovering click commands.
    bot.on('messagestr', (text, position, jsonMsg) => {
      if (!text) return
      this.bus.emit(EV.MC_CHAT, {
        botId: this.botId, bot: this.username, text,
        raw: jsonMsg ? JSON.stringify(jsonMsg) : text,
        position: position ?? 1, at: Date.now(), isOwnEcho: false
      })
    })

    // The server's visible sidebar is evidence of which game the player reached. A selector
    // click is only an action; the sidebar arrives after the server has actually moved the bot.
    // Mineflayer maintains the score lines and team display names for us.
    const publishSidebar = (sidebar = bot.scoreboard?.sidebar) => {
      this.bus.emit(EV.MC_SCOREBOARD, {
        botId: this.botId,
        bot: this.username,
        visible: !!sidebar,
        objective: sidebar?.name ?? null,
        title: sidebar ? stripLegacy(sidebar.title ?? '') : '',
        lines: sidebar?.items?.map((item) => stripLegacy(String(item.displayName ?? item.name))) ?? []
      })
    }
    bot.on('scoreboardPosition', (position, scoreboard) => {
      if (position === 1) publishSidebar(scoreboard)
    })
    bot.on('scoreboardTitleChanged', (scoreboard) => {
      if (scoreboard?.name === bot.scoreboard?.sidebar?.name) publishSidebar(scoreboard)
    })
    bot.on('scoreUpdated', (scoreboard) => {
      if (scoreboard?.name === bot.scoreboard?.sidebar?.name) publishSidebar(scoreboard)
    })
    bot.on('scoreRemoved', (scoreboard) => {
      if (scoreboard?.name === bot.scoreboard?.sidebar?.name) publishSidebar(scoreboard)
    })
    bot.on('scoreboardDeleted', (scoreboard) => {
      if (scoreboard?.name === bot.scoreboard?.sidebar?.name) publishSidebar(null)
    })

    // Windows / GUI. mineflayer hands us an object with id, title, slots and type.
    bot.on('windowOpen', (w) => {
      // `slots` is not necessarily populated when windowOpen fires - the contents arrive on a
      // later packet - so an absent length is reported as null ("unknown"), not 0 ("empty").
      // Reporting 0 made a caller's bounds check reject every click into a window that was fine.
      // inventoryStart is the size of the shop area. slots.length also includes the player's
      // 36 inventory slots, so it is not a safe bound for a shop click.
      const n = Number.isInteger(w.inventoryStart) ? w.inventoryStart : null
      // Strip both the JSON quoting AND the legacy colour codes. A live server sent
      // "§r         Server Selector", so an expectTitle of "Server Selector" could never match -
      // the title looked right in the log and compared wrong.
      this.openWindow = { windowId: w.id, title: String(w.title ?? '').replace(/^"|"$/g, '').replace(/\u00a7./g, '').trim(), slotCount: n, type: w.type }
      this.windowAction = 0
      this.bus.emit(EV.MC_WINDOW_OPEN, { botId: this.botId, bot: this.username, ...this.openWindow })
    })
    bot.on('windowClose', (w) => {
      const was = this.openWindow
      this.openWindow = null
      this.bus.emit(EV.MC_WINDOW_CLOSE, { botId: this.botId, bot: this.username, windowId: w?.id ?? was?.windowId, was })
    })
    bot._client.on('window_items', (p) => {
      this.bus.emit(EV.MC_WINDOW_ITEMS, { botId: this.botId, bot: this.username, windowId: p.windowId, items: p.items })
    })

    bot.on('kicked', (reason) => {
      this.state = 'dead'
      this.bus.emit(EV.MC_KICK, { botId: this.botId, bot: this.username, text: typeof reason === 'string' ? reason : JSON.stringify(reason) })
    })
    bot.on('end', (reason) => {
      this.state = 'disconnected'
      if (!this.stopped) this.bus.emit(EV.MC_END, { botId: this.botId, bot: this.username, reason })
    })
  }

  /** Chat is the same packet on 1.8.9 whatever the client library, so the engine's token bucket
   *  still governs the rate. */
  send (text) {
    if (!this.connected) {
      this.bus.emit(EV.MC_WARN, { botId: this.botId, bot: this.username, text, why: `write refused: state is "${this.state}"` })
      return false
    }
    try { this.mc.chat(text) }
    catch (e) { this.bus.emit(EV.MC_WARN, { botId: this.botId, bot: this.username, text, why: `write failed: ${e.message}` }); return false }
    this.bus.emit(EV.MC_SENT, { botId: this.botId, bot: this.username, text })
    return true
  }

  /** Escape hatch for raw packets mineflayer does not expose. Kept because the transport surface
   *  should not become the limit of what the tool can do. */
  writePacket (name, params) {
    if (!this.connected) return false
    try { this.mc._client.write(name, params); this.bus.emit(EV.MC_SENT, { botId: this.botId, bot: this.username, text: `${name} ${JSON.stringify(params).slice(0, 100)}` }); return true }
    catch (e) { this.bus.emit(EV.MC_WARN, { botId: this.botId, bot: this.username, text: name, why: `write failed: ${e.message}` }); return false }
  }

  // ---------------------------------------------------------------- movement
  //
  // Intent, not positions. This is the whole point of using a physics engine: the behaviour says
  // "hold forward and look this way" and the engine produces a movement a player could produce,
  // acceleration ramp and all. Measured against a live server: walk 0.2158 b/t, sprint 0.2804,
  // sneak 0.0648 - vanilla to four decimals.

  setControl (name, on) {
    if (!this.connected) return false
    try { this.mc.setControlState(name, !!on); return true } catch { return false }
  }

  clearControls () {
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']) {
      try { this.mc.setControlState(c, false) } catch {}
    }
  }

  async look (yaw, pitch, force = true) {
    if (!this.connected) return false
    try { await this.mc.look(yaw, pitch, force); return true } catch { return false }
  }

  async lookAtPoint (x, y, z, force = true) {
    if (!this.connected) return false
    try { await this.mc.lookAt(new (await import('vec3')).Vec3(x, y, z), force); return true } catch { return false }
  }

  /** Send position and look explicitly. Only for callers that have already computed a position -
   *  the normal path is setControl(). */
  moveTo (x, y, z, yaw, pitch, onGround = true) {
    return this.writePacket('position_look', { x, y, z, yaw, pitch, onGround })
  }

  /** Place a block against `refVec`'s face. Verified working on 1.8.9 against the live server:
   *  air at the target before, wool after, confirmed by the server's own view of that coordinate. */
  async placeBlockAt (refVec, faceVec) {
    if (!this.connected) return false
    const ref = refVec instanceof Vec3Class ? refVec : new Vec3Class(refVec.x, refVec.y, refVec.z)
    const face = new Vec3Class(faceVec.x, faceVec.y, faceVec.z)
    const refBlock = this.mc.blockAt(ref)
    if (!refBlock) return false
    try { await this.mc.placeBlock(refBlock, face); return true } catch (e) { this.lastError = e; return false }
  }

  /** The world, as mineflayer knows it. A bridging behaviour cannot decide anything without
   *  asking what is under the bot and what is in front of it. */
  blockAt (x, y, z) {
    if (!this.connected) return null
    try {
      const Vec3 = this.#Vec3()
      return this.mc.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))
    } catch { return null }
  }

  isSolid (x, y, z) {
    const b = this.blockAt(x, y, z)
    return !!(b && b.boundingBox === 'block')
  }

  isAir (x, y, z) {
    const b = this.blockAt(x, y, z)
    return !!b && (b.name === 'air' || b.boundingBox === 'empty')
  }

  /** Put a placeable block in hand. Returns the item, or null if the bot has none. */
  async equipBlock () {
    if (!this.connected) return null
    const PLACEABLE = /(wool|planks|log|stone|cobble|dirt|sand|clay|glass|terracotta|concrete|netherrack|obsidian|brick|leaves)/i
    const inv = this.mc.inventory.items()
    for (const pass of ['hand', 'any']) {
      const it = inv.find((i) => PLACEABLE.test(i.name) && (pass === 'any' || i.slot < 45))
      if (it) { try { await this.mc.equip(it, 'hand'); return it } catch { return null } }
    }
    return null
  }

  heldItem () { return this.mc?.heldItem ?? null }

  /** The server-synchronised player inventory. Item.type is the numeric 1.8 item ID. */
  inventoryItems () {
    try { return this.mc?.inventory?.items().map((item) => ({ ...item })) ?? [] } catch { return [] }
  }

  #Vec3 () { return Vec3Class }

  /** Hold a control until the bot has actually moved, or give up.
   *
   *  A fixed sleep is wrong here: the same key press takes a different time depending on whether
   *  the bot is sneaking (0.0648 b/t), walking (0.2158) or accelerating from a standstill, and a
   *  bridge that steps before it has arrived walks off the block it just placed. Returns how far
   *  it actually moved, so the caller can tell "blocked" from "slow". */
  async advance (distance = 1, timeoutMs = 2500) {
    const start = { ...this.pos }
    this.setControl('forward', true)
    const t0 = Date.now()
    let moved = 0
    try {
      while (Date.now() - t0 < timeoutMs) {
        await new Promise((r) => setTimeout(r, 50))
        if (!this.pos || !start.x) break
        moved = Math.hypot(this.pos.x - start.x, this.pos.z - start.z)
        if (moved >= distance) break
        if (!this.connected) break
      }
    } finally { this.setControl('forward', false) }
    return moved
  }

  /** Activate the item in hand (right-click in the air). */
  useItem () {
    if (!this.connected) return false
    try { this.mc.activateItem(); return true } catch { return false }
  }

  /** 1-indexed, the way a player counts hotbar slots. */
  selectHotbar (slot) {
    if (!this.connected) return false
    try { this.mc.setQuickBarSlot(Number(slot) - 1); return true } catch { return false }
  }

  // --------------------------------------------------------------------- GUI

  clickWindow (slot, button = 'right') {
    if (!this.connected || !this.openWindow) return false
    this.windowAction += 1
    try {
      this.mc.clickWindow(Number(slot), button === 'right' ? 1 : 0, 0).catch((e) => {
        this.lastError = e
        this.bus.emit(EV.MC_WARN, { botId: this.botId, bot: this.username, text: 'window_click', why: e.message })
      })
      return true
    } catch { return false }
  }

  /** Await the 1.8 transaction confirmation before deciding whether a shop click landed. */
  async clickWindowConfirmed (slot, button = 'left') {
    if (!this.connected || !this.openWindow) return false
    try {
      await this.mc.clickWindow(Number(slot), button === 'right' ? 1 : 0, 0)
      return true
    } catch (e) { this.lastError = e; return false }
  }

  closeWindow () {
    if (!this.connected || !this.openWindow) return false
    try {
      const window = this.mc.currentWindow
      if (!window || window.id !== this.openWindow.windowId) return false
      Promise.resolve(this.mc.closeWindow(window)).catch((e) => { this.lastError = e })
      return true
    } catch { return false }
  }

  /** Activate an entity - how a shopkeeper NPC is opened. */
  async activateEntity (entity) {
    if (!this.connected || !entity) return false
    const live = this.resolveEntityCandidate(entity)
    if (!live) return false
    try { await this.mc.activateEntity(live); return true } catch (e) { this.lastError = e; return false }
  }

  /** Entity discovery is limited to entities in chunks loaded by this client. */
  loadedEntities () {
    if (!this.connected || !this.mc?.entities) return []
    return Object.values(this.mc.entities)
  }

  /** Resolve a discovery result immediately before interacting; reject despawns and reconnects. */
  resolveEntityCandidate (candidate) {
    if (!this.connected || candidate?.id == null) return null
    if (candidate.session != null && candidate.session !== this.entitySession) return null
    const live = this.mc?.entities?.[candidate.id]
    if (!live || (candidate.entity && candidate.entity !== live)) return null
    // A raw mineflayer entity from findEntityByName is also accepted, if it is still live.
    if (candidate.position && candidate.entity == null && candidate !== live && candidate.session == null) return null
    return live
  }

  /** Open a chest-style shop at a configured block coordinate. */
  async activateBlockAt (x, y, z) {
    if (!this.connected) return false
    const block = this.blockAt(x, y, z)
    if (!block || block.name === 'air') return false
    try { await this.mc.activateBlock(block); return true } catch (e) { this.lastError = e; return false }
  }

  /** Find a nearby entity by name, for the shop-NPC flow. */
  findEntityByName (name, maxDistance = 8, entityType = '') {
    if (!this.connected) return null
    const me = this.mc.entity.position
    let best = null, bestD = Infinity
    for (const e of Object.values(this.mc.entities)) {
      if (entityType && ![e.name, e.type].some((kind) => String(kind ?? '').toLowerCase() === String(entityType).toLowerCase())) continue
      // In 1.8 a named villager still has displayName="Villager". The visible NPC name
      // arrives in metadata index 2, so include that field when finding the shopkeeper.
      const labels = [e.username, e.metadata?.[2], e.displayName, e.name]
      if (!labels.some((label) => stripLegacy(String(label ?? '')).toLowerCase().includes(stripLegacy(name).toLowerCase()))) continue
      const d = e.position.distanceTo(me)
      if (d < bestD && d <= maxDistance) { best = e; bestD = d }
    }
    return best
  }

  end (reason = 'clientClosed') {
    this.stopped = true
    this.clearControls()
    try { this.mc?.quit(reason) } catch { /* already gone */ }
  }
}
