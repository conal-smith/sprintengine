import { useSyncExternalStore } from 'react'

import type {
  ConversationWireChanges,
  ConversationWireFileCounts,
  ConversationWireLocalServer,
} from '../../../../../../packages/conversation-protocol/src/public'
import type { StudioLocalServer } from '../../../../../../packages/studio-protocol/src/public'
import { cliForConversationProvider } from '../../../../../shared/conversation-harness'
import { phaseWithBackgroundWork } from '../../../../../shared/conversation/phase'
import { meshConversationSessionId, type MeshConversation } from '../../../../../shared/tailnet-mesh'
import type { BranchPullRequest } from '../../../../../shared/git/pull-request'
import { branchPullRequestsOfWire } from './remoteSessionsModel'

// What a paired machine last listed about each of its chats, for the surfaces
// here that draw one without reading the machine themselves: the tab a remote
// chat's pane sits in, and the strip under its composer (its branch, the files
// it changed and its pull requests), which the pane's own read would leave as
// they were when it opened. A local chat's tab reads its CLI mark, model, phase and
// last finish off the session main holds; a remote chat's pane holds no
// session here, so its tab drew the bare chat glyph and no time at all, and a
// chat on another machine read differently from the same chat on this one
// (owner, 2026-10-17: "I shouldn't be able to notice any difference other than
// the fact that I have the icon of the remote machine").
//
// Fed by every read of a machine's list — the sidebar's, and the pane's own —
// so the tab learns as soon as either one has asked. Only what a tab draws is
// kept, and the snapshot changes only when one of those facts did, so a
// re-read that moved nothing draws no tab again.

export type RemoteConversationFacts = {
  cli: string | null
  modelId: string | null
  phase: MeshConversation['phase']
  /** The machine holds a live session for the chat, as a local chat's tab is bold while its session is up. */
  live: boolean
  /** When the agent last finished a turn, as its machine records it; null before one has. */
  lastTurnEndedAt: number | null
  pullRequests: BranchPullRequest[]
  /** The branch the chat's folder is on over there; null from a machine that does not say, or off a branch. */
  branch: string | null
  /** The chat works in a worktree of its project over there. */
  worktree: boolean
  /** The files its checkout carries over there; null from a machine that does not say, or a chat at rest. */
  changes: ConversationWireChanges | null
  /** The local servers its agents linked over there, as that machine last checked them; empty for none. */
  localServers: StudioLocalServer[]
}

const NO_SERVERS: StudioLocalServer[] = []

/**
 * A paired machine's listed servers in the shape this computer's own record
 * hands the strip, under the chat's agent there. What a server needs to run
 * again (its command, its folder) is that machine's, and not listed.
 */
export function localServersOfWire(
  agentId: string,
  servers: readonly ConversationWireLocalServer[] | undefined,
): StudioLocalServer[] {
  if (!servers?.length) return NO_SERVERS
  return servers.map((server) => ({ ...server, agentId, linkedAt: 0, stateAt: 0 }))
}

function sameServers(a: readonly StudioLocalServer[], b: readonly StudioLocalServer[]): boolean {
  return (
    a.length === b.length &&
    a.every((server, index) => {
      const other = b[index]!
      return (
        server.id === other.id &&
        server.state === other.state &&
        server.url === other.url &&
        server.title === other.title
      )
    })
  )
}

type Snapshot = ReadonlyMap<string, RemoteConversationFacts>

let snapshot: Snapshot = new Map()
const listeners = new Set<() => void>()

/** The key a remote pane's facts are filed under: the pairing and the pane's session id over there. */
export function remoteConversationFactsKey(connectionId: string, sessionId: string): string {
  return `${connectionId}\u0000${sessionId}`
}

function factsOf(conversation: MeshConversation): RemoteConversationFacts {
  return {
    cli: cliForConversationProvider(conversation.providerId),
    modelId: conversation.modelId?.trim() || null,
    // Its background work counts, as it does for the chat's sidebar row: a
    // tab whose chat's agents go on after the turn reads as working.
    phase: phaseWithBackgroundWork(conversation.phase, Boolean(conversation.backgroundWork)),
    live: Boolean(conversation.sessionId),
    lastTurnEndedAt: conversation.lastTurnEndedAt ?? null,
    pullRequests: branchPullRequestsOfWire(conversation.pullRequests ?? []),
    branch: conversation.branch?.trim() || null,
    worktree: conversation.worktree === true,
    changes: conversation.changes ?? null,
    localServers: localServersOfWire(conversation.agentId, conversation.localServers),
  }
}

function sameCounts(a: ConversationWireFileCounts | undefined, b: ConversationWireFileCounts | undefined): boolean {
  if (!a || !b) return a === b
  return a.added === b.added && a.updated === b.updated && a.removed === b.removed
}

function sameChanges(a: ConversationWireChanges | null, b: ConversationWireChanges | null): boolean {
  if (!a || !b) return a === b
  return sameCounts(a, b) && a.scope === b.scope && sameCounts(a.uncommitted, b.uncommitted)
}

function sameFacts(a: RemoteConversationFacts, b: RemoteConversationFacts): boolean {
  if (
    a.cli !== b.cli ||
    a.modelId !== b.modelId ||
    a.phase !== b.phase ||
    a.live !== b.live ||
    a.lastTurnEndedAt !== b.lastTurnEndedAt ||
    a.branch !== b.branch ||
    a.worktree !== b.worktree ||
    !sameChanges(a.changes, b.changes) ||
    !sameServers(a.localServers, b.localServers)
  )
    return false
  if (a.pullRequests.length !== b.pullRequests.length) return false
  return a.pullRequests.every((pr, index) => {
    const other = b.pullRequests[index]!
    return pr.url === other.url && pr.state === other.state && pr.title === other.title
  })
}

/**
 * One machine's list, as it answered: its chats replace what the last list
 * said about that machine, and a chat it no longer lists (settled, removed)
 * is forgotten.
 */
export function publishRemoteConversationList(connectionId: string, conversations: readonly MeshConversation[]): void {
  const prefix = remoteConversationFactsKey(connectionId, '')
  const next = new Map<string, RemoteConversationFacts>()
  let changed = false
  for (const [key, facts] of snapshot) {
    if (!key.startsWith(prefix)) next.set(key, facts)
  }
  const listed = new Set<string>()
  for (const conversation of conversations) {
    const key = remoteConversationFactsKey(
      connectionId,
      meshConversationSessionId(conversation.workspaceId, conversation.agentId),
    )
    listed.add(key)
    const held = snapshot.get(key)
    const facts = factsOf(conversation)
    if (held && sameFacts(held, facts)) next.set(key, held)
    else {
      next.set(key, facts)
      changed = true
    }
  }
  for (const key of snapshot.keys()) {
    if (key.startsWith(prefix) && !listed.has(key)) changed = true
  }
  if (!changed) return
  snapshot = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Every remote chat's facts, read once; the hook below follows them. */
export function readRemoteConversationFacts(): Snapshot {
  return snapshot
}

/** Every remote chat's facts, as the newest lists said them. */
export function useRemoteConversationFacts(): Snapshot {
  return useSyncExternalStore(subscribe, readRemoteConversationFacts, readRemoteConversationFacts)
}

/** One remote chat's facts, as the newest list said them; null before any list has named it. */
export function useRemoteConversationFactsOf(connectionId: string, sessionId: string): RemoteConversationFacts | null {
  const key = remoteConversationFactsKey(connectionId, sessionId)
  return useSyncExternalStore(
    subscribe,
    () => snapshot.get(key) ?? null,
    () => snapshot.get(key) ?? null,
  )
}

/** For tests: forget every machine's list. */
export function resetRemoteConversationFacts(): void {
  snapshot = new Map()
  for (const listener of listeners) listener()
}
