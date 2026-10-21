import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import {
  BACKLOG_DEPENDENCIES_PLANNED_KEY,
  backlogDependenciesPlannedFromFields,
  extractBacklogTitle,
  formatBacklogCsvList,
  isValidBacklogSlug,
  parseBacklogCsvList,
  parseBacklogFrontmatter,
  serializeBacklogFrontmatterFields,
  stripBacklogFrontmatter,
  type BacklogFrontmatterUpdates,
} from '../shared/backlog/frontmatter'
import {
  deriveDefaultBacklogKey,
  formatBacklogNumericId,
  isValidBacklogKey,
  parseBacklogNumericId,
  planBacklogIdAllocation,
} from '../shared/backlog/item-id'
import { isRoadmapContent } from '../shared/backlog/roadmap'
import { reconcileBacklogObjectRecordIds, stableBacklogObjectId } from '../shared/backlog/object-id'
import {
  backlogAbsolutePath,
  backlogLocationFor,
  backlogLogicalPath,
  defaultBacklogLocation,
  isDefaultBacklogLocation,
  type BacklogLocation,
} from '../shared/backlog/scan'
import {
  backlogHighlightFields,
  durableBacklogLinkFields,
  durableBacklogLinksFromFrontmatter,
  isDurableBacklogLink,
} from '../shared/backlog/durable-links'
import type {
  BacklogAddOrUpdateLinkInput,
  BacklogCreateEpicInput,
  BacklogCreateEpicResult,
  BacklogEnsureIdsInput,
  BacklogEnsureIdsResult,
  BacklogEpicColorInput,
  BacklogDependenciesInput,
  BacklogDependenciesPlannedInput,
  BacklogEpicInput,
  BacklogHighlightColorPayload,
  BacklogHighlightInput,
  BacklogItemLinkPayload,
  BacklogItemRecordInput,
  BacklogMockupsInput,
  BacklogModuleMetadataInput,
  BacklogMutationResult,
  BacklogObjectRecordPayload,
  BacklogObjectStorePayload,
  BacklogLocationInfo,
  BacklogLocationResult,
  BacklogReadResult,
  BacklogSetRootInput,
  BacklogRemoveLinkInput,
  BacklogRemoveRecordInput,
  BacklogStatusInput,
  BacklogTriageInput,
  BacklogTypeInput,
  BacklogMoveSourceInput,
} from '../shared/electron-api'
import { isPathInsideOrEqual } from './path-containment'
import { SIDECAR_DIR_NAME } from '../shared/workspace-sidecar'
import { workspaceStorePath, workspaceStoreProject, workspaceStoreReady } from './workspace-store'
import { errorMessage } from '../shared/errors'

// The volatile half of an item's links, and nothing else: resolved statuses, the
// agent terminal currently holding an item, module metadata keyed to a live
// session. Kept out of the project, because every value in here is re-derived
// from the world and worthless after a restart — which is precisely why it used
// to churn a TRACKED file (`backlog/items.json` in the sidecar) on every
// resolve tick.
//
// Durable facts moved to the item's own markdown frontmatter (see
// shared/backlog/durable-links.ts), so they travel with the file, diff for a
// human, and cannot be a merge-conflict surface between two agents.
//
// Deleting this file is always safe: the next scan resolves it again.
//
// These three are relative to the project's store in the person's home
// (workspace-store.ts), which every checkout of the project shares.
const STORE_PATH = ['backlog', 'cache', 'links.json'] as const
// The retired sidecar, read once by migrateBacklogSidecarToFiles and then
// deleted. Kept as a constant so the migration cannot drift from the path it
// must look under.
const LEGACY_STORE_PATH = ['backlog', 'items.json'] as const
// Per-project config holding the display key (`MC`) and the backlog's root.
// Separate from the cache, whose store shape is normalized down to
// `{schemaVersion, items}` and would drop a key. It is the app's runtime state
// (it rewrites it as it runs, and a clone derives its own on first read), so it
// is written to the store, never into the project.
//
// Older builds wrote it to `<project>/.sprintengine/backlog/config.json`. The
// store's one-time move takes that file out, unless git tracks it: a project
// that committed its key keeps the file, and it is read, never written, while
// the store has no config of its own — so the committed key is the one every
// clone starts from, and the first change after that lives in the store.
const CONFIG_PATH = ['backlog', 'config.json'] as const
// v1 carried the display key alone; v2 adds `root`. A v1 file reads correctly as
// a workspace with no configured root, so there is no migration to run.
const BACKLOG_CONFIG_SCHEMA_VERSION = 2
const BACKLOG_PREFIX = 'backlog/'
// Items are filed under the epic they belong to, so a folder under `backlog/`
// IS an epic and its children are the items in it. An item with no epic still
// needs a home, and the top level is reserved for those folders, so it goes
// here. `epic:` frontmatter remains the authority on membership; the folder is
// where the item was filed when it was created.
const UNFILED_DIR = 'unfiled'
const EPICS_PREFIX = 'backlog/epics/'

type ValidWorkspace = {
  root: string
  storePath: string
  /**
   * Where this workspace's item files actually live. `<root>/backlog` unless the
   * workspace has configured a root, in which case it can be anywhere on this
   * machine. Item identity is unaffected — see BacklogLocation.
   */
  location: BacklogLocation
}

type BacklogObjectStore = BacklogObjectStorePayload
type BacklogObjectRecord = BacklogObjectRecordPayload

const EMPTY_STORE: BacklogObjectStore = { schemaVersion: 1, items: [] }

const VALID_STATUS = new Set(['idea', 'ready', 'in_progress', 'needs_input', 'completed', 'archived'])
const VALID_TYPE = new Set(['epic', 'feature', 'bug', 'mockup', 'spike'])
const VALID_DIFFICULTY = new Set(['xs', 's', 'm', 'l', 'xl'])
const VALID_CRITICALITY = new Set(['low', 'normal', 'high', 'critical'])
const VALID_RISK = new Set(['low', 'normal', 'high'])
const VALID_HIGHLIGHT_COLOR = new Set(['red', 'orange', 'amber', 'green', 'blue', 'purple', 'pink'])

// Every Backlog writer in this process ultimately targets one project folder.
// Keep id allocation and the writes that depend on it in one FIFO lane per
// project so two concurrent MCP requests cannot both observe the same max id.
// Electron's single-instance lock makes this the only app process that can own
// the gateway; git-branch collisions remain a merge-time concern and continue
// to be surfaced rather than silently rewritten.
const backlogMutationTails = new Map<string, Promise<void>>()

async function withBacklogMutationLock<T>(workspace: ValidWorkspace, operation: () => Promise<T>): Promise<T> {
  const key = workspace.root
  const previous = backlogMutationTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const turn = new Promise<void>((resolveTurn) => {
    release = resolveTurn
  })
  const tail = previous.catch(() => undefined).then(() => turn)
  backlogMutationTails.set(key, tail)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (backlogMutationTails.get(key) === tail) backlogMutationTails.delete(key)
  }
}

/**
 * Run `operation` in this project's Backlog mutation lane — the one id
 * allocation and creation hold — so a writer outside this file (a module's
 * Backlog service) cannot interleave with another writer on the same project.
 * `operation` must not call a writer here that takes the lane itself
 * (`createBacklogItem`, `ensureBacklogItemIds`, `repairBacklogIntegrity`): the
 * lane is not re-entrant, and waiting on itself would never finish.
 */
export async function withBacklogWorkspaceLock<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
  const workspace = await validateWorkspaceRoot(workspaceRoot)
  return withBacklogMutationLock(workspace, operation)
}

/**
 * The display key ids are composed with (`MC` in `MC-240`) without writing
 * anything: the configured one, else the default the first scan would persist.
 */
export async function peekBacklogDisplayKey(workspaceRoot: string): Promise<string> {
  const workspace = await validateWorkspaceRoot(workspaceRoot)
  return (await peekBacklogWorkspaceKey(workspace)) ?? defaultBacklogKeyFor(workspace.root)
}

export async function readBacklogObjectStore(workspaceRoot: string): Promise<BacklogReadResult> {
  try {
    const workspace = await validateWorkspaceRoot(workspaceRoot)
    // The read path is where the lazy v1 -> v2 migration runs: a not-yet-migrated
    // workspace is migrated on first read and tolerated indefinitely until then.
    const store = await loadMigratedStore(workspace)
    return { ok: true, store }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

// Resolve the workspace display key: the config's value when valid, else
// a default derived from the workspace folder name and persisted so it stays
// stable. A malformed config is non-fatal — we derive a fresh default.
async function resolveBacklogWorkspaceKey(workspace: ValidWorkspace): Promise<string> {
  try {
    const raw = await readBacklogConfigText(workspace.root)
    const parsed = JSON.parse(raw) as { key?: unknown }
    if (isValidBacklogKey(parsed.key)) return parsed.key
  } catch (error) {
    if (!isMissingFileError(error)) {
      // Unreadable/unparseable config: fall through and re-derive a default.
    }
  }
  const key = defaultBacklogKeyFor(workspace.root)
  await persistBacklogWorkspaceKey(workspace, key)
  return key
}

/**
 * The key a project with no configured one gets, from its main checkout's
 * name: every checkout shares one config, so a worktree read first must not
 * name the project's items after its own folder.
 */
export function defaultBacklogKeyFor(workspaceRoot: string): string {
  let project = workspaceRoot
  try {
    project = workspaceStoreProject(workspaceRoot)
  } catch {
    // Not a folder on this computer: its own name.
  }
  return deriveDefaultBacklogKey(basename(project) || project)
}

/**
 * The config's text: the store's, else a committed one an older build left in
 * the project (see CONFIG_PATH). Throws, as `readFile` does, when there is
 * neither. Read-only, so a snapshot read never writes.
 */
export async function readBacklogConfigText(workspaceRoot: string): Promise<string> {
  await workspaceStoreReady(workspaceRoot)
  try {
    return await readFile(workspaceStorePath(workspaceRoot, ...CONFIG_PATH), 'utf-8')
  } catch (error) {
    if (!isMissingFileError(error)) throw error
    return readFile(join(workspaceRoot, SIDECAR_DIR_NAME, ...CONFIG_PATH), 'utf-8')
  }
}

// The whole config, or an empty object. Every reader here is tolerant: a
// workspace with an unreadable or malformed config falls back to defaults rather
// than failing to show a backlog at all.
async function readBacklogConfigFile(workspaceRoot: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readBacklogConfigText(workspaceRoot)
    const parsed = JSON.parse(raw) as unknown
    return isPlainRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * The root this workspace has pointed its backlog at, or null for the default.
 * A blank string is the default too, so clearing the field in the config reads
 * the same as never having set it.
 */
async function readConfiguredBacklogRoot(workspaceRoot: string): Promise<string | null> {
  const config = await readBacklogConfigFile(workspaceRoot)
  const configured = config['root']
  return typeof configured === 'string' && configured.trim() ? configured : null
}

// Merge rather than overwrite. This file carries the display key AND the backlog
// root, and each is written by a different path — a whole-object write from
// either one silently drops the other.
async function writeBacklogConfigFields(workspaceRoot: string, fields: Record<string, unknown>): Promise<void> {
  const target = workspaceStorePath(workspaceRoot, ...CONFIG_PATH)
  const existing = await readBacklogConfigFile(workspaceRoot)
  const next = { ...existing, ...fields, schemaVersion: BACKLOG_CONFIG_SCHEMA_VERSION }
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
  } catch {
    // Best effort: a failed write just means we re-derive the same default next time.
  }
}

async function persistBacklogWorkspaceKey(workspace: ValidWorkspace, key: string): Promise<void> {
  await writeBacklogConfigFields(workspace.root, { key })
}

// Scan-time id backfill for legacy or hand-authored files. Main-owned creation
// allocates before writing; this remains the tolerant migration path for files
// that arrive without an id. It shares the same per-project mutation lane as
// creation so a scan and an MCP create cannot mint the same number.
export async function ensureBacklogItemIds(input: BacklogEnsureIdsInput): Promise<BacklogEnsureIdsResult> {
  try {
    const workspace = await validateWorkspaceRoot(input.workspaceRoot)
    return await withBacklogMutationLock(workspace, async () => {
      const key = await resolveBacklogWorkspaceKey(workspace)
      const store = await loadStore(workspace)
      const createdByPath = new Map<string, string | undefined>()
      for (const record of store.items) {
        createdByPath.set(record.source.relativePath.toLowerCase(), record.createdAt)
      }

      const allocationItems: Array<{ relativePath: string; numericId?: number | null; createdAt?: string }> = []
      for (const raw of input.items ?? []) {
        let relativePath: string
        try {
          relativePath = validateBacklogRelativePath(raw.relativePath)
        } catch {
          // A path that escapes backlog/ is ignored, never written to.
          continue
        }
        allocationItems.push({
          relativePath,
          numericId: typeof raw.numericId === 'number' ? raw.numericId : null,
          createdAt: createdByPath.get(relativePath.toLowerCase()),
        })
      }

      const assignments = planBacklogIdAllocation(allocationItems)
      for (const [relativePath, numericId] of Object.entries(assignments)) {
        const target = backlogAbsolutePath(workspace.location, relativePath)
        if (!target) continue
        let content: string
        try {
          content = await readFile(target, 'utf-8')
        } catch {
          // A file that vanished between scan and write is skipped; the next scan
          // re-evaluates it.
          continue
        }
        const next = serializeBacklogFrontmatterFields(content, { id: formatBacklogNumericId(numericId) })
        if (next !== content) await writeFile(target, next, 'utf-8')
      }

      return { ok: true, key, assignments }
    })
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

const MIGRATABLE_FRONTMATTER_FIELDS = ['status', 'type', 'difficulty', 'criticality', 'risk'] as const

type BacklogRecordFrontmatterMigration = {
  relativePath: string
  updates: Record<string, string>
}

export type BacklogStoreMigrationPlan = {
  // Per-record frontmatter writes to apply (only records that still carry fields).
  migrations: BacklogRecordFrontmatterMigration[]
  // Every record with the migratable fields stripped (orphan GC happens in the
  // service, which has fs to check for the file).
  slimRecords: Record<string, unknown>[]
  // True when any record carried a migratable field — i.e. a rewrite is needed.
  changed: boolean
}

// Pure planner for the lazy v1 -> v2 migration. Given a parsed items.json, work
// out which records still carry lightweight fields (status/type/difficulty/
// criticality/risk) to push into the item's frontmatter — sidecar value WINS on
// conflict (matching the old precedence), and unknown string values are migrated
// intact rather than dropped (OKF drift tolerance) — and the records with those
// fields stripped. No fs: the service applies the writes and prunes orphans.
export function planBacklogStoreMigration(parsed: unknown): BacklogStoreMigrationPlan {
  const items = isPlainRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : []
  const migrations: BacklogRecordFrontmatterMigration[] = []
  const slimRecords: Record<string, unknown>[] = []
  let changed = false
  for (const raw of items) {
    if (!isPlainRecord(raw)) continue
    const slim: Record<string, unknown> = { ...raw }
    const updates: Record<string, string> = {}
    for (const field of MIGRATABLE_FRONTMATTER_FIELDS) {
      if (!(field in slim)) continue
      const value = slim[field]
      delete slim[field]
      changed = true
      // Only string values can live in flat frontmatter; non-strings are malformed
      // sidecar data and are simply dropped. Unknown strings (e.g. a custom type)
      // are preserved so the read model can surface them. items.json scalars are
      // untrusted v1 sidecar data, so sanitize before the writer sees them (sec F1,
      // defense in depth with formatScalar) and drop ones that sanitize to empty.
      if (typeof value === 'string') {
        const sanitized = sanitizeMigratedScalar(value)
        if (sanitized) updates[field] = sanitized
      }
    }
    slimRecords.push(slim)
    const relativePath = recordRelativePath(raw)
    if (relativePath && Object.keys(updates).length > 0) migrations.push({ relativePath, updates })
  }
  return { migrations, slimRecords, changed }
}

// Collapse embedded CR/LF in a migration-sourced scalar so a crafted multi-line
// items.json value cannot serialize into extra frontmatter lines, then trim.
function sanitizeMigratedScalar(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

function recordRelativePath(raw: unknown): string | null {
  if (!isPlainRecord(raw)) return null
  const source = raw.source
  if (!isPlainRecord(source) || typeof source.relativePath !== 'string') return null
  return normalizeRelativePath(source.relativePath)
}

// Read items.json, run the lazy migration when it still carries v1 fields, and
// return the (slimmed) store. When nothing needs migrating this is a plain load,
// so steady-state reads incur no extra fs writes (idempotent).
// One-time move off the committed sidecar. `.sprintengine/backlog/items.json` held
// both halves of every link plus the star; the durable halves go into each item's
// own frontmatter, the volatile remainder becomes the cache in the store, and the
// sidecar is deleted.
//
// Idempotent by construction: it runs only while the legacy file exists, and it
// deletes that file as its last act. A record whose markdown is gone contributes
// nothing — those are the orphans the sidecar had been accumulating (175 of them
// in the repo this shipped from), and dropping them is the point.
//
// The durable write is skipped when the item already declares the same scalars,
// because serializeBacklogFrontmatterFields returns the content unchanged and the
// writer compares before writing — so re-running costs reads and no writes.
//
// The file is looked for in two places: the store, where the store's one-time
// move puts one git did not track, and the project's `.sprintengine/`, where a
// tracked one stays (the move leaves tracked files alone; this drain is the
// one-time change that retires that file, as it always was).
async function migrateLegacyBacklogSidecar(workspace: ValidWorkspace): Promise<void> {
  await drainLegacyBacklogSidecar(workspace, workspaceStorePath(workspace.root, ...LEGACY_STORE_PATH))
  await drainLegacyBacklogSidecar(workspace, join(workspace.root, SIDECAR_DIR_NAME, ...LEGACY_STORE_PATH))
}

async function drainLegacyBacklogSidecar(workspace: ValidWorkspace, legacyPath: string): Promise<void> {
  let rawText: string
  try {
    rawText = await readFile(legacyPath, 'utf-8')
  } catch (error) {
    if (isMissingFileError(error)) return
    throw new Error(`Could not read the legacy Backlog sidecar: ${errorMessage(error)}`)
  }
  let legacy: BacklogObjectStore
  try {
    legacy = normalizeStore(JSON.parse(rawText))
  } catch (error) {
    // An unparseable sidecar is not worth failing every Backlog read over, and
    // there is nothing recoverable in it. Leave it in place for a human.
    console.warn(`Backlog: could not parse the legacy sidecar, leaving it alone: ${errorMessage(error)}`)
    return
  }

  const cacheRecords: BacklogObjectRecord[] = []
  for (const record of legacy.items) {
    const relativePath = record.source.relativePath
    const target = backlogAbsolutePath(workspace.location, relativePath)
    if (!target) continue
    let content: string
    try {
      content = await readFile(target, 'utf-8')
    } catch {
      // Orphan: the markdown is gone, so the record describes nothing.
      continue
    }
    const durable = (record.links ?? []).filter(isDurableBacklogLink)
    const updates = {
      ...durableBacklogLinkFields(durable),
      ...backlogHighlightFields(record.highlight),
    }
    const next = serializeBacklogFrontmatterFields(content, updates)
    if (next !== content) {
      try {
        await writeFile(target, next, 'utf-8')
      } catch (error) {
        throw new Error(`Could not migrate Backlog item ${relativePath}: ${errorMessage(error)}`)
      }
    }
    // Everything the file cannot carry stays behind in the cache: the volatile
    // links, the resolved statuses of the durable ones, and module metadata bound
    // to a live session.
    cacheRecords.push({ ...record, highlight: undefined })
  }

  await saveStore(workspace, normalizeStore({ schemaVersion: 1, items: cacheRecords }))
  try {
    await rm(legacyPath, { force: true })
  } catch (error) {
    throw new Error(`Could not remove the legacy Backlog sidecar: ${errorMessage(error)}`)
  }
}

async function loadMigratedStore(workspace: ValidWorkspace): Promise<BacklogObjectStore> {
  // Drains the retired sidecar into the files and the cache the first time this
  // workspace is read after the upgrade; a no-op on every read after that.
  await migrateLegacyBacklogSidecar(workspace)
  let rawText: string
  try {
    rawText = await readFile(workspace.storePath, 'utf-8')
  } catch (error) {
    if (isMissingFileError(error)) return EMPTY_STORE
    throw new Error(`Could not read Backlog metadata: ${errorMessage(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch (error) {
    throw new Error(`Could not parse Backlog metadata: ${errorMessage(error)}`)
  }

  const plan = planBacklogStoreMigration(parsed)
  if (!plan.changed) return normalizeStore(parsed)

  // Push each record's lightweight fields into its item frontmatter (sidecar
  // wins, body byte-preserved). A record whose file is gone is skipped here and
  // pruned by the orphan GC below.
  for (const migration of plan.migrations) {
    const target = backlogAbsolutePath(workspace.location, migration.relativePath)
    if (!target) continue
    let content: string
    try {
      content = await readFile(target, 'utf-8')
    } catch {
      continue
    }
    const next = serializeBacklogFrontmatterFields(content, migration.updates)
    if (next !== content) await writeFile(target, next, 'utf-8')
  }

  // Orphan GC: drop records whose source file no longer exists on disk.
  const survivors: unknown[] = []
  for (const record of plan.slimRecords) {
    const relativePath = recordRelativePath(record)
    if (relativePath && (await backlogFileExists(workspace, relativePath))) survivors.push(record)
  }
  const migrated = normalizeStore({ schemaVersion: 1, items: survivors })
  await saveStore(workspace, migrated)
  return migrated
}

// Frontmatter-sourced lifecycle/triage/epic for an item's markdown content. This
// is the v2 read shape non-panel readers (the mobile bridge) use
// so they see the same source of truth the renderer does, instead of the now-stale
// sidecar fields. Unknown/invalid values are dropped; callers fall back to a
// sidecar record only for not-yet-migrated items (mixed-version tolerance).
export type BacklogFrontmatterFields = {
  status?: BacklogObjectRecord['status']
  type?: BacklogObjectRecord['type']
  difficulty?: BacklogObjectRecord['difficulty']
  criticality?: BacklogObjectRecord['criticality']
  risk?: BacklogObjectRecord['risk']
  epic?: string
  // Prerequisite slugs from the `dependsOn:` CSV line, valid-slug filtered.
  // Exposed so a main-process caller has the dependency axis the panel read
  // model derives in the renderer; empty when the line is absent.
  dependsOn?: string[]
  // The epic's `dependenciesPlanned:` mark. Only meaningful on an epic
  // — a leaf item carrying it means nothing — but parsed for any file, since the
  // reader does not know which one it holds. Absent means false.
  dependenciesPlanned?: boolean
}

export function readBacklogFrontmatterFields(content: string): BacklogFrontmatterFields {
  const { fields } = parseBacklogFrontmatter(content)
  // The parser lowercases every key, so a camelCase field is read at its
  // lowercased spelling. Reading `fields.dependsOn` matched nothing and silently
  // dropped every prerequisite edge this reader exists to expose — the whole
  // dependency axis was empty here.
  const dependsOn = parseBacklogCsvList(fields.dependson).filter(isValidBacklogSlug)
  const dependenciesPlanned = backlogDependenciesPlannedFromFields(fields)
  return {
    ...(dependenciesPlanned ? { dependenciesPlanned } : {}),
    status: isBacklogStatus(fields.status) ? fields.status : undefined,
    type: isBacklogType(fields.type) ? fields.type : undefined,
    difficulty: isBacklogDifficulty(fields.difficulty) ? fields.difficulty : undefined,
    criticality: isBacklogCriticality(fields.criticality) ? fields.criticality : undefined,
    risk: isBacklogRisk(fields.risk) ? fields.risk : undefined,
    epic: isValidEpicSlug(fields.epic) ? fields.epic : undefined,
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
  }
}

// Read-only listing for non-panel consumers (the automation server's
// `backlog.list`): files on disk are the item universe, frontmatter the only
// metadata source. Unlike the mobile snapshot read this NEVER writes — no
// object-store registration, no workspace-key persistence — because an
// external read tool must not mutate app state as a side effect.
type BacklogListedItem = {
  relativePath: string
  title: string
  /** Frontmatter numeric id when assigned (display id = `<key>-<id>`). */
  id?: number
  isEpic: boolean
  // True for a `backlog/roadmaps/<name>.md` ordered-execution plan.
  // Surfaced as a flag rather than through the closed `type` union, which stays
  // OKF-tolerant of the roadmap type (src/shared/backlog/roadmap.ts).
  isRoadmap?: boolean
  status: BacklogObjectRecord['status']
  type?: BacklogObjectRecord['type']
  difficulty?: BacklogObjectRecord['difficulty']
  criticality?: BacklogObjectRecord['criticality']
  risk?: BacklogObjectRecord['risk']
  epic?: string
  // Prerequisite slugs (`dependsOn:`). Present only when the item declares
  // dependencies.
  dependsOn?: string[]
  // The epic's "ordering is done" mark. Present only when set, so an
  // unflagged epic reads exactly as it did before the field existed.
  dependenciesPlanned?: boolean
}

export type BacklogListItemsResult =
  { ok: true; key: string | null; items: BacklogListedItem[] } | { ok: false; message: string }

export async function listBacklogItems(workspaceRoot: string): Promise<BacklogListItemsResult> {
  try {
    const workspace = await validateWorkspaceRoot(workspaceRoot)
    // Walks the tree rather than naming directories. Items live one folder deep
    // now — under the epic they belong to, or `unfiled/` — so the three fixed
    // listings this used to do (`backlog/`, `epics/`, `roadmaps/`) saw only the
    // epics and roadmaps and reported a backlog with no items in it. Same walker
    // and same skip rules as the renderer's scan, so the two agree on what exists.
    const paths = (await listAllBacklogSourcePaths(workspace)).filter((candidate) =>
      candidate.toLowerCase().endsWith('.md'),
    )
    const items: BacklogListedItem[] = []
    for (const relativePath of paths) {
      let raw: string
      try {
        const sourcePath = backlogAbsolutePath(workspace.location, relativePath)
        if (!sourcePath) continue
        raw = await readFile(sourcePath, 'utf-8')
      } catch {
        continue
      }
      const fields = readBacklogFrontmatterFields(raw)
      const status = fields.status ?? 'idea'
      if (status === 'archived') continue
      const { fields: rawFields } = parseBacklogFrontmatter(raw)
      const numericId = parseBacklogNumericId(rawFields.id)
      const body = stripBacklogFrontmatter(raw)
      items.push({
        relativePath,
        title: extractBacklogTitle(body, relativePath),
        ...(numericId !== undefined ? { id: numericId } : {}),
        isEpic: relativePath.startsWith(EPICS_PREFIX) || fields.type === 'epic',
        ...(isRoadmapContent(relativePath, rawFields.type) ? { isRoadmap: true } : {}),
        status,
        ...(fields.type ? { type: fields.type } : {}),
        ...(fields.difficulty ? { difficulty: fields.difficulty } : {}),
        ...(fields.criticality ? { criticality: fields.criticality } : {}),
        ...(fields.risk ? { risk: fields.risk } : {}),
        ...(fields.epic ? { epic: fields.epic } : {}),
        ...(fields.dependsOn ? { dependsOn: fields.dependsOn } : {}),
        ...(fields.dependenciesPlanned ? { dependenciesPlanned: true } : {}),
      })
    }
    items.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    return { ok: true, key: await peekBacklogWorkspaceKey(workspace), items }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

export type BacklogReadItemResult = { ok: true; item: BacklogListedItem; body: string } | { ok: false; message: string }

/**
 * Where this workspace's backlog lives, and whether it is actually there.
 *
 * A configured root that has gone missing is reported rather than papered over:
 * an unplugged drive or an uncloned backlog repo should read as "the folder is
 * not there", not as a backlog that lost all its items.
 */
export async function resolveBacklogLocation(workspaceRoot: string): Promise<BacklogLocationResult> {
  try {
    const workspace = await validateWorkspaceRoot(workspaceRoot)
    return { ok: true, location: await describeLocation(workspace.location) }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

async function describeLocation(location: BacklogLocation): Promise<BacklogLocationInfo> {
  let exists = false
  try {
    exists = (await stat(location.root)).isDirectory()
  } catch {
    exists = false
  }
  return {
    workspaceRoot: location.workspaceRoot,
    root: location.root,
    isDefault: isDefaultBacklogLocation(location),
    exists,
  }
}

/**
 * Point this workspace's backlog at a folder, or reset it to the default with
 * `root: null`. The folder must already exist — this never creates one, because
 * a typo that silently mkdir's an empty backlog is worse than a refusal.
 */
export async function setBacklogRoot(input: BacklogSetRootInput): Promise<BacklogLocationResult> {
  try {
    const workspace = await validateWorkspaceRoot(input.workspaceRoot)
    const requested = typeof input.root === 'string' ? input.root.trim() : ''
    if (!requested) {
      await writeBacklogConfigFields(workspace.root, { root: undefined })
      return { ok: true, location: await describeLocation(defaultBacklogLocation(workspace.root)) }
    }
    if (!isAbsolute(requested)) throw new Error('A backlog folder must be an absolute path.')
    const resolved = await realpath(requested).catch(() => {
      throw new Error('That backlog folder does not exist.')
    })
    if (!(await stat(resolved)).isDirectory()) throw new Error('A backlog folder must be a folder.')
    // Pointing a backlog at the workspace root, or at anything containing it,
    // would make every file in the checkout a backlog item and set the watcher
    // on a tree the size of the repository. `<root>/backlog` is the default and
    // is fine; a folder inside the checkout that is not the checkout is fine too.
    if (isPathInsideOrEqual(resolved, workspace.root)) {
      throw new Error('A backlog folder cannot be the workspace itself, or a folder containing it.')
    }
    const location = backlogLocationFor(workspace.root, resolved)
    await writeBacklogConfigFields(workspace.root, {
      root: isDefaultBacklogLocation(location) ? undefined : location.root,
    })
    return { ok: true, location: await describeLocation(location) }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

export async function readBacklogItem(workspaceRoot: string, relativePath: string): Promise<BacklogReadItemResult> {
  try {
    const workspace = await validateWorkspaceRoot(workspaceRoot)
    const normalized = validateBacklogRelativePath(relativePath)
    const target = backlogAbsolutePath(workspace.location, normalized)
    if (!target) throw new Error('Backlog item path escaped the backlog root.')
    let raw: string
    try {
      raw = await readFile(target, 'utf-8')
    } catch {
      return { ok: false, message: `Backlog item ${normalized} does not exist in this workspace.` }
    }
    const fields = readBacklogFrontmatterFields(raw)
    const { fields: rawFields } = parseBacklogFrontmatter(raw)
    const numericId = parseBacklogNumericId(rawFields.id)
    const body = stripBacklogFrontmatter(raw)
    return {
      ok: true,
      item: {
        relativePath: normalized,
        title: extractBacklogTitle(body, normalized),
        ...(numericId !== undefined ? { id: numericId } : {}),
        isEpic: normalized.startsWith(EPICS_PREFIX) || fields.type === 'epic',
        ...(isRoadmapContent(normalized, rawFields.type) ? { isRoadmap: true } : {}),
        status: fields.status ?? 'idea',
        ...(fields.type ? { type: fields.type } : {}),
        ...(fields.difficulty ? { difficulty: fields.difficulty } : {}),
        ...(fields.criticality ? { criticality: fields.criticality } : {}),
        ...(fields.risk ? { risk: fields.risk } : {}),
        ...(fields.epic ? { epic: fields.epic } : {}),
        ...(fields.dependenciesPlanned ? { dependenciesPlanned: true } : {}),
      },
      body,
    }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

async function listAllBacklogSourcePaths(workspace: ValidWorkspace): Promise<string[]> {
  const paths: string[] = []
  await walk(workspace.location.root)
  return paths.sort((left, right) => left.localeCompare(right))

  async function walk(directory: string): Promise<void> {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== '.sprintengine-worktrees') {
          await walk(join(directory, entry.name))
        }
        continue
      }
      if (!entry.isFile() || !/\.(md|html?)$/i.test(entry.name)) continue
      const logical = backlogLogicalPath(workspace.location, join(directory, entry.name))
      if (logical) paths.push(logical)
    }
  }
}

async function nextBacklogNumericId(workspace: ValidWorkspace): Promise<number> {
  let max = 0
  for (const relativePath of await listAllBacklogSourcePaths(workspace)) {
    let content: string
    try {
      const sourcePath = backlogAbsolutePath(workspace.location, relativePath)
      if (!sourcePath) continue
      content = await readFile(sourcePath, 'utf-8')
    } catch {
      continue
    }
    const { fields } = parseBacklogFrontmatter(content)
    const numericId = parseBacklogNumericId(fields.id)
    if (numericId !== undefined && numericId > max) max = numericId
  }
  return max + 1
}

// The workspace key without the persist-on-first-read behavior of
// readBacklogWorkspaceKey — a pure peek for read-only surfaces.
async function peekBacklogWorkspaceKey(workspace: ValidWorkspace): Promise<string | null> {
  try {
    const raw = await readBacklogConfigText(workspace.root)
    const parsed = JSON.parse(raw) as { key?: unknown }
    return isValidBacklogKey(parsed.key) ? parsed.key : null
  } catch {
    return null
  }
}

export type BacklogCreateInput = {
  workspaceRoot: string
  title: string
  description?: string
  /** The new item's lifecycle; `idea` when absent or not one the app knows. */
  status?: string
  type?: string
  difficulty?: string
  criticality?: string
  risk?: string
  epic?: string
}

export type BacklogCreateResult =
  | { ok: true; id: string; relativePath: string; numericId: number; store: BacklogObjectStorePayload }
  | { ok: false; message: string }

export type BacklogIntegrityRepairInput = {
  workspaceRoot: string
  relativePath: string
  issue: 'embedded_nul' | 'duplicate_id'
}

export type BacklogIntegrityRepairResult =
  | {
      ok: true
      relativePath: string
      issue: BacklogIntegrityRepairInput['issue']
      replacements?: number
      previousNumericId?: number
      numericId?: number
    }
  | { ok: false; message: string }

// Creates a brand-new Backlog item (mobile bridge + automation server):
// writes the real `.md` file AND upserts the items.json record. Filename
// mirrors the desktop renderer's `${today}-${slug(title)}.md` convention and
// dedups against the current store. v2-native: lifecycle/triage go into the
// new file's frontmatter (the source of truth) and the sidecar record stays
// minimal — seeding lifecycle there would hand the lazy migrator stale
// defaults to write back later. The id is allocated and written in this same
// main-owned transaction, so callers can cite it immediately and concurrent
// Studio MCP creates cannot collide. Invalid axis values are dropped, matching
// the tolerant mobile intake; strict vocabularies belong to the callers.
export async function createBacklogItem(input: BacklogCreateInput): Promise<BacklogCreateResult> {
  const title = input.title.trim()
  if (!title) return { ok: false, message: 'Enter a title for the new Backlog item.' }
  try {
    const workspace = await validateWorkspaceRoot(input.workspaceRoot)
    return await withBacklogMutationLock(workspace, async () => {
      const store = await loadStore(workspace)
      const existingLower = new Set(store.items.map((record) => record.source.relativePath.toLowerCase()))
      // Filed into its epic's folder at birth, so a new item lands beside its
      // siblings instead of at the top level among the epic folders themselves.
      const folder = isValidEpicSlug(input.epic) ? input.epic : UNFILED_DIR
      const relativePath = await uniqueBacklogFilePath(workspace, title, existingLower, folder)
      const target = backlogAbsolutePath(workspace.location, relativePath)
      if (!target) throw new Error('Backlog item path escaped the backlog root.')

      const numericId = await nextBacklogNumericId(workspace)
      const now = new Date().toISOString()
      const frontmatter: Array<[key: string, value: string | undefined]> = [
        ['id', formatBacklogNumericId(numericId)],
        ['type', isBacklogType(input.type) ? input.type : undefined],
        ['status', isBacklogStatus(input.status) && input.status !== 'archived' ? input.status : 'idea'],
        ['difficulty', isBacklogDifficulty(input.difficulty) ? input.difficulty : undefined],
        ['criticality', isBacklogCriticality(input.criticality) ? input.criticality : undefined],
        ['risk', isBacklogRisk(input.risk) ? input.risk : undefined],
        ['epic', isValidEpicSlug(input.epic) ? input.epic : undefined],
        ['updated', now],
      ]
      const frontmatterBlock = `---\n${frontmatter
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n')}\n---\n`
      const description = input.description?.trim()
      const body = description ? `# ${title}\n\n${description}\n` : `# ${title}\n`
      await mkdir(dirname(target), { recursive: true })
      // `wx` fails instead of clobbering if a file appears between the uniqueness
      // check and the write.
      await writeFile(target, `${frontmatterBlock}\n${body}`, { encoding: 'utf-8', flag: 'wx' })

      const record: BacklogObjectRecord = {
        id: stableBacklogObjectId(relativePath),
        source: { type: 'file', relativePath },
        metadata: {},
        links: [],
        createdAt: now,
        updatedAt: now,
      }
      const nextStore = normalizeStore({ schemaVersion: 1, items: [...store.items, record] })
      await saveStore(workspace, nextStore)
      return { ok: true, id: record.id, relativePath, numericId, store: nextStore }
    })
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

// Deliberately narrow integrity repair for defects the panel can diagnose but
// ordinary lifecycle tools must never rewrite. Each operation first proves the
// named defect still exists; it is therefore safe to retry and cannot be used as
// a general-purpose Markdown or id editor.
export async function repairBacklogIntegrity(
  input: BacklogIntegrityRepairInput,
): Promise<BacklogIntegrityRepairResult> {
  try {
    const workspace = await validateWorkspaceRoot(input.workspaceRoot)
    const relativePath = validateBacklogRelativePath(input.relativePath)
    if (input.issue !== 'embedded_nul' && input.issue !== 'duplicate_id') {
      return { ok: false, message: 'Unknown Backlog integrity repair operation.' }
    }
    const target = backlogAbsolutePath(workspace.location, relativePath)
    if (!target) throw new Error('Backlog item path escaped the backlog root.')
    return await withBacklogMutationLock(workspace, async () => {
      let content: string
      try {
        content = await readFile(target, 'utf-8')
      } catch {
        return { ok: false, message: `Backlog item ${relativePath} does not exist in this workspace.` }
      }

      if (input.issue === 'embedded_nul') {
        const replacements = content.split('\0').length - 1
        if (replacements === 0) {
          return { ok: false, message: `Backlog item ${relativePath} contains no embedded NUL bytes.` }
        }
        const sanitized = content.replaceAll('\0', '\\0')
        const next = serializeBacklogFrontmatterFields(sanitized, { updated: new Date().toISOString() })
        await writeFile(target, next, 'utf-8')
        return { ok: true, relativePath, issue: input.issue, replacements }
      }

      const { fields } = parseBacklogFrontmatter(content)
      const previousNumericId = parseBacklogNumericId(fields.id)
      if (previousNumericId === undefined) {
        return { ok: false, message: `Backlog item ${relativePath} has no valid numeric id to reallocate.` }
      }
      const paths = await listAllBacklogSourcePaths(workspace)
      let matches = 0
      for (const candidatePath of paths) {
        let candidate: string
        try {
          const candidateSource = backlogAbsolutePath(workspace.location, candidatePath)
          if (!candidateSource) continue
          candidate = await readFile(candidateSource, 'utf-8')
        } catch {
          continue
        }
        const parsed = parseBacklogFrontmatter(candidate)
        if (parseBacklogNumericId(parsed.fields.id) === previousNumericId) matches += 1
      }
      if (matches < 2) {
        return { ok: false, message: `Backlog id ${previousNumericId} is no longer duplicated.` }
      }
      const numericId = await nextBacklogNumericId(workspace)
      const withId = serializeBacklogFrontmatterFields(content, { id: formatBacklogNumericId(numericId) })
      const next = serializeBacklogFrontmatterFields(withId, { updated: new Date().toISOString() })
      await writeFile(target, next, 'utf-8')
      return { ok: true, relativePath, issue: input.issue, previousNumericId, numericId }
    })
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

// Creates a new epic concept file `backlog/epics/<slug>.md` (`type: epic` + the
// title heading). Epics are surfaced from the filesystem, so this writes only the
// markdown file — never an items.json membership record. The slug is the title
// slug, made collision-safe against existing files the same way item creation is.
export async function createBacklogEpic(input: BacklogCreateEpicInput): Promise<BacklogCreateEpicResult> {
  const title = input.title.trim()
  if (!title) return { ok: false, message: 'Enter a title for the new epic.' }
  try {
    const workspace = await validateWorkspaceRoot(input.workspaceRoot)
    const store = await loadStore(workspace)
    const existingLower = new Set(store.items.map((record) => record.source.relativePath.toLowerCase()))
    const relativePath = await uniqueEpicFilePath(workspace, slugifyBacklogTitle(title), existingLower)
    const target = backlogAbsolutePath(workspace.location, relativePath)
    if (!target) throw new Error('Backlog item path escaped the backlog root.')

    const content = `---\ntype: epic\nupdated: ${new Date().toISOString()}\n---\n# ${title}\n`
    await mkdir(dirname(target), { recursive: true })
    // `wx` fails instead of clobbering if a file appears between the uniqueness
    // check and the write.
    await writeFile(target, content, { encoding: 'utf-8', flag: 'wx' })

    const slug = relativePath.slice(EPICS_PREFIX.length).replace(/\.md$/i, '')
    return { ok: true, slug, relativePath }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

export async function ensureBacklogObjectRecords(
  workspaceRoot: string,
  items: BacklogItemRecordInput[],
): Promise<BacklogReadResult> {
  return mutateStore(
    workspaceRoot,
    () => null,
    (store, now) => {
      const nextItems = [...store.items]
      let changed = false
      for (const item of items) {
        const relativePath = validateBacklogRelativePath(item.relativePath)
        const pathKey = relativePath.toLowerCase()
        if (nextItems.some((record) => record.source.relativePath.toLowerCase() === pathKey)) continue
        // v2: the sidecar record carries only app-owned churn (id/source, metadata,
        // links, highlight, timestamps). Lifecycle/triage live in frontmatter, so a
        // freshly registered record seeds none of them — otherwise the lazy migrator
        // would later write those seeded defaults back into the item's frontmatter.
        nextItems.push({
          id: stableBacklogObjectId(relativePath),
          source: { type: 'file', relativePath },
          metadata: {},
          links: [],
          createdAt: now,
          updatedAt: now,
        })
        changed = true
      }
      return changed ? { schemaVersion: 1, items: nextItems } : store
    },
  )
}

// Lifecycle, type, and triage (difficulty/criticality/risk) are frontmatter-
// sourced: these write the item's markdown frontmatter via the shared helper
// (body byte-preserved) and never touch items.json. The matching reader is
// parseBacklogFrontmatter in src/shared/backlog/frontmatter.ts.
export async function updateBacklogStatus(input: BacklogStatusInput): Promise<BacklogMutationResult> {
  if (!isBacklogStatus(input.status)) return { ok: false, message: 'Enter a valid Backlog item status.' }
  const written = await writeBacklogFrontmatter(input.workspaceRoot, input.relativePath, { status: input.status })
  if (!written.ok) return written

  // v2 lifecycle belongs only in frontmatter. A link-sync write from an older
  // build may have left a sidecar status behind; clear it in the same mutation
  // so a later lazy migration cannot overwrite the user's explicit choice.
  return clearBacklogSidecarStatus(input.workspaceRoot, input.relativePath)
}

export async function updateBacklogType(input: BacklogTypeInput): Promise<BacklogMutationResult> {
  if (input.type !== null && !isBacklogType(input.type))
    return { ok: false, message: 'Enter a valid Backlog item type.' }
  return writeBacklogFrontmatter(input.workspaceRoot, input.relativePath, { type: input.type })
}

export async function updateBacklogTriage(input: BacklogTriageInput): Promise<BacklogMutationResult> {
  if (input.difficulty !== undefined && input.difficulty !== null && !isBacklogDifficulty(input.difficulty)) {
    return { ok: false, message: 'Enter a valid Backlog item difficulty.' }
  }
  if (input.criticality !== undefined && input.criticality !== null && !isBacklogCriticality(input.criticality)) {
    return { ok: false, message: 'Enter a valid Backlog item criticality.' }
  }
  if (input.risk !== undefined && input.risk !== null && !isBacklogRisk(input.risk)) {
    return { ok: false, message: 'Enter a valid Backlog item risk.' }
  }
  // Only axes the caller actually supplied are touched; null clears that key's
  // frontmatter line, an omitted axis is left exactly as written.
  const updates: BacklogFrontmatterUpdates = {}
  if ('difficulty' in input) updates.difficulty = input.difficulty ?? null
  if ('criticality' in input) updates.criticality = input.criticality ?? null
  if ('risk' in input) updates.risk = input.risk ?? null
  return writeBacklogFrontmatter(input.workspaceRoot, input.relativePath, updates)
}

// Epic membership is the child-side write: set the child's `epic:` frontmatter
// slug, or null to remove it from its epic. The down-direction (epic -> children)
// stays a derived query (see backlogEpics.ts), never stored, so there is nothing
// to keep in sync. Like the other lifecycle writers this targets the markdown
// frontmatter, never items.json.
export async function updateBacklogEpic(input: BacklogEpicInput): Promise<BacklogMutationResult> {
  if (input.epic !== null && !isValidEpicSlug(input.epic)) {
    return { ok: false, message: 'Enter a valid epic slug.' }
  }
  return writeBacklogFrontmatter(input.workspaceRoot, input.relativePath, { epic: input.epic })
}

// Epic identity colour: write (or clear) the epic file's `color:` frontmatter so
// its members can derive a shared hue at scan time. Like the other frontmatter
// writers this never touches items.json; the value is validated against the
// seven-colour highlight vocabulary so a bad payload can't land an unknown hue.
export async function updateBacklogEpicColor(input: BacklogEpicColorInput): Promise<BacklogMutationResult> {
  if (input.color !== null && !isBacklogHighlightColor(input.color)) {
    return { ok: false, message: 'Enter a valid epic colour.' }
  }
  return writeBacklogFrontmatter(input.workspaceRoot, input.relativePath, { color: input.color })
}

// Prerequisites are the dependent-side write: serialize the item's prerequisite
// slugs to the single comma-separated `dependsOn:` frontmatter line via the
// shared CSV formatter. Each slug is validated with the shared slug check (so the
// write path and the read model agree on what a slug may contain) and the whole
// write is rejected on the first invalid one — nothing is written. Surrounding
// whitespace is trimmed and duplicates dropped, keeping first-seen order, so the
// stored line matches what the reader parses back. An empty list or null clears
// the line (passed as null, since the serializer treats an empty string as a set,
// not a clear). The reverse "blocks" edges and the waiting signal stay derived
// (backlogDependencies.ts), never stored, and this targets markdown frontmatter
// only, never items.json.
export async function updateBacklogDependencies(input: BacklogDependenciesInput): Promise<BacklogMutationResult> {
  if (input.dependsOn !== null && !Array.isArray(input.dependsOn)) {
    return { ok: false, message: 'Enter a valid Backlog prerequisite list.' }
  }
  const cleaned: string[] = []
  const seen = new Set<string>()
  for (const raw of input.dependsOn ?? []) {
    const slug = typeof raw === 'string' ? raw.trim() : ''
    if (!isValidBacklogSlug(slug)) {
      return { ok: false, message: 'Enter valid Backlog prerequisite slugs.' }
    }
    if (seen.has(slug)) continue
    seen.add(slug)
    cleaned.push(slug)
  }
  const dependsOn = cleaned.length > 0 ? formatBacklogCsvList(cleaned) : null
  return writeBacklogFrontmatter(input.workspaceRoot, input.relativePath, { dependsOn })
}

// The epic-side ordering mark: "the planning phase for this epic is
// over". Setting it writes the literal `dependenciesPlanned: true`; clearing it
// removes the line rather than writing `false`, because absent IS false and a
// flag file should not accumulate a negative assertion. Nothing polices HOW it
// got set — a hand edit, an agent's ordering pass, `/backlog` closing an ordering
// session are all the same assertion — so this validates nothing beyond the
// boolean, and never recomputes the value from the children's edges.
export async function updateBacklogDependenciesPlanned(
  input: BacklogDependenciesPlannedInput,
): Promise<BacklogMutationResult> {
  if (typeof input.dependenciesPlanned !== 'boolean') {
    return { ok: false, message: 'Enter true or false for the epic ordering mark.' }
  }
  return writeBacklogFrontmatter(input.workspaceRoot, input.relativePath, {
    [BACKLOG_DEPENDENCIES_PLANNED_KEY]: input.dependenciesPlanned ? 'true' : null,
  })
}

// Mockup attachments are the item-side write: serialize the item's mockup paths
// to the single comma-separated `mockups:` frontmatter line via the shared CSV
// formatter, mirroring updateBacklogDependencies. Each path is validated (a
// non-empty, workspace-relative path with no `..` escape and — the CSV
// contract — no comma) and the whole write is rejected on the first invalid one,
// so a bad payload never lands a half-written line. Surrounding whitespace is
// trimmed, backslashes normalized to `/`, and duplicates dropped keeping
// first-seen order, so the stored line matches what parseBacklogMockups reads
// back. An empty list or null clears the line (passed as null, since the
// serializer treats an empty string as a set, not a clear). Body-prose
// references stay derived (backlogMockups.ts), never written here, and this
// targets markdown frontmatter only, never items.json.
export async function updateBacklogMockups(input: BacklogMockupsInput): Promise<BacklogMutationResult> {
  if (input.mockups !== null && !Array.isArray(input.mockups)) {
    return { ok: false, message: 'Enter a valid Backlog mockup list.' }
  }
  const cleaned: string[] = []
  const seen = new Set<string>()
  for (const raw of input.mockups ?? []) {
    const path = typeof raw === 'string' ? raw.trim().replace(/\\/g, '/') : ''
    // A stored attachment must be a real, workspace-relative path: non-empty, not
    // absolute (POSIX `/` or Windows drive), no `..` escape, and comma-free (the
    // single-line CSV contract can't survive an embedded comma).
    const invalid =
      !path ||
      path.includes(',') ||
      path.startsWith('/') ||
      /^[A-Za-z]:[\\/]/.test(path) ||
      path.split('/').includes('..')
    if (invalid) {
      return { ok: false, message: 'Enter valid Backlog mockup paths (workspace-relative, no “..”).' }
    }
    if (seen.has(path)) continue
    seen.add(path)
    cleaned.push(path)
  }
  const mockups = cleaned.length > 0 ? formatBacklogCsvList(cleaned) : null
  return writeBacklogFrontmatter(input.workspaceRoot, input.relativePath, { mockups })
}

export async function updateBacklogHighlight(input: BacklogHighlightInput): Promise<BacklogMutationResult> {
  if (typeof input.starred !== 'boolean') return { ok: false, message: 'Enter a valid Backlog highlight star value.' }
  if (input.color !== null && !isBacklogHighlightColor(input.color)) {
    return { ok: false, message: 'Enter a valid Backlog highlight color.' }
  }
  // Durable: a person's choice about their own backlog, so it belongs in the file
  // beside the status they also chose. Unstarred with no colour is the default
  // and clears both keys rather than writing an empty highlight.
  return writeBacklogFrontmatter(
    input.workspaceRoot,
    input.relativePath,
    backlogHighlightFields(
      input.starred || input.color !== null ? { starred: input.starred, color: input.color } : undefined,
    ),
  )
}

export async function addOrUpdateBacklogLink(input: BacklogAddOrUpdateLinkInput): Promise<BacklogMutationResult> {
  const link = normalizeBacklogLink(input.link)
  if (!link) return { ok: false, message: 'Enter a valid Backlog item link.' }
  if (link.target.path) {
    if (isAbsolutePathInput(link.target.path)) {
      return { ok: false, message: 'Backlog link target paths must stay project-relative.' }
    }
    const normalizedTargetPath = normalizeRelativePath(link.target.path)
    if (isUnsafeRelativePath(normalizedTargetPath)) {
      return { ok: false, message: 'Backlog link target paths must stay project-relative.' }
    }
    link.target.path = normalizedTargetPath
  }
  if (input.status !== undefined && !isBacklogStatus(input.status)) {
    return { ok: false, message: 'Enter a valid Backlog item status.' }
  }
  const linked = await mutateItem(input.workspaceRoot, input.relativePath, (record, now) => {
    const nextLink = { ...link, updatedAt: link.updatedAt ?? now }
    return {
      ...record,
      links: [...(record.links ?? []).filter((candidate) => candidate.id !== nextLink.id), nextLink],
      updatedAt: now,
    }
  })
  if (!linked.ok) return linked

  // A durable link is ALSO recorded in the item's own frontmatter, which is what
  // makes it survive losing the cache and travel with a `git mv`. The cache copy
  // above stays because it carries the volatile half (resolved status, the prior
  // status a cancel restores); the two are recombined by mergeBacklogLinks on
  // read. Writing the same scalars twice is a no-op — the frontmatter writer
  // compares before writing — so a confirming re-resolve still touches nothing.
  if (isDurableBacklogLink(link)) {
    const durable = await readDurableBacklogLinks(input.workspaceRoot, input.relativePath)
    const next = [...durable.filter((candidate) => candidate.id !== link.id), link]
    const written = await writeBacklogFrontmatter(
      input.workspaceRoot,
      input.relativePath,
      durableBacklogLinkFields(next),
    )
    if (!written.ok) return written
  }
  if (input.status === undefined) return linked

  // Link lifecycle may advance the item, but the lifecycle source of truth is
  // still the Markdown frontmatter. Never reintroduce status into items.json.
  return updateBacklogStatus({
    workspaceRoot: input.workspaceRoot,
    relativePath: input.relativePath,
    status: input.status,
  })
}

export async function removeBacklogLink(input: BacklogRemoveLinkInput): Promise<BacklogMutationResult> {
  const linkId = input.linkId.trim()
  if (!linkId) return { ok: false, message: 'Choose a Backlog link to remove.' }
  const removed = await mutateItem(input.workspaceRoot, input.relativePath, (record, now) => ({
    ...record,
    links: (record.links ?? []).filter((candidate) => candidate.id !== linkId),
    updatedAt: now,
  }))
  if (!removed.ok) return removed

  // The frontmatter half has to go too, or the next scan rebuilds the link from
  // the file and the removal silently undoes itself.
  const durable = await readDurableBacklogLinks(input.workspaceRoot, input.relativePath)
  if (!durable.some((candidate) => candidate.id === linkId)) return removed
  const written = await writeBacklogFrontmatter(
    input.workspaceRoot,
    input.relativePath,
    durableBacklogLinkFields(durable.filter((candidate) => candidate.id !== linkId)),
  )
  return written.ok ? removed : written
}

// An item's durable links as its own file currently declares them. Reading the
// file rather than the cache is the point: the file is the source of truth, and a
// cache wiped between two writes must not silently drop the other links.
async function readDurableBacklogLinks(workspaceRoot: string, relativePath: string): Promise<BacklogItemLinkPayload[]> {
  try {
    const workspace = await validateWorkspaceRoot(workspaceRoot)
    const normalizedPath = validateBacklogRelativePath(relativePath)
    const target = backlogAbsolutePath(workspace.location, normalizedPath)
    if (!target) return []
    const { fields } = parseBacklogFrontmatter(await readFile(target, 'utf-8'))
    return durableBacklogLinksFromFrontmatter(fields) as BacklogItemLinkPayload[]
  } catch {
    // A missing or unreadable item contributes no links; the caller's own write
    // reports the real failure.
    return []
  }
}

async function clearBacklogSidecarStatus(workspaceRoot: string, relativePath: string): Promise<BacklogMutationResult> {
  try {
    validateBacklogRelativePath(relativePath)
    const workspace = await validateWorkspaceRoot(workspaceRoot)
    const store = await loadStore(workspace)
    const pathKey = normalizeRelativePath(relativePath).toLowerCase()
    let changed = false
    const items = store.items.map((record) => {
      if (record.source.relativePath.toLowerCase() !== pathKey || record.status === undefined) return record
      const { status: _status, ...next } = record
      changed = true
      return next
    })
    if (!changed) return { ok: true, store }
    const nextStore = normalizeStore({ schemaVersion: 1, items })
    await saveStore(workspace, nextStore)
    return { ok: true, store: nextStore }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

export async function updateBacklogModuleMetadata(input: BacklogModuleMetadataInput): Promise<BacklogMutationResult> {
  const moduleId = input.moduleId.trim()
  if (!moduleId) return { ok: false, message: 'Backlog module metadata requires a module id.' }
  return mutateItem(input.workspaceRoot, input.relativePath, (record, now) => ({
    ...record,
    metadata: {
      ...record.metadata,
      [moduleId]: input.value,
    },
    updatedAt: now,
  }))
}

export async function moveBacklogObjectSource(input: BacklogMoveSourceInput): Promise<BacklogMutationResult> {
  let nextRelativePath: string
  try {
    nextRelativePath = validateBacklogRelativePath(input.nextRelativePath)
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
  // v2: archived-ness is path-derived by the reader (isArchivedBacklogPath in
  // src/renderer/src/utils/backlog.ts), so the move only rewrites the sidecar
  // source path. Writing status:'archived' here would orphan a lifecycle field
  // the reader never consults, and — since status is migratable under sidecar-
  // wins precedence — a later loadMigratedStore pass would push it back into the
  // archived file's frontmatter, clobbering its true pre-archive status. Mirror
  // the mutateItem pattern that deliberately never seeds lifecycle into items.json.
  return mutateItem(input.workspaceRoot, input.relativePath, (record, now) => ({
    ...record,
    source: { type: 'file', relativePath: nextRelativePath },
    updatedAt: now,
  }))
}

export async function removeBacklogObjectRecord(input: BacklogRemoveRecordInput): Promise<BacklogMutationResult> {
  return mutateStore(
    input.workspaceRoot,
    () => validateBacklogRelativePath(input.relativePath),
    (store) => {
      const pathKey = normalizeRelativePath(input.relativePath).toLowerCase()
      return {
        schemaVersion: 1,
        items: store.items.filter((record) => record.source.relativePath.toLowerCase() !== pathKey),
      }
    },
  )
}

// Read/modify/write the item's markdown frontmatter through the shared
// serializer (T1), leaving items.json untouched. This is the seam epic writes
// (T8) reuse — pass `{ epic: slug }` to point a child, `{ epic: null }` to
// orphan it. Path and workspace validation mirror the items.json mutators, and
// every failure returns an explicit `ok:false` rather than a silent fallback.
async function writeBacklogFrontmatter(
  workspaceRoot: string,
  relativePath: string,
  updates: BacklogFrontmatterUpdates,
): Promise<BacklogMutationResult> {
  let normalizedPath: string
  try {
    normalizedPath = validateBacklogRelativePath(relativePath)
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
  try {
    const workspace = await validateWorkspaceRoot(workspaceRoot)
    const target = backlogAbsolutePath(workspace.location, normalizedPath)
    if (!target) throw new Error('Backlog item path escaped the backlog root.')

    let content: string
    try {
      content = await readFile(target, 'utf-8')
    } catch (error) {
      const detail = isMissingFileError(error) ? 'file not found' : errorMessage(error)
      throw new Error(`Could not read Backlog item: ${detail}`)
    }

    const changed = serializeBacklogFrontmatterFields(content, updates)
    if (changed !== content) {
      // Every real content mutation records a portable, second-level-or-better
      // instant. A date-only value is not precise enough for the row's relative
      // age and Date.parse would silently anchor it to UTC midnight.
      const next = serializeBacklogFrontmatterFields(changed, { updated: new Date().toISOString() })
      try {
        await writeFile(target, next, 'utf-8')
      } catch (error) {
        throw new Error(`Could not write Backlog item: ${errorMessage(error)}`)
      }
    }
    // Frontmatter is the source of truth for these fields, but the result still
    // carries the (unchanged) sidecar so the IPC contract and renderer callers
    // stay identical.
    const store = await loadStore(workspace)
    return { ok: true, store }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

async function mutateItem(
  workspaceRoot: string,
  relativePath: string,
  update: (record: BacklogObjectRecord, now: string) => BacklogObjectRecord,
): Promise<BacklogMutationResult> {
  return mutateStore(
    workspaceRoot,
    () => validateBacklogRelativePath(relativePath),
    (store, now) => {
      const normalizedPath = normalizeRelativePath(relativePath)
      const pathKey = normalizedPath.toLowerCase()
      const index = store.items.findIndex((record) => record.source.relativePath.toLowerCase() === pathKey)
      const base: BacklogObjectRecord =
        index >= 0
          ? store.items[index]
          : // v2: a record materialized by a highlight/link/metadata mutation carries
            // only app-owned churn. Seeding a default `status` here would let the lazy
            // migrator later overwrite the item's real frontmatter status with 'idea'.
            {
              id: stableBacklogObjectId(normalizedPath),
              source: { type: 'file', relativePath: normalizedPath },
              metadata: {},
              links: [],
              createdAt: now,
              updatedAt: now,
            }
      const items = [...store.items]
      const candidate = update(base, now)
      // Every updater stamps `updatedAt: now` unconditionally, so a write that
      // changed nothing else still dirtied the record — and with it a tracked file.
      // Link status re-resolution ticks against live PRs and re-persists what is
      // already stored, which is what churned the sidecar all day. Keep the prior instant when the payload is otherwise identical, so a
      // confirming re-resolve is a true no-op and saveStore can skip the write.
      const next = index >= 0 && sameBacklogRecord({ ...candidate, updatedAt: base.updatedAt }, base) ? base : candidate
      if (index >= 0) {
        items[index] = next
      } else {
        items.push(next)
      }
      return { schemaVersion: 1, items }
    },
  )
}

async function mutateStore(
  workspaceRoot: string,
  validate: () => unknown,
  update: (store: BacklogObjectStore, now: string) => BacklogObjectStore,
): Promise<BacklogMutationResult> {
  try {
    validate()
    const workspace = await validateWorkspaceRoot(workspaceRoot)
    const store = await loadStore(workspace)
    const nextStore = normalizeStore(update(store, new Date().toISOString()))
    await saveStore(workspace, nextStore)
    return { ok: true, store: nextStore }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

async function validateWorkspaceRoot(workspaceRoot: string): Promise<ValidWorkspace> {
  if (!isAbsolute(workspaceRoot)) throw new Error('Backlog workspace root must be an absolute path.')
  const root = await realpath(workspaceRoot).catch((error) => {
    throw new Error(`Backlog workspace root is not accessible: ${errorMessage(error)}`)
  })
  const rootStat = await stat(root).catch((error) => {
    throw new Error(`Backlog workspace root is not accessible: ${errorMessage(error)}`)
  })
  if (!rootStat.isDirectory()) throw new Error('Backlog workspace root must be an existing folder.')
  // Every Backlog read and write passes here, so each waits out the store's
  // one-time move before it reads a config or the cache.
  await workspaceStoreReady(root)
  return {
    root,
    storePath: workspaceStorePath(root, ...STORE_PATH),
    location: backlogLocationFor(root, await readConfiguredBacklogRoot(root)),
  }
}

async function loadStore(workspace: ValidWorkspace): Promise<BacklogObjectStore> {
  let raw: string
  try {
    raw = await readFile(workspace.storePath, 'utf-8')
  } catch (error) {
    if (isMissingFileError(error)) return EMPTY_STORE
    throw new Error(`Could not read Backlog metadata: ${errorMessage(error)}`)
  }
  try {
    return normalizeStore(JSON.parse(raw) as unknown)
  } catch (error) {
    throw new Error(`Could not parse Backlog metadata: ${errorMessage(error)}`)
  }
}

async function saveStore(workspace: ValidWorkspace, store: BacklogObjectStore): Promise<void> {
  const target = resolve(workspace.storePath)
  const next = `${JSON.stringify(normalizeStore(store), null, 2)}\n`
  // Every scan reaches a save, even one that discovers nothing: `mutateStore` has
  // no change check, and the reducers that do (ensureBacklogObjectRecords) guard
  // only themselves. The sidecar was ~550KB and tracked, so rewriting identical
  // bytes cost a full serialize per scan AND left the working tree permanently
  // dirty; in the store it would still be a write per scan. normalizeStore emits
  // a fixed key order, so equal content is equal bytes and this comparison is
  // exact rather than heuristic.
  let current: string | null = null
  try {
    current = await readFile(target, 'utf-8')
  } catch (error) {
    if (!isMissingFileError(error)) throw new Error(`Could not read Backlog metadata: ${errorMessage(error)}`)
  }
  if (current === next) return
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, next, 'utf-8')
  } catch (error) {
    throw new Error(`Could not write Backlog metadata: ${errorMessage(error)}`)
  }
}

function validateBacklogRelativePath(value: string): string {
  if (isAbsolutePathInput(value)) {
    throw new Error('Backlog item paths must be relative paths under backlog/.')
  }
  const normalized = normalizeRelativePath(value)
  if (!normalized.startsWith(BACKLOG_PREFIX) || isUnsafeRelativePath(normalized)) {
    throw new Error('Backlog item paths must be relative paths under backlog/.')
  }
  return normalized
}

async function uniqueBacklogFilePath(
  workspace: ValidWorkspace,
  title: string,
  existingLower: Set<string>,
  folder?: string,
): Promise<string> {
  return uniqueBacklogFilePathFromBase(
    workspace,
    `${backlogTodayPrefix(new Date())}-${slugifyBacklogTitle(title)}`,
    existingLower,
    folder,
  )
}

// Collision-safe `backlog/<base>.md`, appending `-2`, `-3`, … against both the
// current store and the filesystem. Shared by native-item creation and the proxy
// writer so both agree on how a duplicate base becomes a distinct filename.
async function uniqueBacklogFilePathFromBase(
  workspace: ValidWorkspace,
  base: string,
  existingLower: Set<string>,
  folder?: string,
): Promise<string> {
  // `folder` is always an epic slug or UNFILED_DIR, both single path segments —
  // isValidEpicSlug rejects separators and `..`, and validateBacklogRelativePath
  // is the backstop.
  const prefix = folder ? `${BACKLOG_PREFIX}${folder}/` : BACKLOG_PREFIX
  // Uniqueness is checked on the filename STEM across the whole backlog, not just
  // on the path inside the destination folder. `dependsOn:` and `epic:` address
  // an item by its stem (backlogItemSlugFromPath), so two items sharing a stem in
  // different epic folders would collide on every pointer aimed at either.
  const takenStems = await backlogFileStems(workspace)
  let stem = base
  let index = 2
  while (takenStems.has(stem.toLowerCase()) || existingLower.has(`${prefix}${stem}.md`.toLowerCase())) {
    stem = `${base}-${index}`
    index += 1
  }
  return validateBacklogRelativePath(`${prefix}${stem}.md`)
}

// Every backlog markdown stem already on disk, lowercased. Reuses the shared walk
// because items now live one folder deep and a stem must be unique across all of
// them, not just within one directory.
async function backlogFileStems(workspace: ValidWorkspace): Promise<Set<string>> {
  const stems = new Set<string>()
  for (const relativePath of await listAllBacklogSourcePaths(workspace)) {
    if (!relativePath.toLowerCase().endsWith('.md')) continue
    stems.add(basename(relativePath).slice(0, -3).toLowerCase())
  }
  return stems
}

async function uniqueEpicFilePath(
  workspace: ValidWorkspace,
  slug: string,
  existingLower: Set<string>,
): Promise<string> {
  let candidate = `${EPICS_PREFIX}${slug}.md`
  let index = 2
  while (existingLower.has(candidate.toLowerCase()) || (await backlogFileExists(workspace, candidate))) {
    candidate = `${EPICS_PREFIX}${slug}-${index}.md`
    index += 1
  }
  return validateBacklogRelativePath(candidate)
}

async function backlogFileExists(workspace: ValidWorkspace, relativePath: string): Promise<boolean> {
  const target = backlogAbsolutePath(workspace.location, relativePath)
  if (!target) return false
  try {
    await stat(target)
    return true
  } catch (error) {
    if (isMissingFileError(error)) return false
    throw error
  }
}

function slugifyBacklogTitle(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  )
}

function backlogTodayPrefix(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function normalizeStore(value: unknown): BacklogObjectStore {
  if (!value || typeof value !== 'object') return EMPTY_STORE
  const raw = value as { items?: unknown }
  const items = Array.isArray(raw.items)
    ? raw.items.map(normalizeRecord).filter((record): record is BacklogObjectRecord => Boolean(record))
    : []
  // Migrate records keyed by the retired djb2 hash onto the canonical FNV-1a id,
  // merging any that collapse onto the same id (union links, newest wins). Runs
  // on every load/save/mutate through this one chokepoint and is idempotent.
  return { schemaVersion: 1, items: reconcileBacklogObjectRecordIds(items) }
}

// Field-for-field record equality, taken through the canonical normalizer so the
// comparison cannot be fooled by key order or by fields normalizeRecord drops.
function sameBacklogRecord(a: BacklogObjectRecord, b: BacklogObjectRecord): boolean {
  return JSON.stringify(normalizeRecord(a)) === JSON.stringify(normalizeRecord(b))
}

function normalizeRecord(value: unknown): BacklogObjectRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as BacklogObjectRecord
  if (!raw.source || typeof raw.source.relativePath !== 'string') return null
  let relativePath: string
  try {
    relativePath = validateBacklogRelativePath(raw.source.relativePath)
  } catch {
    return null
  }
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : stableBacklogObjectId(relativePath)
  return {
    id,
    source: { type: 'file', relativePath },
    status: isBacklogStatus(raw.status) ? raw.status : undefined,
    type: isBacklogType(raw.type) ? raw.type : undefined,
    difficulty: isBacklogDifficulty(raw.difficulty) ? raw.difficulty : undefined,
    criticality: isBacklogCriticality(raw.criticality) ? raw.criticality : undefined,
    highlight: normalizeBacklogHighlight(raw.highlight),
    metadata: isPlainRecord(raw.metadata) ? raw.metadata : {},
    links: Array.isArray(raw.links)
      ? raw.links.map(normalizeBacklogLink).filter((link): link is BacklogItemLinkPayload => Boolean(link))
      : [],
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
  }
}

function normalizeBacklogHighlight(value: unknown): BacklogObjectRecord['highlight'] {
  if (!isPlainRecord(value)) return undefined
  const starred = value.starred === true
  const color = isBacklogHighlightColor(value.color) ? value.color : null
  if (!starred && color === null) return undefined
  return { starred, color }
}

function normalizeBacklogLink(value: unknown): BacklogItemLinkPayload | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as BacklogItemLinkPayload
  if (
    typeof raw.id !== 'string' ||
    typeof raw.moduleId !== 'string' ||
    typeof raw.type !== 'string' ||
    typeof raw.label !== 'string' ||
    !raw.target ||
    typeof raw.target.kind !== 'string' ||
    typeof raw.target.id !== 'string'
  ) {
    return null
  }
  return {
    id: raw.id,
    moduleId: raw.moduleId,
    type: raw.type,
    label: raw.label,
    target: {
      kind: raw.target.kind,
      id: raw.target.id,
      path: typeof raw.target.path === 'string' ? raw.target.path : undefined,
      url: typeof raw.target.url === 'string' ? raw.target.url : undefined,
    },
    status: typeof raw.status === 'string' ? raw.status : undefined,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
  }
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
}

function isUnsafeRelativePath(path: string): boolean {
  return path === '..' || path.startsWith('../') || path.includes('/../') || isAbsolute(path)
}

function isAbsolutePathInput(path: string): boolean {
  return isAbsolute(path) || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)
}

function isBacklogStatus(value: unknown): value is BacklogObjectRecord['status'] {
  return typeof value === 'string' && VALID_STATUS.has(value)
}

function isBacklogType(value: unknown): value is BacklogObjectRecord['type'] {
  return typeof value === 'string' && VALID_TYPE.has(value)
}

function isBacklogDifficulty(value: unknown): value is BacklogObjectRecord['difficulty'] {
  return typeof value === 'string' && VALID_DIFFICULTY.has(value)
}

function isBacklogCriticality(value: unknown): value is BacklogObjectRecord['criticality'] {
  return typeof value === 'string' && VALID_CRITICALITY.has(value)
}

function isBacklogRisk(value: unknown): value is BacklogObjectRecord['risk'] {
  return typeof value === 'string' && VALID_RISK.has(value)
}

// An epic slug is a single filename-stem token (it must match an epic file's
// stem at read time), so reject whitespace, separators, and other characters
// that could never name `backlog/epics/<slug>.md`.
function isValidEpicSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..'
}

function isBacklogHighlightColor(value: unknown): value is BacklogHighlightColorPayload {
  return typeof value === 'string' && VALID_HIGHLIGHT_COLOR.has(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT')
}
