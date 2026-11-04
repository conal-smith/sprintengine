import { expect, test } from 'vitest'
import { displayBranchName } from './branchLabel'

test('a detached HEAD reads in the app’s words with the short commit', () => {
  expect(displayBranchName('(HEAD detached at 8b9f1eeff)')).toBe('detached at 8b9f1ee')
  expect(displayBranchName('(HEAD detached from origin/main)')).toBe('detached from origin/main')
})

test('a branch name is left as it is', () => {
  expect(displayBranchName('feat/conversation-workspace')).toBe('feat/conversation-workspace')
  expect(displayBranchName('(not a git phrase)')).toBe('(not a git phrase)')
})
