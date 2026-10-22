/**
 * Whether the person trusts a repository's own program settings: the programs
 * its repository-local git config names for git to run (a filter, a merge
 * driver, a diff converter, a hooks folder, an ssh command, a shell-command
 * credential helper). A repository whose config names none is never asked
 * about. One that does is asked once, with a banner on its project, and asked
 * again when those settings change.
 */
export type GitRepoTrustView = {
  /** The repository, as the answer is stored: its main checkout, or a bare repository's own folder. */
  repoPath: string
  /** The setting names, as git spells them (`filter.lfs.smudge`, `core.hookspath`). */
  settings: string[]
  /** Of those settings and their values; an answer is for this hash only. */
  hash: string
  /** The answer on record for this hash: trusted, set aside with Not now, or none yet. */
  decision: GitRepoTrustDecision | null
}

export type GitRepoTrustDecision = 'trusted' | 'dismissed'

/** The banner shows while the repository names programs and nobody answered for these settings. */
export function gitRepoTrustNeedsAnswer(view: GitRepoTrustView | null): view is GitRepoTrustView {
  return view !== null && view.settings.length > 0 && view.decision === null
}
