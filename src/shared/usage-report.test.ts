import assert from 'node:assert/strict'
import { test } from 'vitest'
import { formatUsageTokens } from './usage-report'

test('formatUsageTokens keeps three significant figures in each unit', () => {
  assert.equal(formatUsageTokens(436), '436')
  assert.equal(formatUsageTokens(68_800), '68.8K')
  assert.equal(formatUsageTokens(584_000_000), '584M')
  assert.equal(formatUsageTokens(11_900_000_000), '11.9B')
})

test('formatUsageTokens moves up a unit instead of printing a thousand of the one below', () => {
  assert.equal(formatUsageTokens(999), '999')
  assert.equal(formatUsageTokens(999.5), '1K')
  assert.equal(formatUsageTokens(999_499), '999K')
  assert.equal(formatUsageTokens(999_500), '1M')
  assert.equal(formatUsageTokens(999_999), '1M')
  assert.equal(formatUsageTokens(999_999_999), '1B')
  assert.equal(formatUsageTokens(999_999_999_999), '1T')
})

test('formatUsageTokens formats a negative count like its magnitude', () => {
  assert.equal(formatUsageTokens(-999_999), '-1M')
})
