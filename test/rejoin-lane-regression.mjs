import assert from 'node:assert/strict'
import { Fleet } from '../src/fleet.js'
import { Bus, EV } from '../src/bus.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bus = new Bus()
const cfg = {
  transport: 'mineflayer',
  server: {},
  auth: { enabled: false },
  fleet: {
    leaderIndex: 0,
    rejoinOnKick: true,
    rejoinDelayMs: 1,
    rejoinMaxDelayMs: 10,
    maxRejoinAttempts: 1,
    connectStaggerMs: 25,
    stableRejoinResetMs: 1000
  }
}

const fleet = new Fleet({
  cfg,
  accounts: [
    { username: 'one', password: 'x' },
    { username: 'two', password: 'x' }
  ],
  bus,
  engine: {},
  log: { info () {}, warn () {} }
})

let active = 0
let maxActive = 0
const starts = []

function fakeBot (id, username) {
  return {
    id,
    username,
    stopping: false,
    superseded: false,
    joinedAt: null,
    isReady: () => false,
    start: async () => {
      active++
      maxActive = Math.max(maxActive, active)
      starts.push({ username, at: Date.now() })
      await sleep(20)
      active--
      return true
    },
    dispose () {}
  }
}

fleet.bots = [fakeBot('0:one', 'one'), fakeBot('1:two', 'two')]
fleet.leader = fleet.bots[0]

bus.emit(EV.MC_END, { botId: '0:one', bot: 'one', reason: 'socketClosed' })
bus.emit(EV.MC_END, { botId: '1:two', bot: 'two', reason: 'socketClosed' })
await sleep(120)

assert.equal(maxActive, 1, 'two reconnect attempts ran concurrently')
assert.equal(starts.length, 2, 'both dropped bots did not get a reconnect attempt')
assert.ok(starts[1].at - starts[0].at >= 20, 'global reconnect lane did not serialize starts')

fleet.bots[0].stopping = true
bus.emit(EV.MC_DISCONNECT, {
  botId: '0:one',
  bot: 'one',
  text: 'You are logging in too fast, try again later.'
})
assert.equal(fleet.rejoinStatus().blocked, false, 'login throttle incorrectly became a permanent fleet block')

fleet.dispose()
console.log('rejoin lane regression: PASS')
