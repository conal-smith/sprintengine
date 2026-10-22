import { primaryPullRequest, type BranchPullRequest } from '../../../../shared/git/pull-request'
import type { Workspace } from '../../types/workspace'
import { workspaceProjectRoot } from '../../utils/workspaceWorktree'
import { folderDisplayName, remoteGroupDisplayName } from '../workspace/sidebar/folderGroups'

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
  const shown = chatPullRequestShown(pullRequests, query)
  return shown ? `#${shown.number}` : undefined
}

/** The pull request behind `chatPullRequestBadge`, for a row that draws its state as well as its number. */
export function chatPullRequestShown(
  pullRequests: readonly BranchPullRequest[],
  query: string,
): BranchPullRequest | null {
  if (pullRequests.length === 0) return null
  const normalized = query.trim().toLowerCase()
  const named = normalized
    ? pullRequests.find((pullRequest) =>
        pullRequestSearchTerms(pullRequest).some((term) => term.toLowerCase().includes(normalized)),
      )
    : undefined
  return named ?? primaryPullRequest(pullRequests.filter((pullRequest) => pullRequest.state !== 'closed'))
}

/**
 * Why a chat row is in the results when its title does not say: the pull
 * request whose title or number matched, the branch, or the folder — the
 * fields the row is searched by and never prints. Null when the title matched,
 * or nothing the row could show did (a workspace type's search terms).
 *
 * A search for "wave" listed two chats whose titles had no "wave" in them and
 * whose second line was their folder path: the match was in a pull request's
 * title, so the row looked wrong. The line under it now says where the word was.
 */
export function chatMatchReason(
  chat: { name: string; folderPath: string | null; pullRequests: readonly BranchPullRequest[]; branch: string | null },
  query: string,
): { kind: 'pull-request' | 'branch' | 'folder'; text: string } | null {
  const needle = query.trim().toLowerCase()
  if (!needle || chat.name.toLowerCase().includes(needle)) return null
  const pullRequest = chat.pullRequests.find((candidate) =>
    pullRequestSearchTerms(candidate).some((term) => term.toLowerCase().includes(needle)),
  )
  if (pullRequest) {
    // The title is what was matched when it holds the word; otherwise the
    // number or the URL did, and the number is the short way to say so.
    const title = pullRequest.title?.trim()
    return { kind: 'pull-request', text: title ? `#${pullRequest.number} ${title}` : `#${pullRequest.number}` }
  }
  if (chat.branch?.toLowerCase().includes(needle)) return { kind: 'branch', text: chat.branch }
  if (chat.folderPath?.toLowerCase().includes(needle)) return { kind: 'folder', text: chat.folderPath }
  return null
}

/**
 * The project a chat belongs to, named the way the sidebar's header names it:
 * the folder's own name, and for a worktree the project it was cut from — not
 * `pool-08`, which is a slot, not a place. A chat on another machine is named
 * by its folder there. Null for a chat with no folder, which belongs to no
 * project and says nothing by repeating so.
 */
export function chatProjectName(workspace: Workspace): string | null {
  if (workspace.remoteOrigin || workspace.environment) return remoteGroupDisplayName(workspace)
  const root = workspaceProjectRoot(workspace) ?? workspace.folderPath
  return root?.trim() ? folderDisplayName(root) : null
}
