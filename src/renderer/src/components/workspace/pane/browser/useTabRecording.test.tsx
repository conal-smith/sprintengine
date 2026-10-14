import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, test, vi } from 'vitest'

import type {
  BrowserRecordingEnded,
  BrowserRecordingStart,
  BrowserRecordingStarted,
  BrowserRecordingState,
} from '../../../../../../shared/browser'

// A tab's side of a recording, with the capture stood in for: main's start
// is answered once capture runs (or with why not), main's stop ends it, a stop
// that comes while it is still starting is kept, and a tab that closes ends
// its recording. Then the toolbar's indicator.

type FakeRecording = {
  stopped: number
  finish(outcome?: { durationMs: number; error?: string }): void
}
const capture = {
  fail: null as string | null,
  made: [] as FakeRecording[],
  gate: null as Promise<void> | null,
}

vi.mock('./browserRecording', async (original) => ({
  ...(await original<typeof import('./browserRecording')>()),
  readRecordingTheme: () => ({ fill: 'Highlight', stroke: 'HighlightText', pulse: 'Highlight', backdrop: 'Canvas' }),
  startGuestRecording: async (_options: BrowserRecordingStart, io: { onChunk(bytes: Uint8Array): void }) => {
    if (capture.gate) await capture.gate
    if (capture.fail) throw new Error(capture.fail)
    let finish: (outcome: { durationMs: number; error?: string }) => void = () => undefined
    const finished = new Promise<{ durationMs: number; error?: string }>((resolve) => (finish = resolve))
    const fake: FakeRecording = {
      stopped: 0,
      finish: (outcome = { durationMs: 1_000 }) => finish(outcome),
    }
    capture.made.push(fake)
    io.onChunk(new Uint8Array([1, 2, 3]))
    return {
      mimeType: 'video/webm;codecs=vp9',
      width: 1280,
      height: 800,
      cursor: true,
      stop: () => {
        fake.stopped += 1
        fake.finish({ durationMs: 2_000 })
      },
      finished,
    }
  },
}))

const { useTabRecording } = await import('./useTabRecording')
const { BrowserRecordingIndicator } = await import('./BrowserRecordingIndicator')
const { useRecordingTabsStore } = await import('./recordingTabs')

const sent = {
  started: [] as BrowserRecordingStarted[],
  chunks: [] as Array<[string, number]>,
  ended: [] as BrowserRecordingEnded[],
  stopRequests: [] as string[],
}
const listeners = {
  start: new Set<(start: BrowserRecordingStart) => void>(),
  stop: new Set<(payload: { recordingId: string }) => void>(),
}

let root: Root | null = null
let host: HTMLElement | null = null

beforeAll(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  ;(dom.window as unknown as Record<string, unknown>).api = {
    onBrowserRecordingStart: (cb: (start: BrowserRecordingStart) => void) => {
      listeners.start.add(cb)
      return () => listeners.start.delete(cb)
    },
    onBrowserRecordingStop: (cb: (payload: { recordingId: string }) => void) => {
      listeners.stop.add(cb)
      return () => listeners.stop.delete(cb)
    },
    onBrowserPointer: () => () => undefined,
    browserRecordingStarted: (payload: BrowserRecordingStarted) => void sent.started.push(payload),
    browserRecordingChunk: (recordingId: string, bytes: Uint8Array) =>
      void sent.chunks.push([recordingId, bytes.length]),
    browserRecordingEnded: (payload: BrowserRecordingEnded) => void sent.ended.push(payload),
    browserStopRecording: async (tabId: string) => {
      sent.stopRequests.push(tabId)
      return true
    },
  }
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  capture.fail = null
  capture.gate = null
  capture.made.length = 0
  for (const list of Object.values(sent)) list.length = 0
})

function Recorder({ tabId }: { tabId: string }) {
  useTabRecording(tabId, 'ws')
  return null
}

async function mount(element: React.ReactElement): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(element))
}

const START = (recordingId: string, tabId = 't1'): BrowserRecordingStart => ({
  recordingId,
  tabId,
  frameRate: 30,
  maxEdge: 1280,
  bitsPerSecond: 1_500_000,
  cursor: true,
})

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
const emitStart = (start: BrowserRecordingStart) => act(async () => listeners.start.forEach((cb) => cb(start)))
const emitStop = (recordingId: string) => act(async () => listeners.stop.forEach((cb) => cb({ recordingId })))

test("main's start is answered once capture runs; its stop ends it with the last word", async () => {
  await mount(<Recorder tabId="t1" />)
  await emitStart(START('rec-1', 'other-tab'))
  await flush()
  assert.equal(capture.made.length, 0, "another tab's recording is not this one's")

  await emitStart(START('rec-1'))
  await flush()
  assert.deepEqual(sent.started, [
    { recordingId: 'rec-1', ok: true, mimeType: 'video/webm;codecs=vp9', width: 1280, height: 800, cursor: true },
  ])
  assert.deepEqual(sent.chunks, [['rec-1', 3]])
  assert.deepEqual(
    useRecordingTabsStore.getState().recordings,
    { 'rec-1': { tabId: 't1', workspaceId: 'ws' } },
    'the pane keeps the tab painting while it records',
  )
  await emitStop('rec-1')
  await flush()
  assert.equal(capture.made[0]!.stopped, 1)
  assert.deepEqual(sent.ended, [{ recordingId: 'rec-1', durationMs: 2_000 }])
  assert.deepEqual(useRecordingTabsStore.getState().recordings, {})
})

test('a capture that cannot start says why', async () => {
  await mount(<Recorder tabId="t1" />)
  capture.fail = 'Permission denied'
  await emitStart(START('rec-1'))
  await flush()
  assert.deepEqual(sent.started, [{ recordingId: 'rec-1', ok: false, message: 'Permission denied' }])
  assert.deepEqual(sent.ended, [])
  assert.deepEqual(useRecordingTabsStore.getState().recordings, {})
})

test('a stop that comes while the capture is starting is kept, and ends it as soon as it runs', async () => {
  await mount(<Recorder tabId="t1" />)
  let open: () => void = () => undefined
  capture.gate = new Promise((resolve) => (open = resolve))
  await emitStart(START('rec-1'))
  await emitStop('rec-1')
  await act(async () => open())
  await flush()
  assert.equal(sent.started[0]?.ok, true)
  assert.equal(capture.made[0]!.stopped, 1)
  assert.equal(sent.ended.length, 1)
})

test('a tab that closes ends its recording, and the end is still reported', async () => {
  await mount(<Recorder tabId="t1" />)
  await emitStart(START('rec-1'))
  await flush()
  act(() => root!.unmount())
  root = null
  await flush()
  assert.equal(capture.made[0]!.stopped, 1)
  assert.deepEqual(sent.ended, [{ recordingId: 'rec-1', durationMs: 2_000 }])
})

test('the indicator says it in words with a clock, and Stop asks main', async () => {
  const recording: BrowserRecordingState = {
    recordingId: 'rec-1',
    startedAt: Date.now() - 65_000,
    maxDurationMs: 120_000,
  }
  let stops = 0
  await mount(<BrowserRecordingIndicator recording={recording} onStop={() => (stops += 1)} />)
  assert.match(host!.textContent ?? '', /Recording 1:0[5-6]/)
  const badge = host!.querySelector('[role="img"]')
  assert.match(badge?.getAttribute('aria-label') ?? '', /An agent is recording this tab/)
  const stop = host!.querySelector('button[aria-label="Stop recording"]') as HTMLButtonElement
  await act(async () => stop.click())
  assert.equal(stops, 1)
})
