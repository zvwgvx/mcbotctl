# BedWars opening

The bot can run one BedWars opening: walk to its generator, collect 16 iron, find a nearby
shopkeeper, inspect the shop GUI to buy wool, then sneak bridge to a neighboring island. It
uses the Mineflayer transport for movement and block placement. The dashboard shows each
stage. The run stops if the bot disconnects, the shop cannot be identified, the purchase is
not confirmed in inventory, or the bridge route is unsafe.

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
`shop.hotbarSlot`. The opened GUI is still scanned for the wool offer. When `autoStart` is
enabled, the run begins after the server selector completes. A server with a separate waiting
lobby can set `startMessage` to a distinctive chat line sent when the match begins. The
dashboard can also start or stop the configured actor manually.

## Local fixture

The reference plugin provides `/bwtest`, which creates a private iron generator, a decoy
upgrade NPC, a shop NPC, a two-page shop menu and a short gap to another island. `/bwstatus`
reports server-side iron, wool and island arrival. The existing `test/bedwars-flow.mjs` fixture
runner uses only the generator and bridge coordinates returned by `/bwtest`; it does not
configure a shopkeeper location, name, GUI title or wool slot.
