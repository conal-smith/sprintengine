import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

import type { GitWorktreeCreateInput } from '../../../shared/electron-api'

type FakeAgent = { chatPendingWorktree?: { name: string; projectFolder: string; failure?: string } }
type FakeWorkspace = { id: string; folderPath: string | null; worktree: unknown; agents: Record<string, FakeAgent> }

const state = {
  workspaces: [] as FakeWorkspace[],
  updateAgent: (workspaceId: string, agentId: string, patch: Partial<FakeAgent>) => {
    const agent = state.workspaces.find((workspace) => workspace.id === workspaceId)!.agents[agentId]!
    Object.assign(agent, patch)
    if ('chatPendingWorktree' in patch && patch.chatPendingWorktree === undefined) delete agent.chatPendingWorktree
  },
  setWorkspaceChatFolder: (id: string, folderPath: string, worktree: unknown) => {
    const workspace = state.workspaces.find((candidate) => candidate.id === id)!
    workspace.folderPath = folderPath
    workspace.worktree = worktree
  },
}

const diagnostics: string[] = []
vi.mock('../store/workspaceStore', () => ({ useWorkspaceStore: { getState: () => state } }))
vi.mock('./diagnostics', () => ({
  publishDiagnosticSync: (input: { title: string }) => {
    diagnostics.push(input.title)
  },
}))

const {
  NEW_CHAT_RESERVATION_FRESH_MS,
  hasNewChatWorktreeReservation,
  newChatWorktreeBranch,
  obtainNewChatWorktree,
  prepareNewChatWorktree,
  releaseNewChatWorktreeReservation,
  reserveNewChatWorktree,
  takeReadyNewChatWorktree,
} = await import('./newChatWorktree')

const originalWindow = (globalThis as { window?: unknown }).window
const owners = new Set<string>()

type Answer = { ok: true } | { ok: false; message: string }

/** A pool that answers each lease when told to, numbering its leases. */
function stubPool(options: { answer?: 'now' | 'later'; fail?: boolean } = {}) {
  const creates: GitWorktreeCreateInput[] = []
  const released: string[] = []
  const settles: Array<(answer?: Answer) => void> = []
  ;(globalThis as { window?: unknown }).window = {
    api: {
      getGitRepoRoot: async (folder: string) => folder,
      createGitWorktree: (input: GitWorktreeCreateInput) => {
        creates.push(input)
        const leaseId = `lease-${creates.length}`
        const answer = (result: Answer = options.fail ? { ok: false, message: 'fetch failed' } : { ok: true }) =>
          result.ok
            ? { ok: true, data: { path: `/pool/${leaseId}`, branch: input.branchName, baseRef: 'main', leaseId } }
            : result
        if (options.answer === 'later')
          return new Promise((resolve) => settles.push((result) => resolve(answer(result))))
        return Promise.resolve(answer())
      },
      worktreePoolAction: async (input: { kind: string; leaseId: string }) => {
        released.push(input.leaseId)
        return { ok: true, message: null }
      },
    },
  }
  return { creates, released, settles }
}

function reserve(owner: string, folder: string, hostId?: string | null) {
  owners.add(owner)
  reserveNewChatWorktree(owner, folder, hostId as never)
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(async () => {
  vi.useRealTimers()
  for (const owner of owners) releaseNewChatWorktreeReservation(owner)
  owners.clear()
  await flush()
  ;(globalThis as { window?: unknown }).window = originalWindow
  state.workspaces = []
  diagnostics.length = 0
})

test('a worktree reserved while New chat is open is taken by the chat Enter starts, once', async () => {
  const pool = stubPool()
  reserve('door', '/Users/dev/app')
  await flush()
  assert.equal(pool.creates.length, 1, 'made at once, before any Enter')
  assert.equal(pool.creates[0]?.quietInstall, true, 'its install is the chat’s to show, not a toast')
  assert.match(pool.creates[0]!.branchName, /^agent\//u)

  const taken = takeReadyNewChatWorktree('/Users/dev/app', '', null)
  assert.equal(taken?.folderPath, '/pool/lease-1')
  assert.equal(hasNewChatWorktreeReservation('door'), false, 'it is the chat’s now')
  assert.equal(takeReadyNewChatWorktree('/Users/dev/app', '', null), null, 'a second chat does not get it too')
  releaseNewChatWorktreeReservation('door')
  await flush()
  assert.deepEqual(pool.released, [], 'what a chat took is never given back from under it')
})

test('Enter before the reservation is made waits on it rather than making a second worktree', async () => {
  const pool = stubPool({ answer: 'later' })
  reserve('door', '/Users/dev/app')
  await flush()
  assert.equal(takeReadyNewChatWorktree('/Users/dev/app', '', null), null, 'not made yet')
  const branches: string[] = []
  const obtained = obtainNewChatWorktree('/Users/dev/app', '', null, { onBranch: (branch) => branches.push(branch) })
  pool.settles[0]!()
  const made = await obtained
  assert.equal(made.ok && made.folderPath, '/pool/lease-1')
  assert.equal(pool.creates.length, 1)
  assert.deepEqual(branches, [pool.creates[0]!.branchName], 'the chat learns the branch it is being made on')
})

test('a named worktree, another project or another machine is made on Enter, and the reservation stays', async () => {
  const pool = stubPool()
  reserve('door', '/Users/dev/app')
  await flush()
  assert.equal(takeReadyNewChatWorktree('/Users/dev/app', 'fix-login', null), null, 'a name is its own branch')
  assert.equal(takeReadyNewChatWorktree('/Users/dev/other', '', null), null)
  assert.equal(takeReadyNewChatWorktree('/Users/dev/app', '', 'wsl:Ubuntu'), null)
  assert.equal(hasNewChatWorktreeReservation('door'), true)
  const named = await obtainNewChatWorktree('/Users/dev/app', 'fix-login', null)
  assert.equal(named.ok, true)
  assert.equal(pool.creates.at(-1)?.branchName, 'agent/fix-login')
  assert.equal(pool.creates.length, 2)
})

test('turning Worktree off, or moving to another project, gives the reserved slot back to the pool', async () => {
  const pool = stubPool()
  reserve('door', '/Users/dev/app')
  await flush()
  reserve('door', '/Users/dev/app')
  await flush()
  assert.equal(pool.creates.length, 1, 'asking again for the same project keeps the one made')
  reserve('door', '/Users/dev/other')
  await flush()
  assert.deepEqual(pool.released, ['lease-1'], 'the first project’s slot goes back')
  assert.equal(pool.creates.length, 2)
  releaseNewChatWorktreeReservation('door')
  await flush()
  assert.deepEqual(pool.released, ['lease-1', 'lease-2'])
})

test('a reservation given back while it is still being made goes back once it lands', async () => {
  const pool = stubPool({ answer: 'later' })
  reserve('door', '/Users/dev/app')
  await flush()
  releaseNewChatWorktreeReservation('door')
  assert.deepEqual(pool.released, [])
  pool.settles[0]!()
  await flush()
  assert.deepEqual(pool.released, ['lease-1'])
})

test('closing New chat keeps the reservation a moment for the Enter that closed it', async () => {
  vi.useFakeTimers()
  const pool = stubPool()
  reserve('door', '/Users/dev/app')
  await vi.advanceTimersByTimeAsync(0)
  releaseNewChatWorktreeReservation('door', 10_000)
  const taken = takeReadyNewChatWorktree('/Users/dev/app', '', null)
  assert.equal(taken?.folderPath, '/pool/lease-1')
  await vi.advanceTimersByTimeAsync(10_000)
  assert.deepEqual(pool.released, [], 'taken within the grace, so nothing goes back')

  reserve('door-2', '/Users/dev/app')
  await vi.advanceTimersByTimeAsync(0)
  releaseNewChatWorktreeReservation('door-2', 10_000)
  await vi.advanceTimersByTimeAsync(10_000)
  assert.deepEqual(pool.released, ['lease-2'], 'nobody took it: back to the pool')
})

test('a reservation older than its freshness is given back, and the chat gets a fresh one', async () => {
  vi.useFakeTimers()
  const pool = stubPool()
  reserve('door', '/Users/dev/app')
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(NEW_CHAT_RESERVATION_FRESH_MS + 1)
  assert.equal(takeReadyNewChatWorktree('/Users/dev/app', '', null), null)
  await vi.advanceTimersByTimeAsync(0)
  assert.deepEqual(pool.released, ['lease-1'])
  const made = await obtainNewChatWorktree('/Users/dev/app', '', null)
  assert.equal(made.ok && made.folderPath, '/pool/lease-2')
})

test('a reservation that could not be made says nothing and is not asked for again there', async () => {
  const pool = stubPool({ fail: true })
  reserve('door', '/Users/dev/app')
  await flush()
  assert.deepEqual(diagnostics, [], 'nobody asked for it yet')
  assert.equal(hasNewChatWorktreeReservation('door'), false)
  reserve('door', '/Users/dev/app')
  await flush()
  assert.equal(pool.creates.length, 1, 'not retried on every render')
  // Enter makes it itself, and says why when it fails.
  const made = await obtainNewChatWorktree('/Users/dev/app', '', null)
  assert.equal(made.ok, false)
  assert.deepEqual(diagnostics, ['Worktree failed'])
  // Turned off and on again: tried afresh.
  releaseNewChatWorktreeReservation('door')
  reserve('door', '/Users/dev/app')
  await flush()
  assert.equal(pool.creates.length, 3)
})

test('only this computer’s worktree is reserved', async () => {
  const pool = stubPool()
  reserve('door', '/Users/dev/app', 'wsl:Ubuntu')
  await flush()
  assert.equal(pool.creates.length, 0)
  reserve('door', '/Users/dev/app', 'local')
  await flush()
  assert.equal(pool.creates.length, 1)
})

test('a pending chat takes the reservation and its attempt names the branch it is on', async () => {
  const pool = stubPool({ answer: 'later' })
  reserve('door', '/Users/dev/app')
  await flush()
  state.workspaces = [
    {
      id: 'chat',
      folderPath: null,
      worktree: { repoRoot: '/Users/dev/app' },
      agents: { agent: { chatPendingWorktree: { name: '', projectFolder: '/Users/dev/app' } } },
    },
  ]
  const attempt = prepareNewChatWorktree('chat')
  await flush()
  assert.equal(newChatWorktreeBranch('chat'), pool.creates[0]!.branchName)
  pool.settles[0]!()
  assert.equal(await attempt, true)
  assert.equal(state.workspaces[0]!.folderPath, '/pool/lease-1')
  assert.equal(pool.creates.length, 1, 'the reservation, not a second worktree')
  assert.equal(newChatWorktreeBranch('chat'), null, 'the attempt is over')
})
