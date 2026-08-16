import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from './db.js'
import { Settings, ensureDownloadDir } from './config.js'
import { TorrentCore } from './engine/core.js'
import { createApi } from './api/routes.js'
import { Hub } from './api/ws.js'
import { createAuth, isLoopback } from './api/auth.js'
import { NAME, VERSION } from './version.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_UI = path.join(__dirname, 'webui')

export async function main (argv = process.argv.slice(2)) {
  const args = parseArgs(argv)

  const db = openDb()
  const settings = new Settings(db)
  settings.setMany({
    api_host: args.host ?? settings.get('api_host'),
    api_port: args.port ?? settings.get('api_port')
  })
  if (args.token) settings.set('api_token', args.token)
  ensureDownloadDir(settings.get('download_dir'))

  const core = new TorrentCore(settings, db)
  const { authMiddleware } = createAuth(settings)
  const app = express()

  app.disable('x-powered-by')
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; manifest-src 'self'; worker-src 'self'"
    )
    next()
  })

  app.use((req, res, next) => {
    const origin = req.headers.origin
    const allowed = settings.get('cors_origins') || []
    if (origin && (allowed.includes(origin) || allowed.includes('*'))) {
      res.setHeader('Access-Control-Allow-Origin', allowed.includes('*') ? '*' : origin)
      res.setHeader('Access-Control-Allow-Credentials', 'true')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-nimbus-token')
    }
    if (req.method === 'OPTIONS') return res.status(204).end()
    next()
  })

  app.use(express.json({ limit: '10mb' }))
  app.use(express.raw({ type: ['application/x-bittorrent', 'application/octet-stream'], limit: '10mb' }))

  // .torrent file uploads arrive as raw bytes or base64 inside JSON.
  app.use('/api', (req, res, next) => {
    if (Buffer.isBuffer(req.body)) {
      req.file = { buffer: req.body }
      req.body = {}
    }
    next()
  })

  app.get('/api/health', (req, res) => res.json({ status: 'starting' }))

  app.use('/api', authMiddleware, createApi(settings, core))

  app.use(express.static(WEB_UI, { index: false, etag: true, maxAge: '1h' }))

  app.get('/', (req, res) => {
    const local = isLoopback(req)
    res.type('html').send(indexHtml({ local, token: local ? settings.get('api_token') : '' }))
  })

  // SPA fallback
  app.get('*', (req, res) => res.redirect('/'))

  const server = await new Promise(resolve => {
    const s = app.listen(settings.get('api_port'), settings.get('api_host'), () => resolve(s))
  })

  await core.start()

  const hub = new Hub(server, settings, core)
  const addr = server.address()

  const shutdown = async (signal) => {
    console.log(`\n[server] ${signal} received, shutting down…`)
    hub.close()
    await core.stop()
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  const token = settings.get('api_token')
  const banner = `│  ${NAME} ${VERSION} — secure BitTorrent client  │`
  const bar = '┌' + '─'.repeat(banner.length - 2) + '┐'
  const bottom = '└' + '─'.repeat(banner.length - 2) + '┘'
  console.log(bar)
  console.log(banner)
  console.log(bottom)
  console.log(`  Web UI:  http://${settings.get('api_host')}:${addr.port}/`)
  console.log(`  REST:    http://${settings.get('api_host')}:${addr.port}/api`)
  console.log(`  WS:      ws://${settings.get('api_host')}:${addr.port}/ws`)
  console.log(`  API token: ${token}`)
  console.log('  Tip: bind to 0.0.0.0 and set a token to enable remote control.')
  return { server, core, settings, hub }
}

function indexHtml ({ local, token }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NimbusBT</title>
  <link rel="stylesheet" href="/css/style.css">
  <link rel="manifest" href="/manifest.webmanifest">
  <meta name="theme-color" content="#101418">
  <meta name="nimbus-token" content="${escAttr(token)}">
  <meta name="nimbus-local" content="${local ? 'true' : 'false'}">
</head>
<body>
  <div id="app"></div>
  <script src="/js/app.js" type="module"></script>
</body>
</html>`
}

function escAttr (v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const [flag, inline] = arg.split('=')
    const value = inline ?? argv[++i]
    if (flag === '--port' || flag === '-p') out.port = Number(value)
    else if (flag === '--host' || flag === '-h') out.host = value
    else if (flag === '--token' || flag === '-t') out.token = value
  }
  return out
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('[server] fatal:', err)
    process.exit(1)
  })
}
