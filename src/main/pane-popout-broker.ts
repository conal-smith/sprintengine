// The pane pop-out's relay, as a protocol (shared/ipc/pane-popout.ts has the
// three parties and the messages).
//
// It lives apart from its Electron glue (`ipc/pane-popout-ipc.ts`) for the same
// reason `ipc/dock-diff.ts` does: the rules are here, and a unit test cannot
// load `electron`. Nothing in this file knows what a BrowserWindow is. A peer is
// something that can be sent to, and recognised again when a message comes
// FROM it.
//
// What it is careful about:
//
//   1. **Only the owner speaks for the tabs.** A push, a focus or a close is
//      taken from the window that opened the pop-out and from nobody else; an
//      action is taken from the pop-out window itself. A pop-out id alone is
//      not a credential — any renderer could name one.
//   2. **Main interprets nothing.** A push is held as it came so a window that
//      boots after it can ask for it, and an action is handed on as it came.
//      The owner's pane slice normalizes everything it is sent; checking tab
//      records twice, in two places, is how the two would come to disagree.
//      The one question main asks of a push is which terminals it holds
//      (`mayAttachTerminal`): a pty's output goes to one window.
//   3. **A pop-out never outlives its owner.** The owner's store is the only
//      record of which tabs are out; a reloaded or closed owner has lost it, so
//      the windows it opened are closed rather than left showing tabs nobody
//      can take back (`ownerGone`).

import type {
  PanePopOutAction,
  PanePopOutOpenResult,
  PanePopOutSnapshot,
  PanePopOutState,
} from '../shared/ipc/pane-popout'
import type { WindowBounds } from '../shared/ipc/window'

/** A window, as the broker needs it. `id` is compared with a message's sender. */
export type PanePopOutPeer = {
  id: unknown
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

/** The pop-out window itself: a peer that can also be raised and closed. */
export type PanePopOutWindowHandle = PanePopOutPeer & {
  focus(): void
  close(): void
}

type Entry = {
  popOutId: string
  workspaceId: string
  owner: PanePopOutPeer
  window: PanePopOutWindowHandle
  state: PanePopOutState | null
  /** The owner asked for it closed: from then on it holds nothing, whatever it last showed. */
  closing: boolean
}

// A pane terminal tab's pty session id (renderer: paneTerminals.ts). The one
// place main reads a tab: whether the window holds the terminal it asks for.
function paneTerminalSessionId(terminalId: string): string {
  return `terminal-${terminalId}`
}

export type PanePopOutBrokerDeps = {
  /** Open the window. Called once per pop-out id; the broker remembers the handle. */
  openWindow(input: { popOutId: string; workspaceId: string; bounds: WindowBounds | null }): PanePopOutWindowHandle
}

// The same shape the pane slice keeps on a tab (`POP_OUT_ID` there): what the
// renderer's nanoid mints, and nothing that could smuggle a path or a query
// into the window's URL.
const POP_OUT_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_WORKSPACE_ID_LENGTH = 200
// The pane's own cap is 24 tabs; a push past it is not one the pane made.
const MAX_PUSHED_TABS = 24

const ACTION_TYPES: ReadonlySet<PanePopOutAction['type']> = new Set([
  'close',
  'update',
  'set-board',
  'recent-url',
  'open',
  'add',
  'activate',
  'dock',
  'open-file',
  'diff-opens-in-window',
  'diff-view',
])

function isPanePopOutId(value: unknown): value is string {
  return typeof value === 'string' && POP_OUT_ID.test(value)
}

function readPopOutId(input: unknown): string | null {
  const popOutId = (input as { popOutId?: unknown } | null)?.popOutId
  return isPanePopOutId(popOutId) ? popOutId : null
}

function readBounds(input: unknown): WindowBounds | null {
  if (!input || typeof input !== 'object') return null
  const { x, y, width, height } = input as Partial<Record<keyof WindowBounds, unknown>>
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
  return finite(x) && finite(y) && finite(width) && finite(height) ? { x, y, width, height } : null
}

function readState(input: unknown): PanePopOutState | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Partial<PanePopOutState>
  if (!Array.isArray(raw.tabs) || raw.tabs.length > MAX_PUSHED_TABS) return null
  return raw as PanePopOutState
}

function readAction(input: unknown): PanePopOutAction | null {
  if (!input || typeof input !== 'object') return null
  const type = (input as { type?: unknown }).type
  return typeof type === 'string' && ACTION_TYPES.has(type as PanePopOutAction['type'])
    ? (input as PanePopOutAction)
    : null
}

export function createPanePopOutBroker(deps: PanePopOutBrokerDeps) {
  const entries = new Map<string, Entry>()

  function live(popOutId: string | null): Entry | null {
    if (!popOutId) return null
    const entry = entries.get(popOutId)
    if (!entry) return null
    if (entry.window.isDestroyed()) {
      entries.delete(popOutId)
      return null
    }
    return entry
  }

  return {
    /** The owner asks for a window. A second ask for the same id raises the one that is open. */
    open(owner: PanePopOutPeer, input: unknown): PanePopOutOpenResult {
      const popOutId = readPopOutId(input)
      if (!popOutId) return { ok: false, message: 'invalid_pop_out_id' }
      const workspaceId = (input as { workspaceId?: unknown }).workspaceId
      if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > MAX_WORKSPACE_ID_LENGTH) {
        return { ok: false, message: 'invalid_workspace_id' }
      }
      const existing = live(popOutId)
      if (existing) {
        if (existing.owner.id !== owner.id) return { ok: false, message: 'foreign_pop_out' }
        existing.window.focus()
        return { ok: true }
      }
      const window = deps.openWindow({
        popOutId,
        workspaceId,
        bounds: readBounds((input as { bounds?: unknown }).bounds),
      })
      entries.set(popOutId, { popOutId, workspaceId, owner, window, state: null, closing: false })
      return { ok: true }
    },

    /** The owner's latest word on what the window shows: kept for a late boot, and relayed. */
    push(fromId: unknown, input: unknown): void {
      const entry = live(readPopOutId(input))
      if (!entry || entry.owner.id !== fromId) return
      const state = readState((input as { state?: unknown }).state)
      if (!state) return
      entry.state = state
      entry.window.send('pane-popout:state', { popOutId: entry.popOutId, state })
    },

    /** The pop-out, booting, asks what it is for. Only the window itself is answered. */
    getState(fromId: unknown, input: unknown): PanePopOutSnapshot | null {
      const entry = live(readPopOutId(input))
      if (!entry || entry.window.id !== fromId) return null
      return { workspaceId: entry.workspaceId, state: entry.state }
    },

    /**
     * What the person did in the window, handed to its owner. Returns what it
     * relayed and to whom (null when it relayed nothing), so the glue can bring
     * the owner forward for an action whose answer shows there — a file
     * opening in the owner's editor.
     */
    act(fromId: unknown, input: unknown): { action: PanePopOutAction; ownerId: unknown } | null {
      const entry = live(readPopOutId(input))
      if (!entry || entry.window.id !== fromId || entry.owner.isDestroyed()) return null
      const action = readAction((input as { action?: unknown }).action)
      if (!action) return null
      entry.owner.send('pane-popout:action', { popOutId: entry.popOutId, action })
      return { action, ownerId: entry.owner.id }
    },

    focus(fromId: unknown, input: unknown): void {
      const entry = live(readPopOutId(input))
      if (entry && entry.owner.id === fromId) entry.window.focus()
    },

    close(fromId: unknown, input: unknown): void {
      const entry = live(readPopOutId(input))
      if (!entry || entry.owner.id !== fromId) return
      entry.closing = true
      entry.window.close()
    },

    /**
     * Whether a window may take over the route of an existing terminal
     * session (a terminal pane re-attaching to its pty). A window that is not
     * a pop-out has no say from here. A pop-out may only while the owner's
     * latest word has it holding that terminal's tab: a terminal brought back
     * to the pane is the pane's, and a re-attach the pop-out sent before it
     * heard so — its panel was waiting on a folder lookup — would otherwise
     * route the pty to a window about to drop it, and freeze the pane's.
     */
    mayAttachTerminal(fromId: unknown, sessionId: unknown): boolean {
      const entry = [...entries.values()].find((candidate) => candidate.window.id === fromId)
      if (!entry) return true
      if (entry.closing || entry.window.isDestroyed() || typeof sessionId !== 'string') return false
      return (entry.state?.tabs ?? []).some(
        (tab) =>
          tab?.kind === 'terminal' &&
          typeof tab.terminalId === 'string' &&
          paneTerminalSessionId(tab.terminalId) === sessionId,
      )
    },

    /** The window closed, however it closed: its owner takes the tabs back. */
    windowClosed(popOutId: string): void {
      const entry = entries.get(popOutId)
      if (!entry) return
      entries.delete(popOutId)
      if (!entry.owner.isDestroyed()) entry.owner.send('pane-popout:closed', { popOutId })
    },

    /**
     * The owner closed or reloaded. Its record of the tabs went with it, so its
     * windows close too — a reloaded owner finds the tabs back in its pane,
     * because the pop-out mark is never persisted.
     */
    ownerGone(ownerId: unknown): void {
      for (const entry of [...entries.values()]) {
        if (entry.owner.id !== ownerId) continue
        entries.delete(entry.popOutId)
        if (!entry.window.isDestroyed()) entry.window.close()
      }
    },
  }
}
