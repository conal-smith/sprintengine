import { useCallback, useMemo } from 'react'

import { distroOfHostId } from '../../../../../shared/execution-host'
import type { MachineRef } from '../../../../../shared/machine-identity'
import { isPathOrChild } from '../../../../../shared/paths'
import { useGitBranch } from '../../../hooks/useGitBranch'
import { useMachineIdentity, useWorkspaceMachineRef } from '../../../hooks/useMachineIdentity'
import { selectModuleEnabled } from '../../../modules'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { Workspace } from '../../../types/workspace'
import type { ChatWorkspace } from './chatBinding'
import { dispatchFileReveal } from '../../../utils/fileReveal'
import { resolveWorkspaceWorktree } from '../../../utils/workspaceWorktree'
import { useCheckoutChanges } from '../../workspace/checkoutChanges'
import { changedFilesPhrase } from '../../workspace/terminalLines'
import type { ConversationTransport } from './conversationTransport'
import type { ConversationStripBranch, ConversationStripChanges, ConversationStripMachine } from './conversationStrip'

// What the conversation's composer strip says about where the agent works,
// read off the chat's binding and transport: the machine (when it is not this
// computer), the branch of the checkout it works in, and how many files that
// checkout has changed. Each answers null where the chat cannot know it — a
// chat on a paired machine has no checkout here to ask, and its branch is the
// one its machine lists — so the strip draws what is true and leaves out what
// is not known, never a guess.

/** No pull requests to scope by: a chat runs no terminal that would carry one. */
const NO_PULL_REQUESTS: never[] = []

/** The name a machine's tooltip says, from what the workspace records about it. */
export function stripMachineName(
  ref: MachineRef,
  workspace: Pick<Workspace, 'environment' | 'remoteOrigin' | 'hostId'> | null,
): string {
  if (ref.kind === 'paired') return ref.name
  if (ref.kind === 'ssh') return workspace?.environment?.kind === 'ssh' ? workspace.environment.label : ref.host
  if (ref.kind === 'wsl') return distroOfHostId(ref.hostId) ?? 'WSL'
  return 'This computer'
}

export function useConversationStripFacts({
  workspaceId,
  agentId,
  workspace,
  workspaceRoot,
  transport,
  listedBranch = null,
}: {
  workspaceId: string
  agentId: string
  workspace: ChatWorkspace | null
  workspaceRoot: string | null
  transport: Pick<ConversationTransport, 'kind' | 'machineName' | 'capabilities'>
  /** The branch the machine running a remote chat lists its folder on. */
  listedBranch?: string | null
}): {
  machine: ConversationStripMachine | null
  branch: ConversationStripBranch | null
  changes: ConversationStripChanges | null
} {
  // ── The machine ───────────────────────────────────────────────────────────
  // A chat on a paired machine is named by its link; a local chat by the
  // machine its workspace runs on (an SSH machine, a WSL distribution, or the
  // paired machine a workspace was born on). This computer is no machine to
  // mark: the strip says nothing about it.
  const workspaceRef = useWorkspaceMachineRef(transport.kind === 'remote' ? null : workspace)
  const remoteName = transport.kind === 'remote' ? (transport.machineName ?? null) : null
  const ref = useMemo<MachineRef | null>(
    () => (remoteName ? { kind: 'paired', name: remoteName } : workspaceRef),
    [remoteName, workspaceRef],
  )
  const identity = useMachineIdentity(ref && ref.kind !== 'local' ? ref : null)
  const machine =
    ref && ref.kind !== 'local' && identity
      ? { name: stripMachineName(ref, transport.kind === 'remote' ? null : workspace), identity }
      : null

  // ── The checkout ──────────────────────────────────────────────────────────
  // Only a folder this computer can read: the working root is the agent's
  // worktree when it runs in one (`conversationWorkingRoot`), else the
  // workspace's own checkout.
  const checkout = transport.capabilities.localFiles ? workspaceRoot : null
  const gitBranch = useGitBranch(checkout)
  const workspaceWorktree = workspace ? resolveWorkspaceWorktree(workspace) : null
  // Its own field, not the agent record: an agent is rewritten on every turn.
  const agentExecution = useWorkspaceStore(
    (state) => state.workspaces.find((candidate) => candidate.id === workspaceId)?.agents[agentId]?.execution,
  )
  const execution = workspace ? agentExecution : undefined
  // A worktree only when the agent actually works in one: its own (a worktree
  // launch), or the workspace's, when the workspace is a worktree.
  const agentWorktree = execution?.mode === 'worktree' && Boolean(execution.cwd?.trim())
  const inWorktree = Boolean(checkout) && (agentWorktree || workspaceWorktree !== null)
  const knownBranch = workspaceWorktree && !agentWorktree ? (workspaceWorktree.branch ?? null) : null
  const branchName = gitBranch.branch ?? knownBranch ?? (gitBranch.isRepo ? 'detached' : null)

  const moduleOverrides = useWorkspaceStore((state) => state.appSettings.modules)
  const openPaneTab = useWorkspaceStore((state) => state.openPaneTab)
  const togglePaneKind = useWorkspaceStore((state) => state.togglePaneKind)
  const filesEnabled = selectModuleEnabled(moduleOverrides, 'dev-tools')
  const gitEnabled = selectModuleEnabled(moduleOverrides, 'git')
  const folderPath = workspace?.folderPath ?? null
  // The file explorer is the workspace pane's Files tab, rooted at the
  // workspace folder. A worktree inside that folder is revealed there; one
  // outside it cannot be shown by that tree, which opens on the folder.
  const openFiles = useCallback(() => {
    openPaneTab(workspaceId, { kind: 'files' })
    if (checkout && folderPath && checkout !== folderPath && isPathOrChild(checkout, folderPath))
      dispatchFileReveal({ workspaceId, path: checkout })
  }, [checkout, folderPath, openPaneTab, workspaceId])
  // The same toggle the title bar's branch chip had: the Git panel's own
  // open/close-on-second-click.
  const openChanges = useCallback(() => {
    togglePaneKind(workspaceId, 'git')
  }, [togglePaneKind, workspaceId])

  // A chat on a paired machine has no checkout here; its machine names the
  // branch in its list, and there is no explorer here to open it in.
  const branch: ConversationStripBranch | null =
    checkout && branchName
      ? { name: branchName, worktree: inWorktree, onOpen: filesEnabled && folderPath ? openFiles : null }
      : transport.kind === 'remote' && listedBranch
        ? { name: listedBranch, worktree: false, onOpen: null }
        : null

  const counts = useCheckoutChanges(checkout, NO_PULL_REQUESTS, 'conversation-strip')
  const changes: ConversationStripChanges | null =
    counts.hasCounts && counts.marks && counts.files
      ? {
          added: counts.marks.plus,
          removed: counts.marks.minus,
          phrase: changedFilesPhrase(counts.files),
          onOpen: gitEnabled ? openChanges : null,
        }
      : null

  return { machine, branch, changes }
}
