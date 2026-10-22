import { useCallback, useSyncExternalStore } from 'react'
import type { ConversationThread } from '../../../shared/conversation-index'
import { useWorkspaceStore } from '../store/workspaceStore'
import { revealAgentTerminalTab } from './agentTabReveal'
import { conversationAgentRuntimePatch } from '../components/workspace/conversationSpawnOptions'

const jumps = new Map<string, number>()
const listeners = new Set<() => void>()
function notify() {
  for (const listener of listeners) listener()
}
export function openConversationHistory(workspaceId: string, thread: ConversationThread, seq?: number): boolean {
  const store = useWorkspaceStore.getState()
  if (!store.workspaces.some((workspace) => workspace.id === workspaceId)) return false
  store.updateAgent(workspaceId, thread.agentId, {
    ...conversationAgentRuntimePatch(thread.providerId, thread.model),
    name: thread.title,
  })
  if (seq !== undefined) {
    jumps.set(`${workspaceId}:${thread.agentId}`, seq)
    notify()
  }
  return revealAgentTerminalTab({ workspaceId, agentId: thread.agentId, name: thread.title })
}
/**
 * Open a chat at a message the palette found in it. An agent the chat still
 * has is revealed as it is — its name is the person's, and a search result is
 * no reason to rename it. One the chat no longer holds (its tab closed long
 * ago) is restored from its saved thread first, the way reopening history does.
 */
export async function openConversationMatch(input: {
  workspaceRoot: string
  workspaceId: string
  agentId: string
  seq: number
}): Promise<boolean> {
  const workspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === input.workspaceId)
  if (!workspace) return false
  const agent = workspace.agents?.[input.agentId]
  if (agent) {
    jumps.set(`${input.workspaceId}:${input.agentId}`, input.seq)
    notify()
    return revealAgentTerminalTab({ workspaceId: input.workspaceId, agentId: input.agentId, name: agent.name })
  }
  const result = await window.api
    .conversationThreads({ workspaceRoot: input.workspaceRoot, workspaceId: input.workspaceId })
    .catch(() => null)
  const thread = result?.ok ? result.threads.find((candidate) => candidate.agentId === input.agentId) : undefined
  if (thread) return openConversationHistory(input.workspaceId, thread, input.seq)
  // The thread is gone from under the result: the chat itself is still the
  // answer to what was searched for.
  useWorkspaceStore.getState().setActiveWorkspace(input.workspaceId)
  return false
}
export function clearConversationJump(workspaceId: string, agentId: string): void {
  jumps.delete(`${workspaceId}:${agentId}`)
  notify()
}
export function usePendingConversationJump(workspaceId: string, agentId: string): number | null {
  const snapshot = useCallback(() => jumps.get(`${workspaceId}:${agentId}`) ?? null, [workspaceId, agentId])
  return useSyncExternalStore(
    useCallback((listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }, []),
    snapshot,
    snapshot,
  )
}
export function layoutHasConversation(value: unknown, agentId: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => layoutHasConversation(entry, agentId))
  if (!value || typeof value !== 'object') return false
  const node = value as Record<string, unknown>,
    config = node.config as Record<string, unknown> | undefined
  if (node.component === 'agent' && config?.agentId === agentId) return true
  return Object.values(node).some(
    (entry) => entry && typeof entry === 'object' && layoutHasConversation(entry, agentId),
  )
}
