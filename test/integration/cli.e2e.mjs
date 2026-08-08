// End-to-end: CLI against a running NimbusBT server with a local seeder.
// NOTE: must use async spawn, NOT execSync — execSync blocks this process's
// event loop, which freezes the in-process seeder and deadlocks the handshake.
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import WebTorrent from 'webtorrent'
import { Server as TrackerServer } from 'bittorrent-tracker'
import { spawn } from 'node:child_process'

const WORK = mkdtempSync(path.join(os.tmpdir(), 'nimbus-cli-e2e-'))
const SEED = path.join(WORK, 'cli.bin')
writeFileSync(SEED, randomBytes(128 * 1024))

const tracker = new TrackerServer({ udp: false, ws: false, http: true })
await new Promise(r => tracker.listen(0, '127.0.0.1', r))
const announceUrl = `http://127.0.0.1:${tracker.http.address().port}/announce`

const seeder = new WebTorrent({ dht: false, tracker: true, lsd: false, utp: false })
await new Promise((resolve, reject) => { seeder.seed(SEED, { announce: [announceUrl] }, resolve); seeder.on('error', reject) })
const magnet = seeder.torrents[0].magnetURI

const dataDir = path.join(WORK, 'data')
mkdirSync(dataDir, { recursive: true })
const port = 5199
const server = spawn('node', ['src/server.js', '--port', String(port), '--token', 'clitest'], {
  cwd: process.cwd(), env: { ...process.env, NIMBUSBT_DATA_DIR: dataDir }
})
let slog = ''
server.stdout.on('data', d => { slog += d })
server.stderr.on('data', d => { slog += d })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let up = false
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { up = true; break } } catch {}
  await sleep(250)
}
if (!up) throw new Error(`server failed to start:\n${slog}`)

const cli = (args) => new Promise((resolve, reject) => {
  const child = spawn('node', ['src/cli.js', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, NIMBUSBT_PORT: String(port), NIMBUSBT_TOKEN: 'clitest' }
  })
  let out = '', err = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { err += d })
  child.on('error', reject)
  child.on('exit', code => {
    if (code === 0) resolve(out)
    else reject(new Error(`cli ${args[0]} exited ${code}: ${err}`))
  })
})

const outAdd = await cli(['add', magnet])
const hash = outAdd.match(/\(([a-f0-9]{40})\)/)
if (!hash) throw new Error(`no hash in add output: ${outAdd}`)
console.log('✓ CLI add')
const infoHash = hash[1]

let done = false
for (let i = 0; i < 60; i++) {
  await sleep(400)
  if ((await cli(['list'])).includes('seeding')) { done = true; break }
}
if (!done) throw new Error('download did not complete')
console.log('✓ CLI list shows seeding')

const status = await cli(['status', infoHash])
if (!status.includes('done')) throw new Error('status not done')
console.log('✓ CLI status')

await cli(['pause', infoHash])
await sleep(200)
if (!(await cli(['list'])).includes('paused')) throw new Error('pause failed')
await cli(['resume', infoHash])
console.log('✓ CLI pause/resume')

await cli(['settings', '--download_limit', '2048'])
if (!(await cli(['settings'])).includes('2048')) throw new Error('settings update failed')
console.log('✓ CLI settings')

await cli(['remove', infoHash])
await sleep(300)
if ((await cli(['list'])).includes(infoHash)) throw new Error('remove failed')
console.log('✓ CLI remove')

server.kill('SIGINT')
await new Promise(r => server.once('exit', r))
await new Promise(r => seeder.destroy(r))
await new Promise(r => tracker.close(r))
console.log('CLI E2E PASSED')
process.exit(0)
