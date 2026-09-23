// behaviour/party.js — party formation as DATA (plan steps), plus invite discovery.
//
// ORDERING IS NOT COSMETIC. AuthMe does not hide players and does not touch the tab list, so a
// party plugin can resolve a not-yet-authenticated bot's name and report the invite as
// delivered while the target is still in limbo and cannot act on it. The plan therefore has a
// hard barrier after auth and before the first party command, and the engine's READY gate
// enforces it per bot even if a step is issued early.

import { EV } from '../bus.js'

/** The V1 plan, as plain data so the dashboard can edit it and V2 can extend it without a
 *  code change. Step types:
 *    {type:'auth'}                          wait for every bot to reach READY
 *    {type:'barrier'}                       wait for all in-flight commands to settle
 *    {type:'command', actor, action, target, pace}
 *         actor: 'leader' | 'members' | 'all' | a username
 *         target:'members' | 'leader' | a username | omitted
 *    {type:'wait', ms} */
export function defaultPartyPlan () {
  return [
    { type: 'auth', phase: 'login' },
    { type: 'barrier' },
    { type: 'command', phase: 'party', actor: 'leader', action: 'invite', target: 'members', paceMs: 250 },
    { type: 'wait', ms: 400 },
    { type: 'command', phase: 'party', actor: 'members', action: 'accept', target: 'leader', paceMs: 250 }
  ]
}

/** Formation with a human party owner.
 *
 *  The master is a real player, not one of our bots, so the bot can invite them but can NOT
 *  press accept on their behalf. The flow therefore invites, waits a fixed window for the
 *  human to accept, and only then hands over leadership. If the human never accepts, both the
 *  promote and the transfer come back FAILED ("not in the same party") — which is the correct
 *  and visible outcome, not a silent success.
 *
 *  @param {string} master account name of the human owner
 *  @param {{acceptWaitMs?:number, promote?:boolean}} opts */
export function masterPartyPlan (master, opts = {}) {
  if (!master) throw new Error('masterPartyPlan needs a master account name')
  const wait = Number(opts.acceptWaitMs) || 6000
  const promote = opts.promote !== false
  const plan = [
    { type: 'auth', phase: 'login' },
    { type: 'barrier' },
    { type: 'command', phase: 'party', actor: 'leader', action: 'invite', target: 'members', paceMs: 250 },
    { type: 'wait', ms: 400 },
    { type: 'command', phase: 'party', actor: 'members', action: 'accept', target: 'leader', paceMs: 250 },
    { type: 'barrier' },
    { type: 'command', phase: 'master', actor: 'leader', action: 'invite', target: master },
    { type: 'wait', ms: wait }
  ]
  if (promote) plan.push({ type: 'command', phase: 'master', actor: 'leader', action: 'promote', target: master })
  plan.push({ type: 'command', phase: 'master', actor: 'leader', action: 'transfer', target: master })
  return plan
}

/** Read the REAL accept/deny syntax off an invite packet instead of trusting operator config.
 *
 *  PAF builds its invite as a clickable component:
 *      ClickEvent(RUN_COMMAND, "/" + PartyCommand.getName() + JOIN_COMMAND_NAME + leaderName)
 *  and Spigot serialises the clickEvent into the chat JSON the bot receives. So the server
 *  itself reveals the command — which is exactly what the operator would otherwise have to
 *  guess when a server renames /party to /p or /team.
 *
 *  @param rawComponent the RAW packet.message JSON string (NOT the flattened text)
 *  @returns {{command:string, kind:'accept'|'deny'|'other'}|null} */
export function discoverInviteCommands (rawComponent, ChatMessageFactory) {
  if (!rawComponent || typeof rawComponent !== 'string') return null
  let comp
  try { comp = ChatMessageFactory('1.8').fromNotch(rawComponent) } catch { return null }
  const found = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    const ce = node.clickEvent
    if (ce && ce.action === 'run_command' && typeof ce.value === 'string' && ce.value.startsWith('/')) {
      const kind = /deny|decline|reject/i.test(ce.value) ? 'deny'
        : /join|accept/i.test(ce.value) ? 'accept' : 'other'
      found.push({ command: ce.value, kind })
    }
    for (const key of ['extra', 'with']) if (Array.isArray(node[key])) node[key].forEach(walk)
  }
  walk(comp)
  return found.length ? found : null
}

/** Attaches to the bus and records party-shaped lines for the dashboard / for V2 auto-accept.
 *  V1 needs no policy here beyond observation; the plan drives the actions. */
export class PartyBehaviour {
  constructor ({ bus, log = console }) {
    this.bus = bus
    this.log = log
    this.invites = new Map()   // botId -> discovered accept/deny commands
  }

// Handlers registered on the bus are NOT garbage collected when this object is dropped, and a
  // rebuilt fleet reuses bot ids ("0:Bot01" again), so a stale handler keyed on botId WILL fire
  // for the new bot while its closure still holds the retired one. Collect the unsubscribers and
  // drop them when the runtime is replaced.
  #subs = []
  #sub (topic, fn) { this.#subs.push(this.bus.on(topic, fn)) }
  dispose () { for (const off of this.#subs) { try { off() } catch {} } this.#subs = []; return this }

  attach (bot) {
    this.#sub(EV.MC_CHAT, (e) => {
      if (e.botId !== bot.id) return
      const P = e.text
      if (!P) return
      // Kept deliberately cheap: the plan does the acting; this only exposes what the server said.
      this.bus.emit('party:line', { botId: bot.id, bot: bot.username, text: e.text, raw: e.raw })
    })
    return bot
  }
}
