// bot.js — one account. Owns a lifecycle FSM and a transport; owns no protocol detail and no
// policy. Behaviours (auth, party, and V2's movement/mining) attach from outside.
//
// The Bot is intentionally a thin composition:
//     Fsm  <- transport events
//     Bot  -> engine.run() for every outbound line
//     Bus  -> everything else
// Adding movement in V2 means attaching a behaviour that calls bot.send()/a future bot.move().
// Nothing in this file has to change.

import { Fsm, S } from './fsm.js'
import { EV } from './bus.js'
import { Transport } from './transport/client.js'
import { MineflayerTransport } from './transport/mineflayer.js'

export class Bot {
  constructor ({ username, password, index = 0, cfg, bus, engine, log = console }) {
    this.username = username
    this.password = password
    this.index = index
    this.cfg = cfg
    this.bus = bus
    this.engine = engine
    this.log = log
    this.id = `${index}:${username}`
    this.authAttempts = 0
    this.superseded = false
    // Set by stop(): tells the rejoin driver this disconnect was intentional.
    this.stopping = false

    this.fsm = new Fsm(S.DISCONNECTED, (t) => {
      if (!t.applied) {
        this.log.warn?.(`[${username}] illegal state transition ${t.from} -> ${t.to} (ignored)`)
        return
      }
      this.bus.emit(EV.BOT_STATE, { botId: this.id, bot: username, from: t.from, to: t.to })
      if (t.to === S.READY) this.bus.emit(EV.BOT_READY, { botId: this.id, bot: username })
    })

    // Two implementations, one surface. Which one is a config choice, not a code change, so the
    // 63 flow assertions can be run against either.
    this.transport = cfg.transport === 'raw'
      ? new Transport({ botId: this.id, username, server: cfg.server, log, bus })
      : new MineflayerTransport({ botId: this.id, username, server: cfg.server, log, bus })

    // Transport events -> FSM. A kick or a login-state disconnect both mean DEAD; minecraft-
    // protocol won't close the socket on a kick, and our transport does, so this is the only
    // place that decides a bot is no longer usable.
    bus.on(EV.MC_JOIN, (e) => { if (e.botId === this.id) this.fsm.to(S.PLAY) })
    for (const t of [EV.MC_KICK, EV.MC_DISCONNECT, EV.MC_END]) {
      bus.on(t, (e) => { if (e.botId === this.id) this.fsm.to(S.DEAD) })
    }
    bus.on(EV.MC_WARN, (e) => { if (e.botId === this.id) this.log.warn?.(`[${username}] ${e.why} :: ${JSON.stringify(e.text)}`) })
    bus.on(EV.MC_ERROR, (e) => { if (e.botId === this.id) this.log.warn?.(`[${username}] net: ${e.error.message}`) })
  }

  get joinedAt () { return this.transport.joinedAt }
  get protocolState () { return this.transport.state }
  /** True only when the transport can actually put a frame on the wire. */
  sendable () { return this.transport.state === 'play' }
  /** True when the bot may run non-auth commands: the AuthMe gate, not a protocol gate. */
  isReady () { return this.fsm.state === S.READY }

  /** Resolves on PLAY; rejects on any pre-PLAY disconnect/kick/error. Never throws on the
   *  duplicate-username path — that arrives as a login-state disconnect and is reported. */
  async start () {
    // Guard against a second connect on a live socket. The FSM would refuse the transition,
    // but refusal alone does not stop the transport from opening another login — and a second
    // login under the same name makes the server drop the first connection too.
    const st = this.fsm.state
    if (st === S.PLAY || st === S.AUTH || st === S.READY) return this
    this.stopping = false
    this.fsm.to(S.CONNECTING)
    await this.transport.connect()
    return this
  }

  send (text) { return this.transport.send(text) }

  run (action, vars) { return this.engine.run(this, action, vars) }

  stop (reason = 'stop') {
    this.stopping = true
    this.transport.end(reason)
    if (this.fsm.state !== S.DEAD) this.fsm.to(S.DEAD)
  }
}
