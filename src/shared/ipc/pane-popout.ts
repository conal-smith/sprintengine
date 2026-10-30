// Part of the IPC contract: the workspace pane, or one of its tabs, popped out
// into a window of its own. ../electron-api.ts re-exports everything here.
//
// Three parties. The OWNER is the workspace window whose pane the tabs belong
// to; its store is the only record of them, so it stays the source of truth
// for as long as they are out. The POP-OUT is an aux window (`?aux=pane`) that
// mounts their bodies and draws their strip. MAIN sits between the two: it
// opens and closes the window, remembers which window owns which pop-out, and
// relays — it never interprets a tab.
//
// The owner pushes what the pop-out should show (`PanePopOutState`) whenever
// those tabs change; the pop-out sends back what the person did there
// (`PanePopOutAction`) and renders the owner's answer. When the pop-out window
// closes, the owner is told, and its tabs dock back into the pane.

import type { WorkspacePaneTab, WorkspacePaneTabKind } from '../../renderer/src/types/workspace'
import type { WindowBounds } from './window'

export type PanePopOutOpenInput = {
  /** Minted by the owner; the id every later message names the window by. */
  popOutId: string
  workspaceId: string
  bounds?: WindowBounds | null
}

export type PanePopOutOpenResult = { ok: true } | { ok: false; message: string }

/** What the owner tells a pop-out window to show. */
export type PanePopOutState = {
  /** The tabs the window holds, in strip order, without the owner's pop-out mark. */
  tabs: WorkspacePaneTab[]
  /** The workspace's recent browser URLs, for a browser tab's start page. */
  recentUrls?: string[]
  /**
   * Bring this tab to the front of the window. `key` changes per request, so
   * the same tab can be asked for twice; the window's own tab clicks never
   * move it, which is what lets them stand between two pushes.
   */
  reveal: { tabId: string; key: number } | null
  /**
   * The chat the owner has in focus in this workspace, and its latest request
   * to open the Agents tab on one of a chat's agents. Both are the owner
   * window's alone (it is where chats are focused); an Agents tab out here
   * shows the agents of the chat the person is working with there.
   */
  focusedAgentId?: string | null
  agentFocus?: PanePopOutAgentFocus | null
}

/** A request to open the Agents tab on a chat's agent lane; `serial` changes per request. */
export type PanePopOutAgentFocus = { agentId: string; laneId: string | null; serial: number }

export type PanePopOutStatePush = { popOutId: string; state: PanePopOutState }

/** What a pop-out window is handed when it asks on boot: its workspace, and the last state pushed (null before the first). */
export type PanePopOutSnapshot = { workspaceId: string; state: PanePopOutState | null }

/** A tab to open, as the pane's own opener takes it (`openPaneTab`). */
export type PanePopOutOpenTabInput = { kind: WorkspacePaneTabKind } & Partial<
  Pick<WorkspacePaneTab, 'title' | 'url' | 'terminalId' | 'diff' | 'canvas' | 'document'>
> & { activate?: boolean }

/**
 * What the person did in a pop-out window, for the owner to apply to its pane.
 * Each one is the pane action of the same name, aimed at a tab the window
 * holds — the owner refuses one aimed anywhere else.
 */
export type PanePopOutAction =
  | { type: 'close'; tabId: string }
  | { type: 'update'; tabId: string; patch: Partial<Omit<WorkspacePaneTab, 'id' | 'kind'>> }
  | { type: 'set-board'; tabId: string; path: string }
  | { type: 'recent-url'; url: string }
  | { type: 'open'; input: PanePopOutOpenTabInput }
  /**
   * The window's own "+": a tab of this kind, in this window. A new tab joins
   * it; one of a kind the pane keeps a single tab of, sitting in the pane,
   * moves here rather than showing in the window the person is not looking at.
   */
  | { type: 'add'; kind: WorkspacePaneTabKind }
  /** The window's own tab click: remembered so docking back lands on it. */
  | { type: 'activate'; tabId: string }
  /** Send these tabs back to the pane; the window keeps the rest. */
  | { type: 'dock'; tabIds: string[] }
  /** A file picked in the window: it opens where files open, in the owner. */
  | { type: 'open-file'; path: string; name: string; lineNumber?: number; column?: number }
  /**
   * The Diff tab's app-wide preferences, changed from the window: the owner
   * holds the settings and writes them (the window persists nothing).
   */
  | { type: 'diff-opens-in-window'; enabled: boolean }
  | { type: 'diff-view'; view: 'side-by-side' | 'unified' }

export type PanePopOutActionEvent = { popOutId: string; action: PanePopOutAction }

export type PanePopOutClosedEvent = { popOutId: string }
