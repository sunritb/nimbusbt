import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import WebTorrent from 'webtorrent'
import { Server as TrackerServer } from 'bittorrent-tracker'
import { spawn } from 'node:child_process'

const WORK = mkdtempSync(path.join(os.tmpdir(), 'nimbus-e2e-'))
const PAYLOAD = randomBytes(256 * 1024)
const SEED_FILE = path.join(WORK, 'e2e.bin')
mkdirSync(WORK, { recursive: true })
writeFileSync(SEED_FILE, PAYLOAD)

const tracker = new TrackerServer({ udp: false, ws: false, http: true })
await new Promise(resolve => tracker.listen(0, '127.0.0.1', resolve))
const announceUrl = `http://127.0.0.1:${tracker.http.address().port}/announce`

const seeder = new WebTorrent({ dht: false, tracker: true, lsd: false, utp: false })
await new Promise((resolve, reject) => {
  seeder.seed(SEED_FILE, { announce: [announceUrl] }, resolve)
  seeder.on('error', reject)
})
const magnet = seeder.torrents[0].magnetURI

const dataDir = path.join(WORK, 'data')
mkdirSync(dataDir, { recursive: true })
const env = { ...process.env, NIMBUSBT_DATA_DIR: dataDir }
const port = 5123
const server = spawn('node', ['src/server.js', '--port', String(port), '--token', 'e2etoken'], { cwd: process.cwd(), env })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const base = `http://127.0.0.1:${port}`
const h = { 'x-nimbus-token': 'e2etoken', 'Content-Type': 'application/json' }

server.stdout.on('data', () => {})
server.stderr.on('data', () => {})

// wait for server
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`${base}/api/health`)
    if (r.ok) break
  } catch {}
  await sleep(250)
}

// WebSocket client
const ws = await import('ws')
const wsc = new ws.WebSocket(`ws://127.0.0.1:${port}/ws?token=e2etoken`)
const wsEvents = []
wsc.on('message', d => wsEvents.push(JSON.parse(d)))
await new Promise(r => wsc.on('open', r))
await sleep(300)
const hello = wsEvents.find(e => e.type === 'hello')
if (!hello) throw new Error('no hello over WS')
console.log('✓ hello received over WS')

// add magnet via REST
const addRes = await fetch(`${base}/api/torrents`, { method: 'POST', headers: h, body: JSON.stringify({ magnet }) })
if (!addRes.ok) throw new Error(`add failed: ${await addRes.text()}`)
const added = await addRes.json()
console.log(`✓ added torrent ${added.name} (${added.infoHash})`)

// wait for done over WS
const deadline = Date.now() + 60000
let done = false
while (Date.now() < deadline && !done) {
  const e = wsEvents.find(x => x.type === 'done' && x.data?.infoHash === added.infoHash)
  if (e) { done = true; console.log(`✓ 'done' event over WS (progress ${e.data.progress})`) }
  else await sleep(300)
}
if (!done) throw new Error('download did not complete')

// status via REST
const st = await (await fetch(`${base}/api/torrents/${added.infoHash}`, { headers: h })).json()
if (st.done !== true) throw new Error('status not done')
console.log(`✓ status: done=${st.done} progress=${st.progress} files=${st.files.length} peer=${st.peers[0]?.address}`)

// pause/resume
await fetch(`${base}/api/torrents/${added.infoHash}`, { method: 'PATCH', headers: h, body: JSON.stringify({ action: 'pause' }) })
let st2 = await (await fetch(`${base}/api/torrents/${added.infoHash}`, { headers: h })).json()
if (!st2.paused) throw new Error('pause failed')
console.log('✓ pause works')
await fetch(`${base}/api/torrents/${added.infoHash}`, { method: 'PATCH', headers: h, body: JSON.stringify({ action: 'resume' }) })
st2 = await (await fetch(`${base}/api/torrents/${added.infoHash}`, { headers: h })).json()
if (st2.paused) throw new Error('resume failed')
console.log('✓ resume works')

// settings roundtrip
const up = await (await fetch(`${base}/api/settings`, { method: 'PUT', headers: h, body: JSON.stringify({ download_limit: 1024 }) })).json()
if (up.download_limit !== 1024) throw new Error('settings save failed')
console.log('✓ settings save works')

// remove
const del = await fetch(`${base}/api/torrents/${added.infoHash}`, { method: 'DELETE', headers: h })
if (del.status !== 204) throw new Error('delete failed')
await sleep(300)
const gone = wsEvents.find(e => e.type === 'removed')
if (!gone) throw new Error('no removed event over WS')
console.log('✓ remove + WS removed event')

wsc.close()
server.kill('SIGINT')
await new Promise(r => server.once('exit', r))
await new Promise(resolve => seeder.destroy(resolve))
await new Promise(resolve => tracker.close(resolve))
console.log('ALL E2E CHECKS PASSED')
process.exit(0)
