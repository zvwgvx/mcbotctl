#!/usr/bin/env node
// index.js — composition root. The only file that knows every layer exists.
//
// Wiring order matters: Reporter subscribes to the bus before any bot is created, so no result
// can be emitted into the void. Behaviours are attached after bots exist but before the plan
// runs, so no MC_JOIN event is missed.
//
// The pieces hang off a single `app` object rather than being loose locals, because the web
// console can REBUILD the fleet at runtime: editing the account list produces a different
// roster, and a roster is what a Fleet is built from. `app.fleet` is a getter so every holder
// sees the current fleet without having to be told it changed.

import { Bus, EV } from './bus.js'
import { CommandEngine } from './engine/engine.js'
import { buildRuntime, parseAddress } from './runtime.js'
import { Reporter } from './report/reporter.js'
import { loadConfig, loadAccounts, applyCommands, ROOT } from './config/load.js'
import { defaultPartyPlan } from './behaviour/party.js'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt }
const has = (name) => argv.includes('--' + name)

const log = {
  info: (...a) => { if (!has('quiet')) console.log('   ', ...a) },
  warn: (...a) => console.warn('  !', ...a),
  say: (...a) => console.log(...a)
}

async function main () {
  const cfgPath = arg('config', join(ROOT, 'config', 'default.json'))
  const cfg = loadConfig(cfgPath)
  const accountsFile = arg('accounts', cfg.accountsFile)
  const accounts = loadAccounts(accountsFile)
  const size = Math.min(Number(arg('bots', cfg.fleet.size)), accounts.length)
  const roster = accounts.slice(0, size)

  if (arg('leader')) {
    const idx = roster.findIndex((a) => a.username === arg('leader'))
    if (idx < 0) throw new Error(`--leader ${arg('leader')} is not in the account list`)
    cfg.fleet.leaderIndex = idx
  }

  const bus = new Bus()
  const engine = new CommandEngine({ bus, log, defaults: cfg.engine })
  applyCommands(engine, cfg)

  const jsonl = arg('jsonl', cfg.report.jsonl ? join(ROOT, cfg.report.jsonl) : null)
  const reporter = new Reporter({ bus, log, jsonlPath: jsonl, ringSize: cfg.report.ringSize })

  const app = {
    cfg, cfgPath, accountsFile, bus, engine, reporter, log,
    runtime: buildRuntime({ bus, engine, cfg, roster, log }),
    get fleet () { return this.runtime.fleet },
    /** Swap in a brand-new roster. Stops the old fleet first so its sockets are gone before
     *  the new bots claim the same account names — two live connections under one name are
     *  refused by the server with "The same username is already playing on the server!". */
    async rebuild (nextRoster) {
      const old = this.runtime
      await old.fleet.shutdown('rebuild')
      old.dispose()          // drop the old runtime's bus handlers BEFORE the new bots take the same ids
      cfg.fleet.leaderIndex = 0
      this.runtime = buildRuntime({ bus: this.bus, engine: this.engine, cfg: this.cfg, roster: nextRoster, log: this.log })
      return this.runtime.fleet
    }
  }

  log.say(`mcbotctl — ${size} bot(s) -> ${cfg.server.host}:${cfg.server.port} (MC ${cfg.server.version})`)
  log.say(`auth: ${cfg.auth?.enabled ? `on (${cfg.auth.strategy})` : 'off'}   engine: ${engine.list().length} command(s)   joinGuard: ${cfg.engine.joinGuardMs}ms`)
  log.say('')

  // Danger signals get printed immediately: a kick is never just a log line.
  bus.on(EV.MC_KICK, (e) => log.warn(`[${e.bot}] KICKED: ${e.text}`))
  bus.on(EV.MC_DISCONNECT, (e) => log.warn(`[${e.bot}] DISCONNECTED: ${e.text}`))
  bus.on(EV.AUTH_FAIL, (e) => log.warn(`[${e.bot}] auth failed: ${e.pattern}${e.fatal ? ' — NOT retrying' : ''}`))
  // A throwing bus handler is isolated by design. Surface it instead of losing it.
  bus.on(EV.BUS_ERROR, (e) => log.warn(`bus handler threw on "${e.topic}": ${e.error?.message}`))

  // --serve: opens the web console, does NOT auto-run itself. The operator presses "Run" on the dashboard.
  // Shares one process with the bots -> no extra runtime, exactly the lightweight spirit.
  if (has('serve')) {
    const { WebConsole } = await import('./web/server.js')
    const web = new WebConsole({ app, publicDir: join(ROOT, 'public') })
    const port = Number(arg('port', cfg.web?.port ?? 4599))
    const host = arg('host', cfg.web?.host ?? '127.0.0.1')
    await web.start(port, host)
    log.say(`  dashboard: http://${host}:${port}`)
    log.say('  Press "Run" on the dashboard to start. Ctrl-C to quit.')
    await new Promise(() => {})
    return
  }

  const plan = cfg.plan ?? defaultPartyPlan()
  return app.fleet.execute(plan).then(async (results) => {
    log.say('')
    log.say(reporter.report())

    if (has('snapshot')) log.say('\n' + JSON.stringify(reporter.snapshot(), null, 2))
    if (has('keep-alive')) {
      log.say('\n--keep-alive: bots stay connected. Ctrl-C to stop.')
      await new Promise(() => {})
    }
    await app.fleet.shutdown()
    const bad = results.filter((r) => r.status !== 'OK')
    process.exitCode = bad.length ? 1 : 0
  })
}

main().catch((e) => { console.error('fatal:', e.stack ?? e.message); process.exit(2) })
