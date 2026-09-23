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
import { MenuBehaviour } from './behaviour/menu.js'
import { Movement } from './behaviour/movement.js'
import { BedWarsBehaviour } from './behaviour/bedwars.js'

export function buildRuntime ({ bus, engine, cfg, roster, log = console }) {
  const fleet = new Fleet({ cfg, accounts: roster, bus, engine, log })
  const auth = new AuthBehaviour({ cfg, bus, engine, log })
  const party = new PartyBehaviour({ bus, log })
  const tracker = new PartyTracker({ bus, log })
  const menu = new MenuBehaviour({ cfg, bus, log })
  const movement = new Movement({ cfg, bus, log })
  const bedwars = new BedWarsBehaviour({ cfg, bus, menu, movement, log })
  const autoparty = new AutoPartyBehaviour({ cfg, bus, engine, log })
  for (const bot of fleet.bots) { auth.attach(bot); party.attach(bot); menu.attach(bot); movement.attach(bot) }
  autoparty.attach(fleet)
  bedwars.attach(fleet)
  autoparty.trackMembership(tracker)
  // Members read the invite off the chat and join by themselves - they are not told to accept.
  autoparty.autoJoinInvites(cfg.patterns)
  // One gate, two readers: the engine refuses a party command from a bot that is not in the area,
  // and the arrival sweep never invites one. Both go through the same answer so they cannot
  // disagree about who is allowed to act.
  engine.setGate((bot, spec) => (spec.auth ? null : menu.blockReason(bot)))
  autoparty.setGate((bot) => menu.blockReason(bot) === null)
  return {
    fleet, auth, party, autoparty, tracker, menu, movement, bedwars,
    dispose () {
      auth.dispose(); party.dispose(); autoparty.dispose(); tracker.dispose()
      menu.dispose(); movement.dispose(); bedwars.dispose(); autoparty.resetCompletion(); fleet.dispose()
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
