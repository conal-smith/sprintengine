// The inline styles copied HTML carries, so a paste into an email or a document
// keeps code in a monospace face and a table ruled. Shared by the two ways a
// conversation reaches the clipboard — a copy button rendering the markdown
// (`markdownClipboardHtml.tsx`) and a copied selection (`selectionToMarkdown.ts`)
// — so both paste the same way.
//
// Only what the editors a paste lands in keep, and nothing that sets a colour
// on text or ground: a paste takes the destination's own ink, and reads on a
// white page and a dark one alike. The one grey is a rule, which reads on both.
// They are the receiving document's styles, not the app's, so they are written
// out here rather than taken from the design tokens, whose values are custom
// properties that mean nothing outside the app.

// Any face a reader's machine has: the platform monospaces first, then the
// generic family every editor maps to one.
const MONOSPACE = "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace"
const RULE_GREY = '#aaaaaa'
const HAIRLINE = `1px solid ${RULE_GREY}`
const CELL = `border:${HAIRLINE};padding:4px 8px`

/**
 * The style attribute each tag carries. `codeBlock` is a `code` inside a `pre`,
 * which takes the block's size rather than shrinking again.
 */
export const PASTE_STYLES = {
  pre: `${MONOSPACE};font-size:13px;line-height:1.45;white-space:pre-wrap;padding:8px 12px;border:${HAIRLINE};border-radius:4px`,
  codeBlock: MONOSPACE,
  code: `${MONOSPACE};font-size:0.95em`,
  table: 'border-collapse:collapse',
  blockquote: `margin:0 0 1em;padding:0 0 0 12px;border-left:3px solid ${RULE_GREY}`,
} as const

/**
 * A task item's box, as the character that draws one. A form control is
 * dropped by a mail client's paste filter, and the item would lose whether it
 * was done; a character survives every editor.
 */
export function pasteTaskBox(checked: boolean): string {
  return checked ? '\u2611' : '\u2610'
}

/** A table cell's style: ruled, padded, and aligned as its column is. */
export function pasteCellStyle(align: string | null | undefined): string {
  return `${CELL};text-align:${align && /^(?:left|center|right)$/u.test(align) ? align : 'left'}`
}
