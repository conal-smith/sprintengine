import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFilesystemReadHandlers,
  looksLikeBinary,
  MAX_IMAGE_DATA_URL_BYTES,
  MAX_TEXT_FILE_READ_BYTES,
} from './filesystem-read'
import { readMemoryPreview } from './memory-graph'
import { test } from 'vitest'

test('filesystem-read', async () => {
  const suiteRun = main()

  async function main(): Promise<void> {
    await assertTextReadLimits()
    await assertImageReadLimits()
    await assertFileStats()
    await assertMemoryPreviewImageLimit()
    assertBinarySniffing()
  }

  async function assertTextReadLimits(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'sprintengine-fs-read-text-'))
    const handlers = createFilesystemReadHandlers()

    try {
      const smallPath = join(root, 'notes.txt')
      writeFileSync(smallPath, 'hello\n', 'utf8')
      assert.equal(await handlers.readTextFile(smallPath), 'hello\n')

      const largePath = join(root, 'large.txt')
      writeFileSync(largePath, Buffer.alloc(MAX_TEXT_FILE_READ_BYTES + 1, 0x61))
      await assert.rejects(() => handlers.readTextFile(largePath), /too large/u)

      const binaryPath = join(root, 'binary.dat')
      writeFileSync(binaryPath, Buffer.from([0x68, 0x69, 0x00, 0xff]))
      await assert.rejects(() => handlers.readTextFile(binaryPath), /binary/u)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  }

  async function assertImageReadLimits(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'sprintengine-fs-read-image-'))
    const handlers = createFilesystemReadHandlers()

    try {
      const smallImagePath = join(root, 'image.png')
      writeFileSync(smallImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      const dataUrl = await handlers.readImageDataUrl(smallImagePath)
      assert.match(dataUrl, /^data:image\/png;base64,/u)

      const largeImagePath = join(root, 'large.png')
      writeFileSync(largeImagePath, Buffer.alloc(MAX_IMAGE_DATA_URL_BYTES + 1, 0x89))
      await assert.rejects(() => handlers.readImageDataUrl(largeImagePath), /too large/u)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  }

  async function assertFileStats(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'sprintengine-fs-stat-'))
    const handlers = createFilesystemReadHandlers()

    try {
      const targetPath = join(root, 'mockup.html')
      writeFileSync(targetPath, '<main>hello</main>', 'utf8')
      const stats = await handlers.statPath(targetPath)
      assert.equal(stats.isFile, true)
      assert.equal(stats.isDirectory, false)
      assert.equal(stats.sizeBytes, '<main>hello</main>'.length)
      assert.match(stats.modifiedAt, /^\d{4}-\d{2}-\d{2}T/u)
      assert.equal(Number.isFinite(stats.modifiedAtMs), true)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  }

  async function assertMemoryPreviewImageLimit(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'sprintengine-memory-preview-image-'))

    try {
      const knowledgeRoot = join(root, 'knowledge')
      mkdirSync(knowledgeRoot, { recursive: true })
      const largeImagePath = join(knowledgeRoot, 'large.png')
      writeFileSync(largeImagePath, Buffer.alloc(MAX_IMAGE_DATA_URL_BYTES + 1, 0x89))

      const preview = await readMemoryPreview(root, 'knowledge', 'large.png')
      assert.equal(preview.ok, true)
      if (preview.ok) {
        assert.equal(preview.previewKind, 'unsupported')
        assert.match(preview.message, /too large/u)
      }
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  }

  function assertBinarySniffing(): void {
    assert.equal(looksLikeBinary(Buffer.from('plain text\n')), false)
    assert.equal(looksLikeBinary(Buffer.from([0x61, 0x00, 0x62])), true)
  }

  await suiteRun
})

test('a ~/ picture is stat’d and read from the home folder', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sprintengine-fs-home-'))
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    mkdirSync(join(home, 'Desktop'))
    writeFileSync(join(home, 'Desktop', 'shot.png'), Buffer.from('png'))
    const handlers = createFilesystemReadHandlers()
    assert.equal((await handlers.statPath('~/Desktop/shot.png')).sizeBytes, 3)
    assert.equal(await handlers.readImageDataUrl('~/Desktop/shot.png'), 'data:image/png;base64,cG5n')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { force: true, recursive: true })
  }
})
