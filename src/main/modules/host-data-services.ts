import { join } from 'node:path'

import type { AppServices } from '../app-services'
import type { MainHost } from '../module-host/main-host'
import { createModuleActivityRegistry } from '../module-host/module-activity'
import { createModuleBacklogRegistry } from '../module-host/module-backlog'
import {
  ActivityModuleServiceToken,
  BacklogModuleServiceToken,
  UsageModuleServiceToken,
} from '../module-host/service-tokens'
import { sharedUsageService } from '../usage/usage-service'

// The Backlog, usage and activity services modules reach through the SDK
// (`getBacklogService`, `getUsageService`, `getActivityService`), seeded by the
// agent-runtime core beside the other moduleId-first registries. Each checks
// the calling module's permission on every call. None does any work at
// startup: the usage scan starts at the first query.

export function provideHostDataServices(
  host: MainHost,
  services: Pick<AppServices, 'workspaceSyncService' | 'conversations'>,
  options: {
    getModulePermissions: (moduleId: string) => readonly string[] | undefined
    dataDir: () => string
  },
): void {
  const workspaces = () => services.workspaceSyncService.getSnapshot().state.workspaces
  host.provideService(BacklogModuleServiceToken, () =>
    createModuleBacklogRegistry({
      getWorkspace: (workspaceId) => {
        const workspace = workspaces().find((entry) => entry.id === workspaceId)
        return workspace ? { id: workspace.id, name: workspace.name, folderPath: workspace.folderPath ?? null } : null
      },
      getModulePermissions: options.getModulePermissions,
    }),
  )
  // Shared with the usage dashboard's IPC (usage-ipc.ts): one scan for both.
  const usage = sharedUsageService({
    dataDir: options.dataDir,
    getWorkspaces: workspaces,
    getModulePermissions: options.getModulePermissions,
    // Built beside main's entry (electron.vite.config.ts); where it is not
    // there, the scan runs inline.
    workerPath: join(__dirname, 'usage-scan-worker.js'),
  })
  host.provideService(UsageModuleServiceToken, () => usage.registry)
  host.onShutdownBegin(() => usage.dispose())
  host.provideService(ActivityModuleServiceToken, () =>
    createModuleActivityRegistry({
      getWorkspaces: workspaces,
      runtime: services.conversations,
      getModulePermissions: options.getModulePermissions,
    }),
  )
}
