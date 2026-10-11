import assert from 'node:assert/strict'
import { Bus, EV } from '../src/bus.js'
import { AutoPartyBehaviour } from '../src/behaviour/autoparty.js'
import { STATUS } from '../src/engine/classify.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const bus = new Bus()
let invites = 0

const leader = {
  id: '0:leader',
  username: 'leader',
  offline: false,
  isReady: () => true,
  run: async (action) => {
    if (action === 'invite') {
      invites++
      await sleep(60)
      return { status: STATUS.NO_RESPONSE, pattern: null, response: null, error: 'no reply' }
    }
    return { status: STATUS.OK }
  }
}

const member = {
  id: '1:member',
  username: 'member',
  offline: false,
  isReady: () => true,
  run: async () => ({ status: STATUS.OK })
}

const tracker = {
  entry: () => ({ role: 'none', leader: null })
}

const cfg = {
  fleet: {
    progressiveParty: true,
    leaderIndex: 0,
    offlineWhenFull: false,
    allowLeaderFallback: false
  }
}

const engine = { get: () => null }
const party = new AutoPartyBehaviour({ cfg, bus, engine, log: { info () {}, warn () {} } })
party.attach({ leader, bots: [leader, member] }).trackMembership(tracker)

bus.emit(EV.BOT_READY, { botId: member.id, bot: member.username })
await sleep(10)
bus.emit('party:membership', { bot: member.username, role: 'none', leader: null, confirmedAbsent: true })
await sleep(90)

bus.emit(EV.BOT_READY, { botId: member.id, bot: member.username })
await sleep(120)

assert.equal(invites, 1, 'confirmed-absent update reset invite backoff and caused an immediate retry')
party.dispose()

console.log('autoparty retry regression: PASS')
