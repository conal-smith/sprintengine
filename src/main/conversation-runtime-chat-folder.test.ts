import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { ConversationRuntime } from './conversation-runtime'
import { createMockConversationProvider } from './providers/mock-conversation-provider'
import { createWorktreeLeases, type WorktreeBlocked, type WorktreeHold } from './worktree-leases'

function exclusive(result: WorktreeHold | WorktreeBlocked): WorktreeHold {
  assert.ok('release' in result, 'blockedBy' in result ? `blocked by ${result.blockedBy[0]?.reason}` : '')
  return result
}

// A worktree chat whose pool slot was given back while it sat idle has its
// branch checked out again before any agent runs in its folder, whoever sent
// the turn (worktree-pool/chat-folder-guard.ts): the runtime asks before a
// session starts and before every turn of a resting one.
test('a session start and each turn ask for the chat’s folder first, and a refusal stops them with its reason', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-chat-folder-'))
  const asked: Array<{ workspaceId: string; workspaceRoot: string; fresh?: boolean }> = []
  let refusal: string | null = null
  const mock = createMockConversationProvider()
  const runtime = new ConversationRuntime({
    // A turn that ends at once, so the session is resting before the next.
    adapters: [{ ...mock, sendTurn: (input) => mock.sendTurn({ ...input, message: '/tools' }) }],
    getProviderById: () => undefined,
    prepareChatFolder: async (input) => {
      asked.push(input)
      return refusal ? { ok: false, message: refusal } : { ok: true }
    },
  })
  try {
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const started = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    assert.deepEqual(
      asked,
      [{ workspaceId: 'workspace', workspaceRoot, fresh: true }],
      'asked before the session started',
    )

    const rested = new Promise<void>((resolve) => runtime.onSessionIdle(() => resolve()))
    assert.equal((await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'hello' })).ok, true)
    assert.deepEqual(asked[1], { workspaceId: 'workspace', workspaceRoot }, 'asked again before the turn')
    await rested

    // The chat has a transcript now: starting it again is not its first start.
    assert.equal((await runtime.stopSession({ sessionId: started.session.sessionId })).ok, true)
    const again = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(again.ok)
    assert.equal(asked.at(-1)?.fresh, false, 'a chat with a transcript is not fresh')

    refusal = 'This chat’s worktree could not be brought back: the branch is checked out elsewhere.'
    const refused = await runtime.sendTurn({ sessionId: again.session.sessionId, message: 'again' })
    assert.equal(refused.ok, false)
    assert.equal(refused.ok ? null : refused.message, refusal)
    const notStarted = await runtime.startSession({
      ...key,
      agentId: 'other',
      providerId: 'mock-provider',
      modelId: 'mock-model',
    })
    assert.equal(notStarted.ok, false)
    assert.equal(notStarted.ok ? null : notStarted.message, refusal)
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

// A session start and a turn's start hold the chat's folder shared until the
// chat is live (worktree-leases.ts): the pool's return or the cleanup's
// removal of the folder waits, and is never run between a look and the turn.
test('the chat’s folder is held from the folder check until the turn is under way, and on every refusal let go', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-chat-folder-'))
  const leases = createWorktreeLeases()
  const heldWhileAsked: string[][] = []
  const heldWhileRunning: string[][] = []
  let refusal: string | null = null
  const reasons = async (): Promise<string[]> => (await leases.holders(workspaceRoot)).map((hold) => hold.reason)
  const mock = createMockConversationProvider()
  const runtime = new ConversationRuntime({
    adapters: [
      {
        ...mock,
        sendTurn: async (input) => {
          heldWhileRunning.push(await reasons())
          return mock.sendTurn({ ...input, message: '/tools' })
        },
      },
    ],
    getProviderById: () => undefined,
    worktreeLeases: leases,
    resolveSkills: async ({ skills }) => {
      if (skills.some((skill) => skill.id === 'missing')) throw new Error('No skill named missing.')
      return { ids: [], context: '' }
    },
    prepareChatFolder: async () => {
      heldWhileAsked.push(await reasons())
      return refusal ? { ok: false, message: refusal } : { ok: true }
    },
  })
  try {
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const started = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    assert.deepEqual(heldWhileAsked, [['a chat is starting in it']])
    assert.deepEqual(await reasons(), [], 'let go once the session is up')

    const rested = new Promise<void>((resolve) => runtime.onSessionIdle(() => resolve()))
    assert.equal((await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'hello' })).ok, true)
    assert.deepEqual(heldWhileAsked[1], ['a turn is starting in it'])
    assert.deepEqual(heldWhileRunning, [[]], 'let go once the turn is live, before the provider runs it')
    await rested

    // Turned away after the folder was asked for: a skill that cannot be loaded.
    const unskilled = await runtime.sendTurn({
      sessionId: started.session.sessionId,
      message: 'use it',
      skills: [{ id: 'missing' }],
    })
    assert.equal(unskilled.ok ? null : unskilled.message, 'No skill named missing.')
    assert.deepEqual(await reasons(), [], 'let go on a refusal after the hold')

    refusal = 'This chat’s worktree could not be brought back.'
    assert.equal((await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'again' })).ok, false)
    assert.deepEqual(await reasons(), [], 'let go when the folder is refused')
    assert.equal(
      (await runtime.startSession({ ...key, agentId: 'other', providerId: 'mock-provider', modelId: 'mock-model' })).ok,
      false,
    )
    assert.deepEqual(await reasons(), [], 'let go when a start is refused')
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('a turn whose folder is being returned waits for the return, then starts', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-chat-folder-'))
  const leases = createWorktreeLeases()
  let asked = 0
  const mock = createMockConversationProvider()
  const runtime = new ConversationRuntime({
    adapters: [{ ...mock, sendTurn: (input) => mock.sendTurn({ ...input, message: '/tools' }) }],
    getProviderById: () => undefined,
    worktreeLeases: leases,
    prepareChatFolder: async () => {
      asked += 1
      return { ok: true }
    },
  })
  try {
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const started = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    const returning = exclusive(await leases.tryExclusive(workspaceRoot, 'the pool is returning this worktree'))
    let sent = false
    const sending = runtime.sendTurn({ sessionId: started.session.sessionId, message: 'hello' }).then((result) => {
      sent = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(sent, false, 'waits while the return runs')
    assert.equal(asked, 1, 'the folder is not asked for under the return')
    returning.release()
    assert.equal((await sending).ok, true)
    assert.equal(asked, 2, 'asked once the return is done, so a slot given back is brought back')
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('a revert holds its folder for its whole length, and waits for a return under way', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-chat-folder-'))
  const leases = createWorktreeLeases()
  const runtime = new ConversationRuntime({ getProviderById: () => undefined, worktreeLeases: leases })
  try {
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const returning = exclusive(await leases.tryExclusive(workspaceRoot, 'the pool is returning this worktree'))
    let done = false
    const reverting = runtime.revertToTurn({ key, turnSeq: 1 }).finally(() => (done = true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(done, false, 'waits while the return runs')
    assert.deepEqual(
      (await leases.holders(workspaceRoot)).map(({ reason, waiting }) => ({ reason, waiting })),
      [
        { reason: 'the pool is returning this worktree', waiting: false },
        { reason: 'its chat is reverting files in it', waiting: true },
      ],
    )
    returning.release()
    await reverting
    assert.deepEqual(await leases.holders(workspaceRoot), [], 'let go when the revert ends')
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('stopping a chat abandons its turn’s wait for the folder, and quitting abandons a start’s', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-chat-folder-'))
  const leases = createWorktreeLeases()
  let asked = 0
  const mock = createMockConversationProvider()
  const runtime = new ConversationRuntime({
    adapters: [{ ...mock, sendTurn: (input) => mock.sendTurn({ ...input, message: '/tools' }) }],
    getProviderById: () => undefined,
    worktreeLeases: leases,
    prepareChatFolder: async () => {
      asked += 1
      return { ok: true }
    },
  })
  try {
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const started = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    const returning = exclusive(await leases.tryExclusive(workspaceRoot, 'the pool is returning this worktree'))
    const sending = runtime.sendTurn({ sessionId: started.session.sessionId, message: 'hello' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal((await runtime.stopSession({ sessionId: started.session.sessionId })).ok, true)
    const sent = await sending
    assert.equal(sent.ok, false)
    assert.match(
      sent.ok ? '' : sent.message,
      /Stopped waiting for the worktree \(the pool is returning this worktree\)/,
    )
    assert.equal(asked, 1, 'the abandoned turn never asked for its folder')

    const starting = runtime.startSession({
      ...key,
      agentId: 'other',
      providerId: 'mock-provider',
      modelId: 'mock-model',
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await runtime.shutdown()
    const start = await starting
    assert.equal(start.ok, false)
    assert.deepEqual(
      (await leases.holders(workspaceRoot)).map(({ waiting }) => waiting),
      [false],
      'only the return is left',
    )
    returning.release()
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('Stop abandons a message waiting for its folder, and deleting a chat abandons its start and revert', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-chat-folder-'))
  const leases = createWorktreeLeases()
  let asked = 0
  const mock = createMockConversationProvider()
  const runtime = new ConversationRuntime({
    adapters: [{ ...mock, sendTurn: (input) => mock.sendTurn({ ...input, message: '/tools' }) }],
    getProviderById: () => undefined,
    worktreeLeases: leases,
    prepareChatFolder: async () => {
      asked += 1
      return { ok: true }
    },
  })
  const pause = () => new Promise((resolve) => setTimeout(resolve, 20))
  try {
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const started = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    const returning = exclusive(await leases.tryExclusive(workspaceRoot, 'the pool is returning this worktree'))

    const sending = runtime.sendTurn({ sessionId: started.session.sessionId, message: 'hello' })
    await pause()
    const interrupted = await runtime.interrupt({ sessionId: started.session.sessionId })
    assert.equal(interrupted.ok, true, 'Stop answers as for a turn it stopped')
    assert.equal((await sending).ok, false)
    assert.equal(asked, 1, 'the abandoned message never asked for its folder')
    assert.equal((await runtime.interrupt({ sessionId: started.session.sessionId })).ok, false, 'nothing left to stop')

    const other = { ...key, agentId: 'other' }
    const starting = runtime.startSession({ ...other, providerId: 'mock-provider', modelId: 'mock-model' })
    await pause()
    assert.equal((await runtime.deleteTranscript(other)).ok, true, 'the delete is not refused by the waiting start')
    assert.equal((await starting).ok, false)

    const reverting = runtime.revertToTurn({ key: other, turnSeq: 1 })
    await pause()
    assert.equal((await runtime.deleteTranscript(other)).ok, true, 'nor by the waiting revert')
    assert.equal((await reverting).ok, false)
    assert.deepEqual(
      (await leases.holders(workspaceRoot)).map(({ waiting }) => waiting),
      [false],
      'only the return is left',
    )
    returning.release()
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
