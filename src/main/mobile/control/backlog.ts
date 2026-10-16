import { basename, isAbsolute, join, resolve } from 'path'
import { readdir, readFile } from 'fs/promises'

import {
  defaultBacklogKeyFor,
  ensureBacklogObjectRecords,
  readBacklogConfigText,
  readBacklogFrontmatterFields,
  readBacklogObjectStore,
} from '../../backlog-service'
import {
  backlogTitleFromPath,
  extractBacklogTitle,
  parseBacklogFrontmatter,
  stripBacklogFrontmatter,
} from '../../../shared/backlog/frontmatter'
import { formatBacklogDisplayId, isValidBacklogKey, parseBacklogNumericId } from '../../../shared/backlog/item-id'
import type { BacklogFrontmatterFields } from '../../backlog-service'
import type { BacklogObjectRecordPayload } from '../../../shared/electron-api'
import type {
  MobileControlBacklogEpicSnapshot,
  MobileControlBacklogItemSnapshot,
  MobileControlBacklogWorkspaceSnapshot,
} from './protocol'
import { MobileControlCommandError } from './command-error'
import {
  backlogAbsolutePath,
  backlogLocationFor,
  defaultBacklogLocation,
  type BacklogLocation,
} from '../../../shared/backlog/scan'

const BACKLOG_FOLDER = 'backlog'
const ARCHIVED_PREFIX = 'backlog/archived/'
const maxBacklogItemsPerWorkspace = 50
const maxExcerptCharacters = 280

// Reads one workspace root's backlog for the mobile snapshot: the object store
// (items.json) merged with a scan of backlog/*.md so unregistered captures are
// visible from the phone before the desktop Backlog panel ever opened them.
// Returns null when the workspace has no backlog folder and no store records —
// a calm absence, not an error.
export async function readMobileBacklogWorkspaceSnapshot(
  workspaceRoot: string,
  generatedAt: string,
): Promise<MobileControlBacklogWorkspaceSnapshot | null> {
  const root = resolve(workspaceRoot)
  const backlogLocation = await readBacklogLocation(root)
  const { items, present } = await readActiveBacklogItems(root, backlogLocation)
  if (!present) return null
  if (items.length === 0) return emptyBacklogWorkspaceSnapshot(root, generatedAt)

  const epics = await buildBacklogEpics(root, backlogLocation, items)

  return {
    workspaceId: `backlog:${root}`,
    workspacePath: root,
    workspaceName: basename(root) || root,
    updatedAt: latestTimestamp(items) ?? generatedAt,
    items: items.slice(0, maxBacklogItemsPerWorkspace),
    ...(epics.length > 0 ? { epics } : {}),
  }
}

const EPICS_RELATIVE_PATH = 'backlog/epics'

// Read the workspace's backlog display key (its store's `backlog/config.json`),
// read-only — unlike the desktop resolver, this never persists a derived default,
// because a snapshot read must not write to the workspace.
// Where this workspace keeps its items. Read-only, like the key resolver above:
// a snapshot read must not write to the workspace, and a workspace with no
// configured root reads as the default `<root>/backlog`.
async function readBacklogLocation(root: string): Promise<BacklogLocation> {
  try {
    const raw = await readBacklogConfigText(root)
    const parsed = JSON.parse(raw) as { root?: unknown }
    if (typeof parsed.root === 'string' && parsed.root.trim()) return backlogLocationFor(root, parsed.root)
  } catch {
    // Missing/unreadable config: the default, same as the desktop resolver.
  }
  return defaultBacklogLocation(root)
}

async function readBacklogWorkspaceKey(root: string): Promise<string> {
  try {
    const raw = await readBacklogConfigText(root)
    const parsed = JSON.parse(raw) as { key?: unknown }
    if (isValidBacklogKey(parsed.key)) return parsed.key
  } catch {
    // Missing/unreadable config: fall back to the same default the desktop derives.
  }
  return defaultBacklogKeyFor(root)
}

// Epic metadata: for each `backlog/epics/*.md` file, its display id
// (`<KEY>-<id>`), title, and color from frontmatter, plus a done/total rollup over
// the workspace's items that point at it. Lets the phone render desktop-parity
// epic chips/color bands without denormalizing color onto every item.
async function buildBacklogEpics(
  root: string,
  backlogLocation: BacklogLocation,
  items: MobileControlBacklogItemSnapshot[],
): Promise<MobileControlBacklogEpicSnapshot[]> {
  const epicsDir = backlogAbsolutePath(backlogLocation, EPICS_RELATIVE_PATH)
  let epicFiles: string[]
  try {
    if (epicsDir === null) return []
    epicFiles = (await readdir(epicsDir)).filter((name) => /\.mdx?$/i.test(name))
  } catch {
    return []
  }
  if (epicFiles.length === 0) return []

  const rollups = new Map<string, { done: number; total: number }>()
  for (const item of items) {
    if (!item.epic) continue
    const rollup = rollups.get(item.epic) ?? { done: 0, total: 0 }
    rollup.total += 1
    if (item.status === 'completed') rollup.done += 1
    rollups.set(item.epic, rollup)
  }

  const epics: MobileControlBacklogEpicSnapshot[] = []
  const key = await readBacklogWorkspaceKey(root)
  for (const file of epicFiles.sort()) {
    const slug = file.replace(/\.mdx?$/i, '')
    let raw: string | null = null
    try {
      raw = await readFile(join(epicsDir, file), 'utf-8')
    } catch {
      raw = null
    }
    const fields = raw ? parseBacklogFrontmatter(raw).fields : {}
    const numericId = parseBacklogNumericId(fields.id)
    const color = typeof fields.color === 'string' && fields.color.trim() ? fields.color.trim() : undefined
    const title = raw ? extractBacklogTitle(stripBacklogFrontmatter(raw), file) : slug
    const rollup = rollups.get(slug) ?? { done: 0, total: 0 }
    epics.push({
      slug,
      ...(numericId !== undefined ? { displayId: formatBacklogDisplayId({ key, numericId }) } : {}),
      ...(title ? { title } : {}),
      ...(color ? { color } : {}),
      doneCount: rollup.done,
      totalCount: rollup.total,
    })
  }
  return epics
}

// The snapshot's read pass: merges scanned backlog
// markdown with the items.json records, then builds active, frontmatter-sourced
// item snapshots. `present` is false only when the workspace has neither a
// backlog folder nor any sidecar record (a calm absence, not an error).
async function readActiveBacklogItems(
  root: string,
  backlogLocation: BacklogLocation,
): Promise<{ items: MobileControlBacklogItemSnapshot[]; present: boolean }> {
  const scannedPaths = await scanBacklogMarkdownPaths(backlogLocation)
  const storeResult = await readBacklogObjectStore(root)
  let records: BacklogObjectRecordPayload[] = storeResult.ok ? storeResult.store.items : []

  const known = new Set(records.map((record) => record.source.relativePath.toLowerCase()))
  const unregistered = scannedPaths.filter((relativePath) => !known.has(relativePath.toLowerCase()))
  if (unregistered.length > 0) {
    const ensured = await ensureBacklogObjectRecords(
      root,
      unregistered.map((relativePath) => ({ relativePath })),
    )
    if (ensured.ok) {
      records = ensured.store.items
    }
  }

  const present = !(scannedPaths.length === 0 && records.length === 0)
  // Build every record into a frontmatter-sourced snapshot first, then drop
  // archived ones by their *frontmatter* status (the sidecar status is stale
  // after the v2 migration) and by the archived/ path convention.
  const snapshots = await Promise.all(records.map((record) => toBacklogItemSnapshot(backlogLocation, record)))
  const items = snapshots
    .filter((item) => item.status !== 'archived' && !item.relativePath.toLowerCase().startsWith(ARCHIVED_PREFIX))
    .sort(compareBacklogItems)
  return { items, present }
}

export function assertBacklogRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
  const unsafe =
    isAbsolute(value) ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  if (unsafe || !normalized.startsWith(`${BACKLOG_FOLDER}/`) || !normalized.endsWith('.md')) {
    throw new MobileControlCommandError(
      'path_not_allowed',
      'Backlog item paths must be relative markdown paths under backlog/.',
      false,
    )
  }
  return normalized
}

// Walks the tree. Items live one folder deep — under the epic they belong to, or
// `unfiled/` — so listing only the files directly under `backlog/` showed the
// phone an empty backlog. Same skip rules as the desktop walk and the renderer's
// scan, so all three agree on what exists.
async function scanBacklogMarkdownPaths(backlogLocation: BacklogLocation): Promise<string[]> {
  const paths: string[] = []
  // The prefix stays `backlog` whatever the folder is called on disk: the phone
  // addresses items by the same logical path the desktop does.
  await walk(backlogLocation.root, BACKLOG_FOLDER)
  return paths.sort((left, right) => left.localeCompare(right))

  async function walk(directory: string, prefix: string): Promise<void> {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== '.sprintengine-worktrees') {
          await walk(join(directory, entry.name), `${prefix}/${entry.name}`)
        }
        continue
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) paths.push(`${prefix}/${entry.name}`)
    }
  }
}

async function toBacklogItemSnapshot(
  backlogLocation: BacklogLocation,
  record: BacklogObjectRecordPayload,
): Promise<MobileControlBacklogItemSnapshot> {
  let raw: string | null = null
  try {
    const source = backlogAbsolutePath(backlogLocation, record.source.relativePath)
    raw = source === null ? null : await readFile(source, 'utf-8')
  } catch {
    raw = null
  }
  const body = raw !== null ? stripBacklogFrontmatter(raw) : null
  // Frontmatter is the v2 source of truth for lifecycle/triage/epic; fall back to
  // the sidecar record only for items not yet migrated to frontmatter.
  const fields: BacklogFrontmatterFields = raw !== null ? readBacklogFrontmatterFields(raw) : {}
  const status = fields.status ?? record.status ?? 'idea'
  const type = fields.type ?? record.type
  const difficulty = fields.difficulty ?? record.difficulty
  const criticality = fields.criticality ?? record.criticality

  // `sprintEngineId` and `pullRequestUrl` are optional on the wire and no longer
  // emitted: both were read off Sprint Engine links on the item, and
  // the phone's only use for them was joining an item to a run in the same
  // snapshot. There are no runs in the snapshot any more, so a pointer to one
  // would draw an affordance that dead-ends.

  return {
    itemId: record.id,
    relativePath: record.source.relativePath,
    title: body
      ? extractBacklogTitle(body, record.source.relativePath)
      : backlogTitleFromPath(record.source.relativePath),
    ...(body ? { excerpt: extractExcerpt(body) } : {}),
    status,
    ...(type ? { type } : {}),
    ...(difficulty ? { difficulty } : {}),
    ...(criticality ? { criticality } : {}),
    ...(fields.epic ? { epic: fields.epic } : {}),
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
  }
}

function emptyBacklogWorkspaceSnapshot(root: string, generatedAt: string): MobileControlBacklogWorkspaceSnapshot {
  return {
    workspaceId: `backlog:${root}`,
    workspacePath: root,
    workspaceName: basename(root) || root,
    updatedAt: generatedAt,
    items: [],
  }
}

function extractExcerpt(body: string): string {
  const lines = body.split(/\r?\n/)
  const collected: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      if (collected.length > 0) break
      continue
    }
    collected.push(trimmed)
    if (collected.join(' ').length >= maxExcerptCharacters) break
  }
  const excerpt = collected.join(' ')
  return excerpt.length > maxExcerptCharacters ? `${excerpt.slice(0, maxExcerptCharacters - 1)}…` : excerpt
}

const statusOrder: Record<MobileControlBacklogItemSnapshot['status'], number> = {
  needs_input: 0,
  in_progress: 1,
  ready: 2,
  idea: 3,
  completed: 4,
  archived: 5,
}

function compareBacklogItems(left: MobileControlBacklogItemSnapshot, right: MobileControlBacklogItemSnapshot): number {
  const statusDelta = statusOrder[left.status] - statusOrder[right.status]
  if (statusDelta !== 0) return statusDelta
  const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0
  const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0
  if (leftTime !== rightTime) return rightTime - leftTime
  return left.relativePath.localeCompare(right.relativePath)
}

function latestTimestamp(items: MobileControlBacklogItemSnapshot[]): string | null {
  let latest: string | null = null
  for (const item of items) {
    if (item.updatedAt && (!latest || item.updatedAt > latest)) {
      latest = item.updatedAt
    }
  }
  return latest
}
