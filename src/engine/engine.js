// engine/engine.js — the Command Engine: operator-defined template -> wire command -> verdict.
//
// WHY THIS SHAPE (and not "call bot.chat and hope"):
//
// 1. ONE COMMAND AT A TIME PER BOT. The 1.8.9 unknown-command reply is
//    `Unknown command. Type "/help" for help.` — verified on the live server — and it does NOT
//    contain the offending command. Neither does spigot.yml's message. So a reply cannot be
//    attributed to a command by its text; it can only be attributed by time. Issuing two
//    commands concurrently on one bot makes both verdicts unattributable. Therefore every run()
//    for a given bot is serialised through a per-bot promise chain. This also makes the engine
//    safe for V2's "dozens of configurable commands" without any new locking.
//
// 2. THE JOIN GUARD. AuthMe's quick-command protection (denyCommandsBeforeMilliseconds: 1000,
//    permission default: true) CANCELS AND KICKS on any command that is not in allowCommands
//    issued within 1000 ms of PlayerJoinEvent. /login and /register are on the allowlist;
//    party commands are not. So a spec marked `auth: true` is exempt, and everything else waits
//    until join + joinGuardMs (default 1100). The anchor is the transport's PLAY timestamp,
//    which is necessarily LATER than the server's PlayerJoinEvent, making the guard conservative.
//
// 3. BLOCKED IS A FIRST-CLASS STATUS. Sending a party command before authentication gets it
//    cancelled with "In order to use this command you must be authenticated!" — or, inside the
//    1000 ms window, gets the bot kicked. The engine refuses to send at all unless the bot's
//    FSM says READY (or the spec is an auth command). A local refusal the dashboard can see
//    beats a remote kick it has to infer.

import { EV } from '../bus.js'
import { STATUS, classifyLine } from './classify.js'
import { toRegexList, BASELINE_FAILURES, NOISE, PATTERNS } from '../patterns.js'
import { renderTemplate, nextId, sleep } from '../util.js'

/** @typedef {object} CommandSpec
 *  @property {string}  template     e.g. '/p inv {player}' — operator text, never parsed by us
 *  @property {number}  [timeoutMs]  how long to wait for a matching reply
 *  @property {string|string[]} [success]  pattern keys / raw regex sources
 *  @property {string|string[]} [failure]  extra failures, ADDED to the baseline set
 *  @property {boolean} [auth]       true => exempt from the join guard and allowed pre-READY
 *  @property {boolean} [enabled]
 *  @property {string}  [phase]      reporting label: 'auth' | 'party' | ...
 */

export class CommandEngine {
  #specs = new Map()
  #tail = new Map()          // botId -> promise, the per-bot serialisation chain
  #buckets = new Map()       // botId -> { tokens, last } chat-spam budget
  #gate = null
  #defaults

  constructor ({ bus, log = console, defaults = {}, gate = null }) {
    this.bus = bus
    this.log = log
    // Optional veto, called with (bot, spec) before any non-auth command. Returning a string
    // blocks the command with that reason. Used for the menu area gate: on a server that puts you
    // through a menu first, a bot that skipped it is standing in the wrong world.
    this.#gate = gate
    this.#defaults = {
      timeoutMs: 1500,
      joinGuardMs: 1100,
      // Chat-spam budget per bot, as a token bucket rather than a fixed gap.
      //
      // MEASURED against this server (test/spam-probe.mjs, sustained /p list):
      //    20/s -> kicked after 10 commands      1/s  -> SURVIVED
      //    10/s -> kicked after 10               0.5/s -> SURVIVED
      //     5/s -> kicked after 12
      //     3/s -> kicked after 14
      //     2/s -> kicked after 18
      // Those numbers fit one model exactly: +1 per command, -1 per SECOND, kick above ~10.
      // So it is NOT a rate limit - a burst of 10 is fine and a steady 2/s is fatal. A fixed
      // gap gets this wrong in both directions: too slow for a short burst, still fatal if the
      // operator keeps clicking. The bucket allows a burst and then throttles to 1/s.
      burstCapacity: 8,        // stay under the measured ~10
      refillPerSecond: 1,      // the measured decrement rate
      retries: 0,             // default 0: a retried invite can double-invite
      ...defaults
    }
  }

  define (action, spec) {
    if (!spec || typeof spec.template !== 'string') {
      throw new Error(`command "${action}": template must be a string`)
    }
    this.#specs.set(action, { action, enabled: true, auth: false, ...spec })
    return this
  }

  defineAll (obj = {}) {
    for (const [action, spec] of Object.entries(obj)) {
      if (action.startsWith('_')) continue        // _comment and friends are documentation
      if (spec == null) continue
      this.define(action, spec)
    }
    return this
  }

  /** Wait out the per-bot send gap.
   *
   *  Public because not every line goes through run(): the dashboard's Learn button puts an
   *  arbitrary command on the wire so it can read the raw reply. That path used to bypass this
   *  entirely, which made Learn the one control that could trip the server's chat-spam kick. */
  async pace (bot) {
    if (!bot?.id) return 0
    const cap = this.#defaults.burstCapacity ?? 8
    const rate = this.#defaults.refillPerSecond ?? 1
    if (cap <= 0) return 0
    const now = Date.now()
    const b = this.#buckets.get(bot.id) ?? { tokens: cap, last: now }
    b.tokens = Math.min(cap, b.tokens + ((now - b.last) / 1000) * rate)
    b.last = now
    let waited = 0
    if (b.tokens < 1) {
      waited = Math.ceil(((1 - b.tokens) / rate) * 1000)
      await sleep(waited)
      b.tokens = 1
      b.last = Date.now()
    }
    b.tokens -= 1
    this.#buckets.set(bot.id, b)
    return waited
  }

  /** Put the token back when nothing actually left the socket, so a refused write does not
   *  silently eat the bot's spam budget. */
  refund (bot) {
    if (!bot?.id) return
    const b = this.#buckets.get(bot.id)
    if (b) b.tokens = Math.min(this.#defaults.burstCapacity ?? 8, b.tokens + 1)
  }

  noteSent (bot) { /* the bucket in pace() is the record; kept so callers read symmetrically */ }

  /** Run an arbitrary async step on this bot's serialisation chain.
   *
   *  Learn sends a raw line and watches the chat for a window. Without joining the chain it
   *  could run in the middle of a command's reply window: the command's classifier would
   *  capture the learn reply and the learn window would capture the command's, and both would
   *  report a verdict about the other's answer. */
  serialize (bot, fn) {
    const prev = this.#tail.get(bot.id) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.#tail.set(bot.id, next.then(() => {}, () => {}))
    return next
  }

  setGate (fn) { this.#gate = fn; return this }

  get (action) { return this.#specs.get(action) }
  list () { return [...this.#specs.values()] }

  /** Serialised per bot. Concurrent callers queue; ordering within a bot is preserved. */
  run (bot, action, vars = {}) {
    const prev = this.#tail.get(bot.id) ?? Promise.resolve()
    const next = prev.then(() => this.#run(bot, action, vars))
    this.#tail.set(bot.id, next.then(() => {}, () => {}))
    return next
  }

  async #run (bot, action, vars) {
    const startedAt = Date.now()
    const spec = this.#specs.get(action)
    const warn = (m) => this.log.warn?.(`[${bot.username}] ${m}`)

    const base = {
      id: nextId('cmd_'),
      seq: null,                       // filled in on emit
      at: startedAt,
      bot: bot.username,
      botId: bot.id,
      action,
      phase: spec?.phase ?? null,
      template: spec?.template ?? null,
      command: null,
      vars,
      status: null,
      pattern: null,
      groups: {},
      response: null,
      error: null,
      latencyMs: 0,
      botState: bot.fsm?.state ?? null,
      witnesses: []
    }

    const fail = (status, extra = {}) => this.#finish(bot, { ...base, status, latencyMs: Date.now() - startedAt, ...extra })

    if (!spec) return fail(STATUS.ERROR, { error: `no command defined for action "${action}"` })
    if (spec.enabled === false) return fail(STATUS.SKIPPED, { error: `action "${action}" is disabled` })
    if (typeof bot.send !== 'function') return fail(STATUS.ERROR, { error: 'bot has no transport' })

    base.command = renderTemplate(spec.template, vars)

    // ---- local gates (cheap, and they keep the bot out of AuthMe's kick path) ----
    if (!bot.sendable()) {
      return fail(STATUS.ERROR, { error: `transport not in PLAY (state=${bot.fsm?.state})` })
    }
    if (!spec.auth && !bot.isReady()) {
      return fail(STATUS.BLOCKED, {
        error: `bot is ${bot.fsm?.state}, not READY: AuthMe would cancel this command, and inside the join window it would kick the bot`
      })
    }
    if (!spec.auth && this.#gate) {
      const reason = this.#gate(bot, spec)
      if (reason) return fail(STATUS.BLOCKED, { error: reason })
    }

    // ---- AuthMe join guard ----
    const guardMs = spec.joinGuardMs ?? this.#defaults.joinGuardMs
    let waited = 0
    if (!spec.auth && bot.joinedAt) {
      waited = Math.max(0, guardMs - (Date.now() - bot.joinedAt))
      if (waited > 0) await sleep(waited)
      if (!bot.isReady() && !spec.auth) {
        // Authentication finished while we waited, or never will. Re-check rather than fire blind.
        return fail(STATUS.BLOCKED, { error: 'bot lost READY while waiting out the join guard' })
      }
    }
    base.waitedMs = waited

    // Rate limit: one bot must not put two commands on the wire closer together than
    // minSendGapMs. Placed BEFORE the reply timer starts, so the gap is never charged against
    // the command's own timeout. See the note on the default for why this exists.
    base.rateWaitedMs = await this.pace(bot)

    const timeoutMs = spec.timeoutMs ?? this.#defaults.timeoutMs
    const success = toRegexList(spec.success, warn)
    const failure = [...toRegexList(BASELINE_FAILURES, warn), ...toRegexList(spec.failure, warn)]
    const noise = toRegexList(NOISE, warn)

    return new Promise((resolve) => {
      let done = false
      const finish = (status, extra) => {
        if (done) return
        done = true
        clearTimeout(timer)
        offChat(); offKick(); offEnd(); offDisc(); offDead()
        resolve(this.#finish(bot, { ...base, status, latencyMs: Date.now() - startedAt, waitedMs: waited, ...extra }))
      }

      const offChat = this.bus.on(EV.MC_CHAT, (e) => {
        if (e.botId !== bot.id) return
        if (e.isOwnEcho) return                    // 1.8 echoes your own chat back at you
        const verdict = classifyLine(e.text, { success, failure, noise })
        if (!verdict) { base.witnesses.push(e.text); return }
        finish(verdict.status, {
          pattern: verdict.pattern,
          groups: verdict.groups,
          response: e.text,
          // A FAILED line matched a failure pattern; keep the raw component for the dashboard.
          responseRaw: e.raw
        })
      })
      const onTransportGone = (kind) => (e) => {
        if (e.botId !== bot.id) return
        finish(STATUS.ERROR, { error: `${kind}: ${e.text ?? e.reason ?? 'transport closed'}` })
      }
      const offKick = this.bus.on(EV.MC_KICK, onTransportGone('kicked'))
      const offDisc = this.bus.on(EV.MC_DISCONNECT, onTransportGone('disconnected'))
      const offEnd = this.bus.on(EV.MC_END, (e) => {
        if (e.botId !== bot.id) return
        finish(STATUS.ERROR, { error: `connection ended: ${e.reason}` })
      })
      // An INTENTIONAL disconnect emits none of the transport events above, so a command in
      // flight while the operator pressed Disconnect would sit there until its own timeout and
      // then report NO_RESPONSE - the wrong answer, arrived at slowly. DEAD is reached by every
      // path, so the command fails immediately and says so.
      const offDead = this.bus.on(EV.BOT_STATE, (e) => {
        if (e.botId !== bot.id || e.to !== 'DEAD') return
        if (this.#buckets.has(bot.id)) { /* keep the spam budget; a reconnect continues it */ }
        finish(STATUS.ERROR, { error: 'bot disconnected while the command was in flight' })
      })

      const timer = setTimeout(() => finish(STATUS.NO_RESPONSE, {
        error: `no reply matched any pattern within ${timeoutMs}ms`,
        hint: 'an unknown command still replies — a true silence usually means the command was accepted and the plugin is silent, or an operator pattern is missing'
      }), timeoutMs)

      const sent = bot.send(base.command)
      if (!sent) { this.refund(bot); finish(STATUS.ERROR, { error: 'write refused: transport left PLAY' }) }
      else this.noteSent(bot)
    })
  }

  #finish (bot, result) {
    const event = this.bus.emit(EV.CMD_RESULT, result)
    result.seq = event.seq
    return result
  }

  /** Test seam: classify a line exactly as a run() would, without a bot or a socket. */
  static classify = classifyLine
  static STATUS = STATUS
  static PATTERNS = PATTERNS
}

export { STATUS }
