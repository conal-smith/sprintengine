import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, test } from 'vitest'

import { cleanupAgentWorktrees } from './agent-worktree-cleanup'
import { runGitCommand } from './git-run'

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

// Every worktree here is seconds old, which the idle rule keeps; these cases
// are about the other rules, so they run with the clock two hours on.
const later = (): number => Date.now() + 2 * 60 * 60_000

let scratch = ''
let repo = ''
let container = ''

async function addWorktree(slug: string, branch = `agent/${slug}`): Promise<string> {
  const path = join(container, slug)
  await git(repo, 'worktree', 'add', '-q', '-b', branch, path, 'origin/main')
  return path
}

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-worktree-cleanup-')))
  const origin = join(scratch, 'origin.git')
  const seed = join(scratch, 'seed')
  await mkdir(seed, { recursive: true })
  await git(seed, 'init', '-q', '-b', 'main')
  await writeFile(join(seed, 'README.md'), '# app\n')
  await git(seed, 'add', '.')
  await git(seed, 'commit', '-q', '-m', 'init')
  await git(scratch, 'clone', '-q', '--bare', seed, origin)
  repo = join(scratch, 'app')
  await git(scratch, 'clone', '-q', origin, repo)
  container = join(scratch, '.sprintengine-worktrees', 'app')
  await mkdir(container, { recursive: true })
})

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

test('clean agent worktrees nothing uses are removed; merged branches go with them, unmerged ones stay', async () => {
  // Merged: its one commit was pushed to origin/main and fetched.
  const merged = await addWorktree('merged')
  await writeFile(join(merged, 'feature.txt'), 'done\n')
  await git(merged, 'add', '.')
  await git(merged, 'commit', '-q', '-m', 'feature')
  await git(merged, 'push', '-q', 'origin', 'HEAD:main')
  await git(repo, 'fetch', '-q')

  // Never committed to, with dependencies installed (ignored files do not
  // make a worktree dirty, and go with it).
  const untouched = await addWorktree('untouched')
  await writeFile(join(repo, '.git', 'info', 'exclude'), 'node_modules/\n')
  await mkdir(join(untouched, 'node_modules', 'left-pad'), { recursive: true })
  await writeFile(join(untouched, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')

  // Unmerged: a commit origin/main does not have. Nothing uses it (its chat
  // settled), so it goes, and the commit stays on its branch.
  const unmerged = await addWorktree('unmerged')
  await writeFile(join(unmerged, 'wip.txt'), 'wip\n')
  await git(unmerged, 'add', '.')
  await git(unmerged, 'commit', '-q', '-m', 'wip')

  // Dirty: an untracked file, no commits.
  const dirty = await addWorktree('dirty')
  await writeFile(join(dirty, 'notes.md'), 'not committed\n')

  // In use: a workspace still points into it.
  const inUse = await addWorktree('in-use')

  // A live terminal sits in a subdirectory of this one.
  const live = await addWorktree('live')
  await mkdir(join(live, 'src'), { recursive: true })

  // Locked on purpose.
  const locked = await addWorktree('locked')
  await git(repo, 'worktree', 'lock', '--reason', 'kept for review', locked)

  // Not an agent worktree: made by hand in the Worktree manager.
  const manual = await addWorktree('manual', 'sprintengine/manual')

  const logs: string[] = []
  const dry = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [inUse], dryRun: true },
    { livePaths: () => [join(live, 'src')], log: (line) => logs.push(line), now: later },
  )
  const verdicts = Object.fromEntries(dry.entries.map((entry) => [entry.path.split('/').pop(), entry.verdict]))
  assert.deepEqual(verdicts, {
    merged: 'removed',
    untouched: 'removed',
    unmerged: 'removed',
    dirty: 'dirty',
    'in-use': 'in-use',
    live: 'in-use',
    locked: 'locked',
    // Another worktree: the same rules, and a day unused before it may go.
    manual: 'recent',
  })
  assert.equal(dry.defaultRef, 'origin/main')
  assert.equal(dry.entries.find((entry) => entry.verdict === 'dirty')?.changedPaths, 1)
  assert.ok(await exists(merged), 'a dry run removes nothing')
  assert.ok(logs.some((line) => line.startsWith('would remove') && line.includes('merged')))
  assert.ok(
    logs.some((line) => line.startsWith('kept (dirty)')),
    'keeps are logged too',
  )

  const real = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [inUse], keepBranches: [] },
    { livePaths: () => [join(live, 'src')], log: () => {}, now: later },
  )
  assert.deepEqual(
    real.entries
      .filter((entry) => entry.verdict === 'removed')
      .map((entry) => entry.path.split('/').pop())
      .sort(),
    ['merged', 'unmerged', 'untouched'],
  )
  assert.equal(await exists(merged), false)
  assert.equal(await exists(untouched), false)
  assert.equal(await exists(unmerged), false)
  for (const kept of [dirty, inUse, live, locked, manual]) assert.ok(await exists(kept), `${kept} is kept`)
  // Its work is on the default branch, so its branch goes too (owner ruling
  // 2026-10-05); unmerged work keeps both.
  assert.equal(await git(repo, 'branch', '--list', 'agent/merged'), '', 'a merged branch is deleted')
  assert.ok(real.deletedBranches?.includes('agent/merged'))
  assert.match(
    await git(repo, 'branch', '--list', 'agent/unmerged'),
    /agent\/unmerged/,
    'unmerged work keeps its branch',
  )
})

test('a worktree the app did not make goes once it is merged, clean and a day unused, even unattended', async () => {
  const dayLater = (): number => Date.now() + 25 * 60 * 60_000
  // Made by hand beside the repository, on a branch that never got a commit.
  const handMade = join(scratch, 'app-review')
  await git(repo, 'worktree', 'add', '-q', '-b', 'review/thing', handMade, 'origin/main')
  // An agent CLI's own worktree, inside the main checkout.
  const nested = join(repo, '.claude', 'worktrees', 'agent-1')
  await git(repo, 'worktree', 'add', '-q', '-b', 'worktree-agent-1', nested, 'origin/main')
  // Detached on a commit the default branch has.
  const detached = join(scratch, 'app-detached')
  await git(repo, 'worktree', 'add', '-q', '--detach', detached, 'origin/main')
  // Work the default branch lacks.
  const unmerged = join(scratch, 'app-unmerged')
  await git(repo, 'worktree', 'add', '-q', '-b', 'feat/unmerged', unmerged, 'origin/main')
  await writeFile(join(unmerged, 'wip.txt'), 'wip\n')
  await git(unmerged, 'add', '.')
  await git(unmerged, 'commit', '-q', '-m', 'wip')
  // Locked by a person: nothing here placed it, so nothing here lifts it.
  const locked = join(scratch, 'app-locked')
  await git(repo, 'worktree', 'add', '-q', '-b', 'feat/locked', locked, 'origin/main')
  await git(repo, 'worktree', 'lock', locked)
  // Open in a workspace: in use, and NOT locked for it (only agent worktrees are).
  const open = join(scratch, 'app-open')
  await git(repo, 'worktree', 'add', '-q', '-b', 'feat/open', open, 'origin/main')

  const verdictsOf = (report: Awaited<ReturnType<typeof cleanupAgentWorktrees>>) =>
    Object.fromEntries(
      report.entries
        .filter((entry) => [handMade, nested, detached, unmerged, locked, open].includes(entry.path))
        .map((entry) => [entry.path.split('/').pop(), entry.verdict]),
    )

  // Used within the day: kept, however merged and clean.
  const soon = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [open], dryRun: true, ownedOnly: true },
    { log: () => {}, now: later },
  )
  assert.deepEqual(verdictsOf(soon), {
    'app-review': 'recent',
    'agent-1': 'recent',
    'app-detached': 'recent',
    'app-unmerged': 'recent',
    'app-locked': 'locked',
    'app-open': 'in-use',
  })

  // Swept from a workspace opened on a worktree, the main checkout is listed
  // too, and is never a candidate.
  const fromWorktree = await cleanupAgentWorktrees(
    { repoRoot: open, protectedPaths: [open], dryRun: true },
    { log: () => {}, now: dayLater },
  )
  assert.ok(fromWorktree.entries.length > 0)
  assert.equal(
    fromWorktree.entries.some((entry) => entry.path === repo),
    false,
    'the main checkout is never a candidate',
  )

  const swept = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [open], ownedOnly: true, keepBranches: [] },
    { log: () => {}, now: dayLater },
  )
  assert.deepEqual(verdictsOf(swept), {
    'app-review': 'removed',
    'agent-1': 'removed',
    'app-detached': 'removed',
    'app-unmerged': 'unmerged',
    'app-locked': 'locked',
    'app-open': 'in-use',
  })
  for (const gone of [handMade, nested, detached]) assert.equal(await exists(gone), false, `${gone} is removed`)
  for (const kept of [unmerged, locked, open]) assert.ok(await exists(kept), `${kept} is kept`)

  // Unmerged, a week unused: it goes, and its commit stays on its branch.
  // Commits only a detached HEAD holds keep theirs for good.
  const orphan = join(scratch, 'app-orphan')
  await git(repo, 'worktree', 'add', '-q', '--detach', orphan, 'origin/main')
  await writeFile(join(orphan, 'lost.txt'), 'only here\n')
  await git(orphan, 'add', '.')
  await git(orphan, 'commit', '-q', '-m', 'on no branch')
  const weekLater = (): number => Date.now() + 8 * 24 * 60 * 60_000
  const commit = await git(unmerged, 'rev-parse', 'HEAD')
  const stale = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [open], ownedOnly: true, keepBranches: [] },
    { log: () => {}, now: weekLater },
  )
  assert.equal(verdictsOf(stale)['app-unmerged'], 'removed')
  assert.match(
    stale.entries.find((entry) => entry.path === unmerged)?.detail ?? '',
    /1 commit\(s\) stay on feat\/unmerged/,
  )
  assert.equal(await exists(unmerged), false)
  assert.equal(await git(repo, 'rev-parse', 'feat/unmerged'), commit, 'the branch keeps the work')
  assert.equal(stale.entries.find((entry) => entry.path === orphan)?.verdict, 'unmerged')
  assert.ok(await exists(orphan), 'a detached HEAD on commits no branch has is kept')
  const openBlock = (await git(repo, 'worktree', 'list', '--porcelain'))
    .split('\n\n')
    .find((block) => block.includes(open))
  assert.ok(openBlock && !openBlock.includes('\nlocked'), 'an open worktree is not locked for being open')
  // Its branch is not an agent branch: removing the worktree keeps it.
  assert.match(await git(repo, 'branch', '--list', 'review/thing'), /review\/thing/)
  await git(repo, 'worktree', 'unlock', locked)
})

/** A branch whose two commits reach origin/main as ONE squash commit. */
async function squashMerged(slug: string, extra?: string): Promise<string> {
  const path = await addWorktree(slug)
  await writeFile(join(path, `${slug}-1.txt`), 'one\n')
  await git(path, 'add', '.')
  await git(path, 'commit', '-q', '-m', 'one')
  await writeFile(join(path, `${slug}-2.txt`), 'two\n')
  await git(path, 'add', '.')
  await git(path, 'commit', '-q', '-m', 'two')
  // Squash onto origin/main from a scratch clone, as a PR merge would.
  const merger = join(scratch, `merger-${slug}`)
  await git(scratch, 'clone', '-q', join(scratch, 'origin.git'), merger)
  await git(merger, 'fetch', '-q', path, `agent/${slug}`)
  await git(merger, 'merge', '-q', '--squash', 'FETCH_HEAD')
  await git(merger, 'commit', '-q', '-m', `squash ${slug}`)
  await git(merger, 'push', '-q', 'origin', 'HEAD:main')
  await git(repo, 'fetch', '-q')
  if (extra) {
    // Work the squash did not carry: committed on the branch afterwards.
    await writeFile(join(path, extra), 'not merged\n')
    await git(path, 'add', '.')
    await git(path, 'commit', '-q', '-m', 'after the merge')
  }
  return path
}

test('a squash-merged branch is deleted with its worktree; one carrying more work keeps its branch', async () => {
  const squashed = await squashMerged('squashed')
  const moreWork = await squashMerged('more-work', 'late.txt')

  const report = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [], keepBranches: [] },
    { log: () => {}, now: later },
  )
  const byName = Object.fromEntries(report.entries.map((entry) => [entry.path.split('/').pop(), entry]))
  assert.equal(byName.squashed?.verdict, 'removed', 'its changes are already on origin/main')
  assert.match(byName.squashed?.detail ?? '', /squash-merged/)
  assert.equal(await exists(squashed), false)
  // Nothing uses it, so the worktree goes; the commit the squash did not
  // carry stays on its branch.
  assert.equal(byName['more-work']?.verdict, 'removed')
  assert.doesNotMatch(byName['more-work']?.detail ?? '', /squash-merged/)
  assert.equal(await exists(moreWork), false)
  assert.equal(report.deletedBranches?.includes('agent/more-work'), false)
  assert.equal(await git(repo, 'branch', '--list', 'agent/squashed'), '', 'a squash-merged branch is deleted')
  assert.match(await git(repo, 'branch', '--list', 'agent/more-work'), /agent\/more-work/, 'more work keeps its branch')
})

test('a git without merge-tree --write-tree falls back to the ancestry rule', async () => {
  const squashed = await squashMerged('old-git')
  const report = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [] },
    {
      log: () => {},
      now: later,
      // What git < 2.38 says to the flag: a usage error, never a tree.
      runGit: async (cwd, args) =>
        args[0] === 'merge-tree'
          ? { ok: false, stdout: '', stderr: "error: unknown option `write-tree'", message: 'usage: git merge-tree' }
          : runGitCommand(cwd, args),
    },
  )
  const entry = report.entries.find((candidate) => candidate.path === squashed)
  // An unsupported test is not "merged": the worktree goes as unmerged work
  // does, and its branch is not deleted.
  assert.equal(entry?.verdict, 'removed')
  assert.doesNotMatch(entry?.detail ?? '', /squash-merged/)
  assert.match(await git(repo, 'branch', '--list', 'agent/old-git'), /agent\/old-git/)
})

test('with no default branch to compare against, nothing is removed', async () => {
  const lonely = join(scratch, 'lonely')
  await mkdir(lonely, { recursive: true })
  await git(lonely, 'init', '-q', '-b', 'trunk')
  await writeFile(join(lonely, 'a.txt'), 'a\n')
  await git(lonely, 'add', '.')
  await git(lonely, 'commit', '-q', '-m', 'a')
  const lonelyContainer = join(scratch, '.sprintengine-worktrees', 'lonely')
  await mkdir(lonelyContainer, { recursive: true })
  const path = join(lonelyContainer, 'x')
  await git(lonely, 'worktree', 'add', '-q', '-b', 'agent/x', path)
  const report = await cleanupAgentWorktrees({ repoRoot: lonely, protectedPaths: [] }, { log: () => {}, now: later })
  assert.equal(report.defaultRef, null)
  assert.deepEqual(
    report.entries.map((entry) => entry.verdict),
    ['no-default-branch'],
  )
  assert.ok(await exists(path))
})

test('a chat whose session starts in a worktree while it is being checked keeps it', async () => {
  // Never committed to, so it would go; the chat's session starts there after
  // the sweep first looked, and is in the second look, asked of a server.
  const returning = await addWorktree('returning-chat')
  let asked = 0
  const report = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [] },
    {
      livePaths: async () => {
        asked += 1
        return asked > 1 ? [returning] : []
      },
      log: () => {},
      now: later,
    },
  )
  assert.equal(report.entries.find((entry) => entry.path === returning)?.verdict, 'in-use')
  assert.ok(await exists(returning))
})

test('an agent worktree whose folder was deleted is forgotten by git, so its merged branch can go', async () => {
  const gone = await addWorktree('folder-deleted')
  const handMade = await addWorktree('hand-made-deleted', 'sprintengine/hand-made-deleted')
  await rm(gone, { recursive: true, force: true })
  await rm(handMade, { recursive: true, force: true })

  const dry = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [], dryRun: true },
    { log: () => {}, now: later },
  )
  const dryVerdicts = Object.fromEntries(dry.entries.map((entry) => [entry.path.split('/').pop(), entry.verdict]))
  assert.equal(dryVerdicts['folder-deleted'], 'removed')
  assert.match(await git(repo, 'worktree', 'list'), /folder-deleted/, 'a dry run forgets nothing')

  const real = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [], keepBranches: [] },
    { log: () => {}, now: later },
  )
  const verdicts = Object.fromEntries(real.entries.map((entry) => [entry.path.split('/').pop(), entry.verdict]))
  assert.equal(verdicts['folder-deleted'], 'removed')
  // Not the app's: its folder may be on a volume that is not mounted.
  assert.equal(verdicts['hand-made-deleted'], 'missing')
  const listed = await git(repo, 'worktree', 'list')
  assert.doesNotMatch(listed, /folder-deleted/, 'git no longer holds it')
  assert.match(listed, /hand-made-deleted/, 'a worktree the app did not make keeps its note')
  assert.equal(await git(repo, 'branch', '--list', 'agent/folder-deleted'), '', 'its branch, merged, is deleted')
  assert.ok(real.deletedBranches?.includes('agent/folder-deleted'))
})
