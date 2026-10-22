import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, test } from 'vitest'

import { cleanupAgentWorktrees } from './agent-worktree-cleanup'
import { runGitCommand } from './git-run'
import { removeWorktreeKeepingSubmoduleWork } from './worktree-submodule-removal'

/**
 * Agent worktrees with their submodules checked out, as Studio makes them,
 * on a real repository whose submodule comes from a `file://` remote: a clean
 * one is removed although plain `git worktree remove` refuses it, and every
 * kind of work `--force` would take keeps it.
 */

const execFileAsync = promisify(execFile)
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  // Git refuses a local submodule remote unless told otherwise.
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'protocol.file.allow',
  GIT_CONFIG_VALUE_0: 'always',
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8', env })
  return stdout.trim()
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

const later = (): number => Date.now() + 2 * 60 * 60_000
const quiet = { log: () => {}, now: later }

let scratch = ''
let repo = ''
let container = ''

/** An agent worktree with its submodule checked out, as worktree creation leaves it. */
async function addWorktree(slug: string): Promise<string> {
  const path = join(container, slug)
  await git(repo, 'worktree', 'add', '-q', '-b', `agent/${slug}`, path, 'origin/main')
  await git(path, 'submodule', 'update', '--init', '--recursive', '-q')
  return path
}

async function sweep(path: string) {
  const report = await cleanupAgentWorktrees({ repoRoot: repo, protectedPaths: [] }, quiet)
  return report.entries.find((entry) => entry.path === path)
}

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-worktree-submodules-')))
  const libSeed = join(scratch, 'lib-seed')
  await mkdir(libSeed, { recursive: true })
  await git(libSeed, 'init', '-q', '-b', 'main')
  await writeFile(join(libSeed, 'lib.txt'), 'lib\n')
  await writeFile(join(libSeed, '.gitignore'), '.env\n')
  await git(libSeed, 'add', '.')
  await git(libSeed, 'commit', '-q', '-m', 'lib')
  const libOrigin = join(scratch, 'lib.git')
  await git(scratch, 'clone', '-q', '--bare', libSeed, libOrigin)

  const seed = join(scratch, 'seed')
  await mkdir(seed, { recursive: true })
  await git(seed, 'init', '-q', '-b', 'main')
  await writeFile(join(seed, 'README.md'), '# app\n')
  await git(seed, 'submodule', 'add', '-q', `file://${libOrigin}`, 'lib')
  await git(seed, 'add', '.')
  await git(seed, 'commit', '-q', '-m', 'init')
  await git(scratch, 'clone', '-q', '--bare', seed, join(scratch, 'origin.git'))
  repo = join(scratch, 'app')
  await git(scratch, 'clone', '-q', join(scratch, 'origin.git'), repo)
  container = join(scratch, '.sprintengine-worktrees', 'app')
  await mkdir(container, { recursive: true })
})

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

test('a clean worktree with a checked-out submodule is removed', async () => {
  const path = await addWorktree('clean')
  const plain = await runGitCommand(repo, ['worktree', 'remove', path])
  assert.match(plain.message ?? '', /containing submodules/, 'plain remove refuses it')

  assert.equal((await sweep(path))?.verdict, 'removed')
  assert.equal(await exists(path), false)
})

test('a submodule commit no remote holds keeps the worktree', async () => {
  const path = await addWorktree('unpushed')
  const lib = join(path, 'lib')
  await writeFile(join(lib, 'lib.txt'), 'work\n')
  await git(lib, 'commit', '-q', '-am', 'local work')
  const local = await git(lib, 'rev-parse', 'HEAD')
  // Recorded in the superproject too, so its status reads clean.
  await git(path, 'commit', '-q', '-am', 'bump lib')
  assert.equal(await git(path, 'status', '--porcelain'), '')

  const entry = await sweep(path)
  assert.equal(entry?.verdict, 'unmerged')
  assert.match(entry?.detail ?? '', /no remote-tracking branch/)
  assert.equal(await git(lib, 'rev-parse', 'HEAD'), local)
})

test('a submodule commit only its reflog still holds keeps the worktree', async () => {
  const path = await addWorktree('reflog')
  const lib = join(path, 'lib')
  const base = await git(lib, 'rev-parse', 'HEAD')
  await writeFile(join(lib, 'lib.txt'), 'work\n')
  await git(lib, 'commit', '-q', '-am', 'local work')
  await git(lib, 'checkout', '-q', base)

  const entry = await sweep(path)
  assert.equal(entry?.verdict, 'unmerged')
  assert.match(entry?.detail ?? '', /no remote-tracking branch/)
  assert.equal(await exists(path), true)
})

test('an uncommitted edit in a submodule keeps the worktree', async () => {
  const path = await addWorktree('dirty')
  await writeFile(join(path, 'lib', 'lib.txt'), 'edited\n')
  // A setting that hides submodule changes from the superproject's status.
  await git(path, 'config', 'diff.ignoreSubmodules', 'all')

  const entry = await sweep(path)
  assert.equal(entry?.verdict, 'dirty')
  assert.match(entry?.detail ?? '', /submodule lib/)
})

test('an untracked file in a submodule keeps the worktree', async () => {
  const path = await addWorktree('untracked')
  await git(path, 'config', 'diff.ignoreSubmodules', 'all')
  await writeFile(join(path, 'lib', 'notes.md'), 'notes\n')

  const entry = await sweep(path)
  assert.equal(entry?.verdict, 'dirty')
  assert.match(entry?.detail ?? '', /submodule lib/)
  assert.equal(await exists(join(path, 'lib', 'notes.md')), true)
})

test('an ignored file that may be work in a submodule keeps the worktree', async () => {
  const path = await addWorktree('ignored')
  await writeFile(join(path, 'lib', '.env'), 'TOKEN=local\n')

  const entry = await sweep(path)
  assert.equal(entry?.verdict, 'ignored-files')
  assert.match(entry?.detail ?? '', /\.env/)
})

test('a commit in a deinitialized submodule’s stored repository keeps the worktree', async () => {
  const path = await addWorktree('deinit')
  const lib = join(path, 'lib')
  await git(lib, 'checkout', '-q', '-b', 'local-only')
  await writeFile(join(lib, 'lib.txt'), 'work\n')
  await git(lib, 'commit', '-q', '-am', 'local work')
  await git(lib, 'checkout', '-q', '--detach', 'origin/main')
  await git(path, 'submodule', 'deinit', '-q', 'lib')

  const entry = await sweep(path)
  assert.equal(entry?.verdict, 'unmerged')
  assert.match(entry?.detail ?? '', /no remote-tracking branch/)
  assert.equal(await exists(path), true)
})

test('a file in a submodule folder that is not checked out keeps the worktree', async () => {
  const path = await addWorktree('stray')
  await git(path, 'submodule', 'deinit', '-q', 'lib')
  await writeFile(join(path, 'lib', 'draft.txt'), 'draft\n')

  const entry = await sweep(path)
  assert.equal(entry?.verdict, 'dirty')
  assert.match(entry?.detail ?? '', /not checked out/)
  assert.equal(await exists(join(path, 'lib', 'draft.txt')), true)
})

test('an edit to the worktree itself, made after the sweep read it, is checked again before forcing', async () => {
  const path = await addWorktree('late-edit')
  await writeFile(join(path, 'README.md'), 'late\n')

  const removal = await removeWorktreeKeepingSubmoduleWork(repo, path, runGitCommand)
  assert.deepEqual(removal, {
    outcome: 'kept',
    why: { kind: 'uncommitted', detail: '1 changed path(s)', paths: 1 },
  })
  assert.equal(await exists(join(path, 'README.md')), true)
})
