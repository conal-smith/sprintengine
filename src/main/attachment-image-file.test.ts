import assert from 'node:assert/strict'
import { access, readFile, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

import {
  safeImageFileName,
  VIEWED_IMAGE_KEEP_MS,
  writeAttachmentImageFile,
  writeViewedImageFile,
} from './attachment-image-file'
import { test } from 'vitest'

test('attachment-image-file', async () => {
  // The writer behind both "attach this pasted image" and "open this image in the
  // OS viewer". The name it lands under is renderer-supplied, so most of what is
  // asserted here is what the name is NOT allowed to do.

  async function main(): Promise<void> {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00])
    const base64 = pngBytes.toString('base64')

    const namedPath = await writeAttachmentImageFile(
      { mediaType: 'image/png', dataBase64: base64, name: 'Screenshot 2026-09-07 at 21.48.06.png' },
      'image',
    )
    try {
      assert.equal(
        basename(namedPath),
        'Screenshot 2026-09-07 at 21.48.06.png',
        'the image keeps the name the person knows it by — the OS viewer titles its window with it',
      )
      assert.deepEqual(await readFile(namedPath), pngBytes, 'the file holds the decoded bytes')
    } finally {
      await rm(dirname(namedPath), { recursive: true, force: true })
    }

    const unnamedPath = await writeAttachmentImageFile({ mediaType: 'image/jpeg', dataBase64: base64 }, 'pasted')
    try {
      assert.equal(
        basename(unnamedPath),
        'pasted.jpg',
        'a clipboard paste has no name of its own, so it falls back to the caller stem and its media type',
      )
    } finally {
      await rm(dirname(unnamedPath), { recursive: true, force: true })
    }

    // Two writes in the same instant are two directories, so neither silently
    // overwrites the other even when both carry the same name.
    const first = await writeAttachmentImageFile(
      { mediaType: 'image/png', dataBase64: base64, name: 'shot.png' },
      'image',
    )
    const second = await writeAttachmentImageFile(
      { mediaType: 'image/png', dataBase64: base64, name: 'shot.png' },
      'image',
    )
    try {
      assert.notEqual(first, second, 'a repeated name does not collide')
      assert.equal(basename(first), basename(second), 'both still wear the name they were given')
    } finally {
      await rm(dirname(first), { recursive: true, force: true })
      await rm(dirname(second), { recursive: true, force: true })
    }

    await assert.rejects(
      () => writeAttachmentImageFile({ mediaType: 'image/svg+xml', dataBase64: base64 }, 'image'),
      /Only PNG, JPEG, WebP, and GIF/,
      'a media type the composer never stages is refused rather than written',
    )
    await assert.rejects(
      () => writeAttachmentImageFile({ mediaType: 'image/png', dataBase64: '' }, 'image'),
      /could not be read/,
      'an empty payload is refused rather than written as a zero-byte file',
    )

    // The name is a suggestion, never a path: it cannot climb out of the
    // directory, hide the file, or carry characters a filesystem refuses.
    assert.equal(
      safeImageFileName('../../etc/passwd.png', 'image', 'png'),
      'passwd.png',
      'a traversal in the name is reduced to its basename',
    )
    assert.equal(
      safeImageFileName('.hidden.png', 'image', 'png'),
      'hidden.png',
      'a leading dot cannot make the written file hidden',
    )
    assert.equal(
      safeImageFileName('a/b:c*d?.png', 'image', 'png'),
      'b c d.png',
      'separators and reserved characters are dropped rather than passed to the filesystem',
    )
    assert.equal(safeImageFileName('   .  ', 'image', 'png'), 'image.png', 'a name with nothing left falls back')
    assert.equal(safeImageFileName(undefined, 'pasted', 'webp'), 'pasted.webp', 'an absent name falls back')
    assert.equal(
      safeImageFileName('report.jpeg', 'image', 'png'),
      'report.png',
      'the extension comes from the media type, not from whatever the name claimed',
    )

    console.log('ok - attachment image files are written under a safe, recognizable name')
  }

  const suiteRun = main()

  await suiteRun
})

test('a name Windows keeps for a device is not used as it is', () => {
  for (const [name, saved] of [
    ['CON.png', '_CON.png'],
    ['nul.tar.png', '_nul.tar.png'],
    ['Com1.jpg', '_Com1.png'],
    ['lpt9', '_lpt9.png'],
    ['aux .notes.png', '_aux .notes.png'],
  ] as const)
    assert.equal(safeImageFileName(name, 'image', 'png'), saved, name)
  // Only the whole first part is a device name.
  assert.equal(safeImageFileName('console.png', 'image', 'png'), 'console.png')
  assert.equal(safeImageFileName('com10.png', 'image', 'png'), 'com10.png')
  assert.equal(safeImageFileName('my nul.png', 'image', 'png'), 'my nul.png')
})

test('opening the same image again reuses its viewer copy, and one unopened for a day goes', async () => {
  // Bytes no other test writes, so the copy is this test's own.
  const stamp = Buffer.from(`viewer-${process.pid}-${Date.now()}-${Math.random()}`)
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), stamp])
  const other = Buffer.concat([bytes, Buffer.from('other')])
  const input = { mediaType: 'image/png', dataBase64: bytes.toString('base64'), name: 'shot.png' }
  let clock = Date.now()
  const first = await writeViewedImageFile(input, 'image', () => clock)
  const otherPath = await writeViewedImageFile(
    { mediaType: 'image/png', dataBase64: other.toString('base64'), name: 'shot.png' },
    'image',
    () => clock,
  )
  try {
    assert.equal(await writeViewedImageFile(input, 'image', () => clock), first, 'one file per picture')
    assert.deepEqual(await readFile(first), bytes)
    clock += VIEWED_IMAGE_KEEP_MS / 2
    await writeViewedImageFile(input, 'image', () => clock)
    clock += VIEWED_IMAGE_KEEP_MS / 2 + 1_000
    // Opening the first again prunes the other, last opened more than a day ago.
    await writeViewedImageFile(input, 'image', () => clock)
    assert.ok(await access(first).then(() => true), 'opened within the day: kept')
    assert.equal(
      await access(otherPath).then(
        () => true,
        () => false,
      ),
      false,
    )
  } finally {
    await rm(dirname(first), { recursive: true, force: true })
    await rm(dirname(otherPath), { recursive: true, force: true })
  }
})
