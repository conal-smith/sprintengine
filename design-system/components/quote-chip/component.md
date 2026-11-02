# Quote chip

A passage of an agent's reply, quoted into the person's next message. Select
words in one reply, press **Quote** (the selection toolbar, or the quote
shortcut), and the passage goes into the composer as a chip with an optional
comment. The chip, the comment editor that opens with it, and the card a
marked passage shows in the reply are one family, documented together here.
The message carries the quote as a token inside its text
(`src/shared/chat-quotes.ts`); these pieces are how that token is drawn.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Chip | `.ds-quote-chip` | yes — inline, `quote.ink`, no box and no ground |
| Link | `.ds-quote-chip__link` | yes — the [link button](../link-button/component.md) in its `--quote` ink (`QuoteLinkButton`); opens the quote's popover |
| Number | `.ds-quote-chip__number` | yes — the quote's number in the conversation: a small filled pill, `quote.on-badge` on `quote.badge` |
| Glyph | `QuoteGlyph` | yes — the quote mark, `icon-xs`, centred on the line as the words are |
| Label | `.ds-quote-chip__label` | yes — the comment, or with none the start of the passage; at most 40 characters, cut at the last whole word with a single "…" straight after it (no space, no stray punctuation) |
| Pencil | `.ds-quote-chip__edit` | composer only — `EditChangelistGlyph`, the bare pencil, muted, centred on the line; edits the comment |
| Mark | `.ds-quote-mark` | in the reply — `quote.tint` behind the passage, painted through the CSS Custom Highlight API |
| Badge | `.ds-quote-badge` | in the reply — the same pill as the chip's number, raised into the leading over the end of the passage's last line like a superscript, so it covers neither the words after the passage nor the line above; kept inside the prose column |
| Editor | `.ds-quote-overlay.ds-quote-editor` | the overlay surface, one borderless auto-growing field, one muted check (Save) at the bottom right |
| Card | `.ds-quote-overlay.ds-quote-card` | the overlay surface, a little below the passage, the comment (or the quoted words in muted italics) and, for a draft quote, the pencil and × at the top right — one icon-button size and one muted ink for both, glyphs at one icon step |

The editor has no title, no hint line, no Cancel button and no coloured edge:
the placeholder ("Add an optional comment…") says what it is for, and the
keys say the rest.

## Variants

- **In the composer.** Number, glyph, label and the pencil. The token is an
  atomic range in the editor: the caret steps over the chip, and Backspace or
  Delete takes it whole. The live preview, which shows the markdown of the
  caret's line raw, leaves it a chip.
- **In a sent message.** The same chip without the pencil: what was sent is
  not edited.
- **Draft and sent marks.** A passage a quote in the draft cites is marked in
  `quote.tint` with its number on `quote.badge`; one a sent message cites is
  marked in `quote.tint-sent` with its number on `quote.badge-sent`, history
  rather than work in hand. The mark is the tint alone, with no underline, so
  a link or emphasis inside the passage keeps its own line.

## States

| State | Treatment |
|---|---|
| Rest | Gold ink; the number on its tint |
| Hover (chip) | The link underlines, as every link button does |
| Focus | The product's focus ring, on the link and on the pencil separately |
| Popover open | `aria-expanded` on the link; the popover shows the passage (blockquote, muted), the comment and **Go to source**. It opens above the message bubble or composer the chip sits in, clear of its words and controls, and below it only when there is no room above |
| Hover (mark) | After a short rest, the card opens under the passage. It stays while the pointer crosses into it and closes a moment after the pointer has left both |
| Go to source | The transcript scrolls to the reply (paging in older turns if needed) and the passage is lit with a second layer of tint for about a second |

## Usage

**Only a passage of one reply is a chip.** A selection of the person's own
message, a run across several messages or a step's output has no single reply
to point back at, and is quoted as a markdown blockquote instead. The same
8,000-character cap applies to both, refused with a toast rather than cut.

**The number is the conversation's.** A new quote takes one more than the
highest number among the conversation's sent messages and the draft, and the
number is stored with the quote, so the chip, the badge in the reply and the
`[quote N]` the agent reads agree.

**The card is a popover, not a tooltip.** It holds controls for a draft
quote, and a tooltip is never interactive ([tooltip](../tooltip/component.md)).
A sent quote's card holds no controls.

**Gold is the quote's alone.** `quote.*` marks quotes and nothing else: not a
warning (that is `status.warn`), not a find match (`find.*`), not a link.

## Accessibility

- The chip's link is named "Quote N: label" and states `aria-haspopup` and
  `aria-expanded` for its popover. The number inside it is `aria-hidden`, since
  the name already says it.
- The pencil is named "Edit comment on quote N" and carries a tooltip; the
  check is named "Save".
- The editor is a dialog named "Comment on quote N"; its field takes focus as
  it opens. Enter saves, ⌘/Ctrl+Enter saves and sends, Shift+Enter is a new
  line, Escape closes it — and on a quote just made, takes the quote back out.
  A press outside keeps what was typed.
- The badges in the reply are drawn in an `aria-hidden` layer over the
  transcript; the marks change no text, so a screen reader reads the reply
  as written.
- `quote.ink` clears AA as small text on the app's grounds, and
  `quote.on-badge` on `quote.badge`, in both modes.

## Shipped implementation

`src/renderer/src/components/panels/agentChat/chatQuotes.tsx` (`QuoteChip`,
`SentQuoteChip`, `QuotePopover`, `QuoteCommentEditor`),
`composerQuoteChips.ts` (the editor extension), `quoteHighlights.tsx` (marks,
badges and the card), `quoteAnchors.ts` (finding a passage again) and
`useChatQuotes.tsx` (the chat's wiring).
