import assert from 'node:assert/strict'
import { Fleet } from '../src/fleet.js'
import { Bus } from '../src/bus.js'
import { S } from '../src/fsm.js'

const bus = new Bus()
const cfg = {
  transport: 'mineflayer',
  server: {},
  auth: { enabled: true },
  fleet: {
    leaderIndex: 0,
    rejoinOnKick: false,
    readyTimeoutMs: 1000,
    readyStallMs: 5000,
    connectRetryBaseMs: 500,
    connectRetryMaxMs: 500,
    connectMaxRounds: 0
  }
}

const fleet = new Fleet({
  cfg,
  accounts: [{ username: 'slow-auth', password: 'x' }],
  bus,
  engine: {},
  log: { info () {}, warn () {} }
})

let stops = 0
let starts = 0
const fsm = { state: S.AUTH }
const bot = {
  id: '0:slow-auth',
  username: 'slow-auth',
  fsm,
  joinedAt: Date.now(),
  transport: { connected: true },
  isReady: () => fsm.state === S.READY,
  start: async () => { starts++ },
  stop: () => { stops++ },
  dispose: () => {}
}

fleet.bots = [bot]
fleet.leader = bot

setTimeout(() => { fsm.state = S.READY }, 1200)

const result = await fleet.bringOnline()
assert.equal(result.ready.length, 1)
assert.equal(stops, 0)
assert.equal(starts, 0)

fleet.dispose()
console.log('fleet slow-auth convergence regression: PASS')
