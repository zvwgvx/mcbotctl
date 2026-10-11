// Parse the entire list before changing the editor; errors never echo credentials.
export function parseProxyList (text) {
  const proxies = []
  const errors = []
  for (const [index, raw] of String(text ?? '').split(/\r\n|\n|\r/).entries()) {
    const line = raw.trim()
    if (!line) continue
    const fields = /^(\[[^\]\s]+\]|[^:\s]+):(\d+)(?::([^:]+):(.+))?$/.exec(line)
    if (!fields) {
      errors.push({ line: index + 1, message: 'Use host:port or host:port:username:password' })
      continue
    }
    const port = Number(fields[2])
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push({ line: index + 1, message: 'Port must be an integer from 1 to 65535' })
      continue
    }
    const username = (fields[3] ?? '').trim()
    if (fields[3] !== undefined && !username) {
      errors.push({ line: index + 1, message: 'Username is required when a password is provided' })
      continue
    }
    const host = fields[1].startsWith('[') ? fields[1].slice(1, -1) : fields[1]
    proxies.push({ host, port, username, password: fields[4] ?? '' })
  }
  return { proxies: errors.length ? [] : proxies, errors }
}
