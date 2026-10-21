import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

/**
 * A reply's markdown as the words a reader sees, for a preview too small to
 * render it in: `## Operators` reads "Operators", `**either**` reads "either",
 * `[the docs](https://…)` reads "the docs". A preview that showed the source
 * spent its three lines on pound signs, asterisks and link targets.
 *
 * Only the start is parsed, since a preview never shows more than a few lines
 * and a long reply is re-read as it streams. A table's cells, a list's items
 * and a code block's lines all come out as text, so a reply that opens with
 * code still previews as that code; HTML keeps its text and loses its tags.
 * Whitespace is not collapsed here; the caller cuts the preview to length.
 */

const parser = unified().use(remarkParse).use(remarkGfm).freeze()

const PREVIEW_SOURCE_LIMIT = 1500

type MarkdownRoot = ReturnType<typeof parser.parse>
type MarkdownNode = MarkdownRoot | MarkdownRoot['children'][number]

// A run of inline content is one piece of text: `**op**erators` is one word.
// Everything else (blocks, list items, table rows) is set apart by a space.
const INLINE_PARENTS = new Set<MarkdownNode['type']>([
  'paragraph',
  'heading',
  'tableCell',
  'emphasis',
  'strong',
  'delete',
  'link',
  'linkReference',
])

// A tag that formats text inside a line vanishes; any other tag (a `<br>`, a
// `<div>`, a `<p>`) stands between two words, so it leaves a space.
const INLINE_TAG = /^(?:a|abbr|b|code|del|em|i|ins|kbd|mark|s|small|span|strong|sub|sup|u)$/iu

function htmlText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, '')
    .replace(/<\/?([a-z][\w-]*)(?:[^"'<>]|"[^"]*"|'[^']*')*>/giu, (_tag, name: string) =>
      INLINE_TAG.test(name) ? '' : ' ',
    )
}

function nodeText(node: MarkdownNode): string {
  if (node.type === 'html') return htmlText(node.value)
  if (node.type === 'break') return ' '
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? ''
  if ('value' in node) return node.value
  if (!('children' in node)) return ''
  const children = node.children as MarkdownNode[]
  return children.map(nodeText).join(INLINE_PARENTS.has(node.type) ? '' : ' ')
}

export function markdownPreviewText(markdown: string): string {
  return nodeText(parser.parse(markdown.slice(0, PREVIEW_SOURCE_LIMIT)))
}
