// accel-probe.mjs — does mineflayer's 1.8.9 movement RAMP like a player, or snap to full speed?
//
// This is the load-bearing question for "realistic movement". Open issue #3283 reports an
// anti-cheat flagging mineflayer for reaching top speed without the vanilla acceleration ramp, so
// it cannot be assumed either way. Measured here, per physics tick.
//
// Vanilla 1.8 reference values, for comparison:
//   walk   terminal ~0.221 blocks/tick (4.317 m/s)
//   sneak  ~0.066 (30% of walk, 1.3 m/s)
//   sprint ~0.287 (5.6 m/s)
//   jump   apex +1.252 blocks
import mineflayer from 'mineflayer'
import { pathfinder } from 'mineflayer-pathfinder'

const HOST = '127.0.0.1', PORT = 25566
const NAME = process.env.NAME || 'AccelProbe1'
const PASS = process.env.PASS || 'accelprobe123'

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: NAME, version: '1.8.9', auth: 'offline' })
bot.loadPlugin(pathfinder)

let authed = false
const samples = []
let recording = false

bot.on('messagestr', (t) => {
  if (!authed && /Please,\s*register/i.test(t)) { authed = true; setTimeout(() => bot.chat(`/register ${PASS} ${PASS}`), 200) }
  else if (!authed && /Please,\s*login/i.test(t)) { authed = true; setTimeout(() => bot.chat(`/login ${PASS}`), 200) }
  if (/POS /.test(t)) console.log('  server says:', t)
})

bot.on('physicsTick', () => {
  if (!recording) return
  const v = bot.entity.velocity
  samples.push({ h: Math.hypot(v.x, v.z), y: v.y, y0: bot.entity.position.y, ground: bot.entity.onGround })
})

bot.on('kicked', (r) => console.log('  KICKED:', JSON.stringify(r).slice(0, 200)))
bot.on('error', (e) => console.log('  ERROR:', e.message))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function reset () {
  for (const c of ['forward', 'back', 'left', 'right', 'sneak', 'sprint', 'jump']) bot.setControlState(c, false)
  bot.chat('/reset')
  await sleep(4000)          // fall, land, settle
}

async function measure (label, setup, ticks = 45) {
  samples.length = 0
  await reset()
  console.log(`  [${label}] onGround=${bot.entity.onGround} y=${bot.entity.position.y.toFixed(1)} block below=${bot.blockAt(bot.entity.position.offset(0,-1,0))?.name ?? '?'}`)
  samples.length = 0
  recording = true
  setup()
  await sleep(ticks * 50)
  recording = false
  for (const c of ['forward', 'back', 'left', 'right', 'sneak', 'sprint', 'jump']) bot.setControlState(c, false)
  const hs = samples.map((s) => s.h)
  const peak = Math.max(...hs, 0)
  const first = hs.findIndex((h) => h > 0.05)
  const reach = hs.findIndex((h) => h >= peak * 0.99)
  console.log(`  ${label.padEnd(26)} peak=${peak.toFixed(4)} b/t   starts tick ${first}   reaches peak tick ${reach} (${(reach * 50 / 1000).toFixed(2)}s)`)
  console.log(`  ${''.padEnd(26)} ramp: ${hs.filter((_, i) => i < 22 && i % 3 === 0).map((h) => h.toFixed(3)).join(' ')}`)
  return { peak, rampTicks: reach }
}

async function main () {
  await new Promise((r) => bot.once('spawn', r))
  console.log('  spawned')
  await sleep(4000)
  if (!authed) console.log('  (not authenticated - measuring anyway, but the server may block it)')
  await sleep(1500)

  await measure('walk', () => bot.setControlState('forward', true))
  await measure('sprint', () => { bot.setControlState('sprint', true); bot.setControlState('forward', true) })
  await measure('sneak', () => { bot.setControlState('sneak', true); bot.setControlState('forward', true) })
  await measure('walk + one jump', () => { bot.setControlState('forward', true); setTimeout(() => bot.setControlState('jump', true), 800); setTimeout(() => bot.setControlState('jump', false), 1100) })

  bot.chat('/where')
  await sleep(1200)
  bot.quit()
  process.exit(0)
}
main()
