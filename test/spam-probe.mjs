// spam-probe.mjs — find the real chat rate at which this server kicks with "disconnect.spam".
//
// The engine paces sends, but the pace was chosen from a guess about vanilla's threshold. This
// measures it: connect one bot, register it, then push commands at a fixed rate until the
// server drops it. The answer decides minSendGapMs.
import mc from 'minecraft-protocol'
import { makeChatFlattener } from '../src/util.js'
import { sleep } from '../src/util.js'

const HOST = '127.0.0.1', PORT = 25566
const flatten = makeChatFlattener('1.8')
const results = []

async function trial (perSecond) {
  const name = `SpamP${String(perSecond).replace('.', '')}`
  const gap = Math.round(1000 / perSecond)
  const c = mc.createClient({ host: HOST, port: PORT, username: name, version: '1.8.8', auth: 'offline' })
  let kicked = null, authed = false, sent = 0
  await new Promise((resolve) => {
    const done = () => resolve()
    c.on('login', () => c.write('settings', { locale: 'en_US', viewDistance: 4, chatFlags: 0, chatColors: true, skinParts: 0x7f }))
    c.on('chat', (p) => {
      const t = flatten(p.message)
      if (!authed && /register/i.test(t)) { authed = true; setTimeout(() => c.chat(`/register ${name}pw ${name}pw`), 200) }
      else if (!authed && /login/i.test(t)) { authed = true; setTimeout(() => c.chat(`/login ${name}pw`), 200) }
    })
    c.on('kick_disconnect', (p) => { kicked = flatten(p); done() })
    c.on('end', () => done())
    // start pushing once authenticated
    const iv = setInterval(async () => {
      if (!authed) return
      sent++
      if (sent > perSecond * 12) { clearInterval(iv); kicked = kicked ?? 'SURVIVED'; done(); return }
      try { c.chat('/p list') } catch { clearInterval(iv); done() }
    }, gap)
    setTimeout(() => { clearInterval(iv); if (!kicked) kicked = 'SURVIVED'; done() }, perSecond > 0 ? (12000 / perSecond) * 12 + 15000 : 20000)
  })
  try { c.end() } catch {}
  results.push({ perSecond, gap, sent, kicked })
  console.log(`  ${String(perSecond).padStart(5)}/s (gap ${String(gap).padStart(4)}ms)  sent=${String(sent).padStart(3)}  -> ${kicked}`)
  await sleep(2500)
}

const rates = process.argv.slice(2).map(Number).filter((n) => n > 0)
console.log('\nrate probe (12 seconds of sustained sending per rate)\n')
for (const r of (rates.length ? rates : [20, 10, 5, 3, 2])) await trial(r)

console.log('\n=== VERDICT ===')
const safe = results.filter((r) => r.kicked === 'SURVIVED').map((r) => r.perSecond)
const bad = results.filter((r) => r.kicked !== 'SURVIVED').map((r) => r.perSecond)
console.log(`  survived: ${safe.join(', ') || '(none)'}`)
console.log(`  kicked:   ${bad.join(', ') || '(none)'}`)
process.exit(0)
