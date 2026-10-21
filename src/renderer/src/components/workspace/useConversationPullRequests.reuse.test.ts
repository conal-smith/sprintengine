import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { BranchPullRequest } from '../../../../shared/git/pull-request'
import { reuseUnchangedLists } from './useConversationPullRequests'

// The sidebar hands each memoized row its own workspace's list, so a re-read
// in which one pull request moved must leave every other workspace's list the
// same object, or every row repaints for one row's mark.

function mark(number: number, state: BranchPullRequest['state'] = 'open'): BranchPullRequest {
  return {
    url: `https://github.com/acme/app/pull/${number}`,
    repoKey: 'github.com/acme/app',
    repoName: 'app',
    number,
    title: `#${number}`,
    state,
    isDraft: false,
    openedAt: number,
    stateAt: number,
  }
}

test('one workspace moving keeps the others their lists', () => {
  const current = { 'ws-1': [mark(1)], 'ws-2': [mark(2)] }
  const next = reuseUnchangedLists(current, { 'ws-1': [mark(1, 'merged')], 'ws-2': [mark(2)] })
  assert.notEqual(next, current)
  assert.equal(next['ws-2'], current['ws-2'], 'the unchanged workspace keeps its list')
  assert.equal(next['ws-1']?.[0]?.state, 'merged')
})

test('a re-read that moved nothing keeps the map', () => {
  const current = { 'ws-1': [mark(1)], 'ws-2': [mark(2)] }
  assert.equal(reuseUnchangedLists(current, { 'ws-1': [mark(1)], 'ws-2': [mark(2)] }), current)
})

test('a workspace that left the answer is dropped', () => {
  const current = { 'ws-1': [mark(1)], 'ws-2': [mark(2)] }
  const next = reuseUnchangedLists(current, { 'ws-1': [mark(1)] })
  assert.deepEqual(Object.keys(next), ['ws-1'])
  assert.equal(next['ws-1'], current['ws-1'])
})
