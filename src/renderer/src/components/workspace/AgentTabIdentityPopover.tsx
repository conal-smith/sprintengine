import React, { useCallback, useEffect, useRef, useState } from 'react'
import { PointerPopover } from '../ui'
import type { ConversationPeekIdentity } from './ConversationPeekCard'
import { useConversationPeek } from './useConversationPeek'
import { refreshPullRequestsForLine } from './PullRequestMark'

// The peek card itself behind a `React.lazy` boundary at this call site. It is only ever rendered inside an
// OPEN popover, so the
// hover that opens one fetches it; nothing on first paint reads it. The named
// export stays where it was, so anything importing the card directly is
// untouched. `fallback={null}` because the glass surface is already on screen
// with its own size, and a loader inside it would flash for one frame.
const ConversationPeekCard = React.lazy(() =>
  import('./ConversationPeekCard').then((m) => ({ default: m.ConversationPeekCard })),
)

import { useRelativeNow } from '../../hooks/useRelativeNow'

// Identity shown for an agent terminal tab. Assembled by the caller from the
// agent record + runtime state so this component stays presentational.
//
// The card the tab opens IS the conversation peek (2026-09-07), without its
// place lines (2026-10-04): project, machine and branch are what the window
// around the tab already says. Role, Runtime and Checkout are gone — "No role" was the
// answer for almost every agent, the runtime repeated the mark already on the
// tab, and the checkout repeated the branch already on the topbar — and the
// label column went with them. See ConversationPeekCard for the rest of the
// ruling.
export type AgentTabIdentity = ConversationPeekIdentity

// Hover opens after a beat so a quick sweep across the tab strip never flickers
// cards open; focus opens immediately so keyboard users don't wait. The close
// grace period lets the pointer travel from the tab into the card without it
// vanishing — that's what makes its controls reachable, unlike a tooltip.
// Both numbers come from `useConversationPeek`
// so the tab and the sidebar row open on the same beat.
const ANCHOR_GAP = 6

/**
 * Hover/focus info card for an agent terminal tab — the interactive,
 * stay-open-when-entered analog of `Tooltip` (which is `pointer-events-none`).
 * It wraps the tab's content composition, resolves the enclosing FlexLayout tab
 * button as the hover/focus anchor so the *whole* tab is the trigger, and
 * renders the card through the shared `PointerPopover` shell (portal, clamp,
 * elevation, Escape + outside-dismiss). Only the anchoring lives here.
 *
 * ONE hover surface per tab, always. An agent tab that opened two of them put
 * one over the other, and "what is this tab" and "what was it asked" are one
 * answer — which is why the tab does not also wrap `TabPromptPeek`. A plain
 * terminal tab, which has no identity, keeps that peek as its only reveal.
 */
export function AgentTabIdentityPopover({
  identity,
  children,
  lookupBranch = null,
  lookupPullRequests = true,
}: {
  identity: AgentTabIdentity
  children: React.ReactNode
  /**
   * The branch this agent's session was last observed on, for the pull request
   * lookup below. Not shown anywhere and NOT part of the card — the tab's card
   * deliberately carries no branch and no checkout — it is only what the ask is
   * coalesced by, so a session that moves to another branch is asked about
   * again rather than being answered from the last branch's reading.
   */
  lookupBranch?: string | null
  /**
   * Whether opening the card asks main about this session's pull requests.
   * Off for a chat on a paired machine: main holds no session for it, and the
   * machine's own list already names them.
   */
  lookupPullRequests?: boolean
}) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const tabButtonRef = useRef<HTMLElement | null>(null)

  const [point, setPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  // A tab's card is ITS OWN AGENT's, always: you hovered this tab, so this is
  // the conversation you asked about. The chat's other terminals have tabs of
  // their own, and sub-lines on the sidebar row — a selector inside this card
  // would be a third way to reach them.
  const sessionId = identity.agent.sessionId || null
  const hover = useConversationPeek(sessionId)
  // The ages on the card have to keep moving while it is open — a `Date.now()`
  // read inline froze them at the moment the card mounted, so a card left up
  // still said "2m" ten minutes later. Gated on `open`, so a tab that is not
  // being hovered pays no ticking re-render (the sidebar's own clock is always
  // on because its rows always show a time).
  const now = useRelativeNow(30_000, hover.open)

  // The pull request lookup, from the peek's OTHER anchor (epic decision 8a).
  // The sidebar line asks on hover, but a tab whose line is scrolled out of the
  // sidebar — or whose sidebar is collapsed — is never hovered there, so its
  // marks only ever arrived on the next window focus. Opening the card is the
  // moment the answer is wanted, so it is the moment to ask.
  //
  // The SAME helper the sidebar line uses, deliberately: one coalescing window
  // (session + branch, ~60s) shared by both anchors, so hovering a row and then
  // its tab is one ask rather than two, and neither anchor can drift into a
  // rate of its own.
  useEffect(() => {
    if (!hover.open || !sessionId || !lookupPullRequests) return
    refreshPullRequestsForLine(sessionId, lookupBranch)
  }, [hover.open, sessionId, lookupBranch, lookupPullRequests])

  // Anchor the card to the tab button's bottom-left, computed at reveal so the
  // shell never flashes at 0,0 before positioning.
  const anchor = useCallback(() => {
    const rect = tabButtonRef.current?.getBoundingClientRect()
    if (rect) setPoint({ x: rect.left, y: rect.bottom + ANCHOR_GAP })
  }, [])

  const { openNow, openSoon, closeSoon, closeNow } = hover
  const revealNow = useCallback(() => {
    anchor()
    openNow()
  }, [anchor, openNow])
  const revealSoon = useCallback(() => {
    anchor()
    openSoon()
  }, [anchor, openSoon])

  // Resolve the enclosing tab button once and wire hover/focus to it, so the
  // whole tab is the trigger (not just the label span) and FlexLayout's own
  // keyboard focus opens the card too.
  useEffect(() => {
    const el = anchorRef.current
    if (!el) return
    const button = el.closest<HTMLElement>('.flexlayout__tab_button') ?? el
    tabButtonRef.current = button

    const onEnter = () => revealSoon()
    const onLeave = () => closeSoon()
    const onFocusIn = () => revealNow()
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null
      if (next && button.contains(next)) return
      closeSoon()
    }
    button.addEventListener('mouseenter', onEnter)
    button.addEventListener('mouseleave', onLeave)
    button.addEventListener('focusin', onFocusIn)
    button.addEventListener('focusout', onFocusOut)
    return () => {
      button.removeEventListener('mouseenter', onEnter)
      button.removeEventListener('mouseleave', onLeave)
      button.removeEventListener('focusin', onFocusIn)
      button.removeEventListener('focusout', onFocusOut)
    }
  }, [revealSoon, revealNow, closeSoon])

  return (
    <span ref={anchorRef} className="inline-flex min-w-0 items-center gap-1.5">
      {children}
      {hover.open ? (
        <PointerPopover
          x={point.x}
          y={point.y}
          ariaLabel={`${identity.name} — conversation`}
          popupRole="dialog"
          onClose={closeNow}
          material="glass"
          surfaceClassName="conversation-peek-surface w-[300px]"
        >
          {/* Keep the card open while the pointer rests on it, so its pull
              request mark and Compact button are reachable across the gap
              from the tab. */}
          <div onMouseEnter={hover.keepOpen} onMouseLeave={closeSoon}>
            <React.Suspense fallback={null}>
              <ConversationPeekCard identity={identity} now={now} />
            </React.Suspense>
          </div>
        </PointerPopover>
      ) : null}
    </span>
  )
}
