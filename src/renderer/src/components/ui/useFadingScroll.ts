import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DependencyList,
} from 'react'

// How far the fade at an overflowing edge reaches. One value, both edges.
export const SCROLL_FADE_PX = 28
const SCROLL_FADE = `${SCROLL_FADE_PX}px`

/**
 * What a row that scrolls sideways with no scrollbar needs: which edges have
 * content past them, a mask that fades those edges, and a plain vertical wheel
 * that scrolls it. `content` is what can change its scroll width.
 */
export function useFadingScroll<E extends HTMLElement>(
  content: DependencyList,
): {
  ref: React.RefObject<E | null>
  edges: { start: boolean; end: boolean }
  onScroll: () => void
  style: CSSProperties | undefined
} {
  const ref = useRef<E>(null)
  const [edges, setEdges] = useState({ start: false, end: false })

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    // 1px slack: fractional layout widths leave a sub-pixel of "overflow" on a
    // strip that fits, which would paint a fade over nothing.
    const max = el.scrollWidth - el.clientWidth
    const next = { start: el.scrollLeft > 1, end: el.scrollLeft < max - 1 }
    setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
  }, [])

  // Layout effect: the fade is part of the first paint, not a correction to it.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    measure()
    if (typeof ResizeObserver !== 'function') return
    // The container AND its content: a tab opening or closing changes the
    // scroll width without changing the box the observer was watching.
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    for (const child of Array.from(el.children)) observer.observe(child)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, ...content])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return
      // A trackpad's horizontal component is already the browser's to handle.
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY) || event.deltaY === 0) return
      event.preventDefault()
      el.scrollLeft += event.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Masked, not overlaid: a gradient block painted on top would have to know
  // the band's background colour, and these rows sit on several. The stops are
  // a mask's ALPHA channel — "opaque here, transparent there" — so they are the
  // one thing in this file that cannot come from a colour token: any ink would
  // do, and naming one would imply the fade has a hue.
  // design-tokens-allow: mask alpha channel, not ink — a colour token cannot express "opaque"
  const OPAQUE = '#000'
  const mask =
    edges.start || edges.end
      ? `linear-gradient(to right, transparent 0, ${OPAQUE} ${edges.start ? SCROLL_FADE : '0px'}, ${OPAQUE} calc(100% - ${edges.end ? SCROLL_FADE : '0px'}), transparent 100%)`
      : undefined

  return {
    ref,
    edges,
    onScroll: measure,
    // design-tokens-allow: the two stops are a mask's alpha channel (opaque /
    // transparent), not ink — no palette token can express them.
    style: mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined,
  }
}
