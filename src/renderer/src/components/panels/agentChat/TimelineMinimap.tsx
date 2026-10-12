import { useEffect, useMemo, useRef, useState, type JSX, type TransitionEvent } from 'react'
import { IconButton } from '../../ui'
import { OVERLAY_SURFACE_CLASS } from '../../ui/tokens'
import {
  TURN_MINIMAP_MIN_TURNS,
  turnPreviewText,
  useTurnPosition,
  type TurnMark,
  type TurnNavigation,
} from './turnNavigation'

// One tick per prompt, spaced evenly rather than by where the turn sits in the
// scroll height: a virtualized list only knows the heights it has rendered, and
// a tick that drifts as rows are measured is worse than one that stays put.
// Under the pointer the strip opens out, so each turn has room to land on.
const TICK_SPACING_PX = 8
const TICK_SPACING_EXPANDED_PX = 20

export function minimapTickTop(index: number, count: number): number {
  return count <= 1 ? 0 : (Math.max(0, Math.min(index, count - 1)) / (count - 1)) * 100
}

export function minimapIndexAtPointer(count: number, stripTop: number, stripHeight: number, pointerY: number): number {
  if (count <= 1 || stripHeight <= 0) return 0
  const ratio = Math.max(0, Math.min(1, (pointerY - stripTop) / stripHeight))
  return Math.round(ratio * (count - 1))
}

// 16-grid, 1.4 line work, currentColor — the chevron the step buttons carry.
function TurnStepGlyph({ direction }: { direction: 'up' | 'down' }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
      <path
        d={direction === 'up' ? 'M4.5 10 8 6.5l3.5 3.5' : 'M4.5 6 8 9.5 11.5 6'}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// A tick is always 24px wide and scaled from its right edge (to 6px at rest;
// with the strip open, 12px, 16px beside the hovered one and the full 24px
// under the pointer), so the hover grows it with a transform the compositor
// animates rather than a width that lays the strip out each frame.
function tickClass(index: number, current: number, hovered: number | null): string {
  const distance = hovered === null ? null : Math.abs(index - hovered)
  const scale =
    distance === null
      ? 'scale-x-25'
      : distance === 0
        ? 'scale-x-100'
        : distance === 1
          ? 'scale-x-[0.6667]'
          : 'scale-x-50'
  const ink =
    distance === 0
      ? 'bg-[color:var(--text-default)]'
      : index === current
        ? 'bg-[color:var(--text-muted)]'
        : 'bg-[color:var(--border-strong)]'
  return `pointer-events-none absolute right-0 h-0.5 w-6 origin-right -translate-y-1/2 rounded-full transition-[scale,background-color] duration-150 ${scale} ${ink}`
}

function MinimapPreview({
  mark,
  reply: replyText,
  index,
  count,
}: {
  mark: TurnMark
  reply: string | null
  index: number
  count: number
}): JSX.Element {
  const prompt = turnPreviewText(mark.prompt, 160) ?? 'Prompt with attachments only'
  const reply = turnPreviewText(replyText, 240)
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute right-full mr-2 block w-72 max-w-[60vw] px-3 py-2 text-left ${OVERLAY_SURFACE_CLASS}`}
      style={{
        top: `${minimapTickTop(index, count)}%`,
        // The end previews hang inward so neither runs off the strip's ends.
        transform: `translateY(${index === 0 ? '0%' : index === count - 1 ? '-100%' : '-50%'})`,
      }}
    >
      <span className="block truncate text-meta font-medium leading-5 text-[color:var(--text-strong)]">{prompt}</span>
      {reply ? (
        <span className="mt-0.5 line-clamp-3 text-meta leading-5 text-[color:var(--text-muted)]">{reply}</span>
      ) : null}
    </span>
  )
}

/**
 * The transcript's gutter minimap: a quiet tick per prompt in the right gutter,
 * a preview of the prompt and the start of its reply on hover, and a click to
 * jump there. The strip itself is pointer-only; the step buttons above and
 * below it, and the previous/next-turn shortcuts, are the keyboard's way
 * through the same turns.
 */
export function TimelineMinimap({ navigation }: { navigation: TurnNavigation }): JSX.Element | null {
  const { marks, jump, step, reply, wheel } = navigation
  const { current, hasPrevious, hasNext } = useTurnPosition(navigation)
  const [hovered, setHovered] = useState<number | null>(null)
  // A wheel over the strip or its buttons scrolls the transcript beneath. The
  // listener is the DOM's own, not React's: React's wheel listener is passive,
  // and the forwarded wheel has to stop the browser scrolling anything else.
  const navRef = useRef<HTMLElement | null>(null)
  const shown = marks.length >= TURN_MINIMAP_MIN_TURNS
  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    nav.addEventListener('wheel', wheel, { passive: false })
    return () => nav.removeEventListener('wheel', wheel)
  }, [wheel, shown])
  // The strip opens out from under a still pointer, so the turn it rests on
  // is read again once the strip has finished growing.
  const pointerYRef = useRef<number | null>(null)
  // The minimap re-renders with every streamed token; its ticks only change
  // with the prompts, the reader's turn and the pointer.
  const ticks = useMemo(
    () =>
      marks.map((mark, index) => (
        <span
          key={mark.id}
          aria-hidden="true"
          data-current={index === current || undefined}
          className={tickClass(index, current, hovered)}
          style={{ top: `${minimapTickTop(index, marks.length)}%` }}
        />
      )),
    [marks, current, hovered],
  )
  if (!shown) return null
  const count = marks.length
  const hoveredMark = hovered !== null ? (marks[hovered] ?? null) : null
  const expanded = hovered !== null
  const indexAt = (strip: HTMLDivElement, pointerY: number) => {
    const rect = strip.getBoundingClientRect()
    return minimapIndexAtPointer(count, rect.top, rect.height, pointerY)
  }
  const spacing = expanded ? TICK_SPACING_EXPANDED_PX : TICK_SPACING_PX
  const stepClass =
    'pointer-events-auto opacity-0 transition-opacity duration-150 group-hover/minimap:opacity-100 group-focus-within/minimap:opacity-100'
  return (
    <nav
      ref={navRef}
      aria-label="Conversation turns"
      data-testid="timeline-minimap"
      className="group/minimap pointer-events-none absolute inset-y-0 right-3 z-[var(--z-float)] flex flex-col items-end justify-center gap-2"
    >
      <IconButton
        aria-label="Previous turn"
        size="3xs"
        tone="ink"
        className={stepClass}
        disabled={!hasPrevious}
        onClick={() => step(-1)}
      >
        <TurnStepGlyph direction="up" />
      </IconButton>
      <div
        role="presentation"
        data-minimap-strip=""
        data-expanded={expanded || undefined}
        className={`pointer-events-auto relative cursor-pointer transition-[height,width] duration-150 ease-out ${expanded ? 'w-8' : 'w-4'}`}
        style={{ height: `min(${(count - 1) * spacing}px, calc(100% - 6rem))` }}
        onMouseMove={(event) => {
          pointerYRef.current = event.clientY
          setHovered(indexAt(event.currentTarget, event.clientY))
        }}
        onMouseLeave={() => {
          pointerYRef.current = null
          setHovered(null)
        }}
        onTransitionEnd={(event: TransitionEvent<HTMLDivElement>) => {
          if (event.target !== event.currentTarget || event.propertyName !== 'height') return
          const pointerY = pointerYRef.current
          if (pointerY !== null) setHovered(indexAt(event.currentTarget, pointerY))
        }}
        onClick={(event) => jump(indexAt(event.currentTarget, event.clientY))}
      >
        {ticks}
        {hoveredMark && hovered !== null ? (
          <MinimapPreview mark={hoveredMark} reply={reply(hovered)} index={hovered} count={count} />
        ) : null}
      </div>
      <IconButton
        aria-label="Next turn"
        size="3xs"
        tone="ink"
        className={stepClass}
        disabled={!hasNext}
        onClick={() => step(1)}
      >
        <TurnStepGlyph direction="down" />
      </IconButton>
    </nav>
  )
}
