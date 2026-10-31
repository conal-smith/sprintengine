import { useCallback, useEffect, useRef, useState } from 'react'
import { readVisualTheme } from '../../lib/visual/visualDocument'
import { clampVisualHeight, linkToOpen, readSealedVisualMessage } from '../../lib/visual/sealedVisualMessages'
import { SEALED_VISUAL_CHANNEL } from '../../../../shared/sealed-visual'
import { VISUAL_FRAME_MAX_HEIGHT } from './VisualFrame'

// A ```visual block that runs its own script, drawn as part of the reply the
// way a static one is (`VisualFrame`): no border or background, as tall as its
// content up to a cap. What differs is the seal (`shared/sealed-visual-document.ts`):
// scripts on and no origin of its own, so the app can neither read the frame
// nor be read by it, and the two speak only by message.
//
// A frame with scripts is a live page, so one exists only while it is near the
// view: none is made for a block far down a transcript until it is scrolled
// close, and one scrolled far away is taken down, leaving a box of its last
// height so the reply does not move. A long transcript of visuals therefore
// holds a few running pages at a time, not one per visual. A frame scrolled
// back starts over: what it held in its script is not kept.

/** The only sandbox token a sealed visual gets. Never `allow-same-origin`, popups, top navigation, forms or modals. */
export const SEALED_VISUAL_SANDBOX = 'allow-scripts'

/** What the box holds before its frame has reported a height. */
const RESERVED_HEIGHT = 160

/** How far outside the scroller's view a frame is made, and kept. */
const NEAR_MARGIN = '600px 0px'

function scrollingAncestor(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') return node
  }
  return null
}

function defaultOpenLink(url: string): void {
  void window.api?.openExternal(url)
}

export function SealedVisualFrame({
  url,
  title,
  appearance,
  maxHeight = VISUAL_FRAME_MAX_HEIGHT,
  onOpenLink = defaultOpenLink,
}: {
  /** The sealed document's address (`buildScriptedVisualDocument`). */
  url: string
  /** Accessible name. */
  title: string
  /** The window's appearance; a change is posted to the running frame as its theme. */
  appearance: string
  maxHeight?: number
  /** Opens a web address outside the app. */
  onOpenLink?: (url: string) => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const lastOpenedAt = useRef<number | null>(null)
  // Without an observer to say otherwise, the frame is made at once.
  const [near, setNear] = useState(() => typeof IntersectionObserver !== 'function')
  const [height, setHeight] = useState<number | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host || typeof IntersectionObserver !== 'function') return
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        if (entry) setNear(entry.isIntersecting)
      },
      { root: scrollingAncestor(host), rootMargin: NEAR_MARGIN },
    )
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  const postTheme = useCallback(() => {
    const target = frameRef.current?.contentWindow
    if (!target) return
    // The frame has no origin to name, so `*`; what is sent is the window's
    // public colours and nothing else.
    target.postMessage({ channel: SEALED_VISUAL_CHANNEL, type: 'theme', ...readVisualTheme() }, '*')
  }, [])

  // The document was built in the theme of its first draw; a switch after
  // that is told to the frame rather than rebuilding it.
  useEffect(() => {
    if (near) postTheme()
  }, [appearance, near, postTheme])

  useEffect(() => {
    if (!near) return
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      if (!frame || event.source === null || event.source !== frame.contentWindow) return
      const message = readSealedVisualMessage(event.data)
      if (!message) return
      if (message.type === 'height') {
        const next = clampVisualHeight(message.height, maxHeight)
        if (next !== null) setHeight((current) => (current !== null && Math.abs(current - next) <= 1 ? current : next))
        return
      }
      const now = Date.now()
      const link = linkToOpen(message.href, {
        frame,
        document,
        userActivation: navigator.userActivation,
        now,
        lastOpenedAt: lastOpenedAt.current,
      })
      if (!link) return
      lastOpenedAt.current = now
      onOpenLink(link)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [near, maxHeight, onOpenLink])

  const boxHeight = Math.min(height ?? RESERVED_HEIGHT, maxHeight)
  return (
    <div ref={hostRef} className="block w-full min-w-0" style={{ height: boxHeight }} data-sealed-visual="">
      {near ? (
        <iframe
          // A new document is a new frame: main refuses any navigation of a
          // sealed one, the app's own included.
          key={url}
          ref={frameRef}
          sandbox={SEALED_VISUAL_SANDBOX}
          src={url}
          title={title}
          referrerPolicy="no-referrer"
          onLoad={postTheme}
          className="block h-full w-full min-w-0 border-0 bg-transparent"
          data-visual-frame=""
        />
      ) : null}
    </div>
  )
}
