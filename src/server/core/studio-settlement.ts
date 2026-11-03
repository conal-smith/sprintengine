import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import { conversationSessionWorking } from '../../shared/conversation/phase'
import type { BranchPullRequest } from '../../shared/git/pull-request'
import type { LifecycleState } from '../../shared/lifecycle-state'
import type { WorkspaceRegistryRecord } from '../../shared/workspace-registry'
import type { WorkspaceSyncState } from '../../shared/workspace-sync'
import type { SettledChatsSettings } from '../../shared/workspace-settlement'
import type { SweepDecision, SweepDecisionResult } from '../../main/automation/conversation-lifecycle'
import {
  createWorkspaceSettlementSweep,
  settlementSignals,
  type SettlementSignals,
  type SettlementTerminal,
} from '../../main/automation/workspace-settlement-sweep'

// Main's rest sweep, wired to what the core holds (studio-core.ts composes it):
// the registry, the chats, the shell's terminals, the pull request record, the
// Settled chats settings the windows push, and the module run states they
// push. The sweep decides; this says what it reads, when it looks, and what a
// settle it makes puts away.

/** The chat events after which a chat may read differently: work starting or ending, a question, a message. */
const SETTLEMENT_EVENTS: ReadonlySet<ConversationEvent['type']> = new Set([
  'user_message',
  'turn_started',
  'turn_completed',
  'turn_failed',
  'approval_requested',
  'approval_resolved',
  'subagent_status',
  'session_closed',
])

/** The run states a module may report for one of its chats. */
const LIFECYCLE_STATES: ReadonlySet<string> = new Set([
  'todo',
  'idea',
  'ready',
  'blocked',
  'in_progress',
  'paused',
  'needs_input',
  'done',
  'archived',
  'failed',
])

export type StudioSettlementDeps = {
  registry: {
    getRecords(): readonly WorkspaceRegistryRecord[]
    getRecord(workspaceId: string): WorkspaceRegistryRecord | null
    getState(): Pick<WorkspaceSyncState, 'activeWorkspaceId' | 'workspaceWindows'>
    subscribe(listener: () => void): () => void
  }
  conversations: {
    listSessions(input?: { workspaceId?: string }): { ok: true; sessions: ConversationSessionSummary[] } | { ok: false }
    onEvent(listener: (event: ConversationEvent) => void): () => void
    suspendSession(input: { sessionId: string }): Promise<unknown>
  }
  pullRequests: {
    whenLoaded(): Promise<void>
    forWorkspace(workspaceId: string): readonly BranchPullRequest[]
    onChanged(
      listener: (change: { workspaceIds: string[]; conversations: Array<{ workspaceId: string }> }) => void,
    ): () => void
  }
  settings: { get(): SettledChatsSettings; known(): boolean; subscribe(listener: () => void): () => void }
  terminals: {
    list(): readonly SettlementTerminal[]
    /** Whether the list has been read once (out of process the shell pushes it after the server starts). */
    listed(): boolean
    onChanged?(listener: () => void): () => void
    /** End the terminals main attributes to the workspace, where it holds them. */
    end?(workspaceId: string): void
  }
  lifecycle: { applySweepDecision(decision: SweepDecision): SweepDecisionResult }
  /**
   * Write an agent terminal's turn end to the chat's record. A window writes
   * the turn ends it sees; one main alone saw (no window open) would otherwise
   * go with the terminal when it exits, and the chat read as quiet and seen.
   */
  recordTurnEnd?(workspaceId: string, at: number): void
  onResume(listener: () => void): () => void
  now?: () => number
  schedule?: (job: () => void, ms: number) => () => void
  intervalMs?: number
  log?: (message: string) => void
}

export type StudioSettlement = ReturnType<typeof createStudioSettlement>

export function createStudioSettlement(deps: StudioSettlementDeps) {
  // The pull request record is read from disk once; until then "no pull
  // requests" is not known, and the rules that read them wait.
  let pullRequestsRead = false
  const pullRequestsOf = (workspaceId: string) =>
    pullRequestsRead ? deps.pullRequests.forWorkspace(workspaceId) : undefined
  // What the windows' module providers report for each module chat, as last
  // pushed. In memory: a run state is live news, and a restart's first window
  // pushes it again.
  const moduleRunStates = new Map<string, LifecycleState | null>()

  /** One reading of the chats and terminals, grouped by workspace, for a pass or a single question. */
  function live(): (record: WorkspaceRegistryRecord) => SettlementSignals {
    const listed = deps.conversations.listSessions()
    const chats = new Map<string, ConversationSessionSummary[]>()
    for (const session of listed.ok ? listed.sessions : []) {
      const list = chats.get(session.workspaceId)
      if (list) list.push(session)
      else chats.set(session.workspaceId, [session])
    }
    const terminals = new Map<string, SettlementTerminal[]>()
    for (const session of deps.terminals.list()) {
      if (!session.workspaceId) continue
      const list = terminals.get(session.workspaceId)
      if (list) list.push(session)
      else terminals.set(session.workspaceId, [session])
    }
    return (record) =>
      settlementSignals({
        record,
        conversations: chats.get(record.id) ?? [],
        terminals: terminals.get(record.id) ?? [],
        pullRequests: pullRequestsOf(record.id),
      })
  }

  const sweep = createWorkspaceSettlementSweep({
    records: () => deps.registry.getRecords(),
    record: (workspaceId) => deps.registry.getRecord(workspaceId),
    onScreen: () => {
      const state = deps.registry.getState()
      const ids = new Set<string>()
      for (const id of [state.activeWorkspaceId, ...state.workspaceWindows.map((window) => window.activeWorkspaceId)])
        if (id) ids.add(id)
      return ids
    },
    live,
    pullRequests: pullRequestsOf,
    settings: () => deps.settings.get(),
    // A module's chat reads the run state its type's provider reports in the
    // windows, which push it here; a type with no provider pushes none, and
    // its chats settle as any other. One no window has told this run about is
    // never settled on a guess.
    runState: (record) =>
      record.mode === 'standard'
        ? null
        : moduleRunStates.has(record.id)
          ? (moduleRunStates.get(record.id) ?? null)
          : 'in_progress',
    ready: () => deps.terminals.listed() && deps.settings.known(),
    commit: (decision) => deps.lifecycle.applySweepDecision(decision),
    // A resting chat holds no processes (owner ruling 2026-09-07). The window
    // that routes the row ends them too, as for a Settle from a phone; they
    // end here so nothing runs on with no window open.
    settled: (workspaceId) => {
      const listed = deps.conversations.listSessions({ workspaceId })
      for (const session of listed.ok ? listed.sessions : []) {
        if (session.status === 'stopped' || conversationSessionWorking(session)) continue
        void deps.conversations.suspendSession({ sessionId: session.sessionId }).catch(() => undefined)
      }
      deps.terminals.end?.(workspaceId)
    },
    now: deps.now ?? (() => Date.now()),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    ...(deps.intervalMs !== undefined ? { intervalMs: deps.intervalMs } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  })

  // A terminal's turn end the record has not heard, kept on the record: the
  // clock only moves forward, so a turn end already there writes nothing.
  function keepTurnEnds(): void {
    if (!deps.recordTurnEnd) return
    const latest = new Map<string, number>()
    for (const session of deps.terminals.list()) {
      const at = session.lastTurnEndedAt
      if (session.kind !== 'agent' || !session.workspaceId || typeof at !== 'number' || !Number.isFinite(at)) continue
      if (at > (latest.get(session.workspaceId) ?? -1)) latest.set(session.workspaceId, at)
    }
    for (const [workspaceId, at] of latest) {
      const record = deps.registry.getRecord(workspaceId)
      if (record && at > (record.lastTurnEndedAt ?? -1)) deps.recordTurnEnd(workspaceId, at)
    }
  }

  const stops: Array<() => void> = []
  let wasReady = false
  // The first moment both are known asks for every chat, rather than leaving
  // it to the next minute.
  const noteReady = () => {
    const ready = deps.terminals.listed() && deps.settings.known()
    if (ready && !wasReady) sweep.request()
    wasReady = ready
  }

  return {
    /**
     * Whether an agent in the workspace is at work, leaving out one stopped on
     * the person's answer: what a window's Settle and Snooze are held to.
     */
    isBusy(workspaceId: string): boolean {
      const record = deps.registry.getRecord(workspaceId)
      return record ? live()(record).busy : false
    },

    /** The windows' module run states, by workspace: a full reading that replaces the last. */
    setModuleRunStates(states: unknown): void {
      if (typeof states !== 'object' || states === null) return
      const next = new Map<string, LifecycleState | null>()
      for (const [workspaceId, state] of Object.entries(states as Record<string, unknown>)) {
        if (state === null) next.set(workspaceId, null)
        else if (typeof state === 'string' && LIFECYCLE_STATES.has(state))
          next.set(workspaceId, state as LifecycleState)
      }
      const moved = new Set<string>()
      for (const id of new Set([...moduleRunStates.keys(), ...next.keys()]))
        if (moduleRunStates.get(id) !== next.get(id) || moduleRunStates.has(id) !== next.has(id)) moved.add(id)
      moduleRunStates.clear()
      for (const [id, state] of next) moduleRunStates.set(id, state)
      if (moved.size > 0) sweep.request(moved)
    },

    start(): void {
      stops.push(
        // A chat starting work wakes at once; one finishing may be due.
        deps.conversations.onEvent((event) => {
          if (SETTLEMENT_EVENTS.has(event.type)) sweep.request([event.workspaceId])
        }),
        // A merge, a watch, a list read: the chats it names.
        deps.pullRequests.onChanged((change) =>
          sweep.request([...change.workspaceIds, ...change.conversations.map((key) => key.workspaceId)]),
        ),
        deps.registry.subscribe(() => sweep.noteRegistryChanged()),
        deps.settings.subscribe(() => {
          noteReady()
          sweep.request()
        }),
        // A timer stands still while the computer sleeps; waking reads the clock again.
        deps.onResume(() => sweep.request()),
      )
      if (deps.terminals.onChanged)
        stops.push(
          deps.terminals.onChanged(() => {
            noteReady()
            keepTurnEnds()
            sweep.noteTerminalsChanged(deps.terminals.list())
          }),
        )
      deps.pullRequests.whenLoaded().then(
        () => {
          pullRequestsRead = true
          sweep.request()
        },
        (error: unknown) => {
          // Read as never loaded: the keep for open pull requests holds every
          // chat, and nothing settles on a merge, until the next launch.
          deps.log?.(
            `The pull request record could not be read: ${error instanceof Error ? error.message : String(error)}`,
          )
        },
      )
      keepTurnEnds()
      sweep.start()
      wasReady = deps.terminals.listed() && deps.settings.known()
    },

    dispose(): void {
      for (const stop of stops.splice(0)) stop()
      sweep.dispose()
    },
  }
}
