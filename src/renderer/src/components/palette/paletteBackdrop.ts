import { TERMINAL_SURFACE_ATTRIBUTE } from '../../utils/keyboard'

// Whether the palette's scrim may blur what is behind it (owner ruling
// 2026-10-21): over a conversation, yes — the transcript recedes and the
// results are what is read; over a terminal, no.
//
// The blur ban exists because a full-viewport blur over a streaming terminal
// is re-sampled on every PTY chunk; that was measured at ~10fps (2026-09-01),
// and every scrim lost its blur for it. The palette holds the terminal repaint
// pause while it is up, which would make a blur over paused panes cost one
// pass — but the pause fails open by design: a hold older than two minutes is
// dropped (`terminalRepaintPause.ts`), and the panes under a palette left open
// that long would stream under a full-window blur again. A conversation's
// transcript is a page that redraws a paragraph at a time, not thirty times a
// second, so the ruling is the blur for a conversation and the plain tone for
// anything with a terminal in view.

const TERMINAL = `[${TERMINAL_SURFACE_ATTRIBUTE}], .xterm`
const CONVERSATION = '[data-chat-pane]'

/** Drawn, as opposed to mounted: a background tab and a parked workspace stay in the document. */
function drawn(element: Element): boolean {
  const check = (element as Element & { checkVisibility?: (options?: object) => boolean }).checkVisibility
  if (typeof check === 'function') return check.call(element, { visibilityProperty: true, opacityProperty: true })
  return element.getClientRects().length > 0
}

/**
 * True when what the palette opens over is a conversation: a chat is drawn
 * and no terminal is. Read once, as the palette opens — nothing under a modal
 * changes while it is up.
 */
export function paletteBackdropIsConversation(root: ParentNode = document): boolean {
  if (Array.from(root.querySelectorAll(TERMINAL)).some(drawn)) return false
  return Array.from(root.querySelectorAll(CONVERSATION)).some(drawn)
}
