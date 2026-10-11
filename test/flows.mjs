// flows.mjs — exercises every dashboard feature end to end and reports pass/fail per flow.
//
// This is the regression suite for the operator-facing behaviour: it drives the SAME HTTP API
// the dashboard buttons call, in the same order an operator would, and asserts on the RESULT —
// not on "the request returned 200". A flow that returns 200 while the party quietly lost a
// member still fails here.
//
// Usage:  node test/flows.mjs [--keep]
// Requires the dashboard to be running (default http://127.0.0.1:4599).

const BASE = process.env.BASE || 'http://127.0.0.1:4599'
const KEEP = process.argv.includes('--keep')

let pass = 0, fail = 0
const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function check (name, ok, detail = '') {
  if (ok) { pass++; results.push(['PASS', name, detail]) }
  else { fail++; results.push(['FAIL', name, detail]) }
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

async function get (path) {
  const r = await fetch(BASE + path)
  return r.json()
}
async function post (path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {})
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
const act = (b) => post('/api/action', b)

async function state () { return get('/api/state') }
const readyIn = (s) => s.bots.filter((b) => b.ready).map((b) => b.name)
const partyOf = (s, n) => (s.bots.find((b) => b.name === n)?.party?.role) ?? 'none'
const roster = (s) => s.bots.filter((b) => ['leader', 'member'].includes(b.party?.role)).map((b) => b.name)

/** Wait until the dashboard has no run in flight. A connect takes ~25 s (1 s stagger + auth),
 *  and every endpoint refuses while one is running — so a test that fires two in a row measures
 *  the refusal, not the thing it meant to measure. */
async function waitIdle (timeoutMs = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const st = await state()
    if (!st.running) return true
    await sleep(1000)
  }
  return false
}

async function waitReady (n, timeoutMs = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const s = await state()
    if (readyIn(s).length >= n) return s
    await sleep(1500)
  }
  return state()
}

// Ask the server itself what the party looks like, rather than trusting our own bookkeeping.
async function askLeader (cmd = '/p list', windowMs = 2500) {
  const r = await post('/api/learn', { text: cmd, windowMs })
  const lines = (r.body?.lines ?? []).map((l) => l.text)
  const head = lines.find((l) => /Party \(\d+\)/.test(l))
  return { lines, size: head ? Number(head.match(/Party \((\d+)\)/)[1]) : null }
}

// The templates must actually be the commands the plugin answers to. Two separate incidents
// shipped a wrong template here (accept as "/p join", transfer as "/p promote") and both were
// invisible until a bot silently failed to act, so it is now asserted on every run.
async function checkTemplates (state) {
  const { readFileSync } = await import('node:fs')
  let yaml
  try { yaml = readFileSync(new URL('../plugin/config.yml', import.meta.url), 'utf8') } catch { return }
  const sub = {}
  let inSub = false
  for (const line of yaml.split('\n')) {
    if (/^subcommands:/.test(line)) { inSub = true; continue }
    if (inSub && /^\S/.test(line)) inSub = false
    const m = inSub && line.match(/^\s{2}(\w+):\s*(\S+)\s*$/)
    if (m) sub[m[1]] = m[2]
  }
  // A command may be served by a top-level alias declared in plugin.yml (the reference plugin
  // answers both "/p <sub>" and "/pc <text>"), so an alias name is just as correct as the
  // subcommand name. Accept either; reject anything else.
  let aliases = []
  try {
    const yml = readFileSync(new URL('../plugin/plugin.yml', import.meta.url), 'utf8')
    aliases = [...yml.matchAll(/^\s{2}(\w+):\s*$/gm)].map((m) => m[1])
  } catch { /* no plugin.yml: fall back to subcommands only */ }

  for (const [action, want] of Object.entries(sub)) {
    const tpl = state.commands[action]?.template
    if (tpl === undefined) continue
    const head = tpl.split(/\s+/)[0].replace(/^\//, '')
    const ok = head === want || aliases.includes(head)
    check(`template for ${action} matches the plugin`, ok,
      ok ? `"${tpl}"` : `config has "${tpl}" (head "${head}"); plugin offers subcommand "${want}" or alias ${aliases.join('/') || '(none)'}`)
  }
}

// Refuse to run anywhere but the test bed.
//
// This suite drives the test plugin's /where, /reset, /blockat and /blocks, and asks the reference
// party plugin for /p list. Pointed at a real server - which is a perfectly reasonable thing to do
// with the TOOL - every one of those is missing, and the run produces twenty failures that describe
// the suite's assumptions rather than anything wrong with the server. It did exactly that once,
// against a real server, and the output was indistinguishable from a broken product.
async function requireTestBed (s0) {
  let reply = null
  let why = null
  try {
    const r = await post('/api/learn', { text: '/where', windowMs: 1500 })
    if (r.body?.error) why = r.body.error
    reply = (r.body?.lines ?? []).map((l) => l.text).join(' | ')
  } catch (e) { why = e.message }
  if (reply && /POS -?[\d.]+ -?[\d.]+ -?[\d.]+/.test(reply)) return true

  console.log(`\n  REFUSING TO RUN.`)
  console.log(`  ${s0.server.host}:${s0.server.port} does not answer /where with coordinates, so it is not the`)
  console.log('  test bed this suite is written against.')
  console.log('')
  console.log('  This suite is a TEST BED tool: it uses /where /reset /blockat /blocks from the reference')
  console.log('  plugin and /p list from the reference party plugin. Pointing the dashboard at a real')
  console.log('  server is fine for the tool; it just cannot be verified with this suite, and running it')
  console.log('  anyway reports the suite\'s missing assumptions as if they were product failures.')
  console.log('')
  if (reply) console.log(`  The server replied to /where with: ${reply.slice(0, 120)}`)
  else if (why) console.log(`  /where could not even be sent: ${why}`)
  console.log('')
  return false
}

async function main () {
  console.log(`\nflow suite against ${BASE}\n`)
  const s0 = await state()
  console.log(`server ${s0.server.host}:${s0.server.port} · ${s0.bots.length} accounts\n`)

  console.log('[0] command templates vs plugin')
  await checkTemplates(s0)
  console.log('')
  console.log('[0b] every pattern a command names actually exists')
  // The config used to carry its own copy of all 54 patterns, and it drifted: a stale unanchored
  // entry silently reverted a fix every time the config loaded, and a name that is not in the
  // registry compiles as a literal-string regex that can never match. Both classes are caught here.
  {
    const { PATTERNS } = await import('../src/patterns.js')
    const names = new Set()
    for (const [a, spec] of Object.entries(s0.commands ?? {})) {
      if (a.startsWith('_') || !spec) continue
      for (const k of ['success', 'failure']) for (const v of [].concat(spec[k] ?? [])) names.add(v)
    }
    const missing = [...names].filter((n) => !(n in PATTERNS) && !/[\\^$[\]()|*+?]/.test(n))
    check('no command names a pattern that does not exist', missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : `${names.size} names, all present`)
  }
  console.log('')

  // ── 1. connect ────────────────────────────────────────────────────────────
  console.log('[1] connect')
  await act({ action: 'disconnect', bot: 'all' })
  await sleep(2000)
  // ASSERT ON THE RESPONSE, not just on the effect. A 500 here was invisible for several runs
  // because the address is applied before the response is built, so the fleet connected perfectly
  // while every call reported failure. Checking only the outcome hid it completely.
  const con = await post('/api/connect', { address: `${s0.server.host}:${s0.server.port}` })
  check('POST /api/connect answers 202, not an error',
    con.status === 202 && con.body.ok === true,
    `HTTP ${con.status} ${JSON.stringify(con.body).slice(0, 120)}`)
  check('a connect actually runs the fleet online', await waitIdle(), 'dashboard never went idle')
  const badAddr = await post('/api/connect', { address: '' })
  check('a bad address is refused without wedging the dashboard',
    badAddr.status === 400, `HTTP ${badAddr.status} ${JSON.stringify(badAddr.body).slice(0, 80)}`)
  const stillAlive = await post('/api/connect', { address: `${s0.server.host}:${s0.server.port}` })
  check('connect still works after a refused one (the run flag was released)',
    stillAlive.status === 202, `HTTP ${stillAlive.status} ${JSON.stringify(stillAlive.body).slice(0, 100)}`)
  let s = await waitReady(s0.bots.length, 90000)
  check('every account reaches READY', readyIn(s).length === s0.bots.length,
    `${readyIn(s).length}/${s0.bots.length}`)
  // Wait for the SERVER to say the party is full, not for a fixed number of seconds.
  //
  // The party now fills the way it does on a real server: bot 1 finishes its menu first and starts
  // inviting, and each member only joins once it is through the area gate itself. So the last
  // member arrives several seconds after the last bot is READY, and a fixed wait read the baseline
  // in the middle of the fill - it recorded "Party (1)" and every later assertion was measured
  // against a party that had one person in it.
  const fillDeadline = Date.now() + 90000
  let baseline = 0
  while (Date.now() < fillDeadline) {
    const q = await askLeader('/p list')
    if (typeof q.size === 'number' && q.size >= s0.bots.length) { baseline = q.size; break }
    await sleep(2000)
    s = await state()
  }
  if (!baseline) {
    console.log(`  the party never reached ${s0.bots.length}; continuing so the failures below describe what is missing`)
    baseline = (await askLeader('/p list')).size ?? 0
  }

  // The test-bed check needs a READY bot to send /where from, so it runs after the connect above
  // and not before it. Run too early it reported a perfectly good test bed as a real server.
  if (!(await requireTestBed(await state()))) process.exit(3)

  // ── 2. progressive party ──────────────────────────────────────────────────
  console.log('\n[2] progressive party while joining')
  const inParty = roster(s)
  check('every ready bot is in the party', inParty.length === s0.bots.length,
    `roster: ${inParty.join(',') || '(none)'}`)
  const q = await askLeader('/p list')
  check('the server agrees the party is full', q.size >= s0.bots.length,
    `server says Party (${q.size}) (fleet is ${s0.bots.length})`)

  // ── 2b. the fleet stands down once the party is full ──────────────────────
  // /off is a status, not a disconnect: the account stays connected, it is just telling the rest
  // of the party it is done. Fires once per party, and re-arms if the party comes apart.
  console.log('\n[2b] stand down when the party is full')
  let os = await state()
  const offCount = os.bots.filter((b) => b.offline).length
  check('every bot stood down once the party filled', offCount === s0.bots.length,
    `${offCount}/${s0.bots.length} marked offline`)
  check('and they are still connected while offline', os.bots.every((b) => b.ready),
    'a stand-down is a status, not a disconnect')

  console.log('\n[3] automatic repair after a member is kicked')
  const victim = s.bots.find((b) => b.party?.role === 'member')?.name
  const k = await act({ action: 'kick', target: victim })
  check(`kick ${victim} succeeds`, k.body.ok === true, JSON.stringify(k.body.result?.response ?? k.body.error ?? ''))
  const repairDeadline = Date.now() + 30000
  let repaired = false
  let repairedServerSize = null
  while (Date.now() < repairDeadline) {
    await sleep(750)
    s = await state()
    const q2 = await askLeader('/p list', 1000)
    repairedServerSize = q2.size
    if (partyOf(s, victim) !== 'none' && q2.size === baseline) {
      repaired = true
      break
    }
  }
  check(`${victim} reconnects to the canonical party without a manual invite`, repaired,
    `role ${partyOf(s, victim)}; server Party (${repairedServerSize})`)
  check(`${victim} stays connected during party repair`, s.bots.find((b) => b.name === victim)?.ready === true)
  await sleep(1500)
  const os2 = await state()
  check('stand-down is restored after automatic member repair',
    os2.bots.filter((b) => b.offline).length === s0.bots.length,
    `${os2.bots.filter((b) => b.offline).length}/${s0.bots.length} offline`)

  console.log('\n[4] automatic repair after disband')
  const d = await act({ action: 'disband' })
  check('disband succeeds', d.body.ok === true, d.body.result?.response ?? '')
  const disbandDeadline = Date.now() + 45000
  let rebuilt = false
  let rebuiltSize = null
  while (Date.now() < disbandDeadline) {
    await sleep(1000)
    s = await state()
    const q3 = await askLeader('/p list', 1000)
    rebuiltSize = q3.size
    if (roster(s).length === s0.bots.length && q3.size === baseline) {
      rebuilt = true
      break
    }
  }
  check('the coordinator rebuilds the full party after disband', rebuilt,
    `tracker ${roster(s).length}/${s0.bots.length}; server Party (${rebuiltSize})`)
  const fleetLeaders = s.bots.filter((b) => b.party?.role === 'leader').map((b) => b.name)
  check('the rebuilt fleet has only the canonical bot leader',
    fleetLeaders.length === 1 && fleetLeaders[0] === s0.bots[0].name,
    `leaders: ${fleetLeaders.join(',') || '(none)'}`)

  console.log('\n[4b] connection stability after automatic party repair')
  const kickedOut = s.bots.filter((b) => !b.ready).map((b) => b.name)
  check('nobody was dropped by recovery traffic', kickedOut.length === 0,
    kickedOut.length ? `no longer ready: ${kickedOut.join(',')}` : 'all still ready')

  // ── 5. warp (server has no warp plugin) ───────────────────────────────────
  console.log('\n[5] warp without a warp plugin')
  const w = await act({ action: 'warp', warp: 'spawn' })
  check('a missing warp plugin is reported, not swallowed',
    w.body.ok === false && /unknown command|not.*found/i.test(w.body.result?.response ?? ''),
    w.body.result?.response ?? '')

  // ── 8. master invite + transfer ───────────────────────────────────────────
  console.log('\n[8] master')
  const master = process.env.MASTER_NAME || 'PartyMaster'
  const sBefore = await state()
  const masterOnline = /partymaster/i.test((await askLeader('/p list', 1200)).lines.join(' ')) ||
    (await state()).bots.some((b) => b.name === master)
  const mi = await act({ action: 'invite', target: master })
  check(`invite ${master} is attempted and classified`, typeof mi.body.ok === 'boolean',
    mi.body.result?.status ?? mi.body.error ?? '')
  if (mi.body.ok) {
    // the stand-in accepts on its own; give it a moment, then hand over
    for (let i = 0; i < 10; i++) { await sleep(1000); const st = await state(); if (st.bots.some((b) => b.name === master)) break }
    await sleep(2000)
    const tr = await act({ action: 'transfer', target: master })
    check(`transfer to ${master} succeeds`, tr.body.ok === true, tr.body.result?.response ?? tr.body.error ?? '')
    await sleep(1000)
    const s2 = await state()
    const stillLeading = s2.bots.filter((b) => b.party?.role === 'leader').map((b) => b.name)
    check('no fleet bot still claims to lead the party', stillLeading.length === 0,
      stillLeading.join(',') || '(none)')
  } else {
    console.log(`  (skipped transfer: ${master} is not online)`)
  }

  // ── 8b. the chest-menu flow ───────────────────────────────────────────────
  // The only thing the tool does that is not chat, so it gets its own coverage: pick a hotbar
  // slot, right-click to open, click a slot inside the window. The test server runs
  // plugin/.../MenuSim.java, which puts a menu item in hotbar slot 5 and treats the slot at
  // row 4, column 4 as the connect button.
  console.log('\n[8b] chest menu')
  const setMenu = (menu) => post('/api/config', { menu })
  const menuRun = () => act({ action: 'menu' })

  await setMenu({ hotbarSlot: 5, row: 4, col: 4, button: 'right', expectTitle: '' })
  const good = await menuRun()
  // slotCount is 54 on the raw transport and 90 on mineflayer, which folds the player's own
  // inventory into the same window object. Asserting the exact number tested the transport, not
  // the menu; what matters is that a window opened and the click landed.
  const sc = good.body.result?.opened?.slotCount
  check('the target slot opens the menu and the menu reacts',
    good.body.ok === true && typeof sc === 'number' && sc >= 54 && good.body.result?.windowClosed === true,
    `status ${good.body.result?.status} slot ${good.body.result?.slot} slotCount ${sc} closed ${good.body.result?.windowClosed}`)
  check('the slot is derived from row/col the way a player counts them',
    good.body.result?.slot === 30, `row 4 col 4 -> slot ${good.body.result?.slot} (expected 30)`)

  await setMenu({ row: 1, col: 1 })
  const wrong = await menuRun()
  check('clicking the wrong slot still reports honestly (clicked, but the menu did not react)',
    wrong.body.result?.slot === 0 && wrong.body.result?.windowClosed === false,
    `slot ${wrong.body.result?.slot} closed ${wrong.body.result?.windowClosed}`)

  await setMenu({ hotbarSlot: 1, row: 4, col: 4 })
  const noItem = await menuRun()
  check('a hotbar slot with no menu item fails loudly', noItem.body.ok === false && /no menu opened/.test(noItem.body.result?.error ?? ''),
    noItem.body.result?.error?.slice(0, 80) ?? '')

  await setMenu({ hotbarSlot: 5, expectTitle: 'Not This Menu' })
  const wrongTitle = await menuRun()
  check('an unexpected menu title is a failure, not a silent click',
    wrongTitle.body.ok === false && /does not contain/.test(wrongTitle.body.result?.error ?? ''),
    wrongTitle.body.result?.error?.slice(0, 80) ?? '')

  const bad = await setMenu({ row: 99 })
  check('an out-of-range row is refused', bad.status === 400 && /between 1 and 6/.test(bad.body?.error ?? ''),
    `HTTP ${bad.status} ${bad.body?.error ?? ''}`)

  await setMenu({ hotbarSlot: 5, row: 4, col: 4, expectTitle: '' })
  const restored = await menuRun()
  check('menu settings can be restored', restored.body.ok === true, restored.body.result?.status ?? '')

  // ── 8c. the random walk ───────────────────────────────────────────────────
  // The only thing here the bot's own state cannot prove: whether it MOVED. A bot that believes
  // it walked somewhere proves nothing, so the server is asked for the player's real coordinates
  // before and after, through the test plugin's /where command.
  console.log('\n[8c] random walk')
  const where = async (name) => {
    const r = await post('/api/learn', { text: '/where', bot: name, windowMs: 1200 })
    const line = (r.body?.lines ?? []).map((l) => l.text).find((t) => /POS /.test(t))
    const m = line && line.match(/POS (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/)
    return m ? { x: +m[1], y: +m[2], z: +m[3] } : null
  }

  const off = await act({ action: 'walk', enabled: false })
  check('walking can be switched off', off.body.ok === true && off.body.walking === false, JSON.stringify(off.body))
  await sleep(1000)
  let ws = await state()
  check('and no bot is reported walking', ws.bots.every((b) => !b.walking),
    `${ws.bots.filter((b) => b.walking).length} still walking`)

  const on = await act({ action: 'walk', enabled: true })
  check('walking can be switched on', on.body.ok === true && on.body.walking === true,
    `${on.body.changed?.length ?? 0} bot(s) started`)
  await sleep(2500)
  ws = await state()
  check('every ready bot is walking', ws.bots.every((b) => !b.ready || b.walking),
    `${ws.bots.filter((b) => b.walking).length}/${ws.bots.filter((b) => b.ready).length} ready bots walking`)

  const movers = ws.bots.filter((b) => b.ready).slice(0, 3).map((b) => b.name)
  // A random walk can loop back toward its starting point. Measure the path the server saw
  // across several samples, rather than treating a small net displacement as no movement.
  const previous = {}, distance = {}
  for (const n of movers) { previous[n] = await where(n); distance[n] = 0 }
  for (let sample = 0; sample < 3; sample++) {
    await sleep(2000)
    for (const n of movers) {
      const next = await where(n)
      if (previous[n] && next) distance[n] += Math.hypot(next.x - previous[n].x, next.z - previous[n].z)
      previous[n] = next
    }
  }

  for (const n of movers) {
    const d = distance[n]
    check(`${n} moved, as far as the SERVER is concerned`, d > 2,
      previous[n] ? `server saw at least ${d.toFixed(1)} blocks along the path` : 'the server gave no position')
  }
  const stillUp = await state()
  check('nobody was kicked for moving', stillUp.bots.every((b) => b.ready),
    stillUp.bots.filter((b) => !b.ready).map((b) => b.name).join(',') || 'all still ready')
  await act({ action: 'walk', enabled: false })

  // ── 9. disconnect / reconnect ─────────────────────────────────────────────
  console.log('\n[9] disconnect and reconnect')
  const d1 = await act({ action: 'disconnect', bot: s0.bots[0].name })
  check('disconnect one bot', d1.body.disconnected?.length === 1, JSON.stringify(d1.body.disconnected ?? []))
  await sleep(1500)
  s = await state()
  check('the disconnected bot shows red', s.bots.find((b) => b.name === s0.bots[0].name)?.phase === 'pending')
  const d2 = await act({ action: 'disconnect', bot: 'all' })
  check('disconnect all', d2.body.disconnected?.length === s0.bots.length, `${d2.body.disconnected?.length}`)
  await sleep(1500)
  s = await state()
  check('every bot shows red', s.bots.every((b) => b.phase === 'pending'))
  check('nobody is in a party after everyone left', roster(s).length === 0)

  // ── 10. the area gate ─────────────────────────────────────────────────────
  // On a server that puts you through a menu first, a bot that skipped it is standing in the
  // wrong world, and a party built from those bots looks formed and is not. The gate must
  // therefore BLOCK, and the block must be visible rather than silent.
  console.log('\n[10] the area gate')
  const setMenuCfg = (menu) => post('/api/config', { menu })

  await setMenuCfg({ enabled: true, gateParty: true, hotbarSlot: 1, row: 4, col: 4, expectTitle: '' })
  await act({ action: 'disconnect', bot: 'all' })
  await sleep(2000)
  const gateConnect = await post('/api/connect', { address: `${s0.server.host}:${s0.server.port}` })
  check('connect accepts the fleet even while the BedWars gate is temporarily broken', gateConnect.status === 202,
    `HTTP ${gateConnect.status}`)
  await waitReady(s0.bots.length, 60000)
  await sleep(4000)
  let gs = await state()
  const notIn = gs.bots.filter((b) => b.menu?.state !== 'done').length
  check('a broken selector keeps bots outside BedWars instead of forming a fake party', notIn === s0.bots.length && roster(gs).length === 0,
    `${notIn}/${s0.bots.length} outside; roster ${roster(gs).length}`)
  check('connect remains in recovery instead of declaring success', gs.running === true)

  await setMenuCfg({ enabled: true, gateParty: true, hotbarSlot: 5, row: 4, col: 4, expectTitle: '' })
  check('fixing the selector lets the in-flight connect converge', await waitIdle(90000))
  gs = await state()
  const inside = gs.bots.filter((b) => b.menu?.state === 'done').length
  check('every bot reaches BedWars after the live config repair', inside === s0.bots.length,
    `${inside}/${s0.bots.length} in the area`)
  const gateQ = await askLeader('/p list')
  check('one canonical full party forms after gate recovery', gateQ.size === s0.bots.length,
    `server says Party (${gateQ.size})`)
  await act({ action: 'disconnect', bot: 'all' })

  if (!KEEP) {
    console.log('\n[11] leave the fleet down (as found)')
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`)
  for (const [st, name, detail] of results) if (st === 'FAIL') console.log(`  FAILED: ${name}  ${detail}`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('suite crashed:', e.stack ?? e.message); process.exit(2) })
