// NimbusBT desktop entry.
//
// When run under Electron (`npm i -D electron && electron desktop/main.js`)
// the web UI opens in a native window. Otherwise it starts the local server
// and opens the system browser.
import { exec } from 'node:child_process'
import { main } from '../src/server.js'

let electron = null
try {
  electron = await import('electron')
} catch {
  electron = null
}

const { server } = await main(process.argv.slice(2))
const port = server.address().port
const url = `http://127.0.0.1:${port}/`

if (electron?.default?.app) {
  const { app, BrowserWindow } = electron.default
  app.whenReady().then(() => {
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      title: 'NimbusBT',
      autoHideMenuBar: true
    })
    win.loadURL(url)
    win.on('closed', () => {
      server.close(() => process.exit(0))
    })
  })
  app.on('window-all-closed', () => {
    server.close(() => process.exit(0))
  })
} else {
  const openCmd = process.platform === 'darwin'
    ? `open "${url}"`
    : process.platform === 'win32'
      ? `start "" "${url}"`
      : `xdg-open "${url}"`
  exec(openCmd, () => {})
  console.log(`[desktop] opened ${url}`)
  const shutdown = () => server.close(() => process.exit(0))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
