// behaviour/menu.js — the area gate.
//
// Some servers do not let you do anything meaningful until you have walked through a menu: pick the
// server-selector item, right-click, click the gamemode. On those servers a bot that skips the menu
// is in the wrong world, and a party built from bots in the wrong world is worse than no party —
// it looks formed and is not.
//
// So the menu is a GATE, not a button. When cfg.menu.enabled and cfg.menu.gateParty are on, a bot
// must complete the flow after authenticating before it will invite or accept anything. The engine
// refuses party commands for a bot that has not (see the gate in engine/engine.js), and the
// arrival sweep skips it, so the party count on the dashboard reflects bots that actually got in.
//
// A failure is not silent: the reason is on the bus, in the log, in the state the dashboard reads,
// and on the bot's card. `retries` exists because an area can be slow to open on a busy server.

import { EV } from '../bus.js'
import { STATUS } from '../engine/classify.js'
import { openMenu } from '../menu.js'
import { sleep } from '../util.js'

export class MenuBehaviour {
  constructor ({ cfg, bus, log = console }) {
    this.cfg = cfg
    this.bus = bus
    this.log = log
    this.#subs = []
    /** botId -> { state: 'pending'|'done'|'failed', result } */
    this.byBot = new Map()
  }

  #subs = []
  #sub (topic, fn) { this.#subs.push(this.bus.on(topic, fn)) }
  dispose () { for (const off of this.#subs) { try { off() } catch {} } this.#subs = []; return this }

  get enabled () { return this.cfg.menu?.enabled !== false }
  get gates () { return this.enabled && this.cfg.menu?.gateParty !== false }

  attach (bot) {
    this.byBot.set(bot.id, { state: this.enabled ? 'pending' : 'done', result: null })
    this.#sub(EV.BOT_READY, (e) => { if (e.botId === bot.id) this.#run(bot) })
    // A reconnect invalidates the area: the server puts you back at spawn, so the menu has to be
    // walked again before the bot can act. Without this a rejoined bot would be treated as still
    // standing in the gamemode it was in before it dropped.
    // ANY disconnect invalidates the area, including one the operator asked for: the server puts
    // the player back at spawn either way. Two traps here, both already documented in
    // partytracker.js for the same reason:
    //   1. Driven off the FSM, NOT the transport events. An intentional disconnect emits no
    //      transport event at all - the transport suppresses MC_END for a close it started itself
    //      - so a listener on MC_END never fires for "Disconnect" on the dashboard, which is
    //      exactly the cycle an operator performs.
    //   2. The reset must not be skipped for a disconnect we caused. That looked like an obvious
    //      optimisation, and it left a bot that was Disconnected and then Joined again being
    //      treated as still standing in the gamemode, so the party formed around bots that had
    //      never walked the menu.
    this.#sub(EV.BOT_STATE, (e) => {
      if (e.botId !== bot.id || e.to !== 'DEAD') return
      const want = this.enabled ? 'pending' : 'done'
      if (this.stateOf(bot.id).state === want) return
      this.byBot.set(bot.id, { state: want, result: null })
      bot.menuDone = false
      this.bus.emit('menu:state', { botId: bot.id, bot: bot.username, state: want })
    })
    return bot
  }

  stateOf (botId) { return this.byBot.get(botId) ?? { state: 'pending', result: null } }

  /** Reason string when this bot must not act yet, or null when it may. Read by the engine gate. */
  blockReason (bot) {
    if (!this.gates) return null
    const st = this.stateOf(bot.id)
    if (st.state === 'done') return null
    if (st.state === 'failed') {
      return `${bot.username} never joined the menu area (${st.result?.error ?? 'the menu flow failed'})`
    }
    return `${bot.username} has not joined the menu area yet`
  }

  async #run (bot) {
    if (!this.enabled) { bot.menuDone = true; return null }
    const attempts = Math.max(1, Number(this.cfg.menu?.retries ?? 1) + 1)
    for (let i = 1; i <= attempts; i++) {
      const r = await openMenu(bot, this.cfg, this.log)
      if (r.status === STATUS.OK) {
        this.byBot.set(bot.id, { state: 'done', result: r })
        bot.menuDone = true
        this.bus.emit('menu:state', { botId: bot.id, bot: bot.username, state: 'done', result: r })
        this.log.info?.(`[${bot.username}] in the area: "${r.opened?.title}" slot ${r.slot} (row ${r.row}, col ${r.col})`)
        return r
      }
      this.log.warn?.(`[${bot.username}] menu attempt ${i}/${attempts} failed: ${r.error}`)
      if (i < attempts) await sleep(1500)
    }
    const last = this.stateOf(bot.id).result
    this.byBot.set(bot.id, { state: 'failed', result: last })
    bot.menuDone = false
    this.bus.emit('menu:state', { botId: bot.id, bot: bot.username, state: 'failed', result: last })
    return last
  }
}
