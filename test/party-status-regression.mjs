import assert from 'node:assert/strict'
import { Bus, EV } from '../src/bus.js'
import { PartyStatusBehaviour } from '../src/behaviour/party_status.js'
import { STATUS } from '../src/engine/classify.js'

const bus = new Bus()
let role = 'none'
let ready = true
const calls = []
const tracker = { entry: () => ({ role }) }
const engine = { get: (name) => ['on', 'off'].includes(name) ? { action: name } : null }
const bot = {
  id: '0:StatusBot', username: 'StatusBot', offline: false,
  isReady: () => ready,
  sendable: () => ready,
  run: async (action) => {
    calls.push(action)
    return { status: STATUS.OK, action, response: action === 'on' ? 'Status ▏ Successfully changed status to Online' : 'Status ▏ Successfully changed status to Invisible' }
  }
}
const fleet = { bots: [bot] }
const status = new PartyStatusBehaviour({ cfg: {}, bus, engine, tracker, log: { info () {}, warn () {} } }).attach(fleet)
const wait = () => new Promise((resolve) => setTimeout(resolve, 20))

bus.emit(EV.BOT_READY, { botId: bot.id, bot: bot.username })
await wait()
assert.deepEqual(calls, ['on'])
assert.equal(status.stateOf(bot.id), 'online')
assert.equal(status.blockReason(bot), null)

role = 'member'
bus.emit('party:membership', { bot: bot.username, role: 'member', leader: 'Leader' })
await wait()
assert.deepEqual(calls, ['on', 'off'])
assert.equal(status.stateOf(bot.id), 'offline')
assert.equal(bot.offline, true)

role = 'none'
bus.emit('party:membership', { bot: bot.username, role: 'none', leader: null })
await wait()
assert.deepEqual(calls, ['on', 'off', 'on'])
assert.equal(status.stateOf(bot.id), 'online')
assert.equal(bot.offline, false)

await status.prepareDisconnect(bot)
assert.deepEqual(calls, ['on', 'off', 'on', 'on'])
assert.equal(status.stateOf(bot.id), 'online')

ready = false
bus.emit(EV.BOT_STATE, { botId: bot.id, bot: bot.username, from: 'READY', to: 'DEAD' })
assert.equal(status.stateOf(bot.id), 'unknown')
status.dispose()
console.log('party status regression: PASS')
