import { comparablePath } from '../../../../shared/host-paths'
import type {
  WorktreeDependencyInstallSetting,
  WorktreeDependencyInstallView,
  WorktreeInventory,
  WorktreeInventoryEntry,
  WorktreePoolSlotView,
} from '../../../../shared/ipc/worktree-pool'
import { workspaceProjectRootOf } from '../../../../shared/worktree-paths'
import { formatRelativeMsAgo } from '../../utils/relativeTime'

/**
 * Settings ▸ Worktrees, as data: every worktree of every project the window
 * knows, from main's inventory (worktree-pool/worktree-inventory.ts), joined
 * with the chats that use them. Pure, so what a row says and what may be done
 * to it are decided (and tested) apart from the page that draws them.
 */

/** Where a worktree is, as the page sorts and filters it. */
export type WorktreeRowState =
  /** A pool slot an agent or chat holds. */
  | 'in-use'
  /** A pool slot between states: being made, handed out, taken back or removed. */
  | 'busy'
  /** A pool slot holding work, waiting for a person. */
  | 'held'
  /** A pool slot ready to reuse. */
  | 'ready'
  /** A worktree the pool does not own. */
  | 'other'
  /** Registered with git, gone from disk. */
  | 'missing'

export type WorktreeFilter = 'all' | 'in-use' | 'ready' | 'held' | 'other'

/** The part of a workspace record the page needs. */
export type WorktreeChatSource = {
  id: string
  name: string
  folderPath: string | null
  worktree?: { repoRoot?: string; branch?: string } | null
  settledAt?: number | null
  agents?: Record<string, { execution?: { cwd?: string | null; worktreeId?: string | null } | null } | undefined>
  /** The worktrees the chat's agents were spawned into (the tab strip's "+ Worktree"). */
  worktreeState?: {
    entries?: Record<string, { path?: string | null; status?: string; ownerAgentId?: string | null } | undefined>
  } | null
  remoteOrigin?: unknown
  environment?: unknown
}

export type WorktreeChat = { workspaceId: string; title: string; settled: boolean }

export type WorktreeRow = {
  /** The path, which is unique across every project. */
  key: string
  repoRoot: string
  path: string
  /** The slot's id, or the folder's name. */
  name: string
  state: WorktreeRowState
  /** What the state badge says. */
  stateLabel: string
  slot: WorktreePoolSlotView | null
  entry: WorktreeInventoryEntry | null
  branch: string | null
  /** One line under the branch: where it stands against the default branch. */
  branchNote: string
  chat: WorktreeChat | null
  /** Who or what uses it, in one line. */
  usedBy: string
  bytes: number | null
  /** When it was last used (a stage, commit or checkout in it, or a slot's last lease); null when unknown. */
  lastUsedAt: number | null
  /** What a person may do to it from this page: remove it (pool or git), prune it, or nothing. */
  removal: 'evict' | 'remove' | 'prune' | null
  /** Why it may not be removed, when it may not. */
  keptBecause: string | null
}

export type WorktreeProjectView = {
  repoRoot: string
  name: string
  defaultRef: string | null
  lastFetchAt: number | null
  /** Another Studio drives this pool; its slots are shown, never changed from here. */
  heldByOtherInstance: boolean
  containerPath: string | null
  poolRows: WorktreeRow[]
  otherRows: WorktreeRow[]
  bytes: number
  error: string | null
}

export type WorktreeTotals = {
  count: number
  inUse: number
  ready: number
  held: number
  other: number
  bytes: { inUse: number; ready: number; held: number; other: number; pool: number; all: number }
  /** Workspaces using the slots in use: chats, and the scheduled runs among them. */
  chats: number
}

const BUSY_LABEL: Record<string, string> = {
  creating: 'Being made',
  leasing: 'Getting ready',
  returning: 'Coming back',
  evicting: 'Being removed',
}

function baseName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/u, '')
      .split(/[\\/]/u)
      .pop() ?? path
  )
}

/** Bytes for a person: `840 MB`, `1.9 GB`. */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—'
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb >= 100 ? Math.round(gb) : gb.toFixed(1)} GB`
  const mb = bytes / 1024 ** 2
  if (mb >= 1) return `${Math.round(mb)} MB`
  // Nothing is nothing; only a few bytes round up, so they never read as none.
  if (bytes <= 0) return '0 KB'
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** The local projects the window knows of, for the inventory to start from. */
export function inventoryRootsOf(workspaces: readonly WorktreeChatSource[]): string[] {
  const roots = new Map<string, string>()
  for (const workspace of workspaces) {
    if (workspace.remoteOrigin || workspace.environment) continue
    const root = workspaceProjectRootOf(workspace)
    if (root && !roots.has(comparablePath(root))) roots.set(comparablePath(root), root)
  }
  return [...roots.values()]
}

type ChatIndex = {
  byPath: Map<string, WorktreeChat[]>
  byWorkspace: Map<string, WorktreeChat>
  /** By bare agent id, for a lease that does not name its chat; ids repeat across chats, so a guess. */
  byAgent: Map<string, WorktreeChat>
}

/**
 * Every folder a chat works in: its own, and the worktrees its agents were
 * spawned into, which are not its folder (an agent the tab strip started
 * "+ Worktree" works in one of its own, recorded on the chat's worktree
 * entries and the agent's working directory). A worktree only an agent uses
 * is as much in use as a chat's folder, and must not read as free to remove.
 */
function indexChats(workspaces: readonly WorktreeChatSource[]): ChatIndex {
  const byPath = new Map<string, WorktreeChat[]>()
  const byWorkspace = new Map<string, WorktreeChat>()
  const byAgent = new Map<string, WorktreeChat>()
  for (const workspace of workspaces) {
    if (workspace.remoteOrigin || workspace.environment) continue
    const chat = { workspaceId: workspace.id, title: workspace.name, settled: Boolean(workspace.settledAt) }
    byWorkspace.set(workspace.id, chat)
    const paths = new Set<string>()
    if (workspace.folderPath) paths.add(comparablePath(workspace.folderPath))
    const agents = workspace.agents ?? {}
    for (const [agentId, agent] of Object.entries(agents)) {
      byAgent.set(agentId, chat)
      if (agent?.execution?.cwd) paths.add(comparablePath(agent.execution.cwd))
    }
    for (const entry of Object.values(workspace.worktreeState?.entries ?? {})) {
      if (!entry?.path) continue
      // As the cleanup reads them: an entry assigned to an agent that is gone
      // is an orphan, not a use.
      const assigned = entry.status === 'assigned' && (!entry.ownerAgentId || agents[entry.ownerAgentId])
      if (assigned || entry.status === 'removing') paths.add(comparablePath(entry.path))
    }
    for (const key of paths) byPath.set(key, [...(byPath.get(key) ?? []), chat])
  }
  return { byPath, byWorkspace, byAgent }
}

/** The chat whose agent leased a slot itself: by the chat the lease names, else (an older lease) by the id. */
function chatOfLeasingAgent(index: ChatIndex, lease: WorktreePoolSlotView['lease']): WorktreeChat | null {
  if (!lease?.agentId) return null
  if (lease.workspaceId) return index.byWorkspace.get(lease.workspaceId) ?? null
  return index.byAgent.get(lease.agentId) ?? null
}

/** The chat that works in a folder, or anywhere inside it: an open one before a settled one. */
function chatAt(index: ChatIndex, path: string): WorktreeChat | null {
  const key = comparablePath(path)
  const chats = [...(index.byPath.get(key) ?? [])]
  for (const [candidate, at] of index.byPath) if (candidate.startsWith(`${key}/`)) chats.push(...at)
  return chats.find((chat) => !chat.settled) ?? chats[0] ?? null
}

function branchNote(entry: WorktreeInventoryEntry | null, defaultRef: string | null): string {
  if (!entry) return ''
  const parts: string[] = []
  if (entry.changedPaths) parts.push(`${entry.changedPaths} uncommitted change${entry.changedPaths === 1 ? '' : 's'}`)
  if (entry.uniqueCommits) parts.push(`${entry.uniqueCommits} commit${entry.uniqueCommits === 1 ? '' : 's'} ahead`)
  if (entry.behindCommits && defaultRef) parts.push(`${entry.behindCommits} behind ${defaultRef}`)
  return parts.join(' · ')
}

function slotRow(
  repoRoot: string,
  slot: WorktreePoolSlotView,
  entry: WorktreeInventoryEntry | null,
  defaultRef: string | null,
  chats: ChatIndex,
  now: number,
  foreign: boolean,
): WorktreeRow {
  const state: WorktreeRowState =
    slot.state === 'leased' ? 'in-use' : slot.state === 'held' ? 'held' : slot.state === 'idle' ? 'ready' : 'busy'
  const chat =
    slot.state === 'leased' || slot.state === 'leasing'
      ? (chatAt(chats, slot.path) ?? chatOfLeasingAgent(chats, slot.lease))
      : null
  const branch = slot.lease?.branch ?? slot.held?.branch ?? entry?.branch ?? null
  let usedBy: string
  if (state === 'ready') {
    const when = formatRelativeMsAgo(slot.lastUsedAt, now)
    usedBy = slot.lastUsedAt ? `Last used ${when}` : 'Never used yet'
  } else if (state === 'held') {
    usedBy = slot.held?.detail ?? 'Came back with changes'
  } else if (chat) {
    usedBy = chat.title
  } else if (slot.lease) {
    usedBy = slot.lease.agentId ? 'An agent that leased it itself' : 'A chat not open here'
  } else {
    usedBy = BUSY_LABEL[slot.state] ?? slot.state
  }
  const removal = !foreign && state === 'ready' ? 'evict' : null
  return {
    key: slot.path,
    repoRoot,
    path: slot.path,
    name: slot.id,
    state,
    stateLabel:
      state === 'in-use'
        ? 'In use'
        : state === 'held'
          ? 'Holding work'
          : state === 'ready'
            ? 'Ready'
            : (BUSY_LABEL[slot.state] ?? 'Busy'),
    slot,
    entry,
    branch: state === 'ready' ? null : branch,
    branchNote:
      state === 'ready'
        ? [
            slot.baseRef ? `at ${slot.baseRef}${slot.baseSha ? ` ${slot.baseSha.slice(0, 7)}` : ''}` : '',
            entry?.behindCommits ? `${entry.behindCommits} behind` : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : branchNote(entry, defaultRef),
    chat,
    usedBy,
    bytes: slot.size?.bytes ?? entry?.size?.bytes ?? null,
    lastUsedAt: entry?.lastUsedAt ?? slot.lastUsedAt,
    removal,
    keptBecause: foreign
      ? 'Another SprintEngine Studio manages this pool.'
      : state === 'ready'
        ? null
        : state === 'held'
          ? 'It holds work. Commit, stash or discard it first.'
          : state === 'in-use'
            ? 'It is in use. It comes back to the pool when its chat is done.'
            : 'It is changing right now.',
  }
}

function otherRow(
  repoRoot: string,
  entry: WorktreeInventoryEntry,
  defaultRef: string | null,
  chats: ChatIndex,
): WorktreeRow {
  const chat = chatAt(chats, entry.path)
  if (entry.missing) {
    return {
      key: entry.path,
      repoRoot,
      path: entry.path,
      name: baseName(entry.path),
      state: 'missing',
      stateLabel: 'Missing',
      slot: null,
      entry,
      branch: entry.branch,
      branchNote: 'The folder is gone; git still lists it.',
      chat,
      usedBy: chat ? chat.title : 'No chat',
      bytes: null,
      lastUsedAt: null,
      removal: 'prune',
      keptBecause: null,
    }
  }
  const keptBecause = entry.lockedByOther
    ? 'It is locked by another Studio profile, or by hand.'
    : chat && !chat.settled
      ? `The chat “${chat.title}” works in it.`
      : entry.changedPaths === null
        ? 'Git could not read its status.'
        : entry.changedPaths > 0
          ? `It has ${entry.changedPaths} uncommitted change${entry.changedPaths === 1 ? '' : 's'}.`
          : null
  return {
    key: entry.path,
    repoRoot,
    path: entry.path,
    name: baseName(entry.path),
    state: 'other',
    stateLabel: entry.merged === true ? 'Merged' : entry.merged === false ? 'Not merged' : 'Not in the pool',
    slot: null,
    entry,
    branch: entry.branch,
    branchNote: branchNote(entry, defaultRef),
    chat,
    usedBy: chat ? (chat.settled ? `Settled chat “${chat.title}”` : chat.title) : 'No chat',
    bytes: entry.size?.bytes ?? null,
    lastUsedAt: entry.lastUsedAt,
    removal: keptBecause ? null : 'remove',
    keptBecause,
  }
}

const STATE_ORDER: Record<WorktreeRowState, number> = { 'in-use': 0, busy: 1, held: 2, ready: 3, other: 4, missing: 5 }

export function buildWorktreeProjects(
  inventory: WorktreeInventory,
  workspaces: readonly WorktreeChatSource[],
  now: number,
): WorktreeProjectView[] {
  const chats = indexChats(workspaces)
  return (
    inventory.projects
      .map((project) => {
        const pool = project.pool
        const foreign = pool?.heldByOtherInstance === true
        const entries = new Map(project.worktrees.map((entry) => [comparablePath(entry.path), entry]))
        const poolRows = (pool?.slots ?? [])
          .map((slot) =>
            slotRow(
              project.repoRoot,
              slot,
              entries.get(comparablePath(slot.path)) ?? null,
              project.defaultRef,
              chats,
              now,
              foreign,
            ),
          )
          .sort(
            (a, b) =>
              STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
              (b.slot?.lastUsedAt ?? 0) - (a.slot?.lastUsedAt ?? 0) ||
              a.name.localeCompare(b.name),
          )
        const slotPaths = new Set(poolRows.map((row) => comparablePath(row.path)))
        const otherRows = project.worktrees
          .filter((entry) => !entry.slotId && !slotPaths.has(comparablePath(entry.path)))
          .map((entry) => otherRow(project.repoRoot, entry, project.defaultRef, chats))
          // The one used last first: the long tail at the foot is what is safe to let go.
          .sort(
            (a, b) =>
              STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
              (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) ||
              a.name.localeCompare(b.name),
          )
        const bytes = [...poolRows, ...otherRows].reduce((sum, row) => sum + (row.bytes ?? 0), 0)
        return {
          repoRoot: project.repoRoot,
          name: baseName(project.repoRoot),
          defaultRef: project.defaultRef,
          lastFetchAt: pool?.lastFetchAt ?? null,
          heldByOtherInstance: foreign,
          containerPath: pool?.containerPath ?? null,
          poolRows,
          otherRows,
          bytes,
          error: project.error,
        }
      })
      // The project worked in last leads (owner, 2026-10-08), by its most
      // recently used worktree; one with none known sorts by name below.
      .sort((a, b) => projectUsedAt(b) - projectUsedAt(a) || a.name.localeCompare(b.name))
  )
}

function projectUsedAt(project: WorktreeProjectView): number {
  let latest = 0
  for (const row of [...project.poolRows, ...project.otherRows]) latest = Math.max(latest, row.lastUsedAt ?? 0)
  return latest
}

export function worktreeTotals(projects: readonly WorktreeProjectView[]): WorktreeTotals {
  const totals: WorktreeTotals = {
    count: 0,
    inUse: 0,
    ready: 0,
    held: 0,
    other: 0,
    bytes: { inUse: 0, ready: 0, held: 0, other: 0, pool: 0, all: 0 },
    chats: 0,
  }
  const chats = new Set<string>()
  for (const project of projects) {
    for (const row of [...project.poolRows, ...project.otherRows]) {
      const bytes = row.bytes ?? 0
      totals.count += 1
      totals.bytes.all += bytes
      if (row.slot) totals.bytes.pool += bytes
      if (row.state === 'in-use' || row.state === 'busy') {
        totals.inUse += 1
        totals.bytes.inUse += bytes
        if (row.chat) chats.add(row.chat.workspaceId)
      } else if (row.state === 'ready') {
        totals.ready += 1
        totals.bytes.ready += bytes
      } else if (row.state === 'held') {
        totals.held += 1
        totals.bytes.held += bytes
      } else {
        totals.other += 1
        totals.bytes.other += bytes
      }
    }
  }
  totals.chats = chats.size
  return totals
}

export function rowMatches(row: WorktreeRow, filter: WorktreeFilter, query: string): boolean {
  const inFilter =
    filter === 'all' ||
    (filter === 'in-use' && (row.state === 'in-use' || row.state === 'busy')) ||
    (filter === 'ready' && row.state === 'ready') ||
    (filter === 'held' && row.state === 'held') ||
    (filter === 'other' && (row.state === 'other' || row.state === 'missing'))
  if (!inFilter) return false
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [row.name, row.path, row.branch ?? '', row.usedBy, row.chat?.title ?? '', row.slot?.lastBranch ?? '']
    .join('\n')
    .toLowerCase()
    .includes(needle)
}

export type FreeSpacePlan = {
  /** Ready slots beyond the most recently used one of each project. */
  extraReady: WorktreeRow[]
  /** Worktrees outside the pool whose work is on the default branch, and that nothing keeps. */
  merged: WorktreeRow[]
  /** The ready slot each project keeps; clearing its ignored files is offered. */
  keptReady: WorktreeRow[]
  /** Removable worktrees outside the pool whose work is NOT on the default branch: never offered here. */
  unmerged: WorktreeRow[]
}

export function planFreeSpace(projects: readonly WorktreeProjectView[]): FreeSpacePlan {
  const plan: FreeSpacePlan = { extraReady: [], merged: [], keptReady: [], unmerged: [] }
  for (const project of projects) {
    if (project.heldByOtherInstance) continue
    const ready = project.poolRows
      .filter((row) => row.state === 'ready')
      .sort((a, b) => (b.slot?.lastUsedAt ?? 0) - (a.slot?.lastUsedAt ?? 0))
    if (ready[0]) plan.keptReady.push(ready[0])
    plan.extraReady.push(...ready.slice(1))
    for (const row of project.otherRows) {
      if (row.removal !== 'remove') continue
      if (row.entry?.merged === true) plan.merged.push(row)
      else plan.unmerged.push(row)
    }
  }
  return plan
}

export function bytesOf(rows: readonly WorktreeRow[]): number {
  return rows.reduce((sum, row) => sum + (row.bytes ?? 0), 0)
}

/** A slot's size breakdown entries, named for a person. */
export function partLabel(name: string): string {
  return name === '…' ? 'Everything else' : name
}

/**
 * Every project's install choice with this one's replaced, under the path the
 * page names the project by: an entry that spells the same project another
 * way goes, so one project never holds two answers.
 */
export function withDependencyInstall(
  current: Readonly<Record<string, WorktreeDependencyInstallSetting>>,
  repoRoot: string,
  setting: WorktreeDependencyInstallSetting,
): Record<string, WorktreeDependencyInstallSetting> {
  const key = comparablePath(repoRoot)
  const next = Object.fromEntries(Object.entries(current ?? {}).filter(([root]) => comparablePath(root) !== key))
  next[repoRoot] = setting
  return next
}

/**
 * Every project's submodules-and-LFS choice with this one's set, under the path
 * the page names the project by. Off is the default and is not kept.
 */
export function withSubmodulesAndLfs(
  current: Readonly<Record<string, boolean>>,
  repoRoot: string,
  enabled: boolean,
): Record<string, boolean> {
  const key = comparablePath(repoRoot)
  const next = Object.fromEntries(Object.entries(current ?? {}).filter(([root]) => comparablePath(root) !== key))
  if (enabled) next[repoRoot] = true
  return next
}

/**
 * The installs running now, by the worktree each runs in: added as one is
 * heard starting or moving on, dropped as it ends.
 */
export function applyInstallChange(
  current: ReadonlyMap<string, WorktreeDependencyInstallView>,
  view: WorktreeDependencyInstallView,
): Map<string, WorktreeDependencyInstallView> {
  const next = new Map(current)
  const key = comparablePath(view.path)
  if (view.state === 'running') next.set(key, view)
  else if (next.get(key)?.id === view.id) next.delete(key)
  return next
}

/** The install running in this worktree, if one is. */
export function installAt(
  installs: ReadonlyMap<string, WorktreeDependencyInstallView>,
  path: string,
): WorktreeDependencyInstallView | null {
  return installs.get(comparablePath(path)) ?? null
}
