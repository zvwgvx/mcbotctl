import { PATTERNS } from '../patterns.js'

export class MasterCommandsBehaviour {
  constructor ({ cfg, bus, tracker, presence, autoplay = null, log = console }) {
    this.cfg = cfg
    this.bus = bus
    this.tracker = tracker
    this.presence = presence
    this.autoplay = autoplay
    this.log = log
    this.fleet = null
    this.subs = []
    this.recent = new Map()
    this.busy = false
  }

  attach (fleet) {
    this.fleet = fleet
    this.#sub('mc:chat', (e) => this.#onChat(e))
    return this
  }

  dispose () {
    for (const off of this.subs) { try { off() } catch {} }
    this.subs = []
    this.recent.clear()
    return this
  }

  #sub (topic, fn) {
    this.subs.push(this.bus.on(topic, fn))
  }

  #pattern () {
    try { return new RegExp(PATTERNS.partyChat.re) } catch { return null }
  }

  #onChat (e) {
    const master = String(this.cfg.fleet?.master ?? '').trim()
    if (!master || !e.text) return
    const re = this.#pattern()
    const m = re?.exec(e.text)
    if (!m) return
    const speaker = String(m.groups?.speaker ?? '').trim()
    const message = String(m.groups?.message ?? '').trim()
    const prefix = String(this.cfg.fleet?.masterCommandPrefix ?? '=')
    if (!prefix || speaker.toLowerCase() !== master.toLowerCase() || !message.startsWith(prefix)) return

    const now = Date.now()
    const key = `${speaker.toLowerCase()}\0${message}`
    const last = this.recent.get(key) ?? 0
    if (now - last < 1500) return
    this.recent.set(key, now)
    for (const [k, at] of this.recent) if (now - at > 10000) this.recent.delete(k)

    const [name, ...args] = message.slice(prefix.length).trim().split(/\s+/)
    if (!name || this.busy) return
    this.busy = true
    this.#execute(name.toLowerCase(), args)
      .catch((error) => this.log.warn?.(`[master] =${name} failed: ${error.message}`))
      .finally(() => { this.busy = false })
  }

  async #execute (name, args) {
    if (name === 'leave') return this.#leaveMatch()
    if (name === 'promote') return this.#promoteMaster()
    if (name === 'list' || name === 'partylist') return this.#partyList()
    if (name === 'play') return this.#play(args, { defaultForce: false })
    if (name === 'autoplay') return this.#play(args, { defaultForce: true })
    this.log.warn?.(`[master] ignored unknown command =${name}`)
    return null
  }

  async #play (args, { defaultForce = false } = {}) {
    const request = this.#parsePlay(args, defaultForce)
    if (!request) {
      this.log.warn?.('[master] autoplay command usage: =autoplay [all|<exact botName>] | =autoplay stop [<exact botName>] | =play [all|<botName>] [force]')
      return null
    }

    const method = request.stop ? 'requestStop' : 'requestStart'
    if (typeof this.autoplay?.[method] !== 'function') {
      this.log.warn?.('[master] autoplay ignored: autoplay engine is unavailable')
      return null
    }

    const bots = this.fleet?.bots ?? []
    const targets = request.target
      ? bots.filter((bot) => String(bot.username ?? '').toLowerCase() === request.target.toLowerCase())
      : bots
    if (!targets.length) {
      const detail = request.target ? `bot ${request.target} is not in this fleet` : 'fleet has no bots'
      this.log.warn?.(`[master] autoplay ignored: ${detail}`)
      return []
    }

    const action = request.stop ? 'stop and disarm' : (request.force ? 'force start' : 'arm')
    const targetLabel = request.target ?? 'all'
    const cmdLabel = request.force ? '=autoplay' : '=play'
    this.log.info?.(`[master] ${cmdLabel} ${request.stop ? 'stop ' : ''}${targetLabel} -> ${action} for ${targets.length} bot(s)`)

    const results = []
    for (const bot of targets) {
      try {
        const response = await this.autoplay[method](bot, {
          source: 'master-command',
          ...(request.stop ? { disarm: true } : { arm: true, force: request.force })
        })
        const result = response && typeof response === 'object'
          ? response
          : { ok: false, error: 'invalid autoplay response' }
        results.push({ ...result, bot: bot.username })
        if (result?.ok) {
          this.log.info?.(`[master] autoplay ${bot.username}: accepted${result.phase ? ` (${result.phase})` : ''}`)
        } else {
          this.log.warn?.(`[master] autoplay ${bot.username}: rejected${result?.error ? ` (${result.error})` : ''}`)
        }
      } catch (error) {
        results.push({ bot: bot.username, ok: false, error: error.message })
        this.log.warn?.(`[master] autoplay ${bot.username}: failed (${error.message})`)
      }
    }

    const accepted = results.filter((result) => result.ok).length
    this.log.info?.(`[master] ${cmdLabel} ${targetLabel}: ${accepted}/${targets.length} request(s) accepted`)
    return results
  }

  #parsePlay (args, defaultForce = false) {
    const parts = args.map((value) => String(value ?? '').trim()).filter(Boolean)
    if (!parts.length) return { stop: false, target: null, force: defaultForce }

    const first = parts[0].toLowerCase()
    if (first === 'stop') {
      if (parts.length === 1) return { stop: true, target: null, force: false }
      if (parts.length === 2) return { stop: true, target: parts[1], force: false }
      return null
    }
    if (first === 'force') {
      if (parts.length === 1) return { stop: false, target: null, force: true }
      if (parts.length === 2) return { stop: false, target: parts[1], force: true }
      return null
    }
    if (parts.length === 1) {
      return { stop: false, target: first === 'all' ? null : parts[0], force: defaultForce }
    }
    if (parts.length === 2 && parts[1].toLowerCase() === 'force') {
      return { stop: false, target: first === 'all' ? null : parts[0], force: true }
    }
    return null
  }

  async #leaveMatch () {
    const targets = (this.fleet?.bots ?? []).filter((bot) => bot.isReady() && this.presence?.stateOf(bot.id)?.stage === 'match')
    if (!targets.length) {
      this.log.info?.('[master] =leave ignored: no bot is in a BedWars match')
      return []
    }
    this.log.info?.(`[master] =leave -> ${targets.length} bot(s)`)
    return Promise.all(targets.map((bot) => this.#leaveOne(bot)))
  }

  async #leaveOne (bot) {
    await bot.engine?.pace?.(bot)
    const sent = bot.send('/leave')
    if (!sent) {
      bot.engine?.refund?.(bot)
      return { bot: bot.username, ok: false, error: 'write refused' }
    }

    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      if (!bot.isReady()) return { bot: bot.username, ok: true, state: 'disconnected' }
      if (this.presence?.stateOf(bot.id)?.stage !== 'match') return { bot: bot.username, ok: true, state: 'left-match' }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    this.log.warn?.(`[master] ${bot.username} /leave sent but match exit was not confirmed`)
    return { bot: bot.username, ok: false, error: 'match exit not confirmed' }
  }

  async #promoteMaster () {
    const master = String(this.cfg.fleet?.master ?? '').trim()
    if (!master) return null

    const bots = this.fleet?.bots ?? []
    const leader = bots.find((bot) => this.tracker.entry(bot.username).role === 'leader')
    if (!leader) {
      const knownMasterLeader = bots.some((bot) => String(this.tracker.entry(bot.username).leader ?? '').toLowerCase() === master.toLowerCase())
      if (knownMasterLeader) {
        this.log.info?.(`[master] =promote ignored: ${master} is already party leader`)
        return null
      }
      this.log.warn?.('[master] =promote ignored: bot party leader is not known')
      return null
    }

    if (leader.username.toLowerCase() === master.toLowerCase()) return null
    this.log.info?.(`[master] =promote -> ${leader.username} promotes ${master}`)
    return leader.run('promote', { player: master })
  }

  async #partyList () {
    const bots = this.fleet?.bots ?? []
    const leader = bots.find((bot) => this.tracker.entry(bot.username).role === 'leader')
      ?? bots.find((bot) => bot.isReady() && this.tracker.entry(bot.username).role !== 'none')
    if (!leader) {
      this.log.warn?.('[master] =list ignored: no bot has confirmed party membership')
      return null
    }
    this.log.info?.(`[master] =list -> ${leader.username} /party list`)
    return leader.run('partyList', {})
  }
}
