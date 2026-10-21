import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { CanvasBoardState, CanvasPresence } from '../../../../../../shared/canvas/types'
import { canvasBoardName } from '../../../../../../shared/canvas/paths'
import { useResolvedColorScheme } from '../../../../hooks/useAppTheme'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { showToast } from '../../../../store/toastStore'
import type { WorkspacePaneTab } from '../../../../types/workspace'
import { EmptyState, PrimaryButton } from '../../../ui'
import { SuspenseFallback } from '../../../ui/SuspenseFallback'
import { CanvasBoardPicker } from './CanvasBoardPicker'
import { CanvasExportDialog } from './CanvasExportDialog'
import { canvasExportedToast, type CanvasBoardExporter, type CanvasExportFormats } from './canvasExport'
import { canvasPushMatchesBoard, shouldApplyCanvasPush } from './canvasSync'
import { StudioSkillSuggestion } from '../../../studioSkills/StudioSkillSuggestion'

// The Canvas tab: the board's lifecycle, the board actions, and the picker a
// tab with no board yet shows.
//
// It draws NO chrome of its own. The editor fills the tab body from directly
// under the pane's tab strip — that strip already names the board, and a second
// copy of the name under a hairline cost a strip of drawing surface to say
// nothing new. The actions the band used to hold are handed to the editor as
// callbacks and drawn in its own menu; the Agent badge is drawn in its own
// top-right row.
//
// Deliberately free of the editor. `CanvasEditor` is the only file that imports
// `@excalidraw/excalidraw`, and it is reached from here through `React.lazy`
// alone — so a tab sitting on the picker never fetches a megabyte of editor,
// and the boot chunk never sees it at all.
const CanvasEditor = React.lazy(() => import('./CanvasEditor'))
const CanvasMiniature = React.lazy(() =>
  import('./CanvasEditor').then((module) => ({ default: module.CanvasMiniature })),
)

type CanvasTabProps = {
  workspaceId: string
  tab: WorkspacePaneTab
  active: boolean
}

type BoardState = { kind: 'loading' } | { kind: 'ready'; board: CanvasBoardState } | { kind: 'error'; message: string }

export function CanvasTab({ workspaceId, tab, active }: CanvasTabProps) {
  const path = tab.canvas?.path ?? null
  const updatePaneTab = useWorkspaceStore((s) => s.updatePaneTab)
  const setPaneTabBoard = useWorkspaceStore((s) => s.setPaneTabBoard)
  // The boards this pane's OTHER tabs hold, so the picker can say which of its
  // rows would move the person rather than open something new. Selected as one
  // string and split below: a selector that built a fresh array every time
  // would re-render this tab on every store change. The separator is the one
  // character a board path may never contain.
  const openBoardPaths = useWorkspaceStore((s) => {
    const tabs = s.workspaces.find((w) => w.id === workspaceId)?.paneState?.tabs ?? []
    return tabs
      .filter((candidate) => candidate.kind === 'canvas' && candidate.id !== tab.id && candidate.canvas)
      .map((candidate) => candidate.canvas!.path)
      .join('\u0000')
  })
  const openPaths = useMemo(() => (openBoardPaths ? openBoardPaths.split('\u0000') : []), [openBoardPaths])
  const workspaceRoot = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null)
  const theme = useResolvedColorScheme()
  const [state, setState] = useState<BoardState>({ kind: 'loading' })
  const [presence, setPresence] = useState<CanvasPresence | null>(null)
  const [attempt, setAttempt] = useState(0)
  const hostRef = useRef<HTMLDivElement | null>(null)
  // The editor is not rendered until its container has had a size. A retained
  // hidden layer keeps its layout box (it is `invisible`, not `display:none`),
  // but a CLOSED pane is a zero-width column — and an editor constructed at
  // 0x0 measures itself into the library's phone layout and lays the scene out
  // against a viewport that does not exist. Once it has been sized it STAYS
  // mounted: the pane closing again must not throw the board away.
  const [sized, setSized] = useState(false)
  // Floating, the tab is a picture of the board (CanvasMiniature) laid over
  // whatever editor it already has. A board that floats before it was ever
  // opened in the pane builds no editor for the card's 320px: it is built when
  // the pane opens on it.
  const miniature = tab.floating === true

  useLayoutEffect(() => {
    if (sized || !path || miniature) return
    const host = hostRef.current
    if (!host) return
    const measure = (): boolean => {
      const rect = host.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      setSized(true)
      return true
    }
    if (measure()) return
    const observer = new ResizeObserver(() => {
      if (measure()) observer.disconnect()
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [miniature, path, sized])

  // Open the board and subscribe this window to it; close it on the way out, so
  // main stops pushing scenes to a tab that is gone. Re-runs on `attempt` for
  // the retry, and on `path` when the person switches board.
  useEffect(() => {
    if (!path) return
    let cancelled = false
    setState({ kind: 'loading' })
    setPresence(null)
    void (async () => {
      try {
        const result = await window.api.canvasOpenBoard({ workspaceId, path, create: true })
        if (cancelled) return
        setState(result.ok ? { kind: 'ready', board: result.value } : { kind: 'error', message: result.error.message })
      } catch {
        if (!cancelled) setState({ kind: 'error', message: 'This board could not be opened.' })
      }
    })()
    return () => {
      cancelled = true
      // Unconditional: closing a board that never opened is a no-op on the main
      // side, and skipping it after a failed open would leak the subscription
      // that a partially-successful open left behind.
      try {
        void window.api.canvasCloseBoard({ workspaceId, path })
      } catch {
        // Main is already gone (the window is closing). Nothing to release.
      }
    }
  }, [attempt, path, workspaceId])

  // Scenes from main are folded into the board this tab holds, whether or not
  // the editor is mounted yet. A push is the WHOLE board, so the newest one is
  // the whole answer — which makes this record the right `initialData` for an
  // editor that mounts later (a pane that was closed when an agent drew).
  // The mounted editor applies the same pushes itself, with reconciliation.
  useEffect(() => {
    if (!path) return
    return window.api.onCanvasScene((push) => {
      if (!canvasPushMatchesBoard(push, { workspaceId, path })) return
      setState((previous) => {
        if (previous.kind !== 'ready') return previous
        if (!shouldApplyCanvasPush(push.revision, previous.board.revision)) return previous
        return {
          kind: 'ready',
          board: {
            ...previous.board,
            revision: push.revision,
            elements: push.elements,
            files: push.files,
          },
        }
      })
    })
  }, [path, workspaceId])

  useEffect(() => {
    if (!path) return
    return window.api.onCanvasPresence((incoming) => {
      if (!canvasPushMatchesBoard(incoming, { workspaceId, path })) return
      setPresence({
        controller: incoming.controller,
        agentName: incoming.agentName,
        pointer: incoming.pointer,
        selectedElementIds: incoming.selectedElementIds,
      })
    })
  }, [path, workspaceId])

  const pickBoard = useCallback(
    (next: string) => {
      // Through the slice, not `updatePaneTab`: a board another tab already
      // holds brings that tab forward and closes this picker, and the tab's
      // title follows its board either way.
      setPaneTabBoard(workspaceId, tab.id, next)
    },
    [setPaneTabBoard, tab.id, workspaceId],
  )

  const switchBoard = useCallback(() => {
    updatePaneTab(workspaceId, tab.id, { canvas: undefined })
  }, [tab.id, updatePaneTab, workspaceId])

  // The board actions, handed to the editor to put in its own menu. They
  // are defined here, where the tab record and the workspace root live, and the
  // editor only calls them — which is what keeps `CanvasTab` free of the
  // package. `revealFile` is null rather than disabled when the workspace has
  // no folder: an item that cannot do anything is better left out than shown
  // greyed with no explanation.
  //
  // Main finds the file: a board in the app's store lives in the app's data
  // folder, outside the project, where no join against the workspace root
  // would find it.
  const revealFile = useCallback(() => {
    if (!workspaceRoot || !path) return
    void window.api.canvasRevealBoard({ workspaceId, path }).catch(() => {})
  }, [path, workspaceId, workspaceRoot])

  const copyPath = useCallback(() => {
    if (!path) return
    // The board's own path — a bare file name for a store board, a
    // project-relative one otherwise: the spelling the canvas tools take, and
    // the one that means the same thing on another machine.
    void window.api.clipboardWriteText(path)
    showToast({ tone: 'good', title: 'Board path copied', description: path })
  }, [path])

  // Export: the editor hands up its half (flush, then render the pictures), the
  // dialog asks which files, and main shows the folder picker and writes them.
  // The editor's half is kept in a ref rather than state: it is a function the
  // dialog calls once, not something this tab renders from.
  const exporterRef = useRef<CanvasBoardExporter | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportPending, setExportPending] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const openExport = useCallback((exporter: CanvasBoardExporter) => {
    exporterRef.current = exporter
    setExportError(null)
    setExportOpen(true)
  }, [])

  const cancelExport = useCallback(() => {
    setExportOpen(false)
    setExportError(null)
  }, [])

  const runExport = useCallback(
    async (formats: CanvasExportFormats) => {
      const exporter = exporterRef.current
      if (!path || !exporter) return
      setExportPending(true)
      setExportError(null)
      try {
        const images = await exporter(formats)
        const result = await window.api.canvasExportBoard({
          workspaceId,
          path,
          ...(workspaceRoot ? { defaultDirectory: workspaceRoot } : {}),
          images,
        })
        if (!result.ok) {
          setExportError(result.error.message)
          return
        }
        // Dismissing the folder picker is a change of mind, not a failure: the
        // dialog stays open on the same choice so a second press tries again.
        if (result.value.cancelled) return
        setExportOpen(false)
        showToast({ tone: 'good', ...canvasExportedToast(result.value) })
      } catch (error) {
        setExportError(error instanceof Error ? error.message : 'The board could not be exported.')
      } finally {
        setExportPending(false)
      }
    },
    [path, workspaceId, workspaceRoot],
  )

  if (!path) {
    return <CanvasBoardPicker workspaceId={workspaceId} onPick={pickBoard} openPaths={openPaths} />
  }

  const name = canvasBoardName(path)

  // No band of chrome above the editor. The pane's tab strip already carries
  // the board's name, and a second copy of it under a hairline was a strip of
  // the drawing surface spent saying nothing new — so the editor starts
  // directly under the strip and fills the tab. What the band held moved into
  // the space the editor already spends: the board actions are items at
  // the top of its own menu, and an agent's presence is a badge in its
  // top-right corner.
  //
  // The one line allowed above it is the Canvas skill's offer, shown until the
  // person answers it once (StudioSkillSuggestion); the host is measured, so the
  // editor takes the height back when it goes.
  return (
    <div className="relative flex h-full w-full flex-col">
      <StudioSkillSuggestion
        skillId="studio-canvas"
        className="shrink-0 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3 py-2"
      />
      <div
        ref={hostRef}
        className={`relative min-h-0 w-full flex-1 bg-[color:var(--bg-app)]${miniature ? ' isolate' : ''}`}
      >
        {state.kind === 'error' ? (
          <EmptyState
            title="This board could not be opened"
            body={state.message}
            action={<PrimaryButton onClick={() => setAttempt((n) => n + 1)}>Try again</PrimaryButton>}
          />
        ) : state.kind === 'loading' || !sized ? (
          <SuspenseFallback label="Opening the board" />
        ) : (
          // `se-canvas` is the wrapper canvasTheme.css maps the editor's own
          // variables onto our tokens under. Keyed on the board so switching to
          // another one builds a new editor rather than re-pointing this one:
          // the scene, the undo stack and the viewport all belong to a board.
          <div className="se-canvas absolute inset-0">
            <React.Suspense fallback={<SuspenseFallback label="Loading the canvas" />}>
              <CanvasEditor
                key={path}
                workspaceId={workspaceId}
                path={path}
                initial={state.board}
                name={name}
                theme={theme}
                active={active}
                presence={presence}
                onSwitchBoard={switchBoard}
                onRevealFile={workspaceRoot ? revealFile : null}
                onCopyPath={copyPath}
                onExport={openExport}
              />
            </React.Suspense>
          </div>
        )}
        <CanvasExportDialog
          open={exportOpen}
          boardName={name}
          pending={exportPending}
          error={exportError}
          onCancel={cancelExport}
          onExport={(formats) => void runExport(formats)}
        />
      </div>
      {/* Over the editor and the skill's offer, under the player's own
          chrome (FloatingPlayerChrome, at `--z-float` in the same stacking
          context). No tier of its own: it is the last positioned layer in
          the tab, and the editor's host is isolated while it is up, so none
          of the library's own stacking climbs over the picture. */}
      {miniature && state.kind === 'ready' ? (
        <div className="absolute inset-0">
          <React.Suspense fallback={null}>
            <CanvasMiniature board={state.board} theme={theme} />
          </React.Suspense>
        </div>
      ) : null}
    </div>
  )
}
