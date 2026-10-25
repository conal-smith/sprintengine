// What a fork of a chat is called, and the agent record it joins its workspace
// with. A window's Fork from here writes the record through its store; a fork a
// paired machine asks for over the tailnet is written by main, through the
// workspace bus, on the machine the chat runs on. Both name and seed the fork
// the same way, from here.

import { conversationAgentRuntimePatch, type AgentState } from '../agent-state'

/**
 * What a fork is called: the chat's name with "(fork)", numbered past the
 * forks of it already open. A fork of a fork counts among the forks of the
 * chat it started from, so a second generation reads "Atlas (fork 2)", never
 * "Atlas (fork) (fork)".
 */
export function forkName(parentName: string, taken: readonly string[]): string {
  const base = parentName.replace(/ \(fork(?: \d+)?\)$/u, '')
  const names = new Set(taken)
  if (!names.has(`${base} (fork)`)) return `${base} (fork)`
  let index = 2
  while (names.has(`${base} (fork ${index})`)) index += 1
  return `${base} (fork ${index})`
}

/** The fork's agent record: the parent's engine and folder under the fork's own name. */
export function forkedAgentPatch(parent: AgentState, name: string): Partial<AgentState> {
  const conversation = parent.conversation!
  return {
    name,
    ...conversationAgentRuntimePatch(conversation.providerId, conversation.modelId),
    // A chat started in a worktree is keyed by it; the fork's transcript was
    // written there.
    execution: { ...parent.execution },
    ...(parent.cliPermissionPreset ? { cliPermissionPreset: parent.cliPermissionPreset } : {}),
    ...(parent.cliPermissionMode ? { cliPermissionMode: parent.cliPermissionMode } : {}),
    ...(parent.conversationMode ? { conversationMode: parent.conversationMode } : {}),
    ...(parent.conversationReasoningEffort ? { conversationReasoningEffort: parent.conversationReasoningEffort } : {}),
    ...(parent.conversationSkills?.length ? { conversationSkills: [...parent.conversationSkills] } : {}),
  }
}
