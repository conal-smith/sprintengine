// The Changes list: a commit checklist composed from the kit (epic
// `git-commit-window`, T5; mockup 2522 panel 1).
//
// ONE KEYBOARD OWNER, ONE LISTBOX PER GROUP. The outer element is the walk: it
// carries `tabIndex=0`, drives the cursor with `aria-activedescendant` across
// every group, and owns Space (tick) and Enter (open). Four hundred rows must
// not be four hundred tab stops, which is why `check-row`'s box is a drawing
// rather than an input and why the row is a `<div role="option">` rather than a
// button.
//
// What the outer element is NOT is the listbox. It used to be, and a listbox
// may own nothing but `option`s — while the group bands standing between the
// runs of rows are three real controls each (a chevron `<button>`, a real
// `<input type="checkbox">`, a kebab `<button>`), which `aria-required-children`
// rejects outright. So the bands sit OUTSIDE every listbox, each group's rows
// are their own `role="listbox"`, and the outer element is a `role="group"` —
// a role that supports `aria-activedescendant`, which is what lets one walk
// span all of them. The band's controls stay real, focusable controls, exactly
// as `group-header` specifies: they are per-GROUP, not per-row, so they cost a
// handful of tab stops rather than four hundred. The ruling is recorded in
// design-system/components/check-row/component.md and group-header/component.md.
//
// TWO QUESTIONS, KEPT APART. The tick is a value the row carries — it IS the
// index — and the fill and edge are where the person is. Clicking the box ticks
// without picking (the box stops the click); clicking the row picks without
// ticking. Everything below follows from that one sentence.
//
// GROUPS, PLURAL, AND IT DOES NOT KNOW WHICH. This renders whatever
// `buildGitChangeGroups` hands it — a changelist, a directory, the untracked
// files, one flat list — as a header, the region it folds, and the cap notice.
// T6 added three kinds and changed nothing here except the chip on the band and
// the band's own menu, which is the point of having taken an array in T5.
//
// A PARTIAL ROW IS A DIFFERENT ROW ABOUT THE SAME FILE. Agent changelists let a
// list own hunks of a file that lives in another list, and that draws a second
// row — same filename, same directory, a `partial` micro-chip, and a `key` that
// is not the path. Everything the list keys on is `row.key` for exactly that
// reason; the chip is the visible half and the row's name carries the sentence,
// because a chip is a drawing and the box under it does something different
// here from what every other box in the panel does.
//
// THE LIST OWNS FOUR MORE KEYS. Space ticks and Enter opens, as before; ⌘↓
// opens the file in an editor, F2 edits the changelist the cursor's row sits
// in, ⌫ deletes the selected files from disk, and ⌥⌘A adds an untracked one to
// git. They live here rather than in the command registry because they are only
// meaningful with this list focused — and because the menu may only carry a
// shortcut hint for a key that works with the menu closed, which these do.

import React, { type JSX } from 'react'

import { getGitStatusAppearance } from '../../../utils/gitStatusAppearance'
import { isLetterKey } from '../../../utils/keyboard'
import {
  CheckRow,
  ContextMenu,
  FileTypeGlyph,
  GroupHeader,
  GroupHeaderAction,
  KebabGlyph,
  MenuDivider,
  MenuFlyoutItem,
  MenuItem,
  MicroChip,
  FOCUS_RING_INSET_CLASS,
} from '../../ui'
import type { ChangeRowMenuEntry } from './changeRowMenu'
import { changeRowDomId, gitStatusWord, type GitChangeGroup, type GitChangeRow } from './gitChangesModel'

export type GitChangesListProps = {
  /** Prefix for the region and row ids. Unique per panel instance. */
  listId: string
  groups: GitChangeGroup[]
  /** The rows on screen, in visual order — the keyboard walk and the shift
   *  range. Computed by the panel (which also needs it for the marquee) rather
   *  than derived twice. */
  visibleRows: GitChangeRow[]
  expandedGroupIds: ReadonlySet<string>
  onExpandedChange: (groupId: string, next: boolean) => void
  /** `changeRowKey`, never `path`: a file with a guest row in another list has
   *  TWO rows on screen, and a selection keyed by path would tick both. */
  selectedRowKeys: ReadonlySet<string>
  cursorRowKey: string | null
  /** Tick or untick one row. The panel decides which way from the row's state. */
  onToggleRow: (row: GitChangeRow) => void
  /** Tick or untick a whole group. */
  onToggleGroup: (group: GitChangeGroup, next: boolean) => void
  /** A pointer gesture on the row body. Returns true when the gesture was
   *  consumed as SELECTION (marquee, shift-range, cmd-toggle) and must not also
   *  open the diff. */
  onRowClick: (row: GitChangeRow, event: React.MouseEvent) => boolean
  /** Enter, or a plain click on the row body. */
  onActivateRow: (row: GitChangeRow) => void
  /** Move the keyboard cursor, replacing or extending the selection with it. */
  onMoveCursor: (rowKey: string, mode: 'replace' | 'extend') => void
  onSelectAll: () => void
  /** A right-click makes the row the selection when it was outside it, so the
   *  menu's labels describe exactly what the actions will touch. */
  onContextSelect: (row: GitChangeRow) => void
  buildMenu: (row: GitChangeRow) => ChangeRowMenuEntry[]
  /** The band's own menu — the changelist half plus stage / unstage / discard
   *  all. Reached by right-clicking the band or by its overflow control, which
   *  is what makes it available to a pointer, a keyboard and a touch. */
  buildGroupMenu: (group: GitChangeGroup) => ChangeRowMenuEntry[]
  /** ⌘↓ on the cursor's row. */
  onOpenInEditor: (row: GitChangeRow) => void
  /** ⌫ — deletes from disk, so the panel confirms before it acts. */
  onDeleteFiles: (row: GitChangeRow) => void
  /** ⌥⌘A, and only meaningful on an untracked row; the panel decides. */
  onAddToGit: (row: GitChangeRow) => void
  /** F2 on the cursor's row — edits the changelist that row sits in. */
  onEditChangelist: (row: GitChangeRow) => void
  registerRowNode: (rowKey: string, node: HTMLElement | null) => void
  /** Which group band holds focus, so the panel can route ⌘D to "show diff for
   *  this changelist" instead of to the cursor's row. Null when focus left the
   *  bands entirely. */
  onGroupHeaderFocus?: (groupId: string | null) => void
}

type RowMenuState = { x: number; y: number; row: GitChangeRow; groupTitle: string }
type GroupMenuState = { x: number; y: number; group: GitChangeGroup }

/**
 * One menu entry array, rendered. Shared by the row menu and the band menu so
 * the two cannot drift: a divider is a divider, a submenu is a `MenuFlyoutItem`,
 * and an item's danger ink, hint and disabled state are decided in exactly one
 * place. `onClose` fires before the action so the menu is gone by the time a
 * dialog opens under it.
 */
function renderMenuEntries(entries: ChangeRowMenuEntry[], onClose: () => void): React.ReactNode {
  return entries.map((entry) => {
    if (entry.kind === 'divider') return <MenuDivider key={entry.id} />
    if (entry.kind === 'submenu') {
      return (
        <MenuFlyoutItem
          key={entry.id}
          label={entry.label}
          ariaLabel={entry.label}
          icon={entry.icon}
          disabled={entry.disabled}
          surfaceClassName="min-w-[200px]"
        >
          {renderMenuEntries(entry.items, onClose)}
        </MenuFlyoutItem>
      )
    }
    return (
      <MenuItem
        key={entry.id}
        icon={entry.icon}
        shortcut={entry.shortcut}
        variant={entry.danger ? 'danger' : undefined}
        disabled={entry.disabled}
        onClick={() => {
          onClose()
          entry.onSelect()
        }}
      >
        {entry.label}
      </MenuItem>
    )
  })
}

/** What a row asks of the list. One object for the list's lifetime, so a row
 *  whose own data did not change skips rendering when the panel re-renders. */
type GitChangeRowActions = {
  toggleRow: (row: GitChangeRow) => void
  rowClick: (row: GitChangeRow, event: React.MouseEvent) => boolean
  activateRow: (row: GitChangeRow) => void
  contextSelect: (row: GitChangeRow) => void
  openRowMenu: (menu: RowMenuState) => void
  registerRowNode: (rowKey: string, node: HTMLElement | null) => void
}

// One changed file. Memoized on its own data: a panel holding a few hundred of
// these re-renders for many reasons (a busy flag, a message, the toolbar), and
// none of them is a reason to rebuild every row.
const GitChangeRowItem = React.memo(function GitChangeRowItem({
  listId,
  row,
  groupTitle,
  selected,
  resting,
  cursor,
  actions,
}: {
  listId: string
  row: GitChangeRow
  groupTitle: string
  selected: boolean
  resting: boolean
  cursor: boolean
  actions: GitChangeRowActions
}): JSX.Element {
  const appearance = getGitStatusAppearance(row.status)
  const statusWord = gitStatusWord(row.status)
  // Stable per row: a ref callback that changed identity every render would
  // be detached and attached again on each one.
  const registerNode = React.useCallback(
    (node: HTMLElement | null) => actions.registerRowNode(row.key, node),
    [actions, row.key],
  )
  return (
    <CheckRow
      id={changeRowDomId(listId, row.key)}
      ref={registerNode}
      data-git-change-row="true"
      role="option"
      checked={row.checked}
      // Always present. `check-row` only swallows the click when
      // it has a handler to run, so a box that dropped its
      // handler while busy would let the click through to the row
      // and OPEN THE DIFF — a tick that shows a diff instead.
      onCheckedChange={() => actions.toggleRow(row)}
      glyph={<FileTypeGlyph name={row.filename} tone="kind" className="icon-sm" />}
      name={
        // The status tint travels with the name, and the word
        // travels with it: T5 dropped the trailing status letter,
        // so this clause is the only non-colour carrier left and
        // colour alone is not an accessible signal.
        <span className={appearance.textClass}>
          {row.filename}
          {statusWord ? <span className="sr-only">, {statusWord}</span> : null}
          {/* The chip below is the visible half; a chip is a
              drawing, so the sentence that says what THIS row
              is — and what its box will do, which is not what
              every other box on screen does — travels with the
              name where a screen reader meets it first. */}
          {row.partial ? (
            <span className="sr-only">
              , partial: {groupTitle}’s changes only. Ticking stages that list’s hunks of this file.
            </span>
          ) : null}
        </span>
      }
      directory={
        row.partial ? (
          // The chip trails the directory and never shrinks:
          // the path is what gets cut in a narrow panel, the
          // fact that this row is a piece of a file is not.
          <span className="flex min-w-0 items-center gap-1">
            <span className="min-w-0 truncate">{row.directory}</span>
            <MicroChip>partial</MicroChip>
          </span>
        ) : (
          row.directory || undefined
        )
      }
      selected={selected}
      resting={resting}
      cursor={cursor}
      onClick={(event) => {
        if (actions.rowClick(row, event)) return
        actions.activateRow(row)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        actions.contextSelect(row)
        // A keyboard-summoned menu (Shift+F10, the Menu key)
        // carries no pointer; open it on the row rather than at
        // the viewport corner.
        const rect = event.currentTarget.getBoundingClientRect()
        actions.openRowMenu({ x: event.clientX || rect.left, y: event.clientY || rect.bottom, row, groupTitle })
      }}
    />
  )
})

export const GitChangesList = React.memo(function GitChangesList({
  listId,
  groups,
  visibleRows,
  expandedGroupIds,
  onExpandedChange,
  selectedRowKeys,
  cursorRowKey,
  onToggleRow,
  onToggleGroup,
  onRowClick,
  onActivateRow,
  onMoveCursor,
  onSelectAll,
  onContextSelect,
  buildMenu,
  buildGroupMenu,
  onOpenInEditor,
  onDeleteFiles,
  onAddToGit,
  onEditChangelist,
  registerRowNode,
  onGroupHeaderFocus,
}: GitChangesListProps): JSX.Element {
  const [rowMenu, setRowMenu] = React.useState<RowMenuState | null>(null)
  const [groupMenu, setGroupMenu] = React.useState<GroupMenuState | null>(null)
  // Which fill a picked row takes: the accent edge belongs to the pane the
  // person is driving, and exactly one edge may be on screen at a time.
  const [listFocused, setListFocused] = React.useState(false)
  const listRef = React.useRef<HTMLDivElement | null>(null)
  // The panel hands over fresh closures on every render. The rows reach them
  // through this ref, by way of one actions object that never changes, so a
  // new closure is not a reason for a row to render again.
  const handlers = React.useRef({ onToggleRow, onRowClick, onActivateRow, onContextSelect, registerRowNode })
  React.useLayoutEffect(() => {
    handlers.current = { onToggleRow, onRowClick, onActivateRow, onContextSelect, registerRowNode }
  })
  const rowActions = React.useMemo<GitChangeRowActions>(
    () => ({
      toggleRow: (row) => handlers.current.onToggleRow(row),
      rowClick: (row, event) => handlers.current.onRowClick(row, event),
      activateRow: (row) => handlers.current.onActivateRow(row),
      contextSelect: (row) => handlers.current.onContextSelect(row),
      openRowMenu: setRowMenu,
      registerRowNode: (rowKey, node) => handlers.current.registerRowNode(rowKey, node),
    }),
    [],
  )

  const cursorIndex = cursorRowKey ? visibleRows.findIndex((row) => row.key === cursorRowKey) : -1

  function moveTo(index: number, extend: boolean): void {
    const row = visibleRows[Math.min(Math.max(index, 0), visibleRows.length - 1)]
    if (!row) return
    onMoveCursor(row.key, extend ? 'extend' : 'replace')
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    // Only when focus is on the list itself. The group headers' chevron and
    // checkbox are real controls inside this subtree and own their own keys.
    if (event.target !== event.currentTarget) return
    if (visibleRows.length === 0) return

    // The modified keys are read FIRST. ⌘↓ and ↓ differ by one flag, and a
    // chain that tested the bare arrow first would move the cursor and never
    // reach "open in editor".
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key === 'ArrowDown') {
      // ⌘↓ jumps to the source file. The menu carries this hint because it
      // works right here, with the menu closed.
      event.preventDefault()
      const row = visibleRows[cursorIndex]
      if (row) onOpenInEditor(row)
    } else if (
      (event.metaKey || event.ctrlKey) &&
      event.altKey &&
      (event.key === 'a' || event.key === 'A' || event.code === 'KeyA')
    ) {
      event.preventDefault()
      const row = visibleRows[cursorIndex]
      if (row) onAddToGit(row)
    } else if (event.key === 'F2') {
      event.preventDefault()
      const row = visibleRows[cursorIndex]
      if (row) onEditChangelist(row)
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      // Deletes from DISK. The panel confirms — this key only asks.
      event.preventDefault()
      const row = visibleRows[cursorIndex]
      if (row) onDeleteFiles(row)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveTo(cursorIndex < 0 ? 0 : cursorIndex + 1, event.shiftKey)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveTo(cursorIndex < 0 ? visibleRows.length - 1 : cursorIndex - 1, event.shiftKey)
    } else if (event.key === 'Home') {
      event.preventDefault()
      moveTo(0, event.shiftKey)
    } else if (event.key === 'End') {
      event.preventDefault()
      moveTo(visibleRows.length - 1, event.shiftKey)
    } else if (isLetterKey(event, 'a') && !event.shiftKey && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      onSelectAll()
    } else if (event.key === ' ') {
      // Space ticks, and only ticks. The list owns this key because the box is
      // a drawing — there is nothing else for the keyboard to press.
      event.preventDefault()
      const row = visibleRows[cursorIndex]
      if (row) onToggleRow(row)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const row = visibleRows[cursorIndex]
      if (row) onActivateRow(row)
    }
  }

  return (
    <div
      ref={listRef}
      // `group`, not `listbox`: the bands below are not options, and the walk
      // spans every group's listbox rather than living inside one of them.
      role="group"
      aria-label="Changed files"
      aria-activedescendant={cursorRowKey ? changeRowDomId(listId, cursorRowKey) : undefined}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        // The rows are not focusable — the LIST is the tab stop — so a click on
        // a row has to hand focus to the list, or the arrow keys do nothing
        // until the person has tabbed to it. A group header owns its own
        // controls and keeps their focus.
        if (event.target instanceof Element && event.target.closest('[data-git-group-header="true"]')) return
        listRef.current?.focus()
      }}
      onFocus={() => setListFocused(true)}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setListFocused(false)
      }}
      className={`rounded-xs ${FOCUS_RING_INSET_CLASS}`}
    >
      {groups.map((group) => {
        const regionId = `${listId}-${group.id}-rows`
        const expanded = expandedGroupIds.has(group.id)
        return (
          <div key={group.id}>
            {/* The band is not an `option`, and it is not inside the listbox
                either — a chevron, a checkbox and a kebab are three controls,
                and a listbox owns options and nothing else. The marquee reads
                this attribute so a drag started on a header does not clear the
                selection. */}
            <div
              data-git-group-header="true"
              // The band is three real controls, so it is where a keyboard
              // actually lands between two runs of rows — and ⌘D there means
              // "show me this whole changelist", not "show me the row the
              // cursor happens to be on twenty rows below".
              onFocus={() => onGroupHeaderFocus?.(group.id)}
              onBlur={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                onGroupHeaderFocus?.(null)
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                const rect = event.currentTarget.getBoundingClientRect()
                setGroupMenu({ x: event.clientX || rect.left, y: event.clientY || rect.bottom, group })
              }}
            >
              <GroupHeader
                title={group.title}
                count={group.totalCount === 1 ? '1 file' : `${group.totalCount} files`}
                expanded={expanded}
                onExpandedChange={(next) => onExpandedChange(group.id, next)}
                controls={regionId}
                checked={group.checked ?? undefined}
                // Handed over even while a command is in flight: the panel's
                // `runAction` already refuses a second one, and withholding the
                // handler here would make the box a dead area that the row
                // underneath answers for.
                onCheckedChange={group.checked === null ? undefined : (next) => onToggleGroup(group, next)}
                checkLabel={`Stage every file in ${group.title}`}
                // The chip states a fact that was true before the person
                // arrived — this is the list the next change lands in — which is
                // exactly what `micro-chip` is for, and why it takes no tone.
                //
                // And it is the ONLY chip a band wears. An agent's list draws
                // its agent's name and its count like every other list: no
                // liveness dot, no status glyph (owner's ruling, 2026-09-09).
                // A header that reported whether a process was alive would be a
                // second, quieter agent list competing with the sidebar's.
                chip={group.active ? <MicroChip>active</MicroChip> : undefined}
                // The band's menu, reachable without a right-click. One control,
                // revealed on hover AND focus, which is the slot's whole rule.
                action={
                  <GroupHeaderAction
                    ariaLabel={`Actions for ${group.title}`}
                    // It opens the band's menu, so it says so — and says
                    // whether that menu is showing, which is the half a person
                    // driving this by ear actually needs.
                    menu
                    expanded={groupMenu?.group.id === group.id}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect()
                      setGroupMenu({ x: rect.left, y: rect.bottom, group })
                    }}
                  >
                    <KebabGlyph />
                  </GroupHeaderAction>
                }
              />
            </div>
            {/* Hidden, never unmounted: `aria-controls` above has to resolve.
                The REGION is what folds; the listbox inside it is what the rows
                belong to, so the cap notice below can sit in the fold without
                being a non-option child of a listbox. */}
            <div id={regionId} hidden={!expanded}>
              <div role="listbox" aria-multiselectable="true" aria-label={group.title}>
                {group.rows.map((row) => {
                  const isSelected = selectedRowKeys.has(row.key)
                  return (
                    <GitChangeRowItem
                      key={row.key}
                      listId={listId}
                      row={row}
                      groupTitle={group.title}
                      selected={isSelected && listFocused}
                      resting={isSelected && !listFocused}
                      cursor={cursorRowKey === row.key}
                      actions={rowActions}
                    />
                  )
                })}
              </div>
              {group.omittedCount > 0 ? (
                <div className="mx-2 mt-1 rounded-sm border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-2 py-1.5 text-micro text-[color:var(--text-subtle)]">
                  {group.omittedCount} more changes are hidden to keep the panel responsive. The group’s checkbox still
                  stages or unstages every one of them.
                </div>
              ) : null}
            </div>
          </div>
        )
      })}
      {rowMenu ? (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          ariaLabel={
            // A guest row and its home row are the same file with two menus, so
            // the menu says which of the two it belongs to.
            rowMenu.row.partial
              ? `Actions for ${rowMenu.groupTitle}’s changes to ${rowMenu.row.relativePath}`
              : `Actions for ${rowMenu.row.relativePath}`
          }
          onClose={() => setRowMenu(null)}
          surfaceClassName="min-w-[260px]"
        >
          {renderMenuEntries(buildMenu(rowMenu.row), () => setRowMenu(null))}
        </ContextMenu>
      ) : null}
      {groupMenu ? (
        <ContextMenu
          x={groupMenu.x}
          y={groupMenu.y}
          ariaLabel={`Actions for ${groupMenu.group.title}`}
          onClose={() => setGroupMenu(null)}
          surfaceClassName="min-w-[260px]"
        >
          {renderMenuEntries(buildGroupMenu(groupMenu.group), () => setGroupMenu(null))}
        </ContextMenu>
      ) : null}
    </div>
  )
})
