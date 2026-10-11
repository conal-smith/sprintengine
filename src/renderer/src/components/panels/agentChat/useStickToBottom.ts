import { useCallback, useRef, useState } from 'react'

export const FOLLOW_END_DISTANCE = 48
export function isNearConversationEnd(offset: number, content: number, viewport: number): boolean {
  return content - offset - viewport < FOLLOW_END_DISTANCE
}

/**
 * Settles a transcript once a disclosure in `row` has changed its height while
 * end-follow was paused for it, and says whether the reader still follows the
 * end. The row goes back to where it was clicked, so the control stays under
 * the pointer. Opening the last row at the end grows the transcript below the
 * fold with no scroll to say so; following on from there would yank the view
 * to the end on the next layout change, so a reader who was following and is
 * no longer at the end stops. Collapsing at the end, or a row that opens
 * within the end's slack, leaves them following.
 */
export function settleDisclosureResize(
  row: Pick<Element, 'getBoundingClientRect'>,
  clickedTop: number,
  scroller: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>,
  wasFollowing: boolean,
): boolean {
  const shift = row.getBoundingClientRect().top - clickedTop
  if (Math.abs(shift) > 0.5) scroller.scrollTop += shift
  return wasFollowing && isNearConversationEnd(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight)
}

/** Shared follow state for DOM scrollers; virtual lists can feed native metrics. */
export function useStickToBottom(initialAtEnd = true) {
  const [atBottom, setAtBottom] = useState(initialAtEnd)
  const atBottomRef = useRef(initialAtEnd)
  const observeScroll = useCallback((offset: number, content: number, viewport: number) => {
    const nearBottom = isNearConversationEnd(offset, content, viewport)
    atBottomRef.current = nearBottom
    setAtBottom(nearBottom)
  }, [])
  const onScroll = useCallback(
    (element: HTMLElement) => observeScroll(element.scrollTop, element.scrollHeight, element.clientHeight),
    [observeScroll],
  )
  const followEnd = useCallback((element: HTMLElement, animated = true) => {
    if (!atBottomRef.current) return
    element.scrollTo({
      top: element.scrollHeight,
      behavior: animated && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant',
    })
  }, [])
  return { atBottom, atBottomRef, setAtBottom, observeScroll, onScroll, followEnd }
}
