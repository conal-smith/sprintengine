import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { projectlessChatFolderName, projectlessChatsRootIn } from '../shared/projectless-chats'
import { randomId } from '../shared/random-id'

// The folders chats started without a project run in
// (shared/projectless-chats.ts says why each has one). Made here, in main,
// because the renderer has no disk: the root when New chat is pointed at
// "No project", and a fresh folder in it for each chat that starts there.

export type ProjectlessChatFolderDeps = {
  home?: () => string
  makeDir?: (path: string, options?: { recursive?: boolean }) => Promise<unknown>
  now?: () => Date
  newId?: () => string
}

/** `~/.sprintengine/chats`, made if it is not there yet. */
export async function ensureProjectlessChatsRoot(deps: ProjectlessChatFolderDeps = {}): Promise<string> {
  const root = projectlessChatsRootIn((deps.home ?? homedir)())
  await (deps.makeDir ?? mkdir)(root, { recursive: true })
  return root
}

const NAME_ATTEMPTS = 4

/**
 * A new folder for one chat, named after the words it starts with. The name
 * is claimed with a plain `mkdir`, which fails on a folder already there, so
 * two chats started alike in the same second never share one: a taken name
 * tries again with a fresh id.
 */
export async function createProjectlessChatFolder(
  prompt: string | null | undefined,
  deps: ProjectlessChatFolderDeps = {},
): Promise<string> {
  const root = await ensureProjectlessChatsRoot(deps)
  const makeDir = deps.makeDir ?? mkdir
  const now = (deps.now ?? (() => new Date()))()
  const newId = deps.newId ?? (() => randomId(6))
  let lastError: unknown = null
  for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt += 1) {
    const folder = join(root, projectlessChatFolderName({ prompt, now, id: newId() }))
    try {
      await makeDir(folder)
      return folder
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw error
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not make a folder for the chat.')
}
