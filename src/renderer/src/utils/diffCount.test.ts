import { expect, test } from 'vitest'

import { formatDiffCount } from './diffCount'

test('a count under a thousand prints as it is', () => {
  expect(formatDiffCount(0)).toBe('0')
  expect(formatDiffCount(7)).toBe('7')
  expect(formatDiffCount(999)).toBe('999')
})

test('a big count is digit-grouped in the locale the rest of the app counts in', () => {
  expect(formatDiffCount(83_065)).toBe((83_065).toLocaleString())
  expect(formatDiffCount(1_234_567)).toBe((1_234_567).toLocaleString())
  // Whatever the separator, a seven-digit count is grouped.
  expect(formatDiffCount(1_234_567)).not.toBe('1234567')
})
