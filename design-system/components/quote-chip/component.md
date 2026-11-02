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
| Link | `.ds-quote-chip__link` | yes — the [link button](../link-button/component.md)'s `--quote` ink; opens the quote's popover |
| Number | `.ds-quote-chip__number` | yes — the quote's number in the conversation, on `quote.tint` |
| Glyph | `QuoteGlyph` | yes — the quote mark, `icon-xs` |
| Label | `.ds-quote-chip__label` | yes — the comment, or with none the start of the passage; at most 64 characters, cut at 16em with an ellipsis |
| Pencil | `.ds-quote-chip__edit` | composer only — `EditChangelistGlyph`, the bare pencil, muted; edits the comment |
| Mark | `.ds-quote-mark` | in the reply — `quote.tint` behind the passage, painted through the CSS Custom Highlight API |
| Badge | `.ds-quote-badge` | in the reply — the number, just after the passage's last character |
| Editor | `.ds-quote-overlay.ds-quote-editor` | the overlay surface, one borderless auto-growing field, one muted check (Save) at the bottom right |
| Card | `.ds-quote-overlay.ds-quote-card` | the overlay surface, the comment (or the quoted words in muted italics) and, for a draft quote, the pencil and × at the top right |

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
  `quote.tint` with its badge in `quote.ink`; one a sent message cites is
  marked in `quote.tint-sent` with its badge in `quote.ink-sent`, history
  rather than work in hand. The mark is the tint alone, with no underline, so
  a link or emphasis inside the passage keeps its own line.

## States

| State | Treatment |
|---|---|
| Rest | Gold ink; the number on its tint |
| Hover (chip) | The link underlines, as every link button does |
| Focus | The product's focus ring, on the link and on the pencil separately |
| Popover open | `aria-expanded` on the link; the popover shows the passage (blockquote, muted), the comment and **Go to source** |
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
- `quote.ink` clears AA as small text on the app's grounds and on its own
  tint, in both modes.

## Shipped implementation

`src/renderer/src/components/panels/agentChat/chatQuotes.tsx` (`QuoteChip`,
`SentQuoteChip`, `QuotePopover`, `QuoteCommentEditor`),
`composerQuoteChips.ts` (the editor extension), `quoteHighlights.tsx` (marks,
badges and the card), `quoteAnchors.ts` (finding a passage again) and
`useChatQuotes.tsx` (the chat's wiring).
