import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { McpConnectionContext, McpToolRegistration } from '../../shared/modules/mcp-tools'
import { TAILNET_SCOPES, tailnetScopeGrantsAccess, type TailnetScope } from '../../shared/tailnet'
import { createAutomationTools } from './automation-tools'
import { createBrowserTools } from './browser-tools'
import { createCanvasTools } from './canvas-tools'
import { createConversationTools } from './conversation-tools'
import { createPullRequestTools } from '../../server/pull-requests/pull-request-tools'
import { createLocalServerTools } from '../../server/local-servers/local-server-tools'
import { desktopGatewayTools } from './desktop-gateway-tools'
import { createEditorTools } from './editor-tools'
import { createMcpDispatcher, type McpDispatchGate } from './mcp-dispatch'
import { isStudioGatewayMutation } from './studio-gateway-tools'
import { localOnlyGatewayToolReason, requiredScopeForTool } from './tailnet/tailnet-scopes'
import { createTailnetTools } from './tailnet/tailnet-tools'
import { createTourTools } from './tour-tools'
import { createWorktreePoolTools } from '../worktree-pool/worktree-pool-tools'
import { createArtifactsTools } from '../artifacts/artifacts-tools'

// The tools/list agents see from the desktop, byte for byte: names,
// descriptions, schemas and order, for an agent Studio launched, a CLI the
// person started, and a paired device on read scopes. Taken from the
// composition as it stood before the browser and the canvas became the
// shell's client toolsets; the client-tools path must list exactly this.
// The record keeps each tool's name and the SHA-256 of its whole listed JSON,
// in order, so a drift names the tool that moved.
//
// To take it again after a deliberate change to a tool:
//   UPDATE_GATEWAY_TOOLS_FIXTURE=1 npx vitest run src/main/automation/gateway-tools-parity.test.ts
//
// What the parity tests share: the desktop's tools with stand-ins behind every
// handler, the callers, and the record.

const FIXTURE = join(__dirname, '__fixtures__', 'gateway-tools-list.json')

/** The desktop's own tools, as app-services composes them, with stand-ins behind every handler. */
export function desktopToolParts(): Parameters<typeof desktopGatewayTools>[0] & { core: McpToolRegistration[] } {
  const stub = {} as never
  return {
    browser: createBrowserTools(stub),
    canvas: createCanvasTools(stub),
    editor: createEditorTools(stub),
    tour: createTourTools(stub),
    automation: createAutomationTools(stub),
    worktree: createWorktreePoolTools(stub),
    artifacts: createArtifactsTools(stub),
    tailnet: createTailnetTools({ resolveTailnet: () => null }),
    core: [...createConversationTools(stub), ...createPullRequestTools(stub), ...createLocalServerTools(stub)],
  }
}

/** A paired device on read scopes, gated as the tailnet listener gates it. */
export function readOnlyDeviceGate(resolveTools: () => McpToolRegistration[]): McpDispatchGate {
  const granted = new Set<TailnetScope>(TAILNET_SCOPES.filter((scope) => scope.endsWith(':read')))
  return {
    filterTools: (tools) =>
      tools.filter(
        (tool) =>
          localOnlyGatewayToolReason(tool.name) === null &&
          tailnetScopeGrantsAccess(
            granted,
            requiredScopeForTool(tool.name, isStudioGatewayMutation(tool.name, resolveTools)),
          ),
      ),
  }
}

export const PARITY_CALLERS: Array<[string, McpConnectionContext['metadata']]> = [
  ['studio-agent', { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-1', cliId: 'claude-code' }],
  ['external-local', { kind: 'external-local' }],
  ['remote-tailnet', { kind: 'remote-tailnet', deviceId: 'dev-1', deviceName: 'android-phone' }],
]

/** tools/list for each caller, through the gateway's own dispatcher. */
export async function listsFor(
  resolveTools: (context?: McpConnectionContext) => McpToolRegistration[],
  clientTools?: Parameters<typeof createMcpDispatcher>[0]['clientTools'],
): Promise<Record<string, unknown>> {
  const dispatcher = createMcpDispatcher({
    serverName: 'sprintengine-studio',
    serverVersion: '0.0.0-test',
    resolveTools,
    ...(clientTools ? { clientTools } : {}),
  })
  const lists: Record<string, unknown> = {}
  for (const [name, metadata] of PARITY_CALLERS) {
    const context: McpConnectionContext = { metadata: { ...metadata } }
    const gate = metadata.kind === 'remote-tailnet' ? readOnlyDeviceGate(() => resolveTools(context)) : undefined
    const outcome = await dispatcher.dispatch('tools/list', {}, context, gate)
    assert.equal(outcome.kind, 'result')
    const tools = (outcome.kind === 'result' ? outcome.value.tools : []) as Array<{ name: string }>
    lists[name] = tools.map((tool) => ({
      name: tool.name,
      sha256: createHash('sha256').update(JSON.stringify(tool)).digest('hex'),
    }))
  }
  return lists
}

/** The record, or a fresh one when asked to take it again. */
export function gatewayToolsFixture(lists: Record<string, unknown>): Record<string, unknown> {
  if (process.env.UPDATE_GATEWAY_TOOLS_FIXTURE === '1') writeFileSync(FIXTURE, `${JSON.stringify(lists, null, 2)}\n`)
  return readGatewayToolsFixture()
}

export function readGatewayToolsFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>
}
