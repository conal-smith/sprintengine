import type { WorkspaceSkill } from '../../../../../shared/electron-api'
import type { ConversationImageAttachment } from '../../../../../shared/conversation-runtime'
import type { AgentCli } from '../../../types/workspace'
import type { AgentComposerConnector, AgentComposerSelection } from './useAgentComposer'
import { indexedDbImageVault, memoryImageVault, type PromptStashImageVault } from '../../panels/agentChat/promptStash'

// The New chat door's drafts (new-chat-survives-back-and-forward,
// 2026-09-04, and the Drafts list after it). The panel is component state,
// and it unmounts whenever the person steps off it — Back, a sidebar click, a
// door — so everything typed and pasted into it died with it. This is the
// drafts' home outside the panel, written through by the panel as it changes
// and read back when the door reopens.
//
// Each window has one draft open, its door's. Pressing New chat again over a
// door with something in it keeps that draft and begins another, and the kept
// ones are listed in the sidebar's Drafts, where a click reopens one. They are
// kept across a reload: the words, files and picks in localStorage, the
// images' bytes in an IndexedDB store of their own (the stash's vault,
// `promptStash.ts`), both under a budget.
//
// What clears a draft: starting the chat, closing the panel on purpose (× /
// Escape), or deleting it from the list. Navigation never does — that is the
// whole point.

/** A pasted or dropped image, as the panel holds it: the attachment plus the temp path the agent opens. */
export type NewChatDraftImage = ConversationImageAttachment & { path: string }

/**
 * The engine a draft opens on, when the pick that made the draft happened
 * somewhere the remembered defaults were deliberately not written.
 *
 * That is exactly one caller today: a card's `Go` picker (item 2473, ruling
 * R4b). Choosing how to run ONE card must not move the engine of the person's
 * next unrelated New chat, so the picker writes nothing — and then the row it
 * chose has nowhere else to live on the paths that land in the composer instead
 * of spawning. It rides here, is applied as the composer's opening engine, and
 * is dropped the moment the person picks a row of their own.
 */
type NewChatDraftEngine = { cli: AgentCli; model: string | null; reasoning: string | null }

export type NewChatDraft = {
  /** The project the draft was scoped to; null for "no project picked". */
  folderPath: string | null
  prompt: string
  images: NewChatDraftImage[]
  /** Files attached by path, as their paths: the box's file cards. */
  files: string[]
  /** The engine row picked, or null to fall back to the host's remembered choice. */
  selection: AgentComposerSelection | null
  /** The cli/model/effort that row runs on, when the picker stored none. */
  engine: NewChatDraftEngine | null
  skills: WorkspaceSkill[]
  mcpServers: AgentComposerConnector[]
  /**
   * The Worktree chip as it was left: null off, '' on with a name made up at
   * start, anything else the name typed. Absent until the panel has written
   * it, which opens the chip as the door always opens it.
   */
  worktreeName?: string | null
}

const EMPTY_DRAFT: NewChatDraft = {
  folderPath: null,
  prompt: '',
  images: [],
  files: [],
  selection: null,
  engine: null,
  skills: [],
  mcpServers: [],
}

/** A kept draft as the Drafts list shows it. */
export type NewChatDraftEntry = { id: string; createdAt: number; draft: NewChatDraft }

type StoredDraft = Omit<NewChatDraft, 'images'> & {
  /** The images' details; their bytes are in the vault, under the draft's id and theirs. */
  images: Array<Omit<NewChatDraftImage, 'dataBase64'>>
}
type StoredState = {
  version: 1
  drafts: Array<{ id: string; createdAt: number; draft: StoredDraft }>
  current: Record<string, string>
}

type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>

export const NEW_CHAT_DRAFTS_STORAGE_KEY = 'sprintengine-new-chat-drafts'
const IMAGE_DB = 'sprintengine-new-chat-drafts'
/** Past this the oldest kept drafts go: a list nobody reads is not a list. */
export const MAX_NEW_CHAT_DRAFTS = 30
/** Every kept draft's words together; past it the oldest go, as above. */
const MAX_DRAFT_TEXT_CHARS = 400_000
/** Writes are gathered for this long: typing is a write per key. */
const PERSIST_DELAY_MS = 300

const entries = new Map<string, NewChatDraftEntry>()
/** Each window's draft: the one its New chat door shows. */
const current = new Map<string, string>()
/** The windows this renderer has opened a draft for; every other window's entry in storage is left as it is. */
const ownKeys = new Set<string>()
/** The draft each window had open when the drafts were last written, from storage. */
const resumable = new Map<string, string>()
const listeners = new Set<() => void>()
let listed: NewChatDraftEntry[] = []
let backend: { storage: DraftStorage | null; vault: PromptStashImageVault } | null = null
let persistTimer: ReturnType<typeof setTimeout> | null = null
let sequence = 0

function defaultBackend(): { storage: DraftStorage | null; vault: PromptStashImageVault } {
  const storage = typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  const vault = typeof indexedDB === 'undefined' ? memoryImageVault() : indexedDbImageVault(indexedDB, IMAGE_DB)
  return { storage, vault }
}

function ensureLoaded(): { storage: DraftStorage | null; vault: PromptStashImageVault } {
  if (backend) return backend
  backend = defaultBackend()
  load(backend)
  if (typeof window !== 'undefined') {
    // Another window that keeps or drops a draft tells this one through
    // storage; its own drafts stay as they are in memory.
    window.addEventListener('storage', (event) => {
      if (event.key === NEW_CHAT_DRAFTS_STORAGE_KEY && backend) {
        reloadOthers(backend)
      }
    })
  }
  return backend
}

function readStored(storage: DraftStorage | null): StoredState | null {
  try {
    const raw = storage?.getItem(NEW_CHAT_DRAFTS_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredState>
    if (parsed.version !== 1 || !Array.isArray(parsed.drafts)) return null
    return {
      version: 1,
      drafts: parsed.drafts.filter(
        (entry) =>
          typeof entry?.id === 'string' &&
          typeof entry.createdAt === 'number' &&
          typeof entry.draft?.prompt === 'string' &&
          Array.isArray(entry.draft.images) &&
          Array.isArray(entry.draft.files),
      ),
      current: typeof parsed.current === 'object' && parsed.current !== null ? parsed.current : {},
    }
  } catch {
    return null
  }
}

function fromStored(stored: StoredDraft): NewChatDraft {
  return {
    ...EMPTY_DRAFT,
    ...stored,
    skills: Array.isArray(stored.skills) ? stored.skills : [],
    mcpServers: Array.isArray(stored.mcpServers) ? stored.mcpServers : [],
    // Bytes follow from the vault; until they do an image is not shown.
    images: [],
  }
}

function load(from: { storage: DraftStorage | null; vault: PromptStashImageVault }): void {
  const stored = readStored(from.storage)
  if (!stored) return
  for (const entry of stored.drafts) {
    entries.set(entry.id, { id: entry.id, createdAt: entry.createdAt, draft: fromStored(entry.draft) })
    void restoreImages(from.vault, entry.id, entry.draft.images)
  }
  for (const [key, id] of Object.entries(stored.current))
    if (typeof id === 'string' && entries.has(id)) current.set(key, id)
  refreshList()
}

/** Takes in the drafts another window kept or dropped; the ones this window has open stay as they are here. */
function reloadOthers(from: { storage: DraftStorage | null; vault: PromptStashImageVault }): void {
  const stored = readStored(from.storage)
  if (!stored) return
  const mine = new Set(current.values())
  const seen = new Set<string>()
  for (const entry of stored.drafts) {
    seen.add(entry.id)
    // Another window's draft as it last wrote it; this one may hold an older copy.
    if (mine.has(entry.id)) continue
    const held = entries.get(entry.id)
    const sameImages =
      held !== undefined &&
      held.draft.images.map((image) => image.id).join() === entry.draft.images.map((image) => image.id).join()
    entries.set(entry.id, {
      id: entry.id,
      createdAt: entry.createdAt,
      draft: { ...fromStored(entry.draft), images: sameImages ? held.draft.images : [] },
    })
    if (!sameImages) void restoreImages(from.vault, entry.id, entry.draft.images)
  }
  for (const id of [...entries.keys()]) if (!seen.has(id) && !mine.has(id)) entries.delete(id)
  refreshList()
}

async function restoreImages(vault: PromptStashImageVault, id: string, images: StoredDraft['images']): Promise<void> {
  if (images.length === 0) return
  const restored: NewChatDraftImage[] = []
  for (const image of images) {
    const bytes = await vault.get(imageKey(id, image.id)).catch(() => null)
    if (bytes) restored.push({ ...image, mediaType: bytes.mediaType, dataBase64: bytes.dataBase64 })
  }
  const entry = entries.get(id)
  // A draft already written to since, in this window, keeps what it has now.
  if (!entry || entry.draft.images.length > 0) return
  entries.set(id, { ...entry, draft: { ...entry.draft, images: restored } })
  refreshList()
}

const imageKey = (draftId: string, imageId: string) => `${draftId}\u0000${imageId}`

function refreshList(): void {
  listed = [...entries.values()]
    .filter((entry) => newChatDraftHasContent(entry.draft))
    // By when each was begun, newest first: typing in one never moves it.
    .sort((a, b) => b.createdAt - a.createdAt)
  for (const listener of listeners) listener()
}

function schedulePersist(): void {
  if (persistTimer !== null) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    persist()
  }, PERSIST_DELAY_MS)
}

/** Writes the kept drafts now: the words to storage, the images to the vault. */
export function flushNewChatDrafts(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  persist()
}

function persist(): void {
  const { storage, vault } = ensureLoaded()
  // Newest first, within the budgets; the rest are let go here and everywhere.
  const kept: NewChatDraftEntry[] = []
  let chars = 0
  for (const entry of listed) {
    chars += entry.draft.prompt.length + entry.draft.files.join('').length
    if (kept.length >= MAX_NEW_CHAT_DRAFTS || chars > MAX_DRAFT_TEXT_CHARS) continue
    kept.push(entry)
  }
  const keptIds = new Set(kept.map((entry) => entry.id))
  const openIds = new Set(current.values())
  for (const id of [...entries.keys()]) if (!keptIds.has(id) && !openIds.has(id)) entries.delete(id)
  const state: StoredState = {
    version: 1,
    drafts: kept.map((entry) => ({
      id: entry.id,
      createdAt: entry.createdAt,
      draft: {
        ...entry.draft,
        images: entry.draft.images.map(({ dataBase64: _bytes, ...image }) => image),
      },
    })),
    current: Object.fromEntries(
      [...Object.entries(readStored(storage)?.current ?? {}).filter(([key]) => !ownKeys.has(key)), ...current].filter(
        ([, id]) => keptIds.has(id),
      ),
    ),
  }
  try {
    storage?.setItem(NEW_CHAT_DRAFTS_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Storage full: the drafts stay in this window's memory, as before.
  }
  void syncVault(vault, kept)
}

async function syncVault(vault: PromptStashImageVault, kept: NewChatDraftEntry[]): Promise<void> {
  const live = new Set<string>()
  try {
    for (const entry of kept) {
      for (const image of entry.draft.images) {
        const key = imageKey(entry.id, image.id)
        live.add(key)
        await vault.put(key, { mediaType: image.mediaType, dataBase64: image.dataBase64 })
      }
    }
    const stale = (await vault.keys()).filter((key) => !live.has(key))
    if (stale.length) await vault.remove(stale)
  } catch {
    // An image that did not land is lost on reload; the words are kept.
  }
}

/** A new draft's time, after every other's: two begun in one millisecond still list in order. */
function beginTime(): number {
  let latest = 0
  for (const entry of entries.values()) latest = Math.max(latest, entry.createdAt)
  return Math.max(Date.now(), latest + 1)
}

function newDraftId(): string {
  sequence += 1
  return `draft-${Date.now().toString(36)}-${sequence}-${Math.random().toString(36).slice(2, 8)}`
}

function changed(): void {
  refreshList()
  schedulePersist()
}

/** This window's draft id, taking back the one it had open before a reload. */
function adopt(key: string): string | undefined {
  ensureLoaded()
  if (!ownKeys.has(key)) {
    ownKeys.add(key)
    const id = resumable.get(key)
    if (id && entries.has(id) && !current.has(key)) current.set(key, id)
  }
  return current.get(key)
}

/** The parked draft for a window, or null when nothing is parked. */
export function readNewChatDraft(key: string): NewChatDraft | null {
  const id = adopt(key)
  return (id && entries.get(id)?.draft) || null
}

/** Merge a change into the window's draft, creating it from empty on first write. */
export function writeNewChatDraft(key: string, patch: Partial<NewChatDraft>): NewChatDraft {
  let id = adopt(key)
  let entry = id ? entries.get(id) : undefined
  if (!id || !entry) {
    id = newDraftId()
    entry = { id, createdAt: beginTime(), draft: EMPTY_DRAFT }
    current.set(key, id)
  }
  const next = { ...entry.draft, ...patch }
  entries.set(id, { ...entry, draft: next })
  changed()
  return next
}

/** Forget the draft: the chat started, or the person closed the panel on purpose. */
export function clearNewChatDraft(key: string): void {
  const id = adopt(key)
  current.delete(key)
  if (id) entries.delete(id)
  changed()
}

/**
 * Begin another draft in this window: the one it had is kept in the Drafts
 * list when it holds anything, and let go when it does not. The next write
 * starts the new one. Answers whether one was kept.
 */
export function startAnotherNewChatDraft(key: string): boolean {
  const id = adopt(key)
  current.delete(key)
  const entry = id ? entries.get(id) : undefined
  const kept = newChatDraftHasContent(entry?.draft ?? null)
  if (id && !kept) entries.delete(id)
  changed()
  return kept
}

/** Make a kept draft this window's, the one its New chat door opens on. False when it is gone. */
export function resumeNewChatDraft(key: string, id: string): boolean {
  adopt(key)
  if (!entries.has(id)) return false
  const previous = current.get(key)
  if (previous && previous !== id && !newChatDraftHasContent(entries.get(previous)?.draft ?? null))
    entries.delete(previous)
  current.set(key, id)
  changed()
  return true
}

/** The window's draft's id, or null when it has none. */
export function currentNewChatDraftId(key: string): string | null {
  return adopt(key) ?? null
}

/** Throw a kept draft away, from the Drafts list. A window showing it starts empty. */
export function deleteNewChatDraft(id: string): void {
  ensureLoaded()
  entries.delete(id)
  for (const [key, value] of [...current]) if (value === id) current.delete(key)
  changed()
}

/** The drafts worth listing, newest begun first. The same array until one changes. */
export function listNewChatDrafts(): NewChatDraftEntry[] {
  ensureLoaded()
  return listed
}

export function subscribeNewChatDrafts(listener: () => void): () => void {
  ensureLoaded()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** A draft's line in a list: its first words, or what it carries when it has none. */
export function newChatDraftTitle(draft: NewChatDraft): string {
  const words = draft.prompt.trim().split(/\r?\n/u)[0]?.trim() ?? ''
  if (words) return words.length > 80 ? `${words.slice(0, 79)}…` : words
  const images = draft.images.length
  const files = draft.files.length
  if (images) return images === 1 ? '1 image' : `${images} images`
  if (files) return files === 1 ? '1 file' : `${files} files`
  return 'Draft'
}

/**
 * Move a parked draft onto another project. Skills and MCP picks were installed
 * and synced into ONE project; carried into another they would launch the agent
 * somewhere they are not, so a change of project drops them (the same rule the
 * panel applies live). The prompt and images travel — they are the person's
 * words, not a project's configuration. A draft already on that project is
 * untouched, and no draft is minted for a window that has none.
 */
export function rescopeNewChatDraft(key: string, folderPath: string | null): NewChatDraft | null {
  const draft = readNewChatDraft(key)
  if (!draft) return null
  if (sameFolder(draft.folderPath, folderPath)) return draft
  return writeNewChatDraft(key, { folderPath, skills: [], mcpServers: [] })
}

/**
 * Whether the draft holds anything a person would miss: typed words, attached
 * images or files, or skills / MCP servers they picked. The engine row and the project
 * are not content — both default, and a draft that is nothing but defaults
 * must not pin them onto every New chat after it. The parked ENGINE is the same
 * kind of thing: it says how a chat would start, not that there is one to start.
 */
export function newChatDraftHasContent(draft: NewChatDraft | null): boolean {
  if (!draft) return false
  return (
    draft.prompt.trim().length > 0 ||
    draft.images.length > 0 ||
    draft.files.length > 0 ||
    draft.skills.length > 0 ||
    draft.mcpServers.length > 0
  )
}

/**
 * The connectors a reopened panel starts with: an explicit attachment (a
 * connector's own "New chat") leads, and the draft's picks follow, deduplicated
 * by id — reopening onto a connector never doubles a chip already parked.
 */
export function mergeDraftConnectors(
  explicit: AgentComposerConnector[] | null | undefined,
  parked: AgentComposerConnector[] | undefined,
): AgentComposerConnector[] {
  const merged: AgentComposerConnector[] = []
  const seen = new Set<string>()
  for (const connector of [...(explicit ?? []), ...(parked ?? [])]) {
    if (seen.has(connector.id)) continue
    seen.add(connector.id)
    merged.push(connector)
  }
  return merged
}

function sameFolder(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b
  return normalizeFolder(a) === normalizeFolder(b)
}

function normalizeFolder(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

/**
 * Test seam: forget every draft, and keep the next ones in `storage` and
 * `vault` (memory by default) instead of the window's.
 */
export function resetNewChatDraftsForTests(
  next: { storage?: DraftStorage | null; vault?: PromptStashImageVault } = {},
): void {
  if (persistTimer !== null) clearTimeout(persistTimer)
  persistTimer = null
  entries.clear()
  current.clear()
  ownKeys.clear()
  resumable.clear()
  listed = []
  backend = { storage: next.storage ?? null, vault: next.vault ?? memoryImageVault() }
  load(backend)
}
