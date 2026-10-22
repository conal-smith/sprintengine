import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { createFilesystemReadHandlers } from './filesystem-read'

test('an image on another machine is refused before the disk is asked', async () => {
  const { readImageDataUrl } = createFilesystemReadHandlers()
  for (const path of [
    '\\\\files.example.test\\share\\cat.png',
    '//files.example.test/share/cat.png',
    'file://files.example.test/share/cat.png',
  ]) {
    await expect(readImageDataUrl(path)).rejects.toThrow(/another computer/)
  }
})

test('an image on this disk is still read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sprintengine-image-read-'))
  try {
    const path = join(dir, 'dot.png')
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await expect(createFilesystemReadHandlers().readImageDataUrl(path)).resolves.toMatch(/^data:image\/png;base64,/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
