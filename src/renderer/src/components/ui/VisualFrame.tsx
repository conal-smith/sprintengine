import { useCallback, useEffect, useRef, useState } from 'react'

// A document drawn in a frame of its own and read as part of what surrounds
// it: a reply's ```visual block (`lib/visual/visualDocument.ts`). No border or
// background, and as tall as its content, up to a cap past which it scrolls
// inside itself.
//
// Measuring the document means reading it, so the frame shares this
// document's origin: the sandbox is `allow-same-origin` and nothing else, as
// a measured design preview's is (`PreviewFrame`). Without `allow-scripts`
// nothing in the document can run, so the shared origin has no one to use
// it; and without `allow-top-navigation` or `allow-popups` a link in it,
// should one survive the sanitizer, cannot take the app anywhere.

/** Past this the frame stops growing and its document scrolls. */
export const VISUAL_FRAME_MAX_HEIGHT = 900

/** What the frame holds before its document has loaded and been measured. */
const RESERVED_HEIGHT = 160

function frameBody(frame: HTMLIFrameElement | null): HTMLElement | null {
  // A frame we cannot read keeps the height it has.
  try {
    return frame?.contentDocument?.body ?? null
  } catch {
    return null
  }
}

export function VisualFrame({
  srcDoc,
  title,
  maxHeight = VISUAL_FRAME_MAX_HEIGHT,
}: {
  /** A complete, sanitized document carrying its own inert policy. */
  srcDoc: string
  /** Accessible name — a frame without one is an unlabelled landmark. */
  title: string
  maxHeight?: number
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  // A new document (the same visual after an appearance change) keeps the
  // last height until it is measured, so the reply does not jump meanwhile.
  const [measured, setMeasured] = useState<number | null>(null)

  const measure = useCallback(() => {
    const body = frameBody(frameRef.current)
    if (!body) return
    // The body's box, not the root's scroll height, which never reports less
    // than the frame it is laid out in and so could only ever grow.
    const next = Math.ceil(body.getBoundingClientRect().height)
    if (!Number.isFinite(next) || next <= 0) return
    // 1px slack, so sub-pixel layout does not re-render on every callback.
    setMeasured((current) => (current !== null && Math.abs(current - next) <= 1 ? current : next))
  }, [])

  // Loading a srcdoc replaces the frame's document, so the body is watched
  // afresh on every load: its height changes as the column's width does.
  const handleLoad = useCallback(() => {
    observerRef.current?.disconnect()
    observerRef.current = null
    measure()
    const body = frameBody(frameRef.current)
    if (!body || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(body)
    observerRef.current = observer
  }, [measure])

  useEffect(() => () => observerRef.current?.disconnect(), [])

  return (
    <iframe
      ref={frameRef}
      sandbox="allow-same-origin"
      srcDoc={srcDoc}
      title={title}
      loading="lazy"
      onLoad={handleLoad}
      className="block w-full min-w-0 border-0 bg-transparent"
      style={{ height: Math.min(measured ?? RESERVED_HEIGHT, maxHeight) }}
      data-visual-frame=""
    />
  )
}
