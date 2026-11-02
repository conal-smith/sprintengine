import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { ChatQuote } from '../../../../../shared/chat-quotes'
import { CloseIconButton, IconButton, Tooltip } from '../../ui'
import { useClampedMenuPosition } from '../../ui/ContextMenu'
import { EditChangelistGlyph } from '../../ui/GitActionGlyphs'
import { OVERLAY_SURFACE_CLASS } from '../../ui/tokens'
import { quoteSourceOf, quoteSources, rangeForQuote, QUOTE_SOURCE_ATTRIBUTE } from './quoteAnchors'

// Every quote in the conversation keeps its passage marked in the reply it
// came from: a gold tint behind the words, and the quote's number
// in a small badge after the last of them. A quote still in the draft is
// marked at full strength; one a sent message carries is dimmer, history
// rather than work in hand. Hovering a marked passage (or its badge) shows a
// card with the comment, and for a draft quote the two things that can be done
// to it there: edit the comment, or take the quote out of the draft.
//
// The transcript is a virtualized list whose rows are React's, recycled as it
// scrolls and re-rendered on every token of a reply, so nothing here touches
// them. The words are painted through the CSS Custom Highlight API, as Find in
// chat paints its matches (chatFindHighlight.ts), and the badges are drawn in
// one layer of our own laid over the transcript, placed from the passage's
// client rects. Both are worked out again when the rows change, the list
// scrolls or the pane resizes, a frame at a time, and only for the replies the
// list has drawn. A passage that cannot be found again (the reply drew it
// differently) is simply not marked; its chip and popover still read the quote.

/** A quote as the transcript marks it: whether it is in the draft or was sent already. */
export type ShownQuote = ChatQuote & { sent: boolean }

export const QUOTE_HIGHLIGHT = 'chat-quote'
export const QUOTE_SENT_HIGHLIGHT = 'chat-quote-sent'
export const QUOTE_FLASH_HIGHLIGHT = 'chat-quote-flash'

// How long the pointer may be off both the passage and its card before the
// card goes, and how long it rests on a passage before the card comes: long
// enough to cross the gap between them, short enough not to linger.
const CARD_CLOSE_DELAY_MS = 200
const CARD_OPEN_DELAY_MS = 250
// How long a passage "Go to source" landed on stays lit.
const FLASH_MS = 1_200
// How long a landing waits for its passage to be drawn before giving up.
const FLASH_WAIT_MS = 4_000

// ── The highlight registry ────────────────────────────────────────────────

type HighlightRegistry = { set(name: string, highlight: unknown): void; delete(name: string): void }
type HighlightConstructor = new (...ranges: Range[]) => { priority: number }

function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightConstructor } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS
  const Highlight = (globalThis as { Highlight?: HighlightConstructor }).Highlight
  return css?.highlights && Highlight ? { registry: css.highlights, Highlight } : null
}

// One registry per document and possibly more than one chat marking quotes
// (two side by side): each owns its ranges here and the three entries are
// rebuilt from all of them, as Find in chat's are.
type Painted = { draft: readonly Range[]; sent: readonly Range[]; flash: readonly Range[] }
const painted = new Map<object, Painted>()

function repaintRegistry(): void {
  const api = highlightApi()
  if (!api) return
  const all = { draft: [] as Range[], sent: [] as Range[], flash: [] as Range[] }
  for (const entry of painted.values()) {
    all.draft.push(...entry.draft)
    all.sent.push(...entry.sent)
    all.flash.push(...entry.flash)
  }
  const set = (name: string, ranges: Range[], priority: number) => {
    if (!ranges.length) {
      api.registry.delete(name)
      return
    }
    const highlight = new api.Highlight(...ranges)
    // Under a find's matches, which are what the reader is looking for now.
    highlight.priority = priority
    api.registry.set(name, highlight)
  }
  set(QUOTE_SENT_HIGHLIGHT, all.sent, -2)
  set(QUOTE_HIGHLIGHT, all.draft, -1)
  set(QUOTE_FLASH_HIGHLIGHT, all.flash, -1)
}

function paintQuotes(owner: object, next: Painted): void {
  if (!next.draft.length && !next.sent.length && !next.flash.length) {
    if (painted.delete(owner)) repaintRegistry()
    return
  }
  painted.set(owner, next)
  repaintRegistry()
}

// ── Placing ───────────────────────────────────────────────────────────────

/** Where one quote's passage is on screen right now. */
type Placed = { quote: ShownQuote; range: Range; rects: DOMRect[] }

/** A badge as the layer draws it, in the transcript's own coordinates. */
type Badge = { key: string; n: number; sent: boolean; left: number; top: number }

const quoteKey = (quote: Pick<ChatQuote, 'turnId' | 'n'>) => `${quote.turnId}#${quote.n}`

function sameBadges(a: readonly Badge[], b: readonly Badge[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (badge, index) =>
        badge.key === b[index]!.key &&
        badge.sent === b[index]!.sent &&
        Math.abs(badge.left - b[index]!.left) < 0.5 &&
        Math.abs(badge.top - b[index]!.top) < 0.5,
    )
  )
}

function hits(rects: readonly DOMRect[], x: number, y: number): DOMRect | null {
  return rects.find((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) ?? null
}

/** What the chat can ask of the layer. */
export type QuoteHighlightControl = {
  /** Where a draft quote's passage is on screen, when it is drawn and in view. */
  rectOf(n: number): DOMRect | null
  /** Light a quote's passage for a moment once it is drawn, and hand its range to `onLanding`. */
  flash(quote: Pick<ChatQuote, 'turnId' | 'n'>): void
}

type HoverCard = { quote: ShownQuote; anchor: { left: number; bottom: number } }

/**
 * The layer that marks every quote's passage in the transcript under
 * `transcriptRef`. Renders only when the quotes or their badges' places
 * change: a keystroke in the composer that leaves the draft's quotes as they
 * were reaches it as the same array and renders nothing.
 */
export const QuoteHighlights = memo(function QuoteHighlights({
  transcriptRef,
  quotes,
  controlRef,
  onEdit,
  onRemove,
  onLanding,
}: {
  transcriptRef: RefObject<HTMLElement | null>
  quotes: readonly ShownQuote[]
  controlRef: RefObject<QuoteHighlightControl | null>
  onEdit: (n: number, anchor: DOMRect) => void
  onRemove: (n: number) => void
  /** A passage "Go to source" asked for has been drawn: bring it into view. */
  onLanding: (range: Range) => void
}): JSX.Element | null {
  const owner = useRef({}).current
  const [badges, setBadges] = useState<readonly Badge[]>([])
  const [card, setCard] = useState<HoverCard | null>(null)
  const quotesRef = useRef(quotes)
  quotesRef.current = quotes
  const placedRef = useRef<Placed[]>([])
  // Ranges found per turn, kept until a mutation inside that turn's prose (or
  // a change in which elements draw it) makes them stale.
  const cacheRef = useRef(new Map<string, { elements: Element[]; ranges: Map<string, Range | null> }>())
  const dirtyRef = useRef(new Set<string>())
  const flashRef = useRef<{ key: string; until: number; landed: boolean } | null>(null)
  const latest = useRef({ onLanding, schedule: () => {} })
  latest.current.onLanding = onLanding

  const paint = useCallback(() => {
    const root = transcriptRef.current
    const shown = quotesRef.current
    if (!root || shown.length === 0) {
      paintQuotes(owner, { draft: [], sent: [], flash: [] })
      placedRef.current = []
      setBadges((previous) => (previous.length ? [] : previous))
      return
    }
    const sources = quoteSources(root)
    const cache = cacheRef.current
    for (const turnId of cache.keys()) {
      const elements = sources.get(turnId)
      const cached = cache.get(turnId)!
      if (
        !elements ||
        dirtyRef.current.has(turnId) ||
        elements.length !== cached.elements.length ||
        elements.some((element, index) => element !== cached.elements[index])
      )
        cache.delete(turnId)
    }
    dirtyRef.current.clear()
    const box = root.getBoundingClientRect()
    const placed: Placed[] = []
    const draft: Range[] = []
    const sent: Range[] = []
    const flash: Range[] = []
    const nextBadges: Badge[] = []
    const now = Date.now()
    const flashing = flashRef.current && flashRef.current.until > now ? flashRef.current : null
    for (const quote of shown) {
      const elements = sources.get(quote.turnId)
      if (!elements) continue
      let entry = cache.get(quote.turnId)
      if (!entry) {
        entry = { elements, ranges: new Map() }
        cache.set(quote.turnId, entry)
      }
      const key = quoteKey(quote)
      let range = entry.ranges.get(key)
      if (range === undefined) {
        range = rangeForQuote(elements, quote)
        entry.ranges.set(key, range)
      }
      if (!range) continue
      ;(quote.sent ? sent : draft).push(range)
      if (flashing?.key === key) {
        flash.push(range)
        if (!flashing.landed) {
          flashing.landed = true
          flashing.until = now + FLASH_MS
          latest.current.onLanding(range)
          // Painted once more when the moment is up, which leaves it out.
          setTimeout(() => latest.current.schedule(), FLASH_MS + 50)
        }
      }
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0)
      placed.push({ quote, range, rects })
      const last = rects.at(-1)
      if (!last || last.bottom < box.top || last.top > box.bottom) continue
      nextBadges.push({ key, n: quote.n, sent: quote.sent, left: last.right - box.left, top: last.top - box.top })
    }
    placedRef.current = placed
    paintQuotes(owner, { draft, sent, flash })
    setBadges((previous) => (sameBadges(previous, nextBadges) ? previous : nextBadges))
  }, [owner, transcriptRef])

  const frameRef = useRef(0)
  const schedule = useCallback(() => {
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      paint()
    })
  }, [paint])
  latest.current.schedule = schedule

  // The quotes changed: paint again. Their ranges are kept, keyed by quote.
  useEffect(() => {
    schedule()
  }, [quotes, schedule])

  // The page moved under the passages: rows drawn, recycled or streamed into,
  // the list scrolled, the pane resized. Only while there is something to mark.
  const marking = quotes.length > 0
  useEffect(() => {
    const root = transcriptRef.current
    if (!marking || !root) return
    const observer =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver((records) => {
            for (const record of records) {
              const source = quoteSourceOf(record.target)
              const turnId = source?.getAttribute(QUOTE_SOURCE_ATTRIBUTE)
              if (turnId) dirtyRef.current.add(turnId)
            }
            schedule()
          })
    observer?.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [QUOTE_SOURCE_ATTRIBUTE],
    })
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    resize?.observe(root)
    root.addEventListener('scroll', schedule, { capture: true, passive: true })
    return () => {
      observer?.disconnect()
      resize?.disconnect()
      root.removeEventListener('scroll', schedule, true)
    }
  }, [marking, transcriptRef, schedule])

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      paintQuotes(owner, { draft: [], sent: [], flash: [] })
    },
    [owner],
  )

  // ── Hover ────────────────────────────────────────────────────────────────

  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoveredRef = useRef<string | null>(null)
  const clearTimer = (timer: RefObject<ReturnType<typeof setTimeout> | null>) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  const closeSoon = useCallback(() => {
    clearTimer(openTimer)
    hoveredRef.current = null
    if (closeTimer.current) return
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null
      setCard(null)
    }, CARD_CLOSE_DELAY_MS)
  }, [])
  const keepOpen = useCallback(() => clearTimer(closeTimer), [])

  useEffect(() => {
    const root = transcriptRef.current
    if (!marking || !root) return
    let frame = 0
    let point = { x: 0, y: 0 }
    const test = () => {
      frame = 0
      for (const entry of placedRef.current) {
        const rect = hits(entry.rects, point.x, point.y) ?? hitsBadge(entry, point)
        if (!rect) continue
        const key = quoteKey(entry.quote)
        keepOpen()
        if (hoveredRef.current === key) return
        hoveredRef.current = key
        clearTimer(openTimer)
        const last = entry.rects.at(-1) ?? rect
        openTimer.current = setTimeout(() => {
          openTimer.current = null
          setCard({ quote: entry.quote, anchor: { left: rect.left, bottom: Math.max(rect.bottom, last.bottom) } })
        }, CARD_OPEN_DELAY_MS)
        return
      }
      if (hoveredRef.current) closeSoon()
    }
    const onMove = (event: PointerEvent) => {
      point = { x: event.clientX, y: event.clientY }
      if (!frame) frame = requestAnimationFrame(test)
    }
    const onLeave = () => {
      if (hoveredRef.current) closeSoon()
    }
    root.addEventListener('pointermove', onMove, { passive: true })
    root.addEventListener('pointerleave', onLeave)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      root.removeEventListener('pointermove', onMove)
      root.removeEventListener('pointerleave', onLeave)
    }
  }, [marking, transcriptRef, keepOpen, closeSoon])

  useEffect(
    () => () => {
      clearTimer(openTimer)
      clearTimer(closeTimer)
    },
    [],
  )

  // A card for a quote that has gone (removed, or the draft sent) goes with it.
  const cardKey = card ? quoteKey(card.quote) : null
  const cardQuote = cardKey ? quotes.find((quote) => quoteKey(quote) === cardKey) : null
  useEffect(() => {
    if (card && !cardQuote) setCard(null)
  }, [card, cardQuote])

  // ── What the chat asks of it ─────────────────────────────────────────────

  useLayoutEffect(() => {
    const control: QuoteHighlightControl = {
      rectOf(n) {
        const root = transcriptRef.current
        const entry = placedRef.current.find((placed) => placed.quote.n === n && !placed.quote.sent)
        if (!root || !entry?.range.startContainer.isConnected) return null
        const rect = entry.range.getBoundingClientRect()
        const box = root.getBoundingClientRect()
        return rect.bottom < box.top || rect.top > box.bottom ? null : rect
      },
      flash(quote) {
        flashRef.current = { key: quoteKey(quote), until: Date.now() + FLASH_WAIT_MS, landed: false }
        schedule()
      },
    }
    const handle = controlRef as { current: QuoteHighlightControl | null }
    handle.current = control
    return () => {
      if (handle.current === control) handle.current = null
    }
  }, [controlRef, schedule, transcriptRef])

  if (!badges.length && !card) return null
  return (
    <>
      {badges.length ? (
        <div aria-hidden="true" data-copy-exclude="" className="pointer-events-none absolute inset-0 overflow-hidden">
          {badges.map((badge) => (
            <span
              key={badge.key}
              data-quote-badge={badge.n}
              style={{ left: badge.left, top: badge.top }}
              className={`absolute -translate-y-1/3 rounded-xs px-0.5 text-micro font-medium leading-none tabular-nums ${
                badge.sent
                  ? 'bg-[color:var(--sem-color-quote-tint-sent)] text-[color:var(--sem-color-quote-ink-sent)]'
                  : 'bg-[color:var(--sem-color-quote-tint)] text-[color:var(--sem-color-quote-ink)]'
              }`}
            >
              {badge.n}
            </span>
          ))}
        </div>
      ) : null}
      {card && cardQuote ? (
        <QuoteHoverCard
          quote={cardQuote}
          anchor={card.anchor}
          onPointerEnter={keepOpen}
          onPointerLeave={closeSoon}
          onEdit={() => {
            const rect = placedRef.current.find((placed) => quoteKey(placed.quote) === cardKey)
            setCard(null)
            onEdit(
              cardQuote.n,
              rect?.range.getBoundingClientRect() ?? new DOMRect(card.anchor.left, card.anchor.bottom, 0, 0),
            )
          }}
          onRemove={() => {
            setCard(null)
            onRemove(cardQuote.n)
          }}
        />
      ) : null}
    </>
  )
})

// The badge sits just past the passage's last character; a pointer on it is
// on the passage too.
function hitsBadge(entry: Placed, point: { x: number; y: number }): DOMRect | null {
  const last = entry.rects.at(-1)
  if (!last) return null
  const badge = new DOMRect(last.right, last.top - last.height / 3, last.height, last.height)
  return hits([badge], point.x, point.y) ? last : null
}

/**
 * The card a marked passage shows under the pointer: the comment, or with no
 * comment the quoted words in muted italics. A draft quote's card carries its
 * two actions as bare glyphs at the top right; a sent quote's carries none,
 * since what was sent is not edited. It holds controls, so it is a small
 * popover rather than a tooltip, and it stays while the pointer crosses from
 * the passage into it.
 */
function QuoteHoverCard({
  quote,
  anchor,
  onPointerEnter,
  onPointerLeave,
  onEdit,
  onRemove,
}: {
  quote: ShownQuote
  anchor: { left: number; bottom: number }
  onPointerEnter: () => void
  onPointerLeave: () => void
  onEdit: () => void
  onRemove: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const position = useClampedMenuPosition(anchor.left, anchor.bottom + 4, ref)
  const comment = quote.comment.trim()
  return createPortal(
    <div
      ref={ref}
      role="group"
      aria-label={`Quote ${quote.n}`}
      data-quote-card={quote.n}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={{ left: position.left, top: position.top }}
      className={`fixed z-[var(--z-popover)] flex max-w-[22rem] items-start gap-2 px-2.5 py-2 ${OVERLAY_SURFACE_CLASS}`}
    >
      <p
        className={`line-clamp-6 min-w-0 flex-1 whitespace-pre-wrap break-words text-body ${
          comment ? 'text-[color:var(--text-default)]' : 'italic text-[color:var(--text-muted)]'
        }`}
      >
        {comment || quote.exact || quote.quote}
      </p>
      {quote.sent ? null : (
        <div className="-mr-1 -mt-0.5 flex shrink-0 items-center">
          <Tooltip content="Edit comment">
            <IconButton size="inline" aria-label="Edit comment" onClick={onEdit}>
              <EditChangelistGlyph className="icon-xs" />
            </IconButton>
          </Tooltip>
          <Tooltip content="Remove quote">
            <CloseIconButton size="inline" aria-label="Remove quote" onClick={onRemove} />
          </Tooltip>
        </div>
      )}
    </div>,
    document.body,
  )
}
