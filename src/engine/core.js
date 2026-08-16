import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import WebTorrent from 'webtorrent'
import { SpeedScheduler } from './scheduler.js'
import { applyBlocklist, scanPaths, checkVirusTotal, ipLeakWarning } from './security.js'
import { enableProxy, disableProxy } from './proxy.js'
import { upsert } from '../db.js'

const STATS_INTERVAL = 1000
const PERSIST_INTERVAL = 30_000
const METADATA_TIMEOUT = 120_000

/**
 * Core torrent engine. Owns a single WebTorrent instance and exposes a clean,
 * promise-based API plus events consumed by the API layer and WebSocket hub.
 *
 * Events emitted: 'torrent', 'status', 'done', 'error', 'log', 'warning',
 * 'removed', 'scanned', 'blockedPeer'.
 */
export class TorrentCore extends EventEmitter {
  /**
   * @param {import('../config.js').Settings} settings
   * @param {import('node:sqlite').DatabaseSync} db
   */
  constructor (settings, db) {
    super()
    this.settings = settings
    this.db = db
    this.client = null
    this.torrents = new Map() // infoHash -> webtorrent Torrent
    this.meta = new Map() // infoHash -> persisted row cache
    this.scheduler = null
    this.started = false
    this._statsTimer = null
    this._persistTimer = null
    this._peerId = null
  }

  log (msg, level = 'info') {
    const entry = { time: Date.now(), level, msg: String(msg) }
    this.emit('log', entry)
  }

  async start () {
    if (this.started) return
    this.started = true
    const s = this.settings

    this._peerId = Buffer.from(`-NB0001-${randomBytes(12).toString('hex')}`).toString('hex')

    if (s.get('proxy')) {
      enableProxy(s.get('proxy'))
      this.log(`SOCKS proxy enabled (${s.get('proxy')})`)
    }

    this.client = new WebTorrent({
      dht: s.get('dht'),
      tracker: s.get('tracker'),
      lsd: s.get('lsd'),
      utp: s.get('utp'),
      webSeeds: s.get('web_seeds'),
      torrentPort: s.get('torrent_port') > 0 ? s.get('torrent_port') : undefined,
      maxConns: s.get('max_peers') > 0 ? s.get('max_peers') : undefined
    })

    if (s.get('blocklist_enabled') && s.get('blocklist_url')) {
      const result = await applyBlocklist(this.client, s.get('blocklist_url'))
      this.log(result.ok
        ? `Blocklist loaded (${result.entries === -1 ? 'remote' : result.entries} entries)`
        : `Blocklist failed to load: ${s.get('blocklist_url')}`, result.ok ? 'info' : 'warning')
    }

    this.client.on('error', err => {
      this.log(`Core error: ${err.message}`, 'error')
      this.emit('error', err)
    })

    this.scheduler = new SpeedScheduler({
      apply: limits => this.applyLimits(limits),
      base: () => ({ download: s.get('download_limit'), upload: s.get('upload_limit') }),
      rules: () => s.get('speed_schedule')
    })
    this.scheduler.start()

    await this._restoreFromDb()

    this._statsTimer = setInterval(() => this._broadcastStatus(), STATS_INTERVAL)
    this._statsTimer.unref?.()
    this._persistTimer = setInterval(() => this._persistAll(), PERSIST_INTERVAL)
    this._persistTimer.unref?.()

    this.log(`Engine ready (peerId ${this._peerId}). Torrents loaded: ${this.torrents.size}`)
  }

  async stop () {
    if (!this.started) return
    this.started = false
    this.scheduler?.stop()
    disableProxy()
    if (this._statsTimer) clearInterval(this._statsTimer)
    if (this._persistTimer) clearInterval(this._persistTimer)
    await this._persistAll()
    await new Promise(resolve => this.client?.destroy(resolve))
    this.client = null
    this.log('Engine stopped')
  }

  /* ------------------------------------------------------------------ *
   *  Add / remove
   * ------------------------------------------------------------------ */

  /**
   * Add a torrent from a magnet URI, .torrent file buffer, or local path.
   * @param {string|Buffer} torrentId
   * @param {object} [opts]
   * @param {string} [opts.savePath]
   * @param {boolean} [opts.private]
   * @param {boolean} [opts.paused]
   * @param {string[]} [opts.announce]
   * @param {string[]} [opts.webSeeds]
   * @param {string} [opts.addedBy]
   * @returns {Promise<object>} torrent status snapshot
   */
  async add (torrentId, opts = {}) {
    this._assertRunning()
    const savePath = opts.savePath || this.settings.get('download_dir')
    const isPrivate = opts.private ?? this.settings.get('private_mode_default')
    const paused = opts.paused ?? this.settings.get('autostart_paused')

    const addOpts = {
      path: savePath,
      private: isPrivate,
      paused,
      announce: opts.announce?.length ? opts.announce : undefined,
      webSeeds: opts.webSeeds?.length ? opts.webSeeds : undefined,
      deselect: false
    }

    const addedBy = typeof torrentId === 'string' && (torrentId.startsWith('magnet:') || torrentId.includes('btih:') || torrentId.includes('btmh:'))
      ? 'magnet'
      : (opts.addedBy || 'file')

    const torrent = await this._addWithTimeout(torrentId, addOpts, METADATA_TIMEOUT)
    this._track(torrent, { savePath, isPrivate, paused, addedBy })
    this.log(`Added torrent ${torrent.name || torrent.infoHash} (${addedBy})`)
    return this.snapshot(torrent)
  }

  /**
   * Seed an existing file or folder from disk.
   * @param {string} filePath
   * @param {object} [opts]
   * @returns {Promise<object>}
   */
  async seed (filePath, opts = {}) {
    this._assertRunning()
    const seedOpts = {
      path: opts.savePath || this.settings.get('download_dir'),
      private: opts.private ?? this.settings.get('private_mode_default'),
      announce: opts.announce?.length ? opts.announce : undefined
    }
    const torrent = await new Promise((resolve, reject) => {
      this.client.seed(filePath, seedOpts, resolve)
      setTimeout(() => reject(new Error('Seeding timeout')), METADATA_TIMEOUT)
    })
    this._track(torrent, {
      savePath: seedOpts.path,
      isPrivate: seedOpts.private,
      paused: false,
      addedBy: 'path'
    })
    this.log(`Seeding ${torrent.name || torrent.infoHash}`)
    return this.snapshot(torrent)
  }

  /**
   * Remove a torrent from the client and database.
   * @param {string} infoHash
   * @param {object} [opts] {destroyStore: boolean, deleteFiles: boolean}
   */
  async remove (infoHash, opts = {}) {
    const torrent = this.torrents.get(infoHash)
    if (!torrent) throw new Error(`No torrent with info hash ${infoHash}`)
    const name = torrent.name || infoHash
    this.torrents.delete(infoHash)
    this.meta.delete(infoHash)
    const removeOpts = { destroyStore: !!opts.deleteFiles }
    await new Promise(resolve => this.client.remove(infoHash, removeOpts, () => resolve()))
    this.db.prepare('DELETE FROM torrents WHERE info_hash = ?').run(infoHash)
    this.db.prepare('DELETE FROM files WHERE info_hash = ?').run(infoHash)
    this.db.prepare('DELETE FROM peers WHERE info_hash = ?').run(infoHash)
    this.db.prepare('DELETE FROM trackers WHERE info_hash = ?').run(infoHash)
    this.log(`Removed torrent ${name}`)
    this.emit('removed', { infoHash, name })
  }

  async pause (infoHash) {
    const torrent = this._get(infoHash)
    torrent.pause()
    this.db.prepare('UPDATE torrents SET paused = 1 WHERE info_hash = ?').run(infoHash)
    this.log(`Paused ${torrent.name || infoHash}`)
  }

  async resume (infoHash) {
    const torrent = this._get(infoHash)
    torrent.resume()
    this.db.prepare('UPDATE torrents SET paused = 0 WHERE info_hash = ?').run(infoHash)
    this.log(`Resumed ${torrent.name || infoHash}`)
  }

  /** Force a full piece re-verification against disk (webtorrent recheck). */
  async recheck (infoHash) {
    const torrent = this._get(infoHash)
    const row = this.meta.get(infoHash)
    const savePath = row?.save_path || this.settings.get('download_dir')
    this.torrents.delete(infoHash)
    await new Promise(resolve => this.client.remove(infoHash, { destroyStore: false }, () => resolve()))
    const addOpts = {
      path: savePath,
      private: !!row?.is_private,
      paused: !!row?.paused,
      announce: row?.announce ? JSON.parse(row.announce) : undefined,
      deselect: false
    }
    const fresh = await this._addWithTimeout(torrent.magnetURI || torrent.infoHash, addOpts, METADATA_TIMEOUT)
    this._track(fresh, { savePath, isPrivate: !!row?.is_private, paused: !!row?.paused, addedBy: row?.added_by || 'recheck' })
    this.log(`Rechecking ${torrent.name || infoHash}`)
    return this.snapshot(fresh)
  }

  /* ------------------------------------------------------------------ *
   *  Priority / limits
   * ------------------------------------------------------------------ */

  async setFilePriority (infoHash, fileIdx, priority) {
    const torrent = this._get(infoHash)
    const file = torrent.files[fileIdx]
    if (!file) throw new Error(`No file at index ${fileIdx}`)
    if (priority > 0) file.select(priority)
    else if (priority === 0) file.deselect()
    this.db.prepare('UPDATE files SET priority = ? WHERE info_hash = ? AND idx = ?')
      .run(priority, infoHash, fileIdx)
    this.log(`Priority for ${file.name} set to ${priority}`)
  }

  applyLimits (limits) {
    if (!this.client) return
    this.client.throttleDownload(limits.download)
    this.client.throttleUpload(limits.upload)
  }

  /* ------------------------------------------------------------------ *
   *  Settings application (runtime reconfiguration)
   * ------------------------------------------------------------------ */

  async applySettings (patch) {
    const s = this.settings
    s.setMany(patch)
    if (this.client) {
      if (patch.blocklist_url !== undefined || patch.blocklist_enabled !== undefined) {
        const source = s.get('blocklist_enabled') ? s.get('blocklist_url') : ''
        const result = await applyBlocklist(this.client, source)
        this.log(result.ok ? 'Blocklist updated' : 'Blocklist update failed', result.ok ? 'info' : 'warning')
      }
      if (patch.dht !== undefined) this.client.dht = s.get('dht')
      if (patch.lsd !== undefined) this.client.lsd = s.get('lsd')
      if (patch.utp !== undefined) this.client.utp = s.get('utp')
      if (patch.web_seeds !== undefined) this.client.enableWebSeeds = s.get('web_seeds')
      if (patch.proxy !== undefined) {
        if (s.get('proxy')) {
          enableProxy(s.get('proxy'))
          this.log(`SOCKS proxy enabled (${s.get('proxy')})`)
        } else {
          disableProxy()
          this.log('SOCKS proxy disabled')
        }
      }
    }
    this.scheduler?.refresh()
    this.log('Settings updated')
    return s.all()
  }

  /* ------------------------------------------------------------------ *
   *  Status
   * ------------------------------------------------------------------ */

  async checkMalware (infoHash) {
    const torrent = this._get(infoHash)
    const base = torrent.path || this.settings.get('download_dir')
    const targets = torrent.files
      .filter(f => f.length > 0)
      .map(f => path.join(base, f.path))
    const res = await scanPaths(targets, this.settings.get('scanner_command'))
    this.emit('scanned', { infoHash, ...res })
    return res
  }

  async virusTotalLookup (infoHash) {
    const key = this.settings.get('virus_total_key')
    const res = await checkVirusTotal(infoHash, key)
    this.log(res ? `VirusTotal: ${JSON.stringify(res.stats || res)}` : 'VirusTotal disabled', res?.malicious ? 'warning' : 'info')
    return res
  }

  get ipLeakNote () {
    return ipLeakWarning()
  }

  snapshot (torrent) {
    const pieces = torrent.pieces || []
    const totalPieces = pieces.length
    const havePieces = torrent.bitfield ? countSetBits(torrent.bitfield.buffer, totalPieces) : 0
    const seeders = torrent.wires?.filter(w => {
      if (!w.peerPieces) return false
      return totalPieces > 0 && countSetBits(w.peerPieces.buffer, totalPieces) === totalPieces
    }).length || 0

    const files = (torrent.files || []).map((f, index) => ({
      id: index,
      index,
      name: f.name,
      path: f.path,
      length: f.length,
      progress: f.progress || 0,
      downloaded: f.downloaded || 0,
      selected: !f.deselected,
      priority: f.priority
    }))

    const peers = []
    for (const peer of (torrent._peers?.values() || [])) {
      const wire = peer.wire
      const progress = wire?.peerPieces
        ? countSetBits(wire.peerPieces.buffer, totalPieces) / Math.max(totalPieces, 1)
        : 0
      peers.push({
        address: peer.addr || '',
        addr: peer.addr || '',
        type: peer.type || 'unknown',
        connected: !!peer.connected,
        progress: progress,
        downloadSpeed: wire?.downloadSpeed?.() || 0,
        uploadSpeed: wire?.uploadSpeed?.() || 0,
        downloaded: wire?.downloaded || 0,
        uploaded: wire?.uploaded || 0,
        client: wire?.peerId ? String(wire.peerId) : ''
      })
    }
    peers.sort((a, b) => b.downloadSpeed - a.downloadSpeed)

    return {
      hash: torrent.infoHash,
      infoHash: torrent.infoHash,
      magnet: torrent.magnetURI || torrent.infoHash,
      magnetURI: torrent.magnetURI || torrent.infoHash,
      name: torrent.name || torrent.infoHash.slice(0, 16),
      path: torrent.path || '',
      private: !!torrent.private,
      paused: !!torrent.paused,
      done: !!torrent.done,
      addedAt: torrent._nimbusAddedAt || 0,
      progress: torrent.progress || 0,
      length: torrent.length || 0,
      downloaded: torrent.downloaded || 0,
      uploaded: torrent.uploaded || 0,
      received: torrent.received || 0,
      downloadSpeed: torrent.downloadSpeed || 0,
      uploadSpeed: torrent.uploadSpeed || 0,
      ratio: torrent.ratio || 0,
      timeRemaining: torrent.timeRemaining || 0,
      pieceLength: torrent.pieceLength || 0,
      pieceCount: totalPieces,
      piecesHave: havePieces,
      numPeers: torrent.numPeers || 0,
      numSeeders: seeders,
      seeders,
      webSeeds: torrent.webSeeds?.length || 0,
      announce: (torrent.announce || []),
      files,
      peers: peers.slice(0, 50),
      trackers: []
    }
  }

  get infoHashList () {
    return [...this.torrents.keys()]
  }

  getStatuses () {
    const out = []
    for (const torrent of this.torrents.values()) out.push(this.snapshot(torrent))
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }

  getStatus (infoHash) {
    return this.snapshot(this._get(infoHash))
  }

  /* ------------------------------------------------------------------ *
   *  Internals
   * ------------------------------------------------------------------ */

  _assertRunning () {
    if (!this.client || !this.started) throw new Error('Engine not started')
  }

  _get (infoHash) {
    const t = this.torrents.get(infoHash)
    if (!t) throw new Error(`No torrent with info hash ${infoHash}`)
    return t
  }

  _addWithTimeout (torrentId, addOpts, timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false
      const finish = (fn, arg) => {
        if (done) return
        done = true
        clearTimeout(timer)
        fn(arg)
      }
      const timer = setTimeout(() => {
        finish(reject, new Error('Timed out fetching torrent metadata (no seeds for magnet?)'))
      }, timeoutMs)
      let torrent
      try {
        torrent = this.client.add(torrentId, addOpts, () => finish(resolve, torrent))
      } catch (err) {
        finish(reject, err)
      }
      torrent.on('error', err => {
        if (!done) {
          finish(reject, err)
          if (torrent.infoHash) this.client.remove(torrent.infoHash, {}, () => {})
        }
      })
      torrent.on('warning', warn => this.log(`Torrent warning: ${warn.message}`, 'warning'))
    })
  }

  _track (torrent, meta) {
    const infoHash = torrent.infoHash
    this.torrents.set(infoHash, torrent)
    if (!torrent._nimbusAddedAt) torrent._nimbusAddedAt = Date.now()
    const row = {
      info_hash: infoHash,
      name: torrent.name || '',
      magnet: torrent.magnetURI || torrent.infoHash,
      torrent_file: torrent.torrentFile ? Buffer.from(torrent.torrentFile) : null,
      save_path: meta.savePath,
      added_at: meta.addedAt || Date.now(),
      added_by: meta.addedBy || 'magnet',
      is_private: meta.isPrivate ? 1 : 0,
      paused: meta.paused ? 1 : 0,
      announce: meta.announce?.length ? JSON.stringify(meta.announce) : null,
      status: 'active'
    }
    this.meta.set(infoHash, row)
    upsert(this.db, 'torrents', row, ['info_hash'])
    this._registerTorrentEvents(torrent)
    this._persistFiles(torrent)
    if (torrent.done) {
      // already verified complete on disk (restore / re-add); 'done' fires
      // during _onStore before our listeners attach, so defer the replay so
      // consumers attaching after `await core.add()` still receive it.
      setImmediate(() => {
        this.log(`Already complete: ${torrent.name}`)
        this.emit('done', infoHash)
      })
    }
    this.emit('torrent', infoHash)
    this._broadcastStatus()
  }

  _registerTorrentEvents (torrent) {
    const infoHash = torrent.infoHash
    torrent.on('done', () => {
      this.log(`Download complete: ${torrent.name}`)
      this.emit('done', infoHash)
      if (this.settings.get('malware_scan')) {
        this.checkMalware(infoHash).then(res => {
          this.log(`Malware scan: ${res.status} — ${res.detail.slice(0, 120)}`, res.status === 'clean' ? 'info' : 'warning')
        }).catch(() => {})
      }
    })
    torrent.on('verified', idx => {
      this.db.exec('BEGIN')
      try {
        const row = this.db.prepare('SELECT bitfield FROM torrents WHERE info_hash = ?').get(infoHash)
        const buf = row?.bitfield
        const bf = buf ? new Uint8Array(buf) : new Uint8Array(Math.ceil((torrent.pieces?.length || 0) / 8))
        if (bf[idx >> 3] !== undefined) {
          bf[idx >> 3] |= (1 << (idx & 7))
          this.db.prepare('UPDATE torrents SET bitfield = ? WHERE info_hash = ?').run(Buffer.from(bf), infoHash)
        }
        this.db.exec('COMMIT')
      } catch {
        this.db.exec('ROLLBACK')
      }
    })
    torrent.on('warning', warn => this.log(`Torrent warning: ${warn.message}`, 'warning'))
    torrent.on('blockedPeer', addr => {
      this.log(`Blocked peer ${addr} (blocklist)`, 'warning')
      this.emit('blockedPeer', { infoHash, addr })
    })
  }

  _persistFiles (torrent) {
    const infoHash = torrent.infoHash
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO files (info_hash, idx, name, rel_path, length, selected, priority)
      VALUES (@info_hash, @idx, @name, @rel_path, @length, @selected, @priority)
    `)
    torrent.files.forEach((file, idx) => {
      stmt.run({
        info_hash: infoHash,
        idx,
        name: file.name,
        rel_path: file.path,
        length: file.length,
        selected: file.deselected ? 0 : 1,
        priority: file.priority || 0
      })
    })
  }

  _persistAll () {
    for (const torrent of this.torrents.values()) {
      try {
        this._persistBitfield(torrent)
      } catch { /* ignore */ }
    }
  }

  _persistBitfield (torrent) {
    if (!torrent.bitfield || !torrent.pieces?.length) return
    const bytes = new Uint8Array(Math.ceil(torrent.pieces.length / 8))
    for (let i = 0; i < torrent.pieces.length; i++) {
      if (torrent.bitfield.get(i)) bytes[i >> 3] |= (1 << (i & 7))
    }
    this.db.prepare('UPDATE torrents SET bitfield = ? WHERE info_hash = ?')
      .run(Buffer.from(bytes), torrent.infoHash)
  }

  async _restoreFromDb () {
    const rows = this.db.prepare('SELECT * FROM torrents').all()
    for (const row of rows) {
      const announce = row.announce ? JSON.parse(row.announce) : undefined
      const bitfield = row.bitfield ? new Uint8Array(row.bitfield) : undefined
      const opts = {
        path: row.save_path || this.settings.get('download_dir'),
        private: !!row.is_private,
        paused: !!row.paused,
        announce,
        deselect: false
      }
      if (bitfield?.length) {
        opts.bitfield = bitfield
      }
      try {
        const torrent = this._addWithTimeout(row.magnet || row.info_hash, opts, METADATA_TIMEOUT)
          .catch(err => {
            this.log(`Failed to restore ${row.info_hash}: ${err.message}`, 'error')
            return null
          })
        const t = await torrent
        if (t) this._track(t, {
          savePath: opts.path,
          isPrivate: !!row.is_private,
          paused: !!row.paused,
          addedBy: row.added_by || 'magnet'
        })
      } catch (err) {
        this.log(`Failed to restore ${row.info_hash}: ${err.message}`, 'error')
      }
    }
  }

  _broadcastStatus () {
    if (this.listenerCount('status') === 0) return
    this.emit('status', this.getStatuses())
  }
}

const POPCOUNT = new Uint8Array(256)
for (let i = 0; i < 256; i++) POPCOUNT[i] = (i & 1) + POPCOUNT[i >> 1]

function countSetBits (buf, total) {
  if (!buf) return 0
  const full = Math.min(Math.floor(total / 8), buf.length)
  let n = 0
  for (let i = 0; i < full; i++) n += POPCOUNT[buf[i]]
  const tail = total & 7
  if (tail && full < buf.length) {
    n += POPCOUNT[buf[full] & (0xff << (8 - tail))]
  }
  return n
}
