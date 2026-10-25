import { chatIdsOnRecord } from './agent-worktree-keep-checks'
import { removeConversationStorage } from './conversation-persistence'
import { writeDiagnosticLog } from './diagnostics-service'
import { removeGitWorktree } from './git'
import {
  createSettledChatDeletion,
  type SettledChatDeletion,
  type SettledChatDeletionDeps,
} from './settled-chat-deletion'
import { createSettledChatWorktreeOps } from './settled-chat-worktrees'
import { createWorktreeInventory } from './worktree-pool/worktree-inventory'

// Deleting a settled chat as this app does it, wherever it is asked: a
// window's Delete (settled-chats-ipc.ts) and a paired desktop's
// (`conversation.delete`). One construction, so the two cannot delete
// differently.

type Services = {
  workspaceSyncService: {
    getSnapshot(): { state: { workspaces: ReturnType<SettledChatDeletionDeps['listChats']> } }
    removeWorkspace(workspaceId: string, actor: 'ui' | 'mobile'): { ok: true } | { ok: false; message: string }
  }
  conversations: SettledChatDeletionDeps['conversations']
  worktreePool: Parameters<typeof createSettledChatWorktreeOps>[0]['pool'] &
    Parameters<typeof createWorktreeInventory>[0]['pool']
  liveWorkPaths: Parameters<typeof createWorktreeInventory>[0]['livePaths']
}

/** The deletion, its record removed as `actor`: the window's person, or a paired device. */
export function createAppSettledChatDeletion(services: Services, actor: 'ui' | 'mobile' = 'ui'): SettledChatDeletion {
  const knownWorkspaceIds = () => chatIdsOnRecord(services.workspaceSyncService.getSnapshot().state.workspaces)
  return createSettledChatDeletion({
    listChats: () => services.workspaceSyncService.getSnapshot().state.workspaces,
    removeChat: (workspaceId) => services.workspaceSyncService.removeWorkspace(workspaceId, actor),
    conversations: services.conversations,
    removeConversationStorage,
    worktrees: createSettledChatWorktreeOps({
      pool: services.worktreePool,
      inventory: createWorktreeInventory({
        pool: services.worktreePool,
        livePaths: services.liveWorkPaths,
        knownWorkspaceIds,
        removeWorktree: removeGitWorktree,
      }),
    }),
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'Delete settled chat', message })
    },
  })
}
