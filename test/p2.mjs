// p2.mjs — verify the V1 design against the REAL Paper 1.8.8 + AuthMe 5.6.0 server.
import mc from 'minecraft-protocol'
import { readFileSync } from 'node:fs'
import ChatMessage from 'prismarine-chat'

const C = ChatMessage('1.8.8')
const T0 = Date.now()
const T = () => `+${String(Date.now() - T0).padStart(6)}ms`
const strip = s => s.replace(/§./g, '')
// the OLD hand-rolled flattener, kept only to prove it is wrong
const naive = (m) => {
  if (m == null) return ''
  if (typeof m === 'string') { const s = m.trim(); if (s.startsWith('{')) { try { return naive(JSON.parse(s)) } catch { return m } } return m }
  if (Array.isArray(m)) return m.map(naive).join('')
  if (typeof m === 'object') { let o = ''; if (typeof m.text === 'string') o += m.text; if (Array.isArray(m.extra)) o += m.extra.map(naive).join(''); if (typeof m.translate === 'string' && !m.text) o += m.translate; return o }
  return String(m)
}
const pc = raw => { try { return strip(C.fromNotch(raw).toString()) } catch (e) { return '<pc-error ' + e.message + '>' } }

const accounts = readFileSync('/home/zvwgvx/mcbotctl/accounts/accounts.txt', 'utf8')
  .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  .map(l => { const i = l.indexOf(':'); return { user: l.slice(0, i), pass: l.slice(i + 1) } }).slice(0, 7)
console.log(`accounts: ${accounts.map(a => a.user).join(', ')}\n`)

const RE = {
  loginReq: /Please,\s*login with the command/i,
  regReq: /Please,\s*register to the server with the command/i,
  loginOk: /Successful login!/i,
  regOk: /Successfully registered!/i,
  wrongPw: /Wrong password!/i,
  alreadyIn: /already logged in/i,
  notReg: /isn't registered/i,
  deniedCmd: /must be authenticated/i,
  quickCmd: /used a command too fast/i,
  unknownCmd: /^Unknown command\. Type "\/help" for help\.?$/,
}

function spawn ({ user, pass }, tag) {
  const b = { user, pass, tag, joinedAt: null, promptAt: null, sentAt: null, authedAt: null, state: null, chat: [], kicked: null }
  b.client = mc.createClient({ host: '127.0.0.1', port: 25566, username: user, version: '1.8.8', auth: 'offline' })
  b.client.on('login', () => { b.joinedAt = Date.now(); b.state = 'play'; console.log(`${T()} [${tag}/${user}] JOIN_GAME (0x01) state=${b.client.state} typeofChat=${typeof b.client.chat}`) })
  b.client.on('chat', p => {
    const raw = p.message
    const text = pc(raw)
    b.chat.push({ text, at: Date.now() })
    if (RE.loginReq.test(text) || RE.regReq.test(text)) {
      if (b.promptAt === null) console.log(`${T()} [${tag}/${user}] PROMPT#1 <<${text}>>`)
      else console.log(`${T()} [${tag}/${user}] PROMPT repeat (${((Date.now() - b.promptAt) / 1000).toFixed(1)}s since first)`)
      if (b.promptAt === null) {
        b.promptAt = Date.now()
        const cmd = RE.regReq.test(text) ? `/register ${pass} ${pass}` : `/login ${pass}`
        const canWrite = b.client.state === 'play' && typeof b.client.chat === 'function'
        console.log(`${T()} [${tag}/${user}] prompt->join delta=${b.promptAt - b.joinedAt}ms  WRITABLE=${canWrite}`)
        if (!canWrite) { console.log(`${T()} [${tag}/${user}] !! NOT WRITABLE, dropping`); return }
        b.sentAt = Date.now(); b.client.chat(cmd)
        console.log(`${T()} [${tag}/${user}] SENT ${cmd.replace(pass, '***')}`)
      }
    } else if (RE.loginOk.test(text) || RE.regOk.test(text) || RE.alreadyIn.test(text)) {
      if (!b.authedAt) { b.authedAt = Date.now(); console.log(`${T()} [${tag}/${user}] AUTHED <<${text}>> join->sent=${b.sentAt - b.joinedAt}ms sent->ok=${b.authedAt - b.sentAt}ms`) }
    } else if (RE.wrongPw.test(text)) console.log(`${T()} [${tag}/${user}] <<WRONG PASSWORD>>`)
    else {
      const pos = p.position
      const show = text.slice(0, 110)
      console.log(`${T()} [${tag}/${user}] chat pos=${pos} pc=<<${show}>> naive=<<${naive(raw).slice(0, 110)}>>`)
    }
  })
  b.client.on('kick_disconnect', p => {
    const r = pc(p.reason)
    b.kicked = r
    console.log(`${T()} [${tag}/${user}] KICKED <<${r}>> | raw=${JSON.stringify(p.reason)} | joinedAt+${b.joinedAt ? Date.now() - b.joinedAt : '?'}ms`)
  })
  b.client.on('error', e => console.log(`${T()} [${tag}/${user}] error ${e.message}`))
  b.client.on('end', r => { console.log(`${T()} [${tag}/${user}] end=${r}`) })
  return b
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- PHASE A: 7 bots, prompt-driven login ----------
console.log('=== PHASE A: 7 bots ===')
const bots = []
for (const a of accounts) {
  bots.push(spawn(a, 'A'))
  await sleep(300)
}
// barrier: wait for all 7 authed (or 25s)
const t = Date.now()
while (Date.now() - t < 25000 && bots.some(b => !b.authedAt)) await sleep(100)
const ok = bots.filter(b => b.authedAt)
console.log(`\nAUTH RESULT ${ok.length}/7  (wall ${Date.now() - t}ms)\n`)

if (ok.length >= 2) {
  const [leader, member] = ok
  // 1200ms guard from that bot's own join, then the operator-configured command
  const wait = Math.max(0, 1300 - (Date.now() - leader.joinedAt))
  console.log(`--- invite probe: waiting ${wait}ms (AuthMe denyCommandsBeforeMilliseconds=1000 guard) ---`)
  await sleep(wait)
  console.log(`${T()} [${leader.user}] SEND /p inv ${member.user}  (joined+${Date.now() - leader.joinedAt}ms)`)
  leader.client.chat(`/p inv ${member.user}`)
  await sleep(1500)
  // plain-chat flatten check: the OTHER flattener is the whole point
  console.log(`${T()} [${member.user}] SEND plain chat "hello plain chat"`)
  member.client.chat('hello plain chat')
  await sleep(2000)
}

// ---------- PHASE B: quick-command kick ----------
console.log('\n=== PHASE B: quick-command guard ===')
const q = spawn({ user: 'Tenor', pass: 'matkhau4' }, 'B')
await sleep(3000)   // let it join + get prompt, but do NOT log in
console.log(`${T()} [B/Tenor] unauthenticated, sending /p inv (expect AUTH-DENIED, not a kick)`)
q.client.chat('/p inv Alto')
await sleep(1500)
console.log(`${T()} [B/Tenor] sending a NON-allowlisted command within 1000ms of join? joinedAt delta=${Date.now() - q.joinedAt}ms`)
q.client.chat('/p list')
await sleep(2000)

console.log('\n=== closing ===')
bots.forEach(b => { try { b.client.end() } catch {} })
setTimeout(() => process.exit(0), 1500)
