// app.js — the mcbotctl dashboard. No framework and no build step.
'use strict'

const ACTIONS = ['invite', 'accept', 'deny', 'leave', 'disband', 'transfer', 'promote', 'kick', 'chat', 'warp']
const NEEDS = { invite: 'player', accept: 'player', deny: 'player', leave: null, disband: null,
                transfer: 'player', promote: 'player', kick: 'player', chat: 'message', warp: 'warp' }

let S = { bots: [], commands: {}, accounts: '', master: '' }
let accountsDirty = false
let commandsRendered = false
let commandsDirty = false   // true once the operator has typed in a command field
// What each field was rendered with. Save sends ONLY the fields whose value differs, so a tab
// holding stale values can never clobber a field it did not touch. Sending every field was a
// real bug: a page rendered before a config change wrote its old copy back over the server's,
// silently reverting a working command template to a broken one.
let commandsRenderedWith = {}
let commandsSignature = null

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {})
}).then((r) => r.json()).catch((e) => ({ error: e.message }))
const act = (body) => post('/api/action', body)
const readyNames = () => S.bots.filter((b) => b.ready).map((b) => b.name)

function flash (id, msg, ok = true) {
  const el = $(id)
  if (!el) return
  el.textContent = msg
  el.style.color = ok ? 'var(--ok)' : 'var(--bad)'
  clearTimeout(el._t)
  el._t = setTimeout(() => { el.textContent = '' }, 6000)
}

// ───────────────────────────────────────────────────────────── tabs
const TABS = ['server', 'accounts', 'party', 'commands', 'log']
function showTab (name) {
  if (!TABS.includes(name)) name = 'server'
  for (const t of TABS) {
    document.querySelector(`[data-panel="${t}"]`).hidden = t !== name
    document.querySelector(`.tab[data-tab="${t}"]`).classList.toggle('is-on', t === name)
  }
  location.hash = name
}
document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => showTab(b.dataset.tab) })
showTab((location.hash || '').replace('#', '') || 'server')
// The hash was written but never read back, so Back changed the URL while the panel stayed put.
window.addEventListener('hashchange', () => showTab((location.hash || '').replace('#', '') || 'server'))

// ───────────────────────────────────────────────────────────── live log
const logEl = $('log')
function logLine (cls, text, at) {
  const d = document.createElement('div')
  const t = new Date(at || Date.now()).toLocaleTimeString('en-GB', { hour12: false })
  d.innerHTML = `<span class="t">${t}</span> <span class="${cls}">${esc(text)}</span>`
  logEl.appendChild(d)
  while (logEl.childElementCount > 500) logEl.removeChild(logEl.firstChild)
  logEl.scrollTop = logEl.scrollHeight
}
$('btn-clear').onclick = () => { logEl.innerHTML = '' }

// ──────────────────────────────────────────────────────── bot squad
const PHASE_LABEL = { done: 'ready', waiting: 'joining', pending: 'not in' }
const PARTY_LABEL = { leader: 'party leader', member: 'in party', none: 'not in party' }
const PARTY_CLASS = { leader: 'plead', member: 'pjoin', none: 'pnone' }

// The Members tab still shows the configured area gate and party roles. The bot cards below
// show the four independent progress signals supplied by the server.
const AREA_LABEL = { done: 'in area', pending: 'entering…', failed: 'not in area' }
const AREA_CLASS = { done: 'pjoin', pending: 'pnone', failed: 'pbad' }

// A milestone is only green when the server has evidence for it. In particular, clicking the
// BedWars selector is not proof that the bot actually entered a match; null stays unconfirmed.
function milestone (label, value, { yes, no, unknown = 'Not confirmed', detail = '' }) {
  const state = value === true ? 'yes' : value === false ? 'no' : value === 'na' ? 'na' : 'unknown'
  const status = state === 'yes' ? yes : state === 'no' ? no : state === 'na' ? 'Not required' : unknown
  return `<div class="milestone ${state}"><span class="milestone-label">${esc(label)}</span>` +
    `<span class="milestone-value"><span class="milestone-mark" aria-hidden="true">${
      state === 'yes' ? '✓' : state === 'no' ? '×' : state === 'na' ? '–' : '?'
    }</span>${esc(status)}${value === true && detail ? ` <small>${esc(detail)}</small>` : ''}</span></div>`
}

function renderBots () {
  const box = $('bots')
  box.innerHTML = ''
  for (const b of S.bots) {
    const role = (b.party && b.party.role) || 'none'
    const progress = b.progress || {}
    const authView = progress.authDetail === 'not_required' ? 'na'
      : progress.authDetail === 'pending' ? null : progress.authenticated
    const bedwarsStage = progress.bedwarsStage === 'match' ? '(in a match)'
      : progress.bedwarsStage === 'mode' ? '(BedWars lobby)' : ''
    const partyDetail = role === 'leader' ? '(leader)'
      : role === 'member' && b.party?.leader ? `(${b.party.leader})` : ''
    const d = document.createElement('div')
    d.className = 'glass card'
    d.dataset.phase = b.phase
    d.innerHTML = `<div class="frost"></div><div class="content">
      <div class="who">${esc(b.name)}</div>
      <div class="st"><span class="dot ${esc(b.phase)}"></span>${esc(PHASE_LABEL[b.phase] || b.state)}</div>
      <div class="milestones" aria-label="Progress for ${esc(b.name)}">
        ${milestone('Server connection', progress.connected, { yes: 'Connected', no: 'Not connected' })}
        ${milestone('Login', authView, {
          yes: 'Succeeded', no: progress.authDetail === 'failed' ? 'Failed'
            : progress.authDetail === 'disconnected' ? 'Not connected' : 'Not logged in',
          unknown: progress.authDetail === 'pending' ? 'Logging in' : 'Not confirmed'
        })}
        ${milestone('BedWars area', progress.bedwarsJoined, {
          yes: 'Entered', no: 'Not entered', detail: bedwarsStage
        })}
        ${milestone('Party', progress.partyJoined, { yes: 'Joined', no: 'Not joined', detail: partyDetail })}
      </div>
      ${b.offline ? '<div class="badge poff">offline</div>' : ''}
      ${b.bedwars?.phase && b.bedwars.phase !== 'idle'
        ? `<div class="badge ${['done', 'island_reached'].includes(b.bedwars.phase) ? 'pjoin' : b.bedwars.phase === 'failed' ? 'pbad' : 'pnone'}" title="${esc(b.bedwars.result?.error ?? '')}">BedWars: ${esc(b.bedwars.phase.replaceAll('_', ' '))}</div>`
        : ''}
    </div>`
    box.appendChild(d)
  }
  const ready = S.bots.filter((b) => b.ready).length
  $('ready-count').textContent = S.bots.length ? `${ready}/${S.bots.length} ready` : ''
  const walking = S.bots.filter((b) => b.walking).length
  $('walk-count').textContent = walking ? ` · ${walking} walking` : ''
  const wb = $('btn-walk')
  if (wb) {
    const on = walking > 0
    wb.dataset.on = on ? '1' : '0'
    wb.textContent = on ? 'Stop walking' : 'Start walking'
    wb.classList.toggle('primary', !on)
  }
  $('tab-status').textContent = S.bots.length ? `${ready}/${S.bots.length} ready` : ''
  const bwBot = S.bots.find((b) => b.name === S.bedwars?.actor)
  const bw = bwBot?.bedwars ?? { phase: 'idle' }
  const bwText = `${S.bedwars?.actor ?? 'bot'}: ${bw.phase.replaceAll('_', ' ')}` +
    (bw.iron != null ? ` · ${bw.iron} iron` : '') +
    (bw.wool != null ? ` · ${bw.wool} wool` : '') +
    (bw.target ? ` · target ${bw.target}` : '')
  $('bedwars-state').textContent = bwText
  if (bw.result?.error) $('bedwars-msg').textContent = bw.result.error
  renderMembers()
}

function renderMembers () {
  const box = $('members')
  if (!box) return
  box.innerHTML = ''
  for (const b of S.bots) {
    const d = document.createElement('div')
    d.className = 'member'
    const role = (b.party && b.party.role) || 'none'
    const area = (b.menu && b.menu.state) || 'done'
    d.innerHTML = `<span class="dot ${esc(b.phase)}"></span><span class="who">${esc(b.name)}</span>` +
      `<span class="badge ${AREA_CLASS[area]}">${esc(AREA_LABEL[area])}</span>` +
      `<span class="badge ${PARTY_CLASS[role]}">${esc(PARTY_LABEL[role])}</span>`
    const kick = document.createElement('button')
    kick.className = 'btn ghost tiny'
    kick.textContent = 'kick'
    kick.disabled = !b.ready
    kick.onclick = async () => {
      const r = await act({ action: 'kick', target: b.name })
      flash('action-msg', r.ok ? `kicked ${b.name}` : `kick failed: ${r.result?.response || r.error}`, r.ok)
    }
    d.appendChild(kick)
    box.appendChild(d)
  }
}

// ──────────────────────────────────────────────────── command config
function renderCommands () {
  const box = $('cmds')
  box.innerHTML = ''
  for (const a of ACTIONS) {
    if (!(a in (S.commands || {})) && a === 'warp') { /* still show: it is configurable */ }
    const spec = S.commands[a] || {}
    const need = NEEDS[a]
    const row = document.createElement('div')
    row.className = 'cmd'
    row.innerHTML =
      `<label>${a}</label>` +
      `<input data-a="${a}" value="${esc(spec.template || '')}" spellcheck="false" ` +
      `placeholder="${need === 'message' ? '/pc hello' : need === 'warp' ? '/warp spawn' : need ? '/p inv <name>' : '/p disband'}">` +
      `<button class="btn ghost tiny" data-learn="${a}" title="Send it once and read the reply">Learn</button>` +
      `<div class="pv" data-pv="${a}"></div>`
    box.appendChild(row)
  }
  box.querySelectorAll('input').forEach((i) => i.addEventListener('input', () => { commandsDirty = true; preview() }))
  box.querySelectorAll('[data-learn]').forEach((b) => b.addEventListener('click', () => openLearn(b.dataset.learn)))
  commandsRenderedWith = {}
  for (const a of ACTIONS) {
    const v = (document.querySelector(`input[data-a="${a}"]`)?.value ?? '').trim()
    if (v) commandsRenderedWith[a] = v
  }
  commandsRendered = true
  preview()
}

function sampleVars () {
  const names = S.bots.map((b) => b.name)
  return { player: names[1] || S.master || 'Player2', message: 'hello', warp: $('warp-name')?.value || 'spawn' }
}
const renderTemplate = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (w, k) => (k in vars ? vars[k] : w))

function preview () {
  const vars = sampleVars()
  for (const a of ACTIONS) {
    const el = document.querySelector(`[data-pv="${a}"]`)
    const inp = document.querySelector(`input[data-a="${a}"]`)
    if (!el || !inp) continue
    const tpl = inp.value.trim()
    const need = NEEDS[a]
    const missing = need && !tpl.includes('{' + need + '}')
    el.innerHTML = tpl
      ? `sends: <b>${esc(renderTemplate(tpl, vars))}</b>` +
        (missing ? ` &nbsp;·&nbsp; <span style="color:var(--warn)">missing {${need}}</span>` : '')
      : '<span style="color:var(--ink-dim)">not configured</span>'
  }
}

$('btn-save').onclick = async () => {
  const commands = {}
  const changed = []
  const removed = []
  for (const a of ACTIONS) {
    const el = document.querySelector(`input[data-a="${a}"]`)
    if (!el) continue
    const v = el.value.trim()
    const was = commandsRenderedWith[a] ?? ''
    if (v === was) continue                     // untouched: do not send it at all
    if (v) { commands[a] = { template: v }; changed.push(a) } else { removed.push(a) }
  }
  if (!changed.length && !removed.length) {
    commandsDirty = false            // the page now matches the server, so stop holding edits
    return flash('save-msg', 'nothing changed', true)
  }
  const r = await post('/api/config', { commands, persist: true })
  if (r.error) return flash('save-msg', 'error: ' + r.error, false)
  commandsDirty = false
  for (const a of changed) commandsRenderedWith[a] = commands[a].template
  flash('save-msg', `saved ${changed.length} changed command(s)` +
    (removed.length ? ` (${removed.length} left empty, not sent)` : ''))
}

// ─────────────────────────────────────────────────────── test server
$('btn-connect').onclick = async () => {
  const address = $('address').value.trim()
  $('btn-connect').disabled = true
  $('btn-connect').textContent = 'joining…'
  const r = await post('/api/connect', { address, persist: true })
  $('btn-connect').disabled = false
  $('btn-connect').textContent = 'Join server'
  flash('connect-msg', r.error ? 'error: ' + r.error
    : `joining ${r.address}${r.note ? ' (' + r.note + ')' : ''}, one bot per second…`, !r.error)
}
$('btn-walk').onclick = async () => {
  const on = $('btn-walk').dataset.on !== '1'
  $('btn-walk').disabled = true
  const r = await act({ action: 'walk', enabled: on, persist: true })
  $('btn-walk').disabled = false
  if (r.error) return flash('connect-msg', r.error, false)
  flash('connect-msg', r.walking ? `walking: ${r.changed.length} bot(s) started` : `stopped: ${r.changed.length} bot(s)`, true)
}
$('btn-disconnect').onclick = async () => {
  const r = await act({ action: 'disconnect', bot: 'all' })
  flash('connect-msg', r.error ? r.error : `disconnected ${r.disconnected.length} bot(s)`, !r.error)
}
$('btn-bedwars-start').onclick = async () => {
  $('btn-bedwars-start').disabled = true
  const r = await post('/api/bedwars', { action: 'start' })
  $('btn-bedwars-start').disabled = false
  flash('bedwars-msg', r.error ? r.error : `started BedWars opening for ${r.bot}`, !r.error)
}
$('btn-bedwars-stop').onclick = async () => {
  const r = await post('/api/bedwars', { action: 'stop' })
  flash('bedwars-msg', r.error ? r.error : r.stopped ? `stopped ${r.bot}` : `${r.bot} is not running`, !r.error)
}
// The Accounts tab has its own Disconnect button. It used to delegate to the Server tab's
// handler, which flashes its message into a panel that is hidden while you are on Accounts —
// so the click looked like it did nothing at all.
$('btn-acc-disc').onclick = async () => {
  const r = await act({ action: 'disconnect', bot: 'all' })
  flash('acc-msg', r.error ? r.error : `disconnected ${r.disconnected.length} bot(s)`, !r.error)
}

// ─────────────────────────────────────────────────────────── accounts
$('btn-gen').onclick = async () => {
  const r = await post('/api/accounts/generate', {
    count: Number($('gen-count').value),
    prefix: $('gen-prefix').value.trim() || 'Bot',
    password: $('gen-pass').value || 'changeme123'
  })
  if (r.error) return flash('acc-msg', 'error: ' + r.error, false)
  $('accounts').value = r.text
  accountsDirty = true
  flash('acc-msg', `generated ${r.accounts.length} accounts — review, then Save`)
}
$('accounts').addEventListener('input', () => { accountsDirty = true })
$('btn-acc-save').onclick = async () => {
  const r = await post('/api/accounts', { text: $('accounts').value, persist: true, rebuild: $('acc-rebuild').checked })
  if (r.error) return flash('acc-msg', 'error: ' + r.error, false)
  accountsDirty = false
  flash('acc-msg', `saved ${r.count} accounts${r.rebuilt ? ', fleet rebuilt' : ''}`)
}

// ────────────────────────────────────────────────────────────── party
// p inv ... - bot 1 invites every member.
$('btn-run').onclick = async () => {
  $('btn-run').disabled = true
  const r = await act({ action: 'invite-all' })
  $('btn-run').disabled = false
  if (r.error) return flash('action-msg', r.error, false)
  const al = (r.alreadyIn ?? []).length
  const bad = (r.failed ?? []).length
  flash('action-msg',
    `p inv: ${r.invited ?? 0} command(s) succeeded` +
    (al ? `, ${al} already in the party` : '') +
    (bad ? `, ${bad} FAILED: ${(r.failed ?? []).map((f) => f.bot + ' ' + f.status).join('; ')}` : ''),
    bad === 0)
}

// p join ... - every other bot joins bot 1's party.
$('btn-join-all').onclick = async () => {
  $('btn-join-all').disabled = true
  const r = await act({ action: 'join-all' })
  $('btn-join-all').disabled = false
  if (r.error) return flash('action-msg', r.error, false)
  flash('action-msg',
    `p join: ${r.joined} bot(s) joined` +
    (r.failed?.length ? `, ${r.failed.length} FAILED: ${r.failed.map((f) => f.bot + ' ' + f.status).join('; ')}` : ''),
    !r.failed?.length)
}
$('btn-disband').onclick = async () => {
  const r = await act({ action: 'disband' })
  flash('action-msg', r.ok ? 'party disbanded' : `disband failed: ${r.result?.response || r.error}`, r.ok)
}
$('btn-leave').onclick = async () => {
  const bad = []
  for (const n of readyNames()) {
    const r = await act({ action: 'leave', actor: n })
    if (r.error || r.ok === false) bad.push(`${n}: ${r.result?.response || r.error}`)
  }
  flash('action-msg', bad.length ? `${bad.length} failed — ${bad.join('; ')}` : 'every bot left its party', bad.length === 0)
}

// ────────────────────────────────────────────────────────────── master
$('btn-save-master').onclick = async () => {
  const r = await post('/api/config', {
    master: $('master').value.trim(), masterAcceptWaitMs: Number($('waitms').value), persist: true
  })
  flash('master-msg', r.error ? 'error: ' + r.error : 'master saved', !r.error)
}
$('btn-master').onclick = async () => {
  const master = $('master').value.trim()
  if (!master) return flash('master-msg', 'enter the master account name first', false)
  $('btn-master').disabled = true
  const cfg = await post('/api/config', { master, masterAcceptWaitMs: Number($('waitms').value) })
  if (cfg.error) { $('btn-master').disabled = false; return flash('master-msg', cfg.error, false) }
  const run = await post('/api/run', { mode: 'master', promote: $('promote').checked })
  if (run.error) { $('btn-master').disabled = false; return flash('master-msg', run.error, false) }
  flash('master-msg', `forming the party, then handing it to ${master}…`)
}
$('btn-invite-master').onclick = async () => {
  const master = $('master').value.trim()
  if (!master) return flash('master-msg', 'enter the master account name first', false)
  const r = await act({ action: 'invite', target: master })
  flash('master-msg', r.ok ? `invited ${master}` : `invite failed: ${r.result?.response || r.error}`, r.ok)
}
$('btn-transfer-master').onclick = async () => {
  const master = $('master').value.trim()
  if (!master) return flash('master-msg', 'enter the master account name first', false)
  const r = await act({ action: 'transfer', target: master })
  flash('master-msg', r.ok ? `leadership transferred to ${master}` : `transfer failed: ${r.result?.response || r.error}`, r.ok)
}

// ───────────────────────────────────────────────────── server actions
// ── menu (hotbar item -> chest GUI -> click a slot) ───────────────────────
$('btn-menu').onclick = async () => {
  $('btn-menu').disabled = true
  const r = await act({ action: 'menu' })
  $('btn-menu').disabled = false
  const d = r.result || {}
  flash('menu-msg', r.error ? r.error
    : (r.ok
        ? `menu "${d.opened?.title}" opened; ${d.button}-clicked slot ${d.slot} (row ${d.row}, col ${d.col})` +
          (d.windowClosed ? '; the menu reacted and closed' : '; the window stayed open')
        : `failed: ${d.error || 'unknown'}`), !!r.ok)
}
$('btn-menu-save').onclick = async () => {
  const menu = {
    hotbarSlot: Number($('m-hotbar').value),
    row: Number($('m-row').value),
    col: Number($('m-col').value),
    button: $('m-button').value,
    expectTitle: $('m-title').value.trim()
  }
  const r = await post('/api/config', { menu, persist: true })
  flash('menu-msg', r.error ? 'error: ' + r.error : 'menu settings saved', !r.error)
}

// ── sneak bridge ───────────────────────────────────────────────────────────
$('btn-bridge').onclick = async () => {
  $('btn-bridge').disabled = true
  const r = await act({
    action: 'bridge', yaw: Number($('b-yaw').value), blocks: Number($('b-blocks').value),
    onObstacle: $('b-obstacle').value
  })
  $('btn-bridge').disabled = false
  const d = r.result || {}
  flash('bridge-msg', r.error ? r.error
    : (r.ok ? `bridged ${d.placed} block(s) in ${d.steps} step(s)` : `failed: ${d.error || 'nothing placed'}`),
    !!r.ok)
}
$('btn-bridge-save').onclick = async () => {
  const r = await post('/api/config', {
    bridge: { yaw: Number($('b-yaw').value), blocks: Number($('b-blocks').value), onObstacle: $('b-obstacle').value },
    persist: true
  })
  flash('bridge-msg', r.error ? 'error: ' + r.error : 'bridge settings saved', !r.error)
}

$('btn-warp').onclick = async () => {
  const r = await act({ action: 'warp', warp: $('warp-name').value.trim() || 'spawn' })
  flash('action-msg', r.ok ? 'leader warped' : `warp failed: ${r.result?.response || r.error}`, r.ok)
}
$('btn-warp-all').onclick = async () => {
  const w = $('warp-name').value.trim() || 'spawn'
  const bad = []
  for (const n of readyNames()) {
    const r = await act({ action: 'warp', actor: n, warp: w })
    if (r.error || r.ok === false) bad.push(n)
  }
  flash('action-msg', bad.length ? `warp failed for ${bad.length}/${readyNames().length}: ${bad.join(',')}` : `every bot warped to ${w}`, bad.length === 0)
}

// ──────────────────────────────────────────────────────── Learn overlay
function toRegex (line, names) {
  let s = reEsc(line)
  const used = new Set()
  for (const n of [...names, S.master].filter(Boolean)) {
    const pat = new RegExp('(?<![\\w])' + reEsc(n) + '(?![\\w])', 'g')
    if (!pat.test(s)) continue
    s = s.replace(pat, used.has(n) ? '\\w+' : '(?<player>\\w+)')
    used.add(n)
  }
  return '^' + s + '$'
}

let learnAction = null
async function openLearn (action) {
  learnAction = action
  const tpl = document.querySelector(`input[data-a="${action}"]`)?.value.trim()
  if (!tpl) return alert(`Fill in the "${action}" command first.`)
  const cmd = renderTemplate(tpl, sampleVars())
  $('learn-head').textContent = `${action} · the bot will send: ${cmd} · waiting for the reply…`
  $('learn-lines').innerHTML = '<div class="ln empty">waiting…</div>'
  $('learn-out').innerHTML = ''
  $('learn').hidden = false
  const d = await post('/api/learn', { text: cmd, windowMs: 2500 })
  if (d.error) { $('learn-head').textContent = 'error: ' + d.error; return }
  $('learn-head').textContent =
    `${action} · bot ${d.bot} sent: ${cmd} · ${d.lines.length} repl${d.lines.length === 1 ? 'y' : 'ies'} in ${d.windowMs}ms`
  renderLearnLines(d.lines)
}

function renderLearnLines (lines) {
  const box = $('learn-lines')
  const names = S.bots.map((b) => b.name)
  box.innerHTML = ''
  if (!lines.length) {
    box.innerHTML = '<div class="ln empty">No chat came back in that window — which is itself a ' +
      'signal: a wrong command usually gets no reply at all.</div>'
    return
  }
  for (const l of lines) {
    const d = document.createElement('div')
    d.className = 'ln'
    d.innerHTML = `<code>${esc(l.text)}</code>
      <button class="btn ghost tiny" data-ok>success</button>
      <button class="btn ghost tiny" data-bad>failure</button>`
    const pick = async (kind) => {
      const re = toRegex(l.text, names)
      box.querySelectorAll('.ln').forEach((x) => x.style.outline = '')
      d.style.outline = '2px solid ' + (kind === 'ok' ? 'var(--ok)' : 'var(--bad)')
      $('learn-out').innerHTML =
        `<div class="sub">Regex generated for <b>${esc(learnAction)}</b> (${kind === 'ok' ? 'success' : 'failure'}). Edit it if you like, then save.</div>` +
        `<textarea id="re-out" spellcheck="false">${esc(re)}</textarea>` +
        `<div class="row gap" style="justify-content:flex-start;margin-top:8px"><button class="btn primary" id="re-save">Save this regex</button></div>`
      $('re-save').onclick = async () => {
        const val = $('re-out').value.trim()
        const spec = kind === 'ok' ? { success: val } : { failure: [val] }
        // Carry the template too. applyCommands skips any spec without a string template, so
        // saving a regex for a command that was not already in the config file silently did
        // nothing — the operator saw "saved" and nothing changed.
        const tpl = document.querySelector(`input[data-a="${learnAction}"]`)?.value.trim()
        if (tpl) spec.template = tpl
        const r = await post('/api/config', { commands: { [learnAction]: spec }, persist: true })
        $('learn-head').textContent = r.error ? 'error: ' + r.error : `saved the ${kind} regex for ${learnAction}`
      }
    }
    d.querySelector('[data-ok]').onclick = () => pick('ok')
    d.querySelector('[data-bad]').onclick = () => pick('bad')
    box.appendChild(d)
  }
}
$('learn-close').onclick = () => { $('learn').hidden = true }
$('btn-contrast').onclick = () => document.body.classList.toggle('contrast')

// ──────────────────────────────────────────────────────────────── SSE
function connect () {
  const es = new EventSource('/events')
  es.addEventListener('open', () => { $('conn').textContent = 'SSE: open'; $('conn').className = 'pill on' })
  es.addEventListener('error', () => { $('conn').textContent = 'SSE: disconnected'; $('conn').className = 'pill off' })

  es.addEventListener('state', (m) => {
    S = JSON.parse(m.data)
    $('target').textContent =
      `${S.server.host}:${S.server.port} · MC ${S.server.version} · ` +
      `auth ${S.auth.enabled ? S.auth.strategy + (S.auth.register ? ' +register' : '') : 'off'} · ` +
      `rejoin ${S.rejoinOnKick ? 'on' : 'off'}`
    if (!$('address').value) $('address').value = `${S.server.host}:${S.server.port}`
    // Never overwrite the field the operator is typing in.
    if (document.activeElement !== $('master')) $('master').value = S.master || ''
    // Re-render the command fields whenever the operator has NOT touched them.
    //
    // Running this once and never again was a real bug: after the server's config changed (a
    // restart with new defaults, or another tab saving), the page kept showing the values it
    // first rendered, and the next Save wrote those stale values back over the server's. That
    // silently reverted a working accept command to a broken one. Mirrors accountsDirty.
    if (!commandsDirty) {
      // Rebuilding the inputs on every state push (they arrive often) threw away the caret of
      // whatever field the operator had focused. Only rebuild when the set actually changed.
      const sig = JSON.stringify(S.commands)
      if (sig !== commandsSignature) { commandsSignature = sig; renderCommands() }
    }
    renderBots()
    if (!accountsDirty && S.accounts) {
      $('accounts').value = S.accounts
      const n = S.accounts.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length
      $('acc-count').textContent = `${n} account${n === 1 ? '' : 's'}`
    }
    // A run is a multi-second sequence; leaving every button live invited a second press that
    // interleaved with the first.
    const busy = !!S.running
    for (const id of ['btn-run', 'btn-master', 'btn-invite-master', 'btn-transfer-master',
                      'btn-disband', 'btn-leave', 'btn-warp', 'btn-warp-all', 'btn-connect']) {
      const el = $(id)
      if (el) el.disabled = busy
    }
    if (busy) { $('btn-run').textContent = 'running…'; $('btn-master').disabled = true }
  })

  es.addEventListener('event', (m) => {
    const e = JSON.parse(m.data)
    switch (e.topic) {
      case 'mc:chat': if (e.text) logLine('chat', `${e.bot} << ${e.text}`); break
      case 'mc:sent': logLine('sent', `${e.bot} >> ${e.text}`); break
      case 'cmd:result': logLine(e.status, `${e.bot} ${e.action}${e.vars?.player ? ' ' + e.vars.player : ''} -> ${e.status}  ${e.response || e.error || ''}`); break
      case 'bot:state': logLine('', `${e.bot}: ${e.from} -> ${e.to}`); break
      case 'auth:ok': logLine('OK', `${e.bot} authenticated via ${e.via}`); break
      case 'auth:fail': logLine('FAILED', `${e.bot} auth failed: ${e.pattern}${e.fatal ? ' (fatal)' : ''}`); break
      case 'mc:kick': logLine('FAILED', `${e.bot} KICKED: ${e.text}`); break
      case 'mc:disconnect': logLine('FAILED', `${e.bot} disconnected: ${e.text}`); break
      case 'mc:warn': logLine('NO_RESPONSE', `${e.bot} ${e.why}${e.text ? ' :: ' + JSON.stringify(e.text) : ''}`); break
      case 'party:full': logLine('OK', `-- party is full (${e.size}) - every bot standing down with /${e.action}`); break
      case 'bedwars:state': logLine(e.phase === 'failed' ? 'FAILED' : e.phase === 'done' ? 'OK' : '',
        `${e.bot} BedWars: ${e.phase}${e.target ? ` → ${e.target}` : ''}${e.result?.error ? ' :: ' + e.result.error : ''}`); break
      case 'mc:windowOpen': logLine('OK', `${e.bot} menu opened: "${e.title}" (${e.slotCount} slots)`); break
      case 'menu:state': logLine(e.state === 'done' ? 'OK' : e.state === 'failed' ? 'FAILED' : '',
        `${e.bot} area: ${e.state}${e.result?.opened ? ` via "${e.result.opened.title}" slot ${e.result.slot}` : ''}${e.result?.error ? ' :: ' + e.result.error : ''}`); break
      case 'mc:windowClose': logLine('', `${e.bot} menu closed`); break
      case 'fleet:phase': logLine('', `-- ${e.phase}${e.ready != null ? ` ${e.ready}/${e.total}` : ''}${e.bot ? ' ' + e.bot : ''}${e.attempt ? ` (attempt ${e.attempt})` : ''}`); break
      case 'bus:error': logLine('ERROR', `bus handler threw on "${e.topic}": ${e.error?.message || e.error}`); break
    }
  })

  // Namespaced on purpose: an SSE 'error' listener also fires when the STREAM dies, so a
  // server-sent failure used to turn the connection pill red permanently while data kept
  // arriving. A run failure is now its own event.
  es.addEventListener('runerror', (m) => logLine('ERROR', `run failed: ${m.error}`))
  es.addEventListener('done', (m) => logLine(m.bad ? 'FAILED' : 'OK', `-- done: ${m.total} commands, ${m.bad} not OK`))
  es.addEventListener('connected', (m) => flash('connect-msg', `connected: ${m.ready}/${m.total} ready`, m.ready > 0))
}
connect()
