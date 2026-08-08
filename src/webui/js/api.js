// NimbusBT web UI — REST client + WebSocket. Zero dependencies.

const TOKEN = document.querySelector('meta[name="nimbus-token"]')?.content || ''

async function http (method, url, body) {
  const headers = {}
  if (TOKEN) headers['x-nimbus-token'] = TOKEN
  const opts = { method, headers }
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) {
      headers['Content-Type'] = 'application/x-bittorrent'
      opts.body = body
    } else {
      headers['Content-Type'] = 'application/json'
      opts.body = JSON.stringify(body)
    }
  }
  const res = await fetch(url, opts)
  if (!res.ok) {
    let msg = res.statusText
    try {
      const data = await res.json()
      if (data.error) msg = data.error
    } catch {}
    throw new Error(msg || `HTTP ${res.status}`)
  }
  const ct = res.headers.get('content-type') || ''
  if (res.status === 204) return null
  if (ct.includes('application/json')) return res.json()
  return res
}

export const api = {
  health: () => http('GET', '/api/health'),
  version: () => http('GET', '/api/version'),
  listTorrents: () => http('GET', '/api/torrents'),
  getTorrent: (hash) => http('GET', `/api/torrents/${encodeURIComponent(hash)}`),
  addMagnet: (magnet, opts = {}) => http('POST', '/api/torrents', { source: 'magnet', magnet, ...opts }),
  addFile: async (file, opts = {}) => {
    const bytes = await file.arrayBuffer()
    const qs = new URLSearchParams()
    Object.entries(opts).forEach(([k, v]) => { if (v !== undefined && v !== '') qs.set(k, String(v)) })
    const headers = { 'Content-Type': 'application/x-bittorrent' }
    if (TOKEN) headers['x-nimbus-token'] = TOKEN
    const res = await fetch(`/api/torrents${qs.toString() ? '?' + qs : ''}`, {
      method: 'POST', headers, body: bytes
    })
    if (!res.ok) {
      let msg = res.statusText
      try { msg = (await res.json()).error || msg } catch {}
      throw new Error(msg)
    }
    return res.json()
  },
  patchTorrent: (hash, patch) => http('PATCH', `/api/torrents/${encodeURIComponent(hash)}`, patch),
  remove: (hash, deleteFiles) => http('DELETE', `/api/torrents/${encodeURIComponent(hash)}${deleteFiles ? '?deleteFiles=1' : ''}`),
  filePriority: (hash, fileIdx, priority) => http('POST', `/api/torrents/${encodeURIComponent(hash)}/files/${fileIdx}/priority`, { priority }),
  scan: (hash) => http('POST', `/api/torrents/${encodeURIComponent(hash)}/scan`),
  virusTotal: (hash) => http('POST', `/api/torrents/${encodeURIComponent(hash)}/virustotal`),
  settings: () => http('GET', '/api/settings'),
  saveSettings: (patch) => http('PUT', '/api/settings', patch),
  log: (since = 0) => http('GET', `/api/log?since=${since}`)
}

export function connectWS (handlers) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const token = encodeURIComponent(TOKEN)
  let ws
  let retry = 1000

  function open () {
    ws = new WebSocket(`${proto}//${location.host}/ws?token=${token}`)
    ws.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      const h = handlers[msg.type]
      if (h) h(msg)
    }
    ws.onclose = () => {
      setTimeout(open, retry)
      retry = Math.min(retry * 1.5, 10000)
    }
    ws.onopen = () => { retry = 1000 }
  }

  open()
  return () => ws && ws.close()
}
