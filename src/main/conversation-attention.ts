import type { AgentPhaseEvent } from '../shared/agent-runtime'
import { readConversationMessageOrigin, type ConversationEvent } from '../shared/conversation-runtime'
import type { AgentAttention } from './agent-attention'
import { isTurnlessSubagentStep } from '../shared/conversation/subagents'

/** Adapt live conversation events into the same passive OS attention channel
 * as terminal agents. Tokens/tool output never notify, and concurrent approval
 * callbacks keep attention until the final human decision resolves.
 *
 * A session is remembered only while an approval it raised is outstanding.
 * Settle, Snooze and the idle sweep end a chat's child without a
 * `session_closed`, so an entry kept until then would stay for the life of
 * the app. Forgetting the rest loses nothing attention reads: the only use of
 * the previous phase is to tell a second `awaiting_input` from a first, and a
 * session is only awaiting input while an approval is outstanding. Every way
 * a turn ends (completed, failed, interrupted by Stop or Settle) clears them.
 */
export function createConversationAttentionListener(attention: Pick<AgentAttention, 'onAgentPhase'>) {
  const sessions = new Map<string, { phase: AgentPhaseEvent['phase']; pending: Set<string> }>()
  // The turn Studio opened in each session with its own `/compact`, just
  // before the cache expired: the chat sat idle and still does, so the turn
  // neither badges nor notifies. Remembered only until it ends.
  const quietTurns = new Map<string, string>()
  const listener = (event: ConversationEvent): void => {
    const turnId = typeof event.payload?.turnId === 'string' ? event.payload.turnId : undefined
    if (
      event.type === 'user_message' &&
      turnId &&
      readConversationMessageOrigin(event.payload?.origin)?.reason === 'auto-compact'
    )
      quietTurns.set(event.sessionId, turnId)
    const quiet = quietTurns.get(event.sessionId)
    if (quiet !== undefined && quiet === turnId) {
      if (event.type === 'turn_completed' || event.type === 'turn_failed') quietTurns.delete(event.sessionId)
      return
    }
    const state = sessions.get(event.sessionId) ?? { phase: 'idle', pending: new Set<string>() }
    let phase: AgentPhaseEvent['phase']
    let turnEnd = false
    switch (event.type) {
      case 'session_started':
        phase = 'starting'
        break
      case 'user_message':
      case 'turn_started':
        // A message steered in while a card was being raised: the card is
        // still what the agent waits on.
        if (state.pending.size) return
        phase = 'thinking'
        break
      case 'tool_started':
        if (state.pending.size) return
        // A background agent working after its turn ended: no turn end will
        // follow to put the conversation back to idle.
        if (isTurnlessSubagentStep(event)) return
        phase = 'tool_use'
        break
      case 'approval_requested':
        if (event.payload?.autoApproved === true) return
        if (typeof event.payload?.requestId !== 'string') return
        state.pending.add(event.payload.requestId)
        phase = 'awaiting_input'
        break
      case 'approval_resolved':
        if (typeof event.payload?.requestId !== 'string') return
        if (!state.pending.has(event.payload.requestId)) return
        state.pending.delete(event.payload.requestId)
        if (state.pending.size) return
        phase = 'thinking'
        break
      case 'turn_completed':
      case 'turn_failed':
        // A turn a steered message ended: the agent carries straight on.
        if (event.payload?.steered === true) return
        state.pending.clear()
        phase = 'idle'
        turnEnd = true
        break
      case 'session_closed':
        // A deliberate close clears any stale badge through the existing
        // working transition; it must not create another completion notice.
        phase = 'thinking'
        break
      default:
        return
    }
    attention.onAgentPhase({
      workspaceId: event.workspaceId,
      agentId: event.agentId,
      executionId: event.sessionId,
      phase,
      previousPhase: state.phase,
      event: event.type,
      turnEnd,
      turnFailure: event.type === 'turn_failed',
      ts: event.createdAt,
      pendingWakeupAt: null,
    })
    state.phase = phase
    if (event.type === 'session_closed' || !state.pending.size) sessions.delete(event.sessionId)
    else sessions.set(event.sessionId, state)
  }
  /** How many sessions are remembered. Exposed for tests. */
  return Object.assign(listener, { trackedSessions: () => sessions.size })
}
