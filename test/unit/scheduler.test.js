import { test } from 'node:test'
import assert from 'node:assert/strict'
import { minutesOfDay, activeRule, effectiveLimits, nextRuleChange, SpeedScheduler } from '../../src/engine/scheduler.js'

const at = (hhmm, day) => {
  const d = new Date(2026, 0, 4 + day) // 2026-01-04 is a Sunday (getDay()=0)
  const [h, m] = hhmm.split(':').map(Number)
  d.setHours(h, m, 0, 0)
  return d
}

test('minutesOfDay parses HH:mm', () => {
  assert.equal(minutesOfDay('00:00'), 0)
  assert.equal(minutesOfDay('23:59'), 1439)
  assert.equal(minutesOfDay('09:30'), 570)
  assert.equal(minutesOfDay('bogus'), 0)
})

test('activeRule matches within a window', () => {
  const rules = [{ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '17:00', download: 0, upload: 0 }]
  assert.ok(activeRule(rules, at('10:00', 1)))
  assert.equal(activeRule(rules, at('08:59', 1)), null)
  assert.equal(activeRule(rules, at('17:00', 1)), null)
})

test('activeRule respects day filter', () => {
  const rules = [{ days: [1], start: '00:00', end: '23:59', download: 1 }]
  assert.ok(activeRule(rules, at('12:00', 1)))
  assert.equal(activeRule(rules, at('12:00', 2)), null)
})

test('activeRule wraps past midnight', () => {
  const rules = [{ start: '22:00', end: '06:00', download: 0 }]
  assert.ok(activeRule(rules, at('23:30', 0)))
  assert.ok(activeRule(rules, at('01:00', 1)))
  assert.equal(activeRule(rules, at('12:00', 1)), null)
})

test('activeRule prefers higher priority on overlap', () => {
  const rules = [
    { days: [1], start: '00:00', end: '23:59', download: 100, priority: 0 },
    { days: [1], start: '12:00', end: '13:00', download: 0, priority: 5 }
  ]
  const rule = activeRule(rules, at('12:30', 1))
  assert.equal(rule.download, 0)
})

test('effectiveLimits falls back to base outside rules', () => {
  const base = { download: -1, upload: 512 }
  assert.deepEqual(effectiveLimits([], base, at('10:00', 1)), base)
  const rules = [{ days: [1], start: '09:00', end: '11:00', download: 0, upload: 0 }]
  assert.deepEqual(effectiveLimits(rules, base, at('08:00', 1)), base)
  assert.deepEqual(effectiveLimits(rules, base, at('10:00', 1)), { download: 0, upload: 0 })
})

test('SpeedScheduler applies limits on start and refresh', () => {
  const applied = []
  const scheduler = new SpeedScheduler({
    apply: l => applied.push(l),
    base: () => ({ download: -1, upload: -1 }),
    rules: () => [{ start: '00:00', end: '23:59', download: 0, upload: 0 }]
  })
  scheduler.start()
  assert.equal(applied.length, 1)
  assert.deepEqual(applied[0], { download: 0, upload: 0 })
  scheduler.stop()
})

test('nextRuleChange returns ms until the next boundary', () => {
  const rules = [{ start: '09:00', end: '17:00', download: 0 }]
  assert.equal(nextRuleChange(rules, at('10:00', 1)), 7 * 3600 * 1000)
  assert.equal(nextRuleChange(rules, at('08:00', 1)), 3600 * 1000)
  assert.equal(nextRuleChange(rules, at('17:30', 1)), 15.5 * 3600 * 1000)
})

test('nextRuleChange wraps past midnight', () => {
  const rules = [{ start: '22:00', end: '06:00', download: 0 }]
  assert.equal(nextRuleChange(rules, at('23:30', 0)), 6.5 * 3600 * 1000)
  assert.equal(nextRuleChange(rules, at('05:00', 1)), 3600 * 1000)
})

test('nextRuleChange returns null without rules', () => {
  assert.equal(nextRuleChange([]), null)
  assert.equal(nextRuleChange(null), null)
})

test('SpeedScheduler idles without a timer when no rules are set', () => {
  let applied = 0
  const scheduler = new SpeedScheduler({
    apply: () => { applied++ },
    base: () => ({ download: -1, upload: -1 }),
    rules: () => []
  })
  scheduler.start()
  assert.equal(applied, 1)
  assert.equal(scheduler.timer, null)
  scheduler.stop()
  assert.equal(applied, 1)
})

test('SpeedScheduler schedules a boundary timer and applies on refresh', () => {
  let applied = 0
  const scheduler = new SpeedScheduler({
    apply: () => { applied++ },
    base: () => ({ download: -1, upload: -1 }),
    rules: () => [{ start: '00:00', end: '23:59', download: 0, upload: 0 }]
  })
  scheduler.start()
  assert.ok(scheduler.timer && typeof scheduler.timer.ref === 'function')
  assert.equal(applied, 1)
  scheduler.refresh()
  assert.equal(applied, 2)
  scheduler.stop()
  assert.equal(scheduler.timer, null)
})
