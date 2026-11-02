import { syntaxTree } from '@codemirror/language'
import type { EditorState, Range } from '@codemirror/state'
import {
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view'
import type { SyntaxNodeRef } from '@lezer/common'
import { QUOTE_SCHEME } from '../../../../../shared/chat-quotes'

/**
 * Markdown drawn in place while it is typed. Every line shows its formatting —
 * a heading at heading size, `**bold**` bold with the asterisks gone, a list's
 * dash as a bullet — except the lines the caret or selection is on, which show
 * the raw text so the markup being edited is the markup on screen. Nothing is
 * rewritten: the document is the markdown that gets sent, and the decorations
 * only change how it is drawn.
 *
 * Built for the visible ranges only, from the incremental Lezer parse, so a long
 * pasted handoff costs what fits in the box rather than the whole draft.
 */

const HIDDEN = Decoration.replace({})
const SYNTAX = Decoration.mark({ class: 'cm-md-syntax' })
const STRONG = Decoration.mark({ class: 'cm-md-strong' })
const EMPHASIS = Decoration.mark({ class: 'cm-md-em' })
const STRIKE = Decoration.mark({ class: 'cm-md-strike' })
const INLINE_CODE = Decoration.mark({ class: 'cm-md-code' })
const LINK = Decoration.mark({ class: 'cm-md-link' })
const ORDERED_MARK = Decoration.mark({ class: 'cm-md-list-number' })
const QUOTE_LINE = Decoration.line({ class: 'cm-md-quote' })
const FENCE_LINE = Decoration.line({ class: 'cm-md-fence' })
const FENCE_FIRST_LINE = Decoration.line({ class: 'cm-md-fence cm-md-fence-first' })
const FENCE_LAST_LINE = Decoration.line({ class: 'cm-md-fence cm-md-fence-last' })
const FENCE_ONLY_LINE = Decoration.line({ class: 'cm-md-fence cm-md-fence-first cm-md-fence-last' })
// Headings past the third step take the third's size: a composer is a few
// hundred pixels tall, and the transcript stops growing them there too.
const HEADING_LINE = [1, 2, 3].map((level) => Decoration.line({ class: `cm-md-heading cm-md-h${level}` }))

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const bullet = document.createElement('span')
    bullet.className = 'cm-md-bullet'
    bullet.textContent = '•'
    return bullet
  }
}

class RuleWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const rule = document.createElement('span')
    rule.className = 'cm-md-rule'
    return rule
  }
}

const BULLET = Decoration.replace({ widget: new BulletWidget() })
const RULE = Decoration.replace({ widget: new RuleWidget() })

/**
 * The line numbers that show their raw text: every line a selection range
 * touches, while the field has focus. A field that is not being typed in
 * reveals nothing, so a pasted draft reads as rendered once focus leaves it.
 */
export function revealedLines(state: EditorState, focused: boolean): ReadonlySet<number> {
  const lines = new Set<number>()
  if (!focused) return lines
  for (const range of state.selection.ranges) {
    const last = state.doc.lineAt(range.to).number
    for (let line = state.doc.lineAt(range.from).number; line <= last; line++) lines.add(line)
  }
  return lines
}

function sameLines(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false
  for (const line of a) if (!b.has(line)) return false
  return true
}

/**
 * The decorations for `ranges` of the document (the visible ones, in the
 * editor). Exported apart from the plugin so the rules can be read back
 * against a document without laying one out.
 */
export function livePreviewDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
  revealed: ReadonlySet<number>,
): DecorationSet {
  const { doc } = state
  const decorations: Range<Decoration>[] = []
  const lineOf = (pos: number) => doc.lineAt(pos).number
  const isRevealed = (pos: number) => revealed.has(lineOf(pos))
  // A mark is hidden on a rendered line and dimmed on a revealed one, so the
  // syntax being edited still steps back from the words it wraps. Markup that
  // runs over a line break (a link's `](` and its target on the next line) is
  // taken a line at a time: a view plugin may not hide a line break, and the
  // editor throws on one that tries.
  const markup = (from: number, to: number) => {
    for (let line = doc.lineAt(from); from < to; line = doc.line(line.number + 1), from = line.from) {
      const end = Math.min(to, line.to)
      if (from < end) decorations.push((revealed.has(line.number) ? SYNTAX : HIDDEN).range(from, end))
      if (line.number === doc.lines) break
    }
  }

  const visit = (node: SyntaxNodeRef): boolean | void => {
    switch (node.name) {
      case 'ATXHeading1':
      case 'ATXHeading2':
      case 'ATXHeading3':
      case 'ATXHeading4':
      case 'ATXHeading5':
      case 'ATXHeading6': {
        const level = Math.min(3, Number(node.name.slice(-1)))
        decorations.push(HEADING_LINE[level - 1].range(doc.lineAt(node.from).from))
        return
      }
      case 'SetextHeading1':
      case 'SetextHeading2': {
        const level = Number(node.name.slice(-1))
        const underline = node.node.getChild('HeaderMark')
        const lastText = doc.lineAt(underline ? underline.from - 1 : node.to).number
        for (let line = lineOf(node.from); line <= lastText; line++)
          decorations.push(HEADING_LINE[level - 1].range(doc.line(line).from))
        return
      }
      case 'HeaderMark': {
        // An opening run takes the space after it; a closing run (`# Title ##`)
        // takes the space before it. Either way the heading's words start and
        // end where the rendered line does.
        // A setext heading's underline is a line of its own, so it is dimmed
        // rather than hidden — hiding it would leave a blank line under the title.
        const heading = node.node.parent
        if (heading?.name.startsWith('Setext')) decorations.push(SYNTAX.range(node.from, node.to))
        else if (node.from === heading?.from)
          markup(node.from, node.to + (doc.sliceString(node.to, node.to + 1) === ' ' ? 1 : 0))
        else markup(node.from - (doc.sliceString(node.from - 1, node.from) === ' ' ? 1 : 0), node.to)
        return
      }
      case 'StrongEmphasis':
        decorations.push(STRONG.range(node.from, node.to))
        return
      case 'Emphasis':
        decorations.push(EMPHASIS.range(node.from, node.to))
        return
      case 'Strikethrough':
        decorations.push(STRIKE.range(node.from, node.to))
        return
      case 'EmphasisMark':
      case 'StrikethroughMark':
        markup(node.from, node.to)
        return
      case 'InlineCode':
        decorations.push(INLINE_CODE.range(node.from, node.to))
        return
      case 'CodeMark':
        // A fence's backticks stay on screen: hiding them would leave an empty
        // line at each end of the block. Only an inline span's go.
        if (node.node.parent?.name === 'InlineCode') markup(node.from, node.to)
        else decorations.push(SYNTAX.range(node.from, node.to))
        return
      case 'CodeInfo':
        decorations.push(SYNTAX.range(node.from, node.to))
        return
      case 'FencedCode':
      case 'CodeBlock': {
        const first = lineOf(node.from)
        const last = lineOf(node.to)
        for (let line = first; line <= last; line++) {
          const shape =
            first === last
              ? FENCE_ONLY_LINE
              : line === first
                ? FENCE_FIRST_LINE
                : line === last
                  ? FENCE_LAST_LINE
                  : FENCE_LINE
          decorations.push(shape.range(doc.line(line).from))
        }
        return
      }
      case 'Blockquote': {
        for (let line = lineOf(node.from); line <= lineOf(node.to); line++)
          decorations.push(QUOTE_LINE.range(doc.line(line).from))
        return
      }
      case 'QuoteMark': {
        const end = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
        markup(node.from, end)
        return
      }
      case 'ListMark': {
        const ordered = node.node.parent?.parent?.name === 'OrderedList'
        if (ordered) decorations.push(ORDERED_MARK.range(node.from, node.to))
        else decorations.push((isRevealed(node.from) ? SYNTAX : BULLET).range(node.from, node.to))
        return
      }
      case 'TaskMarker':
        decorations.push(SYNTAX.range(node.from, node.to))
        return
      case 'HorizontalRule':
        decorations.push((isRevealed(node.from) ? SYNTAX : RULE).range(node.from, node.to))
        return
      case 'Link': {
        // `[words](url "title")`: the words stay, drawn as a link; the brackets
        // and everything from `](` on are markup. A reference link (`[words][ref]`)
        // and a bare `[words]` are left as typed — their target is elsewhere.
        const marks = node.node.getChildren('LinkMark')
        const text = (mark: { from: number; to: number }) => doc.sliceString(mark.from, mark.to)
        if (marks.length < 4 || text(marks[1]) !== ']' || text(marks[2]) !== '(') return
        // A quote's token is drawn as its chip (composerQuoteChips.ts), on the
        // caret's line too; marking it here as well would fight the chip.
        const url = node.node.getChild('URL')
        if (url && doc.sliceString(url.from, url.from + QUOTE_SCHEME.length) === QUOTE_SCHEME) return false
        decorations.push(LINK.range(marks[0].to, marks[1].from))
        markup(marks[0].from, marks[0].to)
        markup(marks[1].from, node.to)
        return
      }
      case 'URL':
        // A bare autolink reads as a link; one inside `(…)` was handled above.
        if (node.node.parent?.name !== 'Link') decorations.push(LINK.range(node.from, node.to))
        return false
      case 'LinkMark':
      case 'LinkTitle':
      case 'LinkLabel':
        return false
    }
  }

  for (const { from, to } of ranges) syntaxTree(state).iterate({ from, to, enter: visit })
  return Decoration.set(decorations, true)
}

class LivePreview {
  decorations: DecorationSet
  private revealed: ReadonlySet<number>

  constructor(view: EditorView) {
    this.revealed = revealedLines(view.state, view.hasFocus)
    this.decorations = livePreviewDecorations(view.state, view.visibleRanges, this.revealed)
  }

  update(update: ViewUpdate): void {
    const revealed = revealedLines(update.state, update.view.hasFocus)
    // A caret moving within the lines already shown raw changes nothing drawn,
    // which is most keystrokes' selection update.
    const linesMoved = !sameLines(revealed, this.revealed)
    if (
      !update.docChanged &&
      !update.viewportChanged &&
      !linesMoved &&
      syntaxTree(update.startState) === syntaxTree(update.state)
    )
      return
    this.revealed = revealed
    this.decorations = livePreviewDecorations(update.state, update.view.visibleRanges, revealed)
  }
}

export const markdownLivePreview = ViewPlugin.fromClass(LivePreview, {
  decorations: (plugin) => plugin.decorations,
})
