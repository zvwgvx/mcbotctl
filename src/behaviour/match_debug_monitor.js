import { EV } from '../bus.js'

const KEEP = 10

function push (arr, value) {
  arr.push(value)
  if (arr.length > KEEP) arr.splice(0, arr.length - KEEP)
}

function packetRate (row, name) {
  return Number((row?.rxTopPps ?? []).find(([packet]) => packet === name)?.[1] ?? 0)
}

function classify (row) {
  const tx = Number(row?.txPps ?? 0)
  const entities = Number(row?.health?.mineflayer?.entities ?? 0)
  const transaction = packetRate(row, 'transaction')
  if (tx >= 40 && transaction >= 20) return 'game-like'
  if (tx <= 35 && entities >= 120) return 'lobby-like'
  return 'uncertain'
}

export class MatchDebugMonitor {
  constructor ({ bus, presence, tracker = null, log = console }) {
    this.bus = bus
    this.presence = presence
    this.tracker = tracker
    this.log = log
    this.fleet = null
    this.recent = new Map()
    this.lastFingerprint = new Map()
    this.lastMismatchAt = new Map()
    this.subs = []
  }

  attach (fleet) {
    this.fleet = fleet
    this.#sub(EV.MC_CHAT, (e) => {
      const r = this.#recent(e.botId)
      push(r.chat, { at: e.at, position: e.position ?? null, text: String(e.text ?? '').slice(0, 320) })
    })
    this.#sub(EV.MC_SCOREBOARD, (e) => {
      const r = this.#recent(e.botId)
      const snap = {
        at: e.at,
        visible: !!e.visible,
        objective: e.objective ?? null,
        title: String(e.title ?? '').slice(0, 160),
        lines: (e.lines ?? []).map((line) => String(line).slice(0, 200)).slice(0, 24)
      }
      const sig = JSON.stringify([snap.visible, snap.objective, snap.title, snap.lines])
      if (r.scoreboardSig !== sig) {
        r.scoreboardSig = sig
        push(r.scoreboards, snap)
      }
    })
    this.#sub(EV.MC_TITLE, (e) => {
      const r = this.#recent(e.botId)
      push(r.titles, { at: e.at, action: e.action ?? null, text: String(e.text ?? '').slice(0, 320) })
    })
    this.#sub('network:health', (e) => this.#onHealth(e))
    for (const topic of [EV.MC_KICK, EV.MC_DISCONNECT, EV.MC_END, EV.MC_ERROR]) {
      this.#sub(topic, (e) => this.#terminal(topic, e))
    }
    return this
  }

  dispose () {
    for (const off of this.subs) { try { off() } catch {} }
    this.subs = []
    this.recent.clear()
    this.lastFingerprint.clear()
    this.lastMismatchAt.clear()
  }

  #sub (topic, fn) {
    this.subs.push(this.bus.on(topic, fn))
  }

  #recent (botId) {
    if (!this.recent.has(botId)) this.recent.set(botId, { chat: [], scoreboards: [], titles: [], scoreboardSig: null })
    return this.recent.get(botId)
  }

  #bot (botId) {
    return this.fleet?.bots?.find((bot) => bot.id === botId) ?? null
  }

  #context (row) {
    const bot = this.#bot(row.botId)
    const recent = this.#recent(row.botId)
    return {
      presence: this.presence.stateOf(row.botId),
      party: bot ? this.tracker?.entry?.(bot.username) ?? null : null,
      health: {
        rxPps: row.rxPps,
        txPps: row.txPps,
        rxTopPps: row.rxTopPps,
        txTopPps: row.txTopPps,
        eventLoop: row.health?.eventLoop ?? null,
        io: row.health?.io ?? null,
        endpoint: row.health?.endpoint ?? null,
        mineflayer: row.health?.mineflayer ?? null,
        position: row.health?.position ?? null,
        game: row.health?.game ?? null,
        scoreboard: row.health?.scoreboard ?? null
      },
      recent: {
        chat: recent.chat.slice(-8),
        scoreboards: recent.scoreboards.slice(-6),
        titles: recent.titles.slice(-8)
      }
    }
  }

  #emit (kind, row, extra = {}) {
    this.bus.emit('match:debug', {
      kind,
      bot: row.bot,
      botId: row.botId,
      fingerprint: classify(row),
      ...extra,
      ...this.#context(row)
    })
  }

  #onHealth (e) {
    const now = Date.now()
    for (const row of e.bots ?? []) {
      const fingerprint = classify(row)
      const prev = this.lastFingerprint.get(row.botId)
      if (prev == null) {
        this.lastFingerprint.set(row.botId, fingerprint)
        this.#emit('baseline', row, { from: null, to: fingerprint, scope: e.scope })
      } else if (fingerprint !== prev && fingerprint !== 'uncertain') {
        this.lastFingerprint.set(row.botId, fingerprint)
        this.#emit('fingerprint-transition', row, { from: prev, to: fingerprint, scope: e.scope })
        this.log.info?.(`[match-debug] ${row.bot} ${prev} -> ${fingerprint}`)
      }

      const stage = this.presence.stateOf(row.botId).stage
      const isPreGame = (row.health?.scoreboard?.lines ?? []).some((l) => /starting|waiting|\bplayers:\s*\d+\/\d+/i.test(l))
      const mismatch = (fingerprint === 'game-like' && stage !== 'match' && !isPreGame) ||
        (fingerprint === 'lobby-like' && stage === 'match')
      if (mismatch && now - (this.lastMismatchAt.get(row.botId) ?? 0) >= 15000) {
        this.lastMismatchAt.set(row.botId, now)
        this.#emit('detector-mismatch', row, { detectedStage: stage, scope: e.scope })
      }
    }
  }

  #terminal (topic, e) {
    const row = {
      bot: e.bot,
      botId: e.botId,
      rxPps: null,
      txPps: null,
      rxTopPps: [],
      txTopPps: [],
      health: this.#bot(e.botId)?.transport?.healthSnapshot?.() ?? {}
    }
    this.#emit('terminal', row, {
      terminalTopic: topic,
      reason: e.reason ?? e.text ?? e.error?.message ?? String(e.error ?? '')
    })
  }
}
