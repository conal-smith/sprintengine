import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type RefObject } from 'react'
import type { LegendListRef } from '@legendapp/list/react'
import {
  collectQuotes,
  mayHoldQuotes,
  nextQuoteNumber,
  quoteToken,
  withQuoteComment,
  withoutQuote,
  type ChatQuote,
} from '../../../../../shared/chat-quotes'
import { showToast } from '../../../store/toastStore'
import { QuoteChip, QuoteCommentEditor } from './chatQuotes'
import type { ComposerFieldHandle } from './ComposerField'
import type { ConversationTimelineRow } from './conversationTimeline'
import { quoteSources } from './quoteAnchors'
import { QuoteHighlights, type QuoteHighlightControl, type ShownQuote } from './quoteHighlights'
import type { SelectionAnchor, SelectionCitation } from './quoteSelection'

// A chat's quotes, end to end: a passage cited from the transcript goes into
// the draft as a token at the caret (drawn as a chip) and opens the comment
// editor under the cited words; the chips edit their comments and take the
// reader back to the reply; and every quote of the conversation, sent or in
// the draft, is marked in the reply it came from.

type Editing = { n: number; initial: string; anchor: { left: number; bottom: number }; fresh: boolean }

export type ChatQuotesInput = {
  draft: string
  setDraft: (update: (current: string) => string) => void
  composerRef: RefObject<ComposerFieldHandle | null>
  /** Where the caret goes once the rewritten draft has rendered (the chat's own). */
  pendingCaretRef: RefObject<number | null>
  rows: readonly ConversationTimelineRow[]
  /** Texts that hold numbered quotes besides the sent messages: a queued message. */
  pendingTexts: readonly string[]
  transcriptRef: RefObject<HTMLElement | null>
  listRef: RefObject<LegendListRef | null>
  /** Scroll the list to a row it holds, drawn or not. */
  scrollToRow: (index: number) => void
  pauseFollowing: () => void
  hasMore: boolean
  loadingEarlier: boolean
  loadEarlier: () => Promise<void>
  /** Send the draft as the composer's Enter would; false when it could not be. */
  submit: () => boolean
}

export type ChatQuotes = {
  /** Put a cited passage into the draft at the caret and open its comment editor. */
  cite: (citation: SelectionCitation, anchor: SelectionAnchor) => void
  renderQuoteChip: (quote: ChatQuote) => JSX.Element
  goToSource: (quote: ChatQuote) => void
  /** The marks over the transcript; mounted inside it. */
  highlights: JSX.Element
  /** The comment editor, while one is open. */
  editor: JSX.Element | null
}

const shownKey = (quotes: readonly ShownQuote[]) =>
  quotes.map((quote) => `${quote.sent ? 's' : 'd'}${quote.turnId}#${quote.n}#${quote.comment}`).join('\n')

// The quotes as one array for as long as they are the same quotes, so a
// keystroke that leaves them alone reaches the highlight layer as nothing new.
function useStableQuotes(quotes: ShownQuote[]): readonly ShownQuote[] {
  const held = useRef<{ key: string; quotes: readonly ShownQuote[] }>({ key: '', quotes: [] })
  const key = shownKey(quotes)
  if (key !== held.current.key) held.current = { key, quotes }
  return held.current.quotes
}

export function useChatQuotes(input: ChatQuotesInput): ChatQuotes {
  const latest = useRef(input)
  latest.current = input
  const [editing, setEditing] = useState<Editing | null>(null)
  const controlRef = useRef<QuoteHighlightControl | null>(null)

  // Every quote of the conversation, the draft's first: a quote a recalled or
  // edited message brought back into the draft is the draft's.
  const { draft, rows } = input
  const sentTexts = useMemo(
    () => rows.flatMap((row) => (row.kind === 'user' && mayHoldQuotes(row.entry.text) ? [row.entry.text] : [])),
    [rows],
  )
  const shown: ShownQuote[] = []
  const seen = new Set<number>()
  for (const quote of collectQuotes(draft)) {
    if (seen.has(quote.n)) continue
    seen.add(quote.n)
    shown.push({ ...stripPosition(quote), sent: false })
  }
  for (const text of sentTexts)
    for (const quote of collectQuotes(text)) {
      if (seen.has(quote.n)) continue
      seen.add(quote.n)
      shown.push({ ...stripPosition(quote), sent: true })
    }
  const quotes = useStableQuotes(shown)

  // ── The draft ────────────────────────────────────────────────────────────

  const focusComposer = (caret: number | null) => {
    const field = latest.current.composerRef.current
    if (!field) return
    field.focus()
    if (caret !== null) field.setSelectionRange(caret, caret)
  }

  const cite = useCallback((citation: SelectionCitation, anchor: SelectionAnchor) => {
    const { draft, rows: allRows, pendingTexts, composerRef, setDraft } = latest.current
    const sent = allRows.flatMap((row) => (row.kind === 'user' ? [row.entry.text] : []))
    const n = nextQuoteNumber([...sent, ...pendingTexts, draft])
    const token = quoteToken({ ...citation, n, comment: '' })
    const field = composerRef.current
    const at = Math.max(0, Math.min(field?.selectionEnd ?? draft.length, draft.length))
    const before = draft.slice(0, at)
    // A chip set against a word reads as part of it; it takes a space either side.
    const lead = before && !/\s$/u.test(before) ? ' ' : ''
    const inserted = `${lead}${token} `
    setDraft((current) => `${current.slice(0, at)}${inserted}${current.slice(at)}`)
    // The caret is put after the chip when the editor closes: moved now, the
    // composer would take focus from the editor opening under the words.
    setEditing({ n, initial: '', anchor: { left: anchor.left, bottom: anchor.bottom }, fresh: true })
  }, [])

  const edit = useCallback((n: number, from: HTMLElement | DOMRect | null) => {
    const quote = collectQuotes(latest.current.draft).find((each) => each.n === n)
    if (!quote) return
    // Under the cited words when the reply is drawn and in view, else under
    // whatever it was opened from.
    const rect =
      controlRef.current?.rectOf(n) ?? (from instanceof DOMRect ? from : (from?.getBoundingClientRect() ?? chipRect(n)))
    if (!rect) return
    setEditing({ n, initial: quote.comment, anchor: { left: rect.left, bottom: rect.bottom }, fresh: false })
  }, [])

  const remove = useCallback((n: number) => {
    const { draft, setDraft } = latest.current
    const quote = collectQuotes(draft).find((each) => each.n === n)
    if (!quote) return
    setDraft((current) => withoutQuote(current, n))
    ;(latest.current.pendingCaretRef as { current: number | null }).current = quote.from
  }, [])

  // ⌘/Ctrl+Enter in the editor saves and sends; the send reads the draft the
  // save wrote, so it waits for that draft to render.
  const sendAfterSaveRef = useRef(false)
  useEffect(() => {
    if (!sendAfterSaveRef.current) return
    sendAfterSaveRef.current = false
    latest.current.submit()
  }, [draft])

  const save = useCallback((n: number, comment: string, send: boolean) => {
    setEditing(null)
    const { draft, setDraft } = latest.current
    const next = withQuoteComment(draft, n, comment)
    const token = collectQuotes(next).find((each) => each.n === n)
    const caret = token ? Math.min(next.length, token.to + (next[token.to] === ' ' ? 1 : 0)) : null
    if (next === draft) {
      if (send) latest.current.submit()
      else focusComposer(caret)
      return
    }
    if (send) sendAfterSaveRef.current = true
    else (latest.current.pendingCaretRef as { current: number | null }).current = caret
    setDraft(() => next)
  }, [])

  const cancel = useCallback(
    (editingNow: Editing) => {
      setEditing(null)
      // Escape on the editor a quote opened with takes the quote back out.
      if (editingNow.fresh) remove(editingNow.n)
      else focusComposer(null)
    },
    [remove],
  )

  // An editor for a quote no longer in the draft (sent, or deleted) closes.
  useEffect(() => {
    if (editing && !collectQuotes(draft).some((quote) => quote.n === editing.n)) setEditing(null)
  }, [draft, editing])

  // ── Back to the reply ────────────────────────────────────────────────────

  const [seeking, setSeeking] = useState<ChatQuote | null>(null)
  const goToSource = useCallback((quote: ChatQuote) => {
    const { rows, transcriptRef, scrollToRow, pauseFollowing, hasMore } = latest.current
    const index = rows.findIndex((row) => row.kind === 'assistant' && row.entry.turnId === quote.turnId)
    if (index < 0) {
      if (hasMore) setSeeking(quote)
      else sourceGone()
      return
    }
    pauseFollowing()
    const root = transcriptRef.current
    if (!root || !quoteSources(root).has(quote.turnId)) scrollToRow(index)
    controlRef.current?.flash(quote)
  }, [])

  // A reply older than the pages loaded: earlier pages are fetched until it
  // is there, or there are none left.
  const { hasMore, loadingEarlier } = input
  useEffect(() => {
    if (!seeking || loadingEarlier) return
    if (rows.some((row) => row.kind === 'assistant' && row.entry.turnId === seeking.turnId)) {
      setSeeking(null)
      goToSource(seeking)
      return
    }
    if (!hasMore) {
      setSeeking(null)
      sourceGone()
      return
    }
    void latest.current.loadEarlier().catch(() => {
      setSeeking(null)
      sourceGone()
    })
  }, [seeking, rows, hasMore, loadingEarlier, goToSource])

  const onLanding = useCallback((range: Range) => {
    const list = latest.current.listRef.current
    const scroller = list?.getScrollableNode()
    if (!list || !scroller) return
    const rect = range.getBoundingClientRect()
    const view = scroller.getBoundingClientRect()
    // Already comfortably on screen: left where it is. Otherwise brought to
    // the upper third, where the eye starts, as a find's landing is.
    const margin = Math.min(view.height / 6, 48)
    if (rect.top >= view.top + margin && rect.bottom <= view.bottom - margin) return
    const offset = scroller.scrollTop + rect.top - view.top - view.height / 3
    void list.scrollToOffset({ offset: Math.max(0, offset), animated: false })
  }, [])

  const onEditFromCard = useCallback((n: number, anchor: DOMRect) => edit(n, anchor), [edit])

  const highlights = (
    <QuoteHighlights
      transcriptRef={input.transcriptRef}
      quotes={quotes}
      controlRef={controlRef}
      onEdit={onEditFromCard}
      onRemove={remove}
      onLanding={onLanding}
    />
  )

  const renderQuoteChip = useCallback(
    (quote: ChatQuote) => (
      <QuoteChip quote={quote} onEdit={(element) => edit(quote.n, element)} onGoToSource={goToSource} />
    ),
    [edit, goToSource],
  )

  const editor = editing ? (
    <QuoteCommentEditor
      key={`${editing.n}:${editing.fresh}`}
      n={editing.n}
      initial={editing.initial}
      anchor={editing.anchor}
      onSave={(comment, send) => save(editing.n, comment, send)}
      onCancel={() => cancel(editing)}
    />
  ) : null

  return { cite, renderQuoteChip, goToSource, highlights, editor }
}

function stripPosition({ from: _from, to: _to, ...quote }: ChatQuote & { from: number; to: number }): ChatQuote {
  return quote
}

function chipRect(n: number): DOMRect | null {
  return document.querySelector(`[data-composer-field] [data-quote-number="${n}"]`)?.getBoundingClientRect() ?? null
}

function sourceGone(): void {
  showToast({
    tone: 'neutral',
    title: 'Reply not found',
    description: 'The reply this passage was quoted from is no longer in this conversation.',
  })
}
