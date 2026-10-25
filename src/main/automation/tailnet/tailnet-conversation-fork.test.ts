import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'

import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createConversationGatewayHost, type ConversationRegistryLink } from './tailnet-conversation-host'

// A paired device's Fork from here (`conversation-fork`): the fork is cut by
// this machine's runtime, as a window's is, and joins the chat's workspace
// here under the name a fork made here would get.

async function fixture(options: { fork?: boolean; forks?: ConversationRegistryLink['forks'] | null } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-fork-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const adapter = createMockConversationProvider({ fork: options.fork ?? true })
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  const added: Array<{ chat: { workspaceId: string; agentId: string }; newAgentId: string; name: string }> = []
  const taken = new Set<string>(['agent'])
  const forks: ConversationRegistryLink['forks'] =
    options.forks === null
      ? undefined
      : (options.forks ?? {
          name: (_chat, newAgentId) =>
            taken.has(newAgentId)
              ? { ok: false, message: 'That chat id is taken in this workspace.' }
              : { ok: true, name: 'Atlas (fork)' },
          add: (chat, newAgentId, name) => {
            added.push({ chat, newAgentId, name })
            taken.add(newAgentId)
            return { ok: true }
          },
        })
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === key.workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId: key.workspaceId }],
    () => 'bypass',
    () => null,
    async () => null,
    {},
    forks ? { forks } : {},
  )
  const started = await runtime.startSession({
    ...key,
    providerId: adapter.id,
    modelId: adapter.listModels()[0]!,
    permissionPreset: 'bypass',
  })
  assert.ok(started.ok)
  return {
    key,
    host,
    runtime,
    added,
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

const fork = (newAgentId = 'conversation-mock-provider-fork1') =>
  ({ kind: 'fork', newAgentId, side: 'assistant', turnId: 'turn-1' }) as const

test('a listed chat says whether it can be forked', async () => {
  const can = await fixture({ fork: true })
  const cannot = await fixture({ fork: false })
  try {
    assert.equal((await can.host.list())[0]!.capabilities?.fork, true)
    assert.equal((await cannot.host.list())[0]!.capabilities?.fork, false)
  } finally {
    await can.cleanup()
    await cannot.cleanup()
  }
})

test("a device's fork is cut by the runtime under the fork's name, then joins the workspace's records", async () => {
  const f = await fixture()
  try {
    const cut = vi.spyOn(f.runtime, 'forkAtTurn').mockResolvedValue({ ok: true })
    const forked = await f.host.command(f.key, 'laptop', 'fork-1', fork())
    assert.deepEqual(forked, { ok: true })
    assert.deepEqual(cut.mock.calls, [
      [
        {
          key: f.key,
          newAgentId: 'conversation-mock-provider-fork1',
          title: 'Atlas (fork)',
          side: 'assistant',
          turnId: 'turn-1',
        },
      ],
    ])
    assert.deepEqual(f.added, [
      {
        chat: { workspaceId: 'workspace', agentId: 'agent' },
        newAgentId: 'conversation-mock-provider-fork1',
        name: 'Atlas (fork)',
      },
    ])
    // Before one of the person's messages, the fork names that message.
    await f.host.command(f.key, 'laptop', 'fork-2', {
      kind: 'fork',
      newAgentId: 'conversation-mock-provider-fork2',
      side: 'user',
      turnSeq: 4,
    })
    assert.equal(cut.mock.calls[1]![0].side, 'user')
    assert.equal((cut.mock.calls[1]![0] as { turnSeq?: number }).turnSeq, 4)
  } finally {
    await f.cleanup()
  }
})

test('the same fork sent again after a dropped connection is the same fork', async () => {
  const f = await fixture()
  try {
    const cut = vi.spyOn(f.runtime, 'forkAtTurn').mockResolvedValue({ ok: true })
    const [first, again] = await Promise.all([
      f.host.command(f.key, 'laptop', 'fork-1', fork()),
      f.host.command(f.key, 'laptop', 'fork-1', fork()),
    ])
    const later = await f.host.command(f.key, 'laptop', 'fork-1', fork())
    assert.deepEqual([first.ok, again.ok, later.ok], [true, true, true])
    assert.equal(cut.mock.calls.length, 1)
    assert.equal(f.added.length, 1, 'one record, not one per send')
  } finally {
    await f.cleanup()
  }
})

test('a refused fork writes no record, and the same command may go once the reason is gone', async () => {
  const f = await fixture()
  try {
    const cut = vi
      .spyOn(f.runtime, 'forkAtTurn')
      .mockResolvedValueOnce({ ok: false, message: 'Stop the running turn before forking from an earlier message.' })
      .mockResolvedValueOnce({ ok: true })
    const refused = await f.host.command(f.key, 'laptop', 'fork-1', fork())
    assert.equal(refused.ok, false)
    assert.match(refused.message ?? '', /Stop the running turn/)
    assert.equal(f.added.length, 0)
    const again = await f.host.command(f.key, 'laptop', 'fork-1', fork())
    assert.equal(again.ok, true)
    assert.equal(cut.mock.calls.length, 2)
  } finally {
    await f.cleanup()
  }
})

test('a fork into an id the workspace holds, or one no folder could hold, is refused before anything is cut', async () => {
  const f = await fixture()
  try {
    const cut = vi.spyOn(f.runtime, 'forkAtTurn')
    for (const newAgentId of ['agent', '../escape', 'with space']) {
      const refused = await f.host.command(f.key, 'laptop', `fork-${newAgentId}`, fork(newAgentId))
      assert.equal(refused.ok, false, newAgentId)
    }
    assert.equal(cut.mock.calls.length, 0)
  } finally {
    await f.cleanup()
  }
})

test('a desktop that cannot add the record refuses the fork, so no transcript is left that nothing lists', async () => {
  const f = await fixture({ forks: null })
  try {
    const cut = vi.spyOn(f.runtime, 'forkAtTurn')
    const refused = await f.host.command(f.key, 'laptop', 'fork-1', fork())
    assert.equal(refused.ok, false)
    assert.equal(cut.mock.calls.length, 0)
  } finally {
    await f.cleanup()
  }
})
