// Controlled experiment: does sending /login at MC_JOIN (0ms) corrupt framing vs a delay?
// Uses the real Transport so the result applies to the shipped code.
import { Bus, EV } from '../src/bus.js'
import { Transport } from '../src/transport/client.js'

const server = { host: '127.0.0.1', port: 25566, version: '1.8.9', chatVersion: '1.8', checkTimeoutIntervalMs: 60000 }
const GROUPS = [
  { label: 'IMMEDIATE(+0ms)', delayMs: 0, accts: [['Fleet01','fleet12345'],['Fleet02','fleet12345'],['Fleet03','fleet12345'],['Fleet04','fleet12345'],['Fleet05','fleet12345'],['Fleet06','fleet12345'],['Fleet07','fleet12345']] },
  { label: 'DELAYED(+400ms)', delayMs: 400, accts: [['BlindA1','blind12345'],['BlindA2','blind12345'],['BlindA3','blind12345'],['Tenor','matkhau4'],['Baritone','matkhau5'],['Bass','matkhau6'],['ProbeAlpha','probe12345']] }
]

const bus = new Bus()
const byBot = new Map()      // botId -> record
bus.on(EV.MC_END, (e) => { const r = byBot.get(e.botId); if (r && e.reason !== 'clientClosed') r.endReason = String(e.reason) })

const jobs = []
for (const g of GROUPS) {
  for (const [user, pass] of g.accts) {
    const botId = `${g.label}:${user}`
    const rec = { label: g.label, user, endReason: null, sentAt: null, authed: false, err: null }
    byBot.set(botId, rec)
    const t = new Transport({ botId, username: user, server, log: { warn () {}, info () {} }, bus })
    jobs.push((async () => {
      try {
        await t.connect()
        const joinedAt = t.joinedAt
        rec.sentAt = Date.now() - joinedAt + g.delayMs
        await new Promise((r) => setTimeout(r, g.delayMs))
        t.send(`/login ${pass}`)
        await new Promise((r) => setTimeout(r, 2500))
        rec.authed = t.state === 'play'
      } catch (e) { rec.err = e.text ?? e.message } finally { t.end('probeDone') }
    })())
    await new Promise((r) => setTimeout(r, 300))
  }
}
await Promise.all(jobs)
await new Promise((r) => setTimeout(r, 800))

console.log('bot                 sent@   result   teardown')
for (const r of byBot.values()) {
  const framing = r.endReason && /Internal Exception|DecoderException|IndexOutOfBounds/.test(r.endReason)
  console.log(`${r.user.padEnd(12)} ${String(r.sentAt).padStart(5)}ms  ${r.authed ? 'PLAY ' : 'DOWN '} ${framing ? 'FRAMING-CORRUPTION' : (r.endReason ? r.endReason.slice(0, 40) : 'clean')} ${r.err ? '| ' + r.err : ''}`)
}
console.log('\n=== SUMMARY ===')
for (const g of GROUPS) {
  const rs = [...byBot.values()].filter((r) => r.label === g.label)
  const framing = rs.filter((r) => r.endReason && /DecoderException|IndexOutOfBounds/.test(r.endReason)).length
  console.log(`${g.label}: alive=${rs.filter((r) => r.authed).length}/${rs.length}  framingCorruption=${framing}`)
}
process.exit(0)
