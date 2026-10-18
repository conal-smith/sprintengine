import React, { useCallback, useMemo, useRef, useState, type JSX } from 'react'

import { useGitStatus } from '../../hooks/useGitStatus'
import { isPathOrChild } from '../../utils/paths'
import { changedFileEntries, splitTreePath, type FileTreeEntry } from '../../utils/fileTreeEntries'
import { FileTreeFolderIcon, FileTreePinnedRow } from '../ui/FileTree'
import { CollapseAllGlyph, FilterMenu, IconButton, OverflowMenu, Spinner, Tooltip } from '../ui'
import { ContextMenu, MenuItem } from '../ui/ContextMenu'
import { revealLabel } from '../../utils/revealLabel'
import { hostPlatform } from '../../clientCapabilities'
import {
  FILE_TREE_FOLLOW_DELAY_MS,
  FileExplorerTree,
  type FileExplorerTreeHandle,
  type FileExplorerTreeSource,
} from '../panels/FileExplorer'

// The editor window's file tree: where the open file lives, shown beside it.
//
// It is the workspace's Files tree (panels/FileExplorer.tsx), not a second one:
// the same rows, the same right-click menu, the same agent trail. What this
// host adds is the band (the root's name, the All / Changed filter and
// collapse-all), the pinned row for a file outside the root, and the follow:
// switching tabs opens just the folders between the root and the file (the
// shared model reads only the ones not listed yet), selects the row and
// scrolls it to the nearest edge.
//
// What it does NOT do is write the workspace. It runs in an auxiliary window,
// whose store is a snapshot from when the window opened, so its open folders
// are its own (`persistence="local"`), and the menu's items that would write
// the workspace — marking a folder, carrying the workspace's tabs through a
// rename — are the workspace window's alone (`workspaceWindow={false}`). A
// rename still carries THIS window's tabs along (`onPathMoved`).

/** How long a tab switch settles before the tree follows it. */
export const EDITOR_TREE_FOLLOW_DELAY_MS = FILE_TREE_FOLLOW_DELAY_MS

export type EditorTreeFilter = 'all' | 'changed'

type Props = {
  /** The folder the tree shows. Null while it is being worked out. */
  rootPath: string | null
  /** The workspace the open file came from: whose agents mark the tree. Empty or null when unknown. */
  workspaceId?: string | null
  /** The file the window is showing. */
  activePath: string | null
  onOpenFile: (path: string, name: string) => void
  /** Escape: give the keyboard back to the editor. */
  onReturnFocus: () => void
  /** A rename or move from the tree's menu: the window's tabs follow it. */
  onPathMoved?: (fromPath: string, toPath: string) => void
  /** The pinned row's caption: the workspace's, or the folder's when the window worked the root out itself. */
  outsideLabel?: string
}

const FILTER_ITEMS = [
  { value: 'all', label: 'All files' },
  { value: 'changed', label: 'Changed files' },
] as const

const FILESYSTEM: FileExplorerTreeSource = { kind: 'filesystem' }

export function EditorFileTree({
  rootPath,
  workspaceId = null,
  activePath,
  onOpenFile,
  onReturnFocus,
  onPathMoved,
  outsideLabel = 'Outside this workspace',
}: Props): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<FileExplorerTreeHandle>(null)
  const { status: gitStatus, directoryStatus, refresh: refreshGitStatus } = useGitStatus(rootPath)
  const [filter, setFilter] = useState<EditorTreeFilter>('all')
  const [pinnedMenu, setPinnedMenu] = useState<{ x: number; y: number } | null>(null)

  // "Changed files" is this tree with a filter applied: the files git reports,
  // the folders between them synthesised. Read off the status already held, so
  // narrowing to them never costs a scan.
  const changedEntries = useMemo(
    () => (rootPath && filter === 'changed' ? changedFileEntries(rootPath, gitStatus) : null),
    [filter, gitStatus, rootPath],
  )
  const source = useMemo<FileExplorerTreeSource>(
    () => (changedEntries ? { kind: 'paths', entries: changedEntries, emptyTitle: 'No changed files' } : FILESYSTEM),
    [changedEntries],
  )

  // A click opens the file here, as a tab. A deleted file has nothing on disk
  // to open; its row stays selectable for the menu's "View Git diff".
  const activateFile = useCallback(
    (entry: FileTreeEntry) => {
      if (!entry.gitDeleted) onOpenFile(entry.path, entry.name)
    },
    [onOpenFile],
  )

  const outsideRoot = Boolean(activePath && rootPath && !isPathOrChild(activePath, rootPath))
  const rootName = rootPath ? (rootPath.split(/[/\\]/).filter(Boolean).pop() ?? rootPath) : ''
  const outside = outsideRoot && activePath ? splitTreePath(activePath) : null
  const pinnedItems = activePath
    ? [
        {
          id: 'reveal',
          label: revealLabel(hostPlatform()),
          onSelect: () => void window.api.showItemInFolder(activePath),
        },
        { id: 'copy-path', label: 'Copy path', onSelect: () => void window.api.clipboardWriteText(activePath) },
      ]
    : []

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* One chrome band: the root it shows, and the two ways to narrow it. */}
      <div className="flex h-[36px] shrink-0 items-center gap-1 border-b border-[color:var(--border-default)] pl-2 pr-1.5">
        <Tooltip content={rootPath ?? ''} placement="bottom" wrapperClassName="flex min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2 text-meta">
            <FileTreeFolderIcon />
            <span className="truncate font-medium text-[color:var(--text-strong)]">{rootName || 'Files'}</span>
          </span>
        </Tooltip>
        <FilterMenu
          ariaLabel="Show files"
          groups={[
            {
              label: 'Show',
              items: FILTER_ITEMS,
              value: filter,
              defaultValue: 'all',
              onChange: (value) => setFilter(value === 'changed' ? 'changed' : 'all'),
            },
          ]}
        />
        <Tooltip content="Collapse all" placement="bottom">
          <IconButton
            size="xs"
            aria-label="Collapse all folders"
            onClick={() => treeRef.current?.collapseAll()}
            disabled={!rootPath}
          >
            <CollapseAllGlyph />
          </IconButton>
        </Tooltip>
      </div>
      {/* Outside the scrolling tree, between the band and it: the rows scroll
          beneath nothing, and the open file's own row never scrolls away. */}
      {outside ? (
        <div className="shrink-0 px-1 pb-1">
          <FileTreePinnedRow
            label={outsideLabel}
            directory={outside.directory}
            fileName={outside.name}
            title={activePath ?? undefined}
            onContextMenu={(event) => {
              event.preventDefault()
              setPinnedMenu({ x: event.clientX, y: event.clientY })
            }}
            trailing={<OverflowMenu ariaLabel={`Actions for ${outside.name}`} items={pinnedItems} />}
          />
        </div>
      ) : null}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {rootPath ? (
          <FileExplorerTree
            ref={treeRef}
            scrollParentRef={scrollRef}
            workspaceId={workspaceId || null}
            rootPath={rootPath}
            source={source}
            persistence="local"
            workspaceWindow={false}
            variant="banded"
            ariaLabel={rootName ? `Files in ${rootName}` : 'Files'}
            followPath={activePath}
            gitStatus={gitStatus}
            directoryStatus={directoryStatus}
            refreshGitStatus={refreshGitStatus}
            onOpenFile={onOpenFile}
            onActivateFile={activateFile}
            onEscape={onReturnFocus}
            onPathMoved={onPathMoved}
          />
        ) : (
          <div className="flex items-center gap-2 px-3 py-2 text-micro text-[color:var(--text-muted)]">
            <Spinner size={12} />
            <span role="status">Finding the folder…</span>
          </div>
        )}
      </div>
      {pinnedMenu && outside ? (
        <ContextMenu
          x={pinnedMenu.x}
          y={pinnedMenu.y}
          ariaLabel={`Actions for ${outside.name}`}
          onClose={() => setPinnedMenu(null)}
        >
          {pinnedItems.map((item) => (
            <MenuItem
              key={item.id}
              onClick={() => {
                setPinnedMenu(null)
                item.onSelect()
              }}
            >
              {item.label}
            </MenuItem>
          ))}
        </ContextMenu>
      ) : null}
    </div>
  )
}
