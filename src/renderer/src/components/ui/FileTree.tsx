import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type JSX } from 'react'

import { IconButton } from './Buttons'
import { FileTypeGlyph, FolderGlyph } from './FileTypeGlyph'
import { Spinner } from './Spinner'
import { folderRoleInk, type FolderRole } from '../../utils/folderRoles'

// File tree — the rows of a folder tree, at the 24px hit-target floor.
//
// Spec: design-system/components/file-tree/component.md.
//
// One row vocabulary for every tree in the product — and one tree, too
// (panels/FileExplorer.tsx → FileExplorerTree), which the workspace pane's
// Files tab, the editor window's column and the diff viewer's file list all
// render. What a row IS lives here — the indent, the disclosure chevron, the
// 16px glyph slot, the name in its git tint, the status letter, the two
// selection tiers — and what a row DOES stays with the tree that renders it,
// passed through as ordinary DOM props. A second tree that drew
// its own rows would be a second answer to "how far does a child indent" and
// "what does the selected row look like", and those drift.

/** Every row is exactly this tall, which is what lets a long folder be windowed. */
export const FILE_TREE_ROW_HEIGHT = 24

/**
 * Past this many visible rows the list renders only the window in view. A
 * folder can hold thousands of entries (a generated asset folder, a vendored
 * tree), and mounting every one of them is a pause the person feels on expand.
 */
export const FILE_TREE_VIRTUALIZE_AT = 1000

const OVERSCAN_ROWS = 12

// The file mark is the kit's `FileTypeGlyph` (owner 2026-09-05): one shape per
// kind in the 16px leading slot every tree row reserves.
//
// Inked by KIND (owner, 2026-09-06, principles.md → "Identity colour"): the
// tree is the one surface whose rows carry no other colour at rest, so a hue
// per language lets it be scanned by colour before it is read. An IGNORED row
// drops back to `ink` and takes the row's dimmed colour with everything else:
// a full-strength identity hue on a row whose whole point is "you are not
// looking for this" would be the brightest thing in a tree of build output.
export function FileTreeFileIcon({ name, dimmed = false }: { name: string; dimmed?: boolean }): JSX.Element {
  return (
    <span className="inline-flex size-icon-sm shrink-0 items-center justify-center">
      <FileTypeGlyph name={name} tone={dimmed ? 'ink' : 'kind'} />
    </span>
  )
}

// The folder mark is the kit's outlined `FolderGlyph` (owner 2026-09-05), in
// the same 16px slot as the file glyph so every row's name starts at one x. It
// takes its ink from the row rather than a private palette (ruled 2026-09-02);
// the wrapper declares no ink of its own, because a `text-*` here would pin the
// glyph to one tier and the row's three-tier ink would never reach it. The
// chevron carries expanded state, so the folder reads the same open or closed.
//
// A folder carrying a declared ROLE is the one case where the mark leaves the
// row's ink: only the folder the role was declared ON wears it — a whole
// marked subtree in orange would be a category code on every row rather than a
// mark on the one that was chosen.
export function FileTreeFolderIcon({ role }: { role?: FolderRole | null }): JSX.Element {
  const ink = role ? folderRoleInk(role) : null
  const badge =
    role === 'generated' ? 'generated' : role === 'resources' || role === 'test-resources' ? 'resources' : undefined
  return (
    <span className={`inline-flex size-icon-sm shrink-0 items-center justify-center ${ink ?? ''}`}>
      <FolderGlyph badge={badge} />
    </span>
  )
}

export function FileTreeChevron({
  expanded,
  onClick,
}: {
  expanded: boolean
  onClick?: React.MouseEventHandler<HTMLButtonElement>
}): JSX.Element {
  return (
    <IconButton
      size="xs"
      tabIndex={-1}
      onClick={onClick}
      // The kit's `xs` step IS this box — 24x24, `size.hit-target-min` — on a
      // 12x16 flow advance: the negative margins give back the padding, so the
      // chevron draws exactly where it did while the box a pointer has to hit
      // clears the floor. The 16px advance sits level with the 16px folder and
      // file glyphs beside it, so the row's own 24px floor — not this box — is
      // what sets its height; drop the negative margins and the row jumps to
      // 32px. The sibling spacer on file rows is still w-3, so the columns line
      // up.
      className="-mx-1.5 -my-1 shrink-0"
      aria-label={expanded ? 'Collapse folder' : 'Expand folder'}
    >
      <svg
        viewBox="0 0 12 12"
        aria-hidden="true"
        className={`icon-xs transition-transform ${expanded ? 'rotate-90' : ''}`}
        fill="none"
      >
        <path
          d="M4.25 2.5 7.75 6l-3.5 3.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </IconButton>
  )
}

/**
 * An agent at work on a row: on a file, the agent is reading or editing it;
 * on a folder, on a file somewhere under it.
 */
export type FileTreeAgentMark = {
  verb: 'reading' | 'editing'
  /** Marked files under a folder, said on the folder while it is closed. */
  count: number
  /**
   * The agent's mark, on the row it is on right now (and on each closed folder
   * on the way down to it). Absent on a row it has moved on from.
   */
  glyph?: React.ReactNode
}

/** Where the person is on this row: the keyboard's row, one of its companions, or neither. */
export type FileTreeRowSelection = 'cursor' | 'companion' | null

export type FileTreeRowProps = {
  name: string
  isDir: boolean
  /** 0 for a child of the root. */
  depth: number
  /**
   * Indent steps before depth 0: 1 when a root row heads the tree (depth 0
   * sits one step in from it), 0 when the tree has no root row and its first
   * level is the top.
   */
  indentSteps?: 0 | 1
  /** Folders only. */
  expanded?: boolean
  onToggleExpanded?: () => void
  /**
   * Folders only: its listing is slow to arrive, so the spinner stands in the
   * chevron's slot. The tree decides when a listing counts as slow
   * (`useSlowFolderLoads`).
   */
  loading?: boolean
  selection?: FileTreeRowSelection
  /** Drag-and-drop target: the fill and a 1px accent ring. */
  dropTarget?: boolean
  /** Ignored by git: the whole row drops to disabled ink. */
  ignored?: boolean
  /** The git tint for the name (`gitStatusAppearance.textClass`). */
  nameClassName?: string
  /** The one-letter git status, trailing. Display only. */
  badge?: string | null
  /**
   * Trailing text before the badge, for a tree that knows more about a file
   * than its status: the diff's `+N −N`. Display only, and the same micro
   * size as the badge, so it never makes the row taller.
   */
  meta?: React.ReactNode
  /** A whole-row wash class for a role the person declared (`rowWashClass`). */
  washClassName?: string
  /** A folder's declared role, which inks its mark. */
  folderRole?: FolderRole | null
  /** An agent at work here. An open folder ignores it: the rows under it say it. */
  agentMark?: FileTreeAgentMark | null
  /** Replaces the name, for an in-place rename field. */
  nameSlot?: React.ReactNode
  rowRef?: React.Ref<HTMLDivElement>
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>

export function FileTreeRow({
  name,
  isDir,
  depth,
  indentSteps = 1,
  expanded = false,
  onToggleExpanded,
  loading = false,
  selection = null,
  dropTarget = false,
  ignored = false,
  nameClassName = '',
  badge = null,
  meta = null,
  washClassName = '',
  folderRole = null,
  agentMark = null,
  nameSlot,
  rowRef,
  className = '',
  style,
  ...rest
}: FileTreeRowProps): JSX.Element {
  // Three fills, and selection wins over the wash: a wash is a property of the
  // file, selection is a state of the keyboard, and a tinted selected row is
  // the one row the person has picked looking like it has not been. The
  // cursor's 2px inset edge reads `--selection-edge`, which a resting pane
  // rebinds to transparent (`data-selection-pane` on the tree), so exactly one
  // edge is on screen — on the tree the keyboard is driving.
  // The agent's wash takes the wash channel from a declared role while it is
  // there: it is the row's news, and the role is still on the folder's mark.
  const agent = agentMark && !(isDir && expanded) ? agentMark : null
  const wash = agent
    ? agent.verb === 'editing'
      ? 'bg-[color:var(--agent-trail-soft-strong)]'
      : 'bg-[color:var(--agent-trail-soft)]'
    : washClassName
  const tone = dropTarget
    ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)] ring-1 ring-[color:var(--accent-primary)]'
    : selection === 'cursor'
      ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)] ring-2 ring-inset ring-[color:var(--selection-edge)]'
      : selection === 'companion'
        ? 'bg-[color:var(--bg-selected-resting)] text-[color:var(--text-strong)]'
        : `${ignored ? 'text-[color:var(--text-disabled)]' : 'text-[color:var(--text-default)]'} ${wash} hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]`

  return (
    <div
      ref={rowRef}
      role="treeitem"
      aria-selected={selection !== null}
      aria-expanded={isDir ? expanded : undefined}
      aria-busy={isDir && loading ? true : undefined}
      // The root row, when there is one, is level 1 and its children level 2.
      aria-level={depth + 1 + indentSteps}
      // 24px at rest: `size.hit-target-min`. The two pixels come out of the
      // VERTICAL PADDING — the 16px glyph slot is untouched, so the chevron, the
      // folder mark and the file mark still line up with every other rail in the
      // app. Exactly 24px, never taller, is also what a windowed list counts on.
      className={`group flex min-h-[var(--hit-target-min)] cursor-pointer select-none items-center gap-2 rounded-md px-2 py-0.5 text-meta transition-colors ${tone} ${className}`}
      // The indent, said out loud rather than left as arithmetic (principles.md:
      // an indent that aligns to a reserved glyph slot is structure, not rhythm —
      // it keeps its computed value, off the space scale, with a line saying what
      // it lines up with). 8px is the root row's own `px-2` inset, so depth 0
      // starts one step in from it. Each further level adds 14px: the chevron's
      // 12px flow advance — the kit's 24px `xs` button pulled back by `-mx-1.5` —
      // plus 2px, so a child's disclosure column clears its parent's instead of
      // sitting directly under it. A file row's `w-3` spacer is that same 12px,
      // which is what keeps files and folders on one glyph column at every depth.
      style={{ ...style, paddingLeft: `${8 + (depth + indentSteps) * 14}px` }}
      {...rest}
    >
      {isDir ? (
        <>
          {loading ? (
            // The chevron's 12px advance, so the folder mark and the name hold
            // still while the spinner stands in and when the chevron returns.
            <span className="inline-flex w-3 shrink-0 items-center justify-center">
              <Spinner size={12} label="Loading folder" />
            </span>
          ) : (
            <FileTreeChevron
              expanded={expanded}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onToggleExpanded?.()
              }}
            />
          )}
          <FileTreeFolderIcon role={folderRole} />
          {nameSlot ?? <span className={`truncate font-medium ${nameClassName}`}>{name}</span>}
        </>
      ) : (
        <>
          <span className="w-3 shrink-0" />
          <FileTreeFileIcon name={name} dimmed={ignored} />
          {nameSlot ?? <span className={`truncate ${nameClassName}`}>{name}</span>}
        </>
      )}
      {agent ? (
        <span
          data-agent-trail={agent.verb}
          className="ml-auto flex shrink-0 items-center gap-1.5 text-micro leading-4 text-[color:var(--agent-trail-ink)]"
        >
          <span className="sr-only">
            {isDir
              ? `, an agent is ${agent.verb} ${agent.count} ${agent.count === 1 ? 'file' : 'files'} in here`
              : `, an agent is ${agent.verb} this`}
          </span>
          {isDir ? (
            <span aria-hidden="true">{agent.count}</span>
          ) : (
            <span aria-hidden="true" className="rounded-full bg-[color:var(--agent-trail-soft-strong)] px-1.5">
              {agent.verb}
            </span>
          )}
          {/* The agent's own mark, inked as the trail: the character and the
              working mark both draw in the accent, rebound here. */}
          {agent.glyph ? (
            <span aria-hidden="true" className="flex shrink-0 [--accent-primary:var(--agent-trail-ink)]">
              {agent.glyph}
            </span>
          ) : null}
        </span>
      ) : null}
      {meta ? (
        <span className={`${agent ? '' : 'ml-auto '}flex shrink-0 items-center text-micro leading-4`}>{meta}</span>
      ) : null}
      {badge ? (
        <span
          className={`${agent || meta ? '' : 'ml-auto '}shrink-0 font-mono text-micro font-semibold text-current opacity-80`}
        >
          {badge}
        </span>
      ) : null}
    </div>
  )
}

/**
 * The root row: the folder itself heads the tree, name strong and path muted,
 * and its chevron folds the whole tree. Chrome the tree draws for itself, not
 * an entry — nothing selects, renames, moves or deletes it.
 */
export function FileTreeRootRow({
  name,
  path,
  expanded,
  onToggle,
  trailing,
}: {
  name: string
  path: string
  expanded: boolean
  onToggle: () => void
  trailing?: React.ReactNode
}): JSX.Element {
  return (
    <div
      role="treeitem"
      // A row, so a press on it never starts a background rubber-band.
      data-file-explorer-row="true"
      aria-expanded={expanded}
      aria-selected={false}
      aria-level={1}
      aria-label={name}
      onClick={onToggle}
      className="group flex min-h-[var(--hit-target-min)] cursor-pointer select-none items-center gap-2 rounded-md px-2 py-0.5 text-meta text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
    >
      <FileTreeChevron
        expanded={expanded}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onToggle()
        }}
      />
      <FileTreeFolderIcon />
      <span className="shrink-0 font-medium text-[color:var(--text-strong)]">{name}</span>
      <span className="min-w-0 truncate text-micro text-[color:var(--text-muted)]">{path}</span>
      {trailing}
    </div>
  )
}

/** A folder path split so it can truncate in the MIDDLE: the head gives way, the last folder stays. */
function splitDirectoryForDisplay(directory: string): { head: string; tail: string } {
  const trimmed = directory.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (index <= 0) return { head: '', tail: trimmed || directory }
  return { head: trimmed.slice(0, index), tail: trimmed.slice(index) }
}

/**
 * A file that is open but not under the tree's root — an agent's patch in a
 * scratch folder, a config file in the home directory — pinned above the tree
 * for as long as it is the open file. It says what the file is and where it
 * lives, because the tree below cannot: a caption, then one row with the
 * file's glyph and NAME as the primary text and its folder as muted secondary
 * text, truncated in the middle so both the start of the path and the folder
 * nearest the file stay readable. The full path is the row's tooltip.
 *
 * It sits outside the tree (the tree's keyboard never lands on it) and it is
 * the open file, not a keyboard cursor, so it wears the open file's RESTING
 * fill — the same neutral fill a tree row wears while the editor has focus —
 * and never the accent edge.
 */
export function FileTreePinnedRow({
  label,
  directory,
  fileName,
  trailing,
  ...rest
}: {
  label: string
  directory: string
  fileName: string
  trailing?: React.ReactNode
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>): JSX.Element {
  const { head, tail } = splitDirectoryForDisplay(directory)
  return (
    <div role="group" aria-label={`${fileName}, ${label.toLowerCase()}, in ${directory}`}>
      <p aria-hidden="true" className="px-2 pb-0.5 pt-1 text-micro font-medium text-[color:var(--text-muted)]">
        {label}
      </p>
      <div
        className="group flex min-h-[var(--hit-target-min)] cursor-default select-none items-center gap-2 rounded-md bg-[color:var(--bg-selected-resting)] px-2 py-0.5 text-meta text-[color:var(--text-strong)]"
        {...rest}
      >
        <FileTreeFileIcon name={fileName} />
        <span className="max-w-[60%] shrink-0 truncate font-medium">{fileName}</span>
        <span aria-hidden="true" className="flex min-w-0 flex-1 text-micro text-[color:var(--text-muted)]">
          <span className="min-w-0 truncate">{head}</span>
          <span className="shrink-0">{tail}</span>
        </span>
        {trailing}
      </div>
    </div>
  )
}

export type FileTreeRowsHandle = {
  /** Scroll the row at `index` into view, nearest edge — whether or not it is mounted. */
  scrollToIndex: (index: number) => void
}

type FileTreeRowsProps<T> = {
  rows: readonly T[]
  rowKey: (row: T, index: number) => string
  renderRow: (row: T, index: number) => React.ReactNode
  /** The element that scrolls. The list measures its window against it. */
  scrollParent: React.RefObject<HTMLElement | null>
  /** Override the windowing threshold (tests). */
  virtualizeAt?: number
}

function rowWindow(
  count: number,
  scrollTop: number,
  viewport: number,
  listOffset: number,
): { start: number; end: number } {
  const first = Math.floor((scrollTop - listOffset) / FILE_TREE_ROW_HEIGHT)
  const visible = Math.ceil(viewport / FILE_TREE_ROW_HEIGHT)
  const start = Math.max(0, Math.min(count, first - OVERSCAN_ROWS))
  const end = Math.max(start, Math.min(count, first + visible + OVERSCAN_ROWS))
  return { start, end }
}

function listOffsetWithin(list: HTMLElement, parent: HTMLElement): number {
  return list.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop
}

/**
 * The rows, all of them or — past `FILE_TREE_VIRTUALIZE_AT` — only the window
 * in view, with spacers standing in for the rest. Rows are a fixed 24px, so
 * the window is arithmetic, not measurement.
 */
function FileTreeRowsInner<T>(
  { rows, rowKey, renderRow, scrollParent, virtualizeAt = FILE_TREE_VIRTUALIZE_AT }: FileTreeRowsProps<T>,
  ref: React.ForwardedRef<FileTreeRowsHandle>,
): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const virtual = rows.length > virtualizeAt
  const [range, setRange] = useState<{ start: number; end: number }>({ start: 0, end: 0 })

  const measure = useCallback(() => {
    const parent = scrollParent.current
    const list = listRef.current
    if (!parent || !list) return
    const next = rowWindow(rows.length, parent.scrollTop, parent.clientHeight, listOffsetWithin(list, parent))
    setRange((current) => (current.start === next.start && current.end === next.end ? current : next))
  }, [rows.length, scrollParent])

  useEffect(() => {
    if (!virtual) return
    const parent = scrollParent.current
    if (!parent) return
    measure()
    parent.addEventListener('scroll', measure, { passive: true })
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(parent)
    return () => {
      parent.removeEventListener('scroll', measure)
      observer?.disconnect()
    }
  }, [measure, scrollParent, virtual])

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: (index: number) => {
        const parent = scrollParent.current
        const list = listRef.current
        if (!parent || !list || index < 0) return
        const offset = listOffsetWithin(list, parent)
        const top = offset + index * FILE_TREE_ROW_HEIGHT
        const bottom = top + FILE_TREE_ROW_HEIGHT
        // `block: 'nearest'`: move only as far as it takes, and not at all when
        // the row is already in view. Moving down lands on a row boundary, so
        // the top of the view starts on a whole row rather than a sliver of one
        // peeking out under the band above.
        if (top < parent.scrollTop) {
          parent.scrollTop = top
        } else if (bottom > parent.scrollTop + parent.clientHeight) {
          const minimum = bottom - parent.clientHeight
          const rowsAbove = Math.ceil((minimum - offset) / FILE_TREE_ROW_HEIGHT)
          parent.scrollTop = Math.min(top, Math.max(minimum, offset + rowsAbove * FILE_TREE_ROW_HEIGHT))
        }
        if (virtual) measure()
      },
    }),
    [measure, scrollParent, virtual],
  )

  if (!virtual) {
    return (
      <div ref={listRef} role="none" className="flex flex-col">
        {rows.map((row, index) => (
          <React.Fragment key={rowKey(row, index)}>{renderRow(row, index)}</React.Fragment>
        ))}
      </div>
    )
  }

  const start = Math.min(range.start, rows.length)
  const end = Math.max(start, Math.min(range.end || start + 64, rows.length))
  return (
    <div ref={listRef} role="none" className="flex flex-col">
      <div aria-hidden="true" style={{ height: start * FILE_TREE_ROW_HEIGHT }} className="shrink-0" />
      {rows.slice(start, end).map((row, offset) => (
        <React.Fragment key={rowKey(row, start + offset)}>{renderRow(row, start + offset)}</React.Fragment>
      ))}
      <div aria-hidden="true" style={{ height: (rows.length - end) * FILE_TREE_ROW_HEIGHT }} className="shrink-0" />
    </div>
  )
}

export const FileTreeRows = forwardRef(FileTreeRowsInner) as <T>(
  props: FileTreeRowsProps<T> & { ref?: React.Ref<FileTreeRowsHandle> },
) => JSX.Element
