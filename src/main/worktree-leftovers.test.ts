import assert from 'node:assert/strict'
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import { removeWorktreeLeftovers } from './worktree-leftovers'

/**
 * What Git for Windows leaves after a successful `worktree remove`: junctions
 * and the folders above them. Symlinks stand in for junctions here, which Node
 * reports the same way, with the platform given as Windows.
 */

let scratch = ''
let outside = ''
let leftover = ''

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-worktree-leftovers-')))
  outside = join(scratch, 'outside')
  await mkdir(join(outside, 'pkg'), { recursive: true })
  await writeFile(join(outside, 'keep.txt'), 'external target\n')
  await writeFile(join(outside, 'pkg', 'index.js'), 'module.exports = 1\n')
  // The stub of a removed worktree: linked dependencies under folders git left.
  leftover = join(scratch, 'app-01')
  await mkdir(join(leftover, 'node_modules', '.pnpm'), { recursive: true })
  await mkdir(join(leftover, 'packages', 'web', 'node_modules'), { recursive: true })
  await mkdir(join(leftover, 'empty'))
  await symlink(join(outside, 'pkg'), join(leftover, 'node_modules', 'pkg'), 'dir')
  await symlink(outside, join(leftover, 'packages', 'web', 'node_modules', 'shared'), 'dir')
  await symlink(join(outside, 'keep.txt'), join(leftover, 'linked.txt'), 'file')
})

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

async function targetsIntact(): Promise<void> {
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'external target\n')
  assert.equal(await readFile(join(outside, 'pkg', 'index.js'), 'utf8'), 'module.exports = 1\n')
}

test('on Windows, links and the folders they leave empty are removed, and what they point at survives', async () => {
  assert.equal(await removeWorktreeLeftovers(leftover, 'win32'), true)
  assert.equal(await exists(leftover), false)
  await targetsIntact()
})

test('on Windows, a file written there since keeps it and every folder above it', async () => {
  await mkdir(join(leftover, 'packages', 'web', 'notes'))
  await writeFile(join(leftover, 'packages', 'web', 'notes', 'draft.txt'), 'new work\n')

  assert.equal(await removeWorktreeLeftovers(leftover, 'win32'), false)
  assert.deepEqual(await readdir(leftover), ['packages'])
  assert.deepEqual(await readdir(join(leftover, 'packages', 'web')), ['notes'])
  assert.equal(await readFile(join(leftover, 'packages', 'web', 'notes', 'draft.txt'), 'utf8'), 'new work\n')
  await targetsIntact()
})

test('on Windows, a path that is already gone is left alone', async () => {
  await rm(leftover, { recursive: true, force: true })
  assert.equal(await removeWorktreeLeftovers(leftover, 'win32'), true)
  await targetsIntact()
})

test('on every other platform nothing is touched', async () => {
  assert.equal(await removeWorktreeLeftovers(leftover, 'darwin'), true)
  assert.equal(await removeWorktreeLeftovers(leftover, 'linux'), true)
  assert.ok((await lstat(join(leftover, 'node_modules', 'pkg'))).isSymbolicLink())
  assert.ok(await exists(join(leftover, 'empty')))
})
