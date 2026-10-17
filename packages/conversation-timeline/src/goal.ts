// The goal a session's agent keeps working toward by itself, as
// `session_updated` reports it (`goal`). Shared by the Codex adapter, which
// says it, and the chat view, which shows it above the composer.

import type { ConversationGoal, ConversationGoalStatus } from './protocol.js'
import { asRecord } from './records.js'

/** A goal's state in a word or two, as the chat says it. */
export const CONVERSATION_GOAL_STATUS_WORDS: Readonly<Record<ConversationGoalStatus, string>> = {
  active: 'Working',
  paused: 'Paused',
  blocked: 'Blocked',
  usageLimited: 'Usage limit reached',
  budgetLimited: 'Budget spent',
  complete: 'Met',
}

/**
 * The goal a `session_updated` payload carries: the goal, null when it says
 * there is none, undefined when it says nothing about one, which leaves the
 * goal already known in place. A status this package does not know yet reads
 * as a running goal's, since the agent still has it.
 */
export function readConversationGoal(payload: unknown): ConversationGoal | null | undefined {
  const record = asRecord(payload)
  if (!record || !('goal' in record)) return undefined
  const goal = asRecord(record.goal)
  const objective = typeof goal?.objective === 'string' ? goal.objective.trim() : ''
  if (!objective) return null
  const status = Object.hasOwn(CONVERSATION_GOAL_STATUS_WORDS, String(goal?.status))
    ? (goal?.status as ConversationGoalStatus)
    : 'active'
  return { objective, status }
}
