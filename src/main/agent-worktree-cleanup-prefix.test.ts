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
import { createNodeStudioPlatform, installStudioPlatform, resetStudioPlatform } from '../server/platform/platform'
import { createWorktreeBranchLedger } from './worktree-branch-ledger'

/**
 * What the cleanup takes as Studio's once the person may choose the branch
 * prefix: a branch under `agent/`, as before, or one in the record of the
 * branches Studio made (worktree-branch-ledger.ts). A branch under the chosen
 * prefix that Studio did not make is the person's, and is never deleted, and
 * a record that is missing or unreadable deletes nothing but `agent/` ones.
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

afterEach(() => {
  setAgentWorktreeLockProfile(null)
  resetStudioPlatform()
})

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

/** A clone of its own per case, with `origin/main` to measure "merged" against, and a profile to record in. */
async function makeRepo(): Promise<{ repo: string; container: string; profile: string }> {
  caseNumber += 1
  const dir = join(scratch, `case-${caseNumber}`)
  const profile = join(dir, 'profile')
  await mkdir(profile, { recursive: true })
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
  return { repo, container, profile }
}

/** Branches at `origin/main`, so each is merged by having no work of its own. */
async function mergedBranches(repo: string, ...names: string[]): Promise<void> {
  for (const name of names) await git(repo, 'branch', name, 'origin/main')
}

async function localBranches(repo: string): Promise<string[]> {
  return (await git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).split('\n').filter(Boolean).sort()
}

const ledgerIn = (profile: string) => createWorktreeBranchLedger({ dataDir: () => profile, log: () => {} })

function deps(profile: string): AgentWorktreeCleanupDeps {
  return { log: () => {}, now: later, ledger: ledgerIn(profile) }
}

async function cleanup(repo: string, profile: string, options: { keepBranches?: string[]; dryRun?: boolean } = {}) {
  return cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [], keepBranches: options.keepBranches ?? [], dryRun: options.dryRun },
    deps(profile),
  )
}

test('a person’s merged branch under the prefix survives; the one Studio recorded is deleted', async () => {
  const { repo, profile } = await makeRepo()
  await mergedBranches(repo, 'feat/x', 'feat/chat-1', 'agent/b', 'feature/c', 'release')
  await ledgerIn(profile).record(repo, 'feat/chat-1')
  const report = await cleanup(repo, profile)
  assert.deepEqual([...(report.deletedBranches ?? [])].sort(), ['agent/b', 'feat/chat-1'])
  assert.deepEqual(await localBranches(repo), ['feat/x', 'feature/c', 'main', 'release'])
})

test('a branch Studio deleted is struck off its record', async () => {
  const { repo, profile } = await makeRepo()
  await mergedBranches(repo, 'feat/chat-1', 'feat/chat-2')
  await ledgerIn(profile).record(repo, 'feat/chat-1')
  await ledgerIn(profile).record(repo, 'feat/chat-2')
  await cleanup(repo, profile, { keepBranches: ['feat/chat-2'] })
  assert.deepEqual([...(await ledgerIn(profile).branches(repo))], ['feat/chat-2'], 'kept for its chat, still recorded')
})

test('a recorded branch that is gone is struck off, and a dry run changes nothing', async () => {
  const { repo, profile } = await makeRepo()
  await mergedBranches(repo, 'feat/chat-1')
  await ledgerIn(profile).record(repo, 'feat/chat-1')
  await ledgerIn(profile).record(repo, 'feat/deleted-by-hand')
  const dry = await cleanup(repo, profile, { dryRun: true })
  assert.deepEqual(dry.deletedBranches, ['feat/chat-1'])
  assert.equal((await ledgerIn(profile).branches(repo)).size, 2)
  assert.deepEqual(await localBranches(repo), ['feat/chat-1', 'main'])
  await cleanup(repo, profile)
  assert.equal((await ledgerIn(profile).branches(repo)).size, 0)
})

test('the record a previous run wrote still lets the cleanup delete Studio’s branch', async () => {
  const { repo, profile } = await makeRepo()
  await mergedBranches(repo, 'feat/chat-1')
  // Recorded by one run of the app; the cleanup below is the next run's.
  await ledgerIn(profile).record(repo, 'feat/chat-1')
  const report = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [], keepBranches: [] },
    { log: () => {}, now: later, ledger: createWorktreeBranchLedger({ dataDir: () => profile }) },
  )
  assert.deepEqual(report.deletedBranches, ['feat/chat-1'])
})

test('with no record, or one that cannot be read, only agent/ branches are deleted', async () => {
  for (const content of [null, '{ corrupt', '{"version":1,"repos":[]}']) {
    const { repo, profile } = await makeRepo()
    if (content !== null) await writeFile(join(profile, 'worktree-branches.json'), content)
    await mergedBranches(repo, 'feat/chat-1', 'chat-ab12', 'agent/b')
    const report = await cleanup(repo, profile)
    assert.deepEqual(report.deletedBranches, ['agent/b'], String(content))
    assert.deepEqual(await localBranches(repo), ['chat-ab12', 'feat/chat-1', 'main'])
  }
})

test('with no prefix, a recorded unprefixed branch is deleted and a person’s is not', async () => {
  const { repo, profile } = await makeRepo()
  await mergedBranches(repo, 'chat-ab12', 'fix-login')
  await ledgerIn(profile).record(repo, 'chat-ab12')
  const report = await cleanup(repo, profile)
  assert.deepEqual(report.deletedBranches, ['chat-ab12'])
  assert.deepEqual(await localBranches(repo), ['fix-login', 'main'])
})

test('a recorded branch with work the default branch lacks is kept', async () => {
  const { repo, container, profile } = await makeRepo()
  const path = join(container, 'wip')
  await git(repo, 'worktree', 'add', '-q', '-b', 'feat/wip', path, 'origin/main')
  await writeFile(join(path, 'wip.txt'), 'wip\n')
  await git(path, 'add', '.')
  await git(path, 'commit', '-q', '-m', 'wip')
  await git(repo, 'worktree', 'remove', path)
  await ledgerIn(profile).record(repo, 'feat/wip')
  const report = await cleanup(repo, profile)
  assert.deepEqual(report.deletedBranches, [])
  assert.ok((await localBranches(repo)).includes('feat/wip'))
})

test('a worktree on a recorded branch is an agent’s; one on a person’s branch under the prefix waits a day', async () => {
  const { repo, container, profile } = await makeRepo()
  const studio = join(container, 'studio')
  const own = join(container, 'own')
  await git(repo, 'worktree', 'add', '-q', '-b', 'feat/studio', studio, 'origin/main')
  await git(repo, 'worktree', 'add', '-q', '-b', 'feat/own', own, 'origin/main')
  await ledgerIn(profile).record(repo, 'feat/studio')
  const report = await cleanupAgentWorktrees({ repoRoot: repo, protectedPaths: [] }, deps(profile))
  const verdicts = new Map(report.entries.map((entry) => [entry.path, entry.verdict]))
  assert.equal(verdicts.get(studio), 'removed')
  assert.equal(verdicts.get(own), 'recent', 'the person’s: kept until a day unused')
  assert.equal(await exists(studio), false)
  assert.equal(await exists(own), true)
})

test('a worktree under agent/ is an agent’s, recorded or not', async () => {
  const { repo, container, profile } = await makeRepo()
  const before = join(container, 'before')
  await git(repo, 'worktree', 'add', '-q', '-b', 'agent/before', before, 'origin/main')
  const report = await cleanupAgentWorktrees({ repoRoot: repo, protectedPaths: [] }, deps(profile))
  assert.equal(report.entries.find((entry) => entry.path === before)?.verdict, 'removed')
})

test('a worktree Studio makes records its branch, which the cleanup then deletes once merged', async () => {
  const { repo, container, profile } = await makeRepo()
  installStudioPlatform(createNodeStudioPlatform({ dataDir: profile, packaged: false, version: '0.0.0' }))
  setAgentWorktreeLockProfile('/Users/dev/profile-a')
  const made = await createGitWorktree({
    repoRoot: repo,
    containerPath: container,
    destinationPath: join(container, 'chat-1'),
    branchName: 'feat/chat-1',
    baseRef: 'origin/main',
    agentLockOwner: 'feat/chat-1',
  })
  assert.ok(made.ok, made.ok ? '' : made.message)
  // A worktree the person makes in the same container, on a branch of their own.
  const own = await createGitWorktree({
    repoRoot: repo,
    containerPath: container,
    destinationPath: join(container, 'own'),
    branchName: 'feat/own',
    baseRef: 'origin/main',
  })
  assert.ok(own.ok, own.ok ? '' : own.message)
  assert.deepEqual([...(await ledgerIn(profile).branches(repo))], ['feat/chat-1'])

  // Its worktree goes first (Studio made it: its lock and its record say so),
  // then its branch, merged by having no work of its own.
  const report = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [], keepBranches: [] },
    { log: () => {}, now: later },
  )
  assert.equal(report.entries.find((entry) => entry.path === made.data.path)?.verdict, 'removed')
  assert.deepEqual(report.deletedBranches, ['feat/chat-1'])
  assert.ok((await localBranches(repo)).includes('feat/own'))
})
