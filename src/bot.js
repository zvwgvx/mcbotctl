import { Fsm, S } from './fsm.js'
import { EV } from './bus.js'
import { Transport } from './transport/client.js'
import { MineflayerTransport } from './transport/mineflayer.js'

export class Bot {
  constructor ({ username, password, index = 0, cfg, proxyManager = null, bus, engine, log = console }) {
    this.username = username
    this.password = password
    this.index = index
    this.cfg = cfg
    this.bus = bus
    this.engine = engine
    this.proxyManager = proxyManager
    this.log = log
    this.id = `${index}:${username}`
    this.authAttempts = 0
    this.superseded = false
    this.stopping = false
    this.startPromise = null
    this.startGeneration = 0
    this.activeRoute = null
    this.activeConnectionGeneration = null
    this.subs = []

    this.fsm = new Fsm(S.DISCONNECTED, (t) => {
      if (!t.applied) {
        this.log.warn?.(`[${username}] illegal state transition ${t.from} -> ${t.to} (ignored)`)
        return
      }
      this.bus.emit(EV.BOT_STATE, { botId: this.id, bot: username, from: t.from, to: t.to })
      if (t.to === S.READY) this.bus.emit(EV.BOT_READY, { botId: this.id, bot: username })
    })

    this.transport = cfg.transport === 'raw'
      ? new Transport({ botId: this.id, username, server: cfg.server, proxyFor: () => this.proxyRoute(), log, bus })
      : new MineflayerTransport({ botId: this.id, username, server: cfg.server, proxyFor: () => this.proxyRoute(), log, bus })

    this.subs.push(bus.on(EV.MC_JOIN, (e) => {
      if (e.botId !== this.id || !this.acceptsConnectionEvent(e)) return
      const generation = Number(e.connection?.generation)
      if (Number.isFinite(generation)) this.activeConnectionGeneration = generation
      this.fsm.to(S.PLAY)
    }))
    for (const topic of [EV.MC_KICK, EV.MC_DISCONNECT, EV.MC_END]) {
      this.subs.push(bus.on(topic, (e) => {
        if (e.botId !== this.id || !this.acceptsConnectionEvent(e)) return
        const prePlay = this.fsm.state === S.CONNECTING
        const message = [e.text, e.reason, e.socket?.event, e.socket?.errorMessage].filter(Boolean).join(' ')
        const failure = Object.assign(new Error(message || 'connection ended'), { code: e.socket?.errorCode })
        if (!prePlay) this.proxyManager?.reportFailure?.(this.username, this.activeRoute, failure)
        this.fsm.to(S.DEAD)
      }))
    }
    this.subs.push(bus.on(EV.MC_WARN, (e) => {
      if (e.botId === this.id) this.log.warn?.(`[${username}] ${e.why} :: ${JSON.stringify(e.text)}`)
    }))
    this.subs.push(bus.on(EV.MC_ERROR, (e) => {
      if (e.botId === this.id && this.acceptsConnectionEvent(e)) this.log.warn?.(`[${username}] net: ${e.error.message}`)
    }))
  }

  get joinedAt () { return this.transport.joinedAt }
  get protocolState () { return this.transport.state }
  sendable () { return this.transport.state === 'play' }
  isReady () { return this.fsm.state === S.READY }

  currentConnectionGeneration () {
    const generation = Number(this.transport?.activeSession?.generation ?? this.activeConnectionGeneration)
    return Number.isFinite(generation) ? generation : null
  }

  acceptsConnectionEvent (event) {
    const generation = Number(event?.connection?.generation)
    if (!Number.isFinite(generation)) return true
    const current = this.currentConnectionGeneration()
    return current == null || generation === current
  }

  proxyRoute () {
    return this.proxyManager?.routeFor(this.username) ?? { kind: 'direct', mode: 'off', blocked: false, proxy: null }
  }

  proxyStatus () {
    return this.proxyManager?.publicRouteFor(this.username) ?? {
      bot: this.username,
      kind: 'direct',
      mode: 'off',
      proxyId: null,
      proxyName: null,
      address: null,
      blocked: false,
      reason: null
    }
  }

  async start () {
    const st = this.fsm.state
    if (st === S.PLAY || st === S.AUTH || st === S.READY) return this
    if (st === S.CONNECTING && this.startPromise) return this.startPromise
    const route = this.proxyRoute()
    if (route.blocked) throw Object.assign(new Error(route.reason), { kind: 'proxy' })
    this.stopping = false
    this.activeRoute = route
    this.fsm.to(S.CONNECTING)
    const generation = ++this.startGeneration
    const promise = (async () => {
      try {
        await this.transport.connect()
        this.proxyManager?.reportSuccess?.(this.username, route)
        return this
      } catch (error) {
        this.proxyManager?.reportFailure?.(this.username, route, error)
        if (this.startGeneration === generation && this.fsm.state === S.CONNECTING) this.fsm.to(S.DEAD)
        throw error
      } finally {
        if (this.startGeneration === generation) this.startPromise = null
      }
    })()
    this.startPromise = promise
    return promise
  }

  send (text) {
    return this.transport.send(text)
  }

  run (action, vars) {
    return this.engine.run(this, action, vars)
  }

  stop (reason = 'stop') {
    this.stopping = true
    this.startGeneration++
    this.startPromise = null
    this.transport.end(reason)
    if (this.fsm.state !== S.DEAD) this.fsm.to(S.DEAD)
  }

  dispose () {
    for (const off of this.subs.splice(0)) {
      try { off() } catch {}
    }
  }
}
