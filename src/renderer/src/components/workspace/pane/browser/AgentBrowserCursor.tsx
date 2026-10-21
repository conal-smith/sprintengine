import React, { useEffect, useState } from 'react'

import type { BrowserController } from '../../../../../../shared/browser'
import { AGENT_CURSOR_LINGER_MS, cursorPlacement, cursorVisible, type AgentCursorEvent } from './agentCursor'

// Where the agent's hand is (browser-pane follow-up 2): an arrow drawn over the
// guest at the point the control layer is about to click, scroll or move to.
// Main sends the point BEFORE dispatching the input, so the arrow is there when
// the click lands. It eases to each new point, pulses on a click, fades after
// the last event, and is never shown while the person holds the page — a
// takeover hides the agent's hand at once. Pointer-transparent: it can never
// intercept the person's own clicks.

type AgentBrowserCursorProps = {
  tabId: string
  /** The device frame's fit scale (1 when the guest fills the tab). */
  scale: number
  controller: BrowserController
}

export function AgentBrowserCursor({ tabId, scale, controller }: AgentBrowserCursorProps) {
  const [event, setEvent] = useState<AgentCursorEvent | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(
    () =>
      window.api.onBrowserPointer((incoming) => {
        if (incoming.tabId !== tabId) return
        const at = Date.now()
        setEvent({ ...incoming, at })
        setNow(at)
      }),
    [tabId],
  )

  // One timer per event to re-evaluate visibility once the linger has passed.
  useEffect(() => {
    if (!event) return
    const timer = window.setTimeout(() => setNow(Date.now()), AGENT_CURSOR_LINGER_MS + 20)
    return () => window.clearTimeout(timer)
  }, [event])

  if (!event || !cursorVisible(event, now, controller)) return null
  const { left, top } = cursorPlacement(event, scale)
  return (
    <div
      aria-hidden="true"
      data-agent-cursor={event.kind}
      className="pointer-events-none absolute left-0 top-0 transition-transform duration-[120ms] ease-out"
      style={{ transform: `translate(${left}px, ${top}px)` }}
    >
      {event.kind === 'click' ? (
        // A one-shot ring per click: the key remounts it so the animation restarts.
        // Under Reduce Motion the ring holds still under the point, which
        // still says where the click landed without pulsing.
        <span
          key={event.at}
          className="absolute -left-3 -top-3 block size-icon-lg animate-ping rounded-full bg-[color:var(--accent-primary-soft)] motion-reduce:animate-none"
        />
      ) : null}
      <svg viewBox="0 0 16 16" className="icon-md drop-shadow-sm" aria-hidden="true">
        <path
          d="M2 1.5 L2 12.5 L5 9.8 L7.2 14.5 L9.4 13.5 L7.2 8.9 L11 8.9 Z"
          fill="var(--accent-primary)"
          stroke="var(--text-on-accent)"
          strokeWidth="1"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}
