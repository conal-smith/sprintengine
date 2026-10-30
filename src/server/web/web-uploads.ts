import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'

import { uploadStillSent } from '../../main/upload-references'

// Files a browser drops into a message (phase 9 spec, 4.1 #10; 14.14). A
// browser has no path for a dropped file, and the agent reads files by path
// on the server's machine, so the tab sends the bytes and the server answers
// where it put them: `<data dir>/web-uploads/<session>/<upload>/<name>`. That
// path is what goes into the message, as a dropped file's path does on the
// desktop.
//
// Owner sessions only, one file per request, 50 MB at most. Each upload has a
// directory of its own, so two files of one name never meet, and the name is
// the file's own made safe, so the agent reads a name the person recognises.
// Uploads are kept a week, and past that for as long as a chat one was sent in
// is kept (upload-references.ts), then removed when the next one is saved.

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const KEEP_MS = 7 * 24 * 60 * 60 * 1000
export const WEB_UPLOADS_DIRNAME = 'web-uploads'
const UPLOADS_DIRNAME = WEB_UPLOADS_DIRNAME

export type WebUploadAnswer =
  { ok: true; path: string; bytes: number } | { ok: false; status: 400 | 413 | 500; message: string }

export type WebUploads = {
  /** Save one request's body under a session's uploads. */
  save(input: { sessionId: string; name: string | null; request: IncomingMessage }): Promise<WebUploadAnswer>
  /** Remove a session's uploads, as its browser is removed. */
  forgetSession(sessionId: string): void
}

/** The longest a saved upload's name is, in UTF-8 bytes; file systems allow 255. */
const MAX_UPLOAD_NAME_BYTES = 200
const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])\s*(?:\..*)?$/iu

/** `text` cut to at most `max` UTF-8 bytes, never inside a character. */
function cutToBytes(text: string, max: number): string {
  let out = ''
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char)
    if (used + size > max) break
    out += char
    used += size
  }
  return out
}

/**
 * A dropped file's name, as a single path segment that is safe on every OS:
 * no separators, control or invisible formatting characters (which can make a
 * name read backwards), leading dots, trailing dots or spaces, or a name
 * Windows keeps for a device. Long names are cut to 200 bytes, keeping their
 * extension.
 */
export function safeUploadName(name: string | null): string {
  const base = (name ?? '').split(/[\\/]/u).pop() ?? ''
  const tidy = (text: string) =>
    text
      .trim()
      .replace(/^[.\s]+/u, '')
      .replace(/[.\s]+$/u, '')
  let cleaned = tidy(
    base
      .replace(/[\u0000-\u001f\u007f]/gu, '')
      .replace(/\p{Cf}/gu, '')
      .replace(/[<>:"|?*]/gu, '_'),
  )
  if (WINDOWS_RESERVED_NAME.test(cleaned)) cleaned = `_${cleaned}`
  if (Buffer.byteLength(cleaned) > MAX_UPLOAD_NAME_BYTES) {
    const dot = cleaned.lastIndexOf('.')
    const extension = dot > 0 && Buffer.byteLength(cleaned.slice(dot)) <= 16 ? cleaned.slice(dot) : ''
    const stem = extension ? cleaned.slice(0, dot) : cleaned
    cleaned = tidy(cutToBytes(stem, MAX_UPLOAD_NAME_BYTES - Buffer.byteLength(extension))) + extension
  }
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'upload'
}

/**
 * The folder one session's, or one device's, uploads go in. A hash of its id,
 * so two ids that differ only in characters a folder name cannot hold never
 * share one.
 */
export function uploadOwnerDir(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 32)
}

/** The folder an earlier build named for an id, still removed with the id's uploads. */
export function legacyUploadOwnerDir(id: string, fallback: string): string {
  return id.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 64) || fallback
}

export function createWebUploads(options: { dataDir: string; now?: () => number }): WebUploads {
  const root = join(options.dataDir, UPLOADS_DIRNAME)
  const now = options.now ?? Date.now

  function prune(): void {
    let sessions: string[]
    try {
      sessions = readdirSync(root)
    } catch {
      return
    }
    for (const session of sessions) {
      const dir = join(root, session)
      let uploads: string[]
      try {
        uploads = readdirSync(dir)
      } catch {
        continue
      }
      for (const upload of uploads) {
        try {
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
    async save({ sessionId, name, request }) {
      const declared = Number(request.headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES)
        return { ok: false, status: 413, message: 'That file is over 50 MB, too large to upload.' }
      prune()
      const dir = join(
        root,
        uploadOwnerDir(sessionId),
        `${new Date(now()).toISOString().slice(0, 10)}-${randomBytes(6).toString('hex')}`,
      )
      const path = join(dir, safeUploadName(name))
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
      } catch {
        return { ok: false, status: 500, message: 'Studio could not make a place for the upload.' }
      }
      return new Promise<WebUploadAnswer>((resolve) => {
        let bytes = 0
        let settled = false
        const out = createWriteStream(path, { mode: 0o600, flags: 'wx' })
        const fail = (answer: Extract<WebUploadAnswer, { ok: false }>) => {
          if (settled) return
          settled = true
          request.unpipe(out)
          // Removed once the file is closed, then answered: Windows refuses to
          // remove a file still open, and a throw here would be in a stream's
          // listener, uncaught.
          const removed = () =>
            void rm(dir, { recursive: true, force: true })
              .catch(() => undefined)
              .then(() => resolve(answer))
          if (out.closed) removed()
          else out.once('close', removed)
          out.destroy()
          // Read the rest so the answer can be sent on a socket still in order.
          request.resume()
        }
        request.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > MAX_UPLOAD_BYTES)
            fail({ ok: false, status: 413, message: 'That file is over 50 MB, too large to upload.' })
        })
        request.on('aborted', () => fail({ ok: false, status: 400, message: 'The upload was cut off.' }))
        request.on('error', () => fail({ ok: false, status: 400, message: 'The upload was cut off.' }))
        out.on('error', () => fail({ ok: false, status: 500, message: 'Studio could not save the upload.' }))
        out.on('finish', () => {
          if (settled) return
          settled = true
          resolve({ ok: true, path, bytes })
        })
        request.pipe(out)
      })
    },
    forgetSession(sessionId) {
      rmSync(join(root, uploadOwnerDir(sessionId)), { recursive: true, force: true })
      rmSync(join(root, legacyUploadOwnerDir(sessionId, 'session')), { recursive: true, force: true })
    },
  }
}
