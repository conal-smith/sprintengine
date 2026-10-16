// How much of the title strip's workspace identity survives at the current
// window width — and where the rest of it goes.
//
// The strip used to answer "too narrow" by DELETING segments: the project chip
// vanished below 768px and the branch chip below 640px, both with a bare
// `hidden … md:flex`. A control that disappears is not a responsive control, it
// is a missing feature at that size — the operator's answer to "which branch is
// this workspace on?" was "make the window bigger". Every segment this ladder
// drops now reappears in the identity cluster's overflow menu, so nothing is
// ever unreachable; only its rendering changes.
//
// The ladder is the owner's order (2026-09-04), cheapest loss first:
//
//   0  everything inline
//   1  the chips keep their glyph and their ±lines, lose their WORDS
//   2  "Open" folds into the overflow menu
//   3  the chips fold into the overflow menu entirely
//
// The right-hand glyph cluster (Sessions, Remote, Notifications, search) never
// folds. It is app-level chrome that is the same at every width, and it is what
// the operator reaches for while the window is small.

import React, { useCallback, useLayoutEffect, useState } from 'react'

export type TitleBarFold = 0 | 1 | 2 | 3

// Measured against the strip's LEFT+CENTRE block, not the window: that block is
// `flex-1 min-w-0`, so its width is exactly the space left for the window-nav
// cluster and the identity cluster once the right-hand glyphs have taken theirs.
// A window-width media query would fold on a 1200px window with the sidebar
// expanded and not fold on a 900px one with it collapsed — the same available
// space, two different answers.
//
// The steps are the cluster's own content budget: ~110px of window nav (plus
// 78px of traffic-light gutter on macOS), then star + name + branch + Open. The
// steps were set when a project chip sat beside the branch too; without it the
// ladder folds a little sooner than it has to, never later. Each threshold is the width below which the NEXT segment down the
// ladder no longer fits beside a legible workspace name.
const FOLD_STEPS: readonly { minWidth: number; fold: TitleBarFold }[] = [
  { minWidth: 700, fold: 0 },
  { minWidth: 560, fold: 1 },
  { minWidth: 460, fold: 2 },
]

function foldForWidth(width: number): TitleBarFold {
  for (const step of FOLD_STEPS) {
    if (width >= step.minWidth) return step.fold
  }
  return 3
}

const TitleBarFoldContext = React.createContext<TitleBarFold>(0)

/** The current fold stage. 0 outside a measured strip (aux windows, tests). */
export function useTitleBarFold(): TitleBarFold {
  return React.useContext(TitleBarFoldContext)
}

export function TitleBarFoldProvider({ fold, children }: { fold: TitleBarFold; children: React.ReactNode }) {
  return <TitleBarFoldContext.Provider value={fold}>{children}</TitleBarFoldContext.Provider>
}

/**
 * Watch an element's inline size and report the fold stage it implies.
 * Returns `[fold, ref]`; attach the ref to the block whose width is the budget.
 */
export function useMeasuredTitleBarFold(): [TitleBarFold, (element: HTMLElement | null) => void] {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [fold, setFold] = useState<TitleBarFold>(0)

  const measure = useCallback((width: number) => {
    // Width 0 is a detached or not-yet-laid-out element, not a 0px strip;
    // folding everything away on it would flash the collapsed ladder on mount.
    if (width <= 0) return
    setFold((previous) => {
      const next = foldForWidth(width)
      return previous === next ? previous : next
    })
  }, [])

  // Layout effect: the ladder is part of the first paint. Measuring in a passive
  // effect renders the full cluster once and then collapses it, which reads as
  // the strip flinching every time a workspace is opened.
  useLayoutEffect(() => {
    if (!element) return
    measure(element.getBoundingClientRect().width)
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) measure(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, measure])

  return [fold, setElement]
}
