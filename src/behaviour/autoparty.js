// behaviour/autoparty.js — fill the party AS the fleet arrives.
//
// The plan-based flow waits for every bot to reach READY, then invites. That is the right shape
// for a fixed roster, but it wastes the join window: with one second between connections the
// first bot is ready seven seconds before the last one.
//
// This behaviour instead reacts to BOT_READY. The first bot to arrive becomes the inviter and
// invites each other bot at the moment it becomes ready, so the party is already filling while
// the rest of the fleet is still connecting.
//
// Two edges it has to handle, both of which decide whether the party actually reaches N:
//   1. If the LEADER is the last to arrive, the earlier bots are already READY and nothing will
//      fire for them again — so the leader sweeps everyone already up when IT becomes ready.
//   2. Invites and accepts must not interleave for one bot. The engine already serialises per
//      bot internally, so a burst of BOT_READY events is safe; we still pace them so the server
//      sees one command at a time and the replies stay attributable.

import { EV } from '../bus.js'
import { STATUS } from '../engine/classify.js'
import { sleep } from '../util.js'

export class AutoPartyBehaviour {
  constructor ({ cfg, bus, engine, log = console }) {
    this.cfg = cfg
    this.bus = bus
    this.engine = engine
    this.log = log
    this.fleet = null
    this.busy = new Set()      // botIds with an invite/accept in flight
    this.done = new Set()      // botIds already brought into the party this session
    this.completed = false     // the fleet reached full party and stood down
    this.invited = new Set()   // botIds bot 1 has already invited; the invite is durable
    this.joining = new Set()   // botIds currently running their own join
    this.#warnedLeader = false
    this.#sub(EV.BOT_READY, (e) => this.#onReady(e))
  }

// Handlers registered on the bus are NOT garbage collected when this object is dropped, and a
  // rebuilt fleet reuses bot ids ("0:Bot01" again), so a stale handler keyed on botId WILL fire
  // for the new bot while its closure still holds the retired one. Collect the unsubscribers and
  // drop them when the runtime is replaced.
  #warnedLeader = false
  #subs = []
  #sub (topic, fn) { this.#subs.push(this.bus.on(topic, fn)) }
  dispose () { for (const off of this.#subs) { try { off() } catch {} } this.#subs = []; return this }

  attach (fleet) {
    this.fleet = fleet
    // A bot becomes eligible when the AREA gate opens, and that happens AFTER BOT_READY: the menu
    // flow runs on BOT_READY and takes a second or two. Sweeping only on BOT_READY meant the sweep
    // ran while every bot was still 'pending' at the gate, found nobody it was allowed to touch,
    // and never ran again — so the party never formed even though every bot did get through.
    // The gate opening is the event that matters, so it is listened to as well.
    this.#sub('menu:state', (e) => { if (e.state === 'done') this.#onReady(e) })
    return this
  }

  /** A predicate that says whether a bot is in the right place to take part. Set by the runtime
   *  from the menu behaviour. Without it the sweep would invite bots that are still standing in
   *  the lobby, and the party would look formed while half of it is somewhere else. */
  setGate (fn) { this.gate = fn; return this }

  /** A member that SEES an invite joins by itself.
   *
   *  This is the difference between a scripted accept and a bot that understands what happened: the
   *  member is not told to join, it reads the invite off the chat and acts on it. It also means the
   *  invite wording has to be recognised, which is what partyInviteToMe is for and why the Learn
   *  button exists on the dashboard.
   *
   *  Only invites from BOT 1 are taken. A stranger's invite is not this flow, and joining one would
   *  put the bot in someone else's party where every later command means something different. */
  autoJoinInvites (patterns) {
    // An invite that arrives BEFORE the bot is through the area gate is not a failure and must not
    // be thrown away: on a server where bot 1 finishes its menu first, it invites members who are
    // still in the selector, and the join comes back BLOCKED. Holding the invite and acting on it
    // when the gate opens is both more correct and what a person does - you read the invite, you
    // finish what you were doing, and then you accept.
    const pendingInvites = new Map()   // botId -> inviter

    const attemptJoin = (bot, inviter) => {
      // A SEPARATE lock from `busy`. `busy` is held by #bring while bot 1's invite is in flight,
      // and reusing it here meant the member's own join was refused by the very invite that
      // prompted it: the gate opened, the held invite was found, and attemptJoin returned without
      // a word because the sweep still had the flag. Two different operations, two locks.
      if (this.joining.has(bot.id) || this.done.has(bot.id)) return
      this.joining.add(bot.id)
      this.log.info?.(`[party] ${bot.username} was invited by ${inviter} - joining by itself`)
      bot.run('accept', { player: inviter })
        .then((r) => {
          if (r.status === STATUS.OK) {
            this.done.add(bot.id)
            pendingInvites.delete(bot.id)
          }
          this.log.info?.(`[party] ${bot.username} /p join ${inviter} -> ${r.status}${r.response ? ' :: ' + r.response : ''}`)
        })
        .catch((err) => this.log.warn?.(`[party] ${bot.username} could not join: ${err.message}`))
        .finally(() => this.busy.delete(bot.id))
    }

    this.#sub(EV.MC_CHAT, (e) => {
      if (this.cfg.fleet?.autoJoinOnInvite === false) return
      const bot = this.fleet.bots.find((b) => b.username === e.bot)
      if (!bot) return
      const leader = this.fleet.leader
      if (leader && bot.id === leader.id) return                 // bot 1 is the inviter, never the invitee
      if (this.done.has(bot.id)) return
      if (!bot.isReady()) return
      const spec = patterns?.partyInviteToMe
      if (!spec) return
      let m
      try { m = new RegExp(spec.re).exec(e.text) } catch { return }
      if (!m) return
      const inviter = m.slice(1).find(Boolean)
      if (!inviter) return
      // Only invites from bot 1: a stranger's invite would put the bot in someone else's party,
      // where every later command means something different.
      if (leader && inviter.toLowerCase() !== leader.username.toLowerCase()) return
      if (this.gate && !this.gate(bot)) {
        pendingInvites.set(bot.id, inviter)
        this.log.info?.(`[party] ${bot.username} invited by ${inviter}, but it is still entering the area - the invite is held`)
        return
      }
      attemptJoin(bot, inviter)
    })

    // The gate opening is the other half: an invite held while the bot was in the selector is
    // acted on the moment it is through.
    this.#sub('menu:state', (e) => {
      if (e.state !== 'done') return
      const bot = this.fleet.bots.find((b) => b.id === e.botId)
      const inviter = pendingInvites.get(e.botId)
      if (!bot || !inviter) return
      attemptJoin(bot, inviter)
    })

    return this
  }

  /** Keep `done` honest: a member that leaves, is kicked, or loses the party is no longer in
   *  it, so it must become eligible for an invite again. Without this a kicked member stays
   *  marked done forever and no later action ever re-invites it. */
  trackMembership (tracker) {
    this.tracker = tracker
    this.#sub('party:membership', (e) => {
      if (e.role === 'none') {
        this.done.delete(this.#idOf(e.bot))
        // A party can come apart and re-form - a server restart, a disband, a kick, a reconnect.
        // The stand-down belongs to a PARTY, not to the fleet's lifetime, so losing a member arms
        // it again. Without this, one stand-down ever happened per dashboard process, and a party
        // rebuilt after a server restart never stood down at all.
        this.invited.delete(this.#idOf(e.bot))
        if (this.completed) {
          this.completed = false
          const b = this.fleet.bots.find((x) => x.username === e.bot)
          if (b) b.offline = false
        }
      }
      if (e.role === 'member' || e.role === 'leader') this.done.add(this.#idOf(e.bot))
      // Membership is the only thing that can complete the party, so it is also the only place
      // the completion check needs to run.
      this.#maybeComplete().catch((err) => this.log.warn?.(`[party] stand-down failed: ${err.message}`))
    })
    return this
  }

  /** Once every bot is in the party, the fleet stands down.
   *
   *  Fires ONCE per connect: /off is a status, and re-sending it on every membership event would
   *  spam the party with the same line. Gated on the CONFIGURED fleet size, not on "every bot I
   *  have", so a fleet smaller than the target does not stand down early just because it is as
   *  full as it can get. */
  async #maybeComplete () {
    if (this.completed) return null
    const f = this.cfg.fleet ?? {}
    if (!f.offlineWhenFull) return null
    const action = f.offlineCommand ?? 'off'
    if (!this.engine.get(action)) return null
    if (!this.tracker) return null

    const inParty = this.fleet.bots.filter((b) => this.tracker.entry(b.username).role !== 'none')
    const need = Number(f.partySize ?? f.size ?? this.fleet.bots.length)
    if (inParty.length < need) return null

    this.completed = true
    this.log.info?.(`[party] the party is full (${inParty.length}/${need}) - every bot standing down with /${action}`)
    this.bus.emit('party:full', { size: inParty.length, action })
    const results = []
    for (const b of this.fleet.bots) {
      if (!b.isReady()) continue
      const r = await b.run(action, {})
      results.push(r)
      // The bot's own claim, set only when the server acknowledged it.
      if (r.status === STATUS.OK) b.offline = true
    }
    const bad = results.filter((r) => r.status !== STATUS.OK)
    if (bad.length) this.log.warn?.(`[party] ${bad.length} bot(s) did not acknowledge the stand-down`)
    return results
  }

  /** Called when the fleet is torn down or rebuilt, so a fresh fleet stands down again. */
  resetCompletion () { this.completed = false; this.invited.clear(); this.joining.clear(); for (const b of this.fleet?.bots ?? []) b.offline = false }

  #idOf (username) {
    const bot = this.fleet?.bots.find((b) => b.username === username)
    return bot ? bot.id : username
  }

  get enabled () { return this.cfg.fleet?.progressiveParty !== false }

  reset () { this.done.clear(); this.busy.clear(); this.invited.clear(); this.joining.clear() }

  /** Which bot should issue the invites right now.
   *
   *  Normally the fleet leader. But the leader is pinned at construction and nothing reassigns
   *  it, so a leader that never authenticates used to mean the party could never form at all -
   *  every other bot bailed out on `!leader.isReady()`, and no dashboard control could repair it
   *  because every one of them resolves the actor back to the same dead leader.
   *
   *  Any ready bot can invite: it simply becomes the leader of the party it creates. That is a
   *  far better outcome than a fleet that cannot assemble because one account failed to log in. */
  #ready (bot) {
    if (!bot?.isReady()) return false
    return this.gate ? this.gate(bot) : true
  }

  /** Who creates the party.
   *
   *  BOT 1, as specified: the first account in the list owns the party and invites the rest. The
   *  fallback to "any ready bot" exists only for the case where bot 1 never authenticates, and it
   *  is OFF by default because it silently changes who owns the party - on a real server that
   *  changes what every later command means. When it does fire it says so out loud. */
  #inviter () {
    const leader = this.fleet.leader
    if (this.#ready(leader)) return leader
    if (this.cfg.fleet?.allowLeaderFallback !== true) {
      if (!this.#warnedLeader) {
        this.#warnedLeader = true
        this.log.warn?.(`[party] waiting for ${leader?.username ?? 'bot 1'} to be ready - it owns the party, `
          + `and no other bot will stand in for it (set fleet.allowLeaderFallback to allow that)`)
      }
      return null
    }
    return this.fleet.bots.find((b) => this.#ready(b)) ?? null
  }

  async #onReady (e) {
    if (!this.enabled || !this.fleet) return
    const bot = this.fleet.bots.find((b) => b.id === e.botId)
    if (!bot) return
    const inviter = this.#inviter()
    if (!inviter) return

    // Whoever ends up inviting must sweep the bots that are already up, because they will not
    // produce another BOT_READY event.
    if (bot === inviter) {
      await sleep(400)
      this.log.info?.(`[party] ${inviter.username} is the party owner (bot 1) - inviting the others`)
      for (const m of this.fleet.bots) {
        if (m !== inviter && this.#ready(m)) await this.#bring(inviter, m)
      }
      return
    }
    await this.#bring(inviter, bot)
  }

  /** Bot 1 invites ONE member. It does not join for them.
   *
   *  The member reads the invite off the chat and joins by itself (autoJoinInvites). Doing the
   *  accept here as well would mean two paths racing to do the same thing, and - more importantly -
   *  it would hide the difference the operator actually wants to see: whether the members
   *  recognised the invite on their own, or whether the fleet pressed the button for them.
   *
   *  `done` is deliberately NOT set here. It is set when the party tracker observes the membership
   *  change, so it reflects what the SERVER believes rather than what we asked for. A member that
   *  was invited but never joined stays out of `done`, and the party does not count as full. */
  async #bring (leader, member) {
    if (member === leader || this.done.has(member.id) || this.invited.has(member.id) || this.busy.has(member.id)) return
    this.busy.add(member.id)
    try {
      this.log.info?.(`[party] ${leader.username} >> invite ${member.username}`)
      const inv = await leader.run('invite', { player: member.username })
      if (inv.status === STATUS.OK) {
        this.invited.add(member.id)
        this.log.info?.(`[party] invite sent to ${member.username} - waiting for it to join on its own`)
      } else if (inv.pattern === 'mbpAlreadyInvited') {
        this.invited.add(member.id)
        this.log.info?.(`[party] ${member.username} is already holding a pending invite`)
      } else if (inv.pattern === 'mbpAlreadyInParty') {
        this.log.info?.(`[party] ${member.username} reports already being in a party`)
      } else {
        this.log.warn?.(`[party] could not invite ${member.username}: ${inv.status} ${inv.response ?? inv.error ?? ''}`)
      }
    } finally {
      this.busy.delete(member.id)
    }
  }
}
