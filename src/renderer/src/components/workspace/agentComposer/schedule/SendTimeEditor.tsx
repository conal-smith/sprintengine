import React from 'react'

import { AttachmentChip } from '../../../ui/AttachmentChip'
import { ChipButton, Input, LinkButton, Popover } from '../../../ui'
import { ScheduleGlyph } from '../../../AppIcons'
import { useRelativeNow } from '../../../../hooks/useRelativeNow'
import { TimeField } from './TimeField'
import {
  dateFieldValue,
  minutesOfDay,
  quickSendTimes,
  sendTimeFromNow,
  sendTimeWords,
  withDay,
  withMinutesOfDay,
} from './sendTime'

// One moment to send at: the Once tab of a scheduled agent, and the time a
// message scheduled into an open chat goes out. The everyday times are one
// press each; any other is a day and a time typed. Every change is handed back
// at once, so the tag it opens from says the new time while it is still open.

/**
 * "When my limit resets", for a message into a chat whose provider meters its
 * use: `at` is when it would go, from the provider's latest word, and `on`
 * that it is the choice. Main asks the limit again when that time comes.
 */
export type SendAtLimitReset = { at: number; on: boolean; onPick: () => void }

export function SendTimeEditor({
  at,
  onChange,
  timezone,
  limitReset,
}: {
  at: number
  onChange: (at: number) => void
  /** Said under the readout where the zone matters: a scheduled agent's. */
  timezone?: string
  limitReset?: SendAtLimitReset | null
}) {
  const now = useRelativeNow(30_000)
  const passed = at <= now
  const fromNow = sendTimeFromNow(at, now)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Quick times">
        {quickSendTimes(now).map((choice) => (
          <ChipButton
            key={choice.label}
            variant="outline"
            pressed={choice.at === at}
            onClick={() => onChange(choice.at)}
            className="h-control-sm"
          >
            {choice.label}
          </ChipButton>
        ))}
        {limitReset ? (
          <ChipButton
            variant="outline"
            pressed={limitReset.on}
            onClick={limitReset.onPick}
            className="h-control-sm"
            data-send-at-limit-reset="true"
          >
            When my limit resets
          </ChipButton>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-meta font-medium text-[color:var(--text-subtle)]">On</span>
          <Input
            type="date"
            size="sm"
            fullWidth={false}
            value={dateFieldValue(at)}
            min={dateFieldValue(now)}
            onChange={(event) => {
              const next = withDay(at, event.currentTarget.value)
              if (next !== null) onChange(next)
            }}
            aria-label="Day"
            className="tabular-nums"
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-meta font-medium text-[color:var(--text-subtle)]">At</span>
          <TimeField time={minutesOfDay(at)} onChange={(minutes) => onChange(withMinutesOfDay(at, minutes))} />
        </div>
      </div>

      <div
        className="rounded-md bg-[color:var(--bg-surface)] px-3 py-2"
        role="status"
        aria-live="polite"
        aria-label="When it sends"
      >
        {passed ? (
          <p className="text-body text-[color:var(--tone-error)]">That time has passed — pick one ahead.</p>
        ) : (
          <>
            <p className="text-heading font-medium text-[color:var(--text-strong)]">
              {limitReset?.on ? 'When the usage limit resets' : sendTimeWords(at, now)}
            </p>
            <p className="mt-0.5 text-meta tabular-nums text-[color:var(--text-subtle)]">
              {limitReset?.on ? `${sendTimeWords(at, now)} · ${fromNow}` : fromNow}
            </p>
          </>
        )}
      </div>

      {timezone ? (
        <div className="flex items-center gap-2 text-meta text-[color:var(--text-subtle)]">
          <ScheduleGlyph className="icon-xs shrink-0" />
          <span className="min-w-0 flex-1 truncate">Your time · {timezone}</span>
        </div>
      ) : null}
    </div>
  )
}

/**
 * The time a message will be sent at, as a tag beside the composer's "+": the
 * schedule glyph, the time, and × to send it as usual instead. The time opens
 * the picker over the tag.
 */
export function SendTimeTag({
  at,
  onChange,
  onRemove,
  limitReset,
}: {
  at: number
  onChange: (at: number) => void
  onRemove: () => void
  limitReset?: SendAtLimitReset | null
}) {
  const [open, setOpen] = React.useState(false)
  const now = useRelativeNow(30_000)
  const words = limitReset?.on ? 'When the limit resets' : sendTimeWords(at, now)
  const spoken = limitReset?.on ? 'when the limit resets' : words
  const passed = at <= now
  return (
    <AttachmentChip
      glyph={<ScheduleGlyph className="icon-xs shrink-0 text-[color:var(--accent-primary)]" />}
      label={words}
      removeLabel="Don't schedule — send as usual"
      onRemove={onRemove}
    >
      <Popover
        open={open}
        onOpenChange={setOpen}
        ariaLabel="Send at"
        popupRole="dialog"
        placement="top-start"
        surfaceClassName="w-[340px] p-3"
        renderTrigger={({ ref, triggerProps, togglePopover }) => (
          <LinkButton
            ref={ref}
            ink="quiet"
            size="inherit"
            onClick={togglePopover}
            aria-label={`Sends ${spoken}. Change the time`}
            data-send-time-tag="true"
            {...triggerProps}
          >
            {passed ? <span className="text-[color:var(--tone-error)]">{words}</span> : words}
          </LinkButton>
        )}
      >
        <SendTimeEditor at={at} onChange={onChange} limitReset={limitReset} />
      </Popover>
    </AttachmentChip>
  )
}
