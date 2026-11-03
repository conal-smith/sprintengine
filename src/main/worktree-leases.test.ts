import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import {
  blockedMessage,
  createWorktreeLeases,
  holdIfIdle,
  type WorktreeBlocked,
  type WorktreeBusy,
  type WorktreeHold,
} from './worktree-leases'

let scratch = ''
let slot = ''

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'worktree-leases-')))
  slot = join(scratch, 'container', 'app-01')
  await mkdir(join(slot, 'src'), { recursive: true })
})

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

function held(result: WorktreeHold | WorktreeBusy): WorktreeHold {
  assert.ok(!('busy' in result), 'busy' in result ? result.busy : '')
  return result
}

function exclusive(result: WorktreeHold | WorktreeBlocked): WorktreeHold {
  assert.ok('release' in result, 'blockedBy' in result ? `blocked by ${result.blockedBy[0]?.reason}` : '')
  return result
}

/** Whether `pending` has settled by the time everything already queued has run. */
async function settled(pending: Promise<unknown>): Promise<boolean> {
  let done = false
  void pending.then(() => (done = true))
  await new Promise((resolve) => setTimeout(resolve, 5))
  return done
}

test('shared holds on one path run together, and an exclusive one is refused while any is held', async () => {
  const leases = createWorktreeLeases()
  const turn = held(await leases.acquireShared(slot, { reason: 'a turn is starting in it' }))
  const terminal = held(await leases.acquireShared(slot, { reason: 'a terminal is starting in it' }))
  assert.ok('blockedBy' in (await leases.tryExclusive(slot, 'the pool is returning this worktree')))
  turn.release()
  assert.ok(
    'blockedBy' in (await leases.tryExclusive(slot, 'the pool is returning this worktree')),
    'one is still held',
  )
  terminal.release()
  const returning = exclusive(await leases.tryExclusive(slot, 'the pool is returning this worktree'))
  assert.equal(returning.kind, 'exclusive')
  returning.release()
})

test('an exclusive hold is refused at once, never waited for, while another exclusive one meets it', async () => {
  const leases = createWorktreeLeases()
  const evicting = exclusive(await leases.tryExclusive(slot, 'the pool is removing this worktree'))
  assert.ok('blockedBy' in (await leases.tryExclusive(slot, 'this worktree is being removed')))
  assert.ok('blockedBy' in (await leases.tryExclusive(join(slot, 'src'), 'inside it')))
  assert.ok('blockedBy' in (await leases.tryExclusive(join(scratch, 'container'), 'around it')))
  const sibling = exclusive(await leases.tryExclusive(join(scratch, 'container', 'app-02'), 'another slot'))
  sibling.release()
  evicting.release()
})

test('a shared acquire waits for an exclusive hold, and is granted the moment it ends', async () => {
  const leases = createWorktreeLeases()
  const returning = exclusive(await leases.tryExclusive(slot, 'the pool is returning this worktree'))
  const pending = leases.acquireShared(join(slot, 'src'), { reason: 'a turn is starting in it' })
  assert.equal(await settled(pending), false, 'waits while the return runs')
  assert.deepEqual(
    (await leases.holders(slot)).map(({ kind, reason, waiting }) => ({ kind, reason, waiting })),
    [
      { kind: 'exclusive', reason: 'the pool is returning this worktree', waiting: false },
      { kind: 'shared', reason: 'a turn is starting in it', waiting: true },
    ],
  )
  // Waiting, it already keeps a new exclusive hold off: background work
  // cannot line up behind the return and cut in ahead of the turn.
  assert.ok('blockedBy' in (await leases.tryExclusive(join(slot, 'src'), 'the cleanup is removing this worktree')))
  returning.release()
  // Granted inside the release, before anything else can run.
  assert.ok('blockedBy' in (await leases.tryExclusive(slot, 'the pool is removing this worktree')))
  const turn = held(await pending)
  assert.equal(turn.kind, 'shared')
  turn.release()
  assert.deepEqual(await leases.holders(slot), [])
})

test('a shared acquire that waits too long is refused with the reason of the hold it waited on', async () => {
  const leases = createWorktreeLeases()
  const returning = exclusive(await leases.tryExclusive(slot, 'the pool is returning this worktree'))
  const refused = await leases.acquireShared(slot, { reason: 'a turn is starting in it', timeoutMs: 20 })
  assert.ok('busy' in refused)
  assert.match(refused.busy, /the pool is returning this worktree/)
  assert.deepEqual(
    (await leases.holders(slot)).map(({ kind }) => kind),
    ['exclusive'],
    'no longer waiting',
  )
  returning.release()
  assert.deepEqual(await leases.holders(slot), [])
})

test('a shared acquire stops waiting when its signal aborts, and does not start at all once aborted', async () => {
  const leases = createWorktreeLeases()
  const returning = exclusive(await leases.tryExclusive(slot, 'the pool is returning this worktree'))
  const stop = new AbortController()
  const pending = leases.acquireShared(slot, { reason: 'a terminal is starting in it', signal: stop.signal })
  assert.equal(await settled(pending), false)
  stop.abort()
  const stopped = await pending
  assert.ok('busy' in stopped)
  assert.match(stopped.busy, /the pool is returning this worktree/)
  assert.ok('busy' in (await leases.acquireShared(slot, { reason: 'late', signal: stop.signal })))
  returning.release()
  assert.deepEqual(await leases.holders(slot), [])
})

test('a symlinked spelling, a subfolder and a folder not made yet all meet the slot', async () => {
  const leases = createWorktreeLeases()
  const link = join(scratch, 'linked-container')
  await symlink(join(scratch, 'container'), link)
  const returning = exclusive(await leases.tryExclusive(join(link, 'app-01'), 'the pool is returning this worktree'))
  assert.equal(returning.key.toLowerCase(), slot.toLowerCase(), 'filed under the resolved path')
  for (const spelling of [slot, `${slot}/`, join(link, 'app-01', 'src'), join(slot, 'not-yet', 'deep')]) {
    const refused = await leases.acquireShared(spelling, { reason: 'a terminal is starting in it', timeoutMs: 1 })
    assert.ok('busy' in refused, `${spelling} waits for the slot`)
  }
  // A folder around the slot (the container, a parent a terminal opened in)
  // is not inside it: its start does not wait for the slot.
  held(await leases.acquireShared(join(scratch, 'container'), { reason: 'a terminal is starting in it' })).release()
  returning.release()
})

test('a shared hold on a folder around the slot does not keep the slot from changing', async () => {
  const leases = createWorktreeLeases()
  const around = held(await leases.acquireShared(join(scratch, 'container'), { reason: 'a terminal is starting' }))
  const returning = exclusive(await leases.tryExclusive(slot, 'the pool is returning this worktree'))
  returning.release()
  around.release()
})

test('release is idempotent: a second call gives up nothing another holder has, and the record empties', async () => {
  const leases = createWorktreeLeases()
  const first = held(await leases.acquireShared(slot, { reason: 'a turn is starting in it' }))
  const second = held(await leases.acquireShared(slot, { reason: 'a turn is starting in it' }))
  first.release()
  first.release()
  assert.ok(
    'blockedBy' in (await leases.tryExclusive(slot, 'the pool is returning this worktree')),
    'the second still holds',
  )
  second.release()
  assert.deepEqual(await leases.holders(slot), [])
  const returning = exclusive(await leases.tryExclusive(slot, 'the pool is returning this worktree'))
  returning.release()
  returning.release()
  assert.deepEqual(await leases.holders(slot), [])
})

test('a hold kept past the stale age is logged, never broken', async () => {
  const lines: string[] = []
  const leases = createWorktreeLeases({ staleAfterMs: 5, log: (line) => lines.push(line) })
  const turn = held(await leases.acquireShared(slot, { reason: 'a turn is starting in it' }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(lines.length, 1)
  assert.match(lines[0] ?? '', /a turn is starting in it/)
  assert.ok('blockedBy' in (await leases.tryExclusive(slot, 'the pool is returning this worktree')), 'still held')
  turn.release()
})

test('a refused exclusive acquire names what it met, and only what it conflicts with', async () => {
  const leases = createWorktreeLeases()
  const around = held(await leases.acquireShared(join(scratch, 'container'), { reason: 'a terminal is starting' }))
  const inside = held(await leases.acquireShared(join(slot, 'src'), { reason: 'a turn is starting in it' }))
  const refused = await leases.tryExclusive(slot, 'the pool is returning this worktree')
  assert.ok('blockedBy' in refused)
  assert.deepEqual(
    refused.blockedBy.map(({ kind, reason, owner }) => ({ kind, reason, owner })),
    [{ kind: 'shared', reason: 'a turn is starting in it', owner: null }],
    'the folder around the slot is not among them',
  )
  inside.release()
  const returning = exclusive(await leases.tryExclusive(slot, 'the pool is returning this worktree', { owner: 'pool' }))
  const again = await leases.tryExclusive(slot, 'the pool is removing this worktree')
  assert.ok('blockedBy' in again)
  assert.deepEqual(
    again.blockedBy.map(({ kind, owner }) => ({ kind, owner })),
    [{ kind: 'exclusive', owner: 'pool' }],
  )
  returning.release()
  around.release()
})

test('a start that meets a hold nothing should wait for is refused at once, with its reason', async () => {
  const leases = createWorktreeLeases()
  const leasing = exclusive(
    await leases.tryExclusive(slot, 'the pool is preparing this worktree for a new lease', { refuseWaiters: true }),
  )
  const refused = await leases.acquireShared(join(slot, 'src'), { reason: 'a terminal is starting in it' })
  assert.ok('busy' in refused)
  assert.equal(refused.busy, 'This worktree is not free: the pool is preparing this worktree for a new lease.')
  assert.deepEqual(
    (await leases.holders(slot)).map(({ kind }) => kind),
    ['exclusive'],
    'nothing waits',
  )
  leasing.release()
})

test('holdIfIdle gives the hold only when nothing holds the path and nothing on the live list is in it', async () => {
  const leases = createWorktreeLeases()
  const live: string[] = []
  const idle = await holdIfIdle(leases, slot, 'the pool is returning this worktree', () => live)
  assert.ok('release' in idle)
  idle.release()
  live.push(join(slot, 'src'))
  assert.deepEqual(await holdIfIdle(leases, slot, 'the pool is returning this worktree', () => live), { live: true })
  assert.deepEqual(await leases.holders(slot), [], 'the hold it took to look is given back')
  live.length = 0
  const starting = held(await leases.acquireShared(slot, { reason: 'a turn is starting in it' }))
  const blocked = await holdIfIdle(leases, slot, 'the pool is returning this worktree', () => live)
  assert.ok('blockedBy' in blocked)
  assert.equal(blockedMessage(blocked), 'This worktree is busy (a turn is starting in it). Try again in a moment.')
  starting.release()
  await assert.rejects(
    holdIfIdle(leases, slot, 'the pool is returning this worktree', () => {
      throw new Error('the live list is unreadable')
    }),
  )
  assert.deepEqual(await leases.holders(slot), [], 'given back when the live list throws')
})
