import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

import type { GitWorktreeRestoreInput } from '../../../shared/electron-api'

type FakeWorkspace = {
  id: string
  folderPath: string | null
  worktree: { branch?: string; repoRoot?: string; reclaimedAt?: number } | null
  settledAt?: number | null
  hostId?: string
  environment?: unknown
}

const reclaimed: Array<[string, number | null]> = []
const missing: Array<[string, boolean]> = []
const toasts: Array<{ title: string; description?: string }> = []
const state = {
  workspaces: [] as FakeWorkspace[],
  appSettings: { worktreeBranchPrefix: 'agent' },
  setWorkspaceWorktreeReclaimed: (id: string, at: number | null) => {
    reclaimed.push([id, at])
    const worktree = state.workspaces.find((workspace) => workspace.id === id)?.worktree
    if (worktree && at === null) delete worktree.reclaimedAt
    else if (worktree && at !== null) worktree.reclaimedAt = at
  },
  setFolderMissing: (id: string, value: boolean) => {
    missing.push([id, value])
  },
}

vi.mock('../store/workspaceStore', () => ({ useWorkspaceStore: { getState: () => state } }))
vi.mock('../store/toastStore', () => ({
  showToast: (input: { title: string; description?: string }) => {
    toasts.push(input)
    return 'toast'
  },
}))

const { ensureChatWorktree } = await import('./chatWorktreeRestore')

const CONTAINER = '/Users/dev/.sprintengine-worktrees/app'
const originalWindow = (globalThis as { window?: unknown }).window

type Answer = { ok: boolean; message?: string; definitive?: true } | Error

function stubApi(onDisk: Set<string>, answer: (input: GitWorktreeRestoreInput) => Answer) {
  const restores: GitWorktreeRestoreInput[] = []
  ;(globalThis as { window?: unknown }).window = {
    api: {
      pathExists: async (path: string) => onDisk.has(path),
      restoreGitWorktree: async (input: GitWorktreeRestoreInput) => {
        restores.push(input)
        const result = answer(input)
        if (result instanceof Error) throw result
        if (result.ok) onDisk.add(input.path)
        return result.ok
          ? { ok: true, data: { path: input.path, branch: input.branchName }, message: null }
          : { ok: false, message: result.message ?? 'failed', ...(result.definitive ? { definitive: true } : {}) }
      },
    },
  }
  return restores
}

afterEach(() => {
  ;(globalThis as { window?: unknown }).window = originalWindow
  state.workspaces = []
  state.appSettings.worktreeBranchPrefix = 'agent'
  reclaimed.length = 0
  missing.length = 0
  toasts.length = 0
})

test('opening a chat whose worktree was given back checks it out again, once, before anything runs', async () => {
  state.workspaces = [
    {
      id: 'rested',
      folderPath: `${CONTAINER}/rested`,
      worktree: { branch: 'agent/rested', repoRoot: '/Users/dev/app', reclaimedAt: 5 },
      settledAt: 1,
      hostId: 'wsl:Ubuntu',
    },
  ]
  const restores = stubApi(new Set(), () => ({ ok: true }))

  // The window opening it and every panel asking for its folder share one restore.
  const answers = await Promise.all([ensureChatWorktree('rested'), ensureChatWorktree('rested')])
  assert.deepEqual(answers, [true, true])
  assert.equal(restores.length, 1)
  assert.deepEqual(restores[0], {
    repoRoot: '/Users/dev/app',
    path: `${CONTAINER}/rested`,
    branchName: 'agent/rested',
    copyIncludedFiles: true,
    agentLockOwner: 'agent/rested',
    hostId: 'wsl:Ubuntu',
  })
  assert.deepEqual(reclaimed, [['rested', null]], 'the mark is cleared')
  assert.deepEqual(missing, [['rested', false]])
  assert.equal(toasts.length, 0)

  // Back on disk: the next ask costs no restore.
  assert.equal(await ensureChatWorktree('rested'), true)
  assert.equal(restores.length, 1)
})

test('a worktree that can never come back says why once, drops the mark, and is not asked about again', async () => {
  state.workspaces = [
    {
      id: 'gone',
      folderPath: `${CONTAINER}/gone`,
      worktree: { branch: 'agent/gone', reclaimedAt: 5 },
      settledAt: null,
    },
  ]
  const restores = stubApi(new Set(), () => ({
    ok: false,
    definitive: true,
    message: 'Branch "agent/gone" no longer exists, so the worktree cannot be recreated.',
  }))
  assert.equal(await ensureChatWorktree('gone'), false)
  assert.equal(restores[0].repoRoot, '/Users/dev/app', 'derived from the container when not recorded')
  assert.deepEqual(reclaimed, [['gone', null]])
  assert.deepEqual(missing, [['gone', true]])
  assert.equal(toasts.length, 1)
  assert.match(toasts[0].description ?? '', /no longer exists/)

  // Settled later, it is still a settled agent chat whose folder is gone: every
  // return after that answers quietly, without asking main again.
  state.workspaces[0].settledAt = 2
  assert.equal(await ensureChatWorktree('gone'), false)
  assert.equal(await ensureChatWorktree('gone'), false)
  assert.equal(restores.length, 1)
  assert.equal(toasts.length, 1)
})

test('a restore that fails for now keeps the mark, so the chat tries again on its next return, settled or not', async () => {
  state.workspaces = [
    {
      id: 'unmounted',
      folderPath: `${CONTAINER}/unmounted`,
      worktree: { branch: 'agent/unmounted', reclaimedAt: 5 },
      settledAt: 1,
    },
  ]
  let attempt = 0
  const restores = stubApi(new Set(), () => {
    attempt += 1
    if (attempt === 1) return new Error('git timed out')
    if (attempt === 2) return { ok: false, message: 'Branch "agent/unmounted" is checked out at /Users/dev/other' }
    if (attempt === 3) return { ok: false, message: 'Branch "agent/unmounted" is checked out at /Users/dev/other' }
    return { ok: true }
  })
  assert.equal(await ensureChatWorktree('unmounted'), false)
  assert.equal(state.workspaces[0].worktree?.reclaimedAt, 5, 'the mark stays')
  assert.deepEqual(missing, [['unmounted', true]])

  // Woken (sent to) before the next try: still asked, because it is still marked.
  state.workspaces[0].settledAt = null
  assert.equal(await ensureChatWorktree('unmounted'), false)
  assert.equal(await ensureChatWorktree('unmounted'), false)
  assert.equal(
    toasts.length,
    2,
    'a reason is shown once, however often it is met: the timeout, then the branch held elsewhere',
  )
  assert.equal(await ensureChatWorktree('unmounted'), true)
  assert.equal(restores.length, 4)
  assert.equal(state.workspaces[0].worktree?.reclaimedAt, undefined, 'cleared once it is back')
  assert.deepEqual(missing.at(-1), ['unmounted', false])
})

test('a marked chat asks main even when something is at its path; main says whether it is the worktree', async () => {
  state.workspaces = [
    {
      id: 'squatted',
      folderPath: `${CONTAINER}/squatted`,
      worktree: { branch: 'agent/squatted', reclaimedAt: 5 },
      settledAt: 1,
    },
  ]
  const restores = stubApi(new Set([`${CONTAINER}/squatted`]), () => ({
    ok: false,
    message: `Something else is at ${CONTAINER}/squatted now, so the worktree cannot be recreated there.`,
  }))
  assert.equal(await ensureChatWorktree('squatted'), false)
  assert.equal(restores.length, 1)
  assert.equal(state.workspaces[0].worktree?.reclaimedAt, 5)
  assert.deepEqual(missing, [['squatted', true]])
  assert.match(toasts[0].description ?? '', /Something else is at/)
})

test('a settled agent-branch chat whose folder is gone comes back even without the mark; other chats are left alone', async () => {
  state.workspaces = [
    { id: 'unmarked', folderPath: `${CONTAINER}/unmarked`, worktree: { branch: 'agent/unmarked' }, settledAt: 1 },
    // Not settled and not marked: a folder that went missing is not ours to recreate.
    { id: 'active', folderPath: `${CONTAINER}/active`, worktree: { branch: 'agent/active' }, settledAt: null },
    // Settled, but not on a branch the sweep ever takes: opened from the
    // Worktree manager, or named by hand. Its folder went some other way.
    {
      id: 'opened',
      folderPath: `${CONTAINER}/opened`,
      worktree: { branch: 'sprintengine/opened' },
      settledAt: 1,
    },
    // Settled on the project's own checkout.
    { id: 'in-place', folderPath: '/Users/dev/app', worktree: null, settledAt: 1 },
    // On another machine.
    {
      id: 'ssh',
      folderPath: `${CONTAINER}/ssh`,
      worktree: { branch: 'agent/ssh', reclaimedAt: 5 },
      environment: { kind: 'ssh', id: 'build-box', label: 'build-box' },
    },
  ]
  const restores = stubApi(new Set(), () => ({ ok: true }))
  for (const id of ['active', 'opened', 'in-place', 'ssh', 'nobody']) assert.equal(await ensureChatWorktree(id), true)
  assert.equal(restores.length, 0)
  assert.equal(await ensureChatWorktree('unmarked'), true)
  assert.deepEqual(
    restores.map((input) => input.path),
    [`${CONTAINER}/unmarked`],
  )
})

test('without the mark, a settled chat comes back on the chosen prefix or agent/, and on no other branch', async () => {
  state.appSettings.worktreeBranchPrefix = 'feat'
  state.workspaces = [
    { id: 'feat', folderPath: `${CONTAINER}/feat`, worktree: { branch: 'feat/fix' }, settledAt: 1 },
    { id: 'before', folderPath: `${CONTAINER}/before`, worktree: { branch: 'agent/fix' }, settledAt: 1 },
    { id: 'feature', folderPath: `${CONTAINER}/feature`, worktree: { branch: 'feature/fix' }, settledAt: 1 },
  ]
  const restores = stubApi(new Set(), () => ({ ok: true }))
  for (const id of ['feat', 'before', 'feature']) assert.equal(await ensureChatWorktree(id), true)
  assert.deepEqual(
    restores.map((input) => input.branchName),
    ['feat/fix', 'agent/fix'],
  )
})

test('with no prefix, an unmarked settled chat on an unprefixed branch is not recreated', async () => {
  state.appSettings.worktreeBranchPrefix = ''
  state.workspaces = [
    { id: 'plain', folderPath: `${CONTAINER}/plain`, worktree: { branch: 'chat-ab12' }, settledAt: 1 },
    // The mark is the sweep's own word that it took the worktree: that still brings it back.
    {
      id: 'marked',
      folderPath: `${CONTAINER}/marked`,
      worktree: { branch: 'fix-login', reclaimedAt: 5 },
      settledAt: 1,
    },
  ]
  const restores = stubApi(new Set(), () => ({ ok: true }))
  assert.equal(await ensureChatWorktree('plain'), true)
  assert.equal(await ensureChatWorktree('marked'), true)
  assert.deepEqual(
    restores.map((input) => input.branchName),
    ['fix-login'],
  )
})

test('an unmarked settled chat in a pool slot asks main even with its folder there: the slot may be another chat’s', async () => {
  state.workspaces = [
    { id: 'pooled', folderPath: `${CONTAINER}/pool-03`, worktree: { branch: 'agent/pooled' }, settledAt: 1 },
    { id: 'own', folderPath: `${CONTAINER}/own`, worktree: { branch: 'agent/own' }, settledAt: 1 },
  ]
  const restores = stubApi(new Set([`${CONTAINER}/pool-03`, `${CONTAINER}/own`]), () => ({
    ok: false,
    message: `The worktree this chat used at ${CONTAINER}/pool-03 has since been given to another agent (agent/other).`,
  }))
  assert.equal(await ensureChatWorktree('own'), true)
  assert.equal(restores.length, 0)
  assert.equal(await ensureChatWorktree('pooled'), false)
  assert.deepEqual(
    restores.map((input) => input.path),
    [`${CONTAINER}/pool-03`],
  )
  assert.deepEqual(missing, [['pooled', true]])
})
