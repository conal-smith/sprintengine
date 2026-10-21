import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { PanePopOutState } from '../../../../../../shared/ipc/pane-popout'
import { normalizeWorkspacePaneState } from '../../../../store/slices/workspacePaneSlice'
import { useWorkspaceStore, workspaceRegistryReady } from '../../../../store/workspaceStore'
import type { WorkspacePaneTab } from '../../../../types/workspace'
import { useWindowPageVisible } from '../../../../utils/windowActivity'
import { ContextMenu, EmptyState, MenuDivider, MenuItem, Spinner, Tabs, TabsScroller } from '../../../ui'
import { ToastRegion } from '../../../ui/ToastRegion'
import { TITLE_BAR_HEIGHT, TRAFFIC_LIGHT_INSET } from '../../AppTitleBar'
import { WindowControls } from '../../WindowControls'
import { PaneHostContext } from '../paneHost'
import { paneTabItem, paneTabLabel } from '../paneTabItem'
import { useAgentPresentTabIds } from '../agentPresence'
import { closePaneTabAndItsTerminal, paneTerminalSessionId } from '../paneTerminals'
import { WorkspacePaneBody } from '../WorkspacePaneBody'
import { adoptAgentFocusRequest } from '../agents/agentsPaneFocus'
import { redirectPaneWrites } from './panePopOutRedirect'

// A workspace pane, or one of its tabs, in a window of its own (`?aux=pane`).
//
// The window is a view of tabs that still belong to the pane they came from:
// the owner window pushes what to show (panePopOutHost.ts), this window mounts
// the same tab bodies the pane does, and everything the person does to a tab
// here goes back to the owner as an action (panePopOutRedirect.ts). Its own
// strip is the pane's strip — the same tab items, the same close and context
// menu — minus "+": a new tab is opened in the pane, or by a tab here asking
// for one, and a window that grew tabs of its own would be a second pane.
//
// Closing the window is how its tabs go home. On macOS that is the traffic
// light, and full screen is the native green button; on win/linux the strip
// draws the caption buttons itself.

type PaneView = { tabs: WorkspacePaneTab[]; recentUrls?: string[] }

type Props = { popOutId: string; workspaceId: string }

type TabMenuState = { x: number; y: number; tabId: string }

/** The tab to show when the one in front left: its right-hand neighbour that is still here, then its left. */
function nextFront(
  previous: readonly WorkspacePaneTab[],
  next: readonly WorkspacePaneTab[],
  gone: string,
): string | null {
  const present = new Set(next.map((tab) => tab.id))
  const index = previous.findIndex((tab) => tab.id === gone)
  if (index !== -1) {
    const after = previous.slice(index + 1).find((tab) => present.has(tab.id))
    if (after) return after.id
    const before = [...previous.slice(0, index)].reverse().find((tab) => present.has(tab.id))
    if (before) return before.id
  }
  return next[0]?.id ?? null
}

export default function PanePopOutWindow({ popOutId, workspaceId }: Props) {
  const isMac = window.api.platform === 'darwin'
  const [registryReady, setRegistryReady] = useState(false)
  const [view, setView] = useState<PaneView | null>(null)
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null)
  const [diffCount, setDiffCount] = useState<number | null>(null)
  const [windowState, setWindowState] = useState({ isMaximized: false, isFullScreen: false })
  const viewRef = useRef<PaneView | null>(null)
  const activeRef = useRef<string | null>(null)
  const revealKeyRef = useRef<number | null>(null)
  const agentFocusSerialRef = useRef<number | null>(null)
  const workspaceName = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.name ?? '')
  const workspacePresent = useWorkspaceStore((s) => s.workspaces.some((w) => w.id === workspaceId))
  const pageVisible = useWindowPageVisible()

  const act = useCallback(
    (action: Parameters<typeof window.api.panePopOutAct>[1]) => window.api.panePopOutAct(popOutId, action),
    [popOutId],
  )

  const select = useCallback((tabId: string | null) => {
    activeRef.current = tabId
    setActiveTabId(tabId)
  }, [])

  // Before any tab body can mount: from here on, a body's write to this
  // workspace's pane is the owner's to apply.
  useLayoutEffect(() => redirectPaneWrites({ workspaceId, act, select }), [act, select, workspaceId])

  // The workspace record a body reads (its folder, its worktree) arrives with
  // main's registry; until then this window's copy is whatever it hydrated.
  useEffect(() => {
    let cancelled = false
    void workspaceRegistryReady.then(() => {
      if (!cancelled) setRegistryReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // What the owner says to show. The first state may have been pushed before
  // this window was listening, so it is also asked for — and only taken if no
  // push has landed since, which would be newer.
  useEffect(() => {
    let pushed = false
    const accept = (state: PanePopOutState): void => {
      const normalized = normalizeWorkspacePaneState({ open: true, activeTabId: null, tabs: state.tabs })
      const tabs = normalized?.tabs ?? []
      const previous = viewRef.current?.tabs ?? []
      const next: PaneView = { tabs, ...(Array.isArray(state.recentUrls) ? { recentUrls: state.recentUrls } : {}) }
      viewRef.current = next
      setView(next)
      const reveal = state.reveal
      let front = activeRef.current
      if (reveal && reveal.key !== revealKeyRef.current && tabs.some((tab) => tab.id === reveal.tabId)) {
        revealKeyRef.current = reveal.key
        front = reveal.tabId
      } else if (!front || !tabs.some((tab) => tab.id === front)) {
        front = front ? nextFront(previous, tabs, front) : (tabs[0]?.id ?? null)
      }
      if (front !== activeRef.current) {
        select(front)
        // Told, so docking back lands where the person was looking.
        if (front) act({ type: 'activate', tabId: front })
      }
      // The owner's chat in focus, for an Agents tab here: this window
      // focuses no chat of its own, so it follows the one the person is
      // working with there, and takes the owner's requests for an agent lane.
      if (state.focusedAgentId !== undefined) {
        const focused = state.focusedAgentId
        useWorkspaceStore.setState((draft) => {
          if (typeof focused === 'string' && focused) draft.focusedAgentByWorkspaceId[workspaceId] = focused
          else delete draft.focusedAgentByWorkspaceId[workspaceId]
        })
      }
      const request = state.agentFocus
      if (request && typeof request.agentId === 'string' && request.serial !== agentFocusSerialRef.current) {
        agentFocusSerialRef.current = request.serial
        adoptAgentFocusRequest(workspaceId, request.agentId, request.laneId ?? null)
      }
    }
    const off = window.api.onPanePopOutState((push) => {
      if (push.popOutId !== popOutId) return
      pushed = true
      accept(push.state)
    })
    void window.api
      .panePopOutGetState(popOutId)
      .then((snapshot) => {
        if (!pushed && snapshot?.state) accept(snapshot.state)
      })
      .catch(() => undefined)
    return off
  }, [act, popOutId, select, workspaceId])

  // This window's copy of the pane, for the bodies that read it from the store
  // (a Diff tab's tour, a browser tab's recent pages). Written here and only
  // here; the bodies' own writes go to the owner.
  useEffect(() => {
    if (!view || !workspacePresent) return
    useWorkspaceStore.setState((draft) => {
      const workspace = draft.workspaces.find((w) => w.id === workspaceId)
      if (!workspace) return
      workspace.paneState = {
        open: true,
        activeTabId,
        tabs: view.tabs,
        ...(view.recentUrls ? { recentUrls: view.recentUrls } : {}),
      }
    })
  }, [activeTabId, view, workspaceId, workspacePresent])

  // Nothing left to show: the last tab closed, or went home. Neither is a
  // reason to keep an empty window up — and a workspace that is gone is not
  // one to show at all. The owner closes the window too; whichever is first.
  const empty = view !== null && view.tabs.length === 0
  const workspaceGone = registryReady && !workspacePresent
  useEffect(() => {
    if (empty || workspaceGone) void window.api.windowClose()
  }, [empty, workspaceGone])

  // The window's name, in the taskbar and the window switcher: the tab, when
  // the window holds one, else the workspace's pane.
  useEffect(() => {
    const tabs = view?.tabs ?? []
    document.title =
      tabs.length === 1 ? paneTabLabel(tabs[0]) : workspaceName ? `${workspaceName} — pane` : 'Workspace pane'
  }, [view, workspaceName])

  // The browser tab in front is the one an agent's browser tools act on when
  // they name none. Only the window hosting a tab's page may say so (main
  // checks), and for a tab out here that is this window.
  const activeBrowserTabId = view?.tabs.find((tab) => tab.id === activeTabId && tab.kind === 'browser')?.id ?? null
  useEffect(() => {
    if (activeBrowserTabId) void window.api.browserNoteActive(workspaceId, activeBrowserTabId)
  }, [activeBrowserTabId, workspaceId])

  // A terminal here is fed only while the window can be seen, as the
  // workspace window's are: hidden, main keeps the output and sends what was
  // missed on the way back (WorkspaceManager's paint-visibility sweep is the
  // workspace window's version of this). A terminal panel states its own
  // visibility as it mounts, so only a change is reported.
  const reportedVisibleRef = useRef(pageVisible)
  useEffect(() => {
    if (reportedVisibleRef.current === pageVisible) return
    reportedVisibleRef.current = pageVisible
    for (const tab of viewRef.current?.tabs ?? []) {
      if (tab.kind !== 'terminal' || !tab.terminalId) continue
      void window.api.terminalSetVisible(paneTerminalSessionId(tab.terminalId), pageVisible).catch(() => undefined)
    }
  }, [pageVisible])

  // Maximise/Restore on the win/linux caption buttons, and the traffic-light
  // inset that full screen hides along with the lights.
  useEffect(() => {
    let mounted = true
    void window.api
      .getWindowState()
      .then((state) => {
        if (mounted && state) setWindowState(state)
      })
      .catch(() => undefined)
    const off = window.api.onWindowStateChanged(setWindowState)
    return () => {
      mounted = false
      off()
    }
  }, [])

  const tabs = view?.tabs ?? []
  const agentPresentTabIds = useAgentPresentTabIds(workspaceId, tabs)
  const closeTab = useCallback(
    (tabId: string) => {
      const tab = viewRef.current?.tabs.find((candidate) => candidate.id === tabId)
      // Closed for real, as in the pane: a terminal's pty ends with its tab.
      if (tab) closePaneTabAndItsTerminal(workspaceId, tab)
    },
    [workspaceId],
  )
  const closeTabsWhere = (predicate: (tab: WorkspacePaneTab, index: number) => boolean) => {
    tabs.forEach((tab, index) => {
      if (predicate(tab, index)) closeTab(tab.id)
    })
  }

  if (workspaceGone) {
    return (
      <div className="h-screen w-screen bg-[color:var(--bg-app)]">
        <EmptyState title="This workspace is no longer open." />
      </div>
    )
  }

  const ready = registryReady && view !== null && activeTabId !== null && tabs.length > 0
  const menuTabIndex = tabMenu ? tabs.findIndex((tab) => tab.id === tabMenu.tabId) : -1
  const items = tabs.map((tab) => paneTabItem(tab, { diffCount, agentPresent: agentPresentTabIds.has(tab.id) }))
  const lightsShowing = isMac && !windowState.isFullScreen

  return (
    <section
      aria-label={workspaceName ? `${workspaceName} pane` : 'Workspace pane'}
      className="flex h-screen w-screen flex-col bg-[color:var(--bg-app)] text-[color:var(--text-default)]"
    >
      {/* The pane's strip, on the same 36px the pane draws it at: the tabs
          from the left (past the traffic lights on macOS), then the empty run
          that drags the window. */}
      <div
        className={`app-drag flex ${TITLE_BAR_HEIGHT} shrink-0 items-end ${lightsShowing ? TRAFFIC_LIGHT_INSET : 'pl-1.5'} ${isMac ? 'pr-1' : ''}`}
      >
        <TabsScroller className="flex min-w-0 flex-initial items-end self-stretch">
          {ready ? (
            <Tabs
              ariaLabel="Pane tabs"
              className="app-no-drag"
              idPrefix={`pane-${workspaceId}`}
              items={items}
              value={activeTabId}
              onChange={(tabId) => useWorkspaceStore.getState().setActivePaneTab(workspaceId, tabId)}
              onCloseItem={closeTab}
              onItemAuxClick={(tabId, event) => {
                if (event.button === 1) {
                  event.preventDefault()
                  closeTab(tabId)
                }
              }}
              onItemContextMenu={(tabId, event) => {
                event.preventDefault()
                setTabMenu({ x: event.clientX, y: event.clientY, tabId })
              }}
              borderless
            />
          ) : null}
        </TabsScroller>
        <div className="min-w-0 flex-1 self-stretch" aria-hidden="true" />
        {/* Frameless on win/linux: the window draws its own way to minimise,
            maximise and close. macOS keeps its native lights on the left. */}
        {isMac ? null : (
          <div className="app-no-drag flex shrink-0 self-stretch">
            <WindowControls isMaximized={windowState.isMaximized} />
          </div>
        )}
      </div>
      {/* The body is the pane's card, inset by the shell's card gap on three
          sides exactly as the pane's is in the window it came from. */}
      <div className="relative mx-[var(--shell-card-gap)] mb-[var(--shell-card-gap)] min-h-0 flex-1 overflow-hidden rounded-[var(--shell-card-radius)] bg-[color:var(--bg-surface)]">
        {ready ? (
          <PaneHostContext.Provider value="pop-out">
            <WorkspacePaneBody
              workspaceId={workspaceId}
              tabs={tabs}
              activeTabId={activeTabId}
              selectedTabId={activeTabId}
              onDiffCountChange={setDiffCount}
            />
          </PaneHostContext.Provider>
        ) : (
          <div className="flex h-full items-center justify-center gap-2 text-body text-[color:var(--text-muted)]">
            <Spinner />
            Loading…
          </div>
        )}
      </div>
      {tabMenu ? (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          ariaLabel="Pane tab actions"
          onClose={() => setTabMenu(null)}
          surfaceClassName="min-w-[180px]"
        >
          <MenuItem onClick={() => closeTab(tabMenu.tabId)}>Close</MenuItem>
          <MenuItem disabled={tabs.length <= 1} onClick={() => closeTabsWhere((tab) => tab.id !== tabMenu.tabId)}>
            Close others
          </MenuItem>
          <MenuItem
            disabled={menuTabIndex === -1 || menuTabIndex >= tabs.length - 1}
            onClick={() => closeTabsWhere((_tab, index) => index > menuTabIndex)}
          >
            Close to the right
          </MenuItem>
          <MenuDivider />
          {/* The tab goes home and shows in the pane; the window keeps the
              rest, and closes itself when that was its last. */}
          <MenuItem onClick={() => act({ type: 'dock', tabIds: [tabMenu.tabId] })}>Move to main window</MenuItem>
        </ContextMenu>
      ) : null}
      <ToastRegion />
    </section>
  )
}
