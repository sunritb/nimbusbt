import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { enableProxy, disableProxy, parseProxy, isProxyEnabled } from '../../src/engine/proxy.js'

let echoServer
let socksServer
function startEcho () {
  return new Promise(resolve => {
    echoServer = net.createServer(sock => {
      sock.on('data', d => sock.write(d))
    })
    echoServer.listen(0, '127.0.0.1', () => resolve(echoServer.address().port))
  })
}

function startSocks (targetPort) {
  return new Promise(resolve => {
    socksServer = net.createServer(sock => {
      let buf = Buffer.alloc(0)
      const read = chunk => {
        buf = Buffer.concat([buf, chunk])
        if (buf.length >= 2 && !sock.socksGreeted) {
          const nmethods = buf[1]
          if (buf.length < 2 + nmethods) return
          buf = buf.subarray(2 + nmethods)
          sock.socksGreeted = true
          sock.write(Buffer.from([0x05, 0x00]))
        }
        if (sock.socksGreeted && !sock.socksConnected) {
          if (buf.length < 4) return
          const atyp = buf[3]
          let hostLen = 0
          let host
          if (atyp === 3) {
            hostLen = buf[4]
            if (buf.length < 5 + hostLen + 2) return
            host = buf.subarray(5, 5 + hostLen).toString()
            buf = buf.subarray(5 + hostLen + 2)
          } else {
            if (buf.length < 4 + 4 + 2) return
            host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
            buf = buf.subarray(4 + 4 + 2)
          }
          sock.socksConnected = true
          void host
          const up = net.connect({ host: '127.0.0.1', port: targetPort })
          up.on('connect', () => {
            sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x1f, 0x90]))
            up.write(buf)
            buf = Buffer.alloc(0)
          })
          up.on('data', d => sock.write(d))
          sock.on('data', d => up.write(d))
          up.on('close', () => sock.destroy())
          sock.on('close', () => up.destroy())
          sock.removeListener('data', read)
        }
      }
      sock.on('data', read)
    })
    socksServer.listen(0, '127.0.0.1', () => resolve(socksServer.address().port))
  })
}

let echoActualPort
let socksActualPort

before(async () => {
  echoActualPort = await startEcho()
  socksActualPort = await startSocks(echoActualPort)
})

after(() => {
  disableProxy()
  echoServer?.close()
  socksServer?.close()
})

test('parseProxy accepts socks4/socks5 variants with creds', () => {
  const p = parseProxy('socks5h://user:pass@127.0.0.1:9050')
  assert.equal(p.type, 5)
  assert.equal(p.port, 9050)
  assert.equal(p.userId, 'user')
  assert.equal(p.password, 'pass')
  assert.equal(parseProxy('socks4://10.0.0.1').type, 4)
  assert.equal(parseProxy('socks://host:1080').type, 5)
  assert.equal(parseProxy(''), null)
  assert.equal(parseProxy('http://x'), null)
  assert.equal(parseProxy('nonsense'), null)
})

test('patched net.connect tunnels non-loopback peers through the SOCKS proxy', { timeout: 15000 }, async () => {
  enableProxy(`socks5h://127.0.0.1:${socksActualPort}`)
  assert.ok(isProxyEnabled())
  const echo = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy tunnel timed out')), 10000)
    const conn = net.connect({ port: 1, host: '203.0.113.7' })
    conn.on('connect', () => conn.write('ping-via-proxy'))
    conn.on('data', d => {
      clearTimeout(timer)
      conn.destroy()
      resolve(d.toString())
    })
    conn.on('error', err => {
      clearTimeout(timer)
      conn.destroy()
      reject(err)
    })
  })
  assert.equal(echo, 'ping-via-proxy')
})

test('loopback targets bypass the proxy', { timeout: 15000 }, async () => {
  enableProxy(`socks5h://127.0.0.1:${socksActualPort}`)
  const echo = await new Promise((resolve, reject) => {
    const conn = net.connect({ port: echoActualPort, host: '127.0.0.1' })
    conn.on('connect', () => conn.write('ping-local'))
    conn.on('data', d => {
      conn.destroy()
      resolve(d.toString())
    })
    conn.on('error', err => {
      conn.destroy()
      reject(err)
    })
  })
  assert.equal(echo, 'ping-local')
})

test('disableProxy restores direct connections', () => {
  disableProxy()
  assert.ok(!isProxyEnabled())
})
