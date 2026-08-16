import { api, connectWS } from './api.js'

const state = {
  torrents: new Map(),
  view: 'torrents',
  selected: null,
  query: '',
  settings: {},
  logs: [],
  dirtySettings: null,
  connected: false,
  version: null
}

const els = {}
const $ = (sel, root = document) => root.querySelector(sel)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/* -------------------------------- helpers ------------------------------- */
function fmtBytes (n) {
  if (n == null || n < 0 || !Number.isFinite(n)) return '–'
  if (n === 0) return '0 B'
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(n < 1024 ? 0 : i < 2 ? 1 : 2)} ${u[i]}`
}
function fmtSpeed (n) { return n == null || n === 0 ? '—' : `${fmtBytes(n)}/s` }
function fmtEta (ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '∞'
  const s = Math.ceil(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}
function pct (t) { return Math.round((t.progress || 0) * 100) }
function statusOf (t) {
  if (t.error) return 'error'
  if (t.paused) return 'paused'
  if (t.done) return 'seeding'
  if (t.progress > 0 && t.progress < 1) return 'downloading'
  if (t.numPeers > 0) return 'checking'
  return 'stalled'
}
const STATUS_LABEL = {
  seeding: 'Seeding', downloading: 'Downloading', paused: 'Paused',
  checking: 'Checking', error: 'Error', stalled: 'Stalled'
}

/* --------------------------------- toasts -------------------------------- */
function toast (msg, kind = 'info') {
  const el = document.createElement('div')
  el.className = `toast ${kind}`
  el.setAttribute('role', 'status')
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 4200)
}

/* ------------------------------ theme/init ------------------------------ */
function applyTheme () {
  const t = (state.settings.ui_theme || 'dark').toLowerCase()
  const mode = t === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t
  document.documentElement.dataset.theme = mode === 'light' ? 'light' : 'dark'
}

async function init () {
  const root = $('#app')
  root.innerHTML = shell()
  els.nav = [...root.querySelectorAll('.nav-item')]
  els.view = $('#view')
  els.search = $('#search')
  els.conn = $('#conn')
  els.sideAdd = $('#btn-add')

  els.nav.forEach(b => b.addEventListener('click', () => setView(b.dataset.view)))
  els.search.addEventListener('input', () => { state.query = els.search.value; renderTorrents() })
  els.search.addEventListener('keydown', e => { if (e.key === 'Escape') { els.search.value = ''; state.query = ''; renderTorrents() } })
  els.sideAdd.addEventListener('click', openAddModal)

  window.addEventListener('keydown', onKey)
  root.addEventListener('click', onRootClick)

  applyTheme()
  connectWS({
    hello: data => { state.connected = true; state.version = data?.version || state.version; els.conn.dataset.on = '1'; els.conn.title = 'Connected' },
    status: () => {},
    torrent: m => { state.torrents.set(m.hash, m); if (state.view === 'torrents') renderTorrents(); if (state.selected === m.hash) renderDrawer() },
    done: m => {
      state.torrents.set(m.hash, m)
      if (state.view === 'torrents') renderTorrents()
      notifyDone(m)
    },
    removed: m => { state.torrents.delete(m.infoHash ?? m.hash); if (state.view === 'torrents') renderTorrents(); if (state.selected === (m.infoHash ?? m.hash)) closeDrawer() },
    log: m => { state.logs.push(m); if (state.logs.length > 500) state.logs.shift(); if (state.view === 'logs') renderLogs() },
    error: m => toast(m.message || 'Unknown error', 'error'),
    scanned: m => {
      const infected = m.status === 'infected' || m.malware
      toast(`Scan ${m.status || 'done'}: ${m.detail || ''}`, infected ? 'error' : 'success')
    },
    blockedPeer: m => toast(`Blocked peer ${m.addr || m.address || ''}`, 'info')
  })

  await Promise.all([refreshSettings(), refreshTorrents()])
}

function shell () {
  return `
  <aside class="sidebar" aria-label="Navigation">
    <div class="brand">
      <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path d="M10 26c-3.5 0-5.5-2-5.5-5S6.5 16 10 16h2.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M22 26c3.5 0 5.5-2 5.5-5s-2-5-5.5-5h-2.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <circle cx="16" cy="16" r="3.2" stroke="currentColor" stroke-width="2"/>
        <path d="M16 6v7M11 8.5 16 6l5 2.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>NimbusBT</span>
    </div>
    <button class="nav-item" data-view="torrents" aria-current="page">
      <span aria-hidden="true">⇓</span><span class="lbl">Torrents</span>
    </button>
    <button class="nav-item" data-view="settings">
      <span aria-hidden="true">⚙</span><span class="lbl">Settings</span>
    </button>
    <button class="nav-item" data-view="logs">
      <span aria-hidden="true">📜</span><span class="lbl">Activity log</span>
    </button>
    <button class="nav-item" data-view="about">
      <span aria-hidden="true">🛡</span><span class="lbl">Security</span>
    </button>
    <div class="spacer"></div>
    <div class="foot" id="foot"></div>
  </aside>
  <div class="main">
    <div class="topbar">
      <h1 id="title">Torrents</h1>
      <span id="conn" class="mute" title="Disconnected" data-on="0">● offline</span>
      <input class="search" id="search" type="search" placeholder="Filter torrents… ( / )" aria-label="Filter torrents">
      <div class="actions">
        <button class="btn primary" id="btn-add">＋ Add torrent</button>
      </div>
    </div>
    <div class="view" id="view"></div>
  </div>`
}

/* -------------------------------- routing ------------------------------- */
function setView (v) {
  state.view = v
  els.nav.forEach(b => b.setAttribute('aria-current', b.dataset.view === v ? 'page' : 'false'))
  $('#title').textContent = { torrents: 'Torrents', settings: 'Settings', logs: 'Activity log', about: 'Security' }[v] || 'Torrents'
  if (v === 'torrents') renderTorrents()
  else if (v === 'settings') renderSettings()
  else if (v === 'logs') renderLogs()
  else renderAbout()
}

function onRootClick (e) {
  const t = e.target.closest('[data-action]')
  if (!t) return
  const { action } = t.dataset
  const hash = t.dataset.hash
  if (action === 'pause') return api.patchTorrent(hash, { action: 'pause' }).catch(err => toast(err.message, 'error'))
  if (action === 'resume') return api.patchTorrent(hash, { action: 'resume' }).catch(err => toast(err.message, 'error'))
  if (action === 'recheck') return api.patchTorrent(hash, { action: 'recheck' }).catch(err => toast(err.message, 'error'))
  if (action === 'remove') return confirmRemove(hash, t.dataset.done === '1')
  if (action === 'scan') return api.scan(hash).then(() => toast('Scan started')).catch(err => toast(err.message, 'error'))
  if (action === 'vt') return api.virusTotal(hash).then(r => toast(r.text || 'VirusTotal: ' + r.result)).catch(err => toast(err.message, 'error'))
  if (action === 'clear-done') return clearDone()
  if (action === 'clear-log') { state.logs = []; renderLogs() }
  if (action === 'priority') return setPriority(hash, t.dataset.file, Number(t.dataset.value))
  if (action === 'copy-magnet') {
    navigator.clipboard.writeText(t.dataset.value || state.torrents.get(hash)?.magnetURI || '').then(() => toast('Magnet copied'))
  }
  if (action === 'add-done') { openAddModal() }
  if (action === 'open-file') return openDrawer(t.dataset.hash)
  if (action === 'theme') {
    const cur = state.dirtySettings?.ui_theme ?? state.settings.ui_theme
    const next = cur === 'dark' ? 'light' : cur === 'light' ? 'auto' : 'dark'
    updateDraft('ui_theme', next)
    applyTheme()
  }
  if (action === 'save-settings') return saveSettings()
  if (action === 'reset-token') {
    updateDraft('api_token', crypto.randomUUID())
    renderSettings()
  }
}

/* -------------------------------- torrents ------------------------------- */
function renderTorrents () {
  const rows = [...state.torrents.values()].filter(t => {
    if (!state.query) return true
    return (t.name || '').toLowerCase().includes(state.query.toLowerCase()) ||
      t.infoHash.includes(state.query.toLowerCase())
  })
  rows.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))

  const doneCount = [...state.torrents.values()].filter(t => t.done).length
  els.view.innerHTML = rows.length
    ? `
    <div class="list-head" role="row">
      <div>Name</div><div>Status</div><div>Progress</div><div>Speed</div><div class="col-eta">ETA</div>
    </div>
    <div role="list">${rows.map(renderRow).join('')}</div>`
    : emptyState()

  $('#foot').textContent = `${state.torrents.size} torrent${state.torrents.size === 1 ? '' : 's'} · ${doneCount} done`
}

function renderRow (t) {
  const st = statusOf(t)
  const hash = t.infoHash
  return `
  <div class="torrent-row" role="listitem" data-hash="${esc(hash)}" data-action="open-file" tabindex="0" aria-selected="false">
    <div class="name">
      <span class="dot ${st}" aria-hidden="true"></span>
      <span class="tname" title="${esc(t.name)}">${esc(t.name || hash)}</span>
    </div>
    <div class="mute">${STATUS_LABEL[st]}</div>
    <div class="progress-wrap">
      <div class="bar" role="progressbar" aria-valuenow="${pct(t)}" aria-valuemin="0" aria-valuemax="100" aria-label="Progress of ${esc(t.name)}"><i style="width:${pct(t)}%"></i></div>
      <span class="progress-text">${pct(t)}% · ${fmtBytes(t.downloaded)} / ${fmtBytes(t.length)}</span>
    </div>
    <div class="speed">
      <span class="down" title="Download">▼ ${fmtSpeed(t.downloadSpeed)}</span>
      <span class="up" title="Upload">▲ ${fmtSpeed(t.uploadSpeed)}</span>
    </div>
    <div class="eta">${t.done ? '✓' : fmtEta(t.timeRemaining)}</div>
  </div>`
}

function emptyState () {
  return `
  <div class="empty">
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M12 50c-6 0-9-3.5-9-9s3-9 9-9h5M52 50c6 0 9-3.5 9-9s-3-9-9-9h-5" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="32" cy="30" r="7" stroke="currentColor" stroke-width="3"/><path d="M32 8v13M22 14l10-6 10 6" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <p>${state.query ? `No torrents match “${esc(state.query)}”.` : 'No torrents yet — add a magnet link or a .torrent file.'}</p>
    ${state.query ? '' : '<button class="btn primary" data-action="add-done">＋ Add your first torrent</button>'}
  </div>`
}

async function refreshTorrents () {
  try {
    const list = await api.listTorrents()
    list.forEach(t => state.torrents.set(t.infoHash, t))
    if (state.view === 'torrents') renderTorrents()
  } catch (err) { toast(`Could not load torrents: ${err.message}`, 'error') }
}

function notifyDone (t) {
  toast(`Finished: ${t.name}`, 'success')
  if (state.settings.notify_done && 'Notification' in window && Notification.permission === 'granted') {
    new Notification('NimbusBT — download complete', { body: t.name })
  }
  if (state.settings.notify_done && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission()
  }
}

/* ------------------------------ add modal ------------------------------- */
function openAddModal () {
  const m = document.createElement('div')
  m.className = 'modal-backdrop'
  m.innerHTML = `
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="add-title">
    <div class="row">
      <h2 id="add-title">Add torrent</h2>
      <button class="btn icon close" data-action="add-close" aria-label="Close">✕</button>
    </div>
    <div class="field">
      <label for="add-magnet">Magnet link or info hash</label>
      <textarea id="add-magnet" rows="3" placeholder="magnet:?xt=urn:btih:…"></textarea>
    </div>
    <div class="dropzone" id="add-drop" role="button" tabindex="0" aria-label="Choose a .torrent file">
      <div>Drop a <strong>.torrent</strong> file here or click to browse</div>
      <input id="add-file" type="file" accept=".torrent,application/x-bittorrent" class="hidden">
    </div>
    <div class="row">
      <div class="field grow">
        <label for="add-path">Save to (optional)</label>
        <input id="add-path" type="text" placeholder="${esc(state.settings.download_dir || 'default download dir')}">
      </div>
    </div>
    <div class="row">
      <label class="switch"><input id="add-private" type="checkbox"> <span>Private torrent</span></label>
      <label class="switch"><input id="add-paused" type="checkbox"> <span>Start paused</span></label>
    </div>
    <div class="row text-right">
      <button class="btn" data-action="add-close">Cancel</button>
      <button class="btn primary" id="add-submit">Add</button>
    </div>
  </div>`
  document.body.appendChild(m)
  $('#add-drop', m).addEventListener('click', () => $('#add-file', m).click())
  $('#add-file', m).addEventListener('change', e => {
    if (e.target.files[0]) $('#add-drop', m).firstChild.textContent = `Selected: ${e.target.files[0].name}`
  })
  ;['dragover', 'dragenter'].forEach(ev => m.addEventListener(ev, e => {
    e.preventDefault(); $('#add-drop', m).classList.add('over')
  }))
  ;['dragleave', 'drop'].forEach(ev => m.addEventListener(ev, e => { e.preventDefault(); $('#add-drop', m).classList.remove('over') }))
  m.addEventListener('drop', e => {
    const f = e.dataTransfer?.files?.[0]
    if (f) {
      $('#add-file', m).files = e.dataTransfer.files
      $('#add-drop', m).firstChild.textContent = `Selected: ${f.name}`
    }
  })
  $('#add-submit', m).addEventListener('click', async () => {
    const btn = $('#add-submit', m)
    btn.disabled = true
    btn.textContent = 'Adding…'
    try {
      const opts = {
        savePath: $('#add-path', m).value || undefined,
        private: $('#add-private', m).checked || undefined,
        paused: $('#add-paused', m).checked || undefined
      }
      const file = $('#add-file', m).files[0]
      if (file) await api.addFile(file, opts)
      else {
        const magnet = $('#add-magnet', m).value.trim()
        if (!magnet) throw new Error('Enter a magnet link or choose a file')
        await api.addMagnet(magnet, opts)
      }
      m.remove()
      await refreshTorrents()
    } catch (err) {
      toast(err.message, 'error')
      btn.disabled = false
      btn.textContent = 'Add'
    }
  })
  const close = () => m.remove()
  m.addEventListener('click', e => { if (e.target === m) close() })
  m.querySelector('[data-action="add-close"]').addEventListener('click', close)
  $('#add-magnet', m).focus()
}

/* ------------------------------ detail drawer ---------------------------- */
async function openDrawer (hash) {
  state.selected = hash
  let data
  try { data = await api.getTorrent(hash) } catch (err) { toast(err.message, 'error'); return }
  state.torrents.set(hash, data)

  let d = $('#drawer')
  if (d) d.remove()
  d = document.createElement('div')
  d.id = 'drawer'
  d.className = 'drawer'
  d.setAttribute('role', 'dialog')
  d.setAttribute('aria-label', `Details for ${data.name}`)
  document.body.appendChild(d)
  renderDrawer(d, data)
  requestAnimationFrame(() => $('#drawer-close', d)?.focus())
}

function renderDrawer () {
  const d = $('#drawer')
  if (!d) return
  const t = state.torrents.get(state.selected)
  if (!t) return
  const st = statusOf(t)
  d.innerHTML = `
  <div class="dhead">
    <div>
      <span class="dot ${st}" aria-hidden="true"></span>
    </div>
    <h2>${esc(t.name)}</h2>
    <button class="btn icon close" id="drawer-close" aria-label="Close details">✕</button>
  </div>
  <div class="dbody">
    <div class="row">
      <button class="btn" data-action="${t.paused ? 'resume' : 'pause'}" data-hash="${esc(t.infoHash)}">${t.paused ? '▶ Resume' : '⏸ Pause'}</button>
      <button class="btn" data-action="recheck" data-hash="${esc(t.infoHash)}">⟳ Recheck</button>
      <button class="btn" data-action="copy-magnet" data-hash="${esc(t.infoHash)}" data-value="${esc(t.magnetURI)}">🔗 Copy magnet</button>
      <button class="btn" data-action="scan" data-hash="${esc(t.infoHash)}">🛡 Scan files</button>
      <button class="btn danger" data-action="remove" data-hash="${esc(t.infoHash)}" data-done="${t.done ? 1 : 0}">🗑 Remove</button>
    </div>

    <div class="stat-grid">
      <div class="stat"><div class="k">Status</div><div class="v">${STATUS_LABEL[st]}</div></div>
      <div class="stat"><div class="k">Progress</div><div class="v">${pct(t)}%</div></div>
      <div class="stat"><div class="k">Size</div><div class="v">${fmtBytes(t.length)}</div></div>
      <div class="stat"><div class="k">Downloaded</div><div class="v">${fmtBytes(t.downloaded)}</div></div>
      <div class="stat"><div class="k">Uploaded</div><div class="v">${fmtBytes(t.uploaded)}</div></div>
      <div class="stat"><div class="k">Ratio</div><div class="v">${(t.ratio || 0).toFixed(2)}</div></div>
      <div class="stat"><div class="k">↓ Speed</div><div class="v">${fmtSpeed(t.downloadSpeed)}</div></div>
      <div class="stat"><div class="k">↑ Speed</div><div class="v">${fmtSpeed(t.uploadSpeed)}</div></div>
      <div class="stat"><div class="k">Seeds</div><div class="v">${t.seeders ?? t.numPeers ?? 0}</div></div>
      <div class="stat"><div class="k">Peers</div><div class="v">${t.numPeers ?? 0}</div></div>
      <div class="stat"><div class="k">ETA</div><div class="v">${t.done ? '✓' : fmtEta(t.timeRemaining)}</div></div>
      <div class="stat"><div class="k">Info hash</div><div class="v mono">${esc(t.infoHash)}</div></div>
    </div>

    ${t.files?.length ? `
      <div>
        <div class="sec-title">Files (${t.files.length})</div>
        <table>
          <thead><tr><th>Name</th><th>Size</th><th>Priority</th><th></th></tr></thead>
          <tbody>
            ${t.files.map(f => `
              <tr>
                <td>${esc(f.name)}</td>
                <td>${fmtBytes(f.length)}</td>
                <td>
                  <button class="priority-btn ${(f.priority ?? 1) === 0 ? 'active' : ''}" data-action="priority" data-hash="${esc(t.infoHash)}" data-file="${f.id ?? f.index ?? ''}" data-value="0" title="Deselect (skip download)">skip</button>
                  <button class="priority-btn ${(f.priority ?? 1) === 1 ? 'active' : ''}" data-action="priority" data-hash="${esc(t.infoHash)}" data-file="${f.id ?? f.index ?? ''}" data-value="1" title="Normal">norm</button>
                  <button class="priority-btn ${(f.priority ?? 1) === 2 ? 'active' : ''}" data-action="priority" data-hash="${esc(t.infoHash)}" data-file="${f.id ?? f.index ?? ''}" data-value="2" title="High priority">high</button>
                </td>
                <td class="mute">${fmtBytes(f.downloaded || 0)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : ''}

    ${t.peers?.length ? `
      <div>
        <div class="sec-title">Peers (${t.peers.length})</div>
        <table>
          <thead><tr><th>Address</th><th>↓</th><th>↑</th><th>%</th></tr></thead>
          <tbody>
            ${t.peers.map(p => `
              <tr>
                <td class="mono">${esc(p.address || '')}</td>
                <td>${fmtSpeed(p.downloadSpeed)}</td>
                <td>${fmtSpeed(p.uploadSpeed)}</td>
                <td>${Math.round((p.progress || 0) * 100)}%</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : ''}

    ${t.trackers?.length ? `
      <div>
        <div class="sec-title">Trackers (${t.trackers.length})</div>
        <table>
          <tbody>
            ${t.trackers.map(tk => `<tr><td class="mono">${esc(tk)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>` : ''}

    ${t.error ? `<div class="mute">${esc(t.error)}</div>` : ''}
  </div>`

  const close = () => closeDrawer()
  d.querySelector('#drawer-close').addEventListener('click', close)
  d.addEventListener('keydown', e => { if (e.key === 'Escape') close() })
}

function closeDrawer () {
  state.selected = null
  $('#drawer')?.remove()
}

async function setPriority (hash, file, value) {
  try {
    await api.filePriority(hash, file, value)
    const t = state.torrents.get(hash)
    if (t?.files) {
      t.files.forEach(f => { if ((f.id ?? f.index ?? '') === file) f.priority = value })
      renderDrawer()
    }
  } catch (err) { toast(err.message, 'error') }
}

async function confirmRemove (hash, done) {
  const t = state.torrents.get(hash)
  if (!t) return
  const body = document.createElement('div')
  body.className = 'modal-backdrop'
  body.innerHTML = `
  <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="rm-title">
    <h2 id="rm-title">Remove “${esc(t.name)}”?</h2>
    <p class="hint">${done ? 'This torrent is fully downloaded. Removing it does not delete your files.' : 'The download is incomplete.'}</p>
    <div class="row text-right">
      <button class="btn" data-action="rm-no">Cancel</button>
      <button class="btn" data-action="rm-yes">Remove torrent</button>
      <button class="btn danger" data-action="rm-del">Remove + delete files</button>
    </div>
  </div>`
  document.body.appendChild(body)
  const close = () => body.remove()
  body.addEventListener('click', async e => {
    const a = e.target.closest('[data-action]')?.dataset.action
    if (!a) { if (e.target === body) close(); return }
    if (a === 'rm-no') return close()
    try {
      await api.remove(hash, a === 'rm-del')
      toast(a === 'rm-del' ? 'Torrent removed and files deleted' : 'Torrent removed', 'success')
      close()
    } catch (err) { toast(err.message, 'error') }
  })
  body.querySelector('[data-action="rm-no"]').focus()
}

async function clearDone () {
  const done = [...state.torrents.values()].filter(t => t.done)
  for (const t of done) {
    try { await api.remove(t.infoHash, false) } catch {}
  }
  toast(`Cleared ${done.length} finished torrent${done.length === 1 ? '' : 's'}`, 'success')
}

/* -------------------------------- settings ------------------------------- */
function updateDraft (key, value) {
  state.dirtySettings = { ...(state.dirtySettings || state.settings), [key]: value }
}

function renderSettings () {
  const s = { ...state.settings, ...state.dirtySettings }
  const section = (title, body) => `<div class="card"><h3>${title}</h3>${body}</div>`
  els.view.innerHTML = `
  <div class="settings-grid">
    ${section('General', `
      <div class="field"><label for="set-download_dir">Download directory</label><input id="set-download_dir" type="text" data-key="download_dir" value="${esc(s.download_dir)}"></div>
      <div class="field"><label for="set-torrent_port">Listening port</label><input id="set-torrent_port" type="number" data-key="torrent_port" value="${esc(s.torrent_port)}"></div>
      <div class="field"><label for="set-private">Private mode by default</label><input id="set-private" type="checkbox" data-key="private_mode_default" data-check ${s.private_mode_default ? 'checked' : ''}></div>
      <div class="field"><label for="set-autostart">Start new torrents paused</label><input id="set-autostart" type="checkbox" data-key="autostart_paused" data-check ${s.autostart_paused ? 'checked' : ''}></div>
      <div class="field"><label for="set-theme">Theme</label><select id="set-theme" data-key="ui_theme">
        <option value="dark" ${s.ui_theme === 'dark' ? 'selected' : ''}>Dark</option>
        <option value="light" ${s.ui_theme === 'light' ? 'selected' : ''}>Light</option>
        <option value="auto" ${s.ui_theme === 'auto' ? 'selected' : ''}>Auto</option>
      </select></div>
      <div class="field"><label for="set-notify">Notify when downloads finish</label><input id="set-notify" type="checkbox" data-key="notify_done" data-check ${s.notify_done ? 'checked' : ''}></div>
    `)}
    ${section('Protocols', `
      <div class="field"><label for="set-dht">DHT (BEP-5)</label><input id="set-dht" type="checkbox" data-key="dht" data-check ${s.dht ? 'checked' : ''}></div>
      <div class="field"><label for="set-lsd">Local Peer Discovery (BEP-14)</label><input id="set-lsd" type="checkbox" data-key="lsd" data-check ${s.lsd ? 'checked' : ''}></div>
      <div class="field"><label for="set-utp">uTP (BEP-29)</label><input id="set-utp" type="checkbox" data-key="utp" data-check ${s.utp ? 'checked' : ''}></div>
      <div class="field"><label for="set-webseeds">Web seeds (BEP-19)</label><input id="set-webseeds" type="checkbox" data-key="web_seeds" data-check ${s.web_seeds ? 'checked' : ''}></div>
      <div class="hint">PEX (BEP-11) is always enabled.</div>
    `)}
    ${section('Limits & scheduling', `
      <div class="field"><label for="set-dl-limit">Download limit (KiB/s, 0 = unlimited)</label><input id="set-dl-limit" type="number" data-key="download_limit" value="${esc(s.download_limit)}"></div>
      <div class="field"><label for="set-ul-limit">Upload limit (KiB/s, 0 = unlimited)</label><input id="set-ul-limit" type="number" data-key="upload_limit" value="${esc(s.upload_limit)}"></div>
      <div class="field"><label for="set-maxconns">Max connections</label><input id="set-maxconns" type="number" data-key="max_peers" value="${esc(s.max_peers)}"></div>
      <div class="hint">Scheduled speed windows (JSON, optional):
        <textarea id="set-schedule" rows="4" data-key="speed_schedule" class="mono">${esc(JSON.stringify(s.speed_schedule || [], null, 2))}</textarea>
      </div>
    `)}
    ${section('Security', `
      <div class="field"><label for="set-api-token">API token</label>
        <div class="row"><input id="set-api-token" type="text" data-key="api_token" value="${esc(s.api_token)}" style="flex:1"><button class="btn" data-action="reset-token">Regenerate</button></div>
      </div>
      <div class="field"><label for="set-api-host">Bind address</label><input id="set-api-host" type="text" data-key="api_host" value="${esc(s.api_host)}"></div>
      <div class="field"><label for="set-api-port">Web UI port</label><input id="set-api-port" type="number" data-key="api_port" value="${esc(s.api_port)}"></div>
      <div class="field"><label for="set-blocklist">Enable blocklist</label><input id="set-blocklist" type="checkbox" data-key="blocklist_enabled" data-check ${s.blocklist_enabled ? 'checked' : ''}></div>
      <div class="field"><label for="set-blocklist-url">Blocklist URL or path</label><input id="set-blocklist-url" type="text" data-key="blocklist_url" value="${esc(s.blocklist_url)}"></div>
      <div class="hint">PeerGuardian / PGL format is supported. Applied on save.</div>
      <div class="field"><label for="set-proxy">SOCKS proxy for peer traffic</label><input id="set-proxy" type="text" data-key="proxy" placeholder="socks5h://user:pass@127.0.0.1:9050" value="${esc(s.proxy || '')}"></div>
      <div class="hint">Routes all outgoing peer TCP connections through the proxy (DNS resolved by proxy). Empty = direct. Peer traffic only; tracker announces still use HTTPS.</div>
    `)}
    ${section('Malware scanning', `
      <div class="field"><label for="set-scan">Scan completed files</label><input id="set-scan" type="checkbox" data-key="malware_scan" data-check ${s.malware_scan ? 'checked' : ''}></div>
      <div class="field"><label for="set-scan-cmd">Scanner command (e.g. clamscan)</label><input id="set-scan-cmd" type="text" data-key="scanner_command" value="${esc(s.scanner_command)}"></div>
      <div class="field"><label for="set-vt">VirusTotal API key</label><input id="set-vt" type="password" data-key="virus_total_key" value="${esc(s.virus_total_key)}"></div>
    `)}
  </div>
  <div class="row" style="margin-top:16px">
    <button class="btn primary" data-action="save-settings">Save settings</button>
    <span class="hint" id="set-msg"></span>
  </div>`

  els.view.querySelectorAll('[data-key]').forEach(inp => {
    if (inp.type === 'checkbox') {
      inp.addEventListener('change', () => updateDraft(inp.dataset.key, inp.checked))
    } else if (inp.id === 'set-schedule') {
      let timer
      inp.addEventListener('input', () => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          try { updateDraft('speed_schedule', JSON.parse(inp.value)) } catch { $('#set-msg').textContent = 'Schedule JSON is invalid' }
        }, 400)
      })
    } else {
      inp.addEventListener('input', () => updateDraft(inp.dataset.key, inp.type === 'number' ? Number(inp.value) : inp.value))
    }
  })
  $('#set-theme').addEventListener('change', applyTheme)
}

async function saveSettings () {
  const patch = state.dirtySettings
  if (!patch) return
  try {
    await api.saveSettings(patch)
    state.settings = { ...state.settings, ...patch }
    state.dirtySettings = null
    applyTheme()
    $('#set-msg').textContent = 'Saved'
    setTimeout(() => { $('#set-msg').textContent = '' }, 2000)
  } catch (err) {
    $('#set-msg').textContent = err.message
  }
}

async function refreshSettings () {
  try {
    state.settings = await api.settings()
    applyTheme()
  } catch (err) {
    toast(`Could not load settings: ${err.message}`, 'error')
  }
}

/* --------------------------------- logs ---------------------------------- */
function renderLogs () {
  els.view.innerHTML = `
  <div class="row" style="margin-bottom:10px">
    <button class="btn" data-action="clear-log">Clear</button>
    <span class="hint" id="log-conn">${state.connected ? '● live' : '○ offline'} — log streams over WebSocket</span>
  </div>
  <div>${state.logs.map(l => `
    <div class="log-entry ${esc(l.level || 'info')}">
      <span class="t">${l.time ? new Date(l.time).toLocaleTimeString() : ''}</span>
      <span class="m">${esc(l.message || '')}</span>
    </div>`).join('') || '<div class="empty">No log entries yet.</div>'}
  </div>`
}

/* --------------------------------- about --------------------------------- */
function renderAbout () {
  const s = { ...state.settings, ...state.dirtySettings }
  const proxyOn = !!s.proxy
  els.view.innerHTML = `
  <div class="settings-grid">
    <div class="card">
      <h3>NimbusBT ${esc(state.version || '')}</h3>
      <p class="hint">A modern, privacy-first BitTorrent client built on Node.js + WebTorrent. No telemetry, no analytics, and all local traffic stays on this machine.</p>
      <table>
        <tbody>
          <tr><td>Web UI bind</td><td class="text-right">${esc(s.api_host)}:${esc(s.api_port)}</td></tr>
          <tr><td>Download dir</td><td class="text-right">${esc(s.download_dir)}</td></tr>
          <tr><td>SOCKS proxy</td><td class="text-right">${proxyOn ? esc(s.proxy) : 'off (direct connections)'}</td></tr>
          <tr><td>Blocklist</td><td class="text-right">${s.blocklist_enabled && s.blocklist_url ? 'on' : 'off'}</td></tr>
          <tr><td>Malware scan</td><td class="text-right">${s.malware_scan ? 'on' : 'off'}</td></tr>
        </tbody>
      </table>
    </div>
    <div class="card">
      <h3>Security checklist</h3>
      <ul class="hint">
        <li>Token-authenticated REST + WebSocket API (bearer token)</li>
        <li>Strict Content-Security-Policy; no inline scripts</li>
        <li>Optional blocklist (PeerGuardian / PGL format)</li>
        <li>Optional on-download malware scan (clamscan or custom command)</li>
        <li>Optional VirusTotal lookup by info hash</li>
        <li>Invalid handshakes are rejected by the engine (regression-tested)</li>
        <li>Optional SOCKS4/5 proxy tunnels all outgoing peer traffic (proxy-side DNS)</li>
      </ul>
    </div>
    <div class="card">
      <h3>Recommended configuration</h3>
      <ul class="hint">
        <li>Keep the Web UI bound to 127.0.0.1 (or LAN) and never run with an empty API token.</li>
        <li>For privacy, use a VPN or a SOCKS proxy and update the blocklist regularly.</li>
        <li>Enable the malware scanner if you download executables or archives.</li>
        <li>Keep NimbusBT updated; BitTorrent exposes your IP to peers by design.</li>
      </ul>
    </div>
    <div class="card">
      <h3>Known limitations</h3>
      <ul class="hint">
        <li>Wire encryption (MSE/PE) is not offered by the underlying WebTorrent stack; uTP provides congestion control, not encryption.</li>
        <li>The SOCKS proxy covers peer TCP traffic; tracker announces still use HTTPS directly.</li>
        <li>DHT/PEX/LSD are disabled in private torrent mode.</li>
      </ul>
    </div>
  </div>`
}

/* ------------------------------ keyboard nav ----------------------------- */
function onKey (e) {
  if (e.target.matches('input, textarea, select')) return
  if (e.key === '/' ) { e.preventDefault(); els.search.focus() }
  if (e.key === 'n') { openAddModal() }
}

window.addEventListener('DOMContentLoaded', init)
