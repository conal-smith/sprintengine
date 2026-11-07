import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { ConversationSubagent } from '../../../../packages/conversation-protocol/src/public'
import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createConversationGatewayHost, type ConversationListWorkspace } from './tailnet-conversation-host'

// A device following a chat here reads that chat's sub-agents as this machine's
// own Agents tab does (`conversation-subagents`), and the list a device's
// sidebar reads goes on leaving them out.

const PARENT = { workspaceId: 'workspace', agentId: 'parent' }

async function fixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-subagents-'))
  const adapter = createMockConversationProvider()
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  const conversation = { providerId: adapter.id, modelId: 'mock-model' }
  const record: ConversationListWorkspace = {
    name: 'Project',
    createdAt: 1,
    agents: {
      parent: { name: 'Router work', conversation },
      'child-late': {
        name: 'Cursor · grok-4.7',
        conversation,
        subagentOf: { agentId: 'parent', startedAt: 3_000, task: 'Review the sidebar' },
      },
      'child-done': {
        name: 'Reviewer',
        conversation,
        subagentOf: { agentId: 'parent', startedAt: 2_000, task: 'Review the calendar' },
        subagentReadOnly: true,
        subagentEnd: { at: 2_500, status: 'failed', error: 'The model is unavailable.' },
      },
      'not-this-chats': {
        name: 'Another chat’s',
        conversation,
        subagentOf: { agentId: 'second', startedAt: 1_000, task: 'Something else' },
      },
    },
  }
  const listeners = new Set<() => void>()
  const host = createConversationGatewayHost(
    runtime,
    () => workspaceRoot,
    () => [{ workspaceRoot, workspaceId: PARENT.workspaceId }],
    undefined,
    undefined,
    undefined,
    undefined,
    {
      workspaceOf: () => record,
      subagentChanges: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  )
  const start = (agentId: string) =>
    runtime.startSession({
      workspaceRoot,
      workspaceId: PARENT.workspaceId,
      agentId,
      providerId: adapter.id,
      modelId: 'mock-model',
      permissionPreset: 'manual',
    })
  return {
    host,
    runtime,
    record,
    start,
    moved: () => {
      for (const listener of [...listeners]) listener()
    },
    watching: () => listeners.size,
    async close() {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test('a chat’s own sub-agents are said, oldest first, and no other chat’s', async () => {
  const f = await fixture()
  try {
    const told: ConversationSubagent[][] = []
    const stop = f.host.watchSubagents!(PARENT, (subagents) => told.push(subagents))
    assert.equal(told.length, 1, 'told now')
    assert.deepEqual(
      told[0].map((subagent) => [subagent.agentId, subagent.title, subagent.status, subagent.task]),
      [
        ['child-done', 'Reviewer', 'failed', 'Review the calendar'],
        ['child-late', 'Cursor · grok-4.7', 'stopped', 'Review the sidebar'],
      ],
    )
    const done = told[0][0]
    assert.equal(done.readOnly, true)
    assert.equal(done.endedAt, 2_500)
    assert.equal(done.error, 'The model is unavailable.')
    assert.equal(done.providerId, 'mock-provider')
    assert.equal(done.modelId, 'mock-model')
    assert.equal(done.capabilities?.approvals, true, 'what it can do, as a listed chat says it')
    assert.equal(done.sessionId, undefined, 'it has no session to name')
    stop()
    assert.equal(f.watching(), 0)
  } finally {
    await f.close()
  }
})

test('a row moves with its session and its record, and nothing is said when it reads the same', async () => {
  const f = await fixture()
  try {
    const told: ConversationSubagent[][] = []
    f.host.watchSubagents!(PARENT, (subagents) => told.push(subagents))
    const started = await f.start('child-late')
    assert.ok(started.ok)
    f.moved()
    assert.equal(told.length, 2)
    const late = told.at(-1)?.find((subagent) => subagent.agentId === 'child-late')
    assert.equal(late?.status, 'starting')
    assert.equal(late?.sessionId, started.session.sessionId)
    assert.equal(late?.permissionPreset, 'manual')
    f.moved()
    assert.equal(told.length, 2, 'the same list is not said again')
    const agents = f.record.agents!
    f.record.agents = {
      ...agents,
      'child-late': { ...agents['child-late']!, subagentEnd: { at: 4_000, status: 'stopped' } },
    }
    f.moved()
    assert.equal(told.length, 3)
    assert.deepEqual(
      told
        .at(-1)
        ?.filter((subagent) => subagent.agentId === 'child-late')
        .map((subagent) => [subagent.status, subagent.endedAt]),
      [['stopped', 4_000]],
    )
  } finally {
    await f.close()
  }
})

test('the list goes on leaving a sub-agent out, while its parent is listed and it can be followed', async () => {
  const f = await fixture()
  try {
    assert.ok((await f.start('parent')).ok)
    assert.ok((await f.start('child-late')).ok)
    assert.deepEqual(
      (await f.host.list()).map((thread) => thread.agentId),
      ['parent'],
    )
    assert.equal(f.host.resolveKey(PARENT.workspaceId, 'child-late')?.agentId, 'child-late')
  } finally {
    await f.close()
  }
})

test('a host built without a way to hear them watches nothing', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-subagents-'))
  const runtime = new ConversationRuntime({
    adapters: [createMockConversationProvider()],
    getProviderById: () => undefined,
  })
  try {
    const host = createConversationGatewayHost(
      runtime,
      () => workspaceRoot,
      () => [],
    )
    assert.equal(host.watchSubagents, undefined)
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
