import React, { useEffect } from 'react'

import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { WorkspaceId } from '../../../types/workspace'
import { WorkspaceAsideColumn } from '../workspaceAsideColumn'
import WorkspacePane from './WorkspacePane'
import { openUrlInPane, rewriteUnroutableHost } from './browser/openInPane'
import { agentBrowserTracker, shouldFloatAgentOpen } from './browser/agentBrowserFloat'
import { useAgentBrowserAutoFloat } from './browser/useAgentBrowserAutoFloat'
import { hiddenBrowserLayerStyle } from './WorkspacePaneBody'
import { useRecordingWorkspaceIds } from './browser/recordingTabs'
import { revealPoppedOutTab, showPaneTab, usePanePopOutHost } from './popout/panePopOutHost'

// The pane column (browser-pane epic): the full-height column on the shell
// row's right edge, beside the WorkspaceHeader, that hosts every retained
// workspace's pane. One is visible — the active workspace's — and the others
// stay mounted invisibly, the same retention the workspace layers use, so a
// pane terminal (later a browser page) survives a workspace switch. Width is
// app-level; open/closed is the active workspace's own flag.

type WorkspacePaneColumnProps = {
  activeWorkspaceId: WorkspaceId | null
  // The workspaces whose layers are mounted right now (WorkspaceManager's
  // retention set); a pane mounts for each that has tabs, plus the active one.
  renderedWorkspaceIds: readonly WorkspaceId[]
  // Every workspace this window holds, retained or not: a pane popped out of
  // this window lives only as long as its workspace stays here. Null while
  // this window's own record is missing from the registry, when that is not
  // known.
  windowWorkspaceIds: ReadonlySet<WorkspaceId> | null
  // The New chat door is up: it belongs to no workspace yet, so the column
  // shows no pane and collapses as if the active one were closed. Every pane
  // stays mounted, so closing the door shows the active one as it was.
  suppressed?: boolean
}

/**
 * An agent's `browser.open` with the pane closed: its page comes up as the
 * floating player rather than opening the pane. Nothing is activated or opened
 * on the way, so the pane never opens under the player.
 *
 * The player is the person's once it is up. A page the person floated
 * themselves stays where it is — the agent's page opens behind it, in the
 * pane's strip — and a player the person closed stays closed while that agent
 * keeps working (agentBrowserFloat.AGENT_SESSION_QUIET_MS), whichever way the
 * agent names its page.
 */
function floatAgentOpen(
  workspaceId: WorkspaceId,
  request: { url: string | null; tabId: string | null; floatingTabId: string | null },
): void {
  const store = useWorkspaceStore.getState()
  const pane = store.workspaces.find((w) => w.id === workspaceId)?.paneState
  if (request.floatingTabId) {
    if (!request.tabId && request.url)
      store.openPaneTab(workspaceId, { kind: 'browser', url: rewriteUnroutableHost(request.url), activate: false })
    return
  }
  let target: string | null
  if (request.tabId) {
    target = pane?.tabs.some((tab) => tab.id === request.tabId) ? request.tabId : null
  } else if (request.url) {
    // A new tab of its own: nobody has closed it yet.
    target = store.openPaneTab(workspaceId, {
      kind: 'browser',
      url: rewriteUnroutableHost(request.url),
      activate: false,
    })
  } else {
    target =
      activeBrowserTabId(workspaceId) ??
      pane?.tabs.find((tab) => tab.kind === 'browser' && !tab.poppedOut)?.id ??
      store.openPaneTab(workspaceId, { kind: 'browser', activate: false })
  }
  if (!target || agentBrowserTracker.isSuppressed(target, Date.now())) return
  store.setPaneTabFloating(workspaceId, target, true)
}

/** The pane's front tab when it is a browser, else null. */
function activeBrowserTabId(workspaceId: WorkspaceId): string | null {
  const pane = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)?.paneState
  const active = pane?.tabs.find((tab) => tab.id === pane.activeTabId)
  return active?.kind === 'browser' ? active.id : null
}

export function WorkspacePaneColumn({
  activeWorkspaceId,
  renderedWorkspaceIds,
  windowWorkspaceIds,
  suppressed = false,
}: WorkspacePaneColumnProps) {
  // The owner side of every pane, or tab, this window pops out: one per window,
  // so it rides the column rather than each workspace's pane.
  usePanePopOutHost(windowWorkspaceIds)
  // An agent taking a page in a closed pane brings the page up as the floating
  // player; so does closing the pane on one it is still driving.
  useAgentBrowserAutoFloat(activeWorkspaceId, suppressed)
  const width = useWorkspaceStore((s) => s.workspacePaneWidth)
  const setWidth = useWorkspaceStore((s) => s.setWorkspacePaneWidth)
  const maximised = useWorkspaceStore((s) => s.workspacePaneMaximised)
  const activeOpen =
    useWorkspaceStore((s) => s.workspaces.find((w) => w.id === activeWorkspaceId)?.paneState?.open ?? false) &&
    !suppressed
  // A floating player paints outside the column, so a collapsed column must
  // stay interactive for it (WorkspaceAsideColumn.keepInteractive); the pane
  // marks its own clipped chrome inert instead.
  const activeFloating = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === activeWorkspaceId)?.paneState?.tabs.some((tab) => tab.floating) ?? false,
  )
  // Ids with something to keep alive: a workspace with no tabs has nothing to
  // retain and mounts only while it is the active one.
  const mountedIds = useWorkspaceStore((s) =>
    renderedWorkspaceIds
      .filter(
        (id) => id === activeWorkspaceId || (s.workspaces.find((w) => w.id === id)?.paneState?.tabs.length ?? 0) > 0,
      )
      .join('\n'),
  )
  const ids = mountedIds ? mountedIds.split('\n') : []
  const recordingWorkspaceIds = useRecordingWorkspaceIds()

  // browser.open from an agent: the window SHOWING that workspace answers —
  // opens the tab, shows the pane — so the person sees what the agent is
  // about to do. A window that merely retains the workspace off screen stays
  // out of it, so no orphan tabs appear in a second window; with no window
  // showing it, the tool reports that honestly.
  //
  // With the pane closed the page comes up as the floating player instead
  // (Settings → Agents, on by default): the person sees the agent work without
  // the pane taking the chat's width. An open pane keeps the old answer.
  useEffect(
    () =>
      window.api.onBrowserOpenRequest(({ workspaceId, url, tabId }) => {
        if (workspaceId !== activeWorkspaceId) return
        const store = useWorkspaceStore.getState()
        const pane = store.workspaces.find((w) => w.id === workspaceId)?.paneState
        // A floating tab is already in view. Re-opening the pane on top of it
        // would put the same page on screen twice and take back the width the
        // person floated it to reclaim.
        const floatingTabId = pane?.tabs.find((tab) => tab.floating)?.id ?? null
        if (tabId && tabId === floatingTabId) return
        // Out in a window of its own: that window brings it forward, and the
        // pane stays as it is rather than opening on a placeholder.
        if (tabId && revealPoppedOutTab(workspaceId, tabId)) return
        if (shouldFloatAgentOpen(pane, store.appSettings.browserAutoFloatAgentPreview)) {
          floatAgentOpen(workspaceId, { url, tabId, floatingTabId })
          return
        }
        if (tabId) {
          // The agent navigated an existing tab: bring it to the front.
          if (pane?.tabs.some((tab) => tab.id === tabId)) store.setActivePaneTab(workspaceId, tabId)
        } else if (url) {
          if (!openUrlInPane(workspaceId, url, { forceNewTab: true })) return
        } else if (!pane?.tabs.some((tab) => tab.kind === 'browser')) {
          store.openPaneTab(workspaceId, { kind: 'browser' })
        }
        store.setPaneOpen(workspaceId, true)
      }),
    [activeWorkspaceId],
  )

  // canvas.open from an agent: the same rule as the browser's, and the same
  // reason — only the window SHOWING that workspace answers, so no orphan tab
  // appears in a second window and the tool can report honestly when no window
  // shows it. One tab per board, so a board that is already open is focused
  // rather than opened twice (the slice's own rule; this just asks).
  //
  // It does NOT maximise the pane. The editor drops to its compact layout in a
  // docked pane, and that is the trade: an agent revealing what it is about to
  // draw must not take the window away from what the person is doing. A Canvas
  // tab the person opens is docked too (owner ruling 2026-09-22); only the
  // strip's Maximise control widens the pane.
  useEffect(
    () =>
      window.api.onCanvasOpenRequest(({ workspaceId, path }) => {
        if (workspaceId !== activeWorkspaceId) return
        const store = useWorkspaceStore.getState()
        // A pane already at its tab cap takes nothing, and opening the column
        // on nothing new would be a window change with no answer in it.
        const opened = store.openPaneTab(workspaceId, { kind: 'canvas', canvas: { path }, activate: false })
        if (opened === null) return
        // A board already out in a window of its own comes forward there.
        showPaneTab(workspaceId, opened)
      }),
    [activeWorkspaceId],
  )

  // tour.create from an agent: dock the Diff tab with the tour offered on it,
  // WITHOUT selecting it or opening the pane — an agent finishing its tour must
  // not move the owner's view. The tab's "tour ready" mark and the one
  // attention event main raises are the whole announcement; the answer tells
  // the tool the tab is there (`revealed: true`). Only the window SHOWING the
  // workspace answers, the same rule as the canvas and the browser.
  useEffect(
    () =>
      window.api.onTourRevealRequest(({ requestId, workspaceId, tourId }) => {
        if (workspaceId !== activeWorkspaceId) return
        const store = useWorkspaceStore.getState()
        const pane = store.workspaces.find((w) => w.id === workspaceId)?.paneState
        const existing = pane?.tabs.find((tab) => tab.kind === 'diff')
        const opened = store.openPaneTab(workspaceId, {
          kind: 'diff',
          diff: { ...(existing?.diff ?? { focusPath: null, focusKind: null }), tourOffer: tourId },
          activate: false,
        })
        if (opened === null) return
        window.api.tourAcknowledgeReveal(requestId)
      }),
    [activeWorkspaceId],
  )

  return (
    <WorkspaceAsideColumn
      label="Workspace pane"
      width={width}
      onWidthChange={setWidth}
      collapsed={!activeOpen}
      // Behind the door a floating player is parked offscreen with the rest of
      // its pane (below), so nothing outside the column is left to reach.
      keepInteractive={activeFloating && !suppressed}
      fill={activeOpen && maximised}
    >
      {ids.map((workspaceId) => {
        // The door hides the active pane the way a workspace switch hides any
        // other: parked offscreen, its panels told they are out of sight. A
        // closed column alone clips the docked tabs, but a floating player
        // paints outside the column and would stay over the door, and the
        // tab bodies would go on believing they are on screen.
        const active = workspaceId === activeWorkspaceId && !suppressed
        return (
          <div
            key={workspaceId}
            // Inactive panes park offscreen rather than `invisible`: a browser
            // guest under visibility:hidden blanks for good on macOS
            // (WorkspacePaneBody.OFFSCREEN_LAYER_STYLE). One with a tab being
            // recorded waits behind the front pane instead, so the tab keeps
            // painting (WorkspacePaneBody.hiddenBrowserLayerStyle).
            // No stacking tier: every layer but the active one is offscreen
            // or under it, so nothing can paint over the front pane.
            className="absolute inset-0"
            style={active ? { pointerEvents: 'auto' } : hiddenBrowserLayerStyle(recordingWorkspaceIds.has(workspaceId))}
            aria-hidden={!active}
            // Agents still drive this pane's browser tabs: their input goes to
            // each guest over CDP, which `inert` does not touch (verified; see
            // WorkspacePaneBody's browser layers).
            inert={!active}
          >
            <WorkspacePane workspaceId={workspaceId} active={active} />
          </div>
        )
      })}
    </WorkspaceAsideColumn>
  )
}
