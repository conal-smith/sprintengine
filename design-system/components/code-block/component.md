# Code block

## Anatomy

A card set into the reading flow: `bg.well` (a translucent tint of the ink, so
it separates from the conversation canvas, a panel or a card alike in both
modes), a `border.subtle` hairline and the control radius. Inside it, top to
bottom:

1. **Header** — one row, set off from the source by a `border.subtle` divider.
   - _Left:_ the label. A block with a known filename shows the filename in
     the mono face, led by its file-type glyph, truncated with the full path in
     a tooltip. Otherwise the language's name in the UI face — TypeScript,
     Bash, JSON, never the fence's `ts` / `sh` / `json` — led by the file-type
     glyph when the vocabulary has one for it. No language is "Plain text"; a
     language nobody has mapped is shown as the fence wrote it.
   - _Right:_ the actions, all glyphs at `icon-xs` inside `xs` icon buttons, in
     this order: a surface's own actions, Paste into terminal (shell blocks
     only, see Variants), Show source (drawn blocks only), Wrap lines, Copy
     code.
2. **Source** — a real `<pre><code>`, mono at `font.size.body`, leading
   `font.line.code` (1.6), padded `space.md` × `space.lg`.
3. **Fold control** (long blocks only) — a ghost button with the chevron,
   "Show all N lines" / "Show less".
4. **Note** — a quiet line under the block: "Highlighting stopped at 2000
   lines" past 2000 lines, or the surface's own word on the block, such as why
   a diagram shows as its source. A surface may give it one action, set after
   it as a link button behind ` · ` ("Retry" when a diagram's renderer did not
   load).

A filename comes from the fence info: `title="src/app.ts"`, `file=` /
`filename=` / `path=`, or a bare path after the language (` ```ts src/app.ts `).
A fence tag that is itself a path (` ```src/app.ts `) is read as the filename,
and the language comes from its extension.

**For code that reads the rendered block** (the selection-to-markdown copy):
the root carries `data-code-block` and `data-code-language` — the
highlighter's id when it knows the language, else the fence's own tag
lowercased, else empty. The header, the fold control and the note carry
`data-copy-exclude`. The edge fades are masks on the source, not elements, so
there is nothing else to exclude.

## Variants

- **Unwrapped** (default): long lines scroll horizontally. When they overflow,
  the edges with code past them fade (`space.3xl`), and only those edges.
- **Wrapped**: the Wrap lines toggle is pressed; whitespace is preserved and
  long lines wrap anywhere. No edge fades.
- **Shell** (`bash`, `sh`, `zsh`, `shell`, `console`): a surface that can reach
  a terminal adds Paste into terminal (`TerminalPromptGlyph`). It puts the
  command at a prompt and never presses Enter. A `$ ` or `% ` prompt at the
  start of a line comes off it (an indented one is output, as in curl's
  progress table); when some lines carry a prompt, only those lines, the lines
  a trailing `\` continues onto and the body of a here-document they open are
  the command, and the rest is output. A `console` block is a session, so it is
  offered only when its prompts mark the commands. `fish` and PowerShell are
  not offered — their syntax is not the login shell's.
- **Drawn** (a reply's ` ```mermaid ` block): a surface hands the block a
  drawing made from its source, and the drawing takes the source's place,
  centred at its own size and shrunk to the column, padded like the source.
  Show source (`ViewSourceGlyph`, an `aria-pressed` toggle) switches to the
  source and back; Wrap lines is offered only while the source shows, and the
  fold never applies to a drawing. The source stays in the DOM, hidden, so Copy
  code and a selection across the block both take the source. A drawing is
  never shown while the block streams. Its surface action is Open diagram
  (`EnlargeGlyph`): the same drawing in a `workbench` dialog, fitted to it
  (enlarged at most twice its size), with Zoom out (`ZoomOutGlyph`), a
  readout that fits it again, and Zoom in (`ZoomInGlyph`) stepping through
  25–400%, and the bare keys `-`, `0` and `+` (⌘ chords stay the app's own
  zoom). It shows the SVG the block already holds, under ids of its own, so
  opening it draws nothing again.
- **Unknown language**: the same card with plain source.

## States

- **Loading**: the source reserves its height, hidden, until the grammar is in —
  plain code never flashes before its colour.
- **Streaming**: completed lines are highlighted once and stay stable; the open
  line is plain. Wrap and copy work (copy takes what has arrived). Paste into
  terminal and the fold control are absent until the block settles.
- **Folded**: a settled block over 20 lines shows its first 12, the last few
  fading out, and "Show all N lines" below. "Show less" folds it again. A block
  first seen while streaming stays open when it settles, so it never pulls lines
  away from someone reading them. Every line is in the DOM either way. A find
  the app runs over its own text (Find in chat) that lands on a folded line
  opens the block, as "Show all" would.
- **Actions**: at rest `text.subtle`; `text.default` under the pointer and
  under keyboard focus. Wrap lines pressed takes the neutral pressed fill.
  Copy swaps to the check for 1.2 s on success
  ([button → The copy glyph](../button/component.md#the-copy-glyph)).
- **Failed grammar**: plain source. **Over 2000 lines**: highlighting stops and
  the note says so.
- **Not drawn**: a drawn block whose source does not parse keeps its source,
  and the note says why ("Shown as source: Parse error on line 2"). A
  renderer that did not load is the network's failure rather than the
  source's, so its note ends in a Retry. Until a drawing is ready the source
  shows, so a block never renders empty.

Light and dark come from the same semantic tokens.

## Usage

Syntax colours identify grammatical roles inside code only (2026-09-26). They
are content, never control accents. Use sem.syntax tokens and do not load the
highlighter in the application's initial bundle.

The actions are always visible, never hover-revealed: a hover-only control is
missing on touch and cannot be found from the keyboard. Their quiet ink is what
keeps them from competing with the code.

A surface that already pages its own output (a tool row showing a file read
with its own "Show all") turns folding off (`collapsible={false}`) rather than
stacking a second disclosure. Don't nest a code block inside another well.

## Accessibility

- The card is a `section` named "‹Language› code" (", ‹filename›" when there is
  one).
- Source stays selectable text in `pre`/`code`; folding clips the box, never the
  text, so find-in-page, selection and copy reach every line.
- Every action is an icon button with a spoken name and a matching tooltip:
  "Paste into terminal", "Wrap lines", "Copy code". Wrap lines is an
  `aria-pressed` toggle with a stable name. Copy announces "Copied" politely;
  a failure reports through the shared toast.
- The fold control is a button with `aria-expanded` and `aria-controls` naming
  the source.
- Header actions keep the visible focus ring. There is no animation to reduce:
  the fades are static masks, and the fold opens without a transition.
