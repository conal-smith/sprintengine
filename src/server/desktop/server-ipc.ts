import { hostname } from 'node:os'
import { join } from 'node:path'

import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  CONVERSATION_ATTACHMENTS_DIRECTORY,
  CONVERSATION_TOOL_IMAGES_DIRECTORY,
} from '../../main/conversation-attachment-store'
import { CONVERSATION_PLANS_DIRECTORY } from '../../main/conversation-plan-store'
import type { createConversationTerminalHandoff } from '../../main/conversation-terminal-handoff'
import type { createFilesystemReadHandlers } from '../../main/filesystem-read'
import type { createFilesystemWatchSearchHandlers } from '../../main/filesystem-watch-search-handlers'
import { gitRepoRootFor } from '../../main/git-repo-root'
import type { GitHubTokenStore } from '../../main/github-token-store'
import type { HostRegistry } from '../../main/hosts/host-registry'
import { registerAutomationIpc } from '../../main/ipc/automation-ipc'
import { registerBacklogIpc } from '../../main/ipc/backlog-ipc'
import { registerCliModelDiscoveryIpc } from '../../main/ipc/cli-model-discovery-ipc'
import { registerConversationCommandsIpc } from '../../main/ipc/conversation-commands-ipc'
import { registerConversationImportIpc } from '../../main/ipc/conversation-import-ipc'
import { createConversationIpcHandlers, registerConversationIpc } from '../../main/ipc/conversation-ipc'
import { registerCredentialIpc } from '../../main/ipc/credential-ipc'
import { registerGitHubReposIpc } from '../../main/ipc/github-repos-ipc'
import { registerGitHubTokenIpc } from '../../main/ipc/github-token-ipc'
import { registerHostsIpc } from '../../main/ipc/hosts-ipc'
import { registerLaunchSettingsIpc } from '../../main/ipc/launch-settings-ipc'
import { registerMeshIpc } from '../../main/ipc/mesh-ipc'
import { registerStudioLocalAppsIpc } from '../../main/ipc/studio-local-apps-ipc'
import { registerUsageLimitResumeIpc } from '../../main/ipc/usage-limit-resume-ipc'
import { registerScheduledMessagesIpc } from '../../main/ipc/scheduled-messages-ipc'
import { registerTextGenerationSettingsIpc } from '../../main/ipc/text-generation-settings-ipc'
import { registerUsageLimitsIpc } from '../../main/ipc/usage-limits-ipc'
import { registerUsageIpc } from '../../main/ipc/usage-ipc'
import { registerWorkspaceBackupIpc } from '../../main/ipc/workspace-backup-ipc'
import { registerWorkspaceSyncIpc } from '../../main/ipc/workspace-sync-ipc'
import type { AgentLaunchSettingsStore } from '../../main/launch-settings-store'
import { createStudioChatBackend } from '../../main/studio-rpc/studio-chat-backend'
import type { StudioRpcService } from '../../main/studio-rpc/studio-rpc-service'
import type { WorkspaceBackupService } from '../../main/workspace-backup'
import type { StudioCore } from '../core/studio-core'
import type { StudioGateway } from '../core/studio-gateway'

// The `window.api` domains the Studio server owns (phase 6 spec, sections 5
// and 6.2), registered in one place. Main registers them on `ipcMain` when the
// server runs in process, which it does by default; the server registers the
// very same calls on its IPC tunnel when it runs in a process of its own, and
// the preload routes their channels there (SERVER_IPC_CHANNELS, which the
// completeness test holds to this list).
//
// What is here: the workspace bus and registry hydration, launch settings and
// machines, the gateway's settings and the tailnet and mesh, the paired local
// apps, workspace backups, model discovery, the composer's command lists,
// the subscription usage limits and the resumes after them, the usage
// dashboard's report, backlog files, provider credentials and the GitHub
// token, and the chats, with the copy of the model-written titles setting the
// server titles them by.
// What is not: anything that acts on a window, a terminal or the shell's own
// caches (the git panel, the file explorer, skills and the marketplace,
// modules' enablement and trust), which stays with the shell until phase 10.

/** `ipcMain`, or the server's tunnel registry, which has its shape. */
type IpcRegistryLike = Pick<IpcMain, 'handle' | 'on' | 'removeHandler' | 'removeListener'>

export type ServerDomainIpcDeps = {
  core: Pick<
    StudioCore,
    | 'workspaceSyncService'
    | 'workspaceRegistry'
    | 'agentLaunchSettings'
    | 'hosts'
    | 'conversations'
    | 'conversationImport'
    | 'conversationLifecycle'
    | 'platform'
    | 'usageLimitResumes'
    | 'scheduledMessages'
    | 'textGenerationSettings'
    | 'conversationCommands'
  > & { hosts: HostRegistry; agentLaunchSettings: AgentLaunchSettingsStore }
  gateway: StudioGateway
  studioRpc: StudioRpcService
  githubTokenStore: GitHubTokenStore
  workspaceBackup: WorkspaceBackupService
  terminalHandoff: ReturnType<typeof createConversationTerminalHandoff>['handoff']
  /** The file reads and searches the chat view's protocol surface answers from. */
  files: ReturnType<typeof createFilesystemReadHandlers> & ReturnType<typeof createFilesystemWatchSearchHandlers>
  /** Only an app window may pair a local app: `assertAppSender` in main; the port is the check in the server. */
  assertAppSender: (event: IpcMainInvokeEvent) => void
}

export type ServerDomainIpcHandles = {
  conversationCommands: { dispose(): Promise<void> }
}

export function registerServerDomainIpc(registry: IpcRegistryLike, deps: ServerDomainIpcDeps): ServerDomainIpcHandles {
  const ipc = registry as IpcMain
  const { core } = deps
  const dataDir = () => core.platform.paths.dataDir()
  registerWorkspaceSyncIpc(ipc, core.workspaceSyncService, {
    registry: core.workspaceRegistry,
    markUnread: (workspaceId) => core.conversationLifecycle.markUnread(workspaceId, 'ui'),
  })
  registerAutomationIpc(ipc, deps.gateway)
  registerStudioLocalAppsIpc(ipc, deps.studioRpc, deps.assertAppSender)
  registerMeshIpc(ipc, deps.gateway)
  registerWorkspaceBackupIpc(ipc, deps.workspaceBackup)
  registerCliModelDiscoveryIpc(ipc)
  // The core's own lists, which a paired desktop's `/` menu reads as well.
  const conversationCommands = registerConversationCommandsIpc(ipc, { service: core.conversationCommands() })
  // The subscription usage limits the chats' agents report.
  registerUsageLimitsIpc(ipc, { userDataDir: dataDir() })
  // The chats a usage limit stopped, and the resume each can have when it resets.
  registerUsageLimitResumeIpc(ipc, core.usageLimitResumes)
  // Every agent's token use on this machine and on the machines paired with
  // it over the tailnet, priced, for the usage dashboard.
  registerUsageIpc(ipc, {
    dataDir,
    getWorkspaces: () => core.workspaceSyncService.getSnapshot().state.workspaces,
    mesh: () => deps.gateway.mesh(),
    hostName: () => hostname(),
    machineMarks: () => core.agentLaunchSettings.get().machineMarks,
  })
  // The messages a person scheduled into a chat, sent when their time comes.
  registerScheduledMessagesIpc(ipc, core.scheduledMessages)
  registerLaunchSettingsIpc(ipc, { launchSettings: core.agentLaunchSettings })
  // The titles setting each window pushes; the chats are titled where they run.
  registerTextGenerationSettingsIpc(ipc, core.textGenerationSettings)
  registerHostsIpc(ipc, { hosts: core.hosts })
  registerBacklogIpc(ipc)
  registerGitHubTokenIpc(ipc, deps.githubTokenStore)
  registerGitHubReposIpc(ipc, deps.githubTokenStore)
  // Over the core's chats, as every in-process consumer reaches them.
  const conversationHandlers = createConversationIpcHandlers(core.conversations)
  registerConversationIpc(ipc, { ...conversationHandlers, terminalHandoff: deps.terminalHandoff })
  // The Studio RPC's chat surface is these same handlers, so a chat view on
  // the protocol and one on IPC reach one chat by the same rules.
  deps.studioRpc.provideChat(
    createStudioChatBackend({
      conversation: conversationHandlers,
      files: deps.files,
      repoRoot: gitRepoRootFor,
      hasReceipt: (sessionId, commandId) => core.conversations.hasCommandReceipt(sessionId, commandId),
      // A run's worktree is inside its repository's folder, or a workspace of its own.
      readableRoots: () => [
        ...core.workspaceRegistry.getRecords().flatMap((record) => (record.folderPath ? [record.folderPath] : [])),
        join(dataDir(), CONVERSATION_ATTACHMENTS_DIRECTORY),
        join(dataDir(), CONVERSATION_PLANS_DIRECTORY),
        // The pictures a chat's steps returned (a screenshot) and Codex generated.
        join(dataDir(), CONVERSATION_TOOL_IMAGES_DIRECTORY),
      ],
      commands: (input) => conversationCommands.list(input),
      workspaces: () =>
        core.workspaceRegistry.getRecords().map((record) => ({
          id: record.id,
          name: record.name,
          folderPath: record.folderPath ?? null,
          ...(record.hostId ? { hostId: record.hostId } : {}),
        })),
    }),
  )
  registerConversationImportIpc(ipc, core.conversationImport)
  registerCredentialIpc(ipc)
  return { conversationCommands }
}
