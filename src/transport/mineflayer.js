// transport/mineflayer.js — the same transport surface as client.js, backed by mineflayer.
//
// WHY THIS EXISTS. A raw minecraft-protocol client was measured against a real anti-cheat and
// found silent at exactly the packets that separate a client from a bot: it never answered
// `transaction`, and Kauri flagged every raw bot `BadPackets (N)` about twelve times per tick,
// past VL 1200 in a minute, while a mineflayer bot on the same server was never flagged once.
// mineflayer also brings real physics (measured to match vanilla 1.8 to four decimals, ramp
// included) and block placement, which is what bridging and combat need.
//
// WHAT IT KEEPS. Everything above this file - the engine, the behaviours, the party tracker, the
// area gate, the web console, all 63 flow assertions - talks to a transport through a narrow
// surface, so none of it has to know which implementation it has. The surface is:
//
//   connect() send(text) writePacket(name,params) moveTo(...) setControl(...) look(...)
//   placeBlockAt(...) selectHotbar(n) useItem() clickWindow(slot,button) closeWindow() end()
//   inventoryItems() clickWindowConfirmed(slot,button) activateBlockAt(x,y,z)
//   pos  state  connected  openWindow  username
//
// and the bus events: MC_JOIN MC_CHAT MC_SENT MC_KICK MC_DISCONNECT MC_END MC_ERROR MC_WARN
// MC_WINDOW_OPEN MC_WINDOW_CLOSE MC_WINDOW_ITEMS MC_POSITION
//
// WHAT IT CHANGES. Mineflayer owns physics. Where the raw transport let a behaviour write a
// position directly, this one takes the input instead - setControl and look - and lets the
// physics engine move the bot. That is the point: pressing keys is what a player does, and it is
// what an anti-cheat expects to see.

import mineflayer from 'mineflayer'
import { EventEmitter } from 'node:events'
import { pathfinder } from 'mineflayer-pathfinder'
import { Vec3 as Vec3Class } from 'vec3'
import { EV } from '../bus.js'
import { flattenReason, stripLegacy } from '../util.js'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { connectViaSocks } from '../proxy/socks.js'

const loopDelay = monitorEventLoopDelay({ resolution: 20 })
loopDelay.enable()
let loopStats = { meanMs: 0, maxMs: 0, p99Ms: 0 }
const loopHistory = []
const loopTimer = setInterval(() => {
  const mean = Number(loopDelay.mean)
  const max = Number(loopDelay.max)
  const p99 = Number(loopDelay.percentile(99))
  loopStats = {
    meanMs: Number.isFinite(mean) ? mean / 1e6 : 0,
    maxMs: Number.isFinite(max) ? max / 1e6 : 0,
    p99Ms: Number.isFinite(p99) ? p99 / 1e6 : 0
  }
  loopHistory.push({ at: Date.now(), ...loopStats })
  while (loopHistory.length > 60) loopHistory.shift()
  loopDelay.reset()
}, 1000)
loopTimer.unref?.()

export class MineflayerTransport extends EventEmitter {
  constructor ({ botId, username, server, proxyFor = null, log, bus }) {
    super()
    this.botId = botId
    this.username = username
    this.server = server
    this.proxyFor = proxyFor
    this.log = log ?? console
    this.bus = bus
    this.state = 'disconnected'
    this.pos = null
    this.openWindow = null
    this.windowAction = 0
    this.joinedAt = null
    this.lastError = null
    this.socketTrace = null
    this.stopped = false
    // Tells a behaviour that this transport owns real physics, so movement should be requested
    // as input (setControl/look) rather than written as positions.
    this.physics = true
    this.mc = null
    this.mcData = null
    // A Mineflayer bot is backed by one minecraft-protocol client and one TCP socket. Keep the
    // pair together, rather than treating `this.mc` as a loose mutable pointer: reconnecting
    // while a previous socket is still closing otherwise permits two logins for one username.
    this.activeSession = null
    this.connectionGeneration = 0
    this.connectPromise = null
    // Entity IDs are reused after reconnect. A shop candidate belongs to one connection only.
    this.entitySession = 0
  }

  get connected () {
    return this.state === 'play' && !!this.activeSession && !this.activeSession.socketClosed
  }

  healthSnapshot () {
    const session = this.activeSession
    if (!session) return null
    const out = this.#traceSnapshot(session)
    const mc = this.mc
    return {
      ...out,
      state: this.state,
      connected: this.connected,
      mineflayer: {
        entities: Object.keys(mc?.entities ?? {}).length,
        players: Object.keys(mc?.players ?? {}).length,
        currentWindow: mc?.currentWindow?.title ?? null,
        physicsEnabled: mc?.physicsEnabled ?? null
      },
      position: this.pos ? { ...this.pos } : null,
      game: {
        dimension: mc?.game?.dimension ?? null,
        gameMode: mc?.game?.gameMode ?? null,
        difficulty: mc?.game?.difficulty ?? null,
        levelType: mc?.game?.levelType ?? null
      },
      scoreboard: mc?.scoreboard?.sidebar ? {
        objective: mc.scoreboard.sidebar.name ?? null,
        title: stripLegacy(mc.scoreboard.sidebar.title ?? ''),
        lines: mc.scoreboard.sidebar.items?.map((item) => stripLegacy(String(item.displayName ?? item.name))).slice(0, 24) ?? []
      } : null
    }
  }

  /** Mineflayer's version string normalises 1.8.9 to 1.8.8 internally (same protocol 47), so the
   *  declared value and the resolved one differ. Report the resolved one. */
  get protocolState () { return this.state }

  /**
   * Return one pending attempt to every concurrent caller. Bot.start() already has a guard,
   * but the transport must enforce the same invariant itself because it is also used directly
   * by diagnostic and web code.
   */
  connect () {
    if (this.connectPromise) return this.connectPromise
    const pending = this.#open()
    this.connectPromise = pending
    void pending.then(
      () => { if (this.connectPromise === pending) this.connectPromise = null },
      () => { if (this.connectPromise === pending) this.connectPromise = null }
    )
    return pending
  }

  async #open () {
    const previous = this.activeSession
    if (previous && !previous.socketClosed) {
      // A healthy socket is never replaced in place. Starting a second login with the same
      // username makes many offline-mode servers disconnect both clients.
      if (!previous.closeRequested && !previous.outcome) {
        throw new Error('transport already has a live connection')
      }
      await this.#waitForSocketClose(previous)
    }

    const { host, port, version } = this.server
    const route = this.proxyFor?.() ?? { kind: 'direct', mode: 'off', blocked: false, proxy: null }
    if (route.blocked) throw Object.assign(new Error(route.reason), { kind: 'proxy' })
    this.entitySession += 1
    this.stopped = false
    this.state = 'connecting'
    this.pos = null
    this.openWindow = null

    let bot
    try {
      bot = mineflayer.createBot({
        host, port, username: this.username, version: version ?? '1.8.9', auth: 'offline',
        // The protocol library defaults to a 30 s keep-alive watchdog. Use the same configured
        // tolerance as the raw transport so a quiet proxy hop does not close a healthy match.
        keepAlive: false,
        viewDistance: this.server.viewDistance ?? 'tiny',
        maxCatchupTicks: this.server.maxCatchupTicks ?? 1,
        plugins: { particle: false, fishing: false, sound: false },
        // Errors are emitted on the bus with a per-connection trace below. Letting Mineflayer
        // also print them produces duplicate, context-free lines in the service log.
        hideErrors: true,
        ...(route.kind === 'proxy'
          ? {
              fakeHost: host,
              connect: (client) => connectViaSocks(client, route, {
                host,
                port,
                timeoutMs: this.server.connectTimeoutMs ?? 30000
              })
            }
          : {})
      })
    } catch (error) {
      this.state = 'disconnected'
      this.lastError = error
      this.bus.emit(EV.MC_ERROR, { botId: this.botId, bot: this.username, error })
      throw error
    }

    bot._client?.on('keep_alive', (packet) => {
      try { bot._client.write('keep_alive', { keepAliveId: packet.keepAliveId }) } catch {}
    })

    const session = this.#newSession(bot)
    this.activeSession = session
    this.mc = bot
    this.socketTrace = session.trace
    this.#guardLateSocket(session)
    // Direct TCP connections install the socket synchronously inside createBot(). Attach now,
    // rather than waiting for `connect`, so ECONNREFUSED and pre-connect errors are observable.
    this.#observeSocket(session, bot._client?.socket)
    this.#installIoTrace(session)
    this.#installLifecycle(session)

    try {
      bot.loadPlugin(pathfinder)
      await this.#waitForSpawn(session)
    } catch (error) {
      if (this.#isCurrent(session) && !session.outcome && !session.intentional) {
        this.#noteClient(session, 'connect-failed', error)
        this.#publishEnd(session, error.text ?? error.message ?? 'connection failed')
      }
      this.#requestClose(session, 'socketClosed', false)
      throw error
    }

    if (!this.#isCurrent(session) || session.outcome || session.intentional || this.state !== 'connecting') {
      throw new Error('connection ended during spawn')
    }

    this.state = 'play'
    this.joinedAt = Date.now()
    this.#wire(bot, session)
    this.bus.emit(EV.MC_JOIN, {
      botId: this.botId,
      bot: this.username,
      connection: this.#connectionMeta(session)
    })
    return this
  }

  #newSession (bot) {
    let resolveClosed
    const closed = new Promise((resolve) => { resolveClosed = resolve })
    return {
      bot,
      generation: ++this.connectionGeneration,
      trace: {
        event: null,
        hadError: null,
        errorCode: null,
        errorMessage: null,
        clientReason: null,
        sequence: []
      },
      io: {
        rxPackets: 0,
        txPackets: 0,
        rxByName: {},
        txByName: {},
        lastRxAt: null,
        lastTxAt: null,
        lastRxName: null,
        lastTxName: null,
        keepAliveRx: 0,
        keepAliveTx: 0,
        lastKeepAliveRxAt: null,
        lastKeepAliveTxAt: null,
        lastKeepAliveId: null
      },
      closed,
      resolveClosed,
      socket: null,
      observedSocket: null,
      socketClosed: false,
      closeRequested: false,
      intentional: false,
      outcome: null,
      forceCloseTimer: null,
      forceFinalizeTimer: null,
      abortConnect: null,
      // Mineflayer forwards every minecraft-protocol error to bot.error, but it also uses
      // bot.error for recoverable plugin warnings (for example an out-of-order scoreboard
      // update). Remember protocol errors so those two paths publish once and only the former
      // closes a connection.
      clientErrors: new WeakSet(),
      listeners: []
    }
  }

  #isCurrent (session) {
    return this.activeSession === session && this.mc === session.bot && !session.socketClosed
  }

  #connectionMeta (session) {
    return {
      generation: session.generation,
      current: this.#isCurrent(session),
      socketObserved: !!session.observedSocket,
      intentional: session.intentional
    }
  }

  #traceSnapshot (session) {
    const trace = session.trace
    const io = session.io
    const now = Date.now()
    const socket = session.socket ?? session.bot?._client?.socket
    const mem = process.memoryUsage()
    const age = (value) => value == null ? null : Math.max(0, now - value)
    const recentLoop = loopHistory.filter((entry) => now - entry.at <= 30000)
    const rolling30sMaxMs = recentLoop.reduce((ret, entry) => Math.max(ret, entry.maxMs), loopStats.maxMs)
    const rolling30sP99MaxMs = recentLoop.reduce((ret, entry) => Math.max(ret, entry.p99Ms), loopStats.p99Ms)
    return {
      event: trace.event,
      hadError: trace.hadError,
      errorCode: trace.errorCode,
      errorMessage: trace.errorMessage,
      clientReason: trace.clientReason,
      sequence: [...trace.sequence],
      io: {
        rxPackets: io.rxPackets,
        txPackets: io.txPackets,
        lastRxName: io.lastRxName,
        lastTxName: io.lastTxName,
        lastRxAgoMs: age(io.lastRxAt),
        lastTxAgoMs: age(io.lastTxAt),
        keepAliveRx: io.keepAliveRx,
        keepAliveTx: io.keepAliveTx,
        rxByName: { ...io.rxByName },
        txByName: { ...io.txByName },
        lastKeepAliveRxAgoMs: age(io.lastKeepAliveRxAt),
        lastKeepAliveTxAgoMs: age(io.lastKeepAliveTxAt),
        lastKeepAliveId: io.lastKeepAliveId
      },
      endpoint: {
        localAddress: socket?.localAddress ?? null,
        localPort: socket?.localPort ?? null,
        remoteAddress: socket?.remoteAddress ?? null,
        remotePort: socket?.remotePort ?? null
      },
      eventLoop: { ...loopStats, rolling30sMaxMs, rolling30sP99MaxMs },
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external
      }
    }
  }

  #note (session, source, extra = {}) {
    const trace = session.trace
    if (trace.sequence.length < 16) trace.sequence.push(source)
    if (extra.event && !trace.event) trace.event = extra.event
    if (extra.hadError != null) trace.hadError = !!extra.hadError
    if (extra.errorCode && !trace.errorCode) trace.errorCode = String(extra.errorCode)
    if (extra.errorMessage && !trace.errorMessage) trace.errorMessage = String(extra.errorMessage).slice(0, 240)
    if (extra.clientReason && !trace.clientReason) trace.clientReason = String(extra.clientReason).slice(0, 240)
  }

  #noteClient (session, source, error) {
    const message = String(error?.message ?? error ?? '')
    const timeout = /(?:timed? out|timeout|keep.?alive)/i.test(message)
    this.#note(session, `client:${source}`, {
      event: timeout ? 'timeout' : 'error',
      errorCode: error?.code ?? error?.errno ?? null,
      errorMessage: message
    })
  }

  #notePacket (session, direction, name, packet) {
    const io = session.io
    const now = Date.now()
    const key = String(name ?? '')
    if (direction === 'rx') {
      io.rxPackets++
      io.rxByName[key] = (io.rxByName[key] ?? 0) + 1
      io.lastRxAt = now
      io.lastRxName = key
      if (key === 'keep_alive') {
        io.keepAliveRx++
        io.lastKeepAliveRxAt = now
        io.lastKeepAliveId = String(packet?.keepAliveId ?? '')
      }
      return
    }
    io.txPackets++
    io.txByName[key] = (io.txByName[key] ?? 0) + 1
    io.lastTxAt = now
    io.lastTxName = key
    if (key === 'keep_alive') {
      io.keepAliveTx++
      io.lastKeepAliveTxAt = now
      io.lastKeepAliveId = String(packet?.keepAliveId ?? '')
    }
  }

  #installIoTrace (session) {
    const client = session.bot?._client
    if (!client) return
    this.#listen(session, client, 'packet', (packet, meta) => {
      this.#notePacket(session, 'rx', meta?.name, packet)
    }, { prepend: true })
    const write = client.write?.bind(client)
    if (typeof write !== 'function') return
    client.write = (name, params) => {
      this.#notePacket(session, 'tx', name, params)
      return write(name, params)
    }
  }

  #listen (session, emitter, event, listener, { prepend = false } = {}) {
    if (!emitter?.on) return
    if (prepend && typeof emitter.prependListener === 'function') emitter.prependListener(event, listener)
    else emitter.on(event, listener)
    session.listeners.push({ emitter, event, listener })
  }

  #removeSessionListeners (session) {
    for (const { emitter, event, listener } of session.listeners.splice(0)) {
      try { emitter.removeListener?.(event, listener) } catch {}
    }
  }

  /**
   * minecraft-protocol starts DNS/SRV work before Mineflayer returns. If stop() wins that race,
   * a late DNS callback can otherwise create a brand-new TCP socket after the fleet moved on.
   * Reject that socket at the setSocket boundary before it can send a login packet.
   */
  #guardLateSocket (session) {
    const client = session.bot._client
    if (!client || client.__mcbotctlSetSocketGuard) return
    const setSocket = client.setSocket?.bind(client)
    if (typeof setSocket !== 'function') return
    client.__mcbotctlSetSocketGuard = true
    client.setSocket = (socket) => {
      if (session.closeRequested || !this.#isCurrent(session)) {
        client.__mcbotctlConnectionCancelled = true
        try { socket?.destroy?.() } catch {}
        return undefined
      }
      const result = setSocket(socket)
      this.#observeSocket(session, socket)
      return result
    }
  }

  #observeSocket (session, socket) {
    if (!socket || session.observedSocket === socket || session.socketClosed) return
    session.socket = socket
    session.observedSocket = socket
    try { socket.setKeepAlive?.(true, this.#tcpKeepAliveDelayMs()) } catch {}
    this.#listen(session, socket, 'end', () => {
      this.#note(session, 'tcp:end', { event: 'end' })
    }, { prepend: true })
    this.#listen(session, socket, 'timeout', () => {
      this.#note(session, 'tcp:timeout', { event: 'timeout' })
      // minecraft-protocol emits `end` for a socket timeout but does not itself destroy the
      // descriptor. Close it on the next microtask, after its own timeout listener runs.
      queueMicrotask(() => this.#requestClose(session, 'socketClosed', false))
    }, { prepend: true })
    this.#listen(session, socket, 'error', (error) => {
      this.#note(session, 'tcp:error', {
        event: 'error',
        errorCode: error?.code ?? error?.errno ?? null,
        errorMessage: error?.message
      })
    }, { prepend: true })
    this.#listen(session, socket, 'close', (hadError) => {
      this.#note(session, 'tcp:close', { event: 'close', hadError })
      // The minecraft-protocol close listener publishes Mineflayer's `end` synchronously in
      // this same EventEmitter dispatch. Finish after it, otherwise that terminal event is lost.
      queueMicrotask(() => this.#finishSession(session))
    }, { prepend: true })
  }

  #installLifecycle (session) {
    const { bot } = session
    this.#listen(session, bot._client, 'connect', () => {
      this.#note(session, 'tcp:connect')
      this.#observeSocket(session, bot._client?.socket)
    })
    // Mineflayer installs its client -> bot error forwarder while createBot() runs. Prepend our
    // protocol listener so bot.error can tell a fatal socket/codec error from a plugin warning.
    this.#listen(session, bot._client, 'error', (error) => {
      if (!this.#isCurrent(session)) return
      if (error && (typeof error === 'object' || typeof error === 'function')) session.clientErrors.add(error)
      this.lastError = error
      this.#noteClient(session, 'error', error)
      // A kicked client is already terminal. Socket teardown can still emit a normal ECONNRESET
      // afterwards; keep it in the trace but do not turn one server decision into two failures.
      if (!session.intentional && !session.outcome) {
        this.bus.emit(EV.MC_ERROR, {
          botId: this.botId,
          bot: this.username,
          error,
          socket: this.#traceSnapshot(session),
          connection: this.#connectionMeta(session)
        })
      }
      // A client error from this stack is either a TCP fatal error or a packet codec failure;
      // neither is safe to keep in PLAY. Defer the close until Mineflayer has delivered this
      // same error to the pre-spawn waiter, so a failed login reports the original error rather
      // than an artificial "ended before spawn" race.
      if (!session.intentional && !session.outcome) {
        queueMicrotask(() => this.#requestClose(session, 'socketClosed', false))
      }
    }, { prepend: true })
    this.#listen(session, bot, 'error', (error) => {
      if (!this.#isCurrent(session)) return
      if (error && (typeof error === 'object' || typeof error === 'function') && session.clientErrors.has(error)) return
      // Mineflayer itself uses bot.error for recoverable plugin issues. Surface those with the
      // current generation and trace, but leave a healthy TCP session alone.
      this.lastError = error
      this.#note(session, 'mineflayer:error', { errorMessage: error?.message ?? error })
      if (!session.intentional && !session.outcome) {
        this.bus.emit(EV.MC_ERROR, {
          botId: this.botId,
          bot: this.username,
          error,
          source: 'mineflayer',
          socket: this.#traceSnapshot(session),
          connection: this.#connectionMeta(session)
        })
      }
    })
    this.#listen(session, bot, 'kicked', (reason, loggedIn) => {
      if (!this.#isCurrent(session) || session.intentional) return
      const text = flattenReason(reason)
      this.state = 'dead'
      this.openWindow = null
      // Mineflayer folds the protocol's login-state `disconnect` and play-state
      // `kick_disconnect` packets into one event. Its second argument retains the distinction:
      // false means the server rejected the login; true means it kicked an established player.
      const terminal = loggedIn === false ? EV.MC_DISCONNECT : EV.MC_KICK
      this.#publish(session, terminal, { text })
      // Mineflayer reports the terminal server packet but minecraft-protocol intentionally leaves
      // its socket open. Let the pre-spawn waiter see it first, then end it before any reconnect
      // can claim the same username.
      queueMicrotask(() => this.#requestClose(session, 'kicked', false))
    })
    this.#listen(session, bot, 'end', (reason) => {
      if (!this.#isCurrent(session)) return
      this.#note(session, 'client:end', { clientReason: reason })
      if (!session.intentional && !session.outcome) this.#publishEnd(session, reason ?? 'socketClosed')
      if (session.intentional) {
        this.state = 'disconnected'
        this.openWindow = null
      }
      // `end` means the protocol pipeline has stopped, not necessarily that the TCP descriptor
      // is gone. Wait for close, with a short forced-close fallback, before another connect.
      this.#armCloseWatchdog(session)
    })
  }

  #publish (session, topic, payload = {}) {
    if (!this.#isCurrent(session) || session.outcome) return false
    session.outcome = topic
    this.bus.emit(topic, {
      botId: this.botId,
      bot: this.username,
      ...payload,
      socket: this.#traceSnapshot(session),
      connection: this.#connectionMeta(session)
    })
    return true
  }

  #publishEnd (session, reason) {
    if (!this.#isCurrent(session) || session.intentional || session.outcome) return false
    this.state = 'disconnected'
    this.openWindow = null
    return this.#publish(session, EV.MC_END, { reason })
  }

  #disconnectGraceMs () {
    const configured = Number(this.server.disconnectGraceMs)
    return Number.isFinite(configured) && configured > 0 ? configured : 2000
  }

  #tcpKeepAliveDelayMs () {
    const configured = Number(this.server.tcpKeepAliveInitialDelayMs)
    // TCP keepalive is a second, low-level safety net for an idle NAT/proxy hop. Minecraft's
    // application keep-alives remain authoritative; this only starts after a quiet interval.
    return Number.isFinite(configured) && configured >= 1000 && configured <= 300_000
      ? configured : 30_000
  }

  #requestClose (session, reason, intentional) {
    if (!session || session.socketClosed) return
    if (session.bot?._client) session.bot._client.__mcbotctlConnectionCancelled = true
    if (intentional) {
      session.intentional = true
      this.stopped = true
      if (this.#isCurrent(session)) {
        this.state = 'disconnected'
        this.openWindow = null
      }
      session.abortConnect?.(new Error('connection stopped by caller'))
    } else if (this.#isCurrent(session) && this.state === 'play') {
      // Gate all writes between an error/timeout and the final socket close.
      this.state = 'closing'
    }
    if (!session.closeRequested) {
      session.closeRequested = true
      try { session.bot.quit(reason) } catch {
        try { session.bot._client?.end(reason) } catch {}
      }
    }
    this.#armCloseWatchdog(session)
  }

  #armCloseWatchdog (session) {
    if (session.socketClosed || session.forceCloseTimer) return
    session.forceCloseTimer = setTimeout(() => {
      session.forceCloseTimer = null
      if (session.socketClosed) return
      this.#note(session, 'transport:force-close')
      const socket = session.socket ?? session.bot._client?.socket
      try { socket?.destroy?.() } catch {}
      session.forceFinalizeTimer = setTimeout(() => this.#finishSession(session), 50)
      session.forceFinalizeTimer.unref?.()
    }, this.#disconnectGraceMs())
    session.forceCloseTimer.unref?.()
  }

  #finishSession (session) {
    if (!session || session.socketClosed) return
    // A close can occur without minecraft-protocol's end listener (for example after a failed
    // DNS hand-off). Preserve a single terminal outcome rather than silently losing it.
    if (this.#isCurrent(session) && !session.intentional && !session.outcome) {
      this.#publishEnd(session, session.trace.clientReason ?? 'socketClosed')
    }
    session.socketClosed = true
    clearTimeout(session.forceCloseTimer)
    clearTimeout(session.forceFinalizeTimer)
    this.#removeSessionListeners(session)
    session.resolveClosed()
    if (this.activeSession === session) {
      this.openWindow = null
      if (this.state !== 'dead') this.state = 'disconnected'
      this.mc = null
      this.activeSession = null
    }
  }

  async #waitForSocketClose (session) {
    if (session.socketClosed) return
    this.#armCloseWatchdog(session)
    await session.closed
  }

  #waitForSpawn (session) {
    const { bot } = session
    const client = bot._client
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        bot.removeListener('spawn', onSpawn)
        client?.removeListener('error', onError)
        bot.removeListener('end', onEnd)
        bot.removeListener('kicked', onKick)
        if (session.abortConnect === abort) session.abortConnect = null
        fn(value)
      }
      const onSpawn = () => finish(resolve)
      const onError = (error) => finish(reject, error)
      const onEnd = (reason) => finish(reject, Object.assign(
        new Error(`ended before spawn: ${reason ?? 'socketClosed'}`),
        { kind: 'end', text: reason ?? 'socketClosed' }))
      const onKick = (reason) => {
        const text = flattenReason(reason)
        finish(reject, Object.assign(new Error(`kicked before spawn: ${text}`), { kind: 'kick', text }))
      }
      const abort = (error) => finish(reject, error)
      const configuredTimeout = Number(this.server.connectTimeoutMs)
      const connectTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout : 30000
      const timer = setTimeout(() => finish(reject, Object.assign(
        new Error(`spawn timed out after ${connectTimeoutMs}ms`), { kind: 'timeout' })), connectTimeoutMs)
      session.abortConnect = abort
      bot.once('spawn', onSpawn)
      client?.once('error', onError)
      bot.once('end', onEnd)
      bot.once('kicked', onKick)
    })
  }

  #wire (bot, session) {
    const isCurrent = () => this.#isCurrent(session) && this.state === 'play'
    // Track position from mineflayer's own entity, which its physics keeps current.
    const onMove = () => {
      if (!isCurrent()) return
      const p = bot.entity?.position
      if (!p) return
      this.pos = { x: p.x, y: p.y, z: p.z, yaw: bot.entity.yaw ?? 0, pitch: bot.entity.pitch ?? 0 }
    }
    this.#listen(session, bot, 'physicsTick', onMove)
    this.#listen(session, bot, 'move', onMove)

    // Chat. `messagestr` is already flattened by mineflayer; `message` carries the JSON component,
    // which the Learn flow needs for discovering click commands.
    this.#listen(session, bot, 'messagestr', (text, position, jsonMsg) => {
      if (!isCurrent() || !text) return
      this.bus.emit(EV.MC_CHAT, {
        botId: this.botId, bot: this.username, text,
        raw: jsonMsg ? JSON.stringify(jsonMsg) : text,
        position: position ?? 1, at: Date.now(), isOwnEcho: false
      })
    })
    this.#listen(session, bot._client, 'title', (packet) => {
      if (!isCurrent()) return
      const actions = ['title', 'subtitle', 'times', 'clear', 'reset']
      this.bus.emit(EV.MC_TITLE, {
        botId: this.botId,
        bot: this.username,
        action: actions[Number(packet?.action)] ?? String(packet?.action ?? 'unknown'),
        text: packet?.text == null ? '' : stripLegacy(flattenReason(packet.text))
      })
    })

    // The server's visible sidebar is evidence of which game the player reached. A selector
    // click is only an action; the sidebar arrives after the server has actually moved the bot.
    // Mineflayer maintains the score lines and team display names for us.
    const publishSidebar = (sidebar = bot.scoreboard?.sidebar) => {
      if (!isCurrent()) return
      this.bus.emit(EV.MC_SCOREBOARD, {
        botId: this.botId,
        bot: this.username,
        visible: !!sidebar,
        objective: sidebar?.name ?? null,
        title: sidebar ? stripLegacy(sidebar.title ?? '') : '',
        lines: sidebar?.items?.map((item) => stripLegacy(String(item.displayName ?? item.name))) ?? []
      })
    }
    this.#listen(session, bot, 'scoreboardPosition', (position, scoreboard) => {
      if (position === 1) publishSidebar(scoreboard)
    })
    // Mineflayer does not emit scoreboardPosition when the server clears the sidebar with an
    // empty objective name. Forward that absence so BedWars presence can expire after its grace.
    this.#listen(session, bot._client, 'scoreboard_display_objective', (packet) => {
      if (packet.position === 1 && !packet.name) publishSidebar(null)
    })
    this.#listen(session, bot, 'scoreboardTitleChanged', (scoreboard) => {
      if (scoreboard?.name === bot.scoreboard?.sidebar?.name) publishSidebar(scoreboard)
    })
    this.#listen(session, bot, 'scoreUpdated', (scoreboard) => {
      if (scoreboard?.name === bot.scoreboard?.sidebar?.name) publishSidebar(scoreboard)
    })
    this.#listen(session, bot, 'scoreRemoved', (scoreboard) => {
      if (scoreboard?.name === bot.scoreboard?.sidebar?.name) publishSidebar(scoreboard)
    })
    this.#listen(session, bot, 'scoreboardDeleted', (scoreboard) => {
      if (scoreboard?.name === bot.scoreboard?.sidebar?.name) publishSidebar(null)
    })

    // Windows / GUI. mineflayer hands us an object with id, title, slots and type.
    this.#listen(session, bot, 'windowOpen', (w) => {
      if (!isCurrent()) return
      // `slots` is not necessarily populated when windowOpen fires - the contents arrive on a
      // later packet - so an absent length is reported as null ("unknown"), not 0 ("empty").
      // Reporting 0 made a caller's bounds check reject every click into a window that was fine.
      // inventoryStart is the size of the shop area. slots.length also includes the player's
      // 36 inventory slots, so it is not a safe bound for a shop click.
      const n = Number.isInteger(w.inventoryStart) ? w.inventoryStart : null
      // Strip both the JSON quoting AND the legacy colour codes. A live server sent
      // "§r         Server Selector", so an expectTitle of "Server Selector" could never match -
      // the title looked right in the log and compared wrong.
      this.openWindow = { windowId: w.id, title: String(w.title ?? '').replace(/^"|"$/g, '').replace(/\u00a7./g, '').trim(), slotCount: n, type: w.type }
      this.windowAction = 0
      this.bus.emit(EV.MC_WINDOW_OPEN, { botId: this.botId, bot: this.username, ...this.openWindow })
    })
    this.#listen(session, bot, 'windowClose', (w) => {
      if (!isCurrent()) return
      const was = this.openWindow
      this.openWindow = null
      this.bus.emit(EV.MC_WINDOW_CLOSE, { botId: this.botId, bot: this.username, windowId: w?.id ?? was?.windowId, was })
    })
    this.#listen(session, bot._client, 'window_items', (p) => {
      if (!isCurrent()) return
      this.bus.emit(EV.MC_WINDOW_ITEMS, { botId: this.botId, bot: this.username, windowId: p.windowId, items: p.items })
    })
  }

  /** Chat is the same packet on 1.8.9 whatever the client library, so the engine's token bucket
   *  still governs the rate. */
  send (text) {
    if (!this.connected) {
      this.bus.emit(EV.MC_WARN, { botId: this.botId, bot: this.username, text, why: `write refused: state is "${this.state}"` })
      return false
    }
    try { this.mc.chat(text) }
    catch (e) { this.bus.emit(EV.MC_WARN, { botId: this.botId, bot: this.username, text, why: `write failed: ${e.message}` }); return false }
    this.bus.emit(EV.MC_SENT, { botId: this.botId, bot: this.username, text })
    return true
  }

  /** Escape hatch for raw packets mineflayer does not expose. Kept because the transport surface
   *  should not become the limit of what the tool can do. */
  writePacket (name, params) {
    if (!this.connected) return false
    try { this.mc._client.write(name, params); this.bus.emit(EV.MC_SENT, { botId: this.botId, bot: this.username, text: `${name} ${JSON.stringify(params).slice(0, 100)}` }); return true }
    catch (e) { this.bus.emit(EV.MC_WARN, { botId: this.botId, bot: this.username, text: name, why: `write failed: ${e.message}` }); return false }
  }

  // ---------------------------------------------------------------- movement
  //
  // Intent, not positions. This is the whole point of using a physics engine: the behaviour says
  // "hold forward and look this way" and the engine produces a movement a player could produce,
  // acceleration ramp and all. Measured against a live server: walk 0.2158 b/t, sprint 0.2804,
  // sneak 0.0648 - vanilla to four decimals.

  setControl (name, on) {
    if (!this.connected) return false
    try { this.mc.setControlState(name, !!on); return true } catch { return false }
  }

  clearControls () {
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']) {
      try { this.mc.setControlState(c, false) } catch {}
    }
  }

  async look (yaw, pitch, force = true) {
    if (!this.connected) return false
    try { await this.mc.look(yaw, pitch, force); return true } catch { return false }
  }

  async lookAtPoint (x, y, z, force = true) {
    if (!this.connected) return false
    try { await this.mc.lookAt(new (await import('vec3')).Vec3(x, y, z), force); return true } catch { return false }
  }

  /** Send position and look explicitly. Only for callers that have already computed a position -
   *  the normal path is setControl(). */
  moveTo (x, y, z, yaw, pitch, onGround = true) {
    return this.writePacket('position_look', { x, y, z, yaw, pitch, onGround })
  }

  /** Place a block against `refVec`'s face. Verified working on 1.8.9 against the live server:
   *  air at the target before, wool after, confirmed by the server's own view of that coordinate. */
  async placeBlockAt (refVec, faceVec) {
    if (!this.connected) return false
    const ref = refVec instanceof Vec3Class ? refVec : new Vec3Class(refVec.x, refVec.y, refVec.z)
    const face = new Vec3Class(faceVec.x, faceVec.y, faceVec.z)
    const refBlock = this.mc.blockAt(ref)
    if (!refBlock) return false
    try { await this.mc.placeBlock(refBlock, face); return true } catch (e) { this.lastError = e; return false }
  }

  /** The world, as mineflayer knows it. A bridging behaviour cannot decide anything without
   *  asking what is under the bot and what is in front of it. */
  blockAt (x, y, z) {
    if (!this.connected) return null
    try {
      const Vec3 = this.#Vec3()
      return this.mc.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))
    } catch { return null }
  }

  isSolid (x, y, z) {
    const b = this.blockAt(x, y, z)
    return !!(b && b.boundingBox === 'block')
  }

  isAir (x, y, z) {
    const b = this.blockAt(x, y, z)
    return !!b && (b.name === 'air' || b.boundingBox === 'empty')
  }

  /** Put a placeable block in hand. Returns the item, or null if the bot has none. */
  async equipBlock () {
    if (!this.connected) return null
    const PLACEABLE = /(wool|planks|log|stone|cobble|dirt|sand|clay|glass|terracotta|concrete|netherrack|obsidian|brick|leaves)/i
    const inv = this.mc.inventory.items()
    for (const pass of ['hand', 'any']) {
      const it = inv.find((i) => PLACEABLE.test(i.name) && (pass === 'any' || i.slot < 45))
      if (it) { try { await this.mc.equip(it, 'hand'); return it } catch { return null } }
    }
    return null
  }

  heldItem () { return this.mc?.heldItem ?? null }

  /** The server-synchronised player inventory. Item.type is the numeric 1.8 item ID. */
  inventoryItems () {
    try { return this.mc?.inventory?.items().map((item) => ({ ...item })) ?? [] } catch { return [] }
  }

  #Vec3 () { return Vec3Class }

  /** Hold a control until the bot has actually moved, or give up.
   *
   *  A fixed sleep is wrong here: the same key press takes a different time depending on whether
   *  the bot is sneaking (0.0648 b/t), walking (0.2158) or accelerating from a standstill, and a
   *  bridge that steps before it has arrived walks off the block it just placed. Returns how far
   *  it actually moved, so the caller can tell "blocked" from "slow". */
  async advance (distance = 1, timeoutMs = 2500) {
    const start = { ...this.pos }
    this.setControl('forward', true)
    const t0 = Date.now()
    let moved = 0
    try {
      while (Date.now() - t0 < timeoutMs) {
        await new Promise((r) => setTimeout(r, 50))
        // x=0 is a perfectly valid world coordinate. The old truthiness check treated a bot
        // crossing the origin as if position tracking had failed, which made movement stutter.
        if (!this.pos || !Number.isFinite(start.x) || !Number.isFinite(start.z)) break
        moved = Math.hypot(this.pos.x - start.x, this.pos.z - start.z)
        if (moved >= distance) break
        if (!this.connected) break
      }
    } finally { this.setControl('forward', false) }
    return moved
  }

  /** Activate the item in hand (right-click in the air). */
  useItem () {
    if (!this.connected) return false
    try { this.mc.activateItem(); return true } catch { return false }
  }

  /** 1-indexed, the way a player counts hotbar slots. */
  selectHotbar (slot) {
    if (!this.connected) return false
    try { this.mc.setQuickBarSlot(Number(slot) - 1); return true } catch { return false }
  }

  // --------------------------------------------------------------------- GUI

  clickWindow (slot, button = 'right') {
    if (!this.connected || !this.openWindow) return false
    this.windowAction += 1
    try {
      this.mc.clickWindow(Number(slot), button === 'right' ? 1 : 0, 0).catch((e) => {
        this.lastError = e
        this.bus.emit(EV.MC_WARN, { botId: this.botId, bot: this.username, text: 'window_click', why: e.message })
      })
      return true
    } catch { return false }
  }

  /** Await the 1.8 transaction confirmation before deciding whether a shop click landed. */
  async clickWindowConfirmed (slot, button = 'left') {
    if (!this.connected || !this.openWindow) return false
    try {
      await this.mc.clickWindow(Number(slot), button === 'right' ? 1 : 0, 0)
      return true
    } catch (e) { this.lastError = e; return false }
  }

  closeWindow () {
    if (!this.connected || !this.openWindow) return false
    try {
      const window = this.mc.currentWindow
      if (!window || window.id !== this.openWindow.windowId) return false
      Promise.resolve(this.mc.closeWindow(window)).catch((e) => { this.lastError = e })
      return true
    } catch { return false }
  }

  /** Activate an entity - how a shopkeeper NPC is opened. */
  async activateEntity (entity) {
    if (!this.connected || !entity) return false
    const live = this.resolveEntityCandidate(entity)
    if (!live) return false
    try { await this.mc.activateEntity(live); return true } catch (e) { this.lastError = e; return false }
  }

  /** Entity discovery is limited to entities in chunks loaded by this client. */
  loadedEntities () {
    if (!this.connected || !this.mc?.entities) return []
    return Object.values(this.mc.entities)
  }

  /** Resolve a discovery result immediately before interacting; reject despawns and reconnects. */
  resolveEntityCandidate (candidate) {
    if (!this.connected || candidate?.id == null) return null
    if (candidate.session != null && candidate.session !== this.entitySession) return null
    const live = this.mc?.entities?.[candidate.id]
    if (!live || (candidate.entity && candidate.entity !== live)) return null
    // A raw mineflayer entity from findEntityByName is also accepted, if it is still live.
    if (candidate.position && candidate.entity == null && candidate !== live && candidate.session == null) return null
    return live
  }

  /** Open a chest-style shop at a configured block coordinate. */
  async activateBlockAt (x, y, z) {
    if (!this.connected) return false
    const block = this.blockAt(x, y, z)
    if (!block || block.name === 'air') return false
    try { await this.mc.activateBlock(block); return true } catch (e) { this.lastError = e; return false }
  }

  /** Find a nearby entity by name, for the shop-NPC flow. */
  findEntityByName (name, maxDistance = 8, entityType = '') {
    if (!this.connected) return null
    const me = this.mc.entity.position
    let best = null, bestD = Infinity
    for (const e of Object.values(this.mc.entities)) {
      if (entityType && ![e.name, e.type].some((kind) => String(kind ?? '').toLowerCase() === String(entityType).toLowerCase())) continue
      // In 1.8 a named villager still has displayName="Villager". The visible NPC name
      // arrives in metadata index 2, so include that field when finding the shopkeeper.
      const labels = [e.username, e.metadata?.[2], e.displayName, e.name]
      if (!labels.some((label) => stripLegacy(String(label ?? '')).toLowerCase().includes(stripLegacy(name).toLowerCase()))) continue
      const d = e.position.distanceTo(me)
      if (d < bestD && d <= maxDistance) { best = e; bestD = d }
    }
    return best
  }

  end (reason = 'clientClosed') {
    this.clearControls()
    const session = this.activeSession
    if (!session) {
      this.stopped = true
      this.state = 'disconnected'
      return
    }
    // Do not merely call quit() and immediately permit another connect. A graceful Minecraft
    // disconnect can leave TCP in flight; #open waits for this session's close (or its bounded
    // destroy fallback) before a new login can be created.
    this.#requestClose(session, reason, true)
  }

  /**
   * Resolve only after the active socket has emitted close, or after the bounded destroy
   * fallback has made it impossible for that session to send a late login. Fleet replacement
   * uses this before constructing a new transport for the same account names.
   */
  async waitForClose () {
    const session = this.activeSession
    // Waiting must never turn a healthy match into a forced disconnect. Callers that intend
    // to stop use endAndWait(); this method only waits for a close already in progress.
    if (!session || (!session.closeRequested && !session.outcome && this.state === 'play')) return false
    await this.#waitForSocketClose(session)
    return true
  }

  /** Deliberately end the current session and wait for its TCP ownership to be released. */
  async endAndWait (reason = 'clientClosed') {
    const session = this.activeSession
    this.end(reason)
    if (session) await this.#waitForSocketClose(session)
  }
}
