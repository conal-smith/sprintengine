import type { ElectronApi } from '../shared/electron-api'
import { agentConfigImportApi } from './api/agent-config-import'
import { conversationImportApi } from './api/conversation-import'
import { appMenuApi } from './api/app-menu'
import { appearanceApi } from './api/appearance'
import { authApi } from './api/auth'
import { automationApi } from './api/automation'
import { studioLocalAppsApi } from './api/studio-local-apps'
import { studioConnectionApi } from './api/studio-connection'
import { studioServerApi } from './api/studio-server'
import { meshApi } from './api/mesh'
import { scheduledAgentsApi } from './api/scheduled-agents'
import { backlogApi } from './api/backlog'
import { buildStampApi } from './api/build-stamp'
import { builtinSkillsApi } from './api/builtinSkills'
import { cliRuntimeApi } from './api/cli-runtime'
import { cliModelDiscoveryApi } from './api/cli-model-discovery'
import { textGenerationApi } from './api/text-generation'
import { clipboardApi } from './api/clipboard'
import { chatExportApi } from './api/chat-export'
import { conversationApi } from './api/conversation'
import { conversationCommandsApi } from './api/conversation-commands'
import { usageLimitsApi } from './api/usage-limits'
import { usageApi } from './api/usage'
import { usageLimitResumeApi } from './api/usage-limit-resume'
import { scheduledMessagesApi } from './api/scheduled-messages'
import { conversationPeekApi } from './api/conversation-peek'
import { agentCompactApi } from './api/agent-compact'
import { pullRequestApi } from './api/pull-request'
import { credentialApi } from './api/credential'
import { designSystemApi } from './api/design-system'
import { filesystemApi } from './api/filesystem'
import { gitApi } from './api/git'
import { artifactsApi } from './api/artifacts'
import { marketplaceApi } from './api/marketplace'
import { hostedSourcesFeedApi } from './api/hosted-sources-feed'
import { hostedCardFeedApi } from './api/hosted-card-feed'
import { cliVersionApi } from './api/cli-version'
import { memoryActivityApi } from './api/memoryActivity'
import { mcpApi } from './api/mcp'
import { modulesApi } from './api/modules'
import { pluginsApi } from './api/plugins'
import { skillsApi } from './api/skills'
import { launchSettingsApi } from './api/launch-settings'
import { hostsApi } from './api/hosts'
import { sshEnvironmentsApi } from './api/ssh-environments'
import { splashApi } from './api/splash'
import { startupApi } from './api/startup'
import { terminalApi } from './api/terminal'
import { updateApi } from './api/update'
import { windowApi } from './api/window'
import { browserApi } from './api/browser'
import { canvasApi } from './api/canvas'
import { editorRevealApi } from './api/editor-reveal'
import { toursApi } from './api/tours'
import { workspaceBackupApi } from './api/workspace-backup'
import { workspaceSkillsApi } from './api/workspace-skills'
import { workspaceSyncApi } from './api/workspace-sync'
import { extensionScaffoldApi } from './api/extension-scaffold'
import { previewsApi } from './api/previews'
import { webDevicesApi } from './api/web-devices'
import { worktreePoolApi } from './api/worktree-pool'
import { settledChatsApi } from './api/settled-chats'

// Every `window.api` member the preload builds from its api modules: all of
// them but the values it computes from its own process. One list, which
// the preload and the web client both spread, so a member added here reaches
// both and the compiler holds each to `ElectronApi`.

/** The values the preload computes from its own process rather than an api module. */
export type ComputedApiMembers =
  | 'platform'
  | 'hostPlatform'
  | 'clientCapabilities'
  | 'sshMachinesEnabled'
  | 'isDevelopment'
  | 'isDiagnosticsEnabled'
  | 'diagnosticsGetIpcStats'

export const apiModules = {
  ...agentConfigImportApi,
  ...conversationImportApi,
  ...windowApi,
  ...browserApi,
  ...canvasApi,
  ...editorRevealApi,
  ...toursApi,
  ...splashApi,
  ...startupApi,
  ...buildStampApi,
  ...appearanceApi,
  ...artifactsApi,
  ...authApi,
  ...automationApi,
  ...studioLocalAppsApi,
  ...studioConnectionApi,
  ...studioServerApi,
  ...meshApi,
  ...scheduledAgentsApi,
  ...backlogApi,
  ...builtinSkillsApi,
  ...clipboardApi,
  ...chatExportApi,
  ...cliRuntimeApi,
  ...cliModelDiscoveryApi,
  ...textGenerationApi,
  ...hostedSourcesFeedApi,
  ...hostedCardFeedApi,
  ...cliVersionApi,
  ...filesystemApi,
  ...launchSettingsApi,
  ...hostsApi,
  ...sshEnvironmentsApi,
  ...gitApi,
  ...marketplaceApi,
  ...memoryActivityApi,
  ...mcpApi,
  ...modulesApi,
  ...pluginsApi,
  ...conversationApi,
  ...conversationCommandsApi,
  ...usageLimitsApi,
  ...usageApi,
  ...usageLimitResumeApi,
  ...scheduledMessagesApi,
  ...conversationPeekApi,
  ...agentCompactApi,
  ...pullRequestApi,
  ...credentialApi,
  ...designSystemApi,
  ...skillsApi,
  ...terminalApi,
  ...updateApi,
  ...appMenuApi,
  ...workspaceBackupApi,
  ...workspaceSkillsApi,
  ...workspaceSyncApi,
  ...extensionScaffoldApi,
  ...previewsApi,
  ...webDevicesApi,
  ...worktreePoolApi,
  ...settledChatsApi,
} satisfies Omit<ElectronApi, ComputedApiMembers>
