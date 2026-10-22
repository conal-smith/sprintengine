import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  changedFileKindOf,
  countFileStatuses,
  isLinkedWorktree,
  parseNameStatusZ,
  parseNumstatZ,
  readBranchName,
  readBranchSpan,
  resolveBranchBase,
  resolveTrunk,
} from './git-branch-span'
import { test } from 'vitest'

test('git-branch-span', async () => {
  // The branch reading's plumbing (the-diff-an-agent-made / branch-scoped-row-diff).
  // The parser's shapes are here because they are silently wrong until someone
  // renames a file — this suite inherits that duty from checkpoint-store's, which
  // goes with the checkpoint machinery.

  let failures = 0
  async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], {
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

  const created: string[] = []
  function repo(prefix = 'sprintengine-branch-span-'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    created.push(dir)
    git(dir, 'init', '-b', 'main')
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-m', 'seed')
    return dir
  }

  const suiteRun = (async () => {
    // ---- parseNumstatZ ------------------------------------------------------

    await run('an ordinary change carries its path inline', () => {
      const stat = parseNumstatZ('3\t1\tsrc/a.ts\0')
      assert.deepEqual(stat.files, [{ path: 'src/a.ts', additions: 3, deletions: 1 }])
      assert.equal(stat.additions, 3)
      assert.equal(stat.deletions, 1)
      assert.equal(stat.changedFiles, 1)
    })

    await run('a rename emits THREE fields and is reported at its new path', () => {
      // The shape that silently drops or misattributes every file after it when
      // framed as two fields.
      const stat = parseNumstatZ('0\t0\t\0old/name.ts\0new/name.ts\0' + '4\t2\tsrc/after.ts\0')
      assert.deepEqual(stat.files, [
        { path: 'new/name.ts', additions: 0, deletions: 0 },
        { path: 'src/after.ts', additions: 4, deletions: 2 },
      ])
      assert.equal(stat.changedFiles, 2, 'the file after a rename survives')
    })

    await run('a binary file counts as changed and contributes no lines', () => {
      const stat = parseNumstatZ('-\t-\tassets/logo.png\0')
      assert.deepEqual(stat.files, [{ path: 'assets/logo.png', additions: 0, deletions: 0 }])
      assert.equal(stat.changedFiles, 1)
      assert.equal(stat.additions, 0)
    })

    await run('a path containing a newline round-trips exactly', () => {
      const stat = parseNumstatZ('1\t0\tsrc/we\nird.ts\0')
      assert.deepEqual(stat.files, [{ path: 'src/we\nird.ts', additions: 1, deletions: 0 }])
    })

    await run('empty and malformed output yield an empty stat, never a throw', () => {
      assert.equal(parseNumstatZ('').changedFiles, 0)
      assert.equal(parseNumstatZ('\0\0').changedFiles, 0)
      assert.equal(parseNumstatZ('garbage\0').changedFiles, 0)
    })

    await run('every empty stat is a FRESH object', () => {
      const first = parseNumstatZ('')
      first.files.push({ path: 'x', additions: 1, deletions: 0 })
      assert.equal(parseNumstatZ('').files.length, 0, 'not a shared mutable singleton')
    })

    // ---- base resolution ----------------------------------------------------

    await run('a feature branch merge-bases against local main', async () => {
      const dir = repo()
      const mainOid = git(dir, 'rev-parse', 'HEAD').trim()
      git(dir, 'checkout', '-b', 'feat')
      writeFileSync(join(dir, 'b.txt'), 'x\n')
      git(dir, 'add', '.')
      git(dir, 'commit', '-m', 'work')
      assert.equal(await resolveBranchBase(dir, 'feat'), mainOid)
    })

    await run('a repo with neither main nor master nor a remote has no base', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sprintengine-branch-span-solo-'))
      created.push(dir)
      git(dir, 'init', '-b', 'solo')
      writeFileSync(join(dir, 'a.txt'), 'one\n')
      git(dir, 'add', '.')
      git(dir, 'commit', '-m', 'seed')
      assert.equal(await resolveBranchBase(dir, 'solo'), null)
    })

    await run('origin/HEAD wins over the conventional guesses', async () => {
      const origin = repo('sprintengine-branch-span-origin-')
      git(origin, 'checkout', '-b', 'trunk')
      writeFileSync(join(origin, 'trunk.txt'), 'trunk\n')
      git(origin, 'add', '.')
      git(origin, 'commit', '-m', 'trunk work')

      const clone = mkdtempSync(join(tmpdir(), 'sprintengine-branch-span-clone-'))
      created.push(clone)
      rmSync(clone, { recursive: true, force: true })
      execFileSync('git', ['clone', '--quiet', origin, clone])
      // The clone's default branch is `trunk`; `main` also exists on the remote,
      // so a resolver that guessed origin/main first would pick the wrong base.
      const trunkOid = git(clone, 'rev-parse', 'HEAD').trim()
      git(clone, 'checkout', '-b', 'feat')
      writeFileSync(join(clone, 'c.txt'), 'c\n')
      git(clone, 'add', '.')
      git(clone, 'commit', '-m', 'feature')
      assert.equal(await resolveBranchBase(clone, 'feat'), trunkOid)
    })

    await run('a branch that IS the trunk takes no base at all', async () => {
      const dir = repo()
      // Local `main` is the trunk here, and HEAD is on it. Even with commits that
      // a remote has not seen, there is no branch work to attribute.
      writeFileSync(join(dir, 'b.txt'), 'b\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-m', 'more on main')
      assert.equal(await resolveBranchBase(dir, 'main'), null, 'decided by NAME, not by distance')
    })

    await run('resolveTrunk rejects a branch’s own remote-tracking ref', async () => {
      const origin = repo('sprintengine-branch-span-selftrack-origin-')
      const clone = mkdtempSync(join(tmpdir(), 'sprintengine-branch-span-selftrack-'))
      created.push(clone)
      rmSync(clone, { recursive: true, force: true })
      execFileSync('git', ['clone', '--quiet', origin, clone])
      git(clone, 'checkout', '-b', 'feat')
      writeFileSync(join(clone, 'b.txt'), 'b\n')
      git(clone, 'add', '-A')
      git(clone, 'commit', '-m', 'work')
      git(clone, 'push', '--quiet', '-u', 'origin', 'feat')

      const trunk = await resolveTrunk(clone, 'feat')
      assert.notEqual(trunk?.name, 'feat', 'origin/feat is where it was pushed, not a trunk')
      assert.equal(trunk?.name, 'main')
    })

    // ---- worktree detection -------------------------------------------------

    await run('the main checkout is not a linked worktree; a linked one is', async () => {
      const dir = repo()
      assert.equal(await isLinkedWorktree(dir), false)
      const tree = join(dir, '..', `sprintengine-branch-span-wt-${process.pid}`)
      created.push(tree)
      git(dir, 'worktree', 'add', '-b', 'wt', tree)
      assert.equal(await isLinkedWorktree(tree), true)
    })

    await run('a subdirectory of the main checkout is still not a worktree', async () => {
      const dir = repo()
      const sub = join(dir, 'src')
      execFileSync('mkdir', ['-p', sub])
      writeFileSync(join(sub, 'x.ts'), 'x\n')
      assert.equal(await isLinkedWorktree(sub), false, '--git-dir is relative from a repo root')
    })

    // ---- the span itself ----------------------------------------------------

    await run('a missing folder and a non-repo both read null', async () => {
      const plain = mkdtempSync(join(tmpdir(), 'sprintengine-branch-span-plain-'))
      created.push(plain)
      assert.equal(await readBranchSpan(plain), null)
      assert.equal(await readBranchSpan(join(plain, 'gone')), null)
    })

    await run('an unborn HEAD names its branch and spans nothing', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sprintengine-branch-span-unborn-'))
      created.push(dir)
      git(dir, 'init', '-b', 'main')
      writeFileSync(join(dir, 'a.txt'), 'x\n')
      const result = await readBranchSpan(dir)
      assert.equal(result?.branch, 'main')
      assert.equal(result?.baseOid, null)
      assert.equal(result?.aheadOfBase, false)
      assert.equal(result?.stat.changedFiles, 0)
    })

    await run('readBranchName is null on a detached HEAD, not a hash', async () => {
      const dir = repo()
      git(dir, 'checkout', '--detach', 'HEAD')
      assert.equal(await readBranchName(dir), null)
    })

    await run('a staged rename spans to its new path', async () => {
      const dir = repo()
      git(dir, 'checkout', '-b', 'feat')
      renameSync(join(dir, 'a.txt'), join(dir, 'renamed.txt'))
      git(dir, 'add', '-A')
      const result = await readBranchSpan(dir)
      const paths = (result?.stat.files ?? []).map((file) => file.path).sort()
      assert.ok(paths.includes('renamed.txt'), `expected the new path, got ${paths.join(', ')}`)
    })

    // ---- parseNameStatusZ: the OTHER `-z` framing --------------------------
    //
    // `--numstat` separates its fields with tabs and its records with NULs;
    // `--name-status` puts the status in a NUL-terminated field of its own and
    // follows a rename or copy with TWO paths. Reading one framing with the
    // other's rules silently shifts every file after the first rename by one.

    await run('an ordinary change is status then path', () => {
      const statuses = parseNameStatusZ('M\0src/a.ts\0D\0src/gone.ts\0A\0src/new.ts\0')
      assert.equal(statuses.get('src/a.ts'), 'updated')
      assert.equal(statuses.get('src/gone.ts'), 'removed')
      assert.equal(statuses.get('src/new.ts'), 'added')
      assert.equal(statuses.size, 3)
    })

    await run('a rename spends THREE fields and lands at its NEW path', () => {
      const statuses = parseNameStatusZ('R088\0old/name.ts\0new/name.ts\0M\0src/after.ts\0')
      assert.equal(statuses.get('new/name.ts'), 'updated', 'one moved file, never removed + added')
      assert.equal(statuses.has('old/name.ts'), false, 'the old path is not a file of its own')
      assert.equal(
        statuses.get('src/after.ts'),
        'updated',
        'the record after a rename must not be shifted by the extra field',
      )
    })

    await run('a copy’s new file is an added one', () => {
      const statuses = parseNameStatusZ('C075\0src/a.ts\0src/copy.ts\0')
      assert.equal(statuses.get('src/copy.ts'), 'added')
      assert.equal(statuses.has('src/a.ts'), false)
    })

    await run('a conflicted path reported twice collapses to one updated file', () => {
      // What `git diff --name-status` says about an unmerged path: `U` and then
      // `M`, the same file twice.
      const statuses = parseNameStatusZ('U\0a.txt\0M\0a.txt\0')
      assert.equal(statuses.size, 1)
      assert.equal(statuses.get('a.txt'), 'updated')
    })

    await run('empty and malformed name-status output yield an empty map, never a throw', () => {
      assert.equal(parseNameStatusZ('').size, 0)
      assert.equal(parseNameStatusZ('\0\0').size, 0)
      assert.equal(parseNameStatusZ('M\0').size, 0, 'a status with no path is not a file')
    })

    await run('every status letter folds into one of the three buckets', () => {
      assert.equal(changedFileKindOf('A'), 'added')
      assert.equal(changedFileKindOf('C075'), 'added')
      assert.equal(changedFileKindOf('D'), 'removed')
      assert.equal(changedFileKindOf('M'), 'updated')
      assert.equal(changedFileKindOf('R100'), 'updated')
      assert.equal(changedFileKindOf('T'), 'updated', 'a file that became a symlink is one file')
      assert.equal(changedFileKindOf('U'), 'updated', 'a conflicted file is work in progress')
      assert.equal(changedFileKindOf('X'), 'updated', 'the claim that says least')
      assert.equal(changedFileKindOf(''), 'updated')
    })

    await run('the counts are driven by the FILE LIST, so they always sum to it', () => {
      const files = [{ path: 'a' }, { path: 'b' }, { path: 'c' }, { path: 'unplaced' }]
      const counts = countFileStatuses(
        files,
        new Map([
          ['a', 'added' as const],
          ['b', 'removed' as const],
          ['c', 'updated' as const],
          ['not-in-the-diff', 'added' as const],
        ]),
      )
      assert.deepEqual(counts, { added: 1, updated: 2, removed: 1 })
      assert.equal(counts.added + counts.updated + counts.removed, files.length)
    })

    // ---- the span’s own per-status counts, against real repos ---------------

    await run('a span counts an add, an edit, a delete and a rename-with-edits', async () => {
      const dir = repo()
      const wide = Array.from({ length: 12 }, (_, index) => `l${index}`).join('\n') + '\n'
      writeFileSync(join(dir, 'm.txt'), wide)
      writeFileSync(join(dir, 'd.txt'), 'gone\n')
      writeFileSync(join(dir, 'r.txt'), wide)
      git(dir, 'add', '-A')
      git(dir, 'commit', '-m', 'the base the branch starts from')
      git(dir, 'checkout', '-b', 'feat')

      writeFileSync(join(dir, 'added.txt'), 'brand new\n')
      git(dir, 'add', 'added.txt')
      writeFileSync(join(dir, 'm.txt'), wide + 'one more\n')
      git(dir, 'rm', '-q', 'd.txt')
      git(dir, 'mv', 'r.txt', 'moved.txt')
      writeFileSync(join(dir, 'moved.txt'), wide + 'and an edit\n')

      const span = await readBranchSpan(dir)
      assert.equal(span?.readable, true)
      assert.deepEqual(span?.stat.counts, { added: 1, updated: 2, removed: 1 })
      const counts = span!.stat.counts!
      assert.equal(
        counts.added + counts.updated + counts.removed,
        span!.stat.changedFiles,
        'the breakdown must sum to the file count the row draws beside it',
      )
    })

    await run('a rename stays ONE updated file even with diff.renames off', async () => {
      const dir = repo()
      const wide = Array.from({ length: 12 }, (_, index) => `l${index}`).join('\n') + '\n'
      writeFileSync(join(dir, 'r.txt'), wide)
      git(dir, 'add', '-A')
      git(dir, 'commit', '-m', 'a file worth moving')
      // The user config that would otherwise split one moved file into two.
      git(dir, 'config', 'diff.renames', 'false')
      git(dir, 'checkout', '-b', 'feat')
      git(dir, 'mv', 'r.txt', 'moved.txt')
      writeFileSync(join(dir, 'moved.txt'), wide + 'and an edit\n')

      const span = await readBranchSpan(dir)
      assert.deepEqual(span?.stat.counts, { added: 0, updated: 1, removed: 0 })
      assert.equal(span?.stat.changedFiles, 1)
    })

    // `diff.renames = copies` makes git pair a new file with the one it was copied
    // from and report `C`. Asking for `--find-renames` explicitly normalises that
    // away — both halves say `A` — and either answer folds to `added`, which is
    // what a file that was not there before is.
    await run('a copied file is an added one, whatever diff.renames says', async () => {
      const dir = repo()
      const wide = Array.from({ length: 20 }, (_, index) => `l${index}`).join('\n') + '\n'
      writeFileSync(join(dir, 'source.txt'), wide)
      git(dir, 'add', '-A')
      git(dir, 'commit', '-m', 'a file worth copying')
      git(dir, 'config', 'diff.renames', 'copies')
      git(dir, 'checkout', '-b', 'feat')
      writeFileSync(join(dir, 'copy.txt'), wide)
      git(dir, 'add', 'copy.txt')

      const span = await readBranchSpan(dir)
      assert.deepEqual(span?.stat.counts, { added: 1, updated: 0, removed: 0 })
      assert.equal(span?.stat.changedFiles, 1, 'the source it was copied from did not change')
    })

    await run('a file that became a symlink is one updated file', async () => {
      const dir = repo()
      writeFileSync(join(dir, 't.txt'), 'plain\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-m', 'a plain file')
      git(dir, 'checkout', '-b', 'feat')
      rmSync(join(dir, 't.txt'))
      symlinkSync('a.txt', join(dir, 't.txt'))

      const span = await readBranchSpan(dir)
      assert.deepEqual(span?.stat.counts, { added: 0, updated: 1, removed: 0 })
    })

    // The span is `git diff`, and `diff` cannot see a file git has never tracked.
    // The SUMMARY adds those files back as `added` (workspace-change-summary);
    // this reading stays the tracked diff it is.
    await run('untracked work is outside the span’s own diff and its counts', async () => {
      const dir = repo()
      git(dir, 'checkout', '-b', 'feat')
      writeFileSync(join(dir, 'untracked.txt'), 'nothing git has seen\n')
      const span = await readBranchSpan(dir)
      assert.deepEqual(span?.stat.counts, { added: 0, updated: 0, removed: 0 })
      assert.equal(span?.stat.changedFiles, 0, 'the span never counted untracked files')
    })

    await run('a span that could not be read has NO counts, not zeros', async () => {
      const dir = repo()
      const bare = mkdtempSync(join(tmpdir(), 'sprintengine-branch-span-bare-'))
      created.push(bare)
      execFileSync('git', ['clone', '--quiet', '--bare', dir, join(bare, '.bare')])
      // Reached through a `.git` file, as a bare repository's container is:
      // one git is only allowed to find, not named, is no repository at all.
      writeFileSync(join(bare, '.git'), 'gitdir: ./.bare\n')
      const span = await readBranchSpan(bare)
      assert.equal(span?.readable, false)
      assert.equal(span?.stat.counts, null, 'a breakdown we could not take is absent')
    })

    for (const dir of created) rmSync(dir, { recursive: true, force: true })

    if (failures > 0) {
      console.error(`git-branch-span.test.ts: ${failures} failing`)
      process.exit(1)
    }
    console.log('git-branch-span.test.ts: ok')
  })()

  await suiteRun
})
