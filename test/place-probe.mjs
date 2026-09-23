// place-probe.mjs — does bot.placeBlock actually place a block on 1.8.9?
//
// The load-bearing unknown before any bridging work. A bot that believes it placed a block proves
// nothing, so the SERVER is asked what is at the target coordinates, through the test plugin's
// /blockat command, before and after.
import mineflayer from 'mineflayer'
import { Vec3 } from 'vec3'

const HOST = '127.0.0.1', PORT = 25566
const NAME = process.env.NAME || 'PlaceProbe1'
const PASS = process.env.PASS || 'placeprobe123'
const bot = mineflayer.createBot({ host: HOST, port: PORT, username: NAME, version: '1.8.9', auth: 'offline' })

let lines = []
bot.on('messagestr', (t) => {
  lines.push(t)
  if (/Please,\s*register/i.test(t)) setTimeout(() => bot.chat(`/register ${PASS} ${PASS}`), 200)
  else if (/Please,\s*login/i.test(t)) setTimeout(() => bot.chat(`/login ${PASS}`), 200)
})
bot.on('kicked', (r) => console.log('  KICKED:', JSON.stringify(r).slice(0, 160)))
bot.on('error', (e) => console.log('  ERROR:', e.message))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ask = async (cmd, wait = 1200) => { lines = []; bot.chat(cmd); await sleep(wait); return lines.slice() }
const blockAt = async (v) => {
  const out = await ask(`/blockat ${v.x} ${v.y} ${v.z}`)
  const m = out.map((l) => l.match(/BLOCK (-?\d+) (-?\d+) (-?\d+) (\w+)/)).find(Boolean)
  return m ? m[4] : null
}

bot.once('spawn', async () => {
  await sleep(5000)
  await ask('/blocks')
  await ask('/reset')
  await sleep(4200)

  const p = bot.entity.position.floored()
  console.log(`  bot at ${p.x} ${p.y} ${p.z}  onGround=${bot.entity.onGround}`)
  console.log(`  held: ${bot.heldItem ? bot.heldItem.name + ' x' + bot.heldItem.count : '(nothing)'}`)

  // Find somewhere that is genuinely air and genuinely has a solid neighbour to place against.
  // The first attempt aimed at the block below-ahead and hit grass that was already there, which
  // is a bad target, not a broken placeBlock.
  let ref = null, target = null, face = null
  const below = new Vec3(p.x, p.y - 1, p.z)
  for (const [dx, dz, f] of [[1, 0, [1, 0, 0]], [-1, 0, [-1, 0, 0]], [0, 1, [0, 0, 1]], [0, -1, [0, 0, -1]]]) {
    const nb = bot.blockAt(new Vec3(p.x + dx, p.y - 1, p.z + dz))
    const up = bot.blockAt(new Vec3(p.x + dx, p.y, p.z + dz))
    if (nb && nb.boundingBox === 'block' && up && up.name === 'air') {
      ref = new Vec3(p.x + dx, p.y - 1, p.z + dz)
      target = new Vec3(p.x + dx, p.y, p.z + dz)
      face = new Vec3(0, 1, 0)      // place on the UP face of the block below the target
      break
    }
  }
  if (!target) {
    // fall back: place on top of the block the bot is standing on
    ref = below; target = new Vec3(p.x, p.y, p.z); face = new Vec3(0, 1, 0)
  }
  const refBlock = bot.blockAt(ref)
  const before = await blockAt(target)
  console.log(`  reference block ${ref}: ${refBlock ? refBlock.name : '?'}`)
  console.log(`  target ${target} BEFORE: ${before}`)

  // Equip explicitly rather than hoping the held slot is right.
  const wool = bot.inventory.items().find((i) => /wool/.test(i.name))
  if (!wool) { console.log('  no wool in inventory - /blocks did not work'); bot.quit(); process.exit(2) }
  await bot.equip(wool, 'hand')
  await sleep(300)
  console.log(`  equipped: ${bot.heldItem.name} in slot ${bot.quickBarSlot}`)

  // Look at the face we are placing against, the way a client would.
  await bot.lookAt(new Vec3(target.x + 0.5, target.y + 0.5, target.z + 0.5), true)
  await sleep(300)

  let placed = null
  try {
    placed = await bot.placeBlock(refBlock, face)
    console.log('  placeBlock returned:', placed === undefined ? 'undefined (no error)' : JSON.stringify(placed))
  } catch (e) {
    console.log('  placeBlock THREW:', e.message)
  }
  await sleep(1500)

  const after = await blockAt(target)
  console.log(`  target ${target} AFTER : ${after}`)
  console.log('')
  console.log(`  VERDICT: ${after && after !== 'AIR' && after !== before ? 'PLACED (' + after + ')' : 'NOT PLACED'}`)
  bot.quit()
  process.exit(after && after !== 'AIR' && after !== before ? 0 : 1)
})
