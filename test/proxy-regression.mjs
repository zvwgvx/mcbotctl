import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bot } from '../src/bot.js'
import { Bus } from '../src/bus.js'
import { ProxyManager } from '../src/proxy/manager.js'
import { connectViaSocks, socksConnectOptions } from '../src/proxy/socks.js'
import { WebConsole } from '../src/web/server.js'

const temp = mkdtempSync(join(tmpdir(), 'mcbotctl-proxy-'))
const file = join(temp, 'proxies.json')
const bots = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']

try {
  const manager = await ProxyManager.open({ file, botNames: bots })
  assert.equal(manager.routeFor('Alpha').kind, 'direct', 'off mode stopped using the direct connection')

  await assert.rejects(
    manager.replace({
      mode: 'balanced',
      proxies: [{ id: 'bad-port', name: 'Bad', host: '127.0.0.1', port: 70000 }]
    }, bots),
    /port must be an integer from 1 to 65535/,
    'an invalid port replaced the active proxy configuration'
  )
  assert.equal(manager.routeFor('Alpha').kind, 'direct', 'a rejected update mutated the active mode')

  await manager.replace({
    mode: 'balanced',
    proxies: [
      { id: 'p1', name: 'Primary', host: '10.0.0.1', port: 1080, username: 'proxy-user', password: 'top-secret' },
      { id: 'p2', name: 'Secondary', host: '10.0.0.2', port: 1081 }
    ],
    assignments: {}
  }, bots)

  const counts = new Map()
  const firstPlan = new Map()
  for (const bot of bots) {
    const route = manager.routeFor(bot)
    assert.equal(route.kind, 'proxy')
    firstPlan.set(bot, route.proxy.id)
    counts.set(route.proxy.id, (counts.get(route.proxy.id) ?? 0) + 1)
  }
  assert.deepEqual([...counts.values()].sort(), [2, 3], 'balanced mode did not divide bots evenly')
  assert.deepEqual(bots.map((bot) => manager.routeFor(bot).proxy.id), ['p1', 'p2', 'p1', 'p2', 'p1'],
    'bot i was not assigned to enabled proxy i % k in list order')
  for (const bot of bots) {
    assert.equal(manager.routeFor(bot).proxy.id, firstPlan.get(bot), 'a reconnect changed the bot proxy')
  }

  const beforeFailover = manager.routeFor('Alpha')
  assert.equal(beforeFailover.proxy.id, 'p1')
  assert.equal(manager.reportFailure('Alpha', beforeFailover, Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), true)
  assert.equal(manager.routeFor('Alpha').proxy.id, 'p2', 'balanced routing did not move a bot off a failed proxy')
  manager.reportSuccess('Alpha', manager.routeFor('Alpha'))

  const publicState = manager.publicState(bots)
  assert.equal(publicState.proxies[0].hasPassword, true)
  assert.equal('password' in publicState.proxies[0], false, 'public state exposed the proxy password field')
  assert.equal(JSON.stringify(publicState).includes('top-secret'), false, 'public state exposed the proxy password value')

  await manager.replace({
    mode: 'balanced',
    proxies: publicState.proxies,
    assignments: publicState.assignments
  }, bots)
  assert.equal(
    manager.routeFor(bots.find((bot) => manager.routeFor(bot).proxy.id === 'p1')).proxy.password,
    'top-secret',
    'saving redacted proxy state erased the stored password'
  )
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).proxies[0].password, 'top-secret')
  const reopened = await ProxyManager.open({ file, botNames: bots })
  assert.deepEqual(bots.map((bot) => reopened.routeFor(bot).proxy.id), ['p1', 'p2', 'p1', 'p2', 'p1'],
    'restarting changed the ordered proxy distribution')

  const ordered = await ProxyManager.open({ file: join(temp, 'ordered-proxies.json'), botNames: bots })
  await ordered.replace({
    mode: 'balanced',
    proxies: [
      { id: 'first', host: '127.0.0.1', port: 1080 },
      { id: 'disabled', host: '127.0.0.2', port: 1080, enabled: false },
      { id: 'third', host: '127.0.0.3', port: 1080 }
    ]
  })
  assert.deepEqual(bots.map((bot) => ordered.routeFor(bot).proxy.id), ['first', 'third', 'first', 'third', 'first'],
    'disabled proxies participated in the modulo distribution')
  ordered.setBotNames(['Echo', 'Alpha', 'Bravo'])
  assert.deepEqual(['Echo', 'Alpha', 'Bravo'].map((bot) => ordered.routeFor(bot).proxy.id), ['first', 'third', 'first'],
    'changing roster order did not update each bot index')

  const failoverBots = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5']
  const failover = await ProxyManager.open({ file: join(temp, 'failover-proxies.json'), botNames: failoverBots })
  await failover.replace({
    mode: 'balanced',
    proxies: [
      { id: 'f1', host: '127.0.0.1', port: 1080 },
      { id: 'f2', host: '127.0.0.2', port: 1080 },
      { id: 'f3', host: '127.0.0.3', port: 1080 }
    ]
  }, failoverBots)
  const failedRoute = failover.routeFor('A1')
  assert.equal(failedRoute.proxy.id, 'f2')
  failover.reportFailure('A1', failedRoute, Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
  const a1 = failover.routeFor('A1').proxy.id
  const a4 = failover.routeFor('A4').proxy.id
  assert.notEqual(a1, 'f2', 'failed proxy remained eligible for the bot that observed the failure')
  assert.notEqual(a4, 'f2', 'global proxy health did not protect another bot assigned to the same failed proxy')
  assert.notEqual(a1, a4, 'bots from one failed proxy were not spread across the remaining healthy proxies')

  await manager.replace({
    mode: 'manual',
    proxies: publicState.proxies,
    assignments: { Alpha: 'p2' }
  }, bots)
  assert.equal(manager.routeFor('Alpha').proxy.id, 'p2')
  assert.equal(manager.routeFor('Bravo').kind, 'blocked', 'manual mode allowed an unassigned bot to connect directly')
  assert.match(manager.routeFor('Bravo').reason, /no enabled proxy assigned/i)

  await assert.rejects(
    manager.replace({
      mode: 'manual',
      proxies: publicState.proxies,
      assignments: { Alpha: 'missing' }
    }, bots),
    /unknown or disabled proxy/,
    'manual mode accepted a dangling proxy assignment'
  )

  const blockedBus = new Bus()
  const blockedBot = new Bot({
    username: 'Bravo',
    password: 'unused',
    index: 1,
    cfg: { transport: 'mineflayer', server: {} },
    bus: blockedBus,
    engine: {},
    proxyManager: manager,
    log: { info () {}, warn () {} }
  })
  let transportConnects = 0
  blockedBot.transport.connect = async () => { transportConnects++; return blockedBot.transport }
  await assert.rejects(blockedBot.start(), /no enabled proxy assigned/i)
  assert.equal(transportConnects, 0, 'an unassigned manual bot opened its transport before being blocked')
  blockedBot.dispose()

  const apiManager = await ProxyManager.open({ file: join(temp, 'api-proxies.json'), botNames: ['Alpha'] })
  const apiBus = new Bus()
  const apiBot = {
    id: '0:Alpha', username: 'Alpha', offline: false,
    transport: { connected: false }, fsm: { state: 'disconnected' },
    isReady: () => false,
    proxyStatus: () => apiManager.publicRouteFor('Alpha')
  }
  const apiFleet = {
    bots: [apiBot], leader: apiBot, size: 1,
    rejoinStatus: () => ({ enabled: false, blocked: false, cause: null, label: null, detectedAt: null })
  }
  const apiApp = {
    cfg: {
      server: { host: 'play.example', port: 25565, version: '1.8.9' },
      fleet: {}, auth: { enabled: false }, bedwars: {}, autoplay: {}, patterns: {}
    },
    cfgPath: join(temp, 'unused-config.json'),
    accountsFile: join(temp, 'missing-accounts.txt'),
    proxyManager: apiManager,
    bus: apiBus,
    engine: { list: () => [] },
    log: { info () {}, warn () {} },
    runtime: { fleet: apiFleet, tracker: { entry: () => ({ role: 'none', leader: null }) } },
    get fleet () { return this.runtime.fleet }
  }
  const web = new WebConsole({ app: apiApp, publicDir: join(temp, 'public') })
  const address = await web.start(0, '127.0.0.1')
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/proxies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'balanced',
        proxies: [{ id: 'api-p1', name: 'API Proxy', host: '127.0.0.2', port: 1080, password: 'api-secret' }],
        assignments: {},
        reconnect: false
      })
    })
    assert.equal(response.status, 200, 'proxy API did not accept valid settings')
    const payload = await response.json()
    assert.equal(payload.proxy.routes[0].proxyId, 'api-p1')
    assert.equal(JSON.stringify(payload).includes('api-secret'), false, 'proxy API returned a credential')

    const emptyResponse = await fetch(`http://127.0.0.1:${address.port}/api/proxies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    assert.equal(emptyResponse.status, 400, 'an empty proxy update silently disabled proxy routing')
    assert.equal(apiManager.routeFor('Alpha').proxy.id, 'api-p1', 'a rejected empty update mutated active routes')
  } finally {
    web.stop()
  }

  const route = {
    kind: 'proxy',
    proxy: { id: 'p3', name: 'Auth Proxy', host: 'proxy.example', port: 1080, username: 'alice', password: 'secret' }
  }
  assert.deepEqual(socksConnectOptions(route, { host: 'play.example', port: 25565, timeoutMs: 4321 }), {
    proxy: { host: 'proxy.example', port: 1080, type: 5, userId: 'alice', password: 'secret' },
    command: 'connect',
    destination: { host: 'play.example', port: 25565 },
    timeout: 4321
  })

  const successClient = new EventEmitter()
  let installedSocket = null
  let connected = false
  successClient.setSocket = (socket) => { installedSocket = socket }
  successClient.on('connect', () => { connected = true })
  const fakeSocket = { name: 'socks-socket' }
  await connectViaSocks(successClient, route, { host: 'play.example', port: 25565 }, (options, callback) => {
    assert.equal(options.destination.host, '203.0.113.10')
    callback(null, { socket: fakeSocket })
  }, async () => [], async () => [{ address: '203.0.113.10', family: 4 }])
  assert.equal(installedSocket, fakeSocket, 'successful SOCKS connection did not install its socket')
  assert.equal(connected, true, 'successful SOCKS connection did not notify minecraft-protocol')

  const failedClient = new EventEmitter()
  let emittedError = null
  failedClient.on('error', (error) => { emittedError = error })
  await connectViaSocks(failedClient, route, { host: 'play.example', port: 25565 }, (_options, callback) => {
    callback(new Error('proxy refused connection'))
  }, async () => [], async () => [{ address: '203.0.113.10', family: 4 }])
  assert.match(emittedError?.message ?? '', /Auth Proxy.*proxy refused connection/)
  assert.equal(emittedError?.message.includes('secret'), false, 'SOCKS failure leaked the proxy password')

  const cancelledClient = new EventEmitter()
  let completeSocksConnection
  let cancelledSocketInstalled = false
  let cancelledConnectEmitted = false
  let cancelledSocketDestroyed = false
  cancelledClient.setSocket = () => { cancelledSocketInstalled = true }
  cancelledClient.on('connect', () => { cancelledConnectEmitted = true })
  await connectViaSocks(cancelledClient, route, { host: 'play.example', port: 25565 }, (_options, callback) => {
    completeSocksConnection = callback
  }, async () => [], async () => [{ address: '203.0.113.10', family: 4 }])
  cancelledClient.__mcbotctlConnectionCancelled = true
  completeSocksConnection(null, { socket: { destroy: () => { cancelledSocketDestroyed = true } } })
  assert.equal(cancelledSocketDestroyed, true, 'a SOCKS socket that arrived after stop was left open')
  assert.equal(cancelledSocketInstalled, false, 'a SOCKS socket that arrived after stop was installed')
  assert.equal(cancelledConnectEmitted, false, 'a SOCKS connection completed after its bot stopped')

  console.log('proxy regression: PASS')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
