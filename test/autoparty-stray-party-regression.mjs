import assert from 'node:assert/strict'
import { Bus, EV } from '../src/bus.js'
import { AutoPartyBehaviour } from '../src/behaviour/autoparty.js'
import { STATUS } from '../src/engine/classify.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bus = new Bus()
const actions = []
const states = new Map()

const leader = {
  id: '0:leader',
  username: 'leader',
  offline: false,
  isReady: () => true,
  run: async (action, vars) => {
    actions.push(`leader:${action}:${vars?.player ?? ''}`)
    return { status: STATUS.OK }
  }
}

const member = {
  id: '1:member',
  username: 'member',
  offline: false,
  isReady: () => true,
  run: async (action) => {
    actions.push(`member:${action}`)
    if (action === 'disband' || action === 'leave') {
      states.set('member', { role: 'none', leader: null })
      bus.emit('party:membership', { bot: 'member', role: 'none', leader: null })
    }
    return { status: STATUS.OK }
  }
}

states.set('leader', { role: 'leader', leader: 'leader' })
states.set('member', { role: 'leader', leader: 'member' })

const tracker = {
  entry: (name) => states.get(name) ?? { role: 'none', leader: null }
}

const cfg = {
  fleet: {
    progressiveParty: true,
    leaderIndex: 0,
    offlineWhenFull: false,
    allowLeaderFallback: false,
    partyRetrySweepMs: 60000
  }
}

const engine = {
  get: (action) => ['disband', 'leave', 'invite', 'accept'].includes(action) ? {} : null
}

const party = new AutoPartyBehaviour({ cfg, bus, engine, log: { info () {}, warn () {} } })
party.attach({ leader, bots: [leader, member] }).trackMembership(tracker)

bus.emit('party:membership', { bot: 'member', role: 'leader', leader: 'member' })
bus.emit(EV.BOT_READY, { botId: member.id, bot: member.username })
await sleep(80)

assert.equal(actions[0], 'member:disband', 'a stray second party was not dismantled before normal formation')
assert.equal(states.get('member').role, 'none')
party.dispose()
console.log('autoparty stray-party regression: PASS')
