// Verification for the parts that a live server cannot always demonstrate on demand:
// all five command statuses, the FSM legality table, and the reason decoder.
import assert from 'node:assert/strict'
import { classifyLine, STATUS, summarise } from '../src/engine/classify.js'
import { toRegexList, BASELINE_FAILURES, NOISE } from '../src/patterns.js'
import { flattenReason, stripLegacy, renderTemplate } from '../src/util.js'
import { Fsm, S } from '../src/fsm.js'
import { Bus, EV } from '../src/bus.js'
import { CommandEngine } from '../src/engine/engine.js'

let pass = 0, fail = 0
const t = (name, fn) => { try { fn(); pass++; console.log('  PASS', name) } catch (e) { fail++; console.log('  FAIL', name, '->', e.message) } }

// ---- 1. the reason decoder: all three encodings, the first of which is the real one ----
console.log('\n[1] kick/disconnect reason decoding (real wire bytes -> plain text)')
const WIRE_WRONG_PW = '"\\u00a7cWrong password!"'          // hex 00 38 22 c2a7 34 "Wrong password!" 22
t('JSON string literal (real 1.8.8 Spigot/AuthMe form)', () => assert.equal(flattenReason(WIRE_WRONG_PW), 'Wrong password!'))
t('JSON component object (mc-protocol server form)', () => assert.equal(flattenReason('{"text":"Wrong password!"}'), 'Wrong password!'))
t('plain string', () => assert.equal(flattenReason('nope'), 'nope'))
t('duplicate-name disconnect text', () => assert.equal(flattenReason('"\\u00a74The same username is already playing on the server!"'), 'The same username is already playing on the server!'))

// ---- 2. all five statuses, classified from real captured server strings ----
console.log('\n[2] command classification (real captured replies)')
const failure = toRegexList(BASELINE_FAILURES)
const noise = toRegexList(NOISE)
const c = (text, success) => classifyLine(text, { success: toRegexList(success), failure, noise })

t('FAILED: spigot unknown command  -> /p inv (no party plugin installed)', () => {
  const r = c('Unknown command. Type "/help" for help.', [])
  assert.equal(r.status, STATUS.FAILED); assert.equal(r.pattern, 'unknownCommand')
})
t('FAILED: bukkit no-permission -> /gamemode 1 as non-op', () => {
  assert.equal(c("I'm sorry, but you do not have permission to perform this command. Please contact the server administrators if you believe that this is in error.", []).pattern, 'noPermissionBukkit')
})
t('FAILED: authRequired beats a party success pattern (failure is tested first)', () => {
  const r = c('In order to use this command you must be authenticated!', ['joinedParty'])
  assert.equal(r.status, STATUS.FAILED); assert.equal(r.pattern, 'authRequired')
})
t('OK: loginSuccess', () => assert.equal(c('Successful login!', ['loginSuccess']).status, STATUS.OK))
t('OK: registerSuccess', () => assert.equal(c('Successfully registered!', ['registerSuccess']).status, STATUS.OK))
t('OK: a party invite actually landed', () => {
  const r = c('You were invited into Alice\'s party!', ['invitedBy'])
  assert.equal(r.status, STATUS.OK); assert.equal(r.groups.inviter, 'Alice')
})
t('NO_RESPONSE: output that matches nothing (e.g. /help) returns null', () => {
  assert.equal(c('--------- Help: Index (1/3) ---------------------', []), null)
})
t('noise is ignored, never a verdict', () => {
  assert.equal(c('You own 20 accounts:', []), null)
  assert.equal(c('Fleet01 joined the game.', ['loginSuccess']), null)
})
t('FAILED beats OK when a line matches both', () => {
  const r = classifyLine('Unknown command. Type "/help" for help.', { success: toRegexList([{ test: () => true, key: 'greedy' }]), failure, noise })
  assert.equal(r.status, STATUS.FAILED)
})

// ---- 3. anchoring: player chat must not be mistaken for a plugin error ----
console.log('\n[3] anchoring')
t('typed chat "<Troll> You are not in a party" does not match notInParty', () => {
  assert.equal(c('<Troll> You are not in a party', ['youJoined']), null)
})
t('/me output does not match either', () => assert.equal(c('* Troll waves', ['youJoined']), null))

// ---- 4. FSM: legal transitions only ----
console.log('\n[4] FSM')
t('CONNECTING -> PLAY -> AUTH -> READY is legal', () => {
  const f = new Fsm()
  f.to(S.CONNECTING); assert.equal(f.to(S.PLAY), true); assert.equal(f.to(S.AUTH), true); assert.equal(f.to(S.READY), true)
})
t('DISCONNECTED -> READY is refused (the 0ms-auth bug that made 0/7 READY)', () => {
  const f = new Fsm(); assert.equal(f.to(S.READY), false); assert.equal(f.state, S.DISCONNECTED)
})
t('a kick reaches DEAD from any live state', () => {
  for (const from of [S.PLAY, S.AUTH, S.READY]) { const f = new Fsm(from); assert.equal(f.to(S.DEAD), true) }
})
t('illegal transitions report instead of throwing', () => {
  let seen = null; const f = new Fsm(S.DEAD, (x) => { seen = x }); f.to(S.AUTH)
  assert.equal(seen.applied, false)
})

// ---- 5. engine gates: BLOCKED before READY, and never before PLAY ----
console.log('\n[5] engine gates')
const bus = new Bus()
const engine = new CommandEngine({ bus, log: { warn () {}, info () {} } })
engine.define('invite', { template: '/p inv {player}', success: ['invitedBy'] })
engine.define('__login', { template: '/login {password}', auth: true, success: ['loginSuccess'] })

const stub = (state, sendable = true) => ({
  id: 'stub', username: 'Stub', joinedAt: Date.now() - 5000,
  fsm: { state }, sendable: () => sendable, isReady: () => state === S.READY,
  send: (text) => { stub.sent.push(text); return true }
})
stub.sent = []

await (async () => {
  t('non-auth command while AUTH -> BLOCKED, nothing written', async () => {
    stub.sent.length = 0
    const r = await engine.run(stub(S.AUTH), 'invite', { player: 'X' })
    assert.equal(r.status, STATUS.BLOCKED); assert.equal(stub.sent.length, 0)
  })
  t('transport not in PLAY -> ERROR (the silent 0x00 guard)', async () => {
    stub.sent.length = 0
    const r = await engine.run(stub(S.READY, false), 'invite', { player: 'X' })
    assert.equal(r.status, STATUS.ERROR); assert.equal(stub.sent.length, 0)
  })
  t('unknown action -> ERROR', async () => {
    const r = await engine.run(stub(S.READY), 'nope', {})
    assert.equal(r.status, STATUS.ERROR)
  })
  t('auth command is exempt while in AUTH and IS written', async () => {
    stub.sent.length = 0
    const p = engine.run(stub(S.AUTH), '__login', { password: 'p' })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(stub.sent[0], '/login p')
    bus.emit(EV.MC_CHAT, { botId: 'stub', text: 'Successful login!', isOwnEcho: false })
    assert.equal((await p).status, STATUS.OK)
  })
  t('NO_RESPONSE when nothing matches in the window', async () => {
    const bot = stub(S.READY)
    const p = engine.run(bot, 'invite', { player: 'X' })   // default timeout 1500
    await new Promise((r) => setTimeout(r, 1800))
    assert.equal((await p).status, STATUS.NO_RESPONSE)
  })
  t('per-bot serialisation: two runs never overlap on one bot', async () => {
    const bot = stub(S.READY); const order = []
    const a = engine.run(bot, 'invite', { player: 'A' }).then(() => order.push('a'))
    const b = engine.run(bot, 'invite', { player: 'B' }).then(() => order.push('b'))
    await new Promise((r) => setTimeout(r, 3600))
    await Promise.all([a, b])
    assert.deepEqual(order.sort(), ['a', 'b'])
  })
  t('template rendering leaves unknown placeholders visible', () => {
    assert.equal(renderTemplate('/p inv {player}', {}), '/p inv {player}')
    assert.equal(renderTemplate('/p inv {player}', { player: 'M' }), '/p inv M')
  })
  t('summarise never rounds a failure away', () => {
    const s = summarise([{ status: 'OK', action: 'a', bot: 'b' }, { status: 'FAILED', action: 'a', bot: 'b' }])
    assert.equal(s.ok, 1); assert.equal(s.failed, 1); assert.equal(s.okRate, 0.5)
  })

  console.log(`\n=== ${pass} passed, ${fail} failed ===`)
  process.exit(fail ? 1 : 0)
})()
