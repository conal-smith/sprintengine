import { textDirection } from './textDirection'

// Arabic and Hebrew in a rendered document. Each top-level block — a
// paragraph, a heading, a list, a quote, a table — reads in the direction of
// most of its words (`textDirection.ts`), so an Arabic reply reads right to
// left between English ones. Lines inside a list or a quote follow it, which
// keeps the bullets and the quote's rule on the same side as the text.
//
// Only a block that reads right to left is marked. The page around it is left
// to right already, so an English block keeps exactly the markup it had.

// The slice of the markdown syntax tree this pass reads and writes, declared
// here for the same reason the alert pass declares its own.
type DirectionSyntaxNode = {
  type: string
  value?: string
  children?: DirectionSyntaxNode[]
  data?: { hProperties?: Record<string, unknown> }
}

// The blocks read as prose. A code block, a formula, a rule and a footnote
// keep the page's direction.
const PROSE_BLOCKS = new Set(['paragraph', 'heading', 'list', 'blockquote', 'table'])

// Blocks inside a block. Each is counted apart from its neighbours, so the
// last word of one list item and the first of the next are two words, not one.
const NESTED_BLOCKS = new Set([...PROSE_BLOCKS, 'listItem', 'tableRow', 'tableCell'])

// Code and math read left to right whatever is around them, so their words
// do not vote.
const CODE = new Set(['inlineCode', 'code', 'inlineMath', 'math'])

// Inside a right-to-left block, inline code and inline math are isolated left
// to right, so `fetch()` keeps its parentheses where they were written and a
// formula is not laid out backwards. Code and math blocks are left to right
// on their own frames (`markdown.tsx`, `CodeBlock.tsx`).
const INLINE_CODE = new Set(['inlineCode', 'inlineMath'])

function proseText(node: DirectionSyntaxNode): string {
  if (node.type === 'text') return node.value ?? ''
  if (CODE.has(node.type) || node.type === 'break') return ' '
  const text = (node.children ?? []).map(proseText).join('')
  return NESTED_BLOCKS.has(node.type) ? ` ${text} ` : text
}

function withProperty(node: DirectionSyntaxNode, dir: 'ltr' | 'rtl'): void {
  node.data = { ...node.data, hProperties: { ...node.data?.hProperties, dir } }
}

function isolateInlineCode(node: DirectionSyntaxNode): void {
  for (const child of node.children ?? []) {
    if (INLINE_CODE.has(child.type)) withProperty(child, 'ltr')
    else isolateInlineCode(child)
  }
}

/** Remark plugin: a right-to-left `dir` on each top-level block that reads that way. */
export function remarkTextDirection() {
  return (tree: DirectionSyntaxNode) => {
    for (const block of tree.children ?? []) {
      if (!PROSE_BLOCKS.has(block.type) || textDirection(proseText(block)) !== 'rtl') continue
      withProperty(block, 'rtl')
      isolateInlineCode(block)
    }
  }
}
