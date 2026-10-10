import { nanoid } from 'nanoid'

import { useWorkspaceStore } from '../../../store/workspaceStore'
import { addTerminalTab, focusOrAddFileTab } from '../../../utils/modelRegistry'
import { restoreClosedTab, takeLastClosedTab, type ClosedTab } from '../../../utils/recentlyClosedTabs'

// ⌘⇧T: the tab closed last in this workspace, opened again as a fresh tab of
// its kind (utils/recentlyClosedTabs.ts says which kinds, and why only those).

export type ReopenHost = {
  openPaneTab: (workspaceId: string, open: Extract<ClosedTab, { where: 'pane' }>['open']) => string | null
  openFile: (workspaceId: string, filePath: string, name: string) => boolean
  openShell: (workspaceId: string, name: string) => boolean
}

const appHost: ReopenHost = {
  openPaneTab: (workspaceId, open) => useWorkspaceStore.getState().openPaneTab(workspaceId, open),
  openFile: (workspaceId, filePath, name) => focusOrAddFileTab(workspaceId, filePath, name),
  // A new terminal id is a new shell, in the workspace's folder like any.
  openShell: (workspaceId, name) => addTerminalTab(workspaceId, `terminal-${nanoid(6)}`, name),
}

/** Whether a tab came back. One that cannot (a full pane) stays on the stack for the next press. */
export function reopenLastClosedTab(workspaceId: string, host: ReopenHost = appHost): boolean {
  const entry = takeLastClosedTab(workspaceId)
  if (!entry) return false
  const reopened =
    entry.where === 'pane'
      ? host.openPaneTab(workspaceId, entry.open) !== null
      : entry.kind === 'file'
        ? host.openFile(workspaceId, entry.filePath, entry.name)
        : host.openShell(workspaceId, entry.name)
  if (!reopened) restoreClosedTab(entry)
  return reopened
}
