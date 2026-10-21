import React, { useCallback, useMemo } from 'react'

import { getRendererHost, selectModuleEnabled } from '../../../modules'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { paneKindFloats } from '../../../store/slices/workspacePaneSlice'
import type { WorkspacePaneTab } from '../../../types/workspace'
import { SuspenseFallback } from '../../ui/SuspenseFallback'
import { resolveWorkspaceWorktree } from '../../../utils/workspaceWorktree'
import { useChangelists } from '../../../hooks/useChangelists'
import { useWorkspaceTerminalSessions } from '../../../hooks/useTerminalSessions'
import { defaultDiffChangelistId } from '../../../utils/diffChangelistDefault'
import { paneKindRetainsPanel } from './paneKinds'
import { FloatingPlayerChrome, useFloatRect } from './FloatingPlayer'
import { clientSupports } from '../../../clientCapabilities'
import { AgentEdge, EmptyState, OpenInWindowGlyph, OutlineButton, PrimaryButton } from '../../ui'
import { bringBackPaneTab, showPanePopOut } from './popout/panePopOutHost'
import { paneTabLabel } from './paneTabItem'
import { useRecordingTabIds } from './browser/recordingTabs'
import { useAgentPresentTabIds } from './agentPresence'

// The pane's content region: one layer per tab that needs to stay mounted
// (terminal, browser, canvas) plus the active tab. Inactive retained layers are
// `invisible` rather than `hidden` so xterm keeps its measured size and a tab
// switch never refits the buffer; everything else mounts only while showing.
// A canvas layer hides the same way, and for the same reason: the editor
// measures its container, and a layer with no box would be re-laid-out on
// every tab switch. The offscreen park below is the browser's alone — it exists
// because a <webview> guest cannot survive `visibility: hidden`.

const FileExplorer = React.lazy(() => import('../../panels/FileExplorer'))
const PlainTerminalPanel = React.lazy(() => import('../../panels/PlainTerminalPanel'))
// The diff viewer's own UI (Monaco itself is loaded at boot, see
// utils/monacoRuntime.ts); lazy so a pane without a Diff tab never evaluates it.
const DiffViewer = React.lazy(() =>
  import('../../auxWindows/DiffViewer').then((module) => ({ default: module.DiffViewer })),
)
const BrowserTab = React.lazy(() => import('./browser/BrowserTab').then((module) => ({ default: module.BrowserTab })))
const PreviewTab = React.lazy(() => import('./browser/PreviewTab').then((module) => ({ default: module.PreviewTab })))
// The canvas editor is the heaviest dependency in the tree, and this is the
// boundary that keeps it off the boot path: nothing is drawn on a board until a
// Canvas tab is on screen, so its evaluation waits for one. A local lazy const rather
// than a host-registered panel because the tab needs the tab RECORD — which
// board it is on — and whether it is the one on screen, and a host panel is
// handed neither; the same split dev-tools makes for its explorer.
const CanvasTab = React.lazy(() => import('./canvas/CanvasTab').then((module) => ({ default: module.CanvasTab })))
const AgentsTab = React.lazy(() => import('./agents/AgentsTab').then((module) => ({ default: module.AgentsTab })))
const DocumentTab = React.lazy(() =>
  import('./document/DocumentTab').then((module) => ({ default: module.DocumentTab })),
)

// An inactive layer is normally `invisible`; a browser layer is parked
// offscreen instead. Electron blanks a `visibility:hidden` guest for good on
// macOS, and a guest fully outside the window stops compositing without
// losing its page. Parking is the only hiding a browser layer survives.
const OFFSCREEN_LAYER_STYLE: React.CSSProperties = {
  visibility: 'visible',
  transform: 'translateX(-100000px)',
  pointerEvents: 'none',
}

// Parked outside the window, a guest paints nothing, so a tab being recorded
// out of view gave its recording no frames and the video froze on the last
// one. While it records it waits where it is instead, under everything else
// in the window: Chromium still composites it there, and nothing of it shows
// or takes a click.
const BEHIND_APP_LAYER_STYLE: React.CSSProperties = {
  visibility: 'visible',
  zIndex: 'var(--z-parked)',
  pointerEvents: 'none',
}

/** How a browser layer out of view is hidden: behind the app while it records, else outside the window. */
export function hiddenBrowserLayerStyle(recording: boolean): React.CSSProperties {
  return recording ? BEHIND_APP_LAYER_STYLE : OFFSCREEN_LAYER_STYLE
}

// The explicit, labelled unavailable state (never a silently blank surface) —
// the same copy WorkspaceLayout shows for a disabled or stale FlexLayout tab.
function PaneUnavailable() {
  return (
    <div
      role="note"
      aria-label="Panel unavailable"
      className="flex h-full flex-col items-center justify-center gap-1 bg-[color:var(--bg-app)] px-6 text-center"
    >
      <p className="text-meta font-medium text-[color:var(--text-strong)]">Panel unavailable</p>
      <p className="max-w-xs text-micro leading-5 text-[color:var(--text-muted)]">
        This view isn’t available right now. Its feature may be disabled, or the tab may be out of date.
      </p>
    </div>
  )
}

/**
 * Where a popped-out tab's body would be. The body is mounted in the tab's own
 * window, and mounting it here as well would put one terminal, one page, one
 * live board on screen twice — and for a terminal or a browser, take it back
 * from the window. So the pane says where the tab is, and offers the two ways
 * to it: the window, or the tab back here.
 */
function PanePoppedOutPlaceholder({ workspaceId, tab }: { workspaceId: string; tab: WorkspacePaneTab }) {
  const popOutId = tab.poppedOut
  return (
    <div role="note" className="h-full bg-[color:var(--bg-surface)]">
      <EmptyState
        glyph={<OpenInWindowGlyph className="icon-lg" />}
        title="Shown in a separate window"
        body={`${paneTabLabel(tab)} is open in a window of its own. Bring it back to show it here again.`}
        action={
          <>
            {popOutId ? (
              <OutlineButton size="sm" onClick={() => showPanePopOut(popOutId)}>
                Show window
              </OutlineButton>
            ) : null}
            <PrimaryButton size="sm" onClick={() => bringBackPaneTab(workspaceId, tab)}>
              Bring back
            </PrimaryButton>
          </>
        }
      />
    </div>
  )
}

/**
 * The pane's Diff tab, and the one place the DEFAULT changelist filter is
 * chosen (agent changelists, Wave 4).
 *
 * It lives here rather than in the pane's "+" menu because every way of opening
 * an unaddressed Diff tab ends here: the "+ Diff" item, the letter accelerator,
 * a Diff tab restored from disk with nothing in it. A filter picked at the menu
 * would be picked once and then be wrong for the other two.
 *
 * The rule is narrow on purpose. A tab that names a changelist keeps it; a tab
 * that names a FILE keeps all changes, because a person who asked for a file's
 * diff has not asked to be shown one agent's slice of the repository — and a
 * default filter that hid the file they asked for would be the worst failure
 * this feature can have. Only the empty request consults the workspace.
 *
 * Its own component so the changelist read is mounted with the Diff tab and
 * nowhere else: a hook in `PaneTabPanel` would run for every tab kind.
 */
function PaneDiffTab({
  workspaceId,
  repoRoot,
  tab,
  active,
  onDiffCountChange,
}: {
  workspaceId: string
  repoRoot: string
  tab: WorkspacePaneTab
  active: boolean
  onDiffCountChange?: (count: number | null) => void
}) {
  const lastActiveAgentId = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.lastActiveAgentId ?? null,
  )
  const asked = tab.diff?.changelistId ?? null
  const wantsDefault = !asked && !tab.diff?.focusPath && Boolean(lastActiveAgentId)
  // Read only when a default is actually in question. An addressed Diff tab
  // makes no changelist call at all, which is what keeps every diff opened from
  // a Git row exactly the diff it was before.
  const { changelists } = useChangelists(wantsDefault ? repoRoot : null)
  // The agent's own terminal names the chat its process was launched in, which
  // for one dragged here from another chat is where its list is filed. Found by
  // the session id its record holds, which is unique where the agent id is not.
  const agentSessionId = useWorkspaceStore((s) =>
    lastActiveAgentId
      ? (s.workspaces.find((w) => w.id === workspaceId)?.agents[lastActiveAgentId]?.cliSessionId ?? null)
      : null,
  )
  const workspaceSessions = useWorkspaceTerminalSessions(workspaceId)
  const launchWorkspaceId = agentSessionId
    ? (workspaceSessions.find((session) => session.sessionId === agentSessionId)?.launchWorkspaceId ?? null)
    : null
  const changelistId =
    asked ??
    (wantsDefault
      ? defaultDiffChangelistId({ id: workspaceId, lastActiveAgentId }, changelists, launchWorkspaceId)
      : null)
  // Diff tours. The tab keeps what the viewer has open (so a tab switch does
  // not lose a playing tour) and a tour an agent has offered; the viewer tells
  // it when either changes.
  const tourCurrent = tab.diff?.tour ?? null
  const tourOffer = tab.diff?.tourOffer ?? null
  const tourHost = useMemo(
    () => ({ current: tourCurrent, offer: tourOffer }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tourCurrent?.id, tourCurrent?.playing, tourOffer],
  )
  const writeTourFields = useCallback(
    (patch: (diff: NonNullable<WorkspacePaneTab['diff']>) => NonNullable<WorkspacePaneTab['diff']>) => {
      const store = useWorkspaceStore.getState()
      const current = store.workspaces.find((w) => w.id === workspaceId)?.paneState?.tabs.find((t) => t.id === tab.id)
      if (!current?.diff) return
      const next = patch(current.diff)
      if (JSON.stringify(next) === JSON.stringify(current.diff)) return
      store.updatePaneTab(workspaceId, tab.id, { diff: next })
    },
    [workspaceId, tab.id],
  )
  const takeOffer = useCallback(
    () =>
      writeTourFields((diff) => {
        const { tourOffer: _taken, ...rest } = diff
        return rest
      }),
    [writeTourFields],
  )
  const keepCurrent = useCallback(
    (current: { id: string; playing: boolean } | null) =>
      writeTourFields((diff) => {
        const { tour: _previous, ...rest } = diff
        return current ? { ...rest, tour: current } : rest
      }),
    [writeTourFields],
  )

  // The branch step the viewer has open, kept the same way, so coming back to
  // the tab does not put it back on the whole branch.
  const keptStep = tab.diff?.kept ?? null
  const keepStep = useCallback(
    (kept: NonNullable<NonNullable<WorkspacePaneTab['diff']>['kept']>) =>
      writeTourFields((diff) => ({ ...diff, kept })),
    [writeTourFields],
  )

  return (
    <DiffViewer
      // Keyed on the repo only: a Git row click retargets the mounted
      // viewer through its focus props. Remounting per target (the aux
      // window's rule) disposes Monaco's models under the diff widget.
      // The changelist is deliberately NOT in the key: the default settles a
      // tick after mount, and remounting on it would flash Monaco on the way
      // into every unaddressed Diff tab.
      key={repoRoot}
      repoRoot={repoRoot}
      focusPath={tab.diff?.focusPath ?? null}
      focusKind={tab.diff?.focusKind ?? null}
      changelistId={changelistId}
      // Carried into the window when the band's "Open in separate
      // window" is used, so that window's "Show in the app" knows the
      // pane it came from and can hand the diff back.
      workspaceId={workspaceId}
      variant="pane"
      onItemCountChange={onDiffCountChange}
      // The pane is the only host with a branch to step through; the aux
      // window opens on one file of the working tree.
      branchSteps
      // An agent's editor.open_diff: its narrowing, the step it named, and the
      // lines to land on. Absent for every diff a person opens.
      pathsFilter={tab.diff?.reveal?.paths ?? null}
      focusStep={tab.diff?.reveal?.step ?? null}
      focusRange={tab.diff?.reveal?.range ?? null}
      focusSide={tab.diff?.reveal?.side ?? 'modified'}
      revealKey={tab.diff?.reveal?.key ?? null}
      keptStep={keptStep}
      onKeepStep={keepStep}
      tourHost={tourHost}
      onTourOfferTaken={takeOffer}
      onTourCurrentChange={keepCurrent}
      visible={active}
    />
  )
}

type PaneTabPanelProps = {
  workspaceId: string
  tab: WorkspacePaneTab
  active: boolean
  onDiffCountChange?: (count: number | null) => void
}

function PaneTabPanel({ workspaceId, tab, active, onDiffCountChange }: PaneTabPanelProps) {
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  // The diff reads the worktree the workspace is mounted on, not the parent
  // checkout a run workspace's folderPath names (the WorkspaceIdentity rule).
  const diffRepoRoot = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    if (!ws) return null
    return resolveWorkspaceWorktree(ws)?.gitRoot ?? ws.folderPath ?? null
  })
  switch (tab.kind) {
    case 'files':
      return selectModuleEnabled(moduleOverrides, 'dev-tools') ? (
        <FileExplorer workspaceId={workspaceId} />
      ) : (
        <PaneUnavailable />
      )
    case 'git': {
      // Git is a host-registered panel (git-module.ts); the pane renders the
      // registered component so a disabled module answers with absence.
      const GitPanel = getRendererHost().getPanel('git')
      return GitPanel && selectModuleEnabled(moduleOverrides, 'git') ? (
        <GitPanel workspaceId={workspaceId} />
      ) : (
        <PaneUnavailable />
      )
    }
    case 'backlog': {
      // The workspace's Backlog panel, registered by backlog-module.ts. It
      // takes the same props the FlexLayout rail handed it, future plans
      // included.
      const BacklogPanel = getRendererHost().getPanel('backlog')
      return BacklogPanel && selectModuleEnabled(moduleOverrides, 'backlog') ? (
        <BacklogPanel workspaceId={workspaceId} />
      ) : (
        <PaneUnavailable />
      )
    }
    case 'terminal':
      return tab.terminalId ? (
        <PlainTerminalPanel workspaceId={workspaceId} terminalId={tab.terminalId} />
      ) : (
        <PaneUnavailable />
      )
    case 'browser':
      // A browser tab has no browser pane to drive; it shows the server's dev
      // servers through previews instead (phase 9 spec, 3.6).
      return clientSupports('previews') && !clientSupports('browser-pane') ? (
        <PreviewTab active={active} />
      ) : (
        <BrowserTab workspaceId={workspaceId} tab={tab} active={active} />
      )
    case 'canvas':
      return selectModuleEnabled(moduleOverrides, 'canvas') ? (
        <CanvasTab workspaceId={workspaceId} tab={tab} active={active} />
      ) : (
        <PaneUnavailable />
      )
    case 'document':
      return <DocumentTab tab={tab} active={active} />
    case 'agents':
      return <AgentsTab workspaceId={workspaceId} active={active} />
    case 'diff': {
      // The opener's repository wins: the Git panel can be showing a worktree
      // scope that is not the workspace's own checkout, and re-deriving one
      // here opened the tab on a different repository than the row came from.
      // The derived root is the fallback for a Diff tab opened from the pane's
      // own + menu, which names no repository at all.
      const repoRoot = tab.diff?.repoRoot ?? diffRepoRoot
      return repoRoot && selectModuleEnabled(moduleOverrides, 'git') ? (
        <PaneDiffTab
          workspaceId={workspaceId}
          repoRoot={repoRoot}
          tab={tab}
          active={active}
          onDiffCountChange={onDiffCountChange}
        />
      ) : (
        <PaneUnavailable />
      )
    }
    default:
      return <PaneUnavailable />
  }
}

type WorkspacePaneBodyProps = {
  workspaceId: string
  tabs: WorkspacePaneTab[]
  /** The tab whose panel is on screen: null when the pane is collapsed or the workspace is not the visible one. */
  activeTabId: string | null
  /** The tab the strip has selected, visible or not; decides which panel is the front one. */
  selectedTabId: string | null
  /**
   * The pane is closed. Its column is zero wide, but stays interactive while a
   * tab floats, so it is not `inert` and nothing else tells the idle-animation
   * pause (assets/index.css) that the docked layers are out of sight.
   */
  collapsed?: boolean
  onDiffCountChange?: (count: number | null) => void
}

export function WorkspacePaneBody({
  workspaceId,
  tabs,
  activeTabId,
  selectedTabId,
  collapsed = false,
  onDiffCountChange,
}: WorkspacePaneBodyProps) {
  const floatingTab = tabs.find((tab) => tab.floating && paneKindFloats(tab.kind)) ?? null
  const floatRect = useFloatRect(workspaceId, floatingTab)
  const recordingTabIds = useRecordingTabIds()
  const agentPresentTabIds = useAgentPresentTabIds(workspaceId, tabs)
  // The layers keep one order whatever the strip's is. Dragging a tab moves
  // it in `tabs`, and rendering in that order would have React move layers in
  // the tree to match; a browser layer moved that way detaches its <webview>,
  // which reloads the page from its first URL as a WebContents main no longer
  // knows. Only the selected or floating layer paints, so the tree's order
  // shows nowhere.
  const layerTabs = useMemo(() => [...tabs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), [tabs])
  return (
    <>
      {layerTabs.map((tab) => {
        const floating = tab.id === floatingTab?.id && floatRect !== null
        const selected = tab.id === selectedTabId || floating
        const active = floating || (selected && tab.id === activeTabId)
        // A tab in a window of its own keeps no layer here, retained kind or
        // not: its window holds the terminal, the page, the board. Selected,
        // it is the placeholder.
        const poppedOut = Boolean(tab.poppedOut)
        if (!selected && (poppedOut || !paneKindRetainsPanel(tab.kind))) return null
        const offscreen = !selected && tab.kind === 'browser' && !poppedOut
        return (
          <div
            key={tab.id}
            role="tabpanel"
            id={`pane-${workspaceId}-panel-${tab.id}`}
            aria-labelledby={`pane-${workspaceId}-tab-${tab.id}`}
            aria-hidden={!selected}
            // No stacking tier: an unselected panel is offscreen or, while it
            // records, under everything (browser), or invisible (terminal), so
            // the selected one is the only paint.
            // `aria-hidden` below is load-bearing as well as correct: a canvas
            // layer needs its subtree hidden a second time, because the editor's
            // own stylesheet takes `visibility` back on a few of its nodes, and
            // `canvasTheme.css` matches those layers through this attribute.
            //
            // FLOATING is the one case that leaves the pane's box: the SAME
            // element is restyled to `position: fixed`, never moved in the
            // tree. Re-parenting a <webview> unmounts and remounts it, and the
            // page reloads — losing exactly the state the float exists to keep
            // in view. No ancestor between here and the viewport carries a
            // transform, so `fixed` resolves against the viewport.
            //
            // Floating, it is an overlay and takes the overlay pair: the modal
            // shadow and `--radius-lg`, the shell step. Docked it wears the
            // pane's own card radius, which is a step above what the shape ramp
            // allows anything casting an overlay shadow.
            className={
              floating
                ? 'fixed z-[var(--z-pane)] overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] shadow-[var(--shadow-modal)]'
                : `absolute inset-0 ${selected ? 'visible' : offscreen ? '' : 'invisible'}`
            }
            style={
              floating
                ? { ...floatRect, pointerEvents: 'auto' }
                : offscreen
                  ? hiddenBrowserLayerStyle(recordingTabIds.has(tab.id))
                  : { pointerEvents: selected ? 'auto' : 'none' }
            }
            // An offscreen layer is still in the DOM: `inert` keeps its address
            // field and buttons out of the tab order (the invisible ones are
            // unfocusable already).
            //
            // It does not stop an agent driving the tab. Its clicks and keys go
            // to the guest's own webContents over CDP (Input.dispatchMouseEvent,
            // Input.dispatchKeyEvent, Input.insertText in browser-control.ts),
            // never through this document's hit testing; checked on Electron 44
            // with a <webview> under an inert, offscreen container, and under
            // one made inert after the guest loaded: the guest's button took
            // the click, its input took focus and text, and keydown fired.
            inert={offscreen}
            // A docked layer in a closed pane is clipped to nothing: its
            // animations hold still. The floating player is on screen and is
            // the one layer left running.
            {...(collapsed && !floating ? { 'data-pane-collapsed': '' } : {})}
          >
            {floating ? <FloatingPlayerChrome workspaceId={workspaceId} tab={tab} rect={floatRect} /> : null}
            {poppedOut ? (
              <PanePoppedOutPlaceholder workspaceId={workspaceId} tab={tab} />
            ) : (
              <React.Suspense fallback={<SuspenseFallback label="Loading pane" />}>
                <PaneTabPanel
                  workspaceId={workspaceId}
                  tab={tab}
                  active={active}
                  onDiffCountChange={onDiffCountChange}
                />
              </React.Suspense>
            )}
            {!poppedOut && agentPresentTabIds.has(tab.id) ? (
              // The panel an agent is driving or drawing in, outlined in the
              // violet its tab's pill wears (agentPresence.ts).
              <AgentEdge />
            ) : null}
          </div>
        )
      })}
    </>
  )
}
