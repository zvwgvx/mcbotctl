import assert from 'node:assert/strict'
import { AutoplayEngine } from '../src/behaviour/autoplay_engine.js'
import { Bus } from '../src/bus.js'

const bus = new Bus()
const supervisor = {
  run: async (bot, spec, task) => {
    return { status: 'OK', action: spec.action }
  },
  activeOf: () => null
}
const presence = {
  stateOf: () => ({ stage: 'match' })
}
const engine = new AutoplayEngine({
  cfg: {
    autoplay: { enabled: true, autoStart: true, minWool: 16, matchDebounceMs: 10 },
    bedwars: {
      ironRequired: 16,
      geometry: { home: { id: 'spawn', generator: null, bridgeStart: null }, islands: [] }
    }
  },
  bus,
  supervisor,
  presence,
  log: { info () {}, warn () {}, error () {} }
})

const bot = {
  id: '0:testbot',
  username: 'testbot',
  isReady: () => true,
  transport: {
    connected: true,
    physics: true,
    mc: { entity: { onGround: true, health: 20 }, health: 20 },
    inventoryItems: () => []
  }
}

engine.attach({ bots: [bot] })
bus.emit('bedwars:presence', { botId: bot.id, stage: 'match' })

await new Promise((r) => setTimeout(r, 50))
const state = engine.stateOf(bot.id)
assert.notEqual(state.phase, 'failed', 'Autoplay should NOT fail with TypeError')
assert.equal(state.lastResult?.status, 'OK')
assert.equal(state.lastResult?.action, 'collect_iron')
assert.equal(state.lastResult?.error, null)
console.log('autoplay null geometry regression: PASS')
