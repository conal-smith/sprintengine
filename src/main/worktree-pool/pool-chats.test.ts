import assert from 'node:assert/strict'
import { test } from 'vitest'

import { markChatsReclaimed, poolChatsOf } from './pool-chats'

type Records = Parameters<typeof poolChatsOf>[0]['workspaces']

const CONTAINER = '/Users/dev/.sprintengine-worktrees/app'

function chat(id: string, patch: Partial<Records[number]> = {}): Records[number] {
  const base: Records[number] = {
    id,
    folderPath: `${CONTAINER}/${id}`,
    worktree: { branch: `agent/${id}` },
    agents: {},
  }
  return Object.assign(base, patch)
}

test('a registry with no chats is unknown, not empty: nothing may be taken on its say-so', () => {
  assert.equal(poolChatsOf({ workspaces: [], activeWorkspaceId: null, workspaceWindows: [] }), null)
})

test('each chat names its folder, its branch, the other folders its agents work in, and when it was last active', () => {
  const [one] = poolChatsOf({
    workspaces: [
      chat('one', {
        lastUserMessageAt: 10,
        lastTurnEndedAt: 40,
        lastTerminalActivityAt: 20,
        lastVisitedAt: 30,
        agents: {
          'agent-1': { execution: { cwd: `${CONTAINER}/one` } },
          'agent-2': { execution: { cwd: '/Users/dev/app', worktreeId: 'w-1' } },
        } as unknown as Records[number]['agents'],
        worktreeState: {
          containerPath: CONTAINER,
          updatedAt: null,
          entries: {
            'w-1': { id: 'w-1', path: `${CONTAINER}/sub`, status: 'assigned', ownerAgentId: 'agent-2' },
            'w-2': { id: 'w-2', path: `${CONTAINER}/gone`, status: 'assigned', ownerAgentId: 'agent-9' },
            'w-3': { id: 'w-3', path: `${CONTAINER}/removing`, status: 'removing' },
          },
        } as unknown as Records[number]['worktreeState'],
      }),
    ],
    activeWorkspaceId: null,
    workspaceWindows: [],
  })!
  assert.equal(one.workspaceId, 'one')
  assert.equal(one.folderPath, `${CONTAINER}/one`)
  assert.equal(one.branch, 'agent/one')
  assert.deepEqual(
    [...one.otherPaths].sort(),
    [`${CONTAINER}/removing`, `${CONTAINER}/sub`, '/Users/dev/app'],
    'its own folder is not repeated, and an entry whose agent is gone names nothing',
  )
  assert.equal(one.lastActiveAt, 40)
  assert.equal(one.open, false)
})

test('a chat on screen in any window is open; a settled one counts only while someone has it open', () => {
  const chats = poolChatsOf({
    workspaces: [
      chat('active'),
      chat('detached'),
      chat('settled', { settledAt: 5 }),
      chat('settled-open', { settledAt: 5 }),
      chat('plain', { worktree: null, folderPath: '/Users/dev/app' }),
    ],
    activeWorkspaceId: 'active',
    workspaceWindows: [{ activeWorkspaceId: 'detached' }, { activeWorkspaceId: 'settled-open' }],
  })!
  const byId = new Map(chats.map((entry) => [entry.workspaceId, entry]))
  assert.equal(byId.get('active')?.open, true)
  assert.equal(byId.get('detached')?.open, true)
  assert.equal(byId.has('settled'), false, 'settled and not open: as good as deleted')
  assert.equal(byId.get('settled-open')?.open, true)
  assert.equal(byId.get('plain')?.branch, null, 'a chat on a plain folder has no worktree branch')
  assert.equal(byId.get('plain')?.lastActiveAt, null)
})

test('each chat carries its name, so a refusal can say whose a slot is', () => {
  const [named, unnamed] = poolChatsOf({
    workspaces: [chat('named', { name: 'Fix the login' } as Partial<Records[number]>), chat('unnamed')],
    activeWorkspaceId: null,
    workspaceWindows: [],
  })!
  assert.equal(named.name, 'Fix the login')
  assert.equal(unnamed.name, null)
})

/** A registry stand-in that records what is written to it, as workspace-sync-service.ts would apply it. */
function registry(workspaces: Array<Record<string, unknown>>) {
  const writes: Array<{ id: string; worktree: Record<string, unknown> }> = []
  const service = {
    getSnapshot: () => ({ state: { workspaces } }),
    updateWorkspaceFields: (id: string, patch: { worktree: Record<string, unknown> }) => {
      writes.push({ id, worktree: patch.worktree })
      return { ok: true }
    },
  } as unknown as Parameters<typeof markChatsReclaimed>[0]
  return { service, writes }
}

test('a chat given back on the branch its agent moved to is moved to that branch, and marked to bring it back', () => {
  const path = `${CONTAINER}/pool-04`
  const { service, writes } = registry([
    { id: 'run', folderPath: path, worktree: { branch: 'agent/scheduled-1', repoRoot: '/Users/dev/app' } },
    // An older chat in the same folder, settled, on a branch of its own.
    { id: 'old', folderPath: path, worktree: { branch: 'agent/chat-old', reclaimedAt: 3 } },
    { id: 'elsewhere', folderPath: `${CONTAINER}/pool-05`, worktree: { branch: 'agent/scheduled-1' } },
  ])
  markChatsReclaimed(service, { path, branch: 'agent/daily-low', leaseBranch: 'agent/scheduled-1' })
  assert.equal(writes.length, 1, 'only the chat that records the lease’s branch, in that folder')
  assert.equal(writes[0].id, 'run')
  assert.equal(writes[0].worktree.branch, 'agent/daily-low')
  assert.equal(writes[0].worktree.repoRoot, '/Users/dev/app', 'the rest of its record is kept')
  assert.equal(typeof writes[0].worktree.reclaimedAt, 'number')
})

test('a chat given back on its own branch is only marked, and one already marked is left alone', () => {
  const path = `${CONTAINER}/pool-07`
  const { service, writes } = registry([
    { id: 'chat', folderPath: path, worktree: { branch: 'agent/chat-1' } },
    { id: 'marked', folderPath: path, worktree: { branch: 'agent/chat-0', reclaimedAt: 3 } },
  ])
  markChatsReclaimed(service, { path, branch: 'agent/chat-1', leaseBranch: 'agent/chat-1' })
  assert.deepEqual(
    writes.map((write) => [write.id, write.worktree.branch, typeof write.worktree.reclaimedAt]),
    [['chat', 'agent/chat-1', 'number']],
  )
})
