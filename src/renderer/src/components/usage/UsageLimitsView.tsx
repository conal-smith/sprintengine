import React, { useId, type JSX } from 'react'

import {
  formatUsageResetIn,
  usageProviderLabel,
  usageWindowHasReset,
  usageWindowIsWarning,
  usageWindowPace,
  type UsageLimitSnapshot,
  type UsageLimitWindow,
  type UsagePace,
} from '../../../../shared/usage-limits'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import CliIcon from '../CliIcon'
import { usageReadingAge, useUsageLimitsState } from '../panels/agentChat/usageLimits'
import { EmptyState } from '../ui'
import { Meter } from '../ui/Meter'

// The dashboard's Limits view: each subscription window the agents reported,
// one per row, with how much of it is spent, the share of its time gone by as
// the meter's tick, and when it resets. The same readings the chat strip and
// the palette's dialog draw (src/main/usage-limits): the app never asks a
// provider for them, so a provider shows here once one of its chats (or a
// Claude terminal's status line) has reported.

const RESET_TICK_MS = 60_000

// Ahead: at this rate it runs out before it resets. Under: room to spare.
const PACE_WORDS: Record<UsagePace, string> = { ahead: 'Ahead of pace', on: 'On pace', under: 'Under pace' }

export function UsageLimitsView(): JSX.Element {
  const state = useUsageLimitsState()
  const now = useRelativeNow(RESET_TICK_MS)
  const snapshots = state?.snapshots ?? []
  if (snapshots.length === 0) {
    return (
      <EmptyState
        title="No usage limits reported yet"
        body="They appear once a Claude or Codex chat on a subscription has run a turn, or a Claude terminal has shown its status line."
      />
    )
  }
  return (
    <div className="flex flex-col gap-8">
      {snapshots.map((snapshot) => (
        <LimitsProvider key={snapshot.provider} snapshot={snapshot} now={now} />
      ))}
    </div>
  )
}

function LimitsProvider({ snapshot, now }: { snapshot: UsageLimitSnapshot; now: number }): JSX.Element {
  const headingId = useId()
  const plan = snapshot.plan ? snapshot.plan.charAt(0).toUpperCase() + snapshot.plan.slice(1) : null
  const age = usageReadingAge(snapshot.observedAt, now)
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3" data-usage-provider={snapshot.provider}>
      <div className="flex items-center gap-2">
        <CliIcon cli={snapshot.provider === 'claude' ? 'claude-code' : 'codex'} className="icon-md" />
        <h3 id={headingId} className="m-0 text-heading font-medium text-[color:var(--text-strong)]">
          {usageProviderLabel(snapshot.provider)}
          {plan ? <span className="font-normal text-[color:var(--text-subtle)]"> · {plan}</span> : null}
        </h3>
        {age ? <span className="ml-auto text-meta text-[color:var(--text-subtle)]">{age}</span> : null}
      </div>
      <ul className="m-0 flex list-none flex-col p-0">
        {snapshot.windows.map((window) => (
          <LimitsWindow key={window.id} window={window} now={now} />
        ))}
      </ul>
    </section>
  )
}

function LimitsWindow({ window, now }: { window: UsageLimitWindow; now: number }): JSX.Element {
  const labelId = useId()
  const reset = usageWindowHasReset(window, now)
  const pace = reset ? null : usageWindowPace(window, now)
  const used = reset ? null : window.status === 'rejected' && window.usedPercent === null ? 100 : window.usedPercent
  const figure = reset
    ? 'Reset'
    : window.status === 'rejected'
      ? 'Limit reached'
      : used === null
        ? '—'
        : `${Math.round(used)}%`
  const resets =
    window.resetsAt !== null && !reset
      ? `Resets in ${formatUsageResetIn(window.resetsAt, now)}`
      : reset
        ? 'Reset'
        : null
  const words = [
    figure === '—' ? null : `${figure}${used !== null && !reset ? ' used' : ''}`,
    resets,
    pace ? PACE_WORDS[pace.pace] : null,
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <li
      className="grid grid-cols-1 items-center gap-x-8 gap-y-3 border-b border-[color:var(--border-subtle)] py-5 md:grid-cols-[minmax(180px,240px)_minmax(0,1fr)]"
      data-usage-window={window.id}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span id={labelId} className="truncate text-body text-[color:var(--text-default)]">
          {window.label}
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="text-title font-semibold tracking-tight text-[color:var(--text-strong)]">{figure}</span>
          {used !== null && !reset && window.status !== 'rejected' ? (
            <span className="text-meta text-[color:var(--text-muted)]">used</span>
          ) : null}
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <Meter
          value={used}
          marker={pace?.elapsedPercent ?? null}
          warn={usageWindowIsWarning(window, now)}
          ariaLabelledBy={labelId}
          ariaValueText={words}
        />
        <div className="flex items-center justify-between gap-4 text-meta text-[color:var(--text-muted)]">
          <span className="inline-flex items-center gap-1.5">
            {pace ? (
              <>
                <PaceGlyph pace={pace.pace} />
                <span>{PACE_WORDS[pace.pace]}</span>
              </>
            ) : null}
          </span>
          {resets ? <span className="tabular-nums">{resets}</span> : null}
        </div>
      </div>
    </li>
  )
}

/** Trending up (ahead), level (on pace) or down (under), beside the word that says it. */
function PaceGlyph({ pace }: { pace: UsagePace }): JSX.Element {
  const d =
    pace === 'ahead'
      ? 'M2 11.5l4-4 3 3 5-5.5M10 5h4v4'
      : pace === 'under'
        ? 'M2 4.5l4 4 3-3 5 5.5M10 11h4V7'
        : 'M2 8h12M10 5l3 3-3 3'
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
