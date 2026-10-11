import assert from 'node:assert/strict'
import { PATTERNS } from '../src/patterns.js'
import { Bus, EV } from '../src/bus.js'
import { MasterCommandsBehaviour } from '../src/behaviour/master_commands.js'

const match = (key, text) => new RegExp(PATTERNS[key].re).exec(text)

assert.equal(match('mbpInviteSent', 'Party ▏ ✚ px3anosuko13 invited badasw1212 to the party.')?.groups?.invitee, 'badasw1212')
assert.equal(match('mbpJoined', 'Party ▏ ✚ badasw1212 joined the party!')?.groups?.joiner, 'badasw1212')
assert.equal(match('mbpYouLeft', 'Party ▏ ▬ Tenojkjsd9r has left the party.')?.groups?.leaver, 'Tenojkjsd9r')
assert.ok(match('mbpDisbanded', 'Party ▏ px3anosuko13 disbanded the party! If you wish to play with your friends again try /party!'))
assert.equal(match('mbpTransferred', 'Party ▏ Mezzo8812 is the new Party Leader')?.groups?.leader, 'Mezzo8812')
assert.ok(match('partyHeader', '  ▏ Your Party'))
assert.equal(match('partyOwnerLine', '  ▏ Owner: px3anosuko13')?.groups?.leader, 'px3anosuko13')
assert.equal(match('partyMembersLine', '  ▏ Members: (4) Tenojkjsd9r, Mezzo8812, 12Alto33, sdjsdjda1212')?.groups?.members, 'Tenojkjsd9r, Mezzo8812, 12Alto33, sdjsdjda1212')
assert.ok(match('mbpNotInParty', 'Party ▏ You are currently not in a party. Party up with a friend using /party invite <player>.'))
assert.equal(match('partyChat', 'Party ▏ miang_: =leave')?.groups?.speaker, 'miang_')
assert.equal(match('partyChat', 'Party ▏ miang_: =leave')?.groups?.message, '=leave')

const bus = new Bus()
const stage = new Map([['0:A', 'match'], ['1:B', 'match']])
const roles = new Map([['A', { role: 'leader', leader: 'A' }], ['B', { role: 'member', leader: 'A' }]])
const sent = []
const runs = []
const mkBot = (id, username) => ({
  id, username,
  isReady: () => true,
  engine: { pace: async () => 0, refund () {} },
  send: (text) => { sent.push([username, text]); stage.set(id, 'mode'); return true },
  run: async (action, vars) => { runs.push([username, action, vars]); return { status: 'OK' } }
})
const bots = [mkBot('0:A', 'A'), mkBot('1:B', 'B')]
const behaviour = new MasterCommandsBehaviour({
  cfg: { fleet: { master: 'miang_' } },
  bus,
  tracker: { entry: (name) => roles.get(name) ?? { role: 'none', leader: null } },
  presence: { stateOf: (id) => ({ stage: stage.get(id) ?? 'mode' }) },
  log: { info () {}, warn () {} }
}).attach({ bots })

bus.emit(EV.MC_CHAT, { botId: '0:A', bot: 'A', text: 'Party ▏ random_: =leave' })
await new Promise((resolve) => setTimeout(resolve, 20))
assert.equal(sent.length, 0)

bus.emit(EV.MC_CHAT, { botId: '0:A', bot: 'A', text: 'Party ▏ miang_: =leave' })
bus.emit(EV.MC_CHAT, { botId: '1:B', bot: 'B', text: 'Party ▏ miang_: =leave' })
await new Promise((resolve) => setTimeout(resolve, 40))
assert.deepEqual(sent, [['A', '/leave'], ['B', '/leave']])

bus.emit(EV.MC_CHAT, { botId: '0:A', bot: 'A', text: 'Party ▏ miang_: =promote' })
await new Promise((resolve) => setTimeout(resolve, 40))
assert.deepEqual(runs, [['A', 'promote', { player: 'miang_' }]])

behaviour.dispose()
console.log('pika party regression: PASS')
