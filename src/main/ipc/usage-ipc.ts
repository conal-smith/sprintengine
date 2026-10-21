import type { IpcMain } from 'electron'

import { USAGE_REPORT_CHANNEL } from '../../shared/ipc/usage'
import {
  resolveLocalMachineIdentity,
  resolveMachineIdentity,
  shortHostName,
  type MachineMarkSettings,
} from '../../shared/machine-identity'
import type { UsageReportRequest, UsageReportResult } from '../../shared/usage-report'
import type { TailnetMeshService } from '../automation/tailnet/tailnet-mesh-service'
import { createUsageFleet, type UsageFleet } from '../usage/usage-mesh'
import { appUsageService, type UsageServiceWorkspace } from '../usage/usage-service'

export type UsageIpcDeps = {
  /** The app's per-user data folder; the scan's cache, the price list and the paired machines' last answers live in `usage/` under it. */
  dataDir: () => string
  /** Open workspaces with their agents, so a chat's transcript is read where it runs. */
  getWorkspaces: () => readonly UsageServiceWorkspace[]
  /** The machines paired over the tailnet, whose usage is counted with this one's; absent where there is no mesh. */
  mesh?: () => Pick<TailnetMeshService, 'listConnections' | 'readUsage'> | null
  /** This machine's host name, and the person's kinds and colours for machines (Settings › Machines). */
  hostName?: () => string
  machineMarks?: () => MachineMarkSettings | null | undefined
  /** Overrides the report (tests). */
  service?: Pick<UsageFleet, 'report'>
}

/**
 * `usage:report` answers with the dashboard's priced report. The usage
 * service is the one the module host and the gateway's `usage.report` share
 * (usage-service.ts), so nothing reads the logs twice; the paired machines'
 * rows are added to it here (usage-mesh.ts).
 */
export function registerUsageIpc(ipcMain: IpcMain, deps: UsageIpcDeps): void {
  let fleet = deps.service ?? null
  const usage = (): Pick<UsageFleet, 'report'> =>
    (fleet ??= createUsageFleet({
      service: appUsageService({ dataDir: deps.dataDir, getWorkspaces: deps.getWorkspaces }),
      dataDir: deps.dataDir,
      peers: () => deps.mesh?.()?.listConnections() ?? [],
      askPeer: async (connectionId, args, options) => {
        const mesh = deps.mesh?.()
        if (!mesh) return { ok: false, status: 'offline', message: 'Remote control is not running here.' }
        return mesh.readUsage({ connectionId, args, timeoutMs: options.timeoutMs })
      },
      localMachine: () => {
        const hostName = deps.hostName?.() ?? ''
        const own = resolveLocalMachineIdentity(hostName, deps.machineMarks?.())
        return { label: shortHostName(hostName) || 'This machine', kind: own.kind, color: own.colour }
      },
      pairedMachine: (machineName) => {
        const identity = resolveMachineIdentity({ kind: 'paired', name: machineName }, deps.machineMarks?.())
        return { kind: identity?.kind ?? 'desktop', color: identity?.colour ?? 'neutral' }
      },
    }))
  ipcMain.handle(USAGE_REPORT_CHANNEL, async (_event, request: UsageReportRequest): Promise<UsageReportResult> => {
    try {
      return await usage().report(request)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
}
