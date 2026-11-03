import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

// The phone app cannot import this package, so it runs a byte-for-byte copy.
// Both sides pin the same digest (the phone's in
// mobile/src/shared/connection-supervisor/connectionSupervisor.regression.test.js),
// so a change to one copy fails the build until the other matches and both pins
// move together.

const SOURCE = join(process.cwd(), 'packages/connection-supervisor/src/connectionSupervisor.ts')
const MIRROR = join(process.cwd(), 'mobile/src/shared/connection-supervisor/connectionSupervisor.ts')

test('the phone app runs this same supervisor, byte for byte', () => {
  expect(readFileSync(MIRROR).equals(readFileSync(SOURCE))).toBe(true)
  const hash = createHash('sha256')
  hash.update('connectionSupervisor.ts')
  hash.update('\0')
  hash.update(readFileSync(SOURCE))
  expect(hash.digest('hex')).toBe('e67d35f24a6d79d386f96b70693ad1b7aa538e3c860f3b026c3374bc72ed459b')
})
