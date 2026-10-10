import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi } from '../../shared/electron-api'
import { USAGE_REPORT_CHANNEL } from '../../shared/ipc/usage'
import type { UsageReportRequest, UsageReportResult } from '../../shared/usage-report'

export const usageApi = {
  usageReport: (request: UsageReportRequest): Promise<UsageReportResult> =>
    ipcRenderer.invoke(USAGE_REPORT_CHANNEL, request),
} satisfies Pick<ElectronApi, 'usageReport'>
