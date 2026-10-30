import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { readBranchName } from './git-branch-span'
import { branchNameFromHeadRef } from './git-head-branch'
import { getGitRowSummary } from './git-status'
import { runGitCommand } from './git-utils'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGitCommand(cwd, args)
  assert.ok(result.ok, result.message ?? result.stderr)
  return result.stdout
}

test('a full HEAD ref names its branch, slashes and all', () => {
  assert.equal(branchNameFromHeadRef('refs/heads/feature/marks\n'), 'feature/marks')
  assert.equal(branchNameFromHeadRef('refs/heads/main'), 'main')
})

test('anything but a branch ref names no branch', () => {
  for (const stdout of ['', '\n', 'refs/heads/', 'HEAD', 'refs/tags/v1', 'heads/main', null, undefined]) {
    assert.equal(branchNameFromHeadRef(stdout), null, String(stdout))
  }
})

test('a branch that shares its name with a tag is read as the branch, not heads/<name>', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'git-head-branch-')))
  roots.push(root)
  await git(root, 'init', '--quiet', '--initial-branch=release')
  await git(root, 'config', 'user.name', 'Developer')
  await git(root, 'config', 'user.email', 'dev@example.com')
  await git(root, 'commit', '--quiet', '--allow-empty', '-m', 'first')
  await git(root, 'tag', 'release')

  assert.equal(await readBranchName(root), 'release')
  assert.equal((await getGitRowSummary(root)).branch, 'release')
})
