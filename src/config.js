import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { upsert } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_DOWNLOAD_DIR = path.join(__dirname, '..', 'downloads')

export const DEFAULTS = {
  'download_dir': DEFAULT_DOWNLOAD_DIR,
  'torrent_port': 0,
  'dht': true,
  'tracker': true,
  'lsd': true,
  'utp': false, // WebTorrent connects uTP-first and only falls back to TCP after a ~40s stall; TCP-first is the reliable default
  'web_seeds': true,
  'encryption': 'prefer', // WebTorrent uses uTP + standard handshake; MSE/PE not available -> best-effort
  'proxy': '', // SOCKS proxy for peer traffic, e.g. socks5h://user:pass@127.0.0.1:9050
  'download_limit': -1,
  'upload_limit': -1,
  'max_peers': 0,
  'speed_schedule': [],
  'blocklist_url': '',
  'blocklist_enabled': false,
  'api_host': '127.0.0.1',
  'api_port': 5050,
  'api_token': '',
  'cors_origins': [],
  'malware_scan': false,
  'scanner_command': '',
  'virus_total_key': '',
  'private_mode_default': false,
  'ui_theme': 'auto',
  'notify_done': true,
  'autostart_paused': false,
  'peer_id_prefix': '-NB0001-'
}

/**
 * Settings store backed by SQLite. All values serialised as JSON.
 */
export class Settings {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   */
  constructor (db) {
    this.db = db
    this.store = {}
    this.ensureDefaults()
    this.load()
  }

  ensureDefaults () {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
      if (!row) {
        this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value))
      }
    }
    if (!this.get('api_token')) {
      this.set('api_token', randomBytes(24).toString('hex'))
    }
  }

  load () {
    const rows = this.db.prepare('SELECT key, value FROM settings').all()
    for (const row of rows) {
      this.store[row.key] = JSON.parse(row.value)
    }
  }

  get (key) {
    if (!(key in this.store)) return DEFAULTS[key]
    return this.store[key]
  }

  set (key, value) {
    if (!(key in DEFAULTS)) throw new Error(`Unknown setting: ${key}`)
    this.store[key] = value
    this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value))
    return value
  }

  /**
   * Apply several settings atomically. All keys are validated before any write
   * and the batch commits in a single transaction, so a bad key or DB error
   * leaves neither the store nor the database half-updated.
   * @param {Record<string, unknown>} updates
   */
  setMany (updates) {
    const entries = Object.entries(updates)
    for (const [key] of entries) {
      if (!(key in DEFAULTS)) throw new Error(`Unknown setting: ${key}`)
    }
    const stmt = this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    this.db.exec('BEGIN')
    try {
      for (const [key, value] of entries) stmt.run(key, JSON.stringify(value))
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    for (const [key, value] of entries) this.store[key] = value
    return this
  }

  /** @returns {Record<string, unknown>} snapshot of all settings */
  all () {
    return { ...this.store }
  }
}

export function ensureDownloadDir (dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

export { upsert }
