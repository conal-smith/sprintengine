import { join } from 'node:path'
import type { IpcMain } from 'electron'

import { USAGE_REPORT_CHANNEL } from '../../shared/ipc/usage'
import type { UsageReportRequest, UsageReportResult } from '../../shared/usage-report'
import { sharedUsageService, type UsageService, type UsageServiceWorkspace } from '../usage/usage-service'

export type UsageIpcDeps = {
  /** The app's per-user data folder; the scan's cache and the price list live in `usage/` under it. */
  dataDir: () => string
  /** Open workspaces with their agents, so a chat's transcript is read where it runs. */
  getWorkspaces: () => readonly UsageServiceWorkspace[]
  /** Overrides the service (tests). */
  service?: Pick<UsageService, 'report'>
}

/**
 * `usage:report` answers with the dashboard's priced report. The service is
 * the one the module host shares (usage-service.ts), so the dashboard and a
 * module reading usage never scan the logs twice.
 */
export function registerUsageIpc(ipcMain: IpcMain, deps: UsageIpcDeps): void {
  let service = deps.service ?? null
  const usage = (): Pick<UsageService, 'report'> =>
    (service ??= sharedUsageService({
      dataDir: deps.dataDir,
      getWorkspaces: deps.getWorkspaces,
      // The dashboard is the app's own; it grants no module anything.
      getModulePermissions: () => undefined,
      // Built beside main's entry (electron.vite.config.ts); where it is not
      // there (the server built on its own), the scan runs inline.
      workerPath: join(__dirname, 'usage-scan-worker.js'),
    }))
  ipcMain.handle(USAGE_REPORT_CHANNEL, async (_event, request: UsageReportRequest): Promise<UsageReportResult> => {
    try {
      return await usage().report(request)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
}
