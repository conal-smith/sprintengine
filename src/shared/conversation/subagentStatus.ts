import type { AgentState } from '../agent-state'
import type { ConversationSessionSummary } from '../conversation-runtime'
import { conversationSummaryPhase } from './phase'

/** Where a sub-agent stands, as its parent's tools and the Agents tab say it. */
export type SubagentStatus = 'starting' | 'working' | 'needs_input' | 'completed' | 'failed' | 'stopped'

/** Whether a sub-agent's status is one it stays in until someone sends it a message. */
export function subagentEnded(status: SubagentStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped'
}

/** How it ended if it has, else what its session is doing. */
export function subagentStatusOf(
  agent: Pick<AgentState, 'subagentEnd'> | undefined,
  summary: ConversationSessionSummary | undefined,
): SubagentStatus {
  if (agent?.subagentEnd) return agent.subagentEnd.status
  if (!summary) return 'stopped'
  const phase = conversationSummaryPhase(summary)
  if (phase === 'waiting_for_approval' || phase === 'waiting_for_input') return 'needs_input'
  if (phase === 'running') return 'working'
  if (phase === 'failed') return 'failed'
  if (summary.status === 'stopped') return 'stopped'
  // Between the session starting and its first message going out.
  if (phase === 'starting' || summary.lastTurnEndedAt === undefined) return 'starting'
  return 'completed'
}
