import { useSyncExternalStore } from 'react'

import type { ChatBinding } from './chatBinding'
import type { ConversationTransport } from './conversationTransport'

// The chats on paired machines this window has open, by the workspace here
// that holds each one's pane: what a surface beside the chat (the Agents tab)
// needs to read it as the pane does. A local chat is found by its agent record
// in the workspace store; a remote chat has no record here, only its pane, so
// the pane says it is here. The surface reads through the pane's own
// transport, so it joins the subscription the chat already holds rather than
// following the conversation over the tailnet a second time.

export type RemoteChatEntry = {
  /** The chat's agent id on its machine, which its session is keyed by here. */
  agentId: string
  transport: ConversationTransport
  binding: ChatBinding
}

/** Per workspace, its open remote chats by agent id, most recently published last. */
let registry: ReadonlyMap<string, ReadonlyMap<string, RemoteChatEntry>> = new Map()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function withWorkspace(workspaceId: string, change: (chats: Map<string, RemoteChatEntry>) => void): void {
  const next = new Map(registry)
  const chats = new Map(next.get(workspaceId))
  change(chats)
  if (chats.size === 0) next.delete(workspaceId)
  else next.set(workspaceId, chats)
  registry = next
  emit()
}

/** The pane says its chat is open in `workspaceId`; the returned call takes it back. */
export function publishRemoteChat(workspaceId: string, entry: RemoteChatEntry): () => void {
  withWorkspace(workspaceId, (chats) => {
    chats.delete(entry.agentId)
    chats.set(entry.agentId, entry)
  })
  return () => {
    if (registry.get(workspaceId)?.get(entry.agentId) !== entry) return
    withWorkspace(workspaceId, (chats) => chats.delete(entry.agentId))
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The remote chat open in `workspaceId` that is `agentId`, or, with no agent
 * asked for, the one published last; null when none is open there.
 */
export function readRemoteChat(workspaceId: string, agentId: string | null): RemoteChatEntry | null {
  const chats = registry.get(workspaceId)
  if (!chats) return null
  if (agentId) return chats.get(agentId) ?? null
  let last: RemoteChatEntry | null = null
  for (const entry of chats.values()) last = entry
  return last
}

export function useRemoteChat(workspaceId: string, agentId: string | null): RemoteChatEntry | null {
  const read = () => readRemoteChat(workspaceId, agentId)
  return useSyncExternalStore(subscribe, read, read)
}

/** For tests: forget every published chat. */
export function resetRemoteChats(): void {
  registry = new Map()
  emit()
}
