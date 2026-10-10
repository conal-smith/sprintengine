// Pure helpers extracted from WorkspaceManager.tsx. Workspace activity,
// session shaping, and sidebar ordering live here so the orchestrator stays
// focused on layout, IPC, and state coordination. Nothing in this module reaches into the store directly;
// every function takes its data via arguments.

import { cliForConversationProvider } from '../../../../shared/conversation-harness'
import { isProjectlessChatsRoot } from '../../../../shared/projectless-chats'
import { isStarred } from '../../utils/highlight'
import { findAgentSessionWorkspace, findAgentWorkspaceFollowingMoves } from '../../utils/agentLocation'
import { sortWorkspacesByUserMessage, workspaceLastUserMessageAt } from '../../utils/workspaceRecency'
import { workspaceProjectRoot } from '../../utils/workspaceWorktree'
import { deriveWorkspaceDisplayActivity, isLiveTerminal } from '../../hooks/useTerminalSessions'
import type { Workspace } from '../../types/workspace'
import type { SessionGroup, SessionItem } from './WorkspaceActions'
import type { ConversationSessionStatus, ConversationSessionSummary } from '../../../../shared/conversation-runtime'

export type WorkspaceActivity = 'needs-input' | 'working' | 'failed' | 'idle'
type SessionStatus = 'needs-input' | 'working' | 'idle' | 'failed'

// Honest per-session status for the session manager, from the session's
// lifecycle/hook phase (`session.agentState` — every agent carries one from
// birth; output-timing status inference was deleted, decision of record
// 2026-08-31). See backlog/2026-06-10-truthful-agent-activity.md.
export type SessionStatusInfo = {
  status: SessionStatus
  // Provenance of the signal: 'hook' when an authoritative lifecycle-hook frame
  // drove it, 'lifecycle' for a lifecycle stamp (spawn/watchdog/pty).
  source: AgentStateSource
  // When the current status began (ms epoch) — drives "active 2m" / "waiting 4m".
  activitySince: number
  // Most recent real activity (max of last output/input), for "idle · 12m" recency.
  lastActivityAt: number | null
  // Exit code when `status === 'failed'`, else null.
  exitCode: number | null
}

// Hook phases that mean the agent is actively doing work (not waiting, not done).
const WORKING_AGENT_PHASES: ReadonlySet<AgentPhase> = new Set(['starting', 'thinking', 'tool_use'])

// Attention-first ordering for session rows: things that need the user come
// first, idle last.
const SESSION_STATUS_ORDER: Record<SessionStatus, number> = {
  'needs-input': 0,
  failed: 1,
  working: 2,
  idle: 3,
}

function maxTimestamp(a: number | null, b: number | null): number | null {
  const values = [a, b].filter((value): value is number => typeof value === 'number')
  return values.length > 0 ? Math.max(...values) : null
}

function activityStartedAt(activity: SessionActivity): number {
  return activity.kind === 'working' || activity.kind === 'idle' ? activity.since : activity.at
}

// Single source of truth for "what is this session doing".
//
// Two different questions share this function. An AGENT session always carries
// an `agentState` from birth, so its status is read from the hook phase and the
// activity branch below is unreachable for it — agent state is hooks-only
// (decision of record 2026-08-31), and nothing here infers a phase from output.
// A PLAIN terminal has no agent state at all; its working/idle activity is
// terminal UX, which the inference deletion deliberately kept in scope, and
// that is the only thing the activity branch serves.
//
// The `source` a plain terminal reports is therefore a placeholder, not a claim
// about where its phase came from: it has no phase.
export function deriveSessionStatus(session: TerminalSessionSnapshot): SessionStatusInfo {
  const hook = session.agentState
  const source: AgentStateSource = hook?.source ?? 'lifecycle'
  const lastActivityAt = maxTimestamp(session.lastOutputAt, session.lastInputAt)
  const fallbackSince = activityStartedAt(session.activity)

  // A retained crash is terminal — surface it so it stops silently vanishing.
  if (session.activity.kind === 'failed') {
    return {
      status: 'failed',
      source,
      activitySince: session.activity.at,
      lastActivityAt,
      exitCode: session.activity.exitCode,
    }
  }

  // Needs-input: the authoritative hook phase. This is the most expensive state
  // to miss, so it outranks working/idle. It is gated on `processAlive` — a dead
  // agent's stale `awaiting_input` is not a live attention request.
  if (hook?.phase === 'awaiting_input' && session.processAlive) {
    return {
      status: 'needs-input',
      source,
      activitySince: hook.since,
      lastActivityAt,
      exitCode: null,
    }
  }

  // Working: trust the hook's working phases when present; otherwise fall back to
  // "produced output recently". `stalled`/`idle`/`exited` hook phases fall through
  // to idle below.
  //
  // Gated on `processAlive` for the same reason the needs-input check above
  // is, and it is the same stale frame: a session suspended (or killed) mid-turn
  // keeps the working phase and activity it had when its pty died, and nothing
  // revisits them. A paused agent is not working — it is not running at all.
  const working =
    session.processAlive && (hook ? WORKING_AGENT_PHASES.has(hook.phase) : session.activity.kind === 'working')
  if (working) {
    return {
      status: 'working',
      source,
      activitySince: hook ? hook.since : fallbackSince,
      lastActivityAt,
      exitCode: null,
    }
  }

  return {
    status: 'idle',
    source,
    activitySince: hook ? hook.since : fallbackSince,
    lastActivityAt,
    exitCode: null,
  }
}

// Conversation-agent status → session-manager vocabulary. `stopped` sessions
// drop out of the list entirely (null); a pending approval/question card is
// the conversation equivalent of an awaiting-input hook phase.
const CONVERSATION_SESSION_STATUS: Record<ConversationSessionStatus, SessionStatus | null> = {
  starting: 'working',
  ready: 'idle',
  active: 'working',
  awaiting_approval: 'needs-input',
  failed: 'failed',
  stopped: null,
}

// Readable names for sessions with no workspace.agents record (the Design
// a detached session uses a stable agent id, not a workspace agent).
// Shared with the wizard's session adapters so both transports label from
// one map.
function conversationAgentFallbackLabel(agentId: string): string {
  return agentId
}

// Attention-first comparator for rows within a workspace group: needs-input →
// failed → working → idle, then most-recently-active first within a tier.
export function compareSessionItemsByAttention(a: SessionItem, b: SessionItem): number {
  const byStatus = SESSION_STATUS_ORDER[a.status] - SESSION_STATUS_ORDER[b.status]
  if (byStatus !== 0) return byStatus
  const aRecency = a.lastActivityAt ?? a.activitySince
  const bRecency = b.lastActivityAt ?? b.activitySince
  return bRecency - aRecency
}

// Trigger-badge tone: the badge must not repeat the "everything is fine" lie.
// Warn when anything needs the user, error when anything crashed, else good.
export function sessionsAttentionTone(items: SessionItem[]): 'good' | 'warn' | 'error' {
  if (items.some((item) => item.status === 'needs-input')) return 'warn'
  if (items.some((item) => item.status === 'failed')) return 'error'
  return 'good'
}

export function getWorkspaceActivity(
  workspace: Workspace,
  terminalSessions: TerminalSessionSnapshot[],
): WorkspaceActivity {
  return deriveWorkspaceDisplayActivity(workspace.id, terminalSessions)
}

export function uniqueAgentName(baseName: string, agents: Workspace['agents']): string {
  const existingNames = new Set(Object.values(agents).map((agent) => agent.name))
  if (!existingNames.has(baseName)) return baseName

  let suffix = 2
  while (existingNames.has(`${baseName} ${suffix}`)) suffix += 1
  return `${baseName} ${suffix}`
}

function terminalSessionLabel(terminalId: string): string {
  if (terminalId.startsWith('git-')) return 'Git terminal'
  if (terminalId.startsWith('worktree-')) return 'Worktree terminal'
  return 'Terminal'
}

// Bucket label for a session whose workspaceId matches no workspace row and
// whose caller offered no better name.
const DETACHED_SESSION_LABEL = 'Other sessions'

type SessionItemOptions = {
  // Names the bucket a workspace-less session is listed under — the Reviews
  // integration recognises review ids and answers "Reviews". Returning null (or
  // omitting the hook) falls back to DETACHED_SESSION_LABEL; it never drops the
  // session.
  resolveDetachedLabel?: (workspaceId: string) => string | null
}

function workspaceSessionGroup(workspace: Workspace): SessionGroup {
  return { kind: 'workspace', id: workspace.id, label: workspace.name, workspace }
}

// The bucket for a session no workspace row claims. Keyed by LABEL rather than
// by the unmatched id, so several orphaned reviews read as one "Reviews" group
// instead of N identically-named ones.
function detachedSessionGroup(workspaceId: string | null, options: SessionItemOptions): SessionGroup {
  const label = (workspaceId ? options.resolveDetachedLabel?.(workspaceId) : null) ?? DETACHED_SESSION_LABEL
  return { kind: 'detached', id: `detached:${label}`, label }
}

export function getSessionItems(
  workspaces: Workspace[],
  terminalSessions: TerminalSessionSnapshot[],
  // Conversation (chat) agents have no PTY snapshot; their runtime session
  // summaries are a second, equally truthful status source.
  conversationSessions: readonly ConversationSessionSummary[] = [],
  options: SessionItemOptions = {},
): SessionItem[] {
  const conversationItems = conversationSessions.flatMap((summary): SessionItem[] => {
    const status = CONVERSATION_SESSION_STATUS[summary.status]
    if (!status) return []
    // A summary keyed to an id no workspace row claims (the review guide runs
    // under its review id, or its chat was closed) is NOT dropped — it lands in
    // a detached bucket. An agent the user cannot see is worse than an
    // oddly-grouped one. The runtime keys a conversation by its workspace, so
    // that workspace is the one it belongs to: agent ids recur across chats,
    // and a closed chat's `agent-1` is not the open chat's. An agent dragged to
    // another chat is followed there only by a minted id, which no other agent
    // shares.
    const workspace =
      findAgentWorkspaceFollowingMoves(workspaces, summary.agentId, summary.workspaceId) ??
      workspaces.find((candidate) => candidate.id === summary.workspaceId) ??
      null
    // A conversation session can outlive (or precede) its AgentState entry —
    // it must still be visible in the session manager, so the agent lookup is
    // a label source, not a gate.
    const agent = workspace?.agents[summary.agentId]
    return [
      {
        group: workspace ? workspaceSessionGroup(workspace) : detachedSessionGroup(summary.workspaceId, options),
        kind: 'agent',
        transport: 'conversation',
        agentId: summary.agentId,
        terminalId: null,
        label: agent?.name || conversationAgentFallbackLabel(summary.agentId),
        // A chat provider rides a CLI; wear that CLI's icon.
        cli: cliForConversationProvider(summary.providerId) ?? '',
        // The runtime session state is authoritative (it observes the provider
        // stream directly), so it reads as a hook-grade signal.
        status,
        source: 'hook',
        activitySince: summary.updatedAt,
        lastActivityAt: summary.updatedAt,
        exitCode: null,
        sessionId: summary.sessionId,
      },
    ]
  })

  // An agent can leave a stale PTY session behind and run again on the
  // conversation transport under the same agent id (both transports share one
  // agent id). The conversation summary is the current run — drop
  // the terminal twin instead of listing the agent twice. This is the one
  // remaining terminal-branch drop, and the agent it drops is still on screen:
  // its conversation row represents it.
  //
  // Twins are matched by the chat they belong to, not by the bucket they are
  // listed in: every closed chat shares the one "Other sessions" bucket, and two
  // closed chats' `agent-1`s are not twins.
  const conversationAgentKeys = new Set(
    conversationSessions
      .filter((summary) => CONVERSATION_SESSION_STATUS[summary.status])
      .map((summary) => `${summary.workspaceId} ${summary.agentId}`),
  )

  return terminalSessions
    .filter(
      // Live sessions, plus retained *failed* agent sessions so a crashed agent
      // demands attention instead of silently disappearing from the list. A
      // session with no usable workspaceId is NOT filtered here — it groups as
      // detached below.
      (session) => isLiveTerminal(session) || (session.kind === 'agent' && session.activity.kind === 'failed'),
    )
    .flatMap((session): SessionItem[] => {
      const workspaceId = typeof session.workspaceId === 'string' ? session.workspaceId : null
      // Agent terminals can be moved between workspaces after spawn, but the PTY
      // session keeps its spawn-time workspaceId. Resolve an agent's *current*
      // workspace by the agent record that owns this session, so a moved agent
      // does not open and mutate state in the workspace it left — and never by
      // its id alone, which recurs in every chat (`agent-1`): a closed chat's
      // session would otherwise group under an open chat's namesake.
      const workspace =
        (session.kind === 'agent' && session.agentId
          ? findAgentSessionWorkspace(workspaces, {
              agentId: session.agentId,
              sessionId: session.sessionId,
              workspaceId,
            })
          : null) ??
        (workspaceId ? workspaces.find((candidate) => candidate.id === workspaceId) : null) ??
        null
      // No workspace row claims this session (its workspace was closed, or it
      // was keyed to a door surface's id). It stays listed, under a bucket.
      const group = workspace ? workspaceSessionGroup(workspace) : detachedSessionGroup(workspaceId, options)

      if (session.kind === 'agent') {
        if (session.agentId && conversationAgentKeys.has(`${workspace?.id ?? workspaceId} ${session.agentId}`)) {
          return []
        }
        const agent = session.agentId ? workspace?.agents[session.agentId] : undefined
        const statusInfo = deriveSessionStatus(session)

        return [
          {
            group,
            kind: session.kind,
            transport: 'terminal',
            agentId: session.agentId ?? null,
            terminalId: null,
            // An agent spawned with only snapshot metadata has no
            // workspace.agents record — label from the snapshot's agentName
            // before falling back to the raw id, and to a plain noun when the
            // snapshot carries neither.
            label: agent?.name || session.agentName || session.agentId || 'Agent',
            cli: session.cli ?? agent?.cli ?? '',
            status: statusInfo.status,
            source: statusInfo.source,
            activitySince: statusInfo.activitySince,
            lastActivityAt: statusInfo.lastActivityAt,
            exitCode: statusInfo.exitCode,
            sessionId: session.sessionId,
          },
        ]
      }

      const terminalId = session.terminalId ?? session.sessionId.replace(/^terminal-/, '')
      // Plain terminals have no lifecycle hooks; their status is honest
      // output-recency (working while producing output, otherwise idle).
      const statusInfo = deriveSessionStatus(session)
      return [
        {
          group,
          kind: session.kind,
          transport: 'terminal',
          agentId: null,
          terminalId,
          label: terminalSessionLabel(terminalId),
          cli: session.cli ?? '',
          status: statusInfo.status,
          source: statusInfo.source,
          activitySince: statusInfo.activitySince,
          lastActivityAt: statusInfo.lastActivityAt,
          exitCode: statusInfo.exitCode,
          sessionId: session.sessionId,
        },
      ]
    })
    .concat(conversationItems)
}

// Session rows folded into the buckets the sessions popover renders: one entry
// per group, rows inside it attention-first. Real workspaces keep the sidebar's
// order; detached buckets trail every workspace, ordered by label among
// themselves, so a session with no workspace never displaces a real one.
export function groupSessionItems(
  items: SessionItem[],
  workspaceOrder: Map<string, number>,
): Array<{ group: SessionGroup; items: SessionItem[] }> {
  const groups = items.reduce<Array<{ group: SessionGroup; items: SessionItem[] }>>((acc, item) => {
    const bucket = acc.find((candidate) => candidate.group.id === item.group.id)
    if (bucket) bucket.items.push(item)
    else acc.push({ group: item.group, items: [item] })
    return acc
  }, [])
  for (const bucket of groups) bucket.items.sort(compareSessionItemsByAttention)
  return groups.sort((a, b) => {
    const aDetached = a.group.kind === 'detached'
    const bDetached = b.group.kind === 'detached'
    if (aDetached !== bDetached) return aDetached ? 1 : -1
    if (aDetached && bDetached) return a.group.label.localeCompare(b.group.label)
    return (
      (workspaceOrder.get(a.group.id) ?? Number.MAX_SAFE_INTEGER) -
      (workspaceOrder.get(b.group.id) ?? Number.MAX_SAFE_INTEGER)
    )
  })
}

/**
 * Reproduces the workspace grouping users see in the left sidebar so the
 * session manager dropdown matches: starred workspaces first, then folder
 * groups in first-occurrence order, with each workspace appearing exactly
 * once (a starred chat lives in the Starred section and is not also listed
 * under its project). Both the starred section and each folder's rows are
 * ordered by when the person last messaged each (`workspaceLastUserMessageAt`).
 *
 * That is now the whole order on both surfaces. The sidebar used to band its
 * rows by attention (blocked, just finished, running, at rest) on top of this
 * recency order, and the dropdown never could — the unseen-done mark is
 * sidebar-local session state with no home in the store, so the two surfaces
 * disagreed about where a row sat. The banding is gone (owner ruling
 * 2026-09-09: a finishing or blocked agent tints its row and never moves it),
 * so the sidebar and this dropdown now deal exactly the same order from
 * exactly the same clock.
 */
export function buildSidebarWorkspaceOrder(workspaces: Workspace[]): Map<string, number> {
  const order = new Map<string, number>()
  let index = 0

  const starred = workspaces.filter((workspace) => isStarred(workspace.highlight))
  for (const workspace of sortWorkspacesByUserMessage(starred)) order.set(workspace.id, index++)

  const seenFolders: string[] = []
  const folderBuckets = new Map<string, Workspace[]>()
  for (const workspace of workspaces) {
    if (isStarred(workspace.highlight)) continue
    // Grouped by the workspace's PROJECT, the same key the sidebar groups by, so
    // a worktree chat sits inside its parent's group here too instead of opening
    // a group of its own named after the worktree slug.
    const projectRoot = workspaceProjectRoot(workspace)
    const key = projectRoot ? projectRoot.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase() : '__no_folder__'
    if (!folderBuckets.has(key)) {
      seenFolders.push(key)
      folderBuckets.set(key, [])
    }
    folderBuckets.get(key)!.push(workspace)
  }
  for (const key of seenFolders) {
    const bucket = folderBuckets.get(key)!
    for (const workspace of sortWorkspacesByUserMessage(bucket)) {
      order.set(workspace.id, index++)
    }
  }
  return order
}

// getTerminalSessionsSignature moved to ../../hooks/useTerminalSessions to avoid
// an import cycle (the hook now uses it internally to dedupe no-op broadcasts).

// Whether the canvas draws "No workspace open" and its New chat button. Not
// under the New chat panel: the panel covers it, and the covered button was
// still a Tab stop and the covered title was still read aloud.
export function showsNoWorkspaceState(input: {
  railWorkspaceCount: number
  hasActiveWorkspace: boolean
  newChatPanelOpen: boolean
}): boolean {
  return input.railWorkspaceCount === 0 && !input.hasActiveWorkspace && !input.newChatPanelOpen
}

/**
 * New chat's project choices: one per project across `workspaces`, in the
 * order first met (rail order), each carrying when a chat in it was last
 * written to, so the picker can lead with the project used last.
 *
 * A chat in a worktree (a pool slot, `chat-…`) offers the project it was cut
 * from, never its worktree folder (owner, 2026-10-08): the folder is where the
 * chat runs, and offering it listed every pool slot as a project of its own.
 * The chats started without a project are not a project either: the picker
 * offers them as its own "No project" row.
 */
export function newChatProjectOptionsOf(
  workspaces: readonly Workspace[],
): Array<{ path: string; label: string; lastUsedAt: number }> {
  const byKey = new Map<string, { path: string; label: string; lastUsedAt: number }>()
  for (const workspace of workspaces) {
    const path = workspaceProjectRoot(workspace)?.trim()
    if (!path || isProjectlessChatsRoot(path)) continue
    const key = path.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
    const usedAt = workspaceLastUserMessageAt(workspace)
    const known = byKey.get(key)
    if (known) known.lastUsedAt = Math.max(known.lastUsedAt, usedAt)
    else byKey.set(key, { path, label: path.split(/[\\/]/).filter(Boolean).pop() ?? path, lastUsedAt: usedAt })
  }
  return [...byKey.values()]
}
