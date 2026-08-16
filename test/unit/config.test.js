import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../src/db.js'
import { Settings, DEFAULTS } from '../../src/config.js'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nimbusbt-config-test-'))
const db = openDb(tmp)

after(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('defaults are seeded on first open', () => {
  const settings = new Settings(db)
  for (const key of Object.keys(DEFAULTS)) assert.ok(key in settings.store)
  assert.ok(settings.get('api_token').length > 0)
})

test('setMany persists to the DB and store', () => {
  const settings = new Settings(db)
  settings.setMany({ dht: false, api_port: 6060 })
  assert.equal(settings.get('dht'), false)
  assert.equal(settings.get('api_port'), 6060)
  const reloaded = new Settings(db)
  assert.equal(reloaded.get('dht'), false)
  assert.equal(reloaded.get('api_port'), 6060)
})

test('setMany rejects unknown keys without partial writes', () => {
  const settings = new Settings(db)
  assert.throws(() => settings.setMany({ dht: true, bogus_key: 1 }), /Unknown setting/)
  assert.equal(settings.get('dht'), false)
  const reloaded = new Settings(db)
  assert.equal(reloaded.get('dht'), false)
})
