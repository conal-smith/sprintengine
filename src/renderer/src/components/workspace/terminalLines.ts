import type {
  ChangedFileCounts,
  TerminalSessionSnapshot,
  WorkspaceChangeSummary,
} from '../../../../shared/electron-api'
import { primaryPullRequest, type BranchPullRequest } from '../../../../shared/git/pull-request'
import { sessionRecencyOf } from '../../hooks/useTerminalSessions'
import type { Workspace } from '../../types/workspace'
import { resolveWorkspaceWorktree } from '../../utils/workspaceWorktree'
import { agentCheckoutOf, agentCheckoutProbePath } from './agentCheckout'
import type { RemoteSessionRow } from './remoteBand/remoteSessionsModel'
import { chatLineText } from './sidebar/conversationLines'
import { checkoutPathFor } from './useSidebarGitSummaries'
import type { PromptCacheReading } from '../../../../shared/prompt-cache'
import type { ConversationWireChanges } from '../../../../../packages/conversation-protocol/src/public'

// The sidebar row's terminal lines (sidebar-lists-every-terminal): one line
// per live terminal under the row's title — its CLI mark (whose tooltip
// names the terminal), the branch it is on (a worktree of its own drawn at
// full strength), the ± FILES that checkout carries, and how long it has
// worked or sat idle. The face-pile of heads and the single row-level branch
// are gone: the lines ARE the count, and each one says where IT is.
//
// Pure: sessions and summaries in, lines out. The view renders a line; the
// row decides how many to show.

/** Lines past this fold into one "+N more" line — a row never grows past the screen. */
export const MAX_TERMINAL_LINES = 4

/**
 * Whose changes a line's ± numbers are — the honesty contract the tooltip and
 * the spoken label are derived from, one value wider than git's own
 * ({@link WorkspaceChangeSummary}`.scope`):
 *
 * - `worktree` / `branch` / `folder` — the checkout's git reading, exactly as
 *   main's workspace-change-summary defines them: merge-base(branch, trunk) to
 *   the working tree, uncommitted included, or the folder's uncommitted changes
 *   where there is no branch to measure against.
 * - `landed` — the same checkout's UNCOMMITTED changes alone, shown once the
 *   conversation's primary pull request is merged (owner decision 2026-09-09,
 *   decision 2 of the sidebar-branch-diff ruling). A merge commit or a
 *   fast-forward moves the merge base and the span empties by itself; a SQUASH
 *   merge does not, and a branch whose work has landed must not keep reading
 *   +2000. Merged is only ever GitHub's word through the pull request record
 *   (epic `pull-request-marks`, decision 8c) — never inferred from ancestry.
 *
 * There is deliberately no per-agent scope here any more. The 2026-09-09
 * ruling "no git for a session that has a ledger" is REVERSED: the hook
 * ledger's cumulative tally counts work DONE (a line edited twice counts
 * twice, and work since undone is still in it), which is not what an
 * outstanding diff is. The ledger keeps its two homes — the conversation
 * peek's changed-files list and the agent's changelist — and the sidebar
 * number is what the branch still carries. Two agents on one branch showing
 * the same number is now the correct answer, not the bug it was read as.
 */
export type TerminalDiffScope = 'worktree' | 'branch' | 'folder' | 'landed'

/**
 * The numbers a line shows and what they are allowed to claim, from the two
 * readings that belong to the checkout: git's own span and the pull request
 * state main resolved for the conversation. Pure and exported so the rule can
 * be stated in a test in three lines.
 *
 * - No summary at all (an unresolved checkout, a path git could not be asked
 *   about) → zeros, `folder` scope, and NO file counts: exactly what the line
 *   drew before, and the row draws no chip for zeros anyway.
 * - The primary pull request (`primaryPullRequest`, decision 5 — the most
 *   recent one still OPEN, else the newest of all) is `merged` AND the summary
 *   carries `uncommitted` → the uncommitted numbers, `landed` scope.
 * - Anything else — an open or closed primary, no pull request at all, or a
 *   merged one whose `uncommitted` reading could not be taken → the span, at
 *   the scope git gave it. Never a confident zero: an unreadable reading
 *   degrades to the previous scope, not to 0.
 *
 * The primary rule is what makes a merged pull request followed by a NEW open
 * one go back to the span on its own: the open one becomes the primary.
 *
 * `files` rides beside the line counts and is what the line actually DRAWS
 * (owner decision 2026-09-09, decision 1): the summary numbers are files, and
 * lines survive only where a single file is in view — the hover card's per-file
 * rows and the diff viewer. It is null whenever the reading it belongs to
 * carries no breakdown: a summary from an older main, a span git could not be
 * read for, or the uncommitted reading a `landed` line switched to. Null draws
 * NOTHING; it never falls back to the line counts, because "+202" in a place
 * that means files would be a lie rather than a stale number.
 */
export function lineDiffOf(
  summary: WorkspaceChangeSummary | undefined,
  pullRequests: ReadonlyArray<BranchPullRequest>,
): {
  additions: number
  deletions: number
  changedFiles: number
  files: ChangedFileCounts | null
  scope: TerminalDiffScope
} {
  if (!summary) return { additions: 0, deletions: 0, changedFiles: 0, files: null, scope: 'folder' }
  // Only a pull request ON THIS CHECKOUT'S BRANCH may say the branch landed.
  // The session's list is a union that also carries pull requests on branches
  // the agent worked on in other repositories; the server stamps
  // `onSessionBranch` on the ones that belong to this branch, and a merged one
  // elsewhere must not read this branch as landed.
  const ownBranch = pullRequests.filter((pr) => pr.onSessionBranch === true)
  const landed = primaryPullRequest(ownBranch)?.state === 'merged'
  const uncommitted = summary.uncommitted
  if (landed && uncommitted) {
    return {
      additions: uncommitted.additions,
      deletions: uncommitted.deletions,
      changedFiles: uncommitted.changedFiles,
      // The landed line reads the UNCOMMITTED breakdown, never the span's: the
      // span is the whole feature a squash merge left behind, and pairing its
      // file counts with the uncommitted line counts would invent a reading
      // neither git call took.
      files: uncommitted.files ?? null,
      scope: 'landed',
    }
  }
  return {
    additions: summary.additions,
    deletions: summary.deletions,
    changedFiles: summary.changedFiles,
    files: summary.files ?? null,
    scope: summary.scope,
  }
}

/**
 * The two numbers a line draws, from the file breakdown: green is what the
 * checkout GAINED or reworked (added + updated), red is what it lost. Added and
 * updated are one number on the line and two in the words, because the line has
 * room for a glance and the tooltip has room for the answer.
 */
export function changedFileMarks(files: ChangedFileCounts): { plus: number; minus: number } {
  return { plus: files.added + files.updated, minus: files.removed }
}

/** How many files the breakdown covers — the summary's `changedFiles`, recomputed where only the breakdown is at hand. */
export function changedFilesTotal(files: ChangedFileCounts): number {
  return files.added + files.updated + files.removed
}

/**
 * The breakdown in words: "1 file added, 1 updated, 1 removed". A zero part is
 * left out entirely — "2 files updated, 1 removed" — and the noun rides the
 * first part that survives, pluralised by ITS count, so a single file never
 * reads as "1 files added".
 */
export function changedFilesPhrase(files: ChangedFileCounts): string {
  const present: Array<[number, string]> = (
    [
      [files.added, 'added'],
      [files.updated, 'updated'],
      [files.removed, 'removed'],
    ] as Array<[number, string]>
  ).filter(([count]) => count > 0)
  if (present.length === 0) return 'No files changed'
  return present
    .map(([count, verb], index) =>
      index === 0 ? `${count} file${count === 1 ? '' : 's'} ${verb}` : `${count} ${verb}`,
    )
    .join(', ')
}

/**
 * What a line's ± numbers are allowed to SAY, derived from the scope — the
 * tooltip on hover, the sentence a screen reader gets, and whether the numbers
 * step back. One place, so the two spellings can never drift apart.
 *
 * The words follow the sidebar's existing shape — the claim, an em dash, the
 * reason you may or may not believe it — and each names whose work it is: the
 * terminal, the branch, what is left after the branch landed, or nobody in
 * particular. The claim is now the FILE breakdown the line collapsed into two
 * numbers ("2 files added, 1 updated, 1 removed"), which is the whole point of
 * the hover: the line says how big, the tooltip says of what.
 *
 * `tooltip` and `srText` are one string by construction. They used to differ —
 * a phrase for the eye, a sentence for the ear — and the cost was two spellings
 * of the same numbers that could drift apart; the sentence reads correctly in
 * both places, so there is nothing left to drift.
 */
export function diffScopeCopy(line: Pick<TerminalLine, 'diffScope' | 'branch' | 'files' | 'pullRequests'>): {
  tooltip: string
  srText: string
  dim: boolean
} {
  // A line with no breakdown draws nothing, so these words are never seen; the
  // phrase still degrades to something true rather than to "undefined files".
  const claim = line.files ? changedFilesPhrase(line.files) : 'No files changed'
  const said = (clause: string, dim: boolean) => ({
    tooltip: `${claim} — ${clause}`,
    srText: `${claim} — ${clause}`,
    dim,
  })
  if (line.diffScope === 'landed') {
    // The one scope whose second clause is not a caveat but the REASON the
    // number shrank: the branch's span would still read the whole feature
    // after a squash merge, so the line switched to what the checkout still
    // carries. Naming the pull request is what makes that legible — "why is
    // this suddenly +3?" is answered on hover, not in the changelog. The
    // number is known only when the line carries the pull request it belongs
    // to; a line that lost the record still says the branch landed.
    // The same subset `lineDiffOf` decided on — the pull requests on THIS
    // branch — so the tooltip can never name a pull request the agent opened
    // in another repository as the reason this branch's number shrank.
    const primary = primaryPullRequest(line.pullRequests.filter((pr) => pr.onSessionBranch === true))
    const named = primary ? `pull request #${primary.number} was merged` : 'its pull request was merged'
    // Attributable work: it is what is still outstanding in this checkout, not
    // the repo's anonymous state, so it draws at full strength.
    return said(`uncommitted here since ${named}`, false)
  }
  if (line.diffScope === 'worktree') {
    return said('changed by this terminal, which has a worktree of its own', false)
  }
  if (line.diffScope === 'branch') {
    return said(
      `changed on ${line.branch ?? 'this branch'}; this terminal shares the checkout, so a person or another terminal may have made some of it`,
      false,
    )
  }
  // A folder reading is the repo's state, not this terminal's work: the numbers
  // are real but nobody can say who made them, so they step back.
  return said('uncommitted in this folder; this terminal has no branch of its own', true)
}

/**
 * The workspace header's branch chip, in the same words as the line beneath it
 * (owner decision 2026-09-09, decision 2). It names the branch, the agent whose
 * OWN worktree the chip is describing — the caller passes an agent only then,
 * because on a shared checkout there is no agent to credit — and the same file
 * breakdown the sidebar's line spells. Nothing here instructs the person: the
 * chip's job is to say what you are looking at, and "select another tab to
 * follow it" was a manual note taped to a fact.
 *
 * `spoken` is the clause the control's accessible name takes, comma-led so it
 * appends to whatever the control already calls itself.
 */
export function branchChipCopy(input: {
  branch: string | null
  agent: { name: string; runtime: string | null } | null
  files: ChangedFileCounts | null
}): { tooltip: string; spoken: string } {
  const branch = input.branch ?? 'Detached HEAD'
  const worktreeOf = input.agent
    ? `${input.agent.name}’s worktree${input.agent.runtime ? ` (${input.agent.runtime})` : ''}`
    : null
  // No breakdown, or a clean checkout: the chip says the branch and stops.
  const phrase = input.files && changedFilesTotal(input.files) > 0 ? changedFilesPhrase(input.files) : null
  return {
    tooltip: [worktreeOf ? `${branch} · ${worktreeOf}` : branch, phrase].filter(Boolean).join(' — '),
    spoken: `${worktreeOf ? `, ${worktreeOf}` : ''}${phrase ? `, ${phrase}` : ''}`,
  }
}

export type TerminalLine = {
  key: string
  kind: 'agent' | 'shell' | 'remote'
  cli: string | null
  /**
   * What the terminal is called — the mark's tooltip and accessible name, not
   * line text (owner ruling 2026-09-05); also the tie-break when lines sort.
   * Null when the row's title already names it (a remote band row).
   */
  name: string | null
  /** The machine a remote pane lives on; the glyph beside the name says so. */
  machineName: string | null
  /**
   * What a chat's line says after its mark, as a local chat line does: the
   * wait that needs a person, else the opening of the agent's last reply.
   * Absent for a terminal, whose line has no words of its own.
   */
  text?: string
  branch: string | null
  /** A linked worktree of the terminal's own: the branch reads at full strength. */
  worktree: boolean
  /** The observed directory, for hover: where the terminal sits, which may be a subdirectory. */
  cwd: string | null
  /** The observed directory no longer exists (a worktree pruned under the agent). */
  removed: boolean
  additions: number
  deletions: number
  /**
   * How many files the numbers cover, as the git summary counted them — the
   * span's files, or the uncommitted ones on a `landed` line. A line with no
   * summary to read, and a remote row whose wire shape carries no count, say 0.
   */
  changedFiles: number
  /**
   * What HAPPENED to those files — added, updated (a rename or a conflict is an
   * update), removed. This is what the line draws: `+{added + updated}` green,
   * `−{removed}` red, and the breakdown in words on hover.
   *
   * Null is the honest absence and it draws NOTHING: a summary from a main that
   * predates the breakdown, a span git could not be read for, a remote row whose
   * wire shape carries no counts yet. It never degrades to the line counts —
   * they are a different unit, and a "+202" where a person reads files is worse
   * than an empty space.
   */
  files: ChangedFileCounts | null
  diffScope: TerminalDiffScope
  /**
   * Subagents this session has running (`activeSubagents` on the snapshot).
   * Exposed for the renderer that will say "3 running"; nothing draws it yet,
   * so it is 0 for every line that is not a local agent session.
   */
  activeSubagents: number
  /**
   * The pull requests this conversation has, newest first — the union main
   * already resolves (`TerminalSessionSnapshot.pullRequests`, epic
   * `pull-request-marks` decision 10): the ones on its observed repo and branch
   * plus the ones it opened itself in any repository.
   *
   * Empty is the normal answer and the only one that means "draw nothing": a
   * lookup that could not be made, a plain shell, a branch GitHub says has no
   * pull request. There is no "unknown" mark (decision 3), so the list being
   * empty and the list being unknowable are one case here on purpose.
   */
  pullRequests: BranchPullRequest[]
  working: boolean
  workingSince: number | null
  needsInput: boolean
  failed: boolean
  idleSince: number | null
  /** Words for the idle time's sr-only sentence: "Idle", or "Paused" for a paused remote row. */
  idleLabel: string
  /**
   * The session's prompt cache, from its own status line: the line marks it in
   * the last minutes before it goes cold. Absent for a line with no local
   * session behind it (a remote pane, a paired machine's row).
   */
  promptCache?: PromptCacheReading | null
}

export type TerminalLinesWorkspace = Pick<
  Workspace,
  'folderPath' | 'worktree' | 'moduleState' | 'agents' | 'remoteOrigin'
>

function launchIntentOf(workspace: TerminalLinesWorkspace, session: TerminalSessionSnapshot) {
  const worktree = resolveWorkspaceWorktree(workspace)
  const agent = session.agentId ? workspace.agents?.[session.agentId] : undefined
  return {
    workspaceWorktree: worktree ? { gitRoot: worktree.gitRoot, branch: worktree.branch ?? null } : null,
    execution: agent?.execution ?? null,
  }
}

/**
 * The checkout a session's line reports on — the checkout git observed the
 * session in, else its launch intent, else the workspace's own — or null when
 * it sits somewhere that is not a checkout at all.
 */
export function sessionCheckoutPath(
  workspace: TerminalLinesWorkspace,
  session: TerminalSessionSnapshot,
): string | null {
  return agentCheckoutProbePath(
    agentCheckoutOf(session, launchIntentOf(workspace, session)),
    checkoutPathFor(workspace),
  )
}

/**
 * The distinct checkouts a row's live sessions sit on, for the git poll: two
 * agents on one checkout ask once, an agent in its own worktree asks for it.
 */
export function checkoutPathsOf(
  workspace: TerminalLinesWorkspace,
  sessions: ReadonlyArray<TerminalSessionSnapshot>,
): string[] {
  const paths = new Set<string>()
  for (const session of sessions) {
    const path = sessionCheckoutPath(workspace, session)
    if (path) paths.add(path)
  }
  return [...paths]
}

function recencyOf(session: TerminalSessionSnapshot) {
  const recency = sessionRecencyOf(session)
  return {
    working: session.activity.kind === 'working',
    workingSince: recency.workingSince,
    needsInput: recency.needsInput,
    failed: session.activity.kind === 'failed',
    idleSince: recency.idleSince,
    idleLabel: 'Idle',
  }
}

function lineOfSession(
  workspace: TerminalLinesWorkspace,
  session: TerminalSessionSnapshot,
  summaries: Record<string, WorkspaceChangeSummary>,
): TerminalLine {
  const checkout = agentCheckoutOf(session, launchIntentOf(workspace, session))
  const probePath = agentCheckoutProbePath(checkout, checkoutPathFor(workspace))
  const summary = probePath ? summaries[probePath] : undefined
  const agent = session.agentId ? workspace.agents?.[session.agentId] : undefined
  const isAgent = session.kind === 'agent'
  // The numbers are the CHECKOUT's, always (owner ruling 2026-09-09,
  // sidebar-branch-diff): the branch's diff from its merge base to the working
  // tree, or the folder's uncommitted changes where there is no branch — and
  // the checkout's uncommitted changes alone once the branch has landed. Two
  // agents on one branch therefore show the same number, which is the honest
  // answer: what is outstanding on that branch is one fact about the branch,
  // not two facts about two agents. The hook ledger is NOT consulted here any
  // more; it stays what it always measured — the work an agent did — on the
  // conversation peek's changed-files list and in its changelist.
  //
  // `session.pullRequests` is the same list the line's mark draws, straight off
  // main's snapshot, so `landed` needs no extra read: both the span and the
  // uncommitted reading are already in the summary the poll took, and the
  // moment main marks the primary pull request merged the sessions snapshot
  // re-renders this line and the numbers switch on that render. The
  // uncommitted reading itself is only as fresh as the last poll (≤ 60s,
  // useSidebarGitSummaries), which is the same freshness the span has always
  // had.
  const diff = lineDiffOf(summary, session.pullRequests ?? [])
  // Only a checkout names a branch; a folder, a removed directory or an
  // unverified path has none, and the summary (keyed by checkout) has none
  // for them either, so nothing is claimed.
  const checkoutBranch = checkout && (checkout.kind === 'worktree' || checkout.kind === 'main') ? checkout.branch : null
  return {
    key: session.sessionId,
    kind: isAgent ? 'agent' : 'shell',
    cli: session.cli ?? null,
    name: isAgent ? (agent?.name ?? session.agentName ?? 'Agent') : 'Terminal',
    machineName: null,
    branch: checkoutBranch ?? summary?.branch ?? null,
    worktree: checkout?.kind === 'worktree',
    cwd: checkout?.cwd ?? null,
    removed: checkout?.kind === 'missing',
    additions: diff.additions,
    deletions: diff.deletions,
    changedFiles: diff.changedFiles,
    files: diff.files,
    diffScope: diff.scope,
    activeSubagents: isAgent ? (session.activeSubagents ?? 0) : 0,
    // Straight off the snapshot: main owns which pull requests a session has
    // and how they were learned, and the line only draws what it is handed.
    // Absent on a fixture-built snapshot, and an absent answer is not an empty
    // one — but both draw nothing, which is what decision 3 asks for.
    pullRequests: session.pullRequests ?? [],
    ...recencyOf(session),
    promptCache: session.promptCache ?? null,
  }
}

/**
 * A mesh pane the layout mounts from another machine: its checkout is on
 * that machine's disk, so the only branch this side can name is the one a
 * remote-born workspace had stamped at its create; no ±lines are claimed.
 * No name either — the machine's name is the glyph's tooltip and accessible
 * name, never row text (owner ruling 2026-09-05), and the pane has no other.
 */
function lineOfMeshPane(
  workspace: TerminalLinesWorkspace,
  pane: { tabId: string; machineName: string; cli?: string },
): TerminalLine {
  return {
    key: pane.tabId,
    kind: 'remote',
    cli: pane.cli ?? null,
    name: null,
    machineName: pane.machineName,
    branch: workspace.remoteOrigin?.checkout?.branch ?? null,
    worktree: false,
    cwd: null,
    removed: false,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    files: null,
    diffScope: 'folder',
    activeSubagents: 0,
    // The pane's checkout is on another machine's disk and its pull requests
    // are that machine's to look up; this side has never asked.
    pullRequests: [],
    working: false,
    workingSince: null,
    needsInput: false,
    failed: false,
    idleSince: null,
    idleLabel: 'Idle',
  }
}

/**
 * One chat agent on a paired machine, as the line of its conversation's row.
 *
 * The name rides the line's mark tooltip, exactly as a local agent's does,
 * and the line says what a local chat's line says: its branch and pull
 * requests, then the wait, else the opening of the agent's last reply. The
 * conversation list carries no diff and no file breakdown, so a remote line
 * draws none rather than a confident zero.
 */
/**
 * A paired machine's count of a chat's files, read as `lineDiffOf` reads a
 * summary here: once the chat's own pull request has merged, what is left
 * uncommitted, and otherwise the branch's span. Null draws nothing, as for a
 * summary that could not be read.
 */
export function remoteFileCountsOf(
  changes: ConversationWireChanges | null,
  pullRequests: ReadonlyArray<BranchPullRequest>,
): { files: ChangedFileCounts; scope: TerminalDiffScope } | null {
  if (!changes) return null
  const { scope, uncommitted, ...files } = changes
  if (primaryPullRequest(pullRequests)?.state === 'merged' && uncommitted)
    return { files: uncommitted, scope: 'landed' }
  return { files, scope: scope ?? 'branch' }
}

export function lineOfRemoteRow(row: RemoteSessionRow): TerminalLine {
  const counted = remoteFileCountsOf(row.changes ?? null, row.pullRequests ?? [])
  return {
    key: row.sessionId,
    kind: 'remote',
    cli: row.cli,
    name: row.title,
    text: chatLineText(row.phase, { lastAssistantText: row.replyPreview }),
    machineName: null,
    // The branch its machine names for the chat's folder, which is on that
    // machine's disk: drawn as a local line draws its own, with no path to
    // hover, and its worktree mark where that machine says it is one.
    branch: row.branch ?? null,
    worktree: row.worktree === true,
    cwd: null,
    removed: false,
    // Files, never lines: the machine counts what happened to each file, as
    // the line here draws them, and lists no line counts.
    additions: 0,
    deletions: 0,
    changedFiles: counted ? changedFilesTotal(counted.files) : 0,
    files: counted?.files ?? null,
    diffScope: counted?.scope ?? 'folder',
    activeSubagents: 0,
    // The ones its machine's record holds: the lookup runs where the checkout
    // is, and that is the other machine, which names them in its list.
    pullRequests: row.pullRequests ?? [],
    working: row.activity === 'working',
    workingSince: row.activity === 'working' ? row.since : null,
    needsInput: row.activity === 'needs-input',
    failed: row.phase === 'failed',
    // Idle since the agent last finished, the clock a local chat's line
    // reads; a chat whose machine does not say counts from when it last moved.
    idleSince: row.activity === 'working' ? null : (row.lastTurnEndedAt ?? row.since),
    idleLabel: 'Idle',
  }
}

/** The moment a line last did anything, for ordering; a line that never said is oldest. */
function activityAt(line: TerminalLine, session?: TerminalSessionSnapshot): number {
  return Math.max(line.workingSince ?? 0, line.idleSince ?? 0, session?.lastOutputAt ?? 0, session?.lastInputAt ?? 0)
}

/**
 * A row's lines, in the order they show: the terminals doing something first,
 * then by how recently each did anything, remote panes (which never say) last.
 * Past {@link MAX_TERMINAL_LINES} the rest fold into `overflow`.
 *
 * No row-level aggregate: the sum of the ledgers that used to ride here
 * (`rowDiff`) went with the per-agent scope — nothing ever drew it, and
 * summing branch spans across the row's checkouts would double-count a branch
 * two of its agents share.
 */
export function terminalLinesOf(input: {
  workspace: TerminalLinesWorkspace
  sessions: ReadonlyArray<TerminalSessionSnapshot>
  meshPanes: ReadonlyArray<{ tabId: string; machineName: string; cli?: string }>
  summaries: Record<string, WorkspaceChangeSummary>
}): { lines: TerminalLine[]; overflow: number } {
  const ranked = [
    ...input.sessions.map((session) => {
      const line = lineOfSession(input.workspace, session, input.summaries)
      return { line, at: activityAt(line, session) }
    }),
    ...input.meshPanes.map((pane) => {
      const line = lineOfMeshPane(input.workspace, pane)
      return { line, at: activityAt(line) }
    }),
  ]
  ranked.sort((a, b) => {
    if (a.line.working !== b.line.working) return a.line.working ? -1 : 1
    if (a.at !== b.at) return b.at - a.at
    return (a.line.name ?? '').localeCompare(b.line.name ?? '')
  })
  const lines = ranked.map((entry) => entry.line)
  if (lines.length <= MAX_TERMINAL_LINES) return { lines, overflow: 0 }
  return { lines: lines.slice(0, MAX_TERMINAL_LINES), overflow: lines.length - MAX_TERMINAL_LINES }
}
