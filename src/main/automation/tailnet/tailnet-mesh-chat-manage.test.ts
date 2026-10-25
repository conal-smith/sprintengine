import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { chatManageOf, createTailnetMeshService } from './tailnet-mesh-service'
import { pairingUrl } from './tailnet-service'
import { TAILNET_IDENTITY_PATH, TAILNET_MCP_PATH, TAILNET_PAIR_PATH } from './tailnet-routes'

// A paired desktop's chat management on a chat over there, beyond its row
// menu's marks: each change is the gateway tool of its own capability, asked
// as the row menu's are. A machine that has said it lacks one is not asked,
// and one from before the tool answers "Unknown tool", read the same.

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
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-mesh-chat-manage-'))
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

test('Rename is the machine’s own conversation.rename', async () => {
  const machine = await pairedMachine(['conversations', 'chat-rename'], (call) =>
    success({ ok: true, workspaceId: call.arguments.workspaceId, name: call.arguments.name }),
  )
  try {
    const answer = await machine.mesh.changeConversation({
      connectionId: machine.connectionId,
      workspaceId: 'ws-1',
      change: { kind: 'rename', name: '  Parser review  ' },
    })
    assert.deepEqual(answer, { ok: true, workspaceId: 'ws-1' })
    assert.deepEqual(machine.toolCalls, [
      { name: 'conversation.rename', arguments: { workspaceId: 'ws-1', name: 'Parser review' } },
    ])
  } finally {
    await machine.close()
  }
})

test('Auto compact is the machine’s own conversation.auto_compact, and refused in words where it lacks it', async () => {
  const machine = await pairedMachine(['conversations', 'chat-auto-compact'], (call) =>
    success({ ok: true, workspaceId: call.arguments.workspaceId, autoCompact: call.arguments.enabled }),
  )
  const older = await pairedMachine(['conversations', 'chat-rename'], () => assert.fail('nothing is asked'))
  try {
    const answer = await machine.mesh.changeConversation({
      connectionId: machine.connectionId,
      workspaceId: 'ws-1',
      change: { kind: 'auto-compact', enabled: true },
    })
    assert.deepEqual(answer, { ok: true, workspaceId: 'ws-1' })
    assert.deepEqual(machine.toolCalls, [
      { name: 'conversation.auto_compact', arguments: { workspaceId: 'ws-1', enabled: true } },
    ])
    const refused = await older.mesh.changeConversation({
      connectionId: older.connectionId,
      workspaceId: 'ws-1',
      change: { kind: 'auto-compact', enabled: true },
    })
    assert.match(!refused.ok ? refused.message : '', /cannot switch Auto compact on its chats from here yet/)
    const unreadable = await machine.mesh.changeConversation({
      connectionId: machine.connectionId,
      workspaceId: 'ws-1',
      change: { kind: 'auto-compact' },
    })
    assert.equal(!unreadable.ok && unreadable.code, 'invalid_arguments')
  } finally {
    await machine.close()
    await older.close()
  }
})

test('Stop watching is the machine’s own conversation.pull_request_unwatch, by the agent and the address', async () => {
  const machine = await pairedMachine(['conversations', 'chat-unwatch-pull-request'], (call) =>
    success({ ok: true, ...call.arguments, stopped: 1 }),
  )
  try {
    const url = 'https://github.com/acme/app/pull/7'
    const answer = await machine.mesh.changeConversation({
      connectionId: machine.connectionId,
      workspaceId: 'ws-1',
      change: { kind: 'unwatch-pull-request', agentId: 'agent-1', url },
    })
    assert.deepEqual(answer, { ok: true, workspaceId: 'ws-1' })
    assert.deepEqual(machine.toolCalls, [
      { name: 'conversation.pull_request_unwatch', arguments: { workspaceId: 'ws-1', agentId: 'agent-1', url } },
    ])
    const unnamed = await machine.mesh.changeConversation({
      connectionId: machine.connectionId,
      workspaceId: 'ws-1',
      change: { kind: 'unwatch-pull-request', url },
    })
    assert.equal(!unnamed.ok && unnamed.code, 'invalid_arguments')
  } finally {
    await machine.close()
  }
})

test('Delete reads the machine’s plan, kept to what this build reads, and deletes there', async () => {
  const machine = await pairedMachine(['conversations', 'chat-delete'], (call) =>
    call.name === 'conversation.delete_plan'
      ? success({
          ok: true,
          workspaceId: call.arguments.workspaceId,
          worktrees: [
            {
              name: 'chat-k',
              branch: 'agent/chat-k',
              pooled: true,
              fate: 'keep',
              keptBecause: 'changes',
              changedPaths: 3,
            },
            { name: 7, fate: 'remove' },
          ],
        })
      : success({ ok: true, workspaceId: call.arguments.workspaceId, worktrees: [] }),
  )
  const older = await pairedMachine(['conversations'], () => assert.fail('nothing is asked'))
  try {
    const plan = await machine.mesh.conversationDeletePlan({ connectionId: machine.connectionId, workspaceId: 'ws-1' })
    assert.deepEqual(plan, {
      ok: true,
      workspaceId: 'ws-1',
      worktrees: [
        {
          name: 'chat-k',
          branch: 'agent/chat-k',
          pooled: true,
          changedPaths: 3,
          unpushedCommits: null,
          fate: 'keep',
          keptBecause: 'changes',
        },
      ],
    })
    const deleted = await machine.mesh.changeConversation({
      connectionId: machine.connectionId,
      workspaceId: 'ws-1',
      change: { kind: 'delete' },
    })
    assert.deepEqual(deleted, { ok: true, workspaceId: 'ws-1' })
    assert.deepEqual(
      machine.toolCalls.map((call) => call.name),
      ['conversation.delete_plan', 'conversation.delete'],
    )
    const refused = await older.mesh.conversationDeletePlan({ connectionId: older.connectionId, workspaceId: 'ws-1' })
    assert.equal(!refused.ok && refused.code, 'delete_unsupported')
    assert.match(!refused.ok ? refused.message : '', /Update SprintEngine Studio there/)
  } finally {
    await machine.close()
    await older.close()
  }
})

test('Search asks the machine once, and keeps what this build can read of its answer', async () => {
  const machine = await pairedMachine(['conversations', 'chat-search'], () =>
    success({
      ok: true,
      chats: [
        {
          workspaceId: 'ws-1',
          chatTitle: 'Parser review',
          hits: [{ agentId: 'agent-1', seq: 4, snippet: 'the parser', from: 'person' }, { agentId: 'agent-1' }],
          count: 3,
        },
        { workspaceId: 'ws-2', chatTitle: 'Nothing readable', hits: [{ seq: 'x' }] },
      ],
      truncated: true,
    }),
  )
  const older = await pairedMachine(['conversations'], () => assert.fail('nothing is asked'))
  try {
    const found = await machine.mesh.conversationSearch({ connectionId: machine.connectionId, query: ' parser ' })
    assert.deepEqual(found, {
      ok: true,
      chats: [
        {
          workspaceId: 'ws-1',
          chatTitle: 'Parser review',
          hits: [{ agentId: 'agent-1', seq: 4, snippet: 'the parser', from: 'person' }],
          count: 3,
        },
      ],
      truncated: true,
    })
    assert.deepEqual(machine.toolCalls, [{ name: 'conversation.search', arguments: { query: 'parser' } }])
    const short = await machine.mesh.conversationSearch({ connectionId: machine.connectionId, query: 'p' })
    assert.equal(!short.ok && short.code, 'invalid_arguments')
    const refused = await older.mesh.conversationSearch({ connectionId: older.connectionId, query: 'parser' })
    assert.equal(!refused.ok && refused.code, 'search_unsupported')
  } finally {
    await machine.close()
    await older.close()
  }
})

test('a machine without chat-rename is not asked, and says so in words', async () => {
  const machine = await pairedMachine(['conversations', 'chat-row-menu'], () => assert.fail('nothing is asked'))
  try {
    const answer = await machine.mesh.changeConversation({
      connectionId: machine.connectionId,
      workspaceId: 'ws-1',
      change: { kind: 'rename', name: 'Parser review' },
    })
    assert.equal(!answer.ok && answer.code, 'row_menu_unsupported')
    assert.match(
      !answer.ok ? answer.message : '',
      /cannot rename its chats from here yet\. Update SprintEngine Studio there/,
    )
    assert.deepEqual(machine.toolCalls, [])
  } finally {
    await machine.close()
  }
})

test('a machine from before conversation.rename answers "Unknown tool", read as unsupported', async () => {
  const machine = await pairedMachine(undefined, (call) => ({
    error: { code: -32602, message: `Unknown tool: ${call.name}` },
  }))
  try {
    const answer = await machine.mesh.changeConversation({
      connectionId: machine.connectionId,
      workspaceId: 'ws-1',
      change: { kind: 'rename', name: 'Parser review' },
    })
    assert.equal(!answer.ok && answer.code, 'row_menu_unsupported')
  } finally {
    await machine.close()
  }
})

test('the list says which of the management a machine takes, by its capabilities', () => {
  const none = { rename: false, autoCompact: false, unwatchPullRequest: false, deleteSettled: false, search: false }
  assert.deepEqual(chatManageOf(undefined), none)
  assert.deepEqual(chatManageOf(['conversations']), none)
  assert.deepEqual(chatManageOf(['conversations', 'chat-rename']), { ...none, rename: true })
  assert.deepEqual(chatManageOf(['chat-auto-compact']), { ...none, autoCompact: true })
  assert.deepEqual(chatManageOf(['chat-unwatch-pull-request']), { ...none, unwatchPullRequest: true })
  assert.deepEqual(chatManageOf(['chat-delete']), { ...none, deleteSettled: true })
  assert.deepEqual(chatManageOf(['chat-search']), { ...none, search: true })
})
