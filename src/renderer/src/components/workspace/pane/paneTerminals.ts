import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { WorkspacePaneTab } from '../../../types/workspace'
import { keepFocusOutOfClosedPane } from './paneFocus'

// A pane terminal tab owns a pty the FlexLayout knows nothing about. Its
// session id follows PlainTerminalPanel's convention, and closing the tab
// kills the pty — the one rule, used by the strip's close affordance, the
// Primary+W handler and workspace teardown alike.

export function paneTerminalSessionId(terminalId: string): string {
  return `terminal-${terminalId}`
}

export function closePaneTabAndItsTerminal(workspaceId: string, tab: WorkspacePaneTab): void {
  if (tab.kind === 'terminal' && tab.terminalId) {
    void window.api.terminalKill(paneTerminalSessionId(tab.terminalId)).catch(() => {})
  }
  // The last tab takes the pane with it.
  keepFocusOutOfClosedPane(
    () => useWorkspaceStore.getState().closePaneTab(workspaceId, tab.id),
    () => Boolean(useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)?.paneState?.open),
  )
}
