import { spawn } from 'node:child_process'
import path from 'node:path'

/**
 * Security & privacy helpers: peer blocklists (PeerGuardian P2P format),
 * malware scanning hooks (ClamAV or custom command), VirusTotal info-hash
 * lookups, and honest documentation of transport-layer limits.
 */

/**
 * Try to resolve a peer IP/addr string to a bare host (strip port).
 * @param {string} addr
 * @returns {string}
 */
export function hostOf (addr) {
  if (!addr) return ''
  const s = String(addr).trim()
  if (s.startsWith('[')) {
    const end = s.indexOf(']')
    if (end !== -1) return s.slice(1, end)
    return s.replace(/^\[|\]$/g, '')
  }
  const maybePort = s.lastIndexOf(':')
  if (maybePort === -1) return s
  // Bare IPv6 contains multiple colons — treat the whole thing as a host.
  if (s.indexOf(':') !== maybePort) return s
  const rest = s.slice(maybePort + 1)
  if (/^\d+$/.test(rest)) return s.slice(0, maybePort)
  return s
}

/**
 * Parse a PeerGuardian / eMule style blocklist into {start, end} ranges.
 * Supports `comment: A.B.C.D - E.F.G.H`, `A.B.C.D`, and CIDR `A.B.C.D/n`.
 * @param {string} text
 * @returns {string[]}
 */
export function parsePeerGuardian (text) {
  const ranges = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^\s*(?:[^#].*?\s*:\s*)?([a-f0-9.:]+)(?:\s*-\s*([a-f0-9.:]+))?\s*$/)
    if (m) {
      ranges.push(m[2] ? `${m[1]}-${m[2]}` : m[1])
    } else {
      const c = line.match(/^\s*(?:[^#].*?\s*:\s*)?([0-9.:]+)\/([0-9]{1,2})\s*$/)
      if (c) ranges.push(`${c[1]}/${c[2]}`)
    }
  }
  return ranges
}

/**
 * Load a blocklist from a URL, local file path, or inline text and return the
 * IP set object accepted by WebTorrent's `client.blocked`.
 * @param {string} source URL, path or inline list
 * @param {object} [opts]
 * @returns {Promise<object|null>} the loaded ip-set (or null on failure)
 */
export async function loadBlocklist (source, opts = {}) {
  if (!source) return null
  const { loadIPSet } = await import('load-ip-set')
  return new Promise((resolve) => {
    loadIPSet(source, { headers: { 'user-agent': 'NimbusBT/0.1 (+https://github.com/nimbusbt/nimbusbt)' }, ...opts }, (err, ipSet) => {
      if (err) return resolve(null)
      resolve(ipSet)
    })
  })
}

/**
 * Apply a blocklist to a WebTorrent client instance.
 * @param {import('webtorrent').WebTorrent} client
 * @param {string|null} source
 */
export async function applyBlocklist (client, source) {
  if (!source) {
    client.blocked = null
    return { ok: true, entries: 0 }
  }
  const ipSet = await loadBlocklist(source)
  if (!ipSet) return { ok: false, entries: 0 }
  client.blocked = ipSet
  return { ok: true, entries: countEntries(source) }
}

function countEntries (source) {
  if (/^https?:\/\//.test(source) || source.includes('\n')) return -1
  return 0
}

/**
 * Run a malware scanner against a directory/file list.
 * If `scannerCommand` is configured it is used; otherwise falls back to
 * `clamscan -r` if present on PATH.
 *
 * Output buffers are capped to prevent unbounded memory growth and the child
 * is SIGKILLed if it does not exit within `timeoutMs`.
 * @param {string[]} targets absolute file/dir paths
 * @param {string} [scannerCommand]
 * @param {number} [timeoutMs]
 * @returns {Promise<{status: 'clean'|'infected'|'error', detail: string}>}
 */
export function scanPaths (targets, scannerCommand = '', timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    const parts = scannerCommand ? scannerCommand.trim().split(/\s+/) : []
    const bin = parts[0] || 'clamscan'
    const args = scannerCommand ? parts.slice(1) : ['-r']
    const proc = spawn(bin, [...args, ...targets], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let done = false
    const MAX_OUT = 64 * 1024
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (proc.exitCode === null) proc.kill('SIGKILL')
      resolve(value)
    }
    proc.stdout.on('data', d => {
      if (out.length < MAX_OUT) out += d
    })
    proc.stderr.on('data', d => {
      if (err.length < MAX_OUT) err += d
    })
    proc.on('error', (e) => {
      finish({ status: 'error', detail: `Scanner unavailable: ${e.message}` })
    })
    proc.on('close', (code) => {
      if (done) return
      const lower = out.toLowerCase()
      if (code === 0 || lower.includes('no virus') || lower.includes('clean')) {
        finish({ status: 'clean', detail: out.trim() || 'No threats found.' })
      } else if (lower.includes('found') || code === 1) {
        finish({ status: 'infected', detail: out.trim() || 'Infection reported.' })
      } else {
        finish({ status: 'error', detail: err.trim() || out.trim() || `Exited with code ${code}` })
      }
    })
    const timer = setTimeout(() => {
      finish({ status: 'error', detail: `Scanner timed out after ${Math.round(timeoutMs / 1000)}s` })
    }, timeoutMs)
    timer.unref?.()
  })
}

/**
 * Optional VirusTotal info-hash reputation lookup (transparent, opt-in).
 * @param {string} infoHash
 * @param {string} apiKey
 * @returns {Promise<object|null>}
 */
export async function checkVirusTotal (infoHash, apiKey) {
  if (!apiKey) return null
  const res = await fetch(`https://www.virustotal.com/api/v3/files/${infoHash}`, {
    headers: { 'x-apikey': apiKey }
  })
  if (!res.ok) return { error: `HTTP ${res.status}` }
  const json = await res.json()
  const attrs = json?.data?.attributes || {}
  return {
    stats: attrs.last_analysis_stats || {},
    malicious: attrs.last_analysis_stats?.malicious ?? 0
  }
}

/**
 * Resolve the full on-disk path for a torrent file entry.
 * @param {object} file webtorrent File
 * @param {string} savePath
 */
export function fileDiskPath (file, savePath) {
  return path.join(savePath, file.path)
}

export function ipLeakWarning () {
  return 'BitTorrent inherently exposes your IP address to every peer you connect to. ' +
    'For anonymity route all traffic through a VPN at the OS level; the application-level ' +
    'SOCKS proxy option is not supported by the WebTorrent engine and is intentionally ' +
    'not faked.'
}
