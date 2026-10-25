import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { createTailnetMeshService } from './tailnet-mesh-service'
import { pairingUrl } from './tailnet-service'
import { TAILNET_IDENTITY_PATH, TAILNET_MCP_PATH, TAILNET_PAIR_PATH } from './tailnet-routes'

// Settling a chat on a paired machine, and saying it was looked at: asked of
// a machine that keeps its chats' rest (`conversation-lifecycle`), never of
// one that has said it does not, and read as unsupported from one built
// before the tools.

type ToolCall = { name: string; arguments: Record<string, unknown> }

async function pairedMachine(
  capabilities: string[] | undefined,
  answer: (call: ToolCall) => Record<string, unknown>,
  scopes: string[] = ['conversation:read', 'conversation:operate'],
) {
  const toolCalls: ToolCall[] = []
  const device = {
    deviceId: 'device-1',
    deviceName: 'dev-macbook-air',
    scopes,
    transportVersion: 2,
    ...(capabilities ? { capabilities } : {}),
  }
  const peer: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://peer.invalid').pathname
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      if (path === TAILNET_PAIR_PATH) return json(200, { ...device, deviceToken: 'device-token' })
      if (path === TAILNET_IDENTITY_PATH) return json(200, device)
      if (path === TAILNET_MCP_PATH) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          id: string
          params: { name: string; arguments: Record<string, unknown> }
        }
        toolCalls.push({ name: body.params.name, arguments: body.params.arguments })
        return json(200, { jsonrpc: '2.0', id: body.id, ...answer(body.params) })
      }
      return json(404, { error: { code: 'not_found', message: `No route for ${path}.` } })
    })
  })
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
  const port = (peer.address() as { port: number }).port
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-mesh-lifecycle-'))
  const mesh = createTailnetMeshService({
    resolveUserDataDir: () => dir,
    resolveDeviceName: () => 'dev-macbook-air',
    resolvePeerName: async () => null,
  })
  const paired = await mesh.pair({ pairingUrl: pairingUrl('127.0.0.1', port, 'pairing-token') })
  assert.ok(paired.ok, paired.ok ? '' : paired.message)
  await mesh.checkReachability(paired.connection.id)
  return {
    mesh,
    connectionId: paired.connection.id,
    toolCalls,
    async close() {
      mesh.shutdown()
      await new Promise<void>((resolve) => peer.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const success = (structured: Record<string, unknown>) => ({
  result: { content: [{ type: 'text', text: '' }], structuredContent: structured },
})

test('a machine that keeps its chats’ rest is asked to settle one, and its answer read', async () => {
  const machine = await pairedMachine(['conversations', 'conversation-lifecycle'], (call) =>
    success({ ok: true, workspaceId: call.arguments.workspaceId, settledAt: 4_000 }),
  )
  try {
    const settled = await machine.mesh.settleConversation({ connectionId: machine.connectionId, workspaceId: 'ws-1' })
    assert.deepEqual(settled, { ok: true, workspaceId: 'ws-1', settledAt: 4_000 })
    assert.deepEqual(machine.toolCalls, [
      { name: 'conversation.settle', arguments: { workspaceId: 'ws-1', settled: true } },
    ])
  } finally {
    await machine.close()
  }
})

test('a visit sends no time of this machine’s, and the far machine’s own clock comes back', async () => {
  const machine = await pairedMachine(['conversations', 'conversation-lifecycle'], (call) =>
    success({ ok: true, workspaceId: call.arguments.workspaceId, lastVisitedAt: 7_000 }),
  )
  try {
    const visited = await machine.mesh.visitConversation({ connectionId: machine.connectionId, workspaceId: 'ws-1' })
    assert.deepEqual(visited, { ok: true, workspaceId: 'ws-1', lastVisitedAt: 7_000 })
    // A clock here that runs behind the far machine's would stamp a visit
    // before a finish there, and never clear it; that machine uses its own now.
    assert.deepEqual(machine.toolCalls[0], { name: 'conversation.visit', arguments: { workspaceId: 'ws-1' } })
  } finally {
    await machine.close()
  }
})

test('a machine whose list leaves the capability out is not asked, and says why', async () => {
  const machine = await pairedMachine(['conversations', 'conversation-models'], () =>
    assert.fail('nothing is asked over there'),
  )
  try {
    const settled = await machine.mesh.settleConversation({ connectionId: machine.connectionId, workspaceId: 'ws-1' })
    assert.equal(!settled.ok && settled.code, 'lifecycle_unsupported')
    assert.match(!settled.ok ? settled.message : '', /Update SprintEngine Studio there/)
    const visited = await machine.mesh.visitConversation({ connectionId: machine.connectionId, workspaceId: 'ws-1' })
    assert.equal(!visited.ok && visited.code, 'lifecycle_unsupported')
    assert.match(!visited.ok ? visited.message : '', /read state/, 'a visit is not told about settling')
    assert.deepEqual(machine.toolCalls, [])
  } finally {
    await machine.close()
  }
})

test('a machine from before the tools answers "Unknown tool", read as unsupported', async () => {
  const machine = await pairedMachine(undefined, (call) => ({
    error: { code: -32602, message: `Unknown tool: ${call.name}` },
  }))
  try {
    const settled = await machine.mesh.settleConversation({ connectionId: machine.connectionId, workspaceId: 'ws-1' })
    assert.equal(!settled.ok && settled.code, 'lifecycle_unsupported')
  } finally {
    await machine.close()
  }
})

test('a refusal over there reaches the caller in the machine’s own words', async () => {
  const machine = await pairedMachine(['conversations', 'conversation-lifecycle'], () => ({
    result: {
      content: [{ type: 'text', text: 'working: busy' }],
      structuredContent: { ok: false, error: { code: 'working', message: 'An agent in this chat is still working.' } },
      isError: true,
    },
  }))
  try {
    const settled = await machine.mesh.settleConversation({ connectionId: machine.connectionId, workspaceId: 'ws-1' })
    assert.deepEqual(settled, { ok: false, code: 'working', message: 'An agent in this chat is still working.' })
  } finally {
    await machine.close()
  }
})

test('a browse reads when each workspace was settled, and null for one in the list or from an older machine', async () => {
  const machine = await pairedMachine(
    ['conversations', 'conversation-lifecycle'],
    () =>
      success({
        workspaces: [
          { id: 'resting', name: 'Done', mode: 'standard', folderPath: '/Users/dev/app', settledAt: 3_000 },
          { id: 'open', name: 'Going', mode: 'standard', folderPath: '/Users/dev/app', settledAt: null },
          { id: 'older', name: 'Before', mode: 'standard', folderPath: '/Users/dev/app' },
        ],
      }),
    ['workspace:read', 'conversation:read'],
  )
  try {
    const browsed = await machine.mesh.browse(machine.connectionId)
    assert.deepEqual(
      browsed.workspaces.map((workspace) => [workspace.id, workspace.settledAt]),
      [
        ['resting', 3_000],
        ['open', null],
        ['older', null],
      ],
    )
  } finally {
    await machine.close()
  }
})

// The row menu on a paired machine's chat: Star, Highlight color, Snooze and
// Auto-settle (`chat-row-menu` there), and Mark unread (`chat-mark-unread`).

test('each row menu change is the gateway tool that machine’s own menu writes through', async () => {
  const machine = await pairedMachine(
    ['conversations', 'conversation-lifecycle', 'chat-row-menu', 'chat-mark-unread'],
    (call) => success({ ok: true, workspaceId: call.arguments.workspaceId }),
  )
  try {
    const changes = [
      { kind: 'highlight', starred: true },
      { kind: 'highlight', color: 'green' },
      { kind: 'highlight', color: null },
      { kind: 'snooze', until: 9_000_000 },
      { kind: 'snooze', until: null },
      { kind: 'auto-settle', enabled: true },
      { kind: 'mark-unread' },
    ]
    for (const change of changes) {
      const answer = await machine.mesh.changeConversation({
        connectionId: machine.connectionId,
        workspaceId: 'ws-1',
        change,
      })
      assert.deepEqual(answer, { ok: true, workspaceId: 'ws-1' }, JSON.stringify(change))
    }
    assert.deepEqual(machine.toolCalls, [
      { name: 'conversation.highlight', arguments: { workspaceId: 'ws-1', starred: true } },
      { name: 'conversation.highlight', arguments: { workspaceId: 'ws-1', color: 'green' } },
      { name: 'conversation.highlight', arguments: { workspaceId: 'ws-1', color: null } },
      { name: 'conversation.snooze', arguments: { workspaceId: 'ws-1', until: 9_000_000 } },
      { name: 'conversation.snooze', arguments: { workspaceId: 'ws-1', until: null } },
      { name: 'conversation.auto_settle', arguments: { workspaceId: 'ws-1', enabled: true } },
      { name: 'conversation.mark_unread', arguments: { workspaceId: 'ws-1' } },
    ])
  } finally {
    await machine.close()
  }
})

test('a row menu change is not asked of a machine that does not take it, and one it cannot read is refused here', async () => {
  const machine = await pairedMachine(['conversations', 'conversation-lifecycle'], () =>
    assert.fail('nothing is asked over there'),
  )
  try {
    const starred = await machine.mesh.changeConversation({
      connectionId: machine.connectionId,
      workspaceId: 'ws-1',
      change: { kind: 'highlight', starred: true },
    })
    assert.equal(!starred.ok && starred.code, 'row_menu_unsupported')
    assert.match(!starred.ok ? starred.message : '', /cannot star its chats from here yet/)
    const marked = await machine.mesh.changeConversation({
      connectionId: machine.connectionId,
      workspaceId: 'ws-1',
      change: { kind: 'mark-unread' },
    })
    assert.equal(!marked.ok && marked.code, 'row_menu_unsupported')
    for (const change of [
      { kind: 'highlight' },
      { kind: 'highlight', color: 'teal' },
      { kind: 'snooze', until: 'soon' },
      { kind: 'auto-settle' },
      { kind: 'rename', name: '  ' },
      null,
    ]) {
      const refused = await machine.mesh.changeConversation({
        connectionId: machine.connectionId,
        workspaceId: 'ws-1',
        change,
      })
      assert.equal(!refused.ok && refused.code, 'invalid_arguments', JSON.stringify(change))
    }
    assert.deepEqual(machine.toolCalls, [])
  } finally {
    await machine.close()
  }
})

test('a machine from before the row menu tools answers "Unknown tool", read as unsupported', async () => {
  const machine = await pairedMachine(undefined, (call) => ({
    error: { code: -32602, message: `Unknown tool: ${call.name}` },
  }))
  try {
    const snoozed = await machine.mesh.changeConversation({
      connectionId: machine.connectionId,
      workspaceId: 'ws-1',
      change: { kind: 'snooze', until: 9_000_000 },
    })
    assert.equal(!snoozed.ok && snoozed.code, 'row_menu_unsupported')
  } finally {
    await machine.close()
  }
})
