# Debug report — 2026-09-22/23

Everything below was found by running the real thing: a live PaperSpigot 1.8.8 server with AuthMe
5.6.0, seven real bot connections, and two test suites. Nothing here is inferred from reading code
alone. Numbers are measured, and the command that produced each one is given.

## How to reproduce

```bash
cd /home/zvwgvx/mcbotctl
nvm use 22
docker compose up -d                      # the test server, port 25566
node src/index.js --serve --port 4599     # the dashboard
node test/verify.mjs                      # 27 unit assertions, no server needed
node test/flows.mjs                       # 32 end-to-end flow assertions (server + dashboard)
node test/spam-probe.mjs 2 1 0.5          # measures the server's chat-spam budget
node test/master-bot.mjs                  # stands in for the human party master
```

## The bug you reported: a kicked member still showed green

Connection state and party membership are different things. A bot kicked out of the party is still
connected, authenticated and healthy, so a card coloured only by connection stays green — which is
exactly the reading that hides a lost member.

Fixed by tracking membership separately (`src/behaviour/partytracker.js`) and showing it as its own
badge next to the connection dot: `party leader` / `in party` / `not in party`.

The tracker infers membership from the plugin's chat lines, and each line only means something
relative to **who received it** — "The player X joined the party." carries no party name, so it can
only be read as "X joined MINE".

Verified end to end: with the master owning the party, the master typed `/p kick Tenor` in game and
the API was not called at all afterwards. Tenor went from `member` to `not in party` on its own.

```
before   Soprano=member Mezzo=member Alto=member Tenor=member Baritone=member Bass=member Countertenor=member
master   >> (in game) /p kick Tenor
         << [Party] The player Tenor has been removed from the party.
after    Soprano=member Mezzo=member Alto=member Tenor=none   Baritone=member Bass=member Countertenor=member
```


There was a second half to this bug: membership could also change **without any HTTP request** —
the human master kicks someone in game, or a member types `/p leave`. The dashboard only ever
re-read state after an API call, so those changes never reached the browser. The server now pushes
state on every membership change, throttled.

## The most important finding: the server kicks bots for chat spam

The tool must pace its own commands, and the pace is not a rate limit.

`test/spam-probe.mjs` holds one bot and sends `/p list` at a fixed rate for 12 seconds:

| rate | commands sent before the kick |
|------|-------------------------------|
| 20/s | 10 |
| 10/s | 10 |
| 5/s  | 12 |
| 3/s  | 14 |
| 2/s  | 18 |
| 1/s  | **survived** |
| 0.5/s| **survived** |

Those numbers fit one model exactly: **+1 per command, −1 per second, kicked above ~10**. So a
burst of ten is fine and a steady 2/s is fatal — a fixed "one command per N ms" gap gets this wrong
in both directions. The engine now uses a token bucket (8 tokens, refilling 1/s), which allows a
burst and then throttles.

`disconnect.spam` was observed repeatedly on the leader before this fix, always while the operator
was pressing buttons quickly.

### Validation of the pacing fix

Simulating the measured server model (+1 per command, −1 per second, kick above ~10) against the
pacing the engine actually applies:

| scenario | before | after (token bucket) |
|---|---|---|
| burst of 12 back to back | peak 12 → **KICK** | peak 8 → ok |
| 12 commands, 250 ms apart | peak 9.3 → ok | peak 6.3 → ok |
| 30 commands, 200 ms apart | peak 24.2 → **KICK** | peak 6.6 → ok |
| 20 commands, 100 ms apart | peak 18.1 → **KICK** | peak 7.3 → ok |
| 7 bots, 2 commands each | peak 1.7 → ok | peak 1.7 → ok |

Three of five scenarios that an operator can reach by clicking would have been kicked before.

## Every fix in this round

### Correctness
1. **`accept` template silently reverted to `/p join`** — the plugin has no `join` subcommand, so
   every accept failed. Caused by the dashboard rendering command fields once and then writing
   *every* field back on Save, including stale ones.
2. **`transfer` template silently reverted to `/p promote`** — transfer ran promote instead, so
   leadership was never handed over. Same cause.
3. **Save now sends only the fields the operator actually changed.** A tab holding stale values can
   no longer clobber a field it did not touch.
4. **`#saveConfig` wrote the whole in-memory config over the file.** It now writes only the keys
   the caller changed, is serialised through a queue, and lands via `rename` so the file is never
   observed half-written.
5. **Operator-defined patterns never reached the classifier.** The documented way to teach the tool
   a server's own wording was inert: a pattern key that is not in the built-in registry fell
   through to `new RegExp("myPatternKey")` — a literal-string regex that can never match. Patterns
   posted to `/api/config` are now published into the registry the engine reads.
6. **`noInvite` was read as `notInParty`.** Both lines start "You are not in a party", but one means
   "you have left" and the other means "you have no pending invite". A member who ran `/p deny`
   was marked as having left the party. The patterns are now separate.
7. **The plugin sent a raw UUID as the leader's name** when the inviter had logged out, so the bot
   could not match the "You joined X's party!" line. It now resolves the offline player's name.
8. **`/api/learn` bypassed the engine** — no READY gate, no rate limit, no per-bot serialisation,
   so a Learn click could interleave with a command's reply window and each would capture the
   other's answer. It now runs on the same chain and obeys the same gates.
9. **Learn saved a regex without the template**, and `applyCommands` skips any spec without a
   template — so saving a learned regex for a command not already in the config did nothing while
   reporting success.
10. **`bringOnline()` was not idempotent** — a second Run reconnected already-connected bots, and a
    second login under one name makes the server drop BOTH connections. Pressing Join then Run
    killed the whole fleet.
11. **The FSM refused `DEAD → CONNECTING`**, so a kicked bot could never rejoin.
12. **The auth behaviour never reset per-connection state**, so a rejoined bot sat in PLAY forever
    without re-authenticating.
13. **The party tracker cleared nothing on an intentional disconnect** — the transport suppresses
    its own end event, so "Disconnect all" left every bot marked as a party member.
14. **`flattenChat` ignored `translate` components** — the bot was deaf to `/me`, join/leave and
    many plugin messages, because vanilla sends them as a translation key rather than text.
15. **An optional disconnect had no `bot` field**, so the log showed `undefined`.
16. **`__proto__` as a command name** replaced the prototype of `cfg.commands`; a later merge then
    materialised an inherited spec as a live command. Dangerous keys are now refused.
17. **A non-string template silently deleted a command** at the next start. Now rejected at the door.

### Robustness
18. **Rebuilt fleets leaked ~10 bus handlers each**, and because a rebuild reuses bot ids
    (`0:Bot01` again) a stale handler matched the NEW bot while holding the retired one. Every
    behaviour now collects its unsubscribers and the runtime exposes `dispose()`.
19. `/api/connect` claimed its "running" flag after an await, so two requests could both pass.
20. Missing command arguments are rejected instead of sending `/p inv undefined`.
21. A bare host with no port now says so — it silently became 25565, which on this machine is a
    different, production server.
22. The master name is trimmed both in memory and on disk.
23. `Leave (all)` and `Warp (all)` reported unconditional success without looking at any result.
24. The Disconnect button on the Accounts tab reported into a panel hidden on that tab.
25. A no-op Save never cleared the "edited" flag, so the Commands tab silently stopped tracking
    the server.
26. Back/Forward changed the URL without changing the tab.
27. A server-sent failure event was indistinguishable from a dead SSE stream, because both use the
    name `error`. Server failures are now `runerror`.
28. The command inputs were rebuilt on every state push, discarding the caret mid-edit.
29. Buttons stayed live during a multi-second run.

## Correction: the review's last pass found three bugs I had introduced

The verification workflow finished after I first wrote this report, and its findings include
regressions from my own last round of fixes. They are recorded here rather than quietly patched,
because two of them were **invisible to the test suite as it stood** — which is the more useful
lesson.

**`POST /api/connect` answered HTTP 500 on every single call.** I declared `let addr` inside an
`if` block and then read `addr.defaulted` from outside it to build the response note. That is a
ReferenceError, so every connect answered `500 {"error":"addr is not defined"}`.

The suite did not catch it, and the reason matters: the address is applied **before** the response
is built, so the fleet connected perfectly while the endpoint reported failure. `test/flows.mjs`
only checked the *outcome*, never the *response*. It now asserts on the status code, and on the
recovery path after a refused request.

**The run flag was claimed before validation and never released on early exits.** `this.running`
went true before the body was read; the invalid-JSON path cleared it but the bad-address path and
the outer 500 handler did not. A single click with an empty address field then answered 409 to
every later connect **and** every run, permanently, with only a process restart to recover. Also
reachable straight from the UI, which sends the field without a client-side check.

**A host with no port was silently persisted as 25565.** `parseAddress` defaults a bare host to
25565 and reports that it did — but the write path ignored the flag, so the guess went into
`config/default.json`. `loadConfig` **refuses** port 25565 on this machine (an unrelated production
server owns it), so the tool would then fail to start at all. The connect handler now refuses a
portless address and asks for `host:port`.

## Correction: a fix of mine that was being undone at load time

The `patterns` block in `config/default.json` duplicated all 54 shipped patterns, and had drifted
from `src/patterns.js`. `loadConfig` merges the file **over** the registry, so the file's stale copy
won. The stale `mbpNotInParty` was the unanchored `You are not in a party` — the exact regex behind
the `noInvite` defect — so **the fix I made for it was silently reverted every time the config
loaded**, and the bug was still live.

Worse: the fix that finally published operator patterns into the registry made the file's entries
authoritative too, so wiring the feature up would have made this worse, not better.

The duplicated block is now removed and the registry in `src/patterns.js` is the single source of
truth, with the override mechanism left in place for genuinely server-specific wording. Verified:
with the config as it now stands, `mbpNotInParty` matches `You are not in a party.` and NOT
`You are not in a party and have no pending invite.`

## New: driving a chest-menu GUI

The bot can now do the thing that is not chat: select a hotbar slot, right-click to open a
chest-style menu, and click a slot inside it with a real mouse click.

The packets were measured, not guessed (`test/gui-probe.mjs`, against `plugin/.../MenuSim.java`):

| step | packet | value |
|---|---|---|
| select the 5th hotbar slot | `held_item_slot` | `{slotId: 4}` — 1-indexed in, 0-indexed on the wire |
| right-click | `block_place` | `{location:(-1,-1,-1), direction:-1, heldItem:{blockId:-1}}` |
| the server answers | `open_window` | `{windowId, inventoryType:"minecraft:container", windowTitle, slotCount}` |
| click row 4, col 4 | `window_click` | `{windowId, slot:30, mouseButton:1, action:n, mode:0, item:{blockId:-1}}` |

Three things that are easy to get wrong and are now on the record:

- **`heldItem` cannot be `null`.** The `slot` type reads `.blockId` off whatever it is given, so an
  empty slot has to be `{blockId: -1}`. Passing `null` throws inside the serializer.
- **The bot needs no position or look packet to right-click.** A location of `(-1,-1,-1)` with
  direction `-1` is what the vanilla client sends when the raytrace misses, and the server treats
  it as "use the held item in the air". The whole fleet has never sent a position packet.
- **`action` must increase per click** inside one window, and resets when a new window opens.
  The server drops a click whose counter goes backwards as a desync.

Coordinates are 1-indexed the way a player counts them off the grid; the raw slot is
`(row-1)*9 + (col-1)`, so row 4 col 4 is slot 30. The resolved slot is reported in every result,
because that off-by-one is the easiest mistake here.

The result distinguishes three outcomes rather than collapsing them: **FAILED** when no menu
opened (wrong hotbar slot, no item, not authenticated), **OK with the window still open** when the
click was delivered but the menu did not react, and **OK with the window closed** when the menu
accepted the choice. A click into the wrong slot and a click into the right one are therefore
distinguishable from the dashboard, which a single "clicked" flag would hide.

`POST /api/config` silently ignored the `menu` block at first, so every setting the dashboard sent
was dropped and the flow kept using the shipped default — the button worked, the numbers did
nothing, and nothing said so. Caught by testing the failure paths rather than only the happy one.

### The menu is a gate, not a button

On a server that puts you through a menu first, a bot that skipped it is standing in the wrong
world — and a party built from bots in the wrong world looks formed and is not. So the menu flow
runs automatically after authentication, and until it succeeds the bot is not allowed to invite or
accept anything.

Two readers share one answer, so they cannot disagree about who may act:

- the **engine** refuses a party command from a bot that has not got through, as `BLOCKED` with the
  reason attached (a wrong-world bot is skipped, not silently included)
- the **arrival sweep** never invites one

The gateway is visible everywhere it matters: on the bot's card as an `in area` / `entering…` /
`not in area` badge, in the log, and in the state the dashboard reads. Turning it off is one
setting (`menu.enabled`), for a server that has no such menu.

A reconnect invalidates the area — the server puts you back at spawn — so the menu has to be walked
again before the bot may act. Without that a rejoined bot would be treated as still standing in the
gamemode it was in before it dropped.

**Two bugs this exposed, both found by the tests written for it:**

1. The sweep only ran on `BOT_READY`, and the menu runs *after* `BOT_READY`. So the sweep ran while
   every bot was still `pending` at the gate, found nobody it was allowed to touch, and never ran
   again. Every bot got through the menu and the party never formed — a gate that opens onto
   nothing. The sweep now also listens for the gate opening, which is the event that actually
   matters.

2. **The area was not invalidated by a disconnect at all, when the operator asked for it.** Skipping that reset looked
   like an obvious optimisation, because we are already tearing the socket down — but the server
   puts the player back at spawn either way. So a bot that was `Disconnect`ed and then `Join`ed
   again was still treated as standing in the gamemode, and the party formed around bots that had
   never walked the menu. The test that caught it: point the menu at a hotbar slot with no item,
   reconnect, and assert that no party forms. It did.

   The first fix for that was still wrong, and wrong in a way this codebase has already been bitten
   by once: it listened for the transport's end event. **An intentional disconnect emits no
   transport event at all** — the transport suppresses `MC_END` for a close it started itself — so
   the listener never fired for the one case that mattered, a Disconnect button followed by Join.
   It now drives off the FSM's `DEAD`, which every path reaches, exactly as `partytracker.js`
   already does for the same reason. The comment there explaining this was three files away and I
   had written it.

## New: the bots walk

Until now the fleet had never sent a position packet — it could join, authenticate, chat and drive
menus while standing perfectly still. A random walk was added on request: pick a heading, hold it
for a moment, re-roll, wander.

**1.8.9 makes this simple.** Protocol 47 predates the 1.9 teleport-confirm handshake, so movement is
one `position_look` packet per tick — x, y, z, yaw, pitch, `onGround` — at 20 Hz, with nothing to
wait for. No physics engine, no chunk parsing, no pathfinding. It is not navigation: the bot wanders,
it does not go anywhere in particular.

**Measured, because a bot believing it walked proves nothing** (`test/move-probe.mjs`, and the
plugin's `/where` command, which reports the SERVER's own coordinates for a player):

| | |
|---|---|
| 160 packets over 8 s | the server saw the bot move **7.91 blocks** |
| corrections | **0** |
| kicks | **none** |
| server warnings | **none** |
| CPU, 7 bots walking | **0.0%** |

Less than the 34 blocks those packets asked for, and that is correct: the walk re-rolls its heading
every 900 ms, so net displacement is much shorter than the path walked. That is what a wander is.

**Where the truth lives.** The bot's own idea of its position is only what it last told the server,
and the server is free to disagree — it says so with a `position` packet, which is also how the bot
learns where it is at all, since it has never asked. So `y` is never invented: it stays whatever the
server last said, and a correction is adopted whole. That is what stops the bot walking into the
floor or floating away with no world data at all.

The walk starts only once a bot is READY (AuthMe cancels movement before login) and stops on every
path out — a loop still firing packets at a closed socket would be worse than not walking.
**It is on by default:** connect the fleet and they are moving, with a Stop walking button for when
they should stand still.

### The fleet stands down when the party is full

Once every bot is in the party, each one runs the configured offline command (`/off` by default).
A status, not a disconnect — the account stays connected, it is just telling the rest of the party
it is done for now. The bot's card shows an `offline` badge, set only when the server acknowledged
the command, so it is the server's answer rather than the bot's intention.

It fires once per **party**, not once per process. That distinction cost a round: after a server
restart broke up the party and the fleet rebuilt it, nothing stood down, because the "already done"
flag still said done. Losing a member now re-arms it, which is what "per party" means.

### Two traps in adding that command

- **`off` is a YAML 1.1 boolean.** An unquoted `off:` key in `plugin.yml` is handed to Bukkit as
  `false`, so the command registers under the wrong name and `/off` answers "Unknown command" with
  nothing anywhere saying why. It has to be quoted — same for `on`, `yes`, `no`, `y`, `n`.
- The completion hook was added with a string replacement whose anchor no longer matched, and
  without an assertion, so it silently did nothing and the trigger never ran. Every edit of that
  kind in this project carries an `assert` now, and this is why.

## A real anti-cheat is now running, and it immediately found a real bug

The test bed used to have no anti-cheat at all, which means nothing the fleet did was ever checked
against a realistic adversary. **Kauri 2.19.2** (plus its Atlas library) is now installed and
running on the 1.8.8 server with **90 checks enabled** — Speed, Fly, Reach, Killaura, Autoclicker,
Aim, Block placement, BadPackets, NoFall and more. It loads on 1.8.8 despite declaring
`api-version: 1.13`, and `punishments.releaseStageMinimum: Release` means its beta checks alert but
cannot punish, so nothing gets kicked for a check that is still experimental.

**Our first run against it:** every one of the seven bots was flagged `BadPackets (N)` about
**twelve times per tick**, past **VL 1200 within a minute**. Not one was from movement — the walk
was fine.

**The cause, found by comparison rather than guesswork:** a mineflayer bot on the same server, doing
the same walk, was flagged **zero times**. Kauri's `BadPacketsN` tracks keep-alive and **transaction**
round trips, and:

- `mineflayer/lib/plugins/inventory.js` answers transactions (`bot._client.write('transaction', ...)`)
- `minecraft-protocol` does **not** — it handles keep-alive, compression and the login sequence, and
  stops there

So a raw client is silent at exactly the packets an anti-cheat uses to tell a client from a bot.
`src/transport/client.js` now echoes every transaction back with `accepted: true`, which is what a
vanilla client does.

**Verified after the fix, over the whole 63-assertion suite run: zero flags and zero kicks.** The
last `BadPackets (N)` in the log is at 08:30:57, before the change; the only line after it is one
`Inventory (A)` at VL 1.0 against a threshold of 50, from a chest-menu click — which is the chest
GUI flow, not movement, and worth a look on its own.

Worth recording how nearly that got misread: the log also contains Kauri printing its own punish
command at startup (`kick %name% [Kauri] Unfair Advantage -s`) and its broadcast template
(`%name% was removed by Kauri ...`). A grep for "Unfair Advantage" counts those, not punishments —
it read as "8 punishments" until the timestamps were checked. Un-substituted `%name%` in the output
is the tell that nothing was actually kicked.

That is the whole argument for having an anti-cheat in the test bed: the fleet had been running for
hours with a packet-level gap that nothing else could have shown, because nothing else was looking.

## Test suites## Test suites## Test suites## Test suites## Test suites

`test/verify.mjs` — 27 assertions, no server needed. Statuses, FSM legality, reason decoding,
per-bot serialisation, summary arithmetic.

`test/flows.mjs` — 32 end-to-end assertions driven through the same HTTP API the dashboard buttons
call. It asserts on the RESULT, not on a 200: after a kick it asks the server itself (`/p list`)
whether the party actually shrank, and it checks every command template against the plugin's own
subcommand list, because a wrong template is invisible until a bot silently fails to act.

## Two more real bugs the review caught that I had not fixed

**A pending invite was scored as membership.** The plugin's invites are durable: once sent they
stay pending until accepted, denied, or the target disconnects. `Invite all + accept` matched
"already in a party" and "already invited into your party" as the same benign answer and skipped
the accept — so a member holding a pending invite stayed **outside** the party while the button
reported `ok: true`. That is a green result over an empty outcome, the exact failure this project
exists to prevent. Only "already in a party" is a no-op now; "already invited" still gets accepted.
The same conflation existed in the arrival sweep, where a text test for "already in a party" did not
match the invite wording and fell through to a warning instead of accepting.

**A leader that never authenticates made the party unformable, with no control able to repair it.**
The fleet leader is pinned when the fleet is built and nothing reassigns it. Every other bot bailed
out of the arrival sweep while the leader was not READY, and every dashboard action resolved its
actor back to that same unreachable bot — `invite-all` answered 409, a one-shot invite answered
409, and `POST /api/run {mode:'master'}` answered **202 while issuing nothing at all**.

Any ready bot can invite: it simply becomes the leader of the party it creates, which is a far
better outcome than a fleet that cannot assemble because one account failed to log in. The inviter
now falls back to any ready bot, and a run refuses with 409 rather than accepting and doing nothing.

## One failure that was NOT a product bug

`transfer to PartyMaster succeeds` failed intermittently, and the master bot's own log showed it
had received the invite but never accepted. The cause was in the test fixture, not the tool:
`test/master-bot.mjs` latched an "accepted" flag after the first invite it ever saw, so a second
invite in the same process was silently ignored. A real player accepts every invite. The fixture now
accepts each one, with a short debounce so a duplicated invite line does not send the accept twice.

Worth recording because it is the failure mode that wastes the most time: a fixture that quietly
stops responding looks exactly like a product that quietly stops working, and the first instinct is
to go and change working code.

A second one, in the same family: the new `/api/connect` assertions fired three requests back to
back, but a connect takes ~25 s (1 s stagger plus authentication) and every endpoint refuses while
one is in flight — so the second and third measured the refusal, not what they meant to measure.
The suite now waits for the dashboard to go idle between them.

Both are test bugs and both were briefly reported here as product failures before being traced.
The pattern is the same in each case: a test that does not control for time will happily report a
correct system as broken, and it costs more to disprove than to prevent.

## What the adversarial review confirmed

Five independent reviewers, each finding then attacked by a skeptic told to refute it. The
verification pass completed for three of the five dimensions before the API quota ran out:

| dimension | findings | survived refutation | fixed here | left as a known limitation |
|---|---|---|---|---|
| party tracker | 4 | 4 | 3 | 1 |
| web API | 7 | 1 | 1 | 0 |
| web UI | 10 | 2 | 1 | 1 |
| autoparty | 2 | 2 | 2 | 0 |
| **total** | **23** | **9** | **7** | **2** |

The two left as known limitations, both stated rather than hidden:

- The tracker assumes one party per player. If someone in party A accepts an invite to party B, it
  follows them to B and forgets A. The reference plugin refuses a second party, so this is latent.
- `Save accounts` posts the whole textarea, so a second tab holding a stale list can overwrite
  changes made in the first. Fine for a single operator; not silently correct.

The final dimension's verification and the synthesis step did not report — the workflow stalled
after four of five verification passes. The remaining findings from that dimension (recorded in the
workflow journal) have therefore NOT been through refutation and are not counted above.

The four tracker findings that survived:

1. `noInvite` read as `notInParty` — fixed (patterns split).
2. A join is invisible when the inviter has disconnected, because the plugin was printing a raw
   UUID as the leader's name — fixed (offline player name).
3. The join/transfer rules assume one party per player. **Not fixed.** If a player is in party A
   and accepts an invite to party B, the tracker follows them to B and forgets A. The reference
   plugin prevents this, so it is latent rather than live — but it is a real assumption.
4. Membership changes were emitted but never reached the browser — fixed (state push on
   `party:membership`, throttled).

The one API finding that survived was the inert operator-pattern registry, which is fixed.

## Still open

- **The adversarial review of this round was cut short.** Five reviewers reported 28 findings; the
  verification pass only completed for one dimension before the API quota ran out. The findings
  that were listed but not verified are in the workflow journal. Nothing from that list has been
  dismissed — it simply has not been checked.
- `Save accounts` posts the whole textarea, so a second tab holding a stale list can overwrite
  changes made in the first. Acceptable for a single-operator tool; not silently correct.
- The interface has never been seen by a human. It has only been verified by fetching its assets
  and driving its API. There is no browser on this machine.

## Final state

```
node test/verify.mjs     27 passed, 0 failed
node test/flows.mjs      63 passed, 0 failed      (7 chest menu, 8 random walk, 5 area gate, 3 stand-down)
28 JS/MJS files          0 syntax errors
JSON + YAML              all parse
```

Two of the flow checks were added after the bugs above were found, and both exist because a suite
that checks only outcomes let real failures through: one asserts on the HTTP status of `/api/connect`
(which answered 500 on success for several runs while the fleet connected perfectly), and one asserts
that every pattern name a command references actually exists in the registry (the config used to
carry a drifted duplicate that silently reverted a fix at every load).

The fleet is left disconnected on purpose so you can press **Join server** and watch the whole
thing happen: red -> yellow -> green across the seven accounts, the party filling as each one
arrives, and every command classified as it lands.
