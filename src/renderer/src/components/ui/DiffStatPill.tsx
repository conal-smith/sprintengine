import React from 'react'

import { FOCUS_RING_CLASS } from './tokens'
import { formatDiffCount } from '../../utils/diffCount'

// DiffStatPill — how much a checkout has changed, as one small split pill: the
// added half in the diff green on its wash, the removed half in the diff red on
// its wash, touching, under one pill corner (design-system/components/diff-stat-pill).
//
// The inks and washes are the diff channel's own (`--diff-added` /
// `--diff-removed` over `--tone-good-soft` / `--tone-error-soft`), the pair the
// diff viewer already draws its lines in, so a theme that tunes its diff
// colours moves this pill with its diffs rather than with its status tones.
//
// A half with nothing to say is not drawn: no "+0", no "−0". Nothing to say at
// all draws nothing — a clean checkout is not a zero worth a pill.

const SHELL =
  'inline-flex h-control-xs shrink-0 items-stretch overflow-hidden whitespace-nowrap ' +
  'rounded-[var(--sem-radius-pill)] font-mono text-micro font-semibold leading-none tabular-nums'
const HALF = 'flex items-center px-1.5'

export function DiffStatPill({
  added,
  removed,
  onClick,
  ariaLabel,
  className = '',
}: {
  /** What the added half counts (the caller's unit: files or lines). */
  added: number
  /** What the removed half counts. */
  removed: number
  /** Opens what the counts are of. Absent, the pill is a display. */
  onClick?: () => void
  /**
   * The counts in words, which the halves cannot be: "3 files added, 2
   * removed — open changes". Required for the button; on a display it names
   * the pill as an image.
   */
  ariaLabel: string
  className?: string
}): React.JSX.Element | null {
  if (added <= 0 && removed <= 0) return null
  const halves = (
    <>
      {added > 0 ? (
        <span className={`${HALF} bg-[color:var(--tone-good-soft)] text-[color:var(--diff-added)]`}>
          +{formatDiffCount(added)}
        </span>
      ) : null}
      {removed > 0 ? (
        <span className={`${HALF} bg-[color:var(--tone-error-soft)] text-[color:var(--diff-removed)]`}>
          −{formatDiffCount(removed)}
        </span>
      ) : null}
    </>
  )
  if (!onClick) {
    return (
      <span role="img" aria-label={ariaLabel} data-diff-stat-pill="" className={`${SHELL} ${className}`}>
        {halves}
      </span>
    )
  }
  return (
    // A button of its own rather than a ghost around the pill: the pill IS the
    // control's surface — two washes under one corner — and a ghost's ground
    // and padding would draw a second box around it. The press scale and the
    // focus ring are the kit's; the hover is a hairline on the pill's edge.
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      data-diff-stat-pill=""
      className={`interactive ${SHELL} hover:ring-1 hover:ring-inset hover:ring-[color:var(--border-strong)] ${FOCUS_RING_CLASS} ${className}`}
    >
      <span aria-hidden="true" className="contents">
        {halves}
      </span>
    </button>
  )
}
