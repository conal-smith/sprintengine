import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'

import type { ConversationSessionSummary } from '../../../shared/conversation-runtime'
import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createConversationGatewayHost } from './tailnet-conversation-host'

// A paired device's Restart agent session (`conversation-restart-session`):
// the agent's process ends as this machine's own Restart ends it, suspended,
// and the next message starts it again on the same conversation.

async function fixture(options: { start?: boolean } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-restart-session-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const adapter = createMockConversationProvider()
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === key.workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId: key.workspaceId }],
    () => 'bypass',
    () => null,
    async () => null,
    {},
    {},
  )
  const started =
    options.start === false
      ? null
      : await runtime.startSession({
          ...key,
          providerId: adapter.id,
          modelId: adapter.listModels()[0]!,
          permissionPreset: 'bypass',
        })
  if (started) assert.ok(started.ok)
  return {
    key,
    host,
    runtime,
    session: started?.ok ? started.session : null,
    restart: (commandId: string) => host.command(key, 'phone', commandId, { kind: 'restartSession' }),
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test("a device's restart suspends the chat's session as this machine's own does, once per command", async () => {
  const f = await fixture()
  try {
    const suspend = vi.spyOn(f.runtime, 'suspendSession')
    assert.deepEqual(await f.restart('restart-1'), { ok: true })
    assert.deepEqual(suspend.mock.calls, [[{ sessionId: f.session!.sessionId }]])
    // Sent again after a dropped link: the same restart, not a second one.
    assert.deepEqual(await f.restart('restart-1'), { ok: true })
    assert.equal(suspend.mock.calls.length, 1)
    // The next message starts the agent again on the same conversation.
    const sent = await f.host.command(f.key, 'phone', 'send-1', { kind: 'send', message: 'Carry on' })
    assert.equal(sent.ok, true, sent.message ?? '')
  } finally {
    await f.cleanup()
  }
})

test('a restart while the agent works is refused in words, and may be asked again once it stops', async () => {
  const f = await fixture()
  try {
    const listSessions = vi.spyOn(f.runtime, 'listSessions')
    // The session as the runtime lists it, its phase read off its status.
    const listed = (status: ConversationSessionSummary['status'], phase: ConversationSessionSummary['phase']) =>
      listSessions.mockReturnValue({ ok: true, sessions: [{ ...f.session!, status, phase }] })
    const suspend = vi.spyOn(f.runtime, 'suspendSession')
    listed('active', 'running')
    const refused = await f.restart('restart-1')
    assert.equal(refused.ok, false)
    assert.match(refused.message ?? '', /still working/)
    assert.equal(suspend.mock.calls.length, 0)
    listed('ready', 'completed')
    assert.equal((await f.restart('restart-1')).ok, true, 'a refusal is not kept as the answer')
    assert.equal(suspend.mock.calls.length, 1)
  } finally {
    await f.cleanup()
  }
})

test('a chat with no agent running is not resumed to be restarted, and the answer says so', async () => {
  const f = await fixture({ start: false })
  try {
    const start = vi.spyOn(f.runtime, 'startSession')
    const answer = await f.restart('restart-1')
    assert.equal(answer.ok, true)
    assert.match(answer.notice ?? '', /no agent running/)
    assert.equal(start.mock.calls.length, 0)
  } finally {
    await f.cleanup()
  }
})
