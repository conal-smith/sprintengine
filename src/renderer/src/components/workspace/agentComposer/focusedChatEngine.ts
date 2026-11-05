import { cliForConversationProvider, CONVERSATION_DEFAULT_MODEL_ID } from '../../../../../shared/conversation-harness'
import type { AgentState } from '../../../../../shared/agent-state'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { AgentCli } from '../../../types/workspace'

/**
 * The engine a chat runs on, for a tab opened beside it: the "+" on a Codex
 * chat's strip should stand on Codex, not on whatever was last picked anywhere
 * in the app. Null for an agent with no CLI of its own to stand on.
 */
export function chatEngine(
  agent: Pick<AgentState, 'cli' | 'conversation' | 'conversationReasoningEffort'> | undefined,
): { cli: AgentCli; model: string | null; reasoning: string | null } | null {
  const cli = cliForConversationProvider(agent?.conversation?.providerId) ?? agent?.cli
  if (!cli) return null
  const modelId = agent?.conversation?.modelId
  return {
    cli,
    model: modelId && modelId !== CONVERSATION_DEFAULT_MODEL_ID ? modelId : null,
    reasoning: agent?.conversationReasoningEffort ?? null,
  }
}

/** The engine of the chat in focus in a workspace, read when a new tab mounts. */
export function focusedChatEngine(workspaceId: string | null): ReturnType<typeof chatEngine> {
  if (!workspaceId) return null
  const state = useWorkspaceStore.getState()
  const agentId = state.focusedAgentByWorkspaceId[workspaceId]
  if (!agentId) return null
  return chatEngine(state.workspaces.find((workspace) => workspace.id === workspaceId)?.agents?.[agentId])
}
