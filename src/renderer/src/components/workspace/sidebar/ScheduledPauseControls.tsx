import { GhostButton, IconButton, InlineNotice, OverflowMenu, PauseGlyph, PlayGlyph, Tooltip } from '../../ui'
import type { ScheduledAgentsPause } from '../../../../../shared/scheduled-agents'
import {
  pauseAllChoices,
  pauseAllScheduledAgents,
  resumeAllScheduledAgents,
  scheduledAgentsPauseWords,
} from '../../../utils/scheduledAgentsPause'

/**
 * The Scheduled section's own control, beside its fold: pause every scheduled
 * agent for an hour, until tomorrow morning, or until resumed — or, while they
 * are paused, resume them. Each schedule's own pause is kept apart from it, so
 * resuming them all here leaves one paused on its own paused.
 */
export function PauseAllScheduledAgentsControl({ pause }: { pause: ScheduledAgentsPause | null }) {
  if (pause) {
    return (
      <Tooltip content="Resume scheduled agents — each runs next at its next time" placement="right">
        <IconButton
          tone="quiet"
          aria-label="Resume scheduled agents"
          data-scheduled-pause-all="resume"
          onClick={() => void resumeAllScheduledAgents()}
        >
          <PlayGlyph className="icon-xs" />
        </IconButton>
      </Tooltip>
    )
  }
  // Resolved when the menu is drawn, so each row says when it would end.
  const choices = pauseAllChoices(Date.now())
  return (
    <OverflowMenu
      ariaLabel="Pause all scheduled agents"
      trigger={() => <PauseGlyph className="icon-xs" />}
      items={[
        { kind: 'heading', id: 'pause-all', label: 'Pause all scheduled agents' },
        ...choices.map((choice) => ({
          id: `pause-all:${choice.id}`,
          label: choice.hint ? `${choice.label} — ${choice.hint}` : choice.label,
          onSelect: () => void pauseAllScheduledAgents(choice),
        })),
      ]}
    />
  )
}

/**
 * The line over the Scheduled section while every scheduled agent is paused:
 * "Scheduled agents paused until 3:00 PM · Resume". Amber, as a state that is
 * reduced but working is: the schedules are all kept, and a run already going
 * carries on.
 */
export function ScheduledAgentsPausedNotice({ pause, now }: { pause: ScheduledAgentsPause; now: number }) {
  return (
    <InlineNotice
      tone="warn"
      className="mx-1.5 my-1"
      action={
        <GhostButton size="xs" onClick={() => void resumeAllScheduledAgents()}>
          Resume
        </GhostButton>
      }
    >
      <span data-scheduled-paused-notice="">{scheduledAgentsPauseWords(pause, now)}</span>
    </InlineNotice>
  )
}
