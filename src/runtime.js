// runtime.js — wires one fleet together.
//
// Extracted from index.js so the fleet can be REBUILT at runtime: the dashboard lets the
// operator edit the account list, and a changed roster means new Bot objects with new ids.
// Rebuilding in one place keeps index.js and the web console from each growing their own
// half-correct copy of the wiring.
//
// Note on the bus: a rebuilt fleet reuses bot ids, because an id is "index:username" and the
// roster repeats. So a handler left over from the previous runtime does NOT go quiet — it
// matches the NEW bot's id while its closure still holds the retired Bot, and tries to run
// commands on a closed socket. Every behaviour therefore collects its unsubscribers and the
// runtime exposes dispose(), which index.js calls when it swaps the runtime.

import { Fleet } from './fleet.js'
import { AuthBehaviour } from './behaviour/auth.js'
import { PartyBehaviour } from './behaviour/party.js'
import { AutoPartyBehaviour } from './behaviour/autoparty.js'
import { PartyTracker } from './behaviour/partytracker.js'
import { PartyStatusBehaviour } from './behaviour/party_status.js'
import { MasterCommandsBehaviour } from './behaviour/master_commands.js'
import { MenuBehaviour } from './behaviour/menu.js'
import { Movement } from './behaviour/movement.js'
import { BedWarsBehaviour } from './behaviour/bedwars.js'
import { BedWarsPresence } from './behaviour/bedwars_presence.js'
import { CombatBehaviour } from './behaviour/combat.js'
import { StabilityMonitor } from './behaviour/stability_monitor.js'
import { MatchDebugMonitor } from './behaviour/match_debug_monitor.js'
import { AutoplayEngine } from './behaviour/autoplay_engine.js'
import { ActionSupervisor } from './behaviour/action_supervisor.js'

function nameOf (value) { return String(value ?? '').trim().toLowerCase() }

function teamFor (mc, username) {
  const wanted = nameOf(username)
  if (!wanted) return null
  for (const [name, team] of Object.entries(mc?.teamMap ?? {})) {
    if (nameOf(name) === wanted) return team
  }
  return null
}

export function buildRuntime ({ bus, engine, cfg, roster, proxyManager = null, log = console }) {
  proxyManager?.setBotNames(roster.map((account) => account.username))
  const fleet = new Fleet({ cfg, accounts: roster, proxyManager, bus, engine, log })
  const auth = new AuthBehaviour({ cfg, bus, engine, log })
  const party = new PartyBehaviour({ bus, log })
  const tracker = new PartyTracker({ bus, log })
  const partyStatus = new PartyStatusBehaviour({ cfg, bus, engine, tracker, log })
  const bedwarsPresence = new BedWarsPresence({ cfg, bus })
  const supervisor = new ActionSupervisor({ cfg, bus, log })
  const movement = new Movement({ cfg, bus, supervisor, log })
  const menu = new MenuBehaviour({ cfg, bus, presence: bedwarsPresence, supervisor, movement, log })
  menu.setRecoveryHandler((bot, reason) => fleet.recoverBot(bot, reason))
  const bedwars = new BedWarsBehaviour({ cfg, bus, menu, movement, log })
  const autoparty = new AutoPartyBehaviour({ cfg, bus, engine, log })
  const combat = new CombatBehaviour({ cfg, bus, log })
  const autoplay = new AutoplayEngine({ cfg, bus, supervisor, presence: bedwarsPresence, menu, bedwars, movement, combat, log })
  const masterCommands = new MasterCommandsBehaviour({ cfg, bus, tracker, presence: bedwarsPresence, autoplay, log })
  const stability = new StabilityMonitor({ cfg, bus, presence: bedwarsPresence, combat, log })
  const matchDebug = new MatchDebugMonitor({ bus, presence: bedwarsPresence, tracker, log })
  for (const bot of fleet.bots) { auth.attach(bot); party.attach(bot); menu.attach(bot); movement.attach(bot) }
  partyStatus.attach(fleet)
  masterCommands.attach(fleet)
  autoparty.attach(fleet)
  bedwars.attach(fleet)
  bedwarsPresence.attach(fleet)
  supervisor.attach(fleet)
  combat.attach(fleet)
  stability.attach(fleet)
  matchDebug.attach(fleet)
  autoplay.attach(fleet)
  autoparty.trackMembership(tracker)
  // Members read the invite off the chat and join by themselves - they are not told to accept.
  autoparty.autoJoinInvites(cfg.patterns)
  // One gate, two readers: the engine refuses a party command from a bot that is not in the area,
  // and the arrival sweep never invites one. Both go through the same answer so they cannot
  // disagree about who is allowed to act.
  engine.setGate((bot, spec) => (spec.auth || spec.areaExempt ? null : menu.blockReason(bot)))
  autoparty.setGate((bot) => menu.blockReason(bot) === null && partyStatus.blockReason(bot) === null)
  // Combat stays inactive while an opening run owns movement controls. It also waits for
  // positive match evidence by default, so lobby NPCs and players never become targets.
  combat.setGate((bot) => {
    const leaseReason = supervisor.combatBlockReason(bot)
    if (leaseReason) return leaseReason
    if (bedwars.isRunning(bot.id)) return 'BedWars opening is active'
    if (cfg.combat?.requireBedWarsMatch !== false && bedwarsPresence.stateOf(bot.id).stage !== 'match') {
      return 'waiting for BedWars match evidence'
    }
    return true
  })
  combat.setHostileFilter((bot, entity) => {
    const target = nameOf(entity?.username)
    if (!target) return false

    // Party messages provide stronger friendly evidence than proximity. The tracker only
    // returns members it has actually seen, so an unknown player is not silently treated as an ally.
    const mine = tracker.entry(bot.username)
    if (mine.leader && tracker.rosterOf(mine.leader).some((name) => nameOf(name) === target)) return false

    // BedWars servers normally publish a scoreboard team for each player. Matching teams are
    // allies; different teams are enemies. Some servers omit team packets, in which case the
    // match gate still prevents lobby attacks and requireTeamEvidence can opt into stricter mode.
    const mc = bot.transport?.mc
    const mineTeam = teamFor(mc, bot.username)
    const targetTeam = teamFor(mc, entity.username)
    if (mineTeam && targetTeam) {
      return mineTeam !== targetTeam && mineTeam.team !== targetTeam.team
    }
    return cfg.combat?.requireTeamEvidence !== true
  })
  return {
    fleet, auth, party, autoparty, tracker, partyStatus, masterCommands, menu, movement, bedwars, bedwarsPresence, combat, stability, matchDebug, supervisor, autoplay,
    dispose () {
      auth.dispose(); party.dispose(); autoparty.dispose(); masterCommands.dispose(); partyStatus.dispose(); tracker.dispose()
      menu.dispose(); autoplay.dispose(); void supervisor.dispose(); movement.dispose(); bedwars.dispose(); matchDebug.dispose(); stability.dispose(); bedwarsPresence.dispose(); combat.dispose(); autoparty.resetCompletion(); fleet.dispose()
    }
  }
}

/** "host", "host:port", "http://host:port/path" -> {host, port}. Defaults to 25565. */
export function parseAddress (input) {
  const t = String(input ?? '').trim().replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '')
  if (!t) throw new Error('no address given')
  const m = t.match(/^([^:\s]+)(?::(\d{1,5}))?$/)
  if (!m) throw new Error(`cannot parse "${input}"; expected host or host:port`)
  const defaulted = m[2] === undefined
  const port = defaulted ? 25565 : Number(m[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`port out of range: ${m[2]}`)
  // `defaulted` is reported so the caller can say so out loud. A bare host silently becoming
  // 25565 is a real hazard on a box that already runs another Minecraft server on that port:
  // the fleet would connect to the wrong world and every command would look broken.
  return { host: m[1], port, defaulted }
}
