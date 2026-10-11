import assert from 'node:assert/strict'
import { Bus } from '../src/bus.js'
import { AutoPartyBehaviour } from '../src/behaviour/autoparty.js'
import { STATUS } from '../src/engine/classify.js'

// The dashboard can rebuild a fleet from more accounts than fleet.size specified at startup.
// Being "full" must still mean every bot in the current roster joined the party.
const bus = new Bus()
const sent = []
const roles = new Map([
  ['Leader', { role: 'leader', leader: 'Leader' }],
  ['Member', { role: 'member', leader: 'Leader' }],
  ['Outside', { role: 'none', leader: null }]
])
const bots = ['Leader', 'Member', 'Outside'].map((username, index) => ({
  id: `${index}:${username}`,
  username,
  offline: false,
  isReady: () => true,
  run: async (action) => {
    sent.push([username, action])
    return { status: STATUS.OK, action }
  }
}))
const cfg = { fleet: { size: 2, progressiveParty: false, offlineWhenFull: true, offlineCommand: 'off' } }
const engine = { get: (action) => action === 'off' ? { action } : null }
const tracker = { entry: (name) => roles.get(name) }
const party = new AutoPartyBehaviour({ cfg, bus, engine, log: { info () {}, warn () {} } })
party.attach({ leader: bots[0], bots }).trackMembership(tracker)

bus.emit('party:membership', { bot: 'Member', ...roles.get('Member') })
await new Promise((resolve) => setImmediate(resolve))
assert.deepEqual(sent, [], 'a bot outside the party must remain visible for invitations')
assert.equal(bots[2].offline, false)

roles.set('Outside', { role: 'member', leader: 'Leader' })
bus.emit('party:membership', { bot: 'Outside', ...roles.get('Outside') })
await new Promise((resolve) => setImmediate(resolve))
assert.deepEqual(sent, [
  ['Leader', 'off'], ['Member', 'off'], ['Outside', 'off']
])
assert.ok(bots.every((bot) => bot.offline))

party.dispose()
console.log('autoparty standdown roster regression: PASS')
