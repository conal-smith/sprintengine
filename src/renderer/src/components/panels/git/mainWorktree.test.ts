import assert from 'node:assert/strict'

import { test } from 'vitest'

import { splitMainWorktree } from './mainWorktree'

const entry = (path: string, branch: string) => ({ path, branch })

test('the entry at the resolved root is the main checkout', () => {
  const main = entry('/Users/dev/app', 'main')
  const feature = entry('/Users/dev/app-feature', 'feature')
  assert.deepEqual(splitMainWorktree([main, feature], '/Users/dev/app/'), { main, linked: [feature] })
})

test('a separate git dir listed as the main worktree is the main checkout, not a linked one', () => {
  // `git init --separate-git-dir=store.git work` lists the git folder first.
  const gitDir = entry('/Users/dev/store.git', 'main')
  const feature = entry('/Users/dev/feature', 'feature')
  assert.deepEqual(splitMainWorktree([gitDir, feature], '/Users/dev/work'), { main: gitDir, linked: [feature] })
})

test('a project opened at a linked worktree keeps the main checkout among the others', () => {
  const main = entry('/Users/dev/app', 'main')
  const feature = entry('/Users/dev/app-feature', 'feature')
  assert.deepEqual(splitMainWorktree([main, feature], '/Users/dev/app-feature'), { main: feature, linked: [main] })
})

test('an empty listing has no main checkout', () => {
  assert.deepEqual(splitMainWorktree([], '/Users/dev/app'), { main: null, linked: [] })
})
