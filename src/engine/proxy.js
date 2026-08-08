// SOCKS4/5 proxy support for outbound peer TCP connections.
//
// WebTorrent opens peer connections with `net.connect(opts)`. When a proxy is
// configured we patch `net.connect` so every non-loopback peer connection is
// tunnelled through the proxy (SOCKS5h semantics: the proxy resolves DNS, so the
// local IP is never leaked to the target). Loopback targets are always bypassed
// so local trackers/swarms keep working.
//
// Uses the `socks` package (already a transitive dependency of
// bittorrent-tracker, no new install).
import net from 'node:net'
import { SocksClient } from 'socks'

let origConnect = null
let current = null

const SOCKS_PROTOCOLS = new Set(['socks:', 'socks5:', 'socks5h:', 'socks4:', 'socks4a:'])

/**
 * Parse a proxy URL into SocksClient options, or null when invalid/empty.
 * @param {string} value e.g. socks5h://user:pass@127.0.0.1:9050
 */
export function parseProxy (value) {
  if (!value || typeof value !== 'string') return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (!SOCKS_PROTOCOLS.has(url.protocol)) return null
  const type = url.protocol === 'socks4:' || url.protocol === 'socks4a:' ? 4 : 5
  return {
    type,
    host: url.hostname || '127.0.0.1',
    port: url.port ? Number(url.port) : 1080,
    userId: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined
  }
}

export function isProxyEnabled () {
  return current !== null
}

export function proxyInfo () {
  return current
}

/**
 * Patch `net.connect` to route peer traffic through the proxy.
 * @param {string} value proxy URL
 */
export function enableProxy (value) {
  const p = parseProxy(value)
  if (!p) throw new Error(`Invalid SOCKS proxy URL: ${value}`)
  if (current) disableProxy()
  origConnect = net.connect
  current = p
  net.connect = patchedConnect
  return p
}

/** Restore the original `net.connect`. */
export function disableProxy () {
  if (!current) return
  if (origConnect) {
    net.connect = origConnect
    origConnect = null
  }
  current = null
}

function isLoopback (host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function normalizeArgs (args) {
  const options = {}
  let cb
  if (typeof args[0] === 'object' && args[0] !== null) {
    Object.assign(options, args[0])
    if (typeof args[1] === 'function') cb = args[1]
  } else {
    options.port = args[0]
    if (typeof args[1] === 'string' || typeof args[1] === 'object') options.host = args[1]
    if (typeof args[1] === 'function') cb = args[1]
    if (typeof args[2] === 'function') cb = args[2]
  }
  return { options, cb }
}

function patchedConnect (...args) {
  const { options, cb } = normalizeArgs(args)
  const targetHost = String(options.host || 'localhost').replace(/^\[|\]$/g, '')
  const targetPort = Number(options.port)

  if (!current || isLoopback(targetHost)) {
    return origConnect(options, cb)
  }

  const proxy = current
  const timeout = options.timeout || 30_000
  const facade = new net.Socket()

  // Shadow getter-only properties (connecting/readyState/destroyed/addresses)
  // with writable own properties so callers like simple-peer can inspect them.
  const shadow = (name, value) => {
    Object.defineProperty(facade, name, { value, writable: true, configurable: true })
  }
  shadow('connecting', true)
  shadow('destroyed', false)

  SocksClient.createConnection({
    proxy: {
      host: proxy.host,
      port: proxy.port,
      type: proxy.type,
      userId: proxy.userId,
      password: proxy.password
    },
    command: 'connect',
    destination: { host: targetHost, port: targetPort },
    timeout
  }).then(({ socket }) => {
    const real = socket
    shadow('connecting', false)
    shadow('readyState', 'open')
    shadow('remoteAddress', real.remoteAddress)
    shadow('remotePort', real.remotePort)
    shadow('localAddress', real.localAddress)
    shadow('localPort', real.localPort)

    facade.write = (data, enc, fcb) => {
      if (typeof enc === 'function') { fcb = enc; enc = 'utf8' }
      return real.write(data, enc, fcb)
    }
    facade.end = (...x) => real.end(...x)
    facade.destroy = (...x) => {
      shadow('destroyed', true)
      real.destroy(...x)
    }
    facade.destroySoon = (...x) => real.destroySoon?.(...x)
    facade.setNoDelay = (v) => real.setNoDelay(v)
    facade.setKeepAlive = (a, b) => real.setKeepAlive(a, b)
    facade.setTimeout = (ms, fn) => real.setTimeout(ms, fn)
    facade.pause = () => real.pause()
    facade.resume = () => real.resume()
    facade.ref = () => real.ref()
    facade.unref = () => real.unref()
    facade.address = () => real.address()

    real.on('data', chunk => {
      if (!facade.destroyed) facade.emit('data', chunk)
    })
    real.on('end', () => facade.emit('end'))
    real.on('close', hadErr => {
      shadow('destroyed', true)
      facade.emit('close', hadErr)
    })
    real.on('error', err => facade.emit('error', err))

    if (cb) cb(null)
    facade.emit('connect')
  }).catch(err => {
    shadow('connecting', false)
    facade.emit('error', err)
    if (cb) cb(err)
    facade.emit('close')
  })

  return facade
}
