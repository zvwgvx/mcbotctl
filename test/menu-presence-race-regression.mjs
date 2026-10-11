import assert from 'node:assert/strict'
import { Bus } from '../src/bus.js'
import { MenuBehaviour } from '../src/behaviour/menu.js'

const bus = new Bus()
const cfg = { menu: { enabled: true, gateParty: true } }
const menu = new MenuBehaviour({ cfg, bus, log: { info () {}, warn () {} } })
const bot = {
  id: '0:testbot',
  username: 'testbot',
  menuDone: false,
  isReady: () => true
}

menu.attach(bot)
assert.equal(menu.stateOf(bot.id).state, 'pending')

menu.runs.set(bot.id, new AbortController())
bus.emit('bedwars:presence', { botId: bot.id, joined: true, stage: 'mode', source: 'sidebar' })
assert.equal(menu.stateOf(bot.id).state, 'pending')
assert.notEqual(menu.blockReason(bot), null)

menu.runs.delete(bot.id)
bus.emit('bedwars:presence', { botId: bot.id, joined: true, stage: 'mode', source: 'sidebar' })
assert.equal(menu.stateOf(bot.id).state, 'done')
assert.equal(menu.blockReason(bot), null)

menu.dispose()
console.log('menu presence race regression: PASS')
