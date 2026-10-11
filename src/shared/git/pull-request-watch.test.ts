import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  pullRequestWatchIsTrouble,
  pullRequestWatchSentence,
  pullRequestWatchWords,
  type PullRequestWatchView,
} from './pull-request-watch'

const view = (overrides: Partial<PullRequestWatchView>): PullRequestWatchView => ({
  since: 1,
  waitingOn: 'checks',
  ...overrides,
})

test('each thing a watch waits on has its own words', () => {
  const cases: Array<[Partial<PullRequestWatchView>, string]> = [
    [{ waitingOn: 'first-read' }, 'Watching'],
    [{ waitingOn: 'checks' }, 'Watching · checks running'],
    [{ waitingOn: 'checks', approved: true }, 'Approved · checks running'],
    [{ waitingOn: 'checks', approved: true, autoMerge: true }, 'Approved · merging when green'],
    [{ waitingOn: 'checks-failed', failedChecks: 1 }, 'Check failed'],
    [{ waitingOn: 'checks-failed', failedChecks: 3 }, '3 checks failed'],
    [{ waitingOn: 'behind', base: 'main' }, 'Behind main'],
    [{ waitingOn: 'conflicts', base: 'release/2.0' }, 'Conflicts with release/2.0'],
    [{ waitingOn: 'conflicts' }, 'Conflicts with its base'],
    [{ waitingOn: 'changes-requested' }, 'Changes requested'],
    [{ waitingOn: 'review' }, 'Waiting for review'],
    [{ waitingOn: 'merge', approved: true, autoMerge: true }, 'Approved · merging'],
    [{ waitingOn: 'merge', approved: true }, 'Approved · ready to merge'],
    [{ waitingOn: 'merge' }, 'Ready to merge'],
  ]
  for (const [overrides, words] of cases) assert.equal(pullRequestWatchWords(view(overrides)), words)
})

test('a word a newer Studio sends reads as plain watching, and only failures are trouble', () => {
  const unknown = view({ waitingOn: 'merge-queue' as PullRequestWatchView['waitingOn'] })
  assert.equal(pullRequestWatchWords(unknown), 'Watching')
  assert.match(pullRequestWatchSentence(unknown), /^Studio is watching it\./)
  assert.equal(pullRequestWatchIsTrouble(view({ waitingOn: 'checks-failed' })), true)
  assert.equal(pullRequestWatchIsTrouble(view({ waitingOn: 'conflicts' })), true)
  assert.equal(pullRequestWatchIsTrouble(view({ waitingOn: 'behind' })), false)
})
