import React, { type JSX } from 'react'
import type { Element } from 'hast'
import ReactMarkdown, { type Components, type ExtraProps, type UrlTransform } from 'react-markdown'
import { Checkbox } from '../components/ui/Checkbox'
import { filenameFromFenceMeta } from '../components/ui/codeBlockModel'
import { CopyGlyphButton } from '../components/ui/CopyGlyphButton'
import { LinkButton } from '../components/ui/LinkButton'
import { MarkdownAlertGlyph, type MarkdownAlertKind } from '../components/ui/MarkdownAlertGlyph'
import { OverflowMenu } from '../components/ui/OverflowMenu'
import { copyToClipboardWithToast } from './copyToClipboardWithToast'
import type { GitLineChange } from './gitDiff'
import { tableCsv, tableHtml, tableMarkdown, tableTsv } from './markdownTableClipboard'
import { remarkFencedCodeValue, singleFencedCode } from './markdownFence'
import { isMarkdownFragmentHref, MARKDOWN_FRAGMENT_PREFIX, markdownFragmentTarget } from './markdownHeadingIds'
import { DisplayMath, InlineMath, isMathLanguage } from './markdownMath'
import { MARKDOWN_PLUGINS, MATH_PLUGINS, repairReplyMarkdown, USER_TEXT_PLUGINS } from './markdownPlugins'

/**
 * A document renders at `document` scale; a document read inside a dense
 * surface (the skill reader) renders at `compact`, where the heading scale is
 * the surface's own and body copy stays at its body size.
 *
 * A conversation is neither. A reply is read in a narrow pane between tool rows
 * and a composer, a paragraph or a short list at a time, and a document's
 * 30px title in it is the largest type in the app. `chat` keeps the reading
 * size and compresses the headings to a small ladder; `chat-compact` is the
 * same scale one step down, for markdown inside a card (a plan, a pending
 * question) where the card's own title is already the top of the ladder.
 */
type MarkdownDensity = 'document' | 'compact' | 'chat' | 'chat-compact'

/**
 * `muted` sets the whole block one ink step down — a reasoning trace, read
 * beside the reply it led to and quieter than it. Only the chat scales read it:
 * their ink comes from two custom properties the tone moves together, so
 * headings, `strong` and code still stand above the body within the block.
 */
type MarkdownTone = 'default' | 'muted'

/**
 * What a link that is not a web URL points at. A renderer that owns a local
 * corpus — the files of one skill — resolves relative hrefs against it: a hit
 * opens in place, a miss is stated as a miss rather than rendered as if it
 * would work.
 */
type MarkdownLinkTarget = { kind: 'file'; path: string } | { kind: 'dead'; reason: string }

export type MarkdownLinkResolver = {
  /** null when the href is not this corpus's to own (a scheme, a fragment). */
  resolve: (href: string) => MarkdownLinkTarget | null
  open: (path: string) => void
}

type MarkdownRenderOptions = {
  lineChanges?: GitLineChange[]
  density?: MarkdownDensity
  tone?: MarkdownTone
  links?: MarkdownLinkResolver
  codeBlock?: React.ComponentType<{
    code: string
    language?: string
    filename?: string
    streaming?: boolean
    /** A line under the block saying why it shows as source (a formula that did not parse). */
    note?: string
  }>
  streaming?: boolean
  bare?: boolean
  renderText?: (text: string, source: 'text' | 'inlineCode') => React.ReactNode
  renderLink?: (href: string, label: React.ReactNode) => React.ReactNode | null
  /**
   * A picture the document shows. `src` is as written — a web or data URL, or a
   * path only the caller knows how to read — and `inLink` says the image is a
   * link's label, where it must not become a second control. Without one, or
   * when it returns null, an image is stated by its alt text.
   */
  renderImage?: (src: string, alt: string, inLink: boolean) => React.ReactNode | null
  /**
   * `#heading` links scroll to their heading in the same document (on unless
   * false). Off hands a fragment to `renderLink` like any other href.
   */
  inPageLinks?: boolean
  /**
   * The text is a message a person typed, not a document: every newline is a
   * line break and HTML shows as the text it is (`remarkUserText`).
   */
  userText?: boolean
  /**
   * The text is an agent's reply: a local file link written without the `>`
   * that closes its destination is closed before the parse
   * (`markdownFileLinks.ts`), a ★ Insight block keeps the line breaks it was
   * written with (`markdownInsight.ts`), and a follow-up Codex suggests reads as
   * its label (`markdownCodexFollowups.ts`). Off for a document, which renders
   * as written.
   */
  repairFileLinks?: boolean
  /**
   * Typeset math (`markdownMath.tsx`): `$$…$$` and `\(…\)` inline, `$$` and
   * `\[` blocks, and ```math fences. Off for a document, where a dollar sign is
   * as likely to be a price as anything, and for a person's own text.
   */
  math?: boolean
}

type MarkdownNode = Element | undefined
type MarkdownComponentProps<TagName extends keyof JSX.IntrinsicElements> = React.ComponentPropsWithoutRef<TagName> &
  ExtraProps

// Prose, so it takes the ramp step *below* the 15px it used to hard-code, not
// the one above: `text-title` would put document body text at the same size as
// the titles over it and spend a third font size the "3 per view" ceiling has
// no room for. At `text-heading` the document scale's h6 (`text-sm`) matches it
// in size and separates on weight, which is the hierarchy this scale already
// declares it carries.
const baseTextClass = 'text-heading leading-7 text-[color:var(--text-default)]'
const compactTextClass = 'text-meta leading-[1.65] text-[color:var(--text-default)]'
const SAFE_MARKDOWN_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const LINK_CLASS =
  'text-[color:var(--accent-primary)] underline underline-offset-2 hover:text-[color:var(--accent-primary-hover)]'

/**
 * Per-element classes for each density. Hierarchy is carried by weight, colour
 * and space — no rules under headings — so the two scales differ only in size
 * and rhythm.
 */
type MarkdownScale = {
  h1: string
  h2: string
  h3: string
  h4: string
  h5: string
  h6: string
  p: string
  list: string
  pre: string
  code: string
  strong: string
  em: string
  blockquote: string
  alert: string
  hr: string
  /** The block around a table: its scroller and its copy footer. */
  tableBlock: string
  /** A display formula: the block's own rhythm, scrolling sideways when it is wider than the column. */
  math: string
  table: string
  th: string
  td: string
}

// The table chrome every density shares, after the kit's Table
// (design-system/components/table): row hairlines only, no verticals and no
// header fill, so the body reads as a field and the header's rule is the
// strongest line in it. The header is a label row — it holds its line rather
// than wrapping a column title under itself.
const TABLE_HEAD_CLASS =
  'whitespace-nowrap border-b border-[color:var(--border-default)] text-left align-bottom font-semibold'
const TABLE_CELL_CLASS = 'border-b border-[color:var(--border-subtle)] text-left align-top'

// The conversation scales' ink: two custom properties set on the markdown root
// (index.css, `.markdown-rendered`), so a muted block and a blockquote move all
// of their ink with one declaration instead of each element knowing its context.
const CHAT_INK = 'text-[color:var(--markdown-ink)]'
const CHAT_INK_STRONG = 'text-[color:var(--markdown-ink-strong)]'

// KaTeX gives a display formula its own vertical margin; the block's rhythm
// already spaces it, so that margin goes. A formula wider than the column
// scrolls inside its block instead of pushing the pane wider.
const MATH_BLOCK_CLASS = 'overflow-x-auto overflow-y-hidden [&_.katex-display]:m-0'

/**
 * The conversation ladder. Everything is on the type ramp, and the step from
 * body to the biggest heading is one or two ramp steps, not four: in a reply,
 * a heading is a signpost between paragraphs, so hierarchy comes from weight
 * and ink — headings, `strong` and inline code in strong ink over a body one
 * step quieter — rather than from size. The last two rungs step down in ink
 * instead of size, the way the compact ladder's do.
 *
 * Blocks carry bottom margins only, and headings top ones, so a gap between two
 * blocks is one margin rather than whichever collapse wins; the first and last
 * blocks give theirs up so a message sits flush in its row.
 */
function chatScale(steps: {
  text: string
  h1: string
  h2: string
  h3: string
  h4: string
  h5: string
  h6: string
  gap: string
  table: string
  cell: string
}): MarkdownScale {
  const block = `${steps.gap} last:mb-0`
  const heading = 'first:mt-0 font-semibold leading-snug'
  const body = `${steps.text} ${CHAT_INK}`
  return {
    h1: `${steps.h1} ${heading} ${CHAT_INK_STRONG}`,
    h2: `${steps.h2} ${heading} ${CHAT_INK_STRONG}`,
    h3: `${steps.h3} ${heading} ${CHAT_INK_STRONG}`,
    h4: `${steps.h4} ${heading} ${CHAT_INK}`,
    h5: `${steps.h5} ${heading} ${CHAT_INK}`,
    h6: `${steps.h6} ${heading} text-[color:var(--text-muted)]`,
    p: `${body} ${block}`,
    // Markers hang in the gutter, so wrapped lines align with the text and not
    // under the bullet; item rhythm and nested lists are index.css's.
    list: `${body} ${block} pl-5`,
    pre: `${block} overflow-x-auto rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] p-3 text-meta leading-[1.6] text-[color:var(--text-default)]`,
    // A neutral pill in strong ink: an identifier is one of the things a reader
    // scans a reply for, so it stands out by contrast, not by a status hue. The
    // mono face runs wide, so it steps under the surrounding text's size.
    code: `rounded-xs border border-[color:var(--border-subtle)] bg-[color:var(--bg-active)] px-[0.3em] py-[0.05em] text-[0.9em] ${CHAT_INK_STRONG} break-words box-decoration-clone [pre_&]:text-[1em]`,
    strong: `font-semibold ${CHAT_INK_STRONG}`,
    // Emphasis is a change of voice, not of importance: it keeps the ink it is in.
    em: 'italic',
    // A quote is someone else's words, so it steps its whole ink down —
    // `strong` inside it included — and the rule, not an indent, marks it.
    blockquote: `${block} border-l-2 border-[color:var(--border-default)] pl-3 [--markdown-ink:var(--text-muted)] [--markdown-ink-strong:var(--text-default)] ${CHAT_INK}`,
    alert: `${block} ${steps.text}`,
    hr: `my-4 border-0 border-t border-[color:var(--border-subtle)] first:mt-0 last:mb-0`,
    tableBlock: `${steps.gap} last:mb-0`,
    math: `${block} ${MATH_BLOCK_CLASS} ${CHAT_INK}`,
    // Sized to its content, not squeezed to the pane: a squeezed column breaks
    // `acme-large-2026-09` at every hyphen and a number across two lines. A
    // cell wraps only past a cap — a readable line, and never most of the pane,
    // so a two-column table of prose still fits a narrow pane beside its label
    // column — and a table wider than that scrolls (see MarkdownTable).
    table: `w-max min-w-full border-collapse text-left ${steps.table} tabular-nums leading-normal ${CHAT_INK}`,
    // The outer columns sit flush with the prose around the table, so its text
    // starts on the same edge as the paragraph above it.
    th: `${TABLE_HEAD_CLASS} ${steps.cell} first:pl-0 last:pr-0 ${CHAT_INK_STRONG}`,
    td: `${TABLE_CELL_CLASS} ${steps.cell} first:pl-0 last:pr-0 max-w-[min(20rem,66cqw)]`,
  }
}

const MARKDOWN_SCALE: Record<MarkdownDensity, MarkdownScale> = {
  document: {
    h1: 'mt-8 first:mt-0 mb-4 text-3xl font-semibold leading-tight tracking-tight text-[color:var(--text-strong)]',
    h2: 'mt-8 first:mt-0 mb-3 text-2xl font-semibold leading-tight tracking-tight text-[color:var(--text-strong)]',
    h3: 'mt-6 first:mt-0 mb-3 text-xl font-semibold leading-snug tracking-tight text-[color:var(--text-strong)]',
    h4: 'mt-5 first:mt-0 mb-2 text-lg font-semibold leading-snug text-[color:var(--text-strong)]',
    h5: 'mt-5 first:mt-0 mb-2 text-base font-semibold leading-snug text-[color:var(--text-strong)]',
    h6: 'mt-5 first:mt-0 mb-2 text-sm font-semibold leading-snug tracking-tight text-[color:var(--text-strong)]',
    p: `${baseTextClass} mb-4`,
    list: `mb-4 ml-6 space-y-2 ${baseTextClass}`,
    pre: 'my-4 overflow-x-auto rounded-lg border border-[color:var(--border-default)] bg-[color:var(--terminal-bg)] p-4 text-body leading-6 text-[color:var(--terminal-fg)]',
    // A long path wraps instead of pushing the line box wider than the column;
    // `break-words` keeps a short token whole and moves it down instead. Each
    // scale's pill is cloned onto every line it wraps across, so no fragment
    // is left with an open end and padding on one side only.
    code: 'rounded-xs border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-1.5 py-0.5 text-[color:var(--tone-warn)] break-words box-decoration-clone',
    strong: 'font-semibold text-[color:var(--text-strong)]',
    em: 'italic',
    blockquote: 'my-4 border-l-2 border-[color:var(--border-strong)] py-0.5 pl-4 text-[color:var(--text-muted)]',
    alert: 'my-4 text-heading',
    hr: 'my-6 border-0 border-t border-[color:var(--border-default)]',
    tableBlock: 'my-4',
    math: `my-4 ${MATH_BLOCK_CLASS}`,
    table: 'w-full border-collapse text-left text-body tabular-nums text-[color:var(--text-default)]',
    th: `${TABLE_HEAD_CLASS} px-3 py-2 text-[color:var(--text-strong)]`,
    td: `${TABLE_CELL_CLASS} px-3 py-2`,
  },
  compact: {
    h1: 'mt-6 first:mt-0 mb-4 text-title font-semibold leading-tight tracking-[-0.01em] text-[color:var(--text-strong)]',
    h2: 'mt-[30px] first:mt-0 mb-2.5 text-body font-semibold leading-tight text-[color:var(--text-strong)]',
    h3: 'mt-[22px] first:mt-0 mb-2 text-meta font-semibold leading-snug text-[color:var(--text-strong)]',
    h4: 'mt-5 first:mt-0 mb-1.5 text-meta font-semibold leading-snug text-[color:var(--text-default)]',
    h5: 'mt-5 first:mt-0 mb-1.5 text-meta font-medium leading-snug text-[color:var(--text-default)]',
    // The last rung of the compact ladder: 11px is under the 13px floor for
    // `tracking.tight`, so it holds normal tracking and takes its step down
    // from ink, not from a transform.
    h6: 'mt-5 first:mt-0 mb-1.5 text-micro font-semibold leading-snug tracking-normal text-[color:var(--text-muted)]',
    p: `${compactTextClass} mb-3`,
    list: `mb-3 ml-[18px] space-y-1.5 ${compactTextClass}`,
    pre: 'my-4 overflow-x-auto rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] p-3 text-micro leading-[1.7] text-[color:var(--text-default)]',
    // Inline code sits inside running text, so it matches that text's size;
    // inside a fence it takes the fence's, which is already set on the <pre>.
    code: 'rounded-[3px] bg-[color:var(--bg-active)] px-[0.34em] py-[0.1em] text-[0.92em] text-[color:var(--text-default)] break-words box-decoration-clone [pre_&]:text-[1em]',
    strong: 'font-semibold text-[color:var(--text-strong)]',
    em: 'italic',
    blockquote: 'my-3 border-l border-[color:var(--border-strong)] py-0.5 pl-4 text-[color:var(--text-muted)]',
    alert: 'my-3 text-meta',
    hr: 'my-[22px] border-0 border-t border-[color:var(--border-subtle)]',
    tableBlock: 'my-3',
    math: `my-3 ${MATH_BLOCK_CLASS}`,
    table: 'w-full border-collapse text-left text-micro tabular-nums text-[color:var(--text-default)]',
    th: `${TABLE_HEAD_CLASS} px-2 py-1.5 text-[color:var(--text-strong)]`,
    td: `${TABLE_CELL_CLASS} px-2 py-1`,
  },
  chat: chatScale({
    text: 'text-heading leading-[1.6]',
    h1: 'mt-6 mb-2 text-title tracking-tight',
    h2: 'mt-5 mb-1.5 text-title tracking-tight',
    h3: 'mt-4 mb-1 text-heading',
    h4: 'mt-4 mb-1 text-heading',
    h5: 'mt-3 mb-1 text-body',
    h6: 'mt-3 mb-1 text-body',
    gap: 'mb-2.5',
    table: 'text-body',
    cell: 'px-3 py-1.5',
  }),
  'chat-compact': chatScale({
    text: 'text-body leading-[1.55]',
    h1: 'mt-4 mb-1.5 text-heading',
    h2: 'mt-4 mb-1.5 text-heading',
    h3: 'mt-3 mb-1 text-body',
    h4: 'mt-3 mb-1 text-body',
    h5: 'mt-3 mb-1 text-meta',
    h6: 'mt-3 mb-1 text-meta',
    gap: 'mb-2',
    table: 'text-meta',
    cell: 'px-2 py-1',
  }),
}

function joinClasses(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

const safeMarkdownUrlTransform: UrlTransform = (url) => {
  return isSafeMarkdownUrl(url) || isMarkdownFragmentHref(url) ? url : ''
}

// Only the ids the document's own passes wrote, all prefixed, reach the page:
// anything else could share a name with an element of the app around it.
function documentId(id: string | undefined): string | undefined {
  return id?.startsWith(MARKDOWN_FRAGMENT_PREFIX) ? id : undefined
}

function followMarkdownFragment(event: React.MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault()
  const href = event.currentTarget.getAttribute('href') ?? ''
  markdownFragmentTarget(event.currentTarget, href)?.scrollIntoView({ block: 'start', inline: 'nearest' })
}

// A middle click would ask for a new window onto the app's own page.
function preventDefault(event: React.SyntheticEvent): void {
  event.preventDefault()
}

function isSafeMarkdownUrl(url: string | undefined): url is string {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return SAFE_MARKDOWN_URL_PROTOCOLS.has(parsed.protocol)
  } catch {
    return false
  }
}

function lineRange(node: MarkdownNode): { startLine: number; endLine: number } | null {
  const startLine = node?.position?.start?.line
  const endLine = node?.position?.end?.line
  if (typeof startLine !== 'number' || typeof endLine !== 'number') return null
  return { startLine, endLine }
}

function changeKindForRange(
  node: MarkdownNode,
  lineChanges: GitLineChange[] | undefined,
): GitLineChange['kind'] | null {
  if (!lineChanges?.length) return null
  const range = lineRange(node)
  if (!range) return null

  let matched: GitLineChange['kind'] | null = null

  for (const change of lineChanges) {
    const overlaps = change.startLine <= range.endLine && change.endLine >= range.startLine
    if (!overlaps) continue
    if (change.kind === 'deleted') return 'deleted'
    if (change.kind === 'modified') matched = 'modified'
    if (!matched) matched = change.kind
  }

  return matched
}

function changedBlockClass(node: MarkdownNode, lineChanges: GitLineChange[] | undefined): string | null {
  const kind = changeKindForRange(node, lineChanges)
  return kind ? `markdown-change-block markdown-change-${kind}` : null
}

// GitHub's five, each on a tone the app already speaks: a note is information
// (accent), a tip a good outcome, a warning a degraded one, a caution a
// failure waiting to happen. Important has no tone of its own, so it takes the
// merged violet GitHub gives it on a neutral ground.
const ALERTS: Record<MarkdownAlertKind, { label: string; ink: string; ground: string }> = {
  note: { label: 'Note', ink: 'text-[color:var(--accent-primary)]', ground: 'bg-[color:var(--tone-accent-soft)]' },
  tip: { label: 'Tip', ink: 'text-[color:var(--tone-good)]', ground: 'bg-[color:var(--tone-good-soft)]' },
  important: {
    label: 'Important',
    ink: 'text-[color:var(--tone-merged)]',
    ground: 'bg-[color:var(--tone-neutral-soft)]',
  },
  warning: { label: 'Warning', ink: 'text-[color:var(--tone-warn)]', ground: 'bg-[color:var(--tone-warn-soft)]' },
  caution: { label: 'Caution', ink: 'text-[color:var(--tone-error)]', ground: 'bg-[color:var(--tone-error-soft)]' },
}

function alertKind(node: MarkdownNode): MarkdownAlertKind | null {
  const kind = node?.properties?.dataAlert
  return typeof kind === 'string' && kind in ALERTS ? (kind as MarkdownAlertKind) : null
}

// An identifier short enough to move to the next line whole. A pill split at
// its hyphen (`leading-` / `6`) reads as two tokens; a long path still has to
// wrap, or it would push the line past the pane.
const SHORT_TOKEN_LENGTH = 32

// A browser's word selection stops at hyphens, dots and slashes, so a
// double-click on `migration-gate --dry-run` took one fragment of it. Inline
// code is one token to copy, so a double-click takes the whole span; code in a
// block keeps the browser's word selection.
function selectInlineCode(event: React.MouseEvent<HTMLElement>): void {
  if (event.currentTarget.closest('pre')) return
  window.getSelection()?.selectAllChildren(event.currentTarget)
}

function isShortToken(children: React.ReactNode): boolean {
  return typeof children === 'string' && children.length <= SHORT_TOKEN_LENGTH && !children.includes('\n')
}

function isChatDensity(density: MarkdownDensity | undefined): boolean {
  return density === 'chat' || density === 'chat-compact'
}

// An ordered list's gutter has to hold its widest number: the chat scale's
// gutter fits "9.", and a list that runs to 10 or starts at 120 would hang its
// markers out past the pane's edge. Only a list that needs more asks for it.
function orderedGutter(node: MarkdownNode, start: number | undefined): React.CSSProperties | undefined {
  const items = node?.children.filter((child) => child.type === 'element' && child.tagName === 'li').length ?? 0
  const last = Math.max(Math.abs(start ?? 1), Math.abs((start ?? 1) + items - 1))
  const digits = String(last).length
  return digits > 1 ? { paddingInlineStart: `calc(${digits + 1}ch + 0.4em)` } : undefined
}

/**
 * The wrapper every rendered document sits in (or, for a caller that renders
 * segments bare, the one it draws around them): the class the stylesheet's
 * markdown rules hang off, and the density and tone those rules read.
 */
export function markdownRootProps(options: Pick<MarkdownRenderOptions, 'density' | 'tone'> = {}): {
  className: string
  'data-density'?: MarkdownDensity
  'data-tone'?: MarkdownTone
} {
  return {
    className: 'markdown-rendered',
    ...(isChatDensity(options.density) ? { 'data-density': options.density } : {}),
    ...(options.tone === 'muted' ? { 'data-tone': 'muted' as const } : {}),
  }
}

// Marks a table's scroller with which of its edges hide columns, for the
// stylesheet to fade: a table cut off at the pane's edge otherwise looks like
// a table that ends there. Set on the node rather than held in state, so a
// scroll repaints a mask and never re-renders the cells.
function useOverflowEdges(ref: React.RefObject<HTMLDivElement | null>): void {
  React.useEffect(() => {
    const scroller = ref.current
    if (!scroller) return
    const measure = () => {
      const hidden = scroller.scrollWidth - scroller.clientWidth
      scroller.toggleAttribute('data-overflow-start', hidden > 1 && scroller.scrollLeft > 1)
      scroller.toggleAttribute('data-overflow-end', hidden > 1 && scroller.scrollLeft < hidden - 1)
    }
    measure()
    scroller.addEventListener('scroll', measure, { passive: true })
    // A streaming table grows a row at a time, and the pane can be resized
    // under a finished one; either can change which edges hide columns.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(scroller)
    if (scroller.firstElementChild) observer?.observe(scroller.firstElementChild)
    return () => {
      scroller.removeEventListener('scroll', measure)
      observer?.disconnect()
    }
  }, [ref])
}

/**
 * A table is the one block whose text does not survive a selection: copied off
 * the page it arrives as runs of cells with no columns. Its footer hands it over
 * whole instead — as Markdown (with an HTML flavour beside it, so a rich editor
 * pastes a real table) from the glyph, and as CSV or TSV from the menu beside
 * it. Every format is written from the syntax tree, never scraped from the page.
 *
 * The footer is always there rather than revealed on hover: it is two quiet
 * glyphs, and a menu opened from it must not vanish when the pointer leaves.
 */
function MarkdownTable({
  node,
  blockClassName,
  tableClassName,
  children,
}: {
  node: Element | undefined
  blockClassName: string
  tableClassName: string
  children: React.ReactNode
}): React.ReactNode {
  const scroller = React.useRef<HTMLDivElement>(null)
  useOverflowEdges(scroller)
  return (
    <div className={blockClassName}>
      <div ref={scroller} className="markdown-table-scroll @container overflow-x-auto">
        <table className={tableClassName}>{children}</table>
      </div>
      {node ? (
        <div data-copy-exclude="" className="mt-0.5 flex items-center justify-end gap-0.5">
          <CopyGlyphButton size="xs" label="Copy table" text={() => tableMarkdown(node)} html={() => tableHtml(node)} />
          <OverflowMenu
            ariaLabel="Copy table as"
            triggerTooltip="Copy as"
            items={[
              {
                id: 'markdown',
                label: 'Copy as Markdown',
                onSelect: () => void copyToClipboardWithToast(tableMarkdown(node), { html: () => tableHtml(node) }),
              },
              { id: 'csv', label: 'Copy as CSV', onSelect: () => void copyToClipboardWithToast(tableCsv(node)) },
              {
                id: 'tsv',
                label: 'Copy for a spreadsheet (TSV)',
                onSelect: () => void copyToClipboardWithToast(tableTsv(node)),
              },
            ]}
          />
        </div>
      ) : null}
    </div>
  )
}

const StreamingContext = React.createContext(false)

// A link's label is already one control. Turning a path in it into a file chip
// would nest a second button inside the first — two focus targets, and a click
// that opens both — so text under a link renders as plain text and code.
const LinkLabelContext = React.createContext(false)

function StreamingCode({
  component: Code,
  ...props
}: {
  component: NonNullable<MarkdownRenderOptions['codeBlock']>
  code: string
  language?: string
  filename?: string
  note?: string
}): React.ReactNode {
  return <Code {...props} streaming={React.useContext(StreamingContext)} />
}

function StreamingMath(props: Omit<React.ComponentProps<typeof DisplayMath>, 'streaming'>): React.ReactNode {
  return <DisplayMath {...props} streaming={React.useContext(StreamingContext)} />
}

function markdownComponents(options: MarkdownRenderOptions): Components {
  const { lineChanges, links } = options
  const scale = MARKDOWN_SCALE[options.density ?? 'document']
  const chat = isChatDensity(options.density)
  const Prose = ({ children }: { children: React.ReactNode }): React.ReactNode => {
    const inLinkLabel = React.useContext(LinkLabelContext)
    const { renderText } = options
    if (!renderText || inLinkLabel) return children
    return React.Children.map(children, (child) => (typeof child === 'string' ? renderText(child, 'text') : child))
  }
  const prose = (children: React.ReactNode) => <Prose>{children}</Prose>
  const InlineCode = ({ children }: { children: React.ReactNode }): React.ReactNode => {
    const inLinkLabel = React.useContext(LinkLabelContext)
    return options.renderText && typeof children === 'string' && !inLinkLabel
      ? options.renderText(children, 'inlineCode')
      : children
  }

  const MarkdownImage = ({ src, alt, className }: { src: string; alt: string; className?: string }) => {
    const inLinkLabel = React.useContext(LinkLabelContext)
    const custom = src && options.renderImage ? options.renderImage(src, alt, inLinkLabel) : null
    if (custom) return custom
    // Nothing is fetched to show it: an image URL loaded on render is a request
    // to a host the text chose, made before anyone has read the line. So it is a
    // quiet chip naming the picture, and a web one opens in the browser on a
    // click — never inside a link's label, where it would be a second control.
    const label = alt ? `Image: ${alt}` : 'Image'
    const chip = joinClasses(
      className,
      'inline-block rounded-xs border border-[color:var(--border-subtle)] px-[0.35em] text-[0.9em] text-[color:var(--text-muted)]',
    )
    if (inLinkLabel || !/^https?:\/\//iu.test(src)) return <span className={chip}>{label}</span>
    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className={joinClasses(
          chip,
          'underline-offset-2 hover:text-[color:var(--text-default)] hover:underline focus-visible:focus-ring',
        )}
      >
        {label}
      </a>
    )
  }

  const components: Components = {
    h1: ({ node, children, className, id }: MarkdownComponentProps<'h1'>) => (
      <h1 id={documentId(id)} className={joinClasses(className, scale.h1, changedBlockClass(node, lineChanges))}>
        {children}
      </h1>
    ),
    h2: ({ node, children, className, id }: MarkdownComponentProps<'h2'>) => (
      <h2 id={documentId(id)} className={joinClasses(className, scale.h2, changedBlockClass(node, lineChanges))}>
        {children}
      </h2>
    ),
    h3: ({ node, children, className, id }: MarkdownComponentProps<'h3'>) => (
      <h3 id={documentId(id)} className={joinClasses(className, scale.h3, changedBlockClass(node, lineChanges))}>
        {children}
      </h3>
    ),
    h4: ({ node, children, className, id }: MarkdownComponentProps<'h4'>) => (
      <h4 id={documentId(id)} className={joinClasses(className, scale.h4, changedBlockClass(node, lineChanges))}>
        {children}
      </h4>
    ),
    h5: ({ node, children, className, id }: MarkdownComponentProps<'h5'>) => (
      <h5 id={documentId(id)} className={joinClasses(className, scale.h5, changedBlockClass(node, lineChanges))}>
        {children}
      </h5>
    ),
    h6: ({ node, children, className, id }: MarkdownComponentProps<'h6'>) => (
      <h6 id={documentId(id)} className={joinClasses(className, scale.h6, changedBlockClass(node, lineChanges))}>
        {children}
      </h6>
    ),
    p: ({ node, children, className }: MarkdownComponentProps<'p'>) => (
      <p className={joinClasses(className, scale.p, changedBlockClass(node, lineChanges))}>{prose(children)}</p>
    ),
    a: ({ children: label, href, className, id }: MarkdownComponentProps<'a'>) => {
      const children = <LinkLabelContext.Provider value>{label}</LinkLabelContext.Provider>
      // A link into the document itself is never a file or a web page, so it is
      // settled before a surface's own link renderer sees it.
      if (options.inPageLinks !== false && isMarkdownFragmentHref(href)) {
        return (
          <a
            href={href}
            id={documentId(id)}
            onClick={followMarkdownFragment}
            onAuxClick={preventDefault}
            className={joinClasses(className, LINK_CLASS)}
          >
            {children}
          </a>
        )
      }
      const custom = href ? options.renderLink?.(href, children) : null
      if (custom) return custom
      const target = links && typeof href === 'string' ? links.resolve(href) : null

      if (target?.kind === 'file') {
        const path = target.path
        return (
          // The kit's inline link: a control set inside prose, taking the
          // surrounding text's size and weight, with a standing underline so it
          // reads as a link beside the `<a>` rows above. It opens a file rather
          // than navigating, which is why it is a button and not an anchor.
          <LinkButton
            ink="accent"
            underline="always"
            size="inherit"
            onClick={() => links?.open(path)}
            className={className}
          >
            {children}
          </LinkButton>
        )
      }

      // Not an error — the file is simply not here. Muted and dotted, never the
      // danger colour, and it says why rather than looking clickable. The
      // reason is spoken as well as hovered: a dead link is not focusable, so a
      // tooltip alone would leave it reading as ordinary prose.
      if (target?.kind === 'dead') {
        return (
          <span
            title={target.reason}
            className={joinClasses(
              className,
              'cursor-help text-[color:var(--text-muted)] underline decoration-dotted underline-offset-2',
            )}
          >
            {children}
            <span className="sr-only">{` — ${target.reason}`}</span>
          </span>
        )
      }

      if (!isSafeMarkdownUrl(href)) {
        return <span className={joinClasses(className, 'text-[color:var(--text-default)]')}>{children}</span>
      }

      return (
        <a href={href} target="_blank" rel="noreferrer" className={joinClasses(className, LINK_CLASS)}>
          {children}
        </a>
      )
    },
    strong: ({ children, className }: MarkdownComponentProps<'strong'>) => (
      <strong className={joinClasses(className, scale.strong)}>{prose(children)}</strong>
    ),
    em: ({ children, className }: MarkdownComponentProps<'em'>) => (
      <em className={joinClasses(className, scale.em)}>{prose(children)}</em>
    ),
    code: ({ children, className }: MarkdownComponentProps<'code'>) =>
      options.math && typeof children === 'string' && className?.split(' ').includes('math-inline') ? (
        <InlineMath tex={children} codeClassName={scale.code} />
      ) : (
        <code
          className={joinClasses(className, scale.code, chat && isShortToken(children) && 'whitespace-nowrap')}
          onDoubleClick={selectInlineCode}
        >
          <InlineCode>{children}</InlineCode>
        </code>
      ),
    pre: ({ node, children, className }: MarkdownComponentProps<'pre'>) => {
      const Code = options.codeBlock
      const codeNode = node?.children.find((child) => child.type === 'element' && child.tagName === 'code')
      const plain = (
        <pre className={joinClasses(className, scale.pre, changedBlockClass(node, lineChanges))}>{children}</pre>
      )
      if (codeNode?.type !== 'element' || (!Code && !options.math)) return plain
      const text = codeNode.children.map((child) => (child.type === 'text' ? child.value : '')).join('')
      const classes = codeNode.properties.className
      const languageClass = Array.isArray(classes)
        ? classes.find((value) => String(value).startsWith('language-'))
        : undefined
      const language = languageClass ? String(languageClass).slice(9) : undefined
      const meta = (codeNode.data as { meta?: string } | undefined)?.meta
      const code = text.replace(/\n$/, '')
      const block = (note?: string) =>
        Code ? (
          <StreamingCode
            component={Code}
            code={code}
            language={language}
            filename={filenameFromFenceMeta(meta)}
            note={note}
          />
        ) : (
          plain
        )
      if (options.math && isMathLanguage(language)) {
        // A `$$` or `\[` block or a ```math fence asked for math, so a formula
        // that does not parse falls back to its source with a note saying why.
        return (
          <StreamingMath
            tex={code}
            className={joinClasses(scale.math, changedBlockClass(node, lineChanges))}
            fallback={block}
          />
        )
      }
      return Code ? block() : plain
    },
    blockquote: ({ node, children, className }: MarkdownComponentProps<'blockquote'>) => {
      const kind = alertKind(node)
      if (!kind) {
        return (
          <blockquote className={joinClasses(className, scale.blockquote, changedBlockClass(node, lineChanges))}>
            {children}
          </blockquote>
        )
      }
      const alert = ALERTS[kind]
      // The notice idiom: a neutral hairline over a soft tint, the tone carried
      // by the glyph and the title. The body keeps the document's own ink, and
      // its last block gives up its bottom margin to the box's padding.
      return (
        <div
          role="note"
          data-alert={kind}
          className={joinClasses(
            className,
            scale.alert,
            'rounded-sm border border-[color:var(--border-subtle)] px-3 py-2 [&>:last-child]:mb-0',
            alert.ground,
            changedBlockClass(node, lineChanges),
          )}
        >
          <p className={joinClasses('mb-1 flex items-center gap-1.5 font-semibold', alert.ink)}>
            <MarkdownAlertGlyph kind={kind} className="icon-xs shrink-0" />
            {alert.label}
          </p>
          {children}
        </div>
      )
    },
    ul: ({ node, children, className }: MarkdownComponentProps<'ul'>) => (
      <ul className={joinClasses(className, scale.list, 'list-disc', changedBlockClass(node, lineChanges))}>
        {children}
      </ul>
    ),
    ol: ({ node, children, className, start, reversed, type }: MarkdownComponentProps<'ol'>) => (
      <ol
        start={start}
        reversed={reversed}
        type={type}
        style={chat ? orderedGutter(node, start) : undefined}
        className={joinClasses(className, scale.list, 'list-decimal', changedBlockClass(node, lineChanges))}
      >
        {children}
      </ol>
    ),
    li: ({ node, children, className, value, id }: MarkdownComponentProps<'li'>) => (
      <li value={value} id={documentId(id)} className={joinClasses(className, changedBlockClass(node, lineChanges))}>
        {prose(children)}
      </li>
    ),
    // A GFM task-list marker: the state comes from the document, so it is the
    // kit checkbox in MARKER mode — no label wrapper (the list item's own text
    // is the label), no handler, and `aria-readonly` rather than `disabled`,
    // which would read as "unavailable" for a box that is neither.
    input: ({ className, checked, type }: MarkdownComponentProps<'input'>) =>
      type === 'checkbox' ? (
        <Checkbox readOnly checked={checked === true} className={joinClasses(className, 'mr-2')} />
      ) : null,
    img: ({ src, alt, className }: MarkdownComponentProps<'img'>) => (
      <MarkdownImage src={typeof src === 'string' ? src : ''} alt={alt ?? ''} className={className} />
    ),
    table: ({ node, children, className }: MarkdownComponentProps<'table'>) => (
      <MarkdownTable
        node={node}
        blockClassName={joinClasses(scale.tableBlock, changedBlockClass(node, lineChanges))}
        tableClassName={joinClasses(className, scale.table)}
      >
        {children}
      </MarkdownTable>
    ),
    // GFM column alignment arrives as `style.textAlign` — the JSX runtime turns
    // the tree's `align` into a style — so the style is what has to reach the cell.
    th: ({ children, className, style }: MarkdownComponentProps<'th'>) => (
      <th scope="col" style={style} className={joinClasses(className, scale.th)}>
        {children}
      </th>
    ),
    td: ({ children, className, style }: MarkdownComponentProps<'td'>) => (
      <td style={style} className={joinClasses(className, scale.td)}>
        {children}
      </td>
    ),
    hr: ({ node, className }: MarkdownComponentProps<'hr'>) => (
      <hr className={joinClasses(className, scale.hr, changedBlockClass(node, lineChanges))} />
    ),
  }

  return components
}

function MarkdownRenderer({
  markdown,
  options,
}: {
  markdown: string
  options: MarkdownRenderOptions
}): React.ReactNode {
  const { lineChanges, links, density, renderText, renderLink, renderImage, codeBlock, math, inPageLinks } = options
  const source = React.useMemo(
    () => (options.repairFileLinks ? repairReplyMarkdown(markdown) : markdown),
    [markdown, options.repairFileLinks],
  )
  // Component types must outlive a streamed source update: recreating them
  // remounts code blocks, discards their wrap state, and destroys text selection.
  // Streaming state travels through context without changing those types.
  const components = React.useMemo(
    () =>
      markdownComponents({
        lineChanges,
        links,
        density,
        renderText,
        renderLink,
        renderImage,
        codeBlock,
        math,
        inPageLinks,
      }),
    [lineChanges, links, density, renderText, renderLink, renderImage, codeBlock, math, inPageLinks],
  )

  // A resolver's own hrefs survive the protocol guard so the `a` component can
  // see them; everything else still has to be http, https or mailto, or a
  // fragment of the document itself, to keep its href at all.
  const hrefTransform: UrlTransform = options.renderLink
    ? (url) => url
    : links
      ? (url, key, node) => (links.resolve(url) ? url : safeMarkdownUrlTransform(url, key, node))
      : safeMarkdownUrlTransform
  // An image renderer decides for itself what a source may be — a path is only
  // ever read through it, never handed to the page as a URL.
  const urlTransform: UrlTransform = options.renderImage
    ? (url, key, node) => (key === 'src' ? url : hrefTransform(url, key, node))
    : hrefTransform

  // A segment that is one fenced block skips the parse of its body, which a
  // streaming file would otherwise pay again in full on every token
  // (`markdownFence.ts`). Not where line changes read source positions, nor
  // for a person's own text, which has a plugin of its own.
  const fenced = lineChanges || options.userText ? null : singleFencedCode(source)
  const content = (
    <StreamingContext.Provider value={options.streaming ?? false}>
      <ReactMarkdown
        remarkPlugins={
          fenced
            ? [remarkFencedCodeValue(fenced.value), ...MARKDOWN_PLUGINS]
            : options.userText
              ? USER_TEXT_PLUGINS
              : options.math
                ? MATH_PLUGINS
                : MARKDOWN_PLUGINS
        }
        components={components}
        urlTransform={urlTransform}
      >
        {fenced ? fenced.placeholder : source}
      </ReactMarkdown>
    </StreamingContext.Provider>
  )
  return options.bare ? content : <div {...markdownRootProps(options)}>{content}</div>
}

export function renderMarkdown(markdown: string, options: MarkdownRenderOptions = {}): React.ReactNode {
  return <MarkdownRenderer markdown={markdown} options={options} />
}
