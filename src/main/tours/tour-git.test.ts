import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, test } from 'vitest'

import { resolveTourSteps } from '../../shared/tours/tour-anchor'
import { listTourFiles, parseNameStatus, readTourFile, resolveCommit, resolveHead, resolveRepoRoot } from './tour-git'

// What a tour reads from a real repository: the changed files (tracked,
// untracked, renamed, deleted and binary), each file's two sides and its
// `-U0` hunks — and a committed range, read at its SHAs.

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sprintengine-tour-git-')))
const repo = join(root, 'repo')
afterAll(() => rmSync(root, { recursive: true, force: true }))

function git(args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
}

execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo])
git(['config', 'user.email', 'dev@example.com'])
git(['config', 'user.name', 'Dev'])
git(['config', 'commit.gpgsign', 'false'])
writeFileSync(join(repo, 'retry.ts'), 'export function retry() {\n  return 1\n}\n')
writeFileSync(join(repo, 'legacy.ts'), 'export const legacy = 1\n')
writeFileSync(
  join(repo, 'names.ts'),
  "export const NAME = 'jobs'\nexport const OTHER = 'x'\nexport const THIRD = 'y'\n",
)
writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 3]))
git(['add', '-A'])
git(['commit', '--quiet', '-m', 'first'])
const firstSha = git(['rev-parse', 'HEAD']).trim()

writeFileSync(join(repo, 'retry.ts'), 'export function retry() {\n  return 2\n}\n')
git(['commit', '--quiet', '-am', 'second'])
const secondSha = git(['rev-parse', 'HEAD']).trim()

// The working tree: a modified file, a staged rename with an edit, a deletion,
// an untracked file and a changed binary.
writeFileSync(join(repo, 'retry.ts'), '// header\nexport function retry() {\n  return 3\n}\n')
git(['mv', 'names.ts', 'queue-names.ts'])
writeFileSync(
  join(repo, 'queue-names.ts'),
  "export const NAME = 'queue'\nexport const OTHER = 'x'\nexport const THIRD = 'y'\n",
)
unlinkSync(join(repo, 'legacy.ts'))
writeFileSync(join(repo, 'fresh.ts'), 'export const fresh = true\n')
writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 9, 9, 9]))

test('parseNameStatus reads renames, copies, additions and deletions', () => {
  assert.deepEqual(parseNameStatus('M\0a.ts\0R087\0old.ts\0new.ts\0A\0b.ts\0D\0c.ts\0'), [
    { path: 'a.ts', status: 'modified' },
    { path: 'new.ts', oldPath: 'old.ts', status: 'renamed' },
    { path: 'b.ts', status: 'new' },
    { path: 'c.ts', status: 'deleted' },
  ])
})

test('revisions resolve to SHAs, and an option-shaped revision is refused', async () => {
  assert.equal(await resolveRepoRoot(repo), repo)
  assert.equal(await resolveHead(repo), secondSha)
  assert.equal(await resolveCommit(repo, 'main~1'), firstSha)
  assert.equal(await resolveCommit(repo, '--output=/tmp/x'), null)
  assert.equal(await resolveCommit(repo, 'no-such-branch'), null)
})

test('the working tree lists every kind of change, untracked files included', async () => {
  const listed = await listTourFiles(repo, { base: secondSha, head: 'worktree' })
  assert.equal(listed.ok, true)
  if (!listed.ok) return
  const byPath = new Map(listed.files.map((file) => [file.path, file]))
  assert.equal(byPath.get('retry.ts')?.status, 'modified')
  assert.equal(byPath.get('legacy.ts')?.status, 'deleted')
  assert.deepEqual(byPath.get('queue-names.ts'), { path: 'queue-names.ts', oldPath: 'names.ts', status: 'renamed' })
  assert.equal(byPath.get('fresh.ts')?.status, 'new')
  assert.equal(byPath.get('logo.bin')?.status, 'modified')
})

test('each file is read with both sides and its hunks, and a tour resolves against them', async () => {
  const revisions = { base: secondSha, head: 'worktree' as const }
  const listed = await listTourFiles(repo, revisions)
  assert.ok(listed.ok)
  if (!listed.ok) return
  const files = await Promise.all(listed.files.map((file) => readTourFile(repo, revisions, file)))
  const byPath = new Map(files.map((file) => [file.path, file]))

  const retry = byPath.get('retry.ts')!
  assert.equal(retry.hunks.length, 2, 'the added header and the changed return')
  const renamed = byPath.get('queue-names.ts')!
  assert.equal(renamed.oldText?.startsWith("export const NAME = 'jobs'"), true, 'the old side is read at the old path')
  assert.equal(renamed.hunks.length, 1)
  const deleted = byPath.get('legacy.ts')!
  assert.equal(deleted.newText, null)
  assert.equal(deleted.oldText, 'export const legacy = 1\n')
  const fresh = byPath.get('fresh.ts')!
  assert.deepEqual(fresh.hunks[0], {
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: 1,
    lines: ['+export const fresh = true'],
  })
  assert.equal(byPath.get('logo.bin')!.unreadable, 'binary')

  const resolved = resolveTourSteps(
    [
      { id: 'ret', title: 'Return', body: 'b', path: 'retry.ts', side: 'new', match: 'return 3' },
      { id: 'was', title: 'Was', body: 'b', path: 'retry.ts', side: 'old', hunk: 2 },
      { id: 'gone', title: 'Gone', body: 'b', path: 'legacy.ts', side: 'old', hunk: 1 },
      { id: 'moved', title: 'Moved', body: 'b', path: 'queue-names.ts', oldPath: 'names.ts', side: 'new', hunk: 1 },
      { id: 'fresh', title: 'Fresh', body: 'b', path: 'fresh.ts', side: 'new', hunk: 1 },
      { id: 'logo', title: 'Logo', body: 'b', path: 'logo.bin', side: 'new', fileOnly: true },
    ],
    files,
  )
  assert.equal(resolved.ok, true, resolved.ok ? '' : resolved.errors.join('\n'))
  if (!resolved.ok) return
  assert.deepEqual(
    resolved.steps.map((step) => [step.id, step.anchor.startLine]),
    [
      ['ret', 3],
      ['was', 2],
      ['gone', 1],
      ['moved', 1],
      ['fresh', 1],
      ['logo', null],
    ],
  )
})

test('a committed range is read at its two SHAs, whatever the working tree says', async () => {
  const revisions = { base: firstSha, head: secondSha }
  const listed = await listTourFiles(repo, revisions)
  assert.ok(listed.ok)
  if (!listed.ok) return
  assert.deepEqual(listed.files, [{ path: 'retry.ts', status: 'modified' }])
  const file = await readTourFile(repo, revisions, listed.files[0])
  assert.equal(file.newText, 'export function retry() {\n  return 2\n}\n')
  assert.equal(file.hunks.length, 1)
})

test("a repository's own textconv program is never run to read a tour's diff", async (context) => {
  if (process.platform === 'win32') {
    context.skip('the planted program is a shell script')
    return
  }
  const planted = join(root, 'textconv-repo')
  const marker = join(root, 'textconv-ran')
  const program = join(root, 'textconv.sh')
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\ncat "$1"\n`)
  chmodSync(program, 0o755)
  const run = (args: string[]) => execFileSync('git', ['-C', planted, ...args], { encoding: 'utf8' })
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', planted])
  run(['config', 'user.email', 'dev@example.com'])
  run(['config', 'user.name', 'Dev'])
  run(['config', 'commit.gpgsign', 'false'])
  run(['config', 'diff.planted.textconv', program])
  writeFileSync(join(planted, '.gitattributes'), '*.txt diff=planted\n')
  writeFileSync(join(planted, 'notes.txt'), 'one\n')
  run(['add', '-A'])
  run(['commit', '--quiet', '-m', 'first'])
  const base = run(['rev-parse', 'HEAD']).trim()
  writeFileSync(join(planted, 'notes.txt'), 'two\n')

  const revisions = { base, head: 'worktree' as const }
  const listed = await listTourFiles(planted, revisions)
  assert.ok(listed.ok)
  if (!listed.ok) return
  const file = await readTourFile(planted, revisions, listed.files[0])
  assert.equal(file.hunks.length, 1)
  assert.equal(existsSync(marker), false, 'the planted program never ran')
})
