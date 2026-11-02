import type { ConversationSessionSummary } from '../../shared/conversation-runtime'
import {
  conversationPhaseWorking,
  conversationSummaryPhase,
  terminalAgentWorking,
} from '../../shared/conversation/phase'
import { watchedPullRequest, type BranchPullRequest } from '../../shared/git/pull-request'
import type { LifecycleState } from '../../shared/lifecycle-state'
import { finishedUnseen, workspaceLifecycleSnapshot } from '../../shared/workspace-lifecycle'
import type { WorkspaceRegistryRecord } from '../../shared/workspace-registry'
import { decideWorkspaceSettlement, type SettledChatsSettings } from '../../shared/workspace-settlement'
import { latestTurnEnd, type SweepDecision, type SweepDecisionResult } from './conversation-lifecycle'

// The rest sweep (settled-chats, 2026-09-07), run by main.
//
// A quiet chat with Auto-settle on settles into its folder's Settled shelf
// after its quiet days, or when its pull requests land; a resting chat whose
// agent works again wakes. The rules are shared (`shared/workspace-settlement.ts`);
// this decides when to apply them and what to apply them to.
//
// It ran in the renderer, in whichever window was showing the row, on the
// sidebar's relative-time tick. That made the decision depend on the window:
// a hidden window's tick stands still, so a decision taken on the next
// activity change stamped a stale `settledAt` and read a stale snooze wake; a
// row could be settled on a render's reading of the sessions and woken a beat
// later; and with every window closed nothing settled at all. Main holds the
// record, the chats, the agent terminals and the pull requests, so it decides
// here, with the clock read as each decision is taken.
//
// One pass runs at a time, over the chats asked about since the last one (or
// all of them). A trigger during a pass is not lost: it queues another pass
// after this one. Every decision goes to main's lifecycle as a command with the
// reading it was taken on (`applySweepDecision`), which refuses it if the chat
// has moved on, so a pass that decides on old news writes nothing. A pass that
// decides nothing writes nothing, so passes may run as often as triggers come.

/** How often every chat is looked at, beside the triggers: the quiet-days rule needs no finer clock. */
export const SETTLEMENT_SWEEP_INTERVAL_MS = 60_000

/** What only live state says about a chat: an agent at work in it, or something in it for the person. */
export type SettlementSignals = { busy: boolean; held: boolean }

/** The few fields of an agent terminal the sweep reads. */
export type SettlementTerminal = {
  kind?: string
  workspaceId?: string
  processAlive: boolean
  activity?: { kind: string }
  agentState?: { phase?: string }
}

/**
 * The sweep's reading of a chat's live state, the one the sidebar took:
 *
 *  - busy: an agent at work, which wakes a resting chat and keeps a quiet one
 *    from settling. A chat's turn starting or running, or an agent or monitor
 *    it launched still at work in the background; an agent terminal mid-turn
 *    in a live process. A plain shell printing is not work (`workspaceIsWorking`).
 *  - held: something in the chat for the person: an agent stopped on a
 *    question or an approval, a turn that finished after anyone last had the
 *    chat on screen (`finishedUnseen`, on the visit clock every device
 *    shares), or a pull request Studio watches for it. A thing to look at, not
 *    activity: it keeps a chat from settling, and wakes one the sweep settled.
 */
export function settlementSignals(input: {
  record: Pick<WorkspaceRegistryRecord, 'id' | 'lastTurnEndedAt' | 'lastVisitedAt'>
  conversations: readonly ConversationSessionSummary[]
  terminals: readonly SettlementTerminal[]
  pullRequests: readonly BranchPullRequest[] | undefined
}): SettlementSignals {
  const { record, conversations, terminals } = input
  const agents = terminals.filter((session) => session.kind === 'agent')
  const live = conversations.filter((session) => session.status !== 'stopped')
  const busy =
    agents.some(terminalAgentWorking) ||
    live.some(
      (session) => (session.backgroundAgents ?? 0) > 0 || conversationPhaseWorking(conversationSummaryPhase(session)),
    )
  const needsInput =
    agents.some((session) => session.processAlive && session.agentState?.phase === 'awaiting_input') ||
    live.some((session) => {
      const phase = conversationSummaryPhase(session)
      return phase === 'waiting_for_approval' || phase === 'waiting_for_input'
    })
  const unseen = finishedUnseen({
    idle: !busy && !needsInput,
    finishedAt: latestTurnEnd(conversations, { workspaceId: record.id }, record.lastTurnEndedAt),
    visitedAt: record.lastVisitedAt,
  })
  const watched = watchedPullRequest(input.pullRequests ?? []) !== null
  return { busy, held: needsInput || unseen || watched }
}

export type WorkspaceSettlementSweepDeps = {
  records(): readonly WorkspaceRegistryRecord[]
  record(workspaceId: string): WorkspaceRegistryRecord | null
  /** The chats some window has in front, which the sweep never settles out from under anyone. */
  onScreen(): ReadonlySet<string>
  signals(record: WorkspaceRegistryRecord): SettlementSignals
  /** The chat's pull requests, or undefined while the record of them has not been read. */
  pullRequests(workspaceId: string): readonly BranchPullRequest[] | undefined
  settings(): SettledChatsSettings
  /** The run state the chat's module reports, which pins a run in flight (`AutoSettleContext.runState`). */
  runState?(record: WorkspaceRegistryRecord): LifecycleState | null
  /**
   * Whether the live state `signals` reads has been read once. Until then
   * every chat reads idle, and one parked at a prompt for days would settle
   * and wake a beat later. Absent, it always has.
   */
  ready?(): boolean
  commit(decision: SweepDecision): SweepDecisionResult
  /** A chat the sweep settled: its processes are ended where main holds them. */
  settled?(workspaceId: string): void
  now(): number
  /** Run `job` after `ms`; returns the cancel. Injected so tests drive the clock. */
  schedule?: (job: () => void, ms: number) => () => void
  intervalMs?: number
  log?: (message: string) => void
}

export type WorkspaceSettlementSweep = ReturnType<typeof createWorkspaceSettlementSweep>

export function createWorkspaceSettlementSweep(deps: WorkspaceSettlementSweepDeps) {
  const schedule =
    deps.schedule ??
    ((job: () => void, ms: number) => {
      const timer = setTimeout(job, ms)
      timer.unref?.()
      return () => clearTimeout(timer)
    })
  const intervalMs = deps.intervalMs ?? SETTLEMENT_SWEEP_INTERVAL_MS
  const queued = new Set<string>()
  let everything = false
  let running = false
  let cancelPass: (() => void) | null = null
  let cancelTick: (() => void) | null = null
  let stopped = true
  // What the last registry change left each record at, and which chats were
  // on screen, so a change names only the chats it moved.
  const seenRevision = new Map<string, number>()
  let seenOnScreen = new Set<string>()

  /** Ask for a pass over these chats, or over all of them. Coalesced: a burst is one pass. */
  function request(workspaceIds?: Iterable<string>): void {
    if (stopped) return
    if (workspaceIds === undefined) everything = true
    else for (const id of workspaceIds) queued.add(id)
    if (running || cancelPass || (!everything && queued.size === 0)) return
    cancelPass = schedule(pass, 0)
  }

  function pass(): void {
    cancelPass = null
    if (stopped) return
    // Not read yet: the next tick, or the trigger that says it has been, asks again.
    if (deps.ready && !deps.ready()) return
    running = true
    const ids = everything ? deps.records().map((record) => record.id) : [...queued]
    everything = false
    queued.clear()
    try {
      const onScreen = deps.onScreen()
      const settings = deps.settings()
      for (const id of ids) decide(id, onScreen, settings)
    } finally {
      running = false
    }
    // What a write of this pass (or anything else) asked for meanwhile runs
    // as a pass of its own, so a pass never chases its own writes.
    if (everything || queued.size > 0) cancelPass = schedule(pass, 0)
  }

  function decide(workspaceId: string, onScreen: ReadonlySet<string>, settings: SettledChatsSettings): void {
    const record = deps.record(workspaceId)
    if (!record) return
    // Read now, for this chat: never a clock carried from an earlier render.
    const now = deps.now()
    const signals = deps.signals(record)
    const pullRequests = deps.pullRequests(workspaceId)
    const decision = decideWorkspaceSettlement({
      workspace: record,
      now,
      active: onScreen.has(workspaceId),
      busy: signals.busy,
      held: signals.held,
      context: {
        runState: deps.runState?.(record) ?? null,
        pullRequests,
        pullRequestsUnread: pullRequests === undefined,
        settleOnMerge: settings.settleOnPullRequestMerge,
        keepWithOpenPullRequest: settings.keepChatsWithOpenPullRequest,
        afterDays: settings.autoSettleAfterDays,
      },
    })
    if (decision === 'none') return
    const result = deps.commit({ workspaceId, decision, snapshot: workspaceLifecycleSnapshot(record) })
    if (!result.ok) {
      // A chat that moved on since it was read is not a fault: the change that
      // moved it asks for another look.
      if (result.code !== 'stale') deps.log?.(`A chat was left as it is: ${result.message} (${result.code})`)
      return
    }
    if (decision === 'settle') deps.settled?.(workspaceId)
  }

  /**
   * The registry changed: look again at the chats whose record moved, and at
   * the ones a window has just left (a chat on screen is never settled, so one
   * left may be due).
   */
  function noteRegistryChanged(): void {
    const moved: string[] = []
    const present = new Set<string>()
    for (const record of deps.records()) {
      present.add(record.id)
      if (seenRevision.get(record.id) === record.revision) continue
      seenRevision.set(record.id, record.revision)
      moved.push(record.id)
    }
    for (const id of seenRevision.keys()) if (!present.has(id)) seenRevision.delete(id)
    const onScreen = new Set(deps.onScreen())
    for (const id of seenOnScreen) if (!onScreen.has(id)) moved.push(id)
    seenOnScreen = onScreen
    if (moved.length > 0) request(moved)
  }

  function tick(): void {
    cancelTick = null
    if (stopped) return
    request()
    cancelTick = schedule(tick, intervalMs)
  }

  return {
    /** Start the minute's pass and take a first look at every chat. */
    start(): void {
      if (!stopped) return
      stopped = false
      for (const record of deps.records()) seenRevision.set(record.id, record.revision)
      seenOnScreen = new Set(deps.onScreen())
      tick()
    },
    request,
    noteRegistryChanged,
    dispose(): void {
      stopped = true
      cancelPass?.()
      cancelTick?.()
      cancelPass = null
      cancelTick = null
      queued.clear()
      everything = false
    },
  }
}
