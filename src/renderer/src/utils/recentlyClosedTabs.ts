import type { WorkspacePaneTab } from '../types/workspace'
import type { WorkspacePaneOpenInput } from '../store/slices/workspacePaneSlice'

// Reopen a closed tab (`layout.tab.reopen`, ⌘⇧T): the tabs closed in this
// window this session, newest last, each kept as what is needed to open its
// like again rather than as the tab itself.
//
// What comes back is a fresh tab of the same kind, never the thing that was
// closed, and only where that is safe to do without asking:
//   - a browser tab opens at the URL it was on;
//   - a terminal (the pane's or the layout's) opens as a fresh shell in the
//     workspace's folder, which is where every shell tab starts; the closed
//     one's process and scrollback are gone, and nothing it ran is run again;
//   - a file tab opens the file again;
//   - the pane's own surfaces (Files, Git, Diff, Backlog, Agents, a canvas
//     board, a document) open on what they were showing.
// An agent's tab is never brought back this way: closing it ended or parked a
// conversation, and starting one again is not something a shortcut should do.
//
// Session-only and per window: module state, not the store, so nothing is
// persisted or synced, and a restart starts with nothing to reopen.

export type ClosedTab =
  | { where: 'pane'; workspaceId: string; open: WorkspacePaneOpenInput }
  | { where: 'layout'; workspaceId: string; kind: 'file'; filePath: string; name: string }
  | { where: 'layout'; workspaceId: string; kind: 'terminal'; name: string }

/** How many closed tabs are remembered, across every workspace in this window. */
export const MAX_CLOSED_TABS = 25

const closed: ClosedTab[] = []

function remember(entry: ClosedTab): void {
  closed.push(entry)
  if (closed.length > MAX_CLOSED_TABS) closed.splice(0, closed.length - MAX_CLOSED_TABS)
}

/**
 * What opens a pane tab like `tab` again, or null for one that cannot be.
 * Plain values only: the tab may be a store draft that is gone once the close
 * has been written.
 */
export function closedPaneTabSpec(tab: WorkspacePaneTab): WorkspacePaneOpenInput | null {
  const title = tab.title ? { title: tab.title } : {}
  switch (tab.kind) {
    case 'browser':
      return { kind: 'browser', ...title, ...(tab.url ? { url: tab.url } : {}) }
    case 'terminal':
      // No terminal id: the pane mints a new one, which is a new shell.
      return { kind: 'terminal' }
    case 'files':
    case 'git':
    case 'backlog':
    case 'agents':
      return { kind: tab.kind }
    case 'diff': {
      // Where it was looking; an agent's reveal and a tour are the moment's,
      // not the tab's.
      const diff = tab.diff
      return {
        kind: 'diff',
        diff: {
          ...(diff?.repoRoot ? { repoRoot: diff.repoRoot } : {}),
          focusPath: diff?.focusPath ?? null,
          focusKind: diff?.focusKind ?? null,
          ...(diff?.changelistId ? { changelistId: diff.changelistId } : {}),
        },
      }
    }
    case 'canvas':
      return { kind: 'canvas', ...(tab.canvas?.path ? { canvas: { path: tab.canvas.path } } : {}) }
    case 'document':
      return tab.document?.path ? { kind: 'document', document: { path: tab.document.path } } : null
    default:
      return null
  }
}

export function rememberClosedPaneTab(workspaceId: string, tab: WorkspacePaneTab): void {
  const open = closedPaneTabSpec(tab)
  if (open) remember({ where: 'pane', workspaceId, open })
}

/** A layout tab as its node describes it: its component, its config, its name. */
export type ClosedLayoutNode = { component: string | undefined; config: unknown; name: string }

export function rememberClosedLayoutTab(workspaceId: string, node: ClosedLayoutNode): void {
  const config = (node.config ?? {}) as { filePath?: unknown }
  if (node.component === 'file-editor' && typeof config.filePath === 'string' && config.filePath) {
    remember({ where: 'layout', workspaceId, kind: 'file', filePath: config.filePath, name: node.name })
  } else if (node.component === 'terminal') {
    remember({ where: 'layout', workspaceId, kind: 'terminal', name: node.name || 'Terminal' })
  }
}

/** Take the newest closed tab of `workspaceId` off the stack, or null when it has none. */
export function takeLastClosedTab(workspaceId: string): ClosedTab | null {
  for (let index = closed.length - 1; index >= 0; index--) {
    if (closed[index]!.workspaceId === workspaceId) return closed.splice(index, 1)[0]!
  }
  return null
}

/** Put back a tab that could not be reopened (a full pane), so the next press tries it again. */
export function restoreClosedTab(entry: ClosedTab): void {
  remember(entry)
}

/** Test seam: the stack is module state. */
export function resetClosedTabs(): void {
  closed.length = 0
}
