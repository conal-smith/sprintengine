import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, test } from 'vitest'

import { cleanupAgentWorktrees, type AgentWorktreeCleanupDeps } from './agent-worktree-cleanup'
import { setAgentWorktreeLockProfile } from './agent-worktree-lock'
import { createGitWorktree } from './git'

/**
 * What the cleanup takes as Studio's once the person chose a branch prefix:
 * branches and worktrees under that prefix or under `agent/`, and nothing
 * else. With no prefix a branch's name says nothing about who made it, so no
 * unprefixed branch is ever deleted, and a worktree on one is an agent's only
 * when this profile's agent lock is on it.
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

// Past the hour a new worktree is kept for, short of the day another one is.
const later = (): number => Date.now() + 2 * 60 * 60_000

let scratch = ''
let caseNumber = 0

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-worktree-prefix-')))
})

afterEach(() => setAgentWorktreeLockProfile(null))

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

/** A clone of its own per case, with `origin/main` to measure "merged" against. */
async function makeRepo(): Promise<{ repo: string; container: string }> {
  caseNumber += 1
  const dir = join(scratch, `case-${caseNumber}`)
  const seed = join(dir, 'seed')
  await mkdir(seed, { recursive: true })
  await git(seed, 'init', '-q', '-b', 'main')
  await writeFile(join(seed, 'README.md'), '# app\n')
  await git(seed, 'add', '.')
  await git(seed, 'commit', '-q', '-m', 'init')
  await git(dir, 'clone', '-q', '--bare', seed, join(dir, 'origin.git'))
  const repo = join(dir, 'app')
  await git(dir, 'clone', '-q', join(dir, 'origin.git'), repo)
  const container = join(dir, '.sprintengine-worktrees', 'app')
  await mkdir(container, { recursive: true })
  return { repo, container }
}

/** Branches at `origin/main`, so each is merged by having no work of its own. */
async function mergedBranches(repo: string, ...names: string[]): Promise<void> {
  for (const name of names) await git(repo, 'branch', name, 'origin/main')
}

async function localBranches(repo: string): Promise<string[]> {
  return (await git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).split('\n').filter(Boolean).sort()
}

function deps(branchPrefix: string): AgentWorktreeCleanupDeps {
  return { log: () => {}, now: later, branchPrefix: () => branchPrefix }
}

test('with a prefix, merged branches under it and under agent/ are deleted, and no others', async () => {
  const { repo } = await makeRepo()
  await mergedBranches(repo, 'feat/a', 'agent/b', 'feat/kept', 'feature/c', 'featx/d', 'other/feat/e', 'release')
  const report = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [], keepBranches: ['feat/kept'] },
    deps('feat'),
  )
  assert.deepEqual([...(report.deletedBranches ?? [])].sort(), ['agent/b', 'feat/a'])
  assert.deepEqual(await localBranches(repo), ['feat/kept', 'feature/c', 'featx/d', 'main', 'other/feat/e', 'release'])
})

test('with a namespaced prefix, only branches under the whole of it are Studio’s', async () => {
  const { repo } = await makeRepo()
  await mergedBranches(repo, 'jane/wip/a', 'jane/other', 'agent/b')
  const report = await cleanupAgentWorktrees({ repoRoot: repo, protectedPaths: [], keepBranches: [] }, deps('jane/wip'))
  assert.deepEqual([...(report.deletedBranches ?? [])].sort(), ['agent/b', 'jane/wip/a'])
  assert.ok((await localBranches(repo)).includes('jane/other'))
})

test('with no prefix, only agent/ branches are deleted; no unprefixed branch ever is', async () => {
  const { repo } = await makeRepo()
  // `chat-ab12` is just what Studio names a branch with no prefix, and still
  // not Studio's to delete: nothing records which unprefixed branches it made.
  await mergedBranches(repo, 'chat-ab12', 'fix-login', 'agent/b', 'feature/c')
  const report = await cleanupAgentWorktrees({ repoRoot: repo, protectedPaths: [], keepBranches: [] }, deps(''))
  assert.deepEqual(report.deletedBranches, ['agent/b'])
  assert.deepEqual(await localBranches(repo), ['chat-ab12', 'feature/c', 'fix-login', 'main'])
})

test('a branch under the prefix with work the default branch lacks is kept', async () => {
  const { repo, container } = await makeRepo()
  const path = join(container, 'wip')
  await git(repo, 'worktree', 'add', '-q', '-b', 'feat/wip', path, 'origin/main')
  await writeFile(join(path, 'wip.txt'), 'wip\n')
  await git(path, 'add', '.')
  await git(path, 'commit', '-q', '-m', 'wip')
  await git(repo, 'worktree', 'remove', path)
  const report = await cleanupAgentWorktrees({ repoRoot: repo, protectedPaths: [], keepBranches: [] }, deps('feat'))
  assert.deepEqual(report.deletedBranches, [])
  assert.ok((await localBranches(repo)).includes('feat/wip'))
})

test('a worktree on a branch under the prefix is an agent’s; one on another branch waits a day', async () => {
  const { repo, container } = await makeRepo()
  const studio = join(container, 'studio')
  const other = join(container, 'other')
  await git(repo, 'worktree', 'add', '-q', '-b', 'feat/studio', studio, 'origin/main')
  await git(repo, 'worktree', 'add', '-q', '-b', 'feature/other', other, 'origin/main')
  const report = await cleanupAgentWorktrees({ repoRoot: repo, protectedPaths: [] }, deps('feat'))
  const verdicts = new Map(report.entries.map((entry) => [entry.path, entry.verdict]))
  assert.equal(verdicts.get(studio), 'removed')
  assert.equal(verdicts.get(other), 'recent', 'not Studio’s: kept until a day unused')
  assert.equal(await exists(studio), false)
  assert.equal(await exists(other), true)
})

test('a worktree under the prefix the person had before is still an agent’s after a change', async () => {
  const { repo, container } = await makeRepo()
  const before = join(container, 'before')
  await git(repo, 'worktree', 'add', '-q', '-b', 'agent/before', before, 'origin/main')
  const report = await cleanupAgentWorktrees({ repoRoot: repo, protectedPaths: [] }, deps('feat'))
  assert.equal(report.entries.find((entry) => entry.path === before)?.verdict, 'removed')
})

test('with no prefix, a worktree is an agent’s only when this profile’s agent lock is on it', async () => {
  setAgentWorktreeLockProfile('/Users/dev/profile-a')
  const { repo, container } = await makeRepo()
  const made = await createGitWorktree({
    repoRoot: repo,
    containerPath: container,
    destinationPath: join(container, 'chat-ab12'),
    branchName: 'chat-ab12',
    baseRef: 'origin/main',
    agentLockOwner: 'chat-ab12',
  })
  assert.ok(made.ok, made.ok ? '' : made.message)
  const unlocked = join(container, 'fix-login')
  await git(repo, 'worktree', 'add', '-q', '-b', 'fix-login', unlocked, 'origin/main')

  const report = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [], ownedOnly: true, keepBranches: [] },
    deps(''),
  )
  const verdicts = new Map(report.entries.map((entry) => [entry.path, entry.verdict]))
  assert.equal(verdicts.get(made.data.path), 'removed', 'Studio made it, and its lock says so')
  assert.equal(verdicts.get(unlocked), 'recent', 'nothing says Studio made it: kept until a day unused')
  assert.deepEqual(report.deletedBranches, [], 'the worktree goes, its unprefixed branch stays')
  assert.ok((await localBranches(repo)).includes('chat-ab12'))
})
