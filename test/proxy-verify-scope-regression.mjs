import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProxyManager } from '../src/proxy/manager.js'

const dir = mkdtempSync(join(tmpdir(), 'mcbotctl-proxy-verify-'))
try {
  const bots = ['A0', 'A1', 'A2', 'A3']
  const manager = await ProxyManager.open({ file: join(dir, 'proxies.json'), botNames: bots })
  await manager.replace({
    mode: 'balanced',
    proxies: [
      { id: 'p1', host: '127.0.0.1', port: 1080 },
      { id: 'p2', host: '127.0.0.2', port: 1080 }
    ]
  }, bots)
  const failed = manager.routeFor('A1')
  assert.equal(failed.proxy.id, 'p2')
  assert.equal(manager.routeFor('A3').proxy.id, 'p2')
  const changed = manager.reportFailure('A1', failed, new Error('Hey A1, we need to verify your connection.'))
  assert.equal(changed, false, 'verification challenge was incorrectly treated as a proxy failure')
  assert.equal(manager.routeFor('A1').proxy.id, 'p2', 'verification challenge rotated the bot to another proxy')
  assert.equal(manager.routeFor('A3').proxy.id, 'p2')
  console.log('proxy verify scope regression: PASS')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
