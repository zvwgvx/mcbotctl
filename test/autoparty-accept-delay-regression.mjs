import assert from 'node:assert/strict'
import { Bus, EV } from '../src/bus.js'
import { AutoPartyBehaviour } from '../src/behaviour/autoparty.js'
import { STATUS } from '../src/engine/classify.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bus = new Bus()
let accepts = 0
const leader = { id: '0:leader', username: 'leader', isReady: () => true, run: async () => ({ status: STATUS.OK }) }
const member = {
  id: '1:member', username: 'member', isReady: () => true,
  run: async (action) => { if (action === 'accept') accepts++; return { status: STATUS.OK } }
}
const cfg = { fleet: { progressiveParty: true, offlineWhenFull: false, allowLeaderFallback: false, partyAcceptDelayMs: 350, partyAcceptUnconfirmedDelayMs: 350, partyRetrySweepMs: 60000 } }
const tracker = { entry: () => ({ role: 'none', leader: null }) }
const engine = { get: () => null }
const party = new AutoPartyBehaviour({ cfg, bus, engine, log: { info () {}, warn () {} } })
party.attach({ leader, bots: [leader, member] }).trackMembership(tracker).setGate(() => true).autoJoinInvites({
  partyInviteToMe: { re: '^(?<inviter>leader) invited (?<invitee>member) to the party$' }
})
bus.emit(EV.MC_CHAT, { bot: 'member', botId: member.id, text: 'leader invited member to the party' })
await sleep(120)
assert.equal(accepts, 0)
await sleep(350)
assert.equal(accepts, 1)
party.dispose()
console.log('autoparty accept-delay regression: PASS')
