import assert from 'node:assert/strict'
import { test } from 'vitest'

import { missingGuiLocale } from './gui-locale'

test('a macOS launch with no locale gets a UTF-8 LC_CTYPE', () => {
  assert.equal(missingGuiLocale({ PATH: '/usr/bin:/bin' }, 'darwin'), 'en_US.UTF-8')
})

test('an empty or blank locale variable counts as unset', () => {
  assert.equal(missingGuiLocale({ LANG: '', LC_CTYPE: '  ' }, 'darwin'), 'en_US.UTF-8')
})

test('any locale the person set is left alone', () => {
  assert.equal(missingGuiLocale({ LANG: 'de_DE.UTF-8' }, 'darwin'), null)
  assert.equal(missingGuiLocale({ LC_ALL: 'C' }, 'darwin'), null)
  assert.equal(missingGuiLocale({ LC_CTYPE: 'UTF-8' }, 'darwin'), null)
})

test('Linux and Windows are left alone', () => {
  assert.equal(missingGuiLocale({}, 'linux'), null)
  assert.equal(missingGuiLocale({}, 'win32'), null)
})
