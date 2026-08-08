import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hostOf, parsePeerGuardian } from '../../src/engine/security.js'

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
