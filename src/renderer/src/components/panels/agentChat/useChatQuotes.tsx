import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type RefObject } from 'react'
import type { LegendListRef } from '@legendapp/list/react'
import {
  QUOTE_TOKEN_MAX_CHARS,
  collectQuotes,
  mayHoldQuotes,
  nextQuoteNumber,
  quoteAnchorKey,
  quoteToken,
  withoutQuote,
  type ChatQuote,
  type ChatQuoteToken,
} from '../../../../../shared/chat-quotes'
import { showToast } from '../../../store/toastStore'
import { MAX_DRAFT_CHARS } from './draftStore'
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

// The editor names its quote by the token as the draft holds it: a number can
// be shared (a token pasted from another chat), a token's text cannot. A quote
// just made also keeps which spaces it went in with, so Escape takes back
// exactly what the cite put in.
type Editing = {
  token: string
  n: number
  initial: string
  anchor: { left: number; bottom: number }
  fresh: boolean
  spaces: { before: boolean; after: boolean }
}

type Placed = Omit<Editing, 'initial'>

export type ChatQuotesInput = {
  draft: string
  setDraft: (update: (current: string) => string) => void
  composerRef: RefObject<ComposerFieldHandle | null>
  /** Where the caret goes once the rewritten draft has rendered (the chat's own). */
  pendingCaretRef: RefObject<number | null>
  rows: readonly ConversationTimelineRow[]
  /**
   * Texts that hold numbered quotes besides the loaded messages and the
   * draft: queued and scheduled messages. Read when a quote is made.
   */
  pendingTexts: () => readonly string[]
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
  renderQuoteChip: (quote: ChatQuoteToken) => JSX.Element
  goToSource: (quote: ChatQuote) => void
  /** The marks over the transcript; mounted inside it. */
  highlights: JSX.Element
  /** The comment editor, while one is open. */
  editor: JSX.Element | null
}

const shownKey = (quotes: readonly ShownQuote[]) =>
  quotes.map((quote) => `${quote.sent ? 's' : 'd'}${quote.n}#${quote.comment}#${quoteAnchorKey(quote)}`).join('\n')

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
  // The sent messages' quotes, parsed when the rows change rather than on
  // every keystroke in the composer.
  const sentQuotes = useMemo(
    () =>
      rows.flatMap((row) =>
        row.kind === 'user' && mayHoldQuotes(row.entry.text) ? collectQuotes(row.entry.text) : [],
      ),
    [rows],
  )
  // One mark per passage, the draft's first: a quote a recalled or edited
  // message brought back into the draft is the draft's. Two quotes of other
  // passages are both marked, whatever their numbers.
  const shown: ShownQuote[] = []
  const seen = new Set<string>()
  for (const [list, sent] of [
    [collectQuotes(draft), false],
    [sentQuotes, true],
  ] as const)
    for (const quote of list) {
      const key = quoteAnchorKey(quote)
      if (seen.has(key)) continue
      seen.add(key)
      shown.push({ ...stripPosition(quote), sent })
    }
  const quotes = useStableQuotes(shown)

  // ── The draft ────────────────────────────────────────────────────────────

  const focusComposer = (caret: number | null) => {
    const field = latest.current.composerRef.current
    if (!field) return
    field.focus()
    if (caret !== null) field.setSelectionRange(caret, caret)
  }

  const numberFor = (current: string) => {
    const { rows, pendingTexts } = latest.current
    const sent = rows.flatMap((row) => (row.kind === 'user' ? [row.entry.text] : []))
    return nextQuoteNumber([...sent, ...pendingTexts(), current])
  }

  // The quote a cite put in, until the draft holding it has rendered and its
  // editor can open.
  const placedRef = useRef<Placed | null>(null)
  const cite = useCallback((citation: SelectionCitation, anchor: SelectionAnchor) => {
    const { draft, setDraft, composerRef } = latest.current
    // A token is the passage percent-encoded, which can run to several times
    // its length; one that will not fit, or would crowd the draft past its
    // cap, is refused out loud rather than cut.
    const token = quoteToken({ ...citation, n: numberFor(draft), comment: '' })
    if (token.length > QUOTE_TOKEN_MAX_CHARS || draft.length + token.length + 2 > MAX_DRAFT_CHARS) {
      showToast({
        tone: 'neutral',
        title: 'Selection too long to quote',
        description:
          token.length > QUOTE_TOKEN_MAX_CHARS
            ? 'This passage is too long to carry as a quote. Select a shorter passage.'
            : 'The message has no room left for this quote. Shorten the message or select a shorter passage.',
      })
      return
    }
    const caret = composerRef.current?.selectionEnd
    // Worked out from the draft the edit is applied to, which may be newer
    // than the one this render saw.
    setDraft((current) => {
      const n = numberFor(current)
      const token = quoteToken({ ...citation, n, comment: '' })
      if (current.length + token.length + 2 > MAX_DRAFT_CHARS) return current
      const at = Math.max(0, Math.min(caret ?? current.length, current.length))
      // A chip set against a word reads as part of it; it takes a space either side.
      const before = current.slice(0, at)
      const lead = Boolean(before) && !/\s$/u.test(before)
      placedRef.current = {
        token,
        n,
        anchor: { left: anchor.left, bottom: anchor.bottom },
        fresh: true,
        spaces: { before: lead, after: true },
      }
      return `${before}${lead ? ' ' : ''}${token} ${current.slice(at)}`
    })
  }, [])

  // The cite's editor opens once its quote is in the draft. The caret is put
  // after the chip when the editor closes: moved now, the composer would take
  // focus from the editor opening under the words.
  useEffect(() => {
    const placed = placedRef.current
    if (!placed) return
    placedRef.current = null
    if (draft.includes(placed.token)) setEditing({ ...placed, initial: '' })
  }, [draft])

  const edit = useCallback((token: string, from: HTMLElement | DOMRect | null) => {
    const quote = collectQuotes(latest.current.draft).find((each) => each.token === token)
    if (!quote) return
    // Under the cited words when the reply is drawn and in view, else under
    // whatever it was opened from.
    const rect =
      controlRef.current?.rectOf(quote) ?? (from instanceof DOMRect ? from : (from?.getBoundingClientRect() ?? null))
    if (!rect) return
    setEditing({
      token,
      n: quote.n,
      initial: quote.comment,
      anchor: { left: rect.left, bottom: rect.bottom },
      fresh: false,
      spaces: { before: false, after: true },
    })
  }, [])

  const remove = useCallback((token: string, spaces: Editing['spaces'] = { before: false, after: true }) => {
    const { draft, setDraft } = latest.current
    const quote = collectQuotes(draft).find((each) => each.token === token)
    if (!quote) return
    setDraft((current) => withoutQuote(current, token, spaces))
    ;(latest.current.pendingCaretRef as { current: number | null }).current =
      spaces.before && draft[quote.from - 1] === ' ' ? quote.from - 1 : quote.from
  }, [])

  // The draft's own token for a passage the transcript marks.
  const draftTokenFor = (quote: ShownQuote) => {
    const key = quoteAnchorKey(quote)
    return collectQuotes(latest.current.draft).find((each) => quoteAnchorKey(each) === key)?.token ?? null
  }
  const onEditFromCard = useCallback(
    (quote: ShownQuote, anchor: DOMRect) => {
      const token = draftTokenFor(quote)
      if (token) edit(token, anchor)
    },
    [edit],
  )
  const onRemoveFromCard = useCallback(
    (quote: ShownQuote) => {
      const token = draftTokenFor(quote)
      if (token) remove(token)
    },
    [remove],
  )

  // ⌘/Ctrl+Enter in the editor saves and sends; the send reads the draft the
  // save wrote, so it waits for that draft to render.
  const sendAfterSaveRef = useRef(false)
  useEffect(() => {
    if (!sendAfterSaveRef.current) return
    sendAfterSaveRef.current = false
    latest.current.submit()
  }, [draft])

  const save = useCallback((editingNow: Editing, comment: string, send: boolean) => {
    setEditing(null)
    const { draft, setDraft } = latest.current
    const found = collectQuotes(draft).find((each) => each.token === editingNow.token)
    if (!found) return
    const saved = quoteToken({ ...found, comment: comment.trim() })
    const next = `${draft.slice(0, found.from)}${saved}${draft.slice(found.to)}`
    const end = found.from + saved.length
    const caret = Math.min(next.length, end + (next[end] === ' ' ? 1 : 0))
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
      // Escape on the editor a quote opened with takes the quote back out,
      // with exactly the spaces it went in with.
      if (editingNow.fresh) remove(editingNow.token, editingNow.spaces)
      else focusComposer(null)
    },
    [remove],
  )

  // An editor for a quote no longer in the draft (sent, or deleted) closes.
  useEffect(() => {
    if (editing && !draft.includes(editing.token)) setEditing(null)
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

  const highlights = (
    <QuoteHighlights
      transcriptRef={input.transcriptRef}
      quotes={quotes}
      controlRef={controlRef}
      onEdit={onEditFromCard}
      onRemove={onRemoveFromCard}
      onLanding={onLanding}
    />
  )

  const renderQuoteChip = useCallback(
    (quote: ChatQuoteToken) => (
      <QuoteChip quote={quote} onEdit={(element) => edit(quote.token, element)} onGoToSource={goToSource} />
    ),
    [edit, goToSource],
  )

  const editor = editing ? (
    <QuoteCommentEditor
      key={`${editing.token}:${editing.fresh}`}
      n={editing.n}
      initial={editing.initial}
      anchor={editing.anchor}
      onSave={(comment, send) => save(editing, comment, send)}
      onCancel={() => cancel(editing)}
    />
  ) : null

  return { cite, renderQuoteChip, goToSource, highlights, editor }
}

function stripPosition({ from: _from, to: _to, token: _token, ...quote }: ChatQuoteToken): ChatQuote {
  return quote
}

function sourceGone(): void {
  showToast({
    tone: 'neutral',
    title: 'Reply not found',
    description: 'The reply this passage was quoted from is no longer in this conversation.',
  })
}
