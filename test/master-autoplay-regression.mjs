import assert from 'node:assert/strict'
import { Bus, EV } from '../src/bus.js'
import { MasterCommandsBehaviour } from '../src/behaviour/master_commands.js'

const bus = new Bus()
const calls = []
const fakeAutoplay = {
  requestStart: async (bot, opts) => {
    calls.push(['start', bot.username, opts])
    return { ok: true, phase: 'starting' }
  },
  requestStop: async (bot, opts) => {
    calls.push(['stop', bot.username, opts])
    return { ok: true, phase: 'stopped' }
  }
}

const mkBot = (id, username) => ({
  id, username,
  isReady: () => true
})
const bots = [mkBot('0:A', 'A'), mkBot('1:B', 'B')]

const behaviour = new MasterCommandsBehaviour({
  cfg: { fleet: { master: 'miang_' } },
  bus,
  tracker: { entry: () => ({ role: 'member', leader: 'miang_' }) },
  presence: { stateOf: () => ({ stage: 'mode' }) },
  autoplay: fakeAutoplay,
  log: { info () {}, warn () {} }
}).attach({ bots })

// 1. Non-master command should be ignored
bus.emit(EV.MC_CHAT, { botId: '0:A', bot: 'A', text: 'Party ▏ stranger_: =autoplay' })
await new Promise((r) => setTimeout(r, 40))
assert.equal(calls.length, 0, 'non-master =autoplay should be ignored')

// 2. Master =autoplay should force start all bots
bus.emit(EV.MC_CHAT, { botId: '0:A', bot: 'A', text: 'Party ▏ miang_: =autoplay' })
await new Promise((r) => setTimeout(r, 60))
assert.equal(calls.length, 2)
assert.deepEqual(calls[0], ['start', 'A', { source: 'master-command', arm: true, force: true }])
assert.deepEqual(calls[1], ['start', 'B', { source: 'master-command', arm: true, force: true }])
calls.length = 0

// 3. Master =autoplay stop should stop all bots
await new Promise((r) => setTimeout(r, 1600)) // debounce gap
bus.emit(EV.MC_CHAT, { botId: '0:A', bot: 'A', text: 'Party ▏ miang_: =autoplay stop' })
await new Promise((r) => setTimeout(r, 60))
assert.equal(calls.length, 2)
assert.deepEqual(calls[0], ['stop', 'A', { source: 'master-command', disarm: true }])
assert.deepEqual(calls[1], ['stop', 'B', { source: 'master-command', disarm: true }])
calls.length = 0

// 4. Master =autoplay A should force start only bot A
await new Promise((r) => setTimeout(r, 1600))
bus.emit(EV.MC_CHAT, { botId: '0:A', bot: 'A', text: 'Party ▏ miang_: =autoplay A' })
await new Promise((r) => setTimeout(r, 60))
assert.equal(calls.length, 1)
assert.deepEqual(calls[0], ['start', 'A', { source: 'master-command', arm: true, force: true }])
calls.length = 0

// 5. Master =play should standard arm (force: false)
await new Promise((r) => setTimeout(r, 1600))
bus.emit(EV.MC_CHAT, { botId: '0:A', bot: 'A', text: 'Party ▏ miang_: =play' })
await new Promise((r) => setTimeout(r, 60))
assert.equal(calls.length, 2)
assert.deepEqual(calls[0], ['start', 'A', { source: 'master-command', arm: true, force: false }])
assert.deepEqual(calls[1], ['start', 'B', { source: 'master-command', arm: true, force: false }])
calls.length = 0

// 6. Master =play force should force start (force: true)
await new Promise((r) => setTimeout(r, 1600))
bus.emit(EV.MC_CHAT, { botId: '0:A', bot: 'A', text: 'Party ▏ miang_: =play force' })
await new Promise((r) => setTimeout(r, 60))
assert.equal(calls.length, 2)
assert.deepEqual(calls[0], ['start', 'A', { source: 'master-command', arm: true, force: true }])
assert.deepEqual(calls[1], ['start', 'B', { source: 'master-command', arm: true, force: true }])

behaviour.dispose()
console.log('master autoplay regression: PASS')
