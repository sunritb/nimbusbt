import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAuth, isLoopback } from '../../src/api/auth.js'

function makeSettings (token) {
  return { get: key => (key === 'api_token' ? token : undefined) }
}

function makeReq (token, query = {}) {
  const headers = {}
  if (token !== undefined) headers['x-nimbus-token'] = token
  return { headers, query, socket: { remoteAddress: '127.0.0.1' } }
}

function makeRes () {
  const res = { statusCode: 200, body: null }
  res.status = code => {
    res.statusCode = code
    return res
  }
  res.json = body => {
    res.body = body
    return res
  }
  return res
}

test('valid token passes middleware', () => {
  const { authMiddleware } = createAuth(makeSettings('sekrit'))
  let called = false
  authMiddleware(makeReq('sekrit'), makeRes(), () => { called = true })
  assert.ok(called)
})

test('missing or wrong token is rejected', () => {
  const { authMiddleware } = createAuth(makeSettings('sekrit'))
  const res = makeRes()
  let called = false
  authMiddleware(makeReq(undefined), res, () => { called = true })
  assert.ok(!called)
  assert.equal(res.statusCode, 401)
  assert.equal(res.body.error, 'Unauthorized')
})

test('token via query string is accepted', () => {
  const { authMiddleware } = createAuth(makeSettings('sekrit'))
  let called = false
  authMiddleware(makeReq(undefined, { token: 'sekrit' }), makeRes(), () => { called = true })
  assert.ok(called)
})

test('repeated failures are rate limited to 429', () => {
  const { authMiddleware } = createAuth(makeSettings('sekrit'), { maxAttempts: 3 })
  for (let i = 0; i < 3; i++) {
    const res = makeRes()
    authMiddleware(makeReq('wrong'), res, () => {})
    assert.equal(res.statusCode, 401)
  }
  const res = makeRes()
  authMiddleware(makeReq('wrong'), res, () => {})
  assert.equal(res.statusCode, 429)
})

test('successful auth clears the failure counter', () => {
  const { authMiddleware } = createAuth(makeSettings('sekrit'), { maxAttempts: 3 })
  for (let i = 0; i < 3; i++) authMiddleware(makeReq('wrong'), makeRes(), () => {})
  let called = false
  authMiddleware(makeReq('sekrit'), makeRes(), () => { called = true })
  assert.ok(called)
  const res = makeRes()
  authMiddleware(makeReq('wrong'), res, () => {})
  assert.equal(res.statusCode, 401)
})

test('isLoopback recognizes IPv4/IPv6 loopback', () => {
  assert.ok(isLoopback({ socket: { remoteAddress: '::1' } }))
  assert.ok(isLoopback({ socket: { remoteAddress: '::ffff:127.0.0.1' } }))
  assert.ok(isLoopback({ socket: { remoteAddress: '127.0.0.1' } }))
  assert.ok(!isLoopback({ socket: { remoteAddress: '8.8.8.8' } }))
})
