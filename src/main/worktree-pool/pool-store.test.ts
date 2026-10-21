import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import {
  acquireInstanceLock,
  createPoolStore,
  normalizePoolSettings,
  POOL_LOCK_FILE,
  POOL_RECORD_VERSION,
  RESERVED_PATHS_MAX,
} from './pool-store'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function container(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pool-lock-'))
  directories.push(dir)
  return dir
}

/** A lock left by a Studio on this machine whose process is gone. */
async function deadHolder(dir: string): Promise<void> {
  await writeFile(
    join(dir, POOL_LOCK_FILE),
    JSON.stringify({ pid: 999_999_999, host: 'mac-mini', instanceId: 'dead', startedAt: 0 }),
  )
}

const deps = { host: 'mac-mini', pidAlive: (pid: number) => pid === process.pid }

test('two Studios taking over one dead holder’s lock at once: exactly one gets it', async () => {
  for (let round = 0; round < 40; round += 1) {
    const dir = await container()
    await deadHolder(dir)
    const [first, second, third] = await Promise.all([
      acquireInstanceLock(dir, 'studio-a', deps),
      acquireInstanceLock(dir, 'studio-b', deps),
      acquireInstanceLock(dir, 'studio-c', deps),
    ])
    const winners = [first, second, third].filter((result) => result.ok)
    assert.equal(winners.length, 1, `round ${round}: ${JSON.stringify([first, second, third])}`)
    const holder = JSON.parse(await readFile(join(dir, POOL_LOCK_FILE), 'utf8')) as { instanceId: string }
    const winner = ['studio-a', 'studio-b', 'studio-c'][[first, second, third].findIndex((result) => result.ok)]
    assert.equal(holder.instanceId, winner, 'the lock names the one that got it')
  }
})

test('a lock taken over is never left missing, so no third Studio can slip in with a fresh one', async () => {
  const dir = await container()
  await deadHolder(dir)
  const taking = acquireInstanceLock(dir, 'studio-a', deps)
  // Whatever moment the takeover is at, a lock file is there to read.
  for (let check = 0; check < 20; check += 1) {
    const text = await readFile(join(dir, POOL_LOCK_FILE), 'utf8').catch(() => null)
    assert.notEqual(text, null)
    await new Promise((resolveTick) => setImmediate(resolveTick))
  }
  assert.equal((await taking).ok, true)
})

test('a lock held by a live Studio is not taken over', async () => {
  const dir = await container()
  assert.equal((await acquireInstanceLock(dir, 'studio-a', deps)).ok, true)
  const refused = await acquireInstanceLock(dir, 'studio-b', deps)
  assert.equal(refused.ok, false)
  assert.equal((await acquireInstanceLock(dir, 'studio-a', deps)).ok, true, 'the holder confirms its own')
})

test('the idle period defaults to two hours and is kept to whole minutes between a quarter of an hour and a week', () => {
  const idle = (value: unknown) =>
    normalizePoolSettings({ idleReturnMinutes: value } as Parameters<typeof normalizePoolSettings>[0]).idleReturnMinutes
  assert.equal(normalizePoolSettings(null).idleReturnMinutes, 120)
  assert.equal(normalizePoolSettings({}).idleReturnMinutes, 120, 'absent keeps the default')
  assert.equal(idle(240), 240)
  assert.equal(idle(5), 15, 'too short is raised to the least')
  assert.equal(idle(0), 15)
  assert.equal(idle(-60), 15)
  assert.equal(idle(10 ** 9), 7 * 24 * 60, 'too long is lowered to a week')
  assert.equal(idle(90.6), 91, 'whole minutes')
  assert.equal(idle(Number.NaN), 120, 'not a number keeps the default')
  assert.equal(idle(Number.POSITIVE_INFINITY), 120)
  assert.equal(idle('60'), 120)
  assert.equal(idle(null), 120)
  // The other settings are not disturbed by it.
  const settings = normalizePoolSettings({ maxSlots: 6, idleReturnMinutes: 30 })
  assert.equal(settings.maxSlots, 6)
  assert.equal(settings.idleReturnMinutes, 30)
})

test('a record keeps a slot parked for its chat and the paths kept for chats; a mark no state can have is dropped', async () => {
  const dir = await container()
  const store = createPoolStore(dir)
  const keeper = { branch: 'agent/chat', agentId: null, workspaceId: null, since: 1 }
  const slot = (id: string, state: string) => ({
    id,
    path: `/Users/dev/.sprintengine-worktrees/app/${id}`,
    state,
    baseRef: 'origin/main',
    baseSha: null,
    error: null,
    lease: state === 'leased' ? { leaseId: 'l-1', branch: 'agent/other', owner: 'agent/other', leasedAt: 1 } : null,
    held: null,
    lastUsedAt: 1,
    createdAt: 1,
    op: null,
    uses: 1,
    lastBranch: null,
    size: null,
    kept: null,
    parked: keeper,
  })
  const reserved = Array.from({ length: RESERVED_PATHS_MAX + 2 }, (_, n) => ({
    ...keeper,
    branch: `agent/chat-${n}`,
    path: `/Users/dev/.sprintengine-worktrees/app/app-${n + 10}`,
  }))
  await mkdir(store.dir, { recursive: true })
  await writeFile(
    join(store.dir, 'pool-0123456789abcdef.json'),
    JSON.stringify({
      version: POOL_RECORD_VERSION,
      poolId: '0123456789abcdef',
      repoRoot: '/Users/dev/app',
      commonDir: '/Users/dev/app/.git',
      slots: [slot('app-01', 'idle'), slot('app-02', 'leased')],
      reservedPaths: [...reserved, { path: '/Users/dev/broken' }],
    }),
  )
  const [{ record }] = await store.readAll()
  assert.ok(record)
  assert.deepEqual(record.slots[0]?.parked, keeper, 'an idle slot stays kept for its chat')
  assert.equal(record.slots[1]?.parked, null, 'a leased slot is kept for no one')
  assert.equal(record.reservedPaths.length, RESERVED_PATHS_MAX, 'the oldest past the cap are forgotten')
  assert.equal(record.reservedPaths.at(-1)?.branch, `agent/chat-${RESERVED_PATHS_MAX + 1}`)
  assert.ok(
    record.reservedPaths.every((entry) => entry.path.startsWith('/Users/dev/.sprintengine-worktrees/')),
    'one with no branch is dropped',
  )

  // A record an older build wrote has none.
  await writeFile(
    join(store.dir, 'pool-0123456789abcdef.json'),
    JSON.stringify({
      version: POOL_RECORD_VERSION,
      poolId: '0123456789abcdef',
      repoRoot: '/Users/dev/app',
      commonDir: '/Users/dev/app/.git',
      slots: [],
    }),
  )
  const [{ record: older }] = await store.readAll()
  assert.deepEqual(older?.reservedPaths, [])
})
