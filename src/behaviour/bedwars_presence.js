// bedwars_presence.js — what the server has actually shown each bot about BedWars.
//
// A completed selector click is only an attempted action. The sidebar and optional server
// messages are positive evidence that the bot reached the BedWars area or a match. With no
// such evidence we report "unconfirmed" instead of claiming that the click succeeded.

import { EV } from '../bus.js'
import { stripLegacy } from '../util.js'

const DEFAULT_TITLE = /\bbed[\s_-]*wars?\b/i
const DEFAULT_TEAM = /^(?:(?:[RGBYAWP]\s+)?(?:red|blue|green|yellow|aqua|white|pink|gr[ae]y)\s*[:|\-]\s*(?:✔|✓|✘|✗|x|\d+|alive|dead|bed|destroyed)|(?:✔|✓|✘|✗|x|\d+)\s+(?:red|blue|green|yellow|aqua|white|pink|gr[ae]y)(?:\s*[:|\-]?\s*(?:✔|✓|✘|✗|x|\d+|alive|dead|bed|destroyed))?(?:\s+\(You\))?)$/i

function compile (source, fallback = null) {
  if (!source) return fallback
  try { return new RegExp(String(source), 'i') } catch { return fallback }
}

export class BedWarsPresence {
  constructor ({ cfg, bus }) {
    this.cfg = cfg
    this.bus = bus
    this.states = new Map()
    this.ids = new Set()
    this.bots = new Map()
    this.hiddenTimers = new Map()
    this.subs = []
    this.#sub(EV.MC_JOIN, (e) => {
      if (!this.ids.has(e.botId)) return
      this.#clearHidden(e.botId)
      this.#set(e.botId, { joined: null, stage: null, source: null, detail: null })
      // The first objective can arrive before Mineflayer's spawn event. The transport starts
      // forwarding changes after spawn, so read the already populated sidebar once here.
      const sidebar = this.bots.get(e.botId)?.transport?.mc?.scoreboard?.sidebar
      if (sidebar) this.#onScoreboard({
        botId: e.botId, visible: true, title: sidebar.title,
        lines: sidebar.items?.map((item) => String(item.displayName ?? item.name)) ?? []
      })
    })
    this.#sub(EV.BOT_STATE, (e) => {
      if (this.ids.has(e.botId) && (e.to === 'DEAD' || e.to === 'DISCONNECTED')) {
        this.#clearHidden(e.botId)
        this.#set(e.botId, { joined: false, stage: null, source: 'disconnect', detail: null })
      }
    })
    this.#sub(EV.MC_SCOREBOARD, (e) => this.#onScoreboard(e))
    this.#sub(EV.MC_CHAT, (e) => this.#onChat(e))
  }

  #sub (topic, fn) { this.subs.push(this.bus.on(topic, fn)) }

  attach (fleet) {
    for (const bot of fleet.bots) { this.ids.add(bot.id); this.bots.set(bot.id, bot) }
    return this
  }

  dispose () {
    for (const timer of this.hiddenTimers.values()) clearTimeout(timer)
    this.hiddenTimers.clear()
    for (const off of this.subs) { try { off() } catch {} }
    this.subs = []
    this.states.clear()
    this.ids.clear()
    this.bots.clear()
  }

  stateOf (botId) {
    return this.states.get(botId) ?? { joined: null, stage: null, source: null, detail: null }
  }

  #set (botId, next) {
    const prev = this.stateOf(botId)
    if (prev.joined === next.joined && prev.stage === next.stage && prev.source === next.source && prev.detail === next.detail) return
    this.states.set(botId, next)
    this.bus.emit('bedwars:presence', { botId, ...next })
  }

  #confirmed (stage, source) {
    return {
      joined: stage === 'match' || this.cfg.bedwars?.presence?.requireMatch !== true ? true : null,
      stage,
      source,
      detail: stage === 'match' ? 'In BedWars match' : 'In BedWars lobby'
    }
  }

  #clearHidden (botId) {
    clearTimeout(this.hiddenTimers.get(botId))
    this.hiddenTimers.delete(botId)
  }

  #onScoreboard (e) {
    if (!this.ids.has(e.botId)) return
    if (!e.visible) {
      if (this.stateOf(e.botId).source !== 'sidebar' || this.hiddenTimers.has(e.botId)) return
      // Objective replacement can hide the sidebar for a moment. After a sustained absence,
      // the old positive evidence is stale and the UI must go back to unconfirmed.
      const timer = setTimeout(() => {
        this.hiddenTimers.delete(e.botId)
        if (this.stateOf(e.botId).source === 'sidebar') {
          this.#set(e.botId, { joined: null, stage: null, source: null, detail: null })
        }
      }, this.cfg.bedwars?.presence?.missingSidebarGraceMs ?? 5000)
      timer.unref?.()
      this.hiddenTimers.set(e.botId, timer)
      return
    }
    this.#clearHidden(e.botId)
    const title = stripLegacy(e.title ?? '').trim()
    const pattern = compile(this.cfg.bedwars?.presence?.titlePattern, DEFAULT_TITLE)
    if (!pattern.test(title)) {
      // A different visible sidebar usually means the server transferred the bot away. A
      // temporarily hidden sidebar is ignored above, since matches replace objectives briefly.
      if (this.stateOf(e.botId).source === 'sidebar') {
        this.#set(e.botId, { joined: null, stage: null, source: null, detail: null })
      }
      return
    }
    const teamPattern = compile(this.cfg.bedwars?.presence?.teamLinePattern, DEFAULT_TEAM)
    const teamLines = (e.lines ?? []).filter((line) => teamPattern.test(stripLegacy(line).trim())).length
    const stage = teamLines >= 2 ? 'match' : 'mode'
    this.#set(e.botId, this.#confirmed(stage, 'sidebar'))
  }

  #onChat (e) {
    if (!this.ids.has(e.botId) || !e.text) return
    const text = stripLegacy(e.text)
    const presence = this.cfg.bedwars?.presence ?? {}
    const leave = compile(presence.leaveMessage)
    if (leave?.test(text)) {
      this.#set(e.botId, { joined: false, stage: null, source: 'chat', detail: null })
      return
    }
    const match = compile(presence.matchMessage)
    const startMessage = String(this.cfg.bedwars?.startMessage ?? '').trim()
    if (match?.test(text) || (!presence.matchMessage && startMessage && text.toLowerCase().includes(startMessage.toLowerCase()))) {
      this.#set(e.botId, this.#confirmed('match', 'chat'))
      return
    }
    const join = compile(presence.joinMessage)
    if (join?.test(text)) this.#set(e.botId, this.#confirmed('mode', 'chat'))
  }
}
