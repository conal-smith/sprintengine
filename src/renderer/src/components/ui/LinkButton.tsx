import React from 'react'

import { FOCUS_RING_CLASS } from './tokens'

// The TEXT LINK that is a button — an action set inside a sentence
// (design-system/components/link-button).
//
// "Reconnect" at the end of a ` · `-separated state line. "More" under a clamped
// description. "Search GitHub" beside a field. A repo path inside rendered
// markdown that opens a file rather than a URL. None of these navigates, so none
// of them is an `<a href>`; all of them read as prose, so none of them is a
// button with a box.
//
// The kit had no answer. `GhostButton` is the quietest member and still brings a
// 26px control height, an 8px inset, `font-medium` and a hover fill — put that
// inside a 20px metadata line and the line grows, the words either side stop
// being level with it, and the "link" reads as a control someone forgot to
// finish. So every one of these stayed a raw `<button>` with `border-0
// bg-transparent p-0` written out by hand, which is four utilities cancelling
// the browser rather than a shape the system named.
//
// What it is: baseline flow, the caller's own type unless it asks otherwise, an
// ink pair, an optional underline, and the product's one focus ring. Nothing
// else. It is the smallest member of the button family and the only one with no
// box at all.

/**
 * - `accent` (default) — accent ink, deepening to `accent.hover`, underlined on
 *   hover. Accent as INK is inside the budget (`principles.md` → The accent
 *   budget); what the budget forbids is the accent as a fill, which this never
 *   takes.
 * - `quiet` — `text.muted` lifting to `text.primary`, with a PERSISTENT
 *   underline in `border.strong`. The disclosure case: "More", "Show details".
 *   The underline is standing rather than on hover because a quiet link with no
 *   underline and no box is indistinguishable from the sentence around it.
 * - `name` — `text.primary`, underlined on hover. The name of the thing a row
 *   is about, when the name is what opens that thing's details (Settings ›
 *   Extensions): it must read as the row's title at rest, and the accent
 *   would make every title in the list a second accent.
 * - `quote` — `quote.ink`, the gold a quoted passage is marked in, underlined on
 *   hover. A quote's chip, in the composer and in a sent message: it reads as
 *   words in the sentence, in the colour its passage is marked with in the
 *   reply, so the two are seen to be one thing.
 */
export type LinkInk = 'accent' | 'quiet' | 'name' | 'quote'

const INK: Record<LinkInk, string> = {
  accent:
    'text-[color:var(--accent-primary)] hover:text-[color:var(--accent-primary-hover)] ' +
    'disabled:hover:text-[color:var(--accent-primary)]',
  quiet:
    'text-[color:var(--text-muted)] hover:text-[color:var(--text-strong)] ' +
    'disabled:hover:text-[color:var(--text-muted)]',
  name: 'text-[color:var(--text-strong)]',
  quote: 'text-[color:var(--sem-color-quote-ink)]',
}

/**
 * - `hover` — the underline appears under the pointer. The accent default: the
 *   colour is already doing the work at rest.
 * - `always` — a standing underline in `border.strong`, offset off the
 *   baseline so descenders clear it. What `quiet` needs to be findable.
 * - `never` — no underline in any state. For a link whose surrounding markup
 *   draws its own affordance (a `group-hover:` treatment on the children), and
 *   for a mono path where an underline collides with the glyphs.
 */
export type LinkUnderline = 'hover' | 'always' | 'never'

const UNDERLINE: Record<LinkUnderline, string> = {
  hover: 'no-underline hover:underline',
  always: 'underline underline-offset-2 decoration-[color:var(--border-strong)]',
  never: 'no-underline',
}

/**
 * - `inline` (default) — baseline flow, `display: inline`. A link set inside a
 *   sentence, which is what this primitive is for.
 * - `row` — a full-width flex row, for a LIST of links: the conversation peek's
 *   changed files, where the name, the folder and the counts are three columns
 *   that have to line up down the list.
 *
 * A variant rather than something a caller adds through `className`, because a
 * `flex` written there does not reliably beat this file's `inline`: both are
 * `display` utilities at the same specificity, so which wins is Tailwind's
 * emission order rather than the order of the class attribute. A row that
 * silently went back to `inline` would put the whole path on one baseline with
 * no columns at all.
 */
export type LinkLayout = 'inline' | 'row'

export type LinkButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  ink?: LinkInk
  underline?: LinkUnderline
  layout?: LinkLayout
  /**
   * Take the surrounding text's size and weight instead of the kit's
   * `font.size.meta`.
   *
   * The default is `meta`, which is where nearly all of these sit — a state
   * line, a footer, a caption. `inherit` is for the link set inside PROSE the
   * caller has already sized: a repo path inside rendered markdown, a name
   * inside a heading. A size of our own there would make one word of a sentence
   * a different size from the rest of it, which is worse than any consistency it
   * buys.
   */
  size?: 'meta' | 'inherit'
}

export const LinkButton = React.forwardRef<HTMLButtonElement, LinkButtonProps>(function LinkButton(
  { className, ink = 'accent', underline, layout = 'inline', size = 'meta', type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      {...rest}
      className={[
        // No `inline-flex`, no height, no inset, no ground, no press scale. An
        // inline-flex box does not sit on the surrounding text's baseline, and
        // a control that shrank 3% mid-sentence would move the words after it.
        // `radius.chip` exists only so the focus ring has corners to draw round;
        // nothing is painted inside it.
        layout === 'row'
          ? 'flex w-full min-w-0 items-baseline rounded-xs bg-transparent text-left transition-colors'
          : 'inline rounded-xs bg-transparent text-left transition-colors',
        size === 'meta' ? 'text-meta' : 'text-[length:inherit] font-[inherit] leading-[inherit]',
        INK[ink],
        UNDERLINE[underline ?? (ink === 'quiet' ? 'always' : 'hover')],
        // The disabled link keeps its ink and drops the underline: a sentence
        // whose one action has gone `text.disabled` reads as broken copy rather
        // than as an unavailable action, and disabled ink is certified for
        // non-text contrast only.
        'disabled:cursor-not-allowed disabled:no-underline disabled:opacity-45',
        'disabled:hover:no-underline',
        FOCUS_RING_CLASS,
        className ?? '',
      ].join(' ')}
    />
  )
})
