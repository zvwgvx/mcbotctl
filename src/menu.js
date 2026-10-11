// menu.js — drive a chest-style GUI: select a hotbar slot, right-click to open, click a slot.
//
// This is the first thing the tool does that is NOT chat. A chat command either answers or does
// not; a menu is a conversation with the SERVER's window state, so every step has to be confirmed
// before the next one makes sense. Sending window_click without an open window is meaningless, and
// clicking before the server has sent window_items means clicking at nothing.
//
// VERIFIED against a live PaperSpigot 1.8.8 server (test/gui-probe.mjs, plugin/.../MenuSim.java):
//   held_item_slot {slotId: 4}                                  -> selects the 5th hotbar slot
//   block_place {location:(-1,-1,-1), direction:-1, heldItem:{blockId:-1}}
//                                                               -> right-click in the air; the bot
//                                                                  needs no position packet at all
//   server -> open_window {windowId, inventoryType, windowTitle, slotCount}
//   window_click {windowId, slot, mouseButton:1, action:n, mode:0, item:{blockId:-1}}
//                                                               -> a RIGHT click on that slot
//   server -> close_window, and the plugin's own confirmation line
//
// COORDINATES. Rows and columns are 1-indexed, the way a player counts them off the grid. The raw
// slot is (row - 1) * 9 + (col - 1). Getting that off by one is the easiest mistake here, so the
// resolved slot is reported in every result and logged.

import { EV } from './bus.js'

export const DEFAULT_MENU = {
  hotbarSlot: 5,          // 1-indexed: the 5th slot
  row: 4,                 // 1-indexed, counted from the top of the chest
  col: 4,                 // 1-indexed, counted from the left
  button: 'right',        // 'right' | 'left' — the plugin sees this as isRightClick()
  expectTitle: '',        // if set, a window whose title does not contain this is a failure
  openTimeoutMs: 4000,    // how long to wait for the menu to appear after the right-click
  settleMs: 1200          // how long to watch after the click, to see whether the menu reacts
}

export const slotOf = (row, col) => (Number(row) - 1) * 9 + (Number(col) - 1)

/**
 * @returns {Promise<object>} a result shaped like a command result so the dashboard and the
 *   reporter treat it the same way: { status, action, bot, ... }
 */
export async function openMenu (bot, cfg = {}, log = console, signal = null) {
  const spec = { ...DEFAULT_MENU, ...(cfg.menu ?? {}), ...cfg }
  const startedAt = Date.now()
  const base = {
    action: 'menu', bot: bot.username, botId: bot.id, target: null,
    at: startedAt, hotbarSlot: spec.hotbarSlot, row: spec.row, col: spec.col,
    button: spec.button, slot: slotOf(spec.row, spec.col), witnesses: []
  }
  const fail = (error) => ({ ...base, status: 'FAILED', error, latencyMs: Date.now() - startedAt })
  const wait = (ms) => new Promise((resolve) => {
    if (!signal) { setTimeout(() => resolve(true), ms); return }
    if (signal.aborted) { resolve(false); return }
    const onAbort = () => { clearTimeout(timer); resolve(false) }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

  const t = bot.transport
  if (signal?.aborted) return fail('menu flow cancelled')
  if (!t) return fail('bot has no transport')
  if (!bot.isReady()) return fail(`${bot.username} is ${bot.fsm?.state}, not READY — AuthMe cancels interactions before login`)
  if (!t.connected) return fail(`transport not in PLAY (state ${t.state})`)

  const currentWindow = () => t.openWindow
    ? { botId: bot.id, bot: bot.username, ...t.openWindow }
    : null

  let opened = currentWindow(), closed = null
  const offOpen = bot.bus.on(EV.MC_WINDOW_OPEN, (e) => { if (e.botId === bot.id) opened = e })
  const offClose = bot.bus.on(EV.MC_WINDOW_CLOSE, (e) => { if (e.botId === bot.id) closed = e })
  try {
    if (!opened) {
      log.info?.(`[${bot.username}] menu: selecting hotbar slot ${spec.hotbarSlot}`)
      if (!t.selectHotbar(spec.hotbarSlot)) return fail('could not select the hotbar slot')
      if (!(await wait(400))) return fail('menu flow cancelled')

      log.info?.(`[${bot.username}] menu: right-clicking`)
      if (!t.useItem()) return fail('could not send the right-click')

      const deadline = Date.now() + spec.openTimeoutMs
      while (Date.now() < deadline && !opened) {
        opened = currentWindow()
        if (opened) break
        if (!(await wait(100))) return fail('menu flow cancelled')
      }
      opened ??= currentWindow()
    } else {
      log.info?.(`[${bot.username}] menu: reusing already-open window "${opened.title}"`)
    }
    if (!opened) {
      return fail(`no menu opened within ${spec.openTimeoutMs}ms. The item is not in hotbar slot ` +
        `${spec.hotbarSlot}, or the account is not authenticated, or the item does not open on a right-click.`)
    }
    base.opened = { windowId: opened.windowId, title: opened.title, slotCount: opened.slotCount, type: opened.type }
    log.info?.(`[${bot.username}] menu opened: "${opened.title}" (${opened.slotCount} slots)`)

    if (spec.expectTitle && !String(opened.title).includes(spec.expectTitle)) {
      return { ...base, status: 'FAILED', error: `the menu that opened is "${opened.title}", which does not contain "${spec.expectTitle}"`, latencyMs: Date.now() - startedAt }
    }
    // Only bounds-check when the size is actually known. An unknown size is not an empty window.
    if (typeof opened.slotCount === 'number' && opened.slotCount > 0 && base.slot >= opened.slotCount) {
      return { ...base, status: 'FAILED', error: `slot ${base.slot} (row ${spec.row}, col ${spec.col}) is outside a ${opened.slotCount}-slot window`, latencyMs: Date.now() - startedAt }
    }

    // Let the contents arrive before clicking: a plugin that fills the window on open needs a
    // moment, and a click that lands first can be silently swallowed.
    if (!(await wait(500))) return fail('menu flow cancelled')
    if (!t.clickWindow(base.slot, spec.button)) return fail('could not send the window click')
    log.info?.(`[${bot.username}] menu: ${spec.button}-clicked slot ${base.slot} (row ${spec.row}, col ${spec.col})`)
    base.clicked = true

    if (!(await wait(spec.settleMs))) return fail('menu flow cancelled')
    base.windowClosed = !!closed || !t.openWindow
    // A menu plugin almost always closes the window once it accepts the choice. The window staying
    // open is not proof of failure, but it is the difference between "the menu acted" and "the
    // click landed somewhere the plugin ignored", so it is reported rather than assumed.
    return {
      ...base,
      status: 'OK',
      response: base.windowClosed
        ? `menu "${opened.title}" opened; slot ${base.slot} clicked; the menu closed in response`
        : `menu "${opened.title}" opened and slot ${base.slot} was clicked, but the window stayed open`,
      latencyMs: Date.now() - startedAt
    }
  } finally { offOpen(); offClose() }
}
