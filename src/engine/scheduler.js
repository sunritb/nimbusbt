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
 * Scheduler that re-applies limits whenever an active rule changes
 * (checked every 30 seconds and at each setLimits call).
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
  }

  start () {
    this.refresh()
    this.timer = setInterval(() => this.refresh(), 30_000)
    this.timer.unref?.()
  }

  stop () {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  refresh () {
    const limits = effectiveLimits(this.rules(), this.base())
    this.apply(limits)
  }
}
