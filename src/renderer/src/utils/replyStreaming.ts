import { useSyncExternalStore } from 'react'

import { DEFAULT_REPLY_STREAMING, type ReplyStreaming } from '../types/appTheme'

// How a reply streaming in is drawn (Settings → Appearance → Show replies),
// held here so every message reads one value without each subscribing to the
// store: a transcript draws hundreds of them, and only the one streaming now
// cares. `useAppTheme` keeps it in step with the stored appearance.

let current: ReplyStreaming = DEFAULT_REPLY_STREAMING
const listeners = new Set<() => void>()

function replyStreaming(): ReplyStreaming {
  return current
}

export function setReplyStreaming(mode: ReplyStreaming): void {
  if (mode === current) return
  current = mode
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The Show replies setting, re-rendering the caller when it changes. */
export function useReplyStreaming(): ReplyStreaming {
  return useSyncExternalStore(subscribe, replyStreaming, replyStreaming)
}
