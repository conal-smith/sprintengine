import type { CanvasBoardRef, CanvasScenePush } from '../../../../../../shared/canvas/types'
import { canvasBoardKeyPath } from '../../../../../../shared/canvas/paths'

// The Canvas tab's decisions, with the editor and React taken out of them.
//
// Three questions decide whether the person and an agent can draw on one board
// without fighting, and all three are easy to get subtly wrong inside an
// effect: is the person mid-gesture, which of several queued scenes is the one
// to apply, and is this change ours coming back. They are pure functions here
// so they can be tested against plain objects — the editor cannot be mounted in
// a Node test, and a rule that can only be exercised by hand is a rule that
// drifts.

/**
 * The slice of the editor's `AppState` that says "the person is in the middle
 * of something". Declared structurally, and every field is optional: this is
 * read off a live object the editor owns, and a field the library renames in a
 * minor release must leave the predicate answering `false` rather than
 * throwing. Each name was checked against the shipped `AppState` type.
 */
export type CanvasBusyState = {
  /** A shape being drawn right now. */
  newElement?: unknown
  resizingElement?: unknown
  /** A text element with a caret in it. */
  editingTextElement?: unknown
  /** A multi-point line mid-click-through. */
  multiElement?: unknown
  /** The rubber band of a drag-select. */
  selectionElement?: unknown
  editingLinearElement?: unknown
  selectedElementsAreBeingDragged?: boolean
  isResizing?: boolean
  isRotating?: boolean
  isCropping?: boolean
  cursorButton?: 'up' | 'down'
}

/**
 * Whether the person is holding the board.
 *
 * The ruling this encodes: the person always wins. A remote scene applied
 * mid-gesture moves the ground under a drag — the element being dragged is
 * replaced by its remote twin and the pointer is suddenly holding nothing — so
 * a push that arrives during one is held rather than applied. `cursorButton`
 * catches the gestures that set no element field at all (a pan, a lasso that
 * has not moved yet).
 */
export function isCanvasBusy(state: CanvasBusyState | null | undefined): boolean {
  if (!state) return false
  return Boolean(
    state.newElement ||
    state.resizingElement ||
    state.editingTextElement ||
    state.multiElement ||
    state.selectionElement ||
    state.editingLinearElement ||
    state.selectedElementsAreBeingDragged ||
    state.isResizing ||
    state.isRotating ||
    state.isCropping ||
    state.cursorButton === 'down',
  )
}

/**
 * Everything that makes the board busy EXCEPT a caret sitting in a text
 * element.
 *
 * The two are not the same kind of busy. A drag, a resize or a half-drawn
 * shape is a gesture with an end: the pointer comes up and the push applies. A
 * caret has no end — somebody can leave one in a label and go to lunch — and a
 * push held behind it is held for good.
 */
export function isCanvasGestureBusy(state: CanvasBusyState | null | undefined): boolean {
  if (!state) return false
  return Boolean(
    state.newElement ||
    state.resizingElement ||
    state.multiElement ||
    state.selectionElement ||
    state.editingLinearElement ||
    state.selectedElementsAreBeingDragged ||
    state.isResizing ||
    state.isRotating ||
    state.isCropping ||
    state.cursorButton === 'down',
  )
}

/** How often a buffered push asks again whether the person has let go. */
export const CANVAS_PUSH_RETRY_MS = 1_000

/** How long a text caret alone may hold a push before it is applied anyway. */
export const CANVAS_TEXT_CARET_GRACE_MS = 5_000

export type CanvasBufferedPushInput = {
  /** The editor's live app state, or null when there is no editor yet. */
  busy: CanvasBusyState | null | undefined
  /** When the push was first buffered. */
  bufferedAt: number
  now: number
}

/**
 * Whether a buffered push may go in now.
 *
 * The gesture rule stands: a push applied mid-drag replaces the element under
 * the pointer, so a drag, a resize or a half-drawn shape holds it until the
 * pointer comes up.
 *
 * A text caret is not that kind of busy. It has no end — somebody can leave one
 * in a label and go to lunch — and the retries only ever came from `onChange`
 * and pointer-up, so an agent's edit could wait behind it indefinitely. After
 * the grace period the push goes in regardless of whether anyone is typing:
 * `reconcileElements` keeps the LOCAL copy of the element being edited, which
 * is exactly the element the caret is in, so nothing of theirs is taken. Timing
 * it from when the push was buffered rather than from the last keystroke is
 * deliberate — the editor reports a change often enough while a text editor is
 * open that "idle" would never arrive.
 */
export function canApplyBufferedPush(input: CanvasBufferedPushInput): boolean {
  if (!input.busy) return false
  if (!isCanvasBusy(input.busy)) return true
  if (isCanvasGestureBusy(input.busy)) return false
  return input.now - input.bufferedAt >= CANVAS_TEXT_CARET_GRACE_MS
}

/** The three numbers a tab keeps about where it is relative to main. */
export type CanvasSyncState = {
  /** The revision this tab cites as a merge base. */
  revision: number
  /** The newest revision it has applied; what it refuses as already seen. */
  appliedRevision: number
  /** The hash of the last scene it sent to main OR applied from main. */
  syncedHash: string | null
}

/**
 * Where a tab stands after applying a push.
 *
 * `mainHash` is the hash of the scene MAIN sent, NOT the one that ended up on
 * screen, and that is the whole of the echo rule. Equal hashes mean the apply
 * was silent. A difference means the editor had to adjust the push to accept it
 * — an agent-created element arrives with no fractional index and is given one,
 * which bumps its version — and main is behind by exactly that adjustment.
 * Recording main's hash leaves the editor looking like an unsent change, which
 * the debounce already running commits once, and the next apply finds nothing
 * left to adjust.
 */
export function canvasStateAfterPush(
  state: CanvasSyncState,
  push: { revision: number; mainHash: string },
): CanvasSyncState {
  return { ...state, revision: push.revision, appliedRevision: push.revision, syncedHash: push.mainHash }
}

/** What a tab does with the answer to its own commit. */
export type CanvasCommitOutcome =
  /** A newer scene landed while this was in flight; the answer says nothing new. */
  | { kind: 'stale' }
  /** The merge differed from what was sent: apply the answer exactly as a push. */
  | { kind: 'reconcile' }
  /** Main took what was sent; what is on screen IS that revision. */
  | { kind: 'accepted'; revision: number }

export function canvasCommitOutcome(
  reply: { revision: number; elements: unknown[] | null },
  appliedRevision: number,
): CanvasCommitOutcome {
  // The answer may not drag the revision backwards — `applyPush` refuses a
  // stale push on exactly this test, and a commit's reply is no different.
  if (reply.revision <= appliedRevision) return { kind: 'stale' }
  if (reply.elements) return { kind: 'reconcile' }
  return { kind: 'accepted', revision: reply.revision }
}

/**
 * The echo hash to leave behind when a commit did not land.
 *
 * The hash is claimed BEFORE the round trip, so a change arriving mid-flight
 * compares against what is being sent rather than against what was sent before
 * it. Putting it back is therefore conditional: if something else claimed it
 * while this call was away, that claim is the newer truth and stands.
 */
export function canvasHashAfterFailedCommit(
  current: string | null,
  sent: string,
  previous: string | null,
): string | null {
  return current === sent ? previous : current
}

/**
 * The platform of the machine the boards are on (the server's), as the
 * shell reports it. Read per call and defaulted rather than captured: this
 * module is loaded by tests that have no preload, and a case-sensitive answer
 * there is the conservative one.
 */
function rendererPlatform(): string {
  const api = typeof window === 'undefined' ? undefined : window.api
  const host = api?.hostPlatform
  const platform = typeof host === 'string' ? host : api?.platform
  return typeof platform === 'string' ? platform : 'linux'
}

/** One string per board, whichever spelling of its path names it: what {@link canvasPushMatchesBoard} compares. */
export function canvasBoardKey(board: CanvasBoardRef): string {
  return `${board.workspaceId}\0${canvasBoardKeyPath(board.path, rendererPlatform())}`
}

/**
 * Whether a pushed scene is for the board this tab has open.
 *
 * Compared on the folded key, not the literal string. Main holds ONE board for
 * every spelling of a path the filesystem reads as one file, and it pushes
 * under the spelling the file actually has — so a tab opened under a different
 * one (an agent's `canvas.open` naming `Arch.excalidraw`) would otherwise
 * ignore every scene main ever sent it.
 */
export function canvasPushMatchesBoard(push: CanvasBoardRef, board: CanvasBoardRef): boolean {
  return canvasBoardKey(push) === canvasBoardKey(board)
}

/**
 * Whether a pushed scene still has something to say.
 *
 * Every push carries the WHOLE scene at a revision, so a push at or below the
 * revision already on screen is not stale data to be merged — it is the same
 * data, or older. Applying it would undo a newer one.
 */
export function shouldApplyCanvasPush(revision: number, lastAppliedRevision: number): boolean {
  return revision > lastAppliedRevision
}

/**
 * The one push worth keeping while the person is mid-gesture.
 *
 * A full scene supersedes every earlier full scene, so the buffer is one slot
 * deep whatever arrives — three agent edits during a long drag cost one apply
 * on release, not three. Equal revisions keep the one already buffered: it got
 * there first and they describe the same scene.
 */
export function bufferCanvasPush<T extends { revision: number }>(buffered: T | null, incoming: T): T {
  if (!buffered) return incoming
  return incoming.revision > buffered.revision ? incoming : buffered
}

/**
 * Whether the person's scene is worth sending.
 *
 * `lastSyncedHash` is the hash of the last scene this tab either sent to main
 * or applied from main, so this is the echo guard in both directions: the
 * commit's own round trip does not re-commit, and neither does the `onChange`
 * the editor fires as a consequence of a scene we just applied. A null hash
 * means nothing has been synced yet, so the first change always goes.
 */
export function shouldCommitCanvasScene(hash: string, lastSyncedHash: string | null): boolean {
  return hash !== lastSyncedHash
}

/**
 * The files in a push that the editor does not hold yet.
 *
 * `addFiles` is a no-op for a file id the editor already has, so this is about
 * cost rather than correctness: an image-heavy board would otherwise re-decode
 * every data URL on every push.
 */
export function canvasFilesToAdd(
  pushFiles: CanvasScenePush['files'],
  editorFiles: Readonly<Record<string, unknown>>,
): unknown[] {
  const out: unknown[] = []
  for (const [id, file] of Object.entries(pushFiles ?? {})) {
    if (!file || typeof file !== 'object') continue
    if (editorFiles[id]) continue
    out.push(file)
  }
  return out
}

/**
 * A throttle that answers rather than schedules.
 *
 * The human-input note is fire-and-forget on every pointer down, and a
 * scheduling throttle would leave a timer to cancel on unmount for a call whose
 * whole point is that nothing waits on it. So the caller keeps the last-sent
 * timestamp and asks.
 */
export const CANVAS_HUMAN_INPUT_THROTTLE_MS = 500

export function shouldNoteHumanInput(now: number, lastNotedAt: number | null): boolean {
  return lastNotedAt === null || now - lastNotedAt >= CANVAS_HUMAN_INPUT_THROTTLE_MS
}

/** How long the tab waits after the last change before it commits. */
export const CANVAS_COMMIT_DEBOUNCE_MS = 400
