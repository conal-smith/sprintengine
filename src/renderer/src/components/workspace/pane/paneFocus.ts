// Whether keyboard focus is inside a workspace pane. Read by the shell's
// `layout.tab.close` handler so Primary+W closes the pane's active tab when
// the pane owns focus, and keeps its FlexLayout meaning everywhere else.
export const WORKSPACE_PANE_DATA_ATTRIBUTE = 'data-workspace-pane'

export function isWorkspacePaneFocused(): boolean {
  if (typeof document === 'undefined') return false
  const active = document.activeElement
  return Boolean(active && active.closest(`[${WORKSPACE_PANE_DATA_ATTRIBUTE}]`))
}

/**
 * Make a change that may close the pane, and move focus out of it when it
 * did. A closed pane column is inert at once, so focus left inside it would
 * drop to the page and the next Tab would start from the top of the window;
 * it goes where reopening the pane lives, the header's pane switch.
 */
export function keepFocusOutOfClosedPane(change: () => void, paneOpen: () => boolean): void {
  const focused = isWorkspacePaneFocused()
  change()
  if (!focused || paneOpen() || typeof window === 'undefined') return
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLElement>('[data-pane-switch]')?.focus()
  })
}
