import React from 'react'

import { AttachmentChip } from '../../../ui/AttachmentChip'
import { ChipButton, GhostButton, Input, LinkButton, PauseGlyph, Popover, SegmentedControl } from '../../../ui'
import { ScheduleGlyph } from '../../../AppIcons'
import { ComposerTray, ComposerTrayRow } from '../../../panels/agentChat/composerTray'
import { CRON_FIELD_NAMES, describeCronSchedule, parseCronSchedule } from '../../../../../../shared/cron'
import { nextScheduledAgentRuns, type ScheduledAgentsPause } from '../../../../../../shared/scheduled-agents'
import { pausedSinceWords, scheduledAgentsPauseWords } from '../../../../utils/scheduledAgentsPause'
import {
  cronFromEditorState,
  editorStateFromCron,
  formatRunTimes,
  switchTab,
  type ScheduleEditorState,
  type ScheduleTab,
  type ScheduleTime,
} from './scheduleEditor'
import { SendTimeEditor } from './SendTimeEditor'
import { defaultSendAt, sendTimeWords } from './sendTime'
import { TimeField } from './TimeField'

/**
 * What the picker holds: a repeating schedule's cron, or one time to run at.
 * The cron is kept while Once is picked, so going back to a repeat finds the
 * one that was there.
 */
export type PickedSchedule = { cron: string; once: number | null }

const TABS: { value: ScheduleTab | 'once'; label: string }[] = [
  { value: 'once', label: 'Once' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'cron', label: 'Cron' },
]

// Monday first, the way a working week is read; the values are cron's.
const WEEKDAYS: { value: number; short: string; name: string }[] = [
  { value: 1, short: 'M', name: 'Monday' },
  { value: 2, short: 'T', name: 'Tuesday' },
  { value: 3, short: 'W', name: 'Wednesday' },
  { value: 4, short: 'T', name: 'Thursday' },
  { value: 5, short: 'F', name: 'Friday' },
  { value: 6, short: 'S', name: 'Saturday' },
  { value: 0, short: 'S', name: 'Sunday' },
]

const FIELD_LABEL: Record<(typeof CRON_FIELD_NAMES)[number], string> = {
  minute: 'min',
  hour: 'hour',
  day: 'day',
  month: 'month',
  weekday: 'weekday',
}

const PREVIEW_RUNS = 3

/** What the schedule says and when it next runs, or why it cannot be read. */
export function readSchedule(
  cron: string,
  timezone: string,
  now: number,
): { ok: true; words: string; next: string[] } | { ok: false; message: string; field?: string } {
  const parsed = parseCronSchedule(cron)
  if (!parsed.ok) return { ok: false, message: parsed.error, ...(parsed.field ? { field: parsed.field } : {}) }
  const runs = nextScheduledAgentRuns({ cron, timezone }, now, PREVIEW_RUNS)
  if (runs.length === 0) return { ok: false, message: 'That schedule never comes round — no calendar has that day.' }
  return { ok: true, words: describeCronSchedule(parsed.schedule), next: formatRunTimes(runs, timezone, now) }
}

/** What a picked schedule says and when it next runs, or why it cannot be read. */
export function readPickedSchedule(
  schedule: PickedSchedule,
  timezone: string,
  now: number,
): ReturnType<typeof readSchedule> {
  if (schedule.once === null) return readSchedule(schedule.cron, timezone, now)
  if (schedule.once <= now) return { ok: false, message: 'That time has passed' }
  const when = sendTimeWords(schedule.once, now)
  return { ok: true, words: `Once, ${when}`, next: [when] }
}

/**
 * The schedule, as a tag beside the composer's "+" (owner ruling 2026-10-04):
 * the schedule glyph, what the schedule says, and × to stop scheduling. The
 * words open the picker over the tag; the prompt box stays the prompt's alone
 * — nothing about when is typed into what. While a scheduled agent is being
 * edited there is no ×: it stays a scheduled agent.
 */
export function ScheduleTag({
  schedule,
  timezone,
  onChange,
  onRemove,
}: {
  schedule: PickedSchedule
  timezone: string
  onChange: (schedule: PickedSchedule) => void
  /** Stop scheduling. Absent, the tag cannot be removed. */
  onRemove?: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const read = readPickedSchedule(schedule, timezone, Date.now())
  const words = read.ok ? read.words : 'Schedule'
  const editor = (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Schedule"
      popupRole="dialog"
      placement="bottom-start"
      surfaceClassName="w-[380px] p-3"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <LinkButton
          ref={ref}
          ink="quiet"
          size="inherit"
          onClick={togglePopover}
          // The words name the schedule; the accessible name says what a press does.
          aria-label={read.ok ? `Schedule: ${read.words}, next ${read.next[0]}. Change it` : 'Change the schedule'}
          title={read.ok ? `Next ${read.next[0]}` : read.message}
          data-schedule-tag="true"
          {...triggerProps}
        >
          {read.ok ? words : <span className="text-[color:var(--tone-error)]">{read.message}</span>}
        </LinkButton>
      )}
    >
      <ScheduleEditor schedule={schedule} timezone={timezone} onChange={onChange} />
    </Popover>
  )
  const glyph = <ScheduleGlyph className="icon-xs shrink-0 text-[color:var(--accent-primary)]" />
  if (onRemove) {
    return (
      <AttachmentChip glyph={glyph} label={words} removeLabel="Stop scheduling" onRemove={onRemove}>
        {editor}
      </AttachmentChip>
    )
  }
  // The same tag without its ×, for a scheduled agent being edited.
  return (
    <span className="inline-flex items-center gap-1.5 rounded-sm bg-[color:var(--bg-selected)] px-2 py-0.5 text-meta font-medium text-[color:var(--text-strong)]">
      {glyph}
      {editor}
    </span>
  )
}

/** Why the last run of a scheduled agent did not start, said until the person has seen it. */
export function ScheduleFailureTray({ failure, onDismiss }: { failure: string; onDismiss: () => void }) {
  return (
    <ComposerTray>
      <ComposerTrayRow tone="error" onDismiss={onDismiss}>
        The last run did not start: {failure}
      </ComposerTrayRow>
    </ComposerTray>
  )
}

/**
 * Behind the editor of a paused schedule — paused on its own, or with every
 * other — what that means, with the way out. Its own pause is said first: it is
 * the one this editor's Resume ends; a pause of them all is ended from the
 * Scheduled section, so here it is only said.
 */
export function SchedulePausedTray({
  pausedAt,
  pausedAll,
  now,
  onResume,
}: {
  pausedAt: number | undefined
  pausedAll: ScheduledAgentsPause | null
  now: number
  onResume: () => void
}) {
  const sentence =
    pausedAt !== undefined
      ? `${pausedSinceWords(pausedAt, now)}: it starts no run at its times until you resume it. Run now still runs it.`
      : pausedAll
        ? `${scheduledAgentsPauseWords(pausedAll, now)}. Run now still runs this one.`
        : null
  if (!sentence) return null
  return (
    <ComposerTray>
      <ComposerTrayRow
        tone="warn"
        glyph={<PauseGlyph className="icon-sm text-[color:var(--tone-warn)]" />}
        actions={
          pausedAt !== undefined ? (
            <GhostButton size="xs" onClick={onResume}>
              Resume
            </GhostButton>
          ) : undefined
        }
      >
        <span data-schedule-paused-tray="">{sentence}</span>
      </ComposerTrayRow>
    </ComposerTray>
  )
}

/**
 * The picker. Once runs a single time; Daily, Weekly and Monthly write the
 * everyday shapes of a repeat; Cron takes anything. Every change that reads is
 * handed back at once, so the tag it opens from says the new schedule while
 * the picker is still open; one that does not read is kept here, marked, and
 * the last schedule that did stays.
 */
export function ScheduleEditor({
  schedule,
  timezone,
  onChange,
}: {
  schedule: PickedSchedule
  timezone: string
  onChange: (schedule: PickedSchedule) => void
}) {
  const [state, setState] = React.useState<ScheduleEditorState>(() => editorStateFromCron(schedule.cron))
  // The time Once picks, kept while a repeat is picked so going back finds it.
  const [onceAt, setOnceAt] = React.useState(() => schedule.once ?? defaultSendAt(Date.now()))
  const update = (next: ScheduleEditorState) => {
    setState(next)
    const written = cronFromEditorState(next)
    if (written && parseCronSchedule(written).ok) onChange({ cron: written, once: null })
  }
  const written = cronFromEditorState(state) ?? ''
  const read = readSchedule(written, timezone, Date.now())

  const tabs = (
    <SegmentedControl
      ariaLabel="How often"
      size="sm"
      items={TABS}
      value={schedule.once !== null ? 'once' : state.tab}
      onChange={(tab) => {
        if (tab === 'once') {
          onChange({ cron: schedule.cron, once: onceAt })
          return
        }
        // Back from Once: the repeat the controls hold, on the tab picked.
        if (schedule.once !== null && tab === state.tab) {
          onChange({ cron: written && parseCronSchedule(written).ok ? written : schedule.cron, once: null })
          return
        }
        update(switchTab(state, tab))
      }}
      className="w-full [&>*]:flex-1 [&>*]:justify-center"
    />
  )
  if (schedule.once !== null) {
    return (
      <div className="flex flex-col gap-3">
        {tabs}
        <SendTimeEditor
          at={schedule.once}
          timezone={timezone}
          onChange={(at) => {
            setOnceAt(at)
            onChange({ cron: schedule.cron, once: at })
          }}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {tabs}

      {state.tab === 'weekly' ? (
        <ScheduleSection label="On">
          <div className="grid grid-cols-7 gap-1" role="group" aria-label="Days of the week">
            {WEEKDAYS.map((day) => {
              const on = state.weekdays.includes(day.value)
              return (
                <ChipButton
                  key={day.value}
                  variant="outline"
                  pressed={on}
                  aria-label={day.name}
                  onClick={() =>
                    update({
                      ...state,
                      weekdays: on
                        ? state.weekdays.filter((value) => value !== day.value)
                        : [...state.weekdays, day.value],
                    })
                  }
                  className="h-control-sm justify-center"
                >
                  {day.short}
                </ChipButton>
              )
            })}
          </div>
        </ScheduleSection>
      ) : null}

      {state.tab === 'monthly' ? (
        <ScheduleSection label="On day">
          <div className="grid grid-cols-7 gap-1" role="group" aria-label="Days of the month">
            {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => {
              const on = state.monthDays.includes(day)
              return (
                <ChipButton
                  key={day}
                  variant="outline"
                  pressed={on}
                  onClick={() =>
                    update({
                      ...state,
                      monthDays: on ? state.monthDays.filter((value) => value !== day) : [...state.monthDays, day],
                    })
                  }
                  className="justify-center tabular-nums"
                >
                  {day}
                </ChipButton>
              )
            })}
          </div>
        </ScheduleSection>
      ) : null}

      {state.tab === 'cron' ? (
        <CronField
          text={state.cronText}
          badField={read.ok ? null : ((read as { field?: string }).field ?? null)}
          onChange={(cronText) => update({ ...state, cronText })}
        />
      ) : (
        <ScheduleSection label="At">
          <div className="flex flex-wrap items-center gap-1.5">
            {state.times.map((time, index) => (
              <TimeField
                key={`${index}-${time}`}
                time={time}
                removable={state.times.length > 1}
                onChange={(next) =>
                  update({ ...state, times: state.times.map((value, at) => (at === index ? next : value)) })
                }
                onRemove={() => update({ ...state, times: state.times.filter((_, at) => at !== index) })}
              />
            ))}
            <ChipButton
              variant="outline"
              onClick={() => update({ ...state, times: [...state.times, nextFreeTime(state.times)] })}
              className="h-control-sm"
            >
              + Time
            </ChipButton>
          </div>
        </ScheduleSection>
      )}

      <div
        className="rounded-md bg-[color:var(--bg-surface)] px-3 py-2"
        role="status"
        aria-live="polite"
        aria-label="What this schedule does"
      >
        {read.ok ? (
          <>
            <p className="text-heading font-medium text-[color:var(--text-strong)]">{read.words}</p>
            <p className="mt-0.5 text-meta tabular-nums text-[color:var(--text-subtle)]">
              Next {read.next.join(' · ')}
            </p>
          </>
        ) : (
          <>
            <p className="text-body text-[color:var(--tone-error)]">{read.message}</p>
            <p className="mt-0.5 text-meta text-[color:var(--text-subtle)]">
              The last schedule that read stays until this one does.
            </p>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 text-meta text-[color:var(--text-subtle)]">
        <ScheduleGlyph className="icon-xs shrink-0" />
        <span className="min-w-0 flex-1 truncate">Your time · {timezone}</span>
        {state.tab !== 'cron' && written ? (
          <code className="rounded-xs bg-[color:var(--bg-surface)] px-1 font-mono text-micro text-[color:var(--text-muted)]">
            {written}
          </code>
        ) : null}
      </div>
    </div>
  )
}

function ScheduleSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-meta font-medium text-[color:var(--text-subtle)]">{label}</p>
      {children}
    </div>
  )
}

// A time the list does not have yet: an hour after the last one, wrapping at
// midnight, so "+ Time" never adds a duplicate a person then has to fix.
function nextFreeTime(times: ScheduleTime[]): ScheduleTime {
  let candidate = ((times[times.length - 1] ?? 8 * 60) + 60) % (24 * 60)
  while (times.includes(candidate)) candidate = (candidate + 60) % (24 * 60)
  return candidate
}

function CronField({
  text,
  badField,
  onChange,
}: {
  text: string
  badField: string | null
  onChange: (text: string) => void
}) {
  return (
    <div>
      <Input
        size="md"
        value={text}
        onChange={(event) => onChange(event.currentTarget.value)}
        aria-label="Cron schedule"
        aria-invalid={badField !== null || undefined}
        spellCheck={false}
        autoFocus
        placeholder="0 9 * * 1-5"
        className="font-mono tracking-[0.04em]"
      />
      {/* The five fields named under the line, the wrong one in the error ink —
          which part to fix, not just that something is wrong. */}
      <div className="mt-1 grid grid-cols-5 px-3 text-micro text-[color:var(--text-subtle)]" aria-hidden="true">
        {CRON_FIELD_NAMES.map((field) => (
          <span key={field} className={badField === field ? 'text-[color:var(--tone-error)]' : undefined}>
            {FIELD_LABEL[field]}
          </span>
        ))}
      </div>
    </div>
  )
}
