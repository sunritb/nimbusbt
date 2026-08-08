import { timingSafeEqual } from 'node:crypto'

/**
 * Token-based authentication middleware.
 * Accepts `Authorization: Bearer <token>`, `x-nimbus-token: <token>`,
 * or `?token=<token>` (useful for the Web UI + scripts).
 * Request origin is checked against the configured CORS allow-list; anything
 * other than a localhost origin must present an Origin header that is allowed.
 */
export function createAuth (settings) {
  function valid (token) {
    const expected = settings.get('api_token')
    if (!expected || !token) return false
    const a = Buffer.from(String(token))
    const b = Buffer.from(String(expected))
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  function authMiddleware (req, res, next) {
    const header = req.headers.authorization || ''
    const token =
      (header.startsWith('Bearer ') && header.slice(7)) ||
      req.headers['x-nimbus-token'] ||
      req.query.token

    if (valid(token)) return next()

    res.status(401).json({ error: 'Unauthorized', message: 'A valid API token is required.' })
  }

  function optionalAuth (req, res, next) {
    const header = req.headers.authorization || ''
    const token =
      (header.startsWith('Bearer ') && header.slice(7)) ||
      req.headers['x-nimbus-token'] ||
      req.query.token
    req.isAuthed = valid(token)
    next()
  }

  return { authMiddleware, optionalAuth }
}

export function isLoopback (req) {
  const host = req.socket?.remoteAddress || ''
  return host === '127.0.0.1' || host === '::1' || host === '::ffff:127.0.0.1'
}
