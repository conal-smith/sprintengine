import {
  webContents as allWebContents,
  type IpcMain,
  type IpcMainEvent,
  type Session,
  type WebContents,
} from 'electron'

import {
  BROWSER_RECORDING_CHUNK_CHANNEL,
  BROWSER_RECORDING_ENDED_CHANNEL,
  BROWSER_RECORDING_START_CHANNEL,
  BROWSER_RECORDING_STARTED_CHANNEL,
  BROWSER_RECORDING_STOP_CHANNEL,
  type BrowserRecordingEnded,
  type BrowserRecordingStart,
  type BrowserRecordingStarted,
} from '../../shared/browser'
import type { RecordingEncoder, RecordingEncoderStarted, RecordingFailure } from './browser-recorder'

// The desktop's recording encoder: the window that hosts a tab records it.
//
// The pane's tab is a `<webview>` guest inside a workspace window. Chromium
// can capture a WebContents' own frames directly (what casting a browser tab
// uses), with no screen-recording permission, no debugger session and no
// screenshots: the host window asks `getDisplayMedia`, and this session's
// display-media handler answers it with the guest's main frame as the source.
// The window then draws the agent's cursor over the frames and encodes them
// with MediaRecorder (`pane/browser/browserRecording.ts`), sending the WebM
// back here a chunk at a time.
//
// Why this and not the other ways to get frames:
// - The DevTools protocol's screencast would share the tab's one debugger
//   session with the agent's actions, and stop whenever the person opens
//   DevTools on the page; its frames are JPEGs, decoded and encoded again.
// - `beginFrameSubscription` hands main a full bitmap per frame, tens of
//   megabytes a second through this process's heap, to be scaled and encoded
//   here.
// - Capturing the screen or the window needs the OS screen-recording
//   permission, and records whatever else is on screen over the pane.
//
// The handler grants exactly one request: the one this file armed, from the
// main frame of the window hosting that tab, within a few seconds. Every other
// `getDisplayMedia` from any page in the session is refused, as it was before
// there was a handler.

/** How long an armed grant waits for the window's request. */
const ARM_TTL_MS = 5_000
/** One chunk is about a second of video; anything far larger is not one of ours. */
const MAX_CHUNK_BYTES = 16 * 1024 * 1024

export type RecordingEncoderTabs = {
  /** The tab's guest. */
  webContentsOf(tabId: string): WebContents | null
  /** The window hosting the tab. */
  hostOf(tabId: string): WebContents | null
}

type Running = {
  recordingId: string
  host: WebContents
  guest: WebContents
  answerStart: ((answer: RecordingEncoderStarted | RecordingFailure) => void) | null
  /** The window has been asked to start: before that, it is waiting its turn and the window knows nothing of it. */
  sent: boolean
  ended: boolean
}

type Armed = { recordingId: string; guest: WebContents; expiresAt: number }

export function createHostRecordingEncoder(deps: {
  ipcMain: IpcMain
  tabs: RecordingEncoderTabs
  now?: () => number
}): RecordingEncoder {
  const now = deps.now ?? Date.now
  const running = new Map<string, Running>()
  /** At most one armed grant per host window: starts on one window take turns. */
  const armed = new Map<number, Armed>()
  const turns = new Map<number, Promise<void>>()
  const handledSessions = new WeakSet<Session>()
  const watchedHosts = new WeakSet<WebContents>()
  let listener: Parameters<RecordingEncoder['listen']>[0] | null = null
  // A recording keeps the tab and the window hosting it from being throttled
  // in the background. Chromium slows a backgrounded page's timers and
  // painting, so with Studio behind another app the tab stopped producing
  // frames and the window stopped encoding them, and the video froze until
  // Studio came back to the front. Held per WebContents, for as long as any
  // recording of it runs, and handed back as it was when the last one ends.
  const unthrottled = new Map<WebContents, { holds: number; previous: boolean }>()

  function holdUnthrottled(contents: WebContents): void {
    const held = unthrottled.get(contents)
    if (held) {
      held.holds++
      return
    }
    unthrottled.set(contents, { holds: 1, previous: contents.getBackgroundThrottling() })
    contents.setBackgroundThrottling(false)
  }

  function releaseUnthrottled(contents: WebContents): void {
    const held = unthrottled.get(contents)
    if (!held || --held.holds > 0) return
    unthrottled.delete(contents)
    if (!contents.isDestroyed()) contents.setBackgroundThrottling(held.previous)
  }

  /** Every way a recording stops passes here once. */
  function settle(recording: Running): void {
    if (recording.ended) return
    recording.ended = true
    running.delete(recording.recordingId)
    releaseUnthrottled(recording.guest)
    releaseUnthrottled(recording.host)
  }

  const fail = (code: string, message: string): RecordingFailure => ({ ok: false, code, message })

  function end(recording: Running, outcome: { durationMs?: number; error?: string }): void {
    if (recording.ended) return
    settle(recording)
    for (const [hostId, entry] of armed) if (entry.recordingId === recording.recordingId) armed.delete(hostId)
    recording.answerStart?.(fail('capture_failed', outcome.error ?? 'The recording ended before it started.'))
    recording.answerStart = null
    listener?.ended(recording.recordingId, outcome)
  }

  function installHandler(session: Session): void {
    if (handledSessions.has(session)) return
    handledSessions.add(session)
    // The session's only display-media handler: nothing else in the app asks
    // for one, and every request but an armed one is refused.
    session.setDisplayMediaRequestHandler((request, callback) => {
      const frame = request.frame
      const host = frame ? allWebContents.fromFrame(frame) : undefined
      const entry = host ? armed.get(host.id) : undefined
      const fromHostMainFrame =
        !!frame &&
        !!host &&
        !host.isDestroyed() &&
        frame.processId === host.mainFrame.processId &&
        frame.routingId === host.mainFrame.routingId
      if (!host || !entry || !fromHostMainFrame || entry.expiresAt < now() || entry.guest.isDestroyed()) {
        callback({})
        return
      }
      armed.delete(host.id)
      callback({ video: entry.guest.mainFrame })
    })
  }

  function watchHost(host: WebContents): void {
    if (watchedHosts.has(host)) return
    watchedHosts.add(host)
    const gone = (why: string) => {
      for (const recording of [...running.values()]) if (recording.host === host) end(recording, { error: why })
    }
    host.once('destroyed', () => gone('The window hosting the tab closed.'))
    host.on('render-process-gone', () => gone('The window hosting the tab stopped responding and was reloaded.'))
    // A reload of the window's page drops its recorders with it.
    host.on('did-start-navigation', (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
      if (details?.isMainFrame && !details.isSameDocument) gone('The window hosting the tab reloaded.')
    })
  }

  /** The recording a message from a window is about, if that window is the one recording it. */
  function fromHost(event: IpcMainEvent, recordingId: unknown): Running | null {
    if (typeof recordingId !== 'string') return null
    const recording = running.get(recordingId)
    return recording && event.sender === recording.host ? recording : null
  }

  deps.ipcMain.on(BROWSER_RECORDING_STARTED_CHANNEL, (event, payload: BrowserRecordingStarted) => {
    const recording = fromHost(event, payload?.recordingId)
    if (!recording) return
    if (!recording.answerStart) {
      // Its start was already answered (stopped as it began). A window that
      // then could not capture has nothing more to send, so it ends here.
      if (payload.ok !== true) end(recording, { error: 'The recording was stopped as it began.' })
      return
    }
    const answer = recording.answerStart
    recording.answerStart = null
    for (const [hostId, entry] of armed) if (entry.recordingId === recording.recordingId) armed.delete(hostId)
    if (payload.ok !== true) {
      settle(recording)
      answer(fail('capture_failed', String(payload.message || 'The tab could not be captured.').slice(0, 500)))
      return
    }
    const dimension = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0)
    answer({
      ok: true,
      mimeType: typeof payload.mimeType === 'string' ? payload.mimeType.slice(0, 100) : 'video/webm',
      width: dimension(payload.width),
      height: dimension(payload.height),
      cursor: payload.cursor === true,
    })
  })

  deps.ipcMain.on(BROWSER_RECORDING_CHUNK_CHANNEL, (event, recordingId: unknown, bytes: unknown) => {
    const recording = fromHost(event, recordingId)
    if (!recording || recording.ended) return
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_CHUNK_BYTES) return
    listener?.chunk(recording.recordingId, bytes)
  })

  deps.ipcMain.on(BROWSER_RECORDING_ENDED_CHANNEL, (event, payload: BrowserRecordingEnded) => {
    const recording = fromHost(event, payload?.recordingId)
    if (!recording) return
    end(recording, {
      ...(typeof payload.durationMs === 'number' && Number.isFinite(payload.durationMs)
        ? { durationMs: payload.durationMs }
        : {}),
      ...(typeof payload.error === 'string' && payload.error ? { error: payload.error.slice(0, 500) } : {}),
    })
  })

  return {
    async start(input: BrowserRecordingStart) {
      const guest = deps.tabs.webContentsOf(input.tabId)
      const host = deps.tabs.hostOf(input.tabId)
      if (!guest || guest.isDestroyed() || !host || host.isDestroyed()) {
        return fail('no_tab', 'The browser tab is not open in a window.')
      }
      installHandler(host.session)
      watchHost(host)
      const recording: Running = {
        recordingId: input.recordingId,
        host,
        guest,
        answerStart: null,
        sent: false,
        ended: false,
      }
      running.set(recording.recordingId, recording)
      holdUnthrottled(guest)
      holdUnthrottled(host)
      // One armed grant per window at a time: wait for the one before to be taken.
      const previous = turns.get(host.id) ?? Promise.resolve()
      let release: () => void = () => undefined
      const turn = new Promise<void>((resolve) => (release = resolve))
      turns.set(
        host.id,
        previous.then(() => turn),
      )
      await previous
      try {
        if (recording.ended || host.isDestroyed())
          return fail('capture_failed', 'The recording was stopped as it began.')
        armed.set(host.id, { recordingId: recording.recordingId, guest, expiresAt: now() + ARM_TTL_MS })
        return await new Promise<RecordingEncoderStarted | RecordingFailure>((resolve) => {
          recording.answerStart = resolve
          recording.sent = true
          host.send(BROWSER_RECORDING_START_CHANNEL, input)
        })
      } finally {
        release()
      }
    },

    stop(recordingId: string) {
      const recording = running.get(recordingId)
      if (!recording) return
      if (recording.host.isDestroyed()) {
        end(recording, { error: 'The window hosting the tab closed.' })
        return
      }
      // Still waiting for its turn on the window: the window was never asked,
      // so a stop sent there would find nothing, and the start would go out
      // after it and capture a recording nobody is waiting for. It ends here.
      if (!recording.sent) {
        end(recording, { error: 'The recording was stopped as it began.' })
        return
      }
      // A start still waiting is answered now; the window stops whatever began.
      recording.answerStart?.(fail('capture_failed', 'The recording was stopped as it began.'))
      recording.answerStart = null
      recording.host.send(BROWSER_RECORDING_STOP_CHANNEL, { recordingId })
    },

    listen(next) {
      listener = next
    },
  }
}
