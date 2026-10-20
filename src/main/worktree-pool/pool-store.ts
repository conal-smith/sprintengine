import { createHash } from 'crypto'
import { mkdir, open, readFile, readdir, rm, stat, utimes } from 'fs/promises'
import { hostname } from 'os'
import { join } from 'path'
import {
  DEFAULT_WORKTREE_POOL_SETTINGS,
  WORKTREE_POOL_IDLE_RETURN_MAX_MINUTES,
  WORKTREE_POOL_IDLE_RETURN_MIN_MINUTES,
  WORKTREE_POOL_KEEP_IDLE_MAX,
  WORKTREE_POOL_MAX_SLOTS_CEILING,
  WORKTREE_POOL_MAX_SLOTS_MIN,
  WORKTREE_INSTALL_COMMAND_MAX,
  type WorktreeDependencyInstallSetting,
  type WorktreeDiskUsage,
  type WorktreePoolHeldReason,
  type WorktreePoolSettings,
  type WorktreePoolSlotState,
} from '../../shared/ipc/worktree-pool'
import { comparablePath, distroOfUncPath } from '../../shared/host-paths'
import { isRecord } from '../../shared/records'
import { writeFileAtomic } from '../../server/platform/atomic-file'
import { processIsRunning } from '../../server/platform/process-alive'

/**
 * The pool's durable records: one JSON file per pool under
 * `userData/worktree-pool/`, the settings beside them, and a lock file in each
 * pool's slot container that keeps a second Studio off the same slots.
 *
 * Every record is written whole, to a temporary file that is then renamed over
 * the old one, so a crash leaves either the previous record or the new one and
 * never half of each. A slot's `op` is written BEFORE the git step it names
 * starts and cleared after it ends, which is what lets startup tell a slot
 * that was mid-operation from one that was at rest (worktree-pool-service's
 * recovery).
 */

export const POOL_RECORD_VERSION = 3

export type SlotOp = {
  kind: 'create' | 'lease' | 'reset' | 'return' | 'evict' | 'held-action'
  startedAt: number
  pid: number
  /** For `reset`: HEAD before the reset, and the commit it is being moved to. */
  fromSha?: string | null
  toSha?: string | null
}

export type SlotLease = {
  leaseId: string
  branch: string
  /**
   * Who the slot was leased to, as its `worktree lock` names them: an agent's
   * id, or the branch while the agent does not exist yet (a new chat makes its
   * worktree before its workspace).
   */
  owner: string
  /** The agent that asked through MCP (`worktree.lease`), which keeps the slot while it exists. */
  agentId: string | null
  /**
   * The chat `agentId` is in. An agent id is unique only within its chat, so
   * the agent is matched by both; null for a chat's own worktree, and for a
   * lease recorded before this was, which falls back to the id alone.
   */
  workspaceId: string | null
  leasedAt: number
  /**
   * Whether a cleanup sweep has seen the slot in use since the lease. One never
   * seen may simply not be recorded yet (a window writes the chat after its
   * worktree), so only a lease that was seen in use and then not — or one never
   * claimed for {@link UNCLAIMED_LEASE_MS} — is returned.
   */
  claimed: boolean
}

/** How long a lease nobody has been seen using is left alone before it is returned. */
export const UNCLAIMED_LEASE_MS = 60 * 60_000

/**
 * Who a slot given back while they still exist is kept for: a chat whose
 * worktree it was (its folder is the slot), or the agent that leased it
 * through MCP and its chat. What the lease said, so the slot's owner is
 * matched against the app's records as the lease's was.
 */
export type SlotKeeper = {
  branch: string
  /** The agent that leased it itself (`worktree.lease`); null for a chat's own worktree. */
  agentId: string | null
  workspaceId: string | null
  since: number
}

/**
 * A slot's path, kept free for the chat whose slot it was after the slot was
 * removed to make room (`makeRoom`): the chat names that path, and its CLI
 * keys its sessions by it, so the chat must come back there, not to a new
 * one. No new slot is made at it; the chat's return makes one there again.
 */
export type ReservedPath = SlotKeeper & { path: string }

/** The most reserved paths a pool remembers; past it the oldest is forgotten (its chat then gets a fresh worktree there). */
export const RESERVED_PATHS_MAX = 64

export type SlotHeld = {
  reason: WorktreePoolHeldReason
  detail: string | null
  changedPaths: number | null
  branch: string | null
  since: number
}

export type SlotRecord = {
  id: string
  path: string
  state: WorktreePoolSlotState
  baseRef: string | null
  baseSha: string | null
  error: string | null
  lease: SlotLease | null
  held: SlotHeld | null
  lastUsedAt: number | null
  createdAt: number
  op: SlotOp | null
  /** Leases served. */
  uses: number
  /** The branch of the last lease, once the slot is back. */
  lastBranch: string | null
  /** As last measured (Settings ▸ Worktrees, or a return while a disk limit is set). */
  size: WorktreeDiskUsage | null
  /** Why the last removal of this idle slot left it on disk; cleared when it is leased or cleared. */
  kept: string | null
  /**
   * Set on an idle slot given back while its chat or agent still exists
   * (`returnUnused`, `makeRoom`): it is that chat's to come back to, and no
   * lease reuses it as it stands. Cleared when it is leased again, or when
   * its keeper is gone.
   */
  parked: SlotKeeper | null
}

export type PoolRecord = {
  version: number
  poolId: string
  repoRoot: string
  commonDir: string
  /** The execution host (shared/execution-host.ts) whose git the slots belong to. */
  hostId: string
  defaultRef: string | null
  lastFetchAt: number | null
  lastLeaseAt: number | null
  createdAt: number
  slots: SlotRecord[]
  /** Slot paths the person chose to keep as ordinary worktrees; never adopted back. */
  releasedPaths: string[]
  /** Paths of parked slots removed to make room, kept free for their chats ({@link ReservedPath}). */
  reservedPaths: ReservedPath[]
}

/**
 * A folder on a network share (`\\\\server\\share\\…`) that is not a WSL
 * distribution: its git is slow and its locks unreliable, and the pool keeps
 * no slots there.
 */
export function isNetworkSharePath(repoRoot: string): boolean {
  return /^[\\/]{2}[^\\/]+[\\/]/u.test(repoRoot) && distroOfUncPath(repoRoot) === null
}

/**
 * One pool per (repository, execution host). The repository is its git common
 * dir, so every checkout of one repository shares a pool and two clones never
 * do; the host is the machine whose git makes the slots and whose toolchain
 * installs into them (`local`, or `wsl:<distro>` on Windows), so a Windows
 * pool and a WSL pool never share a slot or its native dependencies.
 */
export function poolIdFor(commonDir: string, hostId: string): string {
  return createHash('sha256')
    .update(`${comparablePath(commonDir)}\0${hostId}`)
    .digest('hex')
    .slice(0, 16)
}

const SLOT_STATES = new Set<WorktreePoolSlotState>([
  'creating',
  'idle',
  'leasing',
  'leased',
  'returning',
  'held',
  'evicting',
])
const OP_KINDS = new Set<SlotOp['kind']>(['create', 'lease', 'reset', 'return', 'evict', 'held-action'])

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

function parseKeeper(value: unknown): SlotKeeper | null {
  if (!isRecord(value)) return null
  const branch = str(value.branch)
  if (!branch) return null
  return { branch, agentId: str(value.agentId), workspaceId: str(value.workspaceId), since: num(value.since) ?? 0 }
}

function parseReservedPath(value: unknown): ReservedPath | null {
  const keeper = parseKeeper(value)
  const path = isRecord(value) ? str(value.path) : null
  return keeper && path ? { ...keeper, path } : null
}

function parseSize(value: unknown): WorktreeDiskUsage | null {
  if (!isRecord(value)) return null
  const bytes = num(value.bytes)
  if (bytes === null || bytes < 0) return null
  return {
    bytes,
    measuredAt: num(value.measuredAt) ?? 0,
    parts: Array.isArray(value.parts)
      ? value.parts
          .filter(isRecord)
          .map((part) => ({ name: str(part.name) ?? '', bytes: num(part.bytes) ?? 0 }))
          .filter((part) => part.name)
      : [],
  }
}

function parseSlot(value: unknown): SlotRecord | null {
  if (!isRecord(value)) return null
  const id = str(value.id)
  const path = str(value.path)
  const state = value.state as WorktreePoolSlotState
  if (!id || !path || !SLOT_STATES.has(state)) return null
  const lease = isRecord(value.lease) ? value.lease : null
  const held = isRecord(value.held) ? value.held : null
  const op = isRecord(value.op) ? value.op : null
  return {
    id,
    path,
    state,
    baseRef: str(value.baseRef),
    baseSha: str(value.baseSha),
    error: str(value.error),
    lease:
      lease && str(lease.leaseId) && str(lease.branch)
        ? {
            leaseId: str(lease.leaseId)!,
            branch: str(lease.branch)!,
            owner: str(lease.owner) ?? str(lease.branch)!,
            agentId: str(lease.agentId),
            workspaceId: str(lease.workspaceId),
            leasedAt: num(lease.leasedAt) ?? Date.now(),
            claimed: lease.claimed === true,
          }
        : null,
    held: held
      ? {
          reason: (str(held.reason) as WorktreePoolHeldReason | null) ?? 'recovery',
          detail: str(held.detail),
          changedPaths: num(held.changedPaths),
          branch: str(held.branch),
          since: num(held.since) ?? Date.now(),
        }
      : null,
    lastUsedAt: num(value.lastUsedAt),
    createdAt: num(value.createdAt) ?? Date.now(),
    // An op of a kind this build does not know is kept as `held-action`, the
    // one recovery holds for a person rather than redoing.
    op:
      op && str(op.kind)
        ? {
            kind: OP_KINDS.has(op.kind as SlotOp['kind']) ? (op.kind as SlotOp['kind']) : 'held-action',
            startedAt: num(op.startedAt) ?? 0,
            pid: num(op.pid) ?? 0,
            fromSha: str(op.fromSha),
            toSha: str(op.toSha),
          }
        : null,
    uses: num(value.uses) ?? 0,
    lastBranch: str(value.lastBranch),
    size: parseSize(value.size),
    kept: str(value.kept),
    // Only an idle slot is kept for anyone, or one on its way into or out of
    // being idle (a return, removal or reclaim that recovery finishes): on a
    // leased or held one it is a leftover of a step cut short.
    parked: state === 'leased' || state === 'held' || state === 'creating' ? null : parseKeeper(value.parked),
  }
}

/** A pool record from disk, or null when the file is missing, unreadable or not one of ours. */
function parsePoolRecord(text: string): PoolRecord | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value) || value.version !== POOL_RECORD_VERSION) return null
  const poolId = str(value.poolId)
  const repoRoot = str(value.repoRoot)
  const commonDir = str(value.commonDir)
  if (!poolId || !repoRoot || !commonDir || !Array.isArray(value.slots)) return null
  return {
    version: POOL_RECORD_VERSION,
    poolId,
    repoRoot,
    commonDir,
    hostId: str(value.hostId) ?? 'local',
    defaultRef: str(value.defaultRef),
    lastFetchAt: num(value.lastFetchAt),
    lastLeaseAt: num(value.lastLeaseAt),
    createdAt: num(value.createdAt) ?? Date.now(),
    slots: value.slots.map(parseSlot).filter((slot): slot is SlotRecord => slot !== null),
    releasedPaths: Array.isArray(value.releasedPaths)
      ? value.releasedPaths.filter((path): path is string => typeof path === 'string')
      : [],
    // Absent in a record an older build wrote, which reserved nothing.
    reservedPaths: Array.isArray(value.reservedPaths)
      ? value.reservedPaths
          .map(parseReservedPath)
          .filter((entry): entry is ReservedPath => entry !== null)
          .slice(-RESERVED_PATHS_MAX)
      : [],
  }
}

export type PoolStore = {
  dir: string
  readAll(): Promise<Array<{ poolId: string; record: PoolRecord | null }>>
  write(record: PoolRecord): Promise<void>
  readSettings(): Promise<WorktreePoolSettings>
  writeSettings(settings: WorktreePoolSettings): Promise<void>
}

export function normalizePoolSettings(input: Partial<WorktreePoolSettings> | null | undefined): WorktreePoolSettings {
  const base = DEFAULT_WORKTREE_POOL_SETTINGS
  const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback
  const diskLimitGb = input?.diskLimitGb
  return {
    enabled: typeof input?.enabled === 'boolean' ? input.enabled : base.enabled,
    keepIdle: clamp(input?.keepIdle, 0, WORKTREE_POOL_KEEP_IDLE_MAX, base.keepIdle),
    maxSlots: clamp(input?.maxSlots, WORKTREE_POOL_MAX_SLOTS_MIN, WORKTREE_POOL_MAX_SLOTS_CEILING, base.maxSlots),
    // Absent keeps the default; an explicit null is "no limit".
    diskLimitGb:
      diskLimitGb === null
        ? null
        : typeof diskLimitGb === 'number' && Number.isFinite(diskLimitGb) && diskLimitGb > 0
          ? Math.min(100_000, diskLimitGb)
          : base.diskLimitGb,
    idleReturnMinutes: clamp(
      input?.idleReturnMinutes,
      WORKTREE_POOL_IDLE_RETURN_MIN_MINUTES,
      WORKTREE_POOL_IDLE_RETURN_MAX_MINUTES,
      base.idleReturnMinutes,
    ),
    dependencyInstall: normalizeDependencyInstall(input?.dependencyInstall),
  }
}

/** The most projects a settings file keeps an install choice for. */
const DEPENDENCY_INSTALL_PROJECTS_MAX = 500

/**
 * Each project's install choice, as typed: a command is trimmed and capped, an
 * empty one means "infer it", and a project that is off with no command of its
 * own is the default and is not written down.
 */
function normalizeDependencyInstall(value: unknown): Record<string, WorktreeDependencyInstallSetting> {
  const out: Record<string, WorktreeDependencyInstallSetting> = {}
  if (!isRecord(value)) return out
  for (const [repoRoot, entry] of Object.entries(value)) {
    if (Object.keys(out).length >= DEPENDENCY_INSTALL_PROJECTS_MAX) break
    if (!repoRoot || !isRecord(entry)) continue
    const command = typeof entry.command === 'string' ? entry.command.trim().slice(0, WORKTREE_INSTALL_COMMAND_MAX) : ''
    const enabled = entry.enabled === true
    if (!enabled && !command) continue
    out[repoRoot] = { enabled, command: command || null }
  }
  return out
}

export function createPoolStore(userDataDir: string): PoolStore {
  const dir = join(userDataDir, 'worktree-pool')
  const settingsPath = join(dir, 'settings.json')
  // One write chain per file: two transitions of one pool in quick succession
  // land in order, and the later always wins.
  const chains = new Map<string, Promise<void>>()

  const chained = (path: string, content: string): Promise<void> => {
    const previous = chains.get(path) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        await mkdir(dir, { recursive: true })
        await writeFileAtomic(path, content)
      })
    chains.set(path, next)
    // Dropped however the write ends: a failed one is the caller's to see,
    // not an unhandled rejection of this bookkeeping.
    const forget = (): void => {
      if (chains.get(path) === next) chains.delete(path)
    }
    void next.then(forget, forget)
    return next
  }

  return {
    dir,
    async readAll() {
      let names: string[] = []
      try {
        names = await readdir(dir)
      } catch {
        return []
      }
      const out: Array<{ poolId: string; record: PoolRecord | null }> = []
      for (const name of names) {
        const match = /^pool-([0-9a-f]{16})\.json$/u.exec(name)
        if (!match) continue
        const text = await readFile(join(dir, name), 'utf8').catch(() => null)
        out.push({ poolId: match[1], record: text === null ? null : parsePoolRecord(text) })
      }
      return out
    },
    write(record) {
      return chained(join(dir, `pool-${record.poolId}.json`), `${JSON.stringify(record, null, 2)}\n`)
    },
    async readSettings() {
      const text = await readFile(settingsPath, 'utf8').catch(() => null)
      if (text === null) return normalizePoolSettings(null)
      try {
        return normalizePoolSettings(JSON.parse(text) as Partial<WorktreePoolSettings>)
      } catch {
        return normalizePoolSettings(null)
      }
    },
    writeSettings(settings) {
      return chained(settingsPath, `${JSON.stringify(normalizePoolSettings(settings), null, 2)}\n`)
    },
  }
}

// ── The instance lock ────────────────────────────────────────────────────────
//
// Two Studios can open one repository: a second profile, a dev build beside the
// installed app. Their pool records live in their own userData, but their slots
// would live in the SAME container, and two services leasing `pool-01` at once
// is exactly the race the pool exists not to have. So the container carries a
// lock file, created with O_EXCL, naming the holder. A holder whose process is
// gone (same machine), or whose heartbeat stopped long ago, is stale and the
// lock is taken over.

export const POOL_LOCK_FILE = '.pool.lock'
export const POOL_LOCK_STALE_MS = 15 * 60_000
export const POOL_LOCK_PID_REUSE_MS = 24 * 60 * 60_000

type LockBody = { pid: number; host: string; instanceId: string; startedAt: number }

export type InstanceLockDeps = {
  pidAlive?: (pid: number) => boolean
  now?: () => number
  host?: string
}

export type InstanceLockResult = { ok: true } | { ok: false; holder: string }

/** Tries at the lock, a little apart, while another Studio is mid-takeover. */
const LOCK_ATTEMPTS = 6
/** A takeover marker older than this was left by a Studio that died mid-takeover (a takeover takes milliseconds). */
const TAKEOVER_STALE_MS = 30_000

/**
 * Replace a lock judged stale with this instance's, so that two Studios
 * judging the same dead holder at once never both end up holding it.
 *
 * Deleting the stale lock and creating a new one is two steps, and between
 * them another Studio that judged the same dead holder could delete the new
 * lock in its turn, thinking it the old one: both then hold the pool. So a
 * takeover is done under a marker file created with O_EXCL (one takeover at a
 * time), the lock is read again inside it and replaced only if it is still
 * exactly what was judged stale (content and mtime), and it is replaced by
 * renaming a whole new file over it: the lock path never stands empty for an
 * ordinary `open(wx)` to claim meanwhile.
 */
async function takeOverLock(
  lockPath: string,
  judgedText: string | null,
  judgedMtimeMs: number | null,
  body: LockBody,
): Promise<'taken' | 'changed' | 'busy'> {
  const markerPath = `${lockPath}.takeover`
  try {
    await (await open(markerPath, 'wx')).close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const marker = await stat(markerPath).catch(() => null)
    if (marker && Date.now() - marker.mtimeMs > TAKEOVER_STALE_MS) await rm(markerPath, { force: true })
    return 'busy'
  }
  try {
    const text = await readFile(lockPath, 'utf8').catch(() => null)
    const info = await stat(lockPath).catch(() => null)
    if (text !== judgedText || (info?.mtimeMs ?? null) !== judgedMtimeMs) return 'changed'
    await writeFileAtomic(lockPath, JSON.stringify(body))
    return 'taken'
  } finally {
    await rm(markerPath, { force: true })
  }
}

/**
 * Take (or confirm) this instance's hold on a pool container. Idempotent for
 * the holder: a second call by the same instance succeeds and refreshes the
 * heartbeat.
 */
export async function acquireInstanceLock(
  containerPath: string,
  instanceId: string,
  deps: InstanceLockDeps = {},
): Promise<InstanceLockResult> {
  const pidAlive = deps.pidAlive ?? processIsRunning
  const now = deps.now ?? Date.now
  const host = deps.host ?? hostname()
  const lockPath = join(containerPath, POOL_LOCK_FILE)
  await mkdir(containerPath, { recursive: true })
  const body: LockBody = { pid: process.pid, host, instanceId, startedAt: now() }

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, 10 * attempt))
    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(JSON.stringify(body))
      } finally {
        await handle.close()
      }
      return { ok: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const text = await readFile(lockPath, 'utf8').catch(() => null)
    const info = await stat(lockPath).catch(() => null)
    let holder: Partial<LockBody> = {}
    try {
      holder = text ? (JSON.parse(text) as Partial<LockBody>) : {}
    } catch {
      holder = {}
    }
    if (holder.instanceId === instanceId) {
      await utimes(lockPath, new Date(), new Date()).catch(() => {})
      return { ok: true }
    }
    const age = info ? now() - info.mtimeMs : Number.POSITIVE_INFINITY
    const sameHost = holder.host === host && typeof holder.pid === 'number'
    const deadHere = sameHost && !pidAlive(holder.pid as number)
    // On this machine the holder's process is the whole truth: a live one keeps
    // the lock however old its heartbeat is (a laptop asleep for an hour stops
    // every timer, the holder's included). Age decides only for a holder on
    // another machine, whose process cannot be asked, and for a lock file too
    // torn to name anyone; an unreadable fresh one may be a holder mid-write.
    // A live pid on this machine whose heartbeat stopped a day ago is not a
    // sleeping Studio but a dead one whose pid was reused.
    const reusedPid = sameHost && age > POOL_LOCK_PID_REUSE_MS
    if (deadHere || reusedPid || (!sameHost && age > POOL_LOCK_STALE_MS)) {
      // Taken over, or judged again: someone else took it first, or another
      // takeover is under way.
      if ((await takeOverLock(lockPath, text, info?.mtimeMs ?? null, body)) === 'taken') return { ok: true }
      continue
    }
    return { ok: false, holder: `${holder.host ?? 'unknown host'} (pid ${holder.pid ?? '?'})` }
  }
  return { ok: false, holder: 'unknown' }
}

/**
 * Touch the lock so the other instance keeps seeing a live holder, and say
 * whether it is still ours. A holder that finds the lock gone or naming
 * someone else has lost the pool and must stop driving it (the caller steps
 * down to "held by another Studio").
 */
export async function heartbeatInstanceLock(
  containerPath: string,
  instanceId: string,
): Promise<'ours' | 'lost' | 'unknown'> {
  const lockPath = join(containerPath, POOL_LOCK_FILE)
  let text: string
  try {
    text = await readFile(lockPath, 'utf8')
  } catch (error) {
    // Gone is lost; a read that failed for any other reason (a scanner
    // holding the file on Windows) says nothing either way.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'lost' : 'unknown'
  }
  let holder: Partial<LockBody>
  try {
    holder = JSON.parse(text) as Partial<LockBody>
  } catch {
    return 'unknown'
  }
  if (holder.instanceId !== instanceId) return 'lost'
  await utimes(lockPath, new Date(), new Date()).catch(() => {})
  return 'ours'
}

export async function releaseInstanceLock(containerPath: string, instanceId: string): Promise<void> {
  const lockPath = join(containerPath, POOL_LOCK_FILE)
  const text = await readFile(lockPath, 'utf8').catch(() => null)
  if (!text) return
  try {
    if ((JSON.parse(text) as Partial<LockBody>).instanceId !== instanceId) return
  } catch {
    return
  }
  await rm(lockPath, { force: true }).catch(() => {})
}
