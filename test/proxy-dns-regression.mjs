import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { connectViaSocks } from '../src/proxy/socks.js'

const route = { kind: 'proxy', proxy: { name: 'Test Proxy', host: '127.0.0.1', port: 1080 } }

async function destinationUsed (destination, srvLookup, addressLookup = async (host) => [{ address: host === 'minecraft-backend.example' ? '203.0.113.90' : '203.0.113.91', family: 4 }]) {
  const client = new EventEmitter()
  client.setSocket = () => {}
  let requestedDestination
  let failure
  client.on('error', error => { failure = error })
  await connectViaSocks(client, route, destination, (options, callback) => {
    requestedDestination = options.destination
    callback(null, { socket: {} })
  }, srvLookup, addressLookup)
  assert.equal(failure, undefined, 'DNS resolution prevented the SOCKS connection from starting')
  return requestedDestination
}

const original = { host: 'srv-only.example', port: 25565 }
const srvDestination = await destinationUsed(original, async name => {
  assert.equal(name, '_minecraft._tcp.srv-only.example')
  return [{ name: 'minecraft-backend.example', port: 25590, priority: 0, weight: 5 }]
})
assert.deepEqual(srvDestination, { host: '203.0.113.90', port: 25590 }, 'an SRV target was not resolved locally before SOCKS connect')
assert.deepEqual(original, { host: 'srv-only.example', port: 25565 }, 'SRV lookup changed the configured address used for the Minecraft handshake')

for (const destination of [
  { host: 'explicit-port.example', port: 25570 },
  { host: '127.0.0.1', port: 25565 },
  { host: '::1', port: 25565 },
  { host: 'localhost', port: 25565 }
]) {
  let lookedUp = false
  const actual = await destinationUsed(destination, async () => { lookedUp = true; return [] })
  assert.equal(lookedUp, false, 'SRV lookup replaced an IP, localhost, or explicit server port')
  if (destination.host === 'explicit-port.example') assert.deepEqual(actual, { ...destination, host: '203.0.113.91' })
  else assert.deepEqual(actual, destination)
}

assert.deepEqual(await destinationUsed({ host: 'no-srv.example', port: 25565 }, async () => {
  throw Object.assign(new Error('no SRV record'), { code: 'ENODATA' })
}), { host: '203.0.113.91', port: 25565 }, 'a missing SRV record blocked local DNS fallback')

assert.deepEqual(await destinationUsed({ host: 'empty-srv.example', port: 25565 }, async () => []),
  { host: '203.0.113.91', port: 25565 }, 'an empty SRV response blocked local DNS fallback')

let completeLookup
let openedSocket = false
const cancelled = new EventEmitter()
cancelled.setSocket = () => {}
const pending = connectViaSocks(cancelled, route, { host: 'slow-srv.example', port: 25565 }, () => { openedSocket = true },
  () => new Promise(resolve => { completeLookup = resolve }),
  async () => [{ address: '203.0.113.92', family: 4 }])
cancelled.__mcbotctlConnectionCancelled = true
completeLookup?.([{ name: 'late-backend.example', port: 25565 }])
await pending
assert.equal(openedSocket, false, 'a bot stopped during DNS lookup still opened a SOCKS connection')

console.log('proxy DNS regression: PASS')
