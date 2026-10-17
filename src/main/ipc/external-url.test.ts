import assert from 'node:assert/strict'

import { safeExternalUrl, safeWindowExternalUrl } from './external-url'
import { test } from 'vitest'

test('external-url', async () => {
  function main(): void {
    // Accepts http and https.
    assert.deepEqual(safeExternalUrl('https://example.com/path?q=1'), {
      ok: true,
      url: 'https://example.com/path?q=1',
    })
    assert.deepEqual(safeExternalUrl('http://localhost:3000'), {
      ok: true,
      url: 'http://localhost:3000',
    })

    // Rejects dangerous schemes that terminal output could smuggle in.
    for (const dangerous of [
      'file:///etc/passwd',
      'vscode://file/etc/passwd',
      'javascript:alert(1)',
      'mailto:a@b.com',
      'ftp://host/x',
    ]) {
      const result = safeExternalUrl(dangerous)
      assert.equal(result.ok, false, `expected ${dangerous} to be rejected`)
    }

    // Rejects empty and non-string input.
    assert.equal(safeExternalUrl('').ok, false)
    assert.equal(safeExternalUrl('   ').ok, false)
    assert.equal(safeExternalUrl(undefined).ok, false)
    assert.equal(safeExternalUrl(42).ok, false)

    // Rejects unparsable links.
    assert.equal(safeExternalUrl('not a url').ok, false)

    console.log('external-url tests passed')
  }

  main()
})

test('a window may open System Settings on Files and Folders, on macOS, and nothing else of its kind', () => {
  const settings = 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders'
  assert.deepEqual(safeWindowExternalUrl(settings, 'darwin'), { ok: true, url: settings })
  assert.equal(safeWindowExternalUrl(settings, 'linux').ok, false)
  assert.equal(safeWindowExternalUrl('x-apple.systempreferences:com.apple.preference.security', 'darwin').ok, false)
  assert.equal(safeWindowExternalUrl(`${settings}&more`, 'darwin').ok, false)
  assert.equal(safeWindowExternalUrl('file:///etc/passwd', 'darwin').ok, false)
  assert.deepEqual(safeWindowExternalUrl('https://example.com', 'darwin'), { ok: true, url: 'https://example.com' })
})

test('a browser tab opened in the system browser still refuses the settings link', () => {
  const settings = 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders'
  assert.equal(safeExternalUrl(settings).ok, false)
})
