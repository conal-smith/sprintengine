import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, test } from 'vitest'

import { cloneTree } from './clone-tree'
import { createGitWorktree } from './git'
import { gitSpawnCounter } from './git-run'

const execFileAsync = promisify(execFile)
const GIT_TEST_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_TEST_ENV })
  return stdout.trim()
}

function spawnTotal(): number {
  return gitSpawnCounter.read + gitSpawnCounter.write + gitSpawnCounter.network
}

let scratch = ''
let repo = ''

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-worktree-create-')))
  repo = join(scratch, 'repo')
  await mkdir(repo, { recursive: true })
  await git(repo, 'init', '-q', '-b', 'main')
  await writeFile(join(repo, 'README.md'), '# repo\n')
  await writeFile(join(repo, '.gitignore'), '.env\ndeps/\n')
  await writeFile(join(repo, '.worktreeinclude'), '# seeded into every worktree\n.env\ndeps\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'init')
  await writeFile(join(repo, '.env'), 'TOKEN=placeholder\n')
  await mkdir(join(repo, 'deps', 'pkg', 'bin'), { recursive: true })
  await writeFile(join(repo, 'deps', 'pkg', 'index.js'), 'module.exports = 1\n')
  await symlink('../index.js', join(repo, 'deps', 'pkg', 'bin', 'run'))
})

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

test('a worktree is cut in five git processes, six for the first, and seeded from .worktreeinclude', async () => {
  const container = join(scratch, 'worktrees')
  const before = spawnTotal()
  const created = await createGitWorktree({
    repoRoot: repo,
    containerPath: container,
    destinationPath: join(container, 'first'),
    branchName: 'agent/first',
    baseRef: 'HEAD',
    copyIncludedFiles: true,
  })
  assert.ok(created.ok, created.ok ? '' : created.message)
  assert.equal(created.data.branch, 'agent/first')
  // root, check-ref-format, rev-parse --verify, worktree add, worktree list,
  // and for the repository's first worktree, config --get checkout.workers.
  assert.equal(spawnTotal() - before, 6, 'resolve the root once and list once')
  const beforeNext = spawnTotal()
  const next = await createGitWorktree({
    repoRoot: repo,
    containerPath: container,
    destinationPath: join(container, 'next'),
    branchName: 'agent/next',
    baseRef: 'HEAD',
  })
  assert.ok(next.ok, next.ok ? '' : next.message)
  assert.equal(spawnTotal() - beforeNext, 5, 'checkout.workers is read once per repository')

  const seeded = join(container, 'first')
  assert.equal(await readFile(join(seeded, '.env'), 'utf8'), 'TOKEN=placeholder\n')
  assert.equal(await readFile(join(seeded, 'deps', 'pkg', 'index.js'), 'utf8'), 'module.exports = 1\n')
  const link = join(seeded, 'deps', 'pkg', 'bin', 'run')
  assert.ok((await lstat(link)).isSymbolicLink(), 'a symlink is recreated, not followed')
  assert.equal(await readlink(link), '../index.js')
})

test('a branch that is already checked out is refused with the worktree that holds it', async () => {
  const container = join(scratch, 'worktrees')
  const again = await createGitWorktree({
    repoRoot: repo,
    containerPath: container,
    destinationPath: join(container, 'second'),
    branchName: 'agent/first',
    baseRef: 'HEAD',
  })
  assert.equal(again.ok, false)
  assert.match(again.ok ? '' : again.message, /already checked out at .*first/)
})

test('a filesystem that refuses to clone falls back to a plain copy', async () => {
  const source = join(scratch, 'clone-source')
  await mkdir(join(source, 'nested'), { recursive: true })
  await writeFile(join(source, 'nested', 'file.txt'), 'content\n')
  const modes: number[] = []
  await cloneTree(source, join(scratch, 'clone-target'), {
    copy: async (from, to, mode) => {
      modes.push(mode)
      if (mode !== 0) throw Object.assign(new Error('clone not supported'), { code: 'ENOTSUP' })
      await writeFile(to, await readFile(from))
    },
  })
  assert.deepEqual(modes, [constants.COPYFILE_FICLONE, 0], 'a clone is asked for first, then a plain copy')
  assert.equal(await readFile(join(scratch, 'clone-target', 'nested', 'file.txt'), 'utf8'), 'content\n')
})

test('a branch named agent is named as what refuses an agent worktree, and nothing is made', async () => {
  const blocked = join(scratch, 'blocked')
  await mkdir(blocked, { recursive: true })
  await git(blocked, 'init', '-q', '-b', 'main')
  await writeFile(join(blocked, 'README.md'), '# blocked\n')
  await git(blocked, 'add', '.')
  await git(blocked, 'commit', '-q', '-m', 'init')
  await git(blocked, 'branch', 'agent')
  const container = join(scratch, 'blocked-worktrees')
  const created = await createGitWorktree({
    repoRoot: blocked,
    containerPath: container,
    destinationPath: join(container, 'fix'),
    branchName: 'agent/fix',
    baseRef: 'HEAD',
  })
  assert.equal(created.ok, false)
  assert.match(created.ok ? '' : created.message, /A branch named “agent” in this repository blocks/)
  assert.equal(await git(blocked, 'branch', '--list', 'agent/*'), '')
})

test('a branch named like a part of a chosen prefix is named as what refuses the worktree', async () => {
  const blocked = join(scratch, 'blocked-prefix')
  await mkdir(blocked, { recursive: true })
  await git(blocked, 'init', '-q', '-b', 'main')
  await writeFile(join(blocked, 'README.md'), '# blocked\n')
  await git(blocked, 'add', '.')
  await git(blocked, 'commit', '-q', '-m', 'init')
  await git(blocked, 'branch', 'jane/wip')
  const container = join(scratch, 'blocked-prefix-worktrees')
  const created = await createGitWorktree({
    repoRoot: blocked,
    containerPath: container,
    destinationPath: join(container, 'fix'),
    branchName: 'jane/wip/fix',
    baseRef: 'HEAD',
  })
  assert.equal(created.ok, false)
  assert.match(
    created.ok ? '' : created.message,
    /A branch named “jane\/wip” in this repository blocks Studio’s jane\/wip\/… branches/,
  )
})
