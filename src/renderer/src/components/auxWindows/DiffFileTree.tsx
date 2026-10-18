import React, { useCallback, useMemo, useRef, useState, type JSX } from 'react'

import { getGitStatusAppearance } from '../../utils/gitStatusAppearance'
import { formatDiffCount } from '../../utils/diffCount'
import { normalizePathKey } from '../../hooks/useGitStatus'
import { splitTreePath, type FileTreeEntry } from '../../utils/fileTreeEntries'
import { CollapseAllGlyph, IconButton, Tooltip } from '../ui'
import {
  FileExplorerTree,
  type FileExplorerRowDecoration,
  type FileExplorerTreeHandle,
  type FileExplorerTreeSource,
} from '../panels/FileExplorer'
import { startColumnResizeDrag } from '../workspace/columnResizeDrag'
import {
  EDITOR_TREE_DEFAULT_WIDTH,
  EDITOR_TREE_MAX_WIDTH,
  EDITOR_TREE_MIN_WIDTH,
  clampEditorTreeWidth,
  type EditorTreePrefs,
} from './editorTreePrefs'
import type { DiffFileItem } from './diffFileList'
import type { BranchDiffItem } from './branchSteps'

// The diff viewer's file list, as a tree: the workspace's Files tree
// (panels/FileExplorer.tsx) with a filter applied — the files this diff holds,
// after an agent's narrowing or a tour has had its say — rather than a list of
// its own. So a row reads as it does in the Files tab, wears the same agent
// mark, and right-clicks into the same menu.
//
// ONE ROW PER PATH. A partly staged file is two of the viewer's items (its
// staged diff and its unstaged one), and the stepper still walks both; the
// tree shows the file once, because it is one file. A click lands on the item
// already on screen when it is that file, and on the first of its items
// otherwise; ⌘↓ from there reaches the other. The row says it holds both.

/** One entry per path, in the viewer's order. A deleted file is listed from the diff, not from disk. */
export function diffTreeEntries(items: readonly DiffFileItem[]): FileTreeEntry[] {
  const seen = new Set<string>()
  const entries: FileTreeEntry[] = []
  for (const item of items) {
    const key = normalizePathKey(item.path)
    if (seen.has(key)) continue
    seen.add(key)
    const { directory, name } = splitTreePath(item.path)
    entries.push({
      name,
      isDir: false,
      path: item.path,
      parentPath: directory,
      // Nothing on disk to open, rename or move: the menu's own rule for a
      // deleted file is what keeps those items off it.
      ...(item.status === 'deleted' ? { gitDeleted: true } : {}),
    })
  }
  return entries
}

/** The item a click on `path` lands on: the one on screen when it is that file, else the file's first. */
export function diffTreeIndexForPath(items: readonly DiffFileItem[], path: string, currentIndex: number): number {
  const key = normalizePathKey(path)
  if (items[currentIndex] && normalizePathKey(items[currentIndex].path) === key) return currentIndex
  return items.findIndex((item) => normalizePathKey(item.path) === key)
}

type PathSummary = {
  status: DiffFileItem['status']
  kinds: Set<DiffFileItem['kind']>
  additions: number
  deletions: number
}

function summarise(items: readonly DiffFileItem[]): Map<string, PathSummary> {
  const byPath = new Map<string, PathSummary>()
  for (const item of items) {
    const key = normalizePathKey(item.path)
    const summary = byPath.get(key) ?? { status: item.status, kinds: new Set(), additions: 0, deletions: 0 }
    summary.kinds.add(item.kind)
    if (item.kind === 'branch') {
      summary.additions += (item as BranchDiffItem).additions
      summary.deletions += (item as BranchDiffItem).deletions
    }
    byPath.set(key, summary)
  }
  return byPath
}

// The diff's own facts on each row, in place of the working tree's: a commit
// step's file has a status in that commit, not now. Folders carry nothing —
// their working-tree tint would be a claim about a different diff.
const NO_DECORATION: FileExplorerRowDecoration = {}

/** The column's switch: the same mark the editor window's strip draws over its own files column. */
export function FilesColumnGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 3V13" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

type Props = {
  items: readonly DiffFileItem[]
  currentIndex: number
  /** The folder the tree is rooted at: the repository the items were read from. */
  rootPath: string
  workspaceId: string | null
  /** The pane's Diff tab runs in the workspace window; the diff window does not. */
  workspaceWindow: boolean
  gitStatus: GitStatusSnapshot | null
  directoryStatus: Record<string, GitFileStatus>
  refreshGitStatus: () => Promise<void>
  onSelectIndex: (index: number) => void
  /** Open a file in an editor: the menu's Open, and a double click. */
  onOpenFile: (path: string, name: string) => void
  /** Escape: back to the diff. */
  onEscape?: () => void
}

export function DiffFileTree({
  items,
  currentIndex,
  rootPath,
  workspaceId,
  workspaceWindow,
  gitStatus,
  directoryStatus,
  refreshGitStatus,
  onSelectIndex,
  onOpenFile,
  onEscape,
}: Props): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<FileExplorerTreeHandle>(null)
  const entries = useMemo(() => diffTreeEntries(items), [items])
  const source = useMemo<FileExplorerTreeSource>(
    () => ({ kind: 'paths', entries, emptyTitle: 'No changed files' }),
    [entries],
  )
  const summaries = useMemo(() => summarise(items), [items])
  const currentPath = currentIndex >= 0 ? (items[currentIndex]?.path ?? null) : null

  const decorate = useCallback(
    (entry: FileTreeEntry): FileExplorerRowDecoration => {
      if (entry.isDir) return NO_DECORATION
      const summary = summaries.get(normalizePathKey(entry.path))
      if (!summary) return NO_DECORATION
      const appearance = getGitStatusAppearance(summary.status)
      const both = summary.kinds.has('staged') && summary.kinds.has('unstaged')
      return {
        badge: appearance.badge,
        nameClassName: appearance.textClass,
        title: both ? `${entry.name}: staged and unstaged changes` : undefined,
        meta:
          summary.additions + summary.deletions > 0 ? (
            // The diff surface's one channel for counts: --diff-*, as the
            // header strip and the gutter read them.
            <span className="font-mono tabular-nums">
              <span className="text-[color:var(--diff-added)]">+{formatDiffCount(summary.additions)}</span>
              <span className="ml-1 text-[color:var(--diff-removed)]">−{formatDiffCount(summary.deletions)}</span>
            </span>
          ) : undefined,
      }
    },
    [summaries],
  )

  const fileCount = entries.length

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The band names what the tree holds, where the editor window's names
          its root: this tree is the diff's files, not a folder. */}
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-[color:var(--border-subtle)] pl-3 pr-1">
        <span className="min-w-0 flex-1 truncate text-meta font-medium text-[color:var(--text-strong)]">
          {fileCount} changed {fileCount === 1 ? 'file' : 'files'}
        </span>
        <Tooltip content="Collapse all" placement="bottom">
          <IconButton size="xs" aria-label="Collapse all folders" onClick={() => treeRef.current?.collapseAll()}>
            <CollapseAllGlyph />
          </IconButton>
        </Tooltip>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <FileExplorerTree
          ref={treeRef}
          scrollParentRef={scrollRef}
          workspaceId={workspaceId}
          rootPath={rootPath}
          source={source}
          persistence="local"
          workspaceWindow={workspaceWindow}
          variant="banded"
          ariaLabel="Changed files in this diff"
          followPath={currentPath}
          gitStatus={gitStatus}
          directoryStatus={directoryStatus}
          refreshGitStatus={refreshGitStatus}
          rowDecoration={decorate}
          onOpenFile={onOpenFile}
          onActivateFile={(entry) => {
            const index = diffTreeIndexForPath(items, entry.path, currentIndex)
            if (index >= 0) onSelectIndex(index)
          }}
          onEscape={onEscape}
        />
      </div>
    </div>
  )
}

/**
 * The column the tree stands in: left of the diff, resizable by its right
 * edge exactly as the editor window's files column is, never more than half
 * the viewer — the diff is the point.
 */
export function DiffFileTreeColumn({
  prefs,
  onPrefsChange,
  children,
}: {
  prefs: EditorTreePrefs
  onPrefsChange: (next: EditorTreePrefs) => void
  children: React.ReactNode
}): JSX.Element {
  const columnRef = useRef<HTMLElement>(null)
  const dragWidthRef = useRef<number | null>(null)
  const [resizing, setResizing] = useState(false)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const startX = event.clientX
    const startWidth = dragWidthRef.current ?? prefs.width
    dragWidthRef.current = startWidth
    setResizing(true)
    // Left-docked, so dragging the right edge RIGHT widens it.
    startColumnResizeDrag(event, {
      onDrag: (clientX) => {
        const next = clampEditorTreeWidth(startWidth + (clientX - startX))
        dragWidthRef.current = next
        if (columnRef.current) columnRef.current.style.width = `${next}px`
      },
      onDragEnd: () => {
        setResizing(false)
        const finalWidth = dragWidthRef.current
        dragWidthRef.current = null
        if (finalWidth !== null) onPrefsChange({ ...prefs, width: finalWidth })
      },
    })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const STEP = 16
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      event.stopPropagation()
      const delta = event.key === 'ArrowRight' ? STEP : -STEP
      onPrefsChange({ ...prefs, width: clampEditorTreeWidth(prefs.width + delta) })
    } else if (event.key === 'Home') {
      event.preventDefault()
      onPrefsChange({ ...prefs, width: EDITOR_TREE_DEFAULT_WIDTH })
    }
  }

  return (
    <aside
      ref={columnRef}
      aria-label="Changed files"
      className="relative flex max-w-[50%] shrink-0 flex-col border-r border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]"
      style={{ width: clampEditorTreeWidth(dragWidthRef.current ?? prefs.width) }}
    >
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize changed files"
        aria-valuemin={EDITOR_TREE_MIN_WIDTH}
        aria-valuemax={EDITOR_TREE_MAX_WIDTH}
        aria-valuenow={prefs.width}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onDoubleClick={() => onPrefsChange({ ...prefs, width: EDITOR_TREE_DEFAULT_WIDTH })}
        className="group absolute right-0 top-0 z-[var(--z-pane)] h-full w-1.5 translate-x-1/2 cursor-col-resize focus-visible:focus-ring"
      >
        <span
          aria-hidden="true"
          className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[color:var(--accent-primary)] transition-opacity ${
            resizing ? 'opacity-100' : 'opacity-0 group-hover:opacity-60 group-focus-visible:opacity-100'
          }`}
        />
      </div>
    </aside>
  )
}
