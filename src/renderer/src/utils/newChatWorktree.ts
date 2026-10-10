import { nanoid } from 'nanoid'

import type { AgentState } from '../../../shared/agent-state'
import { LOCAL_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { useWorkspaceStore } from '../store/workspaceStore'
import type { AgentId, WorkspaceId, WorkspaceWorktree } from '../types/workspace'
import { publishDiagnosticSync } from './diagnostics'
import { agentWorktreePaths, newChatWorktreeName, workspaceProjectRootOf } from './workspaceWorktree'

export type NewChatWorktreeResult =
  | {
      ok: true
      folderPath: string
      worktree: WorkspaceWorktree
      /**
       * How to give the worktree back if nobody takes it: the repository git
       * made it in, and its pool lease when it is a pool slot.
       */
      made?: { repoRoot: string; leaseId: string | null }
    }
  | { ok: false; message: string }

export type NewChatWorktreeOptions = {
  /** Fold the dependency install into the chat rather than toast it (`GitWorktreeCreateInput.quietInstall`). */
  quietInstall?: boolean
  /** No diagnostic when it cannot be made: a reservation nobody asked for yet, tried again on Enter. */
  silent?: boolean
  /** The branch it will be on, once known and before git makes it. */
  onBranch?: (branch: string) => void
}

/**
 * The worktree the New chat door asked for under ⋯ (found at the seam of
 * checkout-and-branch-on-remote-create: the door offered the option and its
 * confirm dropped it on the floor). Same container, branch and include-set as
 * the tab strip's worktree spawn; the chat then opens IN the worktree, the way
 * the Worktree panel's "New chat here" does. When it cannot be made, a
 * diagnostic says why and the answer carries the same words — the caller
 * aborts rather than start the chat in the checkout the person asked to keep
 * clean. A thrown IPC call is one of those answers, not a rejection: the door
 * fires its confirm and forgets it, so a throw here had nowhere to be heard.
 *
 * The returned marker records the chat's project so the sidebar files it under
 * the project it was cut from instead of founding a header named after the
 * slug. It is deliberately the folder the chat was scoped to and not the
 * git-resolved `repoRoot` below: under a symlinked root git's realpath would
 * not string-match the open parent workspace's folderPath, and the chat would
 * found its own header all over again.
 *
 * The scoped folder can itself be one of our worktrees — the plain New chat
 * button inherits the active workspace's folder, and that workspace may be a
 * worktree chat. Everything here works off the PROJECT behind it, so the new
 * worktree is a sibling of the one it was started from rather than nested
 * inside its container, and records the real project as its own.
 *
 * `hostId` is the machine the chat will run on, which makes its worktree too:
 * a worktree made by another machine's git names a gitdir this one cannot
 * follow.
 */
export async function createNewChatWorktree(
  folderPath: string | null,
  requestedName: string,
  hostId?: ExecutionHostId | null,
  options: NewChatWorktreeOptions = {},
): Promise<NewChatWorktreeResult> {
  const fail = (title: string, message: string): NewChatWorktreeResult => {
    if (!options.silent) publishDiagnosticSync({ level: 'error', source: 'workspace', title, message })
    return { ok: false, message }
  }
  if (!folderPath)
    return fail('Worktree needs a project', 'Choose a project folder before starting a chat on a worktree.')
  const projectFolder = workspaceProjectRootOf({ folderPath }) ?? folderPath
  const worktreeHostId = hostId ?? undefined
  try {
    const repoRoot = await window.api.getGitRepoRoot(projectFolder, worktreeHostId)
    if (!repoRoot) {
      return fail(
        'Worktree needs a git repository',
        'This project is not a git repository, so a worktree cannot be created.',
      )
    }
    const name = requestedName.trim() || newChatWorktreeName(nanoid(4))
    const paths = agentWorktreePaths(repoRoot, name)
    if (!paths) return fail('Worktree name invalid', `"${name}" does not reduce to a usable worktree name.`)
    options.onBranch?.(paths.branchName)
    // From the worktree pool, on the default branch (main's git.ts): a
    // reused slot keeps the last agent's installed dependencies. A chat on a
    // WSL machine is declined by the pool and gets a fresh worktree from that
    // machine's git, forked from the same default branch.
    const result = await window.api.createGitWorktree({
      repoRoot,
      containerPath: paths.containerPath,
      destinationPath: paths.destinationPath,
      branchName: paths.branchName,
      baseRef: 'HEAD',
      copyIncludedFiles: true,
      // The branch names the owner: the door's other chats are created after
      // their worktree, and a chat agent's that waits on it (below) has no
      // folder yet, so neither is recorded anywhere that could name it.
      agentLockOwner: paths.branchName,
      fromPool: true,
      ...(worktreeHostId ? { hostId: worktreeHostId } : {}),
      ...(options.quietInstall ? { quietInstall: true } : {}),
    })
    if (!result.ok) return fail('Worktree failed', result.message)
    return {
      ok: true,
      folderPath: result.data.path,
      worktree: {
        branch: result.data.branch ?? paths.branchName,
        baseRef: result.data.baseRef,
        repoRoot: projectFolder,
      },
      made: { repoRoot, leaseId: result.data.leaseId ?? null },
    }
  } catch (error) {
    return fail('Worktree failed', error instanceof Error ? error.message : String(error))
  }
}

// ── A chat that opened before its worktree ──────────────────────────────────
//
// Making a worktree takes seconds (a fetch, then the checkout), and the door
// used to hold the person on New chat for all of them. A chat agent on a
// worktree now opens at once: its workspace is filed under the project by its
// worktree marker, has no folder, and its agent carries `chatPendingWorktree`.
// The attempt below gives it the folder; until then the chat starts nothing —
// it has no root to start a session in, and its pane gates on the record.
//
// The attempt is this window's. One that is not running here — the app went
// away mid-attempt, or the window was reloaded — is never coming back, so the
// chat reads as failed, with Retry and Start in the project, rather than
// waiting on nothing.

export type PendingNewChatWorktree = NonNullable<AgentState['chatPendingWorktree']>

const attempts = new Map<WorkspaceId, Promise<boolean>>()
// The branch each attempt is making, once it is known: the chat's working
// line finds the attempt's dependency install by it.
const attemptBranches = new Map<WorkspaceId, string>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Hear when an attempt starts or settles in this window. */
export function subscribeNewChatWorktreeAttempts(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether this window is making `workspaceId`'s worktree right now. */
export function newChatWorktreeAttemptRunning(workspaceId: WorkspaceId): boolean {
  return attempts.has(workspaceId)
}

/** The branch `workspaceId`'s worktree is being made on, while this window makes it. */
export function newChatWorktreeBranch(workspaceId: WorkspaceId): string | null {
  return attemptBranches.get(workspaceId) ?? null
}

/** Why a pending chat is not being made, or null while its attempt runs. */
export function pendingNewChatWorktreeFailure(
  workspaceId: WorkspaceId,
  pending: PendingNewChatWorktree,
): string | null {
  if (attempts.has(workspaceId)) return null
  return pending.failure ?? 'Studio closed before this chat’s worktree was made.'
}

function pendingChatOf(workspaceId: WorkspaceId): { agentId: AgentId; pending: PendingNewChatWorktree } | null {
  const workspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspaceId)
  for (const [agentId, agent] of Object.entries(workspace?.agents ?? {})) {
    if (agent.chatPendingWorktree) return { agentId, pending: agent.chatPendingWorktree }
  }
  return null
}

/**
 * Make the worktree a pending chat is waiting on, and give the chat its folder.
 * Resolves whether it did; a failure is written onto the chat, which shows it.
 * One attempt per chat at a time; a second caller waits on the first.
 */
export function prepareNewChatWorktree(workspaceId: WorkspaceId): Promise<boolean> {
  const running = attempts.get(workspaceId)
  if (running) return running
  const found = pendingChatOf(workspaceId)
  if (!found) return Promise.resolve(false)
  const { failure: _previous, ...attempt } = found.pending
  if (found.pending.failure !== undefined) {
    useWorkspaceStore.getState().updateAgent(workspaceId, found.agentId, { chatPendingWorktree: attempt })
  }
  const run = (async () => {
    const made = await obtainNewChatWorktree(attempt.projectFolder, attempt.name, attempt.hostId ?? null, {
      quietInstall: true,
      onBranch: (branch) => {
        attemptBranches.set(workspaceId, branch)
        notify()
      },
    })
    // Started in the project, or closed, while the worktree was being made:
    // the chat is no longer this attempt's to finish, and nothing will ever
    // use the worktree, so it goes back now rather than at a sweep an hour on.
    const still = pendingChatOf(workspaceId)
    if (!still) {
      if (made.ok) await giveBackUnusedWorktree(made, attempt.hostId ?? null)
      return false
    }
    const store = useWorkspaceStore.getState()
    if (!made.ok) {
      store.updateAgent(workspaceId, still.agentId, { chatPendingWorktree: { ...attempt, failure: made.message } })
      return false
    }
    // The folder first: the pane gates on the pending record, so clearing it
    // first would show a chat with no folder for a frame.
    store.setWorkspaceChatFolder(workspaceId, made.folderPath, made.worktree)
    store.updateAgent(workspaceId, still.agentId, { chatPendingWorktree: undefined })
    return true
  })().finally(() => {
    attempts.delete(workspaceId)
    attemptBranches.delete(workspaceId)
    notify()
  })
  attempts.set(workspaceId, run)
  notify()
  return run
}

/**
 * A worktree made for a chat that went before it landed, given back the way a
 * closed chat's is, without the wait: a pool slot is returned (held instead if
 * anything in it changed), and a fresh worktree is removed only while git
 * finds it clean. One made by another machine's git is left to the sweep, as
 * this one cannot remove it. Failure is silence: the sweep still finds it.
 */
async function giveBackUnusedWorktree(
  made: Extract<NewChatWorktreeResult, { ok: true }>,
  hostId: ExecutionHostId | null,
): Promise<void> {
  if (!made.made) return
  try {
    if (made.made.leaseId) await window.api.worktreePoolAction({ kind: 'release', leaseId: made.made.leaseId })
    else if (!hostId) await window.api.removeGitWorktree({ repoRoot: made.made.repoRoot, path: made.folderPath })
  } catch {
    // Left for the sweep.
  }
}

/**
 * Give up on the worktree and run the chat in the project it was to be cut
 * from. An attempt still running finds the chat no longer waiting when it
 * lands, and gives back what it made.
 */
export function startPendingNewChatInProject(workspaceId: WorkspaceId): boolean {
  const found = pendingChatOf(workspaceId)
  if (!found) return false
  const store = useWorkspaceStore.getState()
  store.setWorkspaceChatFolder(workspaceId, found.pending.projectFolder, null)
  store.updateAgent(workspaceId, found.agentId, { chatPendingWorktree: undefined })
  return true
}

// ── A worktree made while New chat is still open ────────────────────────────
//
// Opening New chat with Worktree on says the person is about to start work
// there, so the worktree is made while they type rather than after Enter: a
// pool slot is leased and, when the project opted in, its dependencies are
// installed. Enter then takes it as made (`takeReadyNewChatWorktree`) or still
// on its way (`obtainNewChatWorktree`), and the chat starts in it with nothing
// left to wait for, or very little.
//
// One reservation per New chat (its `owner`), for one project on this
// computer, on a branch named at random: a name typed into the chip is a
// different branch, so it is made on Enter as before. Turning Worktree off,
// moving to another project or closing New chat gives the slot back to the
// pool, clean, for the next chat; its empty `agent/` branch goes at the next
// cleanup sweep, like any other with no work of its own.
//
// Kept for a while only: the slot was reset to the base fetched when it was
// leased, and a chat should not start from a base an hour behind origin.

/** How long a made reservation stays good for a chat. Past it, Enter makes a fresh one. */
export const NEW_CHAT_RESERVATION_FRESH_MS = 15 * 60_000

type Reservation = {
  owner: string
  /** The project, as `workspaceProjectRootOf` reads the folder New chat stands on. */
  projectFolder: string
  branch: string | null
  /** Told the branch when it is known, for a chat that took the reservation before then. */
  onBranch: ((branch: string) => void) | null
  made: Promise<NewChatWorktreeResult>
  settled: NewChatWorktreeResult | null
  startedAt: number
  /** The give-back waiting out a closed New chat's grace, or null. */
  releaseTimer: ReturnType<typeof setTimeout> | null
}

const reservations = new Map<string, Reservation>()
// The project each New chat's last reservation could not be made in. It is
// not asked for again there: Enter makes the worktree, and says why.
const failedReservations = new Map<string, string>()
const reservationListeners = new Set<() => void>()

function reservationsChanged(): void {
  for (const listener of reservationListeners) listener()
}

/** Hear when a reservation is made, taken or given back. */
export function subscribeNewChatWorktreeReservations(listener: () => void): () => void {
  reservationListeners.add(listener)
  return () => reservationListeners.delete(listener)
}

/** This computer, however it was named: the only machine a reservation is made for. */
function localHost(hostId: ExecutionHostId | null | undefined): boolean {
  return !hostId || hostId === LOCAL_HOST_ID
}

function projectOf(folderPath: string): string {
  return workspaceProjectRootOf({ folderPath }) ?? folderPath
}

/**
 * Make a worktree for the chat New chat (`owner`) is about to start in
 * `folderPath`'s project. Asking again for the same project keeps the one on
 * its way; another project, or another machine, gives that one back first.
 * Only this computer's: another machine's worktree could not be given back.
 */
export function reserveNewChatWorktree(owner: string, folderPath: string, hostId?: ExecutionHostId | null): void {
  if (!localHost(hostId)) {
    releaseNewChatWorktreeReservation(owner)
    return
  }
  const projectFolder = projectOf(folderPath)
  if (failedReservations.get(owner) === projectFolder) return
  const current = reservations.get(owner)
  if (current?.projectFolder === projectFolder) {
    if (current.releaseTimer) clearTimeout(current.releaseTimer)
    current.releaseTimer = null
    return
  }
  releaseNewChatWorktreeReservation(owner)
  const reservation: Reservation = {
    owner,
    projectFolder,
    branch: null,
    onBranch: null,
    made: Promise.resolve({ ok: false, message: '' }),
    settled: null,
    startedAt: Date.now(),
    releaseTimer: null,
  }
  reservation.made = createNewChatWorktree(projectFolder, '', null, {
    quietInstall: true,
    silent: true,
    onBranch: (branch) => {
      reservation.branch = branch
      reservation.onBranch?.(branch)
    },
  }).then((made) => {
    reservation.settled = made
    // A reservation that could not be made is not kept: Enter makes the
    // worktree itself, and says why if it fails again.
    if (!made.ok && reservations.get(owner) === reservation) {
      failedReservations.set(owner, projectFolder)
      reservations.delete(owner)
      reservationsChanged()
    }
    return made
  })
  reservations.set(owner, reservation)
  reservationsChanged()
}

/**
 * Give `owner`'s reservation back to the pool: at once, or after `graceMs`
 * (a New chat closing, whose Enter may be claiming it a moment later).
 */
export function releaseNewChatWorktreeReservation(owner: string, graceMs = 0): void {
  if (graceMs === 0) failedReservations.delete(owner)
  const reservation = reservations.get(owner)
  if (!reservation) return
  if (graceMs > 0) {
    if (reservation.releaseTimer) return
    reservation.releaseTimer = setTimeout(() => {
      reservation.releaseTimer = null
      if (reservations.get(owner) === reservation) releaseNewChatWorktreeReservation(owner)
    }, graceMs)
    return
  }
  if (reservation.releaseTimer) clearTimeout(reservation.releaseTimer)
  reservations.delete(owner)
  reservationsChanged()
  void reservation.made.then((made) => (made.ok ? giveBackUnusedWorktree(made, null) : undefined))
}

/** Whether `owner` holds a reservation now (made or on its way). */
export function hasNewChatWorktreeReservation(owner: string): boolean {
  return reservations.has(owner)
}

/**
 * The reservation a chat asking for `requestedName` in `folderPath`'s project
 * on `hostId` can take, taken out of the list. Only an unnamed worktree's, on
 * this computer; a stale one is given back instead.
 */
function claimReservation(
  folderPath: string,
  requestedName: string,
  hostId: ExecutionHostId | null | undefined,
  ready: boolean,
): Reservation | null {
  if (requestedName.trim() || !localHost(hostId)) return null
  const projectFolder = projectOf(folderPath)
  let found: Reservation | null = null
  for (const reservation of reservations.values()) {
    if (reservation.projectFolder !== projectFolder) continue
    if (ready && !reservation.settled?.ok) continue
    // The one most likely made: settled before one still on its way.
    if (!found || (reservation.settled?.ok && !found.settled?.ok)) found = reservation
  }
  if (!found) return null
  if (Date.now() - found.startedAt > NEW_CHAT_RESERVATION_FRESH_MS) {
    releaseNewChatWorktreeReservation(found.owner)
    return null
  }
  if (found.releaseTimer) clearTimeout(found.releaseTimer)
  reservations.delete(found.owner)
  reservationsChanged()
  return found
}

/**
 * The worktree reserved for this chat, if it is already made: Enter starts the
 * chat in it at once, with no pending state at all.
 */
export function takeReadyNewChatWorktree(
  folderPath: string | null,
  requestedName: string,
  hostId?: ExecutionHostId | null,
): Extract<NewChatWorktreeResult, { ok: true }> | null {
  if (!folderPath) return null
  const claimed = claimReservation(folderPath, requestedName, hostId, true)
  return claimed?.settled?.ok ? claimed.settled : null
}

/**
 * The worktree a chat asked for: the one reserved for it while New chat was
 * open, when there is one (made, or waited on while it finishes), or a new one.
 */
export async function obtainNewChatWorktree(
  folderPath: string | null,
  requestedName: string,
  hostId?: ExecutionHostId | null,
  options: NewChatWorktreeOptions = {},
): Promise<NewChatWorktreeResult> {
  const claimed = folderPath ? claimReservation(folderPath, requestedName, hostId, false) : null
  if (claimed) {
    if (claimed.branch) options.onBranch?.(claimed.branch)
    else claimed.onBranch = options.onBranch ?? null
    const made = await claimed.made
    if (made.ok) return made
  }
  return createNewChatWorktree(folderPath, requestedName, hostId, options)
}
