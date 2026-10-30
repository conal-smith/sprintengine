import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, test } from 'vitest'

import { quotePromptPath } from '../../shared/prompt-path'
import { createScheduledPromptImages, SCHEDULED_IMAGES_DIRNAME } from './prompt-images'

let scratch = ''
let tempRoot = ''
let dataDir = ''

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'scheduled-prompt-images-'))
  tempRoot = join(scratch, 'temp images')
  dataDir = join(scratch, 'data')
  await mkdir(join(tempRoot, 'image-Ab12Cd'), { recursive: true })
  await writeFile(join(tempRoot, 'image-Ab12Cd', 'pasted.png'), 'png bytes')
})
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

test('a scheduled prompt names a kept copy of each temp image, not the temp file', async () => {
  let clock = Date.now()
  const images = createScheduledPromptImages({ dataDir, tempRoot, now: () => clock })
  const temp = join(tempRoot, 'image-Ab12Cd', 'pasted.png')
  const prompt = `Check this screenshot ${quotePromptPath(temp)} and file a bug`
  const kept = await images.keep(prompt)
  assert.ok(!kept.includes(tempRoot), kept)
  const copy = /'([^']+pasted\.png)'|(\S+pasted\.png)/.exec(kept)
  const path = copy?.[1] ?? copy?.[2] ?? ''
  assert.ok(path.startsWith(join(dataDir, SCHEDULED_IMAGES_DIRNAME)), path)
  assert.equal(await readFile(path, 'utf8'), 'png bytes')

  // The system clears its temp folder; the schedule's copy stays.
  await rm(tempRoot, { recursive: true, force: true })
  clock += 2 * 60 * 60 * 1000
  await images.prune([kept])
  assert.ok(await exists(path), 'named by a prompt: kept')
  await images.prune([])
  assert.equal(await exists(path), false, 'named by none: removed')
})

test('a copy made within the hour survives a prune that does not know it yet', async () => {
  const images = createScheduledPromptImages({ dataDir, tempRoot })
  const kept = await images.keep(`see ${join(tempRoot, 'image-Ab12Cd', 'pasted.png')}`)
  await images.prune([])
  assert.ok(await exists(join(dataDir, SCHEDULED_IMAGES_DIRNAME)))
  assert.ok(kept.includes(join(dataDir, SCHEDULED_IMAGES_DIRNAME)))
})

test('a prompt naming no temp image is stored as written', async () => {
  const images = createScheduledPromptImages({ dataDir, tempRoot })
  for (const prompt of ['summarise the open issues', `read ${join(scratch, 'notes.png')}`])
    assert.equal(await images.keep(prompt), prompt)
})
