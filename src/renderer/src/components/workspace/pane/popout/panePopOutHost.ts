import { nanoid } from 'nanoid'
import { useEffect, useRef } from 'react'

import type { PanePopOutAction, PanePopOutState } from '../../../../../../shared/ipc/pane-popout'
import { clientSupports } from '../../../../clientCapabilities'
import { showToast } from '../../../../store/toastStore'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import type { WorkspaceId, WorkspacePaneTab, WorkspacePaneTabKind } from '../../../../types/workspace'
import { openFileSurface } from '../../../../utils/openFileSurface'
import { readAuxWindowBounds } from '../../../auxWindows/auxWindowPlacement'
import { readAgentFocusRequest, subscribeAgentFocusRequests } from '../agents/agentsPaneFocus'
import type { PaneKindDefinition } from '../paneKinds'

// The owner window's half of the pane pop-out (shared/ipc/pane-popout.ts has
// the protocol). This window's store stays the one record of every tab: a
// popped-out tab is still in the pane's strip, marked with the id of the
// window showing it (`WorkspacePaneTab.poppedOut`). Everything here follows
// from that mark —
//
//   - what each pop-out window is pushed is read off the store, so any change
//     to its tabs, from anywhere (an agent retargeting a diff, a tab closed in
//     the strip), reaches the window without a code path of its own;
//   - what the person does in the window comes back as an action and is
//     applied to the store here, where every other pane write is applied;
//   - a window whose tabs are all gone (closed, brought back) is closed, and a
//     window that closes brings its tabs back.
//
// The ids of this window's pop-outs, and what each one is showing, live in
// this module rather than the store: they are about OS windows this session
// opened, and nothing about them is worth a store write or a persist.

type PopOutRecord = {
  workspaceId: WorkspaceId
  /** The tab the window has in front, as it last said: where docking back lands. */
  activeTabId: string | null
  /** The tab this window last asked the pop-out to bring forward. */
  reveal: { tabId: string; key: number } | null
}

const popOuts = new Map<string, PopOutRecord>()
// Set by the mounted host hook: re-reads the store and pushes what changed.
// A reveal is not a store write, so it has to ask for the push itself.
let requestSync: (() => void) | null = null

/** Whether this shell can pop a pane out at all: a browser tab has no second OS window to give it. */
export function canPopOutPane(): boolean {
  return clientSupports('aux-windows')
}

function paneTabs(workspaceId: WorkspaceId): WorkspacePaneTab[] {
  return useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)?.paneState?.tabs ?? []
}

function bumpReveal(popOutId: string, tabId: string): void {
  const record = popOuts.get(popOutId)
  if (!record) return
  record.reveal = { tabId, key: (record.reveal?.key ?? 0) + 1 }
  record.activeTabId = tabId
}

/**
 * Pop tabs out into one new window: the strip's "Pop out pane" hands every tab
 * still docked, a tab's context menu hands that tab. Resolves false when no
 * window opened, after saying why.
 *
 * The window is opened BEFORE the tabs are marked. Marking is what unmounts
 * their bodies here; a window that then failed to open would have taken a
 * terminal or a page off screen for nothing.
 */
export async function popOutPaneTabs(workspaceId: WorkspaceId, tabIds: readonly string[]): Promise<boolean> {
  const before = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)?.paneState
  const tabs = (before?.tabs ?? []).filter((tab) => tabIds.includes(tab.id) && !tab.poppedOut)
  if (tabs.length === 0) return false
  const popOutId = nanoid(10)
  // The window opens on the tab the person was looking at, when it is one of
  // the tabs going; otherwise on the first of them.
  const front = tabs.find((tab) => tab.id === before?.activeTabId) ?? tabs[0]
  popOuts.set(popOutId, { workspaceId, activeTabId: front.id, reveal: { tabId: front.id, key: 1 } })
  let failure: string | null = null
  try {
    const result = await window.api.panePopOutOpen({ popOutId, workspaceId, bounds: readAuxWindowBounds('pane') })
    if (!result?.ok) failure = result?.message ?? 'The window did not open.'
  } catch (error) {
    failure = error instanceof Error ? error.message : 'The window did not open.'
  }
  if (failure !== null) {
    popOuts.delete(popOutId)
    showToast({ tone: 'error', title: 'The pane did not open in a window', description: failure })
    return false
  }
  const store = useWorkspaceStore.getState()
  store.popOutPaneTabs(
    workspaceId,
    tabs.map((tab) => tab.id),
    popOutId,
  )
  // Two quick clicks open two windows for the same tabs; the second finds them
  // already out, marks nothing, and its window has nothing to show.
  if (!paneTabs(workspaceId).some((tab) => tab.poppedOut === popOutId)) {
    popOuts.delete(popOutId)
    void window.api.panePopOutClose(popOutId).catch(() => undefined)
    return false
  }
  return true
}

/** "Bring back": the tab leaves its window and shows in the pane again, on screen. */
export function bringBackPaneTab(workspaceId: WorkspaceId, tab: WorkspacePaneTab): void {
  if (!tab.poppedOut) return
  useWorkspaceStore.getState().dockPaneTabs(workspaceId, tab.poppedOut, { tabIds: [tab.id], activeTabId: tab.id })
}

/** Raise the window a tab is showing in. */
export function showPanePopOut(popOutId: string): void {
  void window.api.panePopOutFocus(popOutId).catch(() => undefined)
}

/**
 * Bring a popped-out tab to the front of its window — an agent naming a tab
 * that is out — without opening the pane over the placeholder. False when the
 * tab is docked, which leaves the caller to show it the usual way.
 */
export function revealPoppedOutTab(workspaceId: WorkspaceId, tabId: string): boolean {
  const tab = paneTabs(workspaceId).find((candidate) => candidate.id === tabId)
  if (!tab?.poppedOut || !popOuts.has(tab.poppedOut)) return false
  bumpReveal(tab.poppedOut, tabId)
  requestSync?.()
  return true
}

/**
 * Show a pane tab something outside the strip asked for — a board an agent
 * opened, a chat's agent lane, a link sent to the pane's browser. A tab out in
 * a window of its own is brought forward there and the pane is left as it is,
 * rather than opened on its placeholder; any other tab is selected and the
 * pane opens on it. `focus` raises the window too: for the person's own click,
 * never for an agent, which must not take the keyboard.
 */
export function showPaneTab(workspaceId: WorkspaceId, tabId: string, options: { focus?: boolean } = {}): void {
  const popOutId = paneTabs(workspaceId).find((tab) => tab.id === tabId)?.poppedOut
  if (revealPoppedOutTab(workspaceId, tabId)) {
    if (options.focus && popOutId) showPanePopOut(popOutId)
    return
  }
  useWorkspaceStore.getState().setActivePaneTab(workspaceId, tabId)
}

// What a pop-out may say about a tab. The owner's slice normalizes every
// write after this, so a field's shape is checked there; these lists are about
// which fields a window may touch at all.
const POP_OUT_OPEN_KINDS: ReadonlySet<WorkspacePaneTabKind> = new Set<WorkspacePaneTabKind>([
  'browser',
  'files',
  'diff',
  'git',
  'backlog',
  'canvas',
  'document',
  'agents',
])
const POP_OUT_OPEN_FIELDS = ['title', 'url', 'diff', 'canvas', 'document'] as const

/**
 * The rows a pop-out window's "+" offers: the pane's own list, less what a
 * window cannot open. A terminal tab is opened in the pane, which starts its
 * pty, and a row that floats a modal surface (Reviews) needs the window that
 * hosts the modals; neither is a tab the owner would hand this window.
 */
export function popOutAddKinds(kinds: readonly PaneKindDefinition[]): PaneKindDefinition[] {
  return kinds.filter(
    (definition) => !definition.modalSurfaceId && POP_OUT_OPEN_KINDS.has(definition.kind as WorkspacePaneTabKind),
  )
}
const POP_OUT_PATCH_FIELDS = ['title', 'url', 'faviconUrl', 'diff', 'canvas', 'document', 'viewport'] as const

function pickPopOutFields<K extends keyof WorkspacePaneTab>(
  source: object,
  fields: readonly K[],
): Partial<Pick<WorkspacePaneTab, K>> {
  const out: Partial<Pick<WorkspacePaneTab, K>> = {}
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      out[field] = (source as Pick<WorkspacePaneTab, K>)[field]
    }
  }
  return out
}

/**
 * Apply what the person did in a pop-out window. Every action names a tab the
 * window holds, and one aimed at any other tab is dropped: the window is a view
 * of ITS tabs, not a second door into the pane.
 */
export function applyPanePopOutAction(popOutId: string, action: PanePopOutAction): void {
  const record = popOuts.get(popOutId)
  if (!record) return
  const workspaceId = record.workspaceId
  const store = useWorkspaceStore.getState()
  const tabs = paneTabs(workspaceId)
  const holds = (tabId: unknown): tabId is string =>
    typeof tabId === 'string' && tabs.some((tab) => tab.id === tabId && tab.poppedOut === popOutId)
  switch (action.type) {
    case 'close':
      // Closed for real, exactly as in the strip. The window already ended a
      // terminal tab's pty (closePaneTabAndItsTerminal runs there); this is the
      // record.
      if (holds(action.tabId)) store.closePaneTab(workspaceId, action.tabId)
      return
    case 'update': {
      if (!holds(action.tabId) || !action.patch || typeof action.patch !== 'object') return
      // Only what a tab body writes about itself. Where the tab is shown is
      // this window's to say, not the tab's, and what the tab IS — its kind,
      // the pty it owns — is not the window's to change: a terminal tab
      // repointed at another session's pty would hand the window that pty.
      const patch = pickPopOutFields(action.patch, POP_OUT_PATCH_FIELDS)
      if (Object.keys(patch).length > 0) store.updatePaneTab(workspaceId, action.tabId, patch)
      return
    }
    case 'set-board':
      if (holds(action.tabId) && typeof action.path === 'string') {
        store.setPaneTabBoard(workspaceId, action.tabId, action.path)
      }
      return
    case 'recent-url':
      if (typeof action.url === 'string') store.notePaneRecentUrl(workspaceId, action.url)
      return
    case 'activate':
      if (holds(action.tabId)) record.activeTabId = action.tabId
      return
    case 'dock':
      if (!Array.isArray(action.tabIds)) return
      store.dockPaneTabs(workspaceId, popOutId, {
        tabIds: action.tabIds,
        activeTabId: action.tabIds.find((tabId) => holds(tabId)) ?? null,
      })
      return
    case 'open': {
      // A tab opened from inside the window (a Git row's diff, the Backlog's
      // own reveal) opens where the person is working: a NEW tab joins the
      // window, in front. A tab that already exists stays where it lives —
      // brought forward in its window, or shown in the pane — because one tab
      // is in one place.
      if (!action.input || typeof action.input !== 'object') return
      // Only the kinds a tab body opens, and never with a pty id: a terminal
      // tab is opened in the pane, which starts its pty, not from a window
      // that could name another tab's.
      const kind = (action.input as { kind?: unknown }).kind
      if (typeof kind !== 'string' || !POP_OUT_OPEN_KINDS.has(kind as WorkspacePaneTabKind)) return
      const input = {
        ...pickPopOutFields(action.input, POP_OUT_OPEN_FIELDS),
        kind: kind as WorkspacePaneTabKind,
      }
      const known = new Set(tabs.map((tab) => tab.id))
      const opened = store.openPaneTab(workspaceId, { ...input, activate: false })
      if (opened === null) return
      if (!known.has(opened)) {
        store.popOutPaneTabs(workspaceId, [opened], popOutId)
        bumpReveal(popOutId, opened)
        requestSync?.()
        return
      }
      const existing = paneTabs(workspaceId).find((tab) => tab.id === opened)
      if (existing?.poppedOut && popOuts.has(existing.poppedOut)) {
        bumpReveal(existing.poppedOut, opened)
        requestSync?.()
      } else if ((action.input as { activate?: unknown }).activate !== false) {
        store.setActivePaneTab(workspaceId, opened)
      }
      return
    }
    case 'add': {
      // The window's "+". What `open` does for a tab body's request, except
      // that the kind comes HERE: the person picked it in this window. A tab
      // already in another window stays there and comes forward in it — one
      // tab, one window — but one sitting in the pane moves over.
      const kind = action.kind
      if (typeof kind !== 'string' || !POP_OUT_OPEN_KINDS.has(kind) || kind === 'document') return
      const opened = store.openPaneTab(workspaceId, { kind, activate: false })
      if (opened === null) return
      const tab = paneTabs(workspaceId).find((candidate) => candidate.id === opened)
      if (!tab) return
      if (tab.poppedOut && tab.poppedOut !== popOutId && popOuts.has(tab.poppedOut)) {
        bumpReveal(tab.poppedOut, opened)
        showPanePopOut(tab.poppedOut)
      } else {
        if (!tab.poppedOut) store.popOutPaneTabs(workspaceId, [opened], popOutId)
        bumpReveal(popOutId, opened)
      }
      requestSync?.()
      return
    }
    case 'open-file':
      // Files open where files open — the owner's editor, or the editor
      // window when the person keeps files there. Main brings the owner
      // forward with it.
      if (typeof action.path !== 'string' || typeof action.name !== 'string') return
      openFileSurface({
        workspaceId,
        path: action.path,
        name: action.name,
        ...(typeof action.lineNumber === 'number' ? { lineNumber: action.lineNumber } : {}),
        ...(typeof action.column === 'number' ? { column: action.column } : {}),
      })
      return
    case 'diff-opens-in-window':
      if (typeof action.enabled === 'boolean') store.setDiffOpensInWindow(action.enabled)
      return
    case 'diff-view':
      if (action.view === 'side-by-side' || action.view === 'unified') store.setDiffView(action.view)
      return
  }
}

/** The tabs a window shows, as it is sent them: without the mark, which only means something here. */
function withoutMark(tab: WorkspacePaneTab): WorkspacePaneTab {
  const { poppedOut: _poppedOut, ...rest } = tab
  return rest
}

type Pushed = {
  tabs: readonly WorkspacePaneTab[]
  recentUrls: readonly string[] | undefined
  revealKey: number | null
  focusedAgentId: string | null
  agentFocusSerial: number | null
}

function samePush(a: Pushed | undefined, b: Pushed): boolean {
  if (
    !a ||
    a.recentUrls !== b.recentUrls ||
    a.revealKey !== b.revealKey ||
    a.focusedAgentId !== b.focusedAgentId ||
    a.agentFocusSerial !== b.agentFocusSerial ||
    a.tabs.length !== b.tabs.length
  )
    return false
  return a.tabs.every((tab, index) => tab === b.tabs[index])
}

/**
 * The owner side of every pop-out this window opens. Mounted once per
 * workspace window, by the pane column.
 *
 * `windowWorkspaceIds` is the workspaces this window holds. A workspace that
 * leaves it — moved to another window, closed out of this one, deleted — takes
 * its tabs back first and its pop-out windows close: the pop-out belongs to
 * THIS window's pane, and a window showing tabs of a workspace this window no
 * longer holds would be one nobody could dock. (The window closing or
 * reloading closes them in main instead — pane-popout-broker's `ownerGone` —
 * and the tabs, never persisted as popped out, come back in the pane.)
 *
 * Null is "not known right now": this window's own record briefly missing
 * from the registry, mid-move. Nothing is taken back for leaving until it is
 * known again; going by the primary window's record instead would close every
 * pop-out this window has.
 */
export function usePanePopOutHost(windowWorkspaceIds: ReadonlySet<WorkspaceId> | null): void {
  const windowWorkspaceIdsRef = useRef(windowWorkspaceIds)
  windowWorkspaceIdsRef.current = windowWorkspaceIds
  const syncRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!canPopOutPane()) return
    const pushed = new Map<string, Pushed>()
    // The active tab each workspace's pane had at the last pass: selecting a
    // popped-out tab in the strip (or an agent selecting it) brings it forward
    // in its window, so the window and the placeholder agree.
    const lastActive = new Map<WorkspaceId, string | null>()
    let syncing = false

    const sync = (): void => {
      // A dock below writes the store, which calls back in while this pass is
      // still running; the pass runs again once it is done instead.
      if (syncing) return
      syncing = true
      let docked = false
      try {
        const state = useWorkspaceStore.getState()
        const held = new Map<string, { workspaceId: WorkspaceId; tabs: WorkspacePaneTab[]; recentUrls?: string[] }>()
        const strays: Array<{ workspaceId: WorkspaceId; popOutId: string }> = []
        for (const workspace of state.workspaces) {
          const pane = workspace.paneState
          if (!pane) continue
          const active = pane.activeTabId
          const previous = lastActive.get(workspace.id)
          lastActive.set(workspace.id, active)
          if (previous !== undefined && active && active !== previous) {
            const tab = pane.tabs.find((candidate) => candidate.id === active)
            if (tab?.poppedOut && popOuts.has(tab.poppedOut)) bumpReveal(tab.poppedOut, active)
          }
          for (const tab of pane.tabs) {
            if (!tab.poppedOut) continue
            const record = popOuts.get(tab.poppedOut)
            const membership = windowWorkspaceIdsRef.current
            if (!record || record.workspaceId !== workspace.id || (membership && !membership.has(workspace.id))) {
              strays.push({ workspaceId: workspace.id, popOutId: tab.poppedOut })
              continue
            }
            const group = held.get(tab.poppedOut) ?? {
              workspaceId: workspace.id,
              tabs: [],
              recentUrls: pane.recentUrls,
            }
            group.tabs.push(tab)
            held.set(tab.poppedOut, group)
          }
        }
        for (const [popOutId, group] of held) {
          const record = popOuts.get(popOutId)!
          // Which chat's agents an Agents tab shows is decided here, where
          // chats are focused; the window has no chat of its own to follow.
          const focusedAgentId = state.focusedAgentByWorkspaceId[group.workspaceId] ?? null
          const agentFocus = readAgentFocusRequest(group.workspaceId)
          const next: Pushed = {
            tabs: group.tabs,
            recentUrls: group.recentUrls,
            revealKey: record.reveal?.key ?? null,
            focusedAgentId,
            agentFocusSerial: agentFocus?.serial ?? null,
          }
          if (samePush(pushed.get(popOutId), next)) continue
          pushed.set(popOutId, next)
          const reveal =
            record.reveal && group.tabs.some((tab) => tab.id === record.reveal?.tabId) ? record.reveal : null
          const payload: PanePopOutState = {
            tabs: group.tabs.map(withoutMark),
            ...(group.recentUrls ? { recentUrls: group.recentUrls } : {}),
            reveal,
            focusedAgentId,
            agentFocus: agentFocus
              ? { agentId: agentFocus.agentId, laneId: agentFocus.laneId, serial: agentFocus.serial }
              : null,
          }
          window.api.panePopOutPush(popOutId, payload)
        }
        // A window that showed tabs and now holds none — its last tab closed or
        // brought back — has nothing left to be. One that has not been pushed
        // yet is still opening (`popOutPaneTabs` is between its open and its
        // mark) and is left alone.
        for (const popOutId of [...pushed.keys()]) {
          if (held.has(popOutId)) continue
          pushed.delete(popOutId)
          popOuts.delete(popOutId)
          void window.api.panePopOutClose(popOutId).catch(() => undefined)
        }
        // Marks this session cannot stand behind: a window this module never
        // opened (a hot reload dropped the module's records), or a workspace
        // that left this window. The tabs come home; the store write calls
        // back in, and that pass closes the windows above.
        for (const { workspaceId, popOutId } of strays) {
          useWorkspaceStore.getState().dockPaneTabs(workspaceId, popOutId)
          docked = true
        }
      } finally {
        syncing = false
      }
      // The docks cleared the marks they were about, so the second pass finds
      // no strays and stops.
      if (docked) sync()
    }

    syncRef.current = sync
    requestSync = sync
    const offStore = useWorkspaceStore.subscribe(sync)
    // A request for the Agents tab is not a store write, so it is listened
    // for in its own right.
    const offAgentFocus = subscribeAgentFocusRequests(sync)
    const offAction = window.api.onPanePopOutAction(({ popOutId, action }) => applyPanePopOutAction(popOutId, action))
    const offClosed = window.api.onPanePopOutClosed(({ popOutId }) => {
      const record = popOuts.get(popOutId)
      popOuts.delete(popOutId)
      pushed.delete(popOutId)
      if (!record) return
      // Closing the window is how its tabs come home: the pane opens on the
      // tab the window had in front, the way docking a floating player opens
      // the pane on it.
      useWorkspaceStore.getState().dockPaneTabs(record.workspaceId, popOutId, { activeTabId: record.activeTabId })
    })
    sync()
    return () => {
      offStore()
      offAgentFocus()
      offAction()
      offClosed()
      if (requestSync === sync) requestSync = null
      syncRef.current = null
    }
  }, [])

  // Membership is read through the ref; a change to it is a reason to look again.
  useEffect(() => {
    syncRef.current?.()
  }, [windowWorkspaceIds])
}
