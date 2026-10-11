import assert from 'node:assert/strict'
import { Bus } from '../src/bus.js'
import { AutoPartyBehaviour } from '../src/behaviour/autoparty.js'
import { STATUS } from '../src/engine/classify.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bus = new Bus()
let calls = 0
const bot = {
  id: '0:leader',
  username: 'leader',
  offline: false,
  isReady: () => true,
  run: async (action) => {
    if (action !== 'partyList') return { status: STATUS.OK }
    calls++
    return calls === 1
      ? { status: STATUS.NO_RESPONSE, pattern: null }
      : { status: STATUS.OK, pattern: 'partyOwnerLine' }
  }
}
const cfg = { fleet: { progressiveParty: true, leaderIndex: 0, offlineWhenFull: false, partyRetrySweepMs: 1000 } }
const engine = { get: (name) => name === 'partyList' ? {} : null }
const tracker = { entry: () => ({ role: 'none', leader: null }) }
const party = new AutoPartyBehaviour({ cfg, bus, engine, log: { info () {}, warn () {} } })
party.attach({ leader: bot, bots: [bot] }).trackMembership(tracker).setGate(() => true)
bus.emit('menu:state', { botId: bot.id, bot: bot.username, state: 'done' })
await sleep(1800)
assert.equal(calls, 2)
party.dispose()
console.log('autoparty party-list retry regression: PASS')
