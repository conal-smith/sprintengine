import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  abortGitOperation,
  checkoutGitCommit,
  checkoutGitCommitAsBranch,
  cherryPickGitCommit,
  continueGitOperation,
  createGitBranchFromCommit,
  createGitTagFromCommit,
  deleteGitBranch,
  mergeGitRef,
  pullGitBranchWithStash,
  pushGitBranch,
  rebaseGitBranch,
  renameGitBranch,
  resetGitBranchToCommit,
  revertGitCommit,
  switchGitBranch,
} from './git-branch-actions'
import { getGitOperationInProgress } from './git-status'
import { runGitCommand } from './git-utils'
import { test, vi } from 'vitest'

// Every action still runs the real git; the wrapper only lets a test read the
// arguments one was given.
vi.mock('./git-utils', async (original) => {
  const actual = await original<typeof import('./git-utils')>()
  return { ...actual, runGitCommand: vi.fn(actual.runGitCommand) }
})

test('git-branch-actions', async () => {
  const suiteRun = main()

  async function main(): Promise<void> {
    await assertPullMergesDivergentBranches()
    await assertMergeAction()
    await assertCommitActions()
    await assertMergeConflictLifecycle()
    await assertRebaseAction()
    await assertCherryPickAndRevert()
    await assertResetAction()
    await assertBranchManagement()
  }

  async function assertMergeConflictLifecycle(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'sprintengine-git-merge-conflict-'))
    const repo = join(root, 'repo')

    try {
      git(root, ['init', '--initial-branch=main', repo])
      configureRepo(repo)
      writeFileSync(join(repo, 'file.txt'), 'base\n')
      git(repo, ['add', 'file.txt'])
      git(repo, ['commit', '-m', 'base'])

      git(repo, ['switch', '-c', 'side'])
      writeFileSync(join(repo, 'file.txt'), 'side\n')
      git(repo, ['commit', '-am', 'side'])
      git(repo, ['switch', 'main'])
      writeFileSync(join(repo, 'file.txt'), 'main\n')
      git(repo, ['commit', '-am', 'main'])

      assert.equal(await getGitOperationInProgress(repo), null)

      // A conflicted merge parks the repo in the merge operation state.
      const conflicted = await mergeGitRef(repo, 'side')
      assert.equal(conflicted.ok, false)
      assert.equal(await getGitOperationInProgress(repo), 'merge')

      // Abort restores a clean tree and clears the state.
      const aborted = await abortGitOperation(repo, 'merge')
      assert.equal(aborted.ok, true, aborted.message ?? aborted.stderr)
      assert.equal(await getGitOperationInProgress(repo), null)
      assert.equal(git(repo, ['status', '--porcelain=v1']).trim(), '')

      // Resolve + continue completes the merge without opening an editor.
      const conflictedAgain = await mergeGitRef(repo, 'side')
      assert.equal(conflictedAgain.ok, false)
      writeFileSync(join(repo, 'file.txt'), 'resolved\n')
      git(repo, ['add', 'file.txt'])
      const continued = await continueGitOperation(repo, 'merge')
      assert.equal(continued.ok, true, continued.message ?? continued.stderr)
      assert.equal(await getGitOperationInProgress(repo), null)
      assert.match(git(repo, ['log', '--oneline', '--merges', '-1']), /Merge /)

      // A parked `git am` also creates rebase-apply (with its `applying` marker);
      // it is not ours to continue/abort, so it must not read as a rebase.
      mkdirSync(join(repo, '.git', 'rebase-apply'), { recursive: true })
      writeFileSync(join(repo, '.git', 'rebase-apply', 'applying'), '')
      assert.equal(await getGitOperationInProgress(repo), null)
      rmSync(join(repo, '.git', 'rebase-apply'), { force: true, recursive: true })

      console.log('ok - merge conflict lifecycle: operation state, abort, resolve + continue, am exclusion')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  }

  async function assertRebaseAction(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'sprintengine-git-rebase-'))
    const repo = join(root, 'repo')

    try {
      git(root, ['init', '--initial-branch=main', repo])
      configureRepo(repo)
      writeFileSync(join(repo, 'file.txt'), 'base\n')
      git(repo, ['add', 'file.txt'])
      git(repo, ['commit', '-m', 'base'])
      const baseCommit = git(repo, ['rev-parse', 'HEAD']).trim()

      git(repo, ['switch', '-c', 'feature'])
      writeFileSync(join(repo, 'feature.txt'), 'feature\n')
      git(repo, ['add', 'feature.txt'])
      git(repo, ['commit', '-m', 'feature'])
      git(repo, ['switch', 'main'])
      writeFileSync(join(repo, 'main.txt'), 'main\n')
      git(repo, ['add', 'main.txt'])
      git(repo, ['commit', '-m', 'main'])
      const mainTip = git(repo, ['rev-parse', 'HEAD']).trim()

      // Same-branch and empty targets are rejected before shelling out.
      const sameBranch = await rebaseGitBranch(repo, 'main')
      assert.equal(sameBranch.ok, false)
      assert.equal(sameBranch.message, 'Choose a different branch or commit to rebase onto.')
      const empty = await rebaseGitBranch(repo, '  ')
      assert.equal(empty.ok, false)

      git(repo, ['switch', 'feature'])

      // Dirty tracked changes block the rebase with a clear message.
      writeFileSync(join(repo, 'file.txt'), 'dirty\n')
      const dirty = await rebaseGitBranch(repo, 'main')
      assert.equal(dirty.ok, false)
      assert.match(dirty.message ?? '', /tracked changes/)
      git(repo, ['checkout', '--', 'file.txt'])

      // A clean rebase replays feature on top of main.
      const rebased = await rebaseGitBranch(repo, 'main')
      assert.equal(rebased.ok, true, rebased.message ?? rebased.stderr)
      assert.equal(git(repo, ['rev-parse', 'HEAD~1']).trim(), mainTip)
      assert.equal(git(repo, ['show', 'HEAD:feature.txt']).trim(), 'feature')

      // Detached HEAD is rejected.
      git(repo, ['checkout', baseCommit])
      const detached = await rebaseGitBranch(repo, 'main')
      assert.equal(detached.ok, false)
      assert.match(detached.message ?? '', /detached/)
      git(repo, ['switch', 'feature'])

      // A conflicted rebase parks the rebase operation state; abort restores.
      git(repo, ['switch', '-c', 'conflicting', baseCommit])
      writeFileSync(join(repo, 'main.txt'), 'conflicting\n')
      git(repo, ['add', 'main.txt'])
      git(repo, ['commit', '-m', 'conflicting'])
      const conflicted = await rebaseGitBranch(repo, 'main')
      assert.equal(conflicted.ok, false)
      assert.equal(await getGitOperationInProgress(repo), 'rebase')
      const aborted = await abortGitOperation(repo, 'rebase')
      assert.equal(aborted.ok, true, aborted.message ?? aborted.stderr)
      assert.equal(await getGitOperationInProgress(repo), null)
      assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'conflicting')

      // Resolve + continue finishes the rebase without opening an editor.
      const conflictedAgain = await rebaseGitBranch(repo, 'main')
      assert.equal(conflictedAgain.ok, false)
      writeFileSync(join(repo, 'main.txt'), 'resolved\n')
      git(repo, ['add', 'main.txt'])
      const continued = await continueGitOperation(repo, 'rebase')
      assert.equal(continued.ok, true, continued.message ?? continued.stderr)
      assert.equal(await getGitOperationInProgress(repo), null)
      assert.equal(git(repo, ['show', 'HEAD:main.txt']).trim(), 'resolved')

      console.log('ok - rebase action: replay, guards, conflict abort + continue')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  }

  async function assertCherryPickAndRevert(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'sprintengine-git-cherry-pick-'))
    const repo = join(root, 'repo')

    try {
      git(root, ['init', '--initial-branch=main', repo])
      configureRepo(repo)
      writeFileSync(join(repo, 'file.txt'), 'base\n')
      git(repo, ['add', 'file.txt'])
      git(repo, ['commit', '-m', 'base'])

      git(repo, ['switch', '-c', 'side'])
      writeFileSync(join(repo, 'side.txt'), 'side\n')
      git(repo, ['add', 'side.txt'])
      git(repo, ['commit', '-m', 'side'])
      const sideCommit = git(repo, ['rev-parse', 'HEAD']).trim()
      git(repo, ['switch', 'main'])
      // Diverge main so the pick gets a different parent (otherwise the new
      // commit can be bit-identical to the original) and the later merge cannot
      // fast-forward (the refusal assertions need a real merge commit).
      writeFileSync(join(repo, 'main.txt'), 'main\n')
      git(repo, ['add', 'main.txt'])
      git(repo, ['commit', '-m', 'main'])

      // Invalid hash is rejected before shelling out.
      const invalid = await cherryPickGitCommit(repo, 'not-a-hash')
      assert.equal(invalid.ok, false)
      assert.equal(invalid.message, 'Invalid commit hash.')

      // Cherry-pick applies the commit as a new commit on the current branch.
      const picked = await cherryPickGitCommit(repo, sideCommit)
      assert.equal(picked.ok, true, picked.message ?? picked.stderr)
      assert.equal(git(repo, ['show', 'HEAD:side.txt']).trim(), 'side')
      assert.notEqual(git(repo, ['rev-parse', 'HEAD']).trim(), sideCommit)

      // Revert creates an inverse commit; the file is gone again.
      const revertTarget = git(repo, ['rev-parse', 'HEAD']).trim()
      const reverted = await revertGitCommit(repo, revertTarget)
      assert.equal(reverted.ok, true, reverted.message ?? reverted.stderr)
      assert.throws(() => git(repo, ['show', 'HEAD:side.txt']))

      // Merge commits are refused for both operations with guidance.
      const merged = await mergeGitRef(repo, 'side')
      assert.equal(merged.ok, true, merged.message ?? merged.stderr)
      const mergeCommit = git(repo, ['rev-parse', 'HEAD']).trim()
      const pickMerge = await cherryPickGitCommit(repo, mergeCommit)
      assert.equal(pickMerge.ok, false)
      assert.match(pickMerge.message ?? '', /merge commit/)
      const revertMerge = await revertGitCommit(repo, mergeCommit)
      assert.equal(revertMerge.ok, false)
      assert.match(revertMerge.message ?? '', /merge commit/)

      // A conflicted cherry-pick parks the cherry-pick state; abort clears it.
      git(repo, ['switch', '-c', 'pick-conflict'])
      writeFileSync(join(repo, 'file.txt'), 'theirs\n')
      git(repo, ['commit', '-am', 'theirs'])
      const conflictSource = git(repo, ['rev-parse', 'HEAD']).trim()
      git(repo, ['switch', 'main'])
      writeFileSync(join(repo, 'file.txt'), 'ours\n')
      git(repo, ['commit', '-am', 'ours'])
      const conflicted = await cherryPickGitCommit(repo, conflictSource)
      assert.equal(conflicted.ok, false)
      assert.equal(await getGitOperationInProgress(repo), 'cherry-pick')
      const aborted = await abortGitOperation(repo, 'cherry-pick')
      assert.equal(aborted.ok, true, aborted.message ?? aborted.stderr)
      assert.equal(await getGitOperationInProgress(repo), null)

      console.log('ok - cherry-pick + revert: apply, inverse commit, merge-commit refusal, conflict abort')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  }

  async function assertResetAction(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'sprintengine-git-reset-'))
    const repo = join(root, 'repo')

    try {
      git(root, ['init', '--initial-branch=main', repo])
      configureRepo(repo)
      writeFileSync(join(repo, 'file.txt'), 'v1\n')
      git(repo, ['add', 'file.txt'])
      git(repo, ['commit', '-m', 'first'])
      const firstCommit = git(repo, ['rev-parse', 'HEAD']).trim()
      writeFileSync(join(repo, 'file.txt'), 'v2\n')
      git(repo, ['commit', '-am', 'second'])
      const secondCommit = git(repo, ['rev-parse', 'HEAD']).trim()
      writeFileSync(join(repo, 'file.txt'), 'v3\n')
      git(repo, ['commit', '-am', 'third'])

      // Soft: HEAD moves, the undone changes stay staged.
      const soft = await resetGitBranchToCommit(repo, secondCommit, 'soft')
      assert.equal(soft.ok, true, soft.message ?? soft.stderr)
      assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), secondCommit)
      assert.match(git(repo, ['status', '--porcelain=v1']), /^M {2}file\.txt/m)

      // Mixed: HEAD moves, the undone changes stay unstaged.
      const mixed = await resetGitBranchToCommit(repo, firstCommit, 'mixed')
      assert.equal(mixed.ok, true, mixed.message ?? mixed.stderr)
      assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), firstCommit)
      assert.match(git(repo, ['status', '--porcelain=v1']), /^ M file\.txt/m)

      // Hard: the working tree is reset too.
      const hard = await resetGitBranchToCommit(repo, firstCommit, 'hard')
      assert.equal(hard.ok, true, hard.message ?? hard.stderr)
      assert.equal(git(repo, ['status', '--porcelain=v1']).trim(), '')
      assert.equal(git(repo, ['show', 'HEAD:file.txt']).trim(), 'v1')

      // Unknown modes and detached HEAD are rejected.
      const badMode = await resetGitBranchToCommit(repo, firstCommit, 'oops' as never)
      assert.equal(badMode.ok, false)
      assert.match(badMode.message ?? '', /reset mode/)
      git(repo, ['checkout', firstCommit])
      const detached = await resetGitBranchToCommit(repo, firstCommit, 'soft')
      assert.equal(detached.ok, false)
      assert.match(detached.message ?? '', /detached/)

      console.log('ok - reset action: soft, mixed, hard, mode + detached guards')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  }

  async function assertBranchManagement(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'sprintengine-git-branch-management-'))
    const repo = join(root, 'repo')

    try {
      git(root, ['init', '--initial-branch=main', repo])
      configureRepo(repo)
      writeFileSync(join(repo, 'file.txt'), 'base\n')
      git(repo, ['add', 'file.txt'])
      git(repo, ['commit', '-m', 'base'])

      // The current branch cannot be deleted.
      const current = await deleteGitBranch(repo, 'main')
      assert.equal(current.ok, false)
      assert.match(current.message ?? '', /branch you are on/)

      // A fully-merged branch deletes without force.
      git(repo, ['branch', 'merged-branch'])
      const merged = await deleteGitBranch(repo, 'merged-branch')
      assert.equal(merged.ok, true, merged.message ?? merged.stderr)

      // An unmerged branch is refused, then force-deletes.
      git(repo, ['switch', '-c', 'unmerged'])
      writeFileSync(join(repo, 'extra.txt'), 'extra\n')
      git(repo, ['add', 'extra.txt'])
      git(repo, ['commit', '-m', 'extra'])
      git(repo, ['switch', 'main'])
      const refused = await deleteGitBranch(repo, 'unmerged')
      assert.equal(refused.ok, false)
      assert.match(`${refused.message ?? ''}\n${refused.stderr}`, /not fully merged/i)
      const forced = await deleteGitBranch(repo, 'unmerged', true)
      assert.equal(forced.ok, true, forced.message ?? forced.stderr)
      assert.throws(() => git(repo, ['rev-parse', '--verify', 'unmerged']))

      // Rename moves the ref.
      git(repo, ['branch', 'old-name'])
      const renamed = await renameGitBranch(repo, 'old-name', 'new-name')
      assert.equal(renamed.ok, true, renamed.message ?? renamed.stderr)
      assert.doesNotThrow(() => git(repo, ['rev-parse', '--verify', 'new-name']))
      assert.throws(() => git(repo, ['rev-parse', '--verify', 'old-name']))

      console.log('ok - branch management: delete guards, force delete, rename')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  }

  async function assertMergeAction(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'sprintengine-git-merge-action-'))
    const repo = join(root, 'repo')

    try {
      git(root, ['init', '--initial-branch=main', repo])
      configureRepo(repo)
      writeFileSync(join(repo, 'file.txt'), 'base\n')
      git(repo, ['add', 'file.txt'])
      git(repo, ['commit', '-m', 'base'])
      const baseCommit = git(repo, ['rev-parse', 'HEAD']).trim()

      const empty = await mergeGitRef(repo, '   ')
      assert.equal(empty.ok, false)
      assert.equal(empty.message, 'Choose a branch or commit to merge.')

      const current = await mergeGitRef(repo, 'main')
      assert.equal(current.ok, false)
      assert.equal(current.message, 'Choose a different branch or commit to merge.')

      git(repo, ['switch', '-c', 'feature'])
      writeFileSync(join(repo, 'feature.txt'), 'feature\n')
      git(repo, ['add', 'feature.txt'])
      git(repo, ['commit', '-m', 'feature'])
      const featureCommit = git(repo, ['rev-parse', 'HEAD']).trim()
      git(repo, ['switch', 'main'])

      const mergedBranch = await mergeGitRef(repo, 'feature')
      assert.equal(mergedBranch.ok, true, mergedBranch.message ?? mergedBranch.stderr)
      assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), featureCommit)
      assert.equal(git(repo, ['show', 'HEAD:feature.txt']).trim(), 'feature')

      git(repo, ['switch', '-c', 'side'])
      writeFileSync(join(repo, 'side.txt'), 'side\n')
      git(repo, ['add', 'side.txt'])
      git(repo, ['commit', '-m', 'side'])
      git(repo, ['switch', 'main'])
      writeFileSync(join(repo, 'main.txt'), 'main\n')
      git(repo, ['add', 'main.txt'])
      git(repo, ['commit', '-m', 'main'])

      const mergedDivergent = await mergeGitRef(repo, 'side')
      assert.equal(mergedDivergent.ok, true, mergedDivergent.message ?? mergedDivergent.stderr)
      assert.match(git(repo, ['log', '--oneline', '--merges', '-1']), /Merge /)
      assert.equal(git(repo, ['status', '--porcelain=v1']).trim(), '')

      git(repo, ['switch', '-c', 'hash-source'])
      writeFileSync(join(repo, 'hash.txt'), 'hash\n')
      git(repo, ['add', 'hash.txt'])
      git(repo, ['commit', '-m', 'hash source'])
      const hashSourceCommit = git(repo, ['rev-parse', 'HEAD']).trim()
      git(repo, ['switch', 'main'])

      const mergedCommit = await mergeGitRef(repo, hashSourceCommit)
      assert.equal(mergedCommit.ok, true, mergedCommit.message ?? mergedCommit.stderr)
      assert.equal(git(repo, ['show', 'HEAD:hash.txt']).trim(), 'hash')

      writeFileSync(join(repo, 'file.txt'), 'dirty\n')
      const dirty = await mergeGitRef(repo, 'side')
      assert.equal(dirty.ok, false)
      assert.match(dirty.message ?? '', /tracked changes/)
      git(repo, ['checkout', '--', 'file.txt'])

      git(repo, ['checkout', baseCommit])
      const detached = await mergeGitRef(repo, 'side')
      assert.equal(detached.ok, false)
      assert.match(detached.message ?? '', /detached/)

      console.log('ok - merge action: branch, commit, divergent merge, dirty guard, detached guard')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  }

  async function assertCommitActions(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'sprintengine-git-commit-actions-'))
    const repo = join(root, 'repo')

    try {
      git(root, ['init', '--initial-branch=main', repo])
      configureRepo(repo)
      writeFileSync(join(repo, 'file.txt'), 'v1\n')
      git(repo, ['add', 'file.txt'])
      git(repo, ['commit', '-m', 'first'])
      const firstCommit = git(repo, ['rev-parse', 'HEAD']).trim()
      writeFileSync(join(repo, 'file.txt'), 'v2\n')
      git(repo, ['commit', '-am', 'second'])

      // Invalid hash is rejected before shelling out.
      const invalid = await checkoutGitCommit(repo, 'not-a-hash')
      assert.equal(invalid.ok, false)
      assert.equal(invalid.message, 'Invalid commit hash.')

      // Empty branch name is rejected.
      const emptyName = await createGitBranchFromCommit(repo, '   ', firstCommit)
      assert.equal(emptyName.ok, false)

      // Branch from a commit creates the ref without moving HEAD.
      const branched = await createGitBranchFromCommit(repo, 'feature', firstCommit)
      assert.equal(branched.ok, true, branched.message ?? branched.stderr)
      assert.equal(git(repo, ['rev-parse', 'feature']).trim(), firstCommit)

      // Checkout on a clean tree detaches HEAD at the requested commit.
      const checkedOut = await checkoutGitCommit(repo, firstCommit)
      assert.equal(checkedOut.ok, true, checkedOut.message ?? checkedOut.stderr)
      assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), firstCommit)
      assert.throws(() => git(repo, ['symbolic-ref', '-q', 'HEAD']), 'HEAD should be detached')

      git(repo, ['switch', 'main'])

      // A dirty tracked file blocks the detaching checkout with a clear message.
      writeFileSync(join(repo, 'file.txt'), 'dirty\n')
      const blocked = await checkoutGitCommit(repo, firstCommit)
      assert.equal(blocked.ok, false)
      assert.match(blocked.message ?? '', /tracked changes/)
      git(repo, ['checkout', '--', 'file.txt'])

      // Create-and-switch lands on a new branch at the commit.
      const asBranch = await checkoutGitCommitAsBranch(repo, 'feature2', firstCommit)
      assert.equal(asBranch.ok, true, asBranch.message ?? asBranch.stderr)
      assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'feature2')
      assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), firstCommit)

      // Tagging points a tag at the commit.
      const tagged = await createGitTagFromCommit(repo, 'v1.0.0', firstCommit)
      assert.equal(tagged.ok, true, tagged.message ?? tagged.stderr)
      assert.equal(git(repo, ['rev-parse', 'v1.0.0^{commit}']).trim(), firstCommit)

      console.log('ok - commit actions: checkout, branch, tag, dirty guard, invalid hash')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  }

  async function assertPullMergesDivergentBranches(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'sprintengine-git-pull-'))

    try {
      const remote = join(root, 'remote.git')
      const upstream = join(root, 'upstream')
      const local = join(root, 'local')

      git(root, ['init', '--bare', '--initial-branch=main', remote])
      git(root, ['clone', remote, upstream])
      configureRepo(upstream)
      writeFileSync(join(upstream, 'file.txt'), 'base\n')
      git(upstream, ['add', 'file.txt'])
      git(upstream, ['commit', '-m', 'base'])
      git(upstream, ['push', '-u', 'origin', 'main'])

      git(root, ['clone', remote, local])
      configureRepo(local)
      git(local, ['switch', 'main'])
      git(local, ['config', 'pull.ff', 'only'])

      writeFileSync(join(upstream, 'file.txt'), 'base\nremote\n')
      git(upstream, ['commit', '-am', 'remote'])
      git(upstream, ['push'])

      writeFileSync(join(local, 'local.txt'), 'local\n')
      git(local, ['add', 'local.txt'])
      git(local, ['commit', '-m', 'local'])

      const result = await pullGitBranchWithStash(local)

      assert.equal(result.ok, true, result.message ?? result.stderr)
      assert.match(git(local, ['log', '--oneline', '--merges', '-1']), /Merge /)
      assert.equal(git(local, ['status', '--porcelain=v1']).trim(), '')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  }

  function configureRepo(cwd: string): void {
    git(cwd, ['config', 'user.email', 'sprintengine@example.invalid'])
    git(cwd, ['config', 'user.name', 'SprintEngine Test'])
  }

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  await suiteRun
})

/** A bare origin with `main` and `develop`, and a clone of it. */
function pushFixture(): { root: string; origin: string; clone: string; run: (cwd: string, args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), 'sprintengine-git-push-'))
  const origin = join(root, 'origin.git')
  const clone = join(root, 'clone')
  const run = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  run(root, ['init', '--bare', '--initial-branch=main', origin])
  run(root, ['clone', '-q', origin, clone])
  run(clone, ['config', 'user.email', 'dev@example.com'])
  run(clone, ['config', 'user.name', 'Dev'])
  writeFileSync(join(clone, 'file.txt'), 'base\n')
  run(clone, ['add', 'file.txt'])
  run(clone, ['commit', '-qm', 'base'])
  run(clone, ['push', '-q', 'origin', 'main', 'main:develop'])
  run(clone, ['fetch', '-q'])
  return { root, origin, clone, run }
}

test('Push sends a branch cut from origin/main to its own name, never to main, and tracks it after', async () => {
  for (const pushDefault of ['upstream', null]) {
    const { root, origin, clone, run } = pushFixture()
    try {
      if (pushDefault) run(clone, ['config', 'push.default', pushDefault])
      // As a worktree's branch is made: from the base, so tracking it.
      run(clone, ['switch', '-q', '-c', 'feature/marks', '--track', 'origin/main'])
      writeFileSync(join(clone, 'marks.txt'), 'marks\n')
      run(clone, ['add', 'marks.txt'])
      run(clone, ['commit', '-qm', 'marks'])
      const mainBefore = run(origin, ['rev-parse', 'refs/heads/main'])

      const pushed = await pushGitBranch(clone)
      assert.equal(pushed.ok, true, pushed.message ?? pushed.stderr)
      assert.equal(pushed.pushedCommitCount, 1)
      assert.equal(run(origin, ['rev-parse', 'refs/heads/main']), mainBefore, 'main is untouched')
      assert.equal(run(origin, ['rev-parse', 'refs/heads/feature/marks']), run(clone, ['rev-parse', 'HEAD']))
      assert.equal(run(clone, ['rev-parse', '--abbrev-ref', '@{u}']), 'origin/feature/marks')

      // From then on it is an ordinary branch, counted against its own name.
      writeFileSync(join(clone, 'marks.txt'), 'marks 2\n')
      run(clone, ['commit', '-qam', 'more marks'])
      const again = await pushGitBranch(clone)
      assert.equal(again.ok, true, again.message ?? again.stderr)
      assert.equal(again.pushedCommitCount, 1)
      assert.equal(run(origin, ['rev-parse', 'refs/heads/feature/marks']), run(clone, ['rev-parse', 'HEAD']))
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  }
})

test('Push puts `--` before the remote, so a remote from the config is never read as an option', async () => {
  const { root, origin, clone, run } = pushFixture()
  try {
    run(clone, ['switch', '-q', '-c', 'feature/marks', '--track', 'origin/main'])
    writeFileSync(join(clone, 'marks.txt'), 'marks\n')
    run(clone, ['add', 'marks.txt'])
    run(clone, ['commit', '-qm', 'marks'])
    vi.mocked(runGitCommand).mockClear()

    const pushed = await pushGitBranch(clone)
    assert.equal(pushed.ok, true, pushed.message ?? pushed.stderr)
    const pushes = vi
      .mocked(runGitCommand)
      .mock.calls.map(([, args]) => args)
      .filter((args) => args[0] === 'push')
    assert.deepEqual(pushes, [['push', '-u', '--', 'origin', 'HEAD:refs/heads/feature/marks']])
    assert.equal(run(origin, ['rev-parse', 'refs/heads/feature/marks']), run(clone, ['rev-parse', 'HEAD']))
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})

test('Switch refuses a branch name that starts with a dash before git sees it', async () => {
  vi.mocked(runGitCommand).mockClear()
  const refused = await switchGitBranch('/Users/dev/acme', '-x')
  assert.equal(refused.ok, false)
  assert.equal(refused.message, 'Branch names cannot start with a dash.')
  assert.equal(vi.mocked(runGitCommand).mock.calls.length, 0, 'git was not run')
})

test('Push keeps an upstream someone chose, and their push.default upstream still pushes to it', async () => {
  const { root, origin, clone, run } = pushFixture()
  try {
    run(clone, ['switch', '-q', '-c', 'topic', '--track', 'origin/develop'])
    writeFileSync(join(clone, 'topic.txt'), 'topic\n')
    run(clone, ['add', 'topic.txt'])
    run(clone, ['commit', '-qm', 'topic'])

    // Without the setting git would refuse; the branch goes to its own name and keeps tracking develop.
    const own = await pushGitBranch(clone)
    assert.equal(own.ok, true, own.message ?? own.stderr)
    assert.equal(run(origin, ['rev-parse', 'refs/heads/topic']), run(clone, ['rev-parse', 'HEAD']))
    assert.equal(run(clone, ['rev-parse', '--abbrev-ref', '@{u}']), 'origin/develop')

    run(clone, ['config', 'push.default', 'upstream'])
    const followed = await pushGitBranch(clone)
    assert.equal(followed.ok, true, followed.message ?? followed.stderr)
    assert.equal(run(origin, ['rev-parse', 'refs/heads/develop']), run(clone, ['rev-parse', 'HEAD']))
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})
