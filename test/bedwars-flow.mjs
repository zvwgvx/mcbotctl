// Live opening against the opt-in /bwtest fixture on the local Paper test server.
// Uses one configured account and asks the server itself whether the island was reached.

import assert from 'node:assert/strict'
import { Bus, EV } from '../src/bus.js'
import { CommandEngine } from '../src/engine/engine.js'
import { loadAccounts, loadConfig, applyCommands } from '../src/config/load.js'
import { buildRuntime } from '../src/runtime.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const cfg = loadConfig()
cfg.fleet = { ...cfg.fleet, size: 1, progressiveParty: false, offlineWhenFull: false, rejoinOnKick: false }
cfg.menu = { ...cfg.menu, enabled: false }
cfg.movement = { ...cfg.movement, enabled: false }
cfg.bedwars = { ...cfg.bedwars, enabled: false, maxIslands: 1 }
const [account] = loadAccounts(cfg.accountsFile)
assert.ok(account, 'one configured account is required')

const bus = new Bus()
const log = { info () {}, warn: (...args) => console.warn(...args) }
const engine = new CommandEngine({ bus, log, defaults: cfg.engine })
applyCommands(engine, cfg)
const runtime = buildRuntime({ bus, engine, cfg, roster: [account], log })
const bot = runtime.fleet.bots[0]

function waitFor (topic, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const off = bus.on(topic, (event) => {
      if (!predicate(event)) return
      clearTimeout(timer)
      off()
      resolve(event)
    })
    const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${topic}`)) }, timeoutMs)
  })
}

function coords (line, key) {
  const match = line.match(new RegExp(`${key}=(-?\\d+),(-?\\d+),(-?\\d+)`))
  assert.ok(match, `${key} coordinates missing from fixture response`)
  return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) }
}

try {
  await bot.start()
  if (!bot.isReady()) await waitFor(EV.BOT_READY, (e) => e.botId === bot.id, 30000)
  await sleep(cfg.engine.joinGuardMs + 100)
  const setup = waitFor(EV.MC_CHAT, (e) => e.botId === bot.id && e.text.includes('BW TEST generator='), 10000)
  assert.ok(bot.send('/bwtest'), 'could not request BedWars fixture')
  const line = (await setup).text
  assert.doesNotMatch(line, /\b(?:shop|shopNpc|shopTitle|woolSlot)=/i,
    'fixture must not reveal shop location, NPC name, title, or item slot')

  cfg.bedwars.shop = {
    ...cfg.bedwars.shop,
    mode: 'auto',
    maxDistance: 8,
    openTimeoutMs: 4000,
    purchaseTimeoutMs: 5000
  }
  cfg.bedwars.geometry = {
    home: {
      id: 'home', generator: coords(line, 'generator'),
      bridgeStart: coords(line, 'bridge'), neighbors: ['neighbor']
    },
    islands: [{ id: 'neighbor', center: coords(line, 'target'), bridgeEnd: coords(line, 'target') }]
  }
  const started = runtime.bedwars.start(bot)
  assert.equal(started.ok, true, started.error)
  console.log('BedWars opening started')

  const terminal = await waitFor('bedwars:state', (e) => e.botId === bot.id && ['done', 'failed'].includes(e.phase), 120000)
  if (terminal.phase === 'failed') {
    const nearby = Object.values(bot.transport.mc.entities).map((e) => ({
      name: e.name, type: e.type, username: e.username, displayName: e.displayName,
      metadata: e.metadata, distance: e.position?.distanceTo(bot.transport.mc.entity.position)
    })).filter((e) => e.distance < 12)
    console.error('Nearby entities:', JSON.stringify(nearby).slice(0, 1200))
  }
  assert.equal(terminal.phase, 'done', terminal.result?.error ?? 'BedWars opening failed')

  const status = waitFor(EV.MC_CHAT, (e) => e.botId === bot.id && e.text.includes('BW STATUS iron='), 10000)
  assert.ok(bot.send('/bwstatus'), 'could not request server status')
  const server = (await status).text
  assert.match(server, /reached=true/, server)
  assert.match(server, /iron=0\b/, server)
  assert.match(server, /wool=[1-9]\d*/, server)
  console.log(`PASS ${terminal.result.response}; ${server}`)
} finally {
  // Restore the account's saved location so later random-walk runs do not begin at the
  // isolated island fixture, where a bot can walk straight into the void.
  if (bot.isReady() && bot.sendable()) {
    bot.send('/reset')
    await sleep(500)
  }
  await runtime.fleet.shutdown('bedwars-test')
  runtime.dispose()
}
