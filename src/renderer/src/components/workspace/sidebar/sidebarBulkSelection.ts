import { useCallback, useMemo, useState, type RefObject } from 'react'

import {
  collapseBacklogSelectionTo,
  EMPTY_BACKLOG_MULTI_SELECTION,
  extendBacklogSelectionTo,
  isBacklogMultiSelectionActive,
  pruneBacklogSelection,
  toggleBacklogSelection,
  type BacklogMultiSelection,
} from '../../backlog/backlogMultiSelection'

// Selecting several chats in the sidebar at once, to settle, snooze, star or
// retitle them together: Shift-click takes the range from the last clicked
// row, Cmd-click (Ctrl-click off the Mac) adds or drops one row. A plain click
// is what it always was, and ends the selection.
//
// The model is the Backlog list's (backlogMultiSelection.ts): the chat open in
// front is the cursor, so the first Cmd-click on another row selects the two,
// and the selection layers on top without moving the roving tab stop. The
// order a range is cut from is the rows as drawn, read from the tree when the
// click lands, so a folded project's chats are never swept into it.

/** A selected row's fill: the selected surface, as the open chat's, without its edge. */
export const BULK_SELECTED_ROW_CLASS = 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'

type ClickLike = { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; preventDefault(): void }

export type SidebarBulkSelection = {
  /** The selected chats while more than one is; null otherwise. */
  selected: ReadonlySet<string> | null
  /** Whether a row is painted selected: only while a selection of several is held. */
  isSelected(workspaceId: string): boolean
  /**
   * A click on a chat row: true when it changed the selection (a modified
   * click), and the row should not open; false for a plain click, which
   * collapses the selection onto the row and opens it as before.
   */
  click(event: ClickLike, workspaceId: string): boolean
  clear(): void
  /** Forget chats that left the rail (settled, deleted, moved away). */
  prune(present: ReadonlySet<string>): void
}

/**
 * Cmd on the Mac, Ctrl elsewhere: either is taken on both, since a Ctrl-click
 * on the Mac is the system's right-click and never arrives as a click.
 */
function isToggleClick(event: Pick<ClickLike, 'metaKey' | 'ctrlKey'>): boolean {
  return event.metaKey || event.ctrlKey
}

/** The selectable chats in the tree, as drawn, each once. */
export function drawnChatOrder(root: ParentNode | null, canSelect: (workspaceId: string) => boolean): string[] {
  if (!root) return []
  const seen = new Set<string>()
  for (const row of root.querySelectorAll<HTMLElement>('[role="treeitem"][data-workspace-id]')) {
    const id = row.dataset.workspaceId
    if (id && canSelect(id)) seen.add(id)
  }
  return [...seen]
}

export function useSidebarBulkSelection(options: {
  treeRef: RefObject<HTMLElement | null>
  /** The chat open in front, the selection's cursor. */
  cursorId: string | null
  /** Whether a chat may be selected: one here, not a paired machine's. */
  canSelect: (workspaceId: string) => boolean
}): SidebarBulkSelection {
  const { treeRef, cursorId, canSelect } = options
  const [state, setState] = useState<BacklogMultiSelection>(EMPTY_BACKLOG_MULTI_SELECTION)
  const active = isBacklogMultiSelectionActive(state)
  const cursor = cursorId && canSelect(cursorId) ? cursorId : null

  const click = useCallback(
    (event: ClickLike, workspaceId: string): boolean => {
      const toggle = isToggleClick(event)
      if (!event.shiftKey && !toggle) {
        setState(collapseBacklogSelectionTo(workspaceId))
        return false
      }
      // A row that cannot be selected opens as a plain click would.
      if (!canSelect(workspaceId)) return false
      event.preventDefault()
      setState((current) =>
        event.shiftKey
          ? extendBacklogSelectionTo(current, cursor, workspaceId, drawnChatOrder(treeRef.current, canSelect))
          : toggleBacklogSelection(current, cursor, workspaceId),
      )
      return true
    },
    [canSelect, cursor, treeRef],
  )

  const clear = useCallback(() => setState(EMPTY_BACKLOG_MULTI_SELECTION), [])
  const prune = useCallback(
    (present: ReadonlySet<string>) => setState((current) => pruneBacklogSelection(current, present)),
    [],
  )

  return useMemo(
    () => ({
      selected: active ? state.keys : null,
      isSelected: (workspaceId: string) => active && state.keys!.has(workspaceId),
      click,
      clear,
      prune,
    }),
    [active, state.keys, click, clear, prune],
  )
}
