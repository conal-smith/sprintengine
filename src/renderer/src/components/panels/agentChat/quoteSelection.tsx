import { memo, useEffect, useLayoutEffect, useRef, useState, type JSX, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { GhostButton, Tooltip } from '../../ui'
import { QuoteGlyph } from '../../ui/QuoteGlyph'
import { OVERLAY_SURFACE_CLASS } from '../../ui/tokens'
import { selectionClipboard } from '../../../utils/selectionToMarkdown'
import { showToast } from '../../../store/toastStore'

// Quote a stretch of the conversation back into the composer: select text in
// the transcript — a reply, a message of your own, or a run across several —
// and a small toolbar (or the quote shortcut) carries it down as a markdown
// blockquote, so the follow-up says which sentence it is about.
//
// What is quoted is what ⌘C would copy (`selectionToMarkdown`): the markdown
// the selection was rendered from, so bold, inline code, lists, tables and
// fenced code arrive as they were written rather than as the browser's
// flattened text, and the view's chrome (`data-copy-exclude`) stays out.

/** The command id of the quote shortcut, as `commandRegistry` registers it. */
export const QUOTE_SELECTION_COMMAND = 'chat.quoteSelection'

/**
 * The longest selection a quote carries, in characters of markdown. A quote
 * is a pointer at a passage, not a way to paste a transcript back into it:
 * past this the composer turns into a wall the reader has to scroll past to
 * find the question. Longer selections are refused out loud, never cut short
 * without saying so — a quote that silently stopped mid-passage would put
 * words in the agent's mouth by omission.
 */
export const QUOTE_MAX_CHARS = 8_000

// Gap between the selection and the toolbar, and the margin it keeps from the
// window's edges.
const TOOLBAR_GAP = 6
const VIEWPORT_MARGIN = 8

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/u

/**
 * Markdown as one blockquote: every line `> `-prefixed. Outside fenced code,
 * trailing spaces go and a run of blank lines is one paragraph break (a bare
 * `>`, so the quote stays one block). Inside a fence every line is kept as it
 * was — a blank line or trailing space in code is part of the code — and a
 * fence the selection cut open is closed, so text typed after the quote is
 * never swallowed into it.
 */
export function quoteAsMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/gu, '\n').replace(/ /gu, ' ').split('\n')
  const out: string[] = []
  let fence: string | null = null
  for (const raw of lines) {
    if (fence !== null) {
      out.push(raw)
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/u.exec(raw)?.[1]
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = null
      continue
    }
    const line = raw.trimEnd()
    if (!line) {
      if (out.length && out.at(-1) !== '') out.push('')
      continue
    }
    out.push(line)
    const opening = FENCE_OPEN.exec(line)?.[1]
    // A backtick fence's info string cannot hold a backtick; one that does is
    // inline code that happens to start a line.
    if (opening && !(opening[0] === '`' && line.slice(line.indexOf(opening) + opening.length).includes('`')))
      fence = opening
  }
  if (fence !== null) {
    while (out.length && out.at(-1) === '') out.pop()
    out.push(fence)
  }
  while (out.length && out.at(-1) === '') out.pop()
  return out.map((line) => (line ? `> ${line}` : '>')).join('\n')
}

/**
 * The draft with a quote set in at `caret`, as a block of its own: text before
 * the caret ends its line and a blank line follows it, text after the caret
 * starts a new paragraph below. The caret lands on a fresh line after the
 * quote with a blank line between — a line typed straight under a `>` line
 * would join the quote (markdown's lazy continuation).
 */
export function insertQuoteIntoDraft(draft: string, quote: string, caret: number): { text: string; caret: number } {
  if (!quote) return { text: draft, caret }
  const at = Math.max(0, Math.min(caret, draft.length))
  const head = draft.slice(0, at).replace(/\s+$/u, '')
  const tail = draft.slice(at).replace(/^\s+/u, '')
  const before = `${head ? `${head}\n\n` : ''}${quote}\n\n`
  return { text: `${before}${tail ? `\n\n${tail}` : ''}`, caret: before.length }
}

/** The screen box a selection occupies: its first line's top-left, its last line's bottom-right. */
export type SelectionAnchor = { left: number; right: number; top: number; bottom: number }

type QuotableSelection = { text: string; anchor: SelectionAnchor }

function ancestorElement(node: Node): Element | null {
  // 1 is Node.ELEMENT_NODE; a text node answers for its parent element.
  return node.nodeType === 1 ? (node as Element) : node.parentElement
}

/**
 * The selection when it is conversation inside `root` that a quote can carry,
 * and where it sits on screen. A selection that reaches outside the
 * transcript, or lies wholly inside the view's chrome (a code block's header,
 * a meta line), is not a quote.
 */
export function readQuotableSelection(root: HTMLElement, selection: Selection | null): QuotableSelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const first = selection.getRangeAt(0)
  const last = selection.getRangeAt(selection.rangeCount - 1)
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const ancestor = ancestorElement(selection.getRangeAt(index).commonAncestorContainer)
    if (!ancestor || !root.contains(ancestor)) return null
  }
  const ancestor = ancestorElement(first.commonAncestorContainer)
  if (selection.rangeCount === 1 && ancestor?.closest('[data-copy-exclude]')) return null
  const text = selection.toString().trim()
  if (!text) return null
  const rects = (range: Range) => Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0)
  const top = rects(first)[0] ?? first.getBoundingClientRect()
  const bottom = rects(last).at(-1) ?? last.getBoundingClientRect()
  return { text, anchor: { left: top.left, right: bottom.right, top: top.top, bottom: bottom.bottom } }
}

export type SelectionQuote = { kind: 'quote'; markdown: string } | { kind: 'too-long'; length: number }

/**
 * The quote a selection inside `root` makes — its markdown as a blockquote —
 * or why it cannot be one. Null when the selection is not this transcript's
 * or holds nothing but chrome.
 */
export function quoteForSelection(root: HTMLElement, selection: Selection | null): SelectionQuote | null {
  if (!readQuotableSelection(root, selection)) return null
  const copied = selectionClipboard(selection, root)?.text.trim()
  if (!copied) return null
  if (copied.length > QUOTE_MAX_CHARS) return { kind: 'too-long', length: copied.length }
  const markdown = quoteAsMarkdown(copied)
  return markdown ? { kind: 'quote', markdown } : null
}

/**
 * Quote the current selection into the composer through `onQuote`, then clear
 * it. Returns whether the selection was this transcript's to quote — true too
 * when it was refused as too long, which is said with a toast.
 */
export function quoteSelectionInto(
  root: HTMLElement,
  selection: Selection | null,
  onQuote: (markdown: string) => void,
): boolean {
  const quote = quoteForSelection(root, selection)
  if (!quote) return false
  if (quote.kind === 'too-long') {
    showToast({
      tone: 'neutral',
      title: 'Selection too long to quote',
      description: `A quote holds up to ${QUOTE_MAX_CHARS.toLocaleString('en-US')} characters; this one is ${quote.length.toLocaleString('en-US')}. Select a shorter passage.`,
    })
    return true
  }
  onQuote(quote.markdown)
  selection?.removeAllRanges()
  return true
}

/**
 * Where the toolbar goes for a selection: under its last line, right-aligned
 * to where the selection ends, when the window has room there; otherwise over
 * its first line, starting where the selection starts. Either way it never
 * sits on the words it offers to quote. Only a selection taller than the
 * window leaves no free edge, and then the toolbar keeps to the window's
 * bottom margin rather than leaving the screen.
 */
export function placeQuoteToolbar(
  anchor: SelectionAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number; side: 'below' | 'above' } {
  const clampX = (x: number) => Math.max(VIEWPORT_MARGIN, Math.min(x, viewport.width - size.width - VIEWPORT_MARGIN))
  const below = anchor.bottom + TOOLBAR_GAP
  if (below + size.height <= viewport.height - VIEWPORT_MARGIN)
    return { left: clampX(anchor.right - size.width), top: below, side: 'below' }
  const above = anchor.top - TOOLBAR_GAP - size.height
  if (above >= VIEWPORT_MARGIN) return { left: clampX(anchor.left), top: above, side: 'above' }
  return {
    left: clampX(anchor.right - size.width),
    top: Math.max(VIEWPORT_MARGIN, viewport.height - size.height - VIEWPORT_MARGIN),
    side: 'below',
  }
}

/**
 * Where the toolbar goes after something scrolled. The transcript scrolls on
 * its own while it follows a streaming reply, so a scroll is not a reason to
 * leave: the toolbar moves with the selection it belongs to, and goes only when
 * the selection has gone or scrolled wholly out of the window. The same object
 * comes back when nothing moved, so an unmoved scroll renders nothing.
 */
export function selectionAfterScroll(
  previous: QuotableSelection | null,
  next: QuotableSelection | null,
  viewportHeight: number,
): QuotableSelection | null {
  if (!previous || !next || next.text !== previous.text) return null
  if (next.anchor.bottom < 0 || next.anchor.top > viewportHeight) return null
  const moved = (['left', 'right', 'top', 'bottom'] as const).some(
    (edge) => Math.abs(next.anchor[edge] - previous.anchor[edge]) >= 0.5,
  )
  return moved ? next : previous
}

/**
 * The floating "Quote" action for a selection in the transcript. It appears
 * once the selection settles — after the pointer is released, or as a
 * keyboard selection changes — and never while a drag is still extending it.
 * Pressing it keeps the selection alive (the press does not move focus) until
 * the quote has been read, then clears it; Escape, the reader scrolling, or a
 * selection elsewhere dismisses it. A scroll the reader did not make — the
 * transcript following a streaming reply — carries it along with the selection
 * instead.
 */
export const QuoteSelectionToolbar = memo(function QuoteSelectionToolbar({
  rootRef,
  enabled,
  onQuote,
  shortcut,
}: {
  rootRef: RefObject<HTMLElement | null>
  enabled: boolean
  onQuote: (markdown: string) => void
  /** The quote shortcut as the platform writes it, for the tooltip. */
  shortcut?: string | null
}): JSX.Element | null {
  const [selection, setSelection] = useState<QuotableSelection | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)

  useEffect(() => {
    if (!enabled) {
      setSelection(null)
      return
    }
    let frame = 0
    const read = () => {
      frame = 0
      const root = rootRef.current
      setSelection(root && !draggingRef.current ? readQuotableSelection(root, document.getSelection()) : null)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    // A press on a button is an action, not the end of a selection. Chromium
    // keeps the selection through it, so reading it again on the release put
    // the toolbar back beside the words, under whatever the button opened.
    let pressedControl = false
    const onPointerDown = (event: PointerEvent) => {
      if (toolbarRef.current?.contains(event.target as Node)) return
      draggingRef.current = true
      pressedControl = Boolean((event.target as Element | null)?.closest?.('button, [role="button"]'))
      setSelection(null)
    }
    const onPointerUp = () => {
      draggingRef.current = false
      if (pressedControl) {
        pressedControl = false
        return
      }
      schedule()
    }
    // A selection that changed somewhere else — a caret moving in a text
    // field, a selection in another pane — is not this transcript's to read.
    const onSelectionChange = () => {
      if (draggingRef.current) return
      const anchor = document.getSelection()?.anchorNode
      if (anchor && !rootRef.current?.contains(anchor) && !toolbarRef.current) return
      schedule()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !toolbarRef.current) return
      event.preventDefault()
      setSelection(null)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [enabled, rootRef])

  // The toolbar is placed in window coordinates, so a scroll under it is read
  // again on the next frame and the toolbar follows the selection. The
  // reader's own wheel or swipe means they have moved on, and it goes. Only
  // while it is showing: every scroll anywhere in the window would otherwise
  // wake every mounted chat.
  const showing = selection !== null
  useEffect(() => {
    if (!showing) return
    let scrollFrame = 0
    const follow = () => {
      scrollFrame = 0
      const root = rootRef.current
      const next = root && !draggingRef.current ? readQuotableSelection(root, document.getSelection()) : null
      setSelection((previous) => selectionAfterScroll(previous, next, window.innerHeight))
    }
    const onScroll = () => {
      if (!scrollFrame) scrollFrame = requestAnimationFrame(follow)
    }
    const onUserScroll = () => setSelection(null)
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('wheel', onUserScroll, { capture: true, passive: true })
    document.addEventListener('touchmove', onUserScroll, { capture: true, passive: true })
    return () => {
      if (scrollFrame) cancelAnimationFrame(scrollFrame)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('wheel', onUserScroll, true)
      document.removeEventListener('touchmove', onUserScroll, true)
    }
  }, [showing, rootRef])

  // Placed once the toolbar's own size is known, before it paints.
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current
    if (!toolbar || !selection) return
    const rect = toolbar.getBoundingClientRect()
    const place = placeQuoteToolbar(
      selection.anchor,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    )
    toolbar.style.left = `${place.left}px`
    toolbar.style.top = `${place.top}px`
    toolbar.dataset.side = place.side
  }, [selection])

  if (!selection) return null
  return createPortal(
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="Selection"
      data-quote-toolbar=""
      className={`fixed z-[var(--z-popover)] p-0.5 ${OVERLAY_SURFACE_CLASS}`}
      style={{ left: selection.anchor.right, top: selection.anchor.bottom + TOOLBAR_GAP }}
    >
      <Tooltip content={shortcut ? `Quote in reply (${shortcut})` : 'Quote in reply'}>
        <GhostButton
          size="xs"
          // Keep the selection: a press that took focus would collapse it first.
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const root = rootRef.current
            if (root) quoteSelectionInto(root, document.getSelection(), onQuote)
            setSelection(null)
          }}
        >
          <QuoteGlyph className="icon-xs shrink-0" />
          Quote
        </GhostButton>
      </Tooltip>
    </div>,
    document.body,
  )
})
