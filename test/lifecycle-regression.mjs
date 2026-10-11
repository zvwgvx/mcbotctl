import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bus, EV } from '../src/bus.js'
import { Bot } from '../src/bot.js'
import { S } from '../src/fsm.js'
import { MenuBehaviour } from '../src/behaviour/menu.js'
import { Reporter } from '../src/report/reporter.js'

const quiet = { info () {}, warn () {} }

{
  const bus = new Bus()
  const bot = new Bot({
    username: 'DisposeTest', password: 'x', index: 0,
    cfg: { transport: 'mineflayer', server: {} },
    bus, engine: {}, log: quiet
  })
  bot.fsm.to(S.CONNECTING)
  bus.emit(EV.MC_JOIN, { botId: bot.id, bot: bot.username })
  assert.equal(bot.fsm.state, S.PLAY)
  bot.fsm.to(S.DEAD)
  bot.dispose()
  bus.emit(EV.MC_JOIN, { botId: bot.id, bot: bot.username })
  assert.equal(bot.fsm.state, S.DEAD)
}

{
  const bus = new Bus()
  let state = S.READY
  const bot = {
    id: '0:MenuAbort', username: 'MenuAbort', bus, menuDone: false,
    fsm: { get state () { return state } },
    isReady: () => state === S.READY,
    transport: {
      connected: true, state: 'play',
      selectHotbar: () => true,
      useItem: () => true
    }
  }
  const menu = new MenuBehaviour({
    cfg: { menu: { enabled: true, retries: 0, openTimeoutMs: 5000 } },
    bus, log: quiet
  })
  menu.attach(bot)
  const started = Date.now()
  const pending = menu.runForBot(bot)
  setTimeout(() => {
    state = S.DEAD
    bus.emit(EV.BOT_STATE, { botId: bot.id, bot: bot.username, from: S.READY, to: S.DEAD })
  }, 50)
  const result = await pending
  assert.equal(result.status, 'BLOCKED')
  assert.equal(menu.stateOf(bot.id).state, 'pending')
  assert.ok(Date.now() - started < 1000)
  menu.dispose()
}

{
  const bus = new Bus()
  const bot = {
    id: '0:MenuFail', username: 'MenuFail', bus, menuDone: false,
    fsm: { state: S.READY },
    isReady: () => true,
    transport: {
      connected: true, state: 'play',
      selectHotbar: () => true,
      useItem: () => true
    }
  }
  const menu = new MenuBehaviour({
    cfg: { menu: { enabled: true, retries: 0, openTimeoutMs: 20 } },
    bus, log: quiet
  })
  menu.attach(bot)
  const result = await menu.runForBot(bot)
  assert.equal(result.status, 'FAILED')
  assert.equal(menu.stateOf(bot.id).state, 'failed')
  assert.equal(menu.stateOf(bot.id).result?.error, result.error)
  menu.dispose()
}

{
  const dir = mkdtempSync(join(tmpdir(), 'mcbotctl-network-'))
  const network = join(dir, 'network.jsonl')
  const bus = new Bus()
  new Reporter({ bus, log: quiet, networkJsonlPath: network })
  bus.emit(EV.MC_END, {
    botId: '0:Net', bot: 'Net', reason: 'socketClosed',
    socket: { event: 'end', io: { keepAliveRx: 2, keepAliveTx: 2 } }
  })
  const row = JSON.parse(readFileSync(network, 'utf8').trim())
  assert.equal(row.topic, EV.MC_END)
  assert.equal(row.socket.io.keepAliveRx, 2)
}

console.log('lifecycle regression: PASS')
