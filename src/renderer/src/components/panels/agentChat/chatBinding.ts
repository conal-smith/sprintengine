import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { conversationWorkingRoot, type AgentState } from '../../../../../shared/agent-state'
import type { ConversationSessionSummary } from '../../../../../shared/conversation-runtime'
import type { BranchPullRequest } from '../../../../../shared/git/pull-request'
import type { MeshQueuedMessage } from '../../../../../shared/tailnet-mesh'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { Workspace } from '../../../types/workspace'
import {
  newChatWorktreeAttemptRunning,
  pendingNewChatWorktreeFailure,
  prepareNewChatWorktree,
  startPendingNewChatInProject,
  subscribeNewChatWorktreeAttempts,
} from '../../../utils/newChatWorktree'
import type { CliRuntimeOption } from '../../ui/CliModelPicker'
import type { ChatReadiness } from './chatStates'

// What a chat view is bound to besides its transport: the agent fields it reads
// (name, model, preset, mode, skills, the one-shot startup prompt) and where it writes
// them back. A local chat is an agent record in the workspace store; a chat on
// a paired machine has no record here, and keeps the same fields in the pane.

export type ChatAgentFields = Pick<
  AgentState,
  | 'name'
  | 'cliPermissionPreset'
  | 'cliPermissionMode'
  | 'conversationMode'
  | 'conversationReasoningEffort'
  | 'conversationSkills'
  | 'chatStartupPrompt'
  | 'chatStartupImages'
  | 'chatStartupFiles'
> & { conversation: NonNullable<AgentState['conversation']> }

/**
 * What a chat reads of the workspace it sits in: its name, its folder, and the
 * machine and worktree it runs in. Only these, so the chat redraws when one of
 * them changes and not when the workspace record does — which it does every
 * few seconds while the chat is on screen (the visit stamp), and on every tab,
 * layout and draft change besides.
 */
export type ChatWorkspace = Pick<
  Workspace,
  'id' | 'name' | 'folderPath' | 'environment' | 'remoteOrigin' | 'hostId' | 'worktree'
>

export type ChatBinding = {
  agent: ChatAgentFields
  update(patch: Partial<ChatAgentFields>): void
  /** The workspace here, for a local chat: its name, folder and machine. */
  workspace: ChatWorkspace | null
  /** This machine's folder the chat works in; null for one on another machine. */
  workspaceRoot: string | null
  /**
   * The root the session subscription is keyed by when it is not the
   * workspace folder: a remote transport names its conversation itself.
   */
  sessionRoot?: string
  /**
   * A readiness decided by the transport (a remote link), or by a New chat
   * still waiting on its worktree, in place of this machine's provider check.
   */
  readiness?: ChatReadiness
  /** What a chat whose worktree could not be made offers instead. */
  worktreeActions?: { onRetry: () => void; onStartInProject: () => void }
  /** The session as the host last listed it, for a transport that does not start one here. */
  session?: ConversationSessionSummary | null
  /** Stamp the sidebar's ordering clock: a sent turn is a user message, as a CLI prompt is. */
  recordUserMessage?(at: number): void
  /** Remember a picked model as the next chat's default. */
  rememberModel?(choice: ChatAgentFields['conversation']): void
  /**
   * The chat's CLI and its models as the machine running the chat lists them,
   * for a chat on another machine. Absent, the picker reads this machine's own
   * catalog for the chat's CLI.
   */
  engine?: CliRuntimeOption
  /**
   * The messages the machine running the chat holds for its turn to end, as
   * that machine last said, for a chat on another machine whose transport
   * hands its queue over (`capabilities.hostQueue`).
   */
  hostQueue?: { machineName: string; messages: MeshQueuedMessage[] }
  /**
   * Where a chat on another machine works, as that machine lists it: the
   * branch its folder is on and the pull requests it opened. The strip under
   * the composer draws them as it draws a local chat's own, which it reads
   * off this machine's checkout and pull request record instead.
   */
  listed?: { branch: string | null; pullRequests: readonly BranchPullRequest[] }
}

/** A local chat's binding: its agent record in the workspace store. Null until that record has a conversation. */
export function useLocalChatBinding(workspaceId: string, agentId: string): ChatBinding | null {
  const agent = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.agents[agentId])
  // A fresh object each read, handed back as the last one while every field is
  // the same (`useShallow`).
  const workspace = useWorkspaceStore(
    useShallow((s): ChatWorkspace | null => {
      const found = s.workspaces.find((w) => w.id === workspaceId)
      return found
        ? {
            id: found.id,
            name: found.name,
            folderPath: found.folderPath,
            environment: found.environment,
            remoteOrigin: found.remoteOrigin,
            hostId: found.hostId,
            worktree: found.worktree,
          }
        : null
    }),
  )
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const recordWorkspaceUserMessage = useWorkspaceStore((s) => s.recordWorkspaceUserMessage)
  const rememberModel = useWorkspaceStore((s) => s.setLastSelectedConversationModel)
  const update = useCallback(
    (patch: Partial<ChatAgentFields>) => updateAgent(workspaceId, agentId, patch),
    [updateAgent, workspaceId, agentId],
  )
  const recordUserMessage = useCallback(
    (at: number) => recordWorkspaceUserMessage(workspaceId, at),
    [recordWorkspaceUserMessage, workspaceId],
  )
  // A New chat opened before its worktree is the launch gate: no root until
  // the worktree is its folder, so no session can start and the first message
  // waits; the readiness says what it is waiting on, or why it stopped.
  const attemptRunning = useSyncExternalStore(subscribeNewChatWorktreeAttempts, () =>
    newChatWorktreeAttemptRunning(workspaceId),
  )
  const pendingWorktree = agent?.chatPendingWorktree
  const pendingGate = useMemo((): Pick<ChatBinding, 'readiness' | 'worktreeActions'> | null => {
    if (!pendingWorktree) return null
    const failure = attemptRunning ? null : pendingNewChatWorktreeFailure(workspaceId, pendingWorktree)
    return {
      readiness: failure === null ? { kind: 'preparing-worktree' } : { kind: 'worktree-failed', message: failure },
      worktreeActions: {
        onRetry: () => void prepareNewChatWorktree(workspaceId),
        onStartInProject: () => void startPendingNewChatInProject(workspaceId),
      },
    }
  }, [pendingWorktree, attemptRunning, workspaceId])
  return useMemo(
    () =>
      agent?.conversation
        ? {
            agent: agent as ChatAgentFields,
            update,
            workspace,
            // A chat started in a run worktree is keyed by that worktree; the
            // workspace folder would start a second session beside it.
            workspaceRoot: pendingGate ? null : conversationWorkingRoot(agent, workspace?.folderPath),
            recordUserMessage,
            rememberModel,
            ...pendingGate,
          }
        : null,
    [agent, update, workspace, recordUserMessage, rememberModel, pendingGate],
  )
}
