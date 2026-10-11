# mcbotctl User Guide

mcbotctl connects a fleet of Minecraft 1.8.9 accounts, manages party actions, and reports whether commands succeeded based on server replies. Use it only on servers where you are authorized to connect automated accounts.

## 1. Set up

- Install Node.js 22 or later, then run `npm install`.
- Add one `username:password` entry per line to `accounts/accounts.txt`. You can copy `accounts/accounts.example.txt` as a starting point.
- Copy `config/default.json` to `config/local.json`. Set the target server's host, port, and Minecraft version (`1.8.9`), and review the authentication and command settings for that server.
- Keep real account credentials private. `accounts/*.txt`, `config/local.json`, and proxy settings are excluded from Git.

## 2. Start the dashboard

```bash
node src/index.js --serve --config config/local.json --port 4599
```

Open [http://127.0.0.1:4599](http://127.0.0.1:4599). The dashboard does not connect automatically: on **Overview**, enter the server as `host:port` and select **Connect Fleet**. Wait for bots to become operational before sending commands. Select **Disconnect Fleet** when finished.

To run the configured plan without the dashboard:

```bash
node src/index.js --config config/local.json
```

## 3. Use the dashboard

- **Overview** — check connection, party, BedWars, and movement status.
- **Accounts** — edit or generate the roster, then select **Save Roster**. Rebuild the fleet if you changed its accounts.
- **Party** — use **Assemble Party** to create a party and invite available bots. **Enter BedWars Lobby** runs the configured server-selector flow.
- **Bot Control** — send a slash command from the current party leader/master or choose one ready bot. **Leave all · /leave** sends `/leave` to every ready bot.
- **Commands** — edit command templates and use **Probe Reply** to capture the server's response.
- **Diagnostics** — inspect command results, server messages, and runtime issues.
- **Proxies** — optional SOCKS5 routing. Save settings for the next connection, or choose **Save & Reconnect Fleet** to apply them now.

## 4. Read command results

- `OK` — a configured success reply was received.
- `FAILED` — a configured failure reply was received.
- `NO_RESPONSE` — no matching reply arrived before the timeout; check Diagnostics and the server's command format.
- `BLOCKED` — a prerequisite prevented the command from running.
- `ERROR` — the operation encountered a runtime error.

In dashboard controls, a sent command with no captured reply is shown explicitly. Check **Diagnostics** for later server messages. A completed send alone does not confirm that the server carried out the command.
