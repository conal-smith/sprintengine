/**
 * The branch prefix Studio names its worktree branches with, and how a branch
 * is told to be one of them. Pure and string-only, shared by the renderer,
 * main and the server: the window names a New chat's branch with it, main
 * names a pool lease's and a launch's, and every rule that decides a branch is
 * Studio's (the cleanup that deletes merged ones, a chat's restore) asks
 * {@link isStudioBranch}.
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
 * and `/` trimmed from both ends. Empty means no prefix. Case is kept: git's
 * names are case-sensitive.
 */
export function sanitizeWorktreeBranchPrefix(raw: string): string {
  const join = (value: string): string => value.split('/').map(sanitizeComponent).filter(Boolean).join('/')
  const prefix = join(raw.trim())
  // Cut, then sanitized again: the cut may leave a component ending in `.`.
  return prefix.length > PREFIX_MAX_LENGTH ? join(prefix.slice(0, PREFIX_MAX_LENGTH)) : prefix
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
 * Whether `branch` is one Studio named for a worktree: under the configured
 * prefix or under `agent/`, with a name after it. Nothing else is, so a rule
 * that deletes or restores Studio's branches never reaches a person's own.
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
