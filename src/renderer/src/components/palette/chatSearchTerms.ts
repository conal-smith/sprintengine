import { primaryPullRequest, type BranchPullRequest } from '../../../../shared/git/pull-request'
import type { Workspace } from '../../types/workspace'

// What a chat row in the palette can be found by beyond its title and folder:
// the pull requests the chat holds and the branch it works on. Someone coming
// back from a review knows "#482" or the branch name long after they have
// forgotten what the chat was called, and the sidebar already shows both, so
// the palette not finding them read as the search being broken.
//
// Pure, so the matching terms are asserted without rendering the palette.

/**
 * Every way a person might type a pull request: `#482`, `482`,
 * `acme/app#482`, the URL pasted from a browser, words from its title, and the
 * branch it is from when its host has said.
 */
export function pullRequestSearchTerms(pullRequest: BranchPullRequest): string[] {
  // `repoKey` is `host/owner/name`; a person types the part after the host.
  const slash = pullRequest.repoKey.indexOf('/')
  const ownerAndName = slash === -1 ? '' : pullRequest.repoKey.slice(slash + 1)
  const terms = [`#${pullRequest.number}`, String(pullRequest.number)]
  if (ownerAndName) terms.push(`${ownerAndName}#${pullRequest.number}`)
  terms.push(pullRequest.url)
  if (pullRequest.title) terms.push(pullRequest.title)
  if (pullRequest.headRefName) terms.push(pullRequest.headRefName)
  return terms
}

/**
 * The branch a chat is on that holds without a running process: the worktree
 * the app cut for it, or the checkout a remote create chose. A chat on the
 * project's own checkout has no branch of its own — the checkout's current
 * branch is a fact about the folder, not the chat — so it has none here.
 */
export function chatBranch(workspace: Pick<Workspace, 'worktree' | 'remoteOrigin'>): string | null {
  return workspace.worktree?.branch?.trim() || workspace.remoteOrigin?.checkout?.branch?.trim() || null
}

/** The extra match text for a chat row: its pull requests' terms and its branch. */
export function chatSearchKeywords(pullRequests: readonly BranchPullRequest[], branch: string | null): string {
  const terms = pullRequests.flatMap(pullRequestSearchTerms)
  if (branch) terms.push(branch)
  return terms.join(' ')
}

/**
 * A chat's pull requests from both places the sidebar reads them: the
 * conversation's record, and the marks its live sessions carry. One entry per
 * URL — a pull request the record holds is usually on a live session too.
 */
export function mergeChatPullRequests(
  recorded: readonly BranchPullRequest[] | undefined,
  live: readonly (readonly BranchPullRequest[] | undefined)[],
): BranchPullRequest[] {
  const byUrl = new Map<string, BranchPullRequest>()
  for (const pullRequest of recorded ?? []) byUrl.set(pullRequest.url, pullRequest)
  for (const list of live) {
    for (const pullRequest of list ?? []) if (!byUrl.has(pullRequest.url)) byUrl.set(pullRequest.url, pullRequest)
  }
  return [...byUrl.values()]
}

/**
 * Whether two lists search and badge the same. The live half arrives on every
 * terminal snapshot, so the palette keeps a chat's previous list while this
 * holds rather than rebuilding every row because an agent printed a line.
 */
export function sameChatPullRequests(a: readonly BranchPullRequest[], b: readonly BranchPullRequest[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (entry, i) =>
        entry.url === b[i].url &&
        entry.number === b[i].number &&
        entry.title === b[i].title &&
        entry.headRefName === b[i].headRefName &&
        entry.state === b[i].state &&
        entry.openedAt === b[i].openedAt,
    )
  )
}

/**
 * The `#N` a chat row wears: the pull request the query names when it names
 * one, so a search for `#482` shows `#482` even on a chat that holds several;
 * otherwise the one the sidebar's mark shows, which skips a closed one.
 */
export function chatPullRequestBadge(pullRequests: readonly BranchPullRequest[], query: string): string | undefined {
  if (pullRequests.length === 0) return undefined
  const normalized = query.trim().toLowerCase()
  const named = normalized
    ? pullRequests.find((pullRequest) =>
        pullRequestSearchTerms(pullRequest).some((term) => term.toLowerCase().includes(normalized)),
      )
    : undefined
  const shown = named ?? primaryPullRequest(pullRequests.filter((pullRequest) => pullRequest.state !== 'closed'))
  return shown ? `#${shown.number}` : undefined
}
