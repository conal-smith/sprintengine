import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { GitCommandResult } from '../git'
import { parallelCheckoutConfig, type SlotGitRunner } from './slot-git'

/** A git that answers `config --get checkout.workers` with `answer`, recording every call. */
function fakeGit(answer: GitCommandResult): { run: SlotGitRunner; calls: string[][] } {
  const calls: string[][] = []
  const run: SlotGitRunner = async (_cwd, args) => {
    calls.push(args)
    return answer
  }
  return { run, calls }
}

const UNSET: GitCommandResult = { ok: false, stdout: '', stderr: '', message: 'Git command failed.' }

test('a repository with no checkout.workers checks out on one worker per core', async () => {
  const git = fakeGit(UNSET)
  assert.deepEqual(await parallelCheckoutConfig(git.run, '/Users/dev/unset'), ['-c', 'checkout.workers=0'])
  assert.deepEqual(git.calls, [['config', '--get', 'checkout.workers']])
})

test('a checkout.workers the person set is passed through', async () => {
  const git = fakeGit({ ok: true, stdout: '4\n', stderr: '', message: null })
  assert.deepEqual(await parallelCheckoutConfig(git.run, '/Users/dev/configured'), ['-c', 'checkout.workers=4'])
})

test('checkout.workers is read once per repository', async () => {
  const git = fakeGit({ ok: true, stdout: '1\n', stderr: '', message: null })
  await Promise.all([
    parallelCheckoutConfig(git.run, '/Users/dev/once'),
    parallelCheckoutConfig(git.run, '/Users/dev/once'),
  ])
  assert.deepEqual(await parallelCheckoutConfig(git.run, '/Users/dev/once'), ['-c', 'checkout.workers=1'])
  assert.equal(git.calls.length, 1)
  await parallelCheckoutConfig(git.run, '/Users/dev/another')
  assert.equal(git.calls.length, 2, 'another repository reads its own')
})

test('a read of checkout.workers that failed is tried again next time', async () => {
  const git = fakeGit({ ok: false, stdout: '', stderr: 'fatal: bad config line 3', message: 'fatal' })
  assert.deepEqual(await parallelCheckoutConfig(git.run, '/Users/dev/broken'), ['-c', 'checkout.workers=0'])
  await parallelCheckoutConfig(git.run, '/Users/dev/broken')
  assert.equal(git.calls.length, 2)
})
