import assert from 'node:assert/strict'
import type { IpcMain } from 'electron'
import { test } from 'vitest'

import { USAGE_REPORT_CHANNEL } from '../../shared/ipc/usage'
import type { UsageReportRequest, UsageReportResult } from '../../shared/usage-report'
import { registerUsageIpc } from './usage-ipc'

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipc = {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
  }
  return {
    ipc: ipc as unknown as IpcMain,
    invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args),
  }
}

test('usage:report hands the request to the usage service and answers with its report', async () => {
  const { ipc, invoke } = fakeIpc()
  const seen: UsageReportRequest[] = []
  const answer: UsageReportResult = { ok: false, message: 'stub' }
  registerUsageIpc(ipc, {
    dataDir: () => '/tmp/none',
    getWorkspaces: () => [],
    service: { report: async (request) => (seen.push(request), answer) },
  })
  assert.equal(await invoke(USAGE_REPORT_CHANNEL, { from: 1, to: 2, refresh: true }), answer)
  assert.deepEqual(seen, [{ from: 1, to: 2, refresh: true }])
})

test('a service that throws answers with the reason rather than rejecting the invoke', async () => {
  const { ipc, invoke } = fakeIpc()
  registerUsageIpc(ipc, {
    dataDir: () => '/tmp/none',
    getWorkspaces: () => [],
    service: {
      report: async () => {
        throw new Error('disk on fire')
      },
    },
  })
  assert.deepEqual(await invoke(USAGE_REPORT_CHANNEL, { from: 1, to: 2 }), { ok: false, message: 'disk on fire' })
})
