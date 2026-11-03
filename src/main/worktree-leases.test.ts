import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { createWorktreeLeases, type WorktreeBusy, type WorktreeHold } from './worktree-leases'

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
  assert.equal(await leases.tryExclusive(slot, 'the pool is returning this worktree'), null)
  turn.release()
  assert.equal(await leases.tryExclusive(slot, 'the pool is returning this worktree'), null, 'one is still held')
  terminal.release()
  const returning = await leases.tryExclusive(slot, 'the pool is returning this worktree')
  assert.ok(returning)
  assert.equal(returning.kind, 'exclusive')
  returning.release()
})

test('an exclusive hold is refused at once, never waited for, while another exclusive one meets it', async () => {
  const leases = createWorktreeLeases()
  const evicting = await leases.tryExclusive(slot, 'the pool is removing this worktree')
  assert.ok(evicting)
  assert.equal(await leases.tryExclusive(slot, 'this worktree is being removed'), null)
  assert.equal(await leases.tryExclusive(join(slot, 'src'), 'inside it'), null)
  assert.equal(await leases.tryExclusive(join(scratch, 'container'), 'around it'), null)
  const sibling = await leases.tryExclusive(join(scratch, 'container', 'app-02'), 'another slot')
  assert.ok(sibling, 'a sibling slot is another tree')
  sibling.release()
  evicting.release()
})

test('a shared acquire waits for an exclusive hold, and is granted the moment it ends', async () => {
  const leases = createWorktreeLeases()
  const returning = await leases.tryExclusive(slot, 'the pool is returning this worktree')
  assert.ok(returning)
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
  assert.equal(await leases.tryExclusive(join(slot, 'src'), 'the cleanup is removing this worktree'), null)
  returning.release()
  // Granted inside the release, before anything else can run.
  assert.equal(await leases.tryExclusive(slot, 'the pool is removing this worktree'), null)
  const turn = held(await pending)
  assert.equal(turn.kind, 'shared')
  turn.release()
  assert.deepEqual(await leases.holders(slot), [])
})

test('a shared acquire that waits too long is refused with the reason of the hold it waited on', async () => {
  const leases = createWorktreeLeases()
  const returning = await leases.tryExclusive(slot, 'the pool is returning this worktree')
  assert.ok(returning)
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
  const returning = await leases.tryExclusive(slot, 'the pool is returning this worktree')
  assert.ok(returning)
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
  const returning = await leases.tryExclusive(join(link, 'app-01'), 'the pool is returning this worktree')
  assert.ok(returning)
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
  const returning = await leases.tryExclusive(slot, 'the pool is returning this worktree')
  assert.ok(returning)
  returning.release()
  around.release()
})

test('release is idempotent: a second call gives up nothing another holder has, and the record empties', async () => {
  const leases = createWorktreeLeases()
  const first = held(await leases.acquireShared(slot, { reason: 'a turn is starting in it' }))
  const second = held(await leases.acquireShared(slot, { reason: 'a turn is starting in it' }))
  first.release()
  first.release()
  assert.equal(await leases.tryExclusive(slot, 'the pool is returning this worktree'), null, 'the second still holds')
  second.release()
  assert.deepEqual(await leases.holders(slot), [])
  const returning = await leases.tryExclusive(slot, 'the pool is returning this worktree')
  assert.ok(returning)
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
  assert.equal(await leases.tryExclusive(slot, 'the pool is returning this worktree'), null, 'still held')
  turn.release()
})
