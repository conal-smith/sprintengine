import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, test } from 'vitest'

import { comparablePath } from '../shared/host-paths'
import type { GitCommandResult } from './git'
import { runGitCommand } from './git-run'
import { refusedForSubmodules } from './worktree-submodule-removal'
import { removeLinkedWorktree, removeTreeWithoutFollowingLinks, type TreeFs } from './worktree-removal'

/**
 * Removing a worktree whose `node_modules` links point outside it. On a real
 * repository, with the platform given as Windows, symlinks stand in for NTFS
 * junctions (Node reports both as links); the last test makes real junctions
 * on Windows itself.
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

const linkType = process.platform === 'win32' ? 'junction' : 'dir'

let scratch = ''
let repo = ''
let outside = ''
let worktree = ''

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-worktree-removal-')))
  repo = join(scratch, 'repo')
  await mkdir(repo)
  await git(repo, 'init', '-q', '-b', 'main')
  await writeFile(join(repo, 'tracked.txt'), 'tracked\n')
  await writeFile(join(repo, '.gitignore'), 'node_modules\nshared\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'init')
  // What a linked dependency points at: a folder outside the worktree, such
  // as the main checkout's own `node_modules`.
  outside = join(scratch, 'outside')
  await mkdir(join(outside, 'pkg'), { recursive: true })
  await writeFile(join(outside, 'keep.txt'), 'keep\n')
  await writeFile(join(outside, 'pkg', 'index.js'), 'module.exports = 1\n')
  worktree = join(scratch, 'worktrees', 'linked')
  await git(repo, 'worktree', 'add', '-q', '-b', 'feature/linked', worktree)
  await mkdir(join(worktree, 'node_modules'))
  await symlink(outside, join(worktree, 'node_modules', 'dep'), linkType)
  await symlink(outside, join(worktree, 'shared'), linkType)
})

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

async function outsideIntact(): Promise<void> {
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep\n')
  assert.equal(await readFile(join(outside, 'pkg', 'index.js'), 'utf8'), 'module.exports = 1\n')
}

async function registered(): Promise<boolean> {
  return (await git(repo, 'worktree', 'list', '--porcelain'))
    .split('\n')
    .some(
      (line) =>
        line.startsWith('worktree ') && comparablePath(line.slice('worktree '.length)) === comparablePath(worktree),
    )
}

test('on Windows, a forced removal deletes the worktree and its links, and what they point at survives', async () => {
  await writeFile(join(worktree, 'notes.txt'), 'draft\n')

  const result = await removeLinkedWorktree(repo, worktree, runGitCommand, { force: true, platform: 'win32' })

  assert.equal(result.ok, true, result.message ?? '')
  assert.equal(await exists(worktree), false)
  assert.equal(await registered(), false)
  await outsideIntact()
})

test('on Windows, a clean worktree is removed without force', async () => {
  const result = await removeLinkedWorktree(repo, worktree, runGitCommand, { platform: 'win32' })

  assert.equal(result.ok, true, result.message ?? '')
  assert.equal(await exists(worktree), false)
  assert.equal(await registered(), false)
  await outsideIntact()
})

test('on Windows, a worktree with an untracked file is refused as git refuses it, links and all', async () => {
  await writeFile(join(worktree, 'notes.txt'), 'draft\n')

  const result = await removeLinkedWorktree(repo, worktree, runGitCommand, { platform: 'win32' })

  assert.equal(result.ok, false)
  assert.equal(result.message, `fatal: '${worktree}' contains modified or untracked files, use --force to delete it`)
  assert.ok((await lstat(join(worktree, 'node_modules', 'dep'))).isSymbolicLink())
  assert.equal(await readFile(join(worktree, 'notes.txt'), 'utf8'), 'draft\n')
  assert.equal(await registered(), true)
})

test('on Windows, an untracked file is refused even where git is told to hide untracked files', async () => {
  await git(worktree, 'config', 'status.showUntrackedFiles', 'no')
  await writeFile(join(worktree, 'scratch.txt'), 'untracked\n')

  const result = await removeLinkedWorktree(repo, worktree, runGitCommand, { platform: 'win32' })

  assert.equal(result.ok, false)
  assert.equal(await readFile(join(worktree, 'scratch.txt'), 'utf8'), 'untracked\n')
})

test('on Windows, a locked worktree is refused even when forced', async () => {
  await git(repo, 'worktree', 'lock', '--reason', 'in use', worktree)

  const result = await removeLinkedWorktree(repo, worktree, runGitCommand, { force: true, platform: 'win32' })

  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /cannot remove a locked working tree, lock reason: in use/)
  assert.ok((await lstat(join(worktree, 'shared'))).isSymbolicLink())
  assert.equal(await registered(), true)
})

test('on Windows, stored submodules are refused with the message the submodule removal looks for', async () => {
  const adminDir = await git(worktree, 'rev-parse', '--absolute-git-dir')
  await mkdir(join(adminDir, 'modules'))

  const result = await removeLinkedWorktree(repo, worktree, runGitCommand, { platform: 'win32' })

  assert.equal(refusedForSubmodules(result), true)
  assert.equal(await exists(join(worktree, 'tracked.txt')), true)
})

test('on Windows, a worktree of another repository is not removed from this one', async () => {
  const other = join(scratch, 'other')
  await mkdir(other)
  await git(other, 'init', '-q', '-b', 'main')
  await git(other, 'commit', '-q', '--allow-empty', '-m', 'init')

  const result = await removeLinkedWorktree(other, worktree, runGitCommand, { force: true, platform: 'win32' })

  assert.equal(result.ok, false)
  assert.equal(result.message, `fatal: '${worktree}' is not a working tree`)
  assert.equal(await exists(join(worktree, 'tracked.txt')), true)
})

test('on Windows, a delete stopped partway puts `.git` back so a retry can finish it', async () => {
  const gitFile = await readFile(join(worktree, '.git'), 'utf8')
  const failing: TreeFs = {
    lstat: (path) => lstat(path),
    readdir: (path) => readdir(path, { withFileTypes: true }),
    unlink: (path) => unlink(path),
    rmdir: (path) => rmdir(path),
    // As a file held open stops the delete after `.git` has gone.
    rm: async (path) => {
      await unlink(join(path, '.git'))
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    },
  }

  const failed = await removeLinkedWorktree(repo, worktree, runGitCommand, {
    force: true,
    platform: 'win32',
    fs: failing,
  })

  assert.equal(failed.ok, false)
  assert.match(failed.message ?? '', /failed to delete .*EBUSY/)
  assert.equal(await readFile(join(worktree, '.git'), 'utf8'), gitFile)
  await outsideIntact()
  const retried = await removeLinkedWorktree(repo, worktree, runGitCommand, { force: true, platform: 'win32' })
  assert.equal(retried.ok, true, retried.message ?? '')
  assert.equal(await exists(worktree), false)
})

test('elsewhere, git removes the worktree itself, with the same arguments as before', async () => {
  const calls: string[][] = []
  const recording = async (cwd: string, args: string[]): Promise<GitCommandResult> => {
    calls.push([cwd, ...args])
    return { ok: true, stdout: '', stderr: '', message: null }
  }

  await removeLinkedWorktree(repo, worktree, recording, { platform: 'darwin' })
  await removeLinkedWorktree(repo, worktree, recording, { force: true, platform: 'linux' })

  assert.deepEqual(calls, [
    [repo, 'worktree', 'remove', worktree],
    [repo, 'worktree', 'remove', '--force', worktree],
  ])
})

test('the delete unlinks every link without listing it, then removes the rest', async () => {
  // A tree as Windows reports one: a junction listed as a link, and one
  // listed as a folder that `lstat` shows to be a link.
  const kind = (link: boolean, dir: boolean) => ({ isSymbolicLink: () => link, isDirectory: () => dir })
  const tree: Record<string, Array<{ name: string; link: boolean; dir: boolean }>> = {
    '/wt': [
      { name: '.git', link: false, dir: false },
      { name: 'node_modules', link: false, dir: true },
      { name: 'shared', link: false, dir: true },
    ],
    '/wt/node_modules': [
      { name: 'dep', link: true, dir: false },
      { name: 'local', link: false, dir: true },
    ],
    '/wt/node_modules/local': [{ name: 'index.js', link: false, dir: false }],
  }
  const links = new Set(['/wt/node_modules/dep', '/wt/shared'])
  const calls: string[] = []
  const fake: TreeFs = {
    lstat: async (path) => kind(links.has(path), !links.has(path)),
    readdir: async (path) => {
      calls.push(`readdir ${path}`)
      if (links.has(path)) throw new Error(`listed the link ${path}`)
      return (tree[path] ?? []).map((entry) => ({ name: entry.name, ...kind(entry.link, entry.dir) }))
    },
    unlink: async (path) => {
      calls.push(`unlink ${path}`)
      // A directory link `unlink` will not take falls back to `rmdir`.
      if (path === '/wt/shared') throw new Error('EPERM')
    },
    rmdir: async (path) => {
      calls.push(`rmdir ${path}`)
    },
    rm: async (path) => {
      calls.push(`rm ${path}`)
    },
  }

  await removeTreeWithoutFollowingLinks('/wt', fake)

  assert.deepEqual(calls, [
    'readdir /wt',
    'unlink /wt/shared',
    'rmdir /wt/shared',
    'readdir /wt/node_modules',
    'unlink /wt/node_modules/dep',
    'readdir /wt/node_modules/local',
    'rm /wt',
  ])
})

test.skipIf(process.platform !== 'win32')(
  'on Windows itself, real junctions are unlinked and their targets survive',
  async () => {
    assert.ok((await lstat(join(worktree, 'shared'))).isSymbolicLink())

    const result = await removeLinkedWorktree(repo, worktree, runGitCommand, { force: true })

    assert.equal(result.ok, true, result.message ?? '')
    assert.equal(await exists(worktree), false)
    assert.equal(await registered(), false)
    await outsideIntact()
  },
)
