import type { Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { remarkHeadingIds } from './markdownHeadingIds'
import { remarkMathDelimiters } from './markdownMath'
import { remarkTextDirection } from './markdownTextDirection'
import { remarkUserText } from './markdownUserText'
import { showCodexFollowupLabels } from './markdownCodexFollowups'
import { repairMarkdownFileLinks } from './markdownFileLinks'
import { keepInsightLineBreaks } from './markdownInsight'
import { remarkWindowsPaths } from './markdownWindowsPaths'

// How markdown is parsed, apart from how it is drawn: the page's renderer
// (`markdown.tsx`) and the clipboard's (`markdownClipboardHtml.tsx`) read a
// reply with the same passes, so what is pasted is the structure that was
// shown.

// The slice of the markdown syntax tree the alert pass reads. Declared here
// rather than imported: the pass touches four fields, and the tree's own types
// belong to a package this renderer only reaches through remark.
type MarkdownSyntaxNode = {
  type: string
  value?: string
  children?: MarkdownSyntaxNode[]
  data?: { hProperties?: Record<string, unknown> }
}

const ALERT_MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\r?\n|$)/iu

/**
 * A GitHub alert — a blockquote whose first line is `[!NOTE]`, `[!TIP]`,
 * `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` and nothing else. Agents write
 * them because GitHub renders them; left alone the marker reads as stray
 * brackets. The marker comes out of the text and the kind rides on the
 * blockquote for the component to draw.
 */
function remarkGithubAlerts() {
  return (tree: MarkdownSyntaxNode) => markAlerts(tree)
}

function markAlerts(node: MarkdownSyntaxNode): void {
  for (const child of node.children ?? []) {
    if (child.type === 'blockquote') markAlert(child)
    markAlerts(child)
  }
}

function markAlert(quote: MarkdownSyntaxNode): void {
  const paragraph = quote.children?.[0]
  const text = paragraph?.type === 'paragraph' ? paragraph.children?.[0] : undefined
  if (!paragraph?.children || text?.type !== 'text' || typeof text.value !== 'string') return
  const match = ALERT_MARKER.exec(text.value)
  if (!match) return
  text.value = text.value.slice(match[0].length)
  if (!text.value) paragraph.children.shift()
  if (paragraph.children[0]?.type === 'break') paragraph.children.shift()
  if (!paragraph.children.length) quote.children?.shift()
  quote.data = { ...quote.data, hProperties: { ...quote.data?.hProperties, dataAlert: match[1].toLowerCase() } }
}

const SYNTAX_PLUGINS = [remarkGfm, remarkGithubAlerts, remarkHeadingIds, remarkWindowsPaths]
// Each list ends on the direction pass (`markdownTextDirection.ts`), which
// reads the words as the passes before it left them: HTML a person typed is
// text by then, and a formula is a formula.
export const MARKDOWN_PLUGINS = [...SYNTAX_PLUGINS, remarkTextDirection]
export const USER_TEXT_PLUGINS = [...SYNTAX_PLUGINS, remarkUserText, remarkTextDirection]
// remark-math builds the formulas' nodes; which delimiters open one is ours
// (`markdownMath.tsx`), and a single dollar never does: in a reply it is a
// price or a shell variable far more often than a formula.
export const MATH_PLUGINS: NonNullable<Options['remarkPlugins']> = [
  ...SYNTAX_PLUGINS,
  remarkMath,
  remarkMathDelimiters,
  remarkTextDirection,
]

/**
 * An agent's reply as it is parsed: a local file link written without the `>`
 * that closes its destination is closed (`markdownFileLinks.ts`), a ★ Insight
 * block keeps the line breaks it was written with (`markdownInsight.ts`), and a
 * follow-up Codex suggests reads as its label (`markdownCodexFollowups.ts`).
 */
export function repairReplyMarkdown(markdown: string): string {
  return keepInsightLineBreaks(repairMarkdownFileLinks(showCodexFollowupLabels(markdown)))
}
