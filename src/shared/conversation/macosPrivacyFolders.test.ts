import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  hasMacosPrivacyFolderHint,
  isMacosPrivacyFolder,
  looksLikeOperationNotPermitted,
  MACOS_PRIVACY_FOLDER_HINT,
  withMacosPrivacyFolderHint,
} from './macosPrivacyFolders'

const HOME = '/Users/dev'

test('Desktop, Documents, Downloads and iCloud Drive, and folders inside them, are kept private', () => {
  for (const folder of [
    '/Users/dev/Desktop',
    '/Users/dev/Documents/app',
    '/Users/dev/Downloads/thing/',
    '/Users/dev/Library/Mobile Documents/com~apple~CloudDocs/app',
    '/users/dev/documents/App',
  ])
    assert.equal(isMacosPrivacyFolder(folder, HOME), true, folder)
})

test('other folders, and look-alike names, are not', () => {
  for (const folder of ['/Users/dev/code/app', '/Users/dev/Documents-old/app', '/Users/other/Documents/app', '', HOME])
    assert.equal(isMacosPrivacyFolder(folder, HOME), false, folder)
})

test('EPERM and "Operation not permitted" read as a refusal; other failures do not', () => {
  assert.equal(looksLikeOperationNotPermitted('Error: EPERM: operation not permitted, uv_cwd'), true)
  assert.equal(looksLikeOperationNotPermitted('Operation not permitted'), true)
  assert.equal(looksLikeOperationNotPermitted('ENOENT: no such file'), false)
  assert.equal(looksLikeOperationNotPermitted('EPERMISSIVE'), false)
})

test('the hint follows the failure on macOS, in a private folder, refused with EPERM', () => {
  const said = withMacosPrivacyFolderHint('Codex process exited (1).', {
    platform: 'darwin',
    folder: '/Users/dev/Documents/app',
    home: HOME,
    evidence: 'Error: EPERM: operation not permitted, uv_cwd',
  })
  assert.equal(said, `Codex process exited (1). ${MACOS_PRIVACY_FOLDER_HINT}`)
  assert.equal(hasMacosPrivacyFolderHint(said), true)
})

test('the hint is said once, and only when every condition holds', () => {
  const context = { platform: 'darwin', folder: '/Users/dev/Documents/app', home: HOME }
  const once = withMacosPrivacyFolderHint('EPERM', context)
  assert.equal(withMacosPrivacyFolderHint(once, context), once)
  assert.equal(withMacosPrivacyFolderHint('EPERM', { ...context, platform: 'linux' }), 'EPERM')
  assert.equal(withMacosPrivacyFolderHint('EPERM', { ...context, folder: '/Users/dev/code' }), 'EPERM')
  assert.equal(withMacosPrivacyFolderHint('exited (1)', context), 'exited (1)')
  assert.equal(withMacosPrivacyFolderHint('EPERM', { ...context, folder: null }), 'EPERM')
})
