// p3.mjs — the dangerous paths: quick-command kick, denied command, wrong-password kick,
// and the exact raw JSON shapes of 1.8 chat.
import mc from 'minecraft-protocol'
import ChatMessage from 'prismarine-chat'
const C = ChatMessage('1.8.8')
const T0 = Date.now()
const T = () => `+${String(Date.now() - T0).padStart(6)}ms`
const strip = s => s.replace(/§./g, '')
const pc = raw => { try { return strip(C.fromNotch(raw).toString()) } catch { return '<err>' } }
const sleep = ms => new Promise(r => setTimeout(r, ms))

function spawn (user, opts = {}) {
  const b = { user, joinedAt: null, kick: null, ended: null, lines: [] }
  b.client = mc.createClient({ host: '127.0.0.1', port: 25566, username: user, version: '1.8.8', auth: 'offline' })
  b.client.on('login', () => { b.joinedAt = Date.now(); console.log(`${T()} [${user}] JOIN_GAME`) })
  b.client.on('chat', p => {
    const text = pc(p.message)
    b.lines.push(text)
    console.log(`${T()} [${user}] <<${text}>>   RAWJSON=${p.message.slice(0, 200)}`)
  })
  b.client.on('kick_disconnect', p => {
    b.kick = pc(p.reason)
    console.log(`${T()} [${user}] *** KICKED *** <<${b.kick}>> RAW=${JSON.stringify(p.reason)} state=${b.client.state} tcpOpen=${!b.client.socket?.destroyed}`)
  })
  b.client.on('error', e => console.log(`${T()} [${user}] error ${e.message}`))
  b.client.on('end', r => { b.ended = r; console.log(`${T()} [${user}] end=${r}`) })
  b.say = (s) => {
    const w = b.client.state === 'play' && typeof b.client.chat === 'function'
    console.log(`${T()} [${user}] SEND ${JSON.stringify(s)} (state=${b.client.state} writable=${w} joined+${b.joinedAt ? Date.now() - b.joinedAt : '?'}ms)`)
    if (!w) { console.log(`${T()} [${user}] !! DROPPED (would be a silent 0x00 frame)`); return false }
    b.client.chat(s); return true
  }
  return b
}

// ---- (a) command at +400ms after join: quick-command guard ----
console.log('=== (a) non-allowlisted command 400ms after join ===')
const a = spawn('QwFast1')
await sleep(600)
await sleep(2000 + 400 - (Date.now() - T0))   // land ~400ms after ITS join
a.say('/p list')
await sleep(2000)
console.log(`   -> kick=${a.kick}  ended=${a.ended}  state=${a.client.state} ended=${a.client.ended}`)
try { a.client.end() } catch {}

// ---- (b) unauthenticated non-allowlisted command, well past 1000ms ----
console.log('\n=== (b) unauthenticated /p list at join+3000ms ===')
const b = spawn('QwSlow1')
await sleep(2000 + 3000 - (Date.now() - T0))
b.say('/p list')
await sleep(2000)
try { b.client.end() } catch {}

// ---- (c) register, then wrong password ----
console.log('\n=== (c) register then wrong password ===')
const c = spawn('QwWrong1')
await sleep(2000 + 2500 - (Date.now() - T0))
c.say('/register goodpass1 goodpass1')
await sleep(1500)
try { c.client.end() } catch {}
await sleep(1200)
const c2 = spawn('QwWrong1')
await sleep(2000 + 2500 - (Date.now() - T0))
c2.say('/login totallyWRONG')
await sleep(2500)
console.log(`   -> kick=${c2.kick} raw=${JSON.stringify(c2.kick)}`)

// ---- (d) raw JSON for public chat vs emote ----
console.log('\n=== (d) raw JSON of chat types ===')
const d = spawn('Mezzo')   // registered in phase A
await sleep(2000 + 2500 - (Date.now() - T0))
d.say('/login matkhau2')
await sleep(1200)
const e = spawn('Alto')
await sleep(2000 + 2500 - (Date.now() - T0))
e.say('/login matkhau3')
await sleep(1500)
console.log('--- now talking ---')
e.say('plain chat from Alto')
await sleep(1200)
e.say('/me waves at everyone')
await sleep(1500)

console.log('\n=== closing ===')
for (const x of [a, b, c2, d, e]) { try { x.client.end() } catch {} }
setTimeout(() => process.exit(0), 1200)
