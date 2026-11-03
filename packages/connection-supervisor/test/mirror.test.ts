import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

// The phone app cannot import this package, so it runs a byte-for-byte copy.
// This suite reads both, so a change to either copy fails here until the other
// matches. `.gitattributes` keeps both at LF, so a checkout's line endings
// cannot make them differ.

const SOURCE = join(process.cwd(), 'packages/connection-supervisor/src/connectionSupervisor.ts')
const MIRROR = join(process.cwd(), 'mobile/src/shared/connection-supervisor/connectionSupervisor.ts')

test('the phone app runs this same supervisor, byte for byte', () => {
  expect(readFileSync(MIRROR).equals(readFileSync(SOURCE))).toBe(true)
})
