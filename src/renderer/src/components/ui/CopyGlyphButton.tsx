import React, { useCallback, useEffect, useRef, useState } from 'react'
import { CheckIcon, CopyIcon } from '../AppIcons'
import { copyToClipboardWithToast, type ClipboardTextSource } from '../../utils/copyToClipboardWithToast'
import { IconButton, type GhostTone } from './Buttons'
import { Tooltip } from './Tooltip'

/**
 * How long the check holds before the copy glyph comes back. Long enough to be
 * seen after the eye lands on it, short enough that the control is plainly a
 * copy button again by the time anyone reaches for it twice. A timer, not a
 * transition, so it has no motion token to take.
 */
export const COPY_CONFIRM_MS = 1200

/** How a rich copy is asked for as markdown alone, said after its label. */
const MARKDOWN_ONLY_HINT = 'Shift-click for Markdown'

export type CopyGlyphButtonProps = {
  /** What lands on the clipboard. A function is called only on click, so an
   *  expensive serialisation (a whole transcript, a table) costs nothing until
   *  someone copies. */
  text: ClipboardTextSource
  /** Optional `text/html` flavour written beside the plain text. With one, a
   *  Shift-click writes the plain text alone — the markdown, for a paste into
   *  a rich editor that should show the source — and the tooltip says so. */
  html?: string | (() => string)
  /** The accessible name and the tooltip — "Copy code", "Copy message". It never
   *  changes: the confirmation is announced, not renamed onto the button. */
  label: string
  /** `xs` (24px, the hit-target floor) for dense headers; `sm` (26px) for a
   *  toolbar. */
  size?: 'xs' | 'sm'
  tone?: GhostTone
  /** Lands on the wrapper, which is the element that sits in the layout — use
   *  `focus-within:` rather than `focus-visible:` for a reveal-on-focus. */
  className?: string
  onCopied?: () => void
}

/**
 * The one copy affordance: a glyph, never the word. On a successful copy the
 * glyph swaps to a check for `COPY_CONFIRM_MS` and a polite live region says
 * "Copied", so the confirmation arrives where the pointer and the screen reader
 * already are instead of in a corner toast. A failed copy reports through the
 * shared toast and never shows the check.
 *
 * The whole control carries `data-copy-exclude`: it sits inside rendered
 * conversation content, and a selection copied across it must not pick up its
 * chrome. The click stops here, because a copy glyph lives in rows and cards
 * that toggle on click, and copying something must not also collapse it.
 */
export function CopyGlyphButton({
  text,
  html,
  label,
  size = 'sm',
  tone,
  className,
  onCopied,
}: CopyGlyphButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  const handleClick = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      // A re-click while the check is up is a no-op rather than a second write:
      // the clipboard already holds this, and restarting the timer would hold
      // the check for as long as someone keeps clicking.
      if (copied) return
      const ok = await copyToClipboardWithToast(text, { html: event.shiftKey ? undefined : html, success: 'silent' })
      if (!ok || !mountedRef.current) return
      setCopied(true)
      onCopied?.()
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        setCopied(false)
      }, COPY_CONFIRM_MS)
    },
    [copied, html, onCopied, text],
  )

  const glyphSize = size === 'xs' ? 'size-icon-xs' : 'size-icon-sm'
  const tooltip = html === undefined ? label : `${label} · ${MARKDOWN_ONLY_HINT}`

  return (
    <span data-copy-exclude="" className={['relative inline-flex', className ?? ''].join(' ')}>
      <Tooltip content={tooltip}>
        <IconButton size={size} tone={tone} aria-label={label} onClick={(event) => void handleClick(event)}>
          {copied ? (
            <CheckIcon className={`${glyphSize} text-[color:var(--tone-good)]`} />
          ) : (
            <CopyIcon className={glyphSize} />
          )}
        </IconButton>
      </Tooltip>
      {/* Always mounted, so the text change is what gets announced; a region
          inserted already holding "Copied" is skipped by most screen readers. */}
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? 'Copied' : ''}
      </span>
    </span>
  )
}
