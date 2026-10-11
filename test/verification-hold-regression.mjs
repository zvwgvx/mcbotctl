import assert from 'node:assert/strict'
import { Fleet } from '../src/fleet.js'
import { Bus, EV } from '../src/bus.js'
import { S } from '../src/fsm.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bus = new Bus()
const cfg = {
  transport: 'mineflayer',
  server: {},
  auth: { enabled: false },
  fleet: {
    leaderIndex: 0,
    rejoinOnKick: true,
    connectStaggerMs: 25,
    readyTimeoutMs: 1000,
    readyStallMs: 1000,
    connectRetryBaseMs: 10,
    connectRetryMaxMs: 10,
    connectMaxRounds: 0
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

const starts = []
const stops = []

function fakeBot (id, username, verifies = false) {
  const bot = {
    id,
    username,
    stopping: false,
    superseded: false,
    joinedAt: null,
    fsm: { state: S.DISCONNECTED },
    transport: { connected: false },
    isReady: () => false,
    start: async () => {
      starts.push(username)
      bot.fsm.state = S.CONNECTING
      bot.transport.connected = true
      if (verifies) {
        setTimeout(() => {
          bus.emit(EV.MC_KICK, {
            botId: id,
            bot: username,
            text: `Hey ${username}, we need to verify your connection. https://v4g.to/abc123`,
            at: Date.now()
          })
        }, 5)
      }
      await sleep(50)
      return bot
    },
    stop: (reason) => {
      stops.push({ username, reason })
      bot.stopping = true
      bot.transport.connected = false
      bot.fsm.state = S.DEAD
    },
    dispose () {}
  }
  return bot
}

fleet.bots = [
  fakeBot('0:one', 'one', true),
  fakeBot('1:two', 'two'),
  fakeBot('2:three', 'three')
]
fleet.leader = fleet.bots[0]

await assert.rejects(
  fleet.bringOnline(),
  (error) => error?.kind === 'blocked' && error?.cause === 'connection_verification'
)

assert.deepEqual(starts, ['one'], 'fleet launched another bot after verification hold')
assert.equal(fleet.rejoinStatus().blocked, true)
assert.equal(fleet.rejoinStatus().cause, 'connection_verification')
assert.deepEqual(stops, [{ username: 'one', reason: 'fleet-hold' }], 'in-flight connection was not frozen by hold')

fleet.dispose()
console.log('verification hold regression: PASS')
