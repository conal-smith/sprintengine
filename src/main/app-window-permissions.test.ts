import assert from 'node:assert/strict'
import { test } from 'vitest'

import { allowAppWindowPermissionCheck, allowAppWindowPermissionRequest } from './app-window-permissions'

const APP = new URL(
  'file:///Applications/SprintEngine%20Studio.app/Contents/Resources/app.asar/out/renderer/index.html',
)
const DEV_APP = new URL('http://localhost:5173/')
const APP_PAGE = { requestingUrl: `${APP.href}?windowId=primary`, isMainFrame: true }

test('a tab recording’s display capture reaches its own handler', () => {
  // `getDisplayMedia` arrives as a `media` request naming no capture device.
  assert.equal(allowAppWindowPermissionRequest('media', { mediaTypes: [] }, APP), true)
  assert.equal(allowAppWindowPermissionRequest('media', {}, APP), true)
})

test('the microphone and the camera are refused', () => {
  assert.equal(allowAppWindowPermissionRequest('media', { mediaTypes: ['audio'] }, APP), false)
  assert.equal(allowAppWindowPermissionRequest('media', { mediaTypes: ['video'] }, APP), false)
  assert.equal(allowAppWindowPermissionRequest('media', { mediaTypes: ['audio', 'video'] }, APP), false)
})

test('every other permission is refused', () => {
  for (const permission of ['notifications', 'geolocation', 'clipboard-read', 'display-capture', 'audioCapture']) {
    assert.equal(allowAppWindowPermissionRequest(permission, APP_PAGE, APP), false, permission)
  }
})

test('the app’s own page may list the installed font families', () => {
  assert.equal(allowAppWindowPermissionRequest('local-fonts', APP_PAGE, APP), true)
  assert.equal(allowAppWindowPermissionCheck('local-fonts', APP_PAGE, APP), true)
})

test('the app’s own page on the dev server may list them too', () => {
  const page = { requestingUrl: 'http://localhost:5173/?windowId=primary&restoreDetached=0', isMainFrame: true }
  assert.equal(allowAppWindowPermissionCheck('local-fonts', page, DEV_APP), true)
  assert.equal(allowAppWindowPermissionRequest('local-fonts', page, DEV_APP), true)
})

test('a frame inside the app’s page may not', () => {
  // An agent's HTML preview: a sandboxed srcdoc frame in the same session.
  for (const frame of [
    { requestingUrl: 'about:srcdoc', isMainFrame: false },
    { requestingUrl: APP_PAGE.requestingUrl, isMainFrame: false },
  ]) {
    assert.equal(allowAppWindowPermissionCheck('local-fonts', frame, APP), false, frame.requestingUrl)
    assert.equal(allowAppWindowPermissionRequest('local-fonts', frame, APP), false, frame.requestingUrl)
  }
})

test('another page in the session may not, even on the app’s own origin', () => {
  for (const [requestingUrl, app] of [
    // The canvas worker's page beside the app's.
    [APP.href.replace('index.html', 'canvas-worker.html'), APP],
    ['http://localhost:5173/canvas-worker.html', DEV_APP],
    ['https://example.com/', APP],
    ['not a url', APP],
  ] as const) {
    const page = { requestingUrl, isMainFrame: true }
    assert.equal(allowAppWindowPermissionCheck('local-fonts', page, app), false, requestingUrl)
    assert.equal(allowAppWindowPermissionRequest('local-fonts', page, app), false, requestingUrl)
  }
})

test('a request that does not say who is asking is refused', () => {
  assert.equal(allowAppWindowPermissionCheck('local-fonts', undefined, APP), false)
  assert.equal(allowAppWindowPermissionRequest('local-fonts', {}, APP), false)
})

test('every other permission check is refused, even from the app’s own page', () => {
  for (const permission of ['media', 'notifications', 'geolocation', 'clipboard-read', 'display-capture']) {
    assert.equal(allowAppWindowPermissionCheck(permission, APP_PAGE, APP), false, permission)
  }
})
