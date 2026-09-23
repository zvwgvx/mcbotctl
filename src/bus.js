// bus.js — the seam between transport, behaviour and reporting.
//
// Why a bus instead of direct calls: in V2/V3 the same chat line must be seen by the auth
// behaviour, the party behaviour, a mining behaviour, an LLM reaction hook and every reporter
// at once, and none of them may import each other. A subscriber that throws must not take the
// fleet down, so every handler runs inside try/catch and a failure is re-emitted on 'bus:error'.

export const EV = Object.freeze({
  // transport -> everyone
  MC_JOIN: 'mc:join',            // reached PLAY; chat() exists; no position packets sent
  MC_CHAT: 'mc:chat',            // one flattened chat line { text, position, raw, at }
  MC_KICK: 'mc:kick',            // play-state 0x40 kick_disconnect  { reason, text }
  MC_DISCONNECT: 'mc:disconnect', // login-state 0x00 disconnect (bad name / server full / dup)
  MC_END: 'mc:end',              // socket gone { reason }
  MC_ERROR: 'mc:error',
  MC_SENT: 'mc:sent',            // a frame actually left the socket { text }
  MC_WARN: 'mc:warn',            // refused write (wrong protocol state) — the silent-0x00 guard
  MC_SCOREBOARD: 'mc:scoreboard', // visible sidebar snapshot { objective, title, lines, visible }
  // window / GUI
  MC_WINDOW_OPEN: 'mc:windowOpen',    // a chest-style window opened { windowId, title, slotCount, type }
  MC_WINDOW_CLOSE: 'mc:windowClose',  // { windowId }
  MC_WINDOW_ITEMS: 'mc:windowItems',  // { windowId, items } — what is in the menu
  // movement
  MC_POSITION: 'mc:position',
  // bot lifecycle
  BOT_STATE: 'bot:state',        // { from, to }
  BOT_READY: 'bot:ready',        // authenticated: safe to run behaviour commands
  // auth behaviour
  AUTH_PROMPT: 'auth:prompt',
  AUTH_OK: 'auth:ok',
  AUTH_FAIL: 'auth:fail',
  // command engine
  CMD_RESULT: 'cmd:result',
  // orchestration
  FLEET_PHASE: 'fleet:phase',
  FLEET_DONE: 'fleet:done',
  BUS_ERROR: 'bus:error'
})

export class Bus {
  #handlers = new Map()
  #seq = 0

  /** @returns {() => void} unsubscribe */
  on (topic, fn) {
    if (!this.#handlers.has(topic)) this.#handlers.set(topic, new Set())
    this.#handlers.get(topic).add(fn)
    return () => this.off(topic, fn)
  }

  once (topic, fn) {
    const off = this.on(topic, (e) => { off(); fn(e) })
    return off
  }

  off (topic, fn) {
    this.#handlers.get(topic)?.delete(fn)
  }

  /** Deliver to exact-topic subscribers, then to '*' subscribers. Handlers are copied
   *  before dispatch so a handler may subscribe/unsubscribe re-entrantly (the engine does). */
  emit (topic, payload = {}) {
    const event = { topic, seq: ++this.#seq, at: Date.now(), ...payload }
    for (const t of [topic, '*']) {
      for (const fn of [...(this.#handlers.get(t) ?? [])]) {
        try { fn(event) } catch (err) {
          if (topic !== EV.BUS_ERROR) { try { this.emit(EV.BUS_ERROR, { topic, error: err }) } catch {} }
        }
      }
    }
    return event
  }
}
