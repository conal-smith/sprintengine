import React, { useRef } from 'react'
import { useFlipReorder } from '../../utils/flipReorder'
import { TruncatedText } from './TruncatedText'

// BoardLane — canonical lane chrome for any
// future board panel that needs a flexible-width column (260 px floor by
// default) with a header, a FLIP-animated scrollable list, and optional
// drag-and-drop.
//
// No surface renders a board today. The primitive is kept, with its catalog
// entry (design-system/components/board-lane), so a future module's board is
// built from — and compared against — the design system.
//
// The lane primitive owns:
//   - The flex column section (`flex-1` with a caller-set `minWidth` floor)
//   - The header rhythm (label + optional glyph + count)
//   - The scrollable `<ol>` body with FLIP wired via useFlipReorder
//   - The visual state classes for the four drag states (default, dimmed,
//     legal-drop-target, source)
//   - The DnD event plumbing — `onDragOver` callbacks receive the computed
//     drop index, derived from the lane's own list ref + the canonical
//     `[data-task-card]` selector (TaskCard sets this; do not query
//     `[data-card]` — that legacy selector never matched the primitive)
//
// The lane does NOT own:
//   - Which cards to render (caller composes <TaskCard> children directly)
//   - The drop-indicator interleaving (caller interleaves
//     `<BoardLaneDropIndicator />` between cards based on the dropIndex
//     they hold in state)
//   - Empty-state copy (caller renders the empty placeholder as one of the
//     children when the records list is empty)
//
// A board whose cards move on their own passes no `dnd` prop. A lane that
// participates in drag-and-drop passes the three handlers and renders
// DropIndicator children at the computed index. The visual state prop maps to:
//   default            — no special chrome
//   dimmed             — 40 % opacity (lane is not a legal drop target)
//   legal-drop-target  — accent ring (lane will accept the dragged card)
//   source             — neutral (the lane the card is being dragged from)

type LaneState = 'default' | 'dimmed' | 'legal-drop-target' | 'source'

type BoardLaneDnd = {
  /** Receives the computed drop index. Caller stores in state and
   *  interleaves `<BoardLaneDropIndicator />` children at that index. */
  onDragOver: (dropIndex: number) => void
  onDragLeave: () => void
  onDrop: () => void
}

type BoardLaneProps = {
  /** Sentence-case lane label. Renders semibold + strong ink. */
  label: string
  /** Optional leading glyph (e.g. StatusIcon). Sized at 14 px to align with
   *  the label's cap-height. */
  glyph?: React.ReactNode
  /** Item count. Rendered tabular-nums + subtle. */
  count: number
  /** Aria-label for the section. Defaults to `${label} lane`. */
  ariaLabel?: string
  /** FLIP signature. Typically `ids.join(',')`. Changing this triggers the
   *  reorder animation. */
  flipKey: string
  /** Drag state. See module header for the four-state matrix. */
  state?: LaneState
  /** Render the lane as a filled, hairline-bordered panel (fill = --bg-surface,
   *  7 px radius) and lift the cards inside it one elevation step to
   *  --bg-surface-raised with an inset hairline. Off by default, which keeps
   *  transparent lanes on a board canvas; a board opts in so
   *  the columns read as discrete panels. The inset card hairline is what keeps
   *  cards legible in the light theme, where --bg-surface and
   *  --bg-surface-raised collapse to the same white. */
  surface?: boolean
  /** Minimum lane width in px before the board scrolls. Lanes are `flex-1`, so
   *  they grow to fill the row and shrink to this floor. Defaults to 260
   *  (a comfortable card width). A dense board passes a thinner
   *  floor so every lane fits the panel and the row only scrolls past it. */
  minWidth?: number
  /** DnD plumbing. Pass only when the lane participates in drag-and-drop. */
  dnd?: BoardLaneDnd
  /** Children rendered inside the lane's `<ol>`. Caller composes TaskCards
   *  (and DropIndicators when DnD is active). */
  children: React.ReactNode
}

function computeDropIndex(list: HTMLOListElement, clientY: number): number {
  const cards = list.querySelectorAll('[data-task-card]')
  for (let i = 0; i < cards.length; i += 1) {
    const rect = cards[i].getBoundingClientRect()
    if (clientY < rect.top + rect.height / 2) return i
  }
  return cards.length
}

export function BoardLane({
  label,
  glyph,
  count,
  ariaLabel,
  flipKey,
  state = 'default',
  surface = false,
  minWidth = 260,
  dnd,
  children,
}: BoardLaneProps) {
  const listRef = useRef<HTMLOListElement | null>(null)
  useFlipReorder(listRef, flipKey)

  const sectionClass = [
    'flex h-full flex-1 flex-col transition-colors',
    surface ? 'rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]' : '',
    state === 'legal-drop-target' ? 'ring-1 ring-[color:var(--accent-primary)]' : '',
    state === 'dimmed' ? 'opacity-40' : '',
  ]
    .filter(Boolean)
    .join(' ')

  // minWidth is the scroll floor; the surface vars are a custom-property channel
  // consumed by the TaskCard children. The cast is the justified boundary for
  // CSS variables, which React.CSSProperties can't type.
  const laneStyle = {
    minWidth: `${minWidth}px`,
    ...(surface
      ? {
          '--task-card-bg': 'var(--bg-surface-raised)',
          '--task-card-shadow': 'inset 0 0 0 1px var(--border-subtle)',
        }
      : {}),
  } as React.CSSProperties

  return (
    <section
      className={sectionClass}
      style={laneStyle}
      aria-label={ariaLabel ?? `${label} lane`}
      onDragOver={
        dnd
          ? (event) => {
              const list = listRef.current
              if (!list) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              dnd.onDragOver(computeDropIndex(list, event.clientY))
            }
          : undefined
      }
      onDragLeave={
        dnd
          ? (event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
              dnd.onDragLeave()
            }
          : undefined
      }
      onDrop={
        dnd
          ? (event) => {
              event.preventDefault()
              dnd.onDrop()
            }
          : undefined
      }
    >
      <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-2.5">
        <span className="flex min-w-0 items-center gap-1.5">
          {glyph}
          <TruncatedText as="span" text={label} className="text-meta font-semibold text-[color:var(--text-strong)]" />
        </span>
        <span className="shrink-0 tabular-nums text-micro text-[color:var(--text-subtle)]">{count}</span>
      </div>
      <ol ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 py-2">
        {children}
      </ol>
    </section>
  )
}
