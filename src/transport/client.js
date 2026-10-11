// transport/client.js — the ONLY module that knows minecraft-protocol exists.
//
// Everything above this file talks in terms of: joined / a chat line / a kick / a
// disconnect / sent-a-frame. That boundary is what lets V2 swap in a raw-socket transport with
// backpressure, or add a second protocol family, without touching one line of behaviour code.
//
// What this layer deliberately does NOT do:
//   * movement of any kind. No position, look, flying or entity-action packets are ever sent.
//     V1 needs connect + authenticate + chat + read chat, and nothing here blocks V2 adding
//     movement later: a movement plugin would call the same guarded write().
//   * keep_alive handling. minecraft-protocol's built-in plugin replies automatically
//     (src/client/keepalive.js) and arms its own silence watchdog. Re-implementing it is a
//     downgrade. We only expose checkTimeoutInterval, because that watchdog ends the
//     connection if the server goes quiet for longer than it — set it above the server's real
//     keepalive cadence or a healthy bot is killed by its own client.
//   * compression. set_compression/compress is re-piped automatically.
//
// VERSION IS MANDATORY. minecraft-protocol 1.68.0's defaultVersion is '26.1', so omitting
// `version` silently connects as a modern client and a protocol-47 server rejects the
// handshake. '1.8.9' is absent from the library's supportedVersions (it lists '1.8.8') but
// minecraft-data resolves both to protocol 47 — so never validate the config against
// supportedVersions, or you will reject your own valid config.

import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { EV } from '../bus.js'
import { makeChatFlattener, flattenReason, stripLegacy } from '../util.js'
import { connectViaSocks } from '../proxy/socks.js'

const require = createRequire(import.meta.url)
const mc = require('minecraft-protocol')

export class Transport extends EventEmitter {
  #client = null
  #closedByUs = false


  constructor ({ botId, username, server, proxyFor = null, log, bus }) {
    super()
    this.bus = bus
    this.botId = botId
    this.username = username
    this.server = server
    this.proxyFor = proxyFor
    this.log = log
    this.flatten = makeChatFlattener(server.chatVersion ?? '1.8')
    this.joinedAt = null
    this.protocolState = 'handshaking'
    this.lastError = null
    this.inventorySlots = new Map()
    this.pendingWindowItems = null
  }

  get raw () { return this.#client }
  /** The library's own view of the protocol state. This is the authoritative gate for
   *  whether a write produces a real frame — see send(). */
  get state () { return this.#client?.state ?? 'disconnected' }
  get connected () { return this.state === 'play' }

  /** Resolves once the client is in PLAY and chat() exists. Rejects on any pre-PLAY
   *  disconnect/kick/error — including the login-state duplicate-username disconnect,
   *  which never reaches PLAY at all. */
  connect () {
    const { host, port, version } = this.server
    const route = this.proxyFor?.() ?? { kind: 'direct', mode: 'off', blocked: false, proxy: null }
    if (route.blocked) throw Object.assign(new Error(route.reason), { kind: 'proxy' })
    this.#closedByUs = false
    this.inventorySlots.clear()
    this.pendingWindowItems = null
    this.#client = mc.createClient({
      host,
      port,
      username: this.username,
      version,               // MUST be explicit — see header
      auth: 'offline',       // account list is username:password, so auth is the login plugin's job
      keepAlive: false,
      ...(route.kind === 'proxy'
        ? {
            fakeHost: host,
            connect: (client) => connectViaSocks(client, route, {
              host,
              port,
              timeoutMs: this.server.connectTimeoutMs ?? 30000
            })
          }
        : {}),
      // hideErrors stays false: protodef logs malformed-packet stacks to stdout via
      // console.log and does NOT emit 'error'. Leaving it visible is how a desync is noticed.
      hideErrors: false
    })
    const c = this.#client
    c.on('keep_alive', (packet) => {
      try { c.write('keep_alive', { keepAliveId: packet.keepAliveId }) } catch {}
    })

    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (fn, arg) => { if (!settled) { settled = true; fn(arg) } }

      // ---- settling handlers: they ONLY resolve/reject the connect promise ----
      // Emission lives exclusively in the steady-state block below, so no event is ever
      // published twice. (The first cut emitted in both blocks: a bot kicked before PLAY
      // produced two MC_KICK events, and 'playerJoin' + 'login' both fire on 1.8.9, which
      // double-published MC_JOIN and made the FSM see a phantom AUTH -> PLAY.)
      let joined = false
      const onReady = () => {
        if (joined) return               // 'playerJoin' then 'login': publish MC_JOIN exactly once
        joined = true
        this.joinedAt = Date.now()
        this.bus.emit(EV.MC_JOIN, { botId: this.botId, at: this.joinedAt })
        settle(resolve, this)
      }
      c.once('playerJoin', onReady)      // emitted from onReady() in play.js, where client.chat is assigned
      c.once('login', onReady)           // join_game 0x01 arrives one tick later as a packet event

      c.once('disconnect', (p) => settle(reject, Object.assign(
        new Error(`login disconnect: ${this.flattenReasonOf(p.reason)}`),
        { kind: 'disconnect', text: this.flattenReasonOf(p.reason) })))
      c.once('kick_disconnect', (p) => settle(reject, Object.assign(
        new Error(`kicked: ${this.flattenReasonOf(p.reason)}`),
        { kind: 'kick', text: this.flattenReasonOf(p.reason) })))
      c.once('error', (e) => { this.lastError = e; settle(reject, e) })
      c.once('end', (reason) => settle(reject, Object.assign(
        new Error(`ended before PLAY: ${reason}`), { kind: 'end', text: reason })))

      // ---- steady-state: the single publisher for every transport event ----
      c.on('state', (to) => { this.protocolState = to })
      c.on('chat', (p) => {
        // 1.8 protocol 47 chat is EXACTLY { message: <string>, position: <i8> }. There is no
        // sender field, so packet.sender and playerChat.sender are always undefined and the
        // speaker exists only inside the component. Hence text-based everything.
        const text = this.flatten(p.message)
        if (!text) return
        this.bus.emit(EV.MC_CHAT, {
          bot: this.username,
          botId: this.botId,
          text,
          raw: p.message,
          position: p.position,
          at: Date.now(),
          isOwnEcho: this.#isOwnEcho(text)
        })
      })
      // The server telling us where we are: on spawn, and whenever it rubber-bands us.
      const adopt = (p) => {
        const moved = this.pos ? Math.hypot(p.x - this.pos.x, p.y - this.pos.y, p.z - this.pos.z) : 0
        this.pos = { x: p.x, y: p.y, z: p.z, yaw: p.yaw ?? this.pos?.yaw ?? 0, pitch: p.pitch ?? this.pos?.pitch ?? 0 }
        this.bus.emit(EV.MC_POSITION, { botId: this.botId, bot: this.username, ...this.pos, moved })
      }
      c.on('position', adopt)
      c.on('position_look', adopt)

      // Transaction echo.
      //
      // In 1.8 the server sends a `transaction` to confirm inventory actions and to measure
      // latency, and a vanilla client echoes it straight back. minecraft-protocol does NOT do this
      // for us - only mineflayer does (lib/plugins/inventory.js, confirmTransaction) - so a raw
      // client is silent, and an anti-cheat reads that silence as a non-vanilla client.
      //
      // MEASURED, not guessed: with Kauri running, every one of the seven raw bots was flagged
      // with `BadPackets (N)` about 12 VL per tick (past 1200 within a minute), while a mineflayer
      // bot on the same server, doing the same walk, was never flagged once. Kauri's BadPacketsN
      // tracks exactly keepAlive and transaction round trips.
      c.on('transaction', (p) => {
        try { c.write('transaction', { windowId: p.windowId, action: p.action, accepted: true }) }
        catch { /* a failed echo must never take the bot down */ }
      })

      // ---- window / GUI ----
      // A menu plugin answers a right-click with open_window; everything the bot needs to click
      // correctly (the id, the size, the title) arrives there.
      c.on('open_window', (p) => {
        this.openWindow = { windowId: p.windowId, title: String(p.windowTitle ?? '').replace(/^"|"$/g, '').replace(/\u00a7./g, '').trim(), slotCount: p.slotCount, type: p.inventoryType }
        this.windowAction = 0          // the counter is per-window
        if (this.pendingWindowItems?.windowId === p.windowId) {
          const items = this.pendingWindowItems.items
          for (let offset = 0; offset < 36; offset++) this.inventorySlots.set(offset + 9, items[p.slotCount + offset] ?? null)
          this.pendingWindowItems = null
        }
        this.bus.emit(EV.MC_WINDOW_OPEN, { botId: this.botId, bot: this.username, ...this.openWindow })
      })
      c.on('close_window', (p) => {
        const w = this.openWindow
        this.openWindow = null
        this.bus.emit(EV.MC_WINDOW_CLOSE, { botId: this.botId, bot: this.username, windowId: p.windowId, was: w })
      })
      c.on('window_items', (p) => {
        if (p.windowId === 0) {
          for (let slot = 9; slot <= 44; slot++) this.inventorySlots.set(slot, p.items[slot] ?? null)
        } else if (this.openWindow?.windowId === p.windowId && Number.isInteger(this.openWindow.slotCount)) {
          // A container window appends the 36 player slots after its own slots. Map that
          // region back to the player inventory's 9..44 slots for resource accounting.
          const start = this.openWindow.slotCount
          for (let offset = 0; offset < 36; offset++) this.inventorySlots.set(offset + 9, p.items[start + offset] ?? null)
        } else {
          this.pendingWindowItems = p
        }
        this.bus.emit(EV.MC_WINDOW_ITEMS, { botId: this.botId, bot: this.username, windowId: p.windowId, items: p.items })
      })
      c.on('set_slot', (p) => {
        if (p.windowId === 0 && p.slot >= 9 && p.slot <= 44) this.inventorySlots.set(p.slot, p.item)
        else if (this.openWindow?.windowId === p.windowId && Number.isInteger(this.openWindow.slotCount)) {
          const offset = p.slot - this.openWindow.slotCount
          if (offset >= 0 && offset < 36) this.inventorySlots.set(offset + 9, p.item)
        }
      })
      c.on('disconnect', (p) => {        // login-state 0x00: bad name, dup name, server full
        this.bus.emit(EV.MC_DISCONNECT, { botId: this.botId, bot: this.username, text: this.flattenReasonOf(p.reason), raw: p.reason })
      })
      c.on('kick_disconnect', (p) => {   // play-state 0x40
        this.bus.emit(EV.MC_KICK, { botId: this.botId, bot: this.username, text: this.flattenReasonOf(p.reason), raw: p.reason })
        // minecraft-protocol does NOT close the socket on kick and leaves state === 'play'.
        // Without this end() the bot hangs looking perfectly healthy forever, and a naive
        // "state === play" health check reports it as fine.
        this.end('kicked')
      })
      c.on('error', (e) => { this.lastError = e; this.bus.emit(EV.MC_ERROR, { botId: this.botId, error: e }) })
      c.on('end', (reason) => { if (!this.#closedByUs) this.bus.emit(EV.MC_END, { botId: this.botId, reason }) })
    })
  }

  /** Kick/disconnect reasons on this stack are a JSON STRING LITERAL wrapping a legacy
   *  §-coded sentence: the wire bytes for a wrong password are
   *  00 38 22 c2a7 34 "The same username..." 22  ->  `"§cWrong password!"`.
   *  It is neither {"text":...} nor plain text, so flattenReason handles all three. */
  flattenReasonOf (raw) { return flattenReason(raw, this.flatten) }

  #isOwnEcho (text) {
    return text.startsWith(`<${this.username}>`) || text.startsWith(`* ${this.username} `)
  }

  /** The single write gate. Returns false instead of writing when not in PLAY.
   *
   *  WHY: in handshaking or login state, minecraft-protocol serializes an unmapped packet
   *  name to the single byte 0x00, throws nothing and emits nothing. In login state 0x00 IS
   *  login_start, so the server sees a login_start with a missing username. A silent
   *  corruption, invisible per-bot and catastrophic across a fleet. Verified: the library's
   *  own serializer produces frame '00' for {name:'chat'} in both handshaking and login state.
   */
  send (text) {
    if (this.state !== 'play') {
      this.bus.emit(EV.MC_WARN, { botId: this.botId, text, why: `write refused: protocol state is "${this.state}", not "play"` })
      return false
    }
    if (typeof this.#client.chat !== 'function') {
      this.bus.emit(EV.MC_WARN, { botId: this.botId, text, why: 'write refused: client.chat not installed yet' })
      return false
    }
    this.#client.chat(text)   // -> write('chat',{message}); the identical packet carries '/commands'
    this.bus.emit(EV.MC_SENT, { botId: this.botId, text })
    return true
  }

  /** The write gate for every non-chat frame. Same reason as send(): in handshaking or login
   *  state an unmapped packet name serializes to a single 0x00 byte with no error, and in login
   *  state that byte IS login_start. */
  writePacket (name, params) {
    if (this.state !== 'play') {
      this.bus.emit(EV.MC_WARN, { botId: this.botId, text: name, why: `write refused: protocol state is "${this.state}", not "play"` })
      return false
    }
    try { this.#client.write(name, params) }
    catch (e) { this.bus.emit(EV.MC_WARN, { botId: this.botId, text: name, why: `write failed: ${e.message}` }); return false }
    this.bus.emit(EV.MC_SENT, { botId: this.botId, text: `${name} ${JSON.stringify(params).slice(0, 120)}` })
    return true
  }

  /** Select a hotbar slot. `slot` is 1-indexed the way a player counts it; the wire is 0-indexed. */
  selectHotbar (slot) {
    return this.writePacket('held_item_slot', { slotId: Number(slot) - 1 })
  }

  /** Right-click with whatever is held, aimed at nothing.
   *
   *  Verified against a live 1.8.8 server: a position of (-1,-1,-1) with direction -1 is what the
   *  vanilla client sends when the raytrace misses, and the server treats it as "use the item in
   *  the air". The bot does NOT need to have sent any position or look packet for this to work,
   *  and an empty `slot` field is { blockId: -1 } on the wire — protodef throws on null. */
  useItem () {
    return this.writePacket('block_place', {
      location: { x: -1, y: -1, z: -1 },
      direction: -1,
      heldItem: { blockId: -1 },
      cursorX: 0, cursorY: 0, cursorZ: 0
    })
  }

  /** Click a slot in the open window. mode 0 is a normal click; the action number must increase
   *  within one window or the server drops the click as a desync. */
  clickWindow (slot, button = 'right') {
    if (!this.openWindow) return false
    this.windowAction += 1
    return this.writePacket('window_click', {
      windowId: this.openWindow.windowId,
      slot: Number(slot),
      mouseButton: button === 'right' ? 1 : 0,
      action: this.windowAction,
      mode: 0,
      item: { blockId: -1 }
    })
  }

  /** Player inventory as last reported by the server, normalized to mineflayer item fields. */
  inventoryItems () {
    return [...this.inventorySlots.entries()].flatMap(([slot, item]) => {
      if (!item || Number(item.blockId) < 0 || Number(item.itemCount) <= 0) return []
      return [{ slot, type: Number(item.blockId), count: Number(item.itemCount), metadata: item.itemDamage }]
    })
  }

  /** Raw protocol can send the click; the shop behaviour verifies both inventory deltas. */
  async clickWindowConfirmed (slot, button = 'left') {
    return this.clickWindow(slot, button)
  }

  /** Send our position and look. 1.8 has no teleport-confirm handshake, so this is the whole
   *  client side of movement: one packet per tick, with the on-ground flag the server checks. */
  moveTo (x, y, z, yaw, pitch, onGround = true) {
    return this.writePacket('position_look', { x, y, z, yaw, pitch, onGround })
  }

  closeWindow () {
    if (!this.openWindow) return false
    return this.writePacket('close_window', { windowId: this.openWindow.windowId })
  }

  end (reason = 'clientClosed') {
    this.#closedByUs = true
    if (this.#client) this.#client.__mcbotctlConnectionCancelled = true
    try { this.#client?.end(reason) } catch { /* already gone */ }
  }
}
