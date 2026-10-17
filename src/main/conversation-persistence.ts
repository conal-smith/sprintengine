import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  openConfinedExistingFile,
  readBoundedConversationFile,
  resolveConversationPath,
} from './conversation-file-access'
import { conversationConfinementRoot } from './workspace-store'

export const MAX_CONVERSATION_TRANSCRIPT_BYTES = 64 * 1024 * 1024
export const MAX_CONVERSATION_METADATA_BYTES = 8 * 1024 * 1024
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const identity = (info: { dev: number; ino: number }) => `${info.dev}:${info.ino}`

/** Validate each parent, rather than treating the storage folder as trusted.
 * Post-open checks detect replacement during open. Like the existing-file
 * helper, this is defense in depth, not a native openat/renameat sandbox against
 * an adversary repeatedly restoring/replacing the same directory inode.
 */
async function storagePath(rootPath: string, requested: string, createParents = false) {
  const { root, target: path } = await resolveConversationPath(
    await conversationConfinementRoot(rootPath, requested),
    requested,
  )
  const inspect = async (create: boolean) => {
    let current = root
    const rootInfo = await lstat(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Conversation storage root changed.')
    const identities = [identity(rootInfo)]
    for (const part of relative(root, dirname(path)).split(sep).filter(Boolean)) {
      current = resolve(current, part)
      if (create)
        await mkdir(current).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        })
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('Conversation storage parent is not a real directory.')
      identities.push(identity(info))
    }
    return identities.join('/')
  }
  const before = await inspect(createParents)
  return {
    root,
    path,
    verify: async () => {
      if ((await inspect(false)) !== before) throw new Error('Conversation storage changed during access.')
    },
  }
}

export async function readConversationStorage(root: string, path: string, limit: number): Promise<Buffer> {
  const file = await openConfinedExistingFile(await conversationConfinementRoot(root, path), path)
  try {
    return await readBoundedConversationFile(file, limit)
  } finally {
    await file.close()
  }
}

async function removeOwnedFile(guard: Awaited<ReturnType<typeof storagePath>>, path: string, inode: string) {
  await guard.verify()
  const info = await lstat(path).catch((error) => {
    if (missing(error)) return null
    throw error
  })
  if (info?.isFile() && !info.isSymbolicLink() && identity(info) === inode) await unlink(path)
}

/** No bytes are written until the new descriptor and all parents are verified. */
export async function openConversationAppendFile(
  rootPath: string,
  path: string,
  exclusive = false,
): Promise<FileHandle> {
  const guard = await storagePath(rootPath, path, true)
  if (!exclusive) {
    try {
      return await openConfinedExistingFile(guard.root, guard.path, 'append')
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
  const file = await open(
    guard.path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  )
  const inode = identity(await file.stat())
  try {
    await guard.verify()
    const checked = await openConfinedExistingFile(guard.root, guard.path, 'append')
    try {
      if (identity(await checked.stat()) !== inode)
        throw new Error('Conversation storage file changed during creation.')
    } finally {
      await checked.close()
    }
    return file
  } catch (error) {
    await file.close()
    await removeOwnedFile(guard, guard.path, inode).catch(() => undefined)
    throw error
  }
}

export async function writeConversationStorage(rootPath: string, path: string, content: string): Promise<void> {
  if (Buffer.byteLength(content) > MAX_CONVERSATION_METADATA_BYTES)
    throw new Error('Conversation metadata exceeds the storage limit.')
  const guard = await storagePath(rootPath, path, true)
  const previous = await lstat(guard.path).catch((error) => {
    if (missing(error)) return null
    throw error
  })
  if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1))
    throw new Error('Conversation storage target is not a private regular file.')
  const temp = `${guard.path}.${randomUUID()}.tmp`
  const file = await openConversationAppendFile(guard.root, temp, true)
  const inode = identity(await file.stat())
  try {
    await guard.verify()
    await file.writeFile(content, 'utf8')
    await file.close()
    await guard.verify()
    const current = await lstat(guard.path).catch((error) => {
      if (missing(error)) return null
      throw error
    })
    if ((current ? identity(current) : null) !== (previous ? identity(previous) : null) || current?.isSymbolicLink())
      throw new Error('Conversation storage target changed during write.')
    const temporary = await lstat(temp)
    if (!temporary.isFile() || temporary.isSymbolicLink() || temporary.nlink !== 1 || identity(temporary) !== inode)
      throw new Error('Conversation temporary file changed during write.')
    await rename(temp, guard.path)
  } finally {
    await file.close().catch(() => undefined)
    await removeOwnedFile(guard, temp, inode).catch(() => undefined)
  }
}

/** Caller supplies one exact conversation-owned file/directory, never a root. */
export async function removeConversationStorage(rootPath: string, path: string): Promise<void> {
  let guard: Awaited<ReturnType<typeof storagePath>>
  try {
    guard = await storagePath(rootPath, path)
  } catch (error) {
    if (missing(error)) return
    throw error
  }
  const info = await lstat(guard.path).catch((error) => {
    if (missing(error)) return null
    throw error
  })
  if (!info) return
  if (info.isSymbolicLink()) throw new Error('Conversation storage cannot be a symbolic link.')
  await guard.verify()
  if (info.isDirectory()) await rm(guard.path, { recursive: true })
  else if (info.isFile()) await unlink(guard.path)
  else throw new Error('Conversation storage is not a regular file or directory.')
}
