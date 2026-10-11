import assert from "node:assert/strict"
import { Bus } from "../src/bus.js"
import { StabilityMonitor } from "../src/behaviour/stability_monitor.js"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bus = new Bus()
let recoveries = 0
let failures = 0
const health = {
  connected: true,
  io: {
    rxPackets: 10,
    txPackets: 20,
    rxByName: {},
    txByName: {},
    lastRxAgoMs: 70000,
    lastTxAgoMs: 10,
    lastKeepAliveRxAgoMs: 70000
  },
  eventLoop: { maxMs: 0, rolling30sMaxMs: 0 }
}
const bot = {
  id: "0:stale",
  username: "stale",
  activeRoute: { kind: "proxy", proxy: { id: "p1" } },
  isReady: () => true,
  proxyManager: { reportFailure: () => { failures++ } },
  transport: { healthSnapshot: () => health }
}
const presence = { stateOf: () => ({ stage: "mode" }) }
const fleet = { bots: [bot], recoverBot: async () => { recoveries++; return true } }
const monitor = new StabilityMonitor({
  cfg: { fleet: { staleRxReconnectMs: 60000, staleRxTxRecentMs: 15000, staleRxRecoveryCooldownMs: 60000 } },
  bus,
  presence,
  log: { warn () {} }
}).attach(fleet)
monitor.sample("manual")
await sleep(0)
assert.equal(recoveries, 1)
assert.equal(failures, 1)
monitor.sample("manual")
await sleep(0)
assert.equal(recoveries, 1)
health.io.lastRxAgoMs = 5
health.io.lastTxAgoMs = 5
monitor.lastRecoveryAt.clear()
monitor.sample("manual")
await sleep(0)
assert.equal(recoveries, 1)
monitor.dispose()
console.log("stability stale-rx regression: PASS")
