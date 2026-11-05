import React from 'react'

import { IconButton } from './Buttons'
import { ChevronDownIcon } from '../AppIcons'
import { useFadingScroll } from './useFadingScroll'

// A heading over a row of tiles that scrolls sideways
// (design-system/components/card-scroller): more choices than a column holds,
// at their full size, rather than shrunk to fit or stacked until the page
// scrolls. The scrollbar stays out of it, as a tab strip's does: the edges fade
// and the two buttons say there is more, and move a page's worth of tiles.

export function CardScroller({
  title,
  glyph,
  children,
  className,
}: {
  /** What these are. Names the row for a screen reader too. */
  title: string
  glyph?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  const { ref, edges, onScroll, style } = useFadingScroll<HTMLDivElement>([children])
  const page = (direction: 1 | -1) => {
    const el = ref.current
    if (!el) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    el.scrollBy?.({ left: direction * el.clientWidth, behavior: reduced ? 'auto' : 'smooth' })
  }
  const overflowing = edges.start || edges.end
  return (
    <section aria-label={title} className={className}>
      <div className="flex h-control-sm items-center gap-2 px-1">
        {glyph ? <span className="flex shrink-0 text-[color:var(--text-subtle)]">{glyph}</span> : null}
        <h2 className="min-w-0 flex-1 truncate text-meta font-medium text-[color:var(--text-muted)]">{title}</h2>
        {overflowing ? (
          <>
            <IconButton tone="quiet" aria-label="Scroll back" disabled={!edges.start} onClick={() => page(-1)}>
              <ChevronDownIcon className="icon-xs rotate-90" />
            </IconButton>
            <IconButton tone="quiet" aria-label="Scroll on" disabled={!edges.end} onClick={() => page(1)}>
              <ChevronDownIcon className="icon-xs -rotate-90" />
            </IconButton>
          </>
        ) : null}
      </div>
      <div
        ref={ref}
        onScroll={onScroll}
        style={style}
        className="strip-scroll mt-1 grid snap-x auto-cols-[85%] grid-flow-col gap-2 overflow-x-auto overflow-y-hidden p-px @[520px]:auto-cols-[calc((100%-1rem-var(--sem-space-3xl))/3)]"
      >
        {React.Children.map(children, (card) => (
          <div className="flex min-w-0 snap-start">{card}</div>
        ))}
      </div>
    </section>
  )
}
