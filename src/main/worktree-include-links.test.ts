import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { cloneTree } from './clone-tree'
import { seedWorktreeIncludedFiles } from './git'

describe.skipIf(process.platform === 'win32')('.worktreeinclude copies stay inside both trees', () => {
  let base: string
  let repo: string
  let worktree: string
  let outside: string
  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-include-links-')))
    repo = join(base, 'repo')
    worktree = join(base, 'worktree')
    outside = join(base, 'outside')
    await mkdir(repo, { recursive: true })
    await mkdir(worktree, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'private.txt'), 'outside\n')
  })
  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  test('an entry under a linked folder in the repository is not read', async () => {
    await symlink(outside, join(repo, 'linked'))
    await writeFile(join(repo, '.worktreeinclude'), 'linked/private.txt\n')
    const seeded = await seedWorktreeIncludedFiles(repo, worktree)
    expect(seeded.ok && seeded.data.copied).toEqual([])
    expect(await readdir(worktree)).toEqual([])
  })

  test('an entry under a linked folder in the worktree is not written', async () => {
    await mkdir(join(repo, 'hooks'), { recursive: true })
    await writeFile(join(repo, 'hooks', 'post-checkout'), 'new\n')
    await writeFile(join(repo, '.worktreeinclude'), 'hooks/post-checkout\n')
    await symlink(outside, join(worktree, 'hooks'))
    const seeded = await seedWorktreeIncludedFiles(repo, worktree)
    expect(seeded.ok && seeded.data.copied).toEqual([])
    expect(await readdir(outside)).toEqual(['private.txt'])
  })

  test('a link standing where the copy goes is not written through', async () => {
    await writeFile(join(repo, '.env'), 'SECRET=1\n')
    await writeFile(join(repo, '.worktreeinclude'), '.env\n')
    await symlink(join(outside, 'private.txt'), join(worktree, '.env'))
    await seedWorktreeIncludedFiles(repo, worktree)
    expect(await readFile(join(outside, 'private.txt'), 'utf8')).toBe('outside\n')
  })

  test('a folder copy does not descend through a link already in the destination', async () => {
    await mkdir(join(repo, 'config', 'nested'), { recursive: true })
    await writeFile(join(repo, 'config', 'nested', 'private.txt'), 'replaced\n')
    await mkdir(join(worktree, 'config'), { recursive: true })
    await symlink(outside, join(worktree, 'config', 'nested'))
    await cloneTree(join(repo, 'config'), join(worktree, 'config'))
    expect(await readFile(join(outside, 'private.txt'), 'utf8')).toBe('outside\n')
  })

  test('ordinary entries are still copied', async () => {
    await writeFile(join(repo, '.env'), 'A=1\n')
    await mkdir(join(repo, 'deps', 'pkg'), { recursive: true })
    await writeFile(join(repo, 'deps', 'pkg', 'index.js'), 'x\n')
    await writeFile(join(repo, '.worktreeinclude'), '.env\ndeps\n')
    const seeded = await seedWorktreeIncludedFiles(repo, worktree)
    expect(seeded.ok && seeded.data.copied).toEqual(['.env', 'deps'])
    expect(await readFile(join(worktree, 'deps', 'pkg', 'index.js'), 'utf8')).toBe('x\n')
  })
})
