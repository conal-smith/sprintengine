import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'

import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createConversationGatewayHost } from './tailnet-conversation-host'

// A paired device's Edit from here (`conversation-rewind`) and Revert
// (`conversation-checkpoint-revert`): each reaches the runtime as this
// machine's own does, in this machine's checkout, and a repeat of the same
// command after a dropped connection is answered as the first was.

async function fixture(options: { rewind?: boolean; start?: boolean } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-rewind-revert-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const adapter = createMockConversationProvider({ rewind: options.rewind ?? true })
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
  if (options.start !== false) {
    const started = await runtime.startSession({
      ...key,
      providerId: adapter.id,
      modelId: adapter.listModels()[0]!,
      permissionPreset: 'bypass',
    })
    assert.ok(started.ok)
  }
  return {
    key,
    host,
    runtime,
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

const file = { path: 'src/app.ts', status: 'modified' as const, addedLines: 3, removedLines: 1, binary: false }

test('a listed chat says whether it can go back to before one of its messages', async () => {
  const can = await fixture({ rewind: true })
  const cannot = await fixture({ rewind: false })
  try {
    assert.equal((await can.host.list())[0]!.capabilities?.rewind, true)
    assert.equal((await cannot.host.list())[0]!.capabilities?.rewind, false)
  } finally {
    await can.cleanup()
    await cannot.cleanup()
  }
})

test("a device's Edit from here reaches the runtime as this machine's own, and a repeat is the same rewind", async () => {
  const f = await fixture()
  try {
    const rewind = vi.spyOn(f.runtime, 'rewindToTurn').mockResolvedValue({ ok: true })
    assert.deepEqual(await f.host.command(f.key, 'phone', 'rewind-1', { kind: 'rewind', turnSeq: 5 }), { ok: true })
    assert.deepEqual(rewind.mock.calls, [[{ key: f.key, turnSeq: 5 }]])
    // Sent again after a dropped connection: run again, it would no longer
    // find the message it went back before.
    assert.equal((await f.host.command(f.key, 'phone', 'rewind-1', { kind: 'rewind', turnSeq: 5 })).ok, true)
    assert.equal(rewind.mock.calls.length, 1)
    await f.host.command(f.key, 'phone', 'rewind-2', { kind: 'rewind', turnSeq: 3 })
    assert.equal(rewind.mock.calls.length, 2, 'a new press is a new rewind')
  } finally {
    await f.cleanup()
  }
})

test('a refused rewind is said in words and not kept: once the turn ends the same press may go', async () => {
  const f = await fixture()
  try {
    const rewind = vi
      .spyOn(f.runtime, 'rewindToTurn')
      .mockResolvedValueOnce({ ok: false, message: 'Stop the running turn before editing an earlier message.' })
      .mockResolvedValueOnce({ ok: true })
    const refused = await f.host.command(f.key, 'phone', 'rewind-1', { kind: 'rewind', turnSeq: 5 })
    assert.deepEqual(refused, { ok: false, message: 'Stop the running turn before editing an earlier message.' })
    assert.equal((await f.host.command(f.key, 'phone', 'rewind-1', { kind: 'rewind', turnSeq: 5 })).ok, true)
    assert.equal(rewind.mock.calls.length, 2)
  } finally {
    await f.cleanup()
  }
})

test('a chat at rest goes back from its transcript, and is not resumed for it', async () => {
  const f = await fixture({ start: false })
  try {
    const start = vi.spyOn(f.runtime, 'startSession')
    vi.spyOn(f.runtime, 'rewindToTurn').mockResolvedValue({ ok: true })
    vi.spyOn(f.runtime, 'revertToTurn').mockResolvedValue({ ok: true, files: [file], reverted: false })
    assert.equal((await f.host.command(f.key, 'phone', 'rewind-1', { kind: 'rewind', turnSeq: 5 })).ok, true)
    assert.equal((await f.host.command(f.key, 'phone', 'revert-1', { kind: 'revert', turnSeq: 5 })).ok, true)
    assert.equal(start.mock.calls.length, 0)
  } finally {
    await f.cleanup()
  }
})

test("a revert's preview answers with the files it would put back, each time it is asked", async () => {
  const f = await fixture()
  try {
    const revert = vi.spyOn(f.runtime, 'revertToTurn').mockResolvedValue({ ok: true, files: [file], reverted: false })
    const preview = await f.host.command(f.key, 'phone', 'revert-1', { kind: 'revert', turnSeq: 4, undo: true })
    assert.deepEqual(preview, { ok: true, data: { files: [file], reverted: false } })
    assert.deepEqual(revert.mock.calls, [[{ key: f.key, turnSeq: 4, undo: true }]])
    await f.host.command(f.key, 'phone', 'revert-1', { kind: 'revert', turnSeq: 4, undo: true })
    assert.equal(revert.mock.calls.length, 2, 'a preview changes nothing, so it is not kept')
  } finally {
    await f.cleanup()
  }
})

test('a confirmed revert acts on the paths named, says what it kept, and a repeat is the same revert', async () => {
  const f = await fixture()
  try {
    const revert = vi.spyOn(f.runtime, 'revertToTurn').mockResolvedValue({
      ok: true,
      files: [file],
      reverted: true,
      undoRef: 'refs/sprintengine/undo/1',
      kept: ['.env.local'],
    })
    const command = { kind: 'revert' as const, turnSeq: 4, confirmed: true as const, files: ['src/app.ts'] }
    const reverted = await f.host.command(f.key, 'phone', 'revert-1', command)
    // The recovery ref is this machine's to keep: it does not go out.
    assert.deepEqual(reverted, { ok: true, data: { files: [file], reverted: true, kept: ['.env.local'] } })
    assert.deepEqual(revert.mock.calls, [[{ key: f.key, turnSeq: 4, confirmed: true, files: ['src/app.ts'] }]])
    // Run again, it would find its own work done and refuse it as moved files.
    assert.deepEqual(await f.host.command(f.key, 'phone', 'revert-1', command), reverted)
    assert.equal(revert.mock.calls.length, 1)
  } finally {
    await f.cleanup()
  }
})

test('files that moved since they were shown are refused as such, so the device can show the new list', async () => {
  const f = await fixture()
  try {
    vi.spyOn(f.runtime, 'revertToTurn')
      .mockResolvedValueOnce({
        ok: false,
        changed: true,
        message: 'The files to restore changed since they were shown.',
      })
      .mockResolvedValueOnce({ ok: false, message: 'Stop the running turn before reverting files.' })
    const command = { kind: 'revert' as const, turnSeq: 4, confirmed: true as const, files: ['src/app.ts'] }
    assert.deepEqual(await f.host.command(f.key, 'phone', 'revert-1', command), {
      ok: false,
      message: 'The files to restore changed since they were shown.',
      data: { changed: true },
    })
    assert.deepEqual(await f.host.command(f.key, 'phone', 'revert-1', command), {
      ok: false,
      message: 'Stop the running turn before reverting files.',
    })
  } finally {
    await f.cleanup()
  }
})
