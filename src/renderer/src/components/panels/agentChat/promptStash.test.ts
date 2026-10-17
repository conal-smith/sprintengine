import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { ConversationImageAttachment } from '../../../../../shared/conversation-runtime'
import {
  createPromptStash,
  MAX_STASH_IMAGE_BYTES,
  MAX_STASH_TEXT_CHARS,
  MAX_STASHED_PROMPTS,
  memoryImageVault,
  PROMPT_STASH_STORAGE_KEY,
  type PromptStashImageVault,
} from './promptStash'

function memoryStorage(limit = Infinity) {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (value.length > limit) throw new Error('QuotaExceededError')
      values.set(key, value)
    },
  }
}

function counter() {
  let id = 0
  let clock = 1_000
  return { newId: () => `entry-${++id}`, now: () => clock++ }
}

const image = (id: string, dataBase64 = 'aGVsbG8='): ConversationImageAttachment => ({
  id,
  mediaType: 'image/png',
  dataBase64,
  byteLength: 5,
  name: `${id}.png`,
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('a stashed prompt keeps its words, files and mentions, newest first', () => {
  const stash = createPromptStash({ storage: memoryStorage(), vault: memoryImageVault(), ...counter() })
  stash.stash({ text: 'first idea', files: ['/Users/dev/app/a.ts'] })
  stash.stash({ text: 'second idea', mentions: [{ path: 'src/b.ts', kind: 'file' }] })
  assert.deepEqual(
    stash.list().map((entry) => entry.text),
    ['second idea', 'first idea'],
  )
  assert.deepEqual(stash.list()[1].files, ['/Users/dev/app/a.ts'])
  assert.deepEqual(stash.list()[0].mentions, [{ path: 'src/b.ts', kind: 'file' }])
})

test('an empty composer stashes nothing', () => {
  const stash = createPromptStash({ storage: memoryStorage(), vault: memoryImageVault(), ...counter() })
  assert.equal(stash.stash({ text: '   \n' }), null)
  assert.deepEqual(stash.list(), [])
})

test('the stash outlives the window: a new one over the same storage reads it back', () => {
  const storage = memoryStorage()
  createPromptStash({ storage, vault: memoryImageVault(), ...counter() }).stash({ text: 'kept' })
  const again = createPromptStash({ storage, vault: memoryImageVault(), ...counter() })
  assert.deepEqual(
    again.list().map((entry) => entry.text),
    ['kept'],
  )
})

test("an image's bytes go to the vault and only its description to storage", async () => {
  const storage = memoryStorage()
  const vault = memoryImageVault()
  const stash = createPromptStash({ storage, vault, ...counter() })
  const entry = stash.stash({ text: 'look at this', images: [image('shot', 'Ynl0ZXM=')] })!
  await settle()
  assert.equal(storage.values.get(PROMPT_STASH_STORAGE_KEY)?.includes('Ynl0ZXM='), false)
  assert.equal((await vault.keys()).length, 1)
  // A fresh stash over the same storage and vault: the bytes come from the vault.
  const reopened = createPromptStash({ storage, vault, ...counter() })
  const loaded = await reopened.load(entry.id)
  assert.equal(loaded?.images[0].dataBase64, 'Ynl0ZXM=')
  assert.equal(loaded?.images[0].name, 'shot.png')
  assert.equal(loaded?.missingImages, 0)
})

test('removing an entry deletes its images from the vault', async () => {
  const vault = memoryImageVault()
  const stash = createPromptStash({ storage: memoryStorage(), vault, ...counter() })
  const entry = stash.stash({ text: '', images: [image('one'), image('two')] })!
  await settle()
  assert.equal((await vault.keys()).length, 2)
  stash.remove(entry.id)
  await settle()
  assert.deepEqual(await vault.keys(), [])
  assert.deepEqual(stash.list(), [])
})

test('an image the vault refuses is kept in memory for the session', async () => {
  const refusing: PromptStashImageVault = {
    put: () => Promise.reject(new Error('no room')),
    get: () => Promise.reject(new Error('no room')),
    remove: () => Promise.resolve(),
    keys: () => Promise.resolve([]),
  }
  const stash = createPromptStash({ storage: memoryStorage(), vault: refusing, ...counter() })
  const entry = stash.stash({ text: 'with a picture', images: [image('kept')] })!
  await settle()
  const loaded = await stash.load(entry.id)
  assert.equal(loaded?.images.length, 1)
  assert.equal(loaded?.missingImages, 0)
})

test('an image gone from the vault is counted as missing rather than failing the restore', async () => {
  const storage = memoryStorage()
  const entry = createPromptStash({ storage, vault: memoryImageVault(), ...counter() }).stash({
    text: 'words',
    images: [image('lost')],
  })!
  const elsewhere = createPromptStash({ storage, vault: memoryImageVault(), ...counter() })
  const loaded = await elsewhere.load(entry.id)
  assert.equal(loaded?.prompt.text, 'words')
  assert.deepEqual(loaded?.images, [])
  assert.equal(loaded?.missingImages, 1)
})

test(`the stash holds at most ${MAX_STASHED_PROMPTS} prompts, dropping the oldest and its images`, async () => {
  const vault = memoryImageVault()
  const stash = createPromptStash({ storage: memoryStorage(), vault, ...counter() })
  stash.stash({ text: 'oldest', images: [image('old')] })
  for (let index = 0; index < MAX_STASHED_PROMPTS; index++) stash.stash({ text: `prompt ${index}` })
  await settle()
  assert.equal(stash.list().length, MAX_STASHED_PROMPTS)
  assert.equal(
    stash.list().some((entry) => entry.text === 'oldest'),
    false,
  )
  assert.deepEqual(await vault.keys(), [])
})

test('past the words budget the oldest prompts go, and the newest is always kept', () => {
  const stash = createPromptStash({ storage: memoryStorage(), vault: memoryImageVault(), ...counter() })
  // Each under a draft's own cap; four of them are over the stash's budget.
  const quarter = 'a'.repeat(Math.ceil(MAX_STASH_TEXT_CHARS / 4))
  for (const name of ['p1', 'p2', 'p3', 'p4']) stash.stash({ text: `${name} ${quarter}` })
  assert.deepEqual(
    stash.list().map((entry) => entry.text.slice(0, 2)),
    ['p4', 'p3', 'p2'],
  )
})

test('past the images budget the oldest prompts go, and the newest is kept even alone over it', () => {
  const stash = createPromptStash({ storage: memoryStorage(), vault: memoryImageVault(), ...counter() })
  const huge = { ...image('huge'), byteLength: MAX_STASH_IMAGE_BYTES + 1 }
  stash.stash({ text: 'older', images: [image('small')] })
  stash.stash({ text: 'newest', images: [huge] })
  assert.deepEqual(
    stash.list().map((entry) => entry.text),
    ['newest'],
  )
})

test('when storage refuses the list, the oldest prompts are given up until it fits', () => {
  const storage = memoryStorage(400)
  const stash = createPromptStash({ storage, vault: memoryImageVault(), ...counter() })
  stash.stash({ text: 'a'.repeat(150) })
  stash.stash({ text: 'b'.repeat(150) })
  assert.equal(stash.saveFailed(), false)
  assert.deepEqual(
    stash.list().map((entry) => entry.text[0]),
    ['b'],
  )
})

test('a prompt too large for storage is kept for the session and says so', () => {
  const storage = memoryStorage(100)
  const stash = createPromptStash({ storage, vault: memoryImageVault(), ...counter() })
  stash.stash({ text: 'x'.repeat(500) })
  assert.equal(stash.saveFailed(), true)
  assert.equal(stash.list().length, 1)
})

test('a stored list that is not ours, or is damaged, reads as empty', () => {
  for (const raw of ['{', JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: 'x' })]) {
    const storage = memoryStorage()
    storage.values.set(PROMPT_STASH_STORAGE_KEY, raw)
    assert.deepEqual(createPromptStash({ storage, vault: memoryImageVault(), ...counter() }).list(), [])
  }
})

test('damaged entries are dropped and sound ones kept', () => {
  const storage = memoryStorage()
  storage.values.set(
    PROMPT_STASH_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      entries: [
        { id: 'good', text: 'fine', files: ['/Users/dev/a.ts', 'bad\u0000path'], images: [], stashedAt: 2 },
        { id: 'no-text', stashedAt: 1 },
        { id: 'empty', text: '', files: [], images: [], stashedAt: 3 },
      ],
    }),
  )
  const stash = createPromptStash({ storage, vault: memoryImageVault(), ...counter() })
  assert.deepEqual(
    stash.list().map((entry) => [entry.id, entry.files]),
    [['good', ['/Users/dev/a.ts']]],
  )
})

test('images no entry refers to are swept from the vault on start', async () => {
  const vault = memoryImageVault()
  await vault.put('gone\u0000image', { mediaType: 'image/png', dataBase64: 'eA==' })
  createPromptStash({ storage: memoryStorage(), vault, ...counter() })
  await settle()
  assert.deepEqual(await vault.keys(), [])
})

test('another window changing the stash is picked up on reload', () => {
  const storage = memoryStorage()
  const here = createPromptStash({ storage, vault: memoryImageVault(), ...counter() })
  const there = createPromptStash({ storage, vault: memoryImageVault(), newId: () => 'there', now: () => 9_999 })
  there.stash({ text: 'from the other window' })
  here.reload()
  assert.deepEqual(
    here.list().map((entry) => entry.text),
    ['from the other window'],
  )
})
