// Turn-by-turn navigation over the virtualized transcript: the marks the
// gutter minimap draws (one per prompt the person sent), which of them the
// reader is in, and where "previous turn" / "next turn" land.

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from 'react'
import type { LegendListRef } from '@legendapp/list/react'
import type { ConversationTimelineRow } from './conversationTimeline'

/** A short conversation is read by scrolling; the minimap starts at three prompts. */
export const TURN_MINIMAP_MIN_TURNS = 3

export type TurnMark = {
  id: string
  rowIndex: number
  prompt: string
}

export type TurnDirection = -1 | 1

/** One mark per user row. */
export function deriveTurnMarks(rows: readonly ConversationTimelineRow[]): TurnMark[] {
  const marks: TurnMark[] = []
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    if (row.kind === 'user') marks.push({ id: row.id, rowIndex: index, prompt: row.entry.text })
  }
  return marks
}

/**
 * What the marks are derived from: where each prompt sits. A streamed token
 * gives the rows a new identity without moving a prompt, so the marks — and
 * the minimap's ticks drawn from them — are kept until this changes.
 */
export function turnMarksKey(rows: readonly ConversationTimelineRow[]): string {
  let key = ''
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    if (row.kind === 'user') key += `${index}:${row.id}\n`
  }
  return key
}

/**
 * The turn's last reply — the final assistant prose before the next prompt —
 * or null while it has none yet. Read when a preview is shown rather than kept
 * on the mark, because the latest reply changes with every token.
 */
export function turnReply(
  rows: readonly ConversationTimelineRow[],
  marks: readonly TurnMark[],
  index: number,
): string | null {
  const mark = marks[index]
  if (!mark) return null
  const end = marks[index + 1]?.rowIndex ?? rows.length
  for (let row = end - 1; row > mark.rowIndex; row--) {
    const candidate = rows[row]
    if (candidate?.kind === 'assistant' && candidate.entry.text.trim()) return candidate.entry.text
  }
  return null
}

/** Whitespace-collapsed and cut at a word, for a one-glance preview. */
export function turnPreviewText(text: string | null, limit: number): string | null {
  const compact = text?.replace(/\s+/g, ' ').trim() ?? ''
  if (!compact) return null
  if (compact.length <= limit) return compact
  const cut = compact.slice(0, limit)
  const space = cut.lastIndexOf(' ')
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** The turn holding the first visible row: the last prompt at or above it, else -1. */
export function turnAtRow(marks: readonly TurnMark[], firstVisibleRow: number): number {
  let found = -1
  for (let index = 0; index < marks.length && marks[index]!.rowIndex <= firstVisibleRow; index++) found = index
  return found
}

/**
 * Where a step lands, or -1 when there is nowhere to go. Stepping back from the
 * middle of a turn returns to that turn's own prompt first — the way a shell's
 * previous-prompt jump does — and only a reader already at the prompt moves to
 * the one before it.
 */
export function adjacentTurn(
  marks: readonly TurnMark[],
  firstVisibleRow: number,
  direction: TurnDirection,
  anchor: number | null = null,
): number {
  if (marks.length === 0) return -1
  if (anchor !== null && anchor >= 0 && anchor < marks.length) {
    const target = anchor + direction
    return target >= 0 && target < marks.length ? target : -1
  }
  const current = turnAtRow(marks, firstVisibleRow)
  if (direction === 1) return current + 1 < marks.length ? current + 1 : -1
  if (current < 0) return -1
  return marks[current]!.rowIndex === firstVisibleRow ? current - 1 : current
}

/** Where the reader is among the turns: what the minimap marks and the step buttons offer. */
export type TurnPosition = { current: number; hasPrevious: boolean; hasNext: boolean }

/**
 * The reader's position, kept outside React state: it changes as the reader
 * scrolls, and only the minimap draws it, so a scroll redraws the minimap
 * rather than the whole chat view.
 */
export type TurnPositionSource = {
  get(): TurnPosition
  subscribe(listener: () => void): () => void
}

type PositionStore = TurnPositionSource & {
  marks: readonly TurnMark[]
  firstVisibleRow: number
  anchor: number | null
  setFirstVisibleRow(row: number): void
  setAnchor(anchor: number | null): void
}

function createPositionStore(): PositionStore {
  const listeners = new Set<() => void>()
  let cached: { marks: readonly TurnMark[]; first: number; anchor: number | null; position: TurnPosition } | null = null
  const store: PositionStore = {
    marks: [],
    firstVisibleRow: 0,
    anchor: null,
    get() {
      const { marks, firstVisibleRow: first, anchor } = store
      if (cached && cached.marks === marks && cached.first === first && cached.anchor === anchor) return cached.position
      const position = {
        current: anchor ?? turnAtRow(marks, first),
        hasPrevious: adjacentTurn(marks, first, -1, anchor) >= 0,
        hasNext: adjacentTurn(marks, first, 1, anchor) >= 0,
      }
      const same =
        cached &&
        cached.position.current === position.current &&
        cached.position.hasPrevious === position.hasPrevious &&
        cached.position.hasNext === position.hasNext
      cached = { marks, first, anchor, position: same ? cached!.position : position }
      return cached.position
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setFirstVisibleRow(row) {
      if (row === store.firstVisibleRow) return
      store.firstVisibleRow = row
      for (const listener of listeners) listener()
    },
    setAnchor(anchor) {
      if (anchor === store.anchor) return
      store.anchor = anchor
      for (const listener of listeners) listener()
    },
  }
  return store
}

/** A position that never moves, for a navigation drawn once (a test, a preview). */
export function fixedTurnPosition(position: TurnPosition): TurnPositionSource {
  return { get: () => position, subscribe: () => () => undefined }
}

/** The reader's position, for the component that draws it. */
export function useTurnPosition(navigation: Pick<TurnNavigation, 'position'>): TurnPosition {
  return useSyncExternalStore(navigation.position.subscribe, navigation.position.get, navigation.position.get)
}

/**
 * Tracks the reader's turn from the list's first visible row and steps between
 * prompts. A jump remembers the turn it landed on until the reader scrolls by
 * hand: the row above a freshly jumped-to prompt can still report as the first
 * visible one by a pixel, and stepping from it would land on the same prompt.
 *
 * The returned navigation keeps its identity while the prompts stay where
 * they are; where the reader is lives in `position`.
 */
export function useTurnNavigation(input: {
  rows: readonly ConversationTimelineRow[]
  listRef: RefObject<LegendListRef | null>
  jumpToRow: (index: number, id: string) => void
}): TurnNavigation {
  const { rows, listRef } = input
  const marksKey = turnMarksKey(rows)
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  // Keyed on where the prompts sit, not on the rows' identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const marks = useMemo(() => deriveTurnMarks(rowsRef.current), [marksKey])
  const storeRef = useRef<PositionStore | null>(null)
  const store = (storeRef.current ??= createPositionStore())
  store.marks = marks
  const jumpToRowRef = useRef(input.jumpToRow)
  jumpToRowRef.current = input.jumpToRow
  const reply = useCallback((markIndex: number) => turnReply(rowsRef.current, store.marks, markIndex), [store])

  // Re-subscribed as prompts arrive: cheap, and it picks the scroller up even
  // when the list mounted a frame after the first row did.
  const markCount = marks.length
  useEffect(() => {
    const list = listRef.current
    const scroller = list?.getScrollableNode() as HTMLElement | null | undefined
    if (!list || !scroller) return
    let frame = 0
    const read = () => {
      frame = 0
      const start = list.getState().start
      if (Number.isFinite(start)) store.setFirstVisibleRow(Math.max(0, start))
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    // Only the reader's own input releases a jump's anchor: the jump's scroll
    // event, and a streaming reply growing the list, are not the reader moving.
    const release = () => store.setAnchor(null)
    read()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    scroller.addEventListener('wheel', release, { passive: true })
    scroller.addEventListener('touchstart', release, { passive: true })
    scroller.addEventListener('pointerdown', release)
    scroller.addEventListener('keydown', release)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('wheel', release)
      scroller.removeEventListener('touchstart', release)
      scroller.removeEventListener('pointerdown', release)
      scroller.removeEventListener('keydown', release)
    }
  }, [listRef, markCount, store])

  // A page of earlier turns shifts every index; the remembered one with it.
  const firstMarkId = marks[0]?.id
  useEffect(() => store.setAnchor(null), [firstMarkId, store])

  const jump = useCallback(
    (markIndex: number) => {
      const mark = store.marks[markIndex]
      if (!mark) return
      store.setAnchor(markIndex)
      jumpToRowRef.current(mark.rowIndex, mark.id)
    },
    [store],
  )
  const step = useCallback(
    (direction: TurnDirection) => {
      const target = adjacentTurn(store.marks, store.firstVisibleRow, direction, store.anchor)
      if (target >= 0) jump(target)
    },
    [jump, store],
  )
  const wheel = useCallback(
    (event: WheelEvent) => {
      const scroller = listRef.current?.getScrollableNode() as HTMLElement | null | undefined
      if (scroller) forwardWheel(event, scroller)
    },
    [listRef],
  )
  return useMemo(() => ({ marks, jump, step, reply, wheel, position: store }), [marks, jump, step, reply, wheel, store])
}

// A line of wheel travel, in pixels, for a mouse that reports lines.
const WHEEL_LINE_PX = 16

/**
 * Scrolls the transcript by a wheel turned over something laid over it, the
 * minimap, which is a sibling of the scroller rather than inside it: the
 * browser scrolls the target's nearest scrolling ancestor, and the minimap has
 * none, so a wheel over it moved nothing. The event is dispatched on the
 * scroller first, so what listens there for the reader's own input (releasing
 * a jump's anchor, ending a scroll restore) hears it; a dispatched event never
 * scrolls by itself, so the distance is then applied. A pinch (`ctrlKey`) is
 * left to the app's zoom.
 */
export function forwardWheel(event: WheelEvent, scroller: HTMLElement): void {
  if (event.defaultPrevented || event.ctrlKey || event.deltaY === 0) return
  event.preventDefault()
  const forwarded = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaZ: event.deltaZ,
    deltaMode: event.deltaMode,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    altKey: event.altKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  })
  if (!scroller.dispatchEvent(forwarded)) return
  const unit =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? WHEEL_LINE_PX
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? scroller.clientHeight
        : 1
  scroller.scrollBy({ top: event.deltaY * unit })
}

export type TurnNavigation = {
  marks: readonly TurnMark[]
  jump: (markIndex: number) => void
  step: (direction: TurnDirection) => void
  reply: (markIndex: number) => string | null
  /** Scrolls the transcript by a wheel turned over the minimap. */
  wheel: (event: WheelEvent) => void
  position: TurnPositionSource
}
