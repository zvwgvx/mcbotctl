import assert from 'node:assert/strict'
import { Bus, EV } from '../src/bus.js'
import { AutoPartyBehaviour } from '../src/behaviour/autoparty.js'
import { STATUS } from '../src/engine/classify.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bus = new Bus()
let accepts = 0

const leader = {
  id: '0:leader',
  username: 'leader',
  isReady: () => true,
  run: async (action) => {
    if (action === 'invite') return { status: STATUS.NO_RESPONSE }
    return { status: STATUS.OK }
  }
}

const member = {
  id: '1:member',
  username: 'member',
  isReady: () => true,
  run: async (action) => {
    if (action === 'accept') accepts++
    return { status: STATUS.OK }
  }
}

const cfg = {
  fleet: {
    progressiveParty: true,
    offlineWhenFull: false,
    allowLeaderFallback: false,
    partyInviteMinGapMs: 1,
    partyInviteNoResponseCooldownMs: 1,
    partyAcceptUnconfirmedDelayMs: 100,
    partyRetrySweepMs: 60000
  }
}

const tracker = { entry: () => ({ role: 'none', leader: null }) }
const engine = { get: () => null }
const party = new AutoPartyBehaviour({ cfg, bus, engine, log: { info () {}, warn () {} } })
party.attach({ leader, bots: [leader, member] }).trackMembership(tracker).autoJoinInvites({})
bus.emit(EV.BOT_READY, { botId: member.id, bot: member.username })
await sleep(500)
assert.equal(accepts, 1, 'member did not try to join after invite NO_RESPONSE')
party.dispose()
console.log('autoparty no-response join regression: PASS')
