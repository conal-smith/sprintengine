import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { legacyUploadOwnerDir, safeUploadName, uploadOwnerDir } from '../../../server/web/web-uploads'

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
// reference (an hour); one that was sent is kept a week, then removed when
// the next one is placed. A device's folder goes when the device is removed.

export const MAX_TAILNET_FILE_BYTES = 25 * 1024 * 1024
const KEEP_MS = 7 * 24 * 60 * 60 * 1000
export const TAILNET_UPLOADS_DIRNAME = 'tailnet-uploads'

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
          if (now() - statSync(join(dir, upload)).mtimeMs > KEEP_MS)
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
