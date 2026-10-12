import React from 'react'

// The code block's header marks that the vocabulary did not have yet, and the
// zoom marks of the diagram viewer a drawn block opens. All sit on the 16-grid
// at the ui/ primitives' stroke (1.4), in `currentColor`, so they ink and size
// exactly like the copy glyph beside them (design-system/glyphs/wrap-lines.svg,
// terminal-prompt.svg, view-source.svg, enlarge.svg, plus.svg and minus.svg are
// the framework-neutral samples).

type GlyphProps = { className?: string }

/**
 * Wrap long lines: a full line, a line that runs to the edge and turns back
 * under itself with an arrowhead, and the short line it continues on. The turn
 * is the whole meaning — without it the mark is a paragraph icon.
 */
export function WrapLinesGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M2.5 3.5h11M2.5 8h8.25a2.25 2.25 0 0 1 0 4.5H8M9.5 11 8 12.5 9.5 14M2.5 12.5h3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * A terminal at its prompt: the frame, the `>` and the cursor waiting after it.
 * It stands for "put this at a terminal's prompt", which is why it is the
 * prompt and not a play triangle — nothing runs until the person presses Enter,
 * and a play mark would promise that it does.
 */
export function TerminalPromptGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M5 6.5 7 8.5 5 10.5M8.5 10.5h3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Show the source: a pair of angle brackets, the mark for "the code behind
 * this". It switches a block that draws its source — a diagram — to the text
 * it was drawn from, so it is a toggle, pressed while the source shows.
 */
export function ViewSourceGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Open the drawing larger: two arrows pushing out to opposite corners. It
 * opens a view of the same drawing, so it says "bigger", not "new window".
 */
export function EnlargeGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Zoom in: the plus, drawn as `glyphs/plus.svg` is. */
export function ZoomInGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/** Zoom out: the plus without its upright. */
export function ZoomOutGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M3.2 8h9.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
