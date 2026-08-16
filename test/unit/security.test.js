import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hostOf, parsePeerGuardian, scanPaths } from '../../src/engine/security.js'

test('hostOf strips IPv4 port', () => {
  assert.equal(hostOf('192.168.1.1:6881'), '192.168.1.1')
  assert.equal(hostOf('192.168.1.1'), '192.168.1.1')
})

test('hostOf strips bracketed IPv6 port, keeps bare IPv6', () => {
  assert.equal(hostOf('[2001:db8::1]:6881'), '2001:db8::1')
  assert.equal(hostOf('2001:db8::1'), '2001:db8::1')
  assert.equal(hostOf('fe80::1%en0'), 'fe80::1%en0')
})

test('parsePeerGuardian handles comment + range, single IP, CIDR, comments', () => {
  const text = [
    '# header comment',
    'comment: 10.0.0.1 - 10.0.0.255',
    'comment: 172.16.0.5',
    '10.1.2.3/24',
    '',
    '  8.8.8.8  '
  ].join('\n')
  const ranges = parsePeerGuardian(text)
  assert.deepEqual(ranges, [
    '10.0.0.1-10.0.0.255',
    '172.16.0.5',
    '10.1.2.3/24',
    '8.8.8.8'
  ])
})

test('parsePeerGuardian ignores garbage', () => {
  assert.deepEqual(parsePeerGuardian('not an ip\n###\n'), [])
})

test('scanPaths reports clean on exit code 0', async () => {
  const res = await scanPaths(['/tmp/nonexistent'], 'node -e process.exit(0)')
  assert.equal(res.status, 'clean')
})

test('scanPaths reports infected on exit code 1', async () => {
  const res = await scanPaths(['/tmp/nonexistent'], 'node -e process.exit(1)')
  assert.equal(res.status, 'infected')
})

test('scanPaths surfaces a missing scanner binary', async () => {
  const res = await scanPaths(['/tmp/nonexistent'], 'nimbusbt-no-such-scanner-xyz')
  assert.equal(res.status, 'error')
  assert.match(res.detail, /unavailable/i)
})

test('scanPaths kills and reports a hung scanner after the timeout', async () => {
  const t0 = Date.now()
  const res = await scanPaths(
    ['/tmp/nonexistent'],
    'node -e setTimeout(function(){process.exit(0)},30000)',
    400
  )
  assert.equal(res.status, 'error')
  assert.match(res.detail, /timed out/i)
  assert.ok(Date.now() - t0 < 5000, 'timeout must not wait for the child')
})
