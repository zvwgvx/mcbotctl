import assert from 'node:assert/strict'
import { Bot } from '../src/bot.js'
import { Bus, EV } from '../src/bus.js'
import { S } from '../src/fsm.js'

const bus = new Bus()
const bot = new Bot({
  username: 'GenerationBot',
  password: 'x',
  index: 0,
  cfg: { transport: 'mineflayer', server: {} },
  bus,
  engine: {},
  log: { info () {}, warn () {} }
})

bot.transport.activeSession = { generation: 2 }
bot.fsm.to(S.CONNECTING)
bus.emit(EV.MC_JOIN, {
  botId: bot.id,
  bot: bot.username,
  connection: { generation: 2, current: true }
})
assert.equal(bot.fsm.state, S.PLAY)

bus.emit(EV.MC_END, {
  botId: bot.id,
  bot: bot.username,
  reason: 'old socket finally closed',
  connection: { generation: 1, current: false }
})
assert.equal(bot.fsm.state, S.PLAY, 'a stale terminal event killed the current connection')

bus.emit(EV.MC_END, {
  botId: bot.id,
  bot: bot.username,
  reason: 'current socket closed',
  connection: { generation: 2, current: true }
})
assert.equal(bot.fsm.state, S.DEAD, 'the current terminal event was ignored')

bot.dispose()
console.log('connection generation regression: PASS')
