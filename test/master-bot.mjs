// master-bot.mjs — stands in for the HUMAN party master.
//
// The master is a real player, not one of the fleet, so the whole point of the master flow is
// that the bots cannot act for them: the fleet invites, then WAITS, and only then transfers.
// This script is the other half of that test — it registers, watches for the invite, accepts
// it, and reports the promote/transfer it receives afterwards.
//
// Run it in the background, then trigger POST /api/run {mode:'master'} on the dashboard.

import mc from 'minecraft-protocol'
import { makeChatFlattener } from '../src/util.js'

const flattenChat = makeChatFlattener('1.8')

const HOST = process.env.MC_HOST || '127.0.0.1'
const PORT = Number(process.env.MC_PORT || 25566)
const NAME = process.env.MASTER_NAME || 'PartyMaster'
const PASS = process.env.MASTER_PASS || 'masterpass123'
const LEADER = process.env.LEADER_NAME || 'Soprano'

const t0 = Date.now()
const log = (...a) => console.log(`${String(Date.now() - t0).padStart(6)}ms`, ...a)
const c = mc.createClient({ host: HOST, port: PORT, username: NAME, version: '1.8.8', auth: 'offline' })

let registered = false
// A real player accepts EVERY invite they receive. An earlier version latched this after the
// first one, so a second invite in the same process was silently ignored and the transfer that
// followed it failed — which looked like a product bug and was not. Debounce instead, so a
// duplicated invite line within a second does not send the accept twice.
let lastAcceptAt = 0

c.on('login', () => {
  log('joined; waiting for the AuthMe prompt before registering')
  c.write('custom_payload', { channel: 'MC|Brand', data: Buffer.from([7, ...Buffer.from('mcbotctl-master', 'latin1')]) })
  c.write('settings', { locale: 'en_US', viewDistance: 4, chatFlags: 0, chatColors: true, skinParts: 0x7f })
})

c.on('chat', (p) => {
  const text = flattenChat(p.message)
  if (!text) return
  log('<<', text)
  if (!registered && /Please,\s*register/i.test(text)) {
    registered = true
    setTimeout(() => c.chat(`/register ${PASS} ${PASS}`), 200)
    return
  }
  if (!registered && /Please,\s*login/i.test(text)) {
    registered = true
    setTimeout(() => c.chat(`/login ${PASS}`), 200)
    return
  }
  // The fleet invited us — accept, the way a human would click the prompt.
  if (/invited into .+ party/i.test(text)) {
    if (Date.now() - lastAcceptAt < 1500) return          // same invite seen twice
    lastAcceptAt = Date.now()
    const who = (text.match(/invited into (\S+?)'s party/i) || [])[1] || LEADER
    // Take the command from the invite itself, the way a human reads it, instead of hardcoding
    // one. The test plugin's message is "... Go /p join Soprano to accept." - so if the plugin's
    // subcommand is ever renamed, this follows it, and a rename cannot silently break the fixture.
    const advertised = (text.match(/Go\s+(\/\S+\s+\S+)\s+to accept/i) || [])[1]
    const cmd = advertised || `/p join ${who}`
    setTimeout(() => { log('>> accept invite from', who, 'using', cmd); c.chat(cmd) }, 400)
    return
  }
  if (/new party leader is/i.test(text)) log('*** LEADERSHIP RECEIVED ***')
  if (/has been promoted/i.test(text)) log('*** PROMOTED ***')
})

c.on('kick_disconnect', (p) => log('KICKED', flattenChat(p)))
c.on('error', (e) => log('ERROR', e.message))
c.on('end', (r) => log('END', r))

// Optional: act like a human typing an in-game command, so a party change can be produced that
// the dashboard never asked for. This is how the "badge must update without an HTTP call" path
// gets tested.
const CMD = process.env.MASTER_CMD
const CMD_AT = Number(process.env.MASTER_CMD_AT_MS || 0)
if (CMD && CMD_AT) {
  setTimeout(() => { log('>> (in game)', CMD); c.chat(CMD) }, CMD_AT)
}

setTimeout(() => { log('done'); c.end(); process.exit(0) }, Number(process.env.MASTER_TTL_MS || 60000))
