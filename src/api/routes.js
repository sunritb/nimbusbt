import { Router } from 'express'
import { existsSync } from 'node:fs'
import { NAME, VERSION, ENGINE, PROTOCOLS } from '../version.js'

const toInfoHash = v => String(v || '').toLowerCase()

/**
 * Accept a single announce URL or a comma-separated list (query params) and
 * always produce an array, or undefined when nothing was provided.
 */
const toAnnounceList = v => {
  if (v === undefined || v === null || v === '') return undefined
  const list = Array.isArray(v) ? v : String(v).split(',')
  return list.map(s => String(s).trim()).filter(Boolean)
}

/**
 * @param {import('../config.js').Settings} settings
 * @param {import('../engine/core.js').TorrentCore} core
 * @param {import('../db.js')} db
 */
export function createApi (settings, core) {
  const api = Router()

  api.get('/health', (req, res) => {
    res.json({ status: 'ok', started: core.started, torrents: core.torrents.size })
  })

  api.get('/version', (req, res) => {
    res.json({
      name: NAME,
      version: VERSION,
      engine: ENGINE,
      protocols: PROTOCOLS,
      note: core.ipLeakNote
    })
  })

  /* ------------------------------- torrents ------------------------------ */

  api.get('/torrents', (req, res) => {
    let list = core.getStatuses()
    const { state, offset, limit } = req.query
    if (state) {
      const wanted = String(state).toLowerCase()
      list = list.filter(t => {
        if (wanted === 'done' || wanted === 'seeding') return t.done
        if (wanted === 'downloading') return !t.done && !t.paused
        if (wanted === 'paused') return t.paused
        if (wanted === 'active') return !t.paused
        return true
      })
    }
    const off = Math.max(0, Number(offset) || 0)
    const lim = Number(limit)
    if (Number.isInteger(lim) && lim > 0) list = list.slice(off, off + lim)
    else if (off > 0) list = list.slice(off)
    res.json(list)
  })

  api.get('/torrents/summary', (req, res) => {
    const list = core.getStatuses()
    res.json({
      total: list.length,
      downloading: list.filter(t => !t.done && !t.paused).length,
      seeding: list.filter(t => t.done).length,
      paused: list.filter(t => t.paused).length,
      active: list.filter(t => !t.paused).length,
      bytesDownloaded: list.reduce((n, t) => n + (t.downloaded || 0), 0),
      bytesUploaded: list.reduce((n, t) => n + (t.uploaded || 0), 0),
      downloadSpeed: list.reduce((n, t) => n + (t.downloadSpeed || 0), 0),
      uploadSpeed: list.reduce((n, t) => n + (t.uploadSpeed || 0), 0)
    })
  })

  api.get('/torrents/:infoHash', (req, res) => {
    try {
      res.json(core.getStatus(toInfoHash(req.params.infoHash)))
    } catch (err) {
      res.status(404).json({ error: err.message })
    }
  })

  api.post('/torrents', async (req, res) => {
    try {
      let torrentId
      let addedBy
      const body = req.body || {}
      const q = req.query || {}

      if (req.file?.buffer) {
        torrentId = req.file.buffer
        addedBy = 'file'
        body.savePath = body.savePath ?? q.savePath
        body.private = body.private ?? (q.private === '1' || q.private === 'true')
        body.paused = body.paused ?? (q.paused === '1' || q.paused === 'true')
        body.announce = toAnnounceList(body.announce ?? q.announce)
      } else if (typeof body.magnet === 'string' && body.magnet.length) {
        torrentId = body.magnet
        addedBy = 'magnet'
        body.announce = toAnnounceList(body.announce ?? q.announce)
      } else if (typeof body.path === 'string' && body.path.length) {
        if (!existsSync(body.path)) {
          return res.status(400).json({ error: 'Local path does not exist' })
        }
        const stats = await import('node:fs').then(fs => fs.promises.stat(body.path))
        if (stats.isFile() || stats.isDirectory()) {
          const seedStatus = await core.seed(body.path, {
            savePath: body.savePath,
            private: body.private,
            announce: toAnnounceList(body.announce ?? q.announce)
          })
          return res.status(201).json(seedStatus)
        }
        return res.status(400).json({ error: 'Path must be a file or directory' })
      } else {
        return res.status(400).json({ error: 'Provide a magnet URI, .torrent file, or local path' })
      }

      const status = await core.add(torrentId, {
        savePath: body.savePath,
        private: body.private,
        paused: body.paused,
        announce: body.announce,
        addedBy
      })
      res.status(201).json(status)
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  api.patch('/torrents/:infoHash', async (req, res) => {
    const infoHash = toInfoHash(req.params.infoHash)
    const body = req.body || {}
    try {
      if (body.action === 'pause') await core.pause(infoHash)
      else if (body.action === 'resume') await core.resume(infoHash)
      else if (body.action === 'recheck') {
        const status = await core.recheck(infoHash)
        return res.json(status)
      } else {
        return res.status(400).json({ error: 'Unknown action' })
      }
      res.json(core.getStatus(infoHash))
    } catch (err) {
      res.status(404).json({ error: err.message })
    }
  })

  api.delete('/torrents/:infoHash', async (req, res) => {
    try {
      await core.remove(toInfoHash(req.params.infoHash), {
        deleteFiles: !!(req.query.deleteFiles === '1' || req.query.deleteFiles === 'true')
      })
      res.status(204).end()
    } catch (err) {
      res.status(404).json({ error: err.message })
    }
  })

  api.post('/torrents/:infoHash/files/:idx/priority', async (req, res) => {
    try {
      const priority = Number(req.body?.priority)
      if (!Number.isInteger(priority)) return res.status(400).json({ error: 'priority must be an integer' })
      await core.setFilePriority(toInfoHash(req.params.infoHash), Number(req.params.idx), priority)
      res.json(core.getStatus(toInfoHash(req.params.infoHash)))
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  api.post('/torrents/:infoHash/scan', async (req, res) => {
    try {
      const result = await core.checkMalware(toInfoHash(req.params.infoHash))
      res.json(result)
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  api.post('/torrents/:infoHash/virustotal', async (req, res) => {
    try {
      const result = await core.virusTotalLookup(toInfoHash(req.params.infoHash))
      if (!result) return res.status(400).json({ error: 'VirusTotal API key not configured' })
      res.json(result)
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  /* ------------------------------ settings ------------------------------- */

  api.get('/settings', (req, res) => {
    res.json(settings.all())
  })

  api.put('/settings', async (req, res) => {
    try {
      const patch = req.body || {}
      const updated = await core.applySettings(patch)
      res.json(updated)
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  /* --------------------------------- log --------------------------------- */

  api.get('/log', (req, res) => {
    const limit = Number(req.query.limit) || 200
    const level = req.query.level
    let entries = core.getLog(limit)
    if (level) entries = entries.filter(e => e.level === String(level))
    res.json(entries)
  })

  api.delete('/log', (req, res) => {
    core.logBuffer = []
    res.status(204).end()
  })

  return api
}
