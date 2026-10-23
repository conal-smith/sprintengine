import { syntaxTree } from '@codemirror/language'
import type { EditorState, Extension, Range } from '@codemirror/state'
import { Decoration, Direction, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { textDirection, type TextDirection } from '../../../utils/textDirection'

/**
 * Arabic and Hebrew in the composer. Each line reads in the direction of most
 * of its words (`textDirection.ts`), the same count the transcript reads a
 * sent message's blocks by. The lines of a list or a quote take one direction
 * between them, which keeps the bullets and the quote's rule on one side; a
 * line with no letters yet continues the one above it, so a new line after
 * Arabic starts on the right. Code is left to right.
 *
 * The editor reads each line's direction back from the page
 * (`perLineTextDirection`), so the arrow keys move the way the line runs, and
 * inline code in a right-to-left line is an isolate the editor knows about
 * (`bidiIsolatedRanges`), so the caret walks through it in order.
 *
 * Only a right-to-left line is marked: the field is left to right already, so
 * an English draft keeps exactly the markup it had. Built for the visible
 * ranges only, like the live preview beside it.
 */

const RTL_LINE = Decoration.line({ attributes: { dir: 'rtl' } })
const LTR_ISOLATE = Decoration.mark({ attributes: { dir: 'ltr' }, bidiIsolate: Direction.LTR })

// Blocks whose lines read as one: a list, a quote, a table.
const GROUPED_BLOCKS = new Set(['BulletList', 'OrderedList', 'Blockquote', 'Table'])
const CODE_BLOCKS = new Set(['FencedCode', 'CodeBlock'])
// Text that is not read as words: code, and the parts of a link that are its
// address rather than its label.
const NOT_PROSE = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'LinkTitle'])

type LineReading = { code: boolean; direction: TextDirection | undefined }

function proseText(state: EditorState, from: number, to: number): string {
  let text = ''
  let at = from
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      const skip = NOT_PROSE.has(node.name) || (node.name === 'URL' && node.node.parent?.name === 'Link')
      if (!skip) return
      const start = Math.max(node.from, at)
      const end = Math.min(node.to, to)
      if (start < end) {
        text += `${state.sliceDoc(at, start)} `
        at = end
      }
      return false
    },
  })
  return text + state.sliceDoc(at, to)
}

// The block a line belongs to, as the document's own child, and whether the
// line is code at any depth (a fence inside a list item is still code).
function lineBlock(state: EditorState, lineNumber: number): { block: SyntaxNode | null; code: boolean } {
  const line = state.doc.line(lineNumber)
  const indent = line.text.length - line.text.trimStart().length
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(line.from + indent, 1)
  let code = false
  let block: SyntaxNode | null = null
  for (; node?.parent; node = node.parent) {
    if (CODE_BLOCKS.has(node.name)) code = true
    block = node
  }
  return { block, code }
}

function readingOf(
  state: EditorState,
  lineNumber: number,
  grouped: Map<number, TextDirection | undefined>,
): LineReading {
  const { block, code } = lineBlock(state, lineNumber)
  if (code) return { code, direction: undefined }
  if (block && GROUPED_BLOCKS.has(block.name)) {
    if (!grouped.has(block.from)) grouped.set(block.from, textDirection(proseText(state, block.from, block.to)))
    return { code, direction: grouped.get(block.from) }
  }
  const line = state.doc.line(lineNumber)
  return { code, direction: textDirection(proseText(state, line.from, line.to)) }
}

/**
 * The direction each line from `first` to `last` reads in (line numbers, both
 * included), or undefined for a code line and for one that no letters have
 * reached yet. Exported apart from the plugin so the rule can be read back
 * against a document without laying one out.
 */
export function composerLineDirections(
  state: EditorState,
  first = 1,
  last = state.doc.lines,
): Array<TextDirection | undefined> {
  const grouped = new Map<number, TextDirection | undefined>()
  // A letterless first line continues the nearest line above it that has
  // letters; a code line between the two takes no part.
  let previous: TextDirection | undefined
  for (let line = first - 1; line >= 1 && !previous; line--) {
    const reading = readingOf(state, line, grouped)
    if (!reading.code) previous = reading.direction
  }
  const directions: Array<TextDirection | undefined> = []
  for (let line = first; line <= last; line++) {
    const reading = readingOf(state, line, grouped)
    if (reading.code) {
      directions.push(undefined)
      continue
    }
    previous = reading.direction ?? previous
    directions.push(previous)
  }
  return directions
}

type DirectionDecorations = { decorations: DecorationSet; isolates: DecorationSet }

function directionDecorations(view: EditorView): DirectionDecorations {
  const { state } = view
  const lines: Range<Decoration>[] = []
  const isolates: Range<Decoration>[] = []
  for (const { from, to } of view.visibleRanges) {
    const first = state.doc.lineAt(from).number
    const last = state.doc.lineAt(to).number
    composerLineDirections(state, first, last).forEach((direction, index) => {
      if (direction !== 'rtl') return
      const line = state.doc.line(first + index)
      lines.push(RTL_LINE.range(line.from))
      syntaxTree(state).iterate({
        from: line.from,
        to: line.to,
        enter: (node) => {
          if (node.name !== 'InlineCode') return
          const start = Math.max(node.from, line.from)
          const end = Math.min(node.to, line.to)
          if (start < end) isolates.push(LTR_ISOLATE.range(start, end))
          return false
        },
      })
    })
  }
  return { decorations: Decoration.set([...lines, ...isolates], true), isolates: Decoration.set(isolates, true) }
}

class TextDirectionView {
  drawn: DirectionDecorations

  constructor(view: EditorView) {
    this.drawn = directionDecorations(view)
  }

  update(update: ViewUpdate): void {
    if (!update.docChanged && !update.viewportChanged && syntaxTree(update.startState) === syntaxTree(update.state))
      return
    this.drawn = directionDecorations(update.view)
  }
}

const textDirectionPlugin = ViewPlugin.fromClass(TextDirectionView, {
  decorations: (plugin) => plugin.drawn.decorations,
})

export const composerTextDirection: Extension = [
  EditorView.perLineTextDirection.of(true),
  textDirectionPlugin,
  EditorView.bidiIsolatedRanges.of((view) => view.plugin(textDirectionPlugin)?.drawn.isolates ?? Decoration.none),
]
