import type { GitFileStatus, GitStatusSnapshot } from '../../../../shared/electron-api'
import { normalizeChangelistPath, pathsOfChangelist, type Changelist } from '../../../../shared/git/changelists'

// One navigable entry in the diff viewer. A partially-staged file appears twice
// — once as its staged diff (HEAD↔index) and once as its unstaged diff
// (index↔worktree) — mirroring how the Git panel lists it in both groups.
export type DiffFileItem = {
  path: string
  relativePath: string
  status: GitFileStatus
  // 'branch' items come from a commit step rather than the working tree
  // (the-diff-an-agent-made / changed-files-and-commit-steps); their two sides
  // are revisions, carried on BranchDiffItem in branchSteps.ts.
  kind: 'staged' | 'unstaged' | 'branch'
}

// Builds the ordered changed-file list the viewer steps through. Order matches
// the Git panel: the staged group (sorted by relative path) followed by the
// unstaged group (sorted). Conflicted files are excluded — they keep the
// dedicated Resolve flow rather than opening in the diff viewer.
//
// `changelist` narrows the list to ONE changelist's files (agent changelists):
// the files it owns whole plus the files it owns a piece of, which is exactly
// `pathsOfChangelist` — a partially-owned file is a file you must be able to
// step to, or the hunks the list owns inside it are unreachable from a filtered
// window. Absent, nothing is filtered and this is the function it always was.
//
// Everything downstream stays the same: the order, the two kinds, the exclusion
// of conflicts. A filter that emptied the list is an EMPTY list, not a fallback
// to everything — the viewer says whose list it is and offers the way back
// (DiffViewer's filtered empty state), because silently showing all changes
// under a header that names an agent is the one answer nobody can read.
export function buildDiffFileList(
  status: GitStatusSnapshot | null,
  options?: { changelist?: Changelist | null },
): DiffFileItem[] {
  if (!status) return []
  const list = options?.changelist ?? null
  const owned = list ? new Set(pathsOfChangelist(list)) : null
  const entries = Object.values(status.files)
    .filter((entry) => entry.status !== 'conflicted')
    .filter((entry) => !owned || owned.has(normalizeChangelistPath(entry.relativePath)))
  // One collator for both lists; `localeCompare` would build one per comparison.
  const collator = new Intl.Collator()
  const byPath = (a: { relativePath: string }, b: { relativePath: string }): number =>
    collator.compare(a.relativePath, b.relativePath)

  const staged: DiffFileItem[] = entries
    .filter((entry) => entry.staged)
    .sort(byPath)
    .map((entry) => ({
      path: entry.path,
      relativePath: entry.relativePath,
      status: entry.status,
      kind: 'staged',
    }))

  const unstaged: DiffFileItem[] = entries
    .filter((entry) => entry.unstaged)
    .sort(byPath)
    .map((entry) => ({
      path: entry.path,
      relativePath: entry.relativePath,
      status: entry.status,
      kind: 'unstaged',
    }))

  return [...staged, ...unstaged]
}

// Finds the list index matching a focus request. Prefers an exact (path, kind)
// match, then any entry for that path so a stale focus SCOPE still lands
// somewhere sensible.
//
// A focus PATH that matches nothing answers -1, not the first entry. Every
// caller used to hand over a path taken from this very list, so the difference
// was unobservable; the conversation peek's changed-files list is the first
// caller whose path comes from somewhere else — an agent's own edit ledger,
// which can name a file in a different worktree, or one this checkout has
// since had committed away. Answering 0 there opened an UNRELATED file with no
// signal at all, which is worse than not moving. Callers already handle -1: the
// first open resolves it to the top of the list, and a later focus change stays
// where it is.
export function findDiffFocusIndex(
  items: DiffFileItem[],
  focusPath: string | null,
  focusKind: 'staged' | 'unstaged' | null,
): number {
  if (!focusPath) return items.length > 0 ? 0 : -1
  const normalized = focusPath.replace(/\\/g, '/').toLowerCase()
  const samePath = (item: DiffFileItem): boolean => item.path.replace(/\\/g, '/').toLowerCase() === normalized
  if (focusKind) {
    const exact = items.findIndex((item) => samePath(item) && item.kind === focusKind)
    if (exact >= 0) return exact
  }
  return items.findIndex(samePath)
}
