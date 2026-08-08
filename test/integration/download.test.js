import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import WebTorrent from 'webtorrent'
import { Server as TrackerServer } from 'bittorrent-tracker'
import { openDb } from '../../src/db.js'
import { Settings } from '../../src/config.js'
import { TorrentCore } from '../../src/engine/core.js'

const WORK = mkdtempSync(path.join(os.tmpdir(), 'nimbus-test-'))
const DATA_DIR = path.join(WORK, 'data')
const SAVE_DIR = path.join(WORK, 'saves')

const PAYLOAD = randomBytes(512 * 1024)
const SEED_FILE = path.join(WORK, 'seed.bin')

let tracker
let trackerPort
let seeder
let db
let settings
let core

before(async () => {
  mkdirSync(DATA_DIR, { recursive: true })
  mkdirSync(SAVE_DIR, { recursive: true })
  writeFileSync(SEED_FILE, PAYLOAD)

  tracker = new TrackerServer({ udp: false, ws: false, http: true })
  await new Promise(resolve => tracker.listen(0, '127.0.0.1', resolve))
  trackerPort = tracker.http.address().port
  const announceUrl = `http://127.0.0.1:${trackerPort}/announce`

  seeder = new WebTorrent({ dht: false, tracker: true, lsd: false, utp: false })
  await new Promise((resolve, reject) => {
    seeder.seed(SEED_FILE, { announce: [announceUrl] }, resolve)
    seeder.on('error', reject)
  })

  db = openDb(DATA_DIR)
  settings = new Settings(db)
  settings.setMany({
    download_dir: SAVE_DIR,
    dht: false,
    tracker: true,
    lsd: false,
    utp: false,
    torrent_port: 0,
    web_seeds: false
  })
  core = new TorrentCore(settings, db)
  await core.start()
})

after(async () => {
  await core.stop()
  await new Promise(resolve => seeder.destroy(resolve))
  await new Promise(resolve => tracker.close(resolve))
  db.close()
  rmSync(WORK, { recursive: true, force: true })
})

test('downloads a seeded file via a local HTTP tracker', { timeout: 60000 }, async () => {
  const magnet = seeder.torrents[0].magnetURI
  const status = await core.add(magnet, { savePath: SAVE_DIR })

  assert.ok(status.infoHash.length === 40, 'info hash (SHA-1) present')

  const done = new Promise(resolve => core.on('done', resolve))
  await done

  const final = core.getStatus(status.infoHash)
  assert.equal(final.done, true, 'torrent reports done')
  assert.equal(final.progress, 1, 'progress is 100%')

  const written = readFileSync(path.join(SAVE_DIR, 'seed.bin'))
  assert.deepEqual(written, PAYLOAD, 'downloaded bytes match seed')

  await core.remove(status.infoHash, { deleteFiles: false })
})

test('exposes peer and file status after download', { timeout: 60000 }, async () => {
  const magnet = seeder.torrents[0].magnetURI
  const status = await core.add(magnet, { savePath: SAVE_DIR })
  await new Promise(resolve => core.on('done', resolve))
  const snap = core.getStatus(status.infoHash)
  assert.ok(snap.files.length >= 1, 'file list populated')
  assert.ok(snap.files[0].length === PAYLOAD.length, 'file size correct')
  await core.remove(status.infoHash, { deleteFiles: false })
})
