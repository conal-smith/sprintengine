import { getGitEntry, normalizePathKey } from '../hooks/useGitStatus'
import { isPathOrChild } from './paths'

// The pure half of the file tree: what a row is, how a directory listing
// becomes rows, and how a path relates to the root it is shown under. Shared by
// the workspace pane's Files tree and the editor window's tree, so the two
// cannot disagree about sort order, indentation or which folders a reveal has
// to open.

export type FileTreeEntry = {
  name: string
  isDir: boolean
  path: string
  parentPath: string
  /** A file git reports as deleted: listed from the status, not from disk. */
  gitDeleted?: boolean
}

export type FileTreeRowModel = {
  entry: FileTreeEntry
  depth: number
}

export function pathSeparatorFor(path: string): '\\' | '/' {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

export function joinTreePath(parent: string, name: string): string {
  const separator = pathSeparatorFor(parent)
  return `${parent}${parent.endsWith(separator) ? '' : separator}${name}`
}

export function compareTreeEntries(a: FileTreeEntry, b: FileTreeEntry): number {
  return a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)
}

/** A raw listing as tree entries: folders first, then by name; `node_modules` never shown. */
export function toTreeEntries(raw: { name: string; isDir: boolean }[], parent: string): FileTreeEntry[] {
  return raw
    .map((entry) => ({
      name: entry.name,
      isDir: entry.isDir,
      path: joinTreePath(parent, entry.name),
      parentPath: parent,
    }))
    .filter((entry) => entry.name !== 'node_modules')
    .sort(compareTreeEntries)
}

export function isIgnoredTreeWatchPath(path: string): boolean {
  return path
    .split(/[/\\]+/)
    .filter(Boolean)
    .some((segment) => segment === 'node_modules')
}

/**
 * The folders between the root and a file, outermost first — exactly the
 * directories a reveal has to have listed before the file's row exists. Empty
 * for a path at the root or outside it.
 */
export function parentDirectoriesForPath(rootPath: string, filePath: string): string[] {
  if (!isPathOrChild(filePath, rootPath) || filePath === rootPath) return []

  const separator = pathSeparatorFor(rootPath)
  const trimmedRoot = rootPath.endsWith(separator) ? rootPath.slice(0, -1) : rootPath
  const relativePath = filePath.slice(trimmedRoot.length + separator.length)
  const segments = relativePath.split(/[/\\]/).filter(Boolean)
  const parentSegments = segments.slice(0, -1)

  return parentSegments.reduce<string[]>((directories, segment) => {
    const parent = directories.at(-1) ?? trimmedRoot
    directories.push(`${parent}${separator}${segment}`)
    return directories
  }, [])
}

export function relativeChildPath(parentPath: string, childPath: string): string | null {
  const normalizedParent = normalizePathKey(parentPath).replace(/\/+$/, '')
  const normalizedChild = normalizePathKey(childPath)
  if (normalizedChild === normalizedParent || !normalizedChild.startsWith(`${normalizedParent}/`)) return null
  return childPath.slice(normalizedParent.length + 1)
}

export function treeRelativePath(rootPath: string, filePath: string): string | null {
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedFile = filePath.replace(/\\/g, '/')
  const rootKey = normalizePathKey(normalizedRoot)
  const fileKey = normalizePathKey(normalizedFile)
  if (fileKey === rootKey || !fileKey.startsWith(`${rootKey}/`)) return null
  return normalizedFile.slice(normalizedRoot.length + 1)
}

/**
 * A listing plus the files git says were deleted from it. A deleted file is
 * gone from disk, so the listing alone would hide exactly the change the
 * person is most likely to be looking for.
 */
export function mergeGitDeletedEntries(
  entries: FileTreeEntry[],
  dirPath: string,
  gitStatus: GitStatusSnapshot | null,
): FileTreeEntry[] {
  if (!gitStatus) return entries

  let nextEntries: FileTreeEntry[] | null = null
  const seen = new Set(entries.map((entry) => normalizePathKey(entry.path)))

  Object.values(gitStatus.files).forEach((status) => {
    if (status.status !== 'deleted') return

    const relativePath = relativeChildPath(dirPath, status.path)
    if (!relativePath) return

    const separatorMatch = relativePath.match(/[\\/]/)
    const childName = separatorMatch ? relativePath.slice(0, separatorMatch.index) : relativePath
    const childPath = joinTreePath(dirPath, childName)
    const key = normalizePathKey(childPath)
    if (seen.has(key)) return

    seen.add(key)
    nextEntries ??= [...entries]
    nextEntries.push({
      name: childName,
      isDir: Boolean(separatorMatch),
      path: childPath,
      parentPath: dirPath,
      gitDeleted: true,
    })
  })

  // Untouched when nothing was added, so a memo keyed on the listing holds.
  return nextEntries ? (nextEntries as FileTreeEntry[]).sort(compareTreeEntries) : entries
}

/**
 * The visible rows: every entry at the root, and the children of every
 * expanded folder whose listing is in hand. A folder that is expanded but not
 * listed yet shows no children rather than a guess.
 */
export function flattenTree(
  entries: FileTreeEntry[],
  depth: number,
  expanded: Readonly<Record<string, boolean>>,
  childrenOf: (dirPath: string) => FileTreeEntry[] | undefined,
): FileTreeRowModel[] {
  const rows: FileTreeRowModel[] = []
  const visit = (level: FileTreeEntry[], levelDepth: number) => {
    for (const entry of level) {
      rows.push({ entry, depth: levelDepth })
      if (entry.isDir && expanded[entry.path]) {
        const children = childrenOf(entry.path)
        if (children) visit(children, levelDepth + 1)
      }
    }
  }
  visit(entries, depth)
  return rows
}

type PathTreeNode = {
  entry: FileTreeEntry
  children: Map<string, PathTreeNode>
}

/**
 * Rows for a set of files that were found rather than listed — a search's
 * results, or the changed files — with the folders between them and the root
 * synthesised so each file still sits under its path. Nothing is read from disk.
 */
export function buildPathTreeRows(rootPath: string, entries: FileTreeEntry[]): FileTreeRowModel[] {
  const separator = pathSeparatorFor(rootPath)
  const trimmedRoot = rootPath.endsWith(separator) ? rootPath.slice(0, -1) : rootPath
  const rootChildren = new Map<string, PathTreeNode>()

  const getOrCreateDirectory = (
    children: Map<string, PathTreeNode>,
    name: string,
    parentPath: string,
  ): PathTreeNode => {
    const path = `${parentPath}${separator}${name}`
    const existing = children.get(path)
    if (existing) return existing
    const node: PathTreeNode = { entry: { name, isDir: true, path, parentPath }, children: new Map() }
    children.set(path, node)
    return node
  }

  entries.forEach((entry) => {
    const relativePath = treeRelativePath(trimmedRoot, entry.path)
    const segments = relativePath ? relativePath.split('/').filter(Boolean) : []
    if (segments.length <= 1) {
      rootChildren.set(entry.path, { entry, children: new Map() })
      return
    }

    let parentPath = trimmedRoot
    let currentChildren = rootChildren
    segments.slice(0, -1).forEach((segment) => {
      const directory = getOrCreateDirectory(currentChildren, segment, parentPath)
      parentPath = directory.entry.path
      currentChildren = directory.children
    })
    currentChildren.set(entry.path, { entry: { ...entry, parentPath }, children: new Map() })
  })

  const rows: FileTreeRowModel[] = []
  const visit = (nodes: PathTreeNode[], depth: number) => {
    nodes
      .sort((a, b) => compareTreeEntries(a.entry, b.entry))
      .forEach((node) => {
        rows.push({ entry: node.entry, depth })
        if (node.entry.isDir) visit([...node.children.values()], depth + 1)
      })
  }

  visit([...rootChildren.values()], 0)
  return rows
}

/**
 * The changed files under a root, as entries — the "Changed files" view. Read
 * off the git status snapshot the tree already holds, so showing only what
 * changed never costs a scan of the tree.
 */
export function changedFileEntries(rootPath: string, gitStatus: GitStatusSnapshot | null): FileTreeEntry[] {
  if (!gitStatus) return []
  const entries: FileTreeEntry[] = []
  for (const status of Object.values(gitStatus.files)) {
    if (!isPathOrChild(status.path, rootPath) || status.path === rootPath) continue
    const name = status.path.split(/[/\\]/).filter(Boolean).pop()
    if (!name) continue
    const separator = pathSeparatorFor(status.path)
    const index = status.path.lastIndexOf(separator)
    entries.push({
      name,
      isDir: false,
      path: status.path,
      parentPath: index > 0 ? status.path.slice(0, index) : rootPath,
      ...(status.status === 'deleted' ? { gitDeleted: true } : {}),
    })
  }
  return entries
}

export function getDirectoryGitStatus(
  directoryStatus: Record<string, GitFileStatus>,
  dirPath: string,
): GitFileStatus | null {
  return directoryStatus[normalizePathKey(dirPath)] ?? null
}

export function getEntryGitStatus(
  gitStatus: GitStatusSnapshot | null,
  directoryStatus: Record<string, GitFileStatus>,
  entry: FileTreeEntry,
): GitFileStatus | null {
  if (entry.gitDeleted) return 'deleted'
  const exactStatus = getGitEntry(gitStatus, entry.path)?.status ?? null
  if (exactStatus) return exactStatus
  return entry.isDir ? getDirectoryGitStatus(directoryStatus, entry.path) : null
}

/** A path's folder and its last segment, for a row that shows a file with no tree around it. */
export function splitTreePath(path: string): { directory: string; name: string } {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (index < 0) return { directory: '', name: path }
  return { directory: index === 0 ? path.slice(0, 1) : path.slice(0, index), name: path.slice(index + 1) }
}

/**
 * Where a path is after `fromPath` was renamed or moved to `toPath`: the new
 * path for it or anything under it, the path itself otherwise.
 */
export function movedTreePath(path: string, fromPath: string, toPath: string): string {
  if (path === fromPath) return toPath
  const prefix = `${fromPath}${pathSeparatorFor(fromPath)}`
  return path.startsWith(prefix) ? `${toPath}${path.slice(fromPath.length)}` : path
}
