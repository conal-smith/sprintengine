import { expect, test } from 'vitest'

import type { SettledChatDeletionPlan, SettledChatWorktreePlan } from '../../../shared/ipc/settled-chats'
import { deletionConfirmation, deletionToast } from './settledChatDeletion'

const titles: Record<string, string> = { w1: 'Fix the login banner', w2: 'Tidy the release notes', w3: 'Spike' }
const titleOf = (id: string) => titles[id] ?? id

function worktree(patch: Partial<SettledChatWorktreePlan> = {}): SettledChatWorktreePlan {
  return {
    path: '/Users/dev/.sprintengine-worktrees/app/fix-login',
    name: 'fix-login',
    branch: 'agent/fix-login',
    pooled: false,
    changedPaths: 0,
    unpushedCommits: 0,
    fate: 'remove',
    ...patch,
  }
}

const plan = (workspaceId: string, patch: Partial<SettledChatDeletionPlan> = {}): SettledChatDeletionPlan => ({
  workspaceId,
  remoteMachine: null,
  worktrees: [],
  ...patch,
})

test('one chat: its history goes for good, and its worktree goes with its branch kept and its unpushed commits named', () => {
  const confirmation = deletionConfirmation([plan('w1', { worktrees: [worktree({ unpushedCommits: 2 })] })], titleOf)
  expect(confirmation.title).toBe('Delete “Fix the login banner”?')
  expect(confirmation.confirmLabel).toBe('Delete')
  expect(confirmation.paragraphs).toEqual([
    "Its history is deleted for good. A deleted chat can't be brought back.",
    "Its worktree fix-login is removed. The branch agent/fix-login is kept. Its 2 commits that aren't pushed stay on that branch.",
  ])
})

test('a pool slot goes back to the pool; one with changes is kept, and the dialog says where to deal with them', () => {
  expect(
    deletionConfirmation([plan('w1', { worktrees: [worktree({ pooled: true, name: 'pool-03' })] })], titleOf)
      .paragraphs[1],
  ).toBe('Its worktree pool-03 goes back to the worktree pool. The branch agent/fix-login is kept.')
  const dirty = worktree({ fate: 'keep', keptBecause: 'changes', changedPaths: 4 })
  expect(deletionConfirmation([plan('w1', { worktrees: [dirty] })], titleOf).paragraphs[1]).toBe(
    'Its worktree fix-login is kept: it has 4 uncommitted changes. Commit or discard them, then remove it in Settings ▸ Worktrees.',
  )
  const held = worktree({ fate: 'keep', keptBecause: 'changes', changedPaths: 1, pooled: true, name: 'pool-02' })
  expect(deletionConfirmation([plan('w1', { worktrees: [held] })], titleOf).paragraphs[1]).toBe(
    'Its worktree pool-02 is kept: it has 1 uncommitted change. The pool holds it for you in Settings ▸ Worktrees, to commit or discard them.',
  )
})

test("a paired machine's chat is removed from this computer only, and the dialog says it stays there", () => {
  const confirmation = deletionConfirmation([plan('w1', { remoteMachine: 'mac-mini' })], titleOf)
  expect(confirmation.title).toBe('Remove “Fix the login banner” from this computer?')
  expect(confirmation.confirmLabel).toBe('Remove')
  expect(confirmation.paragraphs[0]).toContain('the chat, its history and its worktree stay on mac-mini')
})

test('many chats: one count, what goes, what stays and why, and the ones that live elsewhere', () => {
  const confirmation = deletionConfirmation(
    [
      plan('w1', { worktrees: [worktree({ unpushedCommits: 1 })] }),
      plan('w2', { worktrees: [worktree({ name: 'pool-04', fate: 'keep', keptBecause: 'changes', changedPaths: 3 })] }),
      plan('w3', { remoteMachine: 'mac-mini' }),
    ],
    titleOf,
    1,
  )
  expect(confirmation.title).toBe('Delete 3 settled chats?')
  expect(confirmation.confirmLabel).toBe('Delete 3 chats')
  expect(confirmation.paragraphs).toEqual([
    "Their history is deleted for good. Deleted chats can't be brought back.",
    "1 worktree is removed or goes back to the pool, and its branch is kept. 1 commit that isn't pushed stays on that branch.",
    'Kept: pool-04 (it has 3 uncommitted changes).',
    '1 of them runs on a paired machine: it is removed from this computer only, and stays on that machine.',
    "1 other chat can't be deleted now and is left as it is.",
  ])
})

test('the toast names what was deleted, and any worktree that stayed, and why', () => {
  expect(deletionToast([{ workspaceId: 'w1', ok: true, worktrees: [] }], titleOf)).toEqual({
    tone: 'good',
    title: 'Deleted “Fix the login banner”',
  })
  expect(
    deletionToast(
      [
        { workspaceId: 'w1', ok: true, worktrees: [] },
        {
          workspaceId: 'w2',
          ok: true,
          worktrees: [
            {
              path: '/p',
              name: 'pool-04',
              branch: null,
              result: 'kept',
              detail: 'It has changes, so the pool holds it for you in Settings ▸ Worktrees.',
            },
          ],
        },
      ],
      titleOf,
    ),
  ).toEqual({
    tone: 'warn',
    title: 'Deleted 2 chats',
    description: 'pool-04 was kept: It has changes, so the pool holds it for you in Settings ▸ Worktrees.',
  })
  expect(
    deletionToast(
      [
        { workspaceId: 'w1', ok: false, message: 'An agent in it is working.' },
        { workspaceId: 'w2', ok: true, worktrees: [] },
      ],
      titleOf,
    ),
  ).toEqual({
    tone: 'error',
    title: '“Fix the login banner” was not deleted',
    description: 'An agent in it is working. 1 other chat was deleted.',
  })
})
