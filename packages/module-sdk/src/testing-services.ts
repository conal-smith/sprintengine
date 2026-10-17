// Stateful fakes of the host services a module resolves, for
// `createFakeMainHost` (`@sprintengine/module-sdk/testing`).
//
// Each fake is the moduleId-first registry the app provides under the
// service's key, so the SDK's own helpers (`getModuleStorage(host)`,
// `getConversationService(host)`, …) run unchanged against it, and each
// applies the host's rules: the same key pattern, root rule and size cap for
// storage, the same `permission_missing` answers (or throws, where a call has
// no failure shape) for the permissions the host checks, the same ownership
// answers for chats. Each also returns a handle a test drives the world with
// (`conversations.emitEvent`, `github.respond`, …).
//
// SERVICE_FAKES below is keyed by service key. Adding a fake for a new host
// service is one entry there, one field on `FakeServices`, and its row in
// MODULE_SERVICE_REQUIREMENTS (services.ts).

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import type {
  BacklogItemLink,
  BacklogItemStatus,
  BacklogItemView,
  CompanionAgentEvent,
  CompanionAgentHandle,
  CompanionAgentSpec,
  CompanionAgentStatus,
  ModuleStorageChange,
  ModuleStorageResult,
  ModuleWorkspaceGitInfoResult,
  ModuleWorkspaceGitRemote,
  ModuleWorkspaceListEntry,
  ModuleWorkspaceListOptions,
  ModuleWorkspaceView,
  ScheduledAgentDraft,
  ScheduledAgentLastRun,
  ScheduledAgentRun,
  ScheduledAgentView,
  ScheduledAgentWriteResult,
  WorkspaceCreateInput,
  WorkspaceCreateResult,
} from './index.js'
import type {
  ActivityChatSummary,
  ActivityListChatsInput,
  ActivityPrompt,
  ActivityPromptsInput,
  UsageGroupBy,
  UsageQuery,
  UsageQueryResult,
  UsageRow,
  UsageSource,
  UsageTokens,
} from './activity.js'
import type {
  BacklogWatchError,
  ModuleBacklogCreateInput,
  ModuleBacklogLinkInput,
  ModuleBacklogLocation,
  ModuleBacklogResult,
  ModuleBacklogTriageInput,
} from './backlog.js'
import type {
  ModuleConversationCreateInput,
  ModuleConversationEvent,
  ModuleConversationErrorCode,
  ModuleConversationEventType,
  ModuleConversationPermissionPreset,
  ModuleConversationRef,
  ModuleConversationStatus,
  ModuleConversationStreamFrame,
  ModuleConversationSummary,
  ModuleConversationTurnUsage,
  ModuleTextGenerationErrorCode,
  ModuleTextGenerationInput,
  ModuleTextGenerationResult,
} from './conversation.js'
import type {
  ModuleGitHubDownloadRequest,
  ModuleGitHubDownloadResponse,
  ModuleGitHubMediaType,
  ModuleGitHubRequest,
  ModuleGitHubResponse,
  ModuleSecretFetchInit,
  ModuleSecretFetchResult,
  ModuleSecretsError,
} from './brokers.js'

/** What every service fake is built with. */
export type FakeServiceContext = {
  readonly moduleId: string
  /** The module's declared permissions. Live: a test may add or remove one mid-test. */
  readonly permissions: Set<string>
  /** The fake clock (epoch ms). */
  now(): number
  /** The workspaces every fake resolves ids and roots against. */
  readonly workspaces: FakeWorkspaces
  /** What `MainHost.getModuleDataDir` answers. Absent: a fresh temporary folder, made on first use. */
  readonly dataDir?: string
  /**
   * Another fake's handle, for a fake whose work lands in another's state (a
   * scheduled run starts a chat the conversations fake holds). Absent where
   * a fake is made alone.
   */
  peer?<K extends keyof FakeServices>(name: K): FakeServices[K] | undefined
}

type Failure<C extends string> = { ok: false; code: C; message: string }
const failure = <C extends string>(code: C, message: string): Failure<C> => ({ ok: false, code, message })

// ── Workspaces ───────────────────────────────────────────────────────────────

/**
 * What `getWorkspaceGitInfo` answers for a workspace with a folder: its
 * branch (null when detached) and remotes, or one of the failures git itself
 * can produce. (`permission_missing`, `unknown_workspace` and `no_folder` the
 * fake answers on its own.)
 */
export type FakeWorkspaceGitInfo =
  | { branch: string | null; remotes: ModuleWorkspaceGitRemote[] }
  | { code: 'not_a_repository' | 'unavailable' | 'git_failed'; message?: string }

/** The workspaces the host knows about: `WorkspaceContextToken`, `WorkspaceServiceToken`, and every id a fake checks. */
export type FakeWorkspaces = {
  /** Every open workspace, hydrated or not. */
  all(): ModuleWorkspaceView[]
  /** Open a workspace (one closed earlier leaves the history). */
  add(workspace: ModuleWorkspaceView): void
  /** Forget a workspace outright: not open, and not in the closed history either. */
  remove(id: string): void
  /**
   * Close a workspace, as the person would: it leaves the open list and is
   * listed by `list({ includeClosed: true })`, newest first, with `open: false`
   * and `closedAt` (the fake clock, or `closedAt` when given).
   */
  close(id: string, closedAt?: number): void
  /** The closed history, newest first, as `list({ includeClosed: true })` appends it. */
  closed(): ModuleWorkspaceListEntry[]
  /**
   * While false, `get` answers null and `list` answers no open workspace — the
   * host right after launch, before workspace state re-hydrates. Code that
   * treats null as "deleted" fails a test that toggles this.
   */
  setHydrated(hydrated: boolean): void
  /**
   * Script `getWorkspaceGitInfo` (main and renderer) for a workspace. A
   * workspace with a folder and nothing scripted answers `not_a_repository`.
   */
  setGitInfo(workspaceId: string, info: FakeWorkspaceGitInfo): void
  /** The workspaces `WorkspaceServiceToken.create` made, in order. */
  readonly created: WorkspaceCreateInput[]
}

export function createFakeWorkspaces(
  initial: readonly ModuleWorkspaceView[],
  now: () => number = Date.now,
): FakeWorkspaces & {
  find(id: string): ModuleWorkspaceView | undefined
  hydrated(): boolean
  gitInfo(workspaceId: string): ModuleWorkspaceGitInfoResult
} {
  const list = initial.map((workspace) => ({ ...workspace }))
  const closedList: ModuleWorkspaceListEntry[] = []
  const gitInfo = new Map<string, FakeWorkspaceGitInfo>()
  const created: WorkspaceCreateInput[] = []
  let hydrated = true
  const forgetClosed = (id: string): void => {
    const index = closedList.findIndex((entry) => entry.id === id)
    if (index !== -1) closedList.splice(index, 1)
  }
  const removeOpen = (id: string): ModuleWorkspaceView | undefined => {
    const index = list.findIndex((existing) => existing.id === id)
    return index === -1 ? undefined : list.splice(index, 1)[0]
  }
  return {
    all: () => list.map((workspace) => ({ ...workspace })),
    add(workspace) {
      forgetClosed(workspace.id)
      const index = list.findIndex((existing) => existing.id === workspace.id)
      if (index === -1) list.push({ ...workspace })
      else list[index] = { ...workspace }
    },
    remove(id) {
      removeOpen(id)
      forgetClosed(id)
    },
    close(id, closedAt) {
      const workspace = removeOpen(id)
      if (!workspace) throw new Error(`No open workspace "${id}" to close.`)
      forgetClosed(id)
      closedList.push({ ...workspace, open: false, closedAt: closedAt ?? now() })
      closedList.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    },
    closed: () => closedList.map((entry) => ({ ...entry })),
    setHydrated(next) {
      hydrated = next
    },
    setGitInfo(workspaceId, info) {
      gitInfo.set(workspaceId, structuredClone(info))
    },
    created,
    find: (id) => list.find((workspace) => workspace.id === id),
    hydrated: () => hydrated,
    gitInfo(workspaceId) {
      const workspace = list.find((entry) => entry.id === workspaceId)
      if (!workspace) return failure('unknown_workspace', `No open workspace "${workspaceId}".`)
      if (!workspace.folderPath) return failure('no_folder', 'The workspace has no folder.')
      const scripted = gitInfo.get(workspaceId)
      if (!scripted) return failure('not_a_repository', `${workspace.folderPath} is not in a git repository.`)
      if ('code' in scripted) {
        return failure(scripted.code, scripted.message ?? `The fake host answered "${scripted.code}".`)
      }
      return { ok: true, branch: scripted.branch, remotes: structuredClone(scripted.remotes) }
    },
  }
}

type InternalWorkspaces = ReturnType<typeof createFakeWorkspaces>

function workspaceContextRegistry(workspaces: InternalWorkspaces) {
  return {
    async get(workspaceId: string): Promise<ModuleWorkspaceView | null> {
      if (!workspaces.hydrated()) return null
      const found = workspaces.find(workspaceId)
      return found ? { ...found } : null
    },
    async list(options?: ModuleWorkspaceListOptions): Promise<ModuleWorkspaceListEntry[]> {
      const open = workspaces.hydrated() ? workspaces.all().map((view) => ({ ...view, open: true })) : []
      if (options?.includeClosed !== true) return open
      const openIds = new Set(open.map((entry) => entry.id))
      return [...open, ...workspaces.closed().filter((entry) => !openIds.has(entry.id))]
    },
  }
}

function workspaceServiceRegistry(workspaces: InternalWorkspaces) {
  let next = 1
  return {
    async create(input: WorkspaceCreateInput): Promise<WorkspaceCreateResult> {
      if (input.folderPath !== undefined && !isAbsolute(input.folderPath)) {
        return failure('invalid_input', 'folderPath must be an absolute path.')
      }
      workspaces.created.push({ ...input })
      const workspaceId = `ws-created-${next++}`
      workspaces.add({
        id: workspaceId,
        name: input.name ?? 'Workspace',
        folderPath: input.folderPath ?? null,
        mode: input.templateId ?? 'standard',
      })
      return { ok: true, workspaceId }
    },
  }
}

// ── Storage ──────────────────────────────────────────────────────────────────

/** The module's storage: every scope's values, as the host would have written them. */
export type FakeStorage = {
  /** The stored value (a fresh copy), or undefined. `workspaceRoot` absent reads the global store. */
  peek(key: string, workspaceRoot?: string): unknown
  /** Every key in a scope, sorted. */
  keys(workspaceRoot?: string): string[]
  /** Write a value as if an earlier run had stored it. `watch` listeners hear nothing. */
  seed(key: string, value: unknown, workspaceRoot?: string): void
  /**
   * Change a value by other means — a `git pull` into the workspace, a
   * teammate's commit, a hand edit — as the host's poll would find it: the
   * value is written (deleted for `undefined`) and `watch` listeners of the
   * scope hear `{ keys: [key] }`.
   */
  changeExternally(key: string, value: unknown, workspaceRoot?: string): void
  /** The directory `getModuleDataDir` handed out, or null before the module asked for one. */
  dataDir(): string | null
  /** Every call, in order: `['set', key, workspaceRoot]` (`key` is null for `list`, `getMany` and `watch`). */
  readonly calls: Array<
    [method: 'get' | 'getMany' | 'set' | 'delete' | 'list' | 'watch', key: string | null, workspaceRoot: string | null]
  >
}

// The host's own rules (module-storage.ts in the app): keys are file names.
const STORAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const WINDOWS_RESERVED_KEY = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/
/** The host's cap on one stored value, in bytes of JSON. */
export const MODULE_STORAGE_VALUE_LIMIT_BYTES = 1024 * 1024
/** The most keys one `getMany` reads. */
const MODULE_STORAGE_GET_MANY_LIMIT = 1000
// A module id the host refuses as a folder name.
const UNSAFE_SEGMENT = /[\\/]|^\.\.?$/

type StorageCode = 'invalid_key' | 'invalid_value' | 'value_too_large' | 'invalid_workspace_root' | 'io_error'

function storageRegistry(context: FakeServiceContext): { registry: object; handle: FakeStorage } {
  const scopes = new Map<string, Map<string, string>>()
  const watchers = new Map<string, Set<(change: ModuleStorageChange) => void>>()
  const calls: FakeStorage['calls'] = []
  let dataDir: string | null = null
  const GLOBAL = '\u0000global'
  const scope = (root: string | undefined): Map<string, string> => {
    const id = root ?? GLOBAL
    let store = scopes.get(id)
    if (!store) scopes.set(id, (store = new Map()))
    return store
  }
  // Heard at once by every watcher of the scope, as the host hears its own writes.
  const announce = (root: string | undefined, key: string): void => {
    for (const listener of [...(watchers.get(root ?? GLOBAL) ?? [])]) listener({ keys: [key] })
  }
  const keyIssue = (key: unknown): Failure<StorageCode> | null => {
    if (typeof key !== 'string' || !STORAGE_KEY_PATTERN.test(key)) {
      return failure(
        'invalid_key',
        `Key "${String(key)}" is invalid — keys match ${STORAGE_KEY_PATTERN} (lowercase alphanumerics, dot, dash, underscore; max 64 chars).`,
      )
    }
    if (WINDOWS_RESERVED_KEY.test(key)) {
      return failure('invalid_key', `Key "${key}" is a reserved device name on Windows and cannot be used.`)
    }
    return null
  }
  const rootIssue = (root: unknown): Failure<StorageCode> | null =>
    root !== undefined && (typeof root !== 'string' || !isAbsolute(root))
      ? failure(
          'invalid_workspace_root',
          'workspaceRoot must be an absolute path (resolve it via the workspace context).',
        )
      : null
  type Scoped = { key: string; workspaceRoot?: string }

  const registry = {
    async get(_moduleId: string, input: Scoped): Promise<ModuleStorageResult<{ value: unknown; found: boolean }>> {
      calls.push(['get', input?.key ?? null, input?.workspaceRoot ?? null])
      const issue = keyIssue(input?.key) ?? rootIssue(input?.workspaceRoot)
      if (issue) return issue
      const text = scope(input.workspaceRoot).get(input.key)
      return text === undefined
        ? { ok: true, value: undefined, found: false }
        : { ok: true, value: JSON.parse(text) as unknown, found: true }
    },
    async set(_moduleId: string, input: Scoped & { value: unknown }): Promise<ModuleStorageResult<object>> {
      calls.push(['set', input?.key ?? null, input?.workspaceRoot ?? null])
      const issue = keyIssue(input?.key) ?? rootIssue(input?.workspaceRoot)
      if (issue) return issue
      let text: string | undefined
      try {
        text = JSON.stringify(input.value)
      } catch (error) {
        return failure('invalid_value', error instanceof Error ? error.message : String(error))
      }
      if (text === undefined) return failure('invalid_value', 'Value must be JSON-serializable (undefined is not).')
      if (Buffer.byteLength(text, 'utf8') > MODULE_STORAGE_VALUE_LIMIT_BYTES) {
        return failure('value_too_large', `Value exceeds the ${MODULE_STORAGE_VALUE_LIMIT_BYTES / 1024 / 1024} MB cap.`)
      }
      scope(input.workspaceRoot).set(input.key, text)
      announce(input.workspaceRoot, input.key)
      return { ok: true }
    },
    async delete(_moduleId: string, input: Scoped): Promise<ModuleStorageResult<{ deleted: boolean }>> {
      calls.push(['delete', input?.key ?? null, input?.workspaceRoot ?? null])
      const issue = keyIssue(input?.key) ?? rootIssue(input?.workspaceRoot)
      if (issue) return issue
      const deleted = scope(input.workspaceRoot).delete(input.key)
      // Deleting a key that was never set changes nothing, so nothing is heard.
      if (deleted) announce(input.workspaceRoot, input.key)
      return { ok: true, deleted }
    },
    async list(
      _moduleId: string,
      input?: { workspaceRoot?: string; prefix?: string },
    ): Promise<ModuleStorageResult<{ keys: string[] }>> {
      calls.push(['list', null, input?.workspaceRoot ?? null])
      const issue = rootIssue(input?.workspaceRoot)
      if (issue) return issue
      const prefix = input?.prefix
      if (prefix !== undefined && typeof prefix !== 'string') return failure('invalid_key', 'prefix must be a string.')
      const keys = [...scope(input?.workspaceRoot).keys()].filter(
        (key) => prefix === undefined || key.startsWith(prefix),
      )
      return { ok: true, keys: keys.sort() }
    },
    async getMany(
      _moduleId: string,
      input: { keys: string[]; workspaceRoot?: string },
    ): Promise<ModuleStorageResult<{ values: Record<string, unknown> }>> {
      calls.push(['getMany', null, input?.workspaceRoot ?? null])
      const keys = (input as { keys?: unknown } | undefined)?.keys
      if (!Array.isArray(keys)) return failure('invalid_key', 'getMany takes { keys: string[] }.')
      if (keys.length > MODULE_STORAGE_GET_MANY_LIMIT) {
        return failure('invalid_key', `getMany reads at most ${MODULE_STORAGE_GET_MANY_LIMIT} keys at once.`)
      }
      for (const key of keys) {
        const issue =
          typeof key === 'string' ? keyIssue(key) : failure<StorageCode>('invalid_key', 'Every key must be a string.')
        if (issue) return issue
      }
      const rootProblem = rootIssue(input.workspaceRoot)
      if (rootProblem) return rootProblem
      const store = scope(input.workspaceRoot)
      const values: Record<string, unknown> = {}
      for (const key of new Set(keys as string[])) {
        const text = store.get(key)
        if (text !== undefined) values[key] = JSON.parse(text) as unknown
      }
      return { ok: true, values }
    },
    watch(
      _moduleId: string,
      input: { workspaceRoot?: string } | undefined,
      listener: (change: ModuleStorageChange) => void,
    ): () => void {
      calls.push(['watch', null, input?.workspaceRoot ?? null])
      if (typeof listener !== 'function') throw new Error('watch needs a listener function.')
      const issue = rootIssue(input?.workspaceRoot)
      if (issue) throw new Error(issue.message)
      const id = input?.workspaceRoot ?? GLOBAL
      let set = watchers.get(id)
      if (!set) watchers.set(id, (set = new Set()))
      set.add(listener)
      return () => {
        set.delete(listener)
      }
    },
    // What `MainHost.getModuleDataDir` reads, as the host's storage service provides it.
    dataDir(moduleId: string): string {
      if (UNSAFE_SEGMENT.test(moduleId) || moduleId.trim().length === 0) {
        throw new Error(`Module id "${moduleId}" is not usable as a data folder.`)
      }
      if (dataDir === null) {
        dataDir = context.dataDir ?? join(mkdtempSync(join(tmpdir(), 'sprintengine-module-data-')), moduleId)
        mkdirSync(dataDir, { recursive: true })
      }
      return dataDir
    },
  }
  const handle: FakeStorage = {
    peek(key, workspaceRoot) {
      const text = scope(workspaceRoot).get(key)
      return text === undefined ? undefined : (JSON.parse(text) as unknown)
    },
    keys: (workspaceRoot) => [...scope(workspaceRoot).keys()].sort(),
    seed(key, value, workspaceRoot) {
      scope(workspaceRoot).set(key, JSON.stringify(value))
    },
    changeExternally(key, value, workspaceRoot) {
      if (value === undefined) scope(workspaceRoot).delete(key)
      else scope(workspaceRoot).set(key, JSON.stringify(value))
      announce(workspaceRoot, key)
    },
    dataDir: () => dataDir,
    calls,
  }
  return { registry, handle }
}

// ── Conversations ────────────────────────────────────────────────────────────

/** What a test passes to `emitEvent`: the event's own parts; identity, order and time are filled in. */
export type FakeConversationEventInput = {
  type: ModuleConversationEventType
  payload?: Record<string, unknown>
}

/** One chat the module started, as the fake holds it. */
export type FakeConversationRecord = {
  summary: ModuleConversationSummary
  /** What `create` was asked (for a restored or scheduled-run chat, what it was made with). */
  input: ModuleConversationCreateInput
  /** Every event so far: the transcript. */
  events: ModuleConversationEvent[]
  /** Messages sent with `send`, in order (the opening prompt is the first `user_message` event). */
  sent: string[]
  /** Approval and question answers, in order. */
  answers: Array<{ requestId: string; method: string; input: unknown }>
  interrupted: number
  stopped: boolean
}

/** A chat the module started in an earlier run (or a scheduled run started for it), for `restore`. */
export type FakeRestoredConversation = ModuleConversationRef &
  Partial<Omit<ModuleConversationSummary, 'workspaceId' | 'agentId'>> & {
    /** Its transcript so far, by type and payload. */
    events?: FakeConversationEventInput[]
  }

/** The module's chats, and the levers that make an agent say something. */
export type FakeConversations = {
  all(): FakeConversationRecord[]
  get(ref: ModuleConversationRef): FakeConversationRecord | undefined
  /**
   * Append an event to a chat's transcript and deliver it to every
   * `subscribe` and `follow`, as the runtime would. Status follows the event:
   * `turn_started` → active, `approval_requested` → awaiting_approval,
   * `turn_completed`/`turn_failed` → ready, `session_closed` → stopped.
   * `turn_started`, `content_delta` and `turn_completed` without a `turnId`
   * get the current turn's, so `reply` finds them; give `turn_completed` a
   * `text` (the agent's last message) and `usage` as the host records them.
   */
  emitEvent(ref: ModuleConversationRef, event: FakeConversationEventInput): ModuleConversationEvent
  /** Put a chat in a status directly, notifying watchers. */
  setStatus(ref: ModuleConversationRef, status: ModuleConversationStatus | 'absent'): void
  /**
   * Make a chat of the module's known, as the host finds a saved chat once its
   * workspace loads after launch: a `subscribe` or `follow` already attached
   * to its ref hears it from now (a follow gets its snapshot then). Scheduled
   * runs use this to hand the module their chats.
   */
  restore(chat: FakeRestoredConversation): FakeConversationRecord
  /**
   * Add a chat the module does NOT own (the person's own, or another
   * module's), to check that the module cannot reach it.
   */
  addForeign(ref: ModuleConversationRef): void
  /** Make the next `create` fail with this code, once. */
  failNextCreate(code: ModuleConversationErrorCode, message?: string): void
}

const PRESET_ORDER: ModuleConversationPermissionPreset[] = ['manual', 'none', 'auto', 'bypass']
const MAX_WORKTREE_NAME_CHARS = 80

/** The conversation provider behind a chat runtime id, as the host maps them. */
function providerForCli(cli: string): string {
  return cli === 'claude-code' || cli === 'claude' ? 'claude-agent' : cli === 'codex' ? 'codex-agent' : cli
}

function conversationsRegistry(context: FakeServiceContext): { registry: object; handle: FakeConversations } {
  const workspaces = context.workspaces as InternalWorkspaces
  const records = new Map<string, FakeConversationRecord>()
  const foreign = new Set<string>()
  const subscribers = new Map<string, Set<(event: ModuleConversationEvent) => void>>()
  const followers = new Map<string, Set<(frame: ModuleConversationStreamFrame) => void>>()
  // Follows of a chat the host does not know yet: they get their snapshot when it does.
  const pendingFollows = new Map<
    string,
    Set<{ after?: number; onFrame: (frame: ModuleConversationStreamFrame) => void }>
  >()
  const watchers = new Set<{ filter?: { workspaceId?: string }; cb: (list: ModuleConversationSummary[]) => void }>()
  const receipts = new Map<string, unknown>()
  const currentTurn = new Map<string, string>()
  let nextAgent = 1
  let nextEvent = 1
  let nextTurn = 1
  let nextWorktree = 1
  let pendingFailure: Failure<string> | null = null

  const refKey = (ref: ModuleConversationRef): string => `${ref?.workspaceId}\u0000${ref?.agentId}`
  const canOperate = (): boolean => context.permissions.has('conversation:operate')
  const canRead = (): boolean => canOperate() || context.permissions.has('conversation:read')
  const missing = (permission: string) =>
    failure('permission_missing', `Module "${context.moduleId}" must declare the "${permission}" permission.`)
  const notOwned = (ref: ModuleConversationRef) =>
    failure(
      'not_owned',
      `No conversation "${ref?.agentId}" in workspace "${ref?.workspaceId}" was started by this module.`,
    )
  const requireRead = (): void => {
    if (!canRead()) throw new Error(missing('conversation:read').message)
  }
  // A ref is a mistake in the call when it does not name a workspace and an agent.
  const requireRef = (ref: ModuleConversationRef): void => {
    if (
      typeof ref?.workspaceId !== 'string' ||
      !ref.workspaceId.trim() ||
      typeof ref.agentId !== 'string' ||
      !ref.agentId.trim()
    ) {
      throw new Error('A conversation ref needs a workspaceId and an agentId.')
    }
  }
  const owned = (ref: ModuleConversationRef): FakeConversationRecord | undefined => records.get(refKey(ref))
  const list = (filter?: { workspaceId?: string }): ModuleConversationSummary[] =>
    [...records.values()]
      .filter((record) => !filter?.workspaceId || record.summary.workspaceId === filter.workspaceId)
      .map((record) => ({ ...record.summary }))
  const notifyWatchers = (): void => {
    for (const watcher of watchers) watcher.cb(list(watcher.filter))
  }
  // The module's ceiling: `auto`, or `bypass` with `conversation:bypass`.
  const capped = (preset: ModuleConversationPermissionPreset | undefined) => {
    if (preset === undefined) return undefined
    const ceiling: ModuleConversationPermissionPreset = context.permissions.has('conversation:bypass')
      ? 'bypass'
      : 'auto'
    return PRESET_ORDER.indexOf(preset) > PRESET_ORDER.indexOf(ceiling) ? ceiling : preset
  }
  // A retried command with the same id answers the first result.
  const once = async <T>(commandId: string | undefined, run: () => Promise<T>): Promise<T> => {
    if (commandId === undefined) return run()
    const key = `${context.moduleId}:${commandId}`
    if (receipts.has(key)) return receipts.get(key) as T
    const result = await run()
    receipts.set(key, result)
    return result
  }
  const STATUS_AFTER: Partial<Record<ModuleConversationEventType, ModuleConversationStatus>> = {
    session_ready: 'ready',
    turn_started: 'active',
    approval_requested: 'awaiting_approval',
    approval_resolved: 'active',
    turn_completed: 'ready',
    turn_failed: 'ready',
    session_closed: 'stopped',
  }

  // The turn an event belongs to, as the runtime stamps it.
  function turnPayload(key: string, input: FakeConversationEventInput): Record<string, unknown> | undefined {
    const payload = input.payload ? structuredClone(input.payload) : undefined
    if (input.type !== 'turn_started' && input.type !== 'content_delta' && input.type !== 'turn_completed') {
      return payload
    }
    if (typeof payload?.turnId === 'string') {
      if (input.type === 'turn_started') currentTurn.set(key, payload.turnId)
      if (input.type === 'turn_completed') currentTurn.delete(key)
      return payload
    }
    let turnId = currentTurn.get(key)
    if (input.type === 'turn_started' || !turnId) {
      turnId = `turn-${nextTurn++}`
      currentTurn.set(key, turnId)
    }
    if (input.type === 'turn_completed') currentTurn.delete(key)
    return { ...payload, turnId }
  }

  function emit(record: FakeConversationRecord, input: FakeConversationEventInput): ModuleConversationEvent {
    const key = refKey(record.summary)
    const payload = turnPayload(key, input)
    const event: ModuleConversationEvent = {
      id: `event-${nextEvent++}`,
      seq: record.events.length + 1,
      sessionId: record.summary.sessionId ?? `session-${record.summary.agentId}`,
      workspaceId: record.summary.workspaceId,
      agentId: record.summary.agentId,
      providerId: record.summary.providerId,
      modelId: record.summary.modelId,
      type: input.type,
      createdAt: context.now(),
      ...(payload ? { payload } : {}),
    }
    record.events.push(event)
    const status = STATUS_AFTER[input.type]
    for (const cb of subscribers.get(key) ?? []) cb(structuredClone(event))
    for (const onFrame of followers.get(key) ?? []) onFrame({ type: 'event', event: structuredClone(event) })
    if (status && status !== record.summary.status) {
      record.summary.status = status
      notifyWatchers()
    }
    return event
  }

  // A follow's first frames: a snapshot (or what came after its cursor), then the fence.
  function startFollow(
    record: FakeConversationRecord,
    after: number | undefined,
    onFrame: (frame: ModuleConversationStreamFrame) => void,
  ): void {
    const generation = `fake-${record.summary.agentId}`
    if (after !== undefined && after <= record.events.length) {
      for (const event of record.events.slice(after)) onFrame({ type: 'event', event: structuredClone(event) })
    } else {
      onFrame({
        type: 'snapshot',
        page: { events: structuredClone(record.events), hasMore: false, beforeCursor: record.events.length ? 1 : null },
        reset: true,
        generation,
      })
    }
    onFrame({ type: 'synchronized', seq: record.events.length, generation })
    const key = refKey(record.summary)
    let set = followers.get(key)
    if (!set) followers.set(key, (set = new Set()))
    set.add(onFrame)
  }

  // A chat becomes the module's: list it, and hand it to whoever was waiting for it.
  function adopt(record: FakeConversationRecord): void {
    const key = refKey(record.summary)
    records.set(key, record)
    const waiting = pendingFollows.get(key)
    pendingFollows.delete(key)
    for (const follow of waiting ?? []) startFollow(record, follow.after, follow.onFrame)
    notifyWatchers()
  }

  // Every operating call: the permission, then ownership, then the command
  // receipt. (The registry is loosely typed; the SDK helper types the answers.)
  const operate = async (
    ref: ModuleConversationRef,
    commandId: string | undefined,
    run: (record: FakeConversationRecord) => object,
  ): Promise<object> => {
    if (!canOperate()) return missing('conversation:operate')
    const record = owned(ref)
    if (!record) return notOwned(ref)
    return once(commandId, async () => run(record))
  }

  // A fresh worktree of the project, in a workspace of its own, as the host
  // cuts one: only for a project the fake knows as a git repository.
  function worktreeOf(
    workspace: ModuleWorkspaceView,
    name: string | undefined,
  ): ModuleWorkspaceView | Failure<'worktree_unavailable'> {
    const git = workspaces.gitInfo(workspace.id)
    if (!git.ok) {
      return failure(
        'worktree_unavailable',
        `Workspace "${workspace.id}" is not a git repository (script one with services.workspaces.setGitInfo).`,
      )
    }
    const suffix = `w${nextWorktree++}`
    const slug =
      (name ?? 'chat')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'chat'
    const branch = `agent/${slug}-${suffix}`
    const created: ModuleWorkspaceView = {
      id: `ws-worktree-${suffix}`,
      name: name ?? `${workspace.name} (${branch})`,
      folderPath: `${workspace.folderPath}-worktrees/${slug}-${suffix}`,
      mode: workspace.mode,
    }
    workspaces.add(created)
    workspaces.setGitInfo(created.id, { branch, remotes: git.remotes })
    return created
  }

  const registry = {
    async create(_moduleId: string, input: ModuleConversationCreateInput) {
      if (!canOperate()) return missing('conversation:operate')
      if (typeof input !== 'object' || input === null) return failure('invalid_input', 'create takes an object.')
      return once(input.commandId, async () => {
        if (typeof input.workspaceId !== 'string' || !input.workspaceId.trim()) {
          return failure('invalid_input', '"workspaceId" is required.')
        }
        if (input.allowedTools?.length && !context.permissions.has('conversation:bypass')) {
          return failure(
            'permission_missing',
            `Module "${context.moduleId}" must declare "conversation:bypass" to let a chat use tools without asking.`,
          )
        }
        const worktree = input.worktree
        if (
          worktree !== undefined &&
          (typeof worktree !== 'object' ||
            worktree === null ||
            (worktree.name !== undefined &&
              (typeof worktree.name !== 'string' || worktree.name.length > MAX_WORKTREE_NAME_CHARS)))
        ) {
          return failure(
            'invalid_input',
            `"worktree" takes an optional "name" of at most ${MAX_WORKTREE_NAME_CHARS} characters.`,
          )
        }
        if (pendingFailure) {
          const planned = pendingFailure
          pendingFailure = null
          return planned
        }
        const checkout = workspaces.find(input.workspaceId)
        if (!checkout) return failure('unknown_workspace', `No workspace "${input.workspaceId}".`)
        if (!checkout.folderPath) {
          return failure('workspace_folder_missing', `Workspace "${input.workspaceId}" has no project folder.`)
        }
        const workspace = worktree ? worktreeOf(checkout, worktree.name?.trim() || undefined) : checkout
        if ('ok' in workspace) return workspace
        const agentId = `agent-${nextAgent++}`
        const preset = capped(input.permissionPreset)
        const cli = input.cli ?? 'claude-code'
        const record: FakeConversationRecord = {
          summary: {
            workspaceId: workspace.id,
            agentId,
            sessionId: `session-${agentId}`,
            name: input.name ?? `Chat ${agentId}`,
            cli,
            providerId: providerForCli(cli),
            modelId: input.model ?? 'default',
            status: 'starting',
            ...(preset ? { permissionPreset: preset } : {}),
            ...(preset && preset === input.permissionPreset && input.permissionMode
              ? { permissionMode: input.permissionMode }
              : {}),
          },
          input: structuredClone(input),
          events: [],
          sent: [],
          answers: [],
          interrupted: 0,
          stopped: false,
        }
        adopt(record)
        emit(record, { type: 'session_started' })
        if (input.prompt) emit(record, { type: 'user_message', payload: { text: input.prompt } })
        return { ok: true as const, conversation: { ...record.summary } }
      })
    },
    send: (_m: string, ref: ModuleConversationRef, input: { message: string; commandId?: string }) =>
      operate(ref, input?.commandId, (record) => {
        if (typeof input?.message !== 'string' || !input.message.trim()) {
          return failure('invalid_input', '"message" is required.')
        }
        record.sent.push(input.message)
        emit(record, { type: 'user_message', payload: { text: input.message } })
        return { ok: true }
      }),
    interrupt: (_m: string, ref: ModuleConversationRef, options?: { commandId?: string }) =>
      operate(ref, options?.commandId, (record) => {
        record.interrupted += 1
        return { ok: true }
      }),
    respondToApproval: (_m: string, ref: ModuleConversationRef, input: { requestId: string; commandId?: string }) =>
      operate(ref, input?.commandId, (record) => {
        record.answers.push({ requestId: input.requestId, method: 'respondToApproval', input: structuredClone(input) })
        return { ok: true }
      }),
    answerQuestion: (_m: string, ref: ModuleConversationRef, input: { requestId: string; commandId?: string }) =>
      operate(ref, input?.commandId, (record) => {
        record.answers.push({ requestId: input.requestId, method: 'answerQuestion', input: structuredClone(input) })
        return { ok: true }
      }),
    resolvePlan: (_m: string, ref: ModuleConversationRef, input: { requestId: string; commandId?: string }) =>
      operate(ref, input?.commandId, (record) => {
        record.answers.push({ requestId: input.requestId, method: 'resolvePlan', input: structuredClone(input) })
        return { ok: true }
      }),
    setPermissionPreset: (
      _m: string,
      ref: ModuleConversationRef,
      preset: ModuleConversationPermissionPreset,
      options?: { commandId?: string; permissionMode?: string },
    ) =>
      operate(ref, options?.commandId, (record) => {
        if (!PRESET_ORDER.includes(preset)) {
          return failure('invalid_input', '"permissionPreset" must be "none", "manual", "auto" or "bypass".')
        }
        const inForce = capped(preset) ?? preset
        record.summary.permissionPreset = inForce
        if (inForce === preset && options?.permissionMode) record.summary.permissionMode = options.permissionMode
        else delete record.summary.permissionMode
        notifyWatchers()
        return {
          ok: true,
          permissionPreset: inForce,
          ...(record.summary.permissionMode ? { permissionMode: record.summary.permissionMode } : {}),
        }
      }),
    setModel: (_m: string, ref: ModuleConversationRef, modelId: string, options?: { commandId?: string }) =>
      operate(ref, options?.commandId, (record) => {
        record.summary.modelId = modelId
        notifyWatchers()
        return { ok: true, modelId }
      }),
    stop: (_m: string, ref: ModuleConversationRef) =>
      operate(ref, undefined, (record) => {
        record.stopped = true
        emit(record, { type: 'session_closed' })
        return { ok: true }
      }),
    // A chat the host does not know yet is attached all the same; a ref naming
    // no chat of the module's delivers nothing, ever.
    subscribe(_m: string, ref: ModuleConversationRef, cb: (event: ModuleConversationEvent) => void) {
      requireRead()
      requireRef(ref)
      const key = refKey(ref)
      let set = subscribers.get(key)
      if (!set) subscribers.set(key, (set = new Set()))
      set.add(cb)
      return () => {
        set.delete(cb)
      }
    },
    follow(
      _m: string,
      ref: ModuleConversationRef,
      options: { afterSeq?: number } | undefined,
      onFrame: (frame: ModuleConversationStreamFrame) => void,
    ) {
      requireRead()
      requireRef(ref)
      const after = options?.afterSeq
      if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) {
        throw new Error('"afterSeq" must be a whole number of events.')
      }
      const key = refKey(ref)
      const record = owned(ref)
      if (record) {
        const workspace = workspaces.find(record.summary.workspaceId)
        if (workspace && !workspace.folderPath) {
          throw new Error(`Workspace "${workspace.id}" has no project folder, so its chat has no transcript.`)
        }
        startFollow(record, after, onFrame)
        return () => {
          followers.get(key)?.delete(onFrame)
        }
      }
      const pending = { ...(after !== undefined ? { after } : {}), onFrame }
      let set = pendingFollows.get(key)
      if (!set) pendingFollows.set(key, (set = new Set()))
      set.add(pending)
      return () => {
        pendingFollows.get(key)?.delete(pending)
        followers.get(key)?.delete(onFrame)
      }
    },
    async transcript(_m: string, ref: ModuleConversationRef) {
      if (!canRead()) return missing('conversation:read')
      const record = owned(ref)
      if (!record) return notOwned(ref)
      return { ok: true as const, events: structuredClone(record.events) }
    },
    // The last finished turn's reply (or `turnId`'s), as the host reads it off the transcript.
    async reply(_m: string, ref: ModuleConversationRef, turnId?: string) {
      if (!canRead()) return missing('conversation:read')
      if (turnId !== undefined && (typeof turnId !== 'string' || !turnId.trim())) {
        return failure('invalid_input', '"turnId" must be a turn id when provided.')
      }
      const record = owned(ref)
      if (!record) return notOwned(ref)
      // The SDK targets ES2022, which has no findLast.
      const completed = [...record.events]
        .reverse()
        .find(
          (event) =>
            event.type === 'turn_completed' &&
            typeof event.payload?.turnId === 'string' &&
            (turnId === undefined ? event.payload.steered !== true : event.payload.turnId === turnId),
        )
      const id = completed?.payload?.turnId
      if (!completed || typeof id !== 'string') {
        return failure(
          'no_reply',
          turnId === undefined
            ? 'This conversation has no finished turn yet.'
            : `Turn "${turnId}" has not finished in this conversation.`,
        )
      }
      if (typeof completed.payload?.text === 'string')
        return { ok: true as const, turnId: id, text: completed.payload.text }
      const streamed = record.events
        .filter((event) => event.type === 'content_delta' && event.payload?.turnId === id)
        .map((event) => (typeof event.payload?.text === 'string' ? event.payload.text : ''))
        .join('')
      return { ok: true as const, turnId: id, text: streamed }
    },
    list(_m: string, filter?: { workspaceId?: string }) {
      requireRead()
      return list(filter)
    },
    watch(_m: string, filter: { workspaceId?: string } | undefined, cb: (list: ModuleConversationSummary[]) => void) {
      requireRead()
      const watcher = { filter, cb }
      watchers.add(watcher)
      cb(list(filter))
      return () => {
        watchers.delete(watcher)
      }
    },
  }

  const handle: FakeConversations = {
    all: () => [...records.values()],
    get: (ref) => owned(ref),
    emitEvent(ref, event) {
      const record = owned(ref)
      if (!record) {
        throw new Error(
          foreign.has(refKey(ref))
            ? `Conversation "${ref.agentId}" is not the module's own; the module never sees its events.`
            : `No conversation "${ref.agentId}" in workspace "${ref.workspaceId}"; start one with create (or restore) first.`,
        )
      }
      return emit(record, event)
    },
    setStatus(ref, status) {
      const record = owned(ref)
      if (!record) throw new Error(`No conversation "${ref.agentId}" in workspace "${ref.workspaceId}".`)
      record.summary.status = status
      notifyWatchers()
    },
    restore(chat) {
      const { events = [], ...fields } = structuredClone(chat)
      const cli = fields.cli ?? 'claude-code'
      const record: FakeConversationRecord = {
        summary: {
          sessionId: `session-${fields.agentId}`,
          name: `Chat ${fields.agentId}`,
          providerId: providerForCli(cli),
          modelId: 'default',
          status: 'ready',
          ...fields,
          cli,
        },
        input: { workspaceId: fields.workspaceId, cli, ...(fields.name ? { name: fields.name } : {}) },
        events: [],
        sent: [],
        answers: [],
        interrupted: 0,
        stopped: false,
      }
      // The transcript was there before anyone listened: recorded, not delivered.
      const key = refKey(record.summary)
      const listening = { subscribers: subscribers.get(key), followers: followers.get(key) }
      subscribers.delete(key)
      followers.delete(key)
      const status = record.summary.status
      for (const event of events) emit(record, event)
      record.summary.status = status
      if (listening.subscribers) subscribers.set(key, listening.subscribers)
      if (listening.followers) followers.set(key, listening.followers)
      adopt(record)
      return record
    },
    addForeign(ref) {
      foreign.add(refKey(ref))
    },
    failNextCreate(code, message) {
      pendingFailure = failure(code, message ?? `The fake host refused this create with "${code}".`)
    },
  }
  return { registry, handle }
}

// ── Scheduled agents ─────────────────────────────────────────────────────────

/** The module's scheduled agents, and a way to make one run. */
export type FakeScheduledAgents = {
  all(): ScheduledAgentView[]
  /**
   * Run one as its schedule would: starts its chat (a new workspace, and a
   * chat the module owns in the conversations fake, carrying
   * `scheduledAgentId` and `scheduledAgentTag`), records `lastRun` with the
   * chat's `agentId`, tells `onRun` listeners and then `onChanged` ones, and
   * closes a one-time schedule.
   */
  fire(id: string): ScheduledAgentLastRun
  /** Make the next `create` or `update` fail with this message, as the host's validation would. */
  failNextWrite(message: string): void
  /** Make the next run fail to start with this message: `lastRun` says why, and `onRun` hears nothing. */
  failNextRun(message: string): void
}

const MAX_SCHEDULED_NAME_LENGTH = 120
const MAX_SCHEDULED_TAG_LENGTH = 200

function scheduledAgentsRegistry(context: FakeServiceContext): { registry: object; handle: FakeScheduledAgents } {
  const workspaces = context.workspaces as InternalWorkspaces
  const agents = new Map<string, ScheduledAgentView>()
  const listeners = new Set<(list: ScheduledAgentView[]) => void>()
  const runListeners = new Set<(agent: ScheduledAgentView, run: ScheduledAgentRun) => void>()
  let nextId = 1
  let nextRun = 1
  let pendingFailure: string | null = null
  let pendingRunFailure: string | null = null

  const snapshot = (): ScheduledAgentView[] => [...agents.values()].map((agent) => structuredClone(agent))
  const changed = (): void => {
    for (const listener of listeners) listener(snapshot())
  }
  const label = (value: unknown, max: number): boolean =>
    value === undefined || value === null || (typeof value === 'string' && value.length <= max)
  const invalid = (draft: ScheduledAgentDraft): string | null => {
    if (pendingFailure) {
      const message = pendingFailure
      pendingFailure = null
      return message
    }
    if (typeof draft?.prompt !== 'string' || !draft.prompt.trim()) return 'A scheduled agent needs a prompt.'
    if (typeof draft.folderPath !== 'string' || !isAbsolute(draft.folderPath)) {
      return 'A scheduled agent needs an absolute project folder.'
    }
    if (typeof draft.schedule?.cron !== 'string' || !draft.schedule.cron.trim())
      return 'A scheduled agent needs a schedule.'
    if (typeof draft.schedule.timezone !== 'string' || !draft.schedule.timezone.trim()) {
      return 'A scheduled agent needs a time zone.'
    }
    if (draft.schedule.once !== undefined && draft.schedule.once <= context.now())
      return 'That time has already passed.'
    if (typeof draft.cli !== 'string' || !draft.cli.trim()) return 'A scheduled agent needs an agent runtime.'
    if (!label(draft.name, MAX_SCHEDULED_NAME_LENGTH)) {
      return `A scheduled agent's name is text of at most ${MAX_SCHEDULED_NAME_LENGTH} characters.`
    }
    if (!label(draft.tag, MAX_SCHEDULED_TAG_LENGTH)) {
      return `A scheduled agent's tag is text of at most ${MAX_SCHEDULED_TAG_LENGTH} characters.`
    }
    return null
  }
  // An empty name or tag clears it; one left out keeps the record's (on update).
  const withoutEmptyLabels = (agent: ScheduledAgentView): ScheduledAgentView => {
    const next = { ...agent }
    if (!next.name?.trim()) delete next.name
    else next.name = next.name.trim()
    if (!next.tag?.trim()) delete next.tag
    else next.tag = next.tag.trim()
    return next
  }
  const notFound = (id: string) => ({ ok: false as const, message: `No scheduled agent "${id}".` })

  function run(agent: ScheduledAgentView): ScheduledAgentLastRun {
    const at = context.now()
    if (pendingRunFailure) {
      const message = pendingRunFailure
      pendingRunFailure = null
      agent.lastRun = { at, ok: false, message }
      changed()
      return agent.lastRun
    }
    const n = nextRun++
    const workspaceId = `ws-run-${n}`
    const agentId = `run-agent-${n}`
    const title =
      agent.name ??
      agent.prompt
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find(Boolean) ??
      'Scheduled agent'
    workspaces.add({ id: workspaceId, name: title, folderPath: agent.folderPath, mode: 'standard' })
    // The run's chat is the module's, as on the host: its conversation service reaches it.
    context.peer?.('conversations')?.restore({
      workspaceId,
      agentId,
      name: title,
      cli: agent.cli,
      status: 'active',
      scheduledAgentId: agent.id,
      ...(agent.tag ? { scheduledAgentTag: agent.tag } : {}),
      events: [{ type: 'session_started' }, { type: 'user_message', payload: { text: agent.prompt } }],
    })
    const lastRun: ScheduledAgentLastRun = { at, ok: true, workspaceId, agentId }
    agent.lastRun = lastRun
    // A one-time schedule is told before it closes itself.
    for (const listener of [...runListeners]) listener(structuredClone(agent), { at, workspaceId, agentId })
    if (agent.schedule.once !== undefined) agents.delete(agent.id)
    changed()
    return lastRun
  }

  const registry = {
    async create(moduleId: string, draft: ScheduledAgentDraft): Promise<ScheduledAgentWriteResult> {
      const problem = invalid(draft)
      if (problem) return { ok: false, message: problem }
      const at = context.now()
      const agent: ScheduledAgentView = withoutEmptyLabels({
        ...structuredClone(draft),
        id: `scheduled-${nextId++}`,
        ownerModuleId: moduleId,
        createdAt: at,
        updatedAt: at,
        lastRun: null,
        lastFailureSeenAt: null,
        // The fake does not evaluate cron; a one-time schedule knows its instant.
        nextRunAt: draft.schedule.once ?? null,
      })
      agents.set(agent.id, agent)
      changed()
      return { ok: true, agent: structuredClone(agent) }
    },
    async update(_moduleId: string, id: string, draft: ScheduledAgentDraft): Promise<ScheduledAgentWriteResult> {
      const existing = agents.get(id)
      if (!existing) return notFound(id)
      const problem = invalid(draft)
      if (problem) return { ok: false, message: problem }
      const agent: ScheduledAgentView = withoutEmptyLabels({
        ...existing,
        ...structuredClone(draft),
        updatedAt: context.now(),
        nextRunAt: draft.schedule.once ?? null,
      })
      agents.set(id, agent)
      changed()
      return { ok: true, agent: structuredClone(agent) }
    },
    async remove(_moduleId: string, id: string) {
      if (!agents.delete(id)) return notFound(id)
      changed()
      return { ok: true as const }
    },
    async list() {
      return snapshot()
    },
    async runNow(_moduleId: string, id: string) {
      const agent = agents.get(id)
      if (!agent) return notFound(id)
      return { ok: true as const, run: run(agent) }
    },
    onChanged(_moduleId: string, listener: (list: ScheduledAgentView[]) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    onRun(_moduleId: string, listener: (agent: ScheduledAgentView, run: ScheduledAgentRun) => void) {
      runListeners.add(listener)
      return () => {
        runListeners.delete(listener)
      }
    },
  }
  const handle: FakeScheduledAgents = {
    all: snapshot,
    fire(id) {
      const agent = agents.get(id)
      if (!agent) throw new Error(`No scheduled agent "${id}".`)
      return run(agent)
    },
    failNextWrite(message) {
      pendingFailure = message
    },
    failNextRun(message) {
      pendingRunFailure = message
    },
  }
  return { registry, handle }
}

// ── Companion agents ─────────────────────────────────────────────────────────

/** What a companion's scripted reply is computed from. */
export type FakeCompanionTurn = {
  spec: CompanionAgentSpec
  prompt: string
  attempt: number
  /** The run's tool policy (`none` unless the module asked otherwise). */
  tools: 'none' | 'ask' | 'auto'
}

/** A tool call the companion's agent asks to make, for `requestApproval`. */
export type FakeCompanionApprovalRequest = {
  /** Default: a fresh id. */
  requestId?: string
  /** What the agent wants to do, as the event's payload carries it (`tool`, `command`, …). */
  payload?: Record<string, unknown>
}

/** The module's companion agents, and the replies they give. */
export type FakeCompanions = {
  /** Every handle `attach` returned, by `workspaceId/agentId`. */
  handles(): CompanionAgentHandle[]
  /**
   * What `runStructured` gets back from the agent (before validation).
   * Default: `{}`. May be async: a reply that awaits `requestApproval` is an
   * agent that asks for a tool mid-turn.
   */
  respond(reply: (turn: FakeCompanionTurn) => unknown): void
  /**
   * Every prompt sent through `runStructured` and `send`, in order, as the
   * agent got it: a `tools: 'none'` run's prompt carries the host's note that
   * it has no tools.
   */
  readonly prompts: Array<{
    agentId: string
    prompt: string
    via: 'runStructured' | 'send'
    tools?: 'none' | 'ask' | 'auto'
  }>
  /** Deliver an event to a companion's `onEvent` listeners. */
  emitEvent(workspaceId: string, agentId: string, event: Omit<CompanionAgentEvent, 'workspaceId' | 'agentId'>): void
  /**
   * The companion's agent asks to use a tool, as it would mid-turn. The
   * running structured run's policy answers it: `none` denies, `auto`
   * allows; under `ask`, or outside a structured run (a `send` turn), it is
   * delivered to `onEvent` as `approval_requested` and stays open until the
   * module relays the person's answer with `respondToApproval`. Resolves with
   * the decision.
   */
  requestApproval(
    workspaceId: string,
    agentId: string,
    request?: FakeCompanionApprovalRequest,
  ): Promise<'once' | 'deny'>
  /** Every approval and how it was answered (`by: 'host'` for a run's policy, `'module'` for `respondToApproval`). */
  readonly approvals: Array<{ agentId: string; requestId: string; decision: 'once' | 'deny'; by: 'host' | 'module' }>
}

// What the host tells a `tools: 'none'` run's agent before the module's prompt.
const NO_TOOLS_NOTE =
  'You have no tools for this task: do not call any tool, and do not try to read or change files. Answer from what this message gives you.'

function companionsRegistry(context: FakeServiceContext): { registry: object; handle: FakeCompanions } {
  type Companion = {
    handle: CompanionAgentHandle
    // The tool policy of the structured run in flight, or null between runs (and in `send` turns).
    tools: 'none' | 'ask' | 'auto' | null
    open: Map<string, (decision: 'once' | 'deny') => void>
    emit(type: string, payload?: Record<string, unknown>): void
  }
  const companions = new Map<string, Companion>()
  const prompts: FakeCompanions['prompts'] = []
  const approvals: FakeCompanions['approvals'] = []
  let reply: (turn: FakeCompanionTurn) => unknown = () => ({})
  let nextRequest = 1
  let nextEvent = 1

  function create(spec: CompanionAgentSpec): Companion {
    let status: CompanionAgentStatus = 'absent'
    const statusListeners = new Set<(status: CompanionAgentStatus) => void>()
    const listeners = new Set<(event: CompanionAgentEvent) => void>()
    const setStatus = (next: CompanionAgentStatus): void => {
      if (next === status) return
      status = next
      for (const listener of statusListeners) listener(next)
    }
    let disposed = false
    const live = (): void => {
      if (disposed) throw new Error(`Companion "${spec.agentId}" was disposed; attach it again.`)
    }
    const companion: Companion = {
      handle: undefined as unknown as CompanionAgentHandle,
      tools: null,
      open: new Map(),
      emit(type, payload) {
        const event: CompanionAgentEvent = {
          id: `companion-event-${nextEvent++}`,
          sessionId: `session-${spec.agentId}`,
          workspaceId: spec.workspaceId,
          agentId: spec.agentId,
          providerId: spec.engine?.cli ?? 'claude-agent',
          modelId: spec.engine?.model ?? 'sonnet',
          type,
          createdAt: context.now(),
          ...(payload ? { payload: structuredClone(payload) } : {}),
        }
        for (const cb of [...listeners]) cb(structuredClone(event))
      },
    }
    companion.handle = {
      workspaceId: spec.workspaceId,
      agentId: spec.agentId,
      status: () => status,
      onStatus(cb) {
        statusListeners.add(cb)
        return () => {
          statusListeners.delete(cb)
        }
      },
      async runStructured(options) {
        live()
        const tools = options.tools ?? 'none'
        if (tools === 'auto' && !context.permissions.has('conversation:bypass')) {
          throw new Error(
            `Module "${context.moduleId}" must declare the "conversation:bypass" permission to run a companion task with tools: 'auto', which approves every tool call without asking.`,
          )
        }
        // A live intent spawns the session, as the host's first runStructured does.
        setStatus('active')
        companion.tools = tools
        const retries = options.retries ?? 1
        let errors: string[] = []
        try {
          for (let attempt = 0; attempt <= retries; attempt += 1) {
            const asked =
              attempt === 0 ? options.prompt : `${options.prompt}\n\nThe last answer was invalid: ${errors.join('; ')}`
            const prompt = tools === 'none' ? `${NO_TOOLS_NOTE}\n\n${asked}` : asked
            prompts.push({ agentId: spec.agentId, prompt, via: 'runStructured', tools })
            options.onPhase?.(attempt === 0 ? 'running' : 'retrying')
            const answer = await reply({ spec, prompt, attempt, tools })
            const validated = options.validate(structuredClone(answer))
            if (validated.ok) return validated.value
            errors = validated.errors
          }
        } finally {
          companion.tools = null
          // A turn's end closes whatever it left open.
          for (const settle of companion.open.values()) settle('deny')
          companion.open.clear()
          setStatus('ready')
        }
        throw new Error(`Companion "${spec.agentId}" gave no valid answer: ${errors.join('; ')}`)
      },
      async send(message) {
        live()
        setStatus('ready')
        prompts.push({ agentId: spec.agentId, prompt: message, via: 'send' })
      },
      async respondToApproval(input) {
        if (disposed) return { ok: false, message: 'Companion agent is disposed.' }
        // Relaying the person's "allow" is operating the agent, as in a chat.
        if (input?.decision === 'once' && !context.permissions.has('conversation:operate')) {
          return {
            ok: false,
            message: `Module "${context.moduleId}" must declare the "conversation:operate" permission to allow a tool call; without it a companion's approvals can only be denied.`,
          }
        }
        if (input?.decision !== 'once' && input?.decision !== 'deny') {
          return { ok: false, message: '"decision" must be "once" or "deny".' }
        }
        const settle = companion.open.get(input.requestId)
        if (!settle)
          return { ok: false, message: `No approval request "${input.requestId}" is waiting on this companion.` }
        companion.open.delete(input.requestId)
        approvals.push({ agentId: spec.agentId, requestId: input.requestId, decision: input.decision, by: 'module' })
        settle(input.decision)
        return { ok: true }
      },
      onEvent(cb) {
        listeners.add(cb)
        return () => {
          listeners.delete(cb)
        }
      },
      interrupt() {
        for (const settle of companion.open.values()) settle('deny')
        companion.open.clear()
      },
      dispose() {
        disposed = true
        setStatus('absent')
        companions.delete(`${spec.workspaceId}/${spec.agentId}`)
      },
    }
    return companion
  }

  const registry = {
    attach(_moduleId: string, spec: CompanionAgentSpec): CompanionAgentHandle {
      if (!context.permissions.has('agents:companion')) {
        throw new Error(
          `Module "${context.moduleId}" must declare the "agents:companion" permission to attach a companion agent.`,
        )
      }
      if (!spec?.workspaceRoot || !isAbsolute(spec.workspaceRoot)) {
        throw new Error('A companion agent needs an absolute workspaceRoot.')
      }
      const key = `${spec.workspaceId}/${spec.agentId}`
      let companion = companions.get(key)
      if (!companion) companions.set(key, (companion = create(spec)))
      return companion.handle
    },
  }
  const handle: FakeCompanions = {
    handles: () => [...companions.values()].map((companion) => companion.handle),
    respond(next) {
      reply = next
    },
    prompts,
    emitEvent(workspaceId, agentId, event) {
      const companion = companions.get(`${workspaceId}/${agentId}`)
      companion?.emit(event.type, event.payload)
    },
    requestApproval(workspaceId, agentId, request = {}) {
      const companion = companions.get(`${workspaceId}/${agentId}`)
      if (!companion) throw new Error(`No companion "${agentId}" is attached in workspace "${workspaceId}".`)
      const requestId = request.requestId ?? `request-${nextRequest++}`
      // A structured run's policy answers for it; `ask` and chat turns leave it to the person.
      if (companion.tools === 'none' || companion.tools === 'auto') {
        const decision = companion.tools === 'auto' ? 'once' : 'deny'
        approvals.push({ agentId, requestId, decision, by: 'host' })
        return Promise.resolve(decision)
      }
      return new Promise((resolve) => {
        companion.open.set(requestId, resolve)
        companion.emit('approval_requested', { ...request.payload, requestId })
      })
    },
    approvals,
  }
  return { registry, handle }
}

// ── Secrets ──────────────────────────────────────────────────────────────────

/** A request `fetchWithSecret` would send, with the secret where the host puts it. */
export type FakeSecretRequest = {
  name: string
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/** The module's stored secrets, and the answers its brokered requests get. */
export type FakeSecrets = {
  /** Names stored, and the origins each may go to (the value stays the host's). */
  stored(): Record<string, string[]>
  /** What a brokered request answers. Default: 200 with an empty body. */
  respond(
    answer: (request: FakeSecretRequest) => { status: number; body?: string; headers?: Record<string, string> },
  ): void
  /** Every request sent, with the secret in place. */
  readonly requests: FakeSecretRequest[]
}

const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function secretsRegistry(context: FakeServiceContext): { registry: object; handle: FakeSecrets } {
  const secrets = new Map<string, { value: string; allowedOrigins: string[] }>()
  const requests: FakeSecretRequest[] = []
  let answer: Parameters<FakeSecrets['respond']>[0] = () => ({ status: 200, body: '' })
  const allowed = (): boolean => context.permissions.has('secrets')
  const missing = () =>
    failure<ModuleSecretsError>(
      'permission_missing',
      `Module "${context.moduleId}" must declare the "secrets" permission.`,
    )
  const badName = (name: unknown) =>
    typeof name === 'string' && SECRET_NAME_PATTERN.test(name)
      ? null
      : failure<ModuleSecretsError>('invalid_name', `"${String(name)}" is not a secret name.`)
  const origin = (candidate: unknown): string | null => {
    if (typeof candidate !== 'string') return null
    try {
      const url = new URL(candidate)
      return url.protocol === 'https:' && (url.pathname === '/' || url.pathname === '') && !url.search
        ? url.origin
        : null
    } catch {
      return null
    }
  }

  const registry = {
    async set(_m: string, name: string, value: string, options: { allowedOrigins: string[] }) {
      if (!allowed()) return missing()
      const nameIssue = badName(name)
      if (nameIssue) return nameIssue
      if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Secret "${name}" needs a string value.`)
      const origins = (options?.allowedOrigins ?? []).map(origin)
      if (origins.length === 0 || origins.some((entry) => entry === null)) {
        return failure<ModuleSecretsError>(
          'origin_not_allowed',
          `Secret "${name}" needs allowed origins, each an https origin such as "https://api.example.com".`,
        )
      }
      secrets.set(name, { value: value.trim(), allowedOrigins: [...new Set(origins as string[])] })
      return { ok: true as const }
    },
    async has(_m: string, name: string) {
      if (!allowed()) throw new Error(missing().message)
      return !badName(name) && secrets.has(name)
    },
    async delete(_m: string, name: string) {
      if (!allowed()) return missing()
      const nameIssue = badName(name)
      if (nameIssue) return nameIssue
      secrets.delete(name)
      return { ok: true as const }
    },
    async fetchWithSecret(
      _m: string,
      name: string,
      url: string,
      init: ModuleSecretFetchInit,
    ): Promise<ModuleSecretFetchResult> {
      if (!allowed()) return missing()
      const nameIssue = badName(name)
      if (nameIssue) return nameIssue
      let target: URL
      try {
        target = new URL(url)
      } catch {
        return failure('origin_not_allowed', 'The request URL is not an absolute URL.')
      }
      if (target.protocol !== 'https:') return failure('origin_not_allowed', 'A secret is only ever sent over https.')
      if (target.username || target.password) {
        return failure('origin_not_allowed', 'The request URL may not carry credentials of its own.')
      }
      const stored = secrets.get(name)
      if (!stored) return failure('not_set', `Secret "${name}" is not set.`)
      if (!stored.allowedOrigins.includes(target.origin)) {
        return failure(
          'origin_not_allowed',
          `Secret "${name}" may not be sent to ${target.origin}; it was stored for ${stored.allowedOrigins.join(', ')}.`,
        )
      }
      const headers: Record<string, string> = { ...init?.headers }
      if (init?.placement && 'header' in init.placement) {
        const scheme = init.placement.scheme ?? ''
        headers[init.placement.header] = scheme ? `${scheme} ${stored.value}` : stored.value
      } else if (init?.placement && 'query' in init.placement) {
        target.searchParams.set(init.placement.query, stored.value)
      }
      const request: FakeSecretRequest = {
        name,
        url: target.toString(),
        method: init?.method ?? 'GET',
        headers,
        ...(init?.body !== undefined ? { body: init.body } : {}),
      }
      requests.push(request)
      const answered = answer(structuredClone(request))
      // The host never hands a secret back: an echoed value is redacted.
      const body = (answered.body ?? '').split(stored.value).join('[redacted]')
      return { ok: true, status: answered.status, headers: answered.headers ?? {}, body }
    },
  }
  const handle: FakeSecrets = {
    stored: () => Object.fromEntries([...secrets].map(([name, entry]) => [name, [...entry.allowedOrigins]])),
    respond(next) {
      answer = next
    },
    requests,
  }
  return { registry, handle }
}

// ── GitHub ───────────────────────────────────────────────────────────────────

/**
 * A scripted GitHub answer. A success needs only `data`: `status` defaults to
 * 200 and `headers` to none, and the headers a module may read are kept the
 * way the host keeps them (`etag`, `link`, `retry-after`, `x-ratelimit-*`,
 * lowercased).
 */
export type FakeGitHubReply =
  | { ok: true; status?: number; data: unknown; headers?: Record<string, string> }
  | Extract<ModuleGitHubResponse, { ok: false }>

/** What `request` resolves to for a route: a reply, or one computed from the request. */
export type FakeGitHubAnswer = FakeGitHubReply | ((request: ModuleGitHubRequest) => FakeGitHubReply)

/** What `graphql` answers: GitHub's whole answer (`{ data, errors? }`) as `data`. */
export type FakeGitHubGraphqlAnswer =
  FakeGitHubReply | ((input: { query: string; variables?: Record<string, unknown> }) => FakeGitHubReply)

/** A scripted download: the bytes (or text) behind the redirect, encoded as the request asks. */
export type FakeGitHubDownloadReply =
  | {
      ok: true
      body: string | Uint8Array
      contentType?: string | null
      status?: number
      headers?: Record<string, string>
    }
  | Extract<ModuleGitHubResponse, { ok: false }>

export type FakeGitHubDownloadAnswer =
  FakeGitHubDownloadReply | ((request: ModuleGitHubDownloadRequest) => FakeGitHubDownloadReply)

/** The signed-in user's GitHub, as scripted answers keyed by `METHOD /route`. */
export type FakeGitHub = {
  /**
   * Answer `method route` (the route as the module writes it, placeholders
   * and all: `GET /repos/{owner}/{repo}/pulls`). Unscripted requests answer
   * 404 `http_error`. A request whose `ifNoneMatch` is the `etag` of the
   * answer it would get is answered 304 with `data: null`, as GitHub does.
   */
  respond(method: NonNullable<ModuleGitHubRequest['method']>, route: string, answer: FakeGitHubAnswer): void
  /**
   * What a read-only `graphql` query answers. Unscripted: 200 with
   * `{ data: null, errors: [...] }`, the way GraphQL reports a failure. A
   * mutation or subscription is refused (`invalid_query`) before it is sent.
   */
  respondGraphql(answer: FakeGitHubGraphqlAnswer): void
  /** What `download(route)` answers (the route as the module writes it). Unscripted: 404 `http_error`. */
  respondDownload(route: string, answer: FakeGitHubDownloadAnswer): void
  /** Signed in (as `login`) or not; signed out answers `not_signed_in`. Default: signed in as `dev`. */
  setSignedIn(signedIn: boolean, login?: string): void
  /** Every REST request sent, in order. */
  readonly requests: ModuleGitHubRequest[]
  /** Every GraphQL query sent (refused ones are not sent). */
  readonly graphqlRequests: Array<{ query: string; variables?: Record<string, unknown> }>
  /** Every download sent. */
  readonly downloads: ModuleGitHubDownloadRequest[]
}

const GITHUB_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']
// The host's own lists (module-github.ts in the app): GitHub's media types,
// the response headers a module may read, and an etag's shape.
const GITHUB_MEDIA_TYPES: ReadonlySet<ModuleGitHubMediaType> = new Set<ModuleGitHubMediaType>([
  'application/vnd.github+json',
  'application/vnd.github.raw+json',
  'application/vnd.github.text+json',
  'application/vnd.github.html+json',
  'application/vnd.github.full+json',
  'application/vnd.github.base64+json',
  'application/vnd.github.object+json',
  'application/vnd.github.raw',
  'application/vnd.github.diff',
  'application/vnd.github.patch',
  'application/vnd.github.sha',
])
const GITHUB_RESPONSE_HEADERS = new Set(['link', 'etag', 'retry-after'])
const GITHUB_ETAG_PATTERN = /^(?:W\/)?"[\x21\x23-\x7e]{0,200}"$/

function githubHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase()
    if (GITHUB_RESPONSE_HEADERS.has(lower) || lower.startsWith('x-ratelimit-')) picked[lower] = value
  }
  return picked
}

// The operation keywords at the top level of a GraphQL document (strings,
// block strings and comments skipped), or null for a document that selects
// nothing — the same reading the host's check makes before it sends one.
function graphqlTopLevelKeywords(query: string): string[] | null {
  const keywords: string[] = []
  let depth = 0
  let sawSelection = false
  let index = 0
  while (index < query.length) {
    const char = query[index]!
    if (char === '#') {
      while (index < query.length && query[index] !== '\n' && query[index] !== '\r') index += 1
      continue
    }
    if (query.startsWith('"""', index)) {
      index += 3
      while (index < query.length && !query.startsWith('"""', index)) index += query.startsWith('\\"""', index) ? 4 : 1
      index += 3
      continue
    }
    if (char === '"') {
      index += 1
      while (index < query.length && query[index] !== '"' && query[index] !== '\n') {
        index += query[index] === '\\' ? 2 : 1
      }
      index += 1
      continue
    }
    if (char === '{' || char === '(' || char === '[') {
      if (char === '{') sawSelection = true
      depth += 1
      index += 1
      continue
    }
    if (char === '}' || char === ')' || char === ']') {
      depth = Math.max(0, depth - 1)
      index += 1
      continue
    }
    if (/[_A-Za-z]/.test(char)) {
      const start = index
      while (index < query.length && /[_0-9A-Za-z]/.test(query[index]!)) index += 1
      if (depth === 0) keywords.push(query.slice(start, index))
      continue
    }
    index += 1
  }
  return sawSelection ? keywords : null
}

function githubRegistry(context: FakeServiceContext): { registry: object; handle: FakeGitHub } {
  const answers = new Map<string, FakeGitHubAnswer>()
  const downloadAnswers = new Map<string, FakeGitHubDownloadAnswer>()
  let graphqlAnswer: FakeGitHubGraphqlAnswer | null = null
  const requests: ModuleGitHubRequest[] = []
  const graphqlRequests: FakeGitHub['graphqlRequests'] = []
  const downloads: ModuleGitHubDownloadRequest[] = []
  let signedIn = true
  let login = 'dev'
  const allowed = (): boolean => context.permissions.has('github')
  const missingMessage = `Module "${context.moduleId}" must declare the "github" permission.`
  const signedOut = () => failure('not_signed_in', 'Sign in to GitHub in Settings to let extensions use it.')
  const mediaIssue = (accept: unknown) =>
    accept !== undefined && (typeof accept !== 'string' || !GITHUB_MEDIA_TYPES.has(accept as ModuleGitHubMediaType))
      ? failure('invalid_route', `"${String(accept)}" is not one of the GitHub media types a request may ask for.`)
      : null
  // A scripted reply as the host would hand it over: status and headers filled in.
  const settle = (reply: FakeGitHubReply): ModuleGitHubResponse => {
    if (!reply.ok) return structuredClone(reply)
    return {
      ok: true,
      status: reply.status ?? 200,
      data: structuredClone(reply.data),
      headers: githubHeaders(reply.headers),
    }
  }

  const registry = {
    async request(_m: string, request: ModuleGitHubRequest): Promise<ModuleGitHubResponse> {
      if (!allowed()) return failure('permission_missing', missingMessage)
      if (typeof request?.route !== 'string' || !request.route.startsWith('/')) {
        return failure('invalid_route', 'request needs a route.')
      }
      const method = request.method ?? 'GET'
      if (!GITHUB_METHODS.includes(method)) {
        return failure('invalid_route', `Method "${method}" is not one GitHub's REST API takes.`)
      }
      const media = mediaIssue(request.accept)
      if (media) return media
      if (
        request.ifNoneMatch !== undefined &&
        (typeof request.ifNoneMatch !== 'string' || !GITHUB_ETAG_PATTERN.test(request.ifNoneMatch))
      ) {
        return failure(
          'invalid_route',
          "ifNoneMatch takes an etag exactly as an earlier answer's headers.etag carried it.",
        )
      }
      if (method === 'GET' && request.body !== undefined) {
        return failure('invalid_route', 'A GET request carries no body; use params.')
      }
      requests.push(structuredClone(request))
      if (!signedIn) return signedOut()
      const scripted = answers.get(`${method} ${request.route}`)
      if (scripted === undefined) {
        return {
          ok: false,
          code: 'http_error',
          status: 404,
          message: `No scripted answer for ${method} ${request.route}.`,
        }
      }
      const answer = settle(typeof scripted === 'function' ? scripted(structuredClone(request)) : scripted)
      // Nothing changed since the etag the module holds: GitHub answers 304.
      if (answer.ok && request.ifNoneMatch !== undefined && answer.headers.etag === request.ifNoneMatch) {
        return { ok: true, status: 304, data: null, headers: answer.headers }
      }
      return answer
    },
    async graphql(_m: string, query: string, variables?: Record<string, unknown>): Promise<ModuleGitHubResponse> {
      if (!allowed()) return failure('permission_missing', missingMessage)
      if (typeof query !== 'string' || query.trim() === '') {
        return failure('invalid_query', 'graphql needs a query document.')
      }
      const keywords = graphqlTopLevelKeywords(query)
      if (keywords === null) return failure('invalid_query', 'The document selects nothing.')
      const write = keywords.find((keyword) => keyword === 'mutation' || keyword === 'subscription')
      if (write) {
        return failure(
          'invalid_query',
          `graphql is read-only; a ${write} is refused. Use request() for a write, on an explicit action of the person's.`,
        )
      }
      if (
        variables !== undefined &&
        (typeof variables !== 'object' || variables === null || Array.isArray(variables))
      ) {
        return failure('invalid_query', 'variables must be an object.')
      }
      const input = variables === undefined ? { query } : { query, variables: structuredClone(variables) }
      graphqlRequests.push(input)
      if (!signedIn) return signedOut()
      if (graphqlAnswer === null) {
        return {
          ok: true,
          status: 200,
          data: { data: null, errors: [{ message: 'No scripted GraphQL answer.' }] },
          headers: {},
        }
      }
      return settle(typeof graphqlAnswer === 'function' ? graphqlAnswer(structuredClone(input)) : graphqlAnswer)
    },
    async download(_m: string, request: ModuleGitHubDownloadRequest): Promise<ModuleGitHubDownloadResponse> {
      if (!allowed()) return failure('permission_missing', missingMessage)
      if (typeof request?.route !== 'string' || !request.route.startsWith('/')) {
        return failure('invalid_route', 'download needs a route.')
      }
      const media = mediaIssue(request.accept)
      if (media) return media
      if (request.encoding !== undefined && request.encoding !== 'utf8' && request.encoding !== 'base64') {
        return failure('invalid_route', 'encoding is "utf8" or "base64".')
      }
      const encoding = request.encoding ?? 'utf8'
      downloads.push(structuredClone(request))
      if (!signedIn) return signedOut()
      const scripted = downloadAnswers.get(request.route)
      if (scripted === undefined) {
        return { ok: false, code: 'http_error', status: 404, message: `No scripted download for ${request.route}.` }
      }
      const reply = typeof scripted === 'function' ? scripted(structuredClone(request)) : scripted
      if (!reply.ok) return structuredClone(reply)
      const bytes = typeof reply.body === 'string' ? Buffer.from(reply.body, 'utf8') : Buffer.from(reply.body)
      return {
        ok: true,
        status: reply.status ?? 200,
        data: bytes.toString(encoding),
        encoding,
        contentType: reply.contentType ?? null,
        headers: githubHeaders(reply.headers),
      }
    },
    async status() {
      if (!allowed()) throw new Error(missingMessage)
      return signedIn ? { signedIn: true, login } : { signedIn: false }
    },
  }
  const handle: FakeGitHub = {
    respond(method, route, answer) {
      answers.set(`${method} ${route}`, answer)
    },
    respondGraphql(answer) {
      graphqlAnswer = answer
    },
    respondDownload(route, answer) {
      downloadAnswers.set(route, answer)
    },
    setSignedIn(next, nextLogin) {
      signedIn = next
      if (nextLogin) login = nextLogin
    },
    requests,
    graphqlRequests,
    downloads,
  }
  return { registry, handle }
}

// ── Backlog ──────────────────────────────────────────────────────────────────

/** An item as a test puts it in a Backlog: a title, and whatever else it needs (the rest is filled in). */
export type FakeBacklogItemInput = Partial<BacklogItemView> & { title: string; risk?: string }

/**
 * A workspace's Backlog, held in memory: what `getBacklogService` and the
 * renderer's Backlog reads and writes see, with the host's validation and the
 * `backlog.read` / `backlog.write` checks.
 */
export type FakeBacklog = {
  /** The items of a workspace's Backlog now (fresh copies). */
  items(workspaceId: string): BacklogItemView[]
  /** Replace a workspace's Backlog, as if its files were already there; watchers hear it. */
  seed(workspaceId: string, items: readonly FakeBacklogItemInput[]): void
  /** Where the Backlog lives (default `<folder>/backlog`, `isDefault`, `exists`). `exists: false` lists no items. */
  setLocation(workspaceId: string, location: Partial<ModuleBacklogLocation>): void
  /** The workspace key display ids are made with (`MC` gives `MC-240`). Default: none, so no `displayId`. */
  setKey(workspaceId: string, key: string | null): void
  /**
   * Make the Backlog unreadable (a broken file): `list` answers
   * `backlog_unavailable` and watchers hear `scan_failed` until it is cleared
   * with null.
   */
  failScan(workspaceId: string, message: string | null): void
  /**
   * Hear a workspace's Backlog as the Backlog panel does: once now, then on
   * every change. `onError` hears why a snapshot could not be delivered. What
   * `RendererHost.watchBacklogItems` is built on.
   */
  watch(
    workspaceId: string,
    cb: (items: BacklogItemView[]) => void,
    onError?: (error: BacklogWatchError) => void,
  ): () => void
}

const BACKLOG_STATUSES: ReadonlySet<string> = new Set<BacklogItemStatus>([
  'idea',
  'ready',
  'in_progress',
  'needs_input',
  'completed',
  'archived',
])
// The app's vocabulary (shared/backlog/scan.ts): a value outside it is refused, never guessed.
const BACKLOG_TYPES: ReadonlySet<string> = new Set(['epic', 'feature', 'bug', 'mockup', 'spike'])
const BACKLOG_DIFFICULTIES: ReadonlySet<string> = new Set(['xs', 's', 'm', 'l', 'xl'])
const BACKLOG_CRITICALITIES: ReadonlySet<string> = new Set(['low', 'normal', 'high', 'critical'])
const BACKLOG_RISKS: ReadonlySet<string> = new Set(['low', 'normal', 'high'])
const BACKLOG_LINK_TYPES: ReadonlySet<string> = new Set([
  'execution',
  'issue',
  'review',
  'artifact',
  'external',
  'agent',
])
const EPIC_SLUG = /^[a-z0-9][a-z0-9-]*$/
const MAX_BACKLOG_TITLE = 300
const MAX_BACKLOG_BODY = 256 * 1024

type StoredBacklogItem = BacklogItemView & { risk?: string; body: string }

function backlogRegistry(context: FakeServiceContext): { registry: object; handle: FakeBacklog } {
  const workspaces = context.workspaces as InternalWorkspaces
  const backlogs = new Map<string, StoredBacklogItem[]>()
  const locations = new Map<string, Partial<ModuleBacklogLocation>>()
  const keys = new Map<string, string>()
  const scanFailures = new Map<string, string>()
  const watchers = new Set<{
    workspaceId: string
    cb: (items: BacklogItemView[]) => void
    onError?: (error: BacklogWatchError) => void
  }>()
  type BacklogFailure = Extract<ModuleBacklogResult, { ok: false }>

  const denied = (permission: 'backlog.read' | 'backlog.write'): BacklogFailure | null =>
    context.permissions.has(permission)
      ? null
      : failure(
          'permission_missing',
          `Module "${context.moduleId}" does not declare the "${permission}" permission, so it cannot ${
            permission === 'backlog.read' ? 'read' : 'change'
          } the Backlog.`,
        )
  const folderOf = (workspaceId: unknown): { folder: string } | BacklogFailure => {
    if (typeof workspaceId !== 'string' || !workspaceId.trim())
      return failure('invalid_input', 'A workspace id is required.')
    const workspace = workspaces.find(workspaceId)
    if (!workspace) return failure('unknown_workspace', `There is no open workspace "${workspaceId}".`)
    if (!workspace.folderPath) {
      return failure(
        'workspace_folder_missing',
        `Workspace "${workspaceId}" has no project folder, so it has no Backlog.`,
      )
    }
    return { folder: workspace.folderPath }
  }
  const locationOf = (workspaceId: string, folder: string): ModuleBacklogLocation => ({
    root: join(folder, 'backlog'),
    isDefault: true,
    exists: true,
    ...locations.get(workspaceId),
  })
  const listOf = (workspaceId: string): StoredBacklogItem[] => {
    let list = backlogs.get(workspaceId)
    if (!list) backlogs.set(workspaceId, (list = []))
    return list
  }
  const view = (item: StoredBacklogItem): BacklogItemView => {
    const { body: _body, ...rest } = item
    return structuredClone(rest)
  }
  // The file as the app would write it: frontmatter over the body.
  const render = (workspaceId: string, item: StoredBacklogItem): void => {
    const key = keys.get(workspaceId)
    if (key && item.numericId !== undefined) item.displayId = `${key}-${item.numericId}`
    const fields: Array<[string, unknown]> = [
      ['id', item.numericId],
      ['title', item.title],
      ['status', item.status],
      ['type', item.type],
      ['epic', item.epic],
      ['difficulty', item.difficulty],
      ['criticality', item.criticality],
      ['risk', item.risk],
    ]
    const frontmatter = fields
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => `${name}: ${String(value)}`)
    item.sourceContent = `---\n${frontmatter.join('\n')}\n---\n${item.body ? `\n${item.body}\n` : ''}`
    item.excerpt =
      item.body
        .split('\n')
        .find((line) => line.trim())
        ?.trim() ?? ''
  }
  const nextNumber = (workspaceId: string): number =>
    Math.max(0, ...listOf(workspaceId).map((item) => item.numericId ?? 0)) + 1
  const snapshot = (workspaceId: string): { items: BacklogItemView[] } | BacklogWatchError => {
    const workspace = workspaces.find(workspaceId)
    if (!workspace) return { code: 'unknown_workspace', message: `There is no open workspace "${workspaceId}".` }
    if (!workspace.folderPath) {
      return { code: 'workspace_folder_missing', message: `Workspace "${workspaceId}" has no project folder.` }
    }
    const scanFailure = scanFailures.get(workspaceId)
    if (scanFailure) return { code: 'scan_failed', message: scanFailure }
    if (!locationOf(workspaceId, workspace.folderPath).exists) return { items: [] }
    return { items: listOf(workspaceId).map(view) }
  }
  const deliver = (watcher: {
    workspaceId: string
    cb: (items: BacklogItemView[]) => void
    onError?: (error: BacklogWatchError) => void
  }): void => {
    const now = snapshot(watcher.workspaceId)
    if ('items' in now) watcher.cb(now.items)
    else watcher.onError?.(now)
  }
  const changed = (workspaceId: string): void => {
    for (const watcher of [...watchers]) if (watcher.workspaceId === workspaceId) deliver(watcher)
  }
  const make = (
    workspaceId: string,
    folder: string,
    input: FakeBacklogItemInput,
    numericId: number,
  ): StoredBacklogItem => {
    const slug =
      input.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'item'
    const taken = new Set(listOf(workspaceId).map((item) => item.relativePath))
    const base = `backlog/${input.epic ? `${input.epic}/` : ''}${slug}`
    let relativePath = input.relativePath ?? `${base}.md`
    for (let n = 2; !input.relativePath && taken.has(relativePath); n += 1) relativePath = `${base}-${n}.md`
    const body = input.sourceContent
      ? input.sourceContent.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()
      : (input.excerpt ?? '')
    const item: StoredBacklogItem = {
      metadata: {},
      links: [],
      excerpt: '',
      sourceContent: '',
      status: 'idea',
      numericId,
      modifiedAt: context.now(),
      ...structuredClone(input),
      id: input.id ?? relativePath,
      relativePath,
      path: input.path ?? join(locationOf(workspaceId, folder).root, relativePath.replace(/^backlog\//, '')),
      body,
    }
    render(workspaceId, item)
    if (input.sourceContent !== undefined) item.sourceContent = input.sourceContent
    return item
  }
  // A write to one existing item: the permission, the workspace, the item, then the change.
  const mutate = async (
    workspaceId: string,
    itemId: unknown,
    change: (item: StoredBacklogItem) => void,
  ): Promise<ModuleBacklogResult> => {
    const refused = denied('backlog.write')
    if (refused) return refused
    const resolved = folderOf(workspaceId)
    if ('ok' in resolved) return resolved
    if (typeof itemId !== 'string' || !itemId.trim()) return failure('invalid_input', 'An item id is required.')
    const item = listOf(workspaceId).find((entry) => entry.id === itemId.trim())
    if (!item) return failure('not_found', `There is no Backlog item "${itemId}" in this workspace.`)
    change(item)
    item.modifiedAt = context.now()
    render(workspaceId, item)
    changed(workspaceId)
    return { ok: true }
  }

  const registry = {
    async list(_m: string, workspaceId: string): Promise<ModuleBacklogResult<{ items: BacklogItemView[] }>> {
      const refused = denied('backlog.read')
      if (refused) return refused
      const resolved = folderOf(workspaceId)
      if ('ok' in resolved) return resolved
      const scanFailure = scanFailures.get(workspaceId)
      if (scanFailure) return failure('backlog_unavailable', `The Backlog could not be read: ${scanFailure}`)
      if (!locationOf(workspaceId, resolved.folder).exists) return { ok: true, items: [] }
      return { ok: true, items: listOf(workspaceId).map(view) }
    },
    async getLocation(
      _m: string,
      workspaceId: string,
    ): Promise<ModuleBacklogResult<{ location: ModuleBacklogLocation }>> {
      const refused = denied('backlog.read')
      if (refused) return refused
      const resolved = folderOf(workspaceId)
      if ('ok' in resolved) return resolved
      return { ok: true, location: locationOf(workspaceId, resolved.folder) }
    },
    async create(_m: string, workspaceId: string, input: ModuleBacklogCreateInput) {
      const refused = denied('backlog.write')
      if (refused) return refused
      const resolved = folderOf(workspaceId)
      if ('ok' in resolved) return resolved
      const invalid = invalidBacklogCreate(input)
      if (invalid) return failure('invalid_input', invalid)
      const numericId = nextNumber(workspaceId)
      const item = make(
        workspaceId,
        resolved.folder,
        {
          title: input.title.trim(),
          status: input.status ?? 'idea',
          excerpt: input.body?.trim() ?? '',
          ...(input.type ? { type: input.type } : {}),
          ...(input.epic ? { epic: input.epic } : {}),
          ...(input.difficulty ? { difficulty: input.difficulty } : {}),
          ...(input.criticality ? { criticality: input.criticality } : {}),
          ...(input.risk ? { risk: input.risk } : {}),
        },
        numericId,
      )
      listOf(workspaceId).push(item)
      changed(workspaceId)
      return {
        ok: true as const,
        id: item.id,
        relativePath: item.relativePath,
        path: item.path,
        numericId,
        ...(item.displayId ? { displayId: item.displayId } : {}),
      }
    },
    updateStatus(_m: string, workspaceId: string, itemId: string, status: BacklogItemStatus) {
      if (typeof status !== 'string' || !BACKLOG_STATUSES.has(status)) {
        return Promise.resolve(failure('invalid_input', `"${String(status)}" is not a Backlog item status.`))
      }
      return mutate(workspaceId, itemId, (item) => {
        item.status = status
      })
    },
    updateTriage(_m: string, workspaceId: string, itemId: string, triage: ModuleBacklogTriageInput) {
      const invalid = invalidBacklogTriage(triage)
      if (invalid) return Promise.resolve(failure('invalid_input', invalid))
      return mutate(workspaceId, itemId, (item) => {
        for (const axis of ['difficulty', 'criticality', 'risk'] as const) {
          if (!(axis in triage)) continue
          const value = triage[axis]
          if (value == null) delete item[axis]
          else item[axis] = value
        }
      })
    },
    addLink(moduleId: string, workspaceId: string, itemId: string, link: ModuleBacklogLinkInput) {
      const invalid = invalidBacklogLink(moduleId, link)
      if (invalid) return Promise.resolve(failure('invalid_input', invalid))
      return mutate(workspaceId, itemId, (item) => {
        // The owner is the caller, whatever the link said.
        const owned: BacklogItemLink = { ...structuredClone(link), moduleId }
        const index = item.links.findIndex((existing) => existing.id === owned.id)
        if (index === -1) item.links.push(owned)
        else item.links[index] = owned
      })
    },
    updateModuleMetadata(moduleId: string, workspaceId: string, itemId: string, value: unknown) {
      try {
        if (value !== undefined) JSON.stringify(value)
      } catch {
        return Promise.resolve(failure('invalid_input', 'Module metadata must be JSON-serializable.'))
      }
      return mutate(workspaceId, itemId, (item) => {
        if (value === undefined) delete item.metadata[moduleId]
        else item.metadata[moduleId] = JSON.parse(JSON.stringify(value)) as unknown
      })
    },
  }

  const handle: FakeBacklog = {
    items: (workspaceId) => listOf(workspaceId).map(view),
    seed(workspaceId, items) {
      const folder = workspaces.find(workspaceId)?.folderPath ?? '/'
      backlogs.set(workspaceId, [])
      for (const input of items)
        listOf(workspaceId).push(make(workspaceId, folder, input, input.numericId ?? nextNumber(workspaceId)))
      changed(workspaceId)
    },
    setLocation(workspaceId, location) {
      locations.set(workspaceId, { ...locations.get(workspaceId), ...location })
      changed(workspaceId)
    },
    setKey(workspaceId, key) {
      if (key) keys.set(workspaceId, key)
      else keys.delete(workspaceId)
      for (const item of listOf(workspaceId)) {
        if (!key) delete item.displayId
        render(workspaceId, item)
      }
      changed(workspaceId)
    },
    failScan(workspaceId, message) {
      if (message) scanFailures.set(workspaceId, message)
      else scanFailures.delete(workspaceId)
      changed(workspaceId)
    },
    watch(workspaceId, cb, onError) {
      const watcher = { workspaceId, cb, ...(onError ? { onError } : {}) }
      watchers.add(watcher)
      deliver(watcher)
      return () => {
        watchers.delete(watcher)
      }
    },
  }
  return { registry, handle }
}

function invalidBacklogCreate(input: unknown): string | null {
  const value = input as Record<string, unknown> | null
  if (!value || typeof value !== 'object') return 'The new item is required.'
  if (typeof value.title !== 'string' || !value.title.trim()) return 'A title is required.'
  if (value.title.length > MAX_BACKLOG_TITLE) return `A title is at most ${MAX_BACKLOG_TITLE} characters.`
  if (value.body !== undefined && typeof value.body !== 'string') return '"body" must be a string.'
  if (typeof value.body === 'string' && value.body.length > MAX_BACKLOG_BODY) return 'The body is too long.'
  if (value.status !== undefined && (typeof value.status !== 'string' || !BACKLOG_STATUSES.has(value.status))) {
    return `"${String(value.status)}" is not a Backlog item status.`
  }
  if (value.status === 'archived') return 'A new item cannot start archived.'
  if (value.type !== undefined && !BACKLOG_TYPES.has(value.type as string))
    return `"${String(value.type)}" is not a Backlog type.`
  if (value.epic !== undefined && (typeof value.epic !== 'string' || !EPIC_SLUG.test(value.epic))) {
    return `"${String(value.epic)}" is not an epic slug.`
  }
  if (value.difficulty !== undefined && !BACKLOG_DIFFICULTIES.has(value.difficulty as string)) {
    return `"${String(value.difficulty)}" is not a difficulty.`
  }
  if (value.criticality !== undefined && !BACKLOG_CRITICALITIES.has(value.criticality as string)) {
    return `"${String(value.criticality)}" is not a criticality.`
  }
  if (value.risk !== undefined && !BACKLOG_RISKS.has(value.risk as string))
    return `"${String(value.risk)}" is not a risk.`
  return null
}

function invalidBacklogTriage(triage: unknown): string | null {
  const value = triage as Record<string, unknown> | null
  if (!value || typeof value !== 'object') return 'The triage to change is required.'
  if (value.difficulty != null && !BACKLOG_DIFFICULTIES.has(value.difficulty as string)) {
    return `"${String(value.difficulty)}" is not a difficulty.`
  }
  if (value.criticality != null && !BACKLOG_CRITICALITIES.has(value.criticality as string)) {
    return `"${String(value.criticality)}" is not a criticality.`
  }
  if (value.risk != null && !BACKLOG_RISKS.has(value.risk as string)) return `"${String(value.risk)}" is not a risk.`
  return null
}

function invalidBacklogLink(moduleId: string, link: unknown): string | null {
  const value = link as Record<string, unknown> | null
  if (!value || typeof value !== 'object') return 'The link is required.'
  if (value.moduleId !== undefined && value.moduleId !== moduleId) {
    return `A module records links as itself; "${String(value.moduleId)}" is not "${moduleId}".`
  }
  if (typeof value.id !== 'string' || !value.id.trim()) return 'A link id is required.'
  if (typeof value.type !== 'string' || !BACKLOG_LINK_TYPES.has(value.type))
    return `"${String(value.type)}" is not a link type.`
  if (typeof value.label !== 'string') return 'A link label is required.'
  const target = value.target as Record<string, unknown> | null
  if (!target || typeof target !== 'object' || typeof target.kind !== 'string' || typeof target.id !== 'string') {
    return 'A link target needs a kind and an id.'
  }
  return null
}

// ── Usage ────────────────────────────────────────────────────────────────────

/**
 * Token usage a session spent, as the host's scan would have found it: one
 * hour of one session on one model. Only `at` is required.
 */
export type FakeUsageRecord = {
  /** When (epoch ms); counted in the hour it falls in, as the host keeps usage to the hour. */
  at: number
  /** Default `claude-sonnet-4-5`. */
  model?: string
  /** Default `claude-agent`. */
  providerId?: string
  /** Default null: a session no open workspace holds. */
  workspaceId?: string | null
  /** Default `session-1`. */
  sessionId?: string
  agentId?: string
  chatTitle?: string | null
  tokens?: Partial<UsageTokens>
  /** Default 1. */
  requests?: number
  reportedCostUsd?: number | null
}

/** The usage the host has read off this machine's session logs, and the levers that change it. */
export type FakeUsage = {
  /** Add usage, as a scan that found new turns would; `onChanged` listeners hear it. */
  record(...records: FakeUsageRecord[]): void
  /** What `sources` answers. Default: the three sources, nothing found, no error. */
  setSources(sources: UsageSource[]): void
  /** Every query, in order. */
  readonly queries: UsageQuery[]
}

const USAGE_GROUP_BY: ReadonlySet<string> = new Set<UsageGroupBy>(['day', 'model', 'workspace', 'session', 'provider'])
const HOUR_MS = 3_600_000

function usageDay(hourMs: number): string {
  const date = new Date(hourMs)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function usageRegistry(context: FakeServiceContext): { registry: object; handle: FakeUsage } {
  const records: FakeUsageRecord[] = []
  const listeners = new Set<() => void>()
  const queries: UsageQuery[] = []
  let scannedAt: number | null = null
  let sources: UsageSource[] = [
    { id: 'studio', found: 0, error: null },
    { id: 'claude-code', found: 0, error: null },
    { id: 'codex', found: 0, error: null },
  ]
  const permitted = (): boolean => context.permissions.has('usage:read')
  const invalid = (input: UsageQuery): string | null => {
    if (!input || typeof input !== 'object') return 'A query is required.'
    if (typeof input.from !== 'number' || !Number.isFinite(input.from)) return '"from" must be a time in epoch ms.'
    if (typeof input.to !== 'number' || !Number.isFinite(input.to)) return '"to" must be a time in epoch ms.'
    if (input.to <= input.from) return '"to" must be after "from".'
    if (input.groupBy !== undefined) {
      if (!Array.isArray(input.groupBy)) return '"groupBy" must be a list.'
      const unknown = input.groupBy.find((dimension) => !USAGE_GROUP_BY.has(dimension))
      if (unknown !== undefined) return `"${String(unknown)}" is not a usage dimension.`
    }
    return null
  }
  // Summed over the window and the dimensions asked for, as the host sums them.
  const aggregate = (query: UsageQuery): UsageRow[] => {
    const groupBy = new Set(query.groupBy ?? [])
    const rows = new Map<string, UsageRow>()
    for (const record of records) {
      const hour = Math.floor(record.at / HOUR_MS) * HOUR_MS
      if (hour < query.from || hour >= query.to) continue
      const model = record.model ?? 'claude-sonnet-4-5'
      const providerId = record.providerId ?? 'claude-agent'
      const workspaceId = record.workspaceId ?? null
      const sessionId = record.sessionId ?? 'session-1'
      const day = groupBy.has('day') ? usageDay(hour) : undefined
      const key = JSON.stringify([
        day,
        groupBy.has('model') ? model : undefined,
        groupBy.has('provider') ? providerId : undefined,
        groupBy.has('workspace') ? workspaceId : undefined,
        groupBy.has('session') ? sessionId : undefined,
      ])
      let row = rows.get(key)
      if (!row) {
        row = {
          ...(day !== undefined ? { day } : {}),
          ...(groupBy.has('model') ? { model } : {}),
          ...(groupBy.has('provider') ? { providerId } : {}),
          ...(groupBy.has('workspace') ? { workspaceId } : {}),
          ...(groupBy.has('session')
            ? { sessionId, ...(record.agentId ? { agentId: record.agentId } : {}), chatTitle: record.chatTitle ?? null }
            : {}),
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          requests: 0,
          reportedCostUsd: null,
        }
        rows.set(key, row)
      }
      row.tokens.input += record.tokens?.input ?? 0
      row.tokens.output += record.tokens?.output ?? 0
      row.tokens.cacheRead += record.tokens?.cacheRead ?? 0
      row.tokens.cacheWrite += record.tokens?.cacheWrite ?? 0
      row.requests += record.requests ?? 1
      if (typeof record.reportedCostUsd === 'number') {
        row.reportedCostUsd = (row.reportedCostUsd ?? 0) + record.reportedCostUsd
      }
    }
    const total = (row: UsageRow): number =>
      row.tokens.input + row.tokens.output + row.tokens.cacheRead + row.tokens.cacheWrite
    return [...rows.values()].sort((a, b) => (a.day ?? '').localeCompare(b.day ?? '') || total(b) - total(a))
  }

  const registry = {
    async query(moduleId: string, query: UsageQuery): Promise<UsageQueryResult> {
      if (!permitted()) {
        return {
          ok: false,
          code: 'permission_missing',
          message: `Module "${moduleId}" does not declare the "usage:read" permission, so it cannot read token usage.`,
        }
      }
      const problem = invalid(query)
      if (problem) return { ok: false, code: 'invalid_input', message: problem }
      queries.push(structuredClone(query))
      // The first query waits for the first read, so it never answers unscanned.
      scannedAt ??= context.now()
      return { ok: true, rows: aggregate(query), scannedAt, sources: structuredClone(sources) }
    },
    onChanged(moduleId: string, listener: () => void): () => void {
      if (!permitted()) {
        throw new Error(
          `Module "${moduleId}" does not declare the "usage:read" permission, so it cannot watch token usage.`,
        )
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const handle: FakeUsage = {
    record(...added) {
      records.push(...structuredClone(added))
      scannedAt = context.now()
      for (const listener of [...listeners]) listener()
    },
    setSources(next) {
      sources = structuredClone(next)
    },
    queries,
  }
  return { registry, handle }
}

// ── Activity ─────────────────────────────────────────────────────────────────

/** The person's Studio chats and what they typed in them, as the activity service reads them. */
export type FakeActivity = {
  /**
   * Add (or replace, by workspace and agent id) one of the person's chats.
   * Defaults: title `Chat`, Claude Code, `turnCount` 1, status `ready`,
   * created and updated now. Only chats in an open workspace are listed, as
   * on the host.
   */
  addChat(chat: Partial<ActivityChatSummary> & { workspaceId: string; agentId: string }): void
  /** Add a message the person sent (with the tail of the reply, if any). */
  addPrompt(prompt: ActivityPrompt): void
  /** Every chat added, open workspace or not. */
  chats(): ActivityChatSummary[]
}

const ACTIVITY_DEFAULT_LIMIT = 200
const ACTIVITY_MAX_LIMIT = 1000

function activityRegistry(context: FakeServiceContext): { registry: object; handle: FakeActivity } {
  const workspaces = context.workspaces as InternalWorkspaces
  const chats = new Map<string, ActivityChatSummary>()
  const prompts: ActivityPrompt[] = []
  const denied = () =>
    context.permissions.has('conversation:read-all')
      ? null
      : failure(
          'permission_missing',
          `Module "${context.moduleId}" does not declare the "conversation:read-all" permission, so it cannot read your chats.`,
        )
  const invalidWindow = (from: unknown, to: unknown, required: boolean): string | null => {
    for (const [name, value] of [
      ['from', from],
      ['to', to],
    ] as const) {
      if (value === undefined && !required) continue
      if (typeof value !== 'number' || !Number.isFinite(value)) return `"${name}" must be a time in epoch ms.`
    }
    if (typeof from === 'number' && typeof to === 'number' && to <= from) return '"to" must be after "from".'
    return null
  }
  const invalidWorkspace = (workspaceId: unknown): string | null =>
    workspaceId === undefined || (typeof workspaceId === 'string' && workspaceId.trim())
      ? null
      : '"workspaceId" must be a workspace id.'
  // Chats in a closed workspace are not reachable, as on the host.
  const reachable = (workspaceId: string, only?: string): boolean =>
    (only === undefined || workspaceId === only) && workspaces.find(workspaceId) !== undefined

  const registry = {
    async listChats(_m: string, input?: ActivityListChatsInput) {
      const refused = denied()
      if (refused) return refused
      const invalid = invalidWindow(input?.from, input?.to, false) ?? invalidWorkspace(input?.workspaceId)
      if (invalid) return failure('invalid_input', invalid)
      const listed = [...chats.values()]
        .filter((chat) => reachable(chat.workspaceId, input?.workspaceId))
        .filter(
          (chat) =>
            (input?.from === undefined || chat.updatedAt >= input.from) &&
            (input?.to === undefined || chat.createdAt < input.to),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
      return { ok: true as const, chats: structuredClone(listed) }
    },
    async prompts(_m: string, input: ActivityPromptsInput) {
      const refused = denied()
      if (refused) return refused
      const limitIssue =
        input?.limit === undefined ||
        (typeof input.limit === 'number' &&
          Number.isInteger(input.limit) &&
          input.limit > 0 &&
          input.limit <= ACTIVITY_MAX_LIMIT)
          ? null
          : `"limit" must be a whole number from 1 to ${ACTIVITY_MAX_LIMIT}.`
      const invalid = invalidWindow(input?.from, input?.to, true) ?? invalidWorkspace(input?.workspaceId) ?? limitIssue
      if (invalid) return failure('invalid_input', invalid)
      const limit = input.limit ?? ACTIVITY_DEFAULT_LIMIT
      const found = prompts
        .filter((prompt) => reachable(prompt.workspaceId, input.workspaceId))
        .filter((prompt) => prompt.at >= input.from && prompt.at < input.to)
        .sort((a, b) => a.at - b.at)
      const truncated = found.length > limit
      return { ok: true as const, prompts: structuredClone(truncated ? found.slice(-limit) : found), truncated }
    },
  }
  const handle: FakeActivity = {
    addChat(chat) {
      const at = context.now()
      chats.set(`${chat.workspaceId}\u0000${chat.agentId}`, {
        title: 'Chat',
        cli: 'claude-code',
        providerId: 'claude-agent',
        model: 'claude-sonnet-4-5',
        createdAt: at,
        updatedAt: at,
        turnCount: 1,
        status: 'ready',
        ...structuredClone(chat),
      })
    },
    addPrompt(prompt) {
      prompts.push(structuredClone(prompt))
    },
    chats: () => structuredClone([...chats.values()]),
  }
  return { registry, handle }
}

// ── Text generation ──────────────────────────────────────────────────────────

/** One `generate` call, as the fake resolved it: what was asked, and the runtime and model that answer. */
export type FakeTextGenerationCall = {
  input: ModuleTextGenerationInput
  cli: 'claude-code' | 'codex'
  model: string
}

/**
 * A scripted answer: the text, or the whole answer (with `usage` and `model`),
 * or a failure (`{ ok: false, code: 'timeout', message }`, …). May be a
 * promise, to hold a call open while a test fills the module's lane.
 */
export type FakeTextGenerationReply =
  | string
  | { ok?: true; text: string; usage?: ModuleConversationTurnUsage; model?: string }
  | Extract<ModuleTextGenerationResult, { ok: false }>

/** The person's agent CLI answering prompts in the background, as scripted answers. */
export type FakeTextGeneration = {
  /**
   * What a call answers. Unscripted: `invalid_output`, as a model that said
   * nothing usable. With `json: true`, the reply's JSON value is read out of
   * the text (a fence or prose around it is dropped) and `text` is that value
   * serialised; no JSON answers `invalid_output`.
   */
  respond(answer: (call: FakeTextGenerationCall) => FakeTextGenerationReply | Promise<FakeTextGenerationReply>): void
  /**
   * The runtime (and model) a call that names no `cli` answers on, as the
   * person's text-generation setting chooses it. Default: Claude Code on its
   * small model.
   */
  setPreferred(engine: { cli: 'claude-code' | 'codex'; model?: string }): void
  /** Every call that reached the model, in order (refused ones did not). */
  readonly calls: FakeTextGenerationCall[]
}

// The host's bounds and lane (main/text-generation/module-text-generation.ts in the app).
const TEXT_CLIS: ReadonlySet<string> = new Set(['claude-code', 'codex'])
const TEXT_DEFAULT_MODELS: Readonly<Record<string, string>> = {
  'claude-code': 'claude-haiku-5-5',
  codex: 'gpt-5.6-luna',
}
const MAX_TEXT_PROMPT_CHARS = 400_000
const MAX_TEXT_SYSTEM_CHARS = 40_000
const MAX_TEXT_OUTPUT_TOKENS = 64_000
const TEXT_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,199}$/
const TEXT_MAX_RUNNING = 2
const TEXT_MAX_WAITING = 8
const TEXT_RATE_WINDOW_MS = 60_000
const TEXT_MAX_CALLS_PER_WINDOW = 30

// The JSON value in a reply: the whole text, a fenced block, or the first
// object or array in it.
function jsonIn(text: string): unknown {
  const attempts = [text.trim()]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text)
  if (fenced?.[1]) attempts.push(fenced[1].trim())
  const start = text.search(/[[{]/u)
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  if (start !== -1 && end > start) attempts.push(text.slice(start, end + 1))
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as unknown
    } catch {
      // the next reading
    }
  }
  return undefined
}

function textGenerationRegistry(context: FakeServiceContext): { registry: object; handle: FakeTextGeneration } {
  const calls: FakeTextGenerationCall[] = []
  let answer: Parameters<FakeTextGeneration['respond']>[0] = () => ({
    ok: false,
    code: 'invalid_output',
    message: 'No scripted answer (services.textGeneration.respond).',
  })
  let preferred: { cli: 'claude-code' | 'codex'; model?: string } = { cli: 'claude-code' }
  const lane = { running: 0, waiting: [] as Array<() => void>, calls: [] as number[] }
  const refuse = (code: ModuleTextGenerationErrorCode, message: string): ModuleTextGenerationResult => ({
    ok: false,
    code,
    message,
  })
  const invalid = (input: ModuleTextGenerationInput): string | null => {
    if (typeof input !== 'object' || input === null) return 'generate takes an object.'
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) return '"prompt" is required.'
    if (input.prompt.length > MAX_TEXT_PROMPT_CHARS)
      return `"prompt" is longer than ${MAX_TEXT_PROMPT_CHARS} characters.`
    if (input.system !== undefined && (typeof input.system !== 'string' || input.system.length > MAX_TEXT_SYSTEM_CHARS))
      return `"system" must be a string of at most ${MAX_TEXT_SYSTEM_CHARS} characters.`
    if (input.model !== undefined && (typeof input.model !== 'string' || !TEXT_MODEL_ID.test(input.model.trim())))
      return '"model" must be a model id, such as "claude-haiku-4-5" or "haiku".'
    if (
      input.maxOutputTokens !== undefined &&
      !(
        Number.isSafeInteger(input.maxOutputTokens) &&
        input.maxOutputTokens >= 1 &&
        input.maxOutputTokens <= MAX_TEXT_OUTPUT_TOKENS
      )
    )
      return `"maxOutputTokens" must be a whole number from 1 to ${MAX_TEXT_OUTPUT_TOKENS}.`
    if (input.json !== undefined && typeof input.json !== 'boolean') return '"json" must be true or false.'
    if (input.cli !== undefined && typeof input.cli !== 'string') return '"cli" must be a chat runtime id.'
    return null
  }
  // A place in the module's lane, or why there is none.
  const enter = async (): Promise<string | null> => {
    const at = context.now()
    lane.calls = lane.calls.filter((call) => call > at - TEXT_RATE_WINDOW_MS)
    if (lane.calls.length >= TEXT_MAX_CALLS_PER_WINDOW) {
      return `This module asked for more than ${TEXT_MAX_CALLS_PER_WINDOW} answers in a minute; try again shortly.`
    }
    if (lane.running >= TEXT_MAX_RUNNING && lane.waiting.length >= TEXT_MAX_WAITING) {
      return `This module already has ${TEXT_MAX_RUNNING + TEXT_MAX_WAITING} prompts running or waiting; try again when one has answered.`
    }
    lane.calls.push(at)
    if (lane.running >= TEXT_MAX_RUNNING) await new Promise<void>((resolve) => lane.waiting.push(resolve))
    lane.running += 1
    return null
  }
  const leave = (): void => {
    lane.running -= 1
    lane.waiting.shift()?.()
  }

  const registry = {
    async generate(_m: string, input: ModuleTextGenerationInput): Promise<ModuleTextGenerationResult> {
      if (!context.permissions.has('agents:generate')) {
        return refuse(
          'permission_missing',
          `Module "${context.moduleId}" must declare the "agents:generate" permission.`,
        )
      }
      const problem = invalid(input)
      if (problem) return refuse('invalid_input', problem)
      const cli = input.cli?.trim() || preferred.cli
      if (!TEXT_CLIS.has(cli)) {
        return refuse(
          'unsupported',
          `"${cli}" cannot answer a prompt headlessly here; use "claude-code" or "codex", or leave "cli" out.`,
        )
      }
      const model =
        input.model?.trim() || (cli === preferred.cli && preferred.model ? preferred.model : TEXT_DEFAULT_MODELS[cli]!)
      const refused = await enter()
      if (refused) return refuse('busy', refused)
      try {
        const call: FakeTextGenerationCall = {
          input: structuredClone(input),
          cli: cli as 'claude-code' | 'codex',
          model,
        }
        calls.push(call)
        const raw = await answer(structuredClone(call))
        const reply = typeof raw === 'string' ? { text: raw } : raw
        if (reply.ok === false) return structuredClone(reply)
        if (!reply.text.trim()) return refuse('invalid_output', 'The model answered with nothing.')
        const usage = structuredClone(reply.usage ?? {})
        const answeredBy = reply.model ?? model
        if (!input.json) return { ok: true, text: reply.text, usage, model: answeredBy }
        const value = jsonIn(reply.text)
        if (value === undefined) return refuse('invalid_output', 'The model did not answer with JSON.')
        return { ok: true, text: JSON.stringify(value), usage, model: answeredBy }
      } finally {
        leave()
      }
    },
  }
  const handle: FakeTextGeneration = {
    respond(next) {
      answer = next
    },
    setPreferred(engine) {
      preferred = { ...engine }
    },
    calls,
  }
  return { registry, handle }
}

// ── The registry of fakes ────────────────────────────────────────────────────

/** The handle of every built-in service fake, by name. */
export type FakeServices = {
  workspaces: FakeWorkspaces
  storage: FakeStorage
  conversations: FakeConversations
  scheduledAgents: FakeScheduledAgents
  companions: FakeCompanions
  secrets: FakeSecrets
  github: FakeGitHub
  backlog: FakeBacklog
  usage: FakeUsage
  activity: FakeActivity
  textGeneration: FakeTextGeneration
}

/** How a service's fake is made. */
export type FakeServiceDefinition = {
  /** Where its handle lands on `FakeServices`; null for a service whose state another fake owns. */
  name: keyof FakeServices | null
  create(context: FakeServiceContext): { registry: object; handle?: unknown }
}

/**
 * One fake per service key the SDK publishes (MODULE_SERVICE_REQUIREMENTS).
 * A service added to the host gets its fake here, keyed the same way.
 */
export const SERVICE_FAKES: Readonly<Record<string, FakeServiceDefinition>> = {
  'core.workspace': {
    name: null,
    create: (context) => ({ registry: workspaceServiceRegistry(context.workspaces as InternalWorkspaces) }),
  },
  'core.workspace-context': {
    name: null,
    create: (context) => ({ registry: workspaceContextRegistry(context.workspaces as InternalWorkspaces) }),
  },
  'core.module-storage': { name: 'storage', create: storageRegistry },
  'conversation.module-service': { name: 'conversations', create: conversationsRegistry },
  'scheduled-agents.module-service': { name: 'scheduledAgents', create: scheduledAgentsRegistry },
  'companion-agents.module-service': { name: 'companions', create: companionsRegistry },
  'module-secrets.module-service': { name: 'secrets', create: secretsRegistry },
  'github.module-service': { name: 'github', create: githubRegistry },
  'backlog.module-service': { name: 'backlog', create: backlogRegistry },
  'usage.module-service': { name: 'usage', create: usageRegistry },
  'activity.module-service': { name: 'activity', create: activityRegistry },
  'text-generation.module-service': { name: 'textGeneration', create: textGenerationRegistry },
}
