import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { createTailnetMeshService } from './tailnet-mesh-service'
import { pairingUrl } from './tailnet-service'
import { TAILNET_IDENTITY_PATH, TAILNET_MCP_PATH, TAILNET_PAIR_PATH } from './tailnet-routes'

// A New chat on a paired machine runs in a worktree there only where that
// machine said it takes one. An older build's `conversation.create` skips an
// argument it does not know and starts the chat in the project's checkout —
// the one place the person asked it not to — so a worktree a machine does not
// advertise is refused here, in words, before anything is asked over there.

const WORKTREE_PATH = '/Users/dev/.sprintengine-worktrees/app/login-fix'

/**
 * A machine that answers pairing and identity with the capabilities given,
 * records every tool call's arguments, and answers `conversation.create` with
 * a chat — in a worktree when `answerWorktree` says so.
 */
async function pairedMachine(capabilities: string[] | undefined, answerWorktree = true) {
  const creates: Array<Record<string, unknown>> = []
  const device = {
    deviceId: 'device-1',
    deviceName: 'mac-mini',
    scopes: ['workspace:read', 'conversation:read', 'conversation:operate'],
    transportVersion: 2,
    ...(capabilities ? { capabilities } : {}),
  }
  const peer: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://peer.invalid').pathname
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    request.on('end', () => {
      if (path === TAILNET_PAIR_PATH) return json(200, { ...device, deviceToken: 'device-token' })
      if (path === TAILNET_IDENTITY_PATH) return json(200, device)
      if (path === TAILNET_MCP_PATH) {
        const call = JSON.parse(body) as {
          id?: unknown
          params?: { name?: string; arguments?: Record<string, unknown> }
        }
        if (call.params?.name === 'conversation.create') {
          const args = call.params.arguments ?? {}
          creates.push(args)
          const ranIn =
            answerWorktree && args.worktree === true
              ? { path: WORKTREE_PATH, branch: 'agent/login-fix' }
              : answerWorktree && typeof args.inWorktree === 'string'
                ? { path: args.inWorktree, branch: 'feat/search' }
                : null
          return json(200, {
            jsonrpc: '2.0',
            id: call.id,
            result: {
              structuredContent: {
                ok: true,
                conversation: { workspaceId: 'ws-new', agentId: 'agent-1', name: 'Fix the build' },
                ...(ranIn ? { worktree: ranIn } : {}),
              },
            },
          })
        }
      }
      return json(404, { error: { code: 'not_found', message: `No tailnet gateway route for ${path}.` } })
    })
  })
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
  const port = (peer.address() as { port: number }).port
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-new-chat-worktree-'))
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
    creates,
    async close() {
      mesh.shutdown()
      await new Promise<void>((resolve) => peer.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const EVERY = ['conversations', 'new-chat-worktree', 'new-chat-worktree-name', 'new-chat-in-worktree']

test('a machine that cuts named worktrees is asked for one by name, and its answer says where the chat runs', async () => {
  const machine = await pairedMachine(EVERY)
  try {
    const created = await machine.mesh.createConversation({
      connectionId: machine.connectionId,
      workspaceId: 'w',
      worktree: { kind: 'new', name: ' login-fix ' },
    })
    assert.ok(created.ok, created.ok ? '' : created.message)
    assert.equal(machine.creates[0]?.newChat, true)
    assert.equal(machine.creates[0]?.worktree, true)
    assert.equal(machine.creates[0]?.worktreeName, 'login-fix')
    assert.deepEqual(created.worktree, { path: WORKTREE_PATH, branch: 'agent/login-fix' })
  } finally {
    await machine.close()
  }
})

test('an unnamed worktree sends no name, so a machine that takes no name still cuts one', async () => {
  const machine = await pairedMachine(['conversations', 'new-chat-worktree'])
  try {
    const created = await machine.mesh.createConversation({
      connectionId: machine.connectionId,
      workspaceId: 'w',
      worktree: { kind: 'new', name: '' },
    })
    assert.ok(created.ok)
    assert.equal(machine.creates[0]?.worktree, true)
    assert.equal('worktreeName' in (machine.creates[0] ?? {}), false)
  } finally {
    await machine.close()
  }
})

test('a machine is asked to start a chat in a worktree the project already has, by its path', async () => {
  const machine = await pairedMachine(EVERY)
  try {
    const created = await machine.mesh.createConversation({
      connectionId: machine.connectionId,
      workspaceId: 'w',
      worktree: { kind: 'existing', path: '/Users/dev/.sprintengine-worktrees/app/search' },
    })
    assert.ok(created.ok)
    assert.equal(machine.creates[0]?.inWorktree, '/Users/dev/.sprintengine-worktrees/app/search')
    assert.equal('worktree' in (machine.creates[0] ?? {}), false)
    assert.deepEqual(created.worktree, { path: '/Users/dev/.sprintengine-worktrees/app/search', branch: 'feat/search' })
  } finally {
    await machine.close()
  }
})

test('a worktree a machine does not advertise is refused in words, and nothing is asked over there', async () => {
  const cases: Array<{ capabilities: string[] | undefined; worktree: Record<string, unknown> }> = [
    { capabilities: undefined, worktree: { kind: 'new', name: '' } },
    { capabilities: ['conversations'], worktree: { kind: 'new', name: '' } },
    { capabilities: ['conversations', 'new-chat-worktree'], worktree: { kind: 'new', name: 'login-fix' } },
    { capabilities: ['conversations', 'new-chat-worktree'], worktree: { kind: 'existing', path: WORKTREE_PATH } },
  ]
  for (const { capabilities, worktree } of cases) {
    const machine = await pairedMachine(capabilities)
    try {
      const created = await machine.mesh.createConversation({
        connectionId: machine.connectionId,
        workspaceId: 'w',
        worktree,
      })
      assert.equal(!created.ok && created.code, 'worktree_unsupported', JSON.stringify({ capabilities, worktree }))
      assert.match(!created.ok ? created.message : '', /mac-mini|dev-macbook-air|cannot/)
      assert.equal(machine.creates.length, 0)
    } finally {
      await machine.close()
    }
  }
})

test('a chat with no worktree asked for runs in the checkout, and a machine that names none is read as such', async () => {
  const machine = await pairedMachine(EVERY, false)
  try {
    const created = await machine.mesh.createConversation({ connectionId: machine.connectionId, workspaceId: 'w' })
    assert.ok(created.ok)
    assert.equal('worktree' in (machine.creates[0] ?? {}), false)
    assert.equal('inWorktree' in (machine.creates[0] ?? {}), false)
    assert.equal(created.worktree, null)
  } finally {
    await machine.close()
  }
})

test('a machine that takes it starts a chat under no project, naming no workspace', async () => {
  const machine = await pairedMachine(['conversations', 'new-chat-no-project'])
  try {
    const created = await machine.mesh.createConversation({ connectionId: machine.connectionId, noProject: true })
    assert.ok(created.ok, created.ok ? '' : created.message)
    assert.equal(machine.creates[0]?.noProject, true)
    assert.equal(machine.creates[0]?.workspaceId, undefined)
    assert.equal(machine.creates[0]?.newChat, undefined)
  } finally {
    await machine.close()
  }
})

test('a machine that does not take it is refused here, in words, with nothing asked of it', async () => {
  const machine = await pairedMachine(['conversations'])
  try {
    const created = await machine.mesh.createConversation({ connectionId: machine.connectionId, noProject: true })
    assert.equal(created.ok, false)
    assert.equal(!created.ok && created.code, 'no_project_unsupported')
    assert.equal(machine.creates.length, 0)
  } finally {
    await machine.close()
  }
})
