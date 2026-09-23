// BedWars resource and shop flow. Pickup is automatic while the bot stands on a generator.
// Shop discovery examines loaded NPCs and the actual menu contents before buying anything.

import { EV } from '../bus.js'
import { stripLegacy } from '../util.js'
import { findShopCandidates, approachShopCandidate } from './bedwars_npc.js'

const IRON_INGOT = 265
const WOOL = 35
const ABORTED = Symbol('aborted')
const TIMED_OUT = Symbol('timed out')

export const DEFAULT_BEDWARS_SHOP = Object.freeze({
  ironRequired: 16,
  collectTimeoutMs: 120000,
  pollMs: 100,
  shop: {
    mode: 'auto',           // auto-discover NPC; block and hotbar are optional server overrides
    entityName: '',        // optional ranking hint, never required for NPC discovery
    entityType: '',        // optional exact entity kind
    maxDistance: 24,
    interactionDistance: 3,
    approachTimeoutMs: 15000,
    block: null,
    hotbarSlot: null,
    expectTitle: '',       // optional title guard for a known server
    woolSlot: null,        // optional preference among scanned wool offers
    button: 'left',
    openTimeoutMs: 4000,
    purchaseTimeoutMs: 4000,
    menuTransitionTimeoutMs: 3000,
    maxMenuDepth: 3
  }
})

function resourceCount (items, id, name) {
  return items.reduce((sum, item) => {
    const numericId = Number(item.type ?? item.blockId ?? item.id)
    return sum + (numericId === id || (Number.isNaN(numericId) && item.name === name)
      ? Math.max(0, Number(item.count ?? item.itemCount) || 0)
      : 0)
  }, 0)
}

/** Counts only the player's inventory, never items displayed in an open shop window. */
export function resourceCounts (bot) {
  const items = bot.transport?.inventoryItems?.()
  if (!Array.isArray(items)) return null
  return {
    iron: resourceCount(items, IRON_INGOT, 'iron_ingot'),
    wool: resourceCount(items, WOOL, 'wool')
  }
}

function waitTick (ms, signal) {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    let timer
    const done = (ok) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(ok)
    }
    const onAbort = () => done(false)
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => done(true), ms)
  })
}

function withAbortOrTimeout (promise, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn(value)
    }
    const onAbort = () => done(resolve, ABORTED)
    const timer = setTimeout(() => done(resolve, TIMED_OUT), timeoutMs)
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then((value) => done(resolve, value), (error) => done(reject, error))
  })
}

function stateError (bot, signal) {
  if (signal?.aborted) return 'aborted'
  if (!bot.transport?.connected) return 'transport disconnected'
  if (!bot.isReady()) return `bot is ${bot.fsm?.state}, not READY`
  return null
}

function wholeNumber (value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/** Wait for automatic generator pickup, returning a finite, abortable result. */
export async function waitForIron (bot, bedwarsCfg = {}, { signal } = {}) {
  const at = Date.now()
  const ironRequired = wholeNumber(bedwarsCfg.ironRequired, DEFAULT_BEDWARS_SHOP.ironRequired)
  const timeoutMs = wholeNumber(bedwarsCfg.collectTimeoutMs, DEFAULT_BEDWARS_SHOP.collectTimeoutMs)
  const pollMs = wholeNumber(bedwarsCfg.pollMs, DEFAULT_BEDWARS_SHOP.pollMs)
  const base = { action: 'collectIron', bot: bot.username, botId: bot.id, at, ironRequired }
  const done = (status, error) => ({
    ...base, status, ...(error ? { error } : {}), ...(resourceCounts(bot) ?? {}),
    latencyMs: Date.now() - at
  })

  if (typeof bot.transport?.inventoryItems !== 'function') return done('FAILED', 'transport has no player inventory view')
  const deadline = at + timeoutMs
  while (true) {
    const error = stateError(bot, signal)
    if (error) return done('FAILED', error)
    if (resourceCounts(bot).iron >= ironRequired) return done('OK')
    if (Date.now() >= deadline) return done('FAILED', `only ${resourceCounts(bot).iron}/${ironRequired} iron after ${timeoutMs}ms at the generator`)
    await waitTick(Math.min(pollMs, deadline - Date.now()), signal)
  }
}

function validateShop (shop) {
  if (!['auto', 'entity', 'block', 'hotbar'].includes(shop.mode)) return 'shop.mode must be auto, entity, block, or hotbar'
  if (!['left', 'right'].includes(shop.button)) return 'shop.button must be left or right'
  if (shop.woolSlot != null && (!Number.isInteger(shop.woolSlot) || shop.woolSlot < 0)) {
    return 'shop.woolSlot must be a zero-based, nonnegative integer when supplied'
  }
  if (shop.mode === 'hotbar' && (!Number.isInteger(shop.hotbarSlot) || shop.hotbarSlot < 1 || shop.hotbarSlot > 9)) {
    return 'shop.hotbarSlot must be 1..9 for hotbar mode'
  }
  if (shop.mode === 'block' && !['x', 'y', 'z'].every((axis) => Number.isFinite(shop.block?.[axis]))) {
    return 'shop.block must contain finite x, y, z coordinates for block mode'
  }
  if (!Number.isInteger(shop.maxMenuDepth) || shop.maxMenuDepth < 0 || shop.maxMenuDepth > 6) {
    return 'shop.maxMenuDepth must be an integer from 0 to 6'
  }
  return null
}

function untag (value) {
  return value && typeof value === 'object' && 'value' in value ? value.value : value
}

function menuText (value, depth = 0) {
  if (depth > 6 || value == null) return ''
  const v = untag(value)
  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (/^[{[]/.test(trimmed)) {
      try { return menuText(JSON.parse(trimmed), depth + 1) } catch {}
    }
    return stripLegacy(v).trim()
  }
  if (Array.isArray(v)) return v.map((part) => menuText(part, depth + 1)).filter(Boolean).join(' ')
  if (typeof v === 'object') {
    return [v.text, v.translate, v.extra, v.with]
      .map((part) => menuText(part, depth + 1)).filter(Boolean).join(' ').trim()
  }
  return ''
}

function itemInfo (item, slot) {
  if (!item) return null
  const id = Number(item.type ?? item.itemId ?? item.blockId ?? item.id)
  const count = Number(item.count ?? item.itemCount ?? 0)
  if (!Number.isInteger(id) || id < 0 || count <= 0) return null
  const nbt = untag(item.nbt ?? item.nbtData)
  const display = untag(nbt?.display)
  const customName = menuText(display?.Name)
  const label = customName || menuText(item.displayName) || menuText(item.name)
  const lore = menuText(display?.Lore)
  return { slot, id, count, label, lore, name: String(item.name ?? '') }
}

function watchShopWindows (bot) {
  const t = bot.transport
  const contents = new Map()
  // Mineflayer may emit windowOpen only after applying the first window_items packet. Clearing
  // the packet on windowOpen would discard the contents the scanner is waiting for.
  const offItems = bot.bus.on(EV.MC_WINDOW_ITEMS, (event) => {
    if (event.botId === bot.id && Array.isArray(event.items)) contents.set(event.windowId, event.items)
  })
  const snapshot = () => {
    const open = t.openWindow
    if (!open || !contents.has(open.windowId)) return null
    const packetItems = contents.get(open.windowId)
    const current = t.mc?.currentWindow
    const liveItems = current?.id === open.windowId ? current.slots : null
    const slotCount = Number.isInteger(open.slotCount) && open.slotCount > 0
      ? open.slotCount
      : Number.isInteger(current?.inventoryStart) && current.inventoryStart > 0
        ? current.inventoryStart : packetItems.length - 36
    if (!Number.isInteger(slotCount) || slotCount <= 0 || slotCount > packetItems.length) return null
    const slots = []
    for (let slot = 0; slot < slotCount; slot++) {
      // Mineflayer resolves item names and custom NBT; the raw packet covers the short interval
      // before its window object is updated and servers that replace a page in the same window.
      const live = itemInfo(liveItems?.[slot], slot)
      const packet = itemInfo(packetItems[slot], slot)
      slots.push(live ?? packet)
    }
    const signature = String(open.windowId) + ':' + slots.map((item) =>
      item ? [item.id, item.count, item.label, item.lore].join('/') : '-'
    ).join('|')
    return { windowId: open.windowId, title: open.title, slotCount, slots, signature }
  }
  return { snapshot, close: () => { offItems() } }
}

async function waitForWindow (bot, watcher, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const error = stateError(bot, signal)
    if (error) return { error }
    const window = watcher.snapshot()
    if (window) return { window }
    await waitTick(Math.min(50, deadline - Date.now()), signal)
  }
  return { error: 'shop window did not provide inventory contents within ' + timeoutMs + 'ms' }
}

async function waitForWindowChange (bot, watcher, previous, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const error = stateError(bot, signal)
    if (error) return { error }
    const window = watcher.snapshot()
    if (window && window.signature !== previous.signature) return { window }
    await waitTick(Math.min(50, deadline - Date.now()), signal)
  }
  return { error: 'menu did not change after category click' }
}

const BLOCKS = /(?:^|[^a-z])blocks(?=$|[^a-z])|block shop|building materials/i
const EXACT_BLOCKS_CATEGORY = /^(?:blocks|block shop|building blocks)$/i
const CATEGORY_ACTION = /open|view|browse|category|menu/i
const WOOL_NAME = /(?:^|[^a-z])wool(?=$|[^a-z])/i
const OTHER_CURRENCY = /(?:^|[^a-z])(?:gold|emerald|diamond)(?=$|[^a-z])/i
const UPGRADE_WORD = /upgrade|enchant|level/i
const PURCHASE_WORD = /buy|purchase|cost|price/i
const IRON_WORD = '(?:iron)'

function isBlocksCategory (item) {
  if (!item) return false
  const title = item.label.toLowerCase().trim()
  const lore = item.lore.toLowerCase()
  if (WOOL_NAME.test(title)) return false
  // A concrete item such as "Glass Blocks - 4 Iron" is an offer, not a category. Require an
  // unpriced category title or a navigation instruction before clicking a non-wool icon.
  if (ironPrice(item) != null) return false
  if (EXACT_BLOCKS_CATEGORY.test(title)) return true
  return (BLOCKS.test(title) || BLOCKS.test(lore)) && CATEGORY_ACTION.test(title + ' ' + lore)
}

function ironPrice (item) {
  const description = (item.label + ' ' + item.lore).toLowerCase()
  const prices = []
  const amountFirst = new RegExp('(\\d+)\\s*' + IRON_WORD, 'giu')
  const currencyFirst = new RegExp(IRON_WORD + '\\s*[:x×-]?\\s*(\\d+)', 'giu')
  for (const match of description.matchAll(amountFirst)) prices.push(Number(match[1]))
  for (const match of description.matchAll(currencyFirst)) prices.push(Number(match[1]))
  return prices.length ? Math.min(...prices) : null
}

function woolOffers (window, availableIron, preferredSlot) {
  return window.slots.filter((item) => {
    if (!item || isBlocksCategory(item)) return false
    if (item.id !== WOOL && !WOOL_NAME.test(item.label.toLowerCase())) return false
    const description = (item.label + ' ' + item.lore).toLowerCase()
    if (UPGRADE_WORD.test(description)) return false
    if (/locked|unavailable|out of stock/i.test(description)) return false
    const price = ironPrice(item)
    if (price != null && price > availableIron) return false
    if (price == null && OTHER_CURRENCY.test(description)) return false
    // Some plugins use a custom icon for a wool offer. Its text must explicitly describe a
    // purchase paid in iron; a Wool Upgrade button is not a wool item to bridge with.
    if (item.id !== WOOL && (price == null || !PURCHASE_WORD.test(description))) return false
    return true
  }).map((item) => ({ ...item, price: ironPrice(item) }))
    .sort((a, b) => {
      const aPrice = a.price ?? Number.POSITIVE_INFINITY
      const bPrice = b.price ?? Number.POSITIVE_INFINITY
      return aPrice - bPrice ||
        (a.slot === preferredSlot ? -1 : 0) - (b.slot === preferredSlot ? -1 : 0) ||
        (a.id === WOOL ? -1 : 0) - (b.id === WOOL ? -1 : 0) || a.slot - b.slot
    })
}

function purchased (before, after) {
  return after && after.wool > before.wool && after.iron < before.iron
}

async function clickMenuSlot (bot, shop, slot, signal) {
  const timeoutMs = Math.min(1000, wholeNumber(shop.purchaseTimeoutMs, 4000))
  return withAbortOrTimeout(bot.transport.clickWindowConfirmed(slot, shop.button), signal, timeoutMs)
}

async function waitForOfferResult (bot, watcher, previous, before, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs
  let changed = null
  while (Date.now() < deadline) {
    const error = stateError(bot, signal)
    if (error) return { error }
    const after = resourceCounts(bot)
    if (purchased(before, after)) return { after }
    const next = watcher.snapshot()
    if (next && next.signature !== previous.signature) changed = next
    // A purchase can close its GUI and update the player inventory on the next server tick.
    // Give that update a short chance before treating a new menu as another page to inspect.
    if (changed && Date.now() >= deadline - timeoutMs + 250) return { window: changed, after }
    await waitTick(Math.min(50, deadline - Date.now()), signal)
  }
  return { after: resourceCounts(bot), window: changed }
}

function describeCandidate (candidate) {
  if (!candidate) return 'configured shop'
  return String(candidate.label || candidate.kind || candidate.id) + ' #' + candidate.id
}

async function inspectShop (bot, watcher, shop, initial, log, onPhase, signal) {
  let window = initial
  const path = []
  const seen = new Set()
  let lastClickBefore = null
  try {
    for (let depth = 0; depth <= shop.maxMenuDepth; depth++) {
      const error = stateError(bot, signal)
      if (error) return { error }
      const counts = resourceCounts(bot)
      if (lastClickBefore && purchased(lastClickBefore, counts)) {
        return { before: lastClickBefore, after: counts, opened: window.title, path }
      }
      if (lastClickBefore && (counts.iron < lastClickBefore.iron || counts.wool > lastClickBefore.wool)) {
        return { error: 'inventory changed without a confirmed wool purchase', before: lastClickBefore, after: counts }
      }
      if (seen.has(window.signature)) return { error: 'shop menu repeated without reaching wool' }
      seen.add(window.signature)
      onPhase('scanning_shop', { title: window.title, depth, slotCount: window.slotCount })
      const offers = woolOffers(window, counts.iron, shop.woolSlot)
      if (offers.length) {
        let nextPage = null
        for (const offer of offers) {
          const current = resourceCounts(bot)
          if (offer.price != null && current.iron < offer.price) continue
          lastClickBefore = current
          onPhase('buying_wool', { title: window.title, woolSlot: offer.slot, ironPrice: offer.price })
          log.info?.('[' + bot.username + '] buying wool from slot ' + offer.slot + ' in "' + window.title + '"')
          let clicked
          try { clicked = await clickMenuSlot(bot, shop, offer.slot, signal) }
          catch (cause) {
            return { error: cause?.message ?? String(cause), before: lastClickBefore, after: resourceCounts(bot) }
          }
          if (clicked === ABORTED) return { error: 'aborted' }
          const outcome = await waitForOfferResult(bot, watcher, window, lastClickBefore,
            wholeNumber(shop.purchaseTimeoutMs, 4000), signal)
          if (outcome.error) return outcome
          if (purchased(lastClickBefore, outcome.after)) {
            return { before: lastClickBefore, after: outcome.after, opened: window.title, woolSlot: offer.slot,
              ironPrice: offer.price, path }
          }
          if (outcome.after.iron < lastClickBefore.iron || outcome.after.wool > lastClickBefore.wool) {
            return { error: 'inventory changed without a confirmed wool purchase', before: lastClickBefore, after: outcome.after }
          }
          if (outcome.window) {
            nextPage = outcome.window
            path.push({ title: window.title, slot: offer.slot, label: offer.label })
            break
          }
        }
        if (nextPage) { window = nextPage; continue }
        return { error: 'wool offers in "' + window.title + '" did not complete a purchase' }
      }

      if (depth >= shop.maxMenuDepth) return { error: 'no wool offer found within ' + shop.maxMenuDepth + ' menu levels' }
      const categories = window.slots.filter(isBlocksCategory)
      if (!categories.length) return { error: 'no Blocks category or wool offer in "' + window.title + '"' }
      let nextPage = null
      for (const category of categories) {
        lastClickBefore = resourceCounts(bot)
        onPhase('scanning_shop', { title: window.title, depth, category: category.label, slot: category.slot })
        log.info?.('[' + bot.username + '] opening Blocks category in slot ' + category.slot + ' of "' + window.title + '"')
        let clicked
        try { clicked = await clickMenuSlot(bot, shop, category.slot, signal) }
        catch (cause) {
          return { error: cause?.message ?? String(cause), before: lastClickBefore, after: resourceCounts(bot) }
        }
        if (clicked === ABORTED) return { error: 'aborted' }
        const transition = await waitForWindowChange(bot, watcher, window,
          wholeNumber(shop.menuTransitionTimeoutMs, 3000), signal)
        if (transition.error === 'aborted' || transition.error === 'transport disconnected') return transition
        const after = resourceCounts(bot)
        if (purchased(lastClickBefore, after)) return { before: lastClickBefore, after, opened: window.title, path }
        if (after.iron < lastClickBefore.iron || after.wool > lastClickBefore.wool) {
          return { error: 'inventory changed without a confirmed wool purchase', before: lastClickBefore, after }
        }
        if (transition.window) {
          nextPage = transition.window
          path.push({ title: window.title, slot: category.slot, label: category.label })
          break
        }
      }
      if (!nextPage) return { error: 'Blocks category did not open another menu page' }
      window = nextPage
    }
    return { error: 'menu depth exhausted without a wool purchase' }
  } catch (cause) {
    return { error: cause?.message ?? String(cause), before: lastClickBefore, after: resourceCounts(bot) }
  }
}

/**
 * Wait for generator iron, discover nearby NPCs, read shop pages and buy an affordable wool offer.
 * Inventory deltas, rather than click acknowledgements, prove the server completed the purchase.
 */
export async function buyWool (bot, bedwarsCfg = {}, log = console, { signal, onPhase = () => {} } = {}) {
  const at = Date.now()
  const shop = { ...DEFAULT_BEDWARS_SHOP.shop, ...(bedwarsCfg.shop ?? {}) }
  shop.mode = String(shop.mode ?? '').trim() || 'auto'
  const ironRequired = wholeNumber(bedwarsCfg.ironRequired, DEFAULT_BEDWARS_SHOP.ironRequired)
  const base = { action: 'buyWool', bot: bot.username, botId: bot.id, at, ironRequired, shopMode: shop.mode }
  const result = (status, error, extra = {}) => ({
    ...base, status, ...(error ? { error } : {}), ...extra,
    ...(resourceCounts(bot) ?? {}), latencyMs: Date.now() - at
  })
  const report = (phase, detail = {}) => { try { onPhase(phase, detail) } catch {} }
  const configError = validateShop(shop)
  if (configError) return result('FAILED', configError)
  const t = bot.transport
  if (typeof t?.clickWindowConfirmed !== 'function') return result('FAILED', 'transport cannot click a shop window')
  const collected = await waitForIron(bot, bedwarsCfg, { signal })
  if (collected.status !== 'OK') return result('FAILED', collected.error, { collected })
  if (t.openWindow) return result('FAILED', 'another window is already open: ' + t.openWindow.title)
  const before = resourceCounts(bot)
  const attempts = []
  const npcMode = shop.mode === 'auto' || shop.mode === 'entity'
  const attemptedIds = new Set()
  let directAttempted = false
  let lastAttemptEndedAt = Date.now()

  if (npcMode) {
    if (typeof t.activateEntity !== 'function') return result('FAILED', 'NPC shops need the mineflayer transport', { before })
    report('finding_shop', { maxDistance: shop.maxDistance })
  }

  // Refresh discovery after every failed NPC. A server may spawn the real seller only after the
  // nearest decoy was already inspected, so a frozen first snapshot would miss it.
  while (true) {
    const error = stateError(bot, signal)
    if (error) return result('FAILED', error, { before, attempts })
    let candidate = null
    if (npcMode) {
      if (attemptedIds.size >= 16) break
      const available = findShopCandidates(bot, {
        maxDistance: shop.maxDistance, nameHint: shop.entityName,
        entityType: shop.entityType, excludeIds: attemptedIds
      })
      if (!available.length) {
        if (Date.now() - lastAttemptEndedAt >= 2000) break
        await waitTick(100, signal)
        continue
      }
      candidate = available[0]
      attemptedIds.add(candidate.id)
    } else {
      if (directAttempted) break
      directAttempted = true
    }
    const label = describeCandidate(candidate)
    report('opening_shop', { npc: label, candidateId: candidate?.id ?? null })
    let entity = null
    if (candidate) {
      const approach = await approachShopCandidate(bot, candidate, {
        signal, interactionDistance: shop.interactionDistance,
        timeoutMs: wholeNumber(shop.approachTimeoutMs, 15000)
      })
      if (approach.status !== 'OK') {
        attempts.push({ npc: label, error: approach.error })
        lastAttemptEndedAt = Date.now()
        continue
      }
      entity = approach.entity
    }

    const watcher = watchShopWindows(bot)
    const attemptBefore = resourceCounts(bot)
    try {
      let activated
      if (candidate) {
        activated = await withAbortOrTimeout(t.activateEntity(entity), signal, 1500)
      } else if (shop.mode === 'block') {
        activated = await withAbortOrTimeout(t.activateBlockAt(shop.block.x, shop.block.y, shop.block.z), signal, 1500)
      } else {
        if (!t.selectHotbar(shop.hotbarSlot)) {
          attempts.push({ npc: label, error: 'could not select hotbar slot ' + shop.hotbarSlot })
          continue
        }
        activated = t.useItem()
      }
      if (activated === ABORTED) return result('FAILED', 'aborted', { before, attempts })
      if (activated === false && !t.openWindow) {
        attempts.push({ npc: label, error: 'could not activate shop' })
        continue
      }
      const ready = await waitForWindow(bot, watcher, wholeNumber(shop.openTimeoutMs, 4000), signal)
      if (ready.error) {
        attempts.push({ npc: label, error: ready.error })
        if (stateError(bot, signal)) return result('FAILED', stateError(bot, signal), { before, attempts })
        continue
      }
      const initial = ready.window
      if (shop.expectTitle && !stripLegacy(initial.title).toLowerCase().includes(stripLegacy(shop.expectTitle).toLowerCase())) {
        attempts.push({ npc: label, error: 'opened "' + initial.title + '", expected "' + shop.expectTitle + '"' })
        continue
      }
      const inspected = await inspectShop(bot, watcher, shop, initial, log, report, signal)
      if (inspected.before && inspected.after && purchased(inspected.before, inspected.after)) {
        return result('OK', null, { before: inspected.before, after: inspected.after, npc: label,
          opened: inspected.opened, woolSlot: inspected.woolSlot ?? null, menuPath: inspected.path,
          response: 'bought ' + (inspected.after.wool - inspected.before.wool) + ' wool with ' +
            (inspected.before.iron - inspected.after.iron) + ' iron' })
      }
      attempts.push({ npc: label, error: inspected.error ?? 'wool purchase was not confirmed' })
      const after = resourceCounts(bot)
      if (inspected.error === 'inventory changed without a confirmed wool purchase' ||
          (inspected.before && (after.iron < inspected.before.iron || after.wool > inspected.before.wool))) {
        return result('FAILED', inspected.error ?? 'inventory changed without a confirmed wool purchase',
          { before: inspected.before ?? before, after, attempts })
      }
      if (after.iron < before.iron || after.wool > before.wool) {
        return result('FAILED', 'inventory changed without a confirmed wool purchase', { before, after, attempts })
      }
    } catch (cause) {
      attempts.push({ npc: label, error: cause?.message ?? String(cause) })
      const after = resourceCounts(bot)
      if (after.iron < attemptBefore.iron || after.wool > attemptBefore.wool) {
        return result('FAILED', 'inventory changed without a confirmed wool purchase',
          { before: attemptBefore, after, attempts })
      }
    } finally {
      watcher.close()
      if (t.openWindow) {
        t.closeWindow?.()
        const closeDeadline = Date.now() + 1000
        while (t.openWindow && Date.now() < closeDeadline && !signal?.aborted) {
          await waitTick(50, signal)
        }
      }
      lastAttemptEndedAt = Date.now()
    }
  }
  const reason = stateError(bot, signal)
  if (reason) return result('FAILED', reason, { before, attempts })
  if (npcMode && !attempts.length) {
    return result('FAILED', 'no possible shop NPC is loaded within ' + shop.maxDistance + ' blocks', { before })
  }
  return result('FAILED', 'no candidate shop completed a wool purchase', { before, attempts })
}
