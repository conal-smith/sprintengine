import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

type FakeAgent = { chatPendingWorktree?: { name: string; projectFolder: string; failure?: string } }
type FakeWorkspace = { id: string; folderPath: string | null; worktree: unknown; agents: Record<string, FakeAgent> }

const writes: string[] = []
const state = {
  workspaces: [] as FakeWorkspace[],
  appSettings: { worktreeBranchPrefix: 'agent' },
  updateAgent: (workspaceId: string, agentId: string, patch: Partial<FakeAgent>) => {
    const agent = state.workspaces.find((workspace) => workspace.id === workspaceId)!.agents[agentId]!
    Object.assign(agent, patch)
    if ('chatPendingWorktree' in patch && patch.chatPendingWorktree === undefined) delete agent.chatPendingWorktree
    writes.push(`agent:${patch.chatPendingWorktree?.failure ?? (patch.chatPendingWorktree ? 'pending' : 'cleared')}`)
  },
  setWorkspaceChatFolder: (id: string, folderPath: string, worktree: unknown) => {
    const workspace = state.workspaces.find((candidate) => candidate.id === id)!
    workspace.folderPath = folderPath
    workspace.worktree = worktree
    writes.push(`folder:${folderPath}`)
  },
}

vi.mock('../store/workspaceStore', () => ({ useWorkspaceStore: { getState: () => state } }))
vi.mock('./diagnostics', () => ({ publishDiagnosticSync: () => undefined }))

const {
  newChatWorktreeAttemptRunning,
  pendingNewChatWorktreeFailure,
  prepareNewChatWorktree,
  startPendingNewChatInProject,
} = await import('./newChatWorktree')

const PROJECT = '/Users/dev/app'
const originalWindow = (globalThis as { window?: unknown }).window

function pendingChat(failure?: string): FakeWorkspace {
  return {
    id: 'chat',
    folderPath: null,
    worktree: { repoRoot: PROJECT },
    agents: { agent: { chatPendingWorktree: { name: '', projectFolder: PROJECT, ...(failure ? { failure } : {}) } } },
  }
}

const givenBack: unknown[] = []

function stubWorktree(answer: () => Promise<unknown>) {
  ;(globalThis as { window?: unknown }).window = {
    api: {
      getGitRepoRoot: async () => PROJECT,
      createGitWorktree: answer,
      worktreePoolAction: async (input: unknown) => {
        givenBack.push({ pool: input })
        return { ok: true, message: null }
      },
      removeGitWorktree: async (input: unknown) => {
        givenBack.push({ removed: input })
        return { ok: true, data: {}, message: null }
      },
    },
  }
}

/** An attempt whose worktree lands when the test says, with the answer it is given. */
function heldWorktree() {
  let land: (value: unknown) => void = () => undefined
  stubWorktree(() => new Promise((resolve) => (land = resolve)))
  return {
    land: async (value: unknown) => {
      // The attempt reaches the worktree call after its repository lookup.
      await new Promise((resolve) => setTimeout(resolve, 0))
      land(value)
    },
  }
}

afterEach(() => {
  ;(globalThis as { window?: unknown }).window = originalWindow
  state.workspaces = []
  writes.length = 0
  givenBack.length = 0
})

test('the folder lands before the wait is cleared, so the chat is never folderless and ungated', async () => {
  state.workspaces = [pendingChat()]
  stubWorktree(async () => ({ ok: true, data: { path: `${PROJECT}-wt`, branch: 'agent/chat-1', baseRef: 'main' } }))
  assert.equal(await prepareNewChatWorktree('chat'), true)
  assert.deepEqual(writes, [`folder:${PROJECT}-wt`, 'agent:cleared'])
  assert.equal(newChatWorktreeAttemptRunning('chat'), false)
})

test('a failure is written onto the chat, and a retry clears it before trying again', async () => {
  state.workspaces = [pendingChat()]
  stubWorktree(async () => ({ ok: false, message: 'Could not fetch origin.' }))
  assert.equal(await prepareNewChatWorktree('chat'), false)
  const pending = state.workspaces[0]!.agents.agent!.chatPendingWorktree!
  assert.equal(pendingNewChatWorktreeFailure('chat', pending), 'Could not fetch origin.')

  stubWorktree(async () => ({ ok: true, data: { path: `${PROJECT}-wt`, branch: 'agent/chat-2', baseRef: 'main' } }))
  writes.length = 0
  const retry = prepareNewChatWorktree('chat')
  assert.equal(
    pendingNewChatWorktreeFailure('chat', state.workspaces[0]!.agents.agent!.chatPendingWorktree!),
    null,
    'preparing again while the retry runs',
  )
  assert.equal(await retry, true)
  assert.deepEqual(writes, ['agent:pending', `folder:${PROJECT}-wt`, 'agent:cleared'])
})

test('a chat pending with no attempt in this window reads as failed, never as preparing', () => {
  assert.equal(
    pendingNewChatWorktreeFailure('chat', { name: '', projectFolder: PROJECT }),
    'Studio closed before this chat’s worktree was made.',
  )
})

test('Start in the project goes ahead while an attempt runs, and the worktree it lands with goes back to the pool', async () => {
  state.workspaces = [pendingChat()]
  const worktree = heldWorktree()
  const attempt = prepareNewChatWorktree('chat')
  assert.equal(startPendingNewChatInProject('chat'), true, 'not held up by the attempt')
  assert.equal(state.workspaces[0]!.folderPath, PROJECT)
  assert.equal(state.workspaces[0]!.worktree, null)

  writes.length = 0
  await worktree.land({
    ok: true,
    data: { path: `${PROJECT}-wt`, branch: 'agent/chat-1', baseRef: 'main', leaseId: 'lease-1' },
  })
  assert.equal(await attempt, false)
  assert.deepEqual(writes, [], 'the chat stays in the project')
  assert.deepEqual(givenBack, [{ pool: { kind: 'release', leaseId: 'lease-1' } }])

  // A retry asked of it afterwards (another window's button, say) has nothing left to make.
  stubWorktree(async () => ({ ok: true, data: { path: `${PROJECT}-wt2`, branch: 'agent/chat-2', baseRef: 'main' } }))
  assert.equal(await prepareNewChatWorktree('chat'), false, 'nothing pending: nothing made')
  assert.deepEqual(writes, [])
})

test('a fresh worktree made for a chat closed while it was being made is removed, with the checks a removal makes', async () => {
  state.workspaces = [pendingChat()]
  const worktree = heldWorktree()
  const attempt = prepareNewChatWorktree('chat')
  state.workspaces = []
  await worktree.land({
    ok: true,
    data: { path: `${PROJECT}-wt`, branch: 'agent/chat-1', baseRef: 'main', leaseId: null },
  })
  assert.equal(await attempt, false)
  assert.deepEqual(givenBack, [{ removed: { repoRoot: PROJECT, path: `${PROJECT}-wt` } }], 'not forced')
})

test('a worktree another machine made for a closed chat is left to the sweep there', async () => {
  const chat = pendingChat()
  chat.agents.agent!.chatPendingWorktree = { name: '', projectFolder: PROJECT, hostId: 'wsl:Ubuntu' } as never
  state.workspaces = [chat]
  const worktree = heldWorktree()
  const attempt = prepareNewChatWorktree('chat')
  state.workspaces = []
  await worktree.land({ ok: true, data: { path: '/home/dev/app-wt', branch: 'agent/chat-1', baseRef: 'main' } })
  assert.equal(await attempt, false)
  assert.deepEqual(givenBack, [])
})

test('a worktree that could not be made leaves nothing to give back', async () => {
  state.workspaces = [pendingChat()]
  const worktree = heldWorktree()
  const attempt = prepareNewChatWorktree('chat')
  state.workspaces = []
  await worktree.land({ ok: false, message: 'Could not fetch origin.' })
  assert.equal(await attempt, false)
  assert.deepEqual(givenBack, [])
})
