import React, { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
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
  getEntryGitStatus,
  mergeGitDeletedEntries,
  parentDirectoriesForPath,
  pathSeparatorFor,
  type FileTreeEntry,
  type FileTreeRowModel,
} from '../../utils/fileTreeEntries'
import { useFileTreeModel } from '../../utils/fileTreeModel'
import { EmptyState } from '../ui/EmptyState'
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
// FileTree rows (ui/FileTree.tsx), which the editor window's tree renders too.
// What stays here is what only this tree does: rename, move, create, delete,
// drag, multi-select, search, folder roles, and the expanded set it persists
// for the workspace.
type Entry = FileTreeEntry
type TreeRow = FileTreeRowModel

type ExplorerClipboard = {
  path: string
  isDir: boolean
}

type RenameDraft = {
  entry: Entry
  value: string
}

type CreateEntryRequest = {
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

function remapPath(path: string, fromPath: string, toPath: string): string {
  if (path === fromPath) return toPath
  const separator = fromPath.includes('\\') && !fromPath.includes('/') ? '\\' : '/'
  const prefix = `${fromPath}${separator}`
  return path.startsWith(prefix) ? `${toPath}${path.slice(fromPath.length)}` : path
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
    Object.entries(expandedPaths).map(([key, value]) => [remapPath(key, fromPath, toPath), value]),
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

interface ExplorerTreeProps {
  workspaceId: string
  rootPath: string
  query: string
  refreshToken: number
  revealPath: string | null
  revealToken: number
  createRequest: CreateEntryRequest | null
  gitStatus: GitStatusSnapshot | null
  directoryStatus: Record<string, GitFileStatus>
  refreshGitStatus: () => Promise<void>
  onOpenFile: (path: string, name: string) => void
  /** The element the tree scrolls in: reveal and the windowed row list measure against it. */
  scrollParentRef: React.RefObject<HTMLDivElement | null>
}

function ExplorerTree({
  workspaceId,
  rootPath,
  query,
  refreshToken,
  revealPath,
  revealToken,
  createRequest,
  gitStatus,
  directoryStatus,
  refreshGitStatus,
  onOpenFile,
  scrollParentRef,
}: ExplorerTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rowsHandleRef = useRef<FileTreeRowsHandle>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const openFile = useWorkspaceStore((s) => s.openFile)
  const remapOpenFiles = useWorkspaceStore((s) => s.remapOpenFiles)
  const removeOpenFilesForPath = useWorkspaceStore((s) => s.removeOpenFilesForPath)
  const setFileExplorerExpandedPaths = useWorkspaceStore((s) => s.setFileExplorerExpandedPaths)
  const setFileExplorerSelectedPath = useWorkspaceStore((s) => s.setFileExplorerSelectedPath)
  const setFileExplorerFolderRole = useWorkspaceStore((s) => s.setFileExplorerFolderRole)
  // Subscribed rather than read from a ref: marking a folder has to repaint
  // the tree beneath it on the same tick.
  const folderRoles = useWorkspaceStore(
    (s) => s.workspaces.find((workspace) => workspace.id === workspaceId)?.fileExplorerState?.folderRoles,
  ) as FolderRoleMap | undefined
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  // Where the workspace's agents are working: the rows they are reading and
  // editing, and the closed folders on the way down to them.
  const agentTrail = useAgentFileTrail(workspaceId, rootPath)
  const agentCharacters = useWorkspaceStore((s) => s.appSettings.appearance.agentCharacters)
  const dialog = useConfirmDialog()
  const readPersistedExpandedPaths = useCallback(
    () =>
      useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === workspaceId)?.fileExplorerState
        ?.expandedPaths ?? EMPTY_EXPANDED_PATHS,
    [workspaceId],
  )
  const readPersistedSelectedPath = useCallback(
    () =>
      useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === workspaceId)?.fileExplorerState
        ?.selectedPath ?? null,
    [workspaceId],
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

  const isSearching = query.trim().length > 0
  const searchRows = useMemo(() => buildPathTreeRows(rootPath, searchResults), [rootPath, searchResults])
  const activeRows = isSearching ? searchRows : rootCollapsed ? EMPTY_TREE_ROWS : visibleRows
  const selectedEntries = useMemo(
    () => activeRows.filter((row) => selectedPaths.has(row.entry.path)).map((row) => row.entry),
    [activeRows, selectedPaths],
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

      const rangePaths = fileExplorerSelectionFromVerticalRange(
        activeRowsRef.current
          .map((row) => {
            const node = rowRefs.current[row.entry.path]
            if (!node) return null
            const rect = node.getBoundingClientRect()
            return { path: row.entry.path, top: rect.top, bottom: rect.bottom }
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
      setFileExplorerExpandedPaths(workspaceId, expandedPathListFromRecord(next))
    },
    [setFileExplorerExpandedPaths, workspaceId],
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
    selectionAnchorPathRef.current = entry.path
    setSelectedPath(entry.path)
    setSelectedPaths(new Set([entry.path]))
  }

  const selectEntryRange = (anchorPath: string, targetPath: string) => {
    const rangePaths = fileExplorerSelectionRange(
      activeRowsRef.current.map((row) => row.entry.path),
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
    setSelectedPath(entry.path)

    if (event?.shiftKey && selectionAnchorPathRef.current) {
      selectEntryRange(selectionAnchorPathRef.current, entry.path)
      return
    }

    if (event?.metaKey || event?.ctrlKey) {
      selectionAnchorPathRef.current = entry.path
      setSelectedPaths((current) => {
        const next = new Set(current)
        if (next.has(entry.path) && next.size > 1) {
          next.delete(entry.path)
        } else {
          next.add(entry.path)
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
        openFile(workspaceId, newPath, name, '')
        focusOrAddFileTab(workspaceId, newPath, name)
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
      remapOpenFiles(workspaceId, entry.path, nextPath)
      remapFileTabsForPath(workspaceId, entry.path, nextPath)

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
      topLevelEntries.forEach((entry) => {
        removeOpenFilesForPath(workspaceId, entry.path)
        removeFileTabsForPath(workspaceId, entry.path)
      })

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

    const dragEntries = topLevelEntries(
      (selectedPaths.has(entry.path) ? selectedEntries : [entry]).filter((selectedEntry) => !selectedEntry.gitDeleted),
    )
    if (!dragEntries.length) {
      event.preventDefault()
      return
    }

    const movePayload: ExplorerMovePayload = {
      version: 1,
      workspaceId,
      rootPath,
      entries: dragEntries,
    }
    activeMoveDragRef.current = movePayload
    setSelectedPath(entry.path)
    if (!selectedPaths.has(entry.path)) {
      selectionAnchorPathRef.current = entry.path
      setSelectedPaths(new Set([entry.path]))
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
    if (payload.workspaceId !== workspaceId) return null
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
        remapOpenFiles(workspaceId, entry.path, nextPath)
        remapFileTabsForPath(workspaceId, entry.path, nextPath)
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

  const handleFolderDragOver = (event: React.DragEvent<HTMLDivElement>, entry: Entry) => {
    if (!entry.isDir || entry.gitDeleted) return

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
    if (!entry.isDir || entry.gitDeleted) return

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

    const contextSelection = entry && selectedPaths.has(entry.path) ? selectedEntries : entry ? [entry] : []

    if (entry && !selectedPaths.has(entry.path)) {
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
    const fileActions = visibleFileExplorerModuleActions({
      actions: getRendererHost().getFileActions(),
      moduleEnabled: (moduleId) => selectModuleEnabled(moduleOverrides, moduleId),
      moduleLabel: fileActionModuleLabel,
      context: {
        workspaceId,
        workspaceRoot: rootPath,
        entries: contextSelection,
      },
    })
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
          ? expandedPaths[entry.path]
            ? 'collapse'
            : 'expand'
          : null,
      folderRoleTarget:
        isSingleSelection && entry?.isDir && canUsePathCommands
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
    if (command === 'open' && entry) return void activateEntry(entry)
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
        // repository is the one this tree's status was read against.
        openGitDiff({ workspaceId, repoRoot, focusPath: entry.path, scope })
      }
      return
    }
    if (command.startsWith('file-action:')) {
      const actionId = command.slice('file-action:'.length)
      const action = getRendererHost()
        .getFileActions()
        .find((candidate) => candidate.id === actionId)
      if (!action) return
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

    const startedAt = performance.now()
    const loadInitialTree = async () => {
      const entries = await loadDirectory(rootPath)
      if (cancelled) return

      const expandedDirectories = Object.keys(restoredExpandedPaths).filter((dirPath) => dirPath !== rootPath)
      const existingExpandedPaths = { ...restoredExpandedPaths }
      let loadedDirectoryCount = 1

      await Promise.all(
        expandedDirectories.map(async (dirPath) => {
          try {
            await loadDirectory(dirPath)
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
        const persistedSelectedPath = readPersistedSelectedPath()
        const restorePath =
          persistedSelectedPath && isPathOrChild(persistedSelectedPath, rootPath) ? persistedSelectedPath : firstPath
        setSelectedPath(restorePath)
        setSelectedPaths(restorePath ? new Set([restorePath]) : new Set())
        selectionAnchorPathRef.current = restorePath
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
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [commitExpandedPaths, loadDirectory, model, readPersistedExpandedPaths, readPersistedSelectedPath, rootPath])

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

  useEffect(() => {
    void refreshTree('git-status')
  }, [gitStatus?.updatedAt, refreshTree])

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
    const index = activeRows.findIndex((row) => row.entry.path === target)
    if (index < 0) return
    pendingScrollPathRef.current = null
    rowsHandleRef.current?.scrollToIndex(index)
  }, [activeRows])

  useEffect(() => {
    if (!activeRows.length) {
      if (!loading && !searching) {
        setSelectedPath(null)
        setSelectedPaths(new Set())
        selectionAnchorPathRef.current = null
      }
      return
    }

    if (!selectedPath || !activeRows.some((row) => row.entry.path === selectedPath)) {
      const firstPath = activeRows[0].entry.path
      setSelectedPath(firstPath)
      setSelectedPaths(new Set([firstPath]))
      selectionAnchorPathRef.current = firstPath
      return
    }

    const activePathSet = new Set(activeRows.map((row) => row.entry.path))
    setSelectedPaths((current) => {
      const next = new Set(Array.from(current).filter((path) => activePathSet.has(path)))
      return next.size ? next : new Set([selectedPath])
    })
  }, [activeRows, loading, searching, selectedPath])

  // Persist the focused selection so a reload/restart restores the highlighted
  // file. Debounced because arrow-key navigation changes it rapidly and every
  // store write re-serializes the whole workspace registry. The debounce timer
  // is what survives a Cmd-R reload (React unmount cleanups do not run on a page
  // reload) and still fires on a layer switch, which does not unmount; the
  // separate unmount effect flushes the latest value when the panel/workspace is
  // actually closed so a quick select-then-close is not lost.
  const latestSelectedPathRef = useRef(selectedPath)
  latestSelectedPathRef.current = selectedPath
  useEffect(() => {
    if (!hasRestoredSelectionRef.current) return
    const handle = window.setTimeout(() => {
      setFileExplorerSelectedPath(workspaceId, latestSelectedPathRef.current)
    }, 300)
    return () => window.clearTimeout(handle)
  }, [selectedPath, workspaceId, setFileExplorerSelectedPath])
  useEffect(() => {
    return () => {
      if (!hasRestoredSelectionRef.current) return
      setFileExplorerSelectedPath(workspaceId, latestSelectedPathRef.current)
    }
  }, [workspaceId, setFileExplorerSelectedPath])

  const handleKeyDown = async (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (renameDraft) return
    if (!activeRows.length) return

    const currentIndex = Math.max(
      activeRows.findIndex((row) => row.entry.path === selectedPath),
      0,
    )
    const currentEntry = activeRows[currentIndex].entry
    const moveSelection = (nextIndex: number) => {
      const nextRow = activeRows[nextIndex]
      setSelectedPath(nextRow.entry.path)
      // Keep the cursor in view — past the windowing threshold a row that is
      // off-screen is not mounted at all.
      rowsHandleRef.current?.scrollToIndex(nextIndex)

      if (event.shiftKey) {
        const anchorPath = selectionAnchorPathRef.current ?? currentEntry.path
        selectionAnchorPathRef.current = anchorPath
        selectEntryRange(anchorPath, nextRow.entry.path)
        return
      }

      selectionAnchorPathRef.current = nextRow.entry.path
      setSelectedPaths(new Set([nextRow.entry.path]))
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveSelection(Math.min(currentIndex + 1, activeRows.length - 1))
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveSelection(Math.max(currentIndex - 1, 0))
      return
    }

    if (!isSearching && event.key === 'ArrowRight') {
      event.preventDefault()
      if (currentEntry.isDir && !expandedPaths[currentEntry.path]) {
        await ensureDirectoryLoaded(currentEntry.path)
        setExpandedPaths((current) => ({ ...current, [currentEntry.path]: true }))
        return
      }
      if (currentEntry.isDir && expandedPaths[currentEntry.path]) {
        const nextRow = activeRows[currentIndex + 1]
        if (nextRow?.entry.parentPath === currentEntry.path) {
          setSelectedPath(nextRow.entry.path)
        }
      }
      return
    }

    if (!isSearching && event.key === 'ArrowLeft') {
      event.preventDefault()
      if (currentEntry.isDir && expandedPaths[currentEntry.path]) {
        setExpandedPaths((current) => ({ ...current, [currentEntry.path]: false }))
        return
      }
      const parentRow = activeRows.find((row) => row.entry.path === currentEntry.parentPath)
      if (parentRow) {
        setSelectedPath(parentRow.entry.path)
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

  // Three data states, three idioms (principles.md → Accessibility): loading is
  // the skeleton the panel already owns, a live search is the spinner with its
  // word, and an exhausted search is the kit's empty state — never a sentence in
  // disabled ink that reads the same whichever of the three it is.
  if (loading) {
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

  return (
    <>
      <div
        ref={containerRef}
        tabIndex={0}
        role="tree"
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
        className={`flex min-h-full flex-col rounded-md px-1 py-1.5 outline-none focus-visible:focus-ring ${
          rootDropActive ? 'ring-1 ring-inset ring-[color:var(--accent-primary)]' : ''
        }`}
      >
        {/* The root row (owner 2026-09-05): the folder heads the tree and its
            chevron folds the whole of it. A search ignores the fold, since a
            search that returns nothing on purpose is a lie. */}
        <FileTreeRootRow
          name={rootName}
          path={rootPath}
          expanded={isSearching || !rootCollapsed}
          onToggle={() => {
            if (!isSearching) setRootCollapsed((current) => !current)
            focusTree()
          }}
        />
        <FileTreeRows
          ref={rowsHandleRef}
          rows={activeRows}
          scrollParent={scrollParentRef}
          rowKey={(row) => row.entry.path}
          renderRow={({ entry, depth }) => {
            const isSelected = selectedPaths.has(entry.path)
            const isFocused = entry.path === selectedPath
            const isExpanded = entry.isDir && Boolean(isSearching || expandedPaths[entry.path])
            const isRenaming = renameDraft?.entry.path === entry.path
            const isDropTarget = dropTargetPath === entry.path
            const gitAppearance = getGitStatusAppearance(getEntryGitStatus(gitStatus, directoryStatus, entry))

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
                  rowRefs.current[entry.path] = node
                }}
                name={entry.name}
                isDir={entry.isDir}
                depth={depth}
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
                  selectEntry(entry, event)
                  focusTree()
                }}
                onDoubleClick={() => {
                  if (isRenaming) return
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
                    if (target) setFileExplorerFolderRole(workspaceId, target.path, role)
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
                      if (target) setFileExplorerFolderRole(workspaceId, target.path, null)
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
}

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
          <ExplorerTree
            scrollParentRef={scrollRef}
            workspaceId={workspaceId}
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
