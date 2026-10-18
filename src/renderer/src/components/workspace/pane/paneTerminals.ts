import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { WorkspacePaneTab } from '../../../types/workspace'
import { isWorkspacePaneFocused } from './paneFocus'

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
  const store = useWorkspaceStore.getState()
  const focused = isWorkspacePaneFocused()
  store.closePaneTab(workspaceId, tab.id)
  // The last tab took the pane with it. Focus left inside the closed column
  // would strand the keyboard in hidden chrome, so it goes where reopening
  // the pane lives: the header's pane switch.
  const closedPane = !useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)?.paneState?.open
  if (focused && closedPane && typeof window !== 'undefined') {
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-pane-switch]')?.focus()
    })
  }
}
