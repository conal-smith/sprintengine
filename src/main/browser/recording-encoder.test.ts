import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test, vi } from 'vitest'

import type { BrowserRecordingStart } from '../../shared/browser'

// The display-media grant and the window's messages, with Electron stood in
// for: the handler hands the guest's frame to the one request it armed, and
// only to the window hosting the tab; the window's chunks and its end reach
// the recorder only from that window.

const frameOwners = new Map<object, unknown>()
vi.mock('electron', () => ({ webContents: { fromFrame: (frame: object) => frameOwners.get(frame) } }))

const { createHostRecordingEncoder } = await import('./recording-encoder')
const { BROWSER_RECORDING_START_CHANNEL, BROWSER_RECORDING_STOP_CHANNEL } = await import('../../shared/browser')

type Handler = (request: { frame: object | null }, callback: (streams: { video?: unknown }) => void) => void

function fakeSession() {
  const session = {
    handler: null as Handler | null,
    setDisplayMediaRequestHandler: (h: Handler) => (session.handler = h),
  }
  return session
}

// Whether Chromium may throttle a WebContents in the background, and every change asked of it.
function throttling() {
  const state = {
    throttled: true,
    changes: [] as boolean[],
    getBackgroundThrottling: () => state.throttled,
    setBackgroundThrottling: (allowed: boolean) => {
      state.throttled = allowed
      state.changes.push(allowed)
    },
  }
  return state
}

function fakeHost(id: number, session = fakeSession()) {
  const events = new EventEmitter()
  const mainFrame = { processId: id, routingId: 1 }
  const sent: Array<[string, unknown]> = []
  let destroyed = false
  const background = throttling()
  const host = {
    id,
    session,
    mainFrame,
    sent,
    background,
    getBackgroundThrottling: background.getBackgroundThrottling,
    setBackgroundThrottling: background.setBackgroundThrottling,
    isDestroyed: () => destroyed,
    send: (channel: string, payload: unknown) => void sent.push([channel, payload]),
    once: (name: string, fn: (...args: unknown[]) => void) => void events.once(name, fn),
    on: (name: string, fn: (...args: unknown[]) => void) => void events.on(name, fn),
    destroy() {
      destroyed = true
      events.emit('destroyed')
    },
  }
  frameOwners.set(mainFrame, host)
  return host
}

function fakeGuest(background = throttling()) {
  return {
    isDestroyed: () => false,
    mainFrame: { guest: true },
    background,
    getBackgroundThrottling: background.getBackgroundThrottling,
    setBackgroundThrottling: background.setBackgroundThrottling,
  }
}

function fakeIpcMain() {
  const listeners = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => void>()
  return {
    on: (channel: string, fn: (event: { sender: unknown }, ...args: unknown[]) => void) =>
      void listeners.set(channel, fn),
    emit: (channel: string, sender: unknown, ...args: unknown[]) => listeners.get(channel)?.({ sender }, ...args),
  }
}

const START = (recordingId: string, tabId = 't1'): BrowserRecordingStart => ({
  recordingId,
  tabId,
  frameRate: 30,
  maxEdge: 1280,
  bitsPerSecond: 1_500_000,
  cursor: true,
})

function setup() {
  const ipcMain = fakeIpcMain()
  const host = fakeHost(7)
  const guest = fakeGuest()
  let clock = 0
  const encoder = createHostRecordingEncoder({
    ipcMain: ipcMain as never,
    tabs: {
      webContentsOf: (tabId) => (tabId === 't1' ? (guest as never) : null),
      hostOf: (tabId) => (tabId === 't1' ? (host as never) : null),
    },
    now: () => clock,
  })
  const chunks: Array<[string, number]> = []
  const ended: Array<[string, { durationMs?: number; error?: string }]> = []
  encoder.listen({
    chunk: (id, bytes) => void chunks.push([id, bytes.length]),
    ended: (id, outcome) => void ended.push([id, outcome]),
  })
  const grant = (frame: object | null) => {
    let answer: { video?: unknown } | null = null
    host.session.handler!({ frame }, (streams) => (answer = streams))
    return answer as { video?: unknown } | null
  }
  return { encoder, ipcMain, host, guest, chunks, ended, grant, tick: (ms: number) => (clock += ms) }
}

test('the armed request from the host window gets the guest; nothing else does', async () => {
  const { encoder, ipcMain, host, guest, grant, tick } = setup()
  const starting = encoder.start(START('rec-1'))
  await Promise.resolve()
  assert.deepEqual(host.sent[0], [BROWSER_RECORDING_START_CHANNEL, START('rec-1')])
  // A frame of another window, then a frame that is not the host's main frame.
  const other = fakeHost(9, host.session)
  assert.deepEqual(grant(other.mainFrame), {})
  assert.deepEqual(grant({ processId: 7, routingId: 2 }), {})
  assert.deepEqual(grant(null), {})
  // The host's own request, once.
  assert.deepEqual(grant(host.mainFrame), { video: guest.mainFrame })
  assert.deepEqual(grant(host.mainFrame), {}, 'a grant is spent')
  ipcMain.emit('browser:recording-started', host, {
    recordingId: 'rec-1',
    ok: true,
    mimeType: 'video/webm;codecs=vp9',
    width: 1280,
    height: 800,
    cursor: true,
  })
  assert.deepEqual(await starting, {
    ok: true,
    mimeType: 'video/webm;codecs=vp9',
    width: 1280,
    height: 800,
    cursor: true,
  })

  // An armed grant lapses.
  const late = encoder.start(START('rec-2'))
  await Promise.resolve()
  tick(5_001)
  assert.deepEqual(grant(host.mainFrame), {})
  ipcMain.emit('browser:recording-started', host, { recordingId: 'rec-2', ok: false, message: 'NotAllowedError' })
  const refused = await late
  assert.ok(!refused.ok && refused.message === 'NotAllowedError')
})

test('chunks and the end count only from the window recording; a closed window ends its recordings', async () => {
  const { encoder, ipcMain, host, chunks, ended } = setup()
  const starting = encoder.start(START('rec-1'))
  await Promise.resolve()
  ipcMain.emit('browser:recording-started', host, {
    recordingId: 'rec-1',
    ok: true,
    mimeType: 'video/webm',
    width: 1,
    height: 1,
    cursor: false,
  })
  await starting
  const stranger = fakeHost(9)
  ipcMain.emit('browser:recording-chunk', stranger, 'rec-1', new Uint8Array(5))
  ipcMain.emit('browser:recording-chunk', host, 'rec-1', 'not bytes')
  ipcMain.emit('browser:recording-chunk', host, 'rec-1', new Uint8Array(3))
  assert.deepEqual(chunks, [['rec-1', 3]])
  ipcMain.emit('browser:recording-ended', stranger, { recordingId: 'rec-1' })
  assert.deepEqual(ended, [])

  encoder.stop('rec-1')
  assert.deepEqual(host.sent.at(-1), [BROWSER_RECORDING_STOP_CHANNEL, { recordingId: 'rec-1' }])
  ipcMain.emit('browser:recording-ended', host, { recordingId: 'rec-1', durationMs: 1234 })
  assert.deepEqual(ended, [['rec-1', { durationMs: 1234 }]])

  const second = encoder.start(START('rec-2'))
  await Promise.resolve()
  ipcMain.emit('browser:recording-started', host, {
    recordingId: 'rec-2',
    ok: true,
    mimeType: 'video/webm',
    width: 1,
    height: 1,
    cursor: false,
  })
  await second
  host.destroy()
  assert.deepEqual(ended.at(-1), ['rec-2', { error: 'The window hosting the tab closed.' }])
})

test('a tab with no window cannot be recorded', async () => {
  const { encoder } = setup()
  const result = await encoder.start(START('rec-1', 'gone'))
  assert.ok(!result.ok && result.code === 'no_tab')
})

test('a stop before the window answers the start answers it as failed', async () => {
  const { encoder } = setup()
  const starting = encoder.start(START('rec-1'))
  await Promise.resolve()
  encoder.stop('rec-1')
  const result = await starting
  assert.ok(!result.ok && result.code === 'capture_failed')
})

test('a window that fails to capture after its start was stopped ends the recording', async () => {
  const { encoder, ipcMain, host, ended } = setup()
  const starting = encoder.start(START('rec-1'))
  await Promise.resolve()
  encoder.stop('rec-1')
  await starting
  ipcMain.emit('browser:recording-started', host, { recordingId: 'rec-1', ok: false, message: 'NotAllowedError' })
  assert.deepEqual(ended, [['rec-1', { error: 'The recording was stopped as it began.' }]])
  // Gone: a later word from the window is not taken.
  ipcMain.emit('browser:recording-ended', host, { recordingId: 'rec-1' })
  assert.equal(ended.length, 1)
})

test('a start stopped while it waits its turn on the window is never sent there', async () => {
  const { encoder, ipcMain, host, ended } = setup()
  const first = encoder.start(START('rec-1'))
  await Promise.resolve()
  // A second tab's start on the same window waits for the first grant.
  const second = encoder.start(START('rec-2'))
  await Promise.resolve()
  encoder.stop('rec-2')
  assert.deepEqual(ended, [['rec-2', { error: 'The recording was stopped as it began.' }]])
  ipcMain.emit('browser:recording-started', host, { recordingId: 'rec-1', ok: false, message: 'NotAllowedError' })
  await first
  const result = await second
  assert.ok(!result.ok && result.code === 'capture_failed')
  assert.deepEqual(
    host.sent.map(([channel, payload]) => [channel, (payload as { recordingId: string }).recordingId]),
    [[BROWSER_RECORDING_START_CHANNEL, 'rec-1']],
    'the window is asked to start the first only, and to stop nothing',
  )
})

test('a recording keeps its tab and window unthrottled until the last recording of them ends', async () => {
  const { encoder, ipcMain, host, guest } = setup()
  const started = (recordingId: string) =>
    ipcMain.emit('browser:recording-started', host, {
      recordingId,
      ok: true,
      mimeType: 'video/webm',
      width: 1,
      height: 1,
      cursor: false,
    })
  const first = encoder.start(START('rec-1'))
  await Promise.resolve()
  assert.equal(guest.background.throttled, false, 'the tab paints with Studio in the background')
  assert.equal(host.background.throttled, false, 'the window encodes with Studio in the background')
  started('rec-1')
  await first
  const second = encoder.start(START('rec-2'))
  await Promise.resolve()
  await Promise.resolve()
  started('rec-2')
  await second

  ipcMain.emit('browser:recording-ended', host, { recordingId: 'rec-1', durationMs: 10 })
  assert.equal(guest.background.throttled, false, 'another recording of the tab still runs')
  assert.equal(host.background.throttled, false)
  ipcMain.emit('browser:recording-ended', host, { recordingId: 'rec-2', durationMs: 10 })
  assert.deepEqual(guest.background.changes, [false, true])
  assert.deepEqual(host.background.changes, [false, true])
})

test('a capture that fails, or a window that closes, hands throttling back as it was', async () => {
  const failed = setup()
  failed.guest.background.throttled = false
  const starting = failed.encoder.start(START('rec-1'))
  await Promise.resolve()
  failed.ipcMain.emit('browser:recording-started', failed.host, { recordingId: 'rec-1', ok: false, message: 'x' })
  await starting
  assert.equal(failed.guest.background.throttled, false, 'a tab that was never throttled stays that way')
  assert.equal(failed.host.background.throttled, true)

  const closed = setup()
  const second = closed.encoder.start(START('rec-2'))
  await Promise.resolve()
  closed.host.destroy()
  await second
  assert.equal(closed.guest.background.throttled, true)
  assert.deepEqual(closed.host.background.changes, [false], 'a closed window is not touched')
})
