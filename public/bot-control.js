// Direct command controls share the dashboard's existing paced, per-bot capture API.
const sameName = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase()
const inParty = (bot) => bot.progress?.partyJoined !== false &&
  bot.party?.confirmedAbsent !== true && ['leader', 'member'].includes(bot.party?.role)

export function resolveMasterControl (state) {
  const bots = state.bots ?? []
  const configured = String(state.master ?? '').trim()
  const master = bots.find((bot) => sameName(bot.name, configured))
  // An invitation alone is not membership. Switch only after the tracker confirms the join.
  if (master && inParty(master)) return { name: master.name, bot: master, kind: 'master', configured }

  const leaders = bots.filter((bot) => inParty(bot) && bot.party.role === 'leader')
  const leader = leaders.find((bot) => bot.ready) ?? leaders[0]
  if (leader) return { name: leader.name, bot: leader, kind: 'temporary', configured }

  // Membership also identifies an owner outside our roster. Do not send as a different bot
  // when the real party owner is an account this process does not control.
  const member = bots.find((bot) => bot.ready && inParty(bot) && bot.party.leader) ??
    bots.find((bot) => inParty(bot) && bot.party.leader)
  if (member) {
    const bot = bots.find((candidate) => sameName(candidate.name, member.party.leader))
    return {
      name: bot?.name ?? member.party.leader, bot: bot ?? null,
      kind: sameName(member.party.leader, configured) ? 'master' : 'temporary', configured
    }
  }
  return { name: null, bot: null, kind: 'waiting', configured }
}

export function mountBotControls ({ document, post }) {
  const $ = (id) => document.getElementById(id)
  const panels = ['master', 'individual'].map((kind) => ({
    kind,
    form: $(`control-${kind}-form`),
    input: $(`control-${kind}-command`),
    button: $(`control-${kind}-send`),
    status: $(`control-${kind}-status`),
    log: $(`control-${kind}-log`),
    clear: $(`control-${kind}-clear`)
  }))
  const picker = $('control-bot')
  const leaveAllButton = $('control-leave-all')
  const leaveAllStatus = $('control-leave-all-status')
  const leaveAllResults = $('control-leave-all-results')
  const leaveAllList = $('control-leave-all-list')
  const histories = new Map()
  const pending = new Set()
  let state = { bots: [], master: '' }
  let master = resolveMasterControl(state)
  let connected = false
  let freshState = false
  let rosterSignature = ''
  let leavingAll = false
  let leaveBatch = null

  const readyBots = () => state.bots.filter((bot) => bot.ready && bot.protocol === 'play')

  const targetFor = (panel) => panel.kind === 'master' ? master.bot :
    state.bots.find((bot) => bot.name === picker.value)

  function unavailable (bot) {
    if (!connected || !freshState) return 'Waiting for live fleet status…'
    if (!bot) return 'No controlled bot selected.'
    if (!bot.ready || bot.protocol !== 'play') return `${bot.name} is offline or not ready to receive commands.`
    if (state.running) return 'Wait for the current fleet operation to finish.'
    if (leavingAll) return 'Sending /leave to the fleet…'
    if (pending.has(bot.name)) return `Waiting for ${bot.name} to reply…`
    return ''
  }

  function renderLog (panel) {
    const bot = targetFor(panel)
    const records = histories.get(bot?.name) ?? []
    panel.clear.disabled = !records.length || pending.has(bot?.name)
    const signature = JSON.stringify([bot?.name, records])
    if (signature === panel.logSignature) return
    const changedBot = panel.logBot !== bot?.name
    panel.logSignature = signature
    panel.logBot = bot?.name
    const scrollTop = panel.log.scrollTop
    const stickToBottom = panel.log.scrollHeight - panel.log.scrollTop - panel.log.clientHeight < 48
    panel.log.replaceChildren()
    if (!records.length) {
      const empty = document.createElement('p')
      empty.className = 'control-empty'
      empty.textContent = bot ? `Commands and replies from ${bot.name} will appear here.` : 'Select a bot to view its command responses.'
      panel.log.appendChild(empty)
    }
    for (const record of records) {
      const group = document.createElement('div')
      group.className = 'control-record'
      const heading = document.createElement('div')
      heading.className = 'control-command'
      const time = document.createElement('span')
      time.className = 'control-time'
      time.textContent = new Date(record.at).toLocaleTimeString('en-GB', { hour12: false })
      const command = document.createElement('span')
      command.textContent = `${record.bot} > ${record.command}`
      heading.append(time, command)
      const outcome = document.createElement('div')
      outcome.className = `control-outcome${record.error ? ' is-error' : ''}`
      outcome.textContent = record.status
      group.append(heading, outcome)
      for (const line of record.lines) {
        const reply = document.createElement('div')
        reply.className = 'control-reply'
        reply.textContent = line.text
        group.appendChild(reply)
      }
      panel.log.appendChild(group)
    }
    panel.log.scrollTop = changedBot || stickToBottom ? panel.log.scrollHeight : scrollTop
  }

  function render () {
    master = resolveMasterControl(state)
    $('control-master-name').textContent = master.name ?? 'Waiting for party leader'
    $('control-master-role').textContent = master.kind === 'master' ? 'Botmaster' :
      master.kind === 'temporary' ? 'Temporary master · Party leader' : 'No confirmed leader'
    const registered = state.bots.some((bot) => sameName(bot.name, master.configured))
    $('control-master-note').textContent = master.name && !master.bot
      ? `${master.name} leads the party but is not in Accounts. Add this account and connect it to send commands from it.`
      : master.kind === 'master'
        ? `${master.name} has joined the party and is now the master control target.`
        : master.kind === 'temporary'
          ? `${master.name} is the current party leader${master.configured ? ` until ${master.configured} joins` : ''}.` +
            (master.configured && !registered ? ` Add ${master.configured} to Accounts to control it after it joins.` : '')
          : 'Form a party or refresh the party list to identify its leader. You can still control individual bots below.'
    const leaveReason = !connected || !freshState ? 'Waiting for live fleet status…' :
      state.running ? 'Wait for the current fleet operation to finish.' :
        leavingAll ? 'Sending /leave to the fleet…' :
          pending.size ? 'Wait for the current bot command to finish.' :
            !readyBots().length ? 'No bot is ready to receive /leave. Connect the fleet first.' : ''
    leaveAllButton.disabled = !!leaveReason
    leaveAllButton.title = leaveReason || 'Send /leave to every ready bot, including the master.'
    leaveAllButton.textContent = leavingAll ? 'Sending /leave…' : 'Leave all · /leave'
    leaveAllStatus.textContent = leavingAll ? `Sending /leave to ${leaveBatch.total} bot(s)…` :
      leaveBatch ? `Sent /leave: ${leaveBatch.sent}/${leaveBatch.total} · Not confirmed: ${leaveBatch.failed} · Offline or not ready: ${leaveBatch.skipped}` :
        leaveReason || `Ready to send /leave to ${readyBots().length}/${state.bots.length} bot(s).`
    leaveAllStatus.classList.toggle('is-error', !leavingAll && !!leaveBatch?.failed)
    for (const panel of panels) {
      const bot = targetFor(panel)
      const reason = unavailable(bot)
      panel.status.textContent = reason || `Ready · Commands go only to ${bot.name}.`
      panel.status.className = `sub control-status${bot && !bot.ready ? ' is-error' : ''}`
      panel.input.disabled = !!reason
      panel.button.disabled = !!reason || !panel.input.value.trim()
      panel.button.textContent = pending.has(bot?.name) ? 'Waiting…' : 'Send command'
      renderLog(panel)
    }
  }

  async function sendCommand (bot, command) {
    const record = {
      bot: bot.name, command, at: Date.now(), lines: [], sent: false,
      status: 'Sending command and capturing replies…', error: false
    }
    const history = histories.get(bot.name) ?? []
    history.push(record)
    if (history.length > 30) history.shift()
    histories.set(bot.name, history)
    pending.add(bot.name)
    render()
    try {
      const response = await post('/api/learn', { bot: bot.name, text: command, windowMs: 2500 })
      if (response.error) throw new Error(response.error)
      if (response.bot !== bot.name || response.command !== command) throw new Error('Unexpected command response. Check Diagnostics before sending again.')
      record.lines = Array.isArray(response.lines) ? response.lines : []
      record.sent = response.sent === true
      if (!record.sent) {
        record.error = true
        record.status = 'Command was not sent. Check the bot connection.'
      } else {
        record.status = record.lines.length ? `Sent · ${record.lines.length} reply line(s)` : 'Sent · No reply captured. Check Diagnostics for later messages.'
      }
    } catch (error) {
      record.error = true
      record.status = error.message
    } finally {
      pending.delete(bot.name)
      render()
    }
    return record
  }

  leaveAllButton.addEventListener('click', async () => {
    if (!connected || !freshState || state.running || leavingAll || pending.size) return
    // Take one roster snapshot: bots added or connected during this click belong to the next
    // operation. Each target uses the same paced command path and separate response history.
    const targets = readyBots()
    if (!targets.length) return
    leaveBatch = { total: targets.length, skipped: state.bots.length - targets.length, sent: 0, failed: 0 }
    leavingAll = true
    leaveAllResults.hidden = true
    leaveAllList.replaceChildren()
    render()
    try {
      const records = await Promise.all(targets.map((bot) => sendCommand(bot, '/leave')))
      leaveBatch.sent = records.filter((record) => record.sent).length
      leaveBatch.failed = records.length - leaveBatch.sent
      for (const record of records) {
        const result = document.createElement('div')
        result.className = `control-fleet-result${record.error ? ' is-error' : ''}`
        result.textContent = `${record.bot}: ${record.status}`
        leaveAllList.appendChild(result)
        for (const line of record.lines) {
          const reply = document.createElement('div')
          reply.className = 'control-reply'
          reply.textContent = line.text
          leaveAllList.appendChild(reply)
        }
      }
      leaveAllResults.hidden = false
    } finally {
      leavingAll = false
      render()
    }
  })

  for (const panel of panels) {
    panel.input.addEventListener('input', () => {
      panel.input.setCustomValidity('')
      panel.button.disabled = !!unavailable(targetFor(panel)) || !panel.input.value.trim()
    })
    panel.form.addEventListener('submit', async (event) => {
      event.preventDefault()
      // Resolve at the click, then retain this exact bot throughout the request. A leader
      // transfer or picker change during capture must never mix two bots' command histories.
      const bot = targetFor(panel)
      if (unavailable(bot)) return render()
      const command = panel.input.value.trim()
      if (!command || !command.startsWith('/') || /[\r\n\0]/.test(command)) {
        panel.input.setCustomValidity('Enter one Minecraft command starting with /, for example /bedwars-2.')
        panel.input.reportValidity()
        return
      }
      panel.input.setCustomValidity('')
      await sendCommand(bot, command)
    })
    panel.clear.addEventListener('click', () => {
      const bot = targetFor(panel)
      if (bot && !pending.has(bot.name)) histories.delete(bot.name)
      render()
    })
  }
  picker.addEventListener('change', render)

  render()
  return {
    update (next) {
      state = next
      freshState = connected
      const signature = JSON.stringify(state.bots.map((bot) => [bot.name, bot.ready]))
      if (signature !== rosterSignature) {
        rosterSignature = signature
        const selected = picker.value
        picker.replaceChildren()
        for (const bot of state.bots) {
          const option = document.createElement('option')
          option.value = bot.name
          option.textContent = `${bot.name} · ${bot.ready ? 'READY' : 'Offline'}`
          picker.appendChild(option)
        }
        picker.value = state.bots.some((bot) => bot.name === selected) ? selected :
          (state.bots.find((bot) => bot.ready) ?? state.bots[0])?.name ?? ''
        picker.disabled = !state.bots.length
      }
      render()
    },
    setConnected (value) {
      connected = value
      if (!value) freshState = false
      render()
    },
    selectBot (name) {
      if (state.bots.some((bot) => bot.name === name)) picker.value = name
      render()
      panels[1].input.focus()
    }
  }
}
