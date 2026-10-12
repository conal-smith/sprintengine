import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'vitest'

import type { McpConnectionContext, McpToolRegistration } from '../../shared/modules/mcp-tools'
import { createMcpDispatcher, JSONRPC_INVALID_REQUEST } from './mcp-dispatch'
import { createMcpSocketServer } from './mcp-socket-server'
import { issueGatewayLaunchToken, revokeGatewayLaunchToken } from '../../server/core/gateway-launch-tokens'
import { gatewayConversation } from '../../server/tools/client-tool-gateway'

const CONNECT = 'sprintengine.studio/connect'

function dispatcher() {
  return createMcpDispatcher({ serverName: 'test', serverVersion: '0.0.0-test', resolveTools: () => [] })
}

function freshContext(): McpConnectionContext {
  return { metadata: { kind: 'external-local' } }
}

test('a connection declares an agent once and is that agent', async () => {
  const context = freshContext()
  const outcome = await dispatcher().dispatch(CONNECT, { agentId: 'agent-a', workspaceId: 'ws-1' }, context)
  assert.deepEqual(outcome, { kind: 'no_response' })
  assert.equal(context.metadata.kind, 'studio-agent')
  assert.equal(context.metadata.agentId, 'agent-a')
  assert.equal(context.metadata.workspaceId, 'ws-1')
})

test('a declared agent cannot re-declare itself as another agent', async () => {
  const gateway = dispatcher()
  const context = freshContext()
  await gateway.dispatch(CONNECT, { agentId: 'agent-a', workspaceId: 'ws-1' }, context)
  const outcome = await gateway.dispatch(CONNECT, { agentId: 'agent-b', workspaceId: 'ws-1' }, context)
  assert.equal(outcome.kind, 'error')
  assert.equal(outcome.kind === 'error' && outcome.code, JSONRPC_INVALID_REQUEST)
  assert.equal(context.metadata.agentId, 'agent-a', 'the first identity stands')
})

test('a declared agent cannot move itself to another workspace', async () => {
  const gateway = dispatcher()
  const context = freshContext()
  await gateway.dispatch(CONNECT, { agentId: 'agent-a', workspaceId: 'ws-1' }, context)
  const outcome = await gateway.dispatch(CONNECT, { agentId: 'agent-a', workspaceId: 'ws-2' }, context)
  assert.equal(outcome.kind, 'error')
  assert.equal(context.metadata.workspaceId, 'ws-1')
})

test('a declared agent cannot shed its identity by declaring none', async () => {
  const gateway = dispatcher()
  const context = freshContext()
  await gateway.dispatch(CONNECT, { agentId: 'agent-a', workspaceId: 'ws-1' }, context)
  const outcome = await gateway.dispatch(CONNECT, {}, context)
  assert.equal(outcome.kind, 'error')
  assert.equal(context.metadata.kind, 'studio-agent', 'still capped as the agent it declared')
  assert.equal(context.metadata.agentId, 'agent-a')
})

test('a declared agent may state the same identity again, with a new name', async () => {
  const gateway = dispatcher()
  const context = freshContext()
  await gateway.dispatch(CONNECT, { agentId: 'agent-a', workspaceId: 'ws-1', agentName: 'Scout' }, context)
  const outcome = await gateway.dispatch(
    CONNECT,
    { agentId: 'agent-a', workspaceId: 'ws-1', agentName: 'Ranger', cliId: 'codex' },
    context,
  )
  assert.deepEqual(outcome, { kind: 'no_response' })
  assert.equal(context.metadata.agentName, 'Ranger')
  assert.equal(context.metadata.cliId, 'codex')
})

test('a connection with no agent identity may still re-state what it declares', async () => {
  const gateway = dispatcher()
  const context = freshContext()
  await gateway.dispatch(CONNECT, { workspaceId: 'ws-1' }, context)
  const outcome = await gateway.dispatch(CONNECT, { workspaceId: 'ws-2' }, context)
  assert.deepEqual(outcome, { kind: 'no_response' })
  assert.equal(context.metadata.kind, 'external-local')
  assert.equal(context.metadata.workspaceId, 'ws-2')
})

test('over the local socket, a refused re-declaration leaves every later call attributed to the first agent', async () => {
  const socketPath = join(mkdtempSync(join(tmpdir(), 'se-dispatch-sock-')), 'automation.sock')
  const attributed: Array<string | undefined> = []
  const logged: string[] = []
  const whoami: McpToolRegistration = {
    name: 'workspace.list',
    description: 'test tool',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, context) => {
      attributed.push(context?.metadata.agentId)
      return { content: [{ type: 'text', text: '{}' }], structuredContent: {} }
    },
  }
  const server = createMcpSocketServer({
    socketPath,
    serverName: 'test',
    serverVersion: '0.0.0-test',
    resolveTools: () => [whoami],
    log: (message) => logged.push(message),
  })
  await server.start()
  const socket = connect(socketPath)
  try {
    socket.setEncoding('utf8')
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    const answered: number[] = []
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const id = (JSON.parse(line) as { id?: number }).id
        if (typeof id === 'number') answered.push(id)
      }
    })
    const frame = (payload: Record<string, unknown>) => `${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`
    socket.write(frame({ method: CONNECT, params: { agentId: 'agent-a', workspaceId: 'ws-1' } }))
    socket.write(frame({ id: 1, method: 'tools/call', params: { name: 'workspace.list', arguments: {} } }))
    socket.write(frame({ method: CONNECT, params: { agentId: 'agent-b', workspaceId: 'ws-1' } }))
    socket.write(frame({ id: 2, method: 'tools/call', params: { name: 'workspace.list', arguments: {} } }))
    const deadline = Date.now() + 5_000
    while (answered.length < 2) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for two answers (got ${answered.length})`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.deepEqual(attributed, ['agent-a', 'agent-a'])
    assert.equal(logged.length, 1)
    assert.match(logged[0], /refused sprintengine\.studio\/connect/u)
  } finally {
    socket.destroy()
    await server.stop()
    rmSync(dirname(socketPath), { recursive: true, force: true })
  }
})

test('a launch token proves which conversation a connection is, whatever it declares', async () => {
  const gateway = dispatcher()
  const context = freshContext()
  const token = issueGatewayLaunchToken({ workspaceId: 'ws-1', agentId: 'chat-1', cliId: 'codex' })
  try {
    // It declares another agent; the token names this one, and wins.
    await gateway.dispatch(CONNECT, { agentId: 'someone-else', workspaceId: 'ws-9', launchToken: token }, context)
    assert.equal(context.metadata.kind, 'studio-agent')
    assert.equal(context.metadata.agentId, 'chat-1')
    assert.equal(context.metadata.workspaceId, 'ws-1')
    assert.equal(context.metadata.cliId, 'codex')
    assert.equal(context.metadata.verified, true, 'the token proved the identity')
    assert.deepEqual(gatewayConversation(context), { workspaceId: 'ws-1', agentId: 'chat-1' })
    // A second launch's token cannot move it.
    const other = issueGatewayLaunchToken({ workspaceId: 'ws-1', agentId: 'chat-2' })
    const moved = await gateway.dispatch(
      CONNECT,
      { agentId: 'chat-1', workspaceId: 'ws-1', launchToken: other },
      context,
    )
    assert.equal(moved.kind, 'error')
    assert.deepEqual(gatewayConversation(context), { workspaceId: 'ws-1', agentId: 'chat-1' })
    revokeGatewayLaunchToken(other)
  } finally {
    revokeGatewayLaunchToken(token)
  }
})

test('without a live token a declared agent is only a claim: no conversation is bound', async () => {
  const gateway = dispatcher()
  const declaredOnly = freshContext()
  await gateway.dispatch(CONNECT, { agentId: 'chat-1', workspaceId: 'ws-1' }, declaredOnly)
  assert.equal(declaredOnly.metadata.agentId, 'chat-1')
  assert.notEqual(declaredOnly.metadata.verified, true, 'a declaration proves nothing')
  assert.equal(gatewayConversation(declaredOnly), undefined)
  const revoked = freshContext()
  const token = issueGatewayLaunchToken({ workspaceId: 'ws-1', agentId: 'chat-1' })
  revokeGatewayLaunchToken(token)
  await gateway.dispatch(CONNECT, { agentId: 'chat-1', workspaceId: 'ws-1', launchToken: token }, revoked)
  assert.equal(gatewayConversation(revoked), undefined)
  // A paired device never takes a launch's identity, whatever it presents.
  const live = issueGatewayLaunchToken({ workspaceId: 'ws-1', agentId: 'chat-1' })
  try {
    const remote: McpConnectionContext = { metadata: { kind: 'remote-tailnet', deviceId: 'dev-1', verified: true } }
    await gateway.dispatch(CONNECT, { launchToken: live }, remote)
    assert.equal(remote.metadata.kind, 'remote-tailnet')
    assert.equal(remote.metadata.verified, true, "the transport's proof survives a declaration")
    assert.equal(gatewayConversation(remote), undefined)
  } finally {
    revokeGatewayLaunchToken(live)
  }
})

test('a call queued behind a slow one does not run once its socket has closed', async () => {
  const socketPath = join(mkdtempSync(join(tmpdir(), 'se-dispatch-sock-')), 'automation.sock')
  const ran: Array<string | undefined> = []
  let release = () => {}
  const slow = new Promise<void>((resolve) => (release = resolve))
  const tool: McpToolRegistration = {
    name: 'workspace.list',
    description: 'test tool',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, context) => {
      ran.push(context?.metadata.kind)
      await slow
      return { content: [{ type: 'text', text: '{}' }], structuredContent: {} }
    },
  }
  const server = createMcpSocketServer({
    socketPath,
    serverName: 'test',
    serverVersion: '0.0.0-test',
    resolveTools: () => [tool],
  })
  await server.start()
  const socket = connect(socketPath)
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    const frame = (payload: Record<string, unknown>) => `${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`
    socket.write(frame({ id: 1, method: 'tools/call', params: { name: 'workspace.list', arguments: {} } }))
    socket.write(frame({ id: 2, method: 'tools/call', params: { name: 'workspace.list', arguments: {} } }))
    for (let tries = 0; ran.length === 0 && tries < 500; tries++) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(ran.length, 1)
    socket.destroy()
    // The server hears the close before the first call ends.
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(ran.length, 1, 'the queued call never ran under a fresh identity')
  } finally {
    socket.destroy()
    await server.stop()
    rmSync(dirname(socketPath), { recursive: true, force: true })
  }
})

function toolDispatcher(handler: McpToolRegistration['handler'], inputSchema: Record<string, unknown>) {
  const tool: McpToolRegistration = { name: 'backlog.list', description: 'List the backlog.', inputSchema, handler }
  return createMcpDispatcher({ serverName: 'test', serverVersion: '0.0.0-test', resolveTools: () => [tool] })
}

const STRICT_SCHEMA = {
  type: 'object',
  properties: { projectRoot: { type: 'string' }, limit: { type: 'number' } },
  additionalProperties: false,
}

test('a misspelled argument is refused by name, not dropped while the call runs on its default', async () => {
  const calls: Record<string, unknown>[] = []
  const outcome = await toolDispatcher(async (args) => {
    calls.push(args)
    return { content: [{ type: 'text', text: 'listed' }] }
  }, STRICT_SCHEMA).dispatch(
    'tools/call',
    { name: 'backlog.list', arguments: { projectroot: '/Users/dev/app' } },
    freshContext(),
  )
  assert.equal(calls.length, 0, 'the handler never ran')
  assert.deepEqual(outcome, {
    kind: 'result',
    value: {
      content: [
        {
          type: 'text',
          text: 'backlog.list was not run: it does not take the argument "projectroot". It takes "projectRoot", "limit".',
        },
      ],
      isError: true,
    },
  })
})

test('a call with only declared arguments runs as before', async () => {
  const calls: Record<string, unknown>[] = []
  const outcome = await toolDispatcher(async (args) => {
    calls.push(args)
    return { content: [{ type: 'text', text: 'listed' }] }
  }, STRICT_SCHEMA).dispatch(
    'tools/call',
    { name: 'backlog.list', arguments: { projectRoot: '/Users/dev/app' } },
    freshContext(),
  )
  assert.deepEqual(calls, [{ projectRoot: '/Users/dev/app' }])
  assert.deepEqual(outcome, { kind: 'result', value: { content: [{ type: 'text', text: 'listed' }] } })
})

test('a tool whose schema leaves extra arguments open still takes them', async () => {
  for (const schema of [
    { type: 'object', properties: { projectRoot: { type: 'string' } } },
    { type: 'object', properties: { projectRoot: { type: 'string' } }, additionalProperties: true },
  ]) {
    const calls: Record<string, unknown>[] = []
    await toolDispatcher(async (args) => {
      calls.push(args)
      return { content: [] }
    }, schema).dispatch('tools/call', { name: 'backlog.list', arguments: { extra: 1 } }, freshContext())
    assert.deepEqual(calls, [{ extra: 1 }])
  }
})

test("every tool of the desktop's own that takes no other arguments names the ones it does take", async () => {
  const { desktopToolParts } = await import('./gateway-tools-parity.test-helper')
  const parts = desktopToolParts()
  const tools = [...parts.core, ...parts.browser, ...parts.canvas, ...parts.editor, ...parts.tour, ...parts.automation]
  assert.ok(tools.length > 40)
  for (const tool of tools) {
    if (tool.inputSchema.additionalProperties !== false) continue
    const properties = tool.inputSchema.properties
    assert.ok(
      properties === undefined || (typeof properties === 'object' && properties !== null),
      `${tool.name} declares its properties as an object`,
    )
  }
})
