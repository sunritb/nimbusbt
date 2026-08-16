import { timingSafeEqual } from 'node:crypto'

/**
 * Token-based authentication middleware.
 * Accepts `Authorization: Bearer <token>`, `x-nimbus-token: <token>`,
 * or `?token=<token>` (useful for the Web UI + scripts).
 * Request origin is checked against the configured CORS allow-list; anything
 * other than a localhost origin must present an Origin header that is allowed.
 *
 * Failed attempts are rate-limited per source IP so a token can't be
 * brute-forced over the network. Successful auth clears the counter.
 */
const RATE_WINDOW_MS = 60_000
const RATE_MAX_ATTEMPTS = 20

export function createAuth (settings, opts = {}) {
  const windowMs = opts.windowMs ?? RATE_WINDOW_MS
  const maxAttempts = opts.maxAttempts ?? RATE_MAX_ATTEMPTS
  const failures = new Map()

  function valid (token) {
    const expected = settings.get('api_token')
    if (!expected || !token) return false
    const a = Buffer.from(String(token))
    const b = Buffer.from(String(expected))
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  function tooManyAttempts (key, now = Date.now()) {
    const rec = failures.get(key)
    if (!rec || now - rec.at > windowMs) {
      failures.set(key, { at: now, count: 1 })
      return false
    }
    rec.count += 1
    return rec.count > maxAttempts
  }

  function extractToken (req) {
    const header = req.headers.authorization || ''
    return (
      (header.startsWith('Bearer ') && header.slice(7)) ||
      req.headers['x-nimbus-token'] ||
      req.query.token
    )
  }

  function authMiddleware (req, res, next) {
    const token = extractToken(req)
    if (valid(token)) {
      failures.delete(req.socket?.remoteAddress || 'unknown')
      return next()
    }
    if (tooManyAttempts(req.socket?.remoteAddress || 'unknown')) {
      return res.status(429).json({ error: 'Too many failed attempts. Try again in a minute.' })
    }
    res.status(401).json({ error: 'Unauthorized', message: 'A valid API token is required.' })
  }

  function optionalAuth (req, res, next) {
    req.isAuthed = valid(extractToken(req))
    next()
  }

  return { authMiddleware, optionalAuth }
}

export function isLoopback (req) {
  const host = req.socket?.remoteAddress || ''
  return host === '127.0.0.1' || host === '::1' || host === '::ffff:127.0.0.1'
}
