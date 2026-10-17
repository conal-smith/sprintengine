import { basename, trimPath } from './paths'

// What a clicked terminal link offers, as pure data.
//
// Clicking a terminal link used to fire one hard-wired action: a file path went
// straight to `openFileSurface` (which itself picks an editor tab or a pop-out
// window from a sticky preference the user set months ago by dragging a tab out),
// and an http link went straight to the OS browser. Both were unilateral. Now the
// click opens a chooser, and this module is the chooser's decision — hookless and
// DOM-free so the ordering rules are testable without a renderer.
//
// The ordering rule: the lead item is the one the path IS. A Backlog item leads
// with "Open in Backlog", an HTML file with "Open in browser", anything else with
// "Open in editor". An action that cannot apply is ABSENT, never rendered greyed.

export type TerminalLinkTarget =
  | {
      kind: 'file'
      /** Absolute, already resolved against the execution/workspace root. */
      resolvedPath: string
      isDirectory: boolean
      /** Project root the path may be relative to; null when the workspace has no folder. */
      workspaceRoot: string | null
    }
  | { kind: 'url'; url: string }

export type TerminalLinkActionId =
  | 'open-backlog'
  | 'open-browser'
  | 'open-editor'
  | 'open-popout'
  | 'reveal-files'
  | 'reveal-system'
  | 'copy-path'
  | 'open-url'
  | 'copy-url'

export type TerminalLinkAction = {
  id: TerminalLinkActionId
  label: string
  /** Renders a MenuDivider above this item — one rule between "open" and "locate". */
  startsGroup?: boolean
}

const BACKLOG_PREFIX = 'backlog/'
// Files under backlog/mockups/ are attachments other items reference via
// `mockups:` frontmatter, not work items — BacklogPanel filters the directory out
// of its list, so revealing one there would select nothing. They take the HTML
// menu instead, which is what a mockup wants anyway.
const BACKLOG_MOCKUPS_PREFIX = 'backlog/mockups/'

function normalizeSeparators(pathValue: string): string {
  return pathValue.replace(/\\/gu, '/')
}

/**
 * The project-relative path of a file inside `root`, with `/` separators and no
 * leading slash. Null when the file is outside the root (or there is no root).
 * Case-insensitive on the root to match `samePath`, which the rest of the app
 * uses for workspace-folder comparisons.
 */
export function projectRelativePath(resolvedPath: string, root: string | null): string | null {
  if (!root) return null
  const normalizedRoot = trimPath(normalizeSeparators(root))
  const normalizedPath = normalizeSeparators(resolvedPath)
  if (!normalizedRoot) return null
  if (normalizedPath.length <= normalizedRoot.length) return null
  if (normalizedPath.slice(0, normalizedRoot.length).toLowerCase() !== normalizedRoot.toLowerCase()) {
    return null
  }
  // Guard the boundary so `/repo-two/x` never reads as relative to `/repo`.
  if (normalizedPath[normalizedRoot.length] !== '/') return null
  // A bare trailing separator leaves nothing behind — the root is not inside itself.
  return normalizedPath.slice(normalizedRoot.length + 1) || null
}

/**
 * The `backlog/…` path `dispatchBacklogReveal` needs, or null when this file is
 * not a Backlog item. Doubles as the `open-backlog` predicate: an item is a
 * markdown file directly under `backlog/` that is not a mockup attachment.
 */
export function backlogRelativePath(resolvedPath: string, root: string | null): string | null {
  const relativePath = projectRelativePath(resolvedPath, root)
  if (!relativePath) return null
  if (!relativePath.startsWith(BACKLOG_PREFIX)) return null
  if (relativePath.startsWith(BACKLOG_MOCKUPS_PREFIX)) return null
  if (!/\.md$/iu.test(relativePath)) return null
  return relativePath
}

export function isHtmlPath(resolvedPath: string): boolean {
  return /\.html?$/iu.test(basename(resolvedPath))
}

export type TerminalLinkMenuOptions = {
  /**
   * The system file manager's reveal, by the name the platform gives it
   * ("Reveal in Finder", "Show in Explorer"). Offered only where the path is
   * on this computer and the shell can open the file manager: a chat's file
   * on this disk, never a terminal's on an SSH machine or a browser tab's.
   */
  revealInSystemLabel?: string
}

/**
 * The ordered menu for a clicked link. Every list ends with the "locate" group
 * (`Reveal in Files`, the system file manager where offered, `Copy path`),
 * which is the only group a directory gets.
 */
export function terminalLinkActions(
  target: TerminalLinkTarget,
  options: TerminalLinkMenuOptions = {},
): TerminalLinkAction[] {
  if (target.kind === 'url') {
    return [
      { id: 'open-url', label: 'Open in browser' },
      { id: 'copy-url', label: 'Copy link' },
    ]
  }

  const locate: TerminalLinkAction[] = [
    { id: 'reveal-files', label: 'Reveal in Files', startsGroup: true },
    ...(options.revealInSystemLabel ? [{ id: 'reveal-system' as const, label: options.revealInSystemLabel }] : []),
    { id: 'copy-path', label: 'Copy path' },
  ]

  // A directory has no content to render — reveal and copy are all it can do.
  if (target.isDirectory) {
    return [{ ...locate[0], startsGroup: false }, ...locate.slice(1)]
  }

  const open: TerminalLinkAction[] = [
    { id: 'open-editor', label: 'Open in editor' },
    { id: 'open-popout', label: 'Open in pop-out window' },
  ]

  if (backlogRelativePath(target.resolvedPath, target.workspaceRoot)) {
    return [{ id: 'open-backlog', label: 'Open in Backlog' }, ...open, ...locate]
  }
  if (isHtmlPath(target.resolvedPath)) {
    return [{ id: 'open-browser', label: 'Open in browser' }, ...open, ...locate]
  }
  return [...open, ...locate]
}
