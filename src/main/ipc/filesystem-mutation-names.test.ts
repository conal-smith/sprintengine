import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { registerFilesystemMutationIpc } from './filesystem-mutation-ipc'

type Handler = (_event: unknown, ...args: unknown[]) => Promise<unknown>

function register(): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  const ipcMain = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }
  registerFilesystemMutationIpc(ipcMain as unknown as Parameters<typeof registerFilesystemMutationIpc>[0], {
    getUniqueCopyPath: async () => '',
    pathExists: async (path) =>
      stat(path).then(
        () => true,
        () => false,
      ),
    trashItem: async () => {},
  })
  return handlers
}

describe('new files and folders are named, never placed by path', () => {
  let root: string
  let parent: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sprintengine-fs-names-'))
    parent = join(root, 'project')
    await register().get('fs:ensure-dir')!(null, root, 'project')
  })
  afterEach(async () => {
    await rm(root, { force: true, recursive: true })
  })

  for (const channel of ['fs:create-file', 'fs:create-dir', 'fs:ensure-dir']) {
    test(`${channel} refuses a name that leaves its folder`, async () => {
      const handler = register().get(channel)!
      for (const name of ['../escape', '..', '.', 'a/b', 'a\\b', '', 'trailing.']) {
        await expect(handler(null, parent, name)).rejects.toThrow()
      }
      expect(await readdir(root)).toEqual(['project'])
      expect(await readdir(parent)).toEqual([])
    })

    test(`${channel} still makes an ordinary name`, async () => {
      const made = (await register().get(channel)!(null, parent, 'notes.md')) as string
      expect(made).toBe(join(parent, 'notes.md'))
      await expect(stat(made)).resolves.toBeTruthy()
    })
  }
})
