import { basename } from 'node:path'

import type { Workspace } from '../renderer/src/types/workspace'
import { conversationWorkingRoot } from '../shared/agent-state'
import { conversationSessionWorking } from '../shared/conversation/phase'
import type { ConversationSessionSummary } from '../shared/conversation-runtime'
import { isWslHostId, workspaceHostIdOf } from '../shared/execution-host'
import type {
  SettledChatDeletionOutcome,
  SettledChatDeletionPlan,
  SettledChatWorktreeOutcome,
  SettledChatWorktreePlan,
} from '../shared/ipc/settled-chats'
import { isSettledWorkspace } from '../shared/workspace-lifecycle'
import { repoRootFromWorktreePath } from '../shared/worktree-paths'
import { insideAny, pathSpellings } from './agent-worktree-keep-checks'
import { conversationStorageSegment } from './conversation-index'
import { workspaceStorePath } from './workspace-store'

/**
 * Deleting a settled chat for good: the one way to be rid of a chat now that
 * Settle is the only way to put one away. A settled chat keeps its record, its
 * history and (until the cleanup reclaims it) its worktree, so it can be
 * brought back; deleting it takes all three.
 *
 * - **Its history:** every transcript of every agent the chat has had, through
 *   the conversation runtime's own delete (which stops a session still open and
 *   takes the checkpoints, attachments, plans and handoff notes with it), and
 *   then the chat's whole folder in its store's `conversations/`, so nothing
 *   another feature wrote beside the transcripts is left behind.
 * - **Its record**, through the sync service, which tombstones the id so a
 *   lagging window cannot write it back.
 * - **Its worktree**, when the chat owns one: a pool slot goes back to the
 *   pool, and a worktree in Studio's worktree folder is removed. The branch is
 *   kept either way. Never one with uncommitted changes (the removal refuses
 *   it, and a pool slot is held for a person instead), never one another chat
 *   works in, never one Studio did not make, and never one on another machine.
 *   Commits not pushed stay on the kept branch; the confirmation says so.
 *
 * A chat opened here from a paired machine lives on that machine: deleting it
 * takes this computer's record and nothing else (see `remoteMachine`).
 *
 * The plan is what the window shows before asking; the delete checks it all
 * again, since a worktree may have been written to while the dialog was open.
 */

type ChatRecord = Pick<
  Workspace,
  'id' | 'folderPath' | 'worktree' | 'worktreeState' | 'agents' | 'settledAt' | 'remoteOrigin' | 'environment'
> & { hostId?: string | null }

type CommandResult = { ok: true } | { ok: false; message: string }

/** What the chat's worktree checks and removals need of the machine. */
export type SettledChatWorktreeOps = {
  /** Whether a path is one of the worktree pool's slots. */
  isPoolSlot(path: string): Promise<boolean>
  exists(path: string): Promise<boolean>
  /** The worktree's checkout as git reports it now; null when it could not be read. */
  inspect(path: string): Promise<{ branch: string | null; changedPaths: number; unpushedCommits: number | null } | null>
  /** Give a pool slot back: `returned` when clean, `held` when the pool keeps it for its changes. */
  releaseSlot(path: string): Promise<{ result: 'returned' | 'kept'; detail?: string }>
  /** Remove a worktree the pool does not own, checked as Settings ▸ Worktrees checks one. */
  removeWorktree(input: { repoRoot: string; path: string }): Promise<CommandResult>
}

export type SettledChatDeletionDeps = {
  /** Every chat on record. */
  listChats(): readonly ChatRecord[]
  removeChat(workspaceId: string): CommandResult
  conversations: {
    listSessions(input: { workspaceId: string }): { ok: true; sessions: ConversationSessionSummary[] } | { ok: false }
    listThreads(input: {
      workspaceId: string
      workspaceRoot: string
    }): Promise<{ ok: true; threads: ReadonlyArray<{ agentId: string }> } | { ok: false; message: string }>
    deleteTranscript(input: {
      workspaceRoot: string
      workspaceId: string
      agentId: string
    }): Promise<{ ok: true } | { ok: false; message: string }>
  }
  /** Remove a store path (the chat's `conversations/` folder) under a workspace root; absent is fine. */
  removeConversationStorage(workspaceRoot: string, path: string): Promise<void>
  worktrees: SettledChatWorktreeOps
  /** The store folder a chat's transcripts are in, for a root it ran in. Throws for a folder it has none for. */
  conversationFolder?: (workspaceRoot: string, workspaceId: string) => string
  log?: (line: string) => void
}

const defaultConversationFolder = (workspaceRoot: string, workspaceId: string) =>
  workspaceStorePath(workspaceRoot, 'conversations', conversationStorageSegment(workspaceId))

/** The folders a chat works in, by the paths it records: its own and its agents'. */
function pathsOf(chat: ChatRecord): string[] {
  const paths = new Set<string>()
  if (chat.folderPath?.trim()) paths.add(chat.folderPath)
  const entries = chat.worktreeState?.entries ?? {}
  for (const agent of Object.values(chat.agents ?? {})) {
    const execution = agent?.execution
    if (execution?.cwd?.trim()) paths.add(execution.cwd)
    const entry = execution?.worktreeId ? entries[execution.worktreeId] : undefined
    if (entry?.path) paths.add(entry.path)
  }
  for (const entry of Object.values(entries)) if (entry?.path && entry.status !== 'missing') paths.add(entry.path)
  return [...paths]
}

/**
 * The worktrees a chat owns: its folder when it is a worktree chat (and the
 * cleanup has not reclaimed it already), and every worktree an agent of it
 * was given. Repository root beside each, where it is known.
 */
function ownedWorktreesOf(chat: ChatRecord): Array<{ path: string; branch: string | null; repoRoot: string | null }> {
  const owned = new Map<string, { path: string; branch: string | null; repoRoot: string | null }>()
  const folder = chat.folderPath?.trim() ? chat.folderPath : null
  if (folder && chat.worktree && typeof chat.worktree.reclaimedAt !== 'number') {
    owned.set(folder, {
      path: folder,
      branch: chat.worktree.branch ?? null,
      repoRoot: chat.worktree.repoRoot ?? repoRootFromWorktreePath(folder),
    })
  }
  for (const entry of Object.values(chat.worktreeState?.entries ?? {})) {
    if (!entry?.path || entry.status === 'missing' || owned.has(entry.path) || entry.path === folder) continue
    owned.set(entry.path, { path: entry.path, branch: entry.branch, repoRoot: repoRootFromWorktreePath(entry.path) })
  }
  return [...owned.values()]
}

/** Every (root, agent) whose transcript the chat may have, and every store folder they are in. */
async function transcriptsOf(
  chat: ChatRecord,
  deps: SettledChatDeletionDeps,
): Promise<{
  transcripts: Array<{ workspaceRoot: string; agentId: string }>
  folders: Array<{ root: string; path: string }>
}> {
  const folderOf = deps.conversationFolder ?? defaultConversationFolder
  const roots = new Set<string>()
  const folder = chat.folderPath?.trim() ? chat.folderPath : null
  if (folder) roots.add(folder)
  for (const agent of Object.values(chat.agents ?? {})) {
    if (agent?.runtimeKind !== 'conversation') continue
    const root = conversationWorkingRoot(agent, folder)
    if (root) roots.add(root)
  }
  const transcripts: Array<{ workspaceRoot: string; agentId: string }> = []
  const folders = new Map<string, { root: string; path: string }>()
  for (const root of roots) {
    let path: string
    try {
      path = folderOf(root, chat.id)
    } catch {
      // A folder with no store here (an SSH machine's): its chats' history is that machine's.
      continue
    }
    // Two roots of one project share its store; the folder is read once.
    if (folders.has(path)) continue
    folders.set(path, { root, path })
    const agentIds = new Set<string>()
    for (const [agentId, agent] of Object.entries(chat.agents ?? {})) {
      if (agent?.runtimeKind === 'conversation') agentIds.add(agentId)
    }
    // An agent removed from the chat's layout still has its transcript on disk.
    const listed = await deps.conversations.listThreads({ workspaceId: chat.id, workspaceRoot: root }).catch(() => null)
    if (listed?.ok) for (const thread of listed.threads) agentIds.add(thread.agentId)
    for (const agentId of agentIds) transcripts.push({ workspaceRoot: root, agentId })
  }
  return { transcripts, folders: [...folders.values()] }
}

export function createSettledChatDeletion(deps: SettledChatDeletionDeps) {
  const log = deps.log ?? (() => {})

  function isWorking(workspaceId: string): boolean {
    const listed = deps.conversations.listSessions({ workspaceId })
    return listed.ok && listed.sessions.some(conversationSessionWorking)
  }

  async function worktreePlan(
    chat: ChatRecord,
    others: readonly ChatRecord[],
  ): Promise<Array<SettledChatWorktreePlan & { repoRoot: string | null }>> {
    const owned = ownedWorktreesOf(chat)
    if (owned.length === 0) return []
    const elsewhere = Boolean(chat.environment) || isWslHostId(workspaceHostIdOf(chat))
    const otherPaths = await Promise.all(others.flatMap(pathsOf).map((path) => pathSpellings(path)))
    const plans: Array<SettledChatWorktreePlan & { repoRoot: string | null }> = []
    for (const worktree of owned) {
      const base = {
        path: worktree.path,
        name: basename(worktree.path),
        branch: worktree.branch,
        repoRoot: worktree.repoRoot,
        pooled: false,
        changedPaths: null,
        unpushedCommits: null,
      }
      if (elsewhere) {
        plans.push({ ...base, fate: 'keep', keptBecause: 'other-machine' })
        continue
      }
      // Already gone (removed by hand, or reclaimed and not yet marked): nothing to take.
      if (!(await deps.worktrees.exists(worktree.path))) continue
      const spellings = await pathSpellings(worktree.path)
      if (otherPaths.some((other) => insideAny(other, spellings))) {
        plans.push({ ...base, fate: 'keep', keptBecause: 'shared' })
        continue
      }
      const pooled = await deps.worktrees.isPoolSlot(worktree.path)
      if (!pooled && !worktree.repoRoot) {
        plans.push({ ...base, fate: 'keep', keptBecause: 'not-made-here' })
        continue
      }
      const status = await deps.worktrees.inspect(worktree.path)
      if (!status) {
        plans.push({ ...base, pooled, fate: 'keep', keptBecause: 'unreadable' })
        continue
      }
      const read = {
        ...base,
        pooled,
        branch: status.branch ?? worktree.branch,
        changedPaths: status.changedPaths,
        unpushedCommits: status.unpushedCommits,
      }
      plans.push(
        status.changedPaths > 0 ? { ...read, fate: 'keep', keptBecause: 'changes' } : { ...read, fate: 'remove' },
      )
    }
    return plans
  }

  async function planOne(
    workspaceId: string,
    chats: readonly ChatRecord[],
  ): Promise<{
    plan: SettledChatDeletionPlan
    chat: ChatRecord | null
    worktrees: Array<SettledChatWorktreePlan & { repoRoot: string | null }>
  }> {
    const chat = chats.find((candidate) => candidate.id === workspaceId) ?? null
    const remoteMachine = chat?.remoteOrigin?.machineName ?? null
    const refusal = (refused: string) => ({
      plan: { workspaceId, remoteMachine, worktrees: [], refused },
      chat,
      worktrees: [],
    })
    if (!chat) return refusal('It is no longer on record.')
    if (!isSettledWorkspace(chat)) return refusal('Only a settled chat can be deleted. Settle it first.')
    if (isWorking(workspaceId)) return refusal('An agent in it is working.')
    // A paired machine's chat: its worktree is on that machine, and stays.
    if (chat.remoteOrigin) return { plan: { workspaceId, remoteMachine, worktrees: [] }, chat, worktrees: [] }
    const others = chats.filter((candidate) => candidate.id !== workspaceId)
    const worktrees = await worktreePlan(chat, others)
    return {
      plan: { workspaceId, remoteMachine, worktrees: worktrees.map(({ repoRoot: _repoRoot, ...entry }) => entry) },
      chat,
      worktrees,
    }
  }

  /** What deleting each chat would do, for the confirmation. */
  async function plan(workspaceIds: readonly string[]): Promise<SettledChatDeletionPlan[]> {
    const chats = deps.listChats()
    const plans: SettledChatDeletionPlan[] = []
    // Chats deleted together do not keep each other's worktrees.
    const deleting = new Set(workspaceIds)
    for (const workspaceId of workspaceIds) {
      const staying = chats.filter((chat) => chat.id === workspaceId || !deleting.has(chat.id))
      plans.push((await planOne(workspaceId, staying)).plan)
    }
    return plans
  }

  async function deleteOne(workspaceId: string): Promise<SettledChatDeletionOutcome> {
    const { plan: checked, chat, worktrees } = await planOne(workspaceId, deps.listChats())
    if (checked.refused || !chat) return { workspaceId, ok: false, message: checked.refused ?? 'It is gone.' }
    if (!chat.remoteOrigin) {
      const { transcripts, folders } = await transcriptsOf(chat, deps)
      for (const transcript of transcripts) {
        const deleted = await deps.conversations.deleteTranscript({ ...transcript, workspaceId })
        // Stopped before the record goes, so the chat can be deleted again once the cause is gone.
        if (!deleted.ok) return { workspaceId, ok: false, message: `Its history was not deleted: ${deleted.message}` }
      }
      for (const folder of folders) {
        try {
          await deps.removeConversationStorage(folder.root, folder.path)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { workspaceId, ok: false, message: `Its history folder was not deleted: ${message}` }
        }
      }
    }
    const removed = deps.removeChat(workspaceId)
    if (!removed.ok) return { workspaceId, ok: false, message: removed.message }
    log(
      `Deleted settled chat ${workspaceId}${chat.remoteOrigin ? ` (this computer's record of a chat on ${chat.remoteOrigin.machineName})` : ''}.`,
    )
    // The record is gone first, so nothing of the app's still counts the
    // worktree as the chat's (its transcript inside it included).
    const outcomes: SettledChatWorktreeOutcome[] = []
    for (const worktree of worktrees) {
      const base = { path: worktree.path, name: worktree.name, branch: worktree.branch }
      // A pool slot with changes is given back too: the pool holds it, with its
      // changes, for a person to commit or discard in Settings ▸ Worktrees.
      if (worktree.pooled && (worktree.fate === 'remove' || worktree.keptBecause === 'changes')) {
        const released = await deps.worktrees.releaseSlot(worktree.path)
        outcomes.push({ ...base, ...released })
        log(`Worktree ${worktree.path}: ${released.result}${released.detail ? ` (${released.detail})` : ''}.`)
        continue
      }
      if (worktree.fate === 'keep' || !worktree.repoRoot) {
        outcomes.push({ ...base, result: 'kept', detail: keptDetail(worktree) })
        continue
      }
      const gone = await deps.worktrees.removeWorktree({ repoRoot: worktree.repoRoot, path: worktree.path })
      outcomes.push(gone.ok ? { ...base, result: 'removed' } : { ...base, result: 'kept', detail: gone.message })
      log(`Worktree ${worktree.path}: ${gone.ok ? 'removed' : `kept (${gone.message})`}.`)
    }
    return { workspaceId, ok: true, worktrees: outcomes }
  }

  /** Delete each chat in turn; one that cannot be deleted does not stop the rest. */
  async function deleteChats(workspaceIds: readonly string[]): Promise<SettledChatDeletionOutcome[]> {
    const outcomes: SettledChatDeletionOutcome[] = []
    for (const workspaceId of workspaceIds) {
      try {
        outcomes.push(await deleteOne(workspaceId))
      } catch (error) {
        outcomes.push({ workspaceId, ok: false, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return outcomes
  }

  return { plan, delete: deleteChats }
}

export type SettledChatDeletion = ReturnType<typeof createSettledChatDeletion>

function keptDetail(worktree: SettledChatWorktreePlan): string {
  switch (worktree.keptBecause) {
    case 'changes':
      return 'It has uncommitted changes.'
    case 'shared':
      return 'Another chat works in it.'
    case 'not-made-here':
      return 'Studio did not make it.'
    case 'other-machine':
      return 'It is on another machine.'
    default:
      return 'Its status could not be read.'
  }
}
