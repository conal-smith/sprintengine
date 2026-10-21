// "Create patch from changes…" and "Copy as patch" (epic `git-commit-window`,
// T6; mockup 2522 panel 3).
//
// THE PATCH COMES FROM GIT, NOT FROM THE PANEL. The renderer knows which rows
// are selected and nothing else — it has no hunks, no blob contents, and no way
// to spell a rename. So the selection travels here as paths and `git diff`
// writes the patch, which is also what makes the result something `git apply`
// will actually take.
//
// TWO SIDES OF THE INDEX. `cached` picks `git diff --cached` (HEAD↔index) over
// `git diff` (index↔worktree), the same distinction the row's own diff opens
// on, so "create a patch from what I am about to commit" and "…from what I have
// not staged" are both sayable.
//
// UNTRACKED FILES ARE THE AWKWARD ONES. `git diff` cannot see a file git does
// not know about, and the fix people reach for — `git add -N` — writes to the
// index, which is not something a "copy this to the clipboard" action may do
// behind someone's back. `git diff --no-index /dev/null <file>` produces the
// same creation hunk without touching anything, and exits 1 by design when it
// finds a difference, so its stdout is taken on the failure path as well.

import { getGitStatus } from './git-status'
import { getRelativeGitPath, runGitCommand, toPathspec } from './git-utils'

export type GitPatchResult = {
  ok: boolean
  patch: string
  /** What to say when there is nothing to say — an empty selection, a clean
   *  file, a failure. Null when the patch is the whole answer. */
  message: string | null
}

/**
 * A person's own settings that would otherwise turn the output into something
 * `git apply` refuses: `diff.noprefix` and `diff.mnemonicPrefix` drop or
 * rename the `a/` `b/` prefixes `-p1` counts on, and `diff.external` or a
 * textconv filter replace the patch with a tool's rendering of it. The same
 * pins `git-hunks.ts` puts on the diffs it builds patches from.
 */
const PATCH_PINS = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--binary']

/**
 * The argv for the tracked half. Exported so the test can assert the command
 * rather than the output: `--` before the paths is what keeps a file named
 * `--cached` a file, `:(literal)` is what keeps a file named `[id].tsx` from
 * being read as a character class, and `--no-color` is what keeps ANSI escapes
 * out of a patch that has to survive `git apply`. The rest is `PATCH_PINS`.
 */
export function gitPatchArgs(relativePaths: string[], cached: boolean): string[] {
  return ['diff', ...(cached ? ['--cached'] : []), ...PATCH_PINS, '--', ...relativePaths.map(toPathspec)]
}

/**
 * The argv for one untracked file — a creation diff against nothing.
 *
 * No `:(literal)` here, and that is not an oversight: `--no-index` takes two
 * FILESYSTEM paths rather than pathspecs, and git answers a `:(literal)…`
 * argument with "Could not access". Being outside the pathspec world is also
 * what makes it safe — the name is opened, not matched.
 */
export function gitUntrackedPatchArgs(relativePath: string): string[] {
  return ['diff', '--no-index', ...PATCH_PINS, '--', '/dev/null', relativePath]
}

export async function createGitPatch(
  repoRoot: string,
  paths: string[],
  options: { cached?: boolean } = {},
): Promise<GitPatchResult> {
  const cached = options.cached === true
  const snapshot = await getGitStatus(repoRoot)
  const byPath = new Map(Object.values(snapshot.files).map((entry) => [entry.relativePath, entry]))
  const requested = paths.map((path) => getRelativeGitPath(repoRoot, path))
  const selected = requested.length > 0 ? requested : [...byPath.keys()]

  // Untracked means "git has never heard of it": `new` with nothing in the
  // index. A staged addition is tracked and `git diff --cached` shows it.
  const untracked = selected.filter((path) => {
    const entry = byPath.get(path)
    return Boolean(entry) && entry?.status === 'new' && !entry.staged
  })
  const tracked = selected.filter((path) => !untracked.includes(path))

  const chunks: string[] = []
  if (tracked.length > 0) {
    const result = await runGitCommand(repoRoot, gitPatchArgs(tracked, cached))
    if (!result.ok) return { ok: false, patch: '', message: result.message ?? 'Could not read the diff.' }
    if (result.stdout.trim()) chunks.push(result.stdout.replace(/\n*$/, '\n'))
  }

  // A staged patch is a patch of the index, and an untracked file is not in it.
  if (!cached) {
    for (const path of untracked) {
      const result = await runGitCommand(repoRoot, gitUntrackedPatchArgs(path))
      // Exit 1 is `--no-index`'s way of saying "they differ", which is the
      // whole point of asking. Only an empty stdout is a real failure.
      if (result.stdout.trim()) chunks.push(result.stdout.replace(/\n*$/, '\n'))
    }
  }

  if (chunks.length === 0) {
    return {
      ok: true,
      patch: '',
      message: cached ? 'Nothing staged in the selected files.' : 'No changes in the selected files.',
    }
  }
  return { ok: true, patch: chunks.join(''), message: null }
}

/** The name the save dialog opens on: the repository, the date, `.patch`. */
export function suggestedPatchFileName(repoRoot: string, now = new Date()): string {
  const name = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? 'changes'
  const slug =
    name
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'changes'
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return `${slug}-${stamp}.patch`
}
