import { useEffect, useRef, useSyncExternalStore } from 'react'

import type { BrowserTabState } from '../../../../../../shared/browser'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import type { WorkspaceId } from '../../../../types/workspace'
import { agentBrowserTracker, shouldFloatForAgent } from './agentBrowserFloat'
import { canvasPushMatchesBoard } from '../canvas/canvasSync'

// The window's ear on every browser tab main drives, and every board an agent
// draws on: the floating player comes up when an agent takes a page or a board
// in a closed pane, and goes back up when the person closes the pane on one an
// agent is still working in. Mounted once per window, in the pane column.

// The last state main reported per tab. The player's bar shows the Agent badge
// and the recording clock from it, and it mounts AFTER the report that brought
// it up, so a subscription of its own would start blank.
const liveStates = new Map<string, BrowserTabState>()
const liveListeners = new Set<() => void>()

function publishLiveState(state: BrowserTabState): void {
  liveStates.set(state.tabId, state)
  for (const listener of liveListeners) listener()
}

function subscribeLive(listener: () => void): () => void {
  liveListeners.add(listener)
  return () => liveListeners.delete(listener)
}

/** Main's latest view of a tab, or null before it has reported one. */
export function useBrowserLiveState(tabId: string): BrowserTabState | null {
  return useSyncExternalStore(subscribeLive, () => liveStates.get(tabId) ?? null)
}

/** Float `tabId` for its agent, when the rules and the person's setting allow it. */
export function floatForAgent(workspaceId: WorkspaceId, tabId: string, now: number): boolean {
  const store = useWorkspaceStore.getState()
  if (!store.appSettings.browserAutoFloatAgentPreview) return false
  if (agentBrowserTracker.isSuppressed(tabId, now)) return false
  const pane = store.workspaces.find((w) => w.id === workspaceId)?.paneState
  if (!shouldFloatForAgent(pane, tabId)) return false
  store.setPaneTabFloating(workspaceId, tabId, true)
  return true
}

/**
 * @param activeWorkspaceId the workspace this window shows; only its tabs float.
 * @param suppressed the New chat door is up, and no workspace's page belongs over it.
 */
export function useAgentBrowserAutoFloat(activeWorkspaceId: WorkspaceId | null, suppressed: boolean): void {
  // Read through refs: the subscriptions below must not drop and re-take main's
  // stream on a workspace switch, or a report arriving in between is lost and
  // the tracker's history with it.
  const target = useRef({ activeWorkspaceId, suppressed })
  target.current = { activeWorkspaceId, suppressed }

  useEffect(
    () =>
      window.api.onBrowserState((state) => {
        publishLiveState(state)
        const now = Date.now()
        const tookOver = agentBrowserTracker.observe(state.tabId, state.controller, now)
        const { activeWorkspaceId: workspaceId, suppressed: doorUp } = target.current
        if (!tookOver || doorUp || !workspaceId) return
        floatForAgent(workspaceId, state.tabId, now)
      }),
    [],
  )

  // A board an agent draws on comes up the same way. Main says who holds a
  // board's pen to every window subscribed to it, and a Canvas tab subscribes
  // while it is mounted, closed pane or not (it is a retained kind), so the
  // board is found by its tab. The tracker is keyed on tab ids, which no page
  // and board share, and canvas presence uses the browser's three controllers.
  useEffect(
    () =>
      window.api.onCanvasPresence((presence) => {
        const store = useWorkspaceStore.getState()
        const tab = store.workspaces
          .find((w) => w.id === presence.workspaceId)
          ?.paneState?.tabs.find(
            (candidate) =>
              candidate.kind === 'canvas' &&
              candidate.canvas !== undefined &&
              canvasPushMatchesBoard(presence, { workspaceId: presence.workspaceId, path: candidate.canvas.path }),
          )
        if (!tab) return
        const now = Date.now()
        const tookOver = agentBrowserTracker.observe(tab.id, presence.controller, now)
        const { activeWorkspaceId: workspaceId, suppressed: doorUp } = target.current
        if (!tookOver || doorUp || workspaceId !== presence.workspaceId) return
        floatForAgent(workspaceId, tab.id, now)
      }),
    [],
  )

  // The person closing the pane on a page an agent is driving hands the page
  // to the player rather than hiding it: what they closed was the width, not
  // their view of the agent. Whatever closes the pane — the strip's button,
  // the shortcut — closes it through the store, so the store is where to look.
  useEffect(() => {
    const paneOf = () => {
      const { activeWorkspaceId: workspaceId } = target.current
      return workspaceId
        ? useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)?.paneState
        : undefined
    }
    let watching = target.current.activeWorkspaceId
    let wasOpen = paneOf()?.open ?? false
    return useWorkspaceStore.subscribe(() => {
      const { activeWorkspaceId: workspaceId, suppressed: doorUp } = target.current
      const pane = paneOf()
      const open = pane?.open ?? false
      // A workspace switch is not the pane closing.
      const closed = workspaceId === watching && wasOpen && !open
      watching = workspaceId
      wasOpen = open
      if (!closed || doorUp || !workspaceId || !pane?.activeTabId) return
      const now = Date.now()
      if (agentBrowserTracker.isDriving(pane.activeTabId, now)) floatForAgent(workspaceId, pane.activeTabId, now)
    })
  }, [])
}
