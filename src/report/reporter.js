// report/reporter.js — the reporting layer. Subscribes to the bus and owns no policy.
//
// Deliberately HTTP-free. The dashboard is not the V1 priority, and keeping this file free of
// node:http means the transport is swappable (stdio today, SSE or a WebSocket tomorrow) without
// touching it. The dashboard integration point is exactly two methods: snapshot() and subscribe().

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { EV } from '../bus.js'
import { summarise } from '../engine/classify.js'

export class Reporter {
  constructor ({ bus, log = console, jsonlPath = null, ringSize = 2000 }) {
    this.bus = bus
    this.log = log
    this.ringSize = ringSize
    this.results = []
    this.events = []                 // ring buffer of everything the dashboard might want
    this.counters = { ok: 0, failed: 0, noResponse: 0, blocked: 0, error: 0, skipped: 0 }
    this.startedAt = Date.now()
    this.subscribers = new Set()
    this.jsonlPath = jsonlPath
    if (jsonlPath) { try { mkdirSync(dirname(jsonlPath), { recursive: true }) } catch {} }

    bus.on('*', (e) => this.#onAny(e))
  }

  #onAny (e) {
    this.events.push({ seq: e.seq, at: e.at, topic: e.topic, bot: e.bot ?? null, summary: this.#summariseEvent(e) })
    if (this.events.length > this.ringSize) this.events.splice(0, this.events.length - this.ringSize)
    if (e.topic === EV.CMD_RESULT) this.#onResult(e)
    for (const fn of this.subscribers) { try { fn(e) } catch { /* a slow UI must not break the run */ } }
  }

  #onResult (r) {
    this.results.push(r)
    this.counters[r.status] = (this.counters[r.status] ?? 0) + 1
    if (this.jsonlPath) {
      try { appendFileSync(this.jsonlPath, JSON.stringify(r) + '\n') } catch { /* reporting must never be fatal */ }
    }
  }

  #summariseEvent (e) {
    switch (e.topic) {
      case EV.CMD_RESULT: return `${e.bot} ${e.action} -> ${e.status} ${e.pattern ?? e.error ?? ''}`
      case EV.MC_CHAT: return e.text?.slice(0, 160)
      case EV.MC_KICK: return `KICKED: ${e.text}`
      case EV.MC_DISCONNECT: return `DISCONNECTED: ${e.text}`
      case EV.AUTH_OK: return `auth ok via ${e.via}`
      case EV.AUTH_FAIL: return `auth FAILED ${e.pattern}${e.fatal ? ' (fatal)' : ''}`
      case EV.BOT_STATE: return `${e.from} -> ${e.to}`
      case EV.MC_WARN: return `write refused: ${e.why}`
      default: return null
    }
  }

  /** The dashboard's read model. Everything a UI needs, and nothing it must compute itself. */
  snapshot () {
    const bots = {}
    for (const r of this.results) {
      bots[r.bot] ??= { username: r.bot, state: null, commands: 0, ok: 0, failed: 0, lastAt: null }
      bots[r.bot].commands++
      bots[r.bot].lastAt = r.at
      if (r.status === 'OK') bots[r.bot].ok++
      if (r.status === 'FAILED') bots[r.bot].failed++
    }
    for (const e of this.events) {
      if (e.topic === EV.BOT_STATE && e.bot && bots[e.bot]) { /* state is in the payload, not the slim event */ }
    }
    return {
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      summary: summarise(this.results),
      counters: this.counters,
      bots,
      results: this.results,
      recentEvents: this.events.slice(-200)
    }
  }

  /** SSE/websocket seam. Returns an unsubscribe function. */
  subscribe (fn) { this.subscribers.add(fn); return () => this.subscribers.delete(fn) }

  /** Human-readable end-of-run report. Non-OK results are always listed in full: a green
   *  summary with a hidden failure list is worse than no summary. */
  report () {
    const s = summarise(this.results)
    const lines = []
    lines.push(`commands: ${s.total}  OK=${s.ok} FAILED=${s.failed} NO_RESPONSE=${s.noResponse} BLOCKED=${s.blocked} ERROR=${s.error}`)
    const bad = this.results.filter((r) => r.status !== 'OK')
    if (bad.length) {
      lines.push('')
      lines.push(`${bad.length} command(s) did not succeed:`)
      for (const r of bad) {
        lines.push(`  ${String(r.bot).padEnd(14)} ${String(r.action).padEnd(10)} ${r.status.padEnd(12)} ${r.response ?? r.error ?? ''}`)
      }
    }
    return lines.join('\n')
  }
}
