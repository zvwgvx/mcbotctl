import assert from 'node:assert/strict'
import { Bus, EV } from '../src/bus.js'
import { AutoPartyBehaviour } from '../src/behaviour/autoparty.js'
import { STATUS } from '../src/engine/classify.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bus = new Bus()
const calls = []

const leader = {
  id: '0:leader',
  username: 'leader',
  offline: false,
  isReady: () => true,
  run: async (action, args) => {
    if (action !== 'invite') return { status: STATUS.OK }
    calls.push({ at: Date.now(), player: args.player })
    if (calls.length === 1) return { status: STATUS.NO_RESPONSE, error: 'silent throttle' }
    return { status: STATUS.OK, response: 'ok' }
  }
}

const m1 = { id: '1:m1', username: 'm1', offline: false, isReady: () => true, run: async () => ({ status: STATUS.OK }) }
const m2 = { id: '2:m2', username: 'm2', offline: false, isReady: () => true, run: async () => ({ status: STATUS.OK }) }

const cfg = {
  fleet: {
    progressiveParty: true,
    offlineWhenFull: false,
    allowLeaderFallback: false,
    partyInviteMinGapMs: 30,
    partyInviteNoResponseCooldownMs: 80
  }
}

const tracker = { entry: () => ({ role: 'none', leader: null }) }
const party = new AutoPartyBehaviour({ cfg, bus, engine: { get: () => null }, log: { info () {}, warn () {} } })
party.attach({ leader, bots: [leader, m1, m2] }).trackMembership(tracker)

bus.emit(EV.BOT_READY, { botId: m1.id, bot: m1.username })
await sleep(10)
bus.emit(EV.BOT_READY, { botId: m2.id, bot: m2.username })
await sleep(40)

assert.equal(calls.length, 1, 'second target bypassed the global cooldown after NO_RESPONSE')

await sleep(60)
bus.emit(EV.BOT_READY, { botId: m2.id, bot: m2.username })
await sleep(20)

assert.equal(calls.length, 2, 'second target was not allowed after the global cooldown')
assert.ok(calls[1].at - calls[0].at >= 80, 'global cooldown was shorter than configured')
party.dispose()

console.log('autoparty global throttle regression: PASS')
