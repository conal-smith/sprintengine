import type { RepositoryIdentity } from '../../../../../shared/repository-identity'
import { cliForConversationProvider } from '../../../../../shared/conversation-harness'
import {
  isMeshConversationPane,
  meshConversationPresence,
  meshConversationSessionId,
  type MeshBrowse,
  type MeshConnection,
  type MeshConversation,
  type MeshConversationAccess,
  type MeshConversationManage,
  type MeshMachineReachability,
} from '../../../../../shared/tailnet-mesh'
import type {
  ConversationWireChanges,
  ConversationWirePullRequest,
} from '../../../../../../packages/conversation-protocol/src/public'
import { classifyPullRequestUrl } from '../../../../../shared/git/pr-url'
import { pullRequestRepository, type BranchPullRequest } from '../../../../../shared/git/pull-request'
import type { Workspace, WorkspaceHighlight, WorkspaceRemoteOrigin } from '../../../types/workspace'
import { workspaceLastUserMessageAt } from '../../../utils/workspaceRecency'
import { finishedUnseen } from '../../../../../shared/workspace-lifecycle'
import type { Tone } from '../../ui'
import type { RowRecency } from '../stableRowSlices'
import { meshMachinePhase, type MeshMachinePhase } from '../../remote/machineRowModel'

// The sidebar's Remote band (remote-sessions-in-the-sidebar): the sessions
// that live on each paired machine, as rows a person can open here. DOM-free,
// so the rules — which sessions are rows, which row is already open in this
// app, when a machine may be asked — are tested without mounting the tree.
//
// Decision 1 of the epic: a remote session lives here and only here. A
// workspace with `remoteOrigin` (a chat started over there from New chat, or
// a session opened from this band) is the SAME row as the session it
// attaches to — never a second row under a local folder.

/** One machine's last read, as the hook holds it. */
export type RemoteBrowseEntry = {
  /** The newest browse that answered. Kept across a machine going quiet, so its rows stay on screen dimmed. */
  browse: MeshBrowse | null
  loading: boolean
  /** Why the newest read did not answer; null when it did. */
  error: string | null
  /** Epoch ms of the newest read that settled, or null before the first. */
  at: number | null
  /**
   * The chat conversations the machine listed on the newest read that could
   * list them; absent before one has. A pairing without conversation access,
   * or a machine that does not serve them, simply has none.
   */
  conversations?: MeshConversation[]
  /**
   * The machine advertises `conversation-lifecycle`: it owns its chats' rest
   * and read state. Absent before a list.
   */
  lifecycle?: boolean
  /** What the pairing may do with the machine's chats, as its newest list said. Absent before a list. */
  access?: MeshConversationAccess
  /**
   * The machine advertises `chat-row-menu`: its chats' Star, Highlight color,
   * Snooze and Auto-settle are written there. Absent before a list.
   */
  rowMenu?: boolean
  /** The machine advertises `chat-mark-unread`. Absent before a list. */
  markUnread?: boolean
  /** What of its chats' management the machine takes from here, as its newest list said. Absent before a list. */
  manage?: MeshConversationManage
}

/** No chat management from here: a machine before it, or a pairing that may only follow. */
export const NO_CHAT_MANAGE: MeshConversationManage = {
  rename: false,
  autoCompact: false,
  unwatchPullRequest: false,
  deleteSettled: false,
}

/** What of a machine's chats' management this pairing may ask for: what it takes, where the pairing may drive. */
export function remoteManageWritable(entry: RemoteBrowseEntry | undefined): MeshConversationManage {
  if (!entry?.manage || entry.access !== 'operate') return NO_CHAT_MANAGE
  return { ...NO_CHAT_MANAGE, ...entry.manage }
}

/**
 * Whether this pairing may write a machine's chats' row menu marks: the
 * machine takes them (`chat-row-menu`), and the pairing may drive its chats.
 */
export function remoteRowMenuWritable(entry: RemoteBrowseEntry | undefined): boolean {
  return entry?.rowMenu === true && entry.access === 'operate'
}

/** Whether this pairing may mark a machine's chats unread there (`chat-mark-unread`). */
export function remoteMarkUnreadWritable(entry: RemoteBrowseEntry | undefined): boolean {
  return entry?.markUnread === true && remoteLifecycleWritable(entry)
}

/** What a machine's row menu may do from here, for each of its chats. */
type RemoteRowWrites = { lifecycle: boolean; rowMenu: boolean; markUnread: boolean; manage: MeshConversationManage }

/**
 * Whether this pairing may write a machine's chats' rest and read state:
 * the machine keeps them, and the pairing may drive its chats. Settling one
 * and saying one is on screen need `conversation:operate` there; a pairing
 * that may only follow them would be refused every time, and a visit is
 * stamped every few seconds.
 */
export function remoteLifecycleWritable(entry: RemoteBrowseEntry | undefined): boolean {
  return entry?.lifecycle === true && entry.access === 'operate'
}

/**
 * What a remote conversation is doing, in the local rows' vocabulary (owner
 * ruling 2026-09-05: the band reuses the marks local rows already have — the
 * working mark and elapsed, the gold surface for needs-input, a quiet time
 * for idle — and invents no dot of its own).
 */
type RemoteRowActivity = 'working' | 'needs-input' | 'idle'

/** A chat on a paired machine — one AGENT, a line on its conversation's row. */
export type RemoteSessionRow = {
  key: string
  connectionId: string
  machineName: string
  sessionId: string
  /** The conversation's agent id over there. */
  remoteAgentId: string
  /**
   * The agent's own name ("Gael Corry"), or the kind when the remote has not
   * named it. This is a LINE's name, not a row's: it used to be the row title,
   * which is why the sidebar's remote rows read as a list of strangers instead
   * of a list of conversations (owner, 2026-09-11).
   */
  title: string
  /**
   * The CHAT's title, the one its own machine's sidebar shows: the list's
   * `chatTitle`, else the browse's name for its workspace, else the agent's
   * name when the machine gives neither.
   */
  chatTitle: string
  cli: string | null
  /** The remote workspace: its id, name, and folder there, and which repository that is. */
  workspaceId: string
  workspaceName: string | null
  workspaceRoot: string | null
  repository: RepositoryIdentity | null
  status: { label: string; tone: Tone }
  activity: RemoteRowActivity
  /** The phase the machine listed, which words the line: a wait for approval and a question are two waits. */
  phase: MeshConversation['phase']
  /** The opening of the agent's last reply, as its machine listed it; null from a machine that does not say. */
  replyPreview: string | null
  /** The branch the chat's folder is on over there; null from a machine that does not say, or off a branch. */
  branch: string | null
  /** The pull requests the chat opened, as its machine's record holds them, newest first. */
  pullRequests: BranchPullRequest[]
  /** The files the chat's checkout carries over there; null from a machine that does not say, or a chat at rest. */
  changes: ConversationWireChanges | null
  /** The chat works in a worktree of its project over there. */
  worktree: boolean
  /** Epoch ms the activity began — how long it has worked, or sat idle. Null when the remote did not say. */
  since: number | null
  /** The workspace here whose pane is attached to this session, when one is. */
  attachedWorkspaceId: string | null
  /**
   * Where the row sits: where its machine's own sidebar sits it
   * (`recencyAt`), which is when the person last wrote to the chat, else when
   * it was made or typed into there. A machine from before it said so gives
   * `lastUserMessageAt ?? updatedAt`. The same rule as a local row's, so a
   * remote row stays put until someone speaks.
   */
  recencyAt: number
  /** When a person last wrote to the chat, from any device, as its machine records it; null if never. */
  lastUserMessageAt: number | null
  /** When the chat's agent last finished a turn, and a person last had it on screen, on any device. */
  lastTurnEndedAt: number | null
  lastVisitedAt: number | null
  /** The schedule whose run started the chat over there, which its row marks; null for any other chat. */
  scheduledAgentId: string | null
  /** When the chat wakes, while it is snoozed over there; null from a machine that does not say, or awake. */
  snoozedUntil: number | null
  /**
   * The machine keeps this chat's rest and read state, and this pairing may
   * write them (`remoteLifecycleWritable`), so Settle may be offered for it
   * and a visit said.
   */
  lifecycle: boolean
  /** The chat's star and highlight colour, as its machine records them; null for neither. */
  highlight: WorkspaceHighlight | null
  /** Auto-settle is on for the chat over there. */
  autoSettle: boolean
  /**
   * Its machine takes the row menu's Star, Highlight color, Snooze and
   * Auto-settle from here (`remoteRowMenuWritable`).
   */
  rowMenu: boolean
  /** Its machine takes Mark unread from here (`remoteMarkUnreadWritable`). */
  markUnread: boolean
  /** What of the chat's management its machine takes from here (`remoteManageWritable`). */
  manage: MeshConversationManage
  /**
   * Whether its machine compacts the chat by itself before its cache
   * expires, by its own switch or that machine's default; null from a
   * machine that does not say.
   */
  autoCompact: boolean | null
  /** The chat is Claude's, the only one Auto compact works on yet. */
  claude: boolean
}

/** One paired machine's sub-group in the band. */
export type RemoteMachineGroup = {
  key: string
  /** Null when the pairing is gone but rows born on it remain — they still need a home. */
  connectionId: string | null
  machineName: string
  phase: MeshMachinePhase | null
  rows: RemoteSessionRow[]
  /**
   * Remote-born workspaces here whose session the machine did not list: the
   * pane closed and the session ended, or the machine is not answering and
   * has never been read. They keep their row so nothing a person made vanishes.
   */
  parked: Workspace[]
  /** The rows are from an earlier read and the machine is not answering now. */
  stale: boolean
  loading: boolean
}

/**
 * A CONVERSATION on a paired machine: one chat, and the agents in it.
 *
 * This is the unit the sidebar draws (owner, 2026-09-11): titled with its own
 * name, filed under its project like every other chat, and drawn with a line
 * per agent exactly as a local row is.
 */
export type RemoteConversation = {
  key: string
  connectionId: string
  machineName: string
  /** The chat's name over there. */
  title: string
  /** The remote workspace's id. */
  workspaceId: string
  /** The folder it stands in, on that machine's disk. */
  workspaceRoot: string | null
  repository: RepositoryIdentity | null
  /** Its agents, a line each, the one a window here follows first. Never empty. */
  agents: RemoteSessionRow[]
  /** What its agents are doing — what the row's marks report. */
  activity: RemoteRowActivity
  /** When that began, for the row's clock; null when the remote did not say. */
  since: number | null
  /** The workspace here whose pane is following it, when one is. */
  attachedWorkspaceId: string | null
  /** Read from an earlier browse on a machine that is not answering now. */
  stale: boolean
  /** Its row's place in the list; see `RemoteSessionRow.recencyAt`. */
  recencyAt: number
  /** The chat's star and highlight colour over there; null for neither. */
  highlight: WorkspaceHighlight | null
  /** When the chat wakes, while it is snoozed over there. */
  snoozedUntil: number | null
  /** Auto-settle is on for the chat over there. */
  autoSettle: boolean
  /** Its machine takes the row menu's marks from here (`RemoteSessionRow.rowMenu`). */
  rowMenu: boolean
  /** Its machine takes Mark unread from here. */
  markUnread: boolean
  /** What of the chat's management its machine takes from here (`RemoteSessionRow.manage`). */
  manage: MeshConversationManage
  /**
   * The Auto compact switch as its machine reads it, as a local chat's menu
   * draws it (`autoCompactSwitchOf`); null from a machine that does not say.
   */
  autoCompact: { on: boolean; claude: boolean } | null
}

/**
 * A listed chat's pull requests as a local line wears them. The list carries
 * a pull request's number, state, address and title; which repository it is
 * in is read off its address, as the local record reads it, and one whose
 * address names no pull request is left out rather than drawn wrong.
 */
export function branchPullRequestsOfWire(listed: readonly ConversationWirePullRequest[]): BranchPullRequest[] {
  return listed.flatMap((entry) => {
    const repository = pullRequestRepository(entry.url)
    const forge = classifyPullRequestUrl(entry.url)?.forge
    if (!repository || !forge) return []
    return [
      {
        url: entry.url,
        ...repository,
        number: entry.number,
        title: entry.title,
        state: entry.state,
        isDraft: false,
        openedAt: 0,
        stateAt: 0,
        ...(forge === 'github' ? {} : { forge }),
        // Watched there: the strip and the row say so, and offer Stop watching
        // where the machine takes it from here.
        ...(entry.watch ? { watch: { ...entry.watch } } : {}),
      },
    ]
  })
}

/**
 * The agent finished a turn nobody has had on screen since, on any device:
 * the green "finished while you were away" row a local chat wears, by the
 * rule a local row is marked by (`finishedUnseen`). Only a machine that keeps
 * its chats' read state can say so, and a chat with no visit recorded reads
 * as seen, as the list's contract has it. A chat snoozed over there is not
 * marked until it wakes, as its machine's own row is not.
 */
export function remoteFinishUnseen(
  row: Pick<RemoteSessionRow, 'activity' | 'lastTurnEndedAt' | 'lastVisitedAt'> &
    Partial<Pick<RemoteSessionRow, 'snoozedUntil'>>,
  now: number = Date.now(),
): boolean {
  if (typeof row.snoozedUntil === 'number' && row.snoozedUntil > now) return false
  return finishedUnseen({
    idle: row.activity === 'idle',
    finishedAt: row.lastTurnEndedAt,
    visitedAt: row.lastVisitedAt,
  })
}

/** What opening a row asks the app to do: focus the attached workspace, or follow the chat in a new one. */
export type RemoteSessionOpenSpec = {
  /** The chat it opens, followed in the chat view. */
  conversation: { workspaceId: string; agentId: string }
  connectionId: string
  machineName: string
  sessionId: string
  title: string
  cli: string | null
  workspaceName: string | null
  workspaceRoot: string | null
  repository: RepositoryIdentity | null
  attachedWorkspaceId: string | null
}

/** The remote sessions a workspace's layout holds panes on, read off its remote conversation tabs. */
function meshPaneSessionsOf(workspace: Workspace): Array<{ connectionId: string; remoteSessionId: string }> {
  const panes: Array<{ connectionId: string; remoteSessionId: string }> = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const record = node as { type?: unknown; component?: unknown; config?: unknown; children?: unknown }
    if (record.type === 'tab' && isMeshConversationPane(record.component)) {
      const config = record.config as { connectionId?: unknown; remoteSessionId?: unknown } | undefined
      if (typeof config?.connectionId === 'string' && typeof config.remoteSessionId === 'string') {
        panes.push({ connectionId: config.connectionId, remoteSessionId: config.remoteSessionId })
      }
    }
    if (Array.isArray(record.children)) for (const child of record.children) walk(child)
  }
  const model = workspace.layoutModel as { layout?: unknown; borders?: unknown } | undefined
  walk(model?.layout)
  if (Array.isArray(model?.borders)) for (const border of model.borders) walk(border)
  return panes
}

/**
 * The workspace here that is this remote session, if any: by the session id
 * stamped at its creation first, then by a mesh pane still in its layout
 * (rows born before the stamp existed). Two panes on one session in two
 * workspaces are two healthy attachments; the first in list order is the one
 * a click focuses.
 */
export function attachedWorkspaceFor(
  workspaces: readonly Workspace[],
  connectionId: string,
  sessionId: string,
): Workspace | null {
  for (const workspace of workspaces) {
    const origin = workspace.remoteOrigin
    if (origin && origin.connectionId === connectionId && origin.sessionId === sessionId) return workspace
  }
  for (const workspace of workspaces) {
    if (
      meshPaneSessionsOf(workspace).some(
        (pane) => pane.connectionId === connectionId && pane.remoteSessionId === sessionId,
      )
    ) {
      return workspace
    }
  }
  return null
}

/**
 * Whether a machine may be asked right now (epic decision 2): never while
 * main's last check says it is asleep or has revoked us. A machine never
 * checked gets one read — the check and the read race at mount, and waiting
 * on the check would leave the band empty on a quiet system.
 */
export function shouldBrowse(reach: MeshMachineReachability | undefined): boolean {
  if (!reach) return true
  if (reach.unauthorized) return false
  if (reach.checkedAt === null) return true
  return reach.reachable
}

/**
 * A chat conversation on a paired machine, as a row: the same marks a local
 * row wears — working while a turn runs, the needs-input surface while it
 * waits on an approval or a question — titled with the chat's own name.
 */
function remoteChatRowOf(
  connection: MeshConnection,
  conversation: MeshConversation,
  browse: MeshBrowse | null,
  workspaces: readonly Workspace[],
  writes: RemoteRowWrites,
): RemoteSessionRow {
  const remoteWorkspace = browse?.workspaces.find((workspace) => workspace.id === conversation.workspaceId) ?? null
  const sessionId = meshConversationSessionId(conversation.workspaceId, conversation.agentId)
  // Its background work counts, as the machine's own sidebar counts it: a
  // chat whose turn is over while its agents or a monitor go on is working.
  const presence = meshConversationPresence(conversation.phase, conversation.backgroundWork)
  const attached = attachedWorkspaceFor(workspaces, connection.id, sessionId)
  const title = conversation.title || 'Conversation'
  // The chat's own title over there is its workspace's name there; the list
  // says it fresher than the browse does, and a machine from before the list
  // carried it leaves the browse's.
  const workspaceName = conversation.chatTitle?.trim() || remoteWorkspace?.name || null
  return {
    key: `${connection.id}:${sessionId}`,
    connectionId: connection.id,
    machineName: connection.machineName,
    sessionId,
    remoteAgentId: conversation.agentId,
    title,
    chatTitle: workspaceName ?? title,
    cli: cliForConversationProvider(conversation.providerId),
    workspaceId: conversation.workspaceId,
    workspaceName,
    workspaceRoot: remoteWorkspace?.folderPath ?? null,
    repository: remoteWorkspace?.repository ?? null,
    status:
      presence === 'running'
        ? { label: 'Running', tone: 'accent' }
        : presence === 'needs-input'
          ? { label: 'Needs approval', tone: 'warn' }
          : conversation.phase === 'failed'
            ? { label: 'Failed', tone: 'error' }
            : { label: 'Done', tone: 'neutral' },
    activity: presence === 'running' ? 'working' : presence === 'needs-input' ? 'needs-input' : 'idle',
    phase: conversation.phase,
    replyPreview: conversation.lastAssistantText ?? null,
    branch: conversation.branch ?? null,
    pullRequests: branchPullRequestsOfWire(conversation.pullRequests ?? []),
    changes: conversation.changes ?? null,
    worktree: conversation.worktree === true,
    // A working chat counts from when its stretch of work began, the number
    // its machine's own sidebar counts from: a turn the chat opened by itself
    // does not restart it. A machine from before it said so gives the turn's
    // start; `updatedAt` also moves when an approval resolves or the model
    // changes.
    since:
      presence === 'running'
        ? (conversation.workingSince ?? conversation.turnStartedAt ?? conversation.updatedAt)
        : conversation.updatedAt,
    attachedWorkspaceId: attached?.id ?? null,
    recencyAt: conversation.recencyAt ?? conversation.lastUserMessageAt ?? conversation.updatedAt,
    lastUserMessageAt: conversation.lastUserMessageAt ?? null,
    lastTurnEndedAt: conversation.lastTurnEndedAt ?? null,
    lastVisitedAt: conversation.lastVisitedAt ?? null,
    scheduledAgentId: conversation.scheduledAgentId ?? null,
    snoozedUntil: conversation.snoozedUntil ?? null,
    lifecycle: writes.lifecycle,
    highlight: conversation.highlight
      ? { starred: conversation.highlight.starred, color: conversation.highlight.color ?? null }
      : null,
    autoSettle: conversation.autoSettle === true,
    rowMenu: writes.rowMenu,
    markUnread: writes.markUnread,
    manage: writes.manage,
    autoCompact: typeof conversation.autoCompact === 'boolean' ? conversation.autoCompact : null,
    claude: cliForConversationProvider(conversation.providerId) === 'claude-code',
  }
}

/**
 * Most recently written to first, as the local rows are (owner ruling
 * 2026-09-09: rows stay put, ordered by when I last messaged them). These
 * used to sort working first, then waiting, then idle, then by name, so a
 * remote row jumped whenever its agent started or stopped. The marks say what
 * an agent is doing; the order never does. Ties keep the order the machine
 * listed them in.
 */
function compareByRecency(a: { recencyAt: number }, b: { recencyAt: number }): number {
  return b.recencyAt - a.recencyAt
}

/**
 * Several machines' rows as one list, most recently written to first, with
 * each machine's own rows kept in the order it gave them. A machine that
 * keeps its chats' rest lists them in its sidebar's order, by a key of its
 * own (a chat never written to counts from its creation there, not from when
 * it last moved), and re-sorting them here by `recencyAt` drew them in an
 * order that machine's own sidebar does not.
 */
function mergeByRecency<T extends { recencyAt: number }>(lists: ReadonlyArray<readonly T[]>): T[] {
  const queues = lists.map((list) => ({ list, next: 0 }))
  const merged: T[] = []
  for (;;) {
    let pick: { list: readonly T[]; next: number } | null = null
    for (const queue of queues) {
      const head = queue.list[queue.next]
      // The first machine wins a tie, as a stable sort of the groups in order would.
      if (head !== undefined && (pick === null || head.recencyAt > pick.list[pick.next]!.recencyAt)) pick = queue
    }
    if (!pick) return merged
    merged.push(pick.list[pick.next]!)
    pick.next += 1
  }
}

export function openSpecOf(row: RemoteSessionRow): RemoteSessionOpenSpec {
  return {
    conversation: { workspaceId: row.workspaceId, agentId: row.remoteAgentId },
    connectionId: row.connectionId,
    machineName: row.machineName,
    sessionId: row.sessionId,
    title: row.title,
    cli: row.cli,
    workspaceName: row.workspaceName,
    workspaceRoot: row.workspaceRoot,
    repository: row.repository,
    attachedWorkspaceId: row.attachedWorkspaceId,
  }
}

const QUIET_PHASES = new Set<MeshMachinePhase['phase']>(['unreachable', 'revoked'])

/**
 * The band: one group per paired machine, in name order, plus a group for
 * any machine whose pairing is gone but whose rows are still here.
 */
export function buildRemoteBand(input: {
  connections: readonly MeshConnection[]
  browses: ReadonlyMap<string, RemoteBrowseEntry>
  reachability: ReadonlyMap<string, MeshMachineReachability>
  workspaces: readonly Workspace[]
}): RemoteMachineGroup[] {
  const { connections, browses, reachability, workspaces } = input
  const paired = new Set(connections.map((connection) => connection.id))
  const groups: RemoteMachineGroup[] = [...connections]
    .sort((a, b) => a.machineName.localeCompare(b.machineName))
    .map((connection) => {
      const entry = browses.get(connection.id)
      const browse = entry?.browse ?? null
      const phase = meshMachinePhase(connection.id, reachability)
      // A chat the machine has settled has no row, as it has none in that
      // machine's own sidebar. A machine that keeps rest leaves them out of
      // its list; one whose browse says a workspace is resting is believed
      // too, for a list read before the settle landed.
      const resting = new Set(
        (browse?.workspaces ?? [])
          .filter((workspace) => typeof workspace.settledAt === 'number')
          .map((workspace) => workspace.id),
      )
      // A machine that keeps its chats' rest lists them in its own sidebar's
      // order, which is kept; one from before that is ordered here.
      const writes: RemoteRowWrites = {
        lifecycle: remoteLifecycleWritable(entry),
        rowMenu: remoteRowMenuWritable(entry),
        markUnread: remoteMarkUnreadWritable(entry),
        manage: remoteManageWritable(entry),
      }
      const listed = (entry?.conversations ?? [])
        .filter((conversation) => !resting.has(conversation.workspaceId))
        .map((conversation) => remoteChatRowOf(connection, conversation, browse, workspaces, writes))
      const rows = entry?.lifecycle === true ? listed : listed.sort(compareByRecency)
      const attachedIds = new Set(rows.map((row) => row.attachedWorkspaceId).filter((id): id is string => id !== null))
      const parked = workspaces.filter(
        (workspace) => workspace.remoteOrigin?.connectionId === connection.id && !attachedIds.has(workspace.id),
      )
      // No notices (owner ruling 2026-09-05). A transport error, a scope
      // the pairing lacks, a revocation: none of it is a sidebar sentence.
      // The band lists conversations and nothing else; the Remote glyph
      // and Settings → Remote are where a machine's state is read.
      return {
        key: connection.id,
        connectionId: connection.id,
        machineName: connection.machineName,
        phase,
        rows,
        parked,
        stale: rows.length > 0 && QUIET_PHASES.has(phase.phase),
        loading: entry?.loading ?? false,
      }
    })

  // Rows born on a machine no longer paired here: grouped by the machine
  // their provenance names, with no phase — there is nothing to ask.
  const orphans = new Map<string, Workspace[]>()
  for (const workspace of workspaces) {
    const origin = workspace.remoteOrigin
    if (!origin || paired.has(origin.connectionId)) continue
    const list = orphans.get(origin.connectionId) ?? []
    list.push(workspace)
    orphans.set(origin.connectionId, list)
  }
  for (const [connectionId, parked] of orphans) {
    groups.push({
      key: `gone:${connectionId}`,
      connectionId: null,
      machineName: parked[0]!.remoteOrigin!.machineName,
      phase: null,
      rows: [],
      parked,
      stale: false,
      loading: false,
    })
  }
  return groups
}

/**
 * A machine's chats as conversation rows (owner, 2026-09-11): one entry per
 * chat, carrying a line per agent in it, in the order the rows sort in.
 *
 * The machine lists agents, and a chat over there is its workspace: its title,
 * its message clock and its visits are the workspace's. Two agents in one chat
 * are one row, as that machine's own sidebar draws them; a row per agent drew
 * the chat twice, and the agent a window here was not following stood beside
 * that window as a second copy of it.
 */
export function conversationsOf(group: RemoteMachineGroup): RemoteConversation[] {
  const byChat = new Map<string, RemoteSessionRow[]>()
  for (const row of group.rows) {
    const agents = byChat.get(row.workspaceId)
    if (agents) agents.push(row)
    else byChat.set(row.workspaceId, [row])
  }
  return [...byChat.values()].map((listed) => {
    // The agent a window here follows leads, so opening the chat focuses that
    // window rather than opening a second one onto the same chat.
    const agents = [
      ...listed.filter((row) => row.attachedWorkspaceId !== null),
      ...listed.filter((row) => row.attachedWorkspaceId === null),
    ]
    const lead = agents[0]!
    return {
      key: `${group.machineName}:chat:${lead.workspaceId}`,
      connectionId: lead.connectionId,
      machineName: group.machineName,
      title: lead.chatTitle,
      workspaceId: lead.workspaceId,
      workspaceRoot: lead.workspaceRoot,
      repository: lead.repository,
      agents,
      // The chat's marks say what any of its agents is doing, a wait first.
      activity: agents.some((row) => row.activity === 'needs-input')
        ? 'needs-input'
        : agents.some((row) => row.activity === 'working')
          ? 'working'
          : 'idle',
      since: lead.since,
      attachedWorkspaceId: lead.attachedWorkspaceId,
      stale: group.stale,
      recencyAt: Math.max(...agents.map((row) => row.recencyAt)),
      // The chat's own marks, which its machine keeps on the chat rather than
      // on an agent: every agent of it lists the same ones.
      highlight: lead.highlight,
      snoozedUntil: lead.snoozedUntil,
      autoSettle: lead.autoSettle,
      rowMenu: lead.rowMenu,
      markUnread: lead.markUnread,
      manage: lead.manage,
      // The switch is the chat's, kept on its record there; it works on a
      // chat any of whose agents is Claude's, as a local chat's does.
      autoCompact:
        lead.autoCompact === null ? null : { on: lead.autoCompact, claude: agents.some((row) => row.claude) },
    }
  })
}

/**
 * The remote conversations that need a row of their own: every one across
 * every machine that no window HERE is already showing, most recently written to first.
 *
 * A conversation whose session a local workspace is attached to is not in this
 * list, and must not be: that workspace is already a row of its project
 * (`remoteOrigin`), and listing it here too would be the same chat twice.
 *
 * `listening` is whether this device is on the tailnet at all. Off it, nothing
 * over there can be reached, so nothing read from over there is drawn — only
 * the rows that are windows open HERE stay, since closing those is the
 * person's call. Nothing is forgotten: the browse rows return with the link.
 */
export function unattachedConversations(
  groups: readonly RemoteMachineGroup[],
  listening: boolean,
  workspaces: readonly Workspace[],
): RemoteConversation[] {
  if (!listening) return []
  return mergeByRecency(
    groups.map((group) =>
      conversationsOf(group).filter(
        (conversation) =>
          conversation.attachedWorkspaceId === null ||
          !workspaces.some((candidate) => candidate.id === conversation.attachedWorkspaceId),
      ),
    ),
  )
}

/** One row of a list that holds both this desktop's chats and a paired machine's. */
export type ChatListEntry =
  | { kind: 'local'; workspace: Workspace; recencyAt: number }
  | { kind: 'remote'; conversation: RemoteConversation; recencyAt: number }

/**
 * When a row here was last written to, on whichever machine (owner,
 * 2026-10-09: "the most recent applies across all machines"). A chat opened
 * here from a paired machine is a `Workspace` of this desktop, and its own
 * clock only hears of the messages sent from here; one written to on the
 * machine it runs on reads that machine's clock too. Its message clock, never
 * `updatedAt`: an agent working does not move a row.
 */
export function chatRecencyOf(attached: ReadonlyMap<string, RemoteConversation>): (workspace: Workspace) => number {
  return (workspace) => {
    const agents = attached.get(workspace.id)?.agents ?? []
    // A chat opened here from a paired machine was MADE here at the click,
    // and that is not when anyone last wrote to it: it sits where its machine
    // sits it (`recencyAt`), as it did before it was opened, and moves only
    // when someone writes to it (owner ruling 2026-10-17: a remote chat is
    // ordered exactly as a local one). Only when that machine has said
    // nothing yet does the creation here stand in.
    if (workspace.remoteOrigin) {
      const remote = Math.max(workspace.lastUserMessageAt ?? 0, ...agents.map((agent) => agent.recencyAt))
      return remote > 0 ? remote : workspaceLastUserMessageAt(workspace)
    }
    return Math.max(workspaceLastUserMessageAt(workspace), ...agents.map((agent) => agent.lastUserMessageAt ?? 0))
  }
}

/**
 * The clocks a row here that is a chat on a paired machine draws: its own,
 * which only hear of what happened here, and its machine's, which hear of
 * everything. Without the machine's, an opened remote chat had no idle time
 * at all, since its agent's turns end over there.
 */
export function remoteRowRecency(local: RowRecency | undefined, conversation: RemoteConversation): RowRecency {
  const agents = conversation.agents
  const latest = (values: Array<number | null | undefined>): number | null => {
    const known = values.filter((value): value is number => typeof value === 'number' && value > 0)
    return known.length > 0 ? Math.max(...known) : null
  }
  const working = conversation.activity === 'working'
  const workingAgents = agents.filter((agent) => agent.activity === 'working')
  return {
    hasRunning: (local?.hasRunning ?? false) || working,
    idleSince: working
      ? (local?.idleSince ?? null)
      : latest([local?.idleSince, ...agents.map((agent) => agent.lastTurnEndedAt ?? agent.since)]),
    lastInputAt: latest([local?.lastInputAt, ...agents.map((agent) => agent.lastUserMessageAt)]),
    workingSince:
      local?.workingSince ??
      (working
        ? workingAgents.reduce<number | null>(
            (earliest, agent) => (agent.since === null ? earliest : Math.min(earliest ?? agent.since, agent.since)),
            null,
          )
        : null),
  }
}

/** Rows here, most recently written to first by `recencyOf`; ties keep the order they came in. */
export function sortChatsByRecency(
  workspaces: readonly Workspace[],
  recencyOf: (workspace: Workspace) => number = workspaceLastUserMessageAt,
): Workspace[] {
  return [...workspaces].sort((a, b) => recencyOf(b) - recencyOf(a))
}

/**
 * This desktop's rows and the paired machines' as one list, most recently
 * written to first, whichever machine each runs on (owner, 2026-10-09: a chat
 * I just wrote to on the Mini sat under a local one two days quiet). Each
 * machine's rows keep the order it gave them, and a tie goes to the local row.
 * They used to follow every local row, for fear a machine's clock a few
 * minutes off would shuffle them; it sank the chats the person was working in
 * instead.
 */
export function interleaveChats(
  local: readonly Workspace[],
  remote: readonly RemoteConversation[],
  recencyOf: (workspace: Workspace) => number = workspaceLastUserMessageAt,
): ChatListEntry[] {
  return mergeByRecency<ChatListEntry>([
    sortChatsByRecency(local, recencyOf).map((workspace) => ({
      kind: 'local',
      workspace,
      recencyAt: recencyOf(workspace),
    })),
    remote.map((conversation) => ({ kind: 'remote', conversation, recencyAt: conversation.recencyAt })),
  ])
}

/** What opening a conversation attaches to: its loudest agent — the one you came for. */
export function openSpecOfConversation(conversation: RemoteConversation): RemoteSessionOpenSpec {
  return openSpecOf(conversation.agents[0]!)
}

/**
 * What a chat opened from — or started on — a paired machine is CALLED here.
 *
 * The remote chat's own name, and the lone agent's only when the remote had no
 * name to give (owner, 2026-09-13: "we shouldn't show 'Tara Boyle · xxx' — the
 * agent name shouldn't be there, it is not relevant"). It used to be
 * `${agentName} · ${chatName}`, which put a stranger's name in front of every
 * remote row and made a list of chats read as a list of people — the same
 * mistake the band's own rows made until `conversationsOf` stopped titling a
 * conversation with its loudest agent. One rule, both paths.
 */
export function remoteWorkspaceName(agentTitle: string, remoteChatName: string | null | undefined): string {
  return remoteChatName?.trim() || agentTitle
}

/**
 * The id of the chat a remote-born row is, on its machine. Read off the
 * session id the row was stamped with, which names the chat itself: rows
 * started from New chat were stored with the PROJECT's workspace there in
 * `workspaceId` (the chat the project picker was seated on), so a settle, a
 * visit or a bring-back asked about that chat instead, and the row followed
 * that chat's settle off the sidebar while its own chat ran on.
 */
export function remoteOriginChatWorkspaceId(origin: Pick<WorkspaceRemoteOrigin, 'workspaceId' | 'sessionId'>): string {
  const match = origin.sessionId ? /^conversation:(.+):[^:]+$/.exec(origin.sessionId) : null
  return match?.[1] ?? origin.workspaceId
}

/**
 * The name a remote pane's tab shows: its agent's, and nothing else (owner,
 * 2026-10-08, REVERSING the machine-in-the-name rule: "all we need to show here
 * is in the tab the name of the agent, and then the computer icon to show that
 * it is a remote"). The tab's machine mark, in that machine's colour and named
 * on hover, is what says where it runs.
 *
 * A pane opened under the old rule was saved as `${title} · ${machineName}`,
 * and its tab drops the machine when it is drawn, so the fix reaches the tabs
 * people already have rather than only the next one opened.
 */
export function remotePaneTabLabel(name: string, machineName: string | null | undefined): string {
  const suffix = machineName ? ` · ${machineName}` : null
  return suffix && name.endsWith(suffix) && name.length > suffix.length ? name.slice(0, -suffix.length) : name
}

/**
 * A remote-born row's title, for rows that already exist.
 *
 * `workspace.name` is the answer, except for the rows minted under the old
 * `${agentName} · ${chatName}` rule: those are already in people's stores and
 * would keep reading as strangers forever. A name that ends in exactly its own
 * provenance's chat name, with something in front of it, IS one of those, and
 * the chat name is what it should have been called. A person who renamed the
 * row themselves keeps their name — unless they happened to type that exact
 * shape, in which case they get the chat's name, which is not a bad one.
 */
export function remoteConversationTitle(
  workspace: Pick<Workspace, 'name' | 'remoteOrigin'>,
  listedTitle?: string | null,
): string {
  const chatName = workspace.remoteOrigin?.workspaceName?.trim()
  // A row still named what it was born as follows the chat's title over
  // there, as a local chat's row follows its own: the machine names a new
  // chat once its first turn has been read, and a rename there reaches here.
  // A row renamed here keeps the person's name.
  const listed = listedTitle?.trim()
  if (listed && workspace.name.trim() === (chatName ?? '')) return listed
  if (!chatName) return workspace.name
  const suffix = ` · ${chatName}`
  if (workspace.name.length > suffix.length && workspace.name.endsWith(suffix)) return chatName
  return workspace.name
}

/**
 * Whether THIS device is on the tailnet, as the sidebar must answer it.
 *
 * Three answers rather than two, because "we have not been told" is a real
 * state and must not read as "disconnected": a host without the tailnet bridge
 * (a narrower preload, a partial test harness) and the moment before the first
 * status read both have `status === null`, and hiding every remote row on
 * those would empty the sidebar of chats that are perfectly fine.
 *
 * `tailnetAddress` is the signal rather than `running`, which is the INBOUND
 * listener's state: a person can drive paired machines with Remote turned off
 * here — the listener is what lets other machines drive THIS one — so a
 * listener that is down says nothing about whether the mesh can be reached.
 * The address is read off Tailscale's own interface (`resolveTailnetInterface`,
 * which tells it apart from a WARP or other VPN tunnel in the same 100.64/10
 * range), and that interface holds one only while Tailscale is up, which is
 * exactly the question.
 */
export type RemoteLinkState = 'unknown' | 'up' | 'down'

export function remoteLinkStateOf(status: { tailnetAddress: string | null } | null | undefined): RemoteLinkState {
  if (!status) return 'unknown'
  return status.tailnetAddress === null ? 'down' : 'up'
}

/**
 * The conversation each OPEN remote row is, keyed by the workspace here that
 * holds it (owner, 2026-09-13).
 *
 * The complement of {@link unattachedConversations}: that one lists the
 * conversations no window here holds, this one names the ones that ARE windows
 * here. A remote-born workspace's own layout knows about exactly one session —
 * the pane it attached — so left to itself its row draws one inert line for a
 * chat that may have nine agents standing in it. The browse already read all
 * nine; this is how the row gets to draw them, the way a local chat running
 * three terminals draws three lines.
 */
export function attachedConversations(
  groups: readonly RemoteMachineGroup[],
  workspaces: readonly Workspace[],
): ReadonlyMap<string, RemoteConversation> {
  // Remote-BORN rows only. A local project's workspace can hold a mesh pane
  // too — someone opened a conversation from another machine inside the chat
  // they were working in — and `attachedWorkspaceFor` matches it, because for the
  // band's purposes it genuinely is the window showing that session. It is not
  // a remote conversation, though: it is a local chat with a visitor in it, and
  // handing this map its id would replace its own agents' lines with the other
  // machine's.
  const remoteBorn = new Set(workspaces.filter((workspace) => workspace.remoteOrigin).map((workspace) => workspace.id))
  const byWorkspace = new Map<string, RemoteConversation>()
  for (const group of groups) {
    for (const conversation of conversationsOf(group)) {
      const id = conversation.attachedWorkspaceId
      if (id && remoteBorn.has(id)) byWorkspace.set(id, conversation)
    }
  }
  return byWorkspace
}

/**
 * The rows here, opened from a paired machine's chats, whose chat that
 * machine has since settled — on the phone, on that machine, or from another
 * desktop — and the settle each would follow; and the rows resting because
 * they followed one, whose chat that machine has since brought back.
 *
 * A row here is a window onto the chat, and a chat that has come to rest over
 * there has nothing left to show; left alone it stays on the rail as a pane
 * onto a chat its own machine no longer lists. Read from the machine's browse
 * (`settledAt` on its workspace), and only from a machine that keeps its
 * chats' rest. `followed` holds the settle each row last followed, so one is
 * followed once: a person who brings the row back here keeps it until the
 * machine settles the chat again. It is kept across a restart
 * (`readFollowedRemoteRests`), or the first browse after one would settle
 * every such row again.
 */
export function remoteRestToFollow(input: {
  workspaces: readonly Workspace[]
  browses: ReadonlyMap<string, RemoteBrowseEntry>
  followed: ReadonlyMap<string, number>
}): Array<{ workspaceId: string; settledAt: number; settled: boolean }> {
  const due: Array<{ workspaceId: string; settledAt: number; settled: boolean }> = []
  for (const workspace of input.workspaces) {
    const origin = workspace.remoteOrigin
    if (!origin) continue
    const entry = input.browses.get(origin.connectionId)
    if (entry?.lifecycle !== true || !entry.browse) continue
    const chatWorkspaceId = remoteOriginChatWorkspaceId(origin)
    const remote = entry.browse.workspaces.find((candidate) => candidate.id === chatWorkspaceId)
    if (!remote) continue
    if (typeof remote.settledAt === 'number') {
      if (input.followed.get(workspace.id) === remote.settledAt) continue
      due.push({ workspaceId: workspace.id, settledAt: remote.settledAt, settled: true })
      continue
    }
    // Brought back over there (owner ruling 2026-10-17: a chat's rest is the
    // same on every device): a row here that rests because it followed that
    // machine's settle comes back with it. One a person settled here, which
    // the machine was asked to settle too, is not this row's to undo unless
    // the machine has since said the chat is back.
    const followedAt = input.followed.get(workspace.id)
    if (followedAt !== undefined) due.push({ workspaceId: workspace.id, settledAt: followedAt, settled: false })
  }
  return due
}

/** Where the settles the rows here have followed are kept, so a restart does not follow one again. */
export const FOLLOWED_REMOTE_RESTS_KEY = 'sprintengine.remote.followedRests'

/** The followed settles as they were kept; anything unreadable is read as none. */
export function readFollowedRemoteRests(raw: string | null): Map<string, number> {
  const followed = new Map<string, number>()
  if (!raw) return followed
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return followed
    for (const [workspaceId, settledAt] of Object.entries(parsed))
      if (typeof settledAt === 'number' && Number.isFinite(settledAt)) followed.set(workspaceId, settledAt)
  } catch {
    // Unreadable: nothing was followed, which costs at most one settle followed again.
  }
  return followed
}

/** The followed settles to keep: only those of rows still here, so a closed row's entry goes with it. */
export function followedRemoteRestsToKeep(
  followed: ReadonlyMap<string, number>,
  workspaces: readonly Pick<Workspace, 'id' | 'remoteOrigin'>[],
): string {
  const kept: Record<string, number> = {}
  for (const workspace of workspaces) {
    const settledAt = followed.get(workspace.id)
    if (workspace.remoteOrigin && settledAt !== undefined) kept[workspace.id] = settledAt
  }
  return JSON.stringify(kept)
}

// ── A paired machine's chat's row menu marks ─────────────────────────────
//
// Its star, colour, sleep and Auto-settle are kept by the machine it runs on
// (`chat-row-menu`), and read back off that machine's list. A change asked
// from here is drawn at once, as a local Star flips at once, and held until a
// list read after the machine took it says the same thing for itself.

/** The marks a chat's row wears from its machine's list. */
export type RemoteChatMarks = Pick<RemoteSessionRow, 'highlight' | 'snoozedUntil' | 'autoSettle'>

/** What a change asked of a paired machine draws at once: its marks, or its name (`chat-rename`). */
export type RemoteChatPending = Partial<RemoteChatMarks & Pick<RemoteSessionRow, 'chatTitle' | 'autoCompact'>>

/** A change asked of a paired machine and not yet read back off its list. */
export type PendingRemoteMarks = {
  connectionId: string
  /** The chat's id on that machine. */
  workspaceId: string
  marks: RemoteChatPending
  /** When the machine said it took them; null while it has not answered. */
  takenAt: number | null
}

/** The key a chat's pending marks are held under. */
export function remoteChatKey(connectionId: string, workspaceId: string): string {
  return `${connectionId}:${workspaceId}`
}

/** Each machine's rows, wearing the marks asked of it that its list does not say yet. */
export function withPendingRemoteMarks(
  groups: RemoteMachineGroup[],
  pending: ReadonlyMap<string, PendingRemoteMarks>,
): RemoteMachineGroup[] {
  if (pending.size === 0) return groups
  return groups.map((group) => {
    if (!group.connectionId || !group.rows.some((row) => pending.has(remoteChatKey(row.connectionId, row.workspaceId))))
      return group
    return {
      ...group,
      rows: group.rows.map((row) => {
        const asked = pending.get(remoteChatKey(row.connectionId, row.workspaceId))
        return asked ? { ...row, ...asked.marks } : row
      }),
    }
  })
}

/** Whether a list read since the machine took the change has come in, so the list says it now. */
export function pendingRemoteMarksRead(
  pending: PendingRemoteMarks,
  browses: ReadonlyMap<string, RemoteBrowseEntry>,
): boolean {
  if (pending.takenAt === null) return false
  const at = browses.get(pending.connectionId)?.at ?? null
  return at !== null && at > pending.takenAt
}

/** The highlight a chat would have after a Star or colour change: none when neither is left. */
export function remoteHighlightAfter(
  current: WorkspaceHighlight | null,
  change: { starred?: boolean; color?: WorkspaceHighlight['color'] },
): WorkspaceHighlight | null {
  const starred = change.starred ?? current?.starred === true
  const color = change.color === undefined ? (current?.color ?? null) : change.color
  return starred || color ? { starred, color } : null
}

/** Whether a sleeping chat over there is asleep still, as its machine's own row reads one. */
export function remoteConversationAsleep(conversation: Pick<RemoteConversation, 'snoozedUntil'>, now: number): boolean {
  return typeof conversation.snoozedUntil === 'number' && conversation.snoozedUntil > now
}

/** Whether two readings of a chat carry the same marks for a row opened here. */
export function sameRemoteChatMarks(
  a: Pick<RemoteConversation, 'rowMenu' | 'highlight' | 'snoozedUntil' | 'autoSettle' | 'title' | 'manage'>,
  b: Pick<RemoteConversation, 'rowMenu' | 'highlight' | 'snoozedUntil' | 'autoSettle' | 'title' | 'manage'>,
): boolean {
  return (
    a.manage?.rename === b.manage?.rename &&
    (!a.manage?.rename || a.title === b.title) &&
    a.rowMenu === b.rowMenu &&
    a.snoozedUntil === b.snoozedUntil &&
    a.autoSettle === b.autoSettle &&
    (a.highlight?.starred ?? false) === (b.highlight?.starred ?? false) &&
    (a.highlight?.color ?? null) === (b.highlight?.color ?? null)
  )
}

/**
 * A row opened here from a paired machine's chat, wearing the marks that
 * machine keeps for it, when it keeps them (`rowMenu`): its star, colour,
 * sleep and Auto-settle are the chat's there, not this row's. A row from a
 * machine that does not keep them is its own record, as before.
 */
export function withRemoteChatMarks(workspace: Workspace, conversation: RemoteConversation): Workspace {
  const named = withRemoteChatName(workspace, conversation)
  if (!conversation.rowMenu) return named
  workspace = named
  const highlight = conversation.highlight ?? undefined
  const autoSettleEnabled = conversation.autoSettle ? true : null
  const same =
    (workspace.highlight?.starred ?? false) === (highlight?.starred ?? false) &&
    (workspace.highlight?.color ?? null) === (highlight?.color ?? null) &&
    (workspace.snoozedUntil ?? null) === conversation.snoozedUntil &&
    (workspace.autoSettleEnabled === true) === conversation.autoSettle
  if (same) return workspace
  return { ...workspace, highlight, snoozedUntil: conversation.snoozedUntil, autoSettleEnabled }
}

/**
 * The pull request a paired machine watches for one of the chat's agents, and
 * that agent, where the machine takes Stop watching from here
 * (`chat-unwatch-pull-request`); null for none. An open one on GitHub, as a
 * local chat's watch is.
 */
export function remoteWatchedPullRequest(
  conversation: Pick<RemoteConversation, 'manage' | 'agents'>,
): { agentId: string; url: string; number: number } | null {
  if (!conversation.manage?.unwatchPullRequest) return null
  for (const row of conversation.agents) {
    const pr = row.pullRequests.find((candidate) => candidate.watch && candidate.state === 'open' && !candidate.forge)
    if (pr) return { agentId: row.remoteAgentId, url: pr.url, number: pr.number }
  }
  return null
}

/**
 * A row opened here from a paired machine's chat, named as that machine
 * names the chat, where the machine keeps the name for every device
 * (`chat-rename`): a rename from any of them is the row's name here too. A
 * row from a machine that does not keep it is named here, as before.
 */
export function withRemoteChatName(workspace: Workspace, conversation: RemoteConversation): Workspace {
  if (!conversation.manage?.rename || !conversation.title.trim() || workspace.name === conversation.title)
    return workspace
  return { ...workspace, name: conversation.title }
}

/**
 * Whether a paired machine's chat has something for Mark unread to mark: its
 * machine takes it from here, an agent there has finished a turn, and the row
 * is not already marked finished-unseen.
 */
export function canMarkRemoteConversationUnread(
  conversation: Pick<RemoteConversation, 'markUnread' | 'agents'>,
  now: number = Date.now(),
): boolean {
  if (!conversation.markUnread) return false
  if (conversation.agents.some((row) => remoteFinishUnseen(row, now))) return false
  return conversation.agents.some((row) => row.lastTurnEndedAt !== null)
}

/** Where a paired machine's chat opens when its menu moves it: a window of its own, or the main one. */
export type RemoteWindowPlace = 'new-window' | 'main-window'
