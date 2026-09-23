// config/load.js — read config + accounts, validate, and translate config into engine specs.
//
// The Command Engine is the ONLY consumer of config.commands; nothing else knows the shape of a
// command spec. That keeps "the operator edits a template in the dashboard" a one-line change.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseAccounts } from '../accounts.js'
import { dirname, join, isAbsolute } from 'node:path'
import { PATTERNS } from '../patterns.js'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const DEFAULTS = {
  server: { host: '127.0.0.1', port: 25566, version: '1.8.9', chatVersion: '1.8', checkTimeoutIntervalMs: 60000 },
  auth: { enabled: false, strategy: 'register-first', messageIntervalMs: 5000 },
  engine: { timeoutMs: 1500, joinGuardMs: 1100, retries: 0 },
  fleet: { size: 7, connectStaggerMs: 350, readyTimeoutMs: 20000, leaderIndex: 0 },
  report: { jsonl: null, ringSize: 2000 },
  commands: {},
  patterns: {},
  plan: null
}

export function loadConfig (path = join(ROOT, 'config', 'default.json')) {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const cfg = {
    ...DEFAULTS,
    ...raw,
    server: { ...DEFAULTS.server, ...raw.server },
    auth: { ...DEFAULTS.auth, ...raw.auth },
    engine: { ...DEFAULTS.engine, ...(raw.engine ?? {}) },
    fleet: { ...DEFAULTS.fleet, ...raw.fleet },
    report: { ...DEFAULTS.report, ...raw.report }
  }

  // Operator pattern overrides replace the shipped default of the same name. A raw regex source
  // under a name that does not exist is ADDED, so a server-specific string can be introduced
  // without forking patterns.js.
  cfg.patterns = { ...PATTERNS, ...(raw.patterns ?? {}) }
  // Publish the file's patterns into the registry the engine and the tracker actually read.
  // Without this the whole patterns block was inert: a key the registry did not already know was
  // compiled as a literal-string regex (`new RegExp('myServerKick')`), which can never match, so
  // an operator following the comment in the config got silence instead of detection.
  for (const [key, val] of Object.entries(raw.patterns ?? {})) {
    PATTERNS[key] = typeof val === 'string'
      ? { re: val, kind: 'operator', src: '[OPERATOR] config/default.json patterns' }
      : { ...(val ?? {}), src: '[OPERATOR] config/default.json patterns' }
  }

  if (!cfg.server.version) throw new Error('server.version is required: minecraft-protocol 1.68.0 defaults to 26.1 and would silently connect as a modern client')
  if (!Number.isInteger(cfg.server.port)) throw new Error('server.port must be an integer')
  if (cfg.server.port === 25565 && ['127.0.0.1', 'localhost', '::1'].includes(String(cfg.server.host).toLowerCase())) {
    throw new Error('local port 25565 belongs to an unrelated Paper server; use a separate local test port')
  }

  const acctFile = raw.accounts?.file ?? 'accounts/accounts.txt'
  cfg.accountsFile = isAbsolute(acctFile) ? acctFile : join(ROOT, acctFile)
  return cfg
}

/** accounts.txt: one "username:password" per line, '#' comments, blank lines ignored.
 *  Kept intentionally dumb: it is the format the user already has. */
export function loadAccounts (file) {
  let text
  try { text = readFileSync(file, 'utf8') } catch { throw new Error(`cannot read accounts file: ${file}`) }
  // Validation lives in accounts.js so the CLI, the generator and the dashboard all enforce
  // exactly the same rules; see the header there for why each rule exists.
  return parseAccounts(text, file)
}

/** config.commands (+ the auth sub-commands) -> CommandEngine specs. */
export function applyCommands (engine, cfg) {
  const e = cfg.engine

  // Every operator command inherits the global timeout/guard unless it overrides them.
  for (const [action, spec] of Object.entries(cfg.commands ?? {})) {
    if (action.startsWith('_')) continue
    if (!spec || typeof spec !== 'object' || typeof spec.template !== 'string') continue
    engine.define(action, { timeoutMs: e.timeoutMs, joinGuardMs: e.joinGuardMs, ...spec, phase: spec.phase ?? 'party' })
  }

  // The login plugin is NOT a special path: it goes through the same engine, which is what makes
  // auth timing, retry and reporting identical to every other command. It differs only in being
  // exempt from the join guard and permitted before READY.
  if (cfg.auth?.enabled) {
    engine.define('__login', {
      template: cfg.auth.login?.template ?? '/login {password}',
      timeoutMs: cfg.auth.login?.timeoutMs ?? 4000,
      success: cfg.auth.login?.success ?? ['loginSuccess'],
      failure: cfg.auth.login?.failure ?? ['wrongPassword', 'notRegistered', 'alreadyLoggedIn'],
      auth: true,
      phase: 'auth'
    })
    if (cfg.auth.register?.enabled !== false) {
      engine.define('__register', {
        template: cfg.auth.register?.template ?? '/register {password} {password}',
        timeoutMs: cfg.auth.register?.timeoutMs ?? 4000,
        success: cfg.auth.register?.success ?? ['registerSuccess', 'loginSuccess'],
        failure: cfg.auth.register?.failure ?? ['alreadyRegistered', 'wrongPassword', 'minPasswordLength'],
        auth: true,
        phase: 'auth'
      })
    }
  }
  return engine
}
