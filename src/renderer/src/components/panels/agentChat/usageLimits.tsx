import React, { useEffect, useId, useState, type JSX } from 'react'

import {
  USAGE_LIMIT_STALE_AFTER_MS,
  formatUsageResetIn,
  isProviderWideUsageWindow,
  usageProviderLabel,
  usageWindowHasReset,
  usageWindowIsWarning,
  usageWindowPace,
  type UsageLimitProvider,
  type UsageLimitSnapshot,
  type UsageLimitWindow,
  type UsageLimitsState,
} from '../../../../../shared/usage-limits'
import { useRelativeNow, useRelativeNowFor } from '../../../hooks/useRelativeNow'
import { retainUsageLimits, selectUsageLimitSnapshot, useUsageLimitsStore } from '../../../store/usageLimitsStore'
import { GhostButton, Popover, Tooltip } from '../../ui'
import { Meter } from '../../ui/Meter'
import { Modal, ModalBody, ModalHeader } from '../../ui/Modal'
import { formatTimeOfDay } from '../../../utils/clockFormat'

// The subscription's usage limits — the five-hour session window and the
// weekly ones — where a person checks a budget before they send: the open
// chat's composer strip, beside the context ring. The ring is the chat's own
// budget; this is the account's, and the line already reads as "what is spent".
//
// These limits are not the app's account: they are the agent's, and appear
// on the chats whose agent has them. The same list opens from the command
// palette ("Show usage limits") for a person with no such chat open, and in
// the Limits view of the usage dashboard the rail's chart glyph opens.
//
// Only what the agents reported is drawn, and only for a subscription: the
// list is empty rather than a guess before the first report, and a provider
// on an API key is never in it.

const RESET_TICK_MS = 60_000

/**
 * The window that says most about whether the next turn runs: the fullest of
 * the account-wide ones not yet reset. A window that meters one model (Opus's
 * weekly, a Codex model's own bucket) has its row in the list, but it says
 * nothing about a chat on another model, so the strip never heads with it.
 */
export function headlineWindow(snapshot: UsageLimitSnapshot, now: number): UsageLimitWindow | null {
  let best: UsageLimitWindow | null = null
  for (const window of snapshot.windows) {
    if (usageWindowHasReset(window, now) || !isProviderWideUsageWindow(window)) continue
    const rank = (candidate: UsageLimitWindow): number =>
      candidate.status === 'rejected' ? 1000 : (candidate.usedPercent ?? -1)
    if (!best || rank(window) > rank(best)) best = window
  }
  return best
}

/** One window in words: "42% used · resets in 2h 13m", "Limit reached · resets in 12m", "Reset". */
export function usageWindowWords(window: UsageLimitWindow, now: number): string {
  if (usageWindowHasReset(window, now)) return 'Reset'
  // A source can say where a window stands without how full it is.
  const used =
    window.status === 'rejected'
      ? 'Limit reached'
      : window.usedPercent !== null
        ? `${Math.round(window.usedPercent)}% used`
        : window.status === 'warning'
          ? 'Close to the limit'
          : 'Within the limit'
  return window.resetsAt !== null ? `${used} · resets in ${formatUsageResetIn(window.resetsAt, now)}` : used
}

/** "as of 3:12 PM" for a reading old enough to say so, else null. */
export function usageReadingAge(observedAt: number, now: number): string | null {
  if (now - observedAt < USAGE_LIMIT_STALE_AFTER_MS) return null
  const at = new Date(observedAt)
  const sameDay = new Date(now).toDateString() === at.toDateString()
  const time = formatTimeOfDay(at)
  return sameDay ? `as of ${time}` : `as of ${at.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

/** The trigger's name and tooltip: the provider and its fullest window. */
export function usageStripLabel(snapshot: UsageLimitSnapshot, now: number): string {
  const window = headlineWindow(snapshot, now)
  const provider = `${usageProviderLabel(snapshot.provider)} usage limits`
  return window
    ? `${provider}: ${window.label}, ${usageWindowWords(window, now)}`
    : `${provider}: every account-wide window has reset`
}

const PACE_WORDS = { ahead: 'ahead of pace', on: 'on pace', under: 'under pace' } as const

function UsageWindowRow({ window, now }: { window: UsageLimitWindow; now: number }): JSX.Element {
  const labelId = useId()
  const reset = usageWindowHasReset(window, now)
  const pace = reset ? null : usageWindowPace(window, now)
  const words = usageWindowWords(window, now)
  return (
    <div className="flex flex-col gap-1" data-usage-window={window.id}>
      <div className="flex items-baseline justify-between gap-3 text-meta">
        <span id={labelId} className="min-w-0 truncate text-[color:var(--text-default)]">
          {window.label}
        </span>
        <span className="shrink-0 tabular-nums text-[color:var(--text-subtle)]">{words}</span>
      </div>
      <Meter
        value={reset ? null : window.status === 'rejected' && window.usedPercent === null ? 100 : window.usedPercent}
        marker={pace?.elapsedPercent ?? null}
        warn={usageWindowIsWarning(window, now)}
        ariaLabelledBy={labelId}
        ariaValueText={pace ? `${words}, ${PACE_WORDS[pace.pace]}` : words}
      />
      {/* Said only when it changes what to do: running out before the reset. */}
      {pace?.pace === 'ahead' ? (
        <span className="text-micro text-[color:var(--text-subtle)]">
          Ahead of pace: at this rate it runs out first
        </span>
      ) : null}
    </div>
  )
}

function UsageProviderSection({ snapshot, now }: { snapshot: UsageLimitSnapshot; now: number }): JSX.Element {
  const headingId = useId()
  const age = usageReadingAge(snapshot.observedAt, now)
  const plan = snapshot.plan ? snapshot.plan.charAt(0).toUpperCase() + snapshot.plan.slice(1) : null
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2" data-usage-provider={snapshot.provider}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={headingId} className="text-meta font-medium text-[color:var(--text-strong)]">
          {usageProviderLabel(snapshot.provider)}
          {plan ? <span className="font-normal text-[color:var(--text-subtle)]"> · {plan}</span> : null}
        </h3>
        {age ? <span className="shrink-0 text-micro text-[color:var(--text-subtle)]">{age}</span> : null}
      </div>
      {snapshot.windows.map((window) => (
        <UsageWindowRow key={window.id} window={window} now={now} />
      ))}
    </section>
  )
}

/**
 * Every provider's windows, the given one first. Ticks once a minute while it
 * is drawn, for the "resets in" words; nothing else here keeps time.
 */
export function UsageLimitsPanel({
  state,
  first = null,
}: {
  state: UsageLimitsState | null
  first?: UsageLimitProvider | null
}): JSX.Element {
  const now = useRelativeNow(RESET_TICK_MS)
  const snapshots = [...(state?.snapshots ?? [])].sort(
    (a, b) => Number(b.provider === first) - Number(a.provider === first),
  )
  if (snapshots.length === 0) {
    return (
      <p className="text-meta text-[color:var(--text-subtle)]" data-usage-empty="">
        No usage limits reported yet. They appear once a Claude or Codex chat on a subscription has run a turn.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {snapshots.map((snapshot) => (
        <UsageProviderSection key={snapshot.provider} snapshot={snapshot} now={now} />
      ))}
    </div>
  )
}

/** Holds main's reading in the window while the caller is mounted. */
export function useUsageLimitsState(): UsageLimitsState | null {
  useEffect(() => retainUsageLimits(), [])
  return useUsageLimitsStore((store) => store.state)
}

/**
 * One provider's reading, held while the caller is mounted with a provider.
 * Null for none: nothing is subscribed, and nothing re-renders the caller.
 */
export function useUsageLimitSnapshot(provider: UsageLimitProvider | null): UsageLimitSnapshot | null {
  useEffect(() => (provider ? retainUsageLimits() : undefined), [provider])
  return useUsageLimitsStore((store) => selectUsageLimitSnapshot(store.state, provider))
}

/**
 * The strip's mark: the provider's fullest window as a small bar, in the warn
 * tone at 90% or at the limit. The tooltip says it in words; a click opens
 * every provider's windows.
 */
export function UsageLimitsStripButton({ snapshot }: { snapshot: UsageLimitSnapshot }): JSX.Element {
  const [open, setOpen] = useState(false)
  // Redrawn when the words change, at most once a minute: a reset passing
  // empties the bar, and "resets in" counts down.
  const now = useRelativeNowFor((at) => usageStripLabel(snapshot, at), RESET_TICK_MS)
  const state = useUsageLimitsStore((store) => store.state)
  const window = headlineWindow(snapshot, now)
  const label = usageStripLabel(snapshot, now)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Usage limits"
      popupRole="dialog"
      placement="top-end"
      surfaceClassName="w-[300px] p-3"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <Tooltip content={label} placement="top" wrapperClassName="flex">
          <GhostButton
            ref={ref}
            size="xs"
            tone="subtle"
            onClick={togglePopover}
            {...triggerProps}
            aria-label={label}
            data-strip-usage-limits={snapshot.provider}
            className="px-1.5"
          >
            <Meter
              compact
              value={window ? (window.status === 'rejected' ? 100 : window.usedPercent) : null}
              warn={window ? usageWindowIsWarning(window, now) : false}
            />
          </GhostButton>
        </Tooltip>
      )}
    >
      <UsageLimitsPanel state={state} first={snapshot.provider} />
    </Popover>
  )
}

/**
 * The same list as a dialog, for the command palette's "Show usage limits": a
 * person with no Claude or Codex chat open has no strip to open it from.
 */
export function UsageLimitsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const titleId = useId()
  const state = useUsageLimitsState()
  return (
    <Modal open onClose={onClose} labelledBy={titleId} size="confirm">
      <ModalHeader
        title="Usage limits"
        subtitle="Your Claude and Codex subscriptions, as the agents last reported them."
        titleId={titleId}
        onClose={onClose}
      />
      <ModalBody>
        <UsageLimitsPanel state={state} />
      </ModalBody>
    </Modal>
  )
}
