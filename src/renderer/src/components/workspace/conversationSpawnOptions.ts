import type { WorkspaceSkill } from '../../../../shared/electron-api'
import type { AgentConversationRuntime, AgentState, CliPermissionPreset } from '../../types/workspace'
import { conversationAgentRuntimePatch } from '../../../../shared/agent-state'

// The fields that make a fresh agent a conversation-runtime agent live beside
// the record they patch, so main writes a fork's record with the same ones.
export { conversationAgentRuntimePatch }

/**
 * What a launch hands a new chat agent besides its runtime: the skill chips, and
 * the typed prompt as the chat's first message. The prompt is SENT, not left in
 * the composer — Enter in the launcher starts the agent on what was typed, the
 * same as a terminal agent's startup prompt, so it must not need a second Enter.
 * The images staged beside it go with it as images, the way a later message's
 * do, rather than as paths typed into its text, and the files attached by path
 * go with it as its `files`, the way a later message's do.
 */
export function conversationLaunchDraftPatch(
  skills?: readonly Pick<WorkspaceSkill, 'id'>[],
  prompt?: string,
  images?: readonly string[],
  files?: readonly string[],
): Partial<AgentState> {
  return {
    ...(skills?.length ? { conversationSkills: skills.map((skill) => skill.id) } : {}),
    ...(prompt?.trim() ? { chatStartupPrompt: prompt.trim() } : {}),
    ...(images?.length ? { chatStartupImages: [...images] } : {}),
    ...(files?.length ? { chatStartupFiles: [...files] } : {}),
  }
}

/**
 * The engine settings a launch carries onto a chat agent: the permission preset
 * the picker's footer shows for its CLI, and the effort it stands on (absent is
 * the CLI's own default, as for a terminal launch).
 */
export function conversationLaunchEnginePatch(launch: {
  permissionPreset: CliPermissionPreset
  /** The CLI's own mode at that preset, when it is not the preset's own. */
  permissionMode?: string
  reasoning?: string | null
}): Partial<AgentState> {
  return {
    cliPermissionPreset: launch.permissionPreset,
    ...(launch.permissionMode ? { cliPermissionMode: launch.permissionMode } : {}),
    ...(launch.reasoning ? { conversationReasoningEffort: launch.reasoning } : {}),
  }
}

/**
 * The agent a New chat door's chat-agent confirm opens. It carries no name: the
 * solo workspace names its lone agent from the shared pool, exactly as it does
 * for a terminal agent, so the chat is called what a terminal would be called
 * and never after its model. Null when the confirm names no provider.
 */
export function conversationNewChatSeed(
  confirm: {
    provider?: { providerId: string; modelId: string; modelLabel: string }
    skills?: readonly Pick<WorkspaceSkill, 'id'>[]
    reasoning?: string | null
  },
  launch: {
    prompt?: string
    images?: readonly string[]
    files?: readonly string[]
    permissionPreset: CliPermissionPreset
    permissionMode?: string
  },
): { runtime: AgentConversationRuntime; agentPatch: Partial<AgentState> } | null {
  const target = confirm.provider
  if (!target) return null
  return {
    runtime: { providerId: target.providerId, modelId: target.modelId },
    agentPatch: {
      ...conversationAgentRuntimePatch(target.providerId, target.modelId),
      ...conversationLaunchEnginePatch({
        permissionPreset: launch.permissionPreset,
        ...(launch.permissionMode ? { permissionMode: launch.permissionMode } : {}),
        reasoning: confirm.reasoning,
      }),
      ...conversationLaunchDraftPatch(confirm.skills, launch.prompt, launch.images, launch.files),
    },
  }
}
