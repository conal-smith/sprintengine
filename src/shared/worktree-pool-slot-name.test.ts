import assert from 'node:assert/strict'
import { test } from 'vitest'

import { isPoolSlotPath, poolSlotName, poolSlotNumber, poolSlotStem } from './worktree-pool-slot-name'

test('a slot is named after its project, numbered from 01', () => {
  assert.equal(poolSlotName(poolSlotStem('multicode'), 5), 'multicode-05')
  assert.equal(poolSlotName(poolSlotStem('multicode'), 123), 'multicode-123')
})

test('the stem is safe for a path segment and a branch name', () => {
  assert.equal(poolSlotStem('My App'), 'my-app')
  assert.equal(poolSlotStem('.dotfiles'), 'dotfiles', 'no leading dot: git refuses a ref part that starts with one')
  assert.equal(poolSlotStem('repo.lock'), 'repo', 'no .lock ending')
  assert.equal(poolSlotStem('a..b'), 'a-b', 'no ..')
  assert.equal(poolSlotStem('dir/name'), 'dir-name', 'one segment, never a nested folder')
  assert.equal(poolSlotStem('プロジェクト'), 'pool', 'nothing left: the old stem')
  assert.equal(poolSlotStem('x'.repeat(80)).length, 40, 'capped')
})

test('both spellings are read back as the same sequence of numbers', () => {
  assert.equal(poolSlotNumber('multicode-05', 'multicode'), 5)
  assert.equal(poolSlotNumber('pool-07', 'multicode'), 7, 'a slot made before the rename')
  assert.equal(poolSlotNumber('multicode-5', 'multicode'), null, 'two digits at least, as slots are named')
  assert.equal(poolSlotNumber('other-05', 'multicode'), null)
  assert.equal(poolSlotNumber('multicode-chat-05', 'multicode'), null)
  assert.equal(poolSlotNumber('chat-ab12', 'multicode'), null)
})

test('a slot folder is recognised by the container it sits in', () => {
  assert.equal(isPoolSlotPath('/Users/dev/.sprintengine-worktrees/app/app-03'), true)
  assert.equal(isPoolSlotPath('/Users/dev/.sprintengine-worktrees/app/pool-03/'), true)
  assert.equal(isPoolSlotPath('C:\\Users\\dev\\.sprintengine-worktrees\\My App\\my-app-03'), true)
  assert.equal(isPoolSlotPath('/Users/dev/.sprintengine-worktrees/app/other-03'), false)
  assert.equal(isPoolSlotPath('/Users/dev/.sprintengine-worktrees/app/chat-ab12'), false)
})
