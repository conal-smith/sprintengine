import { randomUUID } from 'node:crypto'

import type { BrowserRecordingStart, BrowserRecordingState } from '../../shared/browser'
import { slugify } from '../../shared/paths'

// Recording a browser tab to video, for an agent: the lifecycle around one
// recording per tab (start, the limits that end it, stop, the file it leaves).
//
// Two things are kept behind interfaces, so this file is all of the policy and
// none of the Electron:
//
// - The ENCODER turns the tab into WebM bytes. The desktop's encoder runs in
//   the window that hosts the tab (`recording-encoder.ts` and the pane's
//   `browserRecording.ts`): Chromium captures the guest's own frames, the
//   agent's cursor is drawn over them, and MediaRecorder encodes. Its chunks
//   arrive here in order, about one a second.
// - The OUTPUT is where the bytes go: a file in the calling agent's workspace
//   (`recording-output.ts`), so the agent reads the result with its own file
//   tools, wherever it runs. An output that cannot be made (no folder, or a
//   workspace whose files Studio cannot write) is refused before anything is
//   captured.
//
// The person always knows: while a recording runs, the tab's state says so
// (`BrowserTabState.recording`), and the pane's toolbar shows it with a timer
// and a Stop button that ends it like the agent's own stop would.

export const RECORDING_LIMITS = {
  /** How long a recording runs when the agent names no limit. */
  defaultSeconds: 60,
  /** The longest an agent may ask for. */
  maxSeconds: 300,
  /** A recording that reaches this many bytes ends there. */
  maxBytes: 60 * 1024 * 1024,
  /** Recordings at once, across every tab: each one encodes video on this machine. */
  maxConcurrent: 2,
  frameRate: 30,
  /** The longer edge of the video, in pixels; the page is scaled down to fit. */
  maxEdge: 1280,
  /** About 2 minutes of screen content per 25 MB, so five minutes stays under `maxBytes`. */
  bitsPerSecond: 1_500_000,
  /** How long the encoder has to say capture began. */
  startTimeoutMs: 10_000,
  /** How long the encoder has to hand over its last bytes after a stop. */
  stopTimeoutMs: 10_000,
  /** How long a finished recording is remembered for `browser.record_stop` and `browser.status`. */
  keepFinishedMs: 30 * 60_000,
} as const

export type RecordingStopReason =
  /** The agent's `browser.record_stop`. */
  | 'stopped'
  /** The person's Stop button in the pane. */
  | 'stopped_by_person'
  | 'max_duration'
  | 'max_bytes'
  /** The tab closed, or its window did. */
  | 'tab_closed'
  | 'app_quit'
  /** The encoder ended on its own: the capture failed or its window went away. */
  | 'capture_ended'

export type RecordingFailure = { ok: false; code: string; message: string }

export type RecordingEncoderStarted = { ok: true; mimeType: string; width: number; height: number; cursor: boolean }

/**
 * What turns a tab into WebM bytes. `start` resolves once capture is running
 * (or has failed); after that the encoder reports through the listener: each
 * chunk in order, then `ended` exactly once, after its last chunk.
 */
export type RecordingEncoder = {
  start(input: BrowserRecordingStart): Promise<RecordingEncoderStarted | RecordingFailure>
  /** Ask a running recording to finish: its last chunk and then `ended` follow. */
  stop(recordingId: string): void
  listen(listener: {
    chunk(recordingId: string, bytes: Uint8Array): void
    ended(recordingId: string, outcome: { durationMs?: number; error?: string }): void
  }): void
}

/** Where one recording's bytes go. */
export type RecordingOutput = {
  /**
   * The file, absolute, as the agent's machine spells it, when Studio can say:
   * a recording is kept in the project's store in the person's home, not in
   * the project, so no path relative to the project names it.
   */
  path: string | null
  append(bytes: Uint8Array): Promise<void>
  /** Close the file, with its length written into it. */
  finish(durationMs: number): Promise<{ bytes: number }>
  /** Remove what was written: nothing worth keeping was captured. */
  discard(): Promise<void>
}

export type RecordingOutputs = {
  create(input: {
    workspaceId: string
    stem: string
  }): Promise<{ ok: true; output: RecordingOutput } | RecordingFailure>
}

export type FinishedRecording = {
  ok: true
  recordingId: string
  tabId: string
  path: string | null
  mimeType: string
  bytes: number
  durationMs: number
  width: number
  height: number
  /** Whether the agent's cursor is drawn in the video. */
  cursor: boolean
  stopReason: RecordingStopReason
  /** Set when the capture ended with an error; the bytes before it are kept. */
  error?: string
  startedAt: string
  endedAt: string
}

export type ActiveRecording = {
  recordingId: string
  tabId: string
  path: string | null
  startedAt: string
  maxDurationMs: number
  bytes: number
  /** Ending: the last bytes are on their way. */
  stopping: boolean
}

export type BrowserRecorderDeps = {
  encoder: RecordingEncoder
  outputs: RecordingOutputs
  /** Tell the tab (and so the person) that a recording is running, or that none is. */
  publish(tabId: string, recording: BrowserRecordingState | null): void
  /** A short name for the file, from the tab's page (`localhost-5173`). */
  describeTab(tabId: string): string
  now?: () => number
  newId?: () => string
  setTimer?: (fn: () => void, ms: number) => { cancel(): void }
  limits?: Partial<typeof RECORDING_LIMITS>
  log?: (message: string) => void
}

type Recording = {
  id: string
  tabId: string
  owner: string
  output: RecordingOutput
  startedAt: number
  maxDurationMs: number
  mimeType: string
  width: number
  height: number
  cursor: boolean
  bytes: number
  /** Appends, one after another, so the file is in the order the chunks came. */
  writes: Promise<void>
  writeError: string | null
  ended: boolean
  /** Capture began and the person was shown it: how it ends is kept for `browser.record_stop`. */
  live: boolean
  encoderDurationMs: number | undefined
  encoderError: string | undefined
  onEnded: Array<() => void>
  limitTimer: { cancel(): void } | null
  finishing: Promise<FinishedRecording | RecordingFailure> | null
}

/** A file name's middle part: what the page was, made safe for any file system. */
export function recordingStem(label: string, at: Date): string {
  const slug = slugify(label).slice(0, 40) || 'page'
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  return `recording-${slug}-${stamp}`
}

export function createBrowserRecorder(deps: BrowserRecorderDeps) {
  const limits = { ...RECORDING_LIMITS, ...deps.limits }
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? (() => `rec-${randomUUID()}`)
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return { cancel: () => clearTimeout(timer) }
    })
  const log = deps.log ?? (() => undefined)

  const byTab = new Map<string, Recording>()
  const byId = new Map<string, Recording>()
  /**
   * How the last recording per tab ended, saved or not, for an agent whose
   * recording ended at a limit or was stopped by the person.
   */
  const finished = new Map<string, { result: FinishedRecording | RecordingFailure; owner: string; at: number }>()

  const fail = (code: string, message: string): RecordingFailure => ({ ok: false, code, message })

  function forgetOldFinished(): void {
    const cutoff = now() - limits.keepFinishedMs
    for (const [tabId, entry] of finished) if (entry.at < cutoff) finished.delete(tabId)
  }

  deps.encoder.listen({
    chunk(recordingId, bytes) {
      const recording = byId.get(recordingId)
      if (!recording || recording.ended || bytes.length === 0) return
      recording.bytes += bytes.length
      recording.writes = recording.writes.then(async () => {
        if (recording.writeError) return
        try {
          await recording.output.append(bytes)
        } catch (error) {
          recording.writeError = error instanceof Error ? error.message : String(error)
          log(`A browser recording could not be written: ${recording.writeError}`)
          void finish(recording, 'capture_ended')
        }
      })
      if (recording.bytes >= limits.maxBytes) void finish(recording, 'max_bytes')
    },
    ended(recordingId, outcome) {
      const recording = byId.get(recordingId)
      if (!recording || recording.ended) return
      recording.encoderDurationMs = outcome.durationMs
      recording.encoderError = outcome.error
      markEnded(recording)
      // Ended without being asked: the capture stopped under it.
      if (!recording.finishing) void finish(recording, 'capture_ended')
    },
  })

  /** Nothing more is taken from the encoder, and whoever waits for its end stops waiting. */
  function markEnded(recording: Recording): void {
    recording.ended = true
    for (const resolve of recording.onEnded.splice(0)) resolve()
  }

  function waitForEnd(recording: Recording): Promise<void> {
    if (recording.ended) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimer(() => {
        // The encoder never answered (its window hung or went away silently):
        // what was written is kept, and nothing more is accepted.
        markEnded(recording)
      }, limits.stopTimeoutMs)
      recording.onEnded.push(() => {
        timer.cancel()
        resolve()
      })
    })
  }

  function finish(recording: Recording, reason: RecordingStopReason): Promise<FinishedRecording | RecordingFailure> {
    if (recording.finishing) return recording.finishing
    recording.finishing = (async (): Promise<FinishedRecording | RecordingFailure> => {
      const result = await save(recording, reason)
      if (recording.live) {
        forgetOldFinished()
        finished.set(recording.tabId, { result, owner: recording.owner, at: now() })
      }
      return result
    })()
    return recording.finishing
  }

  async function save(
    recording: Recording,
    reason: RecordingStopReason,
  ): Promise<FinishedRecording | RecordingFailure> {
    recording.limitTimer?.cancel()
    recording.limitTimer = null
    // The person sees it stop at once; the last second of bytes is a flush.
    deps.publish(recording.tabId, null)
    if (!recording.ended) {
      deps.encoder.stop(recording.id)
      await waitForEnd(recording)
    }
    await recording.writes
    byTab.delete(recording.tabId)
    byId.delete(recording.id)
    const endedAt = now()
    const durationMs = Math.max(0, Math.round(recording.encoderDurationMs ?? endedAt - recording.startedAt))
    if (recording.bytes === 0 || recording.writeError) {
      await recording.output.discard().catch(() => undefined)
      if (recording.writeError) return fail('write_failed', `The recording could not be saved: ${recording.writeError}`)
      return fail(
        'empty',
        recording.encoderError
          ? `The recording captured nothing: ${recording.encoderError}`
          : 'The recording captured nothing: the tab showed no frames.',
      )
    }
    let bytes: number
    try {
      bytes = (await recording.output.finish(durationMs)).bytes
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return fail('write_failed', `The recording could not be saved: ${message}`)
    }
    const result: FinishedRecording = {
      ok: true,
      recordingId: recording.id,
      tabId: recording.tabId,
      path: recording.output.path,
      mimeType: recording.mimeType,
      bytes,
      durationMs,
      width: recording.width,
      height: recording.height,
      cursor: recording.cursor,
      stopReason: reason,
      ...(recording.encoderError ? { error: recording.encoderError } : {}),
      startedAt: new Date(recording.startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
    }
    return result
  }

  /** How the tab's last recording ended, saved or not, for its owner (or anyone, with `owner` null). */
  function lastOutcome(tabId: string, owner: string | null): FinishedRecording | RecordingFailure | null {
    forgetOldFinished()
    const entry = finished.get(tabId)
    if (!entry || (owner !== null && entry.owner !== owner)) return null
    return entry.result
  }

  function describe(recording: Recording): ActiveRecording {
    return {
      recordingId: recording.id,
      tabId: recording.tabId,
      path: recording.output.path,
      startedAt: new Date(recording.startedAt).toISOString(),
      maxDurationMs: recording.maxDurationMs,
      bytes: recording.bytes,
      stopping: recording.finishing !== null,
    }
  }

  return {
    /**
     * Start recording a tab. `owner` is who may stop it besides the person
     * (the calling agent). Resolves once capture is running.
     */
    async start(input: {
      tabId: string
      workspaceId: string
      owner: string
      maxSeconds?: number | null
      cursor?: boolean
      /**
       * Called once the recording is allowed and its file made, just before
       * capture is asked for: where the tab is brought forward, so a refused
       * start moves nothing on screen.
       */
      beforeCapture?: () => void
    }): Promise<{ ok: true; recording: ActiveRecording } | RecordingFailure> {
      const running = byTab.get(input.tabId)
      if (running) {
        return fail(
          'already_recording',
          running.owner === input.owner
            ? 'This tab is already being recorded; browser.record_stop ends it.'
            : 'Another agent is recording this tab.',
        )
      }
      if (byTab.size >= limits.maxConcurrent) {
        return fail(
          'busy',
          `${limits.maxConcurrent} tabs are being recorded already; stop one before starting another.`,
        )
      }
      const seconds = Math.min(limits.maxSeconds, Math.max(1, Math.round(input.maxSeconds ?? limits.defaultSeconds)))
      const startedAtDate = new Date(now())
      const created = await deps.outputs.create({
        workspaceId: input.workspaceId,
        stem: recordingStem(deps.describeTab(input.tabId), startedAtDate),
      })
      if (!created.ok) return created
      // Asked again: two starts for one tab may have raced past the check above.
      if (byTab.has(input.tabId) || byTab.size >= limits.maxConcurrent) {
        await created.output.discard().catch(() => undefined)
        return byTab.has(input.tabId)
          ? fail('already_recording', 'This tab is already being recorded.')
          : fail('busy', `${limits.maxConcurrent} tabs are being recorded already; stop one before starting another.`)
      }
      const recording: Recording = {
        id: newId(),
        tabId: input.tabId,
        owner: input.owner,
        output: created.output,
        startedAt: startedAtDate.getTime(),
        maxDurationMs: seconds * 1000,
        mimeType: 'video/webm',
        width: 0,
        height: 0,
        cursor: false,
        bytes: 0,
        writes: Promise.resolve(),
        writeError: null,
        ended: false,
        live: false,
        encoderDurationMs: undefined,
        encoderError: undefined,
        onEnded: [],
        limitTimer: null,
        finishing: null,
      }
      // Held from here, so a second start is refused while this one begins.
      byTab.set(recording.tabId, recording)
      byId.set(recording.id, recording)
      input.beforeCapture?.()

      let started: RecordingEncoderStarted | RecordingFailure
      let cancelStartTimer: () => void = () => undefined
      try {
        started = await Promise.race([
          deps.encoder.start({
            recordingId: recording.id,
            tabId: recording.tabId,
            frameRate: limits.frameRate,
            maxEdge: limits.maxEdge,
            bitsPerSecond: limits.bitsPerSecond,
            cursor: input.cursor !== false,
          }),
          new Promise<RecordingFailure>((resolve) => {
            const timer = setTimer(
              () => resolve(fail('timeout', 'The tab did not start recording in time.')),
              limits.startTimeoutMs,
            )
            cancelStartTimer = () => timer.cancel()
          }),
        ])
      } catch (error) {
        started = fail('capture_failed', error instanceof Error ? error.message : String(error))
      } finally {
        cancelStartTimer()
      }
      // Capture may have ended before its start was answered (the tab closed
      // under it): that is a failed start, and nothing is left running.
      if (started.ok && (recording.ended || recording.finishing)) {
        started = fail('capture_failed', recording.encoderError ?? 'The tab stopped recording as it started.')
      }
      if (!started.ok) {
        byTab.delete(recording.tabId)
        byId.delete(recording.id)
        if (!recording.ended) deps.encoder.stop(recording.id)
        // Given up on: a finish already under way (the tab closed as it
        // began) does not wait out the encoder's stop for bytes that will not come.
        markEnded(recording)
        await (recording.finishing ?? Promise.resolve())
        await created.output.discard().catch(() => undefined)
        return started
      }
      recording.mimeType = started.mimeType
      recording.width = started.width
      recording.height = started.height
      recording.cursor = started.cursor
      recording.live = true
      // From when capture began, not from when it was asked for.
      recording.startedAt = now()
      recording.limitTimer = setTimer(() => void finish(recording, 'max_duration'), recording.maxDurationMs)
      deps.publish(recording.tabId, {
        recordingId: recording.id,
        startedAt: recording.startedAt,
        maxDurationMs: recording.maxDurationMs,
      })
      return { ok: true, recording: describe(recording) }
    },

    /**
     * Stop a tab's recording and save it. `owner` null is the person, who may
     * stop any recording; an agent stops only its own.
     */
    async stop(input: {
      tabId: string
      owner: string | null
      reason: RecordingStopReason
    }): Promise<FinishedRecording | RecordingFailure> {
      const recording = byTab.get(input.tabId)
      if (!recording) return fail('not_recording', 'This tab is not being recorded.')
      if (input.owner !== null && recording.owner !== input.owner) {
        return fail('not_yours', 'Another agent is recording this tab; it ends when that agent stops it.')
      }
      return finish(recording, input.reason)
    },

    /** The recording running on a tab, if any. */
    active(tabId: string): ActiveRecording | null {
      const recording = byTab.get(tabId)
      return recording ? describe(recording) : null
    },

    /** The tab's last saved recording, for its owner (or anyone, with `owner` null). */
    lastFinished(tabId: string, owner: string | null): FinishedRecording | null {
      const result = lastOutcome(tabId, owner)
      return result?.ok ? result : null
    },

    lastOutcome,

    /** The tab is gone: its recording, if any, is saved with what was captured. */
    tabClosed(tabId: string): void {
      const recording = byTab.get(tabId)
      if (recording) void finish(recording, 'tab_closed')
    },

    /** Save every running recording: the app is quitting. */
    async stopAll(reason: RecordingStopReason): Promise<void> {
      await Promise.allSettled([...byTab.values()].map((recording) => finish(recording, reason)))
    },
  }
}

export type BrowserRecorder = ReturnType<typeof createBrowserRecorder>
