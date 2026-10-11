// action_supervisor.js — one exclusive gameplay lane per bot.
//
// A Mineflayer bot has one set of movement keys, one view direction, one pathfinder goal, and
// one current window. Letting independently-timed behaviours manipulate those at once causes
// stale callbacks to clear a newer action's keys or use a menu that another action opened. This
// class does not know what an action *does*. It only grants a bounded lease to one executor at a
// time, carries an AbortSignal through that executor, and invalidates the lease on a reconnect.

import { EV } from '../bus.js'
import { nextId } from '../util.js'

export const ACTION_PRIORITIES = Object.freeze({
  background: 100,
  combat: 200,
  autoplay: 300,
  manual: 400,
  safety: 500,
  lifecycle: 600
})

export const DEFAULT_ACTION_SUPERVISOR = Object.freeze({
  // A cancelled executor must be allowed to observe its AbortSignal and release listeners before
  // a replacement begins. The timeout only releases the lane; it cannot make an arbitrary
  // promise stop, so executors must use the supplied signal and current-lease guard.
  cancelGraceMs: 900,
  // A task should normally provide its own timeout. This cap prevents a forgotten task from
  // owning a bot indefinitely; `timeoutMs: false` explicitly opts out for a supervised loop.
  timeoutMs: 45_000
})

function boundedMs (value, fallback, min = 0, max = 300_000) {
  if (value === false || value === null) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= min && number <= max ? Math.floor(number) : fallback
}

function text (value, fallback = '') {
  const out = String(value ?? '').trim()
  return out || fallback
}

function priorityOf (value, fallbackOwner = '') {
  if (value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value))) {
    const number = Math.floor(Number(value))
    return { value: Math.max(0, Math.min(10_000, number)), name: 'custom' }
  }

  const aliases = {
    background: 'background', idle: 'background', movement: 'background',
    combat: 'combat',
    autoplay: 'autoplay', play: 'autoplay',
    manual: 'manual', operator: 'manual', dashboard: 'manual',
    safety: 'safety', emergency: 'safety',
    lifecycle: 'lifecycle', connection: 'lifecycle'
  }
  const requested = text(value || fallbackOwner, 'background').toLowerCase()
  const name = aliases[requested] ?? 'background'
  return { value: ACTION_PRIORITIES[name], name }
}

function connectionOf (bot) {
  const transport = bot?.transport ?? null
  const generation = Number(transport?.connectionGeneration)
  const session = transport?.activeSession ?? null
  const sessionGeneration = Number(session?.generation)
  return {
    transport,
    // Mineflayer exposes both values; raw transports may expose neither. Prefer the public
    // transport counter because it changes before a newly-created session starts doing work.
    generation: Number.isFinite(generation)
      ? generation
      : (Number.isFinite(sessionGeneration) ? sessionGeneration : null),
    session,
    mc: transport?.mc ?? null,
    joinedAt: Number.isFinite(Number(transport?.joinedAt)) ? Number(transport.joinedAt) : null
  }
}

function sameConnection (bot, connection) {
  const transport = bot?.transport ?? null
  if (!connection?.transport || transport !== connection.transport) return false

  // A session/mc identity catches a reconnect even for a transport implementation that does not
  // publish a generation counter. Never let an old lease call clearControls() on a new mc object.
  if (connection.session && transport.activeSession !== connection.session) return false
  if (connection.mc && transport.mc !== connection.mc) return false

  const live = connectionOf(bot)
  if (connection.generation != null && live.generation !== connection.generation) return false
  if (connection.joinedAt != null && live.joinedAt !== connection.joinedAt) return false
  return true
}

function publicConnection (connection) {
  return { generation: connection?.generation ?? null }
}

function cancelledResult (lease, reason = null) {
  return {
    status: 'CANCELLED',
    error: reason ?? lease.cancelReason ?? 'action lease is no longer current',
    leaseId: lease.id
  }
}

/**
 * Per-bot action arbiter.
 *
 * `run()` takes a request and an executor. The executor receives:
 *
 *   { bot, request, signal, lease, isCurrent, isOwner, assertCurrent, guard, cleanup }
 *
 * - Check `signal.aborted` after every await.
 * - Check `isCurrent()` before any delayed movement, GUI, look, or attack mutation.
 * - Use `isOwner()` only from a helper's `finally` cleanup. It stays true while the cancelled
 *   lease still owns the lane, but becomes false before a forced-release successor begins.
 * - Wrap a synchronous mutation in `guard(() => ...)` when it is convenient.
 *
 * Returning a result from the executor preserves that result. Admission conflicts return a
 * `{ status: 'BLOCKED', error, active }` result; executor exceptions still reject so their
 * caller can report the original failure. A higher priority request preempts the active lease.
 */
export class ActionSupervisor {
  constructor ({ cfg = {}, bus, log = console } = {}) {
    if (!bus?.on || !bus?.emit) throw new Error('ActionSupervisor needs an event bus')
    this.cfg = cfg
    this.bus = bus
    this.log = log
    this.fleet = null
    this.lanes = new Map() // botId -> { bot, active, lock }
    this.subs = []
    this.disposed = false
    this.disposePromise = null
  }

  get spec () {
    // Keep the config optional so the supervisor can be introduced before a config migration.
    return {
      ...DEFAULT_ACTION_SUPERVISOR,
      ...(this.cfg.actionSupervisor ?? this.cfg.autoplay?.supervisor ?? {})
    }
  }

  attach (fleet) {
    if (!fleet?.bots || !Array.isArray(fleet.bots)) throw new Error('ActionSupervisor.attach needs a fleet')
    if (this.disposed) throw new Error('ActionSupervisor has been disposed')

    // A runtime rebuild creates new Bot objects with the same ids. Remove old subscriptions
    // before retaining the replacement fleet, just as other runtime behaviours do.
    this.#unsubscribe()
    this.fleet = fleet

    const cancelFor = (event, reason) => {
      const bot = this.#botFor(event?.botId)
      if (!bot) return
      void this.cancel(bot, reason).catch((error) => {
        this.log.warn?.(`[${bot.username}] action cancellation failed: ${error.message}`)
      })
    }

    this.#sub(EV.BOT_STATE, (event) => {
      // READY is the only lifecycle state in which gameplay actions are valid. Cancelling on
      // every exit catches an auth reset before a delayed pathfinder/menu callback can run.
      if (event?.to && event.to !== 'READY') cancelFor(event, `bot state changed to ${event.to}`)
    })
    this.#sub(EV.MC_JOIN, (event) => cancelFor(event, 'transport joined a new connection'))
    for (const topic of [EV.MC_KICK, EV.MC_DISCONNECT, EV.MC_END]) {
      this.#sub(topic, (event) => cancelFor(event, `transport event: ${topic}`))
    }
    return this
  }

  /** Abort every active lease and remove lifecycle listeners. It returns a bounded settlement
   * promise; callers that have a shutdown await path can await it, while existing synchronous
   * runtime disposal remains safe because abort and listener removal happen immediately. */
  dispose () {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.#unsubscribe()
    const active = [...this.lanes.values()]
      .map((lane) => lane.bot)
      .filter(Boolean)
      .map((bot) => this.cancel(bot, 'action supervisor disposed'))
    this.disposePromise = Promise.allSettled(active).then(() => undefined)
    return this.disposePromise
  }

  /**
   * Obtain a lease and run `executor` under it.
   *
   * Request fields are deliberately generic: `owner`, `action`, `priority`, `timeoutMs`,
   * `cancelGraceMs`, `preempt`, and `blocksCombat`. Unknown fields are exposed to the executor
   * as `request` so an engine can keep its task metadata without extending this class.
   */
  async run (bot, request = {}, executor) {
    if (typeof request === 'string') request = { action: request }
    if (typeof executor !== 'function') throw new TypeError('ActionSupervisor.run needs an executor function')
    if (this.disposed) return this.#blocked(bot, request, 'action supervisor is disposed')
    if (!bot?.id) return this.#blocked(bot, request, 'bot needs an id')

    const problem = this.#admissionProblem(bot)
    if (problem) return this.#blocked(bot, request, problem)

    const normalized = this.#request(request)
    const lane = this.#lane(bot)
    const admitted = await this.#withLaneLock(lane, async () => {
      if (this.disposed) return { blocked: this.#blocked(bot, normalized, 'action supervisor is disposed') }

      const active = lane.active
      if (active) {
        const mayPreempt = normalized.priority > active.priority ||
          (normalized.priority === active.priority && normalized.preempt === true)
        if (!mayPreempt) {
          return { blocked: this.#blocked(bot, normalized, this.#heldReason(active), active) }
        }
        await this.#cancelLease(lane, active, `preempted by ${normalized.owner}:${normalized.action}`)
      }

      const afterCancel = this.#admissionProblem(bot)
      if (afterCancel) return { blocked: this.#blocked(bot, normalized, afterCancel) }
      const lease = this.#newLease(bot, normalized)
      lane.bot = bot
      lane.active = lease
      this.#emitLease(lease, 'acquired')
      return { lease }
    })

    if (admitted.blocked) return admitted.blocked
    return this.#execute(lane, admitted.lease, executor)
  }

  /** Cancel one bot's active action. Resolves after its executor settles or the grace window
   * expires. A forced release makes the old lease stale before another action can be admitted. */
  async cancel (bot, reason = 'cancelled') {
    const resolved = this.#resolveBot(bot)
    const lane = this.lanes.get(resolved?.id)
    if (!lane?.active) return false
    return this.#withLaneLock(lane, async () => {
      const lease = lane.active
      if (!lease) return false
      await this.#cancelLease(lane, lease, reason)
      return true
    })
  }

  /** A serialisable view of the current lease for one bot, or null when its lane is free. */
  activeOf (botId) {
    const lane = this.lanes.get(typeof botId === 'string' ? botId : botId?.id)
    return lane?.active ? this.#publicLease(lane.active) : null
  }

  /** Serialisable state suitable for the dashboard or a planner's diagnostic snapshot. */
  snapshot () {
    return [...this.lanes.values()]
      .map((lane) => lane.active ? this.#publicLease(lane.active) : {
        botId: lane.bot?.id ?? null,
        bot: lane.bot?.username ?? null,
        state: 'idle'
      })
      .sort((left, right) => String(left.bot ?? '').localeCompare(String(right.bot ?? '')))
  }

  /**
   * Synchronous gate for CombatBehaviour. Combat may continue only when the lane is empty or
   * when its own lease is current. An action can opt out with `blocksCombat: false`, but tasks
   * that touch movement, view, menus, or inventory should keep the safe default.
   */
  combatBlockReason (bot) {
    const active = this.activeOf(bot?.id)
    if (!active || active.blocksCombat === false || active.owner === 'combat') return null
    return `action lease ${active.owner}:${active.action} is active`
  }

  #sub (topic, fn) { this.subs.push(this.bus.on(topic, fn)) }

  #unsubscribe () {
    for (const off of this.subs.splice(0)) { try { off() } catch {} }
  }

  #resolveBot (bot) {
    if (bot && typeof bot === 'object') return bot
    return this.#botFor(bot)
  }

  #botFor (botId) {
    return this.fleet?.bots?.find((bot) => bot.id === botId) ?? null
  }

  #lane (bot) {
    let lane = this.lanes.get(bot.id)
    if (!lane) {
      lane = { bot, active: null, lock: Promise.resolve() }
      this.lanes.set(bot.id, lane)
    }
    // The current runtime can rebuild its fleet using stable bot ids. An idle retained lane may
    // safely point at the replacement Bot; an active one must retain its original identity until
    // it is cancelled, otherwise an old lease could clean controls on the replacement transport.
    if (!lane.active) lane.bot = bot
    return lane
  }

  async #withLaneLock (lane, operation) {
    const previous = lane.lock
    let release
    lane.lock = new Promise((resolve) => { release = resolve })
    await previous.catch(() => undefined)
    try { return await operation() } finally { release() }
  }

  #admissionProblem (bot) {
    if (!bot?.transport) return 'bot has no transport'
    if (typeof bot.isReady === 'function' && !bot.isReady()) return 'bot is not READY'
    if (bot.transport.connected === false) return 'transport is not connected'
    return null
  }

  #request (request) {
    const input = request && typeof request === 'object' ? request : {}
    const owner = text(input.owner ?? input.source, 'unknown')
    const action = text(input.action ?? input.kind ?? input.label, owner)
    const priority = priorityOf(input.priority ?? input.priorityClass, owner)
    const spec = this.spec
    return Object.freeze({
      ...input,
      owner,
      action,
      priority: priority.value,
      priorityName: priority.name,
      // Equal-priority replacement is opt-in. This prevents two autoplay observations from
      // repeatedly restarting one another when they race a state update.
      preempt: input.preempt === true,
      blocksCombat: input.blocksCombat !== false,
      timeoutMs: boundedMs(input.timeoutMs, boundedMs(spec.timeoutMs, DEFAULT_ACTION_SUPERVISOR.timeoutMs)),
      cancelGraceMs: boundedMs(
        input.cancelGraceMs === false ? undefined : input.cancelGraceMs,
        boundedMs(spec.cancelGraceMs === false ? undefined : spec.cancelGraceMs, DEFAULT_ACTION_SUPERVISOR.cancelGraceMs, 50),
        50
      ),
      metadata: input.metadata ?? input.meta ?? null
    })
  }

  #newLease (bot, request) {
    const controller = new AbortController()
    const connection = connectionOf(bot)
    const lease = {
      id: nextId('lease'),
      bot,
      botId: bot.id,
      botName: bot.username,
      request,
      owner: request.owner,
      action: request.action,
      priority: request.priority,
      priorityName: request.priorityName,
      blocksCombat: request.blocksCombat,
      connection,
      controller,
      startedAt: Date.now(),
      deadlineAt: request.timeoutMs == null ? null : Date.now() + request.timeoutMs,
      state: 'active',
      cancelRequestedAt: null,
      cancelReason: null,
      forcedReleaseAt: null,
      settledAt: null,
      timeout: null,
      cancelPromise: null,
      promise: null,
      resolveSettled: null,
      settled: null
    }
    lease.settled = new Promise((resolve) => { lease.resolveSettled = resolve })
    if (request.timeoutMs != null) {
      lease.timeout = setTimeout(() => {
        const lane = this.lanes.get(lease.botId)
        if (!lane) return
        void this.#withLaneLock(lane, async () => {
          if (lane.active === lease) await this.#cancelLease(lane, lease, 'action lease timed out')
        }).catch((error) => this.log.warn?.(`[${lease.botName}] action timeout cleanup failed: ${error.message}`))
      }, request.timeoutMs)
      lease.timeout.unref?.()
    }
    return lease
  }

  #execute (lane, lease, executor) {
    const context = {
      bot: lease.bot,
      request: lease.request,
      signal: lease.controller.signal,
      lease: this.#publicLease(lease),
      isCurrent: () => this.#isCurrent(lane, lease),
      // Cancellation makes isCurrent() false immediately. A helper may still need to release
      // the old pathfinder goal or GUI while this lease owns the lane, so expose the narrower
      // ownership check for cleanup only. It does not survive a forced release or reconnect.
      isOwner: () => this.#ownsLease(lane, lease),
      assertCurrent: () => this.#assertCurrent(lane, lease),
      guard: (fn, stale = false) => this.#isCurrent(lane, lease) ? fn() : stale,
      // An executor may use this in its own finally block. It cannot clear a replacement
      // connection or a newer lease because cleanup has the same identity/current checks.
      cleanup: () => this.#safeControlCleanup(lane, lease)
    }

    const running = Promise.resolve().then(() => {
      if (!this.#isCurrent(lane, lease)) return cancelledResult(lease)
      return executor(context)
    })
    lease.promise = running

    return running.then(
      (result) => {
        // Some helpers resolve a normal-looking result after observing AbortSignal instead of
        // rejecting. Preserve that result for their caller, but report the lease truthfully so a
        // planner never mistakes a cancelled action for a completed one.
        this.#settleLease(lane, lease, lease.controller.signal.aborted ? 'cancelled' : 'completed')
        return result
      },
      (error) => {
        this.#settleLease(lane, lease, lease.controller.signal.aborted ? 'cancelled' : 'failed', error)
        throw error
      }
    )
  }

  #isCurrent (lane, lease) {
    return lane?.active === lease && lease.state === 'active' && !lease.controller.signal.aborted && sameConnection(lease.bot, lease.connection)
  }

  #ownsLease (lane, lease) {
    return lane?.active === lease && sameConnection(lease.bot, lease.connection)
  }

  #assertCurrent (lane, lease) {
    if (this.#isCurrent(lane, lease)) return true
    const error = new Error(lease.cancelReason ?? 'action lease is no longer current')
    error.name = 'AbortError'
    throw error
  }

  #safeControlCleanup (lane, lease) {
    // `clearControls()` delegates through `transport.mc`; checking both the lane and captured
    // connection prevents an old callback from releasing a newer action's controls after a
    // reconnect or a forced handoff.
    if (!this.#ownsLease(lane, lease)) return false
    let changed = false
    try {
      // A pathfinder goal owns the same movement controls as the lease. Clear it while this
      // exact connection still belongs to the old action, before a successor can install a goal.
      lease.connection.mc?.pathfinder?.setGoal?.(null)
      changed = true
    } catch {}
    try {
      lease.connection.transport?.clearControls?.()
      changed = true
    } catch {}
    return changed
  }

  #safeWindowCleanup (lane, lease) {
    // Window ownership is just as important as keys: a delayed shop finally block must never
    // close a menu that a newer manual action opened. During cancellation the old lease is still
    // the owner, so close its window before a successor is admitted.
    if (!this.#ownsLease(lane, lease)) return false
    try {
      if (!lease.connection.transport?.openWindow) return false
      return lease.connection.transport.closeWindow?.() === true
    } catch { return false }
  }

  async #waitForWindowRelease (lane, lease, timeoutMs = 500) {
    const transport = lease?.connection?.transport
    const deadline = Date.now() + timeoutMs
    while (this.#ownsLease(lane, lease) && transport?.openWindow && Date.now() < deadline) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 25)
        timer.unref?.()
      })
    }
    return !transport?.openWindow
  }

  #settleLease (lane, lease, state, error = null) {
    if (lease.settledAt != null) return
    lease.settledAt = Date.now()
    lease.state = state
    if (lease.timeout) clearTimeout(lease.timeout)

    const owned = lane?.active === lease
    if (owned) {
      this.#safeControlCleanup(lane, lease)
      lane.active = null
    }
    this.#emitLease(lease, state, {
      reason: error?.message ?? lease.cancelReason ?? null,
      forced: lease.forcedReleaseAt != null
    })
    lease.resolveSettled?.({ state, forced: lease.forcedReleaseAt != null })
  }

  async #cancelLease (lane, lease, reason) {
    if (lane?.active !== lease) return { settled: lease.settledAt != null, stale: true }
    if (lease.cancelPromise) return lease.cancelPromise

    const cancelReason = text(reason, 'cancelled')
    lease.cancelReason = lease.cancelReason ?? cancelReason
    lease.cancelRequestedAt = lease.cancelRequestedAt ?? Date.now()
    lease.state = 'cancelling'
    try { lease.controller.abort(lease.cancelReason) } catch { lease.controller.abort() }
    this.#safeControlCleanup(lane, lease)
    this.#safeWindowCleanup(lane, lease)
    this.#emitLease(lease, 'cancel-requested', { reason: lease.cancelReason })

    const graceMs = lease.request.cancelGraceMs
    lease.cancelPromise = (async () => {
      // Do not give a successor the lane while this connection still reports the cancelled
      // shop/selector window as open. A short bounded wait avoids clicking a stale window id;
      // it never waits across a reconnect or beyond the cancellation grace window.
      await this.#waitForWindowRelease(lane, lease, Math.min(500, graceMs))
      const remainingGraceMs = Math.max(0, graceMs - (Date.now() - lease.cancelRequestedAt))
      const settled = await this.#waitForSettlement(lease, remainingGraceMs)
      if (!settled && lane.active === lease) {
        // Do not wait forever for an executor that ignored AbortSignal. It is now stale, so its
        // eventual finally block cannot use the supervisor's guarded cleanup on a new lease.
        lease.forcedReleaseAt = Date.now()
        lease.state = 'forced-release'
        if (lease.timeout) clearTimeout(lease.timeout)
        lane.active = null
        this.#emitLease(lease, 'forced-release', { reason: lease.cancelReason, forced: true })
      }
      return { settled, forced: !settled }
    })()
    return lease.cancelPromise
  }

  async #waitForSettlement (lease, graceMs) {
    if (lease.settledAt != null) return true
    let timer = null
    try {
      return await Promise.race([
        lease.settled.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), graceMs)
          timer.unref?.()
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  #blocked (bot, request, error, active = null) {
    const normalized = request?.owner ? request : this.#request(request)
    const result = {
      status: 'BLOCKED',
      error,
      botId: bot?.id ?? null,
      action: normalized.action,
      owner: normalized.owner,
      active: active ? this.#publicLease(active) : null
    }
    this.bus.emit('action:lease', {
      phase: 'blocked', state: 'blocked', botId: result.botId, bot: bot?.username ?? null,
      owner: normalized.owner, action: normalized.action, priority: normalized.priority,
      priorityName: normalized.priorityName, reason: error, active: result.active
    })
    return result
  }

  #heldReason (lease) {
    return `action lease held by ${lease.owner}:${lease.action} (priority ${lease.priority})`
  }

  #publicLease (lease) {
    return {
      leaseId: lease.id,
      botId: lease.botId,
      bot: lease.botName,
      owner: lease.owner,
      action: lease.action,
      priority: lease.priority,
      priorityName: lease.priorityName,
      blocksCombat: lease.blocksCombat,
      state: lease.state,
      startedAt: lease.startedAt,
      deadlineAt: lease.deadlineAt,
      cancelRequestedAt: lease.cancelRequestedAt,
      cancelReason: lease.cancelReason,
      connection: publicConnection(lease.connection),
      metadata: lease.request.metadata ?? null
    }
  }

  #emitLease (lease, phase, extra = {}) {
    this.bus.emit('action:lease', {
      phase,
      state: phase,
      ...this.#publicLease(lease),
      ...extra
    })
  }
}
