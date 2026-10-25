// The machine each chat runs on, and the pull requests it opened, as
// the tailnet lane's conversation list names them to a paired phone.
//
// Both are read from what this desktop already holds: the workspace record
// says which machine a chat runs on, the launch settings hold the person's
// kind and colour for it (Settings › Machines), and the pull request record
// holds what `gh` last answered. Nothing here asks a machine or GitHub
// anything, so a phone refreshing its list costs no process and no request.
//
// The branch each chat's folder is on is read from the checkout's HEAD file
// (`resolveCheckoutForCwd`), which remembers its answer against that file: a
// folder's first list runs one git to find where its HEAD lives, and every
// list after that only looks at the file.
//
// The local servers a chat's agents linked come from the local server record,
// with the state its own checks last found; listing them checks nothing.
//
// The files a live chat's checkout carries are the one count that runs git:
// they come from the shared change-summary reading the sidebar's own lines
// take, which holds each checkout's answer for a few seconds and queues its
// reads, and only a chat with a live session is counted, as the sidebar
// draws a line only for one.

import {
  CONVERSATION_MAX_LOCAL_SERVERS,
  CONVERSATION_MAX_PULL_REQUESTS,
  type ConversationThread,
  type ConversationWireChanges,
  type ConversationWireHost,
  type ConversationWireLocalServer,
  type ConversationWirePullRequest,
} from '../../../../packages/conversation-protocol/src/serverFrames'
import type { WorkspaceChangeSummary } from '../../../shared/ipc/git'
import type { StudioPullRequest } from '../../../../packages/studio-protocol/src/pull-requests'
import type { StudioLocalServer } from '../../../../packages/studio-protocol/src/local-servers'
import { mapWithLimit } from '../../../shared/concurrency'
import { executionHostLabel, isWslHostId, LOCAL_HOST_ID, workspaceHostIdOf } from '../../../shared/execution-host'
import {
  LOCAL_MACHINE_MARK_ID,
  resolveLocalMachineIdentity,
  resolveMachineIdentity,
  shortHostName,
  type MachineMarkSettings,
  type MachineRef,
} from '../../../shared/machine-identity'

/** This desktop as the identity endpoint names it to a paired device: its kind and colour. */
export type TailnetSelfMachine = { kind: string; color: string }

/** What a workspace record says about the machine its chats run on. */
export type ConversationMachineRecord = {
  hostId?: string | null
  folderPath?: string | null
  environment?: { kind: 'ssh'; id: string; label: string } | null
  remoteOrigin?: { machineName: string } | null
}

export type ConversationMachineContext = {
  /** This machine's host name: its default kind and colour, and its label. */
  hostName: string
  /** `process.platform`: only Windows runs chats in a WSL distribution. */
  platform: string
  /** The person's kinds and colours, by machine id (`AgentLaunchSettings.machineMarks`). */
  marks: MachineMarkSettings | null | undefined
  /**
   * An SSH machine by its saved id: the host its SSH config resolves to (else
   * what was typed) and the resolved port, as Settings › Machines keys its
   * mark (`sshMachineRef`). Null when this process does not hold the SSH
   * machines.
   */
  sshMachineOf?: (savedId: string) => { host: string; port?: number | null } | null
}

/** This desktop's own kind and colour, as the identity endpoint sends them. */
export function tailnetSelfMachine(
  context: Pick<ConversationMachineContext, 'hostName' | 'marks'>,
): TailnetSelfMachine {
  const self = resolveLocalMachineIdentity(context.hostName, context.marks)
  return { kind: self.kind, color: self.colour }
}

/**
 * The machine a workspace's chats run on, for its rows in the list. `local`
 * for this machine, so a phone can tell it apart and draw no mark for it.
 * Null when the machine cannot be named yet (an SSH machine this process does
 * not hold): the row then carries no `host`, as from an older desktop, rather
 * than a colour that would change once the machine is known.
 */
export function conversationHostOf(
  workspace: ConversationMachineRecord | null | undefined,
  context: ConversationMachineContext,
): ConversationWireHost | null {
  const local = (): ConversationWireHost => {
    const self = tailnetSelfMachine(context)
    const label = shortHostName(context.hostName) || executionHostLabel(LOCAL_HOST_ID, context.platform)
    return { id: LOCAL_MACHINE_MARK_ID, kind: self.kind, label, color: self.color }
  }
  if (!workspace) return local()
  const marked = (ref: MachineRef, label: string): ConversationWireHost | null => {
    const identity = resolveMachineIdentity(ref, context.marks)
    return identity ? { id: identity.id, kind: identity.kind, label, color: identity.colour } : null
  }
  if (workspace.environment?.kind === 'ssh') {
    const ssh = context.sshMachineOf?.(workspace.environment.id)
    const host = ssh?.host.trim()
    return host ? marked({ kind: 'ssh', host, port: ssh?.port ?? null }, workspace.environment.label || host) : null
  }
  if (workspace.remoteOrigin?.machineName) {
    const name = workspace.remoteOrigin.machineName
    return marked({ kind: 'paired', name }, name)
  }
  if (context.platform === 'win32') {
    const hostId = workspaceHostIdOf(workspace)
    if (isWslHostId(hostId))
      return marked({ kind: 'wsl', hostId }, executionHostLabel(hostId, context.platform)) ?? local()
  }
  return local()
}

/** How many folders' checkouts a list reads at once. */
const BRANCH_READS_AT_ONCE = 4

/**
 * The branch each workspace's folder is checked out on, for the workspaces a
 * list names: what this desktop's own sidebar draws on a chat's line. A
 * workspace with no folder here, a folder that is not a repository, a
 * detached HEAD, and a read that fails are each left out, and the chat is
 * listed without a branch, as from a desktop that never named one.
 */
export async function conversationBranchesOf(
  workspaceIds: readonly string[],
  folderOf: (workspaceId: string) => string | null,
  resolve: (cwd: string) => Promise<{ branch: string | null } | null>,
): Promise<Map<string, string>> {
  const read = await mapWithLimit(workspaceIds, BRANCH_READS_AT_ONCE, async (workspaceId) => {
    const folder = folderOf(workspaceId)
    if (!folder) return null
    const facts = await resolve(folder).catch(() => null)
    return facts?.branch ? ([workspaceId, facts.branch] as const) : null
  })
  return new Map(read.filter((entry): entry is readonly [string, string] => entry !== null))
}

/** The record's pull requests in the list's shape, at most `CONVERSATION_MAX_PULL_REQUESTS`. */
export function conversationPullRequestsOf(found: readonly StudioPullRequest[]): ConversationWirePullRequest[] {
  return found.slice(0, CONVERSATION_MAX_PULL_REQUESTS).map((entry) => ({
    number: entry.number,
    state: entry.state,
    url: entry.url,
    title: entry.title,
  }))
}

/**
 * The record's local servers in the list's shape, at most
 * `CONVERSATION_MAX_LOCAL_SERVERS`: what a paired machine's strip draws and
 * opens, never the command that starts one or the folder it runs in.
 */
export function conversationLocalServersOf(found: readonly StudioLocalServer[]): ConversationWireLocalServer[] {
  return found.slice(0, CONVERSATION_MAX_LOCAL_SERVERS).map((server) => ({
    id: server.id,
    url: server.url,
    title: server.title,
    port: server.port,
    state: server.state,
  }))
}

/** How many chats' checkouts a list counts at once; the shared reading queues its own git reads too. */
const CHANGE_READS_AT_ONCE = 4

/** The files a change summary counts, as a listed chat carries them; null when git could not split them. */
export function conversationChangesOf(summary: WorkspaceChangeSummary): ConversationWireChanges | null {
  if (!summary.files) return null
  const uncommitted = summary.uncommitted?.files
  return { ...summary.files, scope: summary.scope, ...(uncommitted ? { uncommitted: { ...uncommitted } } : {}) }
}

/**
 * Where each listed chat works: in a worktree of its project or not, and,
 * for a chat with a live session, the files its checkout carries, as this
 * desktop's sidebar line and composer strip count them. `checkoutOf` names
 * the chat's working folder on this disk (null for one on another machine,
 * or with no folder) and whether it is a worktree. A count that cannot be
 * read is left out rather than listed as a zero.
 */
export async function conversationCheckoutsOf(
  keys: ReadonlyArray<{ workspaceId: string; agentId: string; live: boolean }>,
  checkoutOf: (key: { workspaceId: string; agentId: string }) => { path: string; worktree: boolean } | null,
  summarize: (checkoutPath: string) => Promise<WorkspaceChangeSummary>,
): Promise<Map<string, Pick<ConversationThread, 'changes' | 'worktree'>>> {
  const read = await mapWithLimit(keys, CHANGE_READS_AT_ONCE, async (key) => {
    const checkout = checkoutOf(key)
    if (!checkout) return null
    const summary = key.live ? await summarize(checkout.path).catch(() => null) : null
    const changes = summary ? conversationChangesOf(summary) : null
    const entry = { ...(changes ? { changes } : {}), ...(checkout.worktree ? { worktree: true } : {}) }
    return Object.keys(entry).length > 0 ? ([`${key.workspaceId}:${key.agentId}`, entry] as const) : null
  })
  return new Map(read.filter((entry): entry is NonNullable<typeof entry> => entry !== null))
}
