import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { GitCommandResult } from './git'
import { parseGitWorktreePorcelain, runGitWorktreeListPorcelain } from './git-worktree-list'

test('with -z, a worktree path holding a newline is read whole', () => {
  const output = [
    'worktree /Users/dev/app',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /Users/dev/odd\nname',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/agent/odd',
    'locked held: dirty',
    '',
  ].join('\0')
  const entries = parseGitWorktreePorcelain(output)
  assert.equal(entries.length, 2)
  assert.equal(entries[1].path, '/Users/dev/odd\nname')
  assert.equal(entries[1].branch, 'agent/odd')
  assert.equal(entries[1].lockedReason, 'held: dirty')
})

test('without -z, each line is one attribute', () => {
  const output = 'worktree /Users/dev/app\r\nHEAD 1111111111111111111111111111111111111111\r\ndetached\r\nlocked\r\n'
  const [entry] = parseGitWorktreePorcelain(output)
  assert.equal(entry.path, '/Users/dev/app')
  assert.equal(entry.detached, true)
  assert.equal(entry.locked, true)
  assert.equal(entry.lockedReason, null)
})

// What git before 2.36 prints for `worktree list -z`, exit 129.
const OLD_GIT_REFUSAL: GitCommandResult = {
  ok: false,
  stdout: '',
  stderr: "error: unknown switch `z'\nusage: git worktree list [<options>]\n",
  message: "error: unknown switch `z'",
}

const LINE_LISTING = [
  'worktree /Users/dev/app',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree /Users/dev/app-pool/slot-1',
  'HEAD 2222222222222222222222222222222222222222',
  'detached',
  'locked held: lease',
  '',
  '',
].join('\n')

test('a git too old for -z is asked again without it, and the listing reads as the -z shape', async () => {
  const calls: string[][] = []
  const result = await runGitWorktreeListPorcelain(async (_cwd, args) => {
    calls.push(args)
    return args.includes('-z') ? OLD_GIT_REFUSAL : { ok: true, stdout: LINE_LISTING, stderr: '', message: null }
  }, '/Users/dev/app')
  assert.deepEqual(calls, [
    ['worktree', 'list', '--porcelain', '-z'],
    ['worktree', 'list', '--porcelain'],
  ])
  assert.equal(result.ok, true)
  const entries = parseGitWorktreePorcelain(result.stdout)
  assert.deepEqual(
    entries.map((entry) => [entry.path, entry.lockedReason]),
    [
      ['/Users/dev/app', null],
      ['/Users/dev/app-pool/slot-1', 'held: lease'],
    ],
  )
  // Callers that split records on the blank entry between them still find two.
  assert.equal(result.stdout.split('\0\0').filter(Boolean).length, 2)
})

test('any other failure is reported as it was, without a second git', async () => {
  const calls: string[][] = []
  const notARepo: GitCommandResult = {
    ok: false,
    stdout: '',
    stderr: 'fatal: not a git repository',
    message: 'fatal: not a git repository',
  }
  const result = await runGitWorktreeListPorcelain(async (_cwd, args) => {
    calls.push(args)
    return notARepo
  }, '/tmp/nowhere')
  assert.equal(result, notARepo)
  assert.equal(calls.length, 1)
})
