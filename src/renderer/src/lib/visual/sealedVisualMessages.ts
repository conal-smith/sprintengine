// What a sealed visual (`scriptedVisualDocument.ts`) may say to the app, and
// what the app does with it. The frame runs an agent's script, so every
// message is read as untrusted: one from anywhere but the frame's own window,
// or of any shape but the two below, is dropped without a word.

import { SEALED_VISUAL_CHANNEL } from '../../../../shared/sealed-visual'

export type SealedVisualMessage = { type: 'height'; height: number } | { type: 'open-link'; href: string }

/** Past this length a link is not one anybody clicked. */
const MAX_LINK_LENGTH = 2048

/** The message, when `data` is one of the two a sealed visual may send; null otherwise. */
export function readSealedVisualMessage(data: unknown): SealedVisualMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const message = data as Record<string, unknown>
  if (message.channel !== SEALED_VISUAL_CHANNEL) return null
  if (message.type === 'height') {
    const height = message.height
    return typeof height === 'number' && Number.isFinite(height) ? { type: 'height', height } : null
  }
  if (message.type === 'open-link') {
    const href = message.href
    return typeof href === 'string' && href.length > 0 && href.length <= MAX_LINK_LENGTH
      ? { type: 'open-link', href }
      : null
  }
  return null
}

/** The height a frame takes for a reported one: none for nothing, and never past `max`. */
export function clampVisualHeight(reported: number, max: number): number | null {
  if (!Number.isFinite(reported) || reported <= 0) return null
  return Math.min(Math.ceil(reported), max)
}

/** A web address a visual may hand out, normalised; null for any other scheme, or for no address at all. */
export function externalVisualLink(href: string): string | null {
  try {
    const url = new URL(href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    // Credentials in a link are a way to make one address read as another.
    if (url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

/**
 * One link per click: after a link opens, the frame's next request waits this
 * long, so a script cannot turn one click into a burst of tabs inside the
 * window a click's activation lasts.
 */
export const LINK_OPEN_COOLDOWN_MS = 1000

export type LinkGate = {
  /** The frame element the request came from. */
  frame: HTMLIFrameElement
  /** The app's document, where a click inside the frame leaves it focused. */
  document: Pick<Document, 'activeElement'>
  /** The app window's activation, which a click inside a child frame grants its ancestors. */
  userActivation: { isActive: boolean } | undefined
  now: number
  lastOpenedAt: number | null
}

/**
 * The address to open for a frame's link request, or null to ignore it. Only
 * just after the person clicked inside this frame (the window holds a fresh
 * activation and the frame has the focus a click gives it), only a web
 * address, and not again within the cooldown. A browser that cannot say
 * whether there was a click opens nothing.
 */
export function linkToOpen(href: string, gate: LinkGate): string | null {
  if (gate.userActivation?.isActive !== true) return null
  if (gate.document.activeElement !== gate.frame) return null
  if (gate.lastOpenedAt !== null && gate.now - gate.lastOpenedAt < LINK_OPEN_COOLDOWN_MS) return null
  return externalVisualLink(href)
}
