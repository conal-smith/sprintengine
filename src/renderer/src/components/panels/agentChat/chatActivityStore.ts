import { useSyncExternalStore } from 'react'

import type { ChatActivityKind } from './chatActivity'

// What each open chat says it touched, for the surfaces outside it that draw
// the same rows: the title bar's pill, which stands in for the chat's card
// when the chat is too narrow to dock it. The chat view publishes; nothing
// here reads a transcript.

/** One row as every surface draws it. */
export type ChatActivityRow = {
  kind: ChatActivityKind
  label: string
  /** The trailing fact: a host, a board, "1 working", a count. */
  meta: string | null
  /** Lines added and removed, for Changes. */
  diff?: { added: number; removed: number }
  /** An agent is in it right now. */
  live: boolean
  /** It changed since the person last opened it. */
  unseen: boolean
}

export type PublishedChatActivity = {
  rows: ChatActivityRow[]
  /** The chat docks its card itself, so no other surface draws the rows. */
  docked: boolean
  open: (kind: ChatActivityKind) => void
}

const published = new Map<string, PublishedChatActivity>()
const listeners = new Set<() => void>()
const emit = () => {
  for (const listener of listeners) listener()
}
const keyOf = (workspaceId: string, agentId: string) => `${workspaceId}\0${agentId}`

export function publishChatActivity(workspaceId: string, agentId: string, value: PublishedChatActivity | null): void {
  const key = keyOf(workspaceId, agentId)
  if (value === null) {
    if (!published.delete(key)) return
  } else published.set(key, value)
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useChatActivity(workspaceId: string | null, agentId: string | null): PublishedChatActivity | null {
  return useSyncExternalStore(subscribe, () =>
    workspaceId && agentId ? (published.get(keyOf(workspaceId, agentId)) ?? null) : null,
  )
}

// Which rows the person has opened since they last changed, by chat. Kept for
// the session only: "new since you looked" is about this sitting.
const seen = new Map<string, Map<ChatActivityKind, string>>()

/** Whether the row's `version` (what it says now) is one the person has opened. */
export function rowSeen(workspaceId: string, agentId: string, kind: ChatActivityKind, version: string): boolean {
  return seen.get(keyOf(workspaceId, agentId))?.get(kind) === version
}

export function markRowSeen(workspaceId: string, agentId: string, kind: ChatActivityKind, version: string): void {
  const key = keyOf(workspaceId, agentId)
  const chat = seen.get(key) ?? new Map<ChatActivityKind, string>()
  chat.set(kind, version)
  seen.set(key, chat)
}
