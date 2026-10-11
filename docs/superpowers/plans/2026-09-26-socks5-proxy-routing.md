# SOCKS5 Proxy Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure SOCKS5 proxy administration and stable balanced or manual per-bot routing.

**Architecture:** A focused proxy manager owns validation, secret persistence, assignment planning, and redacted state. Both transports consume one shared SOCKS5 connector, while the existing composition root injects route lookup into every bot. The dashboard manages the store through one API and shows each bot's effective route.

**Tech Stack:** Node.js 22 ESM, `socks`, Mineflayer, `minecraft-protocol`, plain HTML/CSS/JavaScript

**Spec:** `docs/superpowers/specs/2026-09-26-socks5-proxy-routing-design.md`

## Global Constraints

- Preserve all existing uncommitted workspace changes.
- Never return or log a proxy password.
- Manual mode blocks an unassigned bot before TCP connection.
- Balanced assignment counts differ by at most one and remain stable across reconnects.
- Existing direct connections continue to work when proxy mode is `off`.

## Review Focus

- Saving a redacted proxy must retain its existing password.
- A deleted or disabled proxy must invalidate manual assignments that reference it.
- Empty balanced pools must block connections with an actionable error.
- SOCKS failures must settle the existing connection promise instead of hanging it.
- Rebuilding the account roster must regenerate assignments for the new bot set.

---

### Task 1: Proxy manager and connector

**Files:**
- Create: `src/proxy/manager.js`
- Create: `src/proxy/socks.js`
- Create: `test/proxy-regression.mjs`
- Modify: `package.json`, `package-lock.json`, `.gitignore`, `src/config/load.js`

**Interfaces:**
- Produces: `ProxyManager.open({ file, botNames })`, `routeFor(username)`, `publicState(botNames)`, and `replace(input, botNames)`.
- Produces: `socksConnectOptions(route, destination)` and `connectViaSocks(client, route, destination)`.

- [ ] Write regression tests for validation, redaction, password retention, balanced counts and stability, manual blocking, and SOCKS option construction.
- [ ] Run the regression test and observe failure because the proxy modules do not exist.
- [ ] Implement the manager, atomic persistence, and shared connector.
- [ ] Add the direct `socks` dependency and ignored credential file.
- [ ] Run the proxy regression test and confirm it passes.

### Task 2: Inject routes into bot transports

**Files:**
- Modify: `src/index.js`, `src/runtime.js`, `src/fleet.js`, `src/bot.js`, `src/transport/mineflayer.js`, `src/transport/client.js`
- Modify: `test/proxy-regression.mjs`

**Interfaces:**
- Consumes: `ProxyManager.routeFor(username)` and `connectViaSocks(...)` from Task 1.
- Produces: connection-time route lookup for every bot and a redacted per-bot route summary.

- [ ] Add a failing test proving manual-unassigned bots stop before transport connection.
- [ ] Inject the manager from the composition root through Fleet and Bot.
- [ ] Use the shared connector in both transports and expose route summaries.
- [ ] Run the proxy regression test and confirm it passes.

### Task 3: Admin API and dashboard

**Files:**
- Modify: `src/web/server.js`, `public/index.html`, `public/app.js`, `public/glass.css`

**Interfaces:**
- Consumes: manager replace/public-state APIs and fleet reconnect support.
- Produces: `POST /api/proxies`, proxy state in `/api/state`, and the Proxies dashboard tab.

- [ ] Add API validation and redacted state, preserving the web console's serialized save behavior.
- [ ] Add proxy pool editing, mode selection, assignment controls, route status, and save/reconnect actions.
- [ ] Ensure SSE refreshes do not overwrite dirty proxy edits.
- [ ] Run syntax checks and the proxy regression test.

### Task 4: Integration verification

**Files:**
- Modify only files required by findings.

**Interfaces:**
- Consumes: all prior task interfaces.
- Produces: a coherent direct, balanced, and manual connection flow.

- [ ] Run the existing regression scripts relevant to lifecycle and runtime composition.
- [ ] Review the final diff for leaked secrets, stale assignments, hanging connect promises, and overwritten user changes.
- [ ] Fix any material finding with a reproducing regression assertion.
