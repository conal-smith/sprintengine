import { execFile } from 'child_process'
import { lstat, readdir, readFile, realpath, stat } from 'fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'path'
import type { WorktreeDiskUsage } from '../../shared/ipc/worktree-pool'

/**
 * How much disk a worktree takes, for Settings ▸ Worktrees and the pool's disk
 * limit. Only ever run because someone asked (the page opened, Measure again,
 * a return while a disk limit is set): a worktree with `node_modules` is a
 * hundred thousand files, and walking one costs seconds.
 *
 * `du` where there is one, because it counts allocated blocks (what removing
 * the tree gives back) and is far faster than a walk from Node. Windows has no
 * `du`, so there the tree is walked, and the walk counts file lengths.
 *
 * A pnpm install's packages are left out when they share their blocks with
 * pnpm's store (sharedPnpmVirtualStore), because removing them gives back
 * almost nothing.
 */

/** Top-level entries kept by name in the breakdown; the rest are summed as `…`. */
const NAMED_PARTS = 4
const DU_TIMEOUT_MS = 120_000
const WALK_CONCURRENCY = 16
/** Trees measured at once by a caller measuring many: each `du` reads many thousand files. */
export const MEASURE_CONCURRENCY = 3

/** `signal` stops a measurement part-way (quitting): the answer is then null. */
export type MeasureDiskUsage = (path: string, signal?: AbortSignal) => Promise<WorktreeDiskUsage | null>

function breakdown(total: number, children: Array<{ name: string; bytes: number }>, measuredAt: number) {
  const sorted = children.filter((child) => child.bytes > 0).sort((a, b) => b.bytes - a.bytes)
  const parts = sorted.slice(0, NAMED_PARTS)
  const rest = total - parts.reduce((sum, part) => sum + part.bytes, 0)
  // Everything else: smaller entries, and the top-level files `du -d 1` does not list.
  if (rest > 0) parts.push({ name: '…', bytes: rest })
  return { bytes: total, measuredAt, parts }
}

type DuTotals = { total: number; children: Array<{ name: string; bytes: number }> }

function parseDuTotals(stdout: string, root: string): DuTotals | null {
  let total: number | null = null
  const children: Array<{ name: string; bytes: number }> = []
  const rootKey = root.replace(/[\\/]+$/u, '')
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^(\d+)\s+(.+)$/u.exec(line.trim())
    if (!match) continue
    const bytes = Number(match[1]) * 1024
    const path = match[2].replace(/[\\/]+$/u, '')
    if (path === rootKey) total = bytes
    else children.push({ name: basename(path), bytes })
  }
  return total === null ? null : { total, children }
}

/** `du -k -d 1` output: `<kibibytes>\t<path>` per line, the tree itself last. */
export function parseDuOutput(stdout: string, root: string, measuredAt: number): WorktreeDiskUsage | null {
  const totals = parseDuTotals(stdout, root)
  return totals && breakdown(totals.total, totals.children, measuredAt)
}

/** The value of a top-level `key` in pnpm's `node_modules/.modules.yaml`. */
function pnpmManifestField(text: string, key: string): string | null {
  // pnpm 11 writes the file as JSON, older versions as YAML with one
  // top-level key per line.
  try {
    const value: unknown = JSON.parse(text)?.[key]
    return typeof value === 'string' ? value : null
  } catch {
    // Not JSON: read it as YAML below.
  }
  const match = new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'mu').exec(text)
  if (!match) return null
  const value = match[1]
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/gu, "'")
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value)
      return typeof parsed === 'string' ? parsed : null
    } catch {
      return null
    }
  }
  return value
}

/**
 * Where under `root` pnpm keeps the packages it installed, when removing them
 * gives back almost nothing; null otherwise, and whenever that cannot be told.
 *
 * With its store on the same device, pnpm hard-links or clones (APFS
 * clonefile, btrfs and XFS reflink) each file from the store, so its blocks
 * stay in use by the store after the worktree is gone. Measured as they are,
 * one install reads as gigabytes the worktree does not really take. A store on
 * another device makes pnpm copy instead, and those copies still count. The
 * path is returned under `root` as given, so it compares with `du`'s and the
 * walk's paths.
 */
async function sharedPnpmVirtualStore(root: string): Promise<string | null> {
  try {
    const nodeModules = join(root, 'node_modules')
    const text = await readFile(join(nodeModules, '.modules.yaml'), 'utf8')
    const storeDir = pnpmManifestField(text, 'storeDir')
    if (!storeDir) return null
    const virtualStore = resolve(nodeModules, pnpmManifestField(text, 'virtualStoreDir') ?? '.pnpm')
    const [realRoot, realVirtualStore, store, virtual] = await Promise.all([
      realpath(root),
      realpath(virtualStore),
      stat(storeDir),
      stat(virtualStore),
    ])
    if (store.dev !== virtual.dev) return null
    // A virtual store outside the worktree is not removed with it.
    const inside = relative(realRoot, realVirtualStore)
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null
    return join(root, inside)
  } catch {
    return null
  }
}

function runDu(args: string[], signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolveRun) => {
    execFile(
      'du',
      args,
      { timeout: DU_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal },
      (error, stdout) => {
        if (signal?.aborted) return resolveRun(null)
        // A file it may not read makes `du` exit 1 after printing every total
        // it could; those totals are still the answer.
        if (stdout) resolveRun(stdout)
        else resolveRun(error ? null : '')
      },
    )
  })
}

/** Bytes under `path`, symlinks not followed, `skip` left out. */
async function walk(path: string, signal?: AbortSignal, skip?: string | null): Promise<number> {
  if (signal?.aborted || path === skip) return 0
  const info = await lstat(path).catch(() => null)
  if (!info) return 0
  if (!info.isDirectory()) return info.isSymbolicLink() ? 0 : info.size
  const names = await readdir(path).catch(() => [] as string[])
  let total = 0
  for (let index = 0; index < names.length; index += WALK_CONCURRENCY) {
    const sizes = await Promise.all(
      names.slice(index, index + WALK_CONCURRENCY).map((name) => walk(join(path, name), signal, skip)),
    )
    total += sizes.reduce((sum, size) => sum + size, 0)
  }
  return total
}

async function walkTopLevel(
  path: string,
  measuredAt: number,
  signal?: AbortSignal,
  skip?: string | null,
): Promise<WorktreeDiskUsage | null> {
  const names = await readdir(path).catch(() => null)
  if (!names) return null
  const children: Array<{ name: string; bytes: number }> = []
  for (const name of names) children.push({ name, bytes: await walk(join(path, name), signal, skip) })
  if (signal?.aborted) return null
  return breakdown(
    children.reduce((sum, child) => sum + child.bytes, 0),
    children,
    measuredAt,
  )
}

/**
 * `totals` with what `du` counts under `skip` taken out of the total and of
 * the top-level entry holding it. `du` has no portable way to leave a folder
 * out, so the folder is measured on its own and subtracted.
 */
async function withoutSkipped(
  totals: DuTotals,
  root: string,
  skip: string,
  signal?: AbortSignal,
): Promise<DuTotals | null> {
  const stdout = await runDu(['-k', '-s', skip], signal)
  if (signal?.aborted) return null
  const match = stdout ? /^(\d+)\s/u.exec(stdout.trim()) : null
  // Not measured: the full count is still better than none.
  if (!match) return totals
  const bytes = Number(match[1]) * 1024
  const holder = relative(root, skip).split(sep)[0]
  return {
    total: Math.max(0, totals.total - bytes),
    children: totals.children.map((child) =>
      child.name === holder ? { ...child, bytes: Math.max(0, child.bytes - bytes) } : child,
    ),
  }
}

export const measureDiskUsage: MeasureDiskUsage = async (path, signal) => {
  const measuredAt = Date.now()
  const skip = await sharedPnpmVirtualStore(path)
  if (process.platform !== 'win32') {
    const stdout = await runDu(['-k', '-d', '1', path], signal)
    const parsed = stdout ? parseDuTotals(stdout, path) : null
    const totals = parsed && skip ? await withoutSkipped(parsed, path, skip, signal) : parsed
    if (totals) return breakdown(totals.total, totals.children, measuredAt)
    if (signal?.aborted) return null
  }
  return walkTopLevel(path, measuredAt, signal, skip)
}
