import assert from 'node:assert/strict'
import { parseProxyList } from '../public/proxy-list.js'

const parsed = parseProxyList('\r\n 198.51.100.10:36108:user-a:pass-a \r\n\r\nproxy.example:1080\r\n198.51.100.11:1081:user-b:pass:with:colons\r\n')
assert.deepEqual(parsed.errors, [], 'valid proxy lines were rejected')
assert.deepEqual(parsed.proxies, [
  { host: '198.51.100.10', port: 36108, username: 'user-a', password: 'pass-a' },
  { host: 'proxy.example', port: 1080, username: '', password: '' },
  { host: '198.51.100.11', port: 1081, username: 'user-b', password: 'pass:with:colons' }
], 'list parsing changed the proxy endpoint or credentials')

const invalid = parseProxyList('proxy.example:1080:user:private-value\n\nproxy.example:70000:user:another-private-value\nproxy.example:1080:missing-password\n:1080:user:hidden\nproxy.example:0\nproxy.example:1e3\nproxy.example:1080::missing-user')
assert.deepEqual(invalid.errors.map((error) => error.line), [3, 4, 5, 6, 7, 8], 'invalid lines were accepted or reported with the wrong line number')
assert.deepEqual(invalid.proxies, [], 'a partially invalid list returned proxies that could be imported')
assert.equal(JSON.stringify(invalid.errors).includes('private-value'), false, 'an import error exposed proxy credentials')
assert.equal(JSON.stringify(invalid.errors).includes('hidden'), false, 'an import error echoed the invalid line')

assert.deepEqual(parseProxyList(' \r\n\t'), { proxies: [], errors: [] }, 'blank lines created proxy entries')
console.log('proxy list regression: PASS')
