export class StabilityMonitor {
  constructor ({ cfg = {}, bus, presence, combat = null, log = console }) {
    this.cfg = cfg
    this.bus = bus
    this.presence = presence
    this.combat = combat
    this.log = log
    this.fleet = null
    this.last = new Map()
    this.subs = []
    this.timer = null
    this.lastWarnAt = 0
    this.recovering = new Set()
    this.lastRecoveryAt = new Map()
  }

  attach (fleet) {
    this.fleet = fleet
    this.#sub('bedwars:presence', (e) => {
      if (e.stage === 'match') this.sample('match-enter')
    })
    this.timer = setInterval(() => {
      const match = (this.fleet?.bots ?? []).some((bot) => this.presence.stateOf(bot.id).stage === 'match')
      this.sample(match ? 'match' : 'lobby')
    }, 5000)
    this.timer.unref?.()
    return this
  }

  dispose () {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const off of this.subs) { try { off() } catch {} }
    this.subs = []
    this.last.clear()
    this.recovering.clear()
    this.lastRecoveryAt.clear()
    return this
  }

  #sub (topic, fn) {
    this.subs.push(this.bus.on(topic, fn))
  }

  sample (scope = 'manual') {
    const now = Date.now()
    const bots = []
    for (const bot of this.fleet?.bots ?? []) {
      const health = bot.transport?.healthSnapshot?.() ?? null
      if (!health) continue
      const io = health.io ?? {}
      const prev = this.last.get(bot.id)
      const elapsed = prev ? Math.max(0.001, (now - prev.at) / 1000) : null
      const rxPps = prev && Number.isFinite(io.rxPackets) ? Math.max(0, (io.rxPackets - prev.rxPackets) / elapsed) : null
      const txPps = prev && Number.isFinite(io.txPackets) ? Math.max(0, (io.txPackets - prev.txPackets) / elapsed) : null
      const rates = (current = {}, previous = {}) => Object.entries(current)
        .map(([name, count]) => [name, prev ? Math.max(0, (count - (previous[name] ?? 0)) / elapsed) : 0])
        .filter(([, rate]) => rate > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
      const rxTopPps = rates(io.rxByName, prev?.rxByName)
      const txTopPps = rates(io.txByName, prev?.txByName)
      this.last.set(bot.id, { at: now, rxPackets: io.rxPackets ?? 0, txPackets: io.txPackets ?? 0, rxByName: { ...(io.rxByName ?? {}) }, txByName: { ...(io.txByName ?? {}) } })
      const { rxByName, txByName, ...ioSummary } = io
      const cleanHealth = { ...health, io: ioSummary }
      const stage = this.presence.stateOf(bot.id).stage
      this.#recoverStale(now, bot, stage, cleanHealth)
      bots.push({
        bot: bot.username,
        botId: bot.id,
        stage,
        combat: this.combat?.stateOf(bot.id) ?? null,
        rxPps,
        txPps,
        rxTopPps,
        txTopPps,
        health: cleanHealth
      })
    }
    if (!bots.length) return null
    const eventLoop = bots[0]?.health?.eventLoop ?? null
    this.bus.emit('network:health', { scope, eventLoop, bots })
    if (scope.startsWith('match')) this.#warn(now, bots, eventLoop)
    return bots
  }

  #recoverStale (now, bot, stage, health) {
    const f = this.cfg.fleet ?? {}
    const configured = Number(f.staleRxReconnectMs ?? 60000)
    if (!Number.isFinite(configured) || configured <= 0) return
    const staleMs = Math.max(10000, configured)
    if (!bot?.isReady?.() || health?.connected !== true || !['mode', 'match'].includes(stage)) return
    const rxAgo = health.io?.lastRxAgoMs
    const txAgo = health.io?.lastTxAgoMs
    if (!Number.isFinite(rxAgo) || !Number.isFinite(txAgo) || rxAgo < staleMs) return
    const txRecentMs = Math.max(1000, Number(f.staleRxTxRecentMs ?? 15000))
    if (txAgo > txRecentMs) return
    const cooldownMs = Math.max(staleMs, Number(f.staleRxRecoveryCooldownMs ?? 60000))
    if (this.recovering.has(bot.id) || now - (this.lastRecoveryAt.get(bot.id) ?? 0) < cooldownMs) return
    this.recovering.add(bot.id)
    this.lastRecoveryAt.set(bot.id, now)
    const error = Object.assign(new Error('stale inbound traffic for ' + Math.round(rxAgo) + 'ms'), { code: 'ETIMEDOUT' })
    bot.proxyManager?.reportFailure?.(bot.username, bot.activeRoute, error)
    this.log.warn?.('[stability] ' + bot.username + ' has no inbound traffic for ' + Math.round(rxAgo) + 'ms while still transmitting; recycling connection')
    Promise.resolve(this.fleet?.recoverBot?.(bot, 'stale-rx'))
      .catch((err) => this.log.warn?.('[stability] ' + bot.username + ' stale-rx recovery failed: ' + err.message))
      .finally(() => this.recovering.delete(bot.id))
  }

  #warn (now, bots, eventLoop) {
    if (now - this.lastWarnAt < 10000) return
    const loopMs = Number(eventLoop?.rolling30sMaxMs ?? eventLoop?.maxMs ?? 0)
    const stale = bots.filter((row) => Number(row.health?.io?.lastKeepAliveRxAgoMs) > 25000)
    const noisy = bots.filter((row) => Number(row.txPps) > 200)
    if (loopMs < 500 && !stale.length && !noisy.length) return
    this.lastWarnAt = now
    this.log.warn?.(`[stability] match anomaly loop30sMax=${loopMs.toFixed(1)}ms staleKeepAlive=${stale.length} txOver200pps=${noisy.length}`)
  }
}
