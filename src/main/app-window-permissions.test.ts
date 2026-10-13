import assert from 'node:assert/strict'
import { test } from 'vitest'

import { allowAppWindowPermissionCheck, allowAppWindowPermissionRequest } from './app-window-permissions'

test('a tab recording’s display capture reaches its own handler', () => {
  // `getDisplayMedia` arrives as a `media` request naming no capture device.
  assert.equal(allowAppWindowPermissionRequest('media', { mediaTypes: [] }), true)
  assert.equal(allowAppWindowPermissionRequest('media', {}), true)
})

test('the microphone and the camera are refused', () => {
  assert.equal(allowAppWindowPermissionRequest('media', { mediaTypes: ['audio'] }), false)
  assert.equal(allowAppWindowPermissionRequest('media', { mediaTypes: ['video'] }), false)
  assert.equal(allowAppWindowPermissionRequest('media', { mediaTypes: ['audio', 'video'] }), false)
})

test('every other permission is refused', () => {
  for (const permission of ['notifications', 'geolocation', 'clipboard-read', 'display-capture', 'audioCapture']) {
    assert.equal(allowAppWindowPermissionRequest(permission, {}), false, permission)
  }
})

test('Settings may list the installed font families', () => {
  assert.equal(allowAppWindowPermissionRequest('local-fonts', {}), true)
  assert.equal(allowAppWindowPermissionCheck('local-fonts'), true)
})

test('every other permission check is refused', () => {
  for (const permission of ['media', 'notifications', 'geolocation', 'clipboard-read', 'display-capture']) {
    assert.equal(allowAppWindowPermissionCheck(permission), false, permission)
  }
})
