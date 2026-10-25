import { isAbsolute, resolve } from 'path'
import { comparablePath } from '../shared/host-paths'
import { LOCAL_HOST_ID, workspaceHostIdOf } from '../shared/execution-host'
import { isMachinePath } from '../shared/machine-paths'
import { insideAny, pathSpellings } from './agent-worktree-keep-checks'
import {
  defaultSlotGitRunner,
  fetchBase,
  LEASE_FETCH_TIMEOUT_MS,
  operationInProgress,
  readSlotStatus,
  resolvePoolBaseRef,
  revParseCommit,
  type SlotGitRunner,
} from './worktree-pool/slot-git'

/**
 * A new chat started in a project's own checkout reads the code as it was
 * last pulled there, which can be weeks behind: the pool fetches
 * `origin/<default>` for every worktree it hands out, but nothing moved the
 * checkout's own branch, and an agent asked about the code read the old one.
 *
 * So before a new chat's first agent starts in a checkout, the checkout is
 * brought up to the default branch as origin has it, the way `git pull
 * --ff-only` would, when that cannot touch anyone's work:
 *
 * - It is a project's main checkout on this machine: not a linked worktree
 *   (the pool brings its own up to date), not a folder on another machine.
 * - It is on the default branch, with no staged or unstaged change to a
 *   tracked file, and no merge, rebase or cherry-pick in progress. Untracked
 *   files are left where they are; git refuses the move by itself if the new
 *   commits would overwrite one.
 * - No other chat has a turn running in it: a moving tree under an agent that
 *   is reading it is the stale read this is here to prevent, inverted.
 * - The branch is only behind, never ahead or diverged: a fast-forward or
 *   nothing. Local commits not on origin keep it where it is.
 *
 * Only once per chat, as it starts: a chat already under way is not moved
 * between its turns. The fetch has the deadline a lease's has; offline, the
 * checkout catches up to what `origin/<default>` already says. Nothing here
 * refuses the chat: whatever stops the catch-up is logged, and the chat starts
 * on the checkout as it is.
 */

/** A chat as the catch-up reads it off the workspace registry. */
export type CatchUpChat = {
  folderPath?: string | null
  worktree?: unknown
  environment?: unknown
  remoteOrigin?: unknown
  hostId?: string | null
}

export type MainCheckoutCatchUpDeps = {
  chat: (workspaceId: string) => CatchUpChat | null | undefined
  /** Folders a chat's session works in now (a running turn, a live child): one in the checkout keeps it still. */
  liveSessionPaths: () => string[] | Promise<string[]>
  git?: SlotGitRunner
  log?: (line: string) => void
  fetchTimeoutMs?: number
}

export type MainCheckoutCatchUpOutcome =
  | { kind: 'moved'; from: string; to: string; commits: number; ref: string }
  | { kind: 'current' }
  | { kind: 'skipped'; why: string }

export type MainCheckoutCatchUp = (input: {
  workspaceId: string
  workspaceRoot: string
}) => Promise<MainCheckoutCatchUpOutcome>

export function createMainCheckoutCatchUp(deps: MainCheckoutCatchUpDeps): MainCheckoutCatchUp {
  const git = deps.git ?? defaultSlotGitRunner
  const log = deps.log ?? ((line: string) => console.info(`[checkout-catch-up] ${line}`))
  // Two chats started together in one checkout share the one catch-up.
  const inFlight = new Map<string, Promise<MainCheckoutCatchUpOutcome>>()

  return async ({ workspaceId, workspaceRoot }) => {
    const chat = deps.chat(workspaceId)
    const folder = chat?.folderPath
    if (!chat || !folder) return { kind: 'skipped', why: 'no chat on record' }
    if (chat.worktree || chat.environment || chat.remoteOrigin || isMachinePath(folder)) {
      return { kind: 'skipped', why: 'not a folder chat on this machine' }
    }
    if (workspaceHostIdOf(chat) !== LOCAL_HOST_ID) return { kind: 'skipped', why: 'not on this machine' }
    if (comparablePath(folder) !== comparablePath(workspaceRoot)) {
      return { kind: 'skipped', why: 'the session runs outside the chat’s folder' }
    }
    const key = comparablePath(folder)
    let pending = inFlight.get(key)
    if (!pending) {
      pending = catchUp(folder).catch((error: unknown) => ({
        kind: 'skipped' as const,
        why: error instanceof Error ? error.message : String(error),
      }))
      inFlight.set(key, pending)
      void pending.finally(() => inFlight.delete(key))
    }
    const outcome = await pending
    if (outcome.kind === 'moved') {
      log(
        `${folder}: fast-forwarded to ${outcome.ref} (${outcome.from.slice(0, 9)}..${outcome.to.slice(0, 9)}, ${outcome.commits} commit${outcome.commits === 1 ? '' : 's'}) before a new chat`,
      )
    } else if (outcome.kind === 'skipped') {
      log(`${folder}: left as it is (${outcome.why})`)
    }
    return outcome
  }

  async function catchUp(folder: string): Promise<MainCheckoutCatchUpOutcome> {
    const skip = (why: string): MainCheckoutCatchUpOutcome => ({ kind: 'skipped', why })
    const located = await git(folder, [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--absolute-git-dir',
      '--git-common-dir',
    ])
    if (!located.ok) return skip('not a git checkout')
    const [toplevel, gitDir, common] = located.stdout.split(/\r?\n/u).map((line) => line.trim())
    if (!toplevel || !gitDir || !common) return skip('not a git checkout')
    const commonDir = isAbsolute(common) ? common : resolve(toplevel, common)
    if (comparablePath(gitDir) !== comparablePath(commonDir)) return skip('a linked worktree')

    const ref = await resolvePoolBaseRef(git, toplevel)
    const remoteBranch = ref ? /^[^/]+\/(.+)$/u.exec(ref)?.[1] : undefined
    if (!ref || !remoteBranch) return skip('no remote default branch')
    const status = await readSlotStatus(git, toplevel)
    if (!status.ok) return skip(`git status failed: ${status.message}`)
    if (status.status.branch !== remoteBranch) {
      return skip(status.status.branch ? `on ${status.status.branch}, not ${remoteBranch}` : 'on a detached HEAD')
    }
    if (status.status.trackedPaths.length > 0) return skip('it has uncommitted changes')
    const operation = await operationInProgress(gitDir)
    if (operation) return skip(`a ${operation} is in progress`)
    const checkout = await pathSpellings(toplevel)
    for (const path of ((await deps.liveSessionPaths()) ?? []).filter(Boolean)) {
      if (insideAny(await pathSpellings(path), checkout)) return skip('another chat has a turn running in it')
    }

    const fetched = await fetchBase(git, toplevel, ref, deps.fetchTimeoutMs ?? LEASE_FETCH_TIMEOUT_MS)
    if (!fetched.ok)
      log(`${toplevel}: fetching ${ref} failed (${fetched.message ?? 'no reason given'}); using it as it stands`)
    const head = status.status.oid
    const target = await revParseCommit(git, toplevel, ref)
    if (!head || !target) return skip(`${ref} could not be read`)
    if (head === target) return { kind: 'current' }
    const behind = await git(toplevel, ['merge-base', '--is-ancestor', head, target])
    if (!behind.ok) return skip(`${remoteBranch} has commits ${ref} does not`)
    const counted = await git(toplevel, ['rev-list', '--count', `${head}..${target}`])
    const commits = counted.ok ? Number.parseInt(counted.stdout.trim(), 10) || 0 : 0
    const merged = await git(toplevel, ['merge', '--ff-only', '--quiet', target])
    if (!merged.ok) return skip(`git merge --ff-only refused: ${(merged.message ?? '').trim().split('\n').at(-1)}`)
    return { kind: 'moved', from: head, to: target, commits, ref }
  }
}
