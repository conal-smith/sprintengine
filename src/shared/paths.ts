/**
 * Canonical path helpers, shared by the renderer and the main process. No
 * Node `path` dependency — all functions work on user-visible workspace and
 * file paths that mix `/` and `\` separators.
 *
 * Relocated verbatim from `src/renderer/src/utils/paths.ts` when the main
 * process began needing the same normalisation; the renderer file remains as a
 * re-export shim, so every existing import site and test keeps working
 * unchanged.
 */

export function trimPath(pathValue: string): string {
  return pathValue.replace(/[\\/]+$/, '')
}

export function basename(pathValue: string): string {
  const parts = trimPath(pathValue)
    .split(/[\\/]+/)
    .filter(Boolean)
  return parts.at(-1) ?? pathValue
}

export function parentPath(pathValue: string): string {
  const trimmed = trimPath(pathValue)
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (index <= 0) return trimmed
  return trimmed.slice(0, index)
}

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return trimPath(a).toLowerCase() === trimPath(b).toLowerCase()
}

export function pathSeparatorFor(pathValue: string): '/' | '\\' {
  return pathValue.includes('\\') && !pathValue.includes('/') ? '\\' : '/'
}

/**
 * True when `pathValue` IS `parentPath`, or sits under it.
 *
 * The one containment check for user-visible paths: separator inferred from
 * the parent (so a Windows path compares on `\\` and a posix one on `/`), and
 * case-SENSITIVE — these are paths the app was handed, compared against paths
 * the app was handed, not paths it resolved. Four byte-identical copies of it
 * lived in `modelRegistry`, `editorBuffers`, `FileExplorer` and `agentsSlice`.
 *
 * Not the same predicate as the main process's `isPathInsideOrEqual`, which
 * resolves both sides through Node's `path` first; this one never touches the
 * filesystem or the cwd.
 */
export function isPathOrChild(pathValue: string, parentPath: string): boolean {
  if (pathValue === parentPath) return true
  return pathValue.startsWith(`${parentPath}${pathSeparatorFor(parentPath)}`)
}

export function pathJoin(basePath: string, ...segments: string[]): string {
  const separator = pathSeparatorFor(basePath)
  return [trimPath(basePath), ...segments.map((segment) => segment.replace(/^[\\/]+|[\\/]+$/g, ''))]
    .filter(Boolean)
    .join(separator)
}

export function joinFilePath(basePath: string, childPath: string): string {
  const separator = pathSeparatorFor(basePath)
  return `${trimPath(basePath)}${separator}${childPath.replace(/^[\\/]+/, '')}`
}

export function isAbsoluteFilePath(pathValue: string): boolean {
  return pathValue.startsWith('/') || pathValue.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(pathValue)
}

/**
 * A path as it should land on the clipboard: a Windows path (`C:\…`, `C:/…`,
 * `\\server\share\…`) with its own backslashes, anything else untouched. The
 * app keeps Windows paths with `/` in places (a join onto a relative path, git's
 * own output), and `C:/repo/src/a.ts` pasted into Explorer or a `cmd` prompt is
 * not a path there.
 */
export function clipboardPath(pathValue: string): string {
  if (!/^[A-Za-z]:[\\/]/.test(pathValue) && !pathValue.startsWith('\\\\')) return pathValue
  return pathValue.replace(/\//g, '\\')
}

/**
 * Lowercase alphanumeric slug with `-` separators and stripped boundary hyphens.
 * Returns an empty string if the value yields no slug content; callers add a fallback.
 */
export function slugify(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
