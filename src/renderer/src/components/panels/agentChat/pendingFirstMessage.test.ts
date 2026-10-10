import { expect, test } from 'vitest'

import { chatSetupSteps } from './pendingFirstMessage'

const base = {
  hadWorktree: true,
  preparingWorktree: true,
  branch: null,
  install: null,
  installed: null,
  agentName: 'Claude',
}

test('a chat making its worktree says so, on its branch once that is known', () => {
  expect(chatSetupSteps(base)).toEqual([{ id: 'worktree', label: 'Worktree', done: false }])
  expect(chatSetupSteps({ ...base, branch: 'agent/quiet-otter' })[0]?.label).toBe('Worktree on agent/quiet-otter')
})

test('an install running means the worktree is made, and says what it last printed', () => {
  expect(
    chatSetupSteps({
      ...base,
      branch: 'agent/quiet-otter',
      install: { command: 'npm ci', lastLine: 'added 812 packages' },
      installed: 'npm ci',
    }),
  ).toEqual([
    { id: 'worktree', label: 'Worktree on agent/quiet-otter', done: true },
    { id: 'install', label: 'Dependencies (npm ci)', detail: 'added 812 packages', done: false },
  ])
})

test('once the folder is the chat’s, what ran is done and the agent is starting', () => {
  expect(
    chatSetupSteps({ ...base, preparingWorktree: false, branch: 'agent/quiet-otter', installed: 'npm ci' }),
  ).toEqual([
    { id: 'worktree', label: 'Worktree on agent/quiet-otter', done: true },
    { id: 'install', label: 'Dependencies (npm ci)', detail: null, done: true },
    { id: 'agent', label: 'Starting Claude', done: false },
  ])
})

test('a chat with no worktree only starts its agent', () => {
  expect(chatSetupSteps({ ...base, hadWorktree: false, preparingWorktree: false })).toEqual([
    { id: 'agent', label: 'Starting Claude', done: false },
  ])
})
