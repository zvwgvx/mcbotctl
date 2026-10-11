import assert from 'node:assert/strict'
import { Fleet } from '../src/fleet.js'
import { Bus } from '../src/bus.js'
import { STATUS } from '../src/engine/classify.js'

const bus = new Bus()
const cfg = {
  transport: 'mineflayer',
  server: {},
  auth: { enabled: false },
  fleet: { leaderIndex: 0, progressiveParty: true, rejoinOnKick: false }
}

const fleet = new Fleet({
  cfg,
  accounts: [{ username: 'leader', password: 'x' }, { username: 'member', password: 'x' }],
  bus,
  engine: {},
  log: { info () {}, warn () {} }
})

const calls = []
const leader = {
  id: '0:leader',
  username: 'leader',
  isReady: () => true,
  run: async (action, vars) => {
    calls.push({ bot: 'leader', action, vars })
    return { status: STATUS.OK }
  }
}
const member = {
  id: '1:member',
  username: 'member',
  isReady: () => true,
  run: async (action, vars) => {
    calls.push({ bot: 'member', action, vars })
    return { status: STATUS.OK }
  }
}

fleet.bots = [leader, member]
fleet.leader = leader

await fleet.execute([
  { type: 'command', phase: 'party', actor: 'leader', action: 'invite', target: 'members' },
  { type: 'command', phase: 'party', actor: 'members', action: 'accept', target: 'leader' },
  { type: 'command', phase: 'master', actor: 'leader', action: 'invite', target: 'human' }
])

assert.deepEqual(calls.map((x) => [x.bot, x.action, x.vars?.player]), [['leader', 'invite', 'human']])
console.log('party single-controller regression: PASS')
