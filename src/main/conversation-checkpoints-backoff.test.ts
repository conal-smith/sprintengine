import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import type { GitCommandResult } from './git'

// A git that answers every capture step, whose `add` can be made to fail, to
// run out of time, or to take a while (it moves the fake clock on).
const fake = vi.hoisted(() => ({
  root: '',
  add: 'ok' as 'ok' | 'fail' | 'timeout',
  addTakesMs: 0,
  calls: [] as { args: string[]; options?: { timeoutMs?: number | null } }[],
}))

vi.mock('./git-utils', () => ({
  runGitCommand: async (
    _cwd: string,
    args: string[],
    _env?: NodeJS.ProcessEnv,
    options?: { timeoutMs?: number | null },
  ): Promise<GitCommandResult> => {
    fake.calls.push({ args, options })
    const ok = (stdout = ''): GitCommandResult => ({ ok: true, stdout, stderr: '', message: null })
    const subcommand = args.find((arg, index) => !arg.startsWith('-') && args[index - 1] !== '-c')
    if (args.includes('--show-toplevel')) return ok(`${fake.root}\n`)
    if (args.includes('--git-path')) return ok('no-index-here\n')
    if (subcommand === 'add') {
      if (fake.addTakesMs) vi.setSystemTime(Date.now() + fake.addTakesMs)
      if (fake.add === 'fail') return { ok: false, stdout: '', stderr: 'fatal: adding files failed', message: null }
      if (fake.add === 'timeout')
        return {
          ok: false,
          stdout: '',
          stderr: '',
          message: 'git add did not finish within 60 s and was stopped.',
          timedOut: true,
        }
      return ok()
    }
    if (subcommand === 'check-ignore') return { ok: false, stdout: '', stderr: '', message: null }
    if (subcommand === 'rev-parse') return ok('1111111111111111111111111111111111111111\n')
    if (subcommand === 'write-tree') return ok('2222222222222222222222222222222222222222\n')
    if (subcommand === 'commit-tree') return ok('3333333333333333333333333333333333333333\n')
    return ok()
  },
}))

const { ConversationCheckpoints } = await import('./conversation-checkpoints')

const MINUTE = 60_000
let directory = ''
const key = () => ({ workspaceRoot: fake.root, workspaceId: 'workspace', agentId: 'agent' })
const skipped = (result: { ok: boolean; skipped?: boolean }) => result.ok === false && result.skipped === true
const adds = () => fake.calls.filter((call) => call.args.includes('add')).length

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'checkpoint-backoff-'))
})
afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-17T09:00:00Z'))
  fake.root = directory
  fake.add = 'ok'
  fake.addTakesMs = 0
  fake.calls = []
})
afterEach(() => {
  vi.useRealTimers()
})

test('a capture runs normally while it keeps succeeding', async () => {
  const checkpoints = new ConversationCheckpoints()
  for (let turn = 1; turn <= 3; turn++) expect((await checkpoints.capture(key(), turn, 'pre')).ok).toBe(true)
  expect(adds()).toBe(3)
})

test('two failures in a row pause captures in that repository for ten minutes', async () => {
  const checkpoints = new ConversationCheckpoints()
  fake.add = 'fail'
  expect(await checkpoints.capture(key(), 1, 'pre')).toMatchObject({ ok: false })
  expect((await checkpoints.capture(key(), 2, 'pre')).ok).toBe(false)
  const paused = await checkpoints.capture(key(), 3, 'pre')
  expect(paused).toMatchObject({ ok: false, skipped: true })
  expect(adds()).toBe(2)

  vi.setSystemTime(Date.now() + 9 * MINUTE)
  expect(await checkpoints.capture(key(), 4, 'pre')).toMatchObject({ ok: false, skipped: true })
  expect(adds()).toBe(2)

  fake.add = 'ok'
  vi.setSystemTime(Date.now() + 2 * MINUTE)
  expect((await checkpoints.capture(key(), 5, 'pre')).ok).toBe(true)
  expect(adds()).toBe(3)
})

test('one failure alone does not pause, and a success in between starts the count again', async () => {
  const checkpoints = new ConversationCheckpoints()
  fake.add = 'fail'
  await checkpoints.capture(key(), 1, 'pre')
  fake.add = 'ok'
  expect((await checkpoints.capture(key(), 2, 'pre')).ok).toBe(true)
  fake.add = 'fail'
  await checkpoints.capture(key(), 3, 'pre')
  fake.add = 'ok'
  expect((await checkpoints.capture(key(), 4, 'pre')).ok).toBe(true)
  expect(adds()).toBe(4)
})

test('a failure after a pause runs out pauses again for twice as long, up to the cap', async () => {
  const checkpoints = new ConversationCheckpoints()
  fake.add = 'fail'
  await checkpoints.capture(key(), 1, 'pre')
  await checkpoints.capture(key(), 2, 'pre')
  const pauses: number[] = []
  for (let turn = 3; turn < 9; turn++) {
    const start = Date.now()
    let waited = 0
    // Step a minute at a time until a capture runs again.
    while (skipped(await checkpoints.capture(key(), turn, 'pre'))) {
      vi.setSystemTime(Date.now() + MINUTE)
      waited = Date.now() - start
    }
    pauses.push(Math.round(waited / MINUTE))
  }
  expect(pauses).toEqual([10, 20, 40, 80, 80, 80])
})

test('one capture slower than twenty seconds pauses at once, even when it succeeded', async () => {
  const checkpoints = new ConversationCheckpoints()
  fake.addTakesMs = 25_000
  expect((await checkpoints.capture(key(), 1, 'pre')).ok).toBe(true)
  fake.addTakesMs = 0
  expect(await checkpoints.capture(key(), 1, 'post')).toMatchObject({ ok: false, skipped: true })
  expect(adds()).toBe(1)
})

test('a pause holds only the repository that earned it', async () => {
  const checkpoints = new ConversationCheckpoints()
  const other = await mkdtemp(join(directory, 'other-'))
  fake.add = 'fail'
  await checkpoints.capture(key(), 1, 'pre')
  await checkpoints.capture(key(), 2, 'pre')
  expect(skipped(await checkpoints.capture(key(), 3, 'pre'))).toBe(true)
  fake.root = other
  fake.add = 'ok'
  expect((await checkpoints.capture(key(), 1, 'pre')).ok).toBe(true)
})

test('the snapshot add has a deadline, and one that runs out is not tried again from HEAD', async () => {
  const checkpoints = new ConversationCheckpoints()
  fake.add = 'timeout'
  const result = await checkpoints.capture(key(), 1, 'pre')
  expect(result).toMatchObject({ ok: false, message: 'git add did not finish within 60 s and was stopped.' })
  const addCalls = fake.calls.filter((call) => call.args.includes('add'))
  expect(addCalls).toHaveLength(1)
  expect(addCalls[0].options?.timeoutMs).toBe(60_000)
})
