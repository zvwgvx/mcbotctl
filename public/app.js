// app.js — the mcbotctl dashboard. No framework and no build step.
import { parseProxyList } from './proxy-list.js'
import { mountBotControls } from './bot-control.js'

'use strict'

const ACTIONS = ['invite', 'accept', 'deny', 'leave', 'disband', 'transfer', 'promote', 'kick', 'chat', 'warp']
const ACTION_LABEL = { invite: 'Invite Player', accept: 'Join Party', deny: 'Decline Invite', leave: 'Leave Party', disband: 'Disband Party', transfer: 'Transfer Leadership', promote: 'Promote Player', kick: 'Remove Member', chat: 'Party Chat', warp: 'Warp' }
const NEEDS = { invite: 'player', accept: 'player', deny: 'player', leave: null, disband: null,
                transfer: 'player', promote: 'player', kick: 'player', chat: 'message', warp: 'warp' }

let S = { bots: [], commands: {}, accounts: '', master: '' }
let accountsDirty = false
let proxiesDirty = false
let proxySignature = null
let proxyAssignmentDraft = {}
let commandsRendered = false
let commandsDirty = false   // true once the operator has typed in a command field
// What each field was rendered with. Save sends ONLY the fields whose value differs, so a tab
// holding stale values can never clobber a field it did not touch. Sending every field was a
// real bug: a page rendered before a config change wrote its old copy back over the server's,
// silently reverting a working command template to a broken one.
let commandsRenderedWith = {}
let commandsSignature = null

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]))
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {})
}).then((r) => r.json()).catch((e) => ({ error: e.message }))
const act = (body) => post('/api/action', body)
const readyNames = () => S.bots.filter((b) => b.ready).map((b) => b.name)
const botControls = mountBotControls({ document, post })

function flash (id, msg, ok = true) {
  const el = $(id)
  if (!el) return
  el.textContent = msg
  el.style.color = ok ? 'var(--ok)' : 'var(--bad)'
  clearTimeout(el._t)
  el._t = setTimeout(() => { el.textContent = '' }, 6000)
}

function flashParty (msg, ok = true) {
  const box = $('party-feedback')
  if (!box) return
  box.style.display = 'flex'
  box.className = 'party-feedback-box ' + (ok ? 'ok' : 'bad')
  box.innerHTML = `<span style="font-size:16px;line-height:1;flex-shrink:0">${ok ? '✓' : '!'}</span> <span>${esc(msg)}</span>`
  clearTimeout(box._t)
  box._t = setTimeout(() => { box.style.display = 'none' }, 8000)
}

// ───────────────────────────────────────────────────────────── tabs
const TABS = ['server', 'accounts', 'proxies', 'party', 'control', 'commands', 'log']
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
const debugLogEl = $('match-debug')
function logLine (cls, text, at) {
  const d = document.createElement('div')
  const t = new Date(at || Date.now()).toLocaleTimeString('en-GB', { hour12: false })
  d.innerHTML = `<span class="t">${t}</span> <span class="${cls}">${esc(text)}</span>`
  logEl.appendChild(d)
  while (logEl.childElementCount > 500) logEl.removeChild(logEl.firstChild)
  logEl.scrollTop = logEl.scrollHeight
}
$('btn-clear').onclick = () => { logEl.innerHTML = '' }

function debugLine (e) {
  if (!debugLogEl) return
  const d = document.createElement('div')
  const t = new Date(e.at || Date.now()).toLocaleTimeString('en-GB', { hour12: false })
  const h = e.health || {}
  const io = h.io || {}
  const mf = h.mineflayer || {}
  const presence = e.presence || {}
  const cls = e.kind === 'detector-mismatch' || e.kind === 'terminal' ? 'FAILED' : e.kind === 'fingerprint-transition' ? 'OK' : ''
  const transition = e.from != null || e.to != null ? ` ${e.from ?? '\u2014'} \u2192 ${e.to ?? e.fingerprint ?? '\u2014'}` : ''
  const stage = presence.stage ?? 'none'
  const rx = Number.isFinite(h.rxPps) ? h.rxPps.toFixed(1) : '\u2014'
  const tx = Number.isFinite(h.txPps) ? h.txPps.toFixed(1) : '\u2014'
  const ka = io.lastKeepAliveRxAgoMs == null ? '\u2014' : `${io.lastKeepAliveRxAgoMs}ms`
  const reason = e.reason ? ` | ${e.reason}` : ''
  d.innerHTML = `<span class="t">${t}</span> <span class="${cls}">${esc(e.bot ?? 'fleet')} | ${esc(e.kind ?? 'debug')}${esc(transition)} | presence=${esc(stage)} | rx=${rx} tx=${tx} | entities=${mf.entities ?? '\u2014'} players=${mf.players ?? '\u2014'} | KA=${esc(ka)}${esc(reason)}</span>`
  debugLogEl.appendChild(d)
  while (debugLogEl.childElementCount > 300) debugLogEl.removeChild(debugLogEl.firstChild)
  debugLogEl.scrollTop = debugLogEl.scrollHeight
}
$('btn-debug-clear').onclick = () => { debugLogEl.innerHTML = '' }

// ───────────────────────────────────────────────────────────── bot squad
const PHASE_LABEL = { done: 'Operational', waiting: 'Connecting', pending: 'Offline' }
const PARTY_LABEL = { leader: 'Party Leader', member: 'Party Member', none: 'Not in Party', unknown: 'Membership Unconfirmed' }
const PARTY_CLASS = { leader: 'plead', member: 'pjoin', none: 'pbad', unknown: 'pnone' }

// The Members tab still shows the configured area gate and party roles. The bot cards below
// show the four independent progress signals supplied by the server.
const AREA_LABEL = { done: 'selector used', pending: 'selector pending', failed: 'selector failed' }
const AREA_CLASS = { done: 'pjoin', pending: 'pnone', failed: 'pbad' }

// A milestone is only green when the server has evidence for it. In particular, clicking the
// BedWars selector is not proof that the bot actually entered a match; null stays unconfirmed.
function milestone (label, value, { yes, no, unknown = 'Unconfirmed', detail = '' }) {
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
    const bedwarsStage = progress.bedwarsStage === 'match' ? '(Match)'
      : progress.bedwarsStage === 'mode' ? '(Lobby)' : ''
    const partyDetail = role === 'leader' ? '(Leader)'
      : role === 'member' && b.party?.leader ? `(${b.party.leader})` : ''
    const combat = b.combat ?? { state: 'disabled', target: null, reason: null }
    const combatClass = ['nearby', 'acquiring', 'targeting', 'cooldown', 'attacked', 'watching'].includes(combat.state) ? 'pjoin'
      : combat.state === 'error' ? 'pbad' : 'pnone'
    const combatDetail = combat.target ? ` → ${combat.target}` : ''
    const autoplay = b.autoplay ?? { phase: 'off', task: null, blockedReason: null, error: null }
    const autoplayClass = ['playing', 'acting', 'recovering', 'starting'].includes(autoplay.phase) ? 'pjoin'
      : ['blocked', 'failed'].includes(autoplay.phase) ? 'pbad' : 'pnone'
    const autoplayTask = autoplay.task ?? autoplay.action ?? null
    const autoplayIssue = autoplay.blockedReason ?? autoplay.reason ?? autoplay.error ?? autoplay.lastResult?.error ?? ''
    const autoplayDetail = autoplayTask ? ` · ${autoplayTask.replaceAll('_', ' ')}` : ''
    const movement = b.movement ?? { state: 'idle', heading: null, velocity: null, reason: null }
    const movementSpeed = Number(movement.velocity?.horizontal)
    const movementClass = movement.state === 'moving' ? 'pjoin'
      : ['blocked', 'stopped', 'disconnected'].includes(movement.state) ? 'pbad' : 'pnone'
    const movementHeading = Number.isFinite(Number(movement.heading))
      ? ` · heading ${(Number(movement.heading) * 180 / Math.PI).toFixed(0)}°` : ''
    const movementSpeedText = Number.isFinite(movementSpeed) ? ` · ${movementSpeed.toFixed(2)} b/t` : ''
    const movementReason = movement.reason ? ` · ${movement.reason}` : ''
    const movementText = movement.state === 'moving' ? 'Motion: moving'
      : movement.state === 'paused_safe' ? 'Motion: safely paused'
        : movement.state === 'waiting_lane' ? 'Motion: waiting for action'
          : movement.state === 'recovering' ? 'Motion: recovering'
            : movement.state === 'restarting' ? 'Motion: restarting'
              : `Motion: ${String(movement.state ?? '').replaceAll('_', ' ')}`
    const roam = autoplay.roam ?? null
    const observedSpeed = Number(roam?.velocity?.horizontal)
    const roamSafety = roam?.lastSafetyStop?.reason ?? ''
    const roamClass = ['moving', 'turning', 'recovering'].includes(roam?.state) ? 'pjoin'
      : roam?.state === 'stopped' && roamSafety ? 'pbad' : 'pnone'
    const roamInput = roam?.input ? ` · ${roam.input}` : ''
    const roamHeading = roam?.heading ? ` · ${roam.heading}` : ''
    const roamSpeed = Number.isFinite(observedSpeed) ? ` · observed ${observedSpeed.toFixed(2)} b/t` : ''
    const roamSegments = Number.isFinite(Number(roam?.segments)) ? ` · ${Math.max(0, Math.floor(Number(roam.segments)))} segments` : ''
    const roamPlan = roam?.state !== 'moving' && roam?.replan ? ` · ${String(roam.replan).replaceAll('_', ' ')}` : ''
    const roamText = roam?.state === 'moving' ? 'Motion: roaming'
      : roam?.state === 'turning' ? 'Motion: turning'
        : roam?.state === 'recovering' ? 'Motion: recovering'
          : roam?.state === 'paused_safe' ? 'Motion: safely paused'
            : `Motion: ${String(roam?.state ?? '').replaceAll('_', ' ')}`
    const lease = b.actionLease
    const proxy = b.proxy ?? { kind: 'direct', blocked: false, proxyName: null, address: null, reason: null }
    const proxyClass = proxy.blocked ? 'pbad' : proxy.kind === 'proxy' ? 'plead' : 'poff'
    const proxyText = proxy.blocked ? 'Route: blocked'
      : proxy.kind === 'proxy' ? `SOCKS5: ${proxy.proxyName ?? proxy.address ?? 'proxy'}` : 'Route: direct'
    const proxyTitle = proxy.reason ?? proxy.address ?? 'Direct TCP connection'
    const d = document.createElement('div')
    d.className = 'glass card'
    d.dataset.phase = b.phase
    d.innerHTML = `<div class="frost"></div><div class="content">
      <div class="who">${esc(b.name)}</div>
      <div class="st"><span class="dot ${esc(b.phase)}"></span>${esc(PHASE_LABEL[b.phase] || b.state)}</div>
      <div class="milestones" aria-label="Progress for ${esc(b.name)}">
        ${milestone('Connection', progress.connected, { yes: 'Connected', no: 'Disconnected' })}
        ${milestone('Authentication', authView, {
          yes: 'Confirmed', no: progress.authDetail === 'failed' ? 'Failed'
            : progress.authDetail === 'disconnected' ? 'Disconnected' : 'Not logged in',
          unknown: progress.authDetail === 'pending'
            ? (progress.connected ? 'Authenticating' : 'Waiting for connection') : 'Unconfirmed'
        })}
        ${milestone('BedWars', progress.bedwarsJoined, {
          yes: 'Available', no: 'Unavailable', detail: bedwarsStage
        })}
        ${milestone('Party', progress.partyJoined, { yes: 'Member', no: 'Not a member', detail: partyDetail })}
      </div>
      ${!progress.connected && progress.lastDisconnectReason
        ? `<div class="bot-reason">Last disconnect: ${esc(progress.lastDisconnectReason)}</div>`
        : !progress.connected && progress.fleetBlockReason
          ? `<div class="bot-reason">Fleet status: ${esc(progress.fleetBlockReason)}</div>` : ''}
      ${!progress.connected && progress.verificationUrl
        ? `<div class="bot-reason"><a href="${esc(progress.verificationUrl)}" target="_blank" rel="noopener noreferrer">Open connection verification</a></div>` : ''}
      ${b.offline ? '<div class="badge poff">Invisible in party</div>' : ''}
      <div class="badge ${proxyClass}" title="${esc(proxyTitle)}">${esc(proxyText)}</div>
      ${b.bedwars?.phase && b.bedwars.phase !== 'idle'
        ? `<div class="badge ${['done', 'island_reached'].includes(b.bedwars.phase) ? 'pjoin' : b.bedwars.phase === 'failed' ? 'pbad' : 'pnone'}" title="${esc(b.bedwars.result?.error ?? '')}">BedWars: ${esc(b.bedwars.phase.replaceAll('_', ' '))}</div>`
        : ''}
      ${S.autoplay?.enabled && autoplay.phase && autoplay.phase !== 'off'
        ? `<div class="badge ${autoplayClass}" title="${esc(autoplayIssue)}">Autoplay: ${esc(autoplay.phase.replaceAll('_', ' '))}${esc(autoplayDetail)}</div>`
        : ''}
      ${roam?.state && roam.state !== 'idle'
        ? `<div class="badge ${roamClass}" title="${esc(roamSafety)}">${esc(roamText + roamInput + roamHeading + roamSpeed + roamSegments + roamPlan)}</div>`
        : ''}
      ${movement.state && !['idle', 'disabled', 'disconnected'].includes(movement.state)
        ? `<div class="badge ${movementClass}" title="${esc(movement.reason ?? '')}">${esc(movementText + movementHeading + movementSpeedText + movementReason)}</div>`
        : ''}
      ${lease ? `<div class="badge pnone" title="${esc(lease.cancelReason ?? '')}">Action: ${esc(`${lease.owner}:${lease.action}`)}</div>` : ''}
      ${combat.state && combat.state !== 'disabled'
        ? `<div class="badge ${combatClass}" title="${esc(combat.reason ?? '')}">Combat: ${esc(combat.state.replaceAll('_', ' '))}${esc(combatDetail)}</div>`
        : ''}
      <button class="btn ghost tiny bot-control-shortcut" type="button">Control bot</button>
    </div>`
    d.querySelector('.bot-control-shortcut').onclick = () => {
      showTab('control')
      botControls.selectBot(b.name)
    }
    box.appendChild(d)
  }
  const ready = S.bots.filter((b) => b.ready).length
  $('ready-count').textContent = S.bots.length ? `${ready}/${S.bots.length} operational` : ''
  const bedwarsReady = S.bots.filter((b) => b.progress?.bedwarsJoined === true).length
  const partyReady = S.bots.filter((b) => b.progress?.partyJoined === true).length
  const total = S.bots.length
  const walking = S.bots.filter((b) => b.walking).length
  const fleetBlock = S.rejoin?.blocked === true ? S.rejoin : null
  const connected = S.bots.some((b) => b.progress?.connected === true)

  if ($('metric-operational')) {
    $('metric-operational').textContent = total ? `${ready}/${total}` : '—'
    $('metric-operational-detail').textContent = ready === total && total ? 'All accounts ready' : `${Math.max(0, total - ready)} unavailable`
    $('metric-bedwars').textContent = total ? `${bedwarsReady}/${total}` : '—'
    $('metric-bedwars-detail').textContent = bedwarsReady ? 'Presence confirmed' : 'No confirmed presence'
    $('metric-party').textContent = total ? `${partyReady}/${total}` : '—'
    $('metric-party-detail').textContent = partyReady === total && total ? 'Fleet synchronized' : `${Math.max(0, total - partyReady)} outside party`
    $('metric-automation').textContent = fleetBlock ? 'Paused' : total ? `${walking}/${total}` : '—'
    $('metric-automation-detail').textContent = fleetBlock
      ? (fleetBlock.label || 'Server blocked automatic reconnect')
      : walking === total && total
        ? 'All bots moving'
        : connected ? `${Math.max(0, total - walking)} waiting for movement recovery` : 'No connected bots'
  }

  $('walk-count').textContent = fleetBlock ? ' · suspended' : walking ? ` · ${walking} moving` : ''
  const wb = $('btn-walk')
  if (wb) {
    const on = walking > 0
    wb.dataset.on = on ? '1' : '0'
    wb.disabled = !!fleetBlock || !connected
    wb.textContent = fleetBlock ? 'Movement unavailable: server blocked fleet'
      : !connected ? 'No connected bots'
        : on ? 'Pause Continuous Movement' : 'Resume Continuous Movement'
    wb.classList.toggle('primary', !fleetBlock && connected && !on)
  }
  $('tab-status').textContent = S.bots.length ? `${ready}/${S.bots.length} operational` : ''
  const bwBot = S.bots.find((b) => b.name === S.bedwars?.actor)
  const bw = bwBot?.bedwars ?? { phase: 'idle' }
  const bwText = !S.bedwars?.enabled ? 'Opening disabled' : `${S.bedwars?.actor ?? 'bot'}: ${bw.phase.replaceAll('_', ' ')}` +
    (bw.iron != null ? ` · ${bw.iron} iron` : '') +
    (bw.wool != null ? ` · ${bw.wool} wool` : '') +
    (bw.target ? ` · target ${bw.target}` : '')
  $('bedwars-state').textContent = bwText
  if (bw.result?.error) $('bedwars-msg').textContent = bw.result.error
  const autoplayRunning = S.bots.filter((b) => ['playing', 'acting', 'recovering', 'starting'].includes(b.autoplay?.phase)).length
  const autoplayBlocked = S.bots.filter((b) => ['blocked', 'failed'].includes(b.autoplay?.phase)).length
  const autoplayArmed = S.bots.filter((b) => !['blocked', 'failed'].includes(b.autoplay?.phase) &&
    (String(b.autoplay?.phase ?? '').startsWith('armed') || b.autoplay?.armed === true)).length
  const autoplayState = $('autoplay-state')
  if (autoplayState) {
    autoplayState.textContent = !S.autoplay?.enabled ? 'disabled'
      : autoplayBlocked ? `${autoplayBlocked}/${S.bots.length} blocked`
        : autoplayRunning ? `${autoplayRunning}/${S.bots.length} playing`
        : autoplayArmed ? `${autoplayArmed}/${S.bots.length} armed`
          : S.autoplay?.autoStart ? 'armed on confirmed match' : 'idle'
  }
  renderMembers()
}

function renderMembers () {
  const box = $('members')
  if (!box) return
  box.innerHTML = ''
  for (const b of S.bots) {
    const d = document.createElement('div')
    d.className = 'member'
    const role = b.progress?.partyJoined == null ? 'unknown' : ((b.party && b.party.role) || 'none')
    const bwJoined = b.progress?.bedwarsJoined
    const bwBadge = bwJoined === true
      ? `<span class="badge ok" title="BedWars presence confirmed">BedWars Ready</span>`
      : bwJoined === false
        ? `<span class="badge pbad" title="Confirmed outside BedWars">Outside BedWars</span>`
        : `<span class="badge warn" title="BedWars presence is unconfirmed">BedWars Unconfirmed</span>`

    const partyText = role === 'member' && b.party?.leader
      ? `Member · ${b.party.leader}`
      : PARTY_LABEL[role]

    d.innerHTML = `
      <div class="member-left">
        <span class="dot ${esc(b.phase)}"></span>
        <span class="who" title="${esc(b.name)}">${esc(b.name)}</span>
      </div>
      <div class="member-badges">
        ${bwBadge}
        <span class="badge ${PARTY_CLASS[role]}">${esc(partyText)}</span>
      </div>
    `

    const btnGroup = document.createElement('div')
    btnGroup.className = 'member-actions'

    const invBtn = document.createElement('button')
    invBtn.className = 'btn ghost tiny'
    invBtn.textContent = 'Invite'
    invBtn.title = `Invite ${b.name} to the current party`
    invBtn.disabled = !b.ready || role === 'leader' || role === 'member'
    invBtn.onclick = async () => {
      const r = await act({ action: 'invite', target: b.name })
      flashParty(r.ok ? `Invited ${b.name}` : `Invite failed for ${b.name}: ${r.result?.response || r.error}`, r.ok)
    }
    btnGroup.appendChild(invBtn)

    const bwBtn = document.createElement('button')
    bwBtn.className = 'btn ghost tiny'
    bwBtn.textContent = 'Enter BedWars'
    bwBtn.title = `Move ${b.name} to the BedWars lobby through the configured selector`
    bwBtn.disabled = !b.ready
    bwBtn.onclick = async () => {
      flashParty(`Opening the menu for ${b.name}…`, true)
      const r = await act({ action: 'menu', bot: b.name })
      flashParty(r.ok ? `${b.name} reached the BedWars lobby` : `Could not confirm BedWars entry for ${b.name}: ${r.error || r.result?.error}`, r.ok)
    }
    btnGroup.appendChild(bwBtn)

    const kick = document.createElement('button')
    kick.className = 'btn kick tiny'
    kick.textContent = 'Remove'
    kick.title = `Remove ${b.name} from the current party`
    kick.disabled = !b.ready || role === 'leader' || role === 'none'
    kick.onclick = async () => {
      const r = await act({ action: 'kick', target: b.name })
      flashParty(r.ok ? `Removed ${b.name} from the party` : `Could not remove ${b.name}: ${r.result?.response || r.error}`, r.ok)
    }
    btnGroup.appendChild(kick)

    d.appendChild(btnGroup)
    box.appendChild(d)
  }
}

// ───────────────────────────────────────────────────────────── command config
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
      `<label>${esc(ACTION_LABEL[a] || a)}</label>` +
      `<input data-a="${a}" value="${esc(spec.template || '')}" spellcheck="false" ` +
      `placeholder="${need === 'message' ? '/p chat hello' : need === 'warp' ? '/warp spawn' : need ? '/p inv <name>' : '/p disband'}">` +
      `<button class="btn ghost tiny" data-learn="${a}" title="Send this command once and capture the live server reply">Probe Reply</button>` +
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
      ? `Will send: <b>${esc(renderTemplate(tpl, vars))}</b>` +
        (missing ? ` &nbsp;·&nbsp; <span style="color:var(--warn)">missing {${need}}</span>` : '')
      : '<span style="color:var(--ink-dim)">Not configured</span>'
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
    return flash('save-msg', 'No changes to save', true)
  }
  const r = await post('/api/config', { commands, persist: true })
  if (r.error) return flash('save-msg', 'Error: ' + r.error, false)
  commandsDirty = false
  for (const a of changed) commandsRenderedWith[a] = commands[a].template
  flash('save-msg', `Saved ${changed.length} command profile${changed.length === 1 ? '' : 's'}` +
    (removed.length ? ` · ${removed.length} blank profile${removed.length === 1 ? '' : 's'} left unchanged` : ''))
}

// ───────────────────────────────────────────────────────────── test server
$('btn-connect').onclick = async () => {
  const address = $('address').value.trim()
  $('btn-connect').disabled = true
  $('btn-connect').textContent = 'Connecting…'
  const r = await post('/api/connect', { address, persist: true })
  $('btn-connect').disabled = false
  $('btn-connect').textContent = 'Connect Fleet'
  flash('connect-msg', r.error ? 'Error: ' + r.error
    : `Connecting to ${r.address}${r.note ? ' · ' + r.note : ''} · staggered fleet startup in progress…`, !r.error)
}
$('btn-walk').onclick = async () => {
  const on = $('btn-walk').dataset.on !== '1'
  $('btn-walk').disabled = true
  const r = await act({ action: 'walk', enabled: on, persist: true })
  $('btn-walk').disabled = false
  if (r.error) return flash('connect-msg', r.error, false)
  flash('connect-msg', r.walking ? `Continuous movement enabled for ${r.changed.length} bot(s)` : `Continuous movement paused for ${r.changed.length} bot(s)`, true)
}
$('btn-disconnect').onclick = async () => {
  const r = await act({ action: 'disconnect', bot: 'all' })
  flash('connect-msg', r.error ? r.error : `Disconnected ${r.disconnected.length} bot(s)`, !r.error)
}
const bedwarsStart = $('btn-bedwars-start')
if (bedwarsStart) {
  bedwarsStart.onclick = async () => {
    bedwarsStart.disabled = true
    const r = await post('/api/bedwars', { action: 'start' })
    bedwarsStart.disabled = false
    flash('bedwars-msg', r.error ? r.error : `Opening sequence started for ${r.bot}`, !r.error)
  }
}
const bedwarsStop = $('btn-bedwars-stop')
if (bedwarsStop) {
  bedwarsStop.onclick = async () => {
    const r = await post('/api/bedwars', { action: 'stop' })
    flash('bedwars-msg', r.error ? r.error : r.stopped ? `Opening sequence stopped for ${r.bot}` : `No opening sequence is active for ${r.bot}`, !r.error)
  }
}
const autoplayStart = $('btn-autoplay-start')
if (autoplayStart) {
  autoplayStart.onclick = async () => {
    autoplayStart.disabled = true
    const r = await post('/api/autoplay', { action: 'start', bot: 'all' })
    autoplayStart.disabled = false
    const accepted = (r.results || []).filter((x) => x.ok).length
    flash('autoplay-msg', r.error ? r.error : `Autoplay armed for ${accepted}/${(r.results || []).length} bot(s)`, !r.error)
  }
}
const autoplayForce = $('btn-autoplay-force')
if (autoplayForce) {
  autoplayForce.onclick = async () => {
    autoplayForce.disabled = true
    const r = await post('/api/autoplay', { action: 'start', bot: 'all', force: true })
    autoplayForce.disabled = false
    const accepted = (r.results || []).filter((x) => x.ok).length
    flash('autoplay-msg', r.error ? r.error : `Expedited autoplay armed for ${accepted}/${(r.results || []).length} bot(s); match confirmation is still required`, !r.error)
  }
}
const autoplayStop = $('btn-autoplay-stop')
if (autoplayStop) {
  autoplayStop.onclick = async () => {
    autoplayStop.disabled = true
    const r = await post('/api/autoplay', { action: 'stop', bot: 'all' })
    autoplayStop.disabled = false
    const accepted = (r.results || []).filter((x) => x.ok).length
    flash('autoplay-msg', r.error ? r.error : `Autoplay stopped for ${accepted}/${(r.results || []).length} bot(s)`, !r.error)
  }
}
// The Accounts tab has its own Disconnect button. It used to delegate to the Server tab's
// handler, which flashes its message into a panel that is hidden while you are on Accounts —
// so the click looked like it did nothing at all.
$('btn-acc-disc').onclick = async () => {
  const r = await act({ action: 'disconnect', bot: 'all' })
  flash('acc-msg', r.error ? r.error : `Disconnected ${r.disconnected.length} bot(s)`, !r.error)
}

// ───────────────────────────────────────────────────────────── accounts
$('btn-gen').onclick = async () => {
  const r = await post('/api/accounts/generate', {
    count: Number($('gen-count').value),
    prefix: $('gen-prefix').value.trim() || 'Bot',
    password: $('gen-pass').value || 'changeme123'
  })
  if (r.error) return flash('acc-msg', 'Error: ' + r.error, false)
  $('accounts').value = r.text
  accountsDirty = true
  flash('acc-msg', `Generated ${r.accounts.length} account${r.accounts.length === 1 ? '' : 's'} · review before saving`)
}
$('accounts').addEventListener('input', () => { accountsDirty = true })
$('btn-acc-save').onclick = async () => {
  const r = await post('/api/accounts', { text: $('accounts').value, persist: true, rebuild: $('acc-rebuild').checked })
  if (r.error) return flash('acc-msg', 'Error: ' + r.error, false)
  accountsDirty = false
  flash('acc-msg', `Saved ${r.count} account${r.count === 1 ? '' : 's'}${r.rebuilt ? ' · fleet rebuilt' : ''}`)
}

// ───────────────────────────────────────────────────────────── proxies
function nextProxyId () {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `proxy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function markProxiesDirty () {
  proxiesDirty = true
  flash('proxy-msg', 'Unsaved proxy changes', true)
}

function proxyRows () {
  return [...document.querySelectorAll('#proxy-list .proxy-row')]
}

function readProxyRows () {
  return proxyRows().map((row) => {
    const password = row.querySelector('[data-proxy="password"]').value
    const clearPassword = row.querySelector('[data-proxy-clear]')?.checked === true
    const proxy = {
      id: row.dataset.id,
      name: row.querySelector('[data-proxy="name"]').value.trim(),
      host: row.querySelector('[data-proxy="host"]').value.trim(),
      port: Number(row.querySelector('[data-proxy="port"]').value),
      username: row.querySelector('[data-proxy="username"]').value.trim(),
      enabled: row.querySelector('[data-proxy="enabled"]').checked
    }
    if (password) proxy.password = password
    if (clearPassword) proxy.clearPassword = true
    return proxy
  })
}

function addProxyRow (proxy = {}, { dirty = true } = {}) {
  const list = $('proxy-list')
  const row = document.createElement('div')
  row.className = 'proxy-row'
  row.dataset.id = proxy.id || nextProxyId()
  row.dataset.hasPassword = proxy.hasPassword ? '1' : '0'
  const title = proxy.name || (proxy.host ? `${proxy.host}:${proxy.port || 1080}` : 'New SOCKS5 proxy')
  row.innerHTML = `
    <div class="proxy-row-head">
      <span class="proxy-row-title">${esc(title)}</span>
      <div class="row gap">
        <label class="chk"><input type="checkbox" data-proxy="enabled" ${proxy.enabled === false ? '' : 'checked'}> Enabled</label>
        <button class="btn danger tiny" type="button" data-proxy-remove>Remove</button>
      </div>
    </div>
    <div class="proxy-fields">
      <label class="proxy-field">Name<input data-proxy="name" value="${esc(proxy.name ?? '')}" placeholder="Proxy 1"></label>
      <label class="proxy-field">Host<input data-proxy="host" value="${esc(proxy.host ?? '')}" placeholder="127.0.0.1" spellcheck="false"></label>
      <label class="proxy-field">Port<input data-proxy="port" type="number" min="1" max="65535" value="${esc(proxy.port ?? 1080)}"></label>
    </div>
    <div class="proxy-fields secondary">
      <label class="proxy-field">Username<input data-proxy="username" value="${esc(proxy.username ?? '')}" autocomplete="off" spellcheck="false"></label>
      <label class="proxy-field">Password<input data-proxy="password" type="password" value="" autocomplete="new-password" placeholder="${proxy.hasPassword ? 'Saved — leave blank to keep' : 'Optional'}"></label>
      <label class="chk proxy-password-state" ${proxy.hasPassword ? '' : 'hidden'}><input type="checkbox" data-proxy-clear> Clear saved password</label>
    </div>`
  row.querySelector('[data-proxy="password"]').value = proxy.password ?? ''

  const changed = (event) => {
    if (event.target.matches('[data-proxy="name"], [data-proxy="host"], [data-proxy="port"]')) {
      const name = row.querySelector('[data-proxy="name"]').value.trim()
      const host = row.querySelector('[data-proxy="host"]').value.trim()
      const port = row.querySelector('[data-proxy="port"]').value
      row.querySelector('.proxy-row-title').textContent = name || (host ? `${host}:${port}` : 'New SOCKS5 proxy')
    }
    markProxiesDirty()
    renderProxyAssignments()
  }
  row.querySelectorAll('input').forEach((input) => {
    input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', changed)
  })
  row.querySelector('[data-proxy-remove]').onclick = () => {
    const removedId = row.dataset.id
    row.remove()
    for (const [bot, proxyId] of Object.entries(proxyAssignmentDraft)) {
      if (proxyId === removedId) proxyAssignmentDraft[bot] = ''
    }
    markProxiesDirty()
    renderProxyAssignments()
  }
  list.appendChild(row)
  if (dirty) {
    markProxiesDirty()
    renderProxyAssignments()
  }
}

function renderProxyAssignments () {
  const box = $('proxy-assignments')
  if (!box) return
  const mode = $('proxy-mode').value
  const proxies = readProxyRows().filter((proxy) => proxy.enabled)
  const routes = new Map((S.proxy?.routes ?? []).map((route) => [route.bot, route]))
  box.innerHTML = ''
  $('proxy-assignment-help').textContent = mode === 'manual'
    ? 'Every bot needs an enabled proxy. Unassigned bots are blocked before opening a TCP connection.'
    : mode === 'balanced'
      ? 'Bot i uses enabled proxy i % k, starting at index 0. Bot and proxy list order determine the assignment.'
      : 'Proxy routing is disabled; bots connect directly to the Minecraft server.'

  for (const bot of S.bots) {
    const row = document.createElement('div')
    row.className = 'proxy-assignment-row'
    const name = `<span class="proxy-assignment-bot">${esc(bot.name)}</span>`
    if (mode === 'manual') {
      const options = [`<option value="">Unassigned — block connection</option>`]
      for (const proxy of proxies) {
        const label = proxy.name || `${proxy.host}:${proxy.port}`
        options.push(`<option value="${esc(proxy.id)}">${esc(label)}</option>`)
      }
      row.innerHTML = `${name}<select class="sel" data-proxy-bot="${esc(bot.name)}">${options.join('')}</select>`
      const select = row.querySelector('select')
      select.value = proxyAssignmentDraft[bot.name] ?? ''
      select.onchange = () => {
        proxyAssignmentDraft[bot.name] = select.value
        markProxiesDirty()
      }
    } else {
      const route = routes.get(bot.name)
      const pending = mode === 'balanced' && proxiesDirty
      const text = mode === 'off' ? 'Direct connection'
        : pending ? 'Assigned in list order after save'
          : route?.kind === 'proxy' ? `${route.proxyName} · ${route.address}`
            : route?.reason || 'Waiting for assignment'
      const cls = mode === 'off' ? '' : route?.blocked ? 'blocked' : 'active'
      row.innerHTML = `${name}<span class="proxy-route-value ${cls}">${esc(text)}</span>`
    }
    box.appendChild(row)
  }

  const enabled = proxies.length
  const blocked = (S.proxy?.routes ?? []).filter((route) => route.blocked).length
  $('proxy-summary').textContent = mode === 'off' ? 'Direct connections'
    : `${enabled} enabled prox${enabled === 1 ? 'y' : 'ies'}${mode === 'manual' && blocked ? ` · ${blocked} blocked` : ''}`
  $('proxy-summary').className = `pill ${mode === 'off' || (mode === 'manual' && blocked) ? 'off' : 'on'}`
}

function renderProxyEditor () {
  const proxy = S.proxy ?? { mode: 'off', proxies: [], assignments: {}, routes: [] }
  $('proxy-mode').value = proxy.mode || 'off'
  $('proxy-list').innerHTML = ''
  for (const item of proxy.proxies ?? []) addProxyRow(item, { dirty: false })
  proxyAssignmentDraft = { ...(proxy.assignments ?? {}) }
  proxySignature = JSON.stringify(proxy)
  renderProxyAssignments()
}

function collectProxySettings (reconnect) {
  const proxies = readProxyRows()
  const enabledIds = new Set(proxies.filter((proxy) => proxy.enabled).map((proxy) => proxy.id))
  const assignments = Object.fromEntries(
    Object.entries(proxyAssignmentDraft).filter(([, proxyId]) => enabledIds.has(proxyId))
  )
  return { mode: $('proxy-mode').value, proxies, assignments, reconnect }
}

function importProxies () {
  const input = $('proxy-import')
  const parsed = parseProxyList(input.value)
  if (parsed.errors.length) {
    const errors = parsed.errors.slice(0, 5).map((error) => `Line ${error.line}: ${error.message}`).join('; ')
    flash('proxy-import-msg', `${errors}${parsed.errors.length > 5 ? `; ${parsed.errors.length - 5} more invalid lines` : ''}`, false)
    return false
  }
  if (!parsed.proxies.length) {
    flash('proxy-import-msg', 'Paste at least one proxy, one per line', false)
    return false
  }
  for (const proxy of parsed.proxies) addProxyRow(proxy, { dirty: false })
  input.value = ''
  markProxiesDirty()
  renderProxyAssignments()
  flash('proxy-import-msg', `Added ${parsed.proxies.length} prox${parsed.proxies.length === 1 ? 'y' : 'ies'} to the pool · save settings to apply`)
  return true
}

async function saveProxies (reconnect) {
  if ($('proxy-import').value.trim() && !importProxies()) return
  const save = $('btn-proxy-save')
  const apply = $('btn-proxy-apply')
  save.disabled = true
  apply.disabled = true
  const result = await post('/api/proxies', collectProxySettings(reconnect))
  save.disabled = false
  apply.disabled = false
  if (result.error) return flash('proxy-msg', `Error: ${result.error}`, false)
  proxiesDirty = false
  if (result.proxy) S.proxy = result.proxy
  proxySignature = null
  renderProxyEditor()
  flash('proxy-msg', reconnect ? 'Proxy settings saved · fleet reconnecting with the new routes' : 'Proxy settings saved for the next connection', true)
}

$('proxy-mode').onchange = () => { markProxiesDirty(); renderProxyAssignments() }
$('proxy-import').addEventListener('input', markProxiesDirty)
$('btn-proxy-import').onclick = importProxies
$('btn-proxy-add').onclick = () => addProxyRow()
$('btn-proxy-save').onclick = () => saveProxies(false)
$('btn-proxy-apply').onclick = () => saveProxies(true)

// ───────────────────────────────────────────────────────────── party
// Send every ready bot to the BedWars lobby.
const joinBwAllBtn = $('btn-join-bw-all')
if (joinBwAllBtn) {
  joinBwAllBtn.onclick = async () => {
    joinBwAllBtn.disabled = true
    flashParty('Starting BedWars selector flow for ready bots…', true)
    const r = await act({ action: 'join-bedwars-all' })
    joinBwAllBtn.disabled = false
    if (r.error) return flashParty(`BedWars selector flow failed: ${r.error}`, false)
    const bad = (r.results || []).filter((x) => x.status !== 'OK')
    flashParty(
      `BedWars lobby confirmed for ${(r.results || []).length - bad.length} bot(s)` +
      (bad.length ? `; ${bad.length} failed: ${bad.map((f) => f.bot + ': ' + (f.error || f.status)).join('; ')}` : ''),
      bad.length === 0
    )
  }
}

// Bot 1 invites the fleet; members accept the invitation.
$('btn-run').onclick = async () => {
  $('btn-run').disabled = true
  flashParty('Assembling party · sending invitations and joining available members…', true)
  const r = await act({ action: 'invite-all' })
  $('btn-run').disabled = false
  if (r.error) return flashParty(`Party assembly failed: ${r.error}`, false)
  const al = (r.alreadyIn ?? []).length
  const bad = (r.failed ?? []).length
  flashParty(
    `Party assembly complete · ${r.invited ?? 0} invitation(s) sent` +
    (al ? ` · ${al} already joined` : '') +
    (bad ? ` · ${bad} failed: ${(r.failed ?? []).map((f) => f.bot + ' ' + f.status).join('; ')}` : ''),
    bad === 0)
}

// Resend invitations without forcing members to join.
$('btn-party-inv-all').onclick = async () => {
  const btn = $('btn-party-inv-all')
  btn.dataset.pending = '1'
  btn.disabled = true
  flashParty('Resending party invitations to missing fleet members…', true)
  const r = await act({ action: 'party-invite-all' })
  delete btn.dataset.pending
  btn.disabled = !!S.running
  if (r.error) return flashParty(`Invitation refresh failed: ${r.error}`, false)
  const sent = (r.invited ?? []).length
  const inParty = (r.alreadyIn ?? []).length
  const pending = (r.alreadyInvited ?? []).length
  const failed = r.failed ?? []
  flashParty(`Invitation refresh · actor ${r.actor ?? 'leader'} · sent ${sent} · already joined ${inParty} · pending ${pending}` +
    (failed.length ? ` — ${failed.length} failed: ${failed.map((f) => `${f.bot}: ${f.response || f.status}`).join('; ')}` : ''),
    failed.length === 0 && !!r.ok)
}

// Every other bot accepts the leader's party invitation.
$('btn-join-all').onclick = async () => {
  $('btn-join-all').disabled = true
  flashParty('Joining ready bots to the current fleet leader…', true)
  const r = await act({ action: 'join-all' })
  $('btn-join-all').disabled = false
  if (r.error) return flashParty(`Party join operation failed: ${r.error}`, false)
  flashParty(
    `Party join confirmed for ${r.joined} bot(s)` +
    (r.failed?.length ? `; ${r.failed.length} failed: ${r.failed.map((f) => f.bot + ' ' + f.status).join('; ')}` : ''),
    !r.failed?.length)
}

// Query /party list from each ready bot.
const syncPartyListBtn = $('btn-party-list')
if (syncPartyListBtn) {
  syncPartyListBtn.onclick = async () => {
    syncPartyListBtn.disabled = true
    flashParty('Refreshing party state from the server…', true)
    const bots = readyNames()
    if (!bots.length) {
      syncPartyListBtn.disabled = false
      return flashParty('No operational bot is available to refresh party state.', false)
    }
    let count = 0
    for (const b of bots) {
      try {
        await act({ action: 'partyList', actor: b })
        count++
      } catch {}
      await new Promise((res) => setTimeout(res, 200))
    }
    syncPartyListBtn.disabled = false
    flashParty(`Party state refresh requested for ${count}/${bots.length} bot(s). Membership updates as replies arrive.`, true)
  }
}

// Disband the current party.
$('btn-disband').onclick = async () => {
  if (!confirm('Disband the current party? This ends the party for every member.')) return
  flashParty('Disbanding the current party…', true)
  const r = await act({ action: 'disband' })
  flashParty(r.ok ? 'Party disbanded successfully' : `Could not disband the party: ${r.result?.response || r.error}`, r.ok)
}

// Ask every ready bot to leave its current party.
$('btn-leave').onclick = async () => {
  if (!confirm('Remove every ready bot from its current party?')) return
  flashParty('Removing ready bots from their current party…', true)
  const bad = []
  for (const n of readyNames()) {
    const r = await act({ action: 'leave', actor: n })
    if (r.error || r.ok === false) bad.push(`${n}: ${r.result?.response || r.error}`)
  }
  flashParty(bad.length ? `${bad.length} bot(s) failed to leave: ${bad.join('; ')}` : 'All ready bots have left their party.', bad.length === 0)
}

// Expedite the post-confirmation start across all ready fleet bots.
const partyForceAutoplay = $('btn-party-force-autoplay')
if (partyForceAutoplay) {
  partyForceAutoplay.onclick = async () => {
    partyForceAutoplay.disabled = true
    flashParty('Expediting autoplay after a confirmed match for all ready bots…', true)
    const r = await post('/api/autoplay', { action: 'start', bot: 'all', force: true })
    partyForceAutoplay.disabled = false
    const accepted = (r.results || []).filter((x) => x.ok).length
    flashParty(r.error ? r.error : `Expedited autoplay armed for ${accepted}/${(r.results || []).length} bot(s); match confirmation is still required`, !r.error)
  }
}

// ───────────────────────────────────────────────────────────── master
$('btn-save-master').onclick = async () => {
  const r = await post('/api/config', {
    master: $('master').value.trim(), masterAcceptWaitMs: Number($('waitms').value), persist: true
  })
  flash('master-msg', r.error ? 'error: ' + r.error : 'Master settings saved', !r.error)
}
$('btn-master').onclick = async () => {
  const master = $('master').value.trim()
  if (!master) return flash('master-msg', 'Enter the botmaster username first', false)
  $('btn-master').disabled = true
  const cfg = await post('/api/config', { master, masterAcceptWaitMs: Number($('waitms').value) })
  if (cfg.error) { $('btn-master').disabled = false; return flash('master-msg', cfg.error, false) }
  const run = await post('/api/run', { mode: 'master', promote: $('promote').checked })
  if (run.error) { $('btn-master').disabled = false; return flash('master-msg', run.error, false) }
  flash('master-msg', `Assembling the party, then transferring leadership to ${master}…`)
}
$('btn-invite-master').onclick = async () => {
  const master = $('master').value.trim()
  if (!master) return flash('master-msg', 'Enter the botmaster username first', false)
  const r = await act({ action: 'invite', target: master })
  flash('master-msg', r.ok ? `Invitation sent to ${master}` : `Invitation failed: ${r.result?.response || r.error}`, r.ok)
}
$('btn-transfer-master').onclick = async () => {
  const master = $('master').value.trim()
  if (!master) return flash('master-msg', 'Enter the botmaster username first', false)
  const r = await act({ action: 'transfer', target: master })
  flash('master-msg', r.ok ? `Leadership transferred to ${master}` : `Leadership transfer failed: ${r.result?.response || r.error}`, r.ok)
}

// ───────────────────────────────────────────────────────────── server actions
// ── menu (hotbar item -> chest GUI -> click a slot) ───────────────────────
$('btn-menu').onclick = async () => {
  $('btn-menu').disabled = true
  const r = await act({ action: 'menu' })
  $('btn-menu').disabled = false
  const d = r.result || {}
  flash('menu-msg', r.error ? r.error
    : (r.ok
        ? `Selector complete · "${d.opened?.title}" · ${d.button} click on slot ${d.slot} (row ${d.row}, column ${d.col})` +
          (d.windowClosed ? ' · menu closed' : ' · menu remains open')
        : `Selector failed: ${d.error || 'unknown error'}`), !!r.ok)
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
  flash('menu-msg', r.error ? 'Error: ' + r.error : 'Selector settings saved', !r.error)
}

// ── sneak bridge ──────────────────────────────────────────────────────────
$('btn-bridge').onclick = async () => {
  $('btn-bridge').disabled = true
  const r = await act({
    action: 'bridge', yaw: Number($('b-yaw').value), blocks: Number($('b-blocks').value),
    onObstacle: $('b-obstacle').value
  })
  $('btn-bridge').disabled = false
  const d = r.result || {}
  flash('bridge-msg', r.error ? r.error
    : (r.ok ? `Bridge complete · ${d.placed} block(s) placed in ${d.steps} step(s)` : `Bridge failed: ${d.error || 'no blocks placed'}`),
    !!r.ok)
}
$('btn-bridge-save').onclick = async () => {
  const r = await post('/api/config', {
    bridge: { yaw: Number($('b-yaw').value), blocks: Number($('b-blocks').value), onObstacle: $('b-obstacle').value },
    persist: true
  })
  flash('bridge-msg', r.error ? 'Error: ' + r.error : 'Bridge settings saved', !r.error)
}

$('btn-warp').onclick = async () => {
  const r = await act({ action: 'warp', warp: $('warp-name').value.trim() || 'spawn' })
  flash('action-msg', r.ok ? 'Leader warp completed' : `Warp failed: ${r.result?.response || r.error}`, r.ok)
}
$('btn-warp-all').onclick = async () => {
  const w = $('warp-name').value.trim() || 'spawn'
  const bad = []
  for (const n of readyNames()) {
    const r = await act({ action: 'warp', actor: n, warp: w })
    if (r.error || r.ok === false) bad.push(n)
  }
  flash('action-msg', bad.length ? `Warp failed for ${bad.length}/${readyNames().length}: ${bad.join(', ')}` : `Fleet warp completed · destination ${w}`, bad.length === 0)
}

// ───────────────────────────────────────────────────────────── Learn overlay
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
  if (!tpl) return alert(`Configure ${ACTION_LABEL[action] || action} before probing the server reply.`)
  const cmd = renderTemplate(tpl, sampleVars())
  $('learn-head').textContent = `${ACTION_LABEL[action] || action} · sending ${cmd} · waiting for server reply…`
  $('learn-lines').innerHTML = '<div class="ln empty">Waiting for server response…</div>'
  $('learn-out').innerHTML = ''
  $('learn').hidden = false
  const d = await post('/api/learn', { text: cmd, windowMs: 2500 })
  if (d.error) { $('learn-head').textContent = 'Error: ' + d.error; return }
  $('learn-head').textContent =
    `${ACTION_LABEL[action] || action} · ${d.bot} sent ${cmd} · captured ${d.lines.length} repl${d.lines.length === 1 ? 'y' : 'ies'} in ${d.windowMs} ms`
  renderLearnLines(d.lines)
}

function renderLearnLines (lines) {
  const box = $('learn-lines')
  const names = S.bots.map((b) => b.name)
  box.innerHTML = ''
  if (!lines.length) {
    box.innerHTML = '<div class="ln empty">No server reply was captured in this window. The command may be silent, invalid, or unsupported in the current context.</div>'
    return
  }
  for (const l of lines) {
    const d = document.createElement('div')
    d.className = 'ln'
    d.innerHTML = `<code>${esc(l.text)}</code>
      <button class="btn ghost tiny" data-ok>Mark Success</button>
      <button class="btn ghost tiny" data-bad>Mark Failure</button>`
    const pick = async (kind) => {
      const re = toRegex(l.text, names)
      box.querySelectorAll('.ln').forEach((x) => x.style.outline = '')
      d.style.outline = '2px solid ' + (kind === 'ok' ? 'var(--ok)' : 'var(--bad)')
      $('learn-out').innerHTML =
        `<div class="sub">Response pattern for <b>${esc(ACTION_LABEL[learnAction] || learnAction)}</b> · classified as ${kind === 'ok' ? 'success' : 'failure'}. Review before saving.</div>` +
        `<textarea id="re-out" spellcheck="false">${esc(re)}</textarea>` +
        `<div class="row gap" style="justify-content:flex-start;margin-top:8px"><button class="btn primary" id="re-save">Save Response Pattern</button></div>`
      $('re-save').onclick = async () => {
        const val = $('re-out').value.trim()
        const spec = kind === 'ok' ? { success: val } : { failure: [val] }
        // Carry the template too. applyCommands skips any spec without a string template, so
        // saving a regex for a command that was not already in the config file silently did
        // nothing — the operator saw "saved" and nothing changed.
        const tpl = document.querySelector(`input[data-a="${learnAction}"]`)?.value.trim()
        if (tpl) spec.template = tpl
        const r = await post('/api/config', { commands: { [learnAction]: spec }, persist: true })
        $('learn-head').textContent = r.error ? 'Error: ' + r.error : `Saved ${kind === 'ok' ? 'success' : 'failure'} response pattern for ${ACTION_LABEL[learnAction] || learnAction}`
      }
    }
    d.querySelector('[data-ok]').onclick = () => pick('ok')
    d.querySelector('[data-bad]').onclick = () => pick('bad')
    box.appendChild(d)
  }
}
$('learn-close').onclick = () => { $('learn').hidden = true }
$('btn-contrast').onclick = () => document.body.classList.toggle('contrast')

// ───────────────────────────────────────────────────────────── SSE
function connect () {
  const es = new EventSource('/events')
  es.addEventListener('open', () => {
    $('conn').textContent = 'Live updates: Connected'; $('conn').className = 'pill on'
    botControls.setConnected(true)
  })
  es.addEventListener('error', () => {
    $('conn').textContent = 'Live updates: Reconnecting'; $('conn').className = 'pill off'
    botControls.setConnected(false)
  })

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
    botControls.update(S)
    if (!accountsDirty && S.accounts) {
      $('accounts').value = S.accounts
      const n = S.accounts.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length
      $('acc-count').textContent = `${n} account${n === 1 ? '' : 's'}`
    }
    if (!proxiesDirty) {
      const sig = JSON.stringify(S.proxy ?? {})
      if (sig !== proxySignature) renderProxyEditor()
    }
    // A run is a multi-second sequence; leaving every button live invited a second press that
    // interleaved with the first.
    const busy = !!S.running
    for (const id of ['btn-run', 'btn-join-bw-all', 'btn-party-inv-all', 'btn-join-all', 'btn-party-list', 'btn-master', 'btn-invite-master', 'btn-transfer-master',
                      'btn-disband', 'btn-leave', 'btn-party-force-autoplay', 'btn-warp', 'btn-warp-all', 'btn-connect',
                      'btn-proxy-save', 'btn-proxy-apply']) {
      const el = $(id)
      if (el) el.disabled = busy || el.dataset.pending === '1'
    }
    const runTitle = $('btn-run-title')
    if (runTitle) runTitle.textContent = busy ? 'Operation in Progress…' : 'Assemble Party'
    if (busy) { $('btn-master').disabled = true }
    const partyFleetPill = $('party-fleet-pill')
    if (partyFleetPill) {
      const r = readyNames().length
      partyFleetPill.textContent = `${r}/${S.bots.length} Operational`
      partyFleetPill.className = `pill ${r > 0 ? 'on' : 'off'}`
    }
  })

  es.addEventListener('event', (m) => {
    const e = JSON.parse(m.data)
    switch (e.topic) {
      case 'mc:chat': if (e.text) logLine('chat', `${e.bot} << ${e.text}`); break
      case 'mc:sent': logLine('sent', `${e.bot} >> ${e.text}`); break
      case 'cmd:result': logLine(e.status, `${e.bot} ${e.action}${e.vars?.player ? ' ' + e.vars.player : ''} -> ${e.status}  ${e.response || e.error || ''}`); break
      case 'bot:state': logLine('', `${e.bot}: ${e.from} -> ${e.to}`); break
      case 'auth:ok': logLine(e.via === 'not_required' ? '' : 'OK', e.via === 'not_required'
        ? `${e.bot} login not required (no auth command)` : `${e.bot} authenticated via ${e.via}`); break
      case 'auth:fail': logLine('FAILED', `${e.bot} auth failed: ${e.pattern}${e.fatal ? ' (fatal)' : ''}`); break
      case 'mc:kick': logLine('FAILED', `${e.bot} KICKED: ${e.text}`); break
      case 'mc:disconnect': logLine('FAILED', `${e.bot} disconnected: ${e.text}`); break
      case 'mc:end': logLine('FAILED', `${e.bot} connection ended: ${e.reason || 'socket closed'}` +
        (e.socket?.event ? ` (TCP ${e.socket.event}${e.socket.errorCode ? `, ${e.socket.errorCode}` : ''}${e.socket.hadError ? ', had error' : ''})` : '')); break
      case 'mc:error': logLine('FAILED', `${e.bot} connection error: ${e.error?.message || e.error || 'unknown'}`); break
      case 'mc:warn': logLine('NO_RESPONSE', `${e.bot} ${e.why}${e.text ? ' :: ' + JSON.stringify(e.text) : ''}`); break
      case 'party:full': logLine('OK', `-- party is full (${e.size}) - every bot standing down with /${e.action}`); break
      case 'bedwars:state': logLine(e.phase === 'failed' ? 'FAILED' : e.phase === 'done' ? 'OK' : '',
        `${e.bot} BedWars: ${e.phase}${e.target ? ` → ${e.target}` : ''}${e.result?.error ? ' :: ' + e.result.error : ''}`); break
      case 'autoplay:state': logLine(['blocked', 'failed'].includes(e.phase) ? 'FAILED' : '',
        `${e.bot} Autoplay: ${e.phase}${(e.task ?? e.action) ? ` · ${e.task ?? e.action}` : ''}${e.blockedReason || e.reason || e.error ? ' :: ' + (e.blockedReason || e.reason || e.error) : ''}`); break
      case 'action:lease': logLine(e.phase === 'failed' || e.phase === 'blocked' ? 'FAILED' : '',
        `${e.bot} action ${e.phase}: ${e.owner}:${e.action}${e.reason ? ' :: ' + e.reason : ''}`); break
      case 'combat:attack': logLine('OK', `${e.bot} attacked ${e.target}${Number.isFinite(e.distance) ? ` at ${e.distance.toFixed(2)} blocks` : ''}`); break
      case 'match:debug': debugLine(e); break
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
  es.addEventListener('connected', (m) => flash('connect-msg', `Fleet connected · ${m.ready}/${m.total} operational`, m.ready > 0))
}
connect()
