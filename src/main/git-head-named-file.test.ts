import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, test } from 'vitest'

import { diffBranchSelection } from './branch-steps'
import { readBranchSpan } from './git-branch-span'
import { getGitCommitGraph } from './git-read-models'
import { getGitRowSummary } from './git-status'
import { getWorkspaceChangeSummary } from './workspace-change-summary'

// A checkout holding a file named `HEAD` makes a bare `HEAD` argument both a
// revision and a path, and `diff-index`, `rev-list`, `log` and `reset` refuse
// it as ambiguous unless a `--` ends the revisions. Every read here would then
// quietly report nothing.

let dir = ''

function git(...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  })
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'git-head-file-'))
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'first')
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
  writeFileSync(join(dir, 'HEAD'), 'not a ref\n')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('the sidebar row counts the edit', async () => {
  const row = await getGitRowSummary(dir)
  assert.equal(row.branch, 'main')
  assert.equal(row.additions, 1)
})

test('the change summary reads the uncommitted edit', async () => {
  const summary = await getWorkspaceChangeSummary({ checkoutPath: dir })
  assert.notEqual(summary.uncommitted, null)
  // The edited line, and the untracked `HEAD` file's one line.
  assert.equal(summary.uncommitted?.additions, 2)
})

test('the branch span is read', async () => {
  assert.notEqual(await readBranchSpan(dir), null)
})

test('the uncommitted step lists the edited file', async () => {
  const diff = await diffBranchSelection(dir, { kind: 'uncommitted' })
  const paths = diff.files.map((file) => file.path)
  assert.ok(paths.includes('a.txt'), `got ${JSON.stringify(paths)}`)
})

test('the commit graph counts and lists the commit', async () => {
  const graph = await getGitCommitGraph(dir)
  assert.equal(graph.totalCount, 1)
  assert.equal(graph.commits.length, 1)
})
