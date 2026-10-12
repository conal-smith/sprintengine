// The Commit window's glyph band, under the panel's view strip (epic
// `git-commit-window`, T5; mockup 2522 panel 1).
//
// Nine controls are grouped by what they act on: six that act on the files
// — refresh, discard, move to changelist, stash, write the message, show the
// diff — then the kit's one vertical divider, then three that act on the VIEW:
// group by, expand all, collapse all. The divider is the only thing in a band
// of identical 26px squares that can say which three are which.
//
// Glyph-only, and every word rides the tooltip and the accessible name: the
// band has to fit nine controls in a 340px pane, and a labelled button ramp
// would fit four.
//
// T5 shipped two of the nine disabled, with tooltips saying they arrive with
// changelists. T6 is that arrival: "move to another changelist" now opens the
// list of lists, and "group by" opens Changelist / Directory / None as a radio
// group. "Write commit message" drafts a message for the checked files with
// the person's own agent CLI (`commitMessageDraft.ts`); while it writes, the
// same square shows the working spinner and stops the draft when pressed, so
// the way out is where the person's pointer already is.
//
// When it cannot draft — nothing checked, text generation off, no supported
// CLI — it is `ariaDisabled`, not `disabled`. In a glyph-only band the tooltip
// IS the explanation, and a `disabled` button receives no pointer events — so
// the one sentence saying why the square does nothing could never be read.
// Soft-disabled it stays walkable, focusable and hoverable, and the reason
// rides its accessible name as well as the tooltip.

import React, { type JSX } from 'react'

import {
  CollapseAllGlyph,
  ContextMenu,
  ExpandAllGlyph,
  GroupByGlyph,
  MenuDivider,
  MenuItem,
  MoveToChangelistGlyph,
  NewChangelistGlyph,
  RefreshIcon,
  RollbackGlyph,
  ShowDiffGlyph,
  Spinner,
  StashGlyph,
  Toolbar,
  ToolbarButton,
  ToolbarDivider,
  Tooltip,
  WriteCommitMessageGlyph,
} from '../../ui'
import { orderedChangelists, type Changelist } from '../../../../../shared/git/changelists'
import { menuIconSlot, UNTRACKED_MOVE_REASON } from './changeRowMenu'
import type { GitChangesGrouping } from './gitChangesModel'

const GROUPING_LABELS: Record<GitChangesGrouping, string> = {
  changelist: 'Changelist',
  directory: 'Directory',
  none: 'None',
}

/** Where a "show diff" request should land. `default` honours the sticky
 *  preference T3 introduced; the other two are the explicit overrides the menu
 *  corner exists for. */
export type ShowDiffPlacement = 'default' | 'app' | 'window'

export type GitChangesToolbarProps = {
  busy: boolean
  /** No file is picked: discard, show-diff and move-to-changelist have nothing
   *  to act on. */
  hasTarget: boolean
  changelists: Changelist[]
  /** The list the picked files are already in, so the menu can grey it out
   *  instead of offering a move to where they already are. */
  currentChangelistId: string | null
  /** Every picked file is untracked, so a move would file paths that are drawn
   *  in the untracked group whatever list holds them — a no-op the panel used
   *  to report as a success. */
  untrackedOnly: boolean
  grouping: GitChangesGrouping
  /** "Write commit message": a draft in flight, or why it cannot draft (null when it can). */
  commitMessageDraft: { drafting: boolean; unavailableReason: string | null }
  onWriteCommitMessage: () => void
  onStopCommitMessage: () => void
  onRefresh: () => void
  onDiscard: () => void
  onStash: () => void
  onShowDiff: (placement: ShowDiffPlacement) => void
  onMoveToChangelist: (changelistId: string) => void
  onMoveToNewChangelist: () => void
  onGroupingChange: (grouping: GitChangesGrouping) => void
  onExpandAll: () => void
  onCollapseAll: () => void
}

export function GitChangesToolbar({
  busy,
  hasTarget,
  changelists,
  currentChangelistId,
  untrackedOnly,
  grouping,
  commitMessageDraft,
  onWriteCommitMessage,
  onStopCommitMessage,
  onRefresh,
  onDiscard,
  onStash,
  onShowDiff,
  onMoveToChangelist,
  onMoveToNewChangelist,
  onGroupingChange,
  onExpandAll,
  onCollapseAll,
}: GitChangesToolbarProps): JSX.Element {
  const [diffMenu, setDiffMenu] = React.useState<{ x: number; y: number } | null>(null)
  const [moveMenu, setMoveMenu] = React.useState<{ x: number; y: number } | null>(null)
  const [groupMenu, setGroupMenu] = React.useState<{ x: number; y: number } | null>(null)
  const lists = orderedChangelists(changelists)

  return (
    // Borderless: the view strip above already draws a hairline, and two rules
    // 30px apart is a ladder rather than a structure.
    <Toolbar ariaLabel="Changed files" borderless className="shrink-0">
      <Tooltip content="Refresh the working tree" placement="bottom">
        <ToolbarButton ariaLabel="Refresh the working tree" disabled={busy} onClick={onRefresh}>
          <RefreshIcon />
        </ToolbarButton>
      </Tooltip>
      <Tooltip content="Discard changes in the selected files" placement="bottom">
        <ToolbarButton
          ariaLabel="Discard changes in the selected files"
          disabled={busy || !hasTarget}
          onClick={onDiscard}
        >
          <RollbackGlyph />
        </ToolbarButton>
      </Tooltip>
      {/* Live since T6. It opens a menu rather than acting, because "move" has
          no single destination — the destination IS the question. */}
      <Tooltip
        content={untrackedOnly ? `Move to another changelist — ${UNTRACKED_MOVE_REASON}` : 'Move to another changelist'}
        placement="bottom"
      >
        <ToolbarButton
          ariaLabel="Move to another changelist"
          menu
          expanded={Boolean(moveMenu)}
          disabled={busy || !hasTarget}
          // Soft, so the tooltip above can actually open and say why: an
          // untracked file is drawn in the untracked group whatever list it is
          // filed in, so the move is a no-op the person cannot see.
          ariaDisabled={untrackedOnly}
          disabledReason={UNTRACKED_MOVE_REASON}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setMoveMenu({ x: rect.left, y: rect.bottom })
          }}
        >
          <MoveToChangelistGlyph />
        </ToolbarButton>
      </Tooltip>
      {/* The whole repository, not the selection — the band's other five items
          act on the picked files, so this one says "all" out loud. */}
      <Tooltip content="Stash all changes…" placement="bottom">
        <ToolbarButton ariaLabel="Stash all changes" disabled={busy} onClick={onStash}>
          <StashGlyph />
        </ToolbarButton>
      </Tooltip>
      {/* SOFT-disabled when it cannot draft, and that is the whole point: this
          tooltip is the only place the person is told why the button does
          nothing, and a `disabled` button receives no pointer events, so the
          tooltip never opened. It stays in the band's walk, takes focus, and
          carries the reason in its accessible name for a reader who never sees
          a tooltip at all. Hard-disabled only while another git action runs,
          like its neighbours — but never mid-draft, when it is the stop. */}
      {commitMessageDraft.drafting ? (
        <Tooltip content="Writing a commit message… Press to stop" placement="bottom">
          <ToolbarButton ariaLabel="Stop writing the commit message" onClick={onStopCommitMessage}>
            {/* The default size is the band glyphs' own `icon-sm`, so the square does not jump. */}
            <Spinner />
          </ToolbarButton>
        </Tooltip>
      ) : (
        <Tooltip
          content={
            commitMessageDraft.unavailableReason
              ? `Write commit message — ${commitMessageDraft.unavailableReason}`
              : 'Write commit message from the checked files'
          }
          placement="bottom"
        >
          <ToolbarButton
            ariaLabel="Write commit message"
            disabled={busy}
            ariaDisabled={Boolean(commitMessageDraft.unavailableReason)}
            disabledReason={commitMessageDraft.unavailableReason ?? undefined}
            onClick={onWriteCommitMessage}
          >
            <WriteCommitMessageGlyph />
          </ToolbarButton>
        </Tooltip>
      )}
      <Tooltip content="Show diff" placement="bottom">
        <ToolbarButton
          ariaLabel="Show diff"
          menu
          expanded={Boolean(diffMenu)}
          disabled={!hasTarget}
          onClick={(event) => {
            // The corner mark says this opens a menu, so it opens a menu — the
            // plain "Show diff" is its first item rather than a click that does
            // one thing and a corner that does three.
            const rect = event.currentTarget.getBoundingClientRect()
            setDiffMenu({ x: rect.left, y: rect.bottom })
          }}
        >
          <ShowDiffGlyph />
        </ToolbarButton>
      </Tooltip>
      <ToolbarDivider />
      <Tooltip content={`Group by — ${GROUPING_LABELS[grouping].toLowerCase()}`} placement="bottom">
        <ToolbarButton
          ariaLabel={`Group by ${GROUPING_LABELS[grouping].toLowerCase()}`}
          menu
          expanded={Boolean(groupMenu)}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setGroupMenu({ x: rect.left, y: rect.bottom })
          }}
        >
          <GroupByGlyph />
        </ToolbarButton>
      </Tooltip>
      <Tooltip content="Expand all groups" placement="bottom">
        <ToolbarButton ariaLabel="Expand all groups" onClick={onExpandAll}>
          <ExpandAllGlyph />
        </ToolbarButton>
      </Tooltip>
      <Tooltip content="Collapse all groups" placement="bottom">
        <ToolbarButton ariaLabel="Collapse all groups" onClick={onCollapseAll}>
          <CollapseAllGlyph />
        </ToolbarButton>
      </Tooltip>
      {moveMenu ? (
        <ContextMenu
          x={moveMenu.x}
          y={moveMenu.y}
          ariaLabel="Move to another changelist"
          onClose={() => setMoveMenu(null)}
          surfaceClassName="min-w-[220px]"
        >
          {lists.map((list) => (
            <MenuItem
              key={list.id}
              icon={menuIconSlot()}
              disabled={busy || list.id === currentChangelistId}
              onClick={() => {
                setMoveMenu(null)
                onMoveToChangelist(list.id)
              }}
            >
              {list.active ? `${list.name} (active)` : list.name}
            </MenuItem>
          ))}
          <MenuDivider />
          <MenuItem
            icon={<NewChangelistGlyph className="icon-xs" />}
            disabled={busy}
            onClick={() => {
              setMoveMenu(null)
              onMoveToNewChangelist()
            }}
          >
            New changelist…
          </MenuItem>
        </ContextMenu>
      ) : null}
      {groupMenu ? (
        <ContextMenu
          x={groupMenu.x}
          y={groupMenu.y}
          ariaLabel="Group by"
          onClose={() => setGroupMenu(null)}
          surfaceClassName="min-w-[180px]"
        >
          {/* A value being chosen, not three actions — so the rows are radios
              and the current one is checked, rather than a menu that leaves the
              reader to remember which arrangement they are looking at. */}
          {(['changelist', 'directory', 'none'] as const).map((option) => (
            <MenuItem
              key={option}
              icon={menuIconSlot()}
              checked={grouping === option}
              selection="one-of"
              onClick={() => {
                setGroupMenu(null)
                onGroupingChange(option)
              }}
            >
              {GROUPING_LABELS[option]}
            </MenuItem>
          ))}
        </ContextMenu>
      ) : null}
      {diffMenu ? (
        <ContextMenu
          x={diffMenu.x}
          y={diffMenu.y}
          ariaLabel="Show diff"
          onClose={() => setDiffMenu(null)}
          surfaceClassName="min-w-[200px]"
        >
          <MenuItem
            onClick={() => {
              setDiffMenu(null)
              onShowDiff('default')
            }}
          >
            Show diff
          </MenuItem>
          <MenuItem
            onClick={() => {
              setDiffMenu(null)
              onShowDiff('app')
            }}
          >
            Show diff in the app
          </MenuItem>
          <MenuItem
            onClick={() => {
              setDiffMenu(null)
              onShowDiff('window')
            }}
          >
            Show diff in a window
          </MenuItem>
        </ContextMenu>
      ) : null}
    </Toolbar>
  )
}
