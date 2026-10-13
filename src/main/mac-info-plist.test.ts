import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'

// The keys the packaged app's Info.plist gets from `build.mac.extendInfo`.
function macInfo(): Record<string, unknown> {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    build: { mac: { extendInfo?: Record<string, unknown> } }
  }
  return pkg.build.mac.extendInfo ?? {}
}

test('one-time codes from Messages and Mail are offered only in fields that ask for one', () => {
  // Without it macOS 26 offers a code in every text field: the composer, a
  // terminal, the editor.
  assert.equal(macInfo().NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac, true)
})
