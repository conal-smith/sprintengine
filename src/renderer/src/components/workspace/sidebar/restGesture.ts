import type { WorkspaceLifecycleResult } from '../../../../../shared/workspace-lifecycle'
import type { ShowToastInput } from '../../../store/toastStore'

// What a Settle or Snooze from the row menu does once main has answered it.
// The row moves at once (the store applies the gesture), but what follows it
// waits for main's yes: the chat's processes are put away and the person is
// handed on to the next chat only for a gesture main took. A no has already put
// the row back where main has it (the store adopts main's reading), so all that
// is left is to say why.

/**
 * Whether main took a gesture on a chat's rest: a yes, no main to ask at all
 * (the gesture then stands as applied here), or no record left to ask about
 * (a chat gone from the store has nobody left to keep its agents for). A main
 * that could not be reached is a no.
 */
export function mainAgreed(answer: WorkspaceLifecycleResult | null): boolean {
  return answer === null || answer.ok || answer.code === 'unavailable'
}

/** A Snooze that found an agent at work, whether main said so or the suspend's own re-check did. */
export function stillWorkingToast(name: string): ShowToastInput {
  return {
    tone: 'neutral',
    title: `${name} is still working`,
    description: 'It can be snoozed once its agents finish.',
  }
}

/** What the person is told when main refused a gesture. */
export function restRefusalToast(
  name: string,
  gesture: 'settle' | 'snooze',
  answer: Extract<WorkspaceLifecycleResult, { ok: false }>,
): ShowToastInput {
  if (gesture === 'snooze' && answer.code === 'working') return stillWorkingToast(name)
  const title = gesture === 'settle' ? `${name} was not settled` : `${name} was not snoozed`
  const description =
    answer.code === 'working'
      ? 'An agent in it is working. Settle it once it has finished.'
      : answer.code === 'stale'
        ? 'It changed just now. Look at it again.'
        : answer.message
  return { tone: 'neutral', title, description }
}

/** Run what follows a gesture once main has answered it. */
export async function followRestAnswer(
  answer: Promise<WorkspaceLifecycleResult | null>,
  then: { agreed(): void; refused(answer: Extract<WorkspaceLifecycleResult, { ok: false }>): void },
): Promise<void> {
  const result = await answer
  if (mainAgreed(result)) then.agreed()
  else if (result && !result.ok) then.refused(result)
}
