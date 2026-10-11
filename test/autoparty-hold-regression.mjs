import assert from 'node:assert/strict'
import { AutoPartyBehaviour } from '../src/behaviour/autoparty.js'
import { Bus, EV } from '../src/bus.js'

const bus = new Bus()
let blocked = false
const cfg = {
  fleet: {
    progressiveParty: true,
    partyRetrySweepMs: 60000
  }
}
const autoparty = new AutoPartyBehaviour({
  cfg,
  bus,
  engine: { get () { return null } },
  log: { info () {}, warn () {} }
})

const leader = { id: '0:one', username: 'one', isReady: () => true }
const fleet = {
  bots: [leader],
  leader,
  rejoinStatus: () => blocked
    ? { blocked: true, cause: 'connection_verification', label: 'verification hold' }
    : { blocked: false, cause: null, label: null }
}

autoparty.attach(fleet)
const waiting = autoparty.waitForFull()
setTimeout(() => {
  blocked = true
  bus.emit(EV.FLEET_PHASE, { phase: 'rejoin_blocked', cause: 'connection_verification' })
}, 10)

await assert.rejects(
  waiting,
  (error) => error?.kind === 'blocked' && error?.cause === 'connection_verification'
)

autoparty.dispose()
console.log('autoparty hold regression: PASS')
