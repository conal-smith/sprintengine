import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { GitCommandResult } from './git'
import { readCommitMessageDraftInput } from './commit-message-draft'

// What "Write commit message" is written from: the staged diff and nothing
// else, read with bounded git calls whose arguments never pass through a shell.

const STYLE = { mode: 'repository' as const, instructions: '' }

function fakeGit(answers: Record<string, string | null>, calls: string[][] = []) {
  return async (_cwd: string, args: string[]): Promise<GitCommandResult> => {
    calls.push(args)
    const key = args[0] === 'diff' ? (args.includes('--stat') ? 'stat' : 'patch') : args[0]
    const stdout = answers[key]
    return stdout === null || stdout === undefined
      ? { ok: false, stdout: '', stderr: 'fatal', message: 'fatal' }
      : { ok: true, stdout, stderr: '', message: null }
  }
}

test('the staged diff, its summary, the history and the branch are read', async () => {
  const calls: string[][] = []
  const subjects = Array.from({ length: 12 }, (_, i) => `fix(area${i}): thing ${i}`).join('\n')
  const outcome = await readCommitMessageDraftInput('/Users/dev/app', STYLE, {
    git: fakeGit(
      { stat: ' a.ts | 1 +\n', patch: '+a\n', log: `${subjects}\n`, 'symbolic-ref': 'feature/marks\n' },
      calls,
    ),
  })
  assert.ok(outcome.ok)
  assert.equal(outcome.input.branch, 'feature/marks')
  assert.equal(outcome.input.patch, '+a\n')
  assert.equal(outcome.input.recentSubjects.length, 12)
  assert.equal(outcome.input.conventionalCommits, true)
  assert.deepEqual(outcome.input.style, STYLE)
  for (const args of calls.filter((entry) => entry[0] === 'diff')) {
    for (const flag of ['--cached', '--no-ext-diff', '--no-textconv'])
      assert.ok(args.includes(flag), `${flag} in ${args}`)
  }
})

test('nothing staged is said, and is not a draft', async () => {
  const outcome = await readCommitMessageDraftInput('/Users/dev/app', STYLE, {
    git: fakeGit({ stat: '', patch: '', log: '', 'symbolic-ref': 'main' }),
  })
  assert.deepEqual(outcome, { ok: false, message: 'Nothing is staged to commit.' })
})

test('a repository with no commits, on no branch, still drafts from what is staged', async () => {
  const outcome = await readCommitMessageDraftInput('/Users/dev/app', STYLE, {
    git: fakeGit({ stat: ' a.ts | 1 +', patch: null, log: null, 'symbolic-ref': null }),
  })
  assert.ok(outcome.ok)
  assert.equal(outcome.input.branch, null)
  assert.equal(outcome.input.patch, '', 'a diff git could not hand over is left to the summary')
  assert.deepEqual(outcome.input.recentSubjects, [])
  assert.equal(outcome.input.conventionalCommits, false)
})

test('a staged diff past the read bound is cut', async () => {
  const outcome = await readCommitMessageDraftInput('/Users/dev/app', STYLE, {
    git: fakeGit({ stat: ' a.ts | 1 +', patch: 'x'.repeat(200_000), log: '', 'symbolic-ref': 'main' }),
  })
  assert.ok(outcome.ok)
  assert.equal(outcome.input.patch.length, 60_000)
})
