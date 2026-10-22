import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { McpConnectionContext } from '../../shared/modules/mcp-tools'
import { isStudioGatewayMutation } from '../automation/studio-gateway-tools'
import {
  gatewayToolsForCaller,
  localOnlyGatewayToolReason,
  requiredScopeForTool,
  servedOnlyToPairedDevices,
} from '../automation/tailnet/tailnet-scopes'
import type { UsageSpeedRow } from './usage-aggregate'
import { decodeUsageAnswer, usageSessionHash } from './usage-mesh'
import type { UsageService } from './usage-service'
import { createUsageTools, USAGE_REPORT_TOOL } from './usage-tools'

const H0 = Date.parse('2026-10-20T09:00:00.000Z')

const row: UsageSpeedRow = {
  day: String(H0),
  providerId: 'codex-agent',
  model: 'gpt-5.5',
  sessionId: 'rollout-1',
  workspaceId: 'ws-private',
  chatTitle: 'Payroll export',
  tokens: { input: 3, output: 4, cacheRead: 5, cacheWrite: 0 },
  requests: 2,
  reportedCostUsd: null,
}

function tools(seen: Array<Parameters<UsageService['peerRows']>[0]> = []) {
  return createUsageTools({
    usage: () => ({
      peerRows: async (request) => {
        seen.push(request)
        return { rows: [row], scannedAt: H0, scanning: false, sources: [] }
      },
    }),
  })
}

test('usage.report is a read on workspace:read, which any paired device of the person’s may hold', () => {
  const registered = tools()
  assert.equal(
    isStudioGatewayMutation(USAGE_REPORT_TOOL, () => registered),
    false,
  )
  assert.equal(localOnlyGatewayToolReason(USAGE_REPORT_TOOL), null)
  assert.equal(requiredScopeForTool(USAGE_REPORT_TOOL, false), 'workspace:read')
})

test('usage.report is listed to a paired device and left out for an agent on this machine', () => {
  assert.equal(servedOnlyToPairedDevices(USAGE_REPORT_TOOL), true)
  assert.equal(servedOnlyToPairedDevices('workspace.list'), false)
  const registered = tools()
  const names = (kind: McpConnectionContext['metadata']['kind'] | null) =>
    gatewayToolsForCaller(registered, kind ? { metadata: { kind } } : undefined).map((tool) => tool.name)
  assert.deepEqual(names('remote-tailnet'), [USAGE_REPORT_TOOL])
  assert.deepEqual(names('studio-agent'), [])
  assert.deepEqual(names('external-local'), [])
  assert.deepEqual(names(null), [])
})

test('usage.report answers counts by hashed session, and nothing that names the chat or its folder', async () => {
  const seen: Array<Parameters<UsageService['peerRows']>[0]> = []
  const [tool] = tools(seen)
  const result = await tool!.handler({ from: H0, to: H0 + 3_600_000, wait: true })
  assert.notEqual(result.isError, true)
  assert.deepEqual(seen, [{ from: H0, to: H0 + 3_600_000, refresh: false, wait: true }])
  const wire = JSON.stringify(result)
  for (const secret of ['rollout-1', 'ws-private', 'Payroll export']) assert.ok(!wire.includes(secret), secret)
  const decoded = decodeUsageAnswer(result.structuredContent!)
  assert.deepEqual(decoded?.rows, [
    {
      hour: H0,
      agent: 'codex',
      session: usageSessionHash('codex', 'rollout-1'),
      model: 'gpt-5.5',
      input: 3,
      output: 4,
      cacheRead: 5,
      cacheWrite: 0,
      requests: 2,
      costUsd: null,
    },
  ])
  // The rows go once, as structured content, not again as text.
  assert.ok(!result.content.some((part) => part.type === 'text' && part.text.includes(String(H0))))
})

test('usage.report refuses a window it cannot read', async () => {
  const [tool] = tools()
  for (const args of [{}, { from: 5, to: 1 }, { from: 0, to: 401 * 86_400_000 }, { from: 0, to: 1, wait: 'yes' }]) {
    const result = await tool!.handler(args)
    assert.equal(result.isError, true, JSON.stringify(args))
  }
})
