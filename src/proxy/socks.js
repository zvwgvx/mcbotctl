import { lookup, resolveSrv } from 'node:dns/promises'
import { isIP } from 'node:net'
import { SocksClient } from 'socks'

function labelOf (proxy) {
  return proxy.name || `${proxy.host}:${proxy.port}`
}

export function socksConnectOptions (route, destination) {
  if (route?.kind !== 'proxy' || !route.proxy) throw new Error('a SOCKS5 proxy route is required')
  const proxy = route.proxy
  const options = {
    proxy: {
      host: proxy.host,
      port: proxy.port,
      type: 5,
      ...(proxy.username ? { userId: proxy.username } : {}),
      ...(proxy.password ? { password: proxy.password } : {})
    },
    command: 'connect',
    destination: { host: destination.host, port: destination.port }
  }
  if (Number.isFinite(destination.timeoutMs) && destination.timeoutMs > 0) options.timeout = destination.timeoutMs
  return options
}

async function minecraftDestination (destination, srvLookup, addressLookup) {
  let target = { ...destination }
  if (target.port === 25565 && !isIP(target.host) && target.host !== 'localhost') {
    try {
      const records = await srvLookup(`_minecraft._tcp.${target.host}`)
      const record = records?.[0]
      if (record?.name && Number.isInteger(record.port) && record.port > 0 && record.port <= 65535) {
        target = { ...target, host: record.name, port: record.port }
      }
    } catch {}
  }
  if (isIP(target.host) || target.host === 'localhost') return target
  const result = await addressLookup(target.host, { all: true, verbatim: false })
  const list = Array.isArray(result) ? result : [result]
  const picked = list.find((entry) => entry?.family === 4 && entry?.address) ?? list.find((entry) => entry?.address)
  if (!picked?.address) {
    const error = new Error(`DNS lookup returned no address for ${target.host}`)
    error.code = 'ENOTFOUND'
    throw error
  }
  return { ...target, host: picked.address }
}

export async function connectViaSocks (
  client,
  route,
  destination,
  createConnection = (options, callback) => SocksClient.createConnection(options, callback),
  srvLookup = resolveSrv,
  addressLookup = lookup
) {
  try {
    const target = await minecraftDestination(destination, srvLookup, addressLookup)
    if (client.__mcbotctlConnectionCancelled === true) return
    const options = socksConnectOptions(route, target)
    createConnection(options, (error, info) => {
      if (client.__mcbotctlConnectionCancelled === true) {
        try { info?.socket?.destroy?.() } catch {}
        return
      }
      if (error) {
        const wrapped = new Error(`SOCKS5 ${labelOf(route.proxy)}: ${error.message}`, { cause: error })
        if (error.code) wrapped.code = error.code
        client.emit('error', wrapped)
        return
      }
      if (!info?.socket) {
        client.emit('error', new Error(`SOCKS5 ${labelOf(route.proxy)}: proxy returned no socket`))
        return
      }
      client.setSocket(info.socket)
      if (client.__mcbotctlConnectionCancelled === true) {
        try { info.socket.destroy?.() } catch {}
        return
      }
      client.emit('connect')
    })
  } catch (error) {
    if (client.__mcbotctlConnectionCancelled === true) return
    const wrapped = new Error(`SOCKS5 ${labelOf(route.proxy)}: ${error.message}`, { cause: error })
    if (error.code) wrapped.code = error.code
    client.emit('error', wrapped)
  }
}
