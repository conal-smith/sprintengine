import { expect, test } from 'vitest'

import type {
  WorktreeInventory,
  WorktreeInventoryEntry,
  WorktreePoolSlotView,
} from '../../../../shared/ipc/worktree-pool'
import {
  buildWorktreeProjects,
  formatBytes,
  inventoryRootsOf,
  planFreeSpace,
  rowMatches,
  worktreeTotals,
  type WorktreeChatSource,
} from './worktreesSettingsModel'

const GB = 1024 ** 3
const NOW = 1_000_000_000_000
const MIN = 60_000
const REPO = '/code/app'
const POOL = '/code/.sprintengine-worktrees/app'

function slot(id: string, patch: Partial<WorktreePoolSlotView>): WorktreePoolSlotView {
  return {
    id,
    path: `${POOL}/${id}`,
    state: 'idle',
    baseRef: 'origin/main',
    baseSha: 'a41c9e2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    error: null,
    lease: null,
    held: null,
    lastUsedAt: null,
    uses: 1,
    lastBranch: null,
    size: { bytes: GB, measuredAt: NOW, parts: [] },
    kept: null,
    parked: null,
    ...patch,
  }
}

function entry(path: string, patch: Partial<WorktreeInventoryEntry> = {}): WorktreeInventoryEntry {
  return {
    path,
    branch: null,
    head: 'f00',
    slotId: null,
    lockedByOther: false,
    missing: false,
    uniqueCommits: 0,
    behindCommits: 0,
    merged: true,
    changedPaths: 0,
    changes: [],
    lastUsedAt: null,
    size: null,
    ...patch,
  }
}

const lease = (branch: string, agentId: string | null = null, workspaceId: string | null = null) => ({
  leaseId: `lease-${branch}`,
  branch,
  owner: branch,
  agentId,
  workspaceId,
  leasedAt: NOW - 14 * MIN,
})

const slots = [
  slot('pool-01', { state: 'leased', lease: lease('agent/fix-login') }),
  slot('pool-02', { state: 'leased', lease: lease('agent/retry', 'agent-b') }),
  slot('pool-03', {
    state: 'held',
    held: { reason: 'dirty', detail: null, changedPaths: 3, branch: 'agent/copy', since: NOW - 120 * MIN },
  }),
  slot('pool-04', { state: 'idle', lastUsedAt: NOW - 25 * MIN, lastBranch: 'agent/old' }),
  slot('pool-05', {
    state: 'idle',
    lastUsedAt: NOW - 24 * 60 * MIN,
    size: { bytes: 2 * GB, measuredAt: NOW, parts: [] },
  }),
  slot('pool-06', { state: 'leasing', lease: null }),
]

const inventory: WorktreeInventory = {
  measuredAt: NOW - MIN,
  projects: [
    {
      repoRoot: REPO,
      defaultRef: 'origin/main',
      pool: {
        poolId: 'p1',
        repoRoot: REPO,
        containerPath: POOL,
        heldByOtherInstance: false,
        defaultRef: 'origin/main',
        lastFetchAt: NOW - 2 * MIN,
        slots,
      },
      worktrees: [
        ...slots.map((s) => entry(s.path, { slotId: s.id, branch: s.lease?.branch ?? null })),
        entry('/code/merged-by-hand', { branch: 'feat/merged', size: { bytes: 3 * GB, measuredAt: NOW, parts: [] } }),
        entry('/code/unmerged', { branch: 'feat/unmerged', merged: false, uniqueCommits: 4 }),
        entry('/code/dirty', { branch: 'feat/dirty', changedPaths: 2 }),
        entry('/code/open-chat', { branch: 'feat/open' }),
        entry('/code/settled-chat', { branch: 'feat/settled' }),
        entry('/code/gone', { missing: true }),
        entry('/code/locked', { lockedByOther: true }),
      ],
      error: null,
    },
  ],
}

const workspaces: WorktreeChatSource[] = [
  { id: 'w1', name: 'Fix the login redirect loop', folderPath: `${POOL}/pool-01`, agents: { 'agent-a': {} } },
  { id: 'w2', name: 'Remote reconnect hardening', folderPath: REPO, agents: { 'agent-b': {} } },
  { id: 'w3', name: 'Open chat', folderPath: '/code/open-chat', agents: {} },
  { id: 'w4', name: 'Hero copy', folderPath: '/code/settled-chat', settledAt: NOW - MIN, agents: {} },
  { id: 'w5', name: 'On a machine elsewhere', folderPath: '/remote/x', remoteOrigin: {}, agents: {} },
]

const [project] = buildWorktreeProjects(inventory, workspaces, NOW)
const byName = new Map([...project.poolRows, ...project.otherRows].map((row) => [row.name, row]))
const row = (name: string) => {
  const found = byName.get(name)
  if (!found) throw new Error(`no row ${name}`)
  return found
}

test('slots sort in use, busy, held, then ready (most recent first), each tied to the chat that has it', () => {
  expect(project.poolRows.map((r) => r.name)).toEqual([
    'pool-01',
    'pool-02',
    'pool-06',
    'pool-03',
    'pool-04',
    'pool-05',
  ])
  expect(row('pool-01').chat?.title).toBe('Fix the login redirect loop')
  expect(row('pool-01').usedBy).toBe('Fix the login redirect loop')
  expect(row('pool-02').chat?.workspaceId).toBe('w2')
  expect(row('pool-03').stateLabel).toBe('Holding work')
  expect(row('pool-03').branch).toBe('agent/copy')
  expect(row('pool-04').usedBy).toBe('Last used 25m ago')
  expect(row('pool-04').branch).toBeNull()
  expect(row('pool-04').branchNote).toBe('at origin/main a41c9e2')
  expect(row('pool-06').stateLabel).toBe('Getting ready')
})

test('only ready slots and clean, unused worktrees outside the pool can be removed, each with its reason', () => {
  expect(row('pool-04').removal).toBe('evict')
  expect(row('pool-01').removal).toBeNull()
  expect(row('pool-03').keptBecause).toMatch(/holds work/)
  expect(row('merged-by-hand').removal).toBe('remove')
  expect(row('merged-by-hand').stateLabel).toBe('Merged')
  expect(row('unmerged').removal).toBe('remove')
  expect(row('unmerged').stateLabel).toBe('Not merged')
  expect(row('dirty').keptBecause).toBe('It has 2 uncommitted changes.')
  expect(row('open-chat').keptBecause).toBe('The chat “Open chat” works in it.')
  expect(row('settled-chat').removal).toBe('remove')
  expect(row('settled-chat').usedBy).toBe('Settled chat “Hero copy”')
  expect(row('gone').removal).toBe('prune')
  expect(row('locked').removal).toBeNull()
})

test('totals count every worktree by state and add their sizes', () => {
  const totals = worktreeTotals([project])
  expect(totals.count).toBe(13)
  expect(totals.inUse).toBe(3)
  expect(totals.ready).toBe(2)
  expect(totals.held).toBe(1)
  expect(totals.other).toBe(7)
  expect(totals.chats).toBe(2)
  expect(totals.bytes.ready).toBe(3 * GB)
  expect(totals.bytes.pool).toBe(7 * GB)
  expect(totals.bytes.other).toBe(3 * GB)
})

test('the filter and the search narrow the rows', () => {
  const all = [...project.poolRows, ...project.otherRows]
  expect(all.filter((r) => rowMatches(r, 'held', '')).map((r) => r.name)).toEqual(['pool-03'])
  expect(all.filter((r) => rowMatches(r, 'in-use', '')).map((r) => r.name)).toEqual(['pool-01', 'pool-02', 'pool-06'])
  expect(all.filter((r) => rowMatches(r, 'all', 'login')).map((r) => r.name)).toEqual(['pool-01'])
  expect(all.filter((r) => rowMatches(r, 'other', 'gone')).map((r) => r.name)).toEqual(['gone'])
})

test('freeing space keeps the most recent ready slot, offers merged worktrees, and never unmerged ones', () => {
  const plan = planFreeSpace([project])
  expect(plan.keptReady.map((r) => r.name)).toEqual(['pool-04'])
  expect(plan.extraReady.map((r) => r.name)).toEqual(['pool-05'])
  expect(plan.merged.map((r) => r.name).sort()).toEqual(['merged-by-hand', 'settled-chat'])
  expect(plan.unmerged.map((r) => r.name)).toEqual(['unmerged'])
})

test('the projects sent to main are the local ones, once each, a worktree folded into its project', () => {
  expect(inventoryRootsOf(workspaces)).toEqual([REPO, '/code/open-chat', '/code/settled-chat'])
})

test('sizes read the way a person says them', () => {
  expect(formatBytes(null)).toBe('—')
  expect(formatBytes(1.94 * GB)).toBe('1.9 GB')
  expect(formatBytes(840 * 1024 ** 2)).toBe('840 MB')
  expect(formatBytes(120 * GB)).toBe('120 GB')
  expect(formatBytes(2048)).toBe('2 KB')
})

test('an empty category reads 0 KB, while a few bytes still read as something', () => {
  expect(formatBytes(0)).toBe('0 KB')
  expect(formatBytes(100)).toBe('1 KB')
})

test('a worktree an agent of an open chat was spawned into is in use, not free to remove', () => {
  const spawned: WorktreeInventory = {
    measuredAt: NOW,
    projects: [
      {
        repoRoot: REPO,
        defaultRef: 'origin/main',
        pool: null,
        worktrees: [
          entry('/code/.sprintengine-worktrees/app/agent-tab', { branch: 'agent/tab' }),
          entry('/code/.sprintengine-worktrees/app/agent-cwd', { branch: 'agent/cwd' }),
          entry('/code/.sprintengine-worktrees/app/orphan', { branch: 'agent/orphan' }),
        ],
        error: null,
      },
    ],
  }
  const chats: WorktreeChatSource[] = [
    {
      id: 'w1',
      name: 'Main chat',
      folderPath: REPO,
      agents: {
        'agent-a': { execution: { cwd: '/code/.sprintengine-worktrees/app/agent-cwd/src', worktreeId: null } },
      },
      worktreeState: {
        entries: {
          tab: { path: '/code/.sprintengine-worktrees/app/agent-tab', status: 'assigned', ownerAgentId: null },
          orphan: { path: '/code/.sprintengine-worktrees/app/orphan', status: 'assigned', ownerAgentId: 'gone' },
        },
      },
    },
  ]
  const [view] = buildWorktreeProjects(spawned, chats, NOW)
  const rows = new Map(view.otherRows.map((r) => [r.name, r]))
  expect(rows.get('agent-tab')?.removal).toBeNull()
  expect(rows.get('agent-tab')?.keptBecause).toBe('The chat “Main chat” works in it.')
  expect(rows.get('agent-cwd')?.removal).toBeNull()
  expect(rows.get('orphan')?.removal).toBe('remove')
})

test('a slot an agent leased itself is credited to that agent’s chat, not to another chat with the same agent id', () => {
  const leased: WorktreeInventory = {
    measuredAt: NOW,
    projects: [
      {
        repoRoot: REPO,
        defaultRef: 'origin/main',
        pool: {
          ...inventory.projects[0].pool!,
          slots: [slot('pool-01', { state: 'leased', lease: lease('agent/x', 'agent-1', 'w-b') })],
        },
        worktrees: [],
        error: null,
      },
    ],
  }
  const chats: WorktreeChatSource[] = [
    { id: 'w-b', name: 'The one that leased', folderPath: REPO, agents: { 'agent-1': {} } },
    { id: 'w-a', name: 'Another with agent-1', folderPath: REPO, agents: { 'agent-1': {} } },
  ]
  const [view] = buildWorktreeProjects(leased, chats, NOW)
  expect(view.poolRows[0].chat?.workspaceId).toBe('w-b')
})
