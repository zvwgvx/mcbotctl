// util.js — primitives shared by every layer. No imports from the project: leaf module.
import { createRequire } from 'node:module'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Fill {placeholders}. Unknown keys are left verbatim so a typo shows up in the wire
 *  command instead of silently becoming "undefined" — the dashboard displays the rendered
 *  string, so leaving {foo} visible is the honest failure mode. */
export function renderTemplate (template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m)
}

/** Unique-ish id without a dependency (ulid/uuid would be a new package; V1 needs no crypto). */
let __seq = 0
export function nextId (prefix = 'r') {
  return `${prefix}${Date.now().toString(36)}${(__seq++).toString(36).padStart(3, '0')}`
}

/** Strip Minecraft legacy formatting (§ followed by one char, and the &-form operators type). */
export function stripLegacy (s) {
  return String(s).replace(/§[0-9A-FK-ORa-fk-or]/g, '').replace(/&[0-9A-FK-ORa-fk-or]/g, '')
}

/** Flatten a chat component of ANY shape into plain text.
 *  Shapes seen on the wire (all three verified against PaperSpigot 1.8.8 + AuthMe 5.6.0):
 *    - {"text":"hi","extra":[...]}   a component tree
 *    - {"translate":"chat.type.text","with":[...]}   a 1.8 translation key (needs prismarine-chat)
 *    - "<Notch> hi"                  a legacy pre-formatted literal (Paper sends player chat this way)
 *  `ChatMessage.fromNotch` handles all three; the constructor would NOT, so this is the only
 *  correct entry point. */
export function makeChatFlattener (version = '1.8') {
  // prismarine-chat is CJS; this file is ESM (package.json "type":"module"), so `require`
  // is not defined and a bare require() throws ReferenceError. createRequire is mandatory.
  let ChatMessage = null
  try { ChatMessage = createRequire(import.meta.url)('prismarine-chat')(version) } catch { /* handled below */ }
  return function flatten (raw) {
    if (raw == null) return ''
    if (typeof raw !== 'string') return stripLegacy(JSON.stringify(raw))
    if (ChatMessage) {
      try { return stripLegacy(ChatMessage.fromNotch(raw).toString()) } catch { /* fall through */ }
    }
    return stripLegacy(raw)
  }
}

/** Flatten a kick/disconnect reason. Three encodings are all attested in the wild:
 *    1. a JSON string literal  -> "\"§cWrong password!\""   (PaperSpigot 1.8.8 + AuthMe, VERIFIED)
 *    2. a JSON component object -> {"text":"Wrong password!"}    (minecraft-protocol's own server)
 *    3. a plain string                                          (older/other stacks)
 *  A strict "JSON.parse(x).text" or a "=== 'Wrong password!'" equality check fails on (1),
 *  which is the one that actually happens on the target server. */
const defaultFlatten = makeChatFlattener('1.8')

export function flattenReason (raw, flatten = defaultFlatten) {
  if (raw == null) return ''
  let s = typeof raw === 'string' ? raw : JSON.stringify(raw)
  const t = s.trim()
  if (t.startsWith('"') || t.startsWith('{') || t.startsWith('[')) {
    try {
      const parsed = JSON.parse(t)
      if (typeof parsed === 'string') return flatten(parsed)      // case 1
      return flatten(JSON.stringify(parsed))                      // case 2
    } catch { /* not JSON after all — fall through to case 3 */ }
  }
  return flatten(s)
}
