/**
 * Time-of-day bandwidth scheduler.
 *
 * Rules look like:
 *   { "days": [0,1,2,3,4,5,6], "start": "00:00", "end": "07:00",
 *     "download": 0, "upload": 0 }
 * `download`/`upload` are bytes/second; 0 means fully paused, -1 means unlimited.
 * `days` are JS getDay() indices (0 = Sunday). `days` may be omitted (every day).
 */
export function minutesOfDay (hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
}

/**
 * Find the effective rule at a given moment.
 * @param {Array} rules
 * @param {Date} [now]
 * @returns {object|null}
 */
export function activeRule (rules, now = new Date()) {
  if (!Array.isArray(rules) || rules.length === 0) return null
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const today = now.getDay()
  const candidates = []
  for (const rule of rules) {
    const days = rule.days
    if (Array.isArray(days) && !days.includes(today)) continue
    const start = minutesOfDay(rule.start)
    const end = minutesOfDay(rule.end)
    if (start === end) continue
    let inside
    if (start < end) {
      inside = nowMin >= start && nowMin < end
    } else {
      // wraps past midnight, e.g. 22:00 -> 06:00
      inside = nowMin >= start || nowMin < end
    }
    if (inside) candidates.push(rule)
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  return candidates[0]
}

/**
 * Compute effective speed limits (bytes/sec) for now.
 * @param {Array} rules
 * @param {object} base {download, upload} manual limits
 * @param {Date} [now]
 * @returns {{download: number, upload: number}}
 */
export function effectiveLimits (rules, base, now = new Date()) {
  const rule = activeRule(rules, now)
  if (!rule) return { download: base.download, upload: base.upload }
  return {
    download: Number.isFinite(rule.download) ? rule.download : base.download,
    upload: Number.isFinite(rule.upload) ? rule.upload : base.upload
  }
}

/**
 * Milliseconds until the next rule boundary (a rule start or end), or null
 * when no boundaries exist. Used to schedule precise limit re-applications
 * instead of polling every N seconds.
 * @param {Array} rules
 * @param {Date} [now]
 * @returns {number|null}
 */
export function nextRuleChange (rules, now = new Date()) {
  if (!Array.isArray(rules) || rules.length === 0) return null
  const boundaries = new Set()
  for (const rule of rules) {
    if (Array.isArray(rule.days) && rule.days.length === 0) continue
    boundaries.add(minutesOfDay(rule.start))
    boundaries.add(minutesOfDay(rule.end))
  }
  if (boundaries.size === 0) return null
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const nowMs = now.getTime()
  let best = Infinity
  for (const m of boundaries) {
    if (m > nowMin) {
      const t = new Date(now)
      t.setHours(0, m, 0, 0)
      best = Math.min(best, t.getTime() - nowMs)
    }
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(0, m, 0, 0)
    best = Math.min(best, tomorrow.getTime() - nowMs)
  }
  return best
}

/**
 * Scheduler that re-applies limits at every rule boundary, plus on each
 * refresh() call. When no rules are configured it idles without a timer.
 */
export class SpeedScheduler {
  /**
   * @param {object} opts
   * @param {(limits: {download:number, upload:number}) => void} opts.apply callback
   * @param {() => {download:number, upload:number}} opts.base callback returning manual limits
   * @param {() => Array} opts.rules callback returning schedule rules
   */
  constructor ({ apply, base, rules }) {
    this.apply = apply
    this.base = base
    this.rules = rules
    this.timer = null
    this._onTimer = () => this._scheduleAndApply()
  }

  start () {
    this._scheduleAndApply()
  }

  stop () {
    this._clear()
  }

  refresh () {
    this._scheduleAndApply()
  }

  _clear () {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  _scheduleAndApply () {
    this.apply(effectiveLimits(this.rules(), this.base()))
    this._clear()
    const delay = nextRuleChange(this.rules(), new Date())
    if (delay === null || !Number.isFinite(delay)) return
    // Cap so clock changes or system sleep still re-evaluate periodically.
    this.timer = setTimeout(this._onTimer, Math.min(delay, 6 * 60 * 60 * 1000))
    this.timer.unref?.()
  }
}
