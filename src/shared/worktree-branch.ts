/**
 * The branch prefix Studio names its worktree branches with, and how a branch
 * is told to be one of them. Pure and string-only, shared by the renderer,
 * main and the server: the window names a New chat's branch with it, main
 * names a pool lease's and a launch's, and every rule that decides a branch is
 * Studio's for a chat's restore asks {@link isStudioBranch}. Deleting one asks
 * main's record of the branches Studio made instead (`worktree-branch-ledger.ts`),
 * since a person may name their own branches under the same prefix.
 *
 * The prefix is the person's (Settings ▸ Worktrees, kept in main's launch
 * settings). It was always `agent` before it could be chosen, so `agent/` is
 * recognised whatever the setting says: a chat started before a change is still
 * Studio's afterwards. An empty prefix names branches with no prefix at all,
 * and those cannot be told from a person's own by their name, so nothing is
 * recognised by it: only `agent/` stays Studio's.
 */

/** The prefix Studio's worktree branches had before it could be chosen, and still have by default. */
export const AGENT_BRANCH_PREFIX = 'agent'

/** The longest prefix kept: a namespace, not a sentence. */
const PREFIX_MAX_LENGTH = 64

/** What a new worktree is called in the setting's example. */
const EXAMPLE_SLUG = 'fix-login'

// What git check-ref-format refuses anywhere in a ref: ASCII control
// characters, space, `~ ^ : ? * [ \`, and DEL.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const ILLEGAL_CHARACTERS = /[\u0000- \u007f~^:?*[\\]+/gu

// A first component git reads as something other than a branch's namespace:
// `HEAD`, and the folders under `refs/` (`refs/heads`, `refs/tags`,
// `refs/remotes`). A branch `remotes/main` or `heads/main` makes those names
// mean two things, and git picks the other one. Compared without case, as a
// case-insensitive disk would.
const RESERVED_FIRST_COMPONENTS = new Set(['head', 'refs', 'heads', 'tags', 'remotes'])

// Remote names so common that a prefix spelled like one is warned about
// before any repository is asked: `origin/main` is the default branch.
const COMMON_REMOTES = new Set(['origin', 'upstream'])

/** One `/`-separated component of a prefix, made into one git accepts. */
function sanitizeComponent(raw: string): string {
  let component = raw
    .replace(/@\{/gu, '-')
    .replace(ILLEGAL_CHARACTERS, '-')
    .replace(/\.{2,}/gu, '.')
    .replace(/-{2,}/gu, '-')
    // No component begins with a dot, and a branch never begins with a dash.
    .replace(/^[.-]+/u, '')
  // Nor ends in `.lock` (git's own lock files) or a dot; `a.lock.` needs both.
  for (let previous = ''; previous !== component;) {
    previous = component
    component = component.replace(/\.+$/u, '').replace(/\.lock$/u, '')
  }
  return component
}

/**
 * The prefix as typed, made into one git accepts as the leading components of
 * a branch name: each `/`-separated component sanitized by git's
 * check-ref-format rules (no `..`, no leading `.` or `-`, no `.lock` or `.` at
 * its end, no space, control character or `~^:?*[\`), repeated `/` collapsed
 * and `/` trimmed from both ends, and a leading `HEAD`, `refs`, `heads`, `tags`
 * or `remotes` left out (`RESERVED_FIRST_COMPONENTS`). Empty means no prefix.
 * Case is kept: git's names are case-sensitive.
 *
 * A prefix named after one of a repository's remotes (`origin`) is kept here,
 * since remotes are per repository; making a worktree in a repository that
 * has such a remote is refused (`worktree-pool/slot-git.ts`).
 */
export function sanitizeWorktreeBranchPrefix(raw: string): string {
  const join = (value: string): string => {
    const components = value.split('/').map(sanitizeComponent).filter(Boolean)
    while (components.length > 0 && isReservedFirstComponent(components[0]!)) components.shift()
    return components.join('/')
  }
  const prefix = join(raw.trim())
  // Cut, then sanitized again: the cut may leave a component ending in `.`.
  return prefix.length > PREFIX_MAX_LENGTH ? join(prefix.slice(0, PREFIX_MAX_LENGTH)) : prefix
}

/**
 * What the setting's field says about a prefix as typed, or null: a leading
 * name git keeps for itself, which is left out, or a common remote's name,
 * which hides that remote's branches in any repository that has it.
 */
export function worktreeBranchPrefixWarning(raw: string): string | null {
  const first = raw
    .trim()
    .split('/')
    .find((component) => component.trim() !== '')
  if (!first) return null
  const name = first.trim()
  if (isReservedFirstComponent(name)) {
    return `“${name}” is a name git keeps for itself, so it is left out of the prefix.`
  }
  if (COMMON_REMOTES.has(name.toLowerCase())) {
    return `A branch under “${name}/” would hide the branches of a remote named ${name}, so a repository with one refuses worktrees with this prefix.`
  }
  return null
}

/** Whether `component`, a branch's first, is a name git keeps for itself (`HEAD`, `refs`, …). */
export function isReservedFirstComponent(component: string): boolean {
  return RESERVED_FIRST_COMPONENTS.has(component.toLowerCase())
}

/**
 * The remote among `remotes` that a branch's first component is named after,
 * compared without case, or null. `origin/main` made as a local branch is
 * read by git ahead of the remote's `origin/main`.
 */
export function remoteShadowedBy(branch: string, remotes: readonly string[]): string | null {
  if (!branch.includes('/')) return null
  const first = branch.split('/', 1)[0]!.toLowerCase()
  return remotes.find((remote) => remote.toLowerCase() === first) ?? null
}

/** The prefix a stored setting stands for: never chosen (`null`) reads as `agent`; empty is no prefix. */
export function effectiveWorktreeBranchPrefix(stored: string | null | undefined): string {
  return typeof stored === 'string' ? sanitizeWorktreeBranchPrefix(stored) : AGENT_BRANCH_PREFIX
}

/** The branch a worktree named `slug` is put on: `<prefix>/<slug>`, or `slug` alone with no prefix. */
export function worktreeBranchName(prefix: string, slug: string): string {
  const clean = sanitizeWorktreeBranchPrefix(prefix)
  return clean ? `${clean}/${slug}` : slug
}

/** The branch the setting's example names, for the line under its field. */
export function worktreeBranchExample(prefix: string): string {
  return worktreeBranchName(prefix, EXAMPLE_SLUG)
}

/** Whether `branch` is under `agent/`, the namespace every Studio branch had before the prefix could be chosen. */
export function isAgentNamespaceBranch(branch: string | null | undefined): boolean {
  const namespace = `${AGENT_BRANCH_PREFIX}/`
  return !!branch && branch.length > namespace.length && branch.startsWith(namespace)
}

/**
 * The namespaces a Studio branch starts with, each ending in `/`: the
 * configured prefix's, then `agent/`, once each. An empty prefix adds none.
 */
export function studioBranchPrefixes(prefix: string): string[] {
  const clean = sanitizeWorktreeBranchPrefix(prefix)
  const legacy = `${AGENT_BRANCH_PREFIX}/`
  return clean && `${clean}/` !== legacy ? [`${clean}/`, legacy] : [legacy]
}

/**
 * Whether `branch` looks like one Studio named for a worktree: under the
 * configured prefix or under `agent/`, with a name after it. A person may name
 * their own branches under the same prefix, so this is for what is safe to get
 * wrong (bringing a chat's worktree back); deleting a branch asks the record of
 * the branches Studio made (`worktree-branch-ledger.ts`) instead.
 */
export function isStudioBranch(branch: string | null | undefined, prefix: string): boolean {
  if (!branch) return false
  return studioBranchPrefixes(prefix).some(
    (namespace) => branch.length > namespace.length && branch.startsWith(namespace),
  )
}

/**
 * The branches that would stop git making `branch`: each of its parents
 * (`a`, `a/b` for `a/b/c`). Git keeps `a/b/c` as a file under the folders `a`
 * and `a/b`, so an existing branch by either name refuses it ("cannot lock
 * ref").
 */
export function branchNamespaceParents(branch: string): string[] {
  const components = branch.split('/')
  return components.slice(1).map((_, index) => components.slice(0, index + 1).join('/'))
}
