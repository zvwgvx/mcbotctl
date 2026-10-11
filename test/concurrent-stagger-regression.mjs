import assert from 'node:assert/strict'
import { Fleet } from '../src/fleet.js'
import { Bus } from '../src/bus.js'
import { S } from '../src/fsm.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bus = new Bus()
const cfg = {
  transport: 'mineflayer',
  server: {},
  auth: { enabled: false },
  fleet: {
    leaderIndex: 0,
    connectStaggerMs: 30,
    readyTimeoutMs: 1000,
    connectMaxRounds: 1,
    rejoinOnKick: false
  }
}

const fleet = new Fleet({
  cfg,
  accounts: [
    { username: 'one', password: 'x' },
    { username: 'two', password: 'x' },
    { username: 'three', password: 'x' }
  ],
  bus,
  engine: {},
  log: { info () {}, warn () {} }
})

for (const bot of fleet.bots) bot.dispose?.()

const starts = []
function fakeBot (id, username) {
  let ready = false
  const fsm = { state: S.DISCONNECTED }
  return {
    id,
    username,
    fsm,
    protocolState: 'play',
    isReady: () => ready,
    start: async () => {
      starts.push(Date.now())
      fsm.state = S.CONNECTING
      await sleep(120)
      ready = true
      fsm.state = S.READY
      return true
    },
    dispose () {}
  }
}

fleet.bots = [
  fakeBot('0:one', 'one'),
  fakeBot('1:two', 'two'),
  fakeBot('2:three', 'three')
]
fleet.leader = fleet.bots[0]

const result = await fleet.bringOnline()
assert.equal(result.ready.length, 3)
assert.equal(starts.length, 3)
assert.ok(starts[1] - starts[0] >= 20 && starts[1] - starts[0] < 90, `second bot started after ${starts[1] - starts[0]}ms`)
assert.ok(starts[2] - starts[1] >= 20 && starts[2] - starts[1] < 90, `third bot started after ${starts[2] - starts[1]}ms`)

fleet.dispose()
console.log('concurrent stagger regression: PASS')
