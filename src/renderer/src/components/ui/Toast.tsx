import { useEffect, useRef, useState, type ReactNode } from 'react'
import CliIcon from '../CliIcon'
import { GhostButton, PrimaryButton } from './Buttons'
import { Spinner } from './Spinner'
import { StatusDot } from './StatusDot'
import type { Tone } from './tokens'

const TOAST_ROLE: Record<Tone, 'status' | 'alert'> = {
  neutral: 'status',
  good: 'status',
  accent: 'status',
  warn: 'alert',
  error: 'alert',
}

const TOAST_LIVE: Record<Tone, 'polite' | 'assertive'> = {
  neutral: 'polite',
  good: 'polite',
  accent: 'polite',
  warn: 'assertive',
  error: 'assertive',
}

// Opinionated auto-dismiss policy. Every tone leaves on its own (owner
// ruling 2026-09-28 — the notification bell and the surfaces behind each
// report keep them; a corner of stale cards is furniture). Warn and error
// linger twice as long as a success, and hovering or focusing the card holds
// the clock, so nothing is raced while being read. A producer that needs a
// toast to stay passes `autoDismissMs: false` (the app-update steps do).
const TOAST_AUTO_DISMISS_MS: Record<Tone, number | false> = {
  neutral: 5000,
  good: 5000,
  accent: 5000,
  warn: 10000,
  error: 10000,
}

type ToastProps = {
  tone: Tone
  title: string
  description?: string
  /** Programmatic dismiss. Also wired to the trailing dismiss button when
   *  supplied. Required for auto-dismiss to fire. */
  onDismiss?: () => void
  /** Called when the PERSON presses the dismiss button, before `onDismiss`.
   *  The timer never calls it: a toast that timed out was not dismissed by
   *  anyone. The update toasts read it as "not now" and clear the update's
   *  badges (owner ruling 2026-09-25); a report with nothing to clear omits it. */
  onDismissPressed?: () => void
  /** Override the tone-default auto-dismiss policy. Pass `false` to keep the
   *  toast until the user dismisses it, or a number of ms to override the
   *  tone default. */
  autoDismissMs?: number | false
  className?: string
  /** An agent CLI's glyph in place of the tone dot — the CLI-update toast. */
  cli?: string
  /** The action row. The CLI-update toast is the ONE toast that carries one
   *  (owner ruling 2026-09-04); the toast spec's action-row variant. */
  actions?: ReadonlyArray<{ id: string; label: string; primary?: boolean; busy?: boolean; run: () => void }>
  /** The acting body, under the description: the pair-request toast's code
   *  field and its answers (owner ruling 2026-09-05, the toast spec's
   *  answer-in-place variant). One producer; see the store's `content`. */
  content?: ReactNode
}

export function Toast({
  tone,
  title,
  description,
  onDismiss,
  onDismissPressed,
  autoDismissMs,
  className,
  cli,
  actions,
  content,
}: ToastProps) {
  const resolved = autoDismissMs ?? TOAST_AUTO_DISMISS_MS[tone]

  // The clock is keyed on the POLICY, never on the callback: a host that
  // passes a fresh `onDismiss` closure each render (the region does, per
  // toast) would otherwise restart every toast's 5 s whenever any toast
  // arrived or left. The ref always calls the latest callback when it fires.
  const onDismissRef = useRef(onDismiss)
  useEffect(() => {
    onDismissRef.current = onDismiss
  }, [onDismiss])
  // Held while the pointer is over the card or focus is inside it; letting
  // go restarts the full duration rather than leaving a sliver of it.
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const held = hovered || focused
  useEffect(() => {
    if (resolved === false || held) return
    const id = window.setTimeout(() => onDismissRef.current?.(), resolved)
    return () => window.clearTimeout(id)
  }, [resolved, held])

  return (
    <div
      role={TOAST_ROLE[tone]}
      aria-live={TOAST_LIVE[tone]}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false)
      }}
      className={[
        // toast-enter is defined in src/renderer/src/assets/index.css and is
        // disabled inside the global `prefers-reduced-motion: reduce` rule.
        'toast-enter flex items-start gap-2 rounded-md border px-3 py-2',
        // Glass (owner ruling 2026-09-04):
        // `surface-glass` is bg.surface-raised at glass.opacity over a blur of
        // the page, with a hairline and shadow.toast to draw the card's
        // edge over whatever shows through. The toast is the ONE surface
        // allowed to blur — its area is a corner, not a viewport — and the
        // conformance lint pins the utility to this file. shadow.toast is a
        // lit top edge, lit from above like the primary button's, over a
        // lifted drop (owner ruling 2026-09-28), so the card reads as sitting
        // ON the page, not in it.
        'surface-glass shadow-[var(--shadow-toast)] border-[color:var(--border-default)]',
        'text-meta text-[color:var(--text-default)]',
        className ?? '',
      ].join(' ')}
    >
      {cli ? (
        <CliIcon cli={cli} className="mt-px size-icon-sm shrink-0 text-[color:var(--text-default)]" />
      ) : (
        // The tone's status mark, by shape: the app draws no status dots.
        <StatusDot tone={tone} className="mt-px" />
      )}
      <div className="min-w-0 flex-1">
        <div className="font-medium leading-tight text-[color:var(--text-strong)]">{title}</div>
        {description ? (
          <div className="mt-0.5 break-words text-micro leading-snug text-[color:var(--text-muted)]">{description}</div>
        ) : null}
        {content}
        {actions && actions.length > 0 ? (
          <div className="mt-2 flex justify-end gap-1.5">
            {actions.map((action) =>
              action.primary ? (
                // `busy`: the press went through and the work it started is
                // running (the app-update toast's Restart, owner ruling
                // 2026-09-24). Disabled, with the spinner beside the label.
                <PrimaryButton key={action.id} size="xs" onClick={action.run} busy={action.busy} disabled={action.busy}>
                  {action.busy ? <Spinner className="icon-sm" /> : null}
                  {action.label}
                </PrimaryButton>
              ) : (
                <GhostButton key={action.id} size="xs" onClick={action.run} disabled={action.busy}>
                  {action.label}
                </GhostButton>
              ),
            )}
          </div>
        ) : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={() => {
            onDismissPressed?.()
            onDismiss()
          }}
          aria-label="Dismiss"
          // The floor is the token, not a typed box: the target used to be
          // `h-5 w-5` — 20px, under `--sem-size-hit-target-min` (24px), which
          // the component spec names as one of the two things that must survive
          // a rebuild. The negative margin keeps the flow advance the 20px
          // target had, so widening the target moves nothing beside it.
          className={[
            'interactive -m-1 inline-flex min-h-[var(--hit-target-min)] min-w-[var(--hit-target-min)] shrink-0 items-center justify-center rounded-xs',
            'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
            'focus-visible:focus-ring',
          ].join(' ')}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      ) : null}
    </div>
  )
}
