import { agentWorktreeLockOwner } from './agent-worktree-lock'
import type { GitWorktreeEntry, GitWorktreeListSnapshot, GitWorktreeOperationResult } from './git'
import { runGitCommand } from './git-utils'
import { resolveRepoRoot } from './git-worktree-validation'

function normalizeWorktreeBranch(refName: string): { branch: string; branchRef: string } {
  const branchPrefix = 'refs/heads/'
  return {
    branch: refName.startsWith(branchPrefix) ? refName.slice(branchPrefix.length) : refName,
    branchRef: refName,
  }
}

function createEmptyWorktree(pathValue: string): GitWorktreeEntry {
  return {
    path: pathValue,
    head: null,
    branch: null,
    branchRef: null,
    detached: false,
    bare: false,
    locked: false,
    lockedReason: null,
    prunable: false,
    prunableReason: null,
  }
}

/**
 * `git worktree list --porcelain`, with `-z` or without. With `-z` every
 * attribute ends in a NUL and nothing else splits it, so a path holding a
 * newline survives; without, each line is one.
 */
export function parseGitWorktreePorcelain(output: string): GitWorktreeEntry[] {
  const lines = (output.includes('\0') ? output.split('\0') : output.split(/\r?\n/)).filter(Boolean)
  const worktrees: GitWorktreeEntry[] = []
  let current: GitWorktreeEntry | null = null

  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current)
      current = createEmptyWorktree(line.slice('worktree '.length))
      continue
    }

    if (!current) continue

    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ')) {
      const branch = normalizeWorktreeBranch(line.slice('branch '.length))
      current.branch = branch.branch
      current.branchRef = branch.branchRef
    } else if (line === 'detached') {
      current.detached = true
    } else if (line === 'bare') {
      current.bare = true
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true
      current.lockedReason = line === 'locked' ? null : line.slice('locked '.length)
      const agentLock = agentWorktreeLockOwner(current.lockedReason)
      if (agentLock) current.agentLock = agentLock
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true
      current.prunableReason = line === 'prunable' ? null : line.slice('prunable '.length)
    }
  }

  if (current) worktrees.push(current)
  return worktrees
}

/**
 * `git worktree list --porcelain -z`, the one way every caller reads the list.
 * Git before 2.36 has no `-z` for this command and refuses the whole call
 * ("unknown switch `z'"), which left a pool unable to recover at startup and
 * every lock lookup unanswered on a machine still on an older git. There the
 * call is made again without it, and each newline becomes the NUL `-z` would
 * have written, so a caller splitting records on `\0\0` reads the same shape.
 * Only a path holding a newline is lost that way, and only on such a git.
 */
export async function runGitWorktreeListPorcelain<R extends { ok: boolean; stdout: string; stderr?: string }>(
  run: (cwd: string, args: string[]) => Promise<R>,
  cwd: string,
): Promise<R> {
  const nul = await run(cwd, ['worktree', 'list', '--porcelain', '-z'])
  if (nul.ok || !refusedNulFlag(nul)) return nul
  const lines = await run(cwd, ['worktree', 'list', '--porcelain'])
  return lines.ok ? { ...lines, stdout: lines.stdout.replace(/\r?\n/g, '\0') } : lines
}

function refusedNulFlag(result: { stdout: string; stderr?: string; message?: string | null }): boolean {
  const text = `${result.stderr ?? ''}\n${result.message ?? ''}\n${result.stdout}`
  return /unknown switch [`']z'/.test(text)
}

/**
 * `resolvedRoot` says the caller already holds git's own answer for the root
 * (it just resolved it), so the listing does not spend a process asking again.
 */
export async function listGitWorktrees(
  repoRoot: string,
  options: { resolvedRoot?: boolean } = {},
): Promise<GitWorktreeOperationResult<GitWorktreeListSnapshot>> {
  const root: GitWorktreeOperationResult<string> = options.resolvedRoot
    ? { ok: true, data: repoRoot, message: null }
    : await resolveRepoRoot(repoRoot)
  if (!root.ok) return root

  const result = await runGitWorktreeListPorcelain(runGitCommand, root.data)
  if (!result.ok) {
    return {
      ok: false,
      message: result.message ?? 'Unable to list Git worktrees.',
      stdout: result.stdout,
      stderr: result.stderr,
    }
  }

  return {
    ok: true,
    data: {
      repoRoot: root.data,
      worktrees: parseGitWorktreePorcelain(result.stdout),
      updatedAt: Date.now(),
    },
    message: null,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}
