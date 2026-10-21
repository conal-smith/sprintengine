import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { createTailnetMeshService } from './tailnet-mesh-service'
import { pairingUrl } from './tailnet-service'
import { TAILNET_IDENTITY_PATH, TAILNET_MCP_PATH, TAILNET_PAIR_PATH } from './tailnet-routes'

// A remote chat's Create PR: each step is asked of the machine the chat runs
// on, by the chat's key, and its answers are read member by member. A machine
// that has not said it opens pull requests for its chats is refused here in
// words, before anything is asked.

type Answers = Record<string, unknown>

/** A machine with the capabilities given that records each tool call and answers from `answers`. */
async function pairedMachine(capabilities: string[], answers: Answers = {}) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const device = {
    deviceId: 'device-1',
    deviceName: 'mac-mini',
    scopes: ['workspace:read', 'conversation:read', 'conversation:operate'],
    transportVersion: 2,
    capabilities,
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
        const tool = call.params?.name ?? ''
        calls.push({ tool, args: call.params?.arguments ?? {} })
        return json(200, { jsonrpc: '2.0', id: call.id, result: { structuredContent: answers[tool] ?? { ok: true } } })
      }
      return json(404, { error: { code: 'not_found', message: `No tailnet gateway route for ${path}.` } })
    })
  })
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
  const port = (peer.address() as { port: number }).port
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-remote-pull-request-'))
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
    key: { connectionId: paired.connection.id, workspaceId: 'ws-1', agentId: 'agent-1' },
    calls,
    async close() {
      mesh.shutdown()
      await new Promise<void>((resolve) => peer.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const CAPABLE = ['conversations', 'chat-create-pull-request']
const PIN = { branch: 'agent/remote-pr', headSha: 'abc1234def' }

test('a machine that has not said it opens pull requests is refused before it is asked', async () => {
  const machine = await pairedMachine(['conversations'])
  try {
    const answers = [
      await machine.mesh.conversationPullRequestState({ key: machine.key }),
      await machine.mesh.conversationPullRequestDraft({ key: machine.key, draftId: 'd-1' }),
      await machine.mesh.conversationPullRequestPush({ key: machine.key, pin: PIN }),
      await machine.mesh.conversationPullRequestCreate({ key: machine.key, title: 'feat', body: '' }),
    ]
    for (const answer of answers) {
      assert.ok(!answer.ok && answer.code === 'pull_requests_unsupported')
      assert.ok(!answer.ok && answer.message.includes('Update SprintEngine Studio there'))
    }
    assert.equal(machine.calls.length, 0, 'nothing was asked over there')
  } finally {
    await machine.close()
  }
})

test("each step names the chat, and the state is read with no path of that machine's", async () => {
  const machine = await pairedMachine(CAPABLE, {
    'conversation.pull_request_state': {
      ok: true,
      state: {
        readiness: { ready: true },
        gitRoot: '/Users/dev/app',
        branch: 'agent/remote-pr',
        headSha: 'abc1234def',
        uncommittedChanges: 3,
        base: 'main',
        forge: 'github',
      },
    },
    'conversation.pull_request_draft': { ok: true, title: 'feat: remote PR', body: 'Body' },
    'conversation.pull_request_push': { ok: true, pushed: true },
  })
  try {
    const state = await machine.mesh.conversationPullRequestState({ key: machine.key })
    assert.ok(state.ok)
    assert.deepEqual(state.state, {
      readiness: { ready: true },
      gitRoot: null,
      branch: 'agent/remote-pr',
      headSha: 'abc1234def',
      uncommittedChanges: 3,
      base: 'main',
      forge: 'github',
    })
    const draft = await machine.mesh.conversationPullRequestDraft({ key: machine.key, draftId: 'd-1' })
    assert.deepEqual(draft, { ok: true, title: 'feat: remote PR', body: 'Body' })
    const pushed = await machine.mesh.conversationPullRequestPush({ key: machine.key, pin: PIN })
    assert.deepEqual(pushed, { ok: true, pushed: true })
    await machine.mesh.conversationPullRequestDraftCancel({ key: machine.key, draftId: 'd-1' })
    assert.deepEqual(machine.calls, [
      { tool: 'conversation.pull_request_state', args: { workspaceId: 'ws-1', agentId: 'agent-1' } },
      { tool: 'conversation.pull_request_draft', args: { workspaceId: 'ws-1', agentId: 'agent-1', draftId: 'd-1' } },
      { tool: 'conversation.pull_request_push', args: { workspaceId: 'ws-1', agentId: 'agent-1', pin: PIN } },
      {
        tool: 'conversation.pull_request_draft_cancel',
        args: { workspaceId: 'ws-1', agentId: 'agent-1', draftId: 'd-1' },
      },
    ])
  } finally {
    await machine.close()
  }
})

test('a creation is read member by member: what was recorded there, and only a web address to open here', async () => {
  const machine = await pairedMachine(CAPABLE, {
    'conversation.pull_request_create': {
      ok: true,
      kind: 'created',
      url: 'https://github.com/acme/app/pull/7',
      recorded: false,
      recordMessage: 'The pull request is open (https://github.com/acme/app/pull/7), but it could not be recorded: no.',
    },
  })
  try {
    const created = await machine.mesh.conversationPullRequestCreate({
      key: machine.key,
      title: 'feat: remote PR',
      body: 'Body',
      pin: PIN,
    })
    assert.deepEqual(created, {
      ok: true,
      kind: 'created',
      url: 'https://github.com/acme/app/pull/7',
      recorded: {
        ok: false,
        message: 'The pull request is open (https://github.com/acme/app/pull/7), but it could not be recorded: no.',
      },
    })
    assert.deepEqual(machine.calls[0]?.args, {
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      title: 'feat: remote PR',
      body: 'Body',
      pin: PIN,
    })
  } finally {
    await machine.close()
  }
  const hostile = await pairedMachine(CAPABLE, {
    'conversation.pull_request_create': { ok: true, kind: 'page', url: 'file:///etc/passwd', place: 'GitHub' },
  })
  try {
    const page = await hostile.mesh.conversationPullRequestCreate({ key: hostile.key, title: 'feat', body: '' })
    assert.ok(!page.ok && page.code === 'unreadable_result')
  } finally {
    await hostile.close()
  }
})

test("that machine's text generation being off is said as that machine's; a pin that is not one is refused here", async () => {
  const machine = await pairedMachine(CAPABLE, {
    'conversation.pull_request_draft': { ok: false, error: { code: 'text_generation_off', message: 'off' } },
  })
  try {
    const draft = await machine.mesh.conversationPullRequestDraft({ key: machine.key })
    assert.ok(!draft.ok && draft.code === 'text_generation_off')
    // Named as the pairing names the machine, with the setting that is off over there.
    assert.ok(
      !draft.ok && /^Text generation is off on \S.* \(Settings → Agents → Text generation there\)/u.test(draft.message),
    )
    const pushed = await machine.mesh.conversationPullRequestPush({ key: machine.key, pin: { branch: 'x' } })
    assert.ok(!pushed.ok && pushed.code === 'invalid_arguments')
    assert.equal(machine.calls.length, 1)
  } finally {
    await machine.close()
  }
})
