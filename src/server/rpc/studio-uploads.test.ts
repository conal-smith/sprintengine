import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

import { STUDIO_MAX_UPLOAD_BYTES, STUDIO_MAX_UPLOADS_PER_SEND } from '../../../packages/studio-protocol/src/public'
import { createStudioUploads, type StudioUploads } from './studio-uploads'
import { pngHeader } from '../../../tests/image-headers'

// The pictures a client stages ahead of a send: its own, counted against the
// connection that staged them, given back on discard, and let go of on a
// timer, or once a receipt answers for the send that spent them.

const open: StudioUploads[] = []
afterEach(() => {
  for (const uploads of open.splice(0)) uploads.close()
  vi.useRealTimers()
})

function staged(options: Parameters<typeof createStudioUploads>[0] = {}) {
  const uploads = createStudioUploads(options)
  open.push(uploads)
  return uploads
}

const one = { client: 'owner', connection: 'w1' }
const png = (byteLength = 3) => ({ mediaType: 'image/png', byteLength })

function finished(uploads: StudioUploads, holder = one): string {
  const begun = uploads.begin(holder, png())
  assert.ok(begun.ok)
  assert.ok(uploads.append(holder, { uploadId: begun.uploadId, offset: 0, dataBase64: 'AAAA' }).ok)
  return begun.uploadId
}

test("each window has its own budget: one that has staged all it may does not hold up another's", () => {
  const uploads = staged()
  for (let index = 0; index < STUDIO_MAX_UPLOADS_PER_SEND * 2; index++) assert.ok(uploads.begin(one, png()).ok)
  const full = uploads.begin(one, png())
  assert.equal(!full.ok && full.code, 'busy')
  assert.ok(uploads.begin({ client: 'owner', connection: 'w2' }, png()).ok, 'another window of the same Studio')
  const big = staged()
  for (let index = 0; index < STUDIO_MAX_UPLOADS_PER_SEND; index++)
    assert.ok(big.begin(one, png(STUDIO_MAX_UPLOAD_BYTES)).ok)
  const over = big.begin(one, png(1))
  assert.equal(!over.ok && over.code, 'too_large')
  assert.ok(big.begin({ client: 'owner', connection: 'w2' }, png(1)).ok)
})

test('a discarded upload is gone; one already sent, or another client’s, is passed over', () => {
  const uploads = staged()
  const kept = finished(uploads)
  const dropped = finished(uploads)
  const theirs = finished(uploads, { client: 'app-1', connection: 'c1' })
  assert.ok(uploads.spend('owner', [kept], 'owner:c1').ok)
  assert.deepEqual(uploads.discard('owner', [kept, dropped, theirs, 'no-such-upload']), { discarded: 1 })
  assert.equal(uploads.size(), 2)
  const gone = uploads.spend('owner', [dropped], 'owner:c2')
  assert.equal(!gone.ok && gone.code, 'not_found')
})

test('unsent uploads expire on a timer, and a closed window’s wait only a minute for its reconnect', () => {
  vi.useFakeTimers()
  const uploads = staged({ now: () => Date.now(), sweepEveryMs: 1_000 })
  finished(uploads)
  const orphan = finished(uploads, { client: 'owner', connection: 'w2' })
  const adopted = finished(uploads, { client: 'owner', connection: 'w3' })
  uploads.release('w2')
  uploads.release('w3')
  // The reconnect takes up one of its old connection's uploads.
  assert.ok(
    uploads.append({ client: 'owner', connection: 'w4' }, { uploadId: adopted, offset: 0, dataBase64: 'AAAA' }).ok,
  )
  vi.advanceTimersByTime(62_000)
  assert.equal(uploads.size(), 2, 'the orphan went, with no upload arriving to trigger a sweep')
  const lost = uploads.spend('owner', [orphan], 'owner:c1')
  assert.equal(!lost.ok && lost.code, 'not_found')
  vi.advanceTimersByTime(10 * 60_000)
  assert.equal(uploads.size(), 0, 'nothing unsent outlives ten minutes')
})

test('a recorded send lets its bytes go but keeps that they were sent; an unrecorded one hands them back', () => {
  const uploads = staged()
  const picture = finished(uploads)
  assert.ok(uploads.spend('owner', [picture], 'owner:c1').ok)
  uploads.settle('owner', 'owner:c1', false)
  // Nothing ran, so a retry under another id may carry them.
  const retried = uploads.spend('owner', [picture], 'owner:c2')
  assert.ok(retried.ok)
  assert.equal(retried.pictures[0].bytes.length, 3)
  uploads.settle('owner', 'owner:c2', true)
  const again = uploads.spend('owner', [picture], 'owner:c3')
  assert.equal(!again.ok && again.message, 'A picture in this send was already sent with another message.')
  assert.equal(uploads.size(), 1)
})

test('a file’s bytes are spent only by a file write, and a picture only by a send', () => {
  const uploads = staged()
  const file = uploads.begin(one, { mediaType: 'application/json', byteLength: 3, purpose: 'file' })
  assert.ok(file.ok)
  assert.ok(uploads.append(one, { uploadId: file.uploadId, offset: 0, dataBase64: 'AAAA' }).ok)
  const asPicture = uploads.spend('owner', [file.uploadId], 'send-1')
  assert.equal(!asPicture.ok && asPicture.code, 'invalid_params')
  assert.ok(uploads.spend('owner', [file.uploadId], 'write-1', 'file').ok)
  const picture = finished(uploads)
  const asFile = uploads.spend('owner', [picture], 'write-2', 'file')
  assert.equal(!asFile.ok && asFile.code, 'invalid_params')
})

test('a picture whose header declares more than 100 megapixels is not sent', () => {
  const uploads = staged()
  const stage = (bytes: Uint8Array): string => {
    const begun = uploads.begin(one, png(bytes.byteLength))
    assert.ok(begun.ok)
    const dataBase64 = Buffer.from(bytes).toString('base64')
    assert.ok(uploads.append(one, { uploadId: begun.uploadId, offset: 0, dataBase64 }).ok)
    return begun.uploadId
  }
  const refused = uploads.spend('owner', [stage(pngHeader(100_000, 100_000))], 'owner:c1')
  assert.equal(!refused.ok && refused.code, 'invalid_params')
  assert.ok(uploads.spend('owner', [stage(pngHeader(4032, 3024))], 'owner:c2').ok)
})
