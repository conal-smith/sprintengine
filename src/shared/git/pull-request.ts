// A pull request as the app shows it on a conversation (backlog epic
// pull-request-marks, decisions 1–6). Three states and nothing else: a draft is
// an OPEN pull request with `isDraft` set, never a fourth state, and there is
// no "unknown" — the app draws a pull request only when it definitely has one.
//
// State comes from GitHub (through `gh`) or stays as last read. It is NEVER
// inferred from git ancestry: a rebase, a force push or a squash merge leaves
// no ancestor of the branch tip on main, so `merge-base --is-ancestor` would
// call a landed pull request open for ever (decision 8c). A pull request on
// another forge has no state the app can read: it is shown as opened.

import { classifyPullRequestUrl, type PullRequestForge } from './pr-url'
import type { PullRequestWatchView } from './pull-request-watch'
import { canonicalRepositoryKey } from '../repository-identity'

export type PullRequestState = 'open' | 'merged' | 'closed'

export type BranchPullRequest = {
  /** Canonical URL, as `classifyPullRequestUrl` (src/shared/git/pr-url.ts) normalises it. */
  url: string
  /**
   * The repository the pull request is IN — `host/owner/name`, the key every
   * clone of it shares (`canonicalRepositoryKey`). Not always the repository the
   * conversation sits in: an agent can open a pull request in another
   * repository, and the URL is what says where (decision 10).
   */
  repoKey: string
  /** The repository's short name, for the rows and tooltips that must say which repo. */
  repoName: string
  number: number
  title: string
  state: PullRequestState
  /** A draft is still `open`; this only changes the tooltip's word. */
  isDraft: boolean
  /** When its host says it was opened (until then, when it was recorded), ms epoch. */
  openedAt: number
  /** When `state` was last read from its host, ms epoch; 0 when it never has been. */
  stateAt: number
  /**
   * When it merged, or closed without merging, as GitHub says, ms epoch.
   * Absent while open, and on an entry read before this was kept. What says
   * whether the person went on with the chat after it landed, which decides
   * whether a merge settles the chat (`pullRequestsLanded`).
   */
  endedAt?: number
  /**
   * The forge the pull request is on, when it is not GitHub (GitHub Enterprise
   * included). The app reads a pull request's state through `gh` only, so one
   * on another forge is shown as opened, and its `state` stays `open`.
   */
  forge?: Exclude<PullRequestForge, 'github'>
  /**
   * The conversation that opened it (owner ruling 2026-10-04): its agent ran a
   * create command or tool whose output named this pull request, or called the
   * Studio gateway's `pull_request.link`. Written once, by the first
   * conversation to claim it, and never by a branch lookup. A record written
   * before the agent was known carries the workspace alone, and is worn by
   * every conversation in it.
   */
  openedByWorkspaceId?: string
  openedByAgentId?: string
  /** The branch the pull request is from, once its host has said; the record stamps `onSessionBranch` from it. */
  headRefName?: string
  /** The commit its head was at, from a branch lookup; never stored on the record. */
  headRefOid?: string
  /**
   * Set by the record's `forConversation` (`src/server/pull-requests/`): true
   * when this pull request is from the branch the conversation's own checkout
   * is on. A conversation may have opened pull requests from other branches
   * and other repositories, and only the ones from its own branch may say
   * anything about the state of that branch — the sidebar's "landed" reading
   * (the-diff-an-agent-made decision 10) reads this and nothing else. Absent
   * on any other entry and on a fixture-built snapshot.
   */
  onSessionBranch?: boolean
  /**
   * Present while the conversation's agent has Studio watching it
   * (`pull_request.watch`): what it waits on, as the last read left it. Set
   * by the record on what it answers, never stored on the entry itself.
   */
  watch?: PullRequestWatchView
}

/**
 * The tone a pull request's state inks with (decision 2): open takes the
 * accent because it is the one you can still act on; merged takes the violet
 * the run glyph already wears once a branch lands; closed takes the danger
 * red GitHub itself uses for a pull request that ended without landing.
 * Shape carries the state — the tone only agrees with it.
 */
export type PullRequestTone = 'accent' | 'merged' | 'error'

export function pullRequestTone(state: PullRequestState): PullRequestTone {
  if (state === 'merged') return 'merged'
  if (state === 'closed') return 'error'
  return 'accent'
}

/** The CSS custom property each tone resolves to, for callers that ink by class. */
export const PULL_REQUEST_TONE_VAR: Record<PullRequestTone, string> = {
  accent: 'var(--accent-primary)',
  merged: 'var(--tone-merged)',
  error: 'var(--tone-error)',
}

/** The word a tooltip or a spoken label uses for the state. */
export function pullRequestStateLabel(pr: Pick<BranchPullRequest, 'state' | 'isDraft' | 'forge'>): string {
  // A forge whose state the app cannot read: it is known to have been
  // opened, and nothing more is claimed.
  if (pr.forge) return 'opened'
  if (pr.state === 'merged') return 'merged'
  // "closed" alone reads as resolved; the mockup's wording says the work did
  // NOT land, which is the fact the red cross is drawing.
  if (pr.state === 'closed') return 'closed without merging'
  return pr.isDraft ? 'open, a draft' : 'open'
}

/** What clicking a pull request does, said in words: the forge's own name for GitHub, a browser for the rest. */
export function pullRequestOpenLabel(pr: Pick<BranchPullRequest, 'forge'>): string {
  return pr.forge ? 'Open it in the browser' : 'Open it on GitHub'
}

/**
 * The repository a pull request URL names, on any forge the classifier reads.
 * Built through the one URL classifier and the one repository canonicaliser,
 * so a pull request keys exactly the way a local clone of that repository does
 * and the two join up.
 */
export function pullRequestRepository(url: string): { repoKey: string; repoName: string } | null {
  const classified = classifyPullRequestUrl(url)
  if (!classified) return null
  const repoKey = canonicalRepositoryKey(classified.repositoryUrl)
  if (!repoKey) return null
  const segments = repoKey.split('/').filter((segment) => segment.length > 0)
  const name = segments[segments.length - 1]
  return name ? { repoKey, repoName: name } : null
}

/** The canonical URL for a pull request URL, or null when it is not one. */
export function canonicalPullRequestUrlOf(url: string): string | null {
  return classifyPullRequestUrl(url)?.url ?? null
}

function newestFirst(a: BranchPullRequest, b: BranchPullRequest): number {
  return b.openedAt - a.openedAt || b.number - a.number
}

/**
 * The one pull request a conversation wears (decision 5): the most recent one
 * that is still open, or the newest of all once every one has landed or
 * closed. `null` when there are none — and then nothing is drawn.
 */
export function primaryPullRequest(list: readonly BranchPullRequest[]): BranchPullRequest | null {
  if (list.length === 0) return null
  const sorted = [...list].sort(newestFirst)
  return sorted.find((pr) => pr.state === 'open') ?? sorted[0] ?? null
}

/**
 * The menu's groups (decision 6): open, merged, closed, newest first within
 * each. Callers omit empty groups.
 */
export function groupPullRequests(list: readonly BranchPullRequest[]): {
  open: BranchPullRequest[]
  merged: BranchPullRequest[]
  closed: BranchPullRequest[]
} {
  const sorted = [...list].sort(newestFirst)
  return {
    open: sorted.filter((pr) => pr.state === 'open'),
    merged: sorted.filter((pr) => pr.state === 'merged'),
    closed: sorted.filter((pr) => pr.state === 'closed'),
  }
}

/** Every pull request other than the primary, newest first — the tooltip's "Earlier:" lines. */
export function earlierPullRequests(list: readonly BranchPullRequest[]): BranchPullRequest[] {
  const primary = primaryPullRequest(list)
  return [...list].sort(newestFirst).filter((pr) => pr !== primary)
}
