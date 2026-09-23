// gui-probe.mjs — verify the exact packets needed to drive a chest-menu GUI on 1.8.9.
//
// Everything here is a hypothesis until this script says otherwise: which values a right-click
// needs when the bot is not looking at a block, whether window_click needs the item field, and
// whether the action counter is checked. Prints every GUI packet the server sends back.
import mc from 'minecraft-protocol'
import { makeChatFlattener, sleep } from '../src/util.js'

const HOST = '127.0.0.1', PORT = 25566
const NAME = process.env.NAME || 'GuiProbe1'
const PASS = process.env.PASS || 'guiprobe123'
const HOTBAR = Number(process.env.HOTBAR ?? 5)          // 1-indexed, as a player counts
const ROW = Number(process.env.ROW ?? 4)
const COL = Number(process.env.COL ?? 4)
const TARGET_SLOT = (ROW - 1) * 9 + (COL - 1)

const flatten = makeChatFlattener('1.8')
const t0 = Date.now()
const log = (...a) => console.log(`  ${String(Date.now() - t0).padStart(5)}ms`, ...a)

const c = mc.createClient({ host: HOST, port: PORT, username: NAME, version: '1.8.8', auth: 'offline' })
let authed = false, opened = null, windowAction = 0

c.on('login', () => {
  log('joined')
  c.write('custom_payload', { channel: 'MC|Brand', data: Buffer.from([7, ...Buffer.from('mcbotctl', 'latin1')]) })
  c.write('settings', { locale: 'en_US', viewDistance: 4, chatFlags: 0, chatColors: true, skinParts: 0x7f })
})

c.on('chat', (p) => {
  const t = flatten(p.message)
  if (!t) return
  log('<<', t)
  if (!authed && /Please,\s*register/i.test(t)) { authed = true; setTimeout(() => c.chat(`/register ${PASS} ${PASS}`), 200) }
  else if (!authed && /Please,\s*login/i.test(t)) { authed = true; setTimeout(() => c.chat(`/login ${PASS}`), 200) }
})

// Every GUI packet the server sends, so the shape of a real menu is on the record.
for (const name of ['open_window', 'close_window', 'window_items', 'set_slot', 'held_item_slot', 'transaction', 'confirm_transaction']) {
  c.on(name, (p) => {
    if (name === 'window_items') {
      const filled = (p.items || []).map((it, i) => (it && it.itemCount ? `${i}:${it.itemId}x${it.itemCount}` : null)).filter(Boolean)
      log(`PKT ${name} windowId=${p.windowId} filled=[${filled.join(' ')}]`)
      return
    }
    if (name === 'set_slot' && !p.item) return
    log(`PKT ${name} ${JSON.stringify(p).slice(0, 180)}`)
  })
}

async function main () {
  await sleep(6000)
  if (!authed) { log('never authenticated - stop'); process.exit(1) }

  // 1. select hotbar slot 5
  log(`>> held_item_slot slotId=${HOTBAR - 1}  (the ${HOTBAR}th slot)`)
  c.write('held_item_slot', { slotId: HOTBAR - 1 })
  await sleep(600)

  // 2. right-click. Location -1/-1/-1 plus direction -1 is what the vanilla 1.8 client sends when
  //    the raytrace misses, i.e. "use the held item in the air".
  // An empty `slot` field is { blockId: -1 } on the wire, not null: protodef reads .blockId off
  // whatever is passed and throws on null. Learned by trying null first.
  const EMPTY = { blockId: -1 }
  log('>> block_place location=-1,-1,-1 direction=-1 heldItem=' + JSON.stringify(EMPTY))
  c.write('block_place', {
    location: { x: -1, y: -1, z: -1 },
    direction: -1,
    heldItem: EMPTY,
    cursorX: 0, cursorY: 0, cursorZ: 0
  })
  await sleep(2500)
  if (!opened) { log('!! no open_window arrived - the right-click did not open a menu'); process.exit(2) }

  // 3. click the target slot with the RIGHT mouse button. mode 0 is a normal click; the action
  //    number must increase per click inside one window or the server drops it as a desync.
  windowAction += 1
  log(`>> window_click windowId=${opened.windowId} slot=${TARGET_SLOT} mouseButton=1 action=${windowAction} mode=0`)
  c.write('window_click', {
    windowId: opened.windowId, slot: TARGET_SLOT, mouseButton: 1, action: windowAction, mode: 0, item: { blockId: -1 }
  })
  await sleep(3000)
  log('done')
  c.end()
  process.exit(0)
}

// capture open_window so main() can use it
c.on('open_window', (p) => { opened = p })

main()
