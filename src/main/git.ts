import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, resolve } from 'path'
import { agentWorktreeLockOwner, lockAgentWorktree, relockWorktree, unlockWorktree } from './agent-worktree-lock'
import { excludeFromWorktree } from './integrations/worktree-exclude'
import { cloneTree } from './clone-tree'
import {
  getRelativeGitPath,
  isInsideRepo,
  normalizeComparablePath,
  pathExists,
  runGit,
  runGitCommand,
  toAbsolutePath,
  toFilesystemPath,
  toPosixPath,
} from './git-utils'
import { listGitWorktrees } from './git-worktree-list'
import { activeWorktreePool } from './worktree-pool/active-pool'
import { activeDependencyInstaller } from './worktree-pool/dependency-install'
import { defaultSlotGitRunner, resolveAgentForkBase } from './worktree-pool/slot-git'
import type { WorktreePoolLeaseResult } from './worktree-pool/worktree-pool-service'
import { withWorktreeRegistryLock } from './worktree-registry-lock'
import { repoRootFromWorktreePath, WORKTREE_CONTAINER_DIR, worktreeContainerPath } from '../shared/worktree-paths'
import { dependencyInstallSettingFor, type WorktreeDependencyInstallView } from '../shared/ipc/worktree-pool'
import {
  resolveRepoRoot,
  resolveWorktreeDestination,
  toWorktreeResult,
  validateBaseRef,
  validateBranchName,
} from './git-worktree-validation'

export { listGitWorktrees } from './git-worktree-list'
export { getGitStatus } from './git-status'
export { getGitBranches, getGitCommitGraph } from './git-read-models'
export { applyGitStash, dropGitStash, listGitStashes, pushGitStash } from './git-stash'
export { revertGitPaths, stageGitPaths, unstageGitPaths } from './git-file-actions'
export {
  abortGitOperation,
  checkoutGitCommit,
  checkoutGitCommitAsBranch,
  cherryPickGitCommit,
  commitGitChanges,
  continueGitOperation,
  createGitTagFromCommit,
  deleteGitBranch,
  fetchGitRemotes,
  mergeGitRef,
  pullGitBranchWithStash,
  pushGitBranch,
  rebaseGitBranch,
  renameGitBranch,
  resetGitBranchToCommit,
  revertGitCommit,
  switchGitBranch,
} from './git-branch-actions'

export type GitFileStatus = 'new' | 'modified' | 'deleted' | 'renamed' | 'conflicted'

export type GitStatusEntry = {
  path: string
  relativePath: string
  status: GitFileStatus
  staged: boolean
  unstaged: boolean
}

/** A multi-step operation parked in the repo, awaiting continue or abort. */
export type GitRepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

export type GitResetMode = 'soft' | 'mixed' | 'hard'

export type GitStatusSnapshot = {
  repoRoot: string
  files: Record<string, GitStatusEntry>
  operation: GitRepoOperation | null
  updatedAt: number
}

export type GitStashEntry = {
  /** Git's selector for the entry, e.g. `stash@{0}`. */
  ref: string
  /** The stash commit hash — the entry's stable identity; selectors renumber. */
  hash: string
  index: number
  branch: string | null
  message: string
  createdAt: number
}

export type GitStashListSnapshot = {
  repoRoot: string
  stashes: GitStashEntry[]
  updatedAt: number
}

export type GitFileBaseResult = { ok: true; content: string } | { ok: false; message: string }

// Which stored version of a file to read for the diff viewer. `head` is the
// committed version (`git show HEAD:<p>`); `index` is the staged version
// (`git show :0:<p>`). Worktree content is read off disk via the fs IPC.
export type GitFileStage = 'head' | 'index'

export type GitFileStageResult =
  { ok: true; exists: boolean; content: string; binary: boolean; tooLarge: boolean } | { ok: false; message: string }

type GitBranch = {
  name: string
  current: boolean
  upstream: string | null
}

export type GitBranchSnapshot = {
  current: string | null
  branches: GitBranch[]
  ahead: number
  behind: number
}

type GitCommit = {
  hash: string
  shortHash: string
  author: string
  date: string
  refs: string[]
  subject: string
  commitWebUrl: string | null
}

export type GitGraphCommit = GitCommit & {
  parents: string[]
}

export type GitGraphSnapshot = {
  commits: GitGraphCommit[]
  refs: GitRef[]
  headHash: string | null
  detached: boolean
  totalCount: number
  hasMore: boolean
  updatedAt: number
}

export type GitGraphOptions = {
  limit?: number
  skip?: number
}

export type GitRef = {
  name: string
  hash: string
  type: 'head' | 'remote' | 'tag' | 'other'
}

export type GitCommandResult = {
  ok: boolean
  stdout: string
  stderr: string
  message: string | null
  pushedCommitCount?: number
}

export type GitWorktreeEntry = {
  path: string
  head: string | null
  branch: string | null
  branchRef: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  lockedReason: string | null
  /**
   * Set when the lock is the in-use mark the app places on an agent worktree
   * (agent-worktree-lock.ts): this profile's, which it releases itself, or
   * another Studio profile's, which it never touches.
   */
  agentLock?: 'this-profile' | 'other-profile'
  prunable: boolean
  prunableReason: string | null
}

export type GitWorktreeListSnapshot = {
  repoRoot: string
  worktrees: GitWorktreeEntry[]
  updatedAt: number
}

type GitWorktreeCopyIncludedResult = {
  copied: string[]
  skipped: { path: string; reason: string }[]
}

export type GitWorktreeOperationResult<T> =
  | { ok: true; data: T; message: string | null; stdout?: string; stderr?: string }
  | { ok: false; message: string; stdout?: string; stderr?: string }

export type GitWorktreeCreateInput = {
  repoRoot: string
  containerPath: string
  destinationPath: string
  branchName: string
  baseRef: string
  copyIncludedFiles?: boolean
  /**
   * Lock the new worktree as in use by an agent (agent-worktree-lock.ts),
   * naming this owner: the agent's id, or the branch when the agent does not
   * exist yet. The agent worktree cleanup never removes a worktree another
   * profile has locked, and this profile releases its own lock once its
   * records no longer use the worktree.
   */
  agentLockOwner?: string
  /**
   * An agent's worktree, forked from the default branch: leased from the
   * worktree pool when this process has one (its path is then a pool slot's,
   * not `destinationPath`), otherwise created fresh at `destinationPath` from
   * `origin/<default>` as fetched now. `baseRef` is used only when the
   * repository has no default branch at all. Needs an `agent/` branch.
   */
  fromPool?: boolean
  /** The machine whose git makes it (a WSL machine's); absent resolves from the folder. */
  hostId?: string
  /**
   * With `fromPool`, how the project's dependency install is waited for
   * (worktree-pool/dependency-install.ts): `wait`, the default, answers once
   * it has ended, so the agent starts after it; `start` answers as soon as it
   * is running, with its running view, for a caller in main that waits on it
   * itself (`DependencyInstaller.settled`) and has a reason not to hold its
   * own caller that long — a gateway call, whose client gives up on a call
   * long before an install ends. A window's own launch always waits.
   */
  dependencyInstall?: 'wait' | 'start'
  /** Its caller shows the install (New chat's chat): marked `quiet`, so no window toasts it unless it fails. */
  quietInstall?: boolean
}

/** A created worktree, and what it was forked from. */
export type GitWorktreeCreated = GitWorktreeEntry & {
  /** The ref it was forked from, as the caller should record it (`origin/main`, `HEAD`). */
  baseRef: string
  /** Set when the worktree is a pool slot: the lease to give back if the launch fails. */
  leaseId: string | null
  /**
   * The dependency install the agent worktree ran before it was handed out,
   * when it ran one: how it ended, or, asked to only `start` it, the install
   * still running.
   */
  dependencyInstall?: WorktreeDependencyInstallView | null
}

/**
 * Check a worktree out again, at the path it had, on the branch it kept: the
 * way back to a chat whose worktree the agent worktree cleanup gave back.
 */
export type GitWorktreeRestoreInput = {
  repoRoot: string
  path: string
  branchName: string
  copyIncludedFiles?: boolean
  /** As on {@link GitWorktreeCreateInput}: the restored worktree is locked again, for this owner. */
  agentLockOwner?: string
}

/**
 * A restore's answer. A refusal marked `definitive` is one no retry changes
 * (the branch was deleted, the path is not one of the app's worktrees); any
 * other may succeed next time (the volume is back, the branch was freed).
 */
export type GitWorktreeRestoreResult =
  GitWorktreeOperationResult<GitWorktreeEntry> | { ok: false; message: string; definitive: true }

export type GitWorktreeRemoveInput = {
  repoRoot: string
  path: string
  force?: boolean
}

export type GitConflictFileContent = {
  path: string
  relativePath: string
  base: string | null
  ours: string | null
  theirs: string | null
  result: string
}

export async function getGitRepoRoot(folderPath: string): Promise<string | null> {
  try {
    const stdout = await runGit(folderPath, ['rev-parse', '--show-toplevel'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * The branch-already-exists refusal from `worktree add -b`, reworded to name
 * where that branch is checked out, which is what the person has to act on.
 * Null for any other failure, which keeps git's own words.
 */
async function explainBranchConflict(
  repoRoot: string,
  branch: string,
  addResult: GitCommandResult,
): Promise<string | null> {
  if (
    !/already exists|already checked out|already used by worktree/i.test(
      `${addResult.stderr}\n${addResult.message ?? ''}`,
    )
  ) {
    return null
  }
  const worktrees = await listGitWorktrees(repoRoot, { resolvedRoot: true })
  const holder = worktrees.ok ? worktrees.data.worktrees.find((worktree) => worktree.branch === branch) : undefined
  if (!holder) return null
  return `Branch "${branch}" is already checked out at ${holder.path}. Choose a different branch name or remove that worktree first.`
}

/**
 * Copy the repository's `.worktreeinclude` set into a worktree this module has
 * just created. `repoRoot` is already git's resolved root.
 */
export async function seedWorktreeIncludedFiles(
  repoRoot: string,
  worktreePath: string,
): Promise<GitWorktreeOperationResult<GitWorktreeCopyIncludedResult>> {
  const includeFilePath = join(toFilesystemPath(repoRoot), '.worktreeinclude')
  const result: GitWorktreeCopyIncludedResult = {
    copied: [],
    skipped: [],
  }

  let includeFile = ''
  try {
    includeFile = await readFile(includeFilePath, 'utf8')
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code && code !== 'ENOENT') {
      return {
        ok: false,
        message: `Unable to read .worktreeinclude: ${includeFilePath}`,
      }
    }

    return {
      ok: true,
      data: result,
      message: 'No .worktreeinclude file found.',
    }
  }

  const entries = includeFile
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))

  for (const entry of entries) {
    if (isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
      result.skipped.push({ path: entry, reason: 'Only repository-relative include paths are allowed.' })
      continue
    }

    if (/[*?[\]{}]/.test(entry)) {
      result.skipped.push({
        path: entry,
        reason: 'Glob patterns are not supported; list explicit files or directories.',
      })
      continue
    }

    const sourcePath = join(repoRoot, ...entry.split(/[\\/]+/))
    const destinationPath = join(worktreePath, ...entry.split(/[\\/]+/))

    if (
      !normalizeComparablePath(sourcePath).startsWith(`${normalizeComparablePath(repoRoot)}/`) ||
      !normalizeComparablePath(destinationPath).startsWith(`${normalizeComparablePath(worktreePath)}/`)
    ) {
      result.skipped.push({ path: entry, reason: 'Include path must stay inside the repository and target worktree.' })
      continue
    }

    if (!(await pathExists(sourcePath))) {
      result.skipped.push({ path: entry, reason: 'Source path does not exist.' })
      continue
    }

    try {
      const destinationFsPath = toFilesystemPath(destinationPath)
      await mkdir(dirname(destinationFsPath), { recursive: true })
      await cloneTree(toFilesystemPath(sourcePath), destinationFsPath)
      result.copied.push(entry)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.skipped.push({ path: entry, reason: message })
    }
  }

  return {
    ok: true,
    data: result,
    message: null,
  }
}

/**
 * Cut a new worktree on a new branch.
 *
 * Five git processes, in order, and no more: resolve the repository root once,
 * check the branch name and the base ref, `worktree add`, and one `worktree
 * list` to report the entry the way git spells it. An agent worktree adds a
 * sixth, the `worktree lock` that marks it in use. Every one is a process start
 * on the launch path of a worktree agent, and on Windows or a network mount
 * each costs far more than the ~20 ms it costs here.
 *
 * There is no listing BEFORE the add to look for the branch being checked out
 * elsewhere: `worktree add -b` refuses an existing branch by itself, and only
 * that failure pays for a listing, to name the worktree that holds it.
 */
export async function createGitWorktree(
  input: GitWorktreeCreateInput,
): Promise<GitWorktreeOperationResult<GitWorktreeCreated>> {
  if (input.fromPool && input.branchName.startsWith('agent/')) return createAgentWorktreeFromPool(input)
  const root = await resolveRepoRoot(input.repoRoot)
  if (!root.ok) return root

  const destination = resolveWorktreeDestination(input.containerPath, input.destinationPath)
  if (!destination.ok) return destination

  const branch = await validateBranchName(root.data, input.branchName)
  if (!branch.ok) return branch

  const baseRef = await validateBaseRef(root.data, input.baseRef)
  if (!baseRef.ok) return baseRef

  if (await pathExists(destination.data.destinationPath)) {
    return {
      ok: false,
      message: `Worktree destination already exists: ${destination.data.destinationPath}`,
    }
  }

  await mkdir(toFilesystemPath(destination.data.containerPath), { recursive: true })
  const addResult = await withWorktreeRegistryLock(root.data, () =>
    runGitCommand(root.data, ['worktree', 'add', '-b', branch.data, destination.data.destinationPath, baseRef.data]),
  )

  if (!addResult.ok) {
    return {
      ok: false,
      message:
        (await explainBranchConflict(root.data, branch.data, addResult)) ??
        addResult.message ??
        'Unable to create Git worktree.',
      stdout: addResult.stdout,
      stderr: addResult.stderr,
    }
  }

  const finished = await finishAddedWorktree(root.data, destination.data.destinationPath, input, addResult)
  return finished.ok ? { ...finished, data: { ...finished.data, baseRef: baseRef.data, leaseId: null } } : finished
}

/**
 * What follows a successful `worktree add`, for a new worktree and a restored
 * one alike: the in-use lock, the `.worktreeinclude` seeding, and the entry as
 * git lists it.
 */
async function finishAddedWorktree(
  repoRoot: string,
  worktreePath: string,
  input: { agentLockOwner?: string; copyIncludedFiles?: boolean },
  addResult: GitCommandResult,
): Promise<GitWorktreeOperationResult<GitWorktreeEntry>> {
  if (input.agentLockOwner) {
    // Straight after the add, before the seeding copies anything in: from here
    // on no other Studio profile's cleanup will remove it. A lock that fails is
    // logged, not fatal; the cleanup's age guard still covers a new worktree.
    const locked = await lockAgentWorktree(repoRoot, worktreePath, input.agentLockOwner)
    if (!locked.ok) {
      console.warn(`[git] could not lock agent worktree ${worktreePath}: ${locked.message ?? locked.stderr}`)
    }
  }

  if (input.copyIncludedFiles) {
    // Just created by the add, so it is registered and on disk: the seeding
    // skips the checks it runs for a worktree someone else named.
    const copyResult = await seedWorktreeIncludedFiles(repoRoot, worktreePath)
    if (!copyResult.ok) return copyResult
  }

  const nextWorktrees = await listGitWorktrees(repoRoot, { resolvedRoot: true })
  if (!nextWorktrees.ok) return nextWorktrees

  const createdWorktree = nextWorktrees.data.worktrees.find(
    (worktree) => normalizeComparablePath(worktree.path) === normalizeComparablePath(worktreePath),
  )

  if (!createdWorktree) {
    return {
      ok: false,
      message: `Git created the worktree, but it was not reported by "git worktree list": ${worktreePath}`,
      stdout: addResult.stdout,
      stderr: addResult.stderr,
    }
  }

  return {
    ok: true,
    data: createdWorktree,
    message: null,
    stdout: addResult.stdout,
    stderr: addResult.stderr,
  }
}

/**
 * An agent worktree on the default branch: a pool slot when this process keeps
 * a pool (worktree-pool/), else a fresh worktree forked from the same ref.
 *
 * The pool declining is never the caller's problem — another Studio holds it,
 * the repository is on a WSL machine, the pool is off or full — and the fresh
 * worktree is what the caller would have got before there was a pool. A name
 * the branch cannot take is the caller's, and is reported as the fresh path
 * would.
 *
 * Either way the project's dependency install runs before the worktree is
 * handed out, when the project opted in (`withDependencyInstall`). A fresh
 * worktree is the case that needs it most: it has no `node_modules` at all.
 */
async function createAgentWorktreeFromPool(
  input: GitWorktreeCreateInput,
): Promise<GitWorktreeOperationResult<GitWorktreeCreated>> {
  const pool = activeWorktreePool()
  // The base the pool already fetched for this very request, when it then
  // declined: the fresh worktree forks from it rather than fetching again.
  let poolBaseRef: string | null = null
  if (pool) {
    // A pool that throws (a record it could not write, a git it could not
    // start) is a pool declining like any other: the fresh worktree below is
    // what the chat gets.
    const leased = await pool
      .lease({
        repoRoot: input.repoRoot,
        name: input.branchName.slice('agent/'.length),
        owner: input.agentLockOwner ?? null,
        hostId: input.hostId ?? null,
        copyIncludedFiles: input.copyIncludedFiles === true,
      })
      .catch((error: unknown): WorktreePoolLeaseResult => ({
        ok: false,
        reason: 'error',
        message: error instanceof Error ? error.message : String(error),
      }))
    if (leased.ok) {
      // The entry is what the lease just made, not a listing read back: the
      // slot's path is git's own spelling, and a listing that failed now would
      // only send the chat to a fresh worktree on a branch the slot already has.
      const agentLock = agentWorktreeLockOwner(leased.lockReason)
      const entry: GitWorktreeEntry = {
        path: leased.path,
        head: leased.baseSha,
        branch: leased.branch,
        branchRef: `refs/heads/${leased.branch}`,
        detached: false,
        bare: false,
        locked: leased.lockReason !== null,
        lockedReason: leased.lockReason,
        ...(agentLock ? { agentLock } : {}),
        prunable: false,
        prunableReason: null,
      }
      return {
        ok: true,
        data: await withDependencyInstall(
          { ...entry, baseRef: leased.baseRef, leaseId: leased.leaseId },
          leased.repoRoot,
          input,
        ),
        message: null,
      }
    } else if (leased.reason === 'branch-exists' || leased.reason === 'invalid-name') {
      return { ok: false, message: leased.message }
    } else {
      if (leased.reason !== 'disabled' && leased.reason !== 'unsupported') {
        console.info(`[git] worktree pool declined (${leased.reason}: ${leased.message}); creating a fresh worktree`)
      }
      poolBaseRef = leased.base?.ref ?? null
    }
  }
  const root = await resolveRepoRoot(input.repoRoot)
  if (!root.ok) return root
  const forkBase = poolBaseRef ?? (await resolveAgentForkBase(defaultSlotGitRunner, root.data))
  const created = await createGitWorktree({ ...input, fromPool: false, baseRef: forkBase ?? input.baseRef })
  return created.ok ? { ...created, data: await withDependencyInstall(created.data, root.data, input) } : created
}

/**
 * The project's dependency install in a just-made agent worktree, when it
 * opted in and the worktree's lockfile changed since it last installed: before
 * the agent starts, which it does whatever came of it. The choice is read from
 * the pool's settings, where Settings ▸ Worktrees keeps it, so a process
 * without a pool (a Studio server out of process) installs nothing, as it has
 * no installer either.
 */
async function withDependencyInstall(
  created: GitWorktreeCreated,
  repoRoot: string,
  input: Pick<GitWorktreeCreateInput, 'branchName' | 'dependencyInstall' | 'quietInstall'>,
): Promise<GitWorktreeCreated> {
  const installer = activeDependencyInstaller()
  const pool = activeWorktreePool()
  if (!installer || !pool) return created
  const request = {
    repoRoot,
    path: created.path,
    branch: created.branch ?? input.branchName,
    setting: dependencyInstallSettingFor(await pool.getSettings(), repoRoot),
    ...(input.quietInstall ? { quiet: true } : {}),
  }
  const dependencyInstall =
    input.dependencyInstall === 'start'
      ? ((await installer.start(request))?.view ?? null)
      : await installer.prepare(request)
  return { ...created, dependencyInstall }
}

// One restore per worktree path at a time; see restoreGitWorktree.
const restoresInFlight = new Map<string, Promise<GitWorktreeRestoreResult>>()

/**
 * Bring a chat's worktree back: `git worktree add <path> <branch>`, at the path
 * the chat records, on the branch it was cut onto — no `-b`, the branch is the
 * one thing the cleanup keeps (agent-worktree-cleanup.ts). Locked and seeded
 * from `.worktreeinclude` exactly as when it was first made, so the chat comes
 * back to the checkout it left, its untracked setup files included.
 *
 * Every refusal is worded for the person, because it is shown to them as the
 * reason their chat opened without its folder: the branch is gone, something
 * else now sits at the path, or the branch is checked out somewhere else.
 *
 * A worktree already back at that path on that branch (another window restored
 * it first) is answered as success, so a second caller never reads its own
 * race as a failure. Two windows asking at once share one restore, and an add
 * that loses a race git saw first is answered from the listing after it.
 */
export function restoreGitWorktree(input: GitWorktreeRestoreInput): Promise<GitWorktreeRestoreResult> {
  const key = typeof input?.path === 'string' ? normalizeComparablePath(input.path) : ''
  const pending = restoresInFlight.get(key)
  if (pending) return pending
  const run = restoreGitWorktreeOnce(input).finally(() => restoresInFlight.delete(key))
  restoresInFlight.set(key, run)
  return run
}

async function restoreGitWorktreeOnce(input: GitWorktreeRestoreInput): Promise<GitWorktreeRestoreResult> {
  // Only ever a worktree in the app's own container: the cleanup reclaims
  // nothing else, so nothing else has a reason to come back this way. Named
  // whole, with no `.` or `..` to climb out of it.
  const notOurs = {
    ok: false as const,
    definitive: true as const,
    message: `${input.path} is not one of the app's worktrees, so it is not recreated.`,
  }
  const derivedRoot = typeof input.path === 'string' ? containedWorktreeRepoRoot(input.path) : null
  if (!derivedRoot) return notOurs

  const root = await resolveRepoRoot(input.repoRoot)
  if (!root.ok) {
    return {
      ok: false,
      message: `The project this worktree was cut from is no longer a git repository: ${input.repoRoot}`,
    }
  }

  // And in THIS project's container, as creation puts it: the container next
  // to the repository git names, however the chat spelled that repository.
  if (!(await isRepoTopLevel(derivedRoot, root.data))) return notOurs
  const destination = resolveWorktreeDestination(worktreeContainerPath(derivedRoot), input.path)
  if (!destination.ok) return notOurs
  const worktreePath = destination.data.destinationPath

  const branch = await validateBranchName(root.data, input.branchName)
  if (!branch.ok) return branch

  // A worktree pool slot the cleanup handed back is still on disk: the pool
  // checks the chat's branch out in it again, or says why it cannot.
  const pool = activeWorktreePool()
  if (pool) {
    await pool.load()
    if (pool.ownsPath(worktreePath)) {
      const reclaimed = await pool.reclaim({
        path: worktreePath,
        branch: branch.data,
        owner: input.agentLockOwner ?? branch.data,
      })
      if (reclaimed && !reclaimed.ok) {
        return reclaimed.definitive
          ? { ok: false, definitive: true, message: reclaimed.message }
          : { ok: false, message: reclaimed.message }
      }
      if (reclaimed?.ok) {
        const back = await listGitWorktrees(root.data, { resolvedRoot: true })
        if (!back.ok) return back
        const entry = back.data.worktrees.find(
          (worktree) => normalizeComparablePath(worktree.path) === normalizeComparablePath(worktreePath),
        )
        if (entry) return { ok: true, data: entry, message: null }
      }
    }
  }

  let listed = await listGitWorktrees(root.data, { resolvedRoot: true })
  if (!listed.ok) return listed
  const listedAt = (worktrees: GitWorktreeEntry[]): GitWorktreeEntry | undefined =>
    worktrees.find((worktree) => normalizeComparablePath(worktree.path) === normalizeComparablePath(worktreePath))
  let atPath = listedAt(listed.data.worktrees)
  if (atPath && (await pathExists(worktreePath))) {
    if (atPath.branch === branch.data) return { ok: true, data: atPath, message: null }
    return {
      ok: false,
      message: `Another worktree is at ${worktreePath} now, on ${atPath.branch ?? 'a detached HEAD'}, so this one cannot be recreated there.`,
    }
  }
  if (atPath) {
    // Git still lists the worktree, but its folder is gone: the sweep removed
    // it without git hearing, or a person deleted the folder. This profile's
    // own entry is cleared, alone (`worktree remove` of a missing folder,
    // not a prune of every missing one); another profile's lock, or one put
    // on by hand, is not the app's to lift.
    const ownEntry = !atPath.locked || atPath.agentLock === 'this-profile'
    const cleared =
      ownEntry &&
      (!atPath.locked || (await unlockWorktree(root.data, atPath.path)).ok) &&
      (await runGitCommand(root.data, ['worktree', 'remove', atPath.path])).ok
    if (cleared) {
      listed = await listGitWorktrees(root.data, { resolvedRoot: true })
      if (!listed.ok) return listed
      atPath = listedAt(listed.data.worktrees)
    }
    if (atPath) {
      return {
        ok: false,
        message: `Git still lists a worktree at ${worktreePath} whose folder is gone. Prune worktrees from the Worktree manager, then open the chat again.`,
      }
    }
  }
  if (await pathExists(worktreePath)) {
    return {
      ok: false,
      message: `Something else is at ${worktreePath} now, so the worktree cannot be recreated there.`,
    }
  }

  // Listed rather than verified: `rev-parse --verify` fails the same way for a
  // missing branch and a git that did not answer, and only the first is final.
  const heads = await runGitCommand(root.data, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch.data}`])
  if (!heads.ok) {
    return { ok: false, message: heads.message ?? `Could not look up branch "${branch.data}".` }
  }
  if (!heads.stdout.split(/\r?\n/).some((line) => line.trim() === `refs/heads/${branch.data}`)) {
    return {
      ok: false,
      definitive: true,
      message: `Branch "${branch.data}" no longer exists, so the worktree cannot be recreated.`,
    }
  }
  const holder = listed.data.worktrees.find((worktree) => worktree.branch === branch.data)
  if (holder) {
    return {
      ok: false,
      message: `Branch "${branch.data}" is checked out at ${holder.path}, so it cannot be checked out here as well.`,
    }
  }

  await mkdir(toFilesystemPath(dirname(worktreePath)), { recursive: true })
  const addResult = await runGitCommand(root.data, ['worktree', 'add', worktreePath, branch.data])
  if (!addResult.ok) {
    // Another process (a second app instance, a person at a shell) may have
    // put it back in the meantime, or the add made it and only a hook failed:
    // what git lists now is the answer. Not seeded again over whatever is
    // there, but locked if nothing locked it.
    const after = await listGitWorktrees(root.data, { resolvedRoot: true })
    const back = after.ok ? listedAt(after.data.worktrees) : undefined
    if (back?.branch === branch.data && (await pathExists(worktreePath))) {
      if (back.locked || !input.agentLockOwner) return { ok: true, data: back, message: null }
      return finishAddedWorktree(root.data, worktreePath, { agentLockOwner: input.agentLockOwner }, addResult)
    }
    return {
      ok: false,
      message: addResult.message ?? 'Unable to recreate the Git worktree.',
      stdout: addResult.stdout,
      stderr: addResult.stderr,
    }
  }

  return finishAddedWorktree(root.data, worktreePath, input, addResult)
}

/**
 * The repository a worktree path belongs to by the container convention
 * (`<parent>/.sprintengine-worktrees/<repo>/<slug…>`), for an absolute path
 * every segment of whose slug is a real name; null for anything else.
 */
function containedWorktreeRepoRoot(pathValue: string): string | null {
  if (!isAbsolute(pathValue)) return null
  const segments = pathValue.replace(/[\\/]+$/, '').split(/[\\/]/)
  if (segments.some((segment) => segment === '.' || segment === '..')) return null
  const marker = segments.lastIndexOf(WORKTREE_CONTAINER_DIR)
  if (marker < 0 || segments.slice(marker + 1).some((segment) => segment.length === 0)) return null
  return repoRootFromWorktreePath(pathValue)
}

/**
 * Whether `folder` is the top of the repository git resolved as `repoRoot`. The
 * chat spells paths its own way and git its way (a symlinked parent resolved),
 * so a spelling that differs asks git from there: the same top level, and no
 * prefix, which a folder inside the repository would have.
 */
async function isRepoTopLevel(folder: string, repoRoot: string): Promise<boolean> {
  if (normalizeComparablePath(folder) === normalizeComparablePath(repoRoot)) return true
  const asked = await runGitCommand(folder, ['rev-parse', '--show-toplevel', '--show-prefix'])
  if (!asked.ok) return false
  const [topLevel = '', prefix = ''] = asked.stdout.split(/\r?\n/)
  return prefix.trim() === '' && normalizeComparablePath(topLevel.trim()) === normalizeComparablePath(repoRoot)
}

export async function removeGitWorktree(
  input: GitWorktreeRemoveInput,
): Promise<GitWorktreeOperationResult<GitCommandResult>> {
  const root = await resolveRepoRoot(input.repoRoot)
  if (!root.ok) return root

  const worktreePath = input.path
  const worktrees = await listGitWorktrees(root.data, { resolvedRoot: true })
  if (!worktrees.ok) return worktrees

  const registeredWorktree = worktrees.data.worktrees.find(
    (worktree) => normalizeComparablePath(worktree.path) === normalizeComparablePath(worktreePath),
  )
  if (!registeredWorktree) {
    return {
      ok: false,
      message: `Worktree is not registered for this repository: ${worktreePath}`,
    }
  }

  if (!(await pathExists(worktreePath))) {
    return {
      ok: false,
      message: `Worktree path is missing: ${worktreePath}. Run worktree prune to clean up stale Git metadata.`,
    }
  }

  if (!input.force) {
    const statusResult = await runGitCommand(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (!statusResult.ok) {
      return {
        ok: false,
        message: statusResult.message ?? 'Unable to check whether the worktree is clean.',
        stdout: statusResult.stdout,
        stderr: statusResult.stderr,
      }
    }

    if (statusResult.stdout.length > 0) {
      return {
        ok: false,
        message: `Worktree has uncommitted changes: ${worktreePath}. Commit, stash, discard changes, or retry with force.`,
        stdout: statusResult.stdout,
        stderr: statusResult.stderr,
      }
    }
  }

  // The in-use lock this profile put on its own agent worktree is the app's
  // mark, not the person's, and a person removing the worktree releases it.
  // Any other lock (another profile's agent, or one placed by hand) makes git
  // refuse below, which is the point of it.
  const ownLock = registeredWorktree.locked && registeredWorktree.agentLock === 'this-profile'
  if (ownLock) {
    const unlocked = await unlockWorktree(root.data, worktreePath)
    if (!unlocked.ok) return toWorktreeResult(unlocked, unlocked)
  }

  const removeResult = await withWorktreeRegistryLock(root.data, () =>
    runGitCommand(root.data, ['worktree', 'remove', ...(input.force ? ['--force'] : []), worktreePath]),
  )
  if (!removeResult.ok && ownLock) await relockWorktree(root.data, worktreePath, registeredWorktree.lockedReason)

  return toWorktreeResult(removeResult, removeResult)
}

export async function pruneGitWorktrees(repoRoot: string): Promise<GitWorktreeOperationResult<GitCommandResult>> {
  const root = await resolveRepoRoot(repoRoot)
  if (!root.ok) return root

  // `prune` skips locked entries (git never even reports a locked one as
  // prunable). One of this profile's own agent locks on a worktree whose folder
  // is gone would otherwise keep its metadata for good, which is not what a
  // person pressing Prune asked for.
  const listed = await listGitWorktrees(root.data, { resolvedRoot: true })
  if (listed.ok) {
    for (const worktree of listed.data.worktrees) {
      if (worktree.locked && worktree.agentLock === 'this-profile' && !(await pathExists(worktree.path))) {
        await unlockWorktree(root.data, worktree.path)
      }
    }
  }

  const result = await withWorktreeRegistryLock(root.data, () => runGitCommand(root.data, ['worktree', 'prune']))
  return toWorktreeResult(result, result)
}

/**
 * Lift an agent in-use lock from a worktree, at a person's request. For a lock
 * nothing will lift by itself: another profile's (one since deleted, or whose
 * user-data folder moved), or one placed before a profile was named. A lock a
 * person placed by hand is not the app's to lift, and is refused.
 */
export async function unlockAgentGitWorktree(
  repoRoot: string,
  worktreePath: string,
): Promise<GitWorktreeOperationResult<GitCommandResult>> {
  const root = await resolveRepoRoot(repoRoot)
  if (!root.ok) return root
  const listed = await listGitWorktrees(root.data, { resolvedRoot: true })
  if (!listed.ok) return listed
  const worktree = listed.data.worktrees.find(
    (candidate) => normalizeComparablePath(candidate.path) === normalizeComparablePath(worktreePath),
  )
  if (!worktree?.locked) return { ok: false, message: `Worktree is not locked: ${worktreePath}` }
  if (!worktree.agentLock) {
    return {
      ok: false,
      message: 'This lock was not placed by SprintEngine Studio. Unlock it with git worktree unlock.',
    }
  }
  const result = await unlockWorktree(root.data, worktree.path)
  return toWorktreeResult(result, result)
}

export async function getGitFileBase(repoRoot: string, filePath: string): Promise<GitFileBaseResult> {
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(filePath)
  if (!isInsideRepo(repoRoot, absolutePath) && dirname(absolutePath) !== repoRoot) {
    return { ok: false, message: 'File is outside the Git repository.' }
  }

  try {
    const relativePath = getRelativeGitPath(repoRoot, absolutePath)
    const content = await runGit(repoRoot, ['show', `HEAD:${relativePath}`])
    return { ok: true, content }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message }
  }
}

// Read the file 5 MiB cap mirrors the renderer's editor read limit: past this
// the diff viewer degrades to a clear "too large" message rather than hanging.
const GIT_FILE_STAGE_MAX_BYTES = 5 * 1024 * 1024

// Returns the file's stored content at a given Git stage for the diff viewer.
// A missing object (new file has no HEAD/index entry; a deleted file has no
// index entry) is not an error here — it resolves to `exists: false` with empty
// content so the viewer can render an empty pane. Binary and oversized objects
// are reported via flags instead of returning their bytes as text.
export async function getGitFileAtStage(
  repoRoot: string,
  filePath: string,
  stage: GitFileStage,
): Promise<GitFileStageResult> {
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(filePath)
  if (!isInsideRepo(repoRoot, absolutePath) && dirname(absolutePath) !== repoRoot) {
    return { ok: false, message: 'File is outside the Git repository.' }
  }

  const relativePath = getRelativeGitPath(repoRoot, absolutePath)
  const ref = stage === 'head' ? `HEAD:${relativePath}` : `:0:${relativePath}`

  // `cat-file -s` resolves both existence and size in one cheap call: it fails
  // when the object is absent at this stage, and prints the byte size when present.
  const sizeResult = await runGitCommand(repoRoot, ['cat-file', '-s', ref])
  if (!sizeResult.ok) {
    return { ok: true, exists: false, content: '', binary: false, tooLarge: false }
  }
  const size = Number.parseInt(sizeResult.stdout.trim(), 10)
  if (Number.isFinite(size) && size > GIT_FILE_STAGE_MAX_BYTES) {
    return { ok: true, exists: true, content: '', binary: false, tooLarge: true }
  }

  try {
    const content = await runGit(repoRoot, ['show', ref])
    const binary = content.includes('\u0000')
    return { ok: true, exists: true, content: binary ? '' : content, binary, tooLarge: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message }
  }
}

function normalizeConflictFilePath(
  repoRoot: string,
  filePath: string,
): { absolutePath: string; relativePath: string } | null {
  const absolutePath = isAbsolute(filePath) ? filePath : toAbsolutePath(repoRoot, toPosixPath(filePath))
  if (!isInsideRepo(repoRoot, absolutePath) && dirname(absolutePath) !== repoRoot) return null

  return {
    absolutePath,
    relativePath: getRelativeGitPath(repoRoot, absolutePath),
  }
}

async function getGitConflictStage(repoRoot: string, stage: 1 | 2 | 3, relativePath: string): Promise<string | null> {
  const result = await runGitCommand(repoRoot, ['show', `:${stage}:${relativePath}`])
  return result.ok ? result.stdout : null
}

export async function getGitConflictFile(repoRoot: string, filePath: string): Promise<GitConflictFileContent | null> {
  const normalized = normalizeConflictFilePath(repoRoot, filePath)
  if (!normalized) return null

  const [base, ours, theirs] = await Promise.all([
    getGitConflictStage(repoRoot, 1, normalized.relativePath),
    getGitConflictStage(repoRoot, 2, normalized.relativePath),
    getGitConflictStage(repoRoot, 3, normalized.relativePath),
  ])

  let result = ''
  try {
    result = await readFile(toFilesystemPath(normalized.absolutePath), 'utf8')
  } catch {
    result = ''
  }

  return {
    path: normalized.absolutePath,
    relativePath: normalized.relativePath,
    base,
    ours,
    theirs,
    result,
  }
}

export async function resolveGitConflict(
  repoRoot: string,
  filePath: string,
  content: string,
): Promise<GitCommandResult> {
  const normalized = normalizeConflictFilePath(repoRoot, filePath)
  if (!normalized) {
    return { ok: false, stdout: '', stderr: '', message: 'File is outside the Git repository.' }
  }

  await writeFile(toFilesystemPath(normalized.absolutePath), content, 'utf8')
  return runGitCommand(repoRoot, ['add', '--', normalized.relativePath])
}

// The two managed MCP-config files a per-spawn sync writes into a worktree root:
// Claude's `.mcp.json` and Codex's `.codex/config.toml`. Excluded from a
// connector worktree's git so the generated, machine-specific config never shows
// up in the connector chat's `git status` or commits.
export const MCP_CONFIG_WORKTREE_EXCLUDE_ENTRIES = ['.mcp.json', '.codex/config.toml'] as const

/**
 * Keep the generated managed MCP config ({@link MCP_CONFIG_WORKTREE_EXCLUDE_ENTRIES})
 * out of a connector worktree's git — that worktree's only, never the
 * repository's shared exclude file (see `integrations/worktree-exclude.ts`).
 * Best-effort at the call site: the caller swallows failures so a launch is
 * never blocked by an exclude write.
 */
export async function excludeMcpConfigFromWorktree(worktreePath: string): Promise<void> {
  await excludeFromWorktree(worktreePath, MCP_CONFIG_WORKTREE_EXCLUDE_ENTRIES)
}
