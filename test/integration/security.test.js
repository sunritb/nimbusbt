import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import WebTorrent from 'webtorrent'
import { Server as TrackerServer } from 'bittorrent-tracker'
import { openDb } from '../../src/db.js'
import { Settings } from '../../src/config.js'
import { TorrentCore } from '../../src/engine/core.js'

const WORK = mkdtempSync(path.join(os.tmpdir(), 'nimbus-sec-'))
const DATA_DIR = path.join(WORK, 'data')
const SAVE_DIR = path.join(WORK, 'saves')
const PAYLOAD = randomBytes(256 * 1024)

let tracker
let trackerPort
let seederA // announced via local tracker, used for the health check
let seederB // no announce: attack target has zero peers
let attackTorrent // .torrent buffer of seederB
let db
let settings
let core
let attackPort

before(async () => {
  mkdirSync(DATA_DIR, { recursive: true })
  mkdirSync(SAVE_DIR, { recursive: true })

  tracker = new TrackerServer({ udp: false, ws: false, http: true })
  await new Promise(resolve => tracker.listen(0, '127.0.0.1', resolve))
  trackerPort = tracker.http.address().port
  const announceUrl = `http://127.0.0.1:${trackerPort}/announce`

  seederA = new WebTorrent({ dht: false, tracker: true, lsd: false, utp: false })
  await new Promise((resolve, reject) => {
    const f = path.join(WORK, 'seed-a.bin')
    writeFileSync(f, PAYLOAD)
    seederA.seed(f, { announce: [announceUrl] }, resolve)
    seederA.on('error', reject)
  })

  const attackFile = path.join(WORK, 'seed-b.bin')
  writeFileSync(attackFile, randomBytes(128 * 1024))
  seederB = new WebTorrent({ dht: false, tracker: false, lsd: false, utp: false })
  await new Promise((resolve, reject) => {
    seederB.seed(attackFile, resolve)
    seederB.on('error', reject)
  })
  attackTorrent = Buffer.from(seederB.torrents[0].torrentFile)

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

  await core.add(attackTorrent, { savePath: SAVE_DIR })
  await new Promise(r => setTimeout(r, 500))
  attackPort = core.client.torrentPort
})

after(async () => {
  await core.stop()
  await new Promise(resolve => seederA.destroy(resolve))
  await new Promise(resolve => seederB.destroy(resolve))
  await new Promise(resolve => tracker.close(resolve))
  db.close()
  rmSync(WORK, { recursive: true, force: true })
})

function sendBytes (bytes, wait = 3000) {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port: attackPort }, () => sock.write(bytes))
    const timer = setTimeout(() => { sock.destroy(); resolve('open') }, wait)
    sock.on('close', () => { clearTimeout(timer); resolve('closed') })
    sock.on('error', () => {})
  })
}

test('rejects peers that violate the handshake (spec security checklist)', { timeout: 30000 }, async () => {
  const t = core.torrents.get(core.getStatuses()[0].infoHash)
  assert.equal(t.wires.length, 0, 'starts with no peers')

  const wrongProtocol = Buffer.concat([
    Buffer.from([19]),
    Buffer.from('NOT-A-BITTORRENT-PROTOCOL!!'),
    randomBytes(48)
  ])
  await sendBytes(wrongProtocol)
  await sendBytes(Buffer.from([0x13])) // truncated handshake
  await sendBytes(Buffer.from('GARBAGE GARBAGE GARBAGE')) // raw garbage

  assert.equal(t.wires.length, 0, 'no peer was established from invalid handshakes')
  assert.equal(t.destroyed, false, 'torrent survived the attacks')
  assert.ok(t.files.length >= 1, 'engine still serving metadata after the attack')
})

test('engine remains fully functional after the attack (can still download)', { timeout: 60000 }, async () => {
  const magnet = seederA.torrents[0].magnetURI
  const status = await core.add(magnet, { savePath: SAVE_DIR })
  await new Promise(resolve => core.on('done', resolve))
  const written = readFileSync(path.join(SAVE_DIR, 'seed-a.bin'))
  assert.deepEqual(written, PAYLOAD, 'download completed after handshake attack')
  await core.remove(status.infoHash, { deleteFiles: false })
})
