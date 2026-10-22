import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { registerFilesystemMutationIpc } from './ipc/filesystem-mutation-ipc'

type Handler = (_event: unknown, ...args: unknown[]) => Promise<unknown>

function writefileHandler(): Handler {
  const handlers = new Map<string, Handler>()
  const ipcMain = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }
  registerFilesystemMutationIpc(ipcMain as unknown as Parameters<typeof registerFilesystemMutationIpc>[0], {
    getUniqueCopyPath: async () => '',
    pathExists: async () => false,
    trashItem: async () => {},
  })
  return handlers.get('fs:writefile')!
}

describe.skipIf(process.platform === 'win32')('an editor save stays in the project', () => {
  let base: string
  let project: string
  let outside: string
  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-save-target-')))
    project = join(base, 'project')
    outside = join(base, 'outside')
    await mkdir(join(project, 'src'), { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'original')
  })
  afterEach(async () => {
    await rm(base, { force: true, recursive: true })
  })

  test('a file in the project is saved', async () => {
    const file = join(project, 'src', 'a.ts')
    await writeFile(file, 'old')
    await writefileHandler()(null, file, 'new', { roots: [project] })
    expect(await readFile(file, 'utf8')).toBe('new')
  })

  test('a link in the project pointing outside it is not written through', async () => {
    const link = join(project, 'notes.txt')
    await symlink(join(outside, 'secret.txt'), link)
    await expect(writefileHandler()(null, link, 'changed', { roots: [project] })).rejects.toThrow(
      /outside this project/,
    )
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('original')
  })

  test('a file under a linked folder that leads outside the project is not written', async () => {
    await symlink(outside, join(project, 'linked'))
    await expect(
      writefileHandler()(null, join(project, 'linked', 'secret.txt'), 'changed', { roots: [project] }),
    ).rejects.toThrow(/outside this project/)
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('original')
  })

  test('a link to another file inside the project saves that file and stays a link', async () => {
    const real = join(project, 'src', 'real.ts')
    await writeFile(real, 'old')
    const link = join(project, 'alias.ts')
    await symlink(real, link)
    await writefileHandler()(null, link, 'new', { roots: [project] })
    expect(await readFile(real, 'utf8')).toBe('new')
    expect(await realpath(link)).toBe(real)
  })

  test('a file the person opened from outside the project is saved', async () => {
    const file = join(outside, 'secret.txt')
    await writefileHandler()(null, file, 'edited', { roots: [project] })
    expect(await readFile(file, 'utf8')).toBe('edited')
    await writefileHandler()(null, file, 'again')
    expect(await readFile(file, 'utf8')).toBe('again')
  })

  test('a link opened from outside the project is not written through', async () => {
    const link = join(outside, 'link.txt')
    await symlink(join(outside, 'secret.txt'), link)
    await expect(writefileHandler()(null, link, 'changed', { roots: [project] })).rejects.toThrow(/a link/)
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('original')
  })
})
