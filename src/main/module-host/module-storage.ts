import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { isAbsolute, join } from 'path'
import { workspaceStorePath, workspaceStoreReady } from '../workspace-store'

// Per-module, per-workspace JSON storage for capability modules (SDK
// getModuleStorage). The host owns file placement so modules stop inventing
// locations: workspace-scoped keys live in the project's store in the person's
// home (`<store>/modules/<moduleId>/<key>.json`, workspace-store.ts — never in
// the project's folder, and one per project, whichever checkout asks), global keys
// under userData (`<userData>/module-storage/<moduleId>/<key>.json`). The
// registry takes the module id on every call; the SDK helper closes over
// `host.moduleId` (same scoping structure as the Automations module service).
// Disclosure permission: `storage` (install-time, like every v1 scope).
//
// Beyond one key at a time: `list({ prefix })` and `getMany` read a scope in
// one call, and `watch` says which keys changed — on this module's own writes
// at once, and on anything else that changed the folder (another window's
// process, a hand edit) at the next poll.
//
// Older builds kept workspace keys in `<project>/.sprintengine/modules/`. The
// store's one-time move takes them out, except files git tracks: a project
// that committed a module's data keeps those files, and the module no longer
// reads them. Data too large for a value goes in the
// module's private directory (`dataDir`), which is the module's to lay out.

export type ModuleStorageErrorCode =
  'invalid_key' | 'invalid_value' | 'value_too_large' | 'invalid_workspace_root' | 'io_error'

export type ModuleStorageResult<T> = ({ ok: true } & T) | { ok: false; code: ModuleStorageErrorCode; message: string }

type ModuleStorageScope = {
  /**
   * Absolute workspace folder for workspace-scoped keys; omit for the
   * module's global (per-user) store.
   */
  workspaceRoot?: string
}

export type ModuleStorageRegistry = {
  get(
    moduleId: string,
    input: ModuleStorageScope & { key: string },
  ): Promise<ModuleStorageResult<{ value: unknown; found: boolean }>>
  set(
    moduleId: string,
    input: ModuleStorageScope & { key: string; value: unknown },
  ): Promise<ModuleStorageResult<object>>
  delete(
    moduleId: string,
    input: ModuleStorageScope & { key: string },
  ): Promise<ModuleStorageResult<{ deleted: boolean }>>
  /** Keys in the scope, sorted; with `prefix`, only the keys that start with it. */
  list(
    moduleId: string,
    input?: ModuleStorageScope & { prefix?: string },
  ): Promise<ModuleStorageResult<{ keys: string[] }>>
  /** Several keys in one read: `values` holds the keys that are set; a key never set is absent from it. */
  getMany(
    moduleId: string,
    input: ModuleStorageScope & { keys: string[] },
  ): Promise<ModuleStorageResult<{ values: Record<string, unknown> }>>
  /**
   * Hear which keys of a scope changed. Returns the unsubscriber. A write
   * through this registry is reported at once; a change made any other way
   * (another window's process) at the next poll.
   */
  watch(moduleId: string, input: ModuleStorageScope, listener: (change: ModuleStorageChange) => void): () => void
  /**
   * The module's private directory under the app's per-user data, created on
   * demand and removed when the module is uninstalled — for caches and blobs
   * past the value limit. App-internal: modules reach it as
   * `MainHost.getModuleDataDir()`.
   */
  dataDir(moduleId: string): string
}

/** Which keys of a watched scope changed (were set or deleted), sorted. */
export type ModuleStorageChange = { keys: string[] }

// Keys are file names (minus `.json`), so the charset is locked down; 64 chars
// keeps paths portable. Module ids come from validated manifests, but they are
// path segments here too, so they get the same defensive check.
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
// Windows resolves these to device paths regardless of extension ("con.json"
// is still the console), so they are invalid keys on every platform — a key
// that only works off-Windows is not a portable contract.
const WINDOWS_RESERVED_KEY = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/
// Manifest ids allow uppercase per the manifest validator? They are used as
// folder names all over the module system already; reject only separators and
// traversal rather than re-validating the manifest grammar.
const UNSAFE_SEGMENT = /[\\/]|^\.\.?$/

export const MODULE_STORAGE_VALUE_LIMIT_BYTES = 1024 * 1024
/** At most this many keys in one `getMany`. */
export const MODULE_STORAGE_GET_MANY_LIMIT = 1000
/** How often a watched scope is re-read for changes made outside this registry. */
export const MODULE_STORAGE_WATCH_INTERVAL_MS = 2000
/** Where each module's private directory lives under the app's per-user data. */
export const MODULE_DATA_DIRECTORY = 'module-data'

function failure<T>(code: ModuleStorageErrorCode, message: string): ModuleStorageResult<T> {
  return { ok: false, code, message }
}

type ModuleStorageWatcher = {
  dir: string
  listener: (change: ModuleStorageChange) => void
  /** key -> mtime:size as last seen; null until the first scan settles. */
  seen: Map<string, string> | null
}

export function createModuleStorageRegistry(options: {
  userDataDir: () => string
  /** Poll interval override, for tests. */
  watchIntervalMs?: number
}): ModuleStorageRegistry {
  // One write chain serializes mutations so concurrent set/delete calls can't
  // interleave a temp-write with a rename (same discipline as trust-store).
  let writeChain: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(work)
    writeChain = run.catch(() => undefined)
    return run
  }

  const resolveDir = (
    moduleId: string,
    scope: ModuleStorageScope | undefined,
  ):
    | { ok: true; dir: string; workspaceRoot: string | null }
    | { ok: false; code: ModuleStorageErrorCode; message: string } => {
    if (UNSAFE_SEGMENT.test(moduleId) || moduleId.trim().length === 0) {
      return { ok: false, code: 'io_error', message: `Module id "${moduleId}" is not usable as a storage folder.` }
    }
    const workspaceRoot = scope?.workspaceRoot
    if (workspaceRoot !== undefined) {
      if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot)) {
        return {
          ok: false,
          code: 'invalid_workspace_root',
          message: 'workspaceRoot must be an absolute path (resolve it via the workspace context).',
        }
      }
      try {
        return { ok: true, dir: workspaceStorePath(workspaceRoot, 'modules', moduleId), workspaceRoot }
      } catch (error) {
        return { ok: false, code: 'invalid_workspace_root', message: (error as Error).message }
      }
    }
    return { ok: true, dir: join(options.userDataDir(), 'module-storage', moduleId), workspaceRoot: null }
  }

  // A workspace scope's first read after an upgrade waits out the store's
  // one-time move, so it sees the values the move brings in.
  const ready = async (dir: { workspaceRoot: string | null }): Promise<void> => {
    if (dir.workspaceRoot) await workspaceStoreReady(dir.workspaceRoot)
  }

  // Watchers share one timer: a poll re-reads each watched folder's listing
  // and reports the keys whose file changed, appeared or went away.
  const watchers = new Set<ModuleStorageWatcher>()
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let polling = false

  const scan = async (watcher: ModuleStorageWatcher): Promise<Map<string, string>> => {
    const seen = new Map<string, string>()
    let entries: string[]
    try {
      entries = await readdir(watcher.dir)
    } catch {
      return seen
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const key = entry.slice(0, -'.json'.length)
      if (!KEY_PATTERN.test(key)) continue
      try {
        const info = await stat(join(watcher.dir, entry))
        if (info.isFile()) seen.set(key, `${info.mtimeMs}:${info.size}`)
      } catch {
        // Gone between the listing and the stat: reported as deleted below.
      }
    }
    return seen
  }

  const deliver = (watcher: ModuleStorageWatcher, keys: string[]): void => {
    if (keys.length === 0 || !watchers.has(watcher)) return
    try {
      watcher.listener({ keys: [...new Set(keys)].sort() })
    } catch (error) {
      console.warn('[module-storage] a watch listener threw:', error)
    }
  }

  const pollOnce = async (): Promise<void> => {
    if (polling) return
    polling = true
    try {
      for (const watcher of [...watchers]) {
        const next = await scan(watcher)
        const previous = watcher.seen
        watcher.seen = next
        if (!previous) continue
        const changed: string[] = []
        for (const [key, signature] of next) if (previous.get(key) !== signature) changed.push(key)
        for (const key of previous.keys()) if (!next.has(key)) changed.push(key)
        deliver(watcher, changed)
      }
    } finally {
      polling = false
    }
  }

  // A write this registry made: heard at once by every watcher of that
  // folder, and folded into what the poll last saw so it is not heard twice.
  const announceOwnWrite = async (dir: string, key: string): Promise<void> => {
    const interested = [...watchers].filter((watcher) => watcher.dir === dir)
    if (interested.length === 0) return
    let signature: string | null = null
    try {
      const info = await stat(join(dir, `${key}.json`))
      signature = `${info.mtimeMs}:${info.size}`
    } catch {
      signature = null
    }
    for (const watcher of interested) {
      if (watcher.seen) {
        if (signature === null) watcher.seen.delete(key)
        else watcher.seen.set(key, signature)
      }
      deliver(watcher, [key])
    }
  }

  const readValue = async (
    dir: { dir: string },
    key: string,
  ): Promise<ModuleStorageResult<{ value: unknown; found: boolean }>> => {
    const path = join(dir.dir, `${key}.json`)
    let source: string
    try {
      source = await readFile(path, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: true, value: undefined, found: false }
      return failure('io_error', error instanceof Error ? error.message : String(error))
    }
    try {
      return { ok: true, value: JSON.parse(source) as unknown, found: true }
    } catch {
      // A corrupt record is an explicit error, never silently "missing" —
      // callers must not overwrite data the user might want to recover.
      return failure('io_error', `Stored value for "${key}" is not valid JSON.`)
    }
  }

  const validateKey = (key: string): string | null => {
    if (!KEY_PATTERN.test(key)) {
      return `Key "${key}" is invalid — keys match ${KEY_PATTERN} (lowercase alphanumerics, dot, dash, underscore; max 64 chars).`
    }
    if (WINDOWS_RESERVED_KEY.test(key)) {
      return `Key "${key}" is a reserved device name on Windows and cannot be used.`
    }
    return null
  }

  return {
    async get(moduleId, input) {
      const keyIssue = validateKey(input.key)
      if (keyIssue) return failure('invalid_key', keyIssue)
      const dir = resolveDir(moduleId, input)
      if (!dir.ok) return dir
      await ready(dir)
      return readValue(dir, input.key)
    },

    async getMany(moduleId, input) {
      const keys = (input as { keys?: unknown } | undefined)?.keys
      if (!Array.isArray(keys)) return failure('invalid_key', 'getMany takes { keys: string[] }.')
      if (keys.length > MODULE_STORAGE_GET_MANY_LIMIT) {
        return failure('invalid_key', `getMany reads at most ${MODULE_STORAGE_GET_MANY_LIMIT} keys at once.`)
      }
      for (const key of keys) {
        const keyIssue = typeof key === 'string' ? validateKey(key) : 'Every key must be a string.'
        if (keyIssue) return failure('invalid_key', keyIssue)
      }
      const dir = resolveDir(moduleId, input)
      if (!dir.ok) return dir
      await ready(dir)
      const values: Record<string, unknown> = {}
      for (const key of new Set(keys as string[])) {
        const read = await readValue(dir, key)
        if (!read.ok) return read
        if (read.found) values[key] = read.value
      }
      return { ok: true, values }
    },

    async set(moduleId, input) {
      const keyIssue = validateKey(input.key)
      if (keyIssue) return failure('invalid_key', keyIssue)
      const dir = resolveDir(moduleId, input)
      if (!dir.ok) return dir
      let serialized: string
      try {
        serialized = JSON.stringify(input.value)
      } catch (error) {
        return failure('invalid_value', error instanceof Error ? error.message : String(error))
      }
      if (serialized === undefined) {
        return failure('invalid_value', 'Value must be JSON-serializable (undefined is not).')
      }
      if (Buffer.byteLength(serialized, 'utf8') > MODULE_STORAGE_VALUE_LIMIT_BYTES) {
        return failure('value_too_large', `Value exceeds the ${MODULE_STORAGE_VALUE_LIMIT_BYTES / 1024 / 1024} MB cap.`)
      }
      return enqueue(async () => {
        const path = join(dir.dir, `${input.key}.json`)
        await ready(dir)
        try {
          await mkdir(dir.dir, { recursive: true })
          // A fresh name, created exclusively, so a write never lands in a
          // temp file something else left or made at that name.
          const tmp = `${path}.${process.pid}-${randomUUID()}.tmp`
          try {
            await writeFile(tmp, serialized, { encoding: 'utf8', flag: 'wx' })
            await rename(tmp, path)
          } catch (error) {
            await rm(tmp, { force: true }).catch(() => undefined)
            throw error
          }
          await announceOwnWrite(dir.dir, input.key)
          return { ok: true as const }
        } catch (error) {
          return failure<object>('io_error', error instanceof Error ? error.message : String(error))
        }
      })
    },

    async delete(moduleId, input) {
      const keyIssue = validateKey(input.key)
      if (keyIssue) return failure('invalid_key', keyIssue)
      const dir = resolveDir(moduleId, input)
      if (!dir.ok) return dir
      return enqueue(async () => {
        const path = join(dir.dir, `${input.key}.json`)
        await ready(dir)
        try {
          await readFile(path, 'utf8')
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: true as const, deleted: false }
          return failure<{ deleted: boolean }>('io_error', error instanceof Error ? error.message : String(error))
        }
        try {
          await rm(path)
          await announceOwnWrite(dir.dir, input.key)
          return { ok: true as const, deleted: true }
        } catch (error) {
          return failure<{ deleted: boolean }>('io_error', error instanceof Error ? error.message : String(error))
        }
      })
    },

    async list(moduleId, input) {
      const dir = resolveDir(moduleId, input)
      if (!dir.ok) return dir
      await ready(dir)
      let entries: string[]
      try {
        entries = await readdir(dir.dir)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: true, keys: [] }
        return failure('io_error', error instanceof Error ? error.message : String(error))
      }
      const prefix = input?.prefix
      if (prefix !== undefined && typeof prefix !== 'string') {
        return failure('invalid_key', 'prefix must be a string.')
      }
      const keys = entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => entry.slice(0, -'.json'.length))
        .filter((key) => KEY_PATTERN.test(key) && (prefix === undefined || key.startsWith(prefix)))
        .sort()
      return { ok: true, keys }
    },

    watch(moduleId, input, listener) {
      if (typeof listener !== 'function') throw new Error('watch needs a listener function.')
      const dir = resolveDir(moduleId, input)
      if (!dir.ok) throw new Error(dir.message)
      const watcher: ModuleStorageWatcher = { dir: dir.dir, listener, seen: null }
      watchers.add(watcher)
      // The baseline the first poll compares against; nothing is reported for it.
      void scan(watcher).then((seen) => {
        if (watchers.has(watcher) && watcher.seen === null) watcher.seen = seen
      })
      if (!pollTimer) {
        pollTimer = setInterval(() => void pollOnce(), options.watchIntervalMs ?? MODULE_STORAGE_WATCH_INTERVAL_MS)
        pollTimer.unref?.()
      }
      return () => {
        watchers.delete(watcher)
        if (watchers.size === 0 && pollTimer) {
          clearInterval(pollTimer)
          pollTimer = null
        }
      }
    },

    dataDir(moduleId) {
      if (UNSAFE_SEGMENT.test(moduleId) || moduleId.trim().length === 0) {
        throw new Error(`Module id "${moduleId}" is not usable as a data folder.`)
      }
      const dir = join(options.userDataDir(), MODULE_DATA_DIRECTORY, moduleId)
      mkdirSync(dir, { recursive: true })
      return dir
    },
  }
}
