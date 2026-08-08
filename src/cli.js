#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CONFIG_PATH = path.join(os.homedir(), '.config', 'nimbusbt', 'config')

function loadConfig () {
  const config = { host: '127.0.0.1', port: 5050, token: '' }
  if (existsSync(CONFIG_PATH)) {
    const text = readFileSync(CONFIG_PATH, 'utf8')
    for (const line of text.split('\n')) {
      const [key, ...rest] = line.trim().split('=')
      if (!key) continue
      const value = rest.join('=').trim()
      if (key === 'NIMBUSBT_HOST') config.host = value
      else if (key === 'NIMBUSBT_PORT') config.port = Number(value) || config.port
      else if (key === 'NIMBUSBT_TOKEN') config.token = value
    }
  }
  config.token = process.env.NIMBUSBT_TOKEN || config.token
  if (process.env.NIMBUSBT_HOST) config.host = process.env.NIMBUSBT_HOST
  if (process.env.NIMBUSBT_PORT) config.port = Number(process.env.NIMBUSBT_PORT) || config.port
  return config
}

function baseUrl (config) {
  return `http://${config.host}:${config.port}`
}

async function call (config, method, url, body) {
  const headers = { 'Content-Type': 'application/json' }
  if (config.token) headers['x-nimbus-token'] = config.token
  const res = await fetch(`${baseUrl(config)}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  if (!res.ok) {
    let msg = res.statusText
    try { msg = (await res.json()).error || msg } catch {}
    throw new Error(msg)
  }
  if (res.status === 204) return null
  return res.json()
}

const fmtBytes = n => {
  if (n == null || n <= 0) return '0 B'
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(n < 1024 ? 0 : 1)} ${u[i]}`
}

const fmtEta = ms => {
  if (ms == null || ms < 0 || !Number.isFinite(ms)) return '—'
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function table (rows) {
  if (!rows.length) return '(none)'
  const widths = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] || 0, String(cell).length)
    })
  }
  return rows.map(r => r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd()).join('\n')
}

async function cmdAdd (config, args) {
  if (!args.length) throw new Error('Usage: nimbus add <magnet|.torrent|path> [--path DIR] [--paused]')
  const torrentId = args[0]
  const opts = {}
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--path') opts.savePath = args[++i]
    else if (args[i] === '--paused') opts.paused = true
    else if (args[i] === '--private') opts.private = true
  }
  const body = torrentId.startsWith('magnet:') || torrentId.includes('btih:')
    ? { magnet: torrentId, ...opts }
    : { path: torrentId, ...opts }
  const t = await call(config, 'POST', '/api/torrents', body)
  console.log(`Added ${t.name} (${t.infoHash})`)
}

async function cmdList (config) {
  const list = await call(config, 'GET', '/api/torrents')
  const rows = list.map(t => [
    t.name,
    t.paused ? 'paused' : t.done ? 'seeding' : `${Math.round(t.progress * 100)}%`,
    fmtBytes(t.downloaded) + '/' + fmtBytes(t.length),
    `↓${fmtBytes(t.downloadSpeed)}/s`,
    `↑${fmtBytes(t.uploadSpeed)}/s`,
    fmtEta(t.timeRemaining),
    `${t.numPeers}p`
  ])
  console.log(table(rows))
  console.log(`\n${list.length} torrent(s)`)
}

async function cmdStatus (config, args) {
  if (!args.length) throw new Error('Usage: nimbus status <infoHash>')
  const t = await call(config, 'GET', `/api/torrents/${args[0].toLowerCase()}`)
  console.log(`Name:     ${t.name}`)
  console.log(`Hash:     ${t.infoHash}`)
  console.log(`Status:   ${t.done ? 'done/seeding' : t.paused ? 'paused' : 'downloading'}`)
  console.log(`Progress: ${Math.round(t.progress * 100)}% (${fmtBytes(t.downloaded)} / ${fmtBytes(t.length)})`)
  console.log(`Speed:    ↓${fmtBytes(t.downloadSpeed)}/s  ↑${fmtBytes(t.uploadSpeed)}/s`)
  console.log(`Peers:    ${t.numPeers} (${t.seeders} seeds)`)
  console.log(`Ratio:    ${t.ratio.toFixed(2)}`)
  console.log(`ETA:      ${fmtEta(t.timeRemaining)}`)
  console.log(`Path:     ${t.path}`)
}

async function cmdPause (config, args) {
  if (!args.length) throw new Error('Usage: nimbus pause <infoHash>')
  await call(config, 'PATCH', `/api/torrents/${args[0].toLowerCase()}`, { action: 'pause' })
  console.log(`Paused ${args[0]}`)
}

async function cmdResume (config, args) {
  if (!args.length) throw new Error('Usage: nimbus resume <infoHash>')
  await call(config, 'PATCH', `/api/torrents/${args[0].toLowerCase()}`, { action: 'resume' })
  console.log(`Resumed ${args[0]}`)
}

async function cmdRemove (config, args) {
  if (!args.length) throw new Error('Usage: nimbus remove <infoHash> [--delete-files]')
  const deleteFiles = args.includes('--delete-files')
  await call(config, 'DELETE', `/api/torrents/${args[0].toLowerCase()}${deleteFiles ? '?deleteFiles=1' : ''}`)
  console.log(`Removed ${args[0]}${deleteFiles ? ' (files deleted)' : ''}`)
}

async function cmdSettings (config, args) {
  if (!args.length) {
    const s = await call(config, 'GET', '/api/settings')
    console.log(table(Object.entries(s).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])))
    return
  }
  const patch = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '')
    const value = args[i + 1]
    if (value === undefined) throw new Error(`Missing value for --${key}`)
    patch[key] = /^-?\d+$/.test(value) ? Number(value) : value === 'true' ? true : value === 'false' ? false : value
  }
  const updated = await call(config, 'PUT', '/api/settings', patch)
  console.log('Updated:')
  console.log(table(Object.entries(patch).map(([k, v]) => [k, String(updated[k] ?? v)])))
}

const HELP = `NimbusBT CLI — control a running NimbusBT daemon.

Usage: nimbus <command> [args]

Commands:
  add <magnet|.torrent|path> [--path DIR] [--paused] [--private]
  list                          list torrents
  status <infoHash>             show one torrent
  pause <infoHash>
  resume <infoHash>
  remove <infoHash> [--delete-files]
  settings                      show all settings
  settings --key value ...      update settings (e.g. --download_limit 1024)
  version
  help

Config: reads NIMBUSBT_TOKEN (env) or ~/.config/nimbusbt/config
Host:   NIMBUSBT_HOST / NIMBUSBT_PORT (default 127.0.0.1:5050)
`

const COMMANDS = {
  add: cmdAdd,
  list: cmdList,
  status: cmdStatus,
  pause: cmdPause,
  resume: cmdResume,
  remove: cmdRemove,
  settings: cmdSettings,
  version: async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    console.log(`NimbusBT v${pkg.version}`)
  }
}

async function main () {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP)
    return
  }
  const fn = COMMANDS[command]
  if (!fn) {
    console.error(`Unknown command: ${command}\n`)
    console.error(HELP)
    process.exit(1)
  }
  if (command === 'version') {
    await fn()
    process.exit(0)
  }
  try {
    await fn(loadConfig(), args)
    process.exit(0)
  } catch (err) {
    console.error(`error: ${err.message}`)
    process.exit(1)
  }
}

main()
