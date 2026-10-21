import React, {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { ACTIVE_RENDERER_MODULE_MANIFESTS, getRendererHost, selectModuleEnabled } from '../../modules'
import {
  groupFileExplorerModuleActions,
  visibleFileExplorerModuleActions,
  type FileExplorerModuleActionEntry,
} from './fileExplorerModuleActions'
import { getGitEntry, normalizePathKey, useGitStatus } from '../../hooks/useGitStatus'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import { useSlowFolderLoads } from '../../hooks/useSlowFolderLoads'
import { getGitStatusAppearance } from '../../utils/gitStatusAppearance'
import {
  FOLDER_ROLE_LABEL,
  FOLDER_ROLE_ORDER,
  resolveFolderRole,
  resolveRowWash,
  rowWashClass,
  type FolderRole,
  type FolderRoleMap,
} from '../../utils/folderRoles'
import { focusOrAddFileTab, remapFileTabsForPath, removeFileTabsForPath } from '../../utils/modelRegistry'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { isImageFile } from '../../utils/files'
import { isPathOrChild } from '../../utils/paths'
import type { FileSearchEngine } from '../../../../shared/ipc/filesystem'
import { openGitDiff } from '../../utils/openGitDiff'
import { openDiffWindow } from '../auxWindows/openDiffWindow'
import { openFileSurface } from '../../utils/openFileSurface'
import { fileExplorerSelectionFromVerticalRange, fileExplorerSelectionRange } from '../../utils/fileExplorerSelection'
import { setFileDropData } from '../../utils/terminalDrop'
import { consumePendingFileReveal, subscribeFileReveal } from '../../utils/fileReveal'
import { ContextMenu, MenuDivider, MenuFlyoutItem, MenuItem } from '../ui/ContextMenu'
import { IconButton, OutlineButton, PrimaryButton } from '../ui/Buttons'
import { isTestPath } from '../ui/FileTypeGlyph'
import { FileTreeRootRow, FileTreeRow, FileTreeRows, type FileTreeRowsHandle } from '../ui/FileTree'
import {
  buildPathTreeRows,
  flattenTree,
  folderPathsSharedWithFiles,
  getEntryGitStatus,
  mergeGitDeletedEntries,
  movedTreePath,
  parentDirectoriesForPath,
  pathSeparatorFor,
  treeRowKey,
  type FileTreeEntry,
  type FileTreeRowModel,
} from '../../utils/fileTreeEntries'
import { useFileTreeModel } from '../../utils/fileTreeModel'
import { EmptyState } from '../ui/EmptyState'
import { InlineNotice } from '../ui/InlineNotice'
import { Spinner } from '../ui/Spinner'
import { InboxSearchInput } from '../ui/InboxSearchInput'
import { Skeleton } from '../ui/Skeleton'
import { Input } from '../ui/Input'
import { Tooltip } from '../ui/Tooltip'
import { AgentGlyph } from '../ui/AgentGlyph'
import { WorkingMark } from '../ui/WorkingMark'
import { useAgentFileTrail } from './useAgentFileTrail'
import { showToast } from '../../store/toastStore'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import { isImeKey } from '../../utils/imeKey'

const EMPTY_EXPANDED_PATHS: string[] = []
const EMPTY_TREE_ROWS: TreeRow[] = []

// The tree's data half — listings, the watch, ignore checks, reveal — is the
// shared per-root model (utils/fileTreeModel.ts), and its rows are the kit's
// FileTree rows (ui/FileTree.tsx). What lives here is the tree itself:
// rename, move, create, delete, drag, multi-select, search, folder roles, the
// agent trail and the one right-click menu.
//
// It is ONE tree with three hosts (owner ruling 2026-10-18): the pane's Files
// tab below, the editor window's column (auxWindows/EditorFileTree.tsx) and
// the diff viewer's file list (auxWindows/DiffFileTree.tsx). The editor's
// "Changed files" and the diff's list are this tree with a filter applied — a
// `paths` source instead of the folder on disk — so a row, its menu and its
// agent mark cannot differ between them. What a host may NOT do differs, and
// is said in props rather than in a second tree: whether the workspace's
// remembered folders are this tree's to write (`persistence`), and whether the
// window it runs in may write the workspace at all (`workspaceWindow`).
type Entry = FileTreeEntry
type TreeRow = FileTreeRowModel

/**
 * Where the rows come from. `filesystem` lists the folder on disk, lazily, as
 * folders open. `paths` shows exactly the given files with the folders between
 * them and the root synthesised from their paths — the changed files, a diff's
 * file list — and reads nothing from disk to do it; its folders start open.
 */
export type FileExplorerTreeSource =
  { kind: 'filesystem' } | { kind: 'paths'; entries: FileTreeEntry[]; emptyTitle?: string }

/**
 * What a host draws on a row in place of the git status the tree reads for
 * itself: the diff's own status and line counts, which describe the diff being
 * read rather than the working tree. `undefined` keeps the tree's own.
 */
export type FileExplorerRowDecoration = {
  badge?: string | null
  nameClassName?: string
  title?: string
  /** Trailing, before the badge: the diff's `+N −N`. */
  meta?: React.ReactNode
}

export type FileExplorerTreeHandle = {
  /** Close every folder and scroll to the top. */
  collapseAll: () => void
  focus: () => void
}

const FILESYSTEM_SOURCE: FileExplorerTreeSource = { kind: 'filesystem' }
const EMPTY_PATH_SET: ReadonlySet<string> = new Set()

/** How long a followed path settles before the tree moves to it. */
export const FILE_TREE_FOLLOW_DELAY_MS = 100

/** Rows below a collapsed folder are hidden; a flat list in tree order makes that one pass. */
function withoutCollapsed(rows: TreeRow[], collapsed: ReadonlySet<string>): TreeRow[] {
  if (collapsed.size === 0) return rows
  const out: TreeRow[] = []
  let hiddenBelowDepth: number | null = null
  for (const row of rows) {
    if (hiddenBelowDepth !== null) {
      if (row.depth > hiddenBelowDepth) continue
      hiddenBelowDepth = null
    }
    out.push(row)
    if (row.entry.isDir && collapsed.has(row.entry.path)) hiddenBelowDepth = row.depth
  }
  return out
}

type ExplorerClipboard = {
  path: string
  isDir: boolean
}

type RenameDraft = {
  entry: Entry
  value: string
}

export type CreateEntryRequest = {
  kind: 'file' | 'dir'
  token: number
}

const SPRINTENGINE_EXPLORER_MOVE_MIME = 'application/x-sprintengine-explorer-move'

type ExplorerMovePayload = {
  version: 1
  workspaceId: string
  rootPath: string
  entries: Entry[]
}

type FileSearchDiagnostics = {
  engine: FileSearchEngine
  elapsedMs: number
  resultCount: number
  truncated: boolean
}

type FileSearchResponse = {
  entries: Entry[]
  diagnostics: FileSearchDiagnostics | null
}

type RefreshTreeCause = 'initial' | 'watch' | 'manual' | 'git-status' | 'reveal'

function RefreshFilesIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="icon-sm" fill="none">
      <path
        d="M13.25 7.25A5.25 5.25 0 0 0 4.05 4.1L2.75 5.5m0 0H6m-3.25 0V2.25M2.75 8.75a5.25 5.25 0 0 0 9.2 3.15l1.3-1.4m0 0H10m3.25 0v3.25"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function RevealActiveFileIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="icon-sm" fill="none">
      <circle cx="8" cy="8" r="4.75" stroke="currentColor" strokeWidth="1.35" />
      <circle cx="8" cy="8" r="1.45" fill="currentColor" />
      <path
        d="M8 1.75v2M8 12.25v2M14.25 8h-2M3.75 8h-2"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  )
}

function NewFileIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="icon-sm" fill="none">
      <path
        d="M4.25 1.75h5.4l2.1 2.1v10.4h-7.5a1.5 1.5 0 0 1-1.5-1.5v-9.5a1.5 1.5 0 0 1 1.5-1.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 1.9v2.25h2.25M5.5 8h4M7.5 6v4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function NewFolderIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="icon-sm" fill="none">
      <path
        d="M1.75 4.7c0-.8.65-1.45 1.45-1.45h3.05l1.2 1.45h5.35c.8 0 1.45.65 1.45 1.45v6.15c0 .8-.65 1.45-1.45 1.45H3.2c-.8 0-1.45-.65-1.45-1.45V4.7Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M6 9h4M8 7v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function topLevelEntries(entries: Entry[]): Entry[] {
  return entries.filter(
    (entry) => !entries.some((candidate) => candidate.path !== entry.path && isPathOrChild(entry.path, candidate.path)),
  )
}

function parseExplorerMovePayload(dataTransfer: DataTransfer): ExplorerMovePayload | null {
  const raw = dataTransfer.getData(SPRINTENGINE_EXPLORER_MOVE_MIME)
  if (!raw) return null

  try {
    const value = JSON.parse(raw) as Partial<ExplorerMovePayload>
    if (value.version !== 1 || typeof value.workspaceId !== 'string' || typeof value.rootPath !== 'string') {
      return null
    }
    if (!Array.isArray(value.entries)) return null

    const entries = value.entries.filter(
      (entry): entry is Entry =>
        Boolean(entry) &&
        typeof entry.name === 'string' &&
        typeof entry.path === 'string' &&
        typeof entry.parentPath === 'string' &&
        typeof entry.isDir === 'boolean' &&
        entry.path.trim().length > 0,
    )
    if (!entries.length) return null

    return {
      version: 1,
      workspaceId: value.workspaceId,
      rootPath: value.rootPath,
      entries,
    }
  } catch {
    return null
  }
}

function hasExplorerMovePayload(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(SPRINTENGINE_EXPLORER_MOVE_MIME)
}

// True for OS-level file drags (Finder, desktop, browser). The browser only adds
// the read-only `Files` type for native drags, so this never matches an in-app
// explorer move, which carries SPRINTENGINE_EXPLORER_MOVE_MIME instead.
function hasNativeFileDrop(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files')
}

// `dataTransfer.files` is only populated on drop, not during dragover. Resolve
// each entry to a real disk path via Electron's getPathForFile bridge.
function collectNativeDropPaths(dataTransfer: DataTransfer): string[] {
  return Array.from(dataTransfer.files)
    .map((file) => {
      const path = window.api.getPathForFile(file) || (file as File & { path?: unknown }).path
      return typeof path === 'string' && path.trim() ? path : null
    })
    .filter((path): path is string => Boolean(path))
}

function isHtmlFile(entry: Entry): boolean {
  return !entry.isDir && !entry.gitDeleted && /\.html?$/i.test(entry.name)
}

function fileActionModuleLabel(moduleId: string): string {
  return ACTIVE_RENDERER_MODULE_MANIFESTS.find((manifest) => manifest.id === moduleId)?.displayName ?? moduleId
}

function remapExpandedPaths(
  expandedPaths: Record<string, boolean>,
  fromPath: string,
  toPath: string,
): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(expandedPaths).map(([key, value]) => [movedTreePath(key, fromPath, toPath), value]),
  )
}

function expandedPathRecordFromList(paths: string[], rootPath: string): Record<string, boolean> {
  const candidatePaths = new Set(paths.filter((path) => isPathOrChild(path, rootPath)))
  return Object.fromEntries(
    Array.from(candidatePaths)
      .filter((path) => parentDirectoriesForPath(rootPath, path).every((parentPath) => candidatePaths.has(parentPath)))
      .map((path) => [path, true]),
  )
}

function expandedPathListFromRecord(expandedPaths: Record<string, boolean>): string[] {
  return Object.entries(expandedPaths)
    .filter(([, expanded]) => expanded)
    .map(([path]) => path)
}

async function searchFiles(
  rootPath: string,
  query: string,
  gitStatus: GitStatusSnapshot | null,
  limit = 200,
): Promise<FileSearchResponse> {
  const lowerQuery = query.toLowerCase().trim()
  if (!lowerQuery) return { entries: [], diagnostics: null }

  const result = await window.api.searchFiles(rootPath, query, { limit })
  if (!result.ok) throw new Error(result.message)

  const matches: Entry[] = result.results.map((entry) => ({ ...entry }))
  const seen = new Set(matches.map((entry) => normalizePathKey(entry.path)))

  Object.values(gitStatus?.files ?? {}).forEach((status) => {
    if (matches.length >= limit) return
    if (status.status !== 'deleted') return
    if (!isPathOrChild(status.path, rootPath)) return

    const name = status.path.split(/[/\\]/).filter(Boolean).pop()
    if (!name) return
    if (!name.toLowerCase().includes(lowerQuery) && !status.path.toLowerCase().includes(lowerQuery)) return

    const key = normalizePathKey(status.path)
    if (seen.has(key)) return
    seen.add(key)

    const separator = pathSeparatorFor(status.path)
    const parentPath = status.path.includes(separator)
      ? status.path.slice(0, status.path.lastIndexOf(separator))
      : rootPath
    matches.push({
      name,
      isDir: false,
      path: status.path,
      parentPath,
      gitDeleted: true,
    })
  })

  return {
    entries: matches,
    diagnostics: {
      engine: result.engine,
      elapsedMs: result.elapsedMs,
      resultCount: result.resultCount,
      truncated: result.truncated,
    },
  }
}

// The tree's right-click menu, as it stood the instant it opened. Every field
// is an availability the native template used to encode as `enabled` or as a
// conditional spread, sampled once so the open menu cannot contradict itself
// mid-interaction.
type ExplorerMenuState = {
  x: number
  y: number
  entry: Entry | null
  contextSelection: Entry[]
  targetDir: string
  canOpenPath: boolean
  canOpenInBrowser: boolean
  canViewGitDiff: boolean
  fileActions: FileExplorerModuleActionEntry[]
  directoryToggle: 'expand' | 'collapse' | null
  // Present only for a single directory: the role declared ON it (not one
  // inherited from an ancestor), so the menu can check the row it is open over
  // and offer "None" only when there is a mark to clear.
  folderRoleTarget: { path: string; role: FolderRole | null } | null
  canUseSinglePathCommands: boolean
  canPaste: boolean
  canDeletePath: boolean
  deleteLabel: string
}

export interface FileExplorerTreeProps {
  /**
   * The workspace the tree belongs to: whose agents mark its rows, whose
   * modules add to its menu, and whose open tabs follow a rename. Null where
   * the opener knew none (a file window opened from outside a workspace).
   */
  workspaceId: string | null
  rootPath: string
  /** Default: the folder on disk. */
  source?: FileExplorerTreeSource
  /**
   * `workspace`: the open folders and the selection are the workspace's
   * remembered Files state, restored on mount and written as they change —
   * the pane's Files tab, and only it. `local`: this tree's own, kept per root
   * for as long as it is mounted, so a second tree on the same workspace never
   * fights the first over which folders are open.
   */
  persistence?: 'workspace' | 'local'
  /**
   * Whether this tree runs in the workspace window, whose store it may write:
   * a rename carries the open tabs along, a folder can be marked, "View Git
   * diff" honours the pane-or-window preference. False in an auxiliary window,
   * whose copy of the store is a snapshot from when it opened — a write from
   * there would put that snapshot back over the workspace window's
   * (auxWindows/auxSettingsWrite.ts). Those items are then left out of the
   * menu, or routed the one way such a window can (`onPathMoved`).
   */
  workspaceWindow?: boolean
  /**
   * `rooted`: the folder itself heads the tree as its first row. `banded`: a
   * band above the tree names the root, and the first level is the top.
   */
  variant?: 'rooted' | 'banded'
  ariaLabel?: string
  query?: string
  refreshToken?: number
  revealPath?: string | null
  revealToken?: number
  /**
   * A path the tree keeps its cursor on as it changes: the editor's open file,
   * the diff's current file. Opens the folders down to it and scrolls it into
   * view, settled for `FILE_TREE_FOLLOW_DELAY_MS` so flicking past several
   * costs one reveal. Absent for the pane's tree, which reveals only when asked.
   */
  followPath?: string | null
  createRequest?: CreateEntryRequest | null
  gitStatus: GitStatusSnapshot | null
  directoryStatus: Record<string, GitFileStatus>
  refreshGitStatus: () => Promise<void>
  /** Open a file in an editor: the menu's Open, and Enter and double-click on the pane's tree. */
  onOpenFile: (path: string, name: string) => void
  /**
   * When given, a plain click or Enter on a file calls this instead of only
   * selecting it — the editor window opens it as a tab, the diff shows its
   * diff — and a click on a folder opens or closes it. Modifier clicks still
   * extend the selection.
   */
  onActivateFile?: (entry: FileTreeEntry) => void
  /** Escape in the tree: give the keyboard back to what the tree sits beside. */
  onEscape?: () => void
  /** A rename or move landed, in a window the tree cannot carry open tabs in. */
  onPathMoved?: (fromPath: string, toPath: string) => void
  onPathRemoved?: (path: string) => void
  rowDecoration?: (entry: FileTreeEntry) => FileExplorerRowDecoration | undefined
  /** The element the tree scrolls in: reveal and the windowed row list measure against it. */
  scrollParentRef: React.RefObject<HTMLDivElement | null>
}

export const FileExplorerTree = forwardRef<FileExplorerTreeHandle, FileExplorerTreeProps>(function FileExplorerTree(
  {
    workspaceId,
    rootPath,
    source = FILESYSTEM_SOURCE,
    persistence = 'workspace',
    workspaceWindow = true,
    variant = 'rooted',
    ariaLabel,
    query = '',
    refreshToken = 0,
    revealPath = null,
    revealToken = 0,
    followPath,
    createRequest = null,
    gitStatus,
    directoryStatus,
    refreshGitStatus,
    onOpenFile,
    onActivateFile,
    onEscape,
    onPathMoved,
    onPathRemoved,
    rowDecoration,
    scrollParentRef,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rowsHandleRef = useRef<FileTreeRowsHandle>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const rowIdPrefix = useId()
  const rowId = (path: string) => `${rowIdPrefix}row-${encodeURIComponent(path)}`
  const openFile = useWorkspaceStore((s) => s.openFile)
  const remapOpenFiles = useWorkspaceStore((s) => s.remapOpenFiles)
  const removeOpenFilesForPath = useWorkspaceStore((s) => s.removeOpenFilesForPath)
  const setFileExplorerExpandedPaths = useWorkspaceStore((s) => s.setFileExplorerExpandedPaths)
  const setFileExplorerSelectedPath = useWorkspaceStore((s) => s.setFileExplorerSelectedPath)
  const setFileExplorerFolderRole = useWorkspaceStore((s) => s.setFileExplorerFolderRole)
  const persistsToWorkspace = persistence === 'workspace' && Boolean(workspaceId)
  // The workspace's open tabs and folder marks are this tree's to write only
  // where the workspace's store is the real one.
  const writesWorkspace = workspaceWindow && Boolean(workspaceId)
  const isPathsSource = source.kind === 'paths'
  const following = followPath !== undefined
  // Subscribed rather than read from a ref: marking a folder has to repaint
  // the tree beneath it on the same tick.
  const folderRoles = useWorkspaceStore((s) =>
    workspaceId
      ? s.workspaces.find((workspace) => workspace.id === workspaceId)?.fileExplorerState?.folderRoles
      : undefined,
  ) as FolderRoleMap | undefined
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  // Where the workspace's agents are working: the rows they are reading and
  // editing, and the closed folders on the way down to them. In every host,
  // because the question "is an agent in this file?" does not change with the
  // window it is asked in.
  const agentTrail = useAgentFileTrail(workspaceId ?? '', rootPath)
  const agentCharacters = useWorkspaceStore((s) => s.appSettings.appearance.agentCharacters)
  const dialog = useConfirmDialog()
  // A local tree's open folders, per root: the editor window's tabs can come
  // from two workspaces, and switching back to one finds its folders as they
  // were left.
  const localExpandedRef = useRef<Record<string, string[]>>({})
  const readPersistedExpandedPaths = useCallback(
    () =>
      persistsToWorkspace
        ? (useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === workspaceId)?.fileExplorerState
            ?.expandedPaths ?? EMPTY_EXPANDED_PATHS)
        : (localExpandedRef.current[rootPath] ?? EMPTY_EXPANDED_PATHS),
    [persistsToWorkspace, rootPath, workspaceId],
  )
  const readPersistedSelectedPath = useCallback(
    () =>
      persistsToWorkspace
        ? (useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === workspaceId)?.fileExplorerState
            ?.selectedPath ?? null)
        : null,
    [persistsToWorkspace, workspaceId],
  )
  const initialExpandedPaths = useMemo(
    () => expandedPathRecordFromList(readPersistedExpandedPaths(), rootPath),
    [readPersistedExpandedPaths, rootPath],
  )

  const { model, snapshot: tree } = useFileTreeModel(rootPath)
  const [expandedPaths, setExpandedPathsState] = useState<Record<string, boolean>>(() => initialExpandedPaths)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set())
  const [clipboard, setClipboard] = useState<ExplorerClipboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<Entry[]>([])
  const [searchDiagnostics, setSearchDiagnostics] = useState<FileSearchDiagnostics | null>(null)
  const [renameDraft, setRenameDraft] = useState<RenameDraft | null>(null)
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null)
  const [rootDropActive, setRootDropActive] = useState(false)
  const [contextMenu, setContextMenu] = useState<ExplorerMenuState | null>(null)
  const { slowPaths: slowFolderPaths, track: trackFolderLoad } = useSlowFolderLoads()
  const searchTimeoutRef = useRef<number | null>(null)
  const searchRequestSeqRef = useRef(0)
  const committingRenameRef = useRef(false)
  const latestExpandedPathsRef = useRef<Record<string, boolean>>(initialExpandedPaths)
  const hasRestoredSelectionRef = useRef(false)
  const latestSearchQueryRef = useRef('')
  const latestGitStatusRef = useRef<GitStatusSnapshot | null>(gitStatus)
  const lastManualRefreshRef = useRef(refreshToken)
  const lastCreateRequestTokenRef = useRef(0)
  const selectionAnchorPathRef = useRef<string | null>(null)
  const activeRowsRef = useRef<TreeRow[]>([])
  const activeMoveDragRef = useRef<ExplorerMovePayload | null>(null)
  const dragSelectionRef = useRef<{ kind: 'background'; startY: number; active: boolean } | null>(null)
  const completedDragSelectionRef = useRef(false)
  // Read by the mount-time restore, which must not re-run when they change.
  const isPathsSourceRef = useRef(isPathsSource)
  isPathsSourceRef.current = isPathsSource
  const followingRef = useRef(following)
  followingRef.current = following

  // Deleted files are merged in at render, from the status this tree already
  // holds, rather than written into the shared listings: they are a fact about
  // the repository, not about the folder on disk.
  const visibleRows = useMemo(
    () =>
      flattenTree(mergeGitDeletedEntries(tree.rootEntries ?? [], rootPath, gitStatus), 0, expandedPaths, (dirPath) => {
        const children = tree.childrenByPath[dirPath]
        return children ? mergeGitDeletedEntries(children, dirPath, gitStatus) : undefined
      }),
    [tree.rootEntries, tree.childrenByPath, expandedPaths, rootPath, gitStatus],
  )

  // The root row (owner 2026-09-05): the folder
  // itself heads the tree, name strong and path muted, and its chevron folds
  // the whole tree. It is chrome the tree draws for itself, not an Entry —
  // nothing selects, renames, moves or deletes it — and a search ignores the
  // fold, since a search that returns nothing on purpose is a lie.
  const rootName = rootPath.split(/[/\\]/).filter(Boolean).pop() ?? rootPath
  const [rootCollapsed, setRootCollapsed] = useState(false)

  // A `paths` source's folders are synthesised and start open, so what this
  // tree remembers about them is the ones the person CLOSED. Nothing about
  // them is persisted: the set of folders moves with every change to the list.
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(EMPTY_PATH_SET)
  const pathEntries = source.kind === 'paths' ? source.entries : null
  const allPathRows = useMemo(
    () => (pathEntries ? buildPathTreeRows(rootPath, pathEntries) : EMPTY_TREE_ROWS),
    [pathEntries, rootPath],
  )
  const pathRows = useMemo(() => withoutCollapsed(allPathRows, collapsedPaths), [allPathRows, collapsedPaths])

  // A paths source has nothing to search: it is already the answer to one.
  const isSearching = !isPathsSource && query.trim().length > 0
  const searchRows = useMemo(() => buildPathTreeRows(rootPath, searchResults), [rootPath, searchResults])
  const activeRows = isSearching ? searchRows : rootCollapsed ? EMPTY_TREE_ROWS : isPathsSource ? pathRows : visibleRows
  // Found files can put a folder and a file at one path (a diff that turns the
  // file `docs` into a folder). The selection, the cursor and each row's key
  // and element go by the row's key, so the two are never one row.
  const sharedFolderPaths = useMemo(() => folderPathsSharedWithFiles(activeRows), [activeRows])
  const rowKeyOf = (entry: Entry): string => treeRowKey(entry, sharedFolderPaths)
  const isExpandedEntry = (entry: Entry): boolean =>
    entry.isDir &&
    (isSearching || (isPathsSource ? !collapsedPaths.has(entry.path) : expandedPaths[entry.path] === true))
  const setPathFolderOpen = (path: string, open: boolean) => {
    setCollapsedPaths((current) => {
      if (current.has(path) !== open) return current
      const next = new Set(current)
      if (open) next.delete(path)
      else next.add(path)
      return next
    })
  }
  const selectedEntries = useMemo(
    () =>
      activeRows.filter((row) => selectedPaths.has(treeRowKey(row.entry, sharedFolderPaths))).map((row) => row.entry),
    [activeRows, selectedPaths, sharedFolderPaths],
  )
  const searchDiagnosticsTitle =
    import.meta.env.DEV && searchDiagnostics
      ? `Search used ${searchDiagnostics.engine} in ${searchDiagnostics.elapsedMs} ms (${searchDiagnostics.resultCount}${searchDiagnostics.truncated ? '+' : ''} results)`
      : undefined

  useEffect(() => {
    latestSearchQueryRef.current = query
  }, [query])

  useEffect(() => {
    latestGitStatusRef.current = gitStatus
  }, [gitStatus])

  useEffect(() => {
    activeRowsRef.current = activeRows
  }, [activeRows])

  useEffect(() => {
    const updateBackgroundDragSelection = (clientY: number) => {
      const dragSelection = dragSelectionRef.current
      if (!dragSelection || dragSelection.kind !== 'background') return

      const rows = activeRowsRef.current
      const shared = folderPathsSharedWithFiles(rows)
      const rangePaths = fileExplorerSelectionFromVerticalRange(
        rows
          .map((row) => {
            const key = treeRowKey(row.entry, shared)
            const node = rowRefs.current[key]
            if (!node) return null
            const rect = node.getBoundingClientRect()
            return { path: key, top: rect.top, bottom: rect.bottom }
          })
          .filter((row): row is { path: string; top: number; bottom: number } => Boolean(row)),
        dragSelection.startY,
        clientY,
      )

      completedDragSelectionRef.current = rangePaths.length > 0
      setSelectedPath(rangePaths.at(-1) ?? null)
      setSelectedPaths(new Set(rangePaths))
    }

    const handleMouseMove = (event: MouseEvent) => {
      updateBackgroundDragSelection(event.clientY)
    }

    const handleMouseUp = () => {
      if (dragSelectionRef.current) {
        dragSelectionRef.current = null
        window.setTimeout(() => {
          completedDragSelectionRef.current = false
        }, 0)
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  const renamingPath = renameDraft?.entry.path ?? null

  const commitExpandedPaths = useCallback(
    (next: Record<string, boolean>) => {
      latestExpandedPathsRef.current = next
      setExpandedPathsState(next)
      if (persistsToWorkspace && workspaceId) {
        setFileExplorerExpandedPaths(workspaceId, expandedPathListFromRecord(next))
      } else {
        localExpandedRef.current[rootPath] = expandedPathListFromRecord(next)
      }
    },
    [persistsToWorkspace, rootPath, setFileExplorerExpandedPaths, workspaceId],
  )

  const setExpandedPaths = useCallback(
    (update: Record<string, boolean> | ((current: Record<string, boolean>) => Record<string, boolean>)) => {
      const current = latestExpandedPathsRef.current
      commitExpandedPaths(typeof update === 'function' ? update(current) : update)
    },
    [commitExpandedPaths],
  )

  const showError = useCallback((error: unknown, fallback?: string) => {
    // Through the app's one toast region (design-system/components/toast):
    // this panel used to render and position its own Toast in-flow, which was
    // fine while no corner region existed — now one does, and two placements
    // announcing at once is exactly what the spec's one-region rule forbids.
    showToast({
      tone: 'error',
      title: 'File action failed',
      description: error instanceof Error ? error.message : (fallback ?? String(error)),
    })
  }, [])

  const applySearchResponse = useCallback(
    (response: FileSearchResponse) => {
      setSearchResults(response.entries)
      setSearchDiagnostics(response.diagnostics)

      if (response.diagnostics) {
        logPerfEvent('FileExplorer', 'search-files', {
          rootPath,
          query: latestSearchQueryRef.current,
          ...response.diagnostics,
        })
      }
    },
    [rootPath],
  )

  useEffect(() => {
    if (!renamingPath) return
    window.setTimeout(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }, 0)
  }, [renamingPath])

  // The ignore answers live on the shared model, asked once per folder
  // against the repository this tree's status was read from.
  useEffect(() => {
    model?.setRepoRoot(gitStatus?.repoRoot ?? null)
  }, [model, gitStatus?.repoRoot])
  const isIgnored = useCallback((path: string) => tree.ignoredKeys.has(normalizePathKey(path)), [tree.ignoredKeys])

  const loadDirectory = useCallback(
    async (dirPath: string): Promise<Entry[]> => (model ? model.loadDirectory(dirPath) : []),
    [model],
  )

  // Every open goes through here — a click, the arrow key, the menu — so each
  // one gets the spinner when the listing is slow (an SSH machine).
  const ensureDirectoryLoaded = async (dirPath: string) => {
    if (model) await trackFolderLoad(dirPath, model.ensureLoaded(dirPath))
  }

  const focusTree = () => {
    containerRef.current?.focus()
  }

  const selectOnlyEntry = (entry: Entry) => {
    const key = rowKeyOf(entry)
    selectionAnchorPathRef.current = key
    setSelectedPath(key)
    setSelectedPaths(new Set([key]))
  }

  const selectEntryRange = (anchorPath: string, targetPath: string) => {
    const rangePaths = fileExplorerSelectionRange(
      activeRowsRef.current.map((row) => rowKeyOf(row.entry)),
      anchorPath,
      targetPath,
    )

    if (!rangePaths.length) {
      return
    }

    setSelectedPaths(new Set(rangePaths))
  }

  const beginBackgroundDragSelection = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.target instanceof Element && event.target.closest('[data-file-explorer-row="true"]')) return

    event.preventDefault()
    dragSelectionRef.current = { kind: 'background', startY: event.clientY, active: true }
    completedDragSelectionRef.current = false
    selectionAnchorPathRef.current = null
    setSelectedPath(null)
    setSelectedPaths(new Set())
    focusTree()
  }

  const selectEntry = (entry: Entry, event?: React.MouseEvent<HTMLDivElement>) => {
    const key = rowKeyOf(entry)
    setSelectedPath(key)

    if (event?.shiftKey && selectionAnchorPathRef.current) {
      selectEntryRange(selectionAnchorPathRef.current, key)
      return
    }

    if (event?.metaKey || event?.ctrlKey) {
      selectionAnchorPathRef.current = key
      setSelectedPaths((current) => {
        const next = new Set(current)
        if (next.has(key) && next.size > 1) {
          next.delete(key)
        } else {
          next.add(key)
        }
        return next
      })
      return
    }

    selectOnlyEntry(entry)
  }

  const refreshParentDirectory = async (parentPath: string) => {
    await loadDirectory(parentPath)
  }

  const refreshTree = useCallback(
    async (cause: RefreshTreeCause = 'manual') => {
      if (!model) return
      const startedAt = performance.now()
      const expandedDirectories = Object.entries(latestExpandedPathsRef.current)
        .filter(([, expanded]) => expanded)
        .map(([dirPath]) => dirPath)

      const directories = Array.from(new Set([rootPath, ...expandedDirectories]))
      // A folder that can no longer be read is dropped by the model; its
      // expanded mark goes with it here, so it does not reopen if the name
      // comes back.
      await model.refresh(directories)
      const gone = expandedDirectories.filter((dirPath) => !model.isLoaded(dirPath))
      if (gone.length) {
        setExpandedPaths((current) => {
          const next = { ...current }
          for (const dirPath of gone) delete next[dirPath]
          return next
        })
      }

      logPerfEvent('FileExplorer', 'refresh-tree', {
        cause,
        rootPath,
        elapsedMs: Math.round(performance.now() - startedAt),
        expandedDirectoryCount: expandedDirectories.length,
        loadedDirectoryCount: directories.length - gone.length,
        isSearching: latestSearchQueryRef.current.trim().length > 0,
      })
    },
    [model, rootPath, setExpandedPaths],
  )

  const toggleDirectory = async (entry: Entry) => {
    if (!entry.isDir) return
    if (isPathsSource) {
      setPathFolderOpen(entry.path, collapsedPaths.has(entry.path))
      return
    }
    const isExpanded = latestExpandedPathsRef.current[entry.path] === true
    if (!isExpanded) {
      await ensureDirectoryLoaded(entry.path)
    }
    setExpandedPaths((current) => {
      if (!isExpanded) {
        return { ...current, [entry.path]: true }
      }

      return Object.fromEntries(Object.entries(current).filter(([path]) => !isPathOrChild(path, entry.path)))
    })
  }

  const activateEntry = async (entry: Entry) => {
    selectOnlyEntry(entry)
    if (isSearching && entry.isDir) {
      focusTree()
      return
    }
    // The host's own meaning of "this file", when it has one: the editor
    // window opens it here, the diff shows its diff.
    if (!entry.isDir && onActivateFile) {
      onActivateFile(entry)
      return
    }
    if (isSearching || !entry.isDir) {
      await onOpenFile(entry.path, entry.name)
      return
    }
    await toggleDirectory(entry)
  }

  const createEntry = async (targetDir: string, kind: 'file' | 'dir') => {
    const defaultName = kind === 'file' ? 'untitled.ts' : 'new-folder'
    const rawName = await dialog.prompt({
      title: kind === 'file' ? 'New file' : 'New folder',
      inputLabel: kind === 'file' ? 'File name' : 'Folder name',
      initialValue: defaultName,
      confirmLabel: 'Create',
      required: true,
    })
    const name = rawName?.trim()
    if (!name) return

    try {
      const newPath =
        kind === 'file' ? await window.api.createFile(targetDir, name) : await window.api.createDir(targetDir, name)

      if (targetDir !== rootPath) {
        setExpandedPaths((current) => ({ ...current, [targetDir]: true }))
      }

      await refreshParentDirectory(targetDir)
      selectOnlyEntry({
        name,
        isDir: kind === 'dir',
        path: newPath,
        parentPath: targetDir,
      })

      if (kind === 'file') {
        if (persistsToWorkspace && writesWorkspace && workspaceId) {
          openFile(workspaceId, newPath, name, '')
          focusOrAddFileTab(workspaceId, newPath, name)
        } else {
          // Every other host opens files its own way — the editor window as
          // one of its tabs — and a new file opens where the host opens files.
          onOpenFile(newPath, name)
        }
      }
      void refreshGitStatus()
    } catch (error) {
      showError(error)
    }
  }

  useEffect(() => {
    if (!createRequest || createRequest.token === lastCreateRequestTokenRef.current) return
    lastCreateRequestTokenRef.current = createRequest.token
    void createEntry(rootPath, createRequest.kind)
  }, [createRequest?.token])

  // Open files follow a rename or a move, and close with a delete: through the
  // workspace's tabs where this tree may write them, and through the host
  // otherwise, which knows its own tabs.
  const carryOpenFiles = (fromPath: string, toPath: string) => {
    if (writesWorkspace && workspaceId) {
      remapOpenFiles(workspaceId, fromPath, toPath)
      remapFileTabsForPath(workspaceId, fromPath, toPath)
    }
    onPathMoved?.(fromPath, toPath)
  }
  const dropOpenFiles = (path: string) => {
    if (writesWorkspace && workspaceId) {
      removeOpenFilesForPath(workspaceId, path)
      removeFileTabsForPath(workspaceId, path)
    }
    onPathRemoved?.(path)
  }

  const startRename = (entry: Entry) => {
    selectOnlyEntry(entry)
    setRenameDraft({ entry, value: entry.name })
  }

  const cancelRename = () => {
    setRenameDraft(null)
    focusTree()
  }

  const commitRename = async () => {
    if (!renameDraft || committingRenameRef.current) return

    const { entry } = renameDraft
    const nextName = renameDraft.value.trim()
    if (!nextName || nextName === entry.name) {
      setRenameDraft(null)
      focusTree()
      return
    }

    try {
      committingRenameRef.current = true
      const nextPath = await window.api.renamePath(entry.path, nextName)
      carryOpenFiles(entry.path, nextPath)

      if (entry.isDir) {
        model?.remap(entry.path, nextPath)
        setExpandedPaths((current) => remapExpandedPaths(current, entry.path, nextPath))
      }

      await refreshParentDirectory(entry.parentPath)
      if (isSearching) {
        applySearchResponse(await searchFiles(rootPath, latestSearchQueryRef.current, latestGitStatusRef.current))
      }
      selectionAnchorPathRef.current = nextPath
      setSelectedPath(nextPath)
      setSelectedPaths(new Set([nextPath]))
      setRenameDraft(null)
      focusTree()
      void refreshGitStatus()
    } catch (error) {
      showError(error)
    } finally {
      committingRenameRef.current = false
    }
  }

  const pasteIntoDirectory = async (targetDir: string) => {
    if (!clipboard) return

    try {
      const newPath = await window.api.copyPath(clipboard.path, targetDir)
      setExpandedPaths((current) => ({ ...current, [targetDir]: true }))
      await refreshParentDirectory(targetDir)
      selectionAnchorPathRef.current = newPath
      setSelectedPath(newPath)
      setSelectedPaths(new Set([newPath]))
      void refreshGitStatus()
    } catch (error) {
      showError(error)
    }
  }

  const deleteEntries = async (entries: Entry[]) => {
    const deletableEntries = entries.filter((entry) => !entry.gitDeleted)
    if (!deletableEntries.length) return

    if (typeof window.api.deletePath !== 'function') {
      showError('Delete support is not loaded yet. Restart the app so Electron reloads the preload script.')
      return
    }

    const topLevelEntries = deletableEntries.filter(
      (entry) =>
        !deletableEntries.some(
          (candidate) => candidate.path !== entry.path && isPathOrChild(entry.path, candidate.path),
        ),
    )
    const targetLabel =
      topLevelEntries.length === 1
        ? topLevelEntries[0].isDir
          ? `folder "${topLevelEntries[0].name}" and its contents`
          : `file "${topLevelEntries[0].name}"`
        : `${topLevelEntries.length} selected items`
    const confirmed = await dialog.confirm({
      title: 'Move to Trash?',
      body: `This moves ${targetLabel} to the system Trash. You can restore it from Trash until it is emptied.`,
      confirmLabel: 'Move to Trash',
      tone: 'danger',
    })
    if (!confirmed) return

    try {
      await Promise.all(topLevelEntries.map((entry) => window.api.deletePath(entry.path)))
      topLevelEntries.forEach((entry) => dropOpenFiles(entry.path))

      topLevelEntries.forEach((entry) => model?.forget(entry.path))
      setExpandedPaths((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([path]) => !topLevelEntries.some((entry) => isPathOrChild(path, entry.path))),
        ),
      )
      setSearchResults((current) =>
        current.filter((result) => !topLevelEntries.some((entry) => isPathOrChild(result.path, entry.path))),
      )
      setClipboard((current) =>
        current && topLevelEntries.some((entry) => isPathOrChild(current.path, entry.path)) ? null : current,
      )

      await Promise.all(
        Array.from(new Set(topLevelEntries.map((entry) => entry.parentPath))).map(refreshParentDirectory),
      )
      const nextSelection = isSearching ? null : (topLevelEntries[0]?.parentPath ?? null)
      selectionAnchorPathRef.current = nextSelection
      setSelectedPath(nextSelection)
      setSelectedPaths(nextSelection ? new Set([nextSelection]) : new Set())
      void refreshGitStatus()
    } catch (error) {
      showError(error)
    }
  }

  const handleDragStart = (event: React.DragEvent<HTMLDivElement>, entry: Entry) => {
    if (dragSelectionRef.current?.active) {
      event.preventDefault()
      return
    }

    if (entry.gitDeleted) {
      event.preventDefault()
      return
    }

    const entryKey = rowKeyOf(entry)
    const dragEntries = topLevelEntries(
      (selectedPaths.has(entryKey) ? selectedEntries : [entry]).filter((selectedEntry) => !selectedEntry.gitDeleted),
    )
    if (!dragEntries.length) {
      event.preventDefault()
      return
    }

    const movePayload: ExplorerMovePayload = {
      version: 1,
      workspaceId: workspaceId ?? '',
      rootPath,
      entries: dragEntries,
    }
    activeMoveDragRef.current = movePayload
    setSelectedPath(entryKey)
    if (!selectedPaths.has(entryKey)) {
      selectionAnchorPathRef.current = entryKey
      setSelectedPaths(new Set([entryKey]))
    }
    setFileDropData(event.dataTransfer, {
      version: 1,
      workspaceId,
      rootPath,
      files: dragEntries.map((selectedEntry) => ({
        path: selectedEntry.path,
        name: selectedEntry.name,
        isDir: selectedEntry.isDir,
      })),
    })
    event.dataTransfer.effectAllowed = 'copyMove'
    event.dataTransfer.setData(SPRINTENGINE_EXPLORER_MOVE_MIME, JSON.stringify(movePayload))
  }

  const readMoveDragPayload = (dataTransfer: DataTransfer): ExplorerMovePayload | null => {
    const payload = activeMoveDragRef.current ?? parseExplorerMovePayload(dataTransfer)
    if (!payload) return null
    if (payload.workspaceId !== (workspaceId ?? '')) return null
    if (normalizePathKey(payload.rootPath) !== normalizePathKey(rootPath)) return null
    return payload
  }

  const canDropMovePayload = (payload: ExplorerMovePayload, targetDir: string): boolean => {
    return payload.entries.some(
      (entry) =>
        !entry.gitDeleted &&
        entry.parentPath !== targetDir &&
        entry.path !== targetDir &&
        !isPathOrChild(targetDir, entry.path),
    )
  }

  const moveEntriesIntoDirectory = async (entries: Entry[], targetDir: string) => {
    const movableEntries = topLevelEntries(entries.filter((entry) => !entry.gitDeleted))
    if (!movableEntries.length) return

    const invalidTarget = movableEntries.find(
      (entry) => entry.path === targetDir || isPathOrChild(targetDir, entry.path),
    )
    if (invalidTarget) {
      showError(`Cannot move "${invalidTarget.name}" into itself.`)
      return
    }

    const entriesToMove = movableEntries.filter((entry) => entry.parentPath !== targetDir)
    if (!entriesToMove.length) return

    const parentDirectories = new Set(entriesToMove.flatMap((entry) => [entry.parentPath, targetDir]))
    const movedEntries: Array<{ entry: Entry; nextPath: string }> = []
    const selectMovedEntries = () => {
      const movedPaths = movedEntries.map((moved) => moved.nextPath)
      selectionAnchorPathRef.current = movedPaths[0] ?? null
      setSelectedPath(movedPaths[0] ?? null)
      setSelectedPaths(new Set(movedPaths))
    }

    try {
      for (const entry of entriesToMove) {
        const nextPath = await window.api.movePath(entry.path, targetDir)
        if (nextPath === entry.path) continue
        movedEntries.push({ entry, nextPath })
        carryOpenFiles(entry.path, nextPath)
      }

      if (!movedEntries.length) return

      movedEntries.forEach((moved) => {
        if (moved.entry.isDir) model?.remap(moved.entry.path, moved.nextPath)
      })
      setExpandedPaths((current) => ({
        ...movedEntries.reduce(
          (next, moved) => (moved.entry.isDir ? remapExpandedPaths(next, moved.entry.path, moved.nextPath) : next),
          current,
        ),
        [targetDir]: true,
      }))

      await Promise.all(Array.from(parentDirectories).map(refreshParentDirectory))
      if (isSearching) {
        applySearchResponse(await searchFiles(rootPath, latestSearchQueryRef.current, latestGitStatusRef.current))
      }

      selectMovedEntries()
      focusTree()
      void refreshGitStatus()
    } catch (error) {
      showError(error, 'Could not move the selected file.')
      if (movedEntries.length) {
        await Promise.all(Array.from(parentDirectories).map(refreshParentDirectory))
        if (isSearching) {
          applySearchResponse(await searchFiles(rootPath, latestSearchQueryRef.current, latestGitStatusRef.current))
        }
        selectMovedEntries()
        void refreshGitStatus()
      }
    }
  }

  // Copy OS files/folders dropped from Finder (etc.) into a directory in the
  // tree. Each copy is independent so one name collision does not abort the rest.
  const copyExternalFilesIntoDirectory = async (sourcePaths: string[], targetDir: string) => {
    if (!sourcePaths.length) return
    if (typeof window.api.copyPathInto !== 'function') {
      showError('Copying files into the explorer is not supported in this build.')
      return
    }

    const copiedPaths: string[] = []
    const errors: string[] = []
    for (const sourcePath of sourcePaths) {
      try {
        copiedPaths.push(await window.api.copyPathInto(sourcePath, targetDir))
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }

    if (errors.length) {
      showError(errors.join('\n'))
    }

    setExpandedPaths((current) => ({ ...current, [targetDir]: true }))
    await refreshParentDirectory(targetDir)
    if (isSearching) {
      applySearchResponse(await searchFiles(rootPath, latestSearchQueryRef.current, latestGitStatusRef.current))
    }

    if (copiedPaths.length) {
      selectionAnchorPathRef.current = copiedPaths[0]
      setSelectedPath(copiedPaths[0])
      setSelectedPaths(new Set(copiedPaths))
      focusTree()
    }
    void refreshGitStatus()
  }

  // A paths source's folders are only the way down to the files it lists, so
  // nothing is dropped into them; its rows still drag OUT (to a terminal, a
  // chat), which costs the list nothing.
  const handleFolderDragOver = (event: React.DragEvent<HTMLDivElement>, entry: Entry) => {
    if (!entry.isDir || entry.gitDeleted || isPathsSource) return

    // In-app move takes precedence over an external copy.
    if (hasExplorerMovePayload(event.dataTransfer) || activeMoveDragRef.current) {
      const payload = readMoveDragPayload(event.dataTransfer)
      if (!payload || !canDropMovePayload(payload, entry.path)) {
        event.dataTransfer.dropEffect = 'none'
        setDropTargetPath(null)
        return
      }

      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'
      setDropTargetPath(entry.path)
      return
    }

    if (hasNativeFileDrop(event.dataTransfer)) {
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'copy'
      setRootDropActive(false)
      setDropTargetPath(entry.path)
    }
  }

  const handleFolderDragLeave = (event: React.DragEvent<HTMLDivElement>, entry: Entry) => {
    if (dropTargetPath !== entry.path) return
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    setDropTargetPath(null)
  }

  const handleFolderDrop = (event: React.DragEvent<HTMLDivElement>, entry: Entry) => {
    if (!entry.isDir || entry.gitDeleted || isPathsSource) return

    if (
      hasNativeFileDrop(event.dataTransfer) &&
      !hasExplorerMovePayload(event.dataTransfer) &&
      !activeMoveDragRef.current
    ) {
      event.preventDefault()
      event.stopPropagation()
      setDropTargetPath(null)
      void copyExternalFilesIntoDirectory(collectNativeDropPaths(event.dataTransfer), entry.path)
      return
    }

    const payload = readMoveDragPayload(event.dataTransfer)
    if (!payload || !canDropMovePayload(payload, entry.path)) return

    event.preventDefault()
    event.stopPropagation()
    setDropTargetPath(null)
    void moveEntriesIntoDirectory(payload.entries, entry.path)
  }

  const handleDragEnd = () => {
    activeMoveDragRef.current = null
    setDropTargetPath(null)
    setRootDropActive(false)
  }

  // Drops on empty space or a non-folder row fall through to here and copy into
  // the workspace root. Folder rows stop propagation, so this never double-fires.
  const handleRootDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (isPathsSource) return
    if (hasExplorerMovePayload(event.dataTransfer) || activeMoveDragRef.current) return
    if (!hasNativeFileDrop(event.dataTransfer)) return

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropTargetPath(null)
    setRootDropActive(true)
  }

  const handleRootDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    setRootDropActive(false)
  }

  const handleRootDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (isPathsSource) return
    if (hasExplorerMovePayload(event.dataTransfer) || activeMoveDragRef.current) return
    if (!hasNativeFileDrop(event.dataTransfer)) return

    event.preventDefault()
    setRootDropActive(false)
    void copyExternalFilesIntoDirectory(collectNativeDropPaths(event.dataTransfer), rootPath)
  }

  // The tree's right-click menu. It was a native Electron popup until
  // this item — OS-drawn and Title-Cased, so the richest menu in the product was
  // also the one that looked least like it. Everything the menu offers is
  // sampled here, when it opens, exactly as the native template was: the
  // selection, the clipboard and the git status can all move while it is up.
  const openContextMenu = (event: React.MouseEvent, entry?: Entry) => {
    event.preventDefault()
    event.stopPropagation()
    focusTree()

    const entrySelected = entry ? selectedPaths.has(rowKeyOf(entry)) : false
    const contextSelection = entry && entrySelected ? selectedEntries : entry ? [entry] : []

    if (entry && !entrySelected) {
      selectOnlyEntry(entry)
    }

    const targetDir = entry ? (entry.isDir ? entry.path : entry.parentPath) : rootPath
    const canUsePathCommands =
      contextSelection.length > 0 && contextSelection.every((selectedEntry) => !selectedEntry.gitDeleted)
    const isSingleSelection = contextSelection.length === 1
    const gitDiffEntry =
      isSingleSelection && entry && !entry.isDir ? getGitEntry(latestGitStatusRef.current, entry.path) : null
    const canViewGitDiff = Boolean(
      isSingleSelection &&
      entry &&
      !entry.isDir &&
      latestGitStatusRef.current?.repoRoot &&
      (gitDiffEntry || entry.gitDeleted),
    )
    const canDeletePath = canUsePathCommands && typeof window.api.deletePath === 'function'
    // A module's action is asked about a workspace, so a tree that knows none
    // offers none rather than handing a module an empty id.
    const fileActions = workspaceId
      ? visibleFileExplorerModuleActions({
          actions: getRendererHost().getFileActions(),
          moduleEnabled: (moduleId) => selectModuleEnabled(moduleOverrides, moduleId),
          moduleLabel: fileActionModuleLabel,
          context: {
            workspaceId,
            workspaceRoot: rootPath,
            entries: contextSelection,
          },
        })
      : []
    const deleteLabel =
      contextSelection.length > 1
        ? canDeletePath
          ? `Delete ${contextSelection.length} items`
          : 'Delete items (restart app)'
        : canDeletePath
          ? 'Delete'
          : 'Delete (restart app)'

    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      entry: entry ?? null,
      contextSelection,
      targetDir,
      canOpenPath: Boolean(isSingleSelection && entry && !entry.isDir && canUsePathCommands),
      canOpenInBrowser: Boolean(isSingleSelection && entry && isHtmlFile(entry) && canUsePathCommands),
      canViewGitDiff,
      fileActions,
      directoryToggle:
        isSingleSelection && entry?.isDir && !isSearching && canUsePathCommands
          ? isExpandedEntry(entry)
            ? 'collapse'
            : 'expand'
          : null,
      // A folder's role is the workspace's to remember, so it is marked only
      // where this tree may write the workspace.
      folderRoleTarget:
        writesWorkspace && isSingleSelection && entry?.isDir && canUsePathCommands
          ? { path: entry.path, role: (folderRoles ?? {})[entry.path] ?? null }
          : null,
      canUseSinglePathCommands: Boolean(isSingleSelection && entry && canUsePathCommands),
      canPaste: Boolean(clipboard) && !isSearching,
      canDeletePath,
      deleteLabel,
    })
  }

  const runContextMenuCommand = async (command: string, menu: ExplorerMenuState) => {
    const { entry, contextSelection, targetDir } = menu
    setContextMenu(null)
    // Open is "open it in an editor" in every host, even one whose click means
    // something else (the diff's click shows the file's diff).
    if (command === 'open' && entry) {
      if (entry.isDir) return void activateEntry(entry)
      selectOnlyEntry(entry)
      return void onOpenFile(entry.path, entry.name)
    }
    if (command === 'open-in-browser' && entry && isHtmlFile(entry)) {
      try {
        await window.api.openHtmlFileInBrowser(entry.path)
      } catch (error) {
        showError(error)
      }
      return
    }
    if (command === 'reveal-in-file-manager' && entry && !entry.isDir) {
      try {
        await window.api.showItemInFolder(entry.path)
      } catch (error) {
        showError(error)
      }
      return
    }
    if (command === 'view-git-diff' && entry && !entry.isDir) {
      const repoRoot = latestGitStatusRef.current?.repoRoot
      if (repoRoot) {
        const gitEntry = getGitEntry(latestGitStatusRef.current, entry.path)
        const scope = gitEntry?.staged && !gitEntry.unstaged ? 'staged' : 'unstaged'
        // The same routing the Git panel's rows take: the window by
        // default, the pane's Diff tab once the person has flipped it. The
        // repository is the one this tree's status was read against. An
        // auxiliary window has no pane to open a tab in, nor a store whose
        // preference it may trust, so from there it is always the window.
        if (writesWorkspace && workspaceId) {
          openGitDiff({ workspaceId, repoRoot, focusPath: entry.path, scope })
        } else {
          void openDiffWindow({
            ...(workspaceId ? { workspaceId } : {}),
            repoRoot,
            focusPath: entry.path,
            scope,
          })
        }
      }
      return
    }
    if (command.startsWith('file-action:')) {
      const actionId = command.slice('file-action:'.length)
      const action = getRendererHost()
        .getFileActions()
        .find((candidate) => candidate.id === actionId)
      if (!action || !workspaceId) return
      try {
        await action.run({
          workspaceId,
          workspaceRoot: rootPath,
          entries: contextSelection,
        })
      } catch (error) {
        showError(error)
      }
      return
    }
    if (command === 'expand' && entry?.isDir && isPathsSource) return setPathFolderOpen(entry.path, true)
    if (command === 'collapse' && entry?.isDir && isPathsSource) return setPathFolderOpen(entry.path, false)
    if (command === 'expand' && entry?.isDir) {
      if (!expandedPaths[entry.path]) {
        await ensureDirectoryLoaded(entry.path)
        setExpandedPaths((current) => ({ ...current, [entry.path]: true }))
      }
      return
    }
    if (command === 'collapse' && entry?.isDir) {
      setExpandedPaths((current) => ({ ...current, [entry.path]: false }))
      return
    }
    if (command === 'new-file') return void createEntry(targetDir, 'file')
    if (command === 'new-folder') return void createEntry(targetDir, 'dir')
    if (command === 'copy' && entry) {
      setClipboard({ path: entry.path, isDir: entry.isDir })
      return
    }
    if (command === 'paste' && !isSearching) return void pasteIntoDirectory(targetDir)
    if (command === 'rename' && entry) return startRename(entry)
    if (command === 'delete' && contextSelection.length) return void deleteEntries(contextSelection)
    if (command === 'refresh') {
      if (isSearching || targetDir === rootPath) {
        await refreshTree('manual')
      } else {
        await refreshParentDirectory(targetDir)
      }
      await refreshGitStatus()
    }
  }

  useEffect(() => {
    // The model lands a commit after the root does; the restore below starts
    // once it has.
    if (!model) return
    let cancelled = false
    const restoredExpandedPaths = expandedPathRecordFromList(readPersistedExpandedPaths(), rootPath)
    // Block selection persistence until the initial restore runs, so the
    // pre-restore null below (or a slow tree load) cannot overwrite the saved
    // selection before we read it.
    hasRestoredSelectionRef.current = false
    setLoading(true)
    latestExpandedPathsRef.current = restoredExpandedPaths
    setExpandedPathsState(restoredExpandedPaths)
    setSelectedPath(null)
    setSelectedPaths(new Set())
    selectionAnchorPathRef.current = null

    // A paths source lists nothing to show its rows; the folder is read the
    // first time the host switches it to the folder on disk (below).
    if (isPathsSourceRef.current) {
      setLoading(false)
      return
    }

    // The workspace's tree reads the folder afresh on mount; a local one takes
    // what this window has already read of it — the editor window's tree
    // reads exactly the folders down to the open file, and nothing twice.
    const listDirectory = persistsToWorkspace
      ? loadDirectory
      : async (dirPath: string): Promise<Entry[]> => {
          await model.ensureLoaded(dirPath)
          const snapshot = model.getSnapshot()
          return (dirPath === rootPath ? snapshot.rootEntries : snapshot.childrenByPath[dirPath]) ?? []
        }
    const startedAt = performance.now()
    const loadInitialTree = async () => {
      const entries = await listDirectory(rootPath)
      if (cancelled) return

      const expandedDirectories = Object.keys(restoredExpandedPaths).filter((dirPath) => dirPath !== rootPath)
      const existingExpandedPaths = { ...restoredExpandedPaths }
      let loadedDirectoryCount = 1

      await Promise.all(
        expandedDirectories.map(async (dirPath) => {
          try {
            await listDirectory(dirPath)
            loadedDirectoryCount += 1
          } catch {
            delete existingExpandedPaths[dirPath]
          }
        }),
      )
      if (cancelled) return

      if (Object.keys(existingExpandedPaths).length !== Object.keys(restoredExpandedPaths).length) {
        commitExpandedPaths(existingExpandedPaths)
      }

      return { entries, expandedDirectoryCount: expandedDirectories.length, loadedDirectoryCount }
    }

    loadInitialTree()
      .then((result) => {
        if (!result || cancelled) return
        const { entries, expandedDirectoryCount, loadedDirectoryCount } = result
        const firstPath = entries[0]?.path ?? null
        // Restore the last-selected file once every expanded directory is loaded
        // (so its row is flattened into the tree). If it is no longer under the
        // root or its ancestors are collapsed/gone, the selection-validity effect
        // below replaces it with the first row — graceful for deleted files.
        //
        // A tree that follows a path leaves the selection to the follow: it
        // may already have landed, and the first row is not the open file.
        if (!followingRef.current) {
          const persistedSelectedPath = readPersistedSelectedPath()
          const restorePath =
            persistedSelectedPath && isPathOrChild(persistedSelectedPath, rootPath) ? persistedSelectedPath : firstPath
          setSelectedPath(restorePath)
          setSelectedPaths(restorePath ? new Set([restorePath]) : new Set())
          selectionAnchorPathRef.current = restorePath
        }
        // The saved selection has now been read; later changes may persist.
        hasRestoredSelectionRef.current = true
        logPerfEvent('FileExplorer', 'refresh-tree', {
          cause: 'initial',
          rootPath,
          elapsedMs: Math.round(performance.now() - startedAt),
          expandedDirectoryCount,
          loadedDirectoryCount,
          isSearching: false,
        })
      })
      .catch(() => {
        // The root could not be listed. A refresh is what reports that on the
        // snapshot (`rootError`), which the tree then says in words.
        if (!cancelled) void model.refresh([rootPath])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    commitExpandedPaths,
    loadDirectory,
    model,
    persistsToWorkspace,
    readPersistedExpandedPaths,
    readPersistedSelectedPath,
    rootPath,
  ])

  // A host that switches a paths source to the folder on disk (the editor's
  // "All files") finds the root listed, whether or not it ever was.
  useEffect(() => {
    if (!model || isPathsSource) return
    void model.ensureLoaded(model.rootPath).catch(() => {
      void model.refresh([model.rootPath])
    })
  }, [isPathsSource, model])

  useEffect(() => {
    if (refreshToken === lastManualRefreshRef.current) return
    lastManualRefreshRef.current = refreshToken
    model?.recheckIgnored()
    void refreshTree('manual')
    void refreshGitStatus()
  }, [model, refreshGitStatus, refreshToken, refreshTree])

  // Reveal runs when the TOKEN moves, and only then. `revealPath` follows the
  // editor's active file, so an effect keyed on it re-revealed on every tab
  // switch — the tree kept jumping to whatever was open, which is exactly what
  // the panel's own comment below says it must not do. The path is read when
  // the token moves; a path change alone does nothing.
  const lastRevealTokenRef = useRef(0)
  const revealHandleRef = useRef<{ cancel: () => void } | null>(null)
  const pendingScrollPathRef = useRef<string | null>(null)
  const latestRevealPathRef = useRef(revealPath)
  latestRevealPathRef.current = revealPath
  useEffect(() => {
    if (!model || !revealToken || revealToken === lastRevealTokenRef.current) return
    lastRevealTokenRef.current = revealToken
    const target = latestRevealPathRef.current
    if (!target || !isPathOrChild(target, rootPath)) return

    revealHandleRef.current?.cancel()
    const startedAt = performance.now()
    const handle = model.reveal(target)
    revealHandleRef.current = handle
    void handle.done
      .then((parentDirectories) => {
        if (!parentDirectories) return
        setExpandedPaths((current) => ({
          ...current,
          ...Object.fromEntries(parentDirectories.map((directory) => [directory, true])),
        }))
        setRootCollapsed(false)
        setSelectedPath(target)
        setSelectedPaths(new Set([target]))
        selectionAnchorPathRef.current = target
        pendingScrollPathRef.current = target
        logPerfEvent('FileExplorer', 'refresh-tree', {
          cause: 'reveal',
          rootPath,
          elapsedMs: Math.round(performance.now() - startedAt),
          expandedDirectoryCount: parentDirectories.length,
          loadedDirectoryCount: parentDirectories.length,
          isSearching: false,
        })
      })
      .catch(() => {
        // A folder on the way vanished; the tree shows what it can.
      })
  }, [model, revealToken, rootPath, setExpandedPaths])

  // Following a path: the host's open file or current diff. Debounced, so
  // flicking through tabs (or ⌘↓ through a diff) does not queue a reveal per
  // step, and cancelled when the next one lands first. On the folder on disk
  // it lists just the folders between the root and the file; on a paths source
  // the folders are already there and only need to be open. Re-run when the
  // source switches, so "All files" opens down to a file "Changed files" showed.
  useEffect(() => {
    if (!following) return
    if (!followPath) return
    if (!isPathOrChild(followPath, rootPath)) {
      setSelectedPath(null)
      setSelectedPaths(new Set())
      return
    }
    const target = followPath
    let handle: { cancel: () => void } | null = null
    const land = (ancestors: string[]) => {
      if (!isPathsSource && ancestors.length) {
        setExpandedPaths((current) => ({
          ...current,
          ...Object.fromEntries(ancestors.map((directory) => [directory, true])),
        }))
      }
      // A paths source's folders must not stay folded over the file either.
      setCollapsedPaths((current) => {
        if (!ancestors.some((directory) => current.has(directory))) return current
        const next = new Set(current)
        for (const directory of ancestors) next.delete(directory)
        return next
      })
      setRootCollapsed(false)
      setSelectedPath(target)
      setSelectedPaths(new Set([target]))
      selectionAnchorPathRef.current = target
      pendingScrollPathRef.current = target
    }
    const timer = window.setTimeout(() => {
      if (isPathsSource) {
        land(parentDirectoriesForPath(rootPath, target))
        return
      }
      if (!model) return
      const reveal = model.reveal(target)
      handle = reveal
      void reveal.done
        .then((ancestors) => {
          if (ancestors) land(ancestors)
        })
        .catch(() => {
          // A folder on the way vanished; the tree shows what it can.
        })
    }, FILE_TREE_FOLLOW_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
      handle?.cancel()
    }
  }, [followPath, following, isPathsSource, model, rootPath, setExpandedPaths])

  useEffect(
    () => () => {
      revealHandleRef.current?.cancel()
      if (searchTimeoutRef.current) {
        window.clearTimeout(searchTimeoutRef.current)
        searchTimeoutRef.current = null
      }
    },
    [],
  )

  // The workspace's tree re-reads what it shows whenever git's status moves
  // (a checkout, a stash). A local tree leaves that to the shared model's
  // watch: it is the second view of a root the watch already covers, and a
  // re-read per status tick would read every folder twice.
  useEffect(() => {
    if (!persistsToWorkspace) return
    void refreshTree('git-status')
  }, [gitStatus?.updatedAt, persistsToWorkspace, refreshTree])

  useEffect(() => {
    if (!isSearching) {
      searchRequestSeqRef.current += 1
      if (searchTimeoutRef.current) {
        window.clearTimeout(searchTimeoutRef.current)
        searchTimeoutRef.current = null
      }
      setSearchResults([])
      setSearchDiagnostics(null)
      setSearching(false)
      return
    }

    const requestSeq = ++searchRequestSeqRef.current
    setSearching(true)
    if (searchTimeoutRef.current) {
      window.clearTimeout(searchTimeoutRef.current)
    }

    searchTimeoutRef.current = window.setTimeout(() => {
      searchTimeoutRef.current = null
      searchFiles(rootPath, query, latestGitStatusRef.current)
        .then((response) => {
          if (requestSeq !== searchRequestSeqRef.current) return
          applySearchResponse(response)
          const firstPath = response.entries[0]?.path ?? null
          setSelectedPath(firstPath)
          setSelectedPaths(firstPath ? new Set([firstPath]) : new Set())
          selectionAnchorPathRef.current = firstPath
        })
        .catch(() => {
          if (requestSeq === searchRequestSeqRef.current) {
            setSearchResults([])
            setSearchDiagnostics(null)
          }
        })
        .finally(() => {
          if (requestSeq === searchRequestSeqRef.current) setSearching(false)
        })
    }, 180)

    return () => {
      if (searchTimeoutRef.current) {
        window.clearTimeout(searchTimeoutRef.current)
        searchTimeoutRef.current = null
      }
    }
  }, [applySearchResponse, rootPath, query, isSearching])

  // The revealed row scrolls into view once it is actually a row: the reveal
  // sets the expanded set, and the rows that follow from it land a render later.
  useEffect(() => {
    const target = pendingScrollPathRef.current
    if (!target) return
    const index = activeRows.findIndex((row) => treeRowKey(row.entry, sharedFolderPaths) === target)
    if (index < 0) return
    pendingScrollPathRef.current = null
    rowsHandleRef.current?.scrollToIndex(index)
  }, [activeRows, sharedFolderPaths])

  useEffect(() => {
    // A tree that follows a path has a selection only where that path is: the
    // first row is not the open file, and claiming it would say it was.
    if (following) return
    if (!activeRows.length) {
      if (!loading && !searching) {
        setSelectedPath(null)
        setSelectedPaths(new Set())
        selectionAnchorPathRef.current = null
      }
      return
    }

    const activePathSet = new Set(activeRows.map((row) => treeRowKey(row.entry, sharedFolderPaths)))
    if (!selectedPath || !activePathSet.has(selectedPath)) {
      const firstPath = treeRowKey(activeRows[0].entry, sharedFolderPaths)
      setSelectedPath(firstPath)
      setSelectedPaths(new Set([firstPath]))
      selectionAnchorPathRef.current = firstPath
      return
    }

    setSelectedPaths((current) => {
      const next = new Set(Array.from(current).filter((path) => activePathSet.has(path)))
      return next.size ? next : new Set([selectedPath])
    })
  }, [activeRows, following, loading, searching, selectedPath, sharedFolderPaths])

  // Persist the focused selection so a reload/restart restores the highlighted
  // file. Debounced because arrow-key navigation changes it rapidly and every
  // store write re-serializes the whole workspace registry. The debounce timer
  // is what survives a Cmd-R reload (React unmount cleanups do not run on a page
  // reload) and still fires on a layer switch, which does not unmount; the
  // separate unmount effect flushes the latest value when the panel/workspace is
  // actually closed so a quick select-then-close is not lost.
  const latestSelectedPathRef = useRef(selectedPath)
  latestSelectedPathRef.current = selectedPath
  // A local tree's selection is its own and is never written.
  useEffect(() => {
    if (!persistsToWorkspace || !workspaceId || !hasRestoredSelectionRef.current) return
    const handle = window.setTimeout(() => {
      setFileExplorerSelectedPath(workspaceId, latestSelectedPathRef.current)
    }, 300)
    return () => window.clearTimeout(handle)
  }, [persistsToWorkspace, selectedPath, workspaceId, setFileExplorerSelectedPath])
  useEffect(() => {
    return () => {
      if (!persistsToWorkspace || !workspaceId || !hasRestoredSelectionRef.current) return
      setFileExplorerSelectedPath(workspaceId, latestSelectedPathRef.current)
    }
  }, [persistsToWorkspace, workspaceId, setFileExplorerSelectedPath])

  const handleKeyDown = async (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (renameDraft) return
    if (event.key === 'Escape' && onEscape) {
      event.preventDefault()
      // The editor and diff windows close on Escape; from the tree, Escape
      // means "back to what I was reading", and must not reach the window.
      event.stopPropagation()
      onEscape()
      return
    }
    if (!activeRows.length) return

    const cursorIndex = activeRows.findIndex((row) => rowKeyOf(row.entry) === selectedPath)
    const currentIndex = Math.max(cursorIndex, 0)
    const currentEntry = activeRows[currentIndex].entry
    const moveSelection = (nextIndex: number) => {
      const nextKey = rowKeyOf(activeRows[nextIndex].entry)
      setSelectedPath(nextKey)
      // Keep the cursor in view — past the windowing threshold a row that is
      // off-screen is not mounted at all.
      rowsHandleRef.current?.scrollToIndex(nextIndex)

      if (event.shiftKey) {
        const anchorPath = selectionAnchorPathRef.current ?? rowKeyOf(currentEntry)
        selectionAnchorPathRef.current = anchorPath
        selectEntryRange(anchorPath, nextKey)
        return
      }

      selectionAnchorPathRef.current = nextKey
      setSelectedPaths(new Set([nextKey]))
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      // With no cursor on screen yet, the first press lands on the first row.
      moveSelection(cursorIndex < 0 ? 0 : Math.min(currentIndex + 1, activeRows.length - 1))
      return
    }

    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      moveSelection(event.key === 'Home' ? 0 : activeRows.length - 1)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveSelection(Math.max(currentIndex - 1, 0))
      return
    }

    if (!isSearching && event.key === 'ArrowRight') {
      event.preventDefault()
      if (isPathsSource && currentEntry.isDir && !isExpandedEntry(currentEntry)) {
        setPathFolderOpen(currentEntry.path, true)
        return
      }
      if (!isPathsSource && currentEntry.isDir && !expandedPaths[currentEntry.path]) {
        await ensureDirectoryLoaded(currentEntry.path)
        setExpandedPaths((current) => ({ ...current, [currentEntry.path]: true }))
        return
      }
      if (currentEntry.isDir && isExpandedEntry(currentEntry)) {
        const nextRow = activeRows[currentIndex + 1]
        if (nextRow?.entry.parentPath === currentEntry.path) {
          setSelectedPath(rowKeyOf(nextRow.entry))
        }
      }
      return
    }

    if (!isSearching && event.key === 'ArrowLeft') {
      event.preventDefault()
      if (currentEntry.isDir && isExpandedEntry(currentEntry)) {
        if (isPathsSource) setPathFolderOpen(currentEntry.path, false)
        else setExpandedPaths((current) => ({ ...current, [currentEntry.path]: false }))
        return
      }
      const parentRow = activeRows.find((row) => row.entry.isDir && row.entry.path === currentEntry.parentPath)
      if (parentRow) {
        setSelectedPath(rowKeyOf(parentRow.entry))
      }
      return
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      await deleteEntries(selectedEntries.length ? selectedEntries : [currentEntry])
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      await activateEntry(currentEntry)
    }
  }

  // The rename field's chrome is fixed here rather than at the two call sites:
  // a folder row and a file row differ only by the weight of the name they
  // replace, and spelling the box out twice is how one of them ended up with a
  // `:focus` border swap instead of the ring.
  const renderRenameInput = (className: string) => {
    if (!renameDraft) return null

    return (
      <Input
        ref={renameInputRef}
        variant="well"
        size="none"
        value={renameDraft.value}
        onChange={(event) =>
          setRenameDraft((current) => (current ? { ...current, value: event.target.value } : current))
        }
        onBlur={() => void commitRename()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (isImeKey(event)) return
          if (event.key === 'Enter') {
            event.preventDefault()
            void commitRename()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            cancelRename()
          }
        }}
        // ANNOTATED OFF-RAMP (held through the empty-state consolidation). The primitive is
        // the kit's `Input` on the `well` ground, and `size="none"` is what lets
        // the box stay off the ramp: `h-5` is 20px, below the 26/30/34 ramp's
        // first step, and deliberately so — this field replaces the NAME INSIDE a
        // file-tree row, and a tree row is 24px tall — `size.hit-target-min`,
        // with 2px of padding either side, so a 20px field is exactly the
        // content box the row already has. A ramp-height field would
        // push every sibling row down while one is being renamed, which is the
        // one thing an in-place edit must not do. Everything else — the border,
        // the ground, the radius, the focus ring — is now the primitive's.
        fullWidth={false}
        className={`h-5 min-w-0 flex-1 px-1.5 text-meta text-[color:var(--text-strong)] ${className}`}
      />
    )
  }

  useImperativeHandle(
    ref,
    () => ({
      collapseAll: () => {
        if (isPathsSource) {
          setCollapsedPaths(
            new Set(allPathRows.filter((row) => row.entry.isDir && row.depth === 0).map((row) => row.entry.path)),
          )
        } else {
          setExpandedPaths({})
        }
        scrollParentRef.current?.scrollTo?.({ top: 0 })
      },
      focus: () => containerRef.current?.focus(),
    }),
    [allPathRows, isPathsSource, scrollParentRef, setExpandedPaths],
  )

  // Three data states, three idioms (principles.md → Accessibility): loading is
  // the skeleton the panel already owns, a live search is the spinner with its
  // word, and an exhausted search is the kit's empty state — never a sentence in
  // disabled ink that reads the same whichever of the three it is. A root that
  // could not be read at all is the kit's notice.
  if (!isPathsSource && tree.rootError && !tree.rootEntries) {
    return (
      <div className="px-2 py-2">
        <InlineNotice tone="error">This folder could not be read.</InlineNotice>
      </div>
    )
  }

  if (!isPathsSource && (loading || tree.rootEntries === null)) {
    return <FileExplorerSkeleton />
  }

  if (isSearching && searching) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-micro text-[color:var(--text-muted)]">
        <Spinner size={12} />
        <span role="status">Searching…</span>
      </div>
    )
  }

  if (isSearching && activeRows.length === 0) {
    return <EmptyState density="list" title="No matching files" />
  }

  const banded = variant === 'banded'
  const cursorShown = Boolean(selectedPath && activeRows.some((row) => rowKeyOf(row.entry) === selectedPath))
  const showEmpty = !isSearching && !rootCollapsed && activeRows.length === 0

  return (
    <>
      <div
        ref={containerRef}
        tabIndex={0}
        role="tree"
        aria-label={ariaLabel ?? `Files in ${rootName}`}
        aria-activedescendant={cursorShown && selectedPath ? rowId(selectedPath) : undefined}
        // A selection pane: the tree's own selection drops to the resting tier
        // while the keyboard is driving another list on the surface
        // (assets/index.css, "Selection tiers").
        data-selection-pane="auto"
        title={searchDiagnosticsTitle}
        onKeyDown={(event) => void handleKeyDown(event)}
        onContextMenu={(event) => openContextMenu(event)}
        onMouseDown={beginBackgroundDragSelection}
        onDragOver={handleRootDragOver}
        onDragLeave={handleRootDragLeave}
        onDrop={handleRootDrop}
        // A banded tree sits in a scrolling column that would clip an outset
        // ring at its edges, so its ring is drawn inside.
        className={`flex min-h-full flex-col rounded-md px-1 py-1.5 outline-none ${
          banded ? 'focus-visible:focus-ring-inset' : 'focus-visible:focus-ring'
        } ${rootDropActive ? 'ring-1 ring-inset ring-[color:var(--accent-primary)]' : ''}`}
      >
        {/* The root row (owner 2026-09-05): the folder heads the tree and its
            chevron folds the whole of it. A search ignores the fold, since a
            search that returns nothing on purpose is a lie. A banded tree's
            band names the root instead. */}
        {banded ? null : (
          <FileTreeRootRow
            name={rootName}
            path={rootPath}
            expanded={isSearching || !rootCollapsed}
            onToggle={() => {
              if (!isSearching) setRootCollapsed((current) => !current)
              focusTree()
            }}
          />
        )}
        {showEmpty ? (
          <EmptyState
            density="list"
            title={source.kind === 'paths' ? (source.emptyTitle ?? 'No files') : 'This folder is empty'}
          />
        ) : null}
        <FileTreeRows
          ref={rowsHandleRef}
          rows={activeRows}
          scrollParent={scrollParentRef}
          rowKey={(row) => rowKeyOf(row.entry)}
          renderRow={({ entry, depth }) => {
            const key = rowKeyOf(entry)
            const isSelected = selectedPaths.has(key)
            const isFocused = key === selectedPath
            const isExpanded = isExpandedEntry(entry)
            const isRenaming = renameDraft ? rowKeyOf(renameDraft.entry) === key : false
            const isDropTarget = dropTargetPath === entry.path
            const decoration = rowDecoration?.(entry)
            const gitAppearance = decoration
              ? { badge: decoration.badge ?? null, textClass: decoration.nameClassName ?? '' }
              : getGitStatusAppearance(getEntryGitStatus(gitStatus, directoryStatus, entry))

            // The three cues, each on its own channel so none can overwrite
            // another: the declared role inks the FOLDER MARK, the wash paints
            // the ROW, and being ignored dims the ROW'S INK.
            const declaredRole = folderRoles ? resolveFolderRole(folderRoles, entry.path, rootPath) : null
            // isTestPath wants a path relative to the root — an absolute one
            // drags in the machine's own directory names, and a checkout living
            // under ~/testing would answer yes for every file in it.
            const isTestRow = !entry.isDir && isTestPath(entry.path.slice(rootPath.length))
            const wash = resolveRowWash(declaredRole, isTestRow)
            const ignored = isIgnored(entry.path)
            const trailMark = agentTrail.marks.get(normalizePathKey(entry.path))
            const agentMark = trailMark
              ? {
                  verb: trailMark.verb,
                  count: trailMark.count,
                  glyph: trailMark.here ? (
                    agentCharacters ? (
                      <AgentGlyph agentId={trailMark.here.agentId} state="working" />
                    ) : (
                      <WorkingMark label="Agent working" seed={trailMark.here.agentId} />
                    )
                  ) : undefined,
                }
              : null

            return (
              <FileTreeRow
                rowRef={(node) => {
                  rowRefs.current[key] = node
                }}
                id={rowId(key)}
                name={entry.name}
                isDir={entry.isDir}
                depth={depth}
                indentSteps={banded ? 0 : 1}
                expanded={isExpanded}
                loading={entry.isDir && slowFolderPaths.has(entry.path)}
                onToggleExpanded={() => {
                  if (!isSearching && !entry.gitDeleted) void toggleDirectory(entry)
                }}
                // A multi-selection has one cursor row and the rest: the cursor
                // takes the full-strength fill, its companions the resting tier —
                // the same two tokens a resting PANE uses, because the question
                // is the same one ("which of these is the keyboard on?").
                selection={isSelected ? (isFocused ? 'cursor' : 'companion') : null}
                dropTarget={isDropTarget}
                ignored={ignored}
                nameClassName={gitAppearance.textClass}
                badge={gitAppearance.badge}
                meta={decoration?.meta}
                title={decoration?.title ?? (entry.gitDeleted ? `${entry.name} was deleted` : undefined)}
                // A wash is a property of the file; selection is a state of the
                // keyboard. Selection wins, so the class comes off entirely.
                washClassName={isSelected || isDropTarget ? '' : rowWashClass(wash)}
                folderRole={entry.isDir ? (folderRoles?.[entry.path] ?? null) : null}
                agentMark={agentMark}
                // The tallest thing a row can hold is the 20px rename field,
                // which still clears the 20px content box the row leaves, so a
                // row being renamed does not push its siblings.
                nameSlot={isRenaming ? renderRenameInput(entry.isDir ? 'font-medium' : '') : undefined}
                data-file-explorer-row="true"
                // Read by the file-tree cue checks. The cues are colour and a
                // screenshot cannot assert on colour, so the row states what it
                // decided.
                data-row-wash={wash ?? undefined}
                data-row-ignored={ignored ? 'true' : undefined}
                draggable={!entry.gitDeleted && !isRenaming}
                onDragStart={(event) => handleDragStart(event, entry)}
                onDragOver={(event) => handleFolderDragOver(event, entry)}
                onDragLeave={(event) => handleFolderDragLeave(event, entry)}
                onDrop={(event) => handleFolderDrop(event, entry)}
                onDragEnd={handleDragEnd}
                onClick={(event) => {
                  if (isRenaming) return
                  if (completedDragSelectionRef.current) {
                    event.preventDefault()
                    return
                  }
                  // Where a click means "this one" to the host, a plain click
                  // activates: a file goes to the host, a folder opens or
                  // closes. A modifier click still builds a selection.
                  if (onActivateFile && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
                    void activateEntry(entry)
                    focusTree()
                    return
                  }
                  selectEntry(entry, event)
                  focusTree()
                }}
                onDoubleClick={() => {
                  if (isRenaming) return
                  if (onActivateFile) {
                    // The click already did the host's thing (and toggled a
                    // folder, which a second toggle would undo); the double
                    // click opens the file in an editor.
                    if (!entry.isDir && !entry.gitDeleted) onOpenFile(entry.path, entry.name)
                    return
                  }
                  if (entry.gitDeleted) {
                    selectOnlyEntry(entry)
                    focusTree()
                    return
                  }
                  void activateEntry(entry)
                  focusTree()
                }}
                onContextMenu={(event) => openContextMenu(event, entry)}
              />
            )
          }}
        />
      </div>
      {contextMenu ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel={contextMenu.entry ? `Actions for ${contextMenu.entry.name}` : 'File tree actions'}
          onClose={() => setContextMenu(null)}
          surfaceClassName="min-w-[214px]"
        >
          {contextMenu.canOpenPath ? (
            <MenuItem onClick={() => void runContextMenuCommand('open', contextMenu)}>Open</MenuItem>
          ) : null}
          {contextMenu.canOpenInBrowser ? (
            <MenuItem onClick={() => void runContextMenuCommand('open-in-browser', contextMenu)}>
              Open in browser
            </MenuItem>
          ) : null}
          {contextMenu.canOpenPath ? (
            <MenuItem onClick={() => void runContextMenuCommand('reveal-in-file-manager', contextMenu)}>
              Reveal in file manager
            </MenuItem>
          ) : null}
          {contextMenu.canViewGitDiff ? (
            <MenuItem onClick={() => void runContextMenuCommand('view-git-diff', contextMenu)}>View Git diff</MenuItem>
          ) : null}
          {contextMenu.folderRoleTarget ? (
            <MenuFlyoutItem label="Mark directory as" ariaLabel="Mark directory as" surfaceClassName="min-w-[196px]">
              {FOLDER_ROLE_ORDER.map((role) => (
                <MenuItem
                  key={role}
                  onClick={() => {
                    const target = contextMenu.folderRoleTarget
                    if (target && workspaceId) setFileExplorerFolderRole(workspaceId, target.path, role)
                    setContextMenu(null)
                  }}
                >
                  {FOLDER_ROLE_LABEL[role]}
                </MenuItem>
              ))}
              {contextMenu.folderRoleTarget.role ? (
                <>
                  <MenuDivider />
                  <MenuItem
                    onClick={() => {
                      const target = contextMenu.folderRoleTarget
                      if (target && workspaceId) setFileExplorerFolderRole(workspaceId, target.path, null)
                      setContextMenu(null)
                    }}
                  >
                    Unmark
                  </MenuItem>
                </>
              ) : null}
            </MenuFlyoutItem>
          ) : null}
          {groupFileExplorerModuleActions(contextMenu.fileActions).map((group) =>
            group.actions.length === 1 && group.actions[0] ? (
              <MenuItem
                key={group.actions[0].id}
                disabled={group.actions[0].disabled}
                onClick={() => void runContextMenuCommand(`file-action:${group.actions[0].id}`, contextMenu)}
              >
                {group.actions[0].label}
              </MenuItem>
            ) : (
              <MenuFlyoutItem
                key={group.moduleId}
                label={group.heading}
                ariaLabel={group.heading}
                surfaceClassName="min-w-[196px]"
              >
                {group.actions.map((action) => (
                  <MenuItem
                    key={action.id}
                    disabled={action.disabled}
                    onClick={() => void runContextMenuCommand(`file-action:${action.id}`, contextMenu)}
                  >
                    {action.label}
                  </MenuItem>
                ))}
              </MenuFlyoutItem>
            ),
          )}
          {contextMenu.directoryToggle ? (
            <MenuItem
              onClick={() =>
                void runContextMenuCommand(
                  contextMenu.directoryToggle === 'collapse' ? 'collapse' : 'expand',
                  contextMenu,
                )
              }
            >
              {contextMenu.directoryToggle === 'collapse' ? 'Collapse' : 'Expand'}
            </MenuItem>
          ) : null}
          {contextMenu.entry ? <MenuDivider /> : null}
          <MenuItem onClick={() => void runContextMenuCommand('new-file', contextMenu)}>New file</MenuItem>
          <MenuItem onClick={() => void runContextMenuCommand('new-folder', contextMenu)}>New folder</MenuItem>
          <MenuDivider />
          {contextMenu.canUseSinglePathCommands ? (
            <MenuItem onClick={() => void runContextMenuCommand('copy', contextMenu)}>Copy</MenuItem>
          ) : null}
          <MenuItem disabled={!contextMenu.canPaste} onClick={() => void runContextMenuCommand('paste', contextMenu)}>
            Paste
          </MenuItem>
          {contextMenu.canUseSinglePathCommands ? (
            <MenuItem onClick={() => void runContextMenuCommand('rename', contextMenu)}>Rename</MenuItem>
          ) : null}
          {contextMenu.entry ? (
            <MenuItem
              variant="danger"
              disabled={!contextMenu.canDeletePath}
              onClick={() => void runContextMenuCommand('delete', contextMenu)}
            >
              {contextMenu.deleteLabel}
            </MenuItem>
          ) : null}
          <MenuDivider />
          <MenuItem onClick={() => void runContextMenuCommand('refresh', contextMenu)}>Refresh</MenuItem>
        </ContextMenu>
      ) : null}
    </>
  )
})

// Tree-shaped placeholder shown while the saved folder is being verified on
// disk. The staggered indents and chevron/icon/label rhythm match the resting
// tree so the check reads as a quiet load instead of a "Checking…" message.
const FILE_EXPLORER_SKELETON_ROWS: { indent: number; width: number }[] = [
  { indent: 0, width: 40 },
  { indent: 1, width: 52 },
  { indent: 2, width: 64 },
  { indent: 2, width: 44 },
  { indent: 3, width: 58 },
  { indent: 1, width: 48 },
  { indent: 2, width: 70 },
  { indent: 1, width: 56 },
]

function FileExplorerSkeleton(): JSX.Element {
  return (
    <div className="py-1">
      <span role="status" className="sr-only">
        Loading files…
      </span>
      <div aria-hidden="true">
        {FILE_EXPLORER_SKELETON_ROWS.map((row, index) => (
          <div
            key={index}
            className="flex items-center gap-1.5 py-1 pr-3"
            style={{ paddingLeft: 12 + row.indent * 14 }}
          >
            <Skeleton className="h-3.5 w-3.5 shrink-0 rounded bg-[color:var(--skeleton-shimmer-high)]" />
            <Skeleton
              className="h-3 rounded bg-[color:var(--skeleton-shimmer-high)]"
              style={{ width: `${row.width}%` }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

interface Props {
  workspaceId: string
}

export default function FileExplorer({ workspaceId }: Props) {
  const { folderPath, folderReadyPath, folderMissing, checkingFolder, recheckFolder } =
    useWorkspaceFolderStatus(workspaceId)
  const setFolderPath = useWorkspaceStore((s) => s.setFolderPath)
  const activeFilePath = useWorkspaceStore(
    (s) => s.workspaces.find((workspace) => workspace.id === workspaceId)?.editorState?.activeFilePath ?? null,
  )
  const [query, setQuery] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [revealToken, setRevealToken] = useState(0)
  // An explicit reveal target from outside the panel (the terminal link chooser).
  // Takes precedence over the active file for as long as it is set.
  const [externalRevealPath, setExternalRevealPath] = useState<string | null>(null)
  const [createRequest, setCreateRequest] = useState<CreateEntryRequest | null>(null)
  const { status: gitStatus, directoryStatus, refresh: refreshGitStatus } = useGitStatus(folderReadyPath)
  const canRevealActiveFile = Boolean(
    folderReadyPath && activeFilePath && isPathOrChild(activeFilePath, folderReadyPath),
  )

  const handleOpen = async () => {
    const dir = await window.api.openDir()
    if (dir) {
      setFolderPath(workspaceId, dir)
      setQuery('')
    }
  }

  const handleOpenFile = async (path: string, name: string) => {
    let content = ''
    if (!isImageFile(path || name)) {
      try {
        content = await window.api.readfile(path)
      } catch {
        content = ''
      }
    }
    // Routes to the external editor pop-up or a workspace tab per the
    // openFilesInExternalWindow preference.
    openFileSurface({ workspaceId, path, name, content })
  }

  const requestCreateEntry = (kind: 'file' | 'dir') => {
    setCreateRequest({ kind, token: Date.now() })
  }

  const revealActiveFile = () => {
    if (!canRevealActiveFile) return
    setExternalRevealPath(null)
    setQuery('')
    setRevealToken((current) => current + 1)
  }

  // "Reveal in Files", dispatched by the terminal link chooser. The
  // panel is usually cold when that runs — the same click reveals it — so the
  // latch is drained on mount as well as handled live.
  useEffect(() => {
    // Wait for the root: the workspace folder resolves a tick after mount, and
    // draining the latch before then would discard the target for good (the
    // containment check below cannot pass without a root). Leaving it latched
    // means this effect picks it up when folderReadyPath lands.
    if (!folderReadyPath) return
    const reveal = (path: string) => {
      if (!isPathOrChild(path, folderReadyPath)) return
      setExternalRevealPath(path)
      setQuery('')
      setRevealToken((current) => current + 1)
    }
    const pending = consumePendingFileReveal(workspaceId)
    if (pending) reveal(pending)
    return subscribeFileReveal((detail) => {
      if (detail.workspaceId !== workspaceId) return
      consumePendingFileReveal(workspaceId)
      reveal(detail.path)
    })
  }, [folderReadyPath, workspaceId])

  // Land on the file that is already open when the panel mounts, so opening
  // Files after clicking a terminal link does not mean hunting the tree for a
  // path read off the screen. Once per mount, and only when nothing more
  // specific (an external reveal) has already claimed the tree — the tree does
  // NOT keep following the active file afterwards; that is what the toolbar's
  // Reveal button and the menu item are for.
  const didSyncActiveFileRef = useRef(false)
  useEffect(() => {
    if (didSyncActiveFileRef.current || !canRevealActiveFile) return
    didSyncActiveFileRef.current = true
    // revealToken only ever increments, so 0 means nothing has revealed on this
    // mount yet — a reveal already in flight keeps its target.
    setRevealToken((current) => (current === 0 ? 1 : current))
  }, [canRevealActiveFile])

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[color:var(--bg-surface)] text-[color:var(--text-default)]">
      {/*
       * The panel's one chrome row: search on the left, the four tree actions
       * on the right (owner, 2026-09-05).
       *
       * It used to be a PanelHeader titled with the folder name, the actions
       * in its overflow slot, and the search band on a second row below it.
       * The name now lives as the ROOT ROW of the tree, with its path beside
       * it — so the header was a band of chrome restating the first row of the
       * surface. Same ruling, same geometry as
       * the Git and Backlog panes' bands, so the three pane tabs start their
       * content level. With no folder ready there is nothing to search or act
       * on, and the empty state below carries the path.
       */}
      {folderReadyPath && (
        <div className="flex h-[36px] shrink-0 items-center gap-1 border-b border-[color:var(--border-default)] pl-2 pr-1.5">
          <div className="flex min-w-0 flex-1">
            <InboxSearchInput value={query} onChange={setQuery} ariaLabel="Search files" placeholder="Search files…" />
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Tooltip content="New file" placement="bottom">
              <IconButton aria-label="New file" onClick={() => requestCreateEntry('file')}>
                <NewFileIcon />
              </IconButton>
            </Tooltip>
            <Tooltip content="New folder" placement="bottom">
              <IconButton aria-label="New folder" onClick={() => requestCreateEntry('dir')}>
                <NewFolderIcon />
              </IconButton>
            </Tooltip>
            <Tooltip
              content={canRevealActiveFile ? 'Reveal active file' : 'No active file to reveal'}
              placement="bottom"
            >
              <IconButton aria-label="Reveal active file" onClick={revealActiveFile} disabled={!canRevealActiveFile}>
                <RevealActiveFileIcon />
              </IconButton>
            </Tooltip>
            <Tooltip content="Refresh files" placement="bottom">
              <IconButton
                aria-label="Refresh files"
                onClick={() => {
                  setRefreshToken((current) => current + 1)
                  void refreshGitStatus()
                }}
              >
                <RefreshFilesIcon />
              </IconButton>
            </Tooltip>
          </div>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {folderReadyPath ? (
          <FileExplorerTree
            scrollParentRef={scrollRef}
            workspaceId={workspaceId}
            persistence="workspace"
            rootPath={folderReadyPath}
            query={query}
            refreshToken={refreshToken}
            revealPath={externalRevealPath ?? (canRevealActiveFile ? activeFilePath : null)}
            revealToken={revealToken}
            createRequest={createRequest}
            gitStatus={gitStatus}
            directoryStatus={directoryStatus}
            refreshGitStatus={refreshGitStatus}
            onOpenFile={handleOpenFile}
          />
        ) : checkingFolder ? (
          <FileExplorerSkeleton />
        ) : folderMissing && folderPath ? (
          // The kit's empty state, with the view's one primary on Relink and the
          // retry as its outline sibling — not two hand-rolled buttons, one of
          // them an accent-tinted fourth variant and the other bordered in a
          // fill token (2026-09-02 audit).
          <EmptyState
            title="Saved folder is missing"
            body={<span className="block max-w-full truncate font-mono">{folderPath}</span>}
            action={
              <>
                <OutlineButton onClick={() => void recheckFolder()}>Retry</OutlineButton>
                <PrimaryButton onClick={handleOpen}>Relink</PrimaryButton>
              </>
            }
          />
        ) : (
          <EmptyState title="No folder open" action={<PrimaryButton onClick={handleOpen}>Open folder</PrimaryButton>} />
        )}
      </div>
    </div>
  )
}
