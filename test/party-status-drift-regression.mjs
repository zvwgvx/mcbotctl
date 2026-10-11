import assert from 'node:assert/strict'
import { Bus, EV } from '../src/bus.js'
import { PartyStatusBehaviour } from '../src/behaviour/party_status.js'
import { STATUS } from '../src/engine/classify.js'

// Another party path can change /off after the status reconciler last confirmed /on.
// A bot outside the party must then be brought online again before it can be invited.
const bus = new Bus()
const sent = []
const bot = {
  id: '0:Outside', username: 'Outside', offline: false,
  isReady: () => true,
  sendable: () => true,
  run: async (action) => {
    sent.push(action)
    return { status: STATUS.OK, action }
  }
}
const engine = { get: (action) => ['on', 'off'].includes(action) ? { action } : null }
const tracker = { entry: () => ({ role: 'none', leader: null }) }
const status = new PartyStatusBehaviour({ cfg: {}, bus, engine, tracker, log: { info () {}, warn () {} } })
status.attach({ bots: [bot] })

bus.emit(EV.BOT_READY, { botId: bot.id, bot: bot.username })
await new Promise((resolve) => setImmediate(resolve))
assert.deepEqual(sent, ['on'])

bot.offline = true
assert.match(status.blockReason(bot), /not confirmed online/)
await status.ensureOnline(bot)
assert.deepEqual(sent, ['on', 'on'])
assert.equal(bot.offline, false)
assert.equal(status.blockReason(bot), null)

status.dispose()
console.log('party status drift regression: PASS')
