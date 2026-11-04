import React, { useLayoutEffect, useRef, useState } from 'react'

// Text that gives its FRONT away when it does not fit, keeping its end: a
// branch name, whose tail says what the branch is for while its head is a
// prefix every branch shares ("fix/", "feat/") — "fix/cli-update-output"
// reads "…cli-update-output" (design-system/components/truncated-text →
// Front truncation).
//
// Measured, not CSS: `direction: rtl` with an ellipsis moves punctuation to
// the wrong end of the name and reads it back in the wrong order, which on a
// branch (all slashes and hyphens) is most of the text.

/**
 * `text` cut from the front to at most `maxChars` characters, with a leading
 * "…". Whole leading `/` segments go first ("feat/a/b-c" → "…a/b-c" →
 * "…b-c"); only when the last segment alone does not fit is it cut inside a
 * segment, still keeping its end — and then at the next word when one is near
 * ("…machine", not "…er-machine"), so the kept end never opens on half a word.
 * Null when that would keep fewer than `minChars` characters (or the whole of
 * a shorter text): the caller decides what a text too long for its room
 * becomes.
 */
export function frontTruncate(text: string, maxChars: number, minChars = 1): string | null {
  if (text.length <= maxChars) return text
  if (maxChars < Math.min(Math.max(minChars, 2), text.length)) return null
  const segments = text.split('/')
  for (let index = 1; index < segments.length; index++) {
    const tail = segments.slice(index).join('/')
    if (!tail) break
    const candidate = `…${tail}`
    if (candidate.length <= maxChars) return candidate
  }
  const cut = text.length - (maxChars - 1)
  // A shorter tail that starts on a word reads; a longer one that starts
  // mid-word does not. Never below a short word, nor below the caller's floor.
  const shortest = Math.max(WORD_TAIL_MIN, minChars - 1)
  for (let start = cut; text.length - start >= shortest; start++) {
    if (WORD_BREAK.test(text[start - 1] ?? '')) return `…${text.slice(start)}`
  }
  return `…${text.slice(cut)}`
}

const WORD_BREAK = /[-_.]/
const WORD_TAIL_MIN = 4

/**
 * The text, front-truncated to the room its box has. The box takes the space
 * its row leaves (`flex-1 min-w-0`), so put it last in a row, or where growing
 * into the rest of the row is harmless. It never wraps. A screen reader hears
 * the whole text: the visible cut is `aria-hidden` beside an `sr-only` copy of
 * the full one.
 *
 * Under jsdom, and before the first layout, nothing is measured and the text
 * is whole.
 */
export function FrontTruncatedText({
  text,
  className = '',
  minChars = 4,
}: {
  text: string
  className?: string
  /** The fewest characters a cut keeps; below that the shortest cut is drawn and clipped. */
  minChars?: number
}): React.JSX.Element {
  const boxRef = useRef<HTMLSpanElement | null>(null)
  const textRef = useRef<HTMLSpanElement | null>(null)
  const [shown, setShown] = useState(text)

  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    const measure = (): void => {
      const inner = textRef.current
      const room = box.clientWidth
      if (!inner || room <= 0) return
      const drawn = inner.textContent ?? ''
      const width = inner.getBoundingClientRect().width
      if (!drawn.length || width <= 0) return
      // The drawn text's width per character: exact for the monospace this
      // is mostly used with, and close enough for a proportional face.
      const charWidth = width / drawn.length
      const chars = Math.floor(room / charWidth)
      const next =
        frontTruncate(text, chars, minChars) ?? `…${text.slice(Math.max(0, text.length - Math.max(1, minChars - 1)))}`
      setShown((current) => (current === next ? current : next))
    }
    measure()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(box)
    return () => observer.disconnect()
  }, [text, minChars])

  const cut = shown !== text
  return (
    <span ref={boxRef} className={`block min-w-0 flex-1 overflow-hidden whitespace-nowrap ${className}`}>
      <span ref={textRef} aria-hidden={cut || undefined}>
        {cut ? shown : text}
      </span>
      {cut ? <span className="sr-only">{text}</span> : null}
    </span>
  )
}
