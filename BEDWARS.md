# BedWars opening

The bot can run one BedWars opening: walk to its generator, collect 16 iron, find a nearby
shopkeeper, inspect the shop GUI to buy wool, then sneak bridge to a neighboring island. It
uses the Mineflayer transport for movement and block placement. The dashboard shows each
stage. The run stops if the bot disconnects, the shop cannot be identified, the purchase is
not confirmed in inventory, or the bridge route is unsafe.

The Bots dashboard shows connection, confirmed login, BedWars presence and party membership
separately for each account. BedWars presence comes from the server's visible sidebar or an
optional configured chat message. Clicking the server selector alone leaves the status as
"unconfirmed". A BedWars sidebar confirms the BedWars area; team bed lines upgrade the detail
to "in a match". Set `bedwars.presence.requireMatch` to `true` if the green status should require
match evidence. Servers with different wording can set `presence.titlePattern`,
`presence.teamLinePattern`, `presence.joinMessage`, `presence.matchMessage` and
`presence.leaveMessage` to regular expression sources. The literal `startMessage` also counts
as match evidence when `presence.matchMessage` is empty. A disconnect clears all presence evidence.

## Configure a map

Set `bedwars` in `config/default.json`. The shipped block is disabled because the local party
test server has no permanent BedWars map. Coordinates describe the block at the player's
**feet**; the block at `y - 1` must support the bot. The generator and bridge route still need
map coordinates. The shopkeeper's location, name, menu title and wool slot are discovered at
runtime.

```json
{
  "bedwars": {
    "enabled": true,
    "autoStart": true,
    "actor": "Soprano",
    "startMessage": "",
    "ironRequired": 16,
    "maxIslands": 1,
    "shop": {
      "mode": "auto",
      "maxDistance": 24,
      "interactionDistance": 3,
      "maxMenuDepth": 3
    },
    "geometry": {
      "home": {
        "id": "home",
        "generator": { "x": 100, "y": 65, "z": 100 },
        "bridgeStart": { "x": 100, "y": 65, "z": 104 },
        "neighbors": ["diamond"]
      },
      "islands": [
        {
          "id": "diamond",
          "center": { "x": 100, "y": 65, "z": 121 },
          "bridgeEnd": { "x": 100, "y": 65, "z": 121 }
        }
      ]
    }
  }
}
```

The bot scans loaded nearby entities, approaches likely shopkeepers on supported ground, and
inspects each opened GUI. It searches shop slots for a wool offer and follows a recognizable
Blocks category if the offer is on another page. A nearby upgrade NPC is skipped when its
menu has no wool offer. It accepts a purchase only after the player's inventory shows **more
wool and less iron**. `shop.entityName` can bias candidate ordering, and `shop.expectTitle`
can narrow a known menu; neither is needed in `auto` mode. `shop.woolSlot` is an optional
zero-based GUI slot hint for unusual server menus. NPC scanning is limited to loaded entities
within `shop.maxDistance`, and category navigation is bounded by `shop.maxMenuDepth`.

The bot chooses the nearest unvisited island with a configured straight route. The bridge
must stay on one X or Z axis and one Y level. For several destinations, set `maxIslands` above
1 and give each source island a `bridgeStart`, or use `routes` under that island:

```json
"routes": {
  "next_island": {
    "start": { "x": 100, "y": 65, "z": 121 },
    "end": { "x": 100, "y": 65, "z": 135 }
  }
}
```

The optional explicit shop modes `entity`, `block` and `hotbar` support servers with an unusual
shop entrance. `block` requires `shop.block` coordinates; `hotbar` requires a 1–9
`shop.hotbarSlot`. The opened GUI is still scanned for the wool offer. When `bedwars.autoStart` is
enabled, the run begins after the server selector completes. A server with a separate waiting
lobby can set `startMessage` to a distinctive chat line sent when the match begins. The
dashboard can also start or stop the configured actor manually.

## Continuous movement profile

The deployed profile keeps `movement.enabled` on and disables both `autoplay` and the legacy
BedWars opening sequence. A bot starts its native Mineflayer input loop after `READY`, resumes
when the selector confirms the BedWars lobby, and stays active when the sidebar changes to a
match. It only sends normal view and forward controls. Before moving it requires loaded collision
support ahead. Flat floor remains the normal route; a native stair or slab transition up to
`movement.maxStepHeight` (0.6 by default) is crossed with Mineflayer sneak edge protection. An
edge, unloaded chunk, fall, or high native velocity releases forward until physics settles, then
the loop re-enters automatically. This avoids a bot being parked at a generator while preserving
the server's own movement and keep-alive protocol handling.

The deployed stability profile also keeps `movement.sneakGuard` on while roaming. It is a normal
Mineflayer control input that limits walking over an edge; it does not write a synthetic position,
velocity, or keep-alive packet.

If a server presents decorative collision geometry that cannot prove a normal route, the loop
tries a different direction with native sneak held for at most `movement.cautiousProbeMs` (250 ms
by default). Mineflayer's edge guard and the next physics observation decide whether it can move;
the loop never sends a calculated position or velocity to force its way through an unknown cell.

## Optional autoplay engine

`autoplay` is an optional per-bot match engine. It is disabled in the deployed continuous-movement
profile. If enabled later, it arms on a master party-chat command or automatically
when `autoplay.autoStart` is enabled. An armed bot does not move in the lobby: it waits for
`BedWarsPresence` to confirm `stage: "match"` from the BedWars sidebar, waits a short debounce,
then starts its match loop. A configured generator is reached through the floor-checked route;
an unknown map starts with a continuous safe exploration session before the generator → iron → dynamic
shop/menu → configured sneak-bridge loop. An expedited start shortens that debounce only after
the same match confirmation; it cannot run gameplay in a lobby.

When `bedwars.geometry.home.generator` is absent, autoplay first observes either repeated nearby
`iron_ingot` drops with distinct entity ids or repeated, time-separated inventory gains at the
same cell. A single player-thrown stack is not generator evidence. It performs that observation
while moving through continuous random exploration, using Mineflayer `look` and `forward`
input only. Ordinary safe directional changes hold one action lease and briefly release only the
forward key for one native physics tick; they do not clear all controls or wait through an action
cooldown. Every route checks loaded solid floor and empty feet/head space ahead; an unloaded edge,
a lack of progress, an airborne body, or unsettled horizontal velocity releases controls and
replans.
It then routes only to the observed generator cell through loaded, solid floor and confirms
collection before it reports `collecting iron`. Continuous mode remains active for the confirmed
match unless it finds generator evidence, loses a safe floor, is cancelled, or the match ends.
Set `bedwars.roam.continuous` to `false` to retain the diagnostic
`bedwars.roam.maxSegments` cap.

`bedwars.roam` controls the exploration limits. The defaults use 650–1400 ms segments of
2–4 blocks and a 50 ms native-physics check. With the default `continuous: true` and
`maxSessionMs: false`, one supervised lease remains active through the confirmed match.
Set a positive `maxSessionMs` to roll that lease over periodically, or set `continuous: false`
to apply the 64-segment diagnostic cap. `directionWaitMs` bounds a safe wait for loaded chunks.
`maxTurnRadians` favors a gradual random curve through safe headings; an abrupt fallback is used
only when the loaded floor leaves no gradual route. If the combat behaviour observes an approved
enemy in reach, roam releases its lease first and leaves a short `autoplay.combatWindowMs` window
for normal Mineflayer combat input before it considers movement again.
Mineflayer replies to protocol keep-alives itself and its native physics produces normal movement
packets; autoplay does not fabricate `keep_alive` or position packets. `maxHorizontalSpeed`
and `settleSpeed` use Mineflayer's observed blocks-per-tick values. If an external knockback or
server correction leaves a bot unsupported, controls remain released while native physics gets up
to `fallRecoveryTimeoutMs` to land or respawn before the next plan. The dashboard exposes the
current heading, observed velocity, and the most recent safety release under `Motion` for each
bot. These values are observations only; the engine never derives or sends a position correction.
If the nearby chunks have not arrived yet, `Motion` reports `awaiting supported direction` and
retries from the same stationary position instead of guessing a route or failing the run.
`bedwars.generatorDiscovery.pickupMinIntervalMs` and `evidenceWindowMs` define the pickup cadence
used for the second kind of confirmation.

The master account configured in `fleet.master` can issue these party-chat commands:

```text
=play                 # arm every bot; start ones already in a confirmed match
=play <botName>       # arm one exact fleet account name
=play stop            # stop and disarm every bot
=play stop <botName>  # stop and disarm one bot
```

Every autoplay and selector task obtains an ActionSupervisor lease before it changes movement,
pathfinding, view, inventory, GUI or placement. Combat reads the same lease and waits while a
task owns the bot. A manual bridge or the legacy opening sequence preempts autoplay and waits for
its cancellation cleanup. The dashboard displays the autoplay phase, task, blocked reason and
current action owner for each bot.

Autoplay scans NPCs and their menus dynamically. It deliberately fails closed when a map lacks a
configured bridge route; safe local exploration can continue while it identifies the generator,
but it reports `blocked` before it attempts to bridge toward unseen terrain. Configure
`bedwars.geometry` for each active map before expecting it to cross to an island.

## Local fixture

The reference plugin provides `/bwtest`, which creates a private iron generator, a decoy
upgrade NPC, a shop NPC, a two-page shop menu and a short gap to another island. `/bwstatus`
reports server-side iron, wool and island arrival. The existing `test/bedwars-flow.mjs` fixture
runner uses only the generator and bridge coordinates returned by `/bwtest`; it does not
configure a shopkeeper location, name, GUI title or wool slot.
