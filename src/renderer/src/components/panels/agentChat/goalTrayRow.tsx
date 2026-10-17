// The goal the chat's agent keeps working toward by itself (Codex's `/goal`),
// as one row of the composer tray: what the goal is, and where it stands in a
// word. While the agent works toward it the row wears the working mark, since
// the agent starts its next turn by itself; a goal it is not working toward
// wears the lifecycle glyph of its state. A met goal can be put away; it
// comes back if the goal changes.

import { useState, type JSX } from 'react'
import type { ConversationGoal, ConversationGoalStatus } from '../../../../../shared/conversation-runtime'
import { CONVERSATION_GOAL_STATUS_WORDS } from '../../../../../shared/conversation/goal'
import { LifecycleGlyph, TruncatedText, WorkingMark, type LifecycleState } from '../../ui'
import { ComposerTrayRow } from './composerTray'

// A goal not being worked on, by the lifecycle shape that says why: held by
// the person or a limit, waiting on the person, or done.
const GOAL_GLYPH: Readonly<Record<Exclude<ConversationGoalStatus, 'active'>, LifecycleState>> = {
  paused: 'paused',
  usageLimited: 'paused',
  budgetLimited: 'paused',
  blocked: 'needs_input',
  complete: 'done',
}

export function GoalTrayRow({
  goal,
  seed,
}: {
  goal: ConversationGoal | null
  /** The chat's id: what picks its working mark's pattern. */
  seed: string
}): JSX.Element | null {
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (!goal) return null
  const key = `${goal.status}\0${goal.objective}`
  if (dismissed === key) return null
  const word = CONVERSATION_GOAL_STATUS_WORDS[goal.status]
  return (
    <ComposerTrayRow
      ariaLabel={`Goal, ${word.toLowerCase()}: ${goal.objective}`}
      glyph={
        goal.status === 'active' ? (
          <WorkingMark label="Working toward the goal" seed={seed} />
        ) : (
          <LifecycleGlyph state={GOAL_GLYPH[goal.status]} live={false} />
        )
      }
      onDismiss={goal.status === 'complete' ? () => setDismissed(key) : undefined}
    >
      <span className="flex min-w-0 items-baseline gap-2" data-goal-status={goal.status}>
        <span className="shrink-0 text-[color:var(--text-muted)]">Goal</span>
        <TruncatedText as="span" text={goal.objective} className="min-w-0" />
        <span className="ml-auto shrink-0 text-meta text-[color:var(--text-subtle)]">{word}</span>
      </span>
    </ComposerTrayRow>
  )
}
