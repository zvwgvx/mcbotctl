import assert from 'node:assert/strict'
import { Bus, EV } from '../src/bus.js'
import { MenuBehaviour } from '../src/behaviour/menu.js'
import { STATUS } from '../src/engine/classify.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bus = new Bus()
const cfg = {
  menu: {
    enabled: true,
    gateParty: true,
    maxRecoveryAttempts: 0,
    recoveryBaseMs: 500,
    recoveryMaxMs: 500,
    reconnectEveryRecoveryAttempts: 1
  }
}
const menu = new MenuBehaviour({ cfg, bus, log: { info () {}, warn () {} } })
const bot = {
  id: '0:bot',
  username: 'bot',
  menuDone: false,
  isReady: () => true
}
let reconnects = 0
menu.setRecoveryHandler(async () => { reconnects++ })
menu.runForBot = async () => {
  const result = { status: STATUS.FAILED, error: 'selector unavailable' }
  menu.byBot.set(bot.id, { state: 'failed', result })
  return result
}
menu.attach(bot)
bus.emit(EV.BOT_READY, { botId: bot.id, bot: bot.username })
await sleep(700)
assert.equal(reconnects, 1, 'menu recovery did not escalate to a clean reconnect')
menu.dispose()
console.log('menu reconnect escalation regression: PASS')
