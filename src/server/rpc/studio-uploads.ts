import { randomUUID } from 'node:crypto'

import {
  STUDIO_MAX_UPLOAD_BYTES,
  STUDIO_MAX_UPLOADS_PER_SEND,
  STUDIO_UPLOAD_CHUNK_BYTES,
} from '../../../packages/studio-protocol/src/public'
import { imageWithinDecodeLimits } from '../../shared/image-dimensions'

// Pictures a client sends ahead of the `session.send` that carries them. A
// frame holds about a megabyte and a picture may be five, so the bytes come in
// `uploads.append` pieces, and the send names the finished uploads by id.
//
// An upload belongs to the client that began it (its grant's id), so a window
// that reconnects can still finish and send what it staged. The budget is the
// connection's: as many uploads as one send may carry, twice over, at the
// largest size each may be, so one window cannot spend another's. An append
// from a new connection of the same client takes the upload into that
// connection's budget. When a connection closes, what it staged and did not
// send is kept only a minute, for its reconnect to take up. Anything left
// unsent goes after ten minutes; a sweep runs on a timer, not only when the
// next upload arrives. `uploads.discard` lets a client give back what it will
// not send.
//
// A send spends its uploads under its command id. Once the runtime holds that
// command's receipt, a repeat of the send is answered from the receipt and
// never needs the pictures again, so their bytes are let go of then; the
// router asks for the receipt before it spends anything. If the send left no
// receipt (nothing ran), its uploads go back to unsent, for a retry to carry.

const UPLOAD_TTL_MS = 10 * 60_000
/** How long a closed connection's unsent uploads wait for its reconnect. */
const ORPHAN_GRACE_MS = 60_000
/** How long a spent upload's record outlives its send, so a second send naming it is told it was sent. */
const SPENT_GRACE_MS = 10 * 60_000
const SWEEP_EVERY_MS = 30_000
const MAX_OPEN_UPLOADS = STUDIO_MAX_UPLOADS_PER_SEND * 2
const MAX_STAGED_BYTES = STUDIO_MAX_UPLOADS_PER_SEND * STUDIO_MAX_UPLOAD_BYTES

type Upload = {
  id: string
  owner: string
  /** The connection whose budget it counts against, until that connection closes. */
  connection: string | null
  mediaType: string
  /** A picture for a send, or a file's bytes for `files.write`: each is spent only as what it was begun as. */
  purpose: StudioUploadPurpose
  name?: string
  byteLength: number
  chunks: Buffer[]
  received: number
  at: number
  orphanedAt?: number
  spentBy?: { commandId: string; at: number }
}

export type StudioUploadPurpose = 'picture' | 'file'

const PICTURE_TOO_LARGE = 'A picture in this send is too large to open: over 16384 pixels a side, or 100 megapixels.'

/** An upload's bytes as one buffer, joined once. */
function bytesOf(upload: Upload): Buffer {
  if (upload.chunks.length > 1) upload.chunks = [Buffer.concat(upload.chunks)]
  return upload.chunks[0] ?? Buffer.alloc(0)
}

/** Who is asking: the client an upload belongs to, and the connection whose budget it is counted in. */
export type StudioUploadHolder = { client: string; connection: string }

export type StudioUploadRefusal = {
  ok: false
  code: 'invalid_params' | 'not_found' | 'busy' | 'too_large'
  message: string
}

/** A finished picture, as a send hands it to the runtime. */
export type StudioUploadedPicture = { uploadId: string; mediaType: string; name?: string; bytes: Buffer }

export type StudioUploads = {
  begin(
    holder: StudioUploadHolder,
    input: { mediaType: string; byteLength: number; name?: string; purpose?: StudioUploadPurpose },
  ): { ok: true; uploadId: string; chunkBytes: number } | StudioUploadRefusal
  append(
    holder: StudioUploadHolder,
    input: { uploadId: string; offset: number; dataBase64: string },
  ): { ok: true; received: number } | StudioUploadRefusal
  /** Give back unsent uploads; an id that is unknown, another client's or already sent is passed over. */
  discard(owner: string, uploadIds: string[]): { discarded: number }
  /** The finished uploads a send names, spent under its command id. */
  spend(
    owner: string,
    uploadIds: string[],
    commandId: string,
    purpose?: StudioUploadPurpose,
  ): { ok: true; pictures: StudioUploadedPicture[] } | StudioUploadRefusal
  /**
   * What became of the send that spent these: `recorded`, and its receipt
   * answers any repeat, so the bytes go; otherwise nothing ran, and the
   * uploads are unsent again.
   */
  settle(owner: string, commandId: string, recorded: boolean): void
  /** A connection closed: what it staged and did not send waits a minute for its reconnect. */
  release(connection: string): void
  /** Stop the sweep's timer and let go of everything. */
  close(): void
  /** How many uploads are held, for tests. */
  size(): number
}

export function createStudioUploads(options: { now?: () => number; sweepEveryMs?: number } = {}): StudioUploads {
  const now = options.now ?? Date.now
  const uploads = new Map<string, Upload>()

  function sweep(): void {
    const at = now()
    for (const [id, upload] of uploads) {
      const expired = upload.spentBy
        ? at - upload.spentBy.at > SPENT_GRACE_MS
        : at - upload.at > UPLOAD_TTL_MS ||
          (upload.orphanedAt !== undefined && at - upload.orphanedAt > ORPHAN_GRACE_MS)
      if (expired) uploads.delete(id)
    }
  }
  const timer = setInterval(sweep, options.sweepEveryMs ?? SWEEP_EVERY_MS)
  timer.unref?.()

  const counted = (connection: string) =>
    [...uploads.values()].filter((upload) => upload.connection === connection && !upload.spentBy)
  const find = (owner: string, uploadId: string): Upload | StudioUploadRefusal => {
    const upload = uploads.get(uploadId)
    // Another client's upload is not found, rather than refused: its id says nothing to this one.
    if (!upload || upload.owner !== owner)
      return {
        ok: false,
        code: 'not_found',
        message: 'That upload is not here; it may have expired. Send the picture again.',
      }
    return upload
  }
  const spentWith = (owner: string, commandId: string) =>
    [...uploads.values()].filter((upload) => upload.owner === owner && upload.spentBy?.commandId === commandId)

  return {
    begin(holder, input) {
      sweep()
      const open = counted(holder.connection)
      if (open.length >= MAX_OPEN_UPLOADS)
        return { ok: false, code: 'busy', message: 'Too many pictures are waiting to be sent from this window.' }
      if (open.reduce((total, upload) => total + upload.byteLength, 0) + input.byteLength > MAX_STAGED_BYTES)
        return {
          ok: false,
          code: 'too_large',
          message: 'The pictures waiting to be sent are already as large as one send may carry.',
        }
      const id = randomUUID()
      uploads.set(id, {
        id,
        owner: holder.client,
        connection: holder.connection,
        mediaType: input.mediaType,
        purpose: input.purpose ?? 'picture',
        ...(input.name === undefined ? {} : { name: input.name }),
        byteLength: input.byteLength,
        chunks: [],
        received: 0,
        at: now(),
      })
      return { ok: true, uploadId: id, chunkBytes: STUDIO_UPLOAD_CHUNK_BYTES }
    },

    append(holder, input) {
      sweep()
      const upload = find(holder.client, input.uploadId)
      if ('ok' in upload) return upload
      if (upload.spentBy) return { ok: false, code: 'invalid_params', message: 'That picture was already sent.' }
      // A reconnect takes up what its closed connection began.
      if (upload.connection !== holder.connection) {
        upload.connection = holder.connection
        delete upload.orphanedAt
      }
      const bytes = Buffer.from(input.dataBase64, 'base64')
      // The same piece again (a request resent after a dropped connection) is
      // answered, not appended twice.
      if (input.offset + bytes.length <= upload.received && input.offset < upload.received)
        return { ok: true, received: upload.received }
      if (input.offset !== upload.received)
        return {
          ok: false,
          code: 'invalid_params',
          message: `Expected the bytes from ${upload.received}, not ${input.offset}.`,
        }
      if (bytes.length > STUDIO_UPLOAD_CHUNK_BYTES || upload.received + bytes.length > upload.byteLength)
        return { ok: false, code: 'too_large', message: 'More bytes than the upload said it would carry.' }
      upload.chunks.push(bytes)
      upload.received += bytes.length
      upload.at = now()
      return { ok: true, received: upload.received }
    },

    discard(owner, uploadIds) {
      let discarded = 0
      for (const uploadId of uploadIds) {
        const upload = uploads.get(uploadId)
        if (!upload || upload.owner !== owner || upload.spentBy) continue
        uploads.delete(uploadId)
        discarded++
      }
      return { discarded }
    },

    spend(owner, uploadIds, commandId, purpose = 'picture') {
      sweep()
      const found: Upload[] = []
      for (const uploadId of uploadIds) {
        const upload = find(owner, uploadId)
        if ('ok' in upload) return upload
        if (upload.purpose !== purpose)
          return {
            ok: false,
            code: 'invalid_params',
            message:
              purpose === 'file' ? 'That upload is a picture, not a file.' : 'That upload is a file, not a picture.',
          }
        if (upload.spentBy && upload.spentBy.commandId !== commandId)
          return {
            ok: false,
            code: 'invalid_params',
            message: 'A picture in this send was already sent with another message.',
          }
        if (upload.received !== upload.byteLength || (upload.spentBy && upload.chunks.length === 0))
          return { ok: false, code: 'invalid_params', message: 'A picture in this send has not finished uploading.' }
        // Measured before anything decodes it: a small file can declare a vast picture.
        if (purpose === 'picture' && upload.chunks.length > 0 && !imageWithinDecodeLimits(bytesOf(upload)))
          return { ok: false, code: 'invalid_params', message: PICTURE_TOO_LARGE }
        found.push(upload)
      }
      const at = now()
      for (const upload of found) upload.spentBy = { commandId, at }
      return {
        ok: true,
        pictures: found.map((upload) => ({
          uploadId: upload.id,
          mediaType: upload.mediaType,
          ...(upload.name === undefined ? {} : { name: upload.name }),
          bytes: bytesOf(upload),
        })),
      }
    },

    settle(owner, commandId, recorded) {
      for (const upload of spentWith(owner, commandId)) {
        if (recorded) {
          // Its receipt answers every repeat: only the record that it was sent stays.
          upload.chunks = []
        } else {
          delete upload.spentBy
          upload.at = now()
        }
      }
    },

    release(connection) {
      const at = now()
      for (const upload of uploads.values()) {
        if (upload.connection !== connection) continue
        upload.connection = null
        if (!upload.spentBy) upload.orphanedAt = at
      }
    },

    close() {
      clearInterval(timer)
      uploads.clear()
    },

    size: () => uploads.size,
  }
}
