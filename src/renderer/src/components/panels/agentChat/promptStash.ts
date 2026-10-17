import type { ConversationImageAttachment } from '../../../../../shared/conversation-runtime'
import { parseConversationMentions, type ConversationMentionRef } from '../../../../../shared/conversation/mentions'
import { MAX_DRAFT_CHARS } from './draftStore'

// The prompt stash: drafts set aside with ⌘S to clear the box for something
// else, and brought back from the picker ⌘S opens on an empty box. One list
// for the whole app rather than one per chat, because the reason to stash is
// usually "not this chat, not now": the words are picked up somewhere else.
//
// Local to this device, like drafts. The words, files and mentions live in
// localStorage beside the drafts, under a budget of their own so a full stash
// never crowds out the draft being typed. An image's bytes do not fit that
// budget (one can be several megabytes), so they go to an image vault —
// IndexedDB in the app — keyed by the entry, and only their name, type and
// size sit in the list. Until the vault has an image, and for the whole session
// when it cannot take one, the bytes are held in memory, so a stash always
// comes back whole within the session it was made in.

export const MAX_STASHED_PROMPTS = 50
/** All entries' words, files and mentions together, in localStorage. */
export const MAX_STASH_TEXT_CHARS = 400_000
/** All entries' image bytes together, in the vault. */
export const MAX_STASH_IMAGE_BYTES = 200 * 1024 * 1024
const MAX_STASH_FILES = 50
const MAX_STASH_IMAGES = 16
export const PROMPT_STASH_STORAGE_KEY = 'sprintengine-prompt-stash'

export type StashedImage = { id: string; mediaType: string; byteLength: number; name?: string }

export type StashedPrompt = {
  id: string
  text: string
  files: string[]
  mentions: ConversationMentionRef[]
  images: StashedImage[]
  stashedAt: number
}

export type PromptStashInput = {
  text: string
  files?: readonly string[]
  mentions?: readonly ConversationMentionRef[]
  images?: readonly ConversationImageAttachment[]
}

/** An entry read back for restoring: its images with their bytes, and how many could not be found. */
export type LoadedStashedPrompt = {
  prompt: StashedPrompt
  images: ConversationImageAttachment[]
  missingImages: number
}

type ImageBytes = { mediaType: string; dataBase64: string }

/** Where an image's bytes are kept. Every method may reject; the stash treats that as "not kept". */
export type PromptStashImageVault = {
  put(key: string, value: ImageBytes): Promise<void>
  get(key: string): Promise<ImageBytes | null>
  remove(keys: readonly string[]): Promise<void>
  keys(): Promise<string[]>
}

type StashStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void }

const imageKey = (entryId: string, imageId: string) => `${entryId}\u0000${imageId}`
const entryImageKeys = (entry: StashedPrompt) => entry.images.map((image) => imageKey(entry.id, image.id))
const textChars = (entry: StashedPrompt) =>
  entry.text.length + JSON.stringify(entry.files).length + JSON.stringify(entry.mentions).length
const imageBytes = (entry: StashedPrompt) => entry.images.reduce((sum, image) => sum + image.byteLength, 0)

/** Whether a composer holding this has anything worth stashing. */
function stashInputHasContent(input: PromptStashInput): boolean {
  return (
    input.text.trim().length > 0 ||
    (input.files?.length ?? 0) > 0 ||
    (input.mentions?.length ?? 0) > 0 ||
    (input.images?.length ?? 0) > 0
  )
}

const isSafePath = (path: unknown): path is string =>
  typeof path === 'string' && path.length > 0 && path.length <= 4096 && !/[\u0000-\u001f]/u.test(path)

function normalizeImage(value: unknown): StashedImage | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<StashedImage>
  if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 256) return null
  if (typeof raw.mediaType !== 'string' || !raw.mediaType.startsWith('image/') || raw.mediaType.length > 128)
    return null
  if (typeof raw.byteLength !== 'number' || !Number.isFinite(raw.byteLength) || raw.byteLength < 0) return null
  return {
    id: raw.id,
    mediaType: raw.mediaType,
    byteLength: raw.byteLength,
    ...(typeof raw.name === 'string' && raw.name ? { name: raw.name.slice(0, 512) } : {}),
  }
}

function normalizeEntry(value: unknown): StashedPrompt | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<StashedPrompt>
  if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 256) return null
  if (typeof raw.text !== 'string') return null
  if (typeof raw.stashedAt !== 'number' || !Number.isFinite(raw.stashedAt)) return null
  const entry: StashedPrompt = {
    id: raw.id,
    text: raw.text.slice(0, MAX_DRAFT_CHARS),
    files: Array.isArray(raw.files) ? raw.files.filter(isSafePath).slice(0, MAX_STASH_FILES) : [],
    mentions: parseConversationMentions(raw.mentions) ?? [],
    images: Array.isArray(raw.images)
      ? raw.images
          .map(normalizeImage)
          .filter((image): image is StashedImage => image !== null)
          .slice(0, MAX_STASH_IMAGES)
      : [],
    stashedAt: raw.stashedAt,
  }
  const empty = !entry.text.trim() && !entry.files.length && !entry.mentions.length && !entry.images.length
  return empty ? null : entry
}

/**
 * Newest first, as many as the count and both budgets allow. The newest entry
 * is always kept: it is the one the person just stashed.
 */
function bounded(entries: readonly StashedPrompt[]): { kept: StashedPrompt[]; dropped: StashedPrompt[] } {
  const kept: StashedPrompt[] = []
  const dropped: StashedPrompt[] = []
  let chars = 0
  let bytes = 0
  for (const entry of entries) {
    chars += textChars(entry)
    bytes += imageBytes(entry)
    const over = chars > MAX_STASH_TEXT_CHARS || bytes > MAX_STASH_IMAGE_BYTES
    if (kept.length >= MAX_STASHED_PROMPTS || (kept.length > 0 && over)) dropped.push(entry)
    else kept.push(entry)
  }
  return { kept, dropped }
}

export type PromptStash = ReturnType<typeof createPromptStash>

export function createPromptStash({
  storage,
  vault,
  now = Date.now,
  newId = () => crypto.randomUUID(),
}: {
  storage: StashStorage
  vault: PromptStashImageVault
  now?: () => number
  newId?: () => string
}) {
  // Bytes the vault does not hold (yet, or at all this session), by image key.
  const memory = new Map<string, ImageBytes>()
  const listeners = new Set<() => void>()
  let entries: readonly StashedPrompt[] = load()
  let saveFailed = false

  function load(): StashedPrompt[] {
    try {
      const raw = storage.getItem(PROMPT_STASH_STORAGE_KEY)
      if (!raw) return []
      const envelope = JSON.parse(raw) as { version?: unknown; entries?: unknown }
      if (envelope?.version !== 1 || !Array.isArray(envelope.entries)) return []
      const seen = new Set<string>()
      const valid = envelope.entries
        .map(normalizeEntry)
        .filter((entry): entry is StashedPrompt => {
          if (!entry || seen.has(entry.id)) return false
          seen.add(entry.id)
          return true
        })
        .sort((a, b) => b.stashedAt - a.stashedAt)
      return bounded(valid).kept
    } catch {
      return []
    }
  }

  const emit = () => {
    for (const listener of listeners) listener()
  }

  // The list as JSON, giving up the oldest entries when the quota refuses it.
  // Fewer is always smaller, and the newest is never given up: if even that
  // does not fit it stays in memory, and `saveFailed` says so.
  function persist() {
    for (let count = entries.length; count >= 1; count--) {
      try {
        storage.setItem(PROMPT_STASH_STORAGE_KEY, JSON.stringify({ version: 1, entries: entries.slice(0, count) }))
        saveFailed = false
        if (count < entries.length) forget(entries.slice(count))
        return
      } catch {
        // Try with one fewer.
      }
    }
    if (entries.length === 0) {
      try {
        storage.setItem(PROMPT_STASH_STORAGE_KEY, JSON.stringify({ version: 1, entries: [] }))
        saveFailed = false
        return
      } catch {
        // Fall through.
      }
    }
    saveFailed = true
  }

  function forget(gone: readonly StashedPrompt[]) {
    if (gone.length === 0) return
    const ids = new Set(gone.map((entry) => entry.id))
    entries = entries.filter((entry) => !ids.has(entry.id))
    const keys = gone.flatMap(entryImageKeys)
    for (const key of keys) memory.delete(key)
    if (keys.length) void vault.remove(keys).catch(() => undefined)
  }

  function replace(next: readonly StashedPrompt[]) {
    const { kept, dropped } = bounded(next)
    entries = kept
    forget(dropped)
    persist()
    emit()
  }

  // Images left in the vault by an entry that no longer exists: one taken
  // back before its bytes landed, or a list that was cleared by hand.
  void vault
    .keys()
    .then((keys) => {
      const live = new Set(entries.flatMap(entryImageKeys))
      const orphans = keys.filter((key) => !live.has(key))
      return orphans.length ? vault.remove(orphans) : undefined
    })
    .catch(() => undefined)

  return {
    /** Newest first. The same array until the stash changes, for `useSyncExternalStore`. */
    list: (): readonly StashedPrompt[] => entries,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** Read the list again: another window of the app changed it. */
    reload() {
      entries = load()
      emit()
    },
    /** Whether the last change could not be written to this device's storage. */
    saveFailed: () => saveFailed,
    /** Set a composer's content aside. Null when there is nothing in it to keep. */
    stash(input: PromptStashInput): StashedPrompt | null {
      if (!stashInputHasContent(input)) return null
      const id = newId()
      const images = (input.images ?? []).slice(0, MAX_STASH_IMAGES)
      const entry: StashedPrompt = {
        id,
        text: input.text.slice(0, MAX_DRAFT_CHARS),
        files: (input.files ?? []).filter(isSafePath).slice(0, MAX_STASH_FILES),
        mentions: [...(input.mentions ?? [])],
        images: images.map((image) => ({
          id: image.id,
          mediaType: image.mediaType,
          byteLength: image.byteLength,
          ...(image.name ? { name: image.name } : {}),
        })),
        stashedAt: Math.max(now(), ...entries.map((existing) => existing.stashedAt + 1)),
      }
      for (const image of images) {
        const key = imageKey(id, image.id)
        const bytes = { mediaType: image.mediaType, dataBase64: image.dataBase64 }
        memory.set(key, bytes)
        void vault.put(key, bytes).then(
          () => {
            // Taken back before the write landed: the vault's copy has no entry.
            if (!entries.some((existing) => existing.id === id)) void vault.remove([key]).catch(() => undefined)
            else memory.delete(key)
          },
          // The vault refused it: memory keeps it for this session.
          () => undefined,
        )
      }
      replace([entry, ...entries])
      return entries.find((existing) => existing.id === id) ?? null
    },
    /** An entry with its images' bytes, for restoring. It stays in the stash until `remove`. */
    async load(id: string): Promise<LoadedStashedPrompt | null> {
      const prompt = entries.find((entry) => entry.id === id)
      if (!prompt) return null
      const images: ConversationImageAttachment[] = []
      let missingImages = 0
      for (const image of prompt.images) {
        const key = imageKey(prompt.id, image.id)
        const bytes = memory.get(key) ?? (await vault.get(key).catch(() => null))
        if (!bytes) {
          missingImages++
          continue
        }
        images.push({
          id: image.id,
          mediaType: bytes.mediaType,
          dataBase64: bytes.dataBase64,
          byteLength: image.byteLength,
          ...(image.name ? { name: image.name } : {}),
        })
      }
      return { prompt, images, missingImages }
    },
    remove(id: string) {
      const gone = entries.filter((entry) => entry.id === id)
      if (gone.length === 0) return
      forget(gone)
      persist()
      emit()
    },
  }
}

/** Bytes in memory only: the vault where IndexedDB is missing, and in tests. */
export function memoryImageVault(): PromptStashImageVault {
  const store = new Map<string, ImageBytes>()
  return {
    put: async (key, value) => void store.set(key, value),
    get: async (key) => store.get(key) ?? null,
    remove: async (keys) => {
      for (const key of keys) store.delete(key)
    },
    keys: async () => [...store.keys()],
  }
}

const VAULT_DB = 'sprintengine-prompt-stash'
const VAULT_STORE = 'images'

/** The app's vault: one IndexedDB object store of image bytes by key. */
function indexedDbImageVault(factory: IDBFactory): PromptStashImageVault {
  let opened: Promise<IDBDatabase> | null = null
  const database = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(VAULT_DB, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(VAULT_STORE)) request.result.createObjectStore(VAULT_STORE)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('The image store did not open.'))
    }).catch((error: unknown) => {
      opened = null
      throw error
    }))
  const run = <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void) =>
    database().then(
      (db) =>
        new Promise<T | undefined>((resolve, reject) => {
          const transaction = db.transaction(VAULT_STORE, mode)
          const request = work(transaction.objectStore(VAULT_STORE))
          transaction.oncomplete = () => resolve(request ? request.result : undefined)
          transaction.onerror = () => reject(transaction.error ?? new Error('The image store refused the change.'))
          transaction.onabort = () => reject(transaction.error ?? new Error('The image store refused the change.'))
        }),
    )
  return {
    put: async (key, value) => void (await run('readwrite', (store) => store.put(value, key))),
    get: async (key) => {
      const value = (await run<unknown>('readonly', (store) => store.get(key))) as Partial<ImageBytes> | undefined
      return value && typeof value.mediaType === 'string' && typeof value.dataBase64 === 'string'
        ? { mediaType: value.mediaType, dataBase64: value.dataBase64 }
        : null
    },
    remove: async (keys) => {
      if (keys.length === 0) return
      await run('readwrite', (store) => {
        for (const key of keys) store.delete(key)
      })
    },
    keys: async () =>
      ((await run<IDBValidKey[]>('readonly', (store) => store.getAllKeys())) ?? []).filter(
        (key): key is string => typeof key === 'string',
      ),
  }
}

let shared: PromptStash | undefined
/** The window's stash, over its localStorage and IndexedDB. */
export function promptStash(): PromptStash {
  if (shared) return shared
  const stash = createPromptStash({
    storage: window.localStorage,
    vault: typeof indexedDB === 'undefined' ? memoryImageVault() : indexedDbImageVault(indexedDB),
  })
  // Every window keeps the list in memory; one that stashes tells the others
  // through storage, so none writes back a list missing the other's entry.
  window.addEventListener('storage', (event) => {
    if (event.key === PROMPT_STASH_STORAGE_KEY) stash.reload()
  })
  return (shared = stash)
}
