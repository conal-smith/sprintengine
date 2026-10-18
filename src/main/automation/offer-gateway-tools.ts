import type { StudioClient } from '../../../packages/agent-sdk/src/client'
import type { OfferedToolset, ToolCall, ToolDefinition } from '../../../packages/agent-sdk/src/tools'
import type { McpConnectionContext, McpConnectionMetadata, McpToolRegistration } from '../../shared/modules/mcp-tools'
import { isStudioGatewayMutation } from './studio-gateway-tools'

// The desktop's gateway tools offered as a client toolset: today's
// registrations, unchanged, turned into tool definitions for
// `@sprintengine/agent-sdk`. A call rebuilds the connection context each
// handler reads from the call's own context, so `createBrowserTools(...)` and
// `createCanvasTools(...)` run exactly as they did when the gateway called
// them in process.

/**
 * How long Studio waits for each of its own tools a client runs (the shell's
 * built-ins, and the Windows side's tools a WSL server is offered): enough to
 * cover each one's own internal deadlines (the pane's open and load waits,
 * `wait_for`, the canvas worker's cold start and its mermaid import, a
 * launch), so moving a tool behind the protocol never cuts one short.
 */
export const BUILT_IN_TOOL_TIMEOUTS_MS: Readonly<Record<string, number>> = {
  'browser.open': 30_000,
  'browser.wait_for': 40_000,
  'browser.evaluate': 40_000,
  // A start makes its file (on a WSL share, at that share's pace), gives the
  // tab 10 s to begin capturing, and a capture that ended while it began is
  // then stopped (up to 10 s more) and its file discarded.
  'browser.record_start': 40_000,
  // A stop waits for the window's last second of video, then writes a file of
  // up to 60 MB with its length in it.
  'browser.record_stop': 60_000,
  'canvas.import': 90_000,
  'canvas.edit': 45_000,
  'canvas.layout': 45_000,
  'canvas.screenshot': 45_000,
  // A launch may cut a worktree, then waits up to 20 s for a live session.
  'agent.launch': 120_000,
  'backlog.work': 120_000,
  'terminal.create': 120_000,
  // A publish may clone the site, takes its picture (up to 20 s), and pushes
  // and uploads, retrying a push a racing publish refused.
  'artifacts.publish': 240_000,
  'artifacts.update': 240_000,
  'artifacts.delete': 180_000,
  // Waits for the person's answer (up to five minutes), then sets the host
  // up: a first push, Pages turned on and its first build, or an upload.
  'artifacts.setup': 600_000,
}
const BUILT_IN_DEFAULT_TIMEOUT_MS: Readonly<Record<string, number>> = { browser: 20_000, canvas: 15_000 }

/** How long Studio waits for one of its own tools, `<toolset>.<tool>`, once a client runs it. */
export function gatewayToolTimeoutMs(name: string): number {
  return BUILT_IN_TOOL_TIMEOUTS_MS[name] ?? BUILT_IN_DEFAULT_TIMEOUT_MS[name.split('.')[0]] ?? 60_000
}

/** The connection a gateway handler reads, rebuilt from what the call says about its caller. */
export function connectionContextOf(call: Pick<ToolCall, 'context'>): McpConnectionContext {
  const connection = call.context.connection
  const metadata: McpConnectionMetadata = { kind: connection.kind }
  for (const key of ['workspaceId', 'agentId', 'agentName', 'cliId', 'deviceId', 'deviceName'] as const)
    if (connection[key]) metadata[key] = connection[key]
  return { metadata }
}

/** Registrations named `<toolset>.<tool>` as the SDK's tool definitions, in the same order. */
export function gatewayToolDefinitions(toolset: string, registrations: McpToolRegistration[]): ToolDefinition[] {
  const prefix = `${toolset}.`
  return registrations.map((registration) => {
    if (!registration.name.startsWith(prefix))
      throw new Error(`"${registration.name}" is not a ${toolset} tool and cannot be offered in that toolset.`)
    return {
      name: registration.name.slice(prefix.length),
      description: registration.description,
      inputSchema: registration.inputSchema,
      // A built-in's mutation is the gateway's own classification, which the
      // audit and a paired device's scopes have always read.
      mutates: registration.mutates ?? isStudioGatewayMutation(registration.name),
      timeoutMs: gatewayToolTimeoutMs(registration.name),
      handler: (input, call) => registration.handler(input, connectionContextOf(call)),
    }
  })
}

/** Offer today's registrations of one toolset over a client. */
export function offerGatewayTools(
  client: Pick<StudioClient, 'tools'>,
  toolset: string,
  registrations: McpToolRegistration[],
): Promise<OfferedToolset> {
  return client.tools.offer({ name: toolset, tools: gatewayToolDefinitions(toolset, registrations) })
}
