import { expect, test } from 'vitest'
import { relativeFromNow } from './relativeTime'

const now = Date.UTC(2026, 9, 19, 12, 0, 0)
const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

test('a time just short of an hour away reads as an hour, not 60 minutes', () => {
  expect(relativeFromNow(now - 3_590_000, now)).toBe(RELATIVE.format(-1, 'hour'))
  expect(relativeFromNow(now + 3_590_000, now)).toBe(RELATIVE.format(1, 'hour'))
})

test('a time just short of a day away reads as a day, not 24 hours', () => {
  expect(relativeFromNow(now - 86_000_000, now)).toBe(RELATIVE.format(-1, 'day'))
  expect(relativeFromNow(now + 86_000_000, now)).toBe(RELATIVE.format(1, 'day'))
})

test('times well inside a unit read as before', () => {
  expect(relativeFromNow(now - 30_000, now)).toBe(RELATIVE.format(-30, 'second'))
  expect(relativeFromNow(now - 59_600, now)).toBe(RELATIVE.format(-1, 'minute'))
  expect(relativeFromNow(now - 5 * 60_000, now)).toBe(RELATIVE.format(-5, 'minute'))
  expect(relativeFromNow(now + 3 * 3_600_000, now)).toBe(RELATIVE.format(3, 'hour'))
  expect(relativeFromNow(now - 3 * 86_400_000, now)).toBe(RELATIVE.format(-3, 'day'))
})
