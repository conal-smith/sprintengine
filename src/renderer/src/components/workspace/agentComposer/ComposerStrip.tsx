import React from 'react'

// The context strip tucked under the composer box and one piece with it:
// rounded at the bottom only, inset from the box's sides, its top hidden under
// the box's lower edge (owner ruling 2026-10-04). ONE container, because the
// New chat composer and an open conversation's composer wear the same strip —
// what it holds differs (a launch's choices; a running chat's facts), the
// object does not.
//
// Always exactly one line (owner ruling 2026-10-04): it never wraps. Its items
// sit apart by spacing alone — no divider — and each is `whitespace-nowrap`
// and keeps its width, except a project's name, the item allowed to shrink
// (truncating at its end), so the controls beside it stay in reach. What does
// not fit is the host's to move elsewhere (the conversation strip cuts the
// branch from its front, then folds items into a "⋮" menu); clipping along the line is only the
// last guard against a host that has not, and it clips sideways alone so a
// focus ring above or below an item is never cut.

export const ComposerStrip = React.forwardRef<
  HTMLDivElement,
  { children: React.ReactNode; className?: string } & Omit<React.HTMLAttributes<HTMLDivElement>, 'className'>
>(function ComposerStrip({ children, className = '', ...rest }, ref) {
  return (
    <div
      ref={ref}
      data-composer-strip="true"
      {...rest}
      className={`mx-6 -mt-4 flex min-w-0 flex-nowrap items-center gap-2 overflow-x-clip whitespace-nowrap rounded-b-[var(--sem-radius-composer-strip)] border border-t-0 border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-2 pb-1 pt-5 ${className}`}
    >
      {children}
    </div>
  )
})
