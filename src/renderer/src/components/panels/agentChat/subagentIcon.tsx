import type { JSX } from 'react'
import { cliForConversationProvider } from '../../../../../shared/conversation-harness'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { AgentCli } from '../../../types/workspace'
import CliIcon from '../../CliIcon'
import { useConversationLinkContext } from './conversationLinks'

// A sub-agent is drawn as the harness doing the work, whichever model that
// harness is driving (owner ruling 2026-11-05): a reviewer on Cursor wears
// Cursor's mark, even with Grok under it. The words beside it name the model.
export function SubagentIcon({
  cli,
  className = 'icon-sm shrink-0',
}: {
  cli: AgentCli | null | undefined
  className?: string
}): JSX.Element | null {
  return cli ? <CliIcon cli={cli} className={className} /> : null
}

/** The CLI of the chat these lanes belong to, when this window has its record. */
export function useLaneParentCli(): AgentCli | null {
  const context = useConversationLinkContext()
  const conversation = useWorkspaceStore((state) =>
    context?.workspaceId && context.agentId
      ? state.workspaces.find((workspace) => workspace.id === context.workspaceId)?.agents[context.agentId]
          ?.conversation
      : undefined,
  )
  return cliForConversationProvider(conversation?.providerId) as AgentCli | null
}
