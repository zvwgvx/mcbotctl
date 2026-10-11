import assert from 'node:assert/strict'
import { Bot } from '../src/bot.js'
import { Bus, EV } from '../src/bus.js'

const bus = new Bus()
const route = { kind: 'proxy', mode: 'balanced', blocked: false, proxy: { id: 'p-new', host: '127.0.0.1', port: 1080 } }
const failures = []
const successes = []
const proxyManager = {
  routeFor: () => route,
  publicRouteFor: () => ({ kind: 'proxy', proxyId: route.proxy.id }),
  reportFailure: (_name, usedRoute, error) => { failures.push({ route: usedRoute, error }) },
  reportSuccess: (_name, usedRoute) => { successes.push(usedRoute) }
}
const bot = new Bot({
  username: 'RouteBot', password: 'x', index: 0,
  cfg: { transport: 'mineflayer', server: {} },
  proxyManager, bus, engine: {}, log: { info () {}, warn () {} }
})
bot.activeRoute = { kind: 'proxy', proxy: { id: 'p-old' } }
bot.transport.connect = async () => {
  bus.emit(EV.MC_END, { botId: bot.id, bot: bot.username, reason: 'connect reset' })
  const error = Object.assign(new Error('connect reset'), { code: 'ECONNRESET' })
  throw error
}
await assert.rejects(bot.start(), /connect reset/)
assert.equal(failures.length, 1)
assert.equal(failures[0].route.proxy.id, 'p-new')
assert.equal(bot.activeRoute.proxy.id, 'p-new')

failures.length = 0
bot.transport.connect = async () => {
  bus.emit(EV.MC_JOIN, { botId: bot.id, bot: bot.username })
  return bot.transport
}
await bot.start()
assert.equal(successes.at(-1).proxy.id, 'p-new')
bus.emit(EV.MC_END, { botId: bot.id, bot: bot.username, reason: 'live reset', socket: { errorCode: 'ECONNRESET' } })
assert.equal(failures.length, 1)
assert.equal(failures[0].route.proxy.id, 'p-new')
bot.dispose()
console.log('proxy attempt-route regression: PASS')
