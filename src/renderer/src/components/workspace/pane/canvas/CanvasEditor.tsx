import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  exportToBlob,
  exportToSvg,
  isElementLink,
  reconcileElements,
} from '@excalidraw/excalidraw'
import type {
  BinaryFileData,
  BinaryFiles,
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from '@excalidraw/excalidraw/types'
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { RemoteExcalidrawElement } from '@excalidraw/excalidraw/data/reconcile'

import '@excalidraw/excalidraw/index.css'
import './canvasTheme.css'

import type {
  CanvasBoardState,
  CanvasElement,
  CanvasExportImages,
  CanvasPresence,
  CanvasScenePush,
} from '../../../../../../shared/canvas/types'
import { sceneVersionHash } from '../../../../../../shared/canvas/merge'
import { CANVAS_DEFAULT_BACKGROUND, reduceAppState } from '../../../../../../shared/canvas/scene-file'
import type { ColorScheme } from '../../../../types/appTheme'
import { Badge } from '../../../ui'
import {
  bufferCanvasPush,
  canApplyBufferedPush,
  canvasCommitOutcome,
  canvasFilesToAdd,
  canvasHashAfterFailedCommit,
  canvasPushMatchesBoard,
  canvasStateAfterPush,
  shouldApplyCanvasPush,
  shouldCommitCanvasScene,
  shouldNoteHumanInput,
  CANVAS_COMMIT_DEBOUNCE_MS,
  CANVAS_PUSH_RETRY_MS,
} from './canvasSync'
import type { CanvasBoardExporter } from './canvasExport'
import { canvasLinkAction } from './canvasLinks'

// The live editor, and the ONE file in the tree that imports
// `@excalidraw/excalidraw`. It is reached only through the `React.lazy` in
// `CanvasTab.tsx`, which is what keeps the heaviest dependency in the tree — and
// its stylesheet — off the boot path until a board is actually opened. A static
// import of this file anywhere eager would undo that without failing anything,
// so it stays the only door in.
//
// Everything about talking to main lives here too, because the parts that do it
// need values from the library (`reconcileElements`, `CaptureUpdateAction`) and
// importing those anywhere else would defeat the boundary. The tab above owns
// the board's lifecycle; this owns the scene.
//
// The two directions, and why each is shaped the way it is:
//
//   person → main  `onChange` fires on every pointer move, so it is debounced,
//                  and a scene whose version hash has not moved since the last
//                  one sent OR received is not sent at all. Without that second
//                  half, every scene main pushed us would bounce straight back.
//
//   main → editor  A push is a whole scene at a revision, and it is RECONCILED
//                  against what is on screen — which is what keeps the person's
//                  in-flight local edits. `captureUpdate: NEVER` keeps it off
//                  the undo stack: the person's ⌘Z must never undo an agent's
//                  work, and must never re-do it away either.
//
//                  NOT restored first, which is worth saying out loud because
//                  the obvious reading of the library's collaboration example
//                  says to. `restoreElements(remote, local)` in 0.18.1 does
//                  three things to a push that this sync cannot afford:
//                    * it `bumpVersion`s any remote element the LOCAL copy is
//                      ahead of, to `local.version + 1` — which then wins
//                      `reconcileElements`. A stale scene would overwrite the
//                      shape under the person's hand, the exact inversion of
//                      "the person always wins".
//                    * it runs `syncInvalidIndices` over the remote array
//                      ALONE, assigning fractional indices against a list that
//                      is not the merged one and bumping each version it
//                      touches, so the tab would owe main a write for every
//                      push it received.
//                    * it DROPS invisibly small elements (zero width and
//                      height, a linear element with one point) — including a
//                      tombstone for one, so a deletion of a just-created
//                      shape would never reach the tab and the element would
//                      come back from the local side of the reconcile.
//                  Nothing in a push needs repairing: every element main holds
//                  came from the library, either through the worker or through
//                  this tab's own commits, and the cold path — a board read off
//                  disk at mount — goes through `initialData`, which the editor
//                  restores itself. `reconcileElements` ends in the
//                  `syncInvalidIndices` that matters, over the MERGED array.
//
// The gesture rule is the reason the buffer exists: applying a scene while the
// person is dragging replaces the element under their pointer, so a push that
// lands mid-gesture waits for the pointer to come up. Only the newest is kept,
// because each one is the whole board.
//
// KEYBOARD AND CLIPBOARD, since a retained tab stays mounted behind whatever
// the person is actually typing into. The editor puts `copy`, `cut` and
// `paste` listeners on `document` whatever `handleKeyboardGlobally` says, and
// all three begin by asking whether `document.activeElement` is inside their
// own container — `paste` additionally requires the element under the last
// pointer position to be the drawing canvas. Focus in a terminal, the
// composer or another pane therefore falls through every one of them, so a
// mounted-but-hidden board cannot swallow a paste and no guard of ours is
// needed. (Verified against the shipped source, not the docs.) `keyup` is the
// one document listener with no such test, but it only ever sets editor state
// and never calls `preventDefault` or `stopPropagation`, so nothing can be
// taken from the surface that has focus.
//
// App chords keep working with a board focused because the shell resolves them
// on `window` in the CAPTURE phase, which runs before anything the editor
// binds; the only keys the editor stops are unmodified single letters (its
// tool shortcuts), and those are not app chords. Focus inside its text editing
// is a `<textarea>`, which the shell's own suppression rule already treats as
// "the person is typing" — the same answer Monaco and the terminal get.

/**
 * The board as the floating player shows it: a picture of the whole drawing,
 * fitted to the player, redrawn from every scene main pushes.
 *
 * Not the editor. A live editor in a 320px card is its toolbars and the corner
 * of the board the person last scrolled to; what the player is for is seeing
 * what an agent is drawing, wherever on the board it lands. Exported from this
 * file so the library stays behind the one door (`CanvasTab`'s `React.lazy`).
 *
 * Dark mode is the editor's own trick — the board's light colours under the
 * library's inverting filter — applied to the whole card, so the margin around
 * the picture darkens with it.
 */
export function CanvasMiniature({
  board,
  theme,
}: {
  board: Pick<CanvasBoardState, 'elements' | 'files' | 'appState'>
  theme: ColorScheme
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const background = reduceAppState(board.appState).viewBackgroundColor || CANVAS_DEFAULT_BACKGROUND
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const elements = board.elements.filter((element) => !element.isDeleted)
    if (elements.length === 0) {
      host.replaceChildren()
      return
    }
    // Pushes arrive faster than a render can finish while an agent draws: only
    // the newest render is put on screen.
    let stale = false
    void exportToSvg({
      elements: elements as unknown as readonly OrderedExcalidrawElement[],
      appState: { exportBackground: false, exportWithDarkMode: false, viewBackgroundColor: background },
      files: board.files as unknown as BinaryFiles,
      exportPadding: 16,
    })
      .then((svg: SVGSVGElement) => {
        if (stale) return
        svg.setAttribute('width', '100%')
        svg.setAttribute('height', '100%')
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
        host.replaceChildren(svg)
      })
      .catch(() => {
        // The last picture stays up: a frame behind beats a blank card.
      })
    return () => {
      stale = true
    }
  }, [background, board.elements, board.files])
  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className="h-full w-full"
      style={{ background, filter: theme === 'dark' ? CANVAS_DARK_FILTER : undefined }}
    />
  )
}

/** The library's dark theme: `--theme-filter` under `.theme--dark`. */
const CANVAS_DARK_FILTER = 'invert(93%) hue-rotate(180deg)'

type CanvasEditorProps = {
  workspaceId: string
  path: string
  /** The board as the tab last knew it. Read once, at mount. */
  initial: CanvasBoardState
  /** The board's name — the editor's document name, and what an export is called. */
  name: string
  theme: ColorScheme
  /** Whether the person can see this tab. A tab going out of view flushes. */
  active: boolean
  presence: CanvasPresence | null
  // The board actions, which live at the top of the editor's own menu. The tab
  // owns them — they need the tab record and the workspace root — and this
  // component only draws them, which is what keeps the package behind the lazy
  // boundary. `onRevealFile` is null when the workspace has no folder to reveal
  // into, and the item is left out rather than shown greyed.
  onSwitchBoard: () => void
  onRevealFile: (() => void) | null
  onCopyPath: () => void
  /**
   * Export to a folder. Handed this editor's half of the job — flush what is on
   * screen to main, then render the pictures asked for — so the tab can run the
   * dialog and the folder picker without importing the library.
   */
  onExport: (exporter: CanvasBoardExporter) => void
}

/**
 * A rendered picture as base64 for the trip to main. Chunked rather than one
 * spread: a megabyte of pixels is more arguments than `String.fromCharCode`
 * takes in one call.
 */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk))
  }
  return btoa(binary)
}

// The one collaborator slot an agent occupies. A stable id, so a second push
// replaces the first rather than stacking two ghosts on the board.
const AGENT_COLLABORATOR_ID = 'sprintengine-agent' as SocketId

// The editor's chrome we keep. Everything omitted is either a link out of the
// app, a network feature, or a second copy of something the pane already owns:
// the socials row, live collaboration, the library (a hosted gallery), "open"
// and "save to" (main owns the file), and the theme toggle (the app's theme
// decides, and passing `theme` already disables it).
const UI_OPTIONS = {
  // 0 keeps the right sidebar undocked at every width: a docked sidebar would
  // eat a pane that is 240px wide at its narrowest.
  dockedSidebarBreakpoint: 0,
  canvasActions: {
    loadScene: false,
    saveToActiveFile: false,
    export: false as const,
    saveAsImage: true,
    toggleTheme: false,
  },
} as const

export default function CanvasEditor({
  workspaceId,
  path,
  initial,
  name,
  theme,
  active,
  presence,
  onSwitchBoard,
  onRevealFile,
  onCopyPath,
  onExport,
}: CanvasEditorProps) {
  // The API handle as STATE, not a module-level or file-level variable: two
  // tabs on two boards are two editors, and React's development double-mount
  // constructs one of them twice. State keyed to this component instance is the
  // only place it can live where neither of those is a hazard. The ref mirrors
  // it for the callbacks below, which must not be re-created per handle.
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  apiRef.current = api

  // Read once. The editor reads `initialData` at construction and ignores every
  // later value, so freezing it here says so out loud rather than leaving a
  // prop that looks live and is not.
  const initialRef = useRef(initial)
  const board = useMemo(() => ({ workspaceId, path }), [workspaceId, path])
  // The board, readable from a cleanup that must run ONLY on unmount. An effect
  // that named `board` in its dependencies would tear down and set up again if
  // it ever changed, and that particular cleanup drops the editor handle — so
  // it is given nothing to re-run on instead.
  const boardRef = useRef(board)
  boardRef.current = board

  // The revision this tab is at, and the newest one it has applied. They move
  // together; two names because they answer different questions — what to cite
  // as a merge base, and what to refuse as already seen.
  const revisionRef = useRef(initial.revision)
  const appliedRevisionRef = useRef(initial.revision)
  // The hash of the last scene sent to main or applied from it. Both directions
  // write it, which is what makes it an echo guard rather than a send log.
  const syncedHashRef = useRef<string | null>(sceneVersionHash(initial.elements))
  const pendingPushRef = useRef<CanvasScenePush | null>(null)
  // When the buffered push started waiting: what lets a push out from behind a
  // text caret, which never ends on its own. See `canApplyBufferedPush`.
  const bufferedAtRef = useRef<number | null>(null)
  const pushRetryRef = useRef<number | null>(null)
  const commitTimerRef = useRef<number | null>(null)
  const humanInputAtRef = useRef<number | null>(null)
  // Set while this component is going away, so a debounce that fires during
  // teardown does not commit on behalf of a tab that no longer exists.
  const goneRef = useRef(false)

  const applyPush = useCallback((push: CanvasScenePush) => {
    const editor = apiRef.current
    if (!editor) return
    if (!shouldApplyCanvasPush(push.revision, appliedRevisionRef.current)) return

    // Hashed BEFORE the reconcile, because the reconcile mutates these very
    // objects: an element the remote side wins with is the same object, and
    // `syncInvalidIndices` bumps its version in place. This is the only moment
    // at which "what main holds" is still readable.
    const mainHash = sceneVersionHash(push.elements)

    const local = editor.getSceneElementsIncludingDeleted()
    const reconciled = reconcileElements(
      local,
      push.elements as unknown as readonly RemoteExcalidrawElement[],
      editor.getAppState(),
    )
    // Files first: an element that names an image the editor does not hold
    // paints as a broken box until the file lands, and `updateScene` is what
    // puts the element on screen.
    const files = canvasFilesToAdd(push.files, editor.getFiles())
    if (files.length > 0) editor.addFiles(files as BinaryFileData[])
    editor.updateScene({
      elements: reconciled,
      captureUpdate: CaptureUpdateAction.NEVER,
    })

    // The bookkeeping rule lives in `canvasStateAfterPush`, which is where it is
    // explained and where it is tested: the echo guard records what MAIN holds,
    // not what ended up on screen. A difference between the two is the
    // adjustment the editor had to make to accept the push — an agent-created
    // element arrives with no fractional index and is given one, which bumps
    // its version — and leaving the scene looking unsent is what gets that
    // adjustment back to main, once, through the debounce already running.
    const next = canvasStateAfterPush(
      {
        revision: revisionRef.current,
        appliedRevision: appliedRevisionRef.current,
        syncedHash: syncedHashRef.current,
      },
      { revision: push.revision, mainHash },
    )
    revisionRef.current = next.revision
    appliedRevisionRef.current = next.appliedRevision
    syncedHashRef.current = next.syncedHash
  }, [])

  const stopPushRetry = useCallback(() => {
    if (pushRetryRef.current === null) return
    window.clearInterval(pushRetryRef.current)
    pushRetryRef.current = null
  }, [])

  const flushPendingPush = useCallback(() => {
    const push = pendingPushRef.current
    // `goneRef` matters here because this is also reached from a timer the
    // unmount does not cancel: the handle would still point at an editor that
    // has been torn down, and asking a torn-down one for its state throws.
    if (!push || goneRef.current) {
      stopPushRetry()
      return
    }
    const editor = apiRef.current
    if (!editor) return
    const allowed = canApplyBufferedPush({
      busy: editor.getAppState(),
      bufferedAt: bufferedAtRef.current ?? Date.now(),
      now: Date.now(),
    })
    if (!allowed) return
    pendingPushRef.current = null
    bufferedAtRef.current = null
    stopPushRetry()
    applyPush(push)
  }, [applyPush, stopPushRetry])

  /**
   * The backstop.
   *
   * Without it the only things that ever retry a buffered push are `onChange`
   * and pointer-up, so a push could wait behind a gesture that ended without
   * either — or behind a caret left in a label indefinitely.
   */
  const startPushRetry = useCallback(() => {
    if (pushRetryRef.current !== null) return
    pushRetryRef.current = window.setInterval(() => flushPendingPush(), CANVAS_PUSH_RETRY_MS)
  }, [flushPendingPush])

  const bufferPush = useCallback(
    (push: CanvasScenePush) => {
      pendingPushRef.current = bufferCanvasPush(pendingPushRef.current, push)
      if (bufferedAtRef.current === null) bufferedAtRef.current = Date.now()
      startPushRetry()
    },
    [startPushRetry],
  )

  const commitNow = useCallback(async () => {
    const editor = apiRef.current
    if (!editor || goneRef.current) return
    const elements = editor.getSceneElementsIncludingDeleted() as unknown as CanvasElement[]
    const hash = sceneVersionHash(elements)
    if (!shouldCommitCanvasScene(hash, syncedHashRef.current)) return
    const previousHash = syncedHashRef.current
    // Claimed before the await: a second change arriving while this one is in
    // flight must compare against what we are sending, not against what we sent
    // before it.
    syncedHashRef.current = hash
    const baseRevision = revisionRef.current
    let result: Awaited<ReturnType<typeof window.api.canvasCommitScene>>
    try {
      result = await window.api.canvasCommitScene({
        workspaceId: board.workspaceId,
        path: board.path,
        baseRevision,
        elements,
        appState: reduceAppState(editor.getAppState() as unknown as Record<string, unknown>),
        files: editor.getFiles() as unknown as Record<string, unknown>,
      })
    } catch {
      // Main is gone or the channel is not there. Put the hash back so the next
      // change tries again rather than being read as already saved.
      syncedHashRef.current = canvasHashAfterFailedCommit(syncedHashRef.current, hash, previousHash)
      return
    }
    if (!result.ok) {
      syncedHashRef.current = canvasHashAfterFailedCommit(syncedHashRef.current, hash, previousHash)
      return
    }
    const outcome = canvasCommitOutcome(result.value, appliedRevisionRef.current)
    if (outcome.kind === 'stale') return
    if (outcome.kind === 'reconcile' && result.value.elements) {
      // The merge differed from what we sent — an agent or the disk got there
      // first — so the answer is applied exactly as a push is, which is also
      // what moves both revisions and the echo hash.
      applyPush({
        workspaceId: board.workspaceId,
        path: board.path,
        revision: result.value.revision,
        elements: result.value.elements,
        // The merge answers with elements alone; every file in the scene is one
        // this tab just sent, so the editor already holds it.
        files: {},
        origin: 'human',
      })
      return
    }
    if (outcome.kind !== 'accepted') return
    // Main took exactly what was sent: what is on screen IS that revision.
    revisionRef.current = outcome.revision
    appliedRevisionRef.current = outcome.revision
  }, [applyPush, board.path, board.workspaceId])

  const cancelCommitTimer = useCallback(() => {
    if (commitTimerRef.current === null) return
    window.clearTimeout(commitTimerRef.current)
    commitTimerRef.current = null
  }, [])

  const flushCommit = useCallback(() => {
    cancelCommitTimer()
    void commitNow()
  }, [cancelCommitTimer, commitNow])

  const onChange = useCallback(() => {
    // Never `updateScene` from inside `onChange`: the editor is mid-update, and
    // re-entering it there is how a scene ends up half applied. The buffered
    // push is flushed on the next task instead, which is also where a gesture
    // that ended without a pointer-up event (a key-driven one) is picked up.
    if (pendingPushRef.current) window.setTimeout(flushPendingPush, 0)
    cancelCommitTimer()
    commitTimerRef.current = window.setTimeout(flushCommit, CANVAS_COMMIT_DEBOUNCE_MS)
  }, [cancelCommitTimer, flushCommit, flushPendingPush])

  // Scenes from main. Subscribed as soon as this component exists rather than
  // when the API handle arrives: a push that lands in between is buffered and
  // applied by the effect below once there is an editor to apply it to.
  useEffect(() => {
    return window.api.onCanvasScene((push) => {
      if (!canvasPushMatchesBoard(push, board)) return
      if (!shouldApplyCanvasPush(push.revision, appliedRevisionRef.current)) return
      const editor = apiRef.current
      const now = Date.now()
      const applicable =
        editor !== null &&
        canApplyBufferedPush({ busy: editor.getAppState(), bufferedAt: bufferedAtRef.current ?? now, now })
      if (!applicable) {
        bufferPush(push)
        return
      }
      applyPush(push)
    })
  }, [applyPush, board, bufferPush])

  useEffect(() => {
    if (api) flushPendingPush()
  }, [api, flushPendingPush])

  // An agent's presence, drawn the way a collaborator is: their selection is
  // outlined and their cursor is shown. A fresh Map every time — the editor
  // holds the one it is given, so mutating the previous one would change state
  // it has already rendered — and an empty one when the agent lets go, because
  // a ghost that never leaves is worse than no ghost at all.
  useEffect(() => {
    if (!api) return
    const collaborators = new Map<SocketId, Collaborator>()
    if (presence?.controller === 'agent') {
      collaborators.set(AGENT_COLLABORATOR_ID, {
        username: presence.agentName ?? 'Agent',
        selectedElementIds: Object.fromEntries((presence.selectedElementIds ?? []).map((id) => [id, true] as const)),
        ...(presence.pointer
          ? { pointer: { x: presence.pointer.x, y: presence.pointer.y, tool: 'pointer' as const } }
          : {}),
      })
    }
    api.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER })
  }, [api, presence])

  // Flush on the ways a tab stops being looked at. A change the person made in
  // the last 400ms must not be lost to a tab switch, a window closing, or the
  // app losing focus while they go and read something else.
  useEffect(() => {
    if (!active) flushCommit()
  }, [active, flushCommit])

  useEffect(() => {
    const flush = () => flushCommit()
    window.addEventListener('beforeunload', flush)
    window.addEventListener('blur', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('blur', flush)
    }
  }, [flushCommit])

  // Teardown: stop the pending debounce, then make the last write by hand. It
  // cannot go through `flushCommit`, because the first thing this does is mark
  // the component gone — which is what stops a debounce that fires DURING
  // teardown from committing on behalf of a tab that no longer exists.
  useEffect(() => {
    goneRef.current = false
    return () => {
      goneRef.current = true
      cancelCommitTimer()
      stopPushRetry()
      const editor = apiRef.current
      // Nothing may reach the editor after this point; the handle is dropped so
      // a callback that outlives the component finds nothing rather than a
      // destroyed instance.
      apiRef.current = null
      if (!editor) return
      const elements = editor.getSceneElementsIncludingDeleted() as unknown as CanvasElement[]
      const hash = sceneVersionHash(elements)
      if (!shouldCommitCanvasScene(hash, syncedHashRef.current)) return
      syncedHashRef.current = hash
      // Not awaited and not retried: the component is going away, and main
      // answers on its own timeline. A failure here loses at most the last
      // 400ms of drawing, which is the same thing a crash would lose.
      void window.api
        .canvasCommitScene({
          workspaceId: boardRef.current.workspaceId,
          path: boardRef.current.path,
          baseRevision: revisionRef.current,
          elements,
          appState: reduceAppState(editor.getAppState() as unknown as Record<string, unknown>),
          files: editor.getFiles() as unknown as Record<string, unknown>,
        })
        .catch(() => {})
    }
  }, [cancelCommitTimer, stopPushRetry])

  const noteHumanInput = useCallback(() => {
    const now = Date.now()
    if (!shouldNoteHumanInput(now, humanInputAtRef.current)) return
    humanInputAtRef.current = now
    try {
      window.api.canvasNoteHumanInput({ workspaceId: board.workspaceId, path: board.path })
    } catch {
      // Fire-and-forget by contract: the person is drawing, and a missing
      // channel must not interrupt them.
    }
  }, [board.path, board.workspaceId])

  /**
   * This editor's half of an export.
   *
   * The commit comes first and is awaited: main writes the board file from
   * what IT holds, so the last few hundred milliseconds of drawing have to
   * reach it before the file is copied, or the export is a revision behind the
   * screen. The pictures are rendered from the same scene, in the light theme
   * and on the board's own background — a picture committed to a repository is
   * read by people whose theme is not the one this app happened to be in.
   */
  const exportBoard = useCallback<CanvasBoardExporter>(
    async (formats) => {
      cancelCommitTimer()
      await commitNow()
      const editor = apiRef.current
      if (!editor) return {}
      const images: CanvasExportImages = {}
      if (!formats.png && !formats.svg) return images
      const elements = editor.getSceneElements()
      if (elements.length === 0) return images
      const files = editor.getFiles()
      const appState = {
        exportBackground: true,
        exportWithDarkMode: false,
        exportEmbedScene: false,
        viewBackgroundColor: editor.getAppState().viewBackgroundColor || CANVAS_DEFAULT_BACKGROUND,
      }
      if (formats.png) {
        const blob = await exportToBlob({ elements, appState, files, mimeType: 'image/png', exportPadding: 16 })
        images.png = await blobToBase64(blob)
      }
      if (formats.svg) {
        const svg = await exportToSvg({ elements, appState, files, exportPadding: 16 })
        images.svg = svg.outerHTML
      }
      return images
    },
    [cancelCommitTimer, commitNow],
  )

  const initialData = useMemo(() => {
    const persisted = reduceAppState(initialRef.current.appState)
    return {
      elements: initialRef.current.elements as unknown as readonly OrderedExcalidrawElement[],
      appState: {
        ...persisted,
        // The board's own background, which is a LIGHT colour even on a dark
        // app: the editor renders dark mode by inverting the canvas with a CSS
        // filter, so a dark value here would come out white.
        viewBackgroundColor: persisted.viewBackgroundColor || CANVAS_DEFAULT_BACKGROUND,
      },
      files: initialRef.current.files as unknown as BinaryFiles,
      // A board that already has something on it opens showing it, rather than
      // at whatever origin the last person to draw happened to be near.
      scrollToContent: initialRef.current.elements.length > 0,
    }
  }, [])

  // The board actions first, because they are about WHICH board this is rather
  // than about what is drawn on it — and because this menu is where the pane's
  // band used to be. Library-rendered rows, so they are the editor's own
  // controls rather than ours; the labels are still in our voice.
  const mainMenu = useMemo(
    () => (
      <MainMenu>
        <MainMenu.Group title={name}>
          <MainMenu.Item onSelect={onSwitchBoard}>Switch board…</MainMenu.Item>
          {onRevealFile ? <MainMenu.Item onSelect={onRevealFile}>Reveal file</MainMenu.Item> : null}
          <MainMenu.Item onSelect={onCopyPath}>Copy path</MainMenu.Item>
          <MainMenu.Item onSelect={() => onExport(exportBoard)}>Export to folder…</MainMenu.Item>
        </MainMenu.Group>
        <MainMenu.Separator />
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
        <MainMenu.DefaultItems.ClearCanvas />
      </MainMenu>
    ),
    [exportBoard, name, onCopyPath, onExport, onRevealFile, onSwitchBoard],
  )

  /**
   * The Agent badge, in the editor's own top-right row beside the Library
   * button. Rendered as nothing at all when no agent holds the pen, so the row
   * reserves no space for a badge that is not there. The library calls this for
   * both its layouts — the desktop row and the compact one — so there is one
   * badge and one place for it.
   */
  const renderTopRightUI = useCallback(
    () =>
      presence?.controller === 'agent' ? (
        // `shrink-0` because the row it lands in is the editor's own flex row,
        // beside the collaborator avatars and the Library button, and it will
        // squeeze anything that lets it — which turned the pill into a sliver
        // with its own label hanging out of it.
        <Badge tone="accent" ariaLabel="An agent is drawing on this board" className="shrink-0 whitespace-nowrap">
          Agent
        </Badge>
      ) : null,
    [presence?.controller],
  )

  // See canvasLinks.ts: the editor's own link handling can put a web page in
  // this window, so every click is decided there and the default never runs.
  const onLinkOpen = useCallback(
    (element: { link: string | null }, event: CustomEvent<{ nativeEvent: MouseEvent | React.PointerEvent }>) => {
      event.preventDefault()
      if (!element.link) return
      const action = canvasLinkAction(element.link, isElementLink)
      if (action.kind === 'element') api?.scrollToContent(element.link, { fitToContent: true, animate: true })
      else if (action.kind === 'external') void window.api.openExternal(action.url)
    },
    [api],
  )

  return (
    <Excalidraw
      excalidrawAPI={setApi}
      initialData={initialData}
      name={name}
      theme={theme}
      langCode="en"
      aiEnabled={false}
      autoFocus={false}
      // The app's own chords are resolved on `window` in the capture phase, so
      // they win whatever this is set to. What this decides is whether the
      // editor ALSO claims keys while focus is somewhere else entirely — a
      // terminal, the composer — which a retained hidden tab would do all day.
      handleKeyboardGlobally={false}
      // Nothing on a board is an embeddable in this app: there is no browser
      // behind the canvas, and a link the person pasted must not become a live
      // frame in their project's file.
      validateEmbeddable={false}
      UIOptions={UI_OPTIONS}
      renderTopRightUI={renderTopRightUI}
      onChange={onChange}
      onPointerDown={noteHumanInput}
      onPointerUp={flushPendingPush}
      onLinkOpen={onLinkOpen}
    >
      {mainMenu}
    </Excalidraw>
  )
}
