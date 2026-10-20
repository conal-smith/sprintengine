import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

import { remarkMathDelimiters } from '../../shared/conversation/markdownMathSyntax'
import type { ExportAlert, ExportBlock, ExportInline, ExportListItem, ExportTableAlign } from './chat-export-document'

// A reply's markdown read into the export's blocks, by the parser the chat
// draws it with: GitHub-flavoured markdown and the chat's own math delimiters
// (`$$…$$`, `\(…\)`, `\[ … \]`; a single dollar is a price, never math). Each
// writer turns the blocks into its format, so a table is a table in all three
// and no writer parses markdown of its own.
//
// What the chat leaves as text stays text: raw HTML is shown as the words it
// is, never as markup, and a footnote reference keeps its `[^1]`.

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkMathDelimiters)

// The slice of the syntax tree read here. The parser's own types are a
// package of their own; this reads few enough fields to say them itself.
type MdNode = {
  type: string
  value?: string
  depth?: number
  ordered?: boolean | null
  start?: number | null
  checked?: boolean | null
  lang?: string | null
  url?: string
  alt?: string | null
  align?: Array<'left' | 'center' | 'right' | null>
  identifier?: string
  label?: string | null
  children?: MdNode[]
}

const ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/iu

/** `text` as the export's blocks. Never throws: what cannot be read is a paragraph of its words. */
export function parseExportMarkdown(text: string): ExportBlock[] {
  if (!text.trim()) return []
  try {
    return blocksOf((parser.parse(text) as MdNode).children ?? [])
  } catch {
    return [{ kind: 'paragraph', content: [{ kind: 'text', text }] }]
  }
}

function blocksOf(nodes: readonly MdNode[]): ExportBlock[] {
  return nodes.flatMap(blockOf)
}

function blockOf(node: MdNode): ExportBlock[] {
  switch (node.type) {
    case 'heading':
      return [{ kind: 'heading', level: clampLevel(node.depth), content: inlinesOf(node.children) }]
    case 'paragraph': {
      const content = inlinesOf(node.children)
      return content.length ? [{ kind: 'paragraph', content }] : []
    }
    case 'list':
      return [
        {
          kind: 'list',
          ordered: node.ordered === true,
          ...(node.ordered && typeof node.start === 'number' && node.start !== 1 ? { start: node.start } : {}),
          items: (node.children ?? []).map(listItemOf),
        },
      ]
    case 'code':
      // A ```math fence is a formula the chat typesets; every other fence is
      // code, mermaid included: the export draws no diagrams.
      if ((node.lang ?? '').toLowerCase() === 'math') return [{ kind: 'math', tex: (node.value ?? '').trim() }]
      return [{ kind: 'code', ...(node.lang ? { language: node.lang } : {}), text: node.value ?? '' }]
    case 'math':
      return [{ kind: 'math', tex: (node.value ?? '').trim() }]
    case 'blockquote':
      return [quoteOf(node)]
    case 'table':
      return [tableOf(node)]
    case 'thematicBreak':
      return [{ kind: 'rule' }]
    case 'html':
      return node.value?.trim() ? [{ kind: 'paragraph', content: [{ kind: 'text', text: node.value }] }] : []
    // A footnote's text is read where it is defined, after the reply.
    case 'footnoteDefinition':
      return [
        {
          kind: 'paragraph',
          content: [{ kind: 'text', text: `[^${node.label ?? node.identifier ?? ''}]: ` }],
        },
        ...blocksOf(node.children ?? []),
      ]
    // Link definitions are spent on the links that use them.
    case 'definition':
      return []
    default:
      return node.children ? blocksOf(node.children) : node.value ? [paragraphOf(node.value)] : []
  }
}

function listItemOf(node: MdNode): ExportListItem {
  return {
    ...(typeof node.checked === 'boolean' ? { checked: node.checked } : {}),
    blocks: blocksOf(node.children ?? []),
  }
}

// GitHub's alerts (`> [!NOTE]`), which the chat draws as a labelled callout,
// are a quote that knows its kind; anything else is a quote.
function quoteOf(node: MdNode): ExportBlock {
  const children = node.children ?? []
  const first = children[0]
  const lead = first?.type === 'paragraph' ? first.children?.[0] : undefined
  const match = lead?.type === 'text' && lead.value ? ALERT_MARKER.exec(lead.value) : null
  if (!match || !first || !lead?.value) return { kind: 'quote', blocks: blocksOf(children) }
  const rest = lead.value.slice(match[0].length)
  const firstChildren = [...(rest ? [{ ...lead, value: rest }] : []), ...(first.children ?? []).slice(1)]
  while (firstChildren[0]?.type === 'break') firstChildren.shift()
  const blocks = blocksOf([
    ...(firstChildren.length ? [{ ...first, children: firstChildren }] : []),
    ...children.slice(1),
  ])
  return { kind: 'quote', alert: match[1]!.toLowerCase() as ExportAlert, blocks }
}

function tableOf(node: MdNode): ExportBlock {
  const [head, ...rows] = node.children ?? []
  const cells = (row: MdNode | undefined) => (row?.children ?? []).map((cell) => inlinesOf(cell.children))
  const width = Math.max(head?.children?.length ?? 0, ...rows.map((row) => row.children?.length ?? 0))
  const align: ExportTableAlign[] = Array.from({ length: width }, (_, index) => node.align?.[index] ?? null)
  return { kind: 'table', align, head: cells(head), rows: rows.map(cells) }
}

function inlinesOf(nodes: readonly MdNode[] | undefined): ExportInline[] {
  const out: ExportInline[] = []
  for (const node of nodes ?? []) {
    for (const inline of inlineOf(node)) {
      const previous = out.at(-1)
      // Adjacent words are one run, so a writer emits one span, not ten.
      if (inline.kind === 'text' && previous?.kind === 'text') previous.text += inline.text
      else out.push(inline)
    }
  }
  return out
}

function inlineOf(node: MdNode): ExportInline[] {
  switch (node.type) {
    case 'text':
      return node.value ? [{ kind: 'text', text: node.value }] : []
    case 'strong':
    case 'emphasis':
    case 'delete':
      return [{ kind: node.type, children: inlinesOf(node.children) }]
    case 'inlineCode':
      return [{ kind: 'code', text: node.value ?? '' }]
    case 'inlineMath':
      return [{ kind: 'math', tex: (node.value ?? '').trim() }]
    case 'break':
      return [{ kind: 'break' }]
    case 'link':
      return [{ kind: 'link', href: node.url ?? '', children: inlinesOf(node.children) }]
    // A link by reference reads as its words: its definition is spent here.
    case 'linkReference':
      return inlinesOf(node.children)
    case 'image':
      return [{ kind: 'image', alt: node.alt ?? '', src: node.url ?? '' }]
    case 'imageReference':
      return node.alt ? [{ kind: 'text', text: node.alt }] : []
    case 'footnoteReference':
      return [{ kind: 'text', text: `[^${node.label ?? node.identifier ?? ''}]` }]
    case 'html':
      return node.value ? [{ kind: 'text', text: node.value }] : []
    default:
      return node.children ? inlinesOf(node.children) : node.value ? [{ kind: 'text', text: node.value }] : []
  }
}

function paragraphOf(text: string): ExportBlock {
  return { kind: 'paragraph', content: [{ kind: 'text', text }] }
}

function clampLevel(depth: number | undefined): 1 | 2 | 3 | 4 | 5 | 6 {
  return Math.min(6, Math.max(1, depth ?? 1)) as 1 | 2 | 3 | 4 | 5 | 6
}
