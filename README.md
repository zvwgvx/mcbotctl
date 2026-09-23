# mcbotctl

Spawn N Minecraft 1.8.9 bots that connect, log in, form a party, run a scripted plan, and
report the success or failure of every command — with a web console for driving the fleet by
hand.

It is a measurement tool, not a "bot client". Every command result is classified from what the
server actually said back: success, failure, no response. A command that produced no matching
reply is reported as `NO_RESPONSE`, never quietly rounded up to a pass.

A clean 7-bot run prints one line:

```
commands: 19  OK=19 FAILED=0 NO_RESPONSE=0 BLOCKED=0 ERROR=0
```

And then, always in full, anything that did not succeed — because a green summary with a hidden
failure list is worse than no summary:

```
commands: 19  OK=17 FAILED=1 NO_RESPONSE=1 BLOCKED=0 ERROR=0

2 command(s) did not succeed:
  Tenor          accept     NO_RESPONSE  no reply matched any pattern within 1500ms
  Bass           invite     FAILED       You are not the party leader.
```

## Requirements

- Node 22+ (`.nvmrc` pins it: `nvm use 22`)
- A Minecraft **1.8.9** server you are allowed to run bots against
- Optional: Docker, for the bundled test bed

## Install

```bash
nvm use 22
npm install
```

## Configure

Two files:

**`accounts/accounts.txt`** — one `username:password` per line, `#` comments, blank lines
ignored. Copy `accounts/accounts.example.txt` to start.

```
Soprano:matkhau1
Mezzo:matkhau2
```

Names must be 3–16 chars of `[A-Za-z0-9_]`: 1.8.9 demands the upper bound, and an AuthMe-style
plugin refuses anything under 3.

**`config/default.json`** — the server, the auth templates, the command templates, and the plan.
The shipped file is a sanitized example; the `_`-prefixed keys document *why* each value is
what it is, and most of them were measured rather than guessed. The ones that matter most:

| Key | Why |
| --- | --- |
| `server.version` | Must be set. Without it the protocol library handshakes as a modern client. |
| `engine.joinGuardMs` | AuthMe cancels *and kicks* on a non-allowlisted command sent within 1000 ms of joining. `/login` and `/register` are exempt. |
| `engine.burstCapacity` / `refillPerSecond` | The server's chat-spam budget is a token bucket, not a fixed gap: a burst is fine, a sustained 2/s gets you kicked. |
| `fleet.connectStaggerMs` | Staggered joins stay under AuthMe's connection-rate limiter. |
| `commands.*.success` / `.failure` | The patterns each command is judged on. Edit the `template` to match your server, then the patterns. |
| `transport` | `mineflayer` (full library, real physics and block placement) or `raw` (the lighter raw-protocol client). |

Point at your own file with `--config config/local.json` to keep real values out of the repo —
`config/local.json` is gitignored, `config/default.json` is not.

## Run

Direct — connects, runs the plan, prints a report, exits `1` if anything failed:

```bash
node src/index.js --config config/local.json
```

Web console — opens the dashboard and does *not* auto-run; you press **Run**:

```bash
node src/index.js --serve --port 4599
# then open http://127.0.0.1:4599
```

| Flag | Effect |
| --- | --- |
| `--config <path>` | Config file (default `config/default.json`) |
| `--accounts <path>` | Account list, overriding the config |
| `--bots <n>` | Use the first *n* accounts |
| `--leader <name>` | Which account leads the party |
| `--jsonl <path>` | Where to append per-command results |
| `--keep-alive` | Stay connected after the plan instead of shutting down |
| `--snapshot` | Print the full result tree as JSON |
| `--quiet` | Less narration |

## Test bed

This repo ships the server it was developed against: PaperSpigot 1.8.8 with AuthMe, plus a
reference party plugin whose source is in `plugin/`.

```bash
docker compose up -d                                  # 127.0.0.1:25566
./plugin/build.sh                                     # compile the party plugin into server/data/plugins/
node src/index.js --config config/testbed.json        # the test-bed account list
```

`config/testbed.json` uses `accounts/testbed.txt`, whose passwords are placeholders on
purpose — they are the same ones printed in `accounts/accounts.example.txt`.

## Tests

```bash
node test/verify.mjs                        # 27 offline assertions: patterns, FSM, engine gates
node src/index.js --serve --port 4599 &     # the flow suite drives the dashboard's own HTTP API
node test/flows.mjs                         # 32 end-to-end assertions (needs the test bed)
```

The remaining scripts in `test/` are probes: each one measures one server behaviour and prints
what it found (`accel-probe`, `move-probe`, `place-probe`, `spam-probe`, `gui-probe`, plus the
`p2`/`p3`/`timing` auth experiments). They are how the numbers in the config comments and in
`DEBUG-REPORT.md` were obtained.

## Layout

```
src/
  index.js            composition root and CLI
  bus.js  fsm.js      event bus, bot lifecycle state machine
  bot.js  fleet.js    one account, and a roster of them
  engine/             the command engine: send, match, classify, time out
  transport/          raw protocol client, and the Mineflayer client
  behaviour/          auth, party, party tracking, movement, menu, bridge, bedwars
  config/load.js      config + accounts loading and validation
  patterns.js         the default success/failure phrase table
  report/  web/       result store, and the dashboard (SSE + POST, no dependencies)
plugin/               the reference Bukkit party plugin used by the test bed
```

## Docs

- `DEBUG-REPORT.md` — what was measured while building this, with the command for each number.
- `BEDWARS.md` — the optional BedWars opening (generator, shop, sneak-bridge) and its map config.
