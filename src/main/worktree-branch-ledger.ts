import { mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { isRecord } from '../shared/records'
import { installedStudioPlatform } from '../server/platform/platform'
import { writeFileAtomic } from '../server/platform/atomic-file'
import type { GitCommandResult } from './git'
import { runGitCommand } from './git-run'

/**
 * The branches Studio made for worktrees, per repository: the only ones,
 * besides those under `agent/`, that the agent worktree cleanup may delete.
 *
 * A branch's name cannot say who made it once the person chooses the prefix
 * (Settings ▸ Worktrees): `feat/fix-login` may be Studio's or their own, and an
 * empty prefix names Studio's branches like anyone's. So every branch Studio
 * names for a worktree is written down here as it is made (a new chat's or an
 * agent's worktree, a pool lease, a pool slot's held or rescued work), and the
 * cleanup deletes a merged branch only when it finds it here or under `agent/`,
 * the namespace Studio's branches had before the prefix could be chosen.
 *
 * Keyed by the repository's common git directory with symlinks resolved, which
 * every worktree of a repository shares, however its checkout is spelled. Kept
 * in one small file under the profile's data directory, written whole and
 * atomically; a missing or unreadable file reads as empty, which deletes
 * nothing but `agent/` branches. Each repository keeps its newest
 * `MAX_BRANCHES_PER_REPO` names and the file its most recently touched
 * `MAX_REPOS` repositories: a name that falls off is a branch the cleanup
 * leaves for the person, never one it deletes by mistake.
 *
 * The desktop and a Studio server out of process may both make worktrees for
 * the same profile, so every change reads the file again just before writing
 * it, and changes in this process are written one after another.
 */

const FILE_NAME = 'worktree-branches.json'
const VERSION = 1
const MAX_BRANCHES_PER_REPO = 2_000
const MAX_REPOS = 200

type RepoEntry = { updatedAt: number; branches: string[] }
type LedgerFile = { version: typeof VERSION; repos: Record<string, RepoEntry> }

type RunGit = (cwd: string, args: string[]) => Promise<GitCommandResult>

export type WorktreeBranchLedgerDeps = {
  /** The profile's data directory, or null when this process has none (nothing is kept). */
  dataDir: () => string | null
  runGit?: RunGit
  now?: () => number
  log?: (line: string) => void
}

export type WorktreeBranchLedger = {
  /** Write down that Studio made `branch` in the repository at `repoPath` (any path inside it). */
  record(repoPath: string, branch: string): Promise<void>
  /** The branches Studio made in the repository at `repoPath`; empty when none are known. */
  branches(repoPath: string): Promise<ReadonlySet<string>>
  /** Strike names off: Studio deleted those branches, or they are gone. */
  forget(repoPath: string, branches: Iterable<string>): Promise<void>
}

function parseLedger(text: string | null): LedgerFile {
  const empty: LedgerFile = { version: VERSION, repos: {} }
  if (text === null) return empty
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return empty
  }
  if (!isRecord(raw) || raw.version !== VERSION || !isRecord(raw.repos)) return empty
  const repos: Record<string, RepoEntry> = {}
  for (const [repo, entry] of Object.entries(raw.repos)) {
    if (!repo || !isRecord(entry) || !Array.isArray(entry.branches)) continue
    const branches = entry.branches.filter((branch): branch is string => typeof branch === 'string' && branch !== '')
    if (branches.length === 0) continue
    const updatedAt = typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0
    repos[repo] = { updatedAt, branches: branches.slice(-MAX_BRANCHES_PER_REPO) }
  }
  return { version: VERSION, repos }
}

/** The file with its oldest repositories dropped past the limit. */
function bounded(ledger: LedgerFile): LedgerFile {
  const entries = Object.entries(ledger.repos)
  if (entries.length <= MAX_REPOS) return ledger
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
  return { version: VERSION, repos: Object.fromEntries(entries.slice(0, MAX_REPOS)) }
}

export function createWorktreeBranchLedger(deps: WorktreeBranchLedgerDeps): WorktreeBranchLedger {
  const runGit: RunGit = deps.runGit ?? ((cwd, args) => runGitCommand(cwd, args))
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.warn(`[worktree-branches] ${line}`))
  // A repository's identity, per path asked about: a git process once, not per call.
  const identities = new Map<string, Promise<string | null>>()
  let chain: Promise<unknown> = Promise.resolve()

  const filePath = (): string | null => {
    const dir = deps.dataDir()
    return dir ? join(dir, FILE_NAME) : null
  }

  const read = async (path: string): Promise<LedgerFile> => parseLedger(await readFile(path, 'utf8').catch(() => null))

  function identity(repoPath: string): Promise<string | null> {
    let known = identities.get(repoPath)
    if (!known) {
      known = runGit(repoPath, ['rev-parse', '--git-common-dir']).then(
        async (result) => {
          const dir = result.ok ? result.stdout.trim() : ''
          if (!dir) return null
          const absolute = isAbsolute(dir) ? dir : resolve(repoPath, dir)
          return realpath(absolute).catch(() => absolute)
        },
        () => null,
      )
      // A failed lookup is asked again next time: the folder may be a repository by then.
      void known.then((value) => {
        if (value === null) identities.delete(repoPath)
      })
      identities.set(repoPath, known)
    }
    return known
  }

  /** Apply `change` to the file as it is on disk now, after every change this process made before it. */
  function update(repoPath: string, change: (entry: RepoEntry | undefined) => RepoEntry | null): Promise<void> {
    const run = chain.then(async () => {
      const path = filePath()
      const repo = await identity(repoPath)
      if (!path || !repo) return
      const ledger = await read(path)
      const next = change(ledger.repos[repo])
      if (next === null) delete ledger.repos[repo]
      else ledger.repos[repo] = next
      await mkdir(dirname(path), { recursive: true })
      await writeFileAtomic(path, `${JSON.stringify(bounded(ledger))}\n`)
    })
    // One failed write is logged and does not stop the next: a branch left
    // unrecorded is one the cleanup leaves alone.
    chain = run.catch((error: unknown) => log(`could not update the record: ${String(error)}`))
    return chain.then(() => undefined)
  }

  return {
    record(repoPath, branch) {
      return update(repoPath, (entry) => {
        const branches = (entry?.branches ?? []).filter((name) => name !== branch)
        branches.push(branch)
        return { updatedAt: now(), branches: branches.slice(-MAX_BRANCHES_PER_REPO) }
      })
    },

    async branches(repoPath) {
      const path = filePath()
      const repo = path ? await identity(repoPath).catch(() => null) : null
      if (!path || !repo) return new Set()
      return new Set((await read(path)).repos[repo]?.branches ?? [])
    },

    forget(repoPath, branches) {
      const gone = new Set(branches)
      if (gone.size === 0) return Promise.resolve()
      return update(repoPath, (entry) => {
        if (!entry) return null
        const kept = entry.branches.filter((name) => !gone.has(name))
        return kept.length ? { updatedAt: entry.updatedAt, branches: kept } : null
      })
    },
  }
}

let shared: WorktreeBranchLedger | null = null

/** The ledger in this process's profile data directory; nothing is kept in a process with no platform. */
export function worktreeBranchLedger(): WorktreeBranchLedger {
  shared ??= createWorktreeBranchLedger({ dataDir: () => installedStudioPlatform()?.paths.dataDir() ?? null })
  return shared
}
