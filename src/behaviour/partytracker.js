// behaviour/partytracker.js — who is actually IN the party.
//
// WHY THIS EXISTS: connection state and party membership are different things, and conflating
// them is misleading. A bot that has just been kicked out of the party is still connected,
// authenticated and perfectly healthy — so a dashboard coloured purely by connection state
// keeps showing it green after a kick. That reads as "everything is fine" at the exact moment
// the operator needs to see that the party lost a member.
//
// The party plugin never tells us the roster directly. It tells us through events, and each
// event is only meaningful relative to WHO received it:
//
//   "You joined X's party!"              -> I am a member, X leads
//   "The player Y joined the party."     -> I am in a party, and Y just joined MINE
//   "The player Y has left the party."   -> Y left MINE
//   "The player Y has been removed..."   -> Y was kicked from MINE
//   "The party has been disbanded."      -> MINE is gone, so every member of MINE is out
//   "The new party leader is X"          -> X now leads MINE
//
// The broadcast forms carry no party name, so they are only interpretable through the receiver.
// That is why this is a per-bot listener rather than a global one.

import { EV } from '../bus.js'
import { PATTERNS } from '../patterns.js'

const R = (key) => new RegExp(PATTERNS[key].re)
const RE = {
  joined: R('mbpJoined'),
  joinedBroadcast: R('mbpJoinedBroadcast'),
  youLeft: R('mbpYouLeft'),
  leftBroadcast: R('mbpLeftBroadcast'),
  kicked: R('mbpKicked'),
  disbanded: R('mbpDisbanded'),
  transferred: R('mbpTransferred'),
  invited: R('mbpInviteReceived'),
  alreadyIn: R('mbpAlreadyInParty'),
  notInParty: R('mbpNotInParty'),
  ownerLine: R('partyOwnerLine')
}

export class PartyTracker {
  constructor ({ bus, log = console }) {
    this.bus = bus
    this.log = log
    /** username -> { leader: string|null, role: 'leader'|'member'|'none', invitedBy: string|null } */
    this.members = new Map()
    this.#sub(EV.MC_CHAT, (e) => this.#onChat(e))
    // A bot that goes away leaves the party: the reference plugin removes it on quit, and so
    // does any plugin that cleans up after a disconnect.
    //
    // Driven off the FSM rather than the transport events. An INTENTIONAL disconnect emits no
    // transport event at all - the transport suppresses MC_END for a close it started itself -
    // so listening to MC_END alone left every bot still marked as a party member after
    // "Disconnect all". DEAD is reached by every path: kick, drop, and operator disconnect.
    this.#sub(EV.BOT_STATE, (e) => {
      if (e.to === 'DEAD' && e.bot) this.#set(e.bot, { leader: null, role: 'none', invitedBy: null })
    })
  }

// Handlers registered on the bus are NOT garbage collected when this object is dropped, and a
  // rebuilt fleet reuses bot ids ("0:Bot01" again), so a stale handler keyed on botId WILL fire
  // for the new bot while its closure still holds the retired one. Collect the unsubscribers and
  // drop them when the runtime is replaced.
  #subs = []
  #sub (topic, fn) { this.#subs.push(this.bus.on(topic, fn)) }
  dispose () { for (const off of this.#subs) { try { off() } catch {} } this.#subs = []; return this }

  entry (name) { return this.members.get(name) ?? { leader: null, role: 'none', invitedBy: null } }

  #set (name, patch) {
    if (!name) return
    const next = { ...this.entry(name), ...patch }
    const prev = this.members.get(name)
    this.members.set(name, next)
    if (!prev || prev.leader !== next.leader || prev.role !== next.role || prev.invitedBy !== next.invitedBy) {
      this.bus.emit('party:membership', { bot: name, ...next })
    }
  }

  /** Every member of the party led by `leader`, including the leader. */
  rosterOf (leader) {
    const out = []
    for (const [name, m] of this.members) if (m.leader === leader) out.push(name)
    return out
  }

  #onChat (e) {
    const text = e.text
    const me = e.bot
    if (!text || !me) return
    let m

    if ((m = RE.joined.exec(text))) {
      const leader = m.groups.leader
      this.#set(me, { leader, role: 'member', invitedBy: null })
      this.#set(leader, { leader, role: 'leader' })
      return
    }
    if ((m = RE.joinedBroadcast.exec(text))) {
      const mine = this.entry(me).leader
      if (mine) this.#set(m.groups.joiner, { leader: mine, role: 'member', invitedBy: null })
      return
    }
    // The party-status panel of a live BedWars server: "▏ Owner: <name>". It is printed TO the
    // player it describes, so the receiver is in that party and the named owner leads it. Without
    // this rule the tracker could not read that server at all and a bot that demonstrably had a
    // party still showed as 'not in party'.
    if ((m = RE.ownerLine.exec(text))) {
      const owner = m.groups.leader
      this.#set(me, { leader: owner, role: owner === me ? 'leader' : 'member' })
      this.#set(owner, { leader: owner, role: 'leader' })
      return
    }
    if (RE.youLeft.test(text)) { this.#set(me, { leader: null, role: 'none', invitedBy: null }); return }
    if ((m = RE.leftBroadcast.exec(text))) { this.#set(m.groups.leaver, { leader: null, role: 'none', invitedBy: null }); return }
    if ((m = RE.kicked.exec(text))) { this.#set(m.groups.kicked, { leader: null, role: 'none', invitedBy: null }); return }
    if (RE.disbanded.test(text)) {
      const mine = this.entry(me).leader
      // Everyone who pointed at that leader is now out, including the leader itself.
      if (mine) for (const n of this.rosterOf(mine)) this.#set(n, { leader: null, role: 'none', invitedBy: null })
      this.#set(me, { leader: null, role: 'none', invitedBy: null })
      return
    }
    if ((m = RE.transferred.exec(text))) {
      const mine = this.entry(me).leader
      const next = m.groups.leader
      if (mine) for (const n of this.rosterOf(mine)) this.#set(n, { leader: next, role: n === next ? 'leader' : 'member' })
      this.#set(next, { leader: next, role: 'leader' })
      return
    }
    if ((m = RE.invited.exec(text))) { this.#set(me, { invitedBy: m.groups.inviter }); return }
    if ((m = RE.alreadyIn.exec(text))) {
      // Told about a THIRD party, not ours: we know they are in one but not whose. The pattern
      // captures the name positionally (no named group), and m.groups is undefined when a regex
      // has no named groups at all - reading it would throw inside the bus handler.
      const who = (m.groups && (m.groups.player ?? m.groups[1])) ?? m[1]
      if (who) this.#set(who, {})
      return
    }
    if (RE.notInParty.test(text)) { this.#set(me, { leader: null, role: 'none', invitedBy: null }) }
  }

  snapshot () {
    const out = {}
    for (const [name, m] of this.members) out[name] = { leader: m.leader, role: m.role, invitedBy: m.invitedBy }
    return out
  }
}
