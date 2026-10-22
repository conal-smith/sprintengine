import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, test } from 'vitest'

import type { ConversationSessionSummary } from '../shared/conversation-runtime'
import { removeGitWorktree } from './git'
import {
  createSettledChatDeletion,
  type SettledChatDeletionDeps,
  type SettledChatWorktreeOps,
} from './settled-chat-deletion'
import { createSettledChatWorktreeOps } from './settled-chat-worktrees'
import { createWorktreeInventory } from './worktree-pool/worktree-inventory'

/**
 * Deleting a settled chat: what goes (its record, every transcript, its whole
 * history folder with the handoff notes beside the transcripts, the worktree
 * it owns) and what stays (its branch, a worktree with uncommitted changes,
 * one another chat works in, everything of a paired machine's chat but this
 * computer's record). The worktree cases run on a real repository.
 */

const execFileAsync = promisify(execFile)
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8', env })
  return stdout.trim()
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

let scratch = ''
let repo = ''
let container = ''
let stores = ''

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-settled-delete-')))
  const seed = join(scratch, 'seed')
  await mkdir(seed, { recursive: true })
  await git(seed, 'init', '-q', '-b', 'main')
  await writeFile(join(seed, 'README.md'), '# app\n')
  await writeFile(join(seed, '.gitignore'), 'node_modules/\n')
  await git(seed, 'add', '.')
  await git(seed, 'commit', '-q', '-m', 'init')
  await git(scratch, 'clone', '-q', '--bare', seed, join(scratch, 'origin.git'))
  repo = join(scratch, 'app')
  await git(scratch, 'clone', '-q', join(scratch, 'origin.git'), repo)
  container = join(scratch, '.sprintengine-worktrees', 'app')
  await mkdir(container, { recursive: true })
  stores = join(scratch, 'stores')
})

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

async function addWorktree(slug: string): Promise<string> {
  const path = join(container, slug)
  await git(repo, 'worktree', 'add', '-q', '-b', `agent/${slug}`, path, 'origin/main')
  return path
}

type Chat = ReturnType<SettledChatDeletionDeps['listChats']>[number]

function settled(id: string, patch: Partial<Chat> = {}): Chat {
  return {
    id,
    folderPath: repo,
    settledAt: Date.now() - 60_000,
    agents: { 'agent-1': { runtimeKind: 'conversation', execution: { mode: 'local' } } },
    ...patch,
  } as Chat
}

const folderOf = (_root: string, workspaceId: string) => join(stores, 'conversations', workspaceId)

/** A chat's history folder on disk: two transcripts, a tool detail and a handoff note beside them. */
async function writeHistory(workspaceId: string): Promise<string> {
  const folder = folderOf('', workspaceId)
  await mkdir(join(folder, 'handoffs'), { recursive: true })
  await mkdir(join(folder, 'agent-1.tools'), { recursive: true })
  await writeFile(join(folder, 'agent-1.jsonl'), '{}\n')
  await writeFile(join(folder, 'agent-2.jsonl'), '{}\n')
  await writeFile(join(folder, 'agent-1.tools', 'tool-1.json'), '{}')
  await writeFile(join(folder, 'handoffs', 'agent-1-20261021-0942.md'), '# Where we got to\n')
  return folder
}

function realWorktrees(): SettledChatWorktreeOps {
  return createSettledChatWorktreeOps({
    pool: null,
    inventory: createWorktreeInventory({
      pool: null,
      livePaths: () => [],
      knownWorkspaceIds: () => ['still-here'],
      removeWorktree: removeGitWorktree,
    }),
  })
}

function harness(
  chats: Chat[],
  options: { worktrees?: SettledChatWorktreeOps; sessions?: ConversationSessionSummary[] } = {},
) {
  const records = [...chats]
  const calls = { removed: [] as string[], transcripts: [] as string[], folders: [] as string[] }
  const deps: SettledChatDeletionDeps = {
    listChats: () => records,
    removeChat: (workspaceId) => {
      const index = records.findIndex((chat) => chat.id === workspaceId)
      if (index === -1) return { ok: false, message: 'unknown' }
      records.splice(index, 1)
      calls.removed.push(workspaceId)
      return { ok: true }
    },
    conversations: {
      listSessions: ({ workspaceId }) => ({
        ok: true,
        sessions: (options.sessions ?? []).filter((session) => session.workspaceId === workspaceId),
      }),
      // `agent-2` was taken off the chat's layout; its transcript is on disk all the same.
      listThreads: async () => ({ ok: true, threads: [{ agentId: 'agent-1' }, { agentId: 'agent-2' }] }),
      deleteTranscript: async ({ workspaceId, agentId }) => {
        calls.transcripts.push(`${workspaceId}/${agentId}`)
        await rm(join(folderOf('', workspaceId), `${agentId}.jsonl`), { force: true })
        return { ok: true }
      },
    },
    conversationFolder: folderOf,
    removeConversationStorage: async (_root, path) => {
      calls.folders.push(path)
      await rm(path, { recursive: true, force: true })
    },
    worktrees: options.worktrees ?? realWorktrees(),
  }
  return { deletion: createSettledChatDeletion(deps), records, calls }
}

test('deleting one settled chat takes its record, every transcript and its whole history folder, handoffs included', async () => {
  const folder = await writeHistory('one')
  const other = await writeHistory('still-here')
  const { deletion, records, calls } = harness([settled('one'), settled('still-here', { settledAt: undefined })])

  const [outcome] = await deletion.delete(['one'])

  assert.deepEqual(outcome, { workspaceId: 'one', ok: true, worktrees: [] })
  assert.deepEqual(calls.transcripts, ['one/agent-1', 'one/agent-2'])
  assert.deepEqual(calls.removed, ['one'])
  assert.equal(await exists(folder), false, 'the history folder is gone')
  assert.equal(await exists(join(folder, 'handoffs')), false, 'with the handoff notes in it')
  assert.deepEqual(
    records.map((chat) => chat.id),
    ['still-here'],
  )
  assert.ok(await exists(join(other, 'handoffs', 'agent-1-20261021-0942.md')), "another chat's history is untouched")
})

test('several chats delete in one call; one that is not settled, or is working, is refused and kept', async () => {
  await writeHistory('a')
  await writeHistory('b')
  const working = {
    sessionId: 's1',
    workspaceId: 'busy',
    agentId: 'agent-1',
    status: 'active',
    phase: 'running',
  } as unknown as ConversationSessionSummary
  const { deletion, records } = harness(
    [settled('a'), settled('b'), settled('live', { settledAt: undefined }), settled('busy')],
    { sessions: [working] },
  )

  const plans = await deletion.plan(['a', 'b', 'live', 'busy'])
  assert.deepEqual(
    plans.map((plan) => [plan.workspaceId, plan.refused ?? null]),
    [
      ['a', null],
      ['b', null],
      ['live', 'Only a settled chat can be deleted. Settle it first.'],
      ['busy', 'An agent in it is working.'],
    ],
  )

  const outcomes = await deletion.delete(['a', 'b', 'live', 'busy'])
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.workspaceId, outcome.ok]),
    [
      ['a', true],
      ['b', true],
      ['live', false],
      ['busy', false],
    ],
  )
  assert.deepEqual(
    records.map((chat) => chat.id),
    ['live', 'busy'],
  )
})

test('a history that will not delete keeps the record, so the chat can be deleted again', async () => {
  const records = [settled('stuck')]
  const deletion = createSettledChatDeletion({
    listChats: () => records,
    removeChat: () => {
      throw new Error('the record must stay')
    },
    conversations: {
      listSessions: () => ({ ok: true, sessions: [] }),
      listThreads: async () => ({ ok: true, threads: [] }),
      // The runtime refusing, as it does while the chat's files are being reverted.
      deleteTranscript: async () => ({ ok: false, message: 'Workspace files are being reverted.' }),
    },
    conversationFolder: folderOf,
    removeConversationStorage: async () => {
      throw new Error('the folder must stay')
    },
    worktrees: realWorktrees(),
  })

  const [outcome] = await deletion.delete(['stuck'])
  assert.deepEqual(outcome, {
    workspaceId: 'stuck',
    ok: false,
    message: 'Its history was not deleted: Workspace files are being reverted.',
  })
  assert.deepEqual(
    records.map((chat) => chat.id),
    ['stuck'],
  )
})

test('a clean worktree the chat owns is removed and its branch kept; its unpushed commits are counted first', async () => {
  const path = await addWorktree('clean-chat')
  await writeFile(join(path, 'feature.txt'), 'done\n')
  await git(path, 'add', '.')
  await git(path, 'commit', '-q', '-m', 'feature')
  const chat = settled('clean-chat', { folderPath: path, worktree: { branch: 'agent/clean-chat', repoRoot: repo } })
  const { deletion } = harness([chat, settled('still-here', { settledAt: undefined })])

  const [plan] = await deletion.plan(['clean-chat'])
  assert.deepEqual(plan.worktrees, [
    {
      path,
      name: 'clean-chat',
      branch: 'agent/clean-chat',
      pooled: false,
      changedPaths: 0,
      unpushedCommits: 1,
      fate: 'remove',
    },
  ])

  const [outcome] = await deletion.delete(['clean-chat'])
  assert.ok(outcome.ok)
  assert.deepEqual(outcome.worktrees, [{ path, name: 'clean-chat', branch: 'agent/clean-chat', result: 'removed' }])
  assert.equal(await exists(path), false, 'the folder is gone')
  assert.equal(await git(repo, 'branch', '--list', 'agent/clean-chat'), 'agent/clean-chat', 'the branch is kept')
  assert.equal(await git(repo, 'log', '-1', '--format=%s', 'agent/clean-chat'), 'feature', 'with its commit')
})

test('a worktree with uncommitted changes is never removed: the plan says so, and the delete keeps it', async () => {
  const path = await addWorktree('dirty-chat')
  await writeFile(join(path, 'notes.txt'), 'half a thought\n')
  await writeFile(join(path, 'README.md'), '# app, edited\n')
  const chat = settled('dirty-chat', { folderPath: path, worktree: { branch: 'agent/dirty-chat', repoRoot: repo } })
  const { deletion, records } = harness([chat])

  const [plan] = await deletion.plan(['dirty-chat'])
  assert.equal(plan.worktrees[0].fate, 'keep')
  assert.equal(plan.worktrees[0].keptBecause, 'changes')
  assert.equal(plan.worktrees[0].changedPaths, 2)

  const [outcome] = await deletion.delete(['dirty-chat'])
  assert.ok(outcome.ok, 'the chat itself is deleted')
  assert.equal(outcome.worktrees[0].result, 'kept')
  assert.deepEqual(records, [])
  assert.ok(await exists(join(path, 'notes.txt')), 'the uncommitted work is where it was')
})

test('a worktree written to after the confirmation is kept by the removal itself', async () => {
  const path = await addWorktree('late-edit')
  const chat = settled('late-edit', { folderPath: path, worktree: { branch: 'agent/late-edit', repoRoot: repo } })
  const ops = realWorktrees()
  // The plan reads it clean; by the delete, someone has written to it.
  let reads = 0
  const racing: SettledChatWorktreeOps = {
    ...ops,
    inspect: async (worktreePath) => {
      reads += 1
      if (reads === 2) await writeFile(join(worktreePath, 'late.txt'), 'written while the dialog was open\n')
      return reads === 2
        ? { branch: 'agent/late-edit', changedPaths: 0, unpushedCommits: 0 }
        : ops.inspect(worktreePath)
    },
  }
  const { deletion } = harness([chat], { worktrees: racing })
  assert.equal((await deletion.plan(['late-edit']))[0].worktrees[0].fate, 'remove')
  const [outcome] = await deletion.delete(['late-edit'])
  assert.ok(outcome.ok)
  assert.equal(outcome.worktrees[0].result, 'kept')
  assert.match(outcome.worktrees[0].detail ?? '', /uncommitted changes/)
  assert.ok(await exists(join(path, 'late.txt')))
})

test('a worktree another chat works in, or one Studio did not make, is kept', async () => {
  const shared = await addWorktree('shared-chat')
  const handMade = join(scratch, 'hand-made')
  await git(repo, 'worktree', 'add', '-q', '-b', 'mine', handMade, 'origin/main')
  const { deletion } = harness([
    settled('shared-chat', { folderPath: shared, worktree: { branch: 'agent/shared-chat', repoRoot: repo } }),
    settled('neighbour', { folderPath: shared, settledAt: undefined }),
    settled('by-hand', { folderPath: handMade, worktree: { branch: 'mine' } }),
  ])

  const plans = await deletion.plan(['shared-chat', 'by-hand'])
  assert.deepEqual(
    plans.map((plan) => plan.worktrees.map((worktree) => [worktree.fate, worktree.keptBecause])),
    [[['keep', 'shared']], [['keep', 'not-made-here']]],
  )
  await deletion.delete(['shared-chat', 'by-hand'])
  assert.ok(await exists(shared))
  assert.ok(await exists(handMade))
})

test('two chats deleted together on one worktree do not keep it for each other', async () => {
  const path = await addWorktree('pair')
  const { deletion } = harness([
    settled('first', { folderPath: path, worktree: { branch: 'agent/pair', repoRoot: repo } }),
    settled('second', { folderPath: path }),
  ])
  const [plan] = await deletion.plan(['first', 'second'])
  assert.equal(plan.worktrees[0].fate, 'remove')
})

test('a pool slot goes back to the pool, and one with changes is held there for a person', async () => {
  const released: string[] = []
  const pool: SettledChatWorktreeOps = {
    isPoolSlot: async () => true,
    exists: async () => true,
    inspect: async (path) => ({
      branch: `agent/${path.split('/').at(-1)}`,
      changedPaths: path.endsWith('pool-02') ? 3 : 0,
      unpushedCommits: 0,
    }),
    releaseSlot: async (path) => {
      released.push(path)
      return path.endsWith('pool-02')
        ? { result: 'kept', detail: 'It has changes, so the pool holds it for you in Settings ▸ Worktrees.' }
        : { result: 'returned' }
    },
    removeWorktree: async () => {
      throw new Error('a slot is never removed outside the pool')
    },
  }
  const slots = ['/Users/dev/.sprintengine-worktrees/app/pool-01', '/Users/dev/.sprintengine-worktrees/app/pool-02']
  const { deletion } = harness(
    slots.map((path, index) => settled(`slot-${index}`, { folderPath: path, worktree: { branch: 'agent/x' } })),
    { worktrees: pool },
  )

  const plans = await deletion.plan(['slot-0', 'slot-1'])
  assert.deepEqual(
    plans.map((plan) => [plan.worktrees[0].pooled, plan.worktrees[0].fate, plan.worktrees[0].keptBecause ?? null]),
    [
      [true, 'remove', null],
      [true, 'keep', 'changes'],
    ],
  )
  const outcomes = await deletion.delete(['slot-0', 'slot-1'])
  assert.deepEqual(released, slots, 'both are given back; the pool decides to hold the one with changes')
  assert.deepEqual(
    outcomes.map((outcome) => (outcome.ok ? outcome.worktrees[0].result : null)),
    ['returned', 'kept'],
  )
})

test("a paired machine's chat loses this computer's record and nothing else", async () => {
  const touched: string[] = []
  const untouchable: SettledChatWorktreeOps = {
    isPoolSlot: async () => (touched.push('pool'), false),
    exists: async () => (touched.push('exists'), true),
    inspect: async () => (touched.push('inspect'), null),
    releaseSlot: async () => (touched.push('release'), { result: 'returned' }),
    removeWorktree: async () => (touched.push('remove'), { ok: true }),
  }
  const remote = settled('remote', {
    folderPath: '/Users/dev/app',
    worktree: { branch: 'agent/remote' },
    remoteOrigin: {
      connectionId: 'c1',
      machineName: 'mac-mini',
      workspaceId: 'remote-w',
      workspaceName: 'Fix the login banner',
      workspaceRoot: '/Users/dev/app',
    },
  })
  const { deletion, calls, records } = harness([remote], { worktrees: untouchable })

  const [plan] = await deletion.plan(['remote'])
  assert.deepEqual(plan, { workspaceId: 'remote', remoteMachine: 'mac-mini', worktrees: [] })

  const [outcome] = await deletion.delete(['remote'])
  assert.deepEqual(outcome, { workspaceId: 'remote', ok: true, worktrees: [] })
  assert.deepEqual(records, [])
  assert.deepEqual(calls.transcripts, [], 'its history is on mac-mini')
  assert.deepEqual(calls.folders, [])
  assert.deepEqual(touched, [], 'its worktree is on mac-mini')
})
