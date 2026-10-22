import { lstat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'

import { attachmentImagesRoot, writeAttachmentImageFile } from './attachment-image-file'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')

test('on Linux the images folder is named for this user', () => {
  const uid = process.getuid?.()
  if (uid === undefined) return
  expect(attachmentImagesRoot('linux')).toBe(join(tmpdir(), `sprintengine-images-${uid}`))
  expect(attachmentImagesRoot('darwin')).toBe(join(tmpdir(), 'sprintengine-images'))
})

test.skipIf(process.platform === 'win32')('a saved image is readable by this user only', async () => {
  const path = await writeAttachmentImageFile({ mediaType: 'image/png', dataBase64: PNG }, 'pasted')
  try {
    expect((await lstat(path)).mode & 0o777).toBe(0o600)
    expect((await lstat(dirname(path))).mode & 0o777).toBe(0o700)
    expect((await lstat(attachmentImagesRoot())).mode & 0o777).toBe(0o700)
    expect(dirname(dirname(path))).toBe(attachmentImagesRoot())
  } finally {
    await rm(dirname(path), { recursive: true, force: true })
  }
})
