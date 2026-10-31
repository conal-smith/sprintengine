import { beforeEach, expect, test } from 'vitest'
import { memoryImageVault } from '../../panels/agentChat/promptStash'
import {
  currentNewChatDraftId,
  deleteNewChatDraft,
  flushNewChatDrafts,
  listNewChatDrafts,
  MAX_NEW_CHAT_DRAFTS,
  NEW_CHAT_DRAFTS_STORAGE_KEY,
  newChatDraftTitle,
  readNewChatDraft,
  resetNewChatDraftsForTests,
  resumeNewChatDraft,
  startAnotherNewChatDraft,
  subscribeNewChatDrafts,
  writeNewChatDraft,
} from './newChatDraft'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

let storage = memoryStorage()
let vault = memoryImageVault()

/** A reload: memory forgotten, the same storage and vault read back. */
function reload() {
  flushNewChatDrafts()
  resetNewChatDraftsForTests({ storage, vault })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  storage = memoryStorage()
  vault = memoryImageVault()
  resetNewChatDraftsForTests({ storage, vault })
})

test('a draft survives a reload, and the window reopens on it', () => {
  writeNewChatDraft('window-1', {
    prompt: 'Fix the login redirect',
    folderPath: '/Users/dev/acme',
    files: ['/Users/dev/acme/a.ts'],
  })
  reload()
  expect(readNewChatDraft('window-1')).toMatchObject({
    prompt: 'Fix the login redirect',
    folderPath: '/Users/dev/acme',
    files: ['/Users/dev/acme/a.ts'],
  })
  expect(listNewChatDrafts().map((entry) => entry.draft.prompt)).toEqual(['Fix the login redirect'])
})

test('an empty draft is neither listed nor kept', () => {
  writeNewChatDraft('window-1', { prompt: '   ', folderPath: '/Users/dev/acme' })
  expect(listNewChatDrafts()).toEqual([])
  reload()
  expect(readNewChatDraft('window-1')).toBeNull()
  expect(JSON.parse(storage.getItem(NEW_CHAT_DRAFTS_STORAGE_KEY)!).drafts).toEqual([])
})

test('starting another keeps a draft with words and begins a fresh one; resuming switches back', () => {
  writeNewChatDraft('window-1', { prompt: 'first' })
  const first = currentNewChatDraftId('window-1')!
  expect(startAnotherNewChatDraft('window-1')).toBe(true)
  expect(readNewChatDraft('window-1')).toBeNull()
  writeNewChatDraft('window-1', { prompt: 'second' })
  expect(listNewChatDrafts().map((entry) => entry.draft.prompt)).toEqual(['second', 'first'])
  expect(resumeNewChatDraft('window-1', first)).toBe(true)
  expect(readNewChatDraft('window-1')?.prompt).toBe('first')
  // Editing one never reorders the list.
  writeNewChatDraft('window-1', { prompt: 'first, edited' })
  expect(listNewChatDrafts().map((entry) => entry.draft.prompt)).toEqual(['second', 'first, edited'])
  reload()
  expect(listNewChatDrafts().map((entry) => entry.draft.prompt)).toEqual(['second', 'first, edited'])
  expect(readNewChatDraft('window-1')?.prompt).toBe('first, edited')
})

test('starting another over an empty draft lets it go', () => {
  writeNewChatDraft('window-1', { prompt: '' })
  expect(startAnotherNewChatDraft('window-1')).toBe(false)
  expect(listNewChatDrafts()).toEqual([])
})

test('a deleted draft is gone from the list and from the window showing it', () => {
  writeNewChatDraft('window-1', { prompt: 'throw me away' })
  const id = currentNewChatDraftId('window-1')!
  let calls = 0
  const stop = subscribeNewChatDrafts(() => (calls += 1))
  deleteNewChatDraft(id)
  stop()
  expect(calls).toBeGreaterThan(0)
  expect(listNewChatDrafts()).toEqual([])
  expect(readNewChatDraft('window-1')).toBeNull()
  reload()
  expect(listNewChatDrafts()).toEqual([])
})

test('images come back from the vault after a reload, and leave it with their draft', async () => {
  const image = { id: 'img-1', mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=', byteLength: 8, path: '/tmp/a.png' }
  writeNewChatDraft('window-1', { prompt: 'see screenshot', images: [image] })
  flushNewChatDrafts()
  await settle()
  // The words are in storage without the bytes.
  expect(storage.getItem(NEW_CHAT_DRAFTS_STORAGE_KEY)).not.toContain('iVBORw0KGgo=')
  reload()
  await settle()
  expect(readNewChatDraft('window-1')?.images).toEqual([image])
  deleteNewChatDraft(currentNewChatDraftId('window-1')!)
  flushNewChatDrafts()
  await settle()
  expect(await vault.keys()).toEqual([])
})

test('two windows each keep their own open draft across a reload', () => {
  writeNewChatDraft('window-1', { prompt: 'one' })
  writeNewChatDraft('window-2', { prompt: 'two' })
  reload()
  expect(readNewChatDraft('window-2')?.prompt).toBe('two')
  expect(readNewChatDraft('window-1')?.prompt).toBe('one')
})

test('past the cap the oldest drafts go', () => {
  for (let index = 0; index < MAX_NEW_CHAT_DRAFTS + 3; index += 1) {
    writeNewChatDraft('window-1', { prompt: `draft ${index}` })
    startAnotherNewChatDraft('window-1')
  }
  reload()
  const prompts = listNewChatDrafts().map((entry) => entry.draft.prompt)
  expect(prompts).toHaveLength(MAX_NEW_CHAT_DRAFTS)
  expect(prompts).not.toContain('draft 0')
})

test("a draft's line is its first words, or what it carries", () => {
  const base = readNewChatDraft('nobody') ?? writeNewChatDraft('w', {})
  expect(newChatDraftTitle({ ...base, prompt: '  Plan the release\nwith notes' })).toBe('Plan the release')
  expect(newChatDraftTitle({ ...base, prompt: '', files: ['/a', '/b'] })).toBe('2 files')
  expect(
    newChatDraftTitle({
      ...base,
      prompt: '',
      images: [{ id: 'i', mediaType: 'image/png', dataBase64: '', byteLength: 0, path: '/p' }],
    }),
  ).toBe('1 image')
})
