// move-probe.mjs — does a bot that sends position packets actually move, as far as the SERVER
// is concerned?
//
// A bot believing it walked somewhere proves nothing. This asks the server for the player's real
// coordinates before and after, using the /where command the test plugin provides, and reports the
// distance the server saw. It also prints every correction the server sends back, because a
// rubber-band is the difference between "moving" and "the server disagreeing about where you are".
import mc from 'minecraft-protocol'
import { makeChatFlattener, sleep } from '../src/util.js'

const HOST = '127.0.0.1', PORT = 25566
const NAME = process.env.NAME || 'MoveProbe1'
const PASS = process.env.PASS || 'moveprobe123'
const SECONDS = Number(process.env.SECONDS || 8)
const SPEED = Number(process.env.SPEED || 0.215)     // blocks per tick; walking is ~0.215
const DIR_CHANGE_MS = Number(process.env.DIR_MS || 900)

const flatten = makeChatFlattener('1.8')
const t0 = Date.now()
const log = (...a) => console.log(`  ${String(Date.now() - t0).padStart(5)}ms`, ...a)

const c = mc.createClient({ host: HOST, port: PORT, username: NAME, version: '1.8.8', auth: 'offline' })
let authed = false
let pos = null          // our belief, seeded from the server
let corrections = 0, chatLines = []

c.on('login', () => {
  c.write('custom_payload', { channel: 'MC|Brand', data: Buffer.from([7, ...Buffer.from('mcbotctl', 'latin1')]) })
  c.write('settings', { locale: 'en_US', viewDistance: 4, chatFlags: 0, chatColors: true, skinParts: 0x7f })
})

// The server tells us where it thinks we are, on spawn and whenever it corrects us.
c.on('position', (p) => {
  const moved = pos ? Math.hypot(p.x - pos.x, p.y - pos.y, p.z - pos.z) : 0
  pos = { x: p.x, y: p.y, z: p.z, yaw: p.yaw ?? 0, pitch: p.pitch ?? 0 }
  if (moved > 1) { corrections++; log(`SERVER CORRECTION -> ${pos.x.toFixed(2)} ${pos.y.toFixed(2)} ${pos.z.toFixed(2)}  (was ${moved.toFixed(2)} blocks away)`) }
})

c.on('chat', (p) => {
  const t = flatten(p.message)
  if (!t) return
  if (!authed && /Please,\s*register/i.test(t)) { authed = true; setTimeout(() => c.chat(`/register ${PASS} ${PASS}`), 200); return }
  if (!authed && /Please,\s*login/i.test(t)) { authed = true; setTimeout(() => c.chat(`/login ${PASS}`), 200); return }
  if (!/joined the game|protection|Welcome|You own|accounts/i.test(t)) { chatLines.push(t); log('<<', t) }
})

c.on('kick_disconnect', (p) => log('KICKED:', flatten(p)))
c.on('end', (r) => log('END:', r))

const ask = (cmd) => new Promise((r) => { chatLines = []; c.chat(cmd); setTimeout(() => r(chatLines.slice()), 1200) })
const parsePos = (lines) => {
  for (const l of lines) {
    const m = l.match(/POS (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/)
    if (m) return { x: +m[1], y: +m[2], z: +m[3] }
  }
  return null
}
const sendPos = () => c.write('position_look', { x: pos.x, y: pos.y, z: pos.z, yaw: pos.yaw, pitch: pos.pitch, onGround: true })

async function main () {
  await sleep(6000)
  if (!authed) { log('never authenticated'); process.exit(1) }
  if (!pos) { log('the server never told us where we are — no position packet'); process.exit(2) }
  log(`spawn per server: ${pos.x.toFixed(2)} ${pos.y.toFixed(2)} ${pos.z.toFixed(2)}`)
  await sleep(1500)

  const before = parsePos(await ask('/where'))
  if (!before) { log('/where gave no position'); process.exit(3) }
  log(`/where before: ${before.x} ${before.y} ${before.z}`)

  // Random walk: a direction is held for a while and then re-rolled, which looks like a person
  // wandering rather than a bot vibrating on the spot.
  let dir = Math.random() * Math.PI * 2
  let lastRoll = Date.now()
  const ticks = SECONDS * 20
  for (let i = 0; i < ticks; i++) {
    if (Date.now() - lastRoll > DIR_CHANGE_MS) { dir = Math.random() * Math.PI * 2; lastRoll = Date.now() }
    pos.x += Math.cos(dir) * SPEED
    pos.z += Math.sin(dir) * SPEED
    // 1.8 yaw: 0 = south (+z), 90 = west (-x). Face where we walk so it reads as walking.
    pos.yaw = (Math.atan2(-Math.cos(dir), Math.sin(dir)) * 180 / Math.PI + 360) % 360
    sendPos()
    await sleep(50)
  }
  await sleep(600)

  const after = parsePos(await ask('/where'))
  if (!after) { log('/where gave no position after moving'); process.exit(4) }
  log(`/where after : ${after.x} ${after.y} ${after.z}`)

  const d = Math.hypot(after.x - before.x, after.z - before.z)
  const expected = SPEED * ticks
  console.log('')
  console.log(`  sent ${ticks} position packets over ${SECONDS}s`)
  console.log(`  SERVER saw the bot move : ${d.toFixed(2)} blocks  (expected up to ${expected.toFixed(2)} if nothing pushed back)`)
  console.log(`  server corrections      : ${corrections}`)
  console.log(`  verdict                 : ${d > 3 ? 'MOVING' : 'NOT MOVING'}`)
  c.end()
  process.exit(d > 3 ? 0 : 5)
}
main()
