// accounts.js — the bot account list: parse, validate, format, generate.
//
// The account file is the one piece of state the operator edits most often, so parsing and
// validation live here rather than inline in the config loader, and the dashboard can call
// the same functions the CLI does. One rule, one implementation.
//
// THE VALIDATION IS NOT COSMETIC. Two of these rules were found by connecting to a live
// PaperSpigot 1.8.8 server with AuthMe 5.6.0 and reading the disconnect reason:
//   * A name shorter than AuthMe's minNicknameLength (default 3) is kicked at join with
//     "Your username is either too short or too long!" - before the bot ever reaches PLAY.
//   * Minecraft itself caps a name at 16 characters of [A-Za-z0-9_].
//   * With auth:'offline' the UUID is derived from the name, so two bots sharing a name are
//     ONE account and the second connection is refused with
//     "The same username is already playing on the server!".
//   * AuthMe stores names lowercased but rejects a join whose case differs from the
//     registered name: "You should join using username Bot01, not bot01."

export const NAME_RE = /^[A-Za-z0-9_]{3,16}$/
export const MAX_NAME = 16
export const MIN_NAME = 3

/** @throws {Error} with a message that names the offending line and the reason. */
export function validateName (username, where = '') {
  if (!NAME_RE.test(username)) {
    throw new Error(
      `${where}"${username}" is not a valid Minecraft username: it must be ${MIN_NAME}-${MAX_NAME} ` +
      `characters of [A-Za-z0-9_]. AuthMe's minNicknameLength default is 3 and it disconnects ` +
      `shorter names at join with "Your username is either too short or too long!"`
    )
  }
  return username
}

/** Parse "username:password" lines. Blank lines and lines starting with # are ignored.
 *  @throws {Error} on a malformed line or a duplicate name (case-insensitive). */
export function parseAccounts (text, source = 'accounts') {
  const out = []
  const seen = new Set()
  const lines = String(text).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const at = line.indexOf(':')
    if (at < 1) throw new Error(`${source}:${i + 1}: expected "username:password", got "${line}"`)
    const username = line.slice(0, at).trim()
    const password = line.slice(at + 1).trim()
    validateName(username, `${source}:${i + 1}: `)
    if (seen.has(username.toLowerCase())) {
      throw new Error(`${source}:${i + 1}: duplicate username "${username}"`)
    }
    seen.add(username.toLowerCase())
    out.push({ username, password })
  }
  if (!out.length) throw new Error(`${source}: no accounts found`)
  return out
}

export function formatAccounts (list, header = null) {
  const body = list.map((a) => `${a.username}:${a.password}`).join('\n')
  return (header ? header + '\n' : '') + body + '\n'
}

/** Generate `count` accounts named <prefix><zero-padded index>.
 *
 *  The default prefix is deliberately short so the padded number still fits in 16 characters,
 *  and the numbering starts at 1 so the leader (index 0 in the fleet) is "<prefix>01".
 *  Passwords default to one shared password: AuthMe will happily register a fleet with the
 *  same password, and a single shared secret is far easier to change on a test bed. */
export function generateAccounts ({ count, prefix = 'Bot', password = 'changeme123', start = 1, pad = 2 } = {}) {
  const n = Math.max(1, Math.min(Number(count) || 0, 500))
  const p = String(prefix || 'Bot').replace(/[^A-Za-z0-9_]/g, '')
  if (!p) throw new Error('prefix must contain at least one of [A-Za-z0-9_]')
  const width = String(start + n - 1).length > pad ? String(start + n - 1).length : pad
  const names = []
  for (let i = 0; i < n; i++) {
    const name = p + String(start + i).padStart(width, '0')
    if (name.length > MAX_NAME) {
      throw new Error(`generated name "${name}" is longer than ${MAX_NAME} characters; shorten the prefix`)
    }
    names.push(validateName(name, 'generate: '))
  }
  if (!password) throw new Error('a password is required: AuthMe rejects an empty one')
  return names.map((username) => ({ username, password: String(password) }))
}
