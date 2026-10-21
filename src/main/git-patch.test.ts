import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGitPatch, gitPatchArgs } from './git-patch'
import { bareFileName } from './ipc/git-ipc'
import { test } from 'vitest'

test('git-patch', async () => {
  // A path is a PATHSPEC to git, and a file really named `src/[id].tsx` is a
  // character class that also matches `src/i.tsx`. These assert the whole file's
  // behaviour rather than only the argv: the patch a person copies must be the
  // patch of the file they selected and of nothing that merely matched it.

  const suiteRun = main()

  async function main(): Promise<void> {
    await assertLiteralPathspecInArgv()
    await assertGlobbyNameCopiesOnlyItself()
    assertSaveNameIsABareName()
    console.log('git-patch.test.ts: ok')
  }

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  }

  /** A repo holding `src/[id].tsx` beside `src/i.tsx`, both changed. */
  function makeRepo(): { root: string; repo: string } {
    const root = mkdtempSync(join(tmpdir(), 'sprintengine-git-patch-'))
    const repo = join(root, 'repo')
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo], { encoding: 'utf8' })
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'Test'])
    git(repo, ['config', 'commit.gpgsign', 'false'])
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'src', '[id].tsx'), 'bracketed original\n')
    writeFileSync(join(repo, 'src', 'i.tsx'), 'decoy original\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '--quiet', '-m', 'base'])
    writeFileSync(join(repo, 'src', '[id].tsx'), 'bracketed changed\n')
    writeFileSync(join(repo, 'src', 'i.tsx'), 'decoy changed\n')
    return { root, repo }
  }

  async function assertLiteralPathspecInArgv(): Promise<void> {
    assert.deepEqual(gitPatchArgs(['src/[id].tsx'], false), [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--binary',
      '--',
      ':(literal)src/[id].tsx',
    ])
  }

  async function assertGlobbyNameCopiesOnlyItself(): Promise<void> {
    const { root, repo } = makeRepo()
    try {
      const patch = await createGitPatch(repo, [join(repo, 'src', '[id].tsx')])
      assert.equal(patch.ok, true, patch.message ?? '')
      assert.match(patch.patch, /\+bracketed changed/, 'the selected file is in the patch')
      assert.ok(!patch.patch.includes('decoy'), 'and the file the glob would have matched is not')
      assert.ok(!patch.patch.includes('src/i.tsx'), 'not even by name')

      // The decoy on its own still works — `:(literal)` narrows, it does not break.
      const decoy = await createGitPatch(repo, [join(repo, 'src', 'i.tsx')])
      assert.equal(decoy.ok, true, decoy.message ?? '')
      assert.match(decoy.patch, /\+decoy changed/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  /**
   * The save dialog's default path is `join(repoRoot, suggestion)`, and the
   * suggestion arrives over IPC. A name with a directory in it aims that dialog
   * somewhere the person did not choose — and the default path is what a hurried
   * Enter accepts.
   */
  function assertSaveNameIsABareName(): void {
    assert.equal(bareFileName('changes.patch'), 'changes.patch')
    assert.equal(bareFileName('  changes.patch  '), 'changes.patch', 'trimmed')
    assert.equal(bareFileName('.hidden.patch'), '.hidden.patch', 'a dotfile is a name')
    assert.equal(bareFileName('../../.zshrc'), null)
    assert.equal(bareFileName('/etc/hosts'), null)
    assert.equal(bareFileName('sub\\dir.patch'), null, 'a Windows separator counts too')
    assert.equal(bareFileName('..'), null)
    assert.equal(bareFileName('.'), null)
    assert.equal(bareFileName(''), null)
    assert.equal(bareFileName('   '), null)
    assert.equal(bareFileName(undefined), null)
    assert.equal(bareFileName(42), null)
  }

  await suiteRun
})

test('a patch keeps its a/ b/ prefixes and git’s own rendering whatever the repo is set to', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sprintengine-git-patch-pins-'))
  const repo = join(root, 'repo')
  const git = (args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  try {
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo], { encoding: 'utf8' })
    git(['config', 'user.email', 'dev@example.com'])
    git(['config', 'user.name', 'Dev'])
    git(['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git(['add', '-A'])
    git(['commit', '--quiet', '-m', 'base'])
    // Settings a person may well have: prefix-free diffs, and a diff tool.
    git(['config', 'diff.noprefix', 'true'])
    git(['config', 'diff.external', 'echo external-tool-output'])
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(repo, 'new.txt'), 'fresh\n')

    const patch = await createGitPatch(repo, [join(repo, 'a.txt'), join(repo, 'new.txt')])
    assert.equal(patch.ok, true, patch.message ?? '')
    assert.ok(!patch.patch.includes('external-tool-output'), 'git wrote the patch, not the diff tool')
    assert.match(patch.patch, /^--- a\/a\.txt$/m)
    assert.match(patch.patch, /^\+\+\+ b\/a\.txt$/m)
    assert.match(patch.patch, /^\+\+\+ b\/new\.txt$/m)

    // And it applies: put the tree back, then replay the patch on it.
    git(['checkout', '--', 'a.txt'])
    rmSync(join(repo, 'new.txt'))
    execFileSync('git', ['-C', repo, 'apply', '-'], { input: patch.patch })
    assert.equal(git(['diff', '--no-ext-diff', '--stat']).includes('a.txt'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
