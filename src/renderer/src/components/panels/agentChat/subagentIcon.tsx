import type { JSX } from 'react'
import { cliForConversationProvider } from '../../../../../shared/conversation-harness'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { AgentCli } from '../../../types/workspace'
import CliIcon from '../../CliIcon'
import { useConversationLinkContext } from './conversationLinks'

// A sub-agent is drawn as what is doing the work: the model's maker where the
// id says who that is, else the CLI it runs on. Cursor and OpenCode carry other
// makers' models, so a reviewer on Cursor reads as Grok or Muse, which is what
// a person comparing reviewers wants to see at a glance.
const MODEL_MAKERS: ReadonlyArray<[RegExp, AgentCli]> = [
  [/claude|opus|sonnet|haiku|fable/iu, 'claude-code'],
  [/gpt|codex|^o\d/iu, 'codex'],
  [/grok/iu, 'grok'],
  [/muse/iu, 'muse'],
  [/kimi/iu, 'kimi-code'],
  [/glm|zai/iu, 'zai'],
]

/** The CLI whose mark stands for this model, falling back to the CLI it runs on. */
export function subagentIconCli(cli: AgentCli | null | undefined, modelId: string | null | undefined): AgentCli | null {
  const maker = modelId ? MODEL_MAKERS.find(([family]) => family.test(modelId)) : undefined
  return maker?.[1] ?? cli ?? null
}

export function SubagentIcon({
  cli,
  modelId,
  className = 'icon-sm shrink-0',
}: {
  cli: AgentCli | null | undefined
  modelId?: string | null
  className?: string
}): JSX.Element | null {
  const mark = subagentIconCli(cli, modelId)
  return mark ? <CliIcon cli={mark} className={className} /> : null
}

/** The CLI and model of the chat these lanes belong to, when this window has its record. */
export function useLaneParentRuntime(): { cli: AgentCli | null; modelId: string | null } {
  const context = useConversationLinkContext()
  const conversation = useWorkspaceStore((state) =>
    context?.workspaceId && context.agentId
      ? state.workspaces.find((workspace) => workspace.id === context.workspaceId)?.agents[context.agentId]
          ?.conversation
      : undefined,
  )
  return {
    cli: cliForConversationProvider(conversation?.providerId) as AgentCli | null,
    modelId: conversation?.modelId ?? null,
  }
}
