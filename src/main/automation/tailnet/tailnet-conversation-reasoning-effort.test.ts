import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'

import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createConversationGatewayHost, type AgentChoicePatch } from './tailnet-conversation-host'

// A paired device's effort control (`conversation-reasoning-effort`): the
// list names the levels a chat's provider runs and the one its record keeps,
// and a change is written to that record, as this machine's own control
// writes it, for every turn after to run at.

async function fixture(options: { efforts?: string[] | null; start?: boolean } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-reasoning-effort-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const adapter = createMockConversationProvider({
    reasoningEfforts: options.efforts === undefined ? ['low', 'high'] : options.efforts,
  })
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  let effort: string | undefined = 'low'
  const written: AgentChoicePatch[] = []
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === key.workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId: key.workspaceId }],
    () => 'bypass',
    () => null,
    async () => null,
    {},
    {
      reasoningEffortOf: () => effort,
      writeAgentChoice: (_key, patch) => {
        written.push(patch)
        if ('conversationReasoningEffort' in patch) effort = patch.conversationReasoningEffort
      },
    },
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
    written,
    set: (commandId: string, level?: string) =>
      host.command(key, 'phone', commandId, {
        kind: 'setReasoningEffort',
        ...(level === undefined ? {} : { effort: level }),
      }),
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test("a listed chat names its provider's levels and the one it runs at", async () => {
  const f = await fixture()
  const none = await fixture({ efforts: null })
  try {
    const listed = (await f.host.list())[0]!
    assert.deepEqual(listed.capabilities?.reasoningEfforts, ['low', 'high'])
    assert.equal(listed.reasoningEffort, 'low')
    const plain = (await none.host.list())[0]!
    assert.deepEqual(plain.capabilities?.reasoningEfforts, [])
    assert.equal('reasoningEffort' in plain, false, 'a level the provider does not run is not listed')
  } finally {
    await f.cleanup()
    await none.cleanup()
  }
})

test("a change is written to the chat's record, and says it applies from the next turn", async () => {
  const f = await fixture()
  try {
    const set = await f.set('effort-1', 'high')
    assert.deepEqual(set, { ok: true, notice: 'Reasoning effort applies from the next turn.' })
    assert.deepEqual(f.written, [{ conversationReasoningEffort: 'high' }])
    assert.equal((await f.host.list())[0]!.reasoningEffort, 'high')
    // Sent again after a dropped link, it writes the same level again.
    assert.equal((await f.set('effort-1', 'high')).ok, true)
    // None is the provider's own default.
    assert.equal((await f.set('effort-2')).ok, true)
    assert.deepEqual(f.written.at(-1), { conversationReasoningEffort: undefined })
    assert.equal('reasoningEffort' in (await f.host.list())[0]!, false)
  } finally {
    await f.cleanup()
  }
})

test('a level the provider does not run, or a provider that runs none, is refused in words', async () => {
  const f = await fixture()
  const none = await fixture({ efforts: null })
  try {
    const odd = await f.set('effort-1', 'max')
    assert.equal(odd.ok, false)
    assert.match(odd.message ?? '', /does not run at max/)
    const plain = await none.set('effort-1', 'high')
    assert.equal(plain.ok, false)
    assert.match(plain.message ?? '', /no reasoning effort/)
    assert.deepEqual([...f.written, ...none.written], [])
  } finally {
    await f.cleanup()
    await none.cleanup()
  }
})

test('a chat at rest has its record changed without its session being started', async () => {
  const f = await fixture({ start: false })
  try {
    vi.spyOn(f.runtime, 'listThreads').mockResolvedValue({
      ok: true,
      threads: [{ agentId: 'agent', providerId: 'mock-provider', model: 'mock-model' } as never],
    })
    const start = vi.spyOn(f.runtime, 'startSession')
    const set = await f.set('effort-1', 'high')
    assert.deepEqual(set, { ok: true }, 'no turn runs, so none keeps its own effort')
    assert.equal(start.mock.calls.length, 0)
  } finally {
    await f.cleanup()
  }
})
