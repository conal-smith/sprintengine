import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { GitWorktreeRestoreInput, GitWorktreeRestoreResult } from '../../shared/ipc/git'
import { createChatFolderGuard, type GuardedChat } from './chat-folder-guard'

const SLOT = '/Users/dev/.sprintengine-worktrees/app/app-01'

function harness(options: { awaits?: boolean; chat?: GuardedChat | null; restore?: GitWorktreeRestoreResult } = {}) {
  const restores: GitWorktreeRestoreInput[] = []
  const asked: Array<[string, string]> = []
  const guard = createChatFolderGuard({
    pool: () => ({
      load: async () => {},
      awaitsChat: (path, branch) => {
        asked.push([path, branch])
        return options.awaits ?? true
      },
    }),
    chat: () =>
      options.chat === undefined
        ? { folderPath: SLOT, worktree: { branch: 'agent/chat', repoRoot: '/Users/dev/app' } }
        : options.chat,
    restore: async (input) => {
      restores.push(input)
      return options.restore ?? { ok: true, data: {} as never, message: null }
    },
  })
  return { guard, restores, asked }
}

test('a chat whose slot was given back has its branch checked out at its own folder before an agent runs', async () => {
  const { guard, restores } = harness()
  assert.deepEqual(await guard({ workspaceId: 'ws-1', workspaceRoot: SLOT }), { ok: true })
  assert.deepEqual(restores, [
    {
      repoRoot: '/Users/dev/app',
      path: SLOT,
      branchName: 'agent/chat',
      copyIncludedFiles: true,
      agentLockOwner: 'agent/chat',
    },
  ])
})

test('a chat whose worktree is where it should be costs a look in memory and nothing else', async () => {
  const { guard, restores, asked } = harness({ awaits: false })
  assert.deepEqual(await guard({ workspaceId: 'ws-1', workspaceRoot: SLOT }), { ok: true })
  assert.deepEqual(asked, [[SLOT, 'agent/chat']])
  assert.deepEqual(restores, [])
})

test('only a worktree chat running in its own folder on this machine is brought back', async () => {
  for (const chat of [
    null,
    { folderPath: SLOT, worktree: null },
    { folderPath: SLOT, worktree: { branch: 'agent/chat' }, environment: { kind: 'ssh' } },
    { folderPath: SLOT, worktree: { branch: 'agent/chat' }, remoteOrigin: { peerId: 'mac-mini' } },
  ]) {
    const { guard, restores, asked } = harness({ chat })
    assert.deepEqual(await guard({ workspaceId: 'ws-1', workspaceRoot: SLOT }), { ok: true })
    assert.deepEqual(restores, [])
    assert.deepEqual(asked, [])
  }
  // A run's own worktree, not the chat's folder.
  const { guard, asked } = harness()
  assert.deepEqual(await guard({ workspaceId: 'ws-1', workspaceRoot: '/Users/dev/run-worktree' }), { ok: true })
  assert.deepEqual(asked, [])
})

test('a worktree that cannot come back refuses the turn with the reason', async () => {
  const { guard } = harness({
    restore: { ok: false, message: 'The worktree this chat used has since been given to another agent.' },
  })
  const answer = await guard({ workspaceId: 'ws-1', workspaceRoot: SLOT })
  assert.equal(answer.ok, false)
  assert.match(answer.ok ? '' : answer.message, /could not be brought back: The worktree this chat used has since/)
  const thrown = createChatFolderGuard({
    pool: () => ({ load: async () => {}, awaitsChat: () => true }),
    chat: () => ({ folderPath: SLOT, worktree: { branch: 'agent/chat' } }),
    restore: async () => {
      throw new Error('git exploded')
    },
  })
  const failed = await thrown({ workspaceId: 'ws-1', workspaceRoot: SLOT })
  assert.match(failed.ok ? '' : failed.message, /git exploded/)
})
