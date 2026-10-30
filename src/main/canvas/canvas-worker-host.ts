// The half of the canvas worker that is not a window.
//
// Four of the five canvas operations need a DOM, so they run in a renderer
// nobody sees. What talks to that renderer is a request/response protocol with
// a deadline, a restart and a queue — rules that have nothing to do with
// Electron, and that are worth being able to prove without starting one. So the
// window lives in `canvas-worker-window.ts` behind the `CanvasWorkerTransport`
// interface below, and everything that can go wrong is decided here.
//
// Correlation is on `requestId` alone, and the rule is the same one
// `ipc/dock-diff.ts` arrived at: an answer that is late is not an answer. A
// worker that replies after its deadline finds its request already settled and
// is dropped, rather than being handed to whoever asked next.

import { randomUUID } from 'node:crypto'

import type { CanvasResult } from '../../shared/canvas/types'
import { canvasFail, canvasOk } from '../../shared/canvas/types'
import type {
  CanvasWorkerReport,
  CanvasWorkerRequest,
  CanvasWorkerRequestKind,
  CanvasWorkerResponse,
  CanvasWorkerSuccess,
} from '../../shared/canvas/worker-protocol'

/** Most calls are geometry over an array already in memory. */
export const CANVAS_WORKER_DEADLINE_MS = 20_000
/** Text → diagram pulls in a parser and lays the result out; it is allowed longer. */
export const CANVAS_WORKER_MERMAID_DEADLINE_MS = 60_000
/** The first call after a start also pays for the editor's fonts and chunks. */
export const CANVAS_WORKER_COLD_START_GRACE_MS = 15_000
/** A worker nobody has needed for this long is not worth a process. */
export const CANVAS_WORKER_IDLE_MS = 5 * 60 * 1000

export type CanvasWorkerTransport = {
  /** Resolves once the worker has signalled it is ready to take requests. */
  ensureStarted(): Promise<void>
  post(request: CanvasWorkerRequest): void
  onResponse(cb: (response: CanvasWorkerResponse) => void): () => void
  /** The worker died, hung, or failed to load. The host restarts it once. */
  onCrashed(cb: (reason: string) => void): () => void
  /** What the live worker said about its fonts when it came up, or null. */
  report(): CanvasWorkerReport | null
  stop(): void
}

export type CanvasWorkerHostDeps = {
  transport: CanvasWorkerTransport
  newRequestId?: () => string
  setTimer?: (fn: () => void, ms: number) => { cancel(): void }
  log?: (message: string, details?: Record<string, unknown>) => void
}

/**
 * A request as a caller writes it: the host mints the `requestId`, and it mints
 * a NEW one per attempt, so a retry can never be answered by the reply to the
 * attempt that was given up on. Distributive so each kind keeps its own fields.
 */
export type CanvasWorkerRequestBody<T = CanvasWorkerRequest> = T extends { requestId: string }
  ? Omit<T, 'requestId'>
  : never

export interface CanvasWorkerHost {
  call<K extends CanvasWorkerRequestKind>(
    request: CanvasWorkerRequestBody & { kind: K },
  ): Promise<CanvasResult<Extract<CanvasWorkerSuccess, { kind: K }>>>
  /**
   * How the live worker's fonts went, or null when none is up. A family in
   * `missing` means every label it measures is measured in a fallback face, so
   * the caller has something to warn about rather than a board that is quietly
   * a little wrong.
   */
  report(): CanvasWorkerReport | null
  dispose(): Promise<void>
}

type Pending = {
  run: () => void
  /** Called instead of `run` when the host is disposed with work still queued. */
  abandon: () => void
}

const defaultSetTimer = (fn: () => void, ms: number): { cancel(): void } => {
  const timer = setTimeout(fn, ms)
  return { cancel: () => clearTimeout(timer) }
}

function deadlineFor(kind: CanvasWorkerRequestKind, coldStart: boolean): number {
  const base = kind === 'import-mermaid' ? CANVAS_WORKER_MERMAID_DEADLINE_MS : CANVAS_WORKER_DEADLINE_MS
  return coldStart ? base + CANVAS_WORKER_COLD_START_GRACE_MS : base
}

export function createCanvasWorkerHost(deps: CanvasWorkerHostDeps): CanvasWorkerHost {
  const setTimer = deps.setTimer ?? defaultSetTimer
  const newRequestId = deps.newRequestId ?? randomUUID
  const log = deps.log ?? (() => {})

  /**
   * One request at a time.
   *
   * Not a throughput decision: the worker is a single renderer holding ONE
   * editor instance, and two overlapping calls would interleave in its scene.
   * The queue is what makes "the worker is busy" a wait rather than a fault.
   */
  const queue: Pending[] = []
  let busy = false
  let started = false
  let starting: Promise<void> | null = null
  /** The next call after a start pays the cold-start grace; the ones after do not. */
  let coldStart = true
  let idleTimer: { cancel(): void } | null = null
  let disposed = false

  const responseListeners = new Set<(response: CanvasWorkerResponse) => void>()
  const crashListeners = new Set<(reason: string) => void>()
  let unsubscribeResponse: (() => void) | null = null
  let unsubscribeCrash: (() => void) | null = null

  function attach(): void {
    if (unsubscribeResponse) return
    unsubscribeResponse = deps.transport.onResponse((response) => {
      for (const listener of [...responseListeners]) listener(response)
    })
    unsubscribeCrash = deps.transport.onCrashed((reason) => {
      // A crash invalidates the start: the next call brings a new worker up.
      started = false
      starting = null
      coldStart = true
      for (const listener of [...crashListeners]) listener(reason)
    })
  }

  function armIdle(): void {
    idleTimer?.cancel()
    if (!started || disposed) return
    idleTimer = setTimer(() => {
      idleTimer = null
      if (busy || queue.length > 0 || !started) return
      stopWorker()
    }, CANVAS_WORKER_IDLE_MS)
  }

  function stopWorker(): void {
    started = false
    starting = null
    coldStart = true
    idleTimer?.cancel()
    idleTimer = null
    try {
      deps.transport.stop()
    } catch (error) {
      log('The canvas worker did not stop cleanly', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  async function ensureStarted(): Promise<CanvasResult<void>> {
    if (started) return canvasOk(undefined)
    if (!starting) {
      starting = deps.transport.ensureStarted()
    }
    try {
      await starting
    } catch (error) {
      starting = null
      started = false
      return canvasFail(
        'worker_unavailable',
        `The canvas worker did not start: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    starting = null
    started = true
    attach()
    return canvasOk(undefined)
  }

  /** One attempt: start if needed, post, and wait for this id, a crash or the clock. */
  function attempt(request: CanvasWorkerRequest): Promise<CanvasResult<CanvasWorkerSuccess> | 'crashed' | 'timed-out'> {
    return new Promise((settle) => {
      let done = false
      const wasColdStart = coldStart
      const timer = setTimer(() => finish('timed-out'), deadlineFor(request.kind, wasColdStart))

      const finish = (answer: CanvasResult<CanvasWorkerSuccess> | 'crashed' | 'timed-out'): void => {
        if (done) return
        done = true
        timer.cancel()
        responseListeners.delete(onResponse)
        crashListeners.delete(onCrash)
        settle(answer)
      }

      const onResponse = (response: CanvasWorkerResponse): void => {
        // The id is the whole correlation. A response for another id is
        // another call's (or a late one's) and is not ours to act on.
        if (response.requestId !== request.requestId) return
        if (response.ok === false) {
          finish({ ok: false, error: response.error })
          return
        }
        if (response.kind !== request.kind) {
          finish(
            canvasFail(
              'worker_unavailable',
              `The canvas worker answered a ${request.kind} request with a ${response.kind} result.`,
            ),
          )
          return
        }
        finish(canvasOk(response))
      }
      const onCrash = (): void => finish('crashed')

      responseListeners.add(onResponse)
      crashListeners.add(onCrash)

      void (async () => {
        const start = await ensureStarted()
        if (!start.ok) {
          finish('crashed')
          return
        }
        coldStart = false
        try {
          deps.transport.post(request)
        } catch (error) {
          log('A canvas worker request could not be posted', {
            kind: request.kind,
            error: error instanceof Error ? error.message : String(error),
          })
          finish('crashed')
        }
      })()
    })
  }

  async function run(request: CanvasWorkerRequestBody): Promise<CanvasResult<CanvasWorkerSuccess>> {
    for (let attemptNumber = 0; attemptNumber < 2; attemptNumber += 1) {
      const withId = { ...request, requestId: newRequestId() } as CanvasWorkerRequest
      const answer = await attempt(withId)
      if (answer === 'timed-out') {
        // The worker serves one request at a time, so a request it never
        // finishes (an export or a diagram import stalled in the hidden
        // window) holds every request after it: kept, this worker would time
        // out every call until the app restarted. A timeout is answered as
        // one, not retried, and the next call gets a fresh worker.
        log('The canvas worker did not answer in time; it is replaced for the next call', { kind: request.kind })
        stopWorker()
        return canvasFail(
          'timeout',
          `The canvas worker did not answer a ${request.kind} request in time. The board is unchanged.`,
        )
      }
      if (answer !== 'crashed') return answer
      // A crashed or never-started worker gets exactly one more chance: the
      // common cause is a window that died between calls, and asking twice for
      // a worker that cannot load turns every tool call into a double wait.
      stopWorker()
      if (attemptNumber === 1 || disposed) break
      log('The canvas worker went away; starting it again for one retry', { kind: request.kind })
    }
    return canvasFail(
      'worker_unavailable',
      'The canvas worker is not available. The board is unchanged; try again in a moment.',
    )
  }

  function pump(): void {
    if (busy || disposed) return
    const next = queue.shift()
    if (!next) {
      armIdle()
      return
    }
    busy = true
    next.run()
  }

  // Written as a typed const rather than inline so the generic signature is
  // the interface's own: the narrowing below is checked against one declaration
  // instead of two that have to be kept in step by eye.
  // The plumbing above carries the protocol's whole response union; the
  // interface promises the caller the one success shape that goes with the kind
  // it asked for. That pairing is the protocol's, not something the type system
  // can follow through a queue, so it is asserted once, here — and `attempt`
  // has already refused any reply whose kind is not the one that was asked for,
  // which is what makes the assertion true rather than hopeful.
  const call = ((request: CanvasWorkerRequestBody): Promise<CanvasResult<CanvasWorkerSuccess>> => {
    if (disposed) {
      return Promise.resolve(canvasFail('worker_unavailable', 'The canvas worker has been shut down.'))
    }
    idleTimer?.cancel()
    idleTimer = null
    return new Promise((settle) => {
      queue.push({
        run: () => {
          void run(request).then((answer) => {
            busy = false
            settle(answer)
            pump()
          })
        },
        // A caller waiting behind a request when the app quits must be
        // answered, not left holding a promise nothing will ever settle.
        abandon: () =>
          settle(canvasFail('worker_unavailable', 'The canvas worker was shut down before this request ran.')),
      })
      pump()
    })
  }) as CanvasWorkerHost['call']

  return {
    call,
    report: () => deps.transport.report(),
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      const abandoned = queue.splice(0, queue.length)
      for (const pending of abandoned) pending.abandon()
      unsubscribeResponse?.()
      unsubscribeCrash?.()
      unsubscribeResponse = null
      unsubscribeCrash = null
      responseListeners.clear()
      crashListeners.clear()
      stopWorker()
    },
  }
}
