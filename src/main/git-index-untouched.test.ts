import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { diffBranchSelection } from './branch-steps'
import { readBranchSpan } from './git-branch-span'
import { getGitRowSummary } from './git-status'
import { runGitCommand } from './git-utils'
import { getWorkspaceChangeSummary } from './workspace-change-summary'

// The readings that poll a checkout compare the working tree with a commit.
// `git diff` does that by refreshing the index first, and writes the index back
// (taking index.lock) for a file whose stat data moved without its content —
// which fails an agent's `git commit` that lands at the same moment, and wakes
// the watcher on the git folder. These readings must leave the index alone.

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGitCommand(cwd, args)
  assert.ok(result.ok, result.message ?? result.stderr)
  return result.stdout
}

/** A repository with one committed file edited, one renamed, and one only touched. */
async function touchedRepository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'git-index-untouched-')))
  roots.push(root)
  await git(root, 'init', '--quiet')
  await git(root, 'config', 'user.name', 'Developer')
  await git(root, 'config', 'user.email', 'dev@example.com')
  await writeFile(join(root, 'edited.txt'), 'one\n')
  await writeFile(join(root, 'touched.txt'), 'same\n')
  await writeFile(join(root, 'moved.txt'), 'a\nb\nc\nd\n')
  await git(root, 'add', '.')
  await git(root, 'commit', '--quiet', '-m', 'Initial files')
  await writeFile(join(root, 'edited.txt'), 'one\ntwo\n')
  await git(root, 'mv', 'moved.txt', 'renamed.txt')
  // Whole seconds apart, since git may compare stat times to the second: the
  // index a minute old, the files' times seconds after what it recorded.
  const index = join(root, '.git', 'index')
  const past = new Date(Date.now() - 60_000)
  await utimes(index, past, past)
  const later = new Date(Date.now() + 10_000)
  await utimes(join(root, 'touched.txt'), later, later)
  await utimes(join(root, 'edited.txt'), later, later)
  return { root, index, indexMtime: (await stat(index)).mtimeMs }
}

async function assertIndexUntouched(f: { root: string; index: string; indexMtime: number }) {
  assert.equal((await stat(f.index)).mtimeMs, f.indexMtime, 'the index was rewritten')
  assert.equal(existsSync(join(f.root, '.git', 'index.lock')), false)
}

test('the branch span and the sidebar row read the working tree without writing the index', async () => {
  const f = await touchedRepository()
  const span = await readBranchSpan(f.root)
  assert.ok(span?.readable)
  assert.deepEqual(span.stat.files.map((file) => file.path).sort(), ['edited.txt', 'renamed.txt'])
  const summary = await getWorkspaceChangeSummary({ checkoutPath: f.root })
  assert.equal(summary.changedFiles, 2)
  await assertIndexUntouched(f)
})

test('the row summary counts the edit and not the touch, without writing the index', async () => {
  const f = await touchedRepository()
  assert.deepEqual(await getGitRowSummary(f.root), { branch: await currentBranch(f.root), additions: 1, deletions: 0 })
  await assertIndexUntouched(f)
})

test('uncommitted branch steps list the edit and the rename, not a file that was only touched', async () => {
  const f = await touchedRepository()
  const diff = await diffBranchSelection(f.root, { kind: 'uncommitted' })
  assert.deepEqual(
    diff.files.map((file) => [file.path, file.status]),
    [
      ['edited.txt', 'modified'],
      ['renamed.txt', 'renamed'],
    ],
  )
  await assertIndexUntouched(f)
})

async function currentBranch(root: string): Promise<string> {
  return (await git(root, 'symbolic-ref', '--short', 'HEAD')).trim()
}
