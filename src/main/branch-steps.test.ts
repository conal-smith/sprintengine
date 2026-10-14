import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { diffBranchSelection, listBranchSteps, parseNameStatusZ, readFileAtRev } from './branch-steps'
import { getWorkspaceChangeSummary } from './workspace-change-summary'
import { test } from 'vitest'

test('branch-steps', async () => {
  // A step is a COMMIT (the-diff-an-agent-made / changed-files-and-commit-steps).
  // This suite is the item's acceptance, run against real repos.

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
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'sprintengine-steps-'))
    created.push(dir)
    git(dir, 'init', '-b', 'main')
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-m', 'seed')
    return dir
  }

  function commit(dir: string, message: string): void {
    git(dir, 'add', '-A')
    git(dir, 'commit', '-m', message)
  }

  function paths(files: Array<{ path: string }>): string[] {
    return files.map((file) => file.path).sort()
  }

  const suiteRun = (async () => {
    // ---- the name-status framing -------------------------------------------

    await run('parseNameStatusZ reads a rename as THREE fields', () => {
      const parsed = parseNameStatusZ('R100\0old.ts\0new.ts\0M\0after.ts\0')
      assert.deepEqual(parsed, [
        { path: 'new.ts', status: 'renamed', oldPath: 'old.ts' },
        { path: 'after.ts', status: 'modified' },
      ])
    })

    await run('parseNameStatusZ maps A/D/M and survives junk', () => {
      assert.deepEqual(parseNameStatusZ('A\0new.ts\0'), [{ path: 'new.ts', status: 'new' }])
      assert.deepEqual(parseNameStatusZ('D\0gone.ts\0'), [{ path: 'gone.ts', status: 'deleted' }])
      assert.deepEqual(parseNameStatusZ(''), [])
      assert.deepEqual(parseNameStatusZ('M\0'), [], 'a code with no path is dropped, not guessed')
    })

    // ---- the strip ----------------------------------------------------------

    await run('a branch lists its commits oldest first', async () => {
      const dir = repo()
      git(dir, 'checkout', '-b', 'feat')
      writeFileSync(join(dir, 'b.txt'), 'b\n')
      commit(dir, 'first step')
      writeFileSync(join(dir, 'c.txt'), 'c\n')
      commit(dir, 'second step')

      const snapshot = await listBranchSteps(dir)
      assert.equal(snapshot.branch, 'feat')
      assert.equal(snapshot.scope, 'branch')
      assert.deepEqual(
        snapshot.steps.map((step) => step.subject),
        ['first step', 'second step'],
        'oldest first — the order the work happened in',
      )
      assert.ok(snapshot.steps[0].shortHash.length > 0)
      assert.ok(snapshot.steps[0].authoredAt > 0)
      assert.equal(snapshot.steps[0].isMerge, false)
      assert.equal(snapshot.hasUncommitted, false)
    })

    await run('a branch level with the default branch has only the uncommitted step', async () => {
      const dir = repo()
      writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
      const snapshot = await listBranchSteps(dir)
      assert.deepEqual(snapshot.steps, [])
      assert.equal(snapshot.scope, 'folder')
      assert.equal(snapshot.hasUncommitted, true)
    })

    await run('an untracked file alone still opens the uncommitted step', async () => {
      const dir = repo()
      writeFileSync(join(dir, 'brand-new.txt'), 'x\n')
      const snapshot = await listBranchSteps(dir)
      assert.equal(snapshot.hasUncommitted, true, 'diff is blind to this; status is not')
    })

    await run('a subject containing a newline survives the record framing', async () => {
      const dir = repo()
      git(dir, 'checkout', '-b', 'feat')
      writeFileSync(join(dir, 'b.txt'), 'b\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-m', 'subject line', '-m', 'body paragraph')
      const snapshot = await listBranchSteps(dir)
      assert.equal(snapshot.steps.length, 1)
      assert.equal(snapshot.steps[0].subject, 'subject line', 'the body is not part of the subject')
    })

    await run('a non-repo and a missing folder report an empty strip, never a throw', async () => {
      const plain = mkdtempSync(join(tmpdir(), 'sprintengine-steps-plain-'))
      created.push(plain)
      const snapshot = await listBranchSteps(plain)
      assert.deepEqual(snapshot, {
        branch: null,
        baseOid: null,
        scope: 'folder',
        steps: [],
        hasUncommitted: false,
      })
      assert.equal((await listBranchSteps(join(plain, 'gone'))).steps.length, 0)
    })

    // ---- the diffs ----------------------------------------------------------

    await run('a step shows only that commit’s changes', async () => {
      const dir = repo()
      git(dir, 'checkout', '-b', 'feat')
      writeFileSync(join(dir, 'b.txt'), 'b\n')
      commit(dir, 'adds b')
      writeFileSync(join(dir, 'c.txt'), 'c\n')
      commit(dir, 'adds c')

      const snapshot = await listBranchSteps(dir)
      const first = await diffBranchSelection(dir, { kind: 'commit', hash: snapshot.steps[0].hash })
      assert.deepEqual(paths(first.files), ['b.txt'])
      assert.equal(first.files[0].status, 'new')
      assert.equal(first.additions, 1)
    })

    await run('the span is the union, counted once', async () => {
      const dir = repo()
      git(dir, 'checkout', '-b', 'feat')
      writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
      commit(dir, 'touch a')
      writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n')
      commit(dir, 'touch a again')

      const span = await diffBranchSelection(dir, { kind: 'span' })
      assert.deepEqual(paths(span.files), ['a.txt'], 'one entry, not one per commit')
      assert.equal(span.additions, 2)
    })

    // The item's sharpest case: a file that came and went inside the branch.
    await run('a file created then deleted is in each step and NOT in the span', async () => {
      const dir = repo()
      git(dir, 'checkout', '-b', 'feat')
      writeFileSync(join(dir, 'temp.txt'), 'scratch\n')
      commit(dir, 'adds temp')
      unlinkSync(join(dir, 'temp.txt'))
      commit(dir, 'removes temp')

      const snapshot = await listBranchSteps(dir)
      const added = await diffBranchSelection(dir, { kind: 'commit', hash: snapshot.steps[0].hash })
      const removed = await diffBranchSelection(dir, { kind: 'commit', hash: snapshot.steps[1].hash })
      const span = await diffBranchSelection(dir, { kind: 'span' })

      assert.deepEqual(paths(added.files), ['temp.txt'])
      assert.equal(added.files[0].status, 'new')
      assert.deepEqual(paths(removed.files), ['temp.txt'])
      assert.equal(removed.files[0].status, 'deleted')
      assert.deepEqual(paths(span.files), [], 'the branch produced nothing that survived')
    })

    // The seam with the sidebar row: both claim to show "the span", so they have
    // to agree file-for-file. The row reads `git diff`, which cannot see untracked
    // content, so the span does not add it either — it belongs to the step that
    // says "uncommitted", one chip to the left.
    await run('the SPAN excludes untracked files, so it agrees with the row', async () => {
      const dir = repo()
      git(dir, 'checkout', '-b', 'feat')
      writeFileSync(join(dir, 'b.txt'), 'b\n')
      commit(dir, 'committed work')
      writeFileSync(join(dir, 'brand-new.txt'), 'x\ny\n')

      const span = await diffBranchSelection(dir, { kind: 'span' })
      assert.deepEqual(paths(span.files), ['b.txt'], 'the new file is not the span’s to report')

      const tail = await diffBranchSelection(dir, { kind: 'uncommitted' })
      assert.ok(
        paths(tail.files).includes('brand-new.txt'),
        'but it is reachable — the uncommitted step is where it lives',
      )
    })

    await run('the uncommitted step is HEAD → working tree, untracked included', async () => {
      const dir = repo()
      writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
      writeFileSync(join(dir, 'fresh.txt'), 'p\nq\n')
      const diff = await diffBranchSelection(dir, { kind: 'uncommitted' })
      assert.deepEqual(paths(diff.files), ['a.txt', 'fresh.txt'])
      const fresh = diff.files.find((file) => file.path === 'fresh.txt')
      assert.equal(fresh?.status, 'new')
      assert.equal(fresh?.additions, 2, 'an untracked file’s lines are counted, not left at zero')
    })

    await run('an ignored file is not mistaken for untracked work', async () => {
      const dir = repo()
      writeFileSync(join(dir, '.gitignore'), 'secret.txt\n')
      commit(dir, 'ignore')
      writeFileSync(join(dir, 'secret.txt'), 'nope\n')
      const diff = await diffBranchSelection(dir, { kind: 'uncommitted' })
      assert.deepEqual(paths(diff.files), [], 'exclude-standard is doing its job')
    })

    await run('a binary untracked file is listed with no line count', async () => {
      const dir = repo()
      writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3]))
      const diff = await diffBranchSelection(dir, { kind: 'uncommitted' })
      const blob = diff.files.find((file) => file.path === 'blob.bin')
      assert.equal(blob?.status, 'new')
      assert.equal(blob?.additions, 0)
    })

    await run('a rename inside a commit reports its new path and where it came from', async () => {
      const dir = repo()
      git(dir, 'checkout', '-b', 'feat')
      git(dir, 'mv', 'a.txt', 'renamed.txt')
      commit(dir, 'rename')
      const snapshot = await listBranchSteps(dir)
      const step = await diffBranchSelection(dir, { kind: 'commit', hash: snapshot.steps[0].hash })
      const entry = step.files.find((file) => file.path === 'renamed.txt')
      assert.equal(entry?.status, 'renamed')
      assert.equal(entry?.oldPath, 'a.txt')
    })

    await run('a ROOT commit reports its whole tree rather than failing', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sprintengine-steps-root-'))
      created.push(dir)
      git(dir, 'init', '-b', 'main')
      writeFileSync(join(dir, 'first.txt'), 'x\n')
      commit(dir, 'root commit')
      const head = git(dir, 'rev-parse', 'HEAD').trim()
      const diff = await diffBranchSelection(dir, { kind: 'commit', hash: head })
      assert.deepEqual(paths(diff.files), ['first.txt'], 'no parent to diff against, still readable')
    })

    await run('a merge step shows what it brought IN, and is flagged as a merge', async () => {
      const dir = repo()
      git(dir, 'checkout', '-b', 'feat')
      writeFileSync(join(dir, 'b.txt'), 'b\n')
      commit(dir, 'feature work')
      git(dir, 'checkout', 'main')
      writeFileSync(join(dir, 'c.txt'), 'c\n')
      commit(dir, 'main work')
      git(dir, 'checkout', 'feat')
      git(dir, 'merge', '--no-ff', '--no-edit', 'main')
      const head = git(dir, 'rev-parse', 'HEAD').trim()
      const diff = await diffBranchSelection(dir, { kind: 'commit', hash: head })
      // git's first-parent reading. Asserted rather than assumed: the comment
      // here first claimed a merge reports nothing, and this proved otherwise.
      assert.deepEqual(paths(diff.files), ['c.txt'], 'what the merge brought into the branch')
      const snapshot = await listBranchSteps(dir)
      const merge = snapshot.steps.find((step) => step.hash === head)
      assert.equal(merge?.isMerge, true, 'the strip can label it')
      assert.equal(
        snapshot.steps.filter((step) => !step.isMerge).length,
        1,
        'the branch’s own work is still one ordinary step',
      )
    })

    await run('a bad hash yields an empty diff rather than an error', async () => {
      const dir = repo()
      const diff = await diffBranchSelection(dir, { kind: 'commit', hash: 'deadbeefdeadbeef' })
      assert.deepEqual(diff.files, [])
      assert.equal(diff.additions, 0)
    })

    await run('a rebase mid-session re-reads cleanly under new hashes', async () => {
      const dir = repo()
      git(dir, 'checkout', '-b', 'feat')
      writeFileSync(join(dir, 'b.txt'), 'b\n')
      commit(dir, 'feature work')
      const before = await listBranchSteps(dir)

      git(dir, 'checkout', 'main')
      writeFileSync(join(dir, 'c.txt'), 'c\n')
      commit(dir, 'main moved')
      git(dir, 'checkout', 'feat')
      git(dir, 'rebase', 'main')

      const after = await listBranchSteps(dir)
      assert.equal(after.steps.length, 1)
      assert.equal(after.steps[0].subject, 'feature work')
      assert.notEqual(after.steps[0].hash, before.steps[0].hash, 'the commit was re-identified')
      const diff = await diffBranchSelection(dir, { kind: 'commit', hash: after.steps[0].hash })
      assert.deepEqual(paths(diff.files), ['b.txt'])
    })

    // ---- the second review's findings ---------------------------------------

    // A hash reaches argv where git also looks for options, and `git show` accepts
    // `--output=<file>`. A review confirmed this writing a file from main.
    await run('an option-shaped hash never reaches git', async () => {
      const dir = repo()
      const target = join(tmpdir(), `sprintengine-steps-pwned-${process.pid}.txt`)
      const diff = await diffBranchSelection(dir, { kind: 'commit', hash: `--output=${target}` })
      assert.deepEqual(diff.files, [], 'refused, not run')
      assert.equal(existsSync(target), false, 'and nothing was written')
      // Ordinary refs that are not hashes are refused too — only a hash is a hash.
      assert.deepEqual((await diffBranchSelection(dir, { kind: 'commit', hash: 'HEAD' })).files, [])
    })

    await run('readFileAtRev refuses an option-shaped rev or path, and escapes nothing', async () => {
      const dir = repo()
      const target = join(tmpdir(), `sprintengine-steps-pwned2-${process.pid}.txt`)
      assert.deepEqual(await readFileAtRev(dir, `--output=${target}`, 'a.txt'), { kind: 'absent' })
      assert.equal(existsSync(target), false)
      assert.deepEqual(await readFileAtRev(dir, 'HEAD', '--output=x'), { kind: 'absent' })
      // Out of the repo entirely.
      assert.deepEqual(await readFileAtRev(dir, 'HEAD', '../../../etc/hosts'), { kind: 'absent' })
    })

    // `--name-status` on a merge is a COMBINED diff and reports nothing, so every
    // file the merge brought in fell through to combine()'s leftover branch and was
    // labelled "Modified" — an added file shown as modified, a deleted one too.
    await run('a merge step reports the right STATUS for each file, not just the path', async () => {
      const dir = repo()
      git(dir, 'checkout', '-b', 'feat')
      writeFileSync(join(dir, 'b.txt'), 'b\n')
      commit(dir, 'feature work')
      git(dir, 'checkout', 'main')
      unlinkSync(join(dir, 'a.txt'))
      writeFileSync(join(dir, 'c.txt'), 'c\n')
      commit(dir, 'main adds c and deletes a')
      git(dir, 'checkout', 'feat')
      git(dir, 'merge', '--no-ff', '--no-edit', 'main')

      const head = git(dir, 'rev-parse', 'HEAD').trim()
      const diff = await diffBranchSelection(dir, { kind: 'commit', hash: head })
      const byPath = new Map(diff.files.map((file) => [file.path, file.status]))
      assert.equal(byPath.get('c.txt'), 'new', 'an added file is not "modified"')
      assert.equal(byPath.get('a.txt'), 'deleted', 'nor is a deleted one')
    })

    // The row diffs an unborn HEAD against the empty tree; the pane ran
    // `git diff HEAD`, which fails there, so the row said +2 and the pane nothing.
    await run('an unborn HEAD shows its staged work, matching the row', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sprintengine-steps-unborn-'))
      created.push(dir)
      git(dir, 'init', '-b', 'main')
      writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
      git(dir, 'add', '-A')

      const row = await getWorkspaceChangeSummary({ checkoutPath: dir })
      const span = await diffBranchSelection(dir, { kind: 'span' })
      const tail = await diffBranchSelection(dir, { kind: 'uncommitted' })
      assert.equal(row.additions, 2)
      assert.equal(span.additions, 2, 'the pane agrees with the row')
      assert.equal(tail.additions, 2, 'and so does the uncommitted step')
    })

    await run('a file too large to send is reported as such, not as an empty side', async () => {
      const dir = repo()
      const big = 'x\n'.repeat(3_000_000)
      writeFileSync(join(dir, 'big.txt'), big)
      commit(dir, 'a large file')
      const result = await readFileAtRev(dir, 'HEAD', 'big.txt')
      assert.equal(result.kind, 'too-large', 'an empty side would read as "newly added"')
    })

    // ---- the seam with the sidebar row --------------------------------------

    // The row and this panel are two renderings of ONE reading. If they ever
    // disagree, one of them is lying to the person looking at both.
    await run('the span’s totals equal the row’s ±N for the same checkout', async () => {
      const dir = repo()
      git(dir, 'checkout', '-b', 'feat')
      writeFileSync(join(dir, 'b.txt'), 'x\ny\n')
      commit(dir, 'committed')
      writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
      writeFileSync(join(dir, 'untracked.txt'), 'ignored by both\n')

      const span = await diffBranchSelection(dir, { kind: 'span' })
      const row = await getWorkspaceChangeSummary({ checkoutPath: dir })
      assert.equal(span.additions, row.additions, 'additions agree')
      assert.equal(span.deletions, row.deletions, 'deletions agree')
      // The ONE known difference (files-not-lines, 2026-09-09): the row counts
      // files, and a file the agent created is "1 file added" to the person
      // reading it, so the row's count includes the untracked file the pane's
      // span still leaves out. The line totals above stay git's tracked diff on
      // both. Stated here as an exact equation rather than glossed, so the day
      // the pane lists untracked files too this line is the one that fails.
      assert.equal(
        span.files.length + 1,
        row.changedFiles,
        'the row counts the untracked file as added; the pane does not yet',
      )
      // b.txt is new against the merge base, untracked.txt is new on disk, a.txt existed at the base.
      assert.deepEqual(row.files, { added: 2, updated: 1, removed: 0 }, 'b.txt and untracked.txt are the added ones')
    })

    await run('the strip’s scope agrees with the row’s scope', async () => {
      const dir = repo()
      git(dir, 'checkout', '-b', 'feat')
      writeFileSync(join(dir, 'b.txt'), 'x\n')
      commit(dir, 'work')
      const snapshot = await listBranchSteps(dir)
      const row = await getWorkspaceChangeSummary({ checkoutPath: dir })
      assert.equal(snapshot.scope, row.scope, 'one rule, two surfaces')
    })

    await run('and they agree when the checkout cannot be read at all', async () => {
      const source = repo()
      const bare = mkdtempSync(join(tmpdir(), 'sprintengine-steps-bare-'))
      created.push(bare)
      execFileSync('git', ['clone', '--quiet', '--bare', source, bare])
      // No working tree: the row clamps to `folder`, so the strip must too, or the
      // panel would claim exactness over a list it could not build.
      const snapshot = await listBranchSteps(bare)
      const row = await getWorkspaceChangeSummary({ checkoutPath: bare })
      assert.equal(row.scope, 'folder')
      assert.equal(snapshot.scope, 'folder', 'neither surface claims what it cannot read')
    })

    // ---- the diff sides -----------------------------------------------------

    await run('readFileAtRev returns content, and `absent` for a file not there', async () => {
      const dir = repo()
      assert.deepEqual(await readFileAtRev(dir, 'HEAD', 'a.txt'), {
        kind: 'content',
        content: 'one\ntwo\nthree\n',
      })
      // `absent` rather than an error: it is the correct original side for an
      // addition and modified side for a deletion, and the pane renders it empty.
      assert.deepEqual(await readFileAtRev(dir, 'HEAD', 'never-existed.txt'), { kind: 'absent' })
      assert.deepEqual(await readFileAtRev(dir, 'nonsense-rev', 'a.txt'), { kind: 'absent' })
    })

    for (const dir of created) rmSync(dir, { recursive: true, force: true })

    if (failures > 0) {
      console.error(`branch-steps.test.ts: ${failures} failing`)
      process.exit(1)
    }
    console.log('branch-steps.test.ts: ok')
  })()

  await suiteRun
})

// A file moved with a plain rename, not `git mv`, leaves git a deleted tracked
// path and an untracked new one. The uncommitted reading pairs them through a
// copy of the index, never the person's own.

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'dev',
      GIT_AUTHOR_EMAIL: 'dev@example.com',
      GIT_COMMITTER_NAME: 'dev',
      GIT_COMMITTER_EMAIL: 'dev@example.com',
    },
  })
}

function movedRepo(): { dir: string; index: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sprintengine-steps-moved-'))
  gitIn(dir, 'init', '-b', 'main')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const one = 1\nexport const two = 2\nexport const three = 3\n')
  writeFileSync(join(dir, 'README.md'), 'acme\n')
  gitIn(dir, 'add', '.')
  gitIn(dir, 'commit', '-m', 'seed')
  renameSync(join(dir, 'src', 'a.ts'), join(dir, 'src', 'b.ts'))
  writeFileSync(join(dir, 'src', 'c.ts'), 'export const fresh = true\n')
  return { dir, index: join(dir, '.git', 'index') }
}

test('a file moved without git mv is one rename, and the real index is never written', async () => {
  const { dir, index } = movedRepo()
  try {
    const before = { bytes: readFileSync(index), mtimeMs: statSync(index).mtimeMs }
    const diff = await diffBranchSelection(dir, { kind: 'uncommitted' })
    assert.deepEqual(diff.files, [
      { path: 'src/b.ts', status: 'renamed', oldPath: 'src/a.ts', additions: 0, deletions: 0 },
      { path: 'src/c.ts', status: 'new', additions: 1, deletions: 0 },
    ])
    assert.deepEqual(readFileSync(index), before.bytes)
    assert.equal(statSync(index).mtimeMs, before.mtimeMs)
    assert.match(gitIn(dir, 'status', '--porcelain'), /^ D src\/a\.ts\n\?\? src\/b\.ts\n\?\? src\/c\.ts\n$/)

    // From a subdirectory the paths are still the repo's.
    const fromSrc = await diffBranchSelection(join(dir, 'src'), { kind: 'uncommitted' })
    assert.deepEqual(
      fromSrc.files.map((file) => [file.status, file.path]),
      [
        ['renamed', 'src/b.ts'],
        ['new', 'src/c.ts'],
      ],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('past the cap of untracked files a move reads as before: a deletion and a new file', async () => {
  const { dir } = movedRepo()
  try {
    mkdirSync(join(dir, 'out'))
    for (let file = 0; file < 300; file++) writeFileSync(join(dir, 'out', `${file}.txt`), `${file}\n`)
    const diff = await diffBranchSelection(dir, { kind: 'uncommitted' })
    const moved = diff.files.filter((file) => file.path.startsWith('src/'))
    assert.deepEqual(
      moved.map((file) => [file.status, file.path]),
      [
        ['deleted', 'src/a.ts'],
        ['new', 'src/b.ts'],
        ['new', 'src/c.ts'],
      ],
    )
    assert.equal(diff.files.length, 303)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
