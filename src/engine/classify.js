// engine/classify.js — pure classification. No sockets, no timers, no bus: unit-testable.
//
// THE ONE RULE THAT MATTERS: failure is tested BEFORE success. A reply may match both sets
// (an operator's success regex that is too loose, or a plugin that emits "You are not in a
// party" before a success line). Testing success first would let a hard error be recorded as
// OK, which is the single worst outcome this tool can produce — a green dashboard over a
// broken flow.

export const STATUS = Object.freeze({
  OK: 'OK',                 // a success pattern matched
  FAILED: 'FAILED',         // a failure pattern matched (incl. every baseline failure)
  NO_RESPONSE: 'NO_RESPONSE', // nothing matched within the window
  BLOCKED: 'BLOCKED',       // refused locally: bot not READY, or AuthMe would cancel/kick it
  ERROR: 'ERROR',           // transport error: not connected, kicked, socket died
  SKIPPED: 'SKIPPED'        // disabled / not applicable
})

/** @returns {{status, pattern, groups}|null} null means "this line is not our answer". */
export function classifyLine (text, { failure = [], success = [], noise = [] } = {}) {
  for (const n of noise) if (n.re.test(text)) return null
  for (const f of failure) {
    const m = f.re.exec(text)
    if (m) return { status: STATUS.FAILED, pattern: f.key, groups: m.groups ?? {}, match: m }
  }
  for (const s of success) {
    const m = s.re.exec(text)
    if (m) return { status: STATUS.OK, pattern: s.key, groups: m.groups ?? {}, match: m }
  }
  return null
}

/** Fold a set of per-bot results into the dashboard's summary row. */
export function summarise (results) {
  const byStatus = {}
  const byAction = {}
  const byBot = {}
  for (const r of results) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    byAction[r.action] ??= { total: 0, byStatus: {} }
    byAction[r.action].total++
    byAction[r.action].byStatus[r.status] = (byAction[r.action].byStatus[r.status] ?? 0) + 1
    byBot[r.bot] ??= { total: 0, byStatus: {} }
    byBot[r.bot].total++
    byBot[r.bot].byStatus[r.status] = (byBot[r.bot].byStatus[r.status] ?? 0) + 1
  }
  return {
    total: results.length,
    ok: byStatus.OK ?? 0,
    failed: byStatus.FAILED ?? 0,
    noResponse: byStatus.NO_RESPONSE ?? 0,
    blocked: byStatus.BLOCKED ?? 0,
    error: byStatus.ERROR ?? 0,
    // A fleet is only healthy if EVERY command landed. Anything else is surfaced, not rounded.
    okRate: results.length ? Number(((byStatus.OK ?? 0) / results.length).toFixed(3)) : null,
    byStatus, byAction, byBot
  }
}
