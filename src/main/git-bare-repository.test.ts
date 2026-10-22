import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { bareRepositoryGitDirArgs, explicitGitDir, runGit, runGitCommand } from './git-run'

// The app's git runs under `safe.bareRepository=explicit`. These are real
// repositories: a bare one nested in a project's tree is not picked up by a git
// started inside it, and the bare repositories a person works with on purpose
// (a bare clone, its worktrees, the `.bare` container) still work.

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'se-git-bare-')))
}

function seed(dir: string): string {
  const source = join(dir, 'source')
  execFileSync('git', ['init', '-q', '-b', 'main', source])
  git(source, 'config', 'user.email', 'dev@example.com')
  git(source, 'config', 'user.name', 'dev')
  writeFileSync(join(source, 'a.txt'), 'one\n')
  git(source, 'add', '.')
  git(source, 'commit', '-q', '-m', 'init')
  return source
}

test("a bare repository inside a project's tree is not taken for the repository git was asked about", async () => {
  const dir = scratch()
  try {
    const project = seed(dir)
    const nested = join(project, 'vendor', 'planted.git')
    mkdirSync(join(project, 'vendor'))
    execFileSync('git', ['init', '-q', '--bare', nested])

    const inside = await runGitCommand(nested, ['rev-parse', '--git-dir'])
    assert.equal(inside.ok, false)
    assert.match(inside.stderr, /cannot use bare repository .*safe\.bareRepository/u)
    const below = await runGitCommand(join(nested, 'refs'), ['rev-parse', '--git-dir'])
    assert.equal(below.ok, false, 'nor from a folder inside it')
    // The project around it is unaffected.
    assert.equal((await runGit(project, ['rev-parse', '--is-inside-work-tree'])).trim(), 'true')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a bare clone is named explicitly and reads as before', async () => {
  const dir = scratch()
  try {
    const source = seed(dir)
    const bare = join(dir, 'app.git')
    execFileSync('git', ['clone', '-q', '--bare', source, bare])

    assert.deepEqual(await bareRepositoryGitDirArgs(bare), [explicitGitDir(bare)])
    const gitDir = await bareRepositoryGitDirArgs(bare)
    assert.equal((await runGit(bare, [...gitDir, 'branch', '--format=%(refname:short)'])).trim(), 'main')
    assert.equal((await runGit(bare, [...gitDir, 'log', '--format=%s', '-1'])).trim(), 'init')
    assert.match(await runGit(bare, [...gitDir, 'remote', '-v']), /^origin\t/mu)

    // Nothing else is taken for one.
    assert.deepEqual(await bareRepositoryGitDirArgs(source), [], 'a checkout')
    assert.deepEqual(await bareRepositoryGitDirArgs(join(source, '.git')), [], "a checkout's .git folder")
    assert.deepEqual(await bareRepositoryGitDirArgs(join(bare, 'refs')), [], 'a folder inside a bare clone')
    assert.deepEqual(await bareRepositoryGitDirArgs(dir), [], 'a folder that is not a repository')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a project whose repository is bare still adds worktrees, and git works in them as it always has', async () => {
  const dir = scratch()
  try {
    const source = seed(dir)
    const bare = join(dir, 'app.git')
    execFileSync('git', ['clone', '-q', '--bare', source, bare])
    const worktree = join(dir, 'wt-feature')

    const added = await runGitCommand(bare, [explicitGitDir(bare), 'worktree', 'add', '-q', '-b', 'feature', worktree])
    assert.equal(added.ok, true, added.message ?? '')
    assert.equal((await runGit(worktree, ['branch', '--show-current'])).trim(), 'feature')
    writeFileSync(join(worktree, 'b.txt'), 'two\n')
    assert.equal((await runGit(worktree, ['status', '--porcelain'])).trim(), '?? b.txt')
    // The repository the worktree belongs to is the bare one.
    assert.equal(
      (await runGit(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(),
      realpathSync(bare),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a container whose .git file points at ./.bare is found through that file, worktrees and all', async () => {
  const dir = scratch()
  try {
    const source = seed(dir)
    const container = join(dir, 'app')
    mkdirSync(container)
    execFileSync('git', ['clone', '-q', '--bare', source, join(container, '.bare')])
    writeFileSync(join(container, '.git'), 'gitdir: ./.bare\n')

    assert.equal((await runGit(container, ['rev-parse', '--is-bare-repository'])).trim(), 'true')
    const added = await runGitCommand(container, ['worktree', 'add', '-q', join(container, 'main'), 'main'])
    assert.equal(added.ok, true, added.message ?? '')
    assert.equal((await runGit(join(container, 'main'), ['status', '--porcelain'])).trim(), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
