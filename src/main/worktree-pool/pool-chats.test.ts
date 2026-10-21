import assert from 'node:assert/strict'
import { test } from 'vitest'

import { poolChatsOf } from './pool-chats'

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
