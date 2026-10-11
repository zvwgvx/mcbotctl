import assert from 'node:assert/strict'
import { Bus, EV } from '../src/bus.js'
import { CommandEngine } from '../src/engine/engine.js'
import { loadAccounts, loadConfig, applyCommands } from '../src/config/load.js'
import { buildRuntime } from '../src/runtime.js'
import { resourceCounts } from '../src/behaviour/bedwars_shop.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const cfg = loadConfig('./config/testbed.json')
cfg.fleet = { ...cfg.fleet, size: 1, progressiveParty: false, offlineWhenFull: false, rejoinOnKick: false }
cfg.menu = { ...cfg.menu, enabled: false }
cfg.movement = { ...cfg.movement, enabled: false }
cfg.bedwars = { ...cfg.bedwars, enabled: false, ironRequired: 16, walkTimeoutMs: 15000 }
cfg.combat = { ...cfg.combat, enabled: false }
cfg.autoplay = { ...cfg.autoplay, enabled: true, autoStart: false, roamRadius: 3, maxActionFailures: 8 }

const [account] = loadAccounts(cfg.accountsFile)
const bus = new Bus()
const log = { info () {}, warn: (...args) => console.warn(...args) }
const engine = new CommandEngine({ bus, log, defaults: cfg.engine })
applyCommands(engine, cfg)
const runtime = buildRuntime({ bus, engine, cfg, roster: [account], log })
const bot = runtime.fleet.bots[0]

function waitFor (topic, predicate, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const off = bus.on(topic, (event) => {
      if (!predicate(event)) return
      clearTimeout(timer)
      off()
      resolve(event)
    })
    const timer = setTimeout(() => {
      off()
      reject(new Error('timeout waiting for ' + topic))
    }, timeoutMs)
  })
}

try {
  await bot.start()
  if (!bot.isReady()) await waitFor(EV.BOT_READY, (e) => e.botId === bot.id, 30000)
  const fixture = waitFor(EV.MC_CHAT, (e) => e.botId === bot.id && e.text.includes('BW TEST generator='), 10000)
  assert.ok(bot.send('/bwtest'))
  await fixture

  const started = runtime.autoplay.start(bot)
  assert.equal(started.ok, true, started.error)

  const deadline = Date.now() + 90000
  let finalState = null
  while (Date.now() < deadline) {
    const state = runtime.autoplay.stateOf(bot.id)
    const resources = resourceCounts(bot)
    if (resources.wool > 0 && state?.moves > 0 && state?.interactions > 0) {
      finalState = state
      break
    }
    await sleep(500)
  }

  assert.ok(finalState, 'autoplay did not complete interaction + movement')
  const resources = resourceCounts(bot)
  assert.ok(resources.wool > 0, 'autoplay did not buy wool')
  assert.ok(finalState.interactions > 0, 'autoplay did not record an interaction')
  assert.ok(finalState.moves > 0, 'autoplay did not roam after interaction')

  console.log('autoplay engine regression: PASS')
  console.log(JSON.stringify({
    resources,
    actions: finalState.actions,
    interactions: finalState.interactions,
    moves: finalState.moves,
    failures: finalState.failures,
    lastAction: finalState.action
  }))
} finally {
  runtime.autoplay.stop(bot)
  if (bot.isReady() && bot.sendable()) {
    bot.send('/reset')
    await sleep(300)
  }
  await runtime.fleet.shutdown('autoplay-test')
  runtime.dispose()
}
