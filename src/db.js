import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function dataDir () {
  return process.env.NIMBUSBT_DATA_DIR || path.join(__dirname, '..', 'data')
}

export const DATA_DIR = dataDir()
export const DB_PATH = path.join(DATA_DIR, 'nimbusbt.db')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS torrents (
  info_hash    TEXT PRIMARY KEY,
  name         TEXT,
  magnet       TEXT,
  torrent_file BLOB,
  save_path    TEXT NOT NULL,
  added_at     INTEGER NOT NULL,
  added_by     TEXT NOT NULL DEFAULT 'magnet',
  is_private   INTEGER NOT NULL DEFAULT 0,
  paused       INTEGER NOT NULL DEFAULT 0,
  bitfield     BLOB,
  web_seeds    TEXT,
  announce     TEXT,
  status       TEXT
);

CREATE TABLE IF NOT EXISTS files (
  info_hash TEXT NOT NULL,
  idx       INTEGER NOT NULL,
  name      TEXT NOT NULL,
  rel_path  TEXT NOT NULL,
  length    INTEGER NOT NULL DEFAULT 0,
  selected  INTEGER NOT NULL DEFAULT 1,
  priority  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (info_hash, idx)
);

CREATE TABLE IF NOT EXISTS trackers (
  info_hash    TEXT NOT NULL,
  url          TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'http',
  last_announce INTEGER,
  seeders      INTEGER,
  leechers     INTEGER,
  complete     INTEGER,
  PRIMARY KEY (info_hash, url)
);

CREATE TABLE IF NOT EXISTS peers (
  info_hash TEXT NOT NULL,
  addr      TEXT NOT NULL,
  type      TEXT,
  client    TEXT,
  progress  REAL DEFAULT 0,
  down_rate INTEGER DEFAULT 0,
  up_rate   INTEGER DEFAULT 0,
  updated   INTEGER,
  PRIMARY KEY (info_hash, addr)
);

CREATE INDEX IF NOT EXISTS idx_files_torrent ON files (info_hash);
CREATE INDEX IF NOT EXISTS idx_peers_torrent ON peers (info_hash);
CREATE INDEX IF NOT EXISTS idx_trackers_torrent ON trackers (info_hash);
`

/**
 * Open (and lazily initialise) the SQLite database.
 * Uses Node's built-in `node:sqlite` — zero native dependencies.
 * @param {string} [dir] optional data directory override
 * @returns {DatabaseSync}
 */
export function openDb (dir) {
  const target = dir || dataDir()
  mkdirSync(target, { recursive: true })
  const db = new DatabaseSync(path.join(target, 'nimbusbt.db'))
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  return db
}

/**
 * Tiny helper for INSERT ... ON CONFLICT ... DO UPDATE.
 * @param {DatabaseSync} db
 * @param {string} table
 * @param {Record<string, unknown>} data
 * @param {string[]} conflictKeys
 */
export function upsert (db, table, data, conflictKeys) {
  const keys = Object.keys(data)
  const cols = keys.join(', ')
  const placeholders = keys.map(k => `@${k}`).join(', ')
  const conflict = conflictKeys.join(', ')
  const updates = keys
    .filter(k => !conflictKeys.includes(k))
    .map(k => `${k} = excluded.${k}`)
    .join(', ')
  const sql = `INSERT INTO ${table} (${cols}) VALUES (${placeholders})
    ON CONFLICT (${conflict}) DO UPDATE SET ${updates}`
  return db.prepare(sql).run(data)
}

export default openDb
