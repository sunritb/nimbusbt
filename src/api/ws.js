import { WebSocketServer } from 'ws'
import { VERSION } from '../version.js'

/**
 * WebSocket hub. Broadcasts engine events and periodic status snapshots to
 * connected clients. Same token auth as the REST API.
 */
export class Hub {
  /**
   * @param {import('ws').Server} server
   * @param {import('../config.js').Settings} settings
   * @param {import('../engine/core.js').TorrentCore} core
   */
  constructor (server, settings, core) {
    this.settings = settings
    this.core = core
    this.clients = new Set()
    this.wss = new WebSocketServer({ server, path: '/ws' })

    this.wss.on('connection', (socket, req) => {
      const url = new URL(req.url, `http://${req.headers.host}`)
      const token = url.searchParams.get('token') ||
        (req.headers['sec-websocket-protocol'] || '').split(',')[0]?.trim()
      if (token !== this.settings.get('api_token')) {
        socket.close(4001, 'unauthorized')
        return
      }
      this.clients.add(socket)
      socket.send(JSON.stringify({ type: 'hello', data: this._helloPayload() }))
      socket.on('close', () => this.clients.delete(socket))
    })

    this._bindCoreEvents()
    this._ticker = setInterval(() => this.broadcast('status', this.core.getStatuses()), 1000)
    this._ticker.unref?.()
  }

  _helloPayload () {
    return {
      version: VERSION,
      settings: this.settings.all(),
      log: this.core.getLog(200),
      ipLeakNote: this.core.ipLeakNote
    }
  }

  _bindCoreEvents () {
    this.core.on('log', entry => {
      this.broadcast('log', entry)
    })
    this.core.on('torrent', infoHash => this._broadcastTorrent(infoHash))
    this.core.on('done', infoHash => this._broadcastTorrent(infoHash, 'done'))
    this.core.on('removed', info => this.broadcast('removed', info))
    this.core.on('error', err => this.broadcast('error', { message: err.message }))
    this.core.on('scanned', res => this.broadcast('scanned', res))
    this.core.on('blockedPeer', info => this.broadcast('blockedPeer', info))
  }

  _broadcastTorrent (infoHash, type = 'torrent') {
    try {
      this.broadcast(type, this.core.getStatus(infoHash))
    } catch {
      /* torrent may have been removed mid-broadcast */
    }
  }

  broadcast (type, data) {
    if (this.clients.size === 0) return
    const msg = JSON.stringify({ type, data })
    for (const socket of this.clients) {
      if (socket.readyState === 1) socket.send(msg)
    }
  }

  close () {
    clearInterval(this._ticker)
    for (const socket of this.clients) socket.close()
    this.wss.close()
  }
}
