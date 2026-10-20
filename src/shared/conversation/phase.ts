import type { ConversationSessionSummary } from '../conversation-runtime'
import { backgroundTasksWakeAgent } from './backgroundTasks'

/** One display phase for a conversation, ordered by the action it needs. */
export type ConversationPhase =
  'idle' | 'starting' | 'running' | 'waiting_for_approval' | 'waiting_for_input' | 'failed' | 'completed'

export type ConversationPhaseSignals = {
  approvalPending?: boolean
  inputPending?: boolean
  failed?: boolean
  running?: boolean
  starting?: boolean
  completed?: boolean
}

/** A pending human action outranks a process state when both are reported. */
export function conversationPhaseOf(signals: ConversationPhaseSignals): ConversationPhase {
  if (signals.approvalPending) return 'waiting_for_approval'
  if (signals.inputPending) return 'waiting_for_input'
  if (signals.failed) return 'failed'
  if (signals.running) return 'running'
  if (signals.starting) return 'starting'
  if (signals.completed) return 'completed'
  return 'idle'
}

export function conversationPhaseNeedsAttention(phase: ConversationPhase): boolean {
  return phase === 'waiting_for_approval' || phase === 'waiting_for_input' || phase === 'failed'
}

/**
 * A turn's phase, counting what the chat still has working once the turn is
 * over. Background agents keep working after the turn that launched them
 * ends, and a monitor will wake the agent again: the chat is not done with
 * either. The one rule both a chat's summary here and a paired machine's
 * listed chat (its `phase` beside its `backgroundWork`) are read by.
 */
export function phaseWithBackgroundWork(phase: ConversationPhase, backgroundWork: boolean): ConversationPhase {
  return backgroundWork && (phase === 'completed' || phase === 'idle') ? 'running' : phase
}

export function conversationSummaryPhase(summary: ConversationSessionSummary): ConversationPhase {
  return phaseWithBackgroundWork(
    summary.phase ?? statusPhase(summary),
    Boolean(summary.backgroundAgents) || backgroundTasksWakeAgent(summary.backgroundTasks),
  )
}

/** Whether a phase is the agent at work: what a sidebar row's working mark and its count are drawn for. */
export function conversationPhaseWorking(phase: ConversationPhase): boolean {
  return phase === 'running' || phase === 'starting'
}

function statusPhase(summary: ConversationSessionSummary): ConversationPhase {
  return conversationPhaseOf({
    approvalPending: summary.status === 'awaiting_approval',
    failed: summary.status === 'failed',
    running: summary.status === 'active',
    starting: summary.status === 'starting',
    completed: summary.status === 'stopped',
  })
}

/**
 * Whether stopping the chat now would cut a turn short: one starting, running
 * (background agents included), or stopped on a question or an approval. What
 * a quit asks about; a finished, failed or resting chat loses nothing.
 */
export function conversationTurnInProgress(summary: ConversationSessionSummary): boolean {
  const phase = conversationSummaryPhase(summary)
  return (
    phase === 'starting' || phase === 'running' || phase === 'waiting_for_approval' || phase === 'waiting_for_input'
  )
}

/**
 * Whether ending a chat session's processes now would lose work: a turn
 * starting, running or stopped on a person's answer, or an agent or monitor
 * it launched still working in the background, whatever its parent's phase
 * says (it goes on while the parent waits on the person, or after the
 * parent's turn failed). A stopped session has no processes left to end. What a Settle
 * asked for from another device or an agent waits on (`conversation.settle`):
 * the window that carries out a settle made elsewhere ends the chat's
 * processes, and the work with them.
 */
export function conversationSessionWorking(summary: ConversationSessionSummary): boolean {
  if (summary.status === 'stopped') return false
  return (
    (summary.backgroundAgents ?? 0) > 0 ||
    backgroundTasksWakeAgent(summary.backgroundTasks) ||
    conversationTurnInProgress(summary)
  )
}

/**
 * Whether an agent terminal is mid-turn, in a process still there to run it:
 * a stamp of `working` outlives a pty that was suspended or killed mid-turn,
 * so it counts only while the process is alive.
 */
export function terminalAgentWorking(session: { processAlive: boolean; activity?: { kind: string } }): boolean {
  return session.processAlive && session.activity?.kind === 'working'
}
