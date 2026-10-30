import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

import { legacyUploadOwnerDir, safeUploadName, uploadOwnerDir } from '../../../server/web/web-uploads'
import { uploadStillSent } from '../../upload-references'

// Files a paired device sends with a chat's message (`upload?kind=file`,
// `conversation-message-files`). A picture is read into the turn and its
// staged copy removed; a file is not. The agent is told where the file is
// and reads it by path, during that turn or any later one, so the file is
// kept where Studio keeps its own state, never in the project's folder:
// `<data dir>/tailnet-uploads/<device>/<upload>/<name>`, as a browser's
// dropped file is kept under `web-uploads` (web-uploads.ts).
//
// Each upload has a folder of its own, so two files of one name never meet,
// and the name is the file's own made safe, so the agent and the chat's card
// read a name the person recognises. A file never sent goes with its upload
// reference (an hour); one that was sent is kept a week, and past that for as
// long as a chat it was sent in is kept (upload-references.ts), then removed
// when the next one is placed. A device's folder goes when the device is
// removed.
//
// A file a held message carries (`conversation-queued-attachments`) waits
// with the message for its chat's turn to end, which may be longer than a
// week when the chat refused it and it waits on the person: its upload's
// folder is marked held (`holdTailnetUpload`) and pruning passes it by. Once
// the message has gone the mark comes off (`releaseTailnetUpload`): sent, the
// file is the message's and is kept a week from then, as one sent at once is;
// deleted, it goes with its folder.

export const MAX_TAILNET_FILE_BYTES = 25 * 1024 * 1024
const KEEP_MS = 7 * 24 * 60 * 60 * 1000
export const TAILNET_UPLOADS_DIRNAME = 'tailnet-uploads'
/** In an upload's folder while a held message carries its file. */
const HELD_MARK = '.held'

export type TailnetFilePlace = {
  /** Where the bytes go: a new folder's only file. */
  path: string
  /** The file's name as it was made safe. */
  name: string
  /** Remove the upload's folder, the file with it. */
  remove(): void
}

export type TailnetFileUploads = {
  /** A new place for one file from a device, its folder made and empty. */
  place(deviceId: string, name: string): TailnetFilePlace
  /** Remove everything a device sent, as the device is removed. */
  forgetDevice(deviceId: string): void
}

export function createTailnetFileUploads(options: { root: string; now?: () => number }): TailnetFileUploads {
  const now = options.now ?? Date.now

  function prune(): void {
    let devices: string[]
    try {
      devices = readdirSync(options.root)
    } catch {
      return
    }
    for (const device of devices) {
      const dir = join(options.root, device)
      let uploads: string[]
      try {
        uploads = readdirSync(dir)
      } catch {
        continue
      }
      for (const upload of uploads) {
        try {
          if (existsSync(join(dir, upload, HELD_MARK))) continue
          if (now() - statSync(join(dir, upload)).mtimeMs <= KEEP_MS) continue
          // A chat it was sent in may read it again, in any later turn.
          if (uploadStillSent(join(dir, upload))) continue
          rmSync(join(dir, upload), { recursive: true, force: true })
        } catch {
          // Gone already, or not ours to read.
        }
      }
    }
  }

  return {
    place(deviceId, name) {
      prune()
      const dir = join(
        options.root,
        uploadOwnerDir(deviceId),
        `${new Date(now()).toISOString().slice(0, 10)}-${randomBytes(6).toString('hex')}`,
      )
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const safe = safeUploadName(name)
      return {
        path: join(dir, safe),
        name: safe,
        remove: () => rmSync(dir, { recursive: true, force: true }),
      }
    },
    forgetDevice(deviceId) {
      rmSync(join(options.root, uploadOwnerDir(deviceId)), { recursive: true, force: true })
      rmSync(join(options.root, legacyUploadOwnerDir(deviceId, 'device')), { recursive: true, force: true })
    },
  }
}

/**
 * The folder of the upload `path` names under `root`, when it is one: a
 * device's folder, then the upload's own, then its file. Null for any other
 * path, which is never touched.
 */
function uploadFolderOf(root: string, path: string): string | null {
  const inside = relative(root, path)
  if (!inside || isAbsolute(inside)) return null
  const parts = inside.split(sep)
  if (parts.length !== 3 || parts.some((part) => !part || part === '..' || part === '.')) return null
  return join(root, parts[0]!, parts[1]!)
}

/** Keep the upload at `path` through pruning while a held message carries it. False for a path that is no upload. */
export function holdTailnetUpload(root: string, path: string): boolean {
  const folder = uploadFolderOf(root, path)
  if (!folder || !existsSync(path)) return false
  writeFileSync(join(folder, HELD_MARK), '')
  return true
}

/**
 * A held message carrying the upload at `path` has gone. `sent`, the file is
 * the message's: the mark comes off and it is kept a week from now. Not sent,
 * it goes with its folder.
 */
export function releaseTailnetUpload(root: string, path: string, sent: boolean): void {
  const folder = uploadFolderOf(root, path)
  if (!folder) return
  if (!sent) {
    rmSync(folder, { recursive: true, force: true })
    return
  }
  rmSync(join(folder, HELD_MARK), { force: true })
  const at = new Date()
  utimesSync(folder, at, at)
}
