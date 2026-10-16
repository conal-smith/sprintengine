import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { BrowserRecordingStart, BrowserRecordingState } from '../../shared/browser'
import {
  createBrowserRecorder,
  recordingStem,
  type RecordingEncoder,
  type RecordingEncoderStarted,
  type RecordingFailure,
  type RecordingOutput,
  type RecordingOutputs,
} from './browser-recorder'

// The recorder's lifecycle with the encoder and the file stood in for: what
// starts, what ends a recording and why, what the person is shown, and what
// is left on disk.

type Listener = Parameters<RecordingEncoder['listen']>[0]

function fakeEncoder(
  answer: () =>
    RecordingEncoderStarted | RecordingFailure | Promise<RecordingEncoderStarted | RecordingFailure> = started,
) {
  let listener: Listener | null = null
  const starts: BrowserRecordingStart[] = []
  const stops: string[] = []
  const encoder: RecordingEncoder = {
    start: async (input) => {
      starts.push(input)
      return answer()
    },
    stop: (recordingId) => void stops.push(recordingId),
    listen: (next) => void (listener = next),
  }
  return {
    encoder,
    starts,
    stops,
    chunk: (recordingId: string, size: number) => listener!.chunk(recordingId, new Uint8Array(size).fill(1)),
    ended: (recordingId: string, outcome: { durationMs?: number; error?: string } = {}) =>
      listener!.ended(recordingId, outcome),
  }
}

function started(): RecordingEncoderStarted {
  return { ok: true, mimeType: 'video/webm;codecs=vp9', width: 1280, height: 800, cursor: true }
}

function fakeOutputs(refuse?: RecordingFailure) {
  const files: Array<{ stem: string; bytes: number; finished: number | null; discarded: boolean }> = []
  const outputs: RecordingOutputs = {
    create: async ({ stem }) => {
      if (refuse) return refuse
      const file = { stem, bytes: 0, finished: null as number | null, discarded: false }
      files.push(file)
      const output: RecordingOutput = {
        path: `/Users/dev/.sprintengine/workspaces/app-0123456789abcdef/browser/recordings/${stem}.webm`,
        append: async (bytes) => void (file.bytes += bytes.length),
        finish: async (durationMs) => {
          file.finished = durationMs
          return { bytes: file.bytes }
        },
        discard: async () => void (file.discarded = true),
      }
      return { ok: true, output }
    },
  }
  return { outputs, files }
}

function manualTimers() {
  const pending: Array<{ at: number; fn: () => void; cancelled: boolean }> = []
  let clock = 1_000_000
  return {
    now: () => clock,
    setTimer: (fn: () => void, ms: number) => {
      const entry = { at: clock + ms, fn, cancelled: false }
      pending.push(entry)
      return { cancel: () => void (entry.cancelled = true) }
    },
    advance(ms: number) {
      clock += ms
      for (const entry of pending.splice(0)) {
        if (entry.cancelled) continue
        if (entry.at <= clock) entry.fn()
        else pending.push(entry)
      }
    },
  }
}

function setup(options: { encoder?: ReturnType<typeof fakeEncoder>; refuse?: RecordingFailure } = {}) {
  const enc = options.encoder ?? fakeEncoder()
  const out = fakeOutputs(options.refuse)
  const timers = manualTimers()
  const published: Array<[string, BrowserRecordingState | null]> = []
  let ids = 0
  const recorder = createBrowserRecorder({
    encoder: enc.encoder,
    outputs: out.outputs,
    publish: (tabId, recording) => void published.push([tabId, recording]),
    describeTab: () => 'localhost:5173',
    now: timers.now,
    setTimer: timers.setTimer,
    newId: () => `rec-${++ids}`,
  })
  return { recorder, enc, out, timers, published }
}

/** Let queued appends and the finish run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('a file stem says what the page was and when, in characters every file system takes', () => {
  assert.equal(
    recordingStem('localhost:5173', new Date(2026, 9, 4, 9, 5, 7)),
    'recording-localhost-5173-20261004-090507',
  )
  assert.equal(recordingStem('', new Date(2026, 0, 1)), 'recording-page-20260101-000000')
})

test('start → chunks → stop: the person is shown it, and the file is finished with its length', async () => {
  const { recorder, enc, out, timers, published } = setup()
  const begun = await recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'agent-1', maxSeconds: 30 })
  assert.ok(begun.ok)
  assert.equal(begun.recording.recordingId, 'rec-1')
  assert.equal(
    begun.recording.path,
    `/Users/dev/.sprintengine/workspaces/app-0123456789abcdef/browser/recordings/${out.files[0]!.stem}.webm`,
  )
  assert.deepEqual(enc.starts[0], {
    recordingId: 'rec-1',
    tabId: 't1',
    frameRate: 30,
    maxEdge: 1280,
    bitsPerSecond: 1_500_000,
    cursor: true,
  })
  assert.deepEqual(published, [['t1', { recordingId: 'rec-1', startedAt: timers.now(), maxDurationMs: 30_000 }]])
  assert.equal(recorder.active('t1')?.recordingId, 'rec-1')

  enc.chunk('rec-1', 100)
  enc.chunk('rec-1', 50)
  timers.advance(4_000)
  const stopping = recorder.stop({ tabId: 't1', owner: 'agent-1', reason: 'stopped' })
  // The tab stops saying "recording" at once, while the last bytes flush.
  assert.deepEqual(published.at(-1), ['t1', null])
  assert.deepEqual(enc.stops, ['rec-1'])
  enc.chunk('rec-1', 25)
  enc.ended('rec-1', { durationMs: 3_990 })
  const result = await stopping
  assert.ok(result.ok)
  assert.equal(result.bytes, 175)
  assert.equal(result.durationMs, 3_990, "the encoder's own measure of the video")
  assert.equal(result.stopReason, 'stopped')
  assert.equal(result.cursor, true)
  assert.equal(out.files[0]!.finished, 3_990)
  assert.equal(recorder.active('t1'), null)
  assert.equal(recorder.lastFinished('t1', 'agent-1')?.recordingId, 'rec-1')
  assert.equal(recorder.lastFinished('t1', 'agent-2'), null, "another agent's recording is not handed out")
})

test('one recording per tab, and only so many at once', async () => {
  const { recorder } = setup()
  assert.ok((await recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'a' })).ok)
  const again = await recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'a' })
  assert.equal(!again.ok && again.code, 'already_recording')
  const other = await recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'b' })
  assert.ok(!other.ok && other.message.includes('Another agent'))
  assert.ok((await recorder.start({ tabId: 't2', workspaceId: 'ws', owner: 'a' })).ok)
  const third = await recorder.start({ tabId: 't3', workspaceId: 'ws', owner: 'a' })
  assert.equal(!third.ok && third.code, 'busy')
})

test('an agent stops only its own recording; the person stops any', async () => {
  const { recorder, enc } = setup()
  await recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'a' })
  enc.chunk('rec-1', 10)
  const refused = await recorder.stop({ tabId: 't1', owner: 'b', reason: 'stopped' })
  assert.equal(!refused.ok && refused.code, 'not_yours')
  const byPerson = recorder.stop({ tabId: 't1', owner: null, reason: 'stopped_by_person' })
  enc.ended('rec-1')
  const result = await byPerson
  assert.ok(result.ok && result.stopReason === 'stopped_by_person')
  const nothing = await recorder.stop({ tabId: 't1', owner: 'a', reason: 'stopped' })
  assert.equal(!nothing.ok && nothing.code, 'not_recording')
})

test('the duration limit ends a recording, and its result waits for the agent', async () => {
  const { recorder, enc, timers } = setup()
  await recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'a', maxSeconds: 5 })
  enc.chunk('rec-1', 10)
  timers.advance(5_000)
  assert.deepEqual(enc.stops, ['rec-1'])
  enc.ended('rec-1')
  await settle()
  const kept = recorder.lastFinished('t1', 'a')
  assert.equal(kept?.stopReason, 'max_duration')
  assert.equal(kept?.durationMs, 5_000, "main's clock when the encoder gives none")
})

test('a limit asked past the ceiling is held to it', async () => {
  const { recorder, published } = setup()
  await recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'a', maxSeconds: 9_999 })
  assert.equal(published[0]![1]?.maxDurationMs, 300_000)
})

test('the size limit ends a recording', async () => {
  const { recorder, enc } = setup()
  await recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'a' })
  enc.chunk('rec-1', 60 * 1024 * 1024)
  assert.deepEqual(enc.stops, ['rec-1'])
  enc.ended('rec-1')
  await settle()
  assert.equal(recorder.lastFinished('t1', 'a')?.stopReason, 'max_bytes')
})

test('a tab that closes keeps what was captured', async () => {
  const { recorder, enc, published } = setup()
  await recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'a' })
  enc.chunk('rec-1', 10)
  recorder.tabClosed('t1')
  enc.ended('rec-1', { error: 'The tab closed.' })
  await settle()
  const kept = recorder.lastFinished('t1', 'a')
  assert.equal(kept?.stopReason, 'tab_closed')
  assert.equal(kept?.bytes, 10)
  assert.deepEqual(published.at(-1), ['t1', null])
})

test('a capture that ends by itself is saved, with why', async () => {
  const { recorder, enc } = setup()
  await recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'a' })
  enc.chunk('rec-1', 10)
  enc.ended('rec-1', { error: 'The window hosting the tab went away.' })
  await settle()
  const kept = recorder.lastFinished('t1', 'a')
  assert.equal(kept?.stopReason, 'capture_ended')
  assert.equal(kept?.error, 'The window hosting the tab went away.')
})

test('nothing captured: no file is left, and the agent is told', async () => {
  const { recorder, enc, out } = setup()
  await recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'a' })
  const stopping = recorder.stop({ tabId: 't1', owner: 'a', reason: 'stopped' })
  enc.ended('rec-1')
  const result = await stopping
  assert.equal(!result.ok && result.code, 'empty')
  assert.equal(out.files[0]!.discarded, true)
})

test('an encoder that never answers the stop: what was written is saved after the wait', async () => {
  const { recorder, enc, timers } = setup()
  await recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'a' })
  enc.chunk('rec-1', 10)
  const stopping = recorder.stop({ tabId: 't1', owner: 'a', reason: 'stopped' })
  timers.advance(10_000)
  const result = await stopping
  assert.ok(result.ok && result.bytes === 10)
  enc.chunk('rec-1', 99)
  await settle()
  assert.equal(recorder.lastFinished('t1', 'a')?.bytes, 10, 'a late chunk is not taken')
})

test('a refused output starts nothing: the SSH machine case', async () => {
  const refusal: RecordingFailure = { ok: false, code: 'recording_unavailable', message: 'not here' }
  const { recorder, enc, published } = setup({ refuse: refusal })
  assert.deepEqual(await recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'a' }), refusal)
  assert.equal(enc.starts.length, 0, 'nothing is captured')
  assert.deepEqual(published, [])
})

test('a capture that fails to start leaves no file and no recording', async () => {
  const enc = fakeEncoder(() => ({ ok: false, code: 'capture_failed', message: 'Chromium said no.' }))
  const { recorder, out, published } = setup({ encoder: enc })
  const result = await recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'a' })
  assert.equal(!result.ok && result.code, 'capture_failed')
  assert.equal(out.files[0]!.discarded, true)
  assert.equal(recorder.active('t1'), null)
  assert.deepEqual(published, [])
  const retried = await recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'a' })
  assert.equal(!retried.ok && retried.code, 'capture_failed', 'tried again, not held as already recording')
})

test('a start the encoder never answers times out and is cleaned up', async () => {
  const enc = fakeEncoder(() => new Promise<never>(() => undefined))
  const { recorder, out, timers } = setup({ encoder: enc })
  const starting = recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'a' })
  await settle()
  timers.advance(10_000)
  const result = await starting
  assert.equal(!result.ok && result.code, 'timeout')
  assert.deepEqual(enc.stops, ['rec-1'], 'told to stop, in case it started late')
  assert.equal(out.files[0]!.discarded, true)
  assert.equal(recorder.active('t1'), null)
})

test('quitting saves every running recording', async () => {
  const { recorder, enc } = setup()
  await recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'a' })
  await recorder.start({ tabId: 't2', workspaceId: 'ws', owner: 'b' })
  enc.chunk('rec-1', 5)
  enc.chunk('rec-2', 7)
  const quitting = recorder.stopAll('app_quit')
  enc.ended('rec-1')
  enc.ended('rec-2')
  await quitting
  assert.equal(recorder.lastFinished('t1', null)?.stopReason, 'app_quit')
  assert.equal(recorder.lastFinished('t2', null)?.bytes, 7)
})

test('a finished recording is forgotten after a while', async () => {
  const { recorder, enc, timers } = setup()
  await recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'a' })
  enc.chunk('rec-1', 5)
  const stopping = recorder.stop({ tabId: 't1', owner: 'a', reason: 'stopped' })
  enc.ended('rec-1')
  await stopping
  timers.advance(31 * 60_000)
  assert.equal(recorder.lastFinished('t1', 'a'), null)
})

test('a tab that closes as its recording starts answers the start at once, with nothing left behind', async () => {
  let answer: (value: RecordingFailure) => void = () => undefined
  const enc = fakeEncoder(() => new Promise<RecordingFailure>((resolve) => (answer = resolve)))
  const { recorder, out } = setup({ encoder: enc })
  const starting = recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'a' })
  await settle()
  recorder.tabClosed('t1')
  assert.deepEqual(enc.stops, ['rec-1'])
  // The encoder answers the stopped start; its window never says it ended.
  answer({ ok: false, code: 'capture_failed', message: 'The recording was stopped as it began.' })
  const result = await starting
  assert.equal(!result.ok && result.code, 'capture_failed', 'answered without waiting out the stop timeout')
  assert.equal(out.files[0]!.discarded, true)
  assert.equal(recorder.active('t1'), null)
  assert.equal(recorder.lastOutcome('t1', 'a'), null, 'a start that never ran leaves no outcome')
})

test('starts that race past the limit are told the limit, not that the tab is taken', async () => {
  const { recorder } = setup()
  const results = await Promise.all(
    ['t1', 't2', 't3'].map((tabId) => recorder.start({ tabId, workspaceId: 'ws', owner: 'a' })),
  )
  assert.deepEqual(
    results.map((result) => (result.ok ? 'ok' : result.code)),
    ['ok', 'ok', 'busy'],
  )
})

test('a recording that saved nothing is remembered, so the agent is told why', async () => {
  const { recorder, enc } = setup()
  await recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'a' })
  enc.ended('rec-1', { error: 'The window hosting the tab closed.' })
  await settle()
  const outcome = recorder.lastOutcome('t1', 'a')
  assert.equal(outcome && !outcome.ok && outcome.code, 'empty')
  assert.equal(recorder.lastFinished('t1', 'a'), null, 'nothing saved')
  assert.equal(recorder.lastOutcome('t1', 'b'), null, "not another agent's to read")
})

test('the tab is brought forward only for a start that is allowed', async () => {
  const refusal: RecordingFailure = { ok: false, code: 'recording_unavailable', message: 'not here' }
  const refused = setup({ refuse: refusal })
  let forward = 0
  await refused.recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'a', beforeCapture: () => void forward++ })
  assert.equal(forward, 0)
  const { recorder } = setup()
  await recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'a', beforeCapture: () => void forward++ })
  await recorder.start({ tabId: 't1', workspaceId: 'ws', owner: 'b', beforeCapture: () => void forward++ })
  assert.equal(forward, 1)
})
