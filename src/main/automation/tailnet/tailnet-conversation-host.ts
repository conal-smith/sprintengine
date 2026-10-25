import {
  CONVERSATION_DEFAULT_MODEL_ID,
  CONVERSATION_MAX_FILE_SEARCH_RESULTS,
  CONVERSATION_MAX_REPLY_PREVIEW,
  parseConversationCommandsAnswer,
  parseConversationWireHighlight,
  type ConversationCommand,
  type ConversationForkCommand,
  type ConversationCommandsAnswer,
  type ConversationFileSearchAnswer,
  type ConversationFileSearchEntry,
  type ConversationQueuedMessage,
  type ConversationScheduledMessage,
  type ConversationThread,
  type ConversationUsageLimitResumeAction,
  type ConversationUsageLimitsFrame,
  type ConversationWireErrorCode,
  type ConversationWireHost,
  type ConversationWirePullRequest,
  type ConversationWireLocalServer,
  type ConversationWireModels,
  type ConversationWireMcpServerAction,
  isStaleConversationSend,
} from '../../../../packages/conversation-protocol/src/public'
import { isPlaceholderAgentName } from '../../../shared/agent-names'
import { backgroundTasksWakeAgent } from '../../../shared/conversation/backgroundTasks'
import {
  conversationPhaseWorking,
  conversationSummaryPhase,
  conversationTurnInProgress,
} from '../../../shared/conversation/phase'
import { isSettledWorkspace, workspaceLastUserMessageAt } from '../../../shared/workspace-lifecycle'
import type {
  ConversationContextBreakdownResult,
  ConversationKey,
  ConversationImageAttachment,
  ConversationMessageOrigin,
  ConversationPermissionPreset,
  ConversationSessionActionResult,
  ConversationSessionFrame,
  ConversationSessionSummary,
  ConversationSideQuestionExchange,
  ConversationSideQuestionResult,
  ConversationSubscribeInput,
} from '../../../shared/conversation-runtime'
import type { ConversationBackend } from '../../../server/core/conversation-backend'
import type { ConversationModelCatalog } from '../../conversation-model-catalog'
import { ConversationSessionApi } from '../../conversation-session-api'
import { latestTurnEnd } from '../conversation-lifecycle'
import { randomUUID } from 'node:crypto'
import { DEFAULT_AGENT_SPAWN_PERMISSION_PRESET } from '../../../shared/launch-settings'
import { parseCliPermissionModeId } from '../../../shared/cli-permission-mode'
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path'
import { stat } from 'node:fs/promises'
import type { ConversationAttachedFile } from '../../../shared/conversation/attachedFiles'
import type { ConversationCommandCatalog } from '../../../shared/conversation/commands'
import { cliForConversationProvider } from '../../../shared/conversation-harness'
import type { FileSearchResult } from '../../../shared/ipc/filesystem'
import { openConfinedExistingFile } from '../../conversation-file-access'
import { confineToRoots } from '../../studio-rpc/studio-file-confinement'
import { distroOfUncPath } from '../../../shared/host-paths'
import {
  conversationImageFileOf,
  conversationImagePathOf,
  sniffConversationImage,
  type ConversationImageMediaType,
} from './tailnet-conversation-images'
import { ConversationAttachmentStore } from '../../conversation-attachment-store'
import {
  ATTACHABLE_IMAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_TURN,
} from '../../../shared/conversation-attachments'

const UPLOAD_TTL_MS = 60 * 60_000
const MAX_UPLOAD_REFS = 256
const MAX_DEVICE_UPLOAD_REFS = 32
const MAX_SPENT_UPLOAD_REFS = 256
// Rewinds, confirmed reverts and handoffs remembered by the device's command,
// so one sent again after a dropped connection is answered as the first was.
const MAX_COMMAND_RECEIPTS = 64
// Forks remembered by the device's command, so one sent again after a dropped
// connection is answered as the first was rather than refused as taken.
const MAX_FORK_RECEIPTS = 64
// A fork's id names its transcript's folder: letters, digits, `.`, `_`, `-`.
const FORK_AGENT_ID = /^[A-Za-z0-9][\w.-]{0,199}$/u
// Restarts remembered by the device's command, so one sent again after a
// dropped connection is answered as the first was.
const MAX_RESTART_RECEIPTS = 64
/**
 * Where a step's picture is, once found, is kept this long and for this many
 * steps. Finding it scans the transcript back to the step, and a phone
 * scrolling a chat, or a second paired machine, asks for the same pictures
 * again. Kept for minutes, not for good: a step can be announced again with
 * a different path, and a picture's last announcement is the one that
 * stands. A step that names no picture yet is not kept at all.
 */
const IMAGE_PATH_TTL_MS = 10 * 60_000
const MAX_IMAGE_PATHS = 256
const wireCapabilities = (capabilities: ConversationSessionSummary['capabilities'] | undefined) =>
  capabilities
    ? {
        images: capabilities.images,
        approvals: capabilities.approvals,
        questions: capabilities.questions,
        planMode: capabilities.planMode,
        interrupt: capabilities.interrupt,
        checkpoints: capabilities.checkpoints === true,
        ...(capabilities.permissionPresets ? { permissionPresets: [...capabilities.permissionPresets] } : {}),
        ...(capabilities.permissionModes ? { permissionModes: [...capabilities.permissionModes] } : {}),
        // Whether a `send` that says `steer` can go into the turn now running
        // (`conversation-steer-sends`); a client offers Steer only where it can.
        steer: capabilities.steer === true,
        // Whether one agent the chat spawned can be stopped by itself
        // (`conversation-stop-subagent`); a client offers an agent's Stop only
        // where it can.
        stopSubagent: capabilities.stopSubagent === true,
        // Whether the chat can be handed off to a fresh session
        // (`conversation-handoff`); a client offers Handoff only where it can.
        handoff: capabilities.handoff === true,
        // Whether the chat can go back to before one of its messages
        // (`conversation-rewind`); a client offers Edit from here only where
        // it can.
        rewind: capabilities.rewind === true,
        // Whether the chat can be forked (`conversation-fork`), a side question
        // asked of it (`conversation-side-questions`), and its agent asked what
        // fills its window (`conversation-context-breakdown`); a client offers
        // each only where it can.
        fork: capabilities.fork === true,
        sideQuestion: capabilities.sideQuestion === true,
        contextBreakdown: capabilities.contextBreakdown === true,
        // The effort levels the chat's provider runs, none for one that runs
        // none (`conversation-reasoning-effort`); a client offers its effort
        // control only where there are some.
        reasoningEfforts: [...(capabilities.reasoningEfforts ?? [])],
        // What a device may do to the chat's servers while it runs
        // (`conversation-mcp-server-actions`). Not a sign-in: the CLI waits
        // for its callback on this machine, where no device could finish it.
        mcpServerActions: (capabilities.mcpServerActions ?? []).filter(
          (action): action is ConversationWireMcpServerAction => action !== 'sign-in',
        ),
      }
    : undefined

const capabilitiesOf = (capabilities: ConversationSessionSummary['capabilities'] | undefined) => {
  const wire = wireCapabilities(capabilities)
  return wire ? { capabilities: wire } : {}
}

export async function readBoundedConversationUpload(path: string, expectedBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > MAX_ATTACHMENT_BYTES)
    throw new Error('Image upload size is invalid.')
  const file = await openConfinedExistingFile(dirname(path), basename(path))
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size !== expectedBytes) throw new Error('Image upload changed after receipt.')
    const bytes = Buffer.allocUnsafe(expectedBytes + 1)
    let count = 0
    while (count < bytes.length) {
      const read = await file.read(bytes, count, bytes.length - count, count)
      if (!read.bytesRead) break
      count += read.bytesRead
    }
    const after = await file.stat()
    if (count !== expectedBytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error('Image upload changed after receipt.')
    return bytes.subarray(0, count)
  } finally {
    await file.close()
  }
}

export type ConversationGatewayHost = {
  list(): Promise<ConversationThread[]>
  /**
   * This machine's own kind and colour, for the identity endpoint's
   * `machine`: how a paired device draws the desktop it is paired with.
   */
  machine?(): { kind: string; color: string } | null
  resolveKey(workspaceId: string, agentId: string): ConversationKey | null
  subscribe(
    key: ConversationKey,
    cursor: Omit<ConversationSubscribeInput, 'key'>,
    listener: (frame: ConversationSessionFrame) => void,
  ): { dispose(): void; ready: Promise<void> }
  loadEarlier(
    key: ConversationKey,
    beforeCursor: number,
    turnLimit?: number,
  ): ReturnType<ConversationSessionApi['loadEarlier']>
  getToolDetail(key: ConversationKey, toolUseId: string): ReturnType<ConversationBackend['getToolDetail']>
  getTurnDiff(key: ConversationKey, turnSeq: number, path?: string): ReturnType<ConversationSessionApi['getTurnDiff']>
  /**
   * Where the picture one step made or looked at is on this disk, read from
   * the conversation's own record of that step. `unknown_conversation` when
   * the workspace has no such chat; `unknown_image` when the chat has no such
   * step, or the step shows no picture.
   */
  toolImagePath?(key: ConversationKey, toolUseId: string): Promise<ConversationToolImagePath>
  /**
   * A picture the person sent with one of the chat's messages, by the `ref`
   * its `user_message` recorded. Read only from this machine's attachment
   * store, and only from the chat's own folder there: a ref naming another
   * chat's picture is `unknown_image`, as one that is gone is.
   */
  sentImage?(key: ConversationKey, ref: string): Promise<ConversationSentImage>
  /**
   * Keep what a device uploaded for one chat's next send, under an id only
   * that device can spend. A picture is read into the turn; a `file` (any
   * type, `conversation-message-files`) is attached to the message by its
   * path, which then stays where the upload put it.
   */
  registerUpload?(input: {
    deviceId: string
    sessionId: string
    path: string
    name: string
    mediaType: string
    bytes: number
    kind?: 'file'
    dispose?: () => void
  }): string
  /**
   * The preset the conversation runs under now, or would resume under: the
   * same answer its listed thread gives as `permissionPreset`.
   */
  permissionOf?(key: Pick<ConversationKey, 'workspaceId' | 'agentId'>): ConversationPermissionPreset
  /**
   * Follow what this desktop holds for a chat until its turn ends: told now,
   * and again whenever it changes. Absent on a host that holds nothing (one
   * built without `heldMessages`); returns what stops the following.
   */
  watchQueued?(
    key: Pick<ConversationKey, 'workspaceId' | 'agentId'>,
    listener: (messages: ConversationQueuedMessage[]) => void,
  ): () => void
  /**
   * A side question about a chat (`conversation-side-questions`), asked of its
   * agent and added to nothing, under the device's own `questionId`. A chat
   * at rest is resumed for it, as a send resumes one. Absent on a host that
   * cannot ask one.
   */
  askSideQuestion?(
    key: ConversationKey,
    deviceId: string,
    questionId: string,
    question: string,
    history: ConversationSideQuestionExchange[],
  ): Promise<ConversationSideQuestionResult>
  /** Call off a side question the device asked and is still being answered. */
  cancelSideQuestion?(deviceId: string, questionId: string): Promise<{ ok: true } | { ok: false; message: string }>
  /**
   * What fills a chat's context window, as its live session's agent measures it
   * (`conversation-context-breakdown`). A chat with no live session is not
   * started for it: the read says there is no agent to ask yet.
   */
  contextBreakdown?(key: ConversationKey): Promise<ConversationContextBreakdownResult>
  /**
   * The files and folders in a chat's folder whose names match `query`, best
   * first, each by its path relative to that folder: what a paired device's @
   * mention searches (`conversation-file-search`). The folder is the one the
   * chat's session works in, else its workspace's, the one its mentions are
   * resolved against when it sends; nothing outside it is named. A device's
   * next search supersedes its last. Absent on a host that searches nothing.
   */
  searchFiles?(
    key: ConversationKey,
    deviceId: string,
    query: string,
    limit?: number,
  ): Promise<ConversationComposerRead<ConversationFileSearchAnswer>>
  /**
   * The slash commands the chat's CLI runs in the chat's folder, as the `/`
   * menu here lists them (`conversation-commands`). `refresh` asks the CLI
   * again now. Absent on a host that lists none.
   */
  listCommands?(key: ConversationKey, refresh: boolean): Promise<ConversationComposerRead<ConversationCommandsAnswer>>
  /**
   * Follow what this desktop has scheduled into a chat for a time: told now,
   * and again whenever it changes. Absent on a host that schedules nothing
   * (one built without `scheduledSends`); returns what stops the following.
   */
  watchScheduled?(
    key: Pick<ConversationKey, 'workspaceId' | 'agentId'>,
    listener: (messages: ConversationScheduledMessage[]) => void,
  ): () => void
  /**
   * Follow what this desktop knows of its agents' usage limits, for a chat:
   * each plan's windows and the notice a limit left on the chat's turn. Told
   * now, and again whenever it reads differently. Absent on a host built
   * without `usageLimits`; returns what stops the following.
   */
  watchUsageLimits?(
    key: Pick<ConversationKey, 'workspaceId' | 'agentId'>,
    listener: (state: ConversationUsageLimitsState) => void,
  ): () => void
  /**
   * Carry out one command under its client's id. `fingerprint`, where the
   * client's door computes one, is kept with the command's receipt: the same
   * id for a different command is then refused (`command_id_conflict`).
   */
  command(
    key: ConversationKey,
    deviceId: string,
    commandId: string,
    command: ConversationCommand,
    fingerprint?: string,
  ): Promise<ConversationGatewayCommandResult>
}

/**
 * A runtime answer as a command's result. Three refusals the runtime names by
 * a code are kept: a command id already used for a different command, `busy`
 * with its delay (a send that arrived while a turn runs, which the device
 * sends again), and `stale` (a send written long before it arrived, which the
 * device asks its person about). The commands built here name none other, and
 * the runtime's words stay in the message.
 */
function relay(
  result: ConversationGatewayCommandResult | ConversationSessionActionResult,
): ConversationGatewayCommandResult {
  if (
    result.ok ||
    result.code === undefined ||
    result.code === 'command_id_conflict' ||
    result.code === 'busy' ||
    result.code === 'stale'
  )
    return result as ConversationGatewayCommandResult
  const { code: _unnamed, ...rest } = result
  return rest as ConversationGatewayCommandResult
}

/** A read for a paired device's composer, or why there is none: no such chat, or nothing to read. */
export type ConversationComposerRead<T> =
  { ok: true; answer: T } | { ok: false; code: 'unknown_conversation' | 'unavailable'; message: string }

export type ConversationToolImagePath =
  { ok: true; path: string } | { ok: false; code: 'unknown_conversation' | 'unknown_image' }

export type ConversationSentImage =
  | { ok: true; mediaType: ConversationImageMediaType; bytes: Buffer }
  | { ok: false; code: 'unknown_conversation' | 'unknown_image' }

/**
 * How a command ended. `code` names a refusal the wire has a word for (a model
 * outside the chat's catalog); any other refusal is `unavailable` with its
 * message. `notice` qualifies an accepted command, as the runtime words it.
 */
export type ConversationGatewayCommandResult = {
  ok: boolean
  message?: string
  code?: ConversationWireErrorCode | 'command_id_conflict'
  /** With `busy`: when trying again can succeed. */
  retryAfterMs?: number
  notice?: string
  /** What a command that answers more than yes or no says, as its `commandResult`'s `data` (a `revert`'s files). */
  data?: Record<string, unknown>
}

/** A count or a time in milliseconds as the wire carries it: a whole number, never below zero. */
function wholeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null
}

/**
 * A listed row's numbers as whole numbers. A transcript's times can come from
 * a file's modification time (fractional milliseconds) or be missing for one
 * that could not be read; a client that reads them as integers would refuse
 * the row, or the whole list.
 */
function wholeNumbers(thread: ConversationThread): ConversationThread {
  const createdAt = wholeNumber(thread.createdAt) ?? wholeNumber(thread.updatedAt) ?? 0
  return {
    ...thread,
    createdAt,
    updatedAt: wholeNumber(thread.updatedAt) ?? createdAt,
    turnCount: wholeNumber(thread.turnCount) ?? 0,
    lastSeq: wholeNumber(thread.lastSeq) ?? 0,
  }
}

/** Answers to Send now and Delete on a scheduled message, and to a resume's, kept for a command sent again. */
const MAX_ANSWER_RECEIPTS = 256

/** How long a send turned away behind another send to the same chat waits before trying again. */
const SEND_BUSY_RETRY_MS = 1_000

/**
 * What a listed chat carries beside its conversation: the machine it runs on
 * and the pull requests it opened. Both are read from records this
 * desktop already keeps, so listing never starts a process or asks GitHub.
 */
export type ConversationListMarks = {
  /** The machine a workspace's chats run on; null when it cannot be named yet. */
  machineOf?: (workspaceId: string) => ConversationWireHost | null
  /**
   * The same, as a reader made once per list: what every workspace's machine
   * is named against (this machine's host name, the launch settings) is read
   * once for the list rather than once per workspace. Preferred to `machineOf`.
   */
  machineReader?: () => (workspaceId: string) => ConversationWireHost | null
  /** The pull requests the record holds for these chats, keyed `workspaceId:agentId`. */
  pullRequestsOf?: (
    keys: Array<{ workspaceId: string; agentId: string }>,
  ) => Promise<Map<string, ConversationWirePullRequest[]>>
  /**
   * The local servers the record holds for these chats, keyed
   * `workspaceId:agentId`, as last checked: a chat with none is left out.
   */
  localServersOf?: (
    keys: Array<{ workspaceId: string; agentId: string }>,
  ) => Promise<Map<string, ConversationWireLocalServer[]>>
  /** This machine's own kind and colour. */
  selfMachine?: () => { kind: string; color: string }
  /**
   * The branch each workspace's folder is checked out on, keyed by workspace
   * id; a folder that is not a repository, or sits on a detached HEAD, is
   * left out. Read from the checkout's HEAD file, remembered against it, so a
   * list asked for again runs no git.
   */
  branchesOf?: (workspaceIds: string[]) => Promise<Map<string, string>>
  /**
   * Where each chat works, keyed `workspaceId:agentId`: whether in a worktree
   * of its project, and, for a chat whose session is `live`, the files its
   * checkout carries. Counted from the shared reading the sidebar's lines
   * take, held for a few seconds, so a list asked for again runs no git; and
   * only for a live chat, as the sidebar draws a line only for one. A chat
   * left out, or a count that could not be read, lists without it.
   */
  checkoutsOf?: (
    keys: Array<{ workspaceId: string; agentId: string; live: boolean }>,
  ) => Promise<Map<string, Pick<ConversationThread, 'changes' | 'worktree'>>>
  /**
   * What a paired desktop's management of each chat reads, keyed
   * `workspaceId:agentId`: whether it compacts by itself (`autoCompact`). A
   * chat left out lists without it.
   */
  manageOf?: (
    keys: Array<{ workspaceId: string; agentId: string }>,
  ) => Promise<Map<string, ConversationListManage>> | Map<string, ConversationListManage>
}

/** The members a paired desktop's management of a listed chat reads (`ConversationListMarks.manageOf`). */
export type ConversationListManage = Pick<ConversationThread, 'autoCompact'>

const restingRecord = (record: ConversationListWorkspace | null): boolean =>
  record !== null && isSettledWorkspace(record)

const epoch = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/** When the turn a live session is running began, left out between turns. */
function turnStartOf(summary: ConversationSessionSummary | undefined): Pick<ConversationThread, 'turnStartedAt'> {
  return epoch(summary?.turnStartedAt) ? { turnStartedAt: Math.trunc(summary.turnStartedAt) } : {}
}

/**
 * When a live session's stretch of work began, as the runtime keeps it
 * (`workingSince`, conversation/workingStretch.ts): the number this desktop's
 * own sidebar counts "working for" from. Present whenever the session reads
 * as working, its background work included, so a turn the chat opens by
 * itself does not restart a paired machine's count, and the gap between two
 * of them does not stop it.
 */
function workingSinceOf(summary: ConversationSessionSummary | undefined): Pick<ConversationThread, 'workingSince'> {
  if (!summary || !epoch(summary.workingSince)) return {}
  return conversationPhaseWorking(conversationSummaryPhase(summary))
    ? { workingSince: Math.trunc(summary.workingSince) }
    : {}
}

/**
 * What a live session still has working after its turn ended, from the same
 * readings the desktop's sidebar counts it working by
 * (`conversationSummaryPhase`): its background agents, and the background
 * tasks that will wake its agent. Left out when there is neither. The listed
 * `phase` stays the turn's own: a device that holds sends while a turn runs
 * would otherwise hold them for as long as a background agent works.
 */
function backgroundWorkOf(summary: ConversationSessionSummary | undefined): Pick<ConversationThread, 'backgroundWork'> {
  if (!summary) return {}
  const agents = wholeNumber(summary.backgroundAgents) ?? 0
  const monitors = (summary.backgroundTasks ?? []).filter((task) => backgroundTasksWakeAgent([task])).length
  return agents > 0 || monitors > 0 ? { backgroundWork: { agents, monitors } } : {}
}

/** A listed chat's lifecycle members, each left out when there is nothing true to say. */
function lifecycleOf(
  record: ConversationListWorkspace | null,
  lastTurnEndedAt: number | undefined,
  now: number,
): Pick<
  ConversationThread,
  | 'chatTitle'
  | 'lastUserMessageAt'
  | 'lastTurnEndedAt'
  | 'lastVisitedAt'
  | 'visitRewoundAt'
  | 'scheduledAgentId'
  | 'snoozedUntil'
  | 'highlight'
  | 'autoSettle'
> {
  const chatTitle = record?.name.trim()
  const scheduledAgentId = record?.scheduledAgentId?.trim()
  // The record's own mark, read as a client reads one: a colour this desktop
  // does not offer is left out.
  const highlight = parseConversationWireHighlight(record?.highlight)
  return {
    ...(chatTitle ? { chatTitle } : {}),
    ...(epoch(record?.lastUserMessageAt) ? { lastUserMessageAt: record.lastUserMessageAt } : {}),
    ...(lastTurnEndedAt !== undefined ? { lastTurnEndedAt } : {}),
    ...(epoch(record?.lastVisitedAt) ? { lastVisitedAt: record.lastVisitedAt } : {}),
    // Read only from the record, which only Mark unread's own command stamps.
    ...(epoch(record?.visitRewoundAt) ? { visitRewoundAt: record.visitRewoundAt } : {}),
    // How the chat began, which this desktop's row marks with the schedule's clock.
    ...(scheduledAgentId ? { scheduledAgentId } : {}),
    // Only a snooze still ahead: one that has run out is a row awake here.
    ...(epoch(record?.snoozedUntil) && record.snoozedUntil > now
      ? { snoozedUntil: Math.trunc(record.snoozedUntil) }
      : {}),
    // The row menu's star, colour and Auto-settle, which a paired device's
    // menu reads and writes (`chat-row-menu`).
    ...(highlight ? { highlight } : {}),
    ...(record?.autoSettleEnabled === true ? { autoSettle: true as const } : {}),
  }
}

/**
 * The opening of a chat's last reply, the line its row previews. The newest
 * session this run holds says it freshest, empty once the person has written
 * again; the transcript's index says it for a chat no session holds.
 */
function replyPreviewOf(
  sessions: readonly ConversationSessionSummary[],
  indexed?: string,
): Pick<ConversationThread, 'lastAssistantText'> {
  let newest: ConversationSessionSummary | null = null
  for (const session of sessions)
    if (typeof session.lastAssistantText === 'string' && (!newest || session.updatedAt > newest.updatedAt))
      newest = session
  const preview = (newest ? newest.lastAssistantText : indexed)?.slice(0, CONVERSATION_MAX_REPLY_PREVIEW)
  return preview?.trim() ? { lastAssistantText: preview } : {}
}

/**
 * What this desktop's own record of a chat says about it, as a listed chat
 * carries it: the name its sidebar shows, whether it is resting, and the
 * clocks the sidebar orders it and reads "finished, unseen" by.
 */
export type ConversationListWorkspace = {
  name: string
  createdAt: number
  settledAt?: number | null
  lastUserMessageAt?: number | null
  lastTerminalActivityAt?: number | null
  lastVisitedAt?: number | null
  /** When Mark unread last moved `lastVisitedAt` back. */
  visitRewoundAt?: number | null
  /** The schedule whose run started the chat; absent for one a person or an agent started. */
  scheduledAgentId?: string | null
  /** When a snoozed chat wakes; absent, or past, for one that is awake. */
  snoozedUntil?: number | null
  /** The row menu's star and highlight colour; absent for a chat with neither. */
  highlight?: { starred: boolean; color: string | null } | null
  /** Auto-settle, switched on from the row menu; absent or null is off. */
  autoSettleEnabled?: boolean | null
}

/**
 * The desktop's chat records, which the conversation lane reads and writes
 * through rather than keeping its own copy: the desktop is the one owner of a
 * chat's rest and of when it was last written to and looked at, so a phone, a
 * second desktop and the desktop's own sidebar can never disagree about them.
 */
export type ConversationRegistryLink = {
  /** The record a workspace's chats belong to; null when the desktop has none for it. */
  workspaceOf?: (workspaceId: string) => ConversationListWorkspace | null
  /** A person sent one of the workspace's chats a message from a paired device. */
  noteUserMessage?: (workspaceId: string, at: number) => void
  /**
   * List as the `conversation-lifecycle` capability promises: the chats this
   * desktop has settled left out, the rest in its sidebar's order. Only a
   * door that advertises the capability turns it on (the tailnet lane); the
   * Studio RPC does not advertise it, and lists every chat by `updatedAt`, as
   * it always has.
   */
  lifecycleList?: boolean
  /**
   * The sends through this host are Studio's own, not a person's (a resume
   * after a usage limit): each turn's `user_message` carries this origin, so
   * the chat draws it as Studio's and nothing counts it as the person writing.
   * Absent, a send is the person's, from a paired device.
   */
  sendOrigin?: ConversationMessageOrigin
  /**
   * The effort the chat's agent record keeps (a New chat's pick, or one
   * changed in the chat since), which a window's chat view sends every turn
   * with. A turn sent from here runs at it too, or a chat would switch effort
   * each time the person moved between the phone and the desk.
   */
  reasoningEffortOf?: (key: { workspaceId: string; agentId: string }) => string | null | undefined
  /**
   * Writes a choice a paired device made for a chat to its agent record, as the
   * chat view writes the person's own: the record is what the chat starts on
   * after this desktop's tab remounts or the app restarts, and what its chip
   * shows with no live session. Without it a phone's switch lasted only as long
   * as the session it was applied to, and the next start put the old one back.
   */
  writeAgentChoice?: (key: { workspaceId: string; agentId: string }, patch: AgentChoicePatch) => void
  /**
   * Where a `send` that says `queue` is held until the chat's turn ends, and
   * sent from (`conversation-queued-sends`). Absent, such a send is an
   * ordinary one, refused `busy` while a turn runs, as before the member.
   */
  heldMessages?: ConversationHeldMessages
  /**
   * Where a message a paired machine scheduled into a chat for a time is
   * kept, and sent from when it comes due (`conversation-scheduled-sends`).
   * Absent, the commands are refused in words.
   */
  scheduledSends?: ConversationScheduledSends
  /**
   * What this desktop knows of its agents' usage limits, and the resume it
   * sends a chat a limit stopped (`conversation-usage-limits`). Absent, the
   * command is refused in words and nothing is watched.
   */
  usageLimits?: ConversationUsageLimits
  /**
   * Studio's own folders of pictures (what chats sent, the pictures their steps
   * returned, pasted images). A step's picture is served from the chat's
   * folder, its session's, or one of these, and from nowhere else.
   */
  imageRoots?: () => readonly string[]
  /**
   * Where a fork a paired device asked for joins this desktop's records, as a
   * window's Fork from here adds one (`conversation-fork`): `name` says what
   * the fork of a chat is called beside the workspace's others, refusing an
   * id the workspace holds already, and `add` writes its agent record, the
   * chat's twin under that name. Absent, a fork is refused: one with no
   * record would be a transcript no window here lists.
   */
  forks?: {
    name(chat: ChatOf, newAgentId: string): { ok: true; name: string } | { ok: false; message: string }
    add(chat: ChatOf, newAgentId: string, name: string): { ok: true } | { ok: false; message: string }
  }
  /**
   * Search a chat's folder for files and folders by name, as the composer's @
   * picker here does (filesystem-search.ts), for a paired device's mention
   * (`conversation-file-search`). `channel` names the asker, so its next
   * query supersedes its last. Absent, nothing is searched.
   */
  searchFiles?: (input: {
    workspaceId: string
    rootPath: string
    query: string
    limit: number
    channel: string
  }) => Promise<FileSearchResult>
  /**
   * The slash commands a CLI runs in a chat's folder, from the composer's own
   * command lists (conversation-commands/service.ts), for a paired device's
   * `/` menu (`conversation-commands`). Absent, none is listed.
   */
  commandsOf?: (input: {
    workspaceId: string
    cli: string
    cwd: string
    refresh?: boolean
  }) => Promise<ConversationCommandCatalog>
}

type ChatOf = { workspaceId: string; agentId: string }

/**
 * The messages this desktop holds for its chats until their turns end: queued
 * on a paired machine while a turn ran, and sent from here when it ends, so
 * the machine that typed one may sleep or close in the meantime. The
 * scheduled messages keep them (scheduled-messages.ts, `hold`).
 */
export type ConversationHeldMessages = {
  /** Hold `text` for the chat. `source` names the command it came in on: the same one twice is held once. */
  hold(chat: ChatOf, text: string, source: string): { ok: true } | { ok: false; message: string }
  /** Take a held message back; refused once it is on its way into the chat. */
  cancel(chat: ChatOf, id: string): { ok: true } | { ok: false; message: string }
  /** What the chat has held now, oldest first, leaving out one already on its way. */
  list(chat: ChatOf): ConversationQueuedMessage[]
  /** Something held changed, for some chat. */
  onChanged(listener: () => void): () => void
}

/**
 * The messages this desktop has scheduled into its chats for a time, as a
 * paired machine schedules, sends early and deletes them: the scheduled
 * messages keep them (scheduled-messages.ts, `scheduleFrom`), beside the ones
 * scheduled here, and send them when they come due, so the machine that
 * scheduled one may sleep or close meanwhile. A message held for a turn's end
 * is `heldMessages`'s, and is in none of these.
 */
export type ConversationScheduledSends = {
  /** Keep `text` for the chat until `sendAt`. `source` names the command it came in on: the same one twice is kept once. */
  schedule(chat: ChatOf, text: string, sendAt: number, source: string): { ok: true } | { ok: false; message: string }
  /** Send one at once, a refused one again; refused once it is no longer scheduled. */
  sendNow(chat: ChatOf, id: string): { ok: true } | { ok: false; message: string }
  /** Delete one; refused once it is on its way into the chat, or no longer scheduled. */
  cancel(chat: ChatOf, id: string): { ok: true } | { ok: false; message: string }
  /** What the chat has scheduled now, soonest first. */
  list(chat: ChatOf): ConversationScheduledMessage[]
  /** Something scheduled changed, for some chat. */
  onChanged(listener: () => void): () => void
}

/** A `usageLimits` frame without its type and key: what a host says of one chat. */
export type ConversationUsageLimitsState = Omit<ConversationUsageLimitsFrame, 'type' | 'key'>

/**
 * This desktop's usage limits, as a paired machine's strip and tray draw them
 * for one of its chats: the limits its agents reported here
 * (usage-limits/store.ts), and the resume it sends a chat a limit stopped
 * (usage-limits/resume.ts), which a paired machine schedules, cancels,
 * dismisses or retries as this desktop's own tray row does.
 */
export type ConversationUsageLimits = {
  /** What there is to say for the chat now. */
  list(chat: ChatOf): ConversationUsageLimitsState
  /** Act on the chat's notice; `always` also switches on resuming every chat a limit stops. */
  update(
    chat: ChatOf,
    action: ConversationUsageLimitResumeAction,
    always: boolean,
  ): { ok: true } | { ok: false; message: string }
  /** The limits or a notice changed. */
  onChanged(listener: () => void): () => void
}

/**
 * Both IPC and the network wrap this one session API; only root resolution
 * differs. `defaultPermissionPreset` answers for a conversation this app has
 * not run since it started: the preset its agent record holds, else the app's
 * spawn default. `agentName` is the name the conversation's agent record holds
 * — the one this desktop's tab and sidebar show — and is what a phone or a
 * second desktop lists the conversation as; the thread's own title (its first
 * message, or a rename) answers only for a conversation with no named agent.
 */
/** What a paired device's switch changes on a chat's agent record. */
export type AgentChoicePatch = {
  cliPermissionPreset?: ConversationPermissionPreset
  /** Written with the preset, or cleared with it: a mode left from an earlier preset is not this one's. */
  cliPermissionMode?: string | undefined
  conversation?: { providerId: string; modelId: string }
  /** Cleared with `undefined`: the chat then runs at its provider's own default. */
  conversationReasoningEffort?: string | undefined
}

/**
 * One chat's held messages, told now and again on each change that touches
 * them: every chat's changes arrive on the one channel, and a follower is told
 * only when its own chat's list reads differently.
 */
function watchHeld<Said>(
  held: { list(chat: ChatOf): Said; onChanged(listener: () => void): () => void },
  chat: ChatOf,
  listener: (said: Said) => void,
): () => void {
  const key = { workspaceId: chat.workspaceId, agentId: chat.agentId }
  let last: string | null = null
  const tell = () => {
    const messages = held.list(key)
    const seen = JSON.stringify(messages)
    if (seen === last) return
    last = seen
    listener(messages)
  }
  const stop = held.onChanged(tell)
  tell()
  return stop
}

/**
 * A step's picture as the path to serve, when it is really inside one of
 * `roots`; null otherwise. A WSL distribution's files are named by its share
 * (`\\wsl.localhost\Ubuntu\…`), a spelling the general check refuses, so on
 * Windows such a path is held by its spelling to a root on that same share.
 */
/**
 * A search's matches as a paired device is told them: each by its path
 * relative to `root`, with `/` between segments, and none that is not inside
 * it. The device names them back as mentions, which this machine resolves
 * against the same folder.
 */
function relativeSearchEntries(root: string, result: FileSearchResult, limit: number): ConversationFileSearchAnswer {
  if (!result.ok) return { entries: [], truncated: false }
  const entries: ConversationFileSearchEntry[] = []
  let truncated = result.truncated
  for (const found of result.results) {
    const inside = relative(root, found.path)
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) continue
    if (entries.length >= limit) {
      truncated = true
      break
    }
    entries.push({ path: inside.split(sep).join('/'), kind: found.isDir ? 'folder' : 'file' })
  }
  return { entries, truncated }
}

async function confineImagePath(path: string, roots: readonly string[]): Promise<string | null> {
  const checked = await confineToRoots(path, roots)
  if (checked.ok) return checked.path
  if (process.platform !== 'win32' || !distroOfUncPath(path)) return null
  const named = win32.normalize(path).toLowerCase()
  for (const root of roots) {
    if (!distroOfUncPath(root)) continue
    const relative = win32.relative(win32.normalize(root).toLowerCase(), named)
    if (relative === '' || (!relative.startsWith('..') && !win32.isAbsolute(relative))) return path
  }
  return null
}

export function createConversationGatewayHost(
  runtime: ConversationBackend,
  resolveWorkspaceRoot: (workspaceId: string) => string | null,
  listWorkspaces: () => Array<{ workspaceId: string; workspaceRoot: string }>,
  defaultPermissionPreset: (key: { workspaceId: string; agentId: string }) => ConversationPermissionPreset = () =>
    DEFAULT_AGENT_SPAWN_PERMISSION_PRESET,
  agentName: (key: { workspaceId: string; agentId: string }) => string | null | undefined = () => null,
  modelCatalog: (providerId: string) => Promise<ConversationModelCatalog | null> = async () => null,
  marks: ConversationListMarks = {},
  registry: ConversationRegistryLink = {},
): ConversationGatewayHost {
  // A slot placeholder ("Agent 2", the record id) is not a name; the thread's
  // title says more than it does.
  const nameFor = (key: { workspaceId: string; agentId: string }): string | null => {
    const name = agentName(key)?.trim()
    return name && !isPlaceholderAgentName(name, key.agentId) ? name : null
  }
  const api = new ConversationSessionApi(runtime)
  const uploads = new Map<
    string,
    {
      deviceId: string
      sessionId: string
      path: string
      name: string
      mediaType: string
      bytes: number
      kind?: 'file'
      at: number
      dispose?: () => void
    }
  >()
  const discardUpload = (id: string) => {
    uploads.get(id)?.dispose?.()
    uploads.delete(id)
  }
  // A sent file stays on disk: the message names its path, and the agent may
  // read it in any later turn. Only its reference goes.
  const spendUpload = (id: string) => {
    if (uploads.get(id)?.kind === 'file') uploads.delete(id)
    else discardUpload(id)
  }
  // Images an accepted send already carried, by upload id. Their files are
  // gone; a retry of that same command is answered from the runtime's receipt
  // and does not need them again.
  const spent = new Map<string, { deviceId: string; commandId: string }>()
  const receipts = new Map<string, Promise<ConversationGatewayCommandResult>>()
  // Carried out under the device's own command: a repeat after a dropped
  // connection is the same rewind, revert or handoff, answered as the first
  // was. Run again, a rewind would no longer find the message it went back
  // before, a revert would find its own work done and refuse it as files that
  // moved, and a handoff would be refused as one already made.
  const receipted = (
    key: ConversationKey,
    deviceId: string,
    commandId: string,
    run: () => Promise<ConversationGatewayCommandResult>,
  ): Promise<ConversationGatewayCommandResult> => {
    const receipt = JSON.stringify([deviceId, commandId, key.workspaceId, key.agentId])
    let running = receipts.get(receipt)
    if (!running) {
      running = run().catch((error: unknown): ConversationGatewayCommandResult => ({
        ok: false,
        message: error instanceof Error ? error.message : 'The conversation could not do that.',
      }))
      receipts.set(receipt, running)
      while (receipts.size > MAX_COMMAND_RECEIPTS) receipts.delete(receipts.keys().next().value!)
      // A refusal is not kept: the person may try again once the turn is over.
      void running.then((result) => {
        if (!result.ok) receipts.delete(receipt)
      })
    }
    return running
  }
  // A turn's files put back, or only listed, as this machine's own Revert
  // does. The paths are the checkout's own, relative to it, which the socket
  // keeps them as.
  const revert = async (
    key: ConversationKey,
    command: Extract<ConversationCommand, { kind: 'revert' }>,
  ): Promise<ConversationGatewayCommandResult> => {
    const result = await api.revertToTurn({
      key,
      turnSeq: command.turnSeq,
      ...(command.undo ? { undo: true } : {}),
      ...(command.confirmed ? { confirmed: true, files: command.files ?? [] } : {}),
    })
    if (!result.ok)
      return { ok: false, message: result.message, ...(result.changed ? { data: { changed: true } } : {}) }
    return {
      ok: true,
      data: {
        files: result.files,
        reverted: result.reverted,
        ...(result.kept?.length ? { kept: result.kept } : {}),
      },
    }
  }
  const restarts = new Map<string, Promise<ConversationGatewayCommandResult>>()
  // As this machine's own Restart agent session: the agent's process ended
  // the way Settle ends it, suspended, so the next message starts it again on
  // the same conversation. Refused while it works, since a suspend would
  // interrupt the turn and end the agents it sent off. Under the device's own
  // command: a repeat after a dropped connection is that restart, not a
  // second one ending the session a message has started since.
  const restartSession = (key: ConversationKey, deviceId: string, commandId: string) => {
    const receipt = JSON.stringify([deviceId, commandId, key.workspaceId, key.agentId])
    let restarting = restarts.get(receipt)
    if (!restarting) {
      restarting = (async (): Promise<ConversationGatewayCommandResult> => {
        // A chat at rest is not resumed for it: there is nothing running to end.
        const session = sessionFor(key)
        if (!session) return { ok: true, notice: 'This chat has no agent running. Your next message starts one.' }
        if (conversationTurnInProgress(session))
          return { ok: false, message: 'The agent is still working. Stop it first, then restart the session.' }
        const suspended = await runtime.suspendSession({ sessionId: session.sessionId })
        return suspended.ok ? { ok: true } : { ok: false, message: suspended.message }
      })().catch((error: unknown): ConversationGatewayCommandResult => ({
        ok: false,
        message: error instanceof Error ? error.message : 'The session was not restarted.',
      }))
      restarts.set(receipt, restarting)
      while (restarts.size > MAX_RESTART_RECEIPTS) restarts.delete(restarts.keys().next().value!)
      // A refusal is not kept: the person may try again once the agent stops.
      void restarting.then((result) => {
        if (!result.ok) restarts.delete(receipt)
      })
    }
    return restarting
  }
  const starting = new Map<string, ReturnType<ConversationBackend['startSession']>>()
  const sending = new Map<
    string,
    { commandId: string; deviceId: string; promise: Promise<ConversationGatewayCommandResult> }
  >()
  let imageSends = 0
  const sessionFor = (key: ConversationKey) => {
    const listed = api.listSessions({ workspaceId: key.workspaceId, agentId: key.agentId })
    return listed.ok
      ? listed.sessions.find(
          (session) =>
            session.workspaceId === key.workspaceId &&
            session.agentId === key.agentId &&
            session.status !== 'stopped' &&
            session.status !== 'failed',
        )
      : undefined
  }
  // The preset a conversation runs under, or would resume under: the last
  // session this app ran for it (a stopped one still holds the preset it had),
  // else the default above. A remote resume keeps the conversation on the
  // preset it was left on rather than choosing one of its own, and on the
  // CLI's own mode at that preset when the session ran one.
  const permissionFor = (
    key: { workspaceId: string; agentId: string },
    sessions: ConversationSessionSummary[],
  ): { permissionPreset: ConversationPermissionPreset; permissionMode?: string } => {
    const latest = sessions
      .filter((session) => session.workspaceId === key.workspaceId && session.agentId === key.agentId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (!latest?.permissionPreset) return { permissionPreset: defaultPermissionPreset(key) }
    return {
      permissionPreset: latest.permissionPreset,
      ...(latest.permissionMode ? { permissionMode: latest.permissionMode } : {}),
    }
  }
  const imagePaths = new Map<string, { at: number; found: Promise<ConversationToolImagePath> }>()
  const threadFor = async (key: ConversationKey) => {
    const indexed = await runtime.listThreads(key)
    return indexed.ok ? indexed.threads.find((entry) => entry.agentId === key.agentId) : undefined
  }
  // The folder a chat works in, for what a paired device's composer reads of
  // it: its live session's (a New chat's pool worktree), else its
  // workspace's, which is where a send resumes it and so where the mentions
  // it names are resolved. Null for a chat the workspace does not hold.
  const chatFolderOf = async (key: ConversationKey): Promise<{ folder: string; providerId: string } | null> => {
    const live = sessionFor(key)
    const providerId = live?.providerId ?? (await threadFor(key))?.providerId
    if (!providerId) return null
    const sessionRoot =
      live && typeof runtime.sessionWorkspaceRoot === 'function' ? runtime.sessionWorkspaceRoot(live.sessionId) : null
    return { folder: sessionRoot || key.workspaceRoot, providerId }
  }
  const unknownChat = {
    ok: false as const,
    code: 'unknown_conversation' as const,
    message: 'No eligible conversation on this machine has that id.',
  }
  // The models a chat can switch between: its CLI's catalog, and whether its
  // provider takes a new model mid-conversation — as the live session
  // declared, else as the provider declares for a session it would resume.
  const modelsFor = async (
    providerId: string,
    summary: ConversationSessionSummary | undefined,
    catalogs: Map<string, Promise<ConversationModelCatalog | null>> = new Map(),
  ): Promise<ConversationWireModels | null> => {
    let catalog = catalogs.get(providerId)
    if (!catalog) {
      catalog = modelCatalog(providerId).catch(() => null)
      catalogs.set(providerId, catalog)
    }
    const listed = await catalog
    if (!listed) return null
    const capabilities = summary?.capabilities ?? runtime.getProviderCapabilities(providerId)
    return { ...listed, liveModelSwitch: capabilities?.liveModelSwitch === true }
  }
  const ensureSession = async (key: ConversationKey) => {
    const active = sessionFor(key)
    if (active) return { ok: true as const, session: active }
    const id = JSON.stringify([key.workspaceId, key.agentId])
    let request = starting.get(id)
    if (!request) {
      request = (async () => {
        const thread = await threadFor(key)
        if (!thread) return { ok: false as const, message: 'Conversation is unavailable.' }
        const listed = api.listSessions({ workspaceId: key.workspaceId, agentId: key.agentId })
        return runtime.startSession({
          ...key,
          providerId: thread.providerId,
          modelId: thread.model,
          ...permissionFor(key, listed.ok ? listed.sessions : []),
        })
      })()
      starting.set(id, request)
    }
    try {
      return await request
    } finally {
      if (starting.get(id) === request) starting.delete(id)
    }
  }
  // "Fork from here" for a paired device, as a window here forks: the runtime
  // writes the fork's transcript beside this chat's, then the fork joins the
  // workspace's records as this chat's twin under its own name, so every
  // window here lists it and the device can follow it by the id it chose.
  // Never a resume: a fork is cut from the transcript, and a provider that
  // branches only a live session (an ACP agent) hands the fork the
  // conversation as text instead. Held under the device's own command, so a
  // repeat after a dropped connection is the same fork; a refusal is not
  // kept, since the person may try again once the turn is over.
  const forkReceipts = new Map<string, Promise<ConversationGatewayCommandResult>>()
  const fork = (
    key: ConversationKey,
    deviceId: string,
    commandId: string,
    command: ConversationForkCommand,
  ): Promise<ConversationGatewayCommandResult> => {
    const receipt = JSON.stringify([deviceId, commandId, key.workspaceId, key.agentId])
    const kept = forkReceipts.get(receipt)
    if (kept) return kept
    const forking = (async (): Promise<ConversationGatewayCommandResult> => {
      const records = registry.forks
      if (!records) return { ok: false, message: 'This desktop cannot add a forked chat.' }
      if (!FORK_AGENT_ID.test(command.newAgentId) || command.newAgentId === key.agentId)
        return { ok: false, message: 'The new chat needs an id of its own.' }
      const chat = { workspaceId: key.workspaceId, agentId: key.agentId }
      const named = records.name(chat, command.newAgentId)
      if (!named.ok) return named
      const forked = await runtime.forkAtTurn({
        key,
        newAgentId: command.newAgentId,
        title: named.name,
        ...(command.side === 'user'
          ? { side: 'user' as const, turnSeq: command.turnSeq }
          : { side: 'assistant' as const, turnId: command.turnId }),
      })
      if (!forked.ok) return { ok: false, message: forked.message }
      return records.add(chat, command.newAgentId, named.name)
    })().catch((error: unknown): ConversationGatewayCommandResult => ({
      ok: false,
      message: error instanceof Error ? error.message : 'The conversation could not be forked.',
    }))
    forkReceipts.set(receipt, forking)
    while (forkReceipts.size > MAX_FORK_RECEIPTS) forkReceipts.delete(forkReceipts.keys().next().value!)
    void forking.then((result) => {
      if (!result.ok && forkReceipts.get(receipt) === forking) forkReceipts.delete(receipt)
    })
    return forking
  }
  // Side questions a device asked, by its own id for each: where each went,
  // so it can be called off there, or that it was called off before its
  // session had started, so it is never asked.
  const sideQuestions = new Map<string, { sessionId: string; requestId: string } | { calledOff: boolean }>()
  // Send now and Delete on a message a paired machine scheduled, and what it
  // did to a usage limit's resume, answered as they were the first time when
  // the same command comes again (a device that lost the answer offers it
  // again under its id): the message is gone by then, or the resume already
  // sent, and a second answer saying so would read as a failure.
  const answers = new Map<string, ConversationGatewayCommandResult>()
  const once = (
    deviceId: string,
    commandId: string,
    run: () => ConversationGatewayCommandResult,
  ): ConversationGatewayCommandResult => {
    const id = JSON.stringify([deviceId, commandId])
    const answered = answers.get(id)
    if (answered) return answered
    const result = run()
    answers.set(id, result)
    while (answers.size > MAX_ANSWER_RECEIPTS) answers.delete(answers.keys().next().value!)
    return result
  }
  const scheduledCommand = (
    chat: ChatOf,
    deviceId: string,
    commandId: string,
    command: Extract<ConversationCommand, { kind: 'scheduleSend' | 'sendScheduledNow' | 'cancelScheduled' }>,
  ): ConversationGatewayCommandResult => {
    const scheduled = registry.scheduledSends
    if (!scheduled) return { ok: false, message: 'This desktop does not schedule messages from another device.' }
    // Kept under the device's own command, so a repeat after a dropped
    // connection, or after a restart, schedules it once.
    const source = JSON.stringify([deviceId, commandId])
    if (command.kind === 'scheduleSend') return scheduled.schedule(chat, command.message, command.sendAt, source)
    return once(deviceId, commandId, () =>
      command.kind === 'sendScheduledNow'
        ? scheduled.sendNow(chat, command.scheduledId)
        : scheduled.cancel(chat, command.scheduledId),
    )
  }
  // A switch within the chat's own CLI, to a model this machine's picker
  // offers for it. Checked here, before the runtime sees it: the id must be in
  // the catalog (or be the CLI's own default), and the provider must take a
  // new model mid-conversation. A chat with no live session is resumed, as a
  // send or a preset switch resumes it, and the switch applies to that session.
  const setModel = async (
    key: ConversationKey,
    commandId: string,
    modelId: string,
    fingerprint?: string,
  ): Promise<ConversationGatewayCommandResult> => {
    let session = sessionFor(key)
    const providerId = session?.providerId ?? (await threadFor(key))?.providerId
    if (!providerId) return { ok: false, message: 'Conversation is unavailable.' }
    const models = await modelsFor(providerId, session)
    if (!models)
      return { ok: false, code: 'unsupported_model', message: "This chat's model cannot be changed from here." }
    if (modelId !== CONVERSATION_DEFAULT_MODEL_ID && !models.options.some((option) => option.id === modelId))
      return { ok: false, code: 'unsupported_model', message: `${models.cliLabel} does not offer that model.` }
    if (!models.liveModelSwitch)
      return { ok: false, message: 'This conversation provider cannot change models mid-conversation.' }
    if (!session) {
      const resumed = await ensureSession(key)
      if (!resumed.ok) return resumed
      session = resumed.session
    }
    const switched = await api.setModel({
      sessionId: session.sessionId,
      commandId,
      modelId,
      ...(fingerprint ? { commandFingerprint: fingerprint } : {}),
    })
    if (!switched.ok) return { ok: false, message: switched.message }
    registry.writeAgentChoice?.(key, { conversation: { providerId: session.providerId, modelId } })
    return { ok: true, ...(switched.notice ? { notice: switched.notice } : {}) }
  }
  // The effort a chat runs at, as its record keeps it and a send applies it:
  // only a level its provider runs, as the chat view reads it.
  const effortOf = (
    key: { workspaceId: string; agentId: string },
    capabilities: ConversationSessionSummary['capabilities'] | undefined,
  ): Pick<ConversationThread, 'reasoningEffort'> => {
    const effort = registry.reasoningEffortOf?.(key) ?? undefined
    return effort && capabilities?.reasoningEfforts?.includes(effort) ? { reasoningEffort: effort } : {}
  }
  // The chat's effort, as its own effort control sets it: written to its
  // record, which every turn sent to it reads, whichever device sends it. A
  // level its provider does not run is refused, as the control offers none.
  // No session is resumed for it: the record is what the next turn reads.
  // Sent twice, the second writes the same level again.
  const setReasoningEffort = async (
    key: ConversationKey,
    effort: string | undefined,
  ): Promise<ConversationGatewayCommandResult> => {
    if (!registry.writeAgentChoice || !registry.reasoningEffortOf)
      return { ok: false, message: 'This desktop keeps no reasoning effort for its chats.' }
    const session = sessionFor(key)
    const providerId = session?.providerId ?? (await threadFor(key))?.providerId
    if (!providerId) return { ok: false, message: 'Conversation is unavailable.' }
    const levels = (session?.capabilities ?? runtime.getProviderCapabilities(providerId))?.reasoningEfforts ?? []
    if (levels.length === 0) return { ok: false, message: "This chat's agent has no reasoning effort to set." }
    if (effort !== undefined && !levels.includes(effort))
      return { ok: false, message: `This chat's agent does not run at ${effort} effort.` }
    registry.writeAgentChoice(key, { conversationReasoningEffort: effort })
    // As the chat view says it: the turn running, if any, keeps its own.
    return { ok: true, ...(session ? { notice: 'Reasoning effort applies from the next turn.' } : {}) }
  }
  // The machine once per workspace, and the pull requests in one read of the
  // record for the whole list. A failed read leaves the rows without them, as
  // from a desktop that never listed them: the list itself still answers.
  const withMarks = async (listed: ConversationThread[]): Promise<ConversationThread[]> => {
    if (
      !marks.machineOf &&
      !marks.machineReader &&
      !marks.pullRequestsOf &&
      !marks.localServersOf &&
      !marks.branchesOf &&
      !marks.checkoutsOf &&
      !marks.manageOf
    )
      return listed
    const machines = new Map<string, ConversationWireHost | null>()
    let read: ((workspaceId: string) => ConversationWireHost | null) | undefined
    try {
      read = marks.machineReader?.() ?? marks.machineOf
    } catch {
      read = undefined
    }
    const machineOf = (workspaceId: string): ConversationWireHost | null => {
      if (!read) return null
      if (!machines.has(workspaceId)) {
        let found: ConversationWireHost | null = null
        try {
          found = read(workspaceId)
        } catch {
          found = null
        }
        machines.set(workspaceId, found)
      }
      return machines.get(workspaceId) ?? null
    }
    let pullRequests: Map<string, ConversationWirePullRequest[]> | null = null
    if (marks.pullRequestsOf && listed.length > 0) {
      pullRequests = await marks
        .pullRequestsOf(listed.map((thread) => ({ workspaceId: thread.workspaceId, agentId: thread.agentId })))
        .catch(() => null)
    }
    let localServers: Map<string, ConversationWireLocalServer[]> | null = null
    if (marks.localServersOf && listed.length > 0) {
      localServers = await marks
        .localServersOf(listed.map((thread) => ({ workspaceId: thread.workspaceId, agentId: thread.agentId })))
        .catch(() => null)
    }
    let branches: Map<string, string> | null = null
    if (marks.branchesOf && listed.length > 0) {
      branches = await marks.branchesOf([...new Set(listed.map((thread) => thread.workspaceId))]).catch(() => null)
    }
    let checkouts: Map<string, Pick<ConversationThread, 'changes' | 'worktree'>> | null = null
    if (marks.checkoutsOf && listed.length > 0) {
      checkouts = await marks
        .checkoutsOf(
          listed.map((thread) => ({
            workspaceId: thread.workspaceId,
            agentId: thread.agentId,
            live: Boolean(thread.sessionId),
          })),
        )
        .catch(() => null)
    }
    let manage: Map<string, ConversationListManage> | null = null
    if (marks.manageOf && listed.length > 0) {
      manage = await Promise.resolve(
        marks.manageOf(listed.map((thread) => ({ workspaceId: thread.workspaceId, agentId: thread.agentId }))),
      ).catch(() => null)
    }
    return listed.map((thread) => {
      const host = machineOf(thread.workspaceId)
      const branch = branches?.get(thread.workspaceId)
      const checkout = checkouts?.get(`${thread.workspaceId}:${thread.agentId}`)
      const servers = localServers?.get(`${thread.workspaceId}:${thread.agentId}`)
      const managed = manage?.get(`${thread.workspaceId}:${thread.agentId}`)
      return {
        ...managed,
        ...thread,
        ...(host ? { host } : {}),
        ...(branch ? { branch } : {}),
        ...(checkout?.changes ? { changes: checkout.changes } : {}),
        ...(checkout?.worktree ? { worktree: true } : {}),
        ...(pullRequests ? { pullRequests: pullRequests.get(`${thread.workspaceId}:${thread.agentId}`) ?? [] } : {}),
        ...(servers?.length ? { localServers: servers } : {}),
      }
    })
  }
  // The record a chat belongs to, once per workspace per list. A failed read
  // lists the chat as a desktop from before the record was read would: no
  // lifecycle members, and nothing left out.
  const recordsFor = () => {
    const records = new Map<string, ConversationListWorkspace | null>()
    return (workspaceId: string): ConversationListWorkspace | null => {
      if (!registry.workspaceOf) return null
      if (!records.has(workspaceId)) {
        let found: ConversationListWorkspace | null = null
        try {
          found = registry.workspaceOf(workspaceId)
        } catch {
          found = null
        }
        records.set(workspaceId, found)
      }
      return records.get(workspaceId) ?? null
    }
  }
  return {
    async list() {
      const now = Date.now()
      const result = api.listSessions()
      const all = result.ok ? result.sessions : []
      const live = all.filter((session) => session.status !== 'stopped').sort((a, b) => b.updatedAt - a.updatedAt)
      // Each chat's sessions, and its newest live one, found once for the
      // whole list rather than searched for again for every thread.
      const chatId = (key: { workspaceId: string; agentId: string }) => `${key.workspaceId}:${key.agentId}`
      const sessionsOf = new Map<string, ConversationSessionSummary[]>()
      for (const session of all) {
        const id = chatId(session)
        const held = sessionsOf.get(id)
        if (held) held.push(session)
        else sessionsOf.set(id, [session])
      }
      const liveOf = new Map<string, ConversationSessionSummary>()
      for (const session of live) if (!liveOf.has(chatId(session))) liveOf.set(chatId(session), session)
      const NO_SESSIONS: ConversationSessionSummary[] = []
      // One catalog read per provider for the whole list.
      const catalogs = new Map<string, Promise<ConversationModelCatalog | null>>()
      const byId = new Map<string, ConversationThread>()
      const recordOf = recordsFor()
      for (const workspace of listWorkspaces()) {
        // A settled chat is not drawn in the desktop's own sidebar, so no list
        // a paired device reads draws it either.
        if (registry.lifecycleList && restingRecord(recordOf(workspace.workspaceId))) continue
        const indexed = await runtime.listThreads(workspace)
        if (!indexed.ok) continue
        for (const thread of indexed.threads) {
          const key = { workspaceId: workspace.workspaceId, agentId: thread.agentId }
          const sessions = sessionsOf.get(chatId(key)) ?? NO_SESSIONS
          const summary = liveOf.get(chatId(key))
          const models = await modelsFor(thread.providerId, summary, catalogs)
          byId.set(chatId(key), {
            workspaceId: workspace.workspaceId,
            agentId: thread.agentId,
            title: nameFor(key) ?? thread.title,
            phase: summary?.phase ?? 'completed',
            updatedAt: thread.updatedAt,
            createdAt: thread.createdAt,
            providerId: thread.providerId,
            modelId: thread.model,
            turnCount: thread.turnCount,
            lastSeq: thread.lastSeq,
            ...permissionFor(key, sessions),
            ...(models ? { models } : {}),
            ...(summary ? { sessionId: summary.sessionId } : {}),
            // What the chat can do, from its session when it has one and
            // otherwise from its provider, as a chat here reads it before its
            // first turn. A chat at rest used to be listed with none, so a
            // client read it as taking no pictures, and a screenshot dropped
            // into it went over as the path of a file on the other machine.
            ...capabilitiesOf(summary?.capabilities ?? runtime.getProviderCapabilities(thread.providerId)),
            ...effortOf(key, summary?.capabilities ?? runtime.getProviderCapabilities(thread.providerId)),
            ...turnStartOf(summary),
            ...workingSinceOf(summary),
            ...backgroundWorkOf(summary),
            ...lifecycleOf(recordOf(workspace.workspaceId), latestTurnEnd(sessions, key, thread.lastTurnEndedAt), now),
            ...replyPreviewOf(sessions, thread.lastAssistantText),
          })
        }
      }
      for (const summary of live) {
        const id = chatId(summary)
        if (byId.has(id)) continue
        const sessions = sessionsOf.get(id) ?? NO_SESSIONS
        if (registry.lifecycleList && restingRecord(recordOf(summary.workspaceId))) continue
        const models = await modelsFor(summary.providerId, summary, catalogs)
        byId.set(id, {
          workspaceId: summary.workspaceId,
          agentId: summary.agentId,
          title: nameFor(summary) ?? summary.displayName ?? summary.firstUserText ?? 'New conversation',
          phase: summary.phase ?? 'idle',
          updatedAt: summary.updatedAt,
          createdAt: summary.createdAt,
          providerId: summary.providerId,
          modelId: summary.modelId,
          turnCount: 0,
          lastSeq: 0,
          ...permissionFor(summary, sessions),
          ...(models ? { models } : {}),
          sessionId: summary.sessionId,
          ...capabilitiesOf(summary.capabilities ?? runtime.getProviderCapabilities(summary.providerId)),
          ...effortOf(summary, summary.capabilities ?? runtime.getProviderCapabilities(summary.providerId)),
          ...turnStartOf(summary),
          ...workingSinceOf(summary),
          ...backgroundWorkOf(summary),
          ...lifecycleOf(recordOf(summary.workspaceId), latestTurnEnd(sessions, summary), now),
          ...replyPreviewOf(sessions),
        })
      }
      // In the order the desktop's sidebar draws them: by when the person last
      // wrote to each, most recent first, never by what an agent is doing.
      // A door without the capability keeps the order it always had.
      const orderOf = (thread: ConversationThread): number => {
        const record = recordOf(thread.workspaceId)
        return record ? workspaceLastUserMessageAt(record) : thread.updatedAt
      }
      // And the key itself, on each chat the sidebar here keeps a record of,
      // so a device that interleaves these rows with its own puts each where
      // it sits here, not by a fallback of its own.
      const listed = [...byId.values()]
        .map(wholeNumbers)
        .map((thread) => {
          const record = registry.lifecycleList ? recordOf(thread.workspaceId) : null
          const recencyAt = record ? workspaceLastUserMessageAt(record) : null
          return epoch(recencyAt) ? { ...thread, recencyAt: Math.trunc(recencyAt) } : thread
        })
        .sort((a, b) =>
          registry.lifecycleList ? orderOf(b) - orderOf(a) || b.updatedAt - a.updatedAt : b.updatedAt - a.updatedAt,
        )
      return withMarks(listed)
    },
    ...(marks.selfMachine ? { machine: () => marks.selfMachine?.() ?? null } : {}),
    permissionOf(key) {
      const listed = api.listSessions({ workspaceId: key.workspaceId, agentId: key.agentId })
      return permissionFor(key, listed.ok ? listed.sessions : []).permissionPreset
    },
    resolveKey: (workspaceId, agentId) => {
      const workspaceRoot = resolveWorkspaceRoot(workspaceId)
      return workspaceRoot ? { workspaceRoot, workspaceId, agentId } : null
    },
    subscribe: (key, cursor, listener) =>
      api.subscribe(
        { key, afterSeq: cursor.afterSeq, generation: cursor.generation, turnLimit: cursor.turnLimit },
        listener,
      ),
    loadEarlier: (key, beforeCursor, turnLimit) => api.loadEarlier({ key, beforeCursor, turnLimit }),
    getToolDetail: (key, toolUseId) => api.getToolDetail({ ...key, toolUseId }),
    getTurnDiff: (key, turnSeq, path) => api.getTurnDiff({ key, turnSeq, path }),
    toolImagePath(key, toolUseId) {
      const id = JSON.stringify([key.workspaceRoot, key.workspaceId, key.agentId, toolUseId])
      const now = Date.now()
      const kept = imagePaths.get(id)
      if (kept && now - kept.at < IMAGE_PATH_TTL_MS) return kept.found
      // Kept only once the step has ended well: one still waiting on its
      // approval may yet be declined, and is asked about again.
      let settled = false
      const found = (async (): Promise<ConversationToolImagePath> => {
        // A chat is one the list would name: a live session, or a thread the
        // workspace's history holds.
        const live = sessionFor(key)
        if (!live && !(await threadFor(key))) return { ok: false, code: 'unknown_conversation' }
        const tool = await runtime.findToolCall({ ...key, toolUseId })
        // A step declined, stopped or failed shows no picture in the chat,
        // so its file is not served either.
        if (tool?.status && tool.status !== 'ok') return { ok: false, code: 'unknown_image' }
        // Nor one not yet ended: a read still waiting on its approval may be
        // declined, and the chat's device draws a picture only once it is done.
        // (A backend from before `ended` says nothing, and is read as before.)
        if (tool?.ended === false) return { ok: false, code: 'unknown_image' }
        settled = tool?.status === 'ok' || tool?.ended === true
        const recorded = tool ? conversationImagePathOf(tool) : null
        if (!recorded) return { ok: false, code: 'unknown_image' }
        const path = conversationImageFileOf(recorded, key.workspaceRoot)
        // A relative path names a file in the chat's folder, as a link to it in
        // the same transcript does: the folder its session works in (a New
        // chat's pool worktree), else the workspace's.
        const sessionRoot =
          live && typeof runtime.sessionWorkspaceRoot === 'function'
            ? runtime.sessionWorkspaceRoot(live.sessionId)
            : null
        const named = isAbsolute(path) ? path : resolve(sessionRoot || key.workspaceRoot, path)
        const confined = await confineImagePath(named, [
          key.workspaceRoot,
          ...(sessionRoot ? [sessionRoot] : []),
          ...(registry.imageRoots?.() ?? []),
        ])
        return confined ? { ok: true, path: confined } : { ok: false, code: 'unknown_image' }
      })()
      // Shared while it is being found, so a burst of asks is one scan; kept
      // afterwards only when it named a picture of a step that has ended.
      imagePaths.delete(id)
      imagePaths.set(id, { at: now, found })
      while (imagePaths.size > MAX_IMAGE_PATHS) imagePaths.delete(imagePaths.keys().next().value!)
      void found.then(
        (answer) => {
          if ((!answer.ok || !settled) && imagePaths.get(id)?.found === found) imagePaths.delete(id)
        },
        () => {
          if (imagePaths.get(id)?.found === found) imagePaths.delete(id)
        },
      )
      return found
    },
    async sentImage(key, ref) {
      const live = sessionFor(key)
      if (!live && !(await threadFor(key))) return { ok: false, code: 'unknown_conversation' }
      // The store keeps each chat's pictures in a folder named from the chat
      // itself, so the folder is the authorisation: a ref is served only from
      // this chat's own, or from its live session's where that session runs in
      // another folder (a New chat's pool worktree). The store then refuses
      // anything that is not exactly a name it chose.
      const sessionRoot =
        live && typeof runtime.sessionWorkspaceRoot === 'function' ? runtime.sessionWorkspaceRoot(live.sessionId) : null
      const folders = new Set([
        ConversationAttachmentStore.folderFor(key),
        ...(sessionRoot ? [ConversationAttachmentStore.folderFor({ ...key, workspaceRoot: sessionRoot })] : []),
      ])
      const slash = ref.indexOf('/')
      if (slash < 0 || !folders.has(ref.slice(0, slash))) return { ok: false, code: 'unknown_image' }
      const read = await runtime.readAttachment(ref).catch(() => null)
      if (!read?.ok) return { ok: false, code: 'unknown_image' }
      const bytes = Buffer.from(read.dataBase64, 'base64')
      // The store wrote it under the sender's own cap; its first bytes, not its
      // name, say what it is served as.
      const mediaType = bytes.length <= MAX_ATTACHMENT_BYTES ? sniffConversationImage(bytes.subarray(0, 12)) : null
      return mediaType ? { ok: true, mediaType, bytes } : { ok: false, code: 'unknown_image' }
    },
    ...(registry.searchFiles
      ? {
          async searchFiles(key, deviceId, query, limit = CONVERSATION_MAX_FILE_SEARCH_RESULTS) {
            const chat = await chatFolderOf(key)
            if (!chat) return unknownChat
            const bounded = Math.max(1, Math.min(CONVERSATION_MAX_FILE_SEARCH_RESULTS, Math.trunc(limit)))
            const found = await registry.searchFiles!({
              workspaceId: key.workspaceId,
              rootPath: chat.folder,
              query,
              limit: bounded,
              // One search at a time per device: its next keystroke's
              // search calls off the one still walking.
              channel: `tailnet:${deviceId}`,
            }).catch((error: unknown) => ({
              ok: false as const,
              message: error instanceof Error ? error.message : String(error),
              engine: null,
            }))
            if (!found.ok) return { ok: false as const, code: 'unavailable' as const, message: found.message }
            return { ok: true as const, answer: relativeSearchEntries(chat.folder, found, bounded) }
          },
        }
      : {}),
    ...(registry.commandsOf
      ? {
          async listCommands(key, refresh) {
            const chat = await chatFolderOf(key)
            if (!chat) return unknownChat
            const cli = cliForConversationProvider(chat.providerId)
            if (!cli)
              return {
                ok: false as const,
                code: 'unavailable' as const,
                message: "This chat's agent runs no slash commands.",
              }
            const catalog = await registry.commandsOf!({
              workspaceId: key.workspaceId,
              cli,
              cwd: chat.folder,
              ...(refresh ? { refresh: true } : {}),
            }).catch((error: unknown) => ({
              cli,
              cwd: chat.folder,
              commands: [],
              fetchedAt: 0,
              error: error instanceof Error ? error.message : String(error),
            }))
            // Read as a device reads it: Studio's own commands are each
            // device's, and the folder the list was kept under is this disk's.
            const answer = parseConversationCommandsAnswer({
              cli,
              commands: catalog.commands,
              fetchedAt: catalog.fetchedAt,
              ...(catalog.error ? { error: catalog.error } : {}),
            })
            return answer
              ? { ok: true as const, answer }
              : { ok: false as const, code: 'unavailable' as const, message: 'The command list could not be read.' }
          },
        }
      : {}),
    registerUpload(input) {
      for (const [id, entry] of uploads) if (Date.now() - entry.at > UPLOAD_TTL_MS) discardUpload(id)
      const ownIds = [...uploads].filter(([, entry]) => entry.deviceId === input.deviceId).map(([id]) => id)
      while (ownIds.length >= MAX_DEVICE_UPLOAD_REFS) discardUpload(ownIds.shift()!)
      while (uploads.size >= MAX_UPLOAD_REFS) discardUpload(uploads.keys().next().value!)
      const id = randomUUID()
      uploads.set(id, { ...input, at: Date.now() })
      return id
    },
    ...(registry.heldMessages
      ? { watchQueued: (key, listener) => watchHeld(registry.heldMessages!, key, listener) }
      : {}),
    // As the chat view's /btw asks one: of the chat's session, started first
    // when there is none, as a send would start it, and kept out of the chat.
    async askSideQuestion(key, deviceId, questionId, question, history) {
      const asked = JSON.stringify([deviceId, questionId])
      if (sideQuestions.has(asked)) return { ok: false, message: 'That side question is already being answered.' }
      const pending = { calledOff: false }
      sideQuestions.set(asked, pending)
      const cancelled = { ok: false, cancelled: true, message: 'The side question was called off.' } as const
      try {
        const started = await ensureSession(key)
        if (pending.calledOff) return cancelled
        if (!started.ok) return { ok: false, message: started.message }
        const requestId = randomUUID()
        sideQuestions.set(asked, { sessionId: started.session.sessionId, requestId })
        return await runtime.askSideQuestion({
          sessionId: started.session.sessionId,
          requestId,
          question,
          ...(history.length ? { history } : {}),
        })
      } finally {
        sideQuestions.delete(asked)
      }
    },
    async cancelSideQuestion(deviceId, questionId) {
      const asked = sideQuestions.get(JSON.stringify([deviceId, questionId]))
      if (!asked) return { ok: false, message: 'That side question is not being answered.' }
      if ('calledOff' in asked) {
        asked.calledOff = true
        return { ok: true }
      }
      return runtime.cancelSideQuestion(asked)
    },
    // Asked of the live session's agent only: opening the ring is not a
    // reason to start one, here any more than in a window.
    async contextBreakdown(key) {
      const live = sessionFor(key)
      if (!live)
        return {
          ok: false,
          reason: 'not-running',
          message: 'The agent is not running for this chat now. Send a message and it can say what fills the window.',
        }
      return runtime.readContextBreakdown({ sessionId: live.sessionId })
    },
    ...(registry.scheduledSends
      ? { watchScheduled: (key, listener) => watchHeld(registry.scheduledSends!, key, listener) }
      : {}),
    ...(registry.usageLimits
      ? { watchUsageLimits: (key, listener) => watchHeld(registry.usageLimits!, key, listener) }
      : {}),
    command(key, deviceId, commandId, command, fingerprint) {
      if (command.kind === 'setModel') return setModel(key, commandId, command.modelId, fingerprint)
      if (command.kind === 'fork') return fork(key, deviceId, commandId, command)
      if (command.kind === 'setReasoningEffort') return setReasoningEffort(key, command.effort)
      if (command.kind === 'restartSession') return restartSession(key, deviceId, commandId)
      const held = registry.heldMessages
      const chat = { workspaceId: key.workspaceId, agentId: key.agentId }
      if (command.kind === 'scheduleSend' || command.kind === 'sendScheduledNow' || command.kind === 'cancelScheduled')
        return Promise.resolve(scheduledCommand(chat, deviceId, commandId, command))
      if (command.kind === 'usageLimitResume')
        return Promise.resolve(
          once(deviceId, commandId, () =>
            registry.usageLimits
              ? registry.usageLimits.update(chat, command.action, command.always === true)
              : { ok: false, message: 'This desktop does not resume chats from another device.' },
          ),
        )
      if (command.kind === 'cancelQueued')
        return Promise.resolve(
          held ? held.cancel(chat, command.queuedId) : { ok: false, message: 'This desktop holds no queued messages.' },
        )
      // As this machine's own Edit from here and Revert: the runtime refuses
      // either in words while a turn runs, and neither needs a live session,
      // so neither resumes a chat at rest: after a rewind, the next message,
      // from either machine, starts from where the chat went back to.
      if (command.kind === 'rewind')
        return receipted(key, deviceId, commandId, async () => {
          const rewound = await api.rewindToTurn({ key, turnSeq: command.turnSeq })
          return rewound.ok ? { ok: true } : { ok: false, message: rewound.message }
        })
      // A preview changes no file, and is run again for each ask.
      if (command.kind === 'revert')
        return command.confirmed
          ? receipted(key, deviceId, commandId, () => revert(key, command))
          : revert(key, command)
      // As this machine's own Handoff, which needs no live session either: it
      // lets the session go. The file it writes stays here, so only whether it
      // went is said.
      if (command.kind === 'handoff')
        return receipted(key, deviceId, commandId, async () => {
          const handed = await runtime.handoffConversation({ key })
          return handed.ok ? { ok: true } : { ok: false, message: handed.message }
        })
      // A message written long ago that the person has not confirmed is not
      // held either: held now, it would go the moment the chat is free, which
      // is the late send the refusal is for. The runtime asks the same of a
      // send it runs, after its receipts.
      const staleHold = (): ConversationGatewayCommandResult | null =>
        command.kind === 'send' && isStaleConversationSend(command, Date.now())
          ? {
              ok: false,
              code: 'stale',
              message: 'This message was written a while ago and was not sent. Send it again to send it now.',
            }
          : null
      // A queued message is held here and sent from here when the turn ends,
      // answered as soon as it is held: no session is resumed for it now, and
      // nothing waits on the turn. Held under the device's own command, so a
      // repeat after a dropped connection, or after a restart, holds it once.
      if (command.kind === 'send' && command.queue && held)
        return Promise.resolve(staleHold() ?? held.hold(chat, command.message, JSON.stringify([deviceId, commandId])))
      // A steer the running turn cannot take is held for the turn's end, as a
      // queued send is, and answered at once with a notice saying so: the
      // person's words are never lost to a provider that cannot take them, or
      // to a turn that ended on their way. A held message is its words alone,
      // so one with pictures, skills or mentions is refused busy instead,
      // which a phone sends again as it does any send made mid-turn.
      const steer = command.kind === 'send' && command.steer === true
      const holdInstead = (reason: string): ConversationGatewayCommandResult => {
        // Nor one in a mode of its own: held, it would go in the default one.
        if (
          command.kind !== 'send' ||
          !held ||
          command.uploadIds?.length ||
          command.skills?.length ||
          command.mentions?.length ||
          command.mode
        )
          return { ok: false, code: 'busy', retryAfterMs: SEND_BUSY_RETRY_MS, message: reason }
        const stale = staleHold()
        if (stale) return stale
        const holding = held.hold(chat, command.message, JSON.stringify([deviceId, commandId]))
        return holding.ok
          ? { ok: true, notice: `${reason.replace(/\.$/u, '')}, so it is queued and goes when this turn ends.` }
          : holding
      }
      // Whether there is a turn for a steer to join. Without one it is an
      // ordinary send, and waits its turn behind any send being prepared.
      const live = steer ? sessionFor(key) : undefined
      const joinsTurn = live?.status === 'active' || live?.status === 'awaiting_approval'
      // Not asked of a provider that cannot take one: the runtime would only
      // refuse it, after resolving its skills and mentions.
      if (joinsTurn && live?.capabilities?.steer !== true)
        return Promise.resolve(holdInstead('This agent cannot take a message while it is working.'))
      const stamp = fingerprint ? { commandFingerprint: fingerprint } : {}
      const execute = async (): Promise<ConversationGatewayCommandResult> => relay(await run())
      const run = async (): Promise<ConversationGatewayCommandResult | ConversationSessionActionResult> => {
        // An upload names the session the list showed, which a resume below
        // may replace (a failed turn's session is listed, but a send resumes
        // the chat on a new one, and the runtime forgets the old): read before
        // that, any session of this chat will do.
        const listedForChat = api.listSessions({ workspaceId: key.workspaceId, agentId: key.agentId })
        const chatSessions = new Set(
          listedForChat.ok
            ? listedForChat.sessions
                .filter((entry) => entry.workspaceId === key.workspaceId && entry.agentId === key.agentId)
                .map((entry) => entry.sessionId)
            : [],
        )
        let session = sessionFor(key)
        // A send, or a preset switch, reaches a conversation with no live
        // session by resuming it; the switch then applies to that session.
        if (!session && (command.kind === 'send' || command.kind === 'setPermissionPreset')) {
          const resumed = await ensureSession(key)
          if (!resumed.ok) return resumed
          session = resumed.session
        }
        // Its servers run with its agent, so a chat at rest is not resumed to
        // reach them, as its own server rows offer nothing then either.
        if (!session && command.kind === 'mcpServerAction')
          return { ok: false, message: 'This chat has no agent running. Send it a message, then try again.' }
        if (!session) return { ok: false, message: 'Conversation is unavailable.' }
        switch (command.kind) {
          case 'send': {
            // Only a level the chat's provider runs, as the chat view checks it.
            const effort = registry.reasoningEffortOf?.(key) ?? undefined
            const turnEffort =
              effort && session.capabilities?.reasoningEfforts?.includes(effort) ? { reasoningEffort: effort } : {}
            const ids = command.uploadIds ?? []
            if (ids.length > MAX_ATTACHMENTS_PER_TURN) return { ok: false, message: 'Too many attachments.' }
            // Skills the paired machine's composer attached, resolved against
            // this machine's folder as its own chips are (conversation-skills.ts).
            const turnSkills = command.skills?.length ? { skills: command.skills.map((id) => ({ id })) } : {}
            // Files and folders the paired machine's composer mentioned, by
            // their paths in the chat's folder here: the runtime resolves them
            // against the session's folder as it does its own composer's, and
            // refuses one outside it, behind a link, or gone.
            const turnMentions = command.mentions?.length ? { mentions: command.mentions } : {}
            const retry =
              ids.length > 0 &&
              ids.every((id) => spent.get(id)?.deviceId === deviceId && spent.get(id)?.commandId === commandId)
            // Into the running turn, where there is one; with none, the runtime
            // sends it as the next turn, as an ordinary send.
            const turnSteer = steer ? { steer: true } : {}
            // When the person wrote it, and whether they confirmed one written
            // long ago: the runtime refuses an unconfirmed old one and records
            // the time on the message.
            const written = {
              ...(command.composedAt !== undefined ? { composedAt: command.composedAt } : {}),
              ...(command.confirmedStale ? { confirmedStale: true } : {}),
            }
            // The mode the device's chat sends the turn in, as this machine's
            // own chat does; the runtime refuses `plan` for a provider that
            // does not plan.
            const turnMode = command.mode ? { mode: command.mode } : {}
            if (retry)
              return api.send({
                sessionId: session.sessionId,
                commandId,
                message: command.message,
                attachments: [],
                ...turnEffort,
                ...turnSkills,
                ...turnMentions,
                ...turnSteer,
                ...turnMode,
                ...written,
                ...stamp,
                ...(registry.sendOrigin ? { origin: registry.sendOrigin } : {}),
              })
            chatSessions.add(session.sessionId)
            const attachments: ConversationImageAttachment[] = []
            const files: ConversationAttachedFile[] = []
            for (const id of ids) {
              const upload = uploads.get(id)
              if (upload?.kind === 'file') {
                if (
                  upload.deviceId !== deviceId ||
                  !chatSessions.has(upload.sessionId) ||
                  Date.now() - upload.at > UPLOAD_TTL_MS
                )
                  return { ok: false, message: 'File upload reference is unavailable.' }
                // The file is attached by path, so it must still be the one
                // that was received: not removed, replaced or grown since.
                const present = await stat(upload.path).catch(() => null)
                if (!present?.isFile() || present.size !== upload.bytes)
                  return { ok: false, message: 'File upload changed after receipt.' }
                files.push({ path: upload.path })
                continue
              }
              if (
                !upload ||
                upload.deviceId !== deviceId ||
                !chatSessions.has(upload.sessionId) ||
                !ATTACHABLE_IMAGE_TYPES.includes(upload.mediaType as (typeof ATTACHABLE_IMAGE_TYPES)[number]) ||
                upload.bytes > MAX_ATTACHMENT_BYTES ||
                Date.now() - upload.at > UPLOAD_TTL_MS
              ) {
                return { ok: false, message: 'Image upload reference is unavailable.' }
              }
              let bytes: Buffer
              try {
                bytes = await readBoundedConversationUpload(upload.path, upload.bytes)
              } catch {
                return { ok: false, message: 'Image upload changed after receipt.' }
              }
              attachments.push({
                id,
                mediaType: upload.mediaType,
                dataBase64: bytes.toString('base64'),
                name: upload.name,
                byteLength: bytes.length,
              })
            }
            // A message from a paired device is the person speaking, as one
            // typed here is: the chat moves up the desktop's own list, and every
            // list ordered by that clock, at once. Stamped when the chat takes
            // it, which its `user_message` says, not when the send is answered,
            // which is when its turn ends; and never for a send turned away (a
            // phone sends again every second while a turn runs, and a message
            // it gave up on would still wake a settled chat).
            const noteUserMessage = registry.noteUserMessage
            const sessionId = session.sessionId
            // A steer's send settles when the turn it opened ends, so it can
            // fail after its message is in the chat; that one is not held a
            // second time.
            let landed = false
            const stopWatching: (() => unknown) | null =
              noteUserMessage || steer
                ? runtime.onEvent((event) => {
                    if (event.type !== 'user_message' || event.sessionId !== sessionId) return
                    if (event.payload?.commandId !== commandId) return
                    landed = true
                    stopWatching?.()
                    noteUserMessage?.(key.workspaceId, event.createdAt > 0 ? event.createdAt : Date.now())
                  })
                : null
            let sent: ConversationSessionActionResult
            try {
              sent = await api.send({
                sessionId,
                commandId,
                message: command.message,
                attachments,
                ...(files.length ? { files } : {}),
                ...turnEffort,
                ...turnSkills,
                ...turnMentions,
                ...turnSteer,
                ...turnMode,
                ...written,
                ...stamp,
                ...(registry.sendOrigin ? { origin: registry.sendOrigin } : {}),
              })
            } finally {
              stopWatching?.()
            }
            // Accepted: the images are in the turn now, so their staged files
            // are removed rather than left for the hour-long expiry, and the
            // files are the message's, so only their references go. A refused
            // send keeps both for a retry.
            if (sent.ok) {
              for (const id of ids) {
                spendUpload(id)
                spent.set(id, { deviceId, commandId })
              }
              while (spent.size > MAX_SPENT_UPLOAD_REFS) spent.delete(spent.keys().next().value!)
            }
            if (!sent.ok && steer) {
              // In the chat already, and its turn then failed: the message was
              // taken, and what became of the turn is in the transcript. Said
              // as a refusal, a client would send the same words again.
              if (landed)
                return { ok: true, notice: `It reached the agent, and then: ${sent.message.replace(/\.$/u, '')}.` }
              // The turn could not take it (one awaiting an answer, one that
              // ended on the way): it waits for the turn's end instead.
              return holdInstead(sent.message)
            }
            return sent
          }
          case 'interrupt':
            return api.interrupt({ sessionId: session.sessionId, commandId, ...stamp })
          // One agent, as its Stop on this machine stops it: never a resume,
          // since an agent runs only in a live session. Sent twice, the second
          // finds it ended and is refused in words, which changes nothing.
          case 'stopSubagent':
            return runtime.stopSubagent({ sessionId: session.sessionId, toolUseId: command.toolUseId })
          // As the chat's server row on this machine does it, refused for an
          // action its provider does not take. Sent twice, a reconnect
          // reconnects again and a switch finds the server where it left it.
          case 'mcpServerAction': {
            const done = await runtime.mcpServerAction({
              sessionId: session.sessionId,
              serverId: command.serverId,
              action: command.action,
            })
            return done.ok ? { ok: true } : { ok: false, message: done.message }
          }
          case 'resolveApproval':
            return api.resolveApproval({
              sessionId: session.sessionId,
              commandId,
              requestId: command.requestId,
              approved: command.decision !== 'deny',
              decision: command.decision,
              ...stamp,
            })
          case 'answerQuestion':
            return api.answerQuestion({
              sessionId: session.sessionId,
              commandId,
              requestId: command.requestId,
              approved: true,
              answers: command.answers,
              ...stamp,
            })
          // A plan's own answer, refused for a request that is not a plan.
          // A plan answered as a `resolveApproval`, as before this command
          // existed, is still taken.
          case 'resolvePlan':
            return api.resolveApproval({
              sessionId: session.sessionId,
              commandId,
              requestId: command.requestId,
              approved: command.decision === 'approve',
              requestKind: 'plan',
              ...stamp,
            })
          case 'setPermissionPreset': {
            // A mode that is no mode id of a CLI's own is dropped, and the
            // preset's own mode runs, as a client from before modes gets.
            const permissionMode = parseCliPermissionModeId(command.permissionMode)
            const applied = await api.setPermissionPreset({
              sessionId: session.sessionId,
              commandId,
              permissionPreset: command.preset,
              ...(permissionMode ? { permissionMode } : {}),
              ...stamp,
            })
            if (applied.ok)
              registry.writeAgentChoice?.(key, {
                cliPermissionPreset: command.preset,
                cliPermissionMode: permissionMode ?? undefined,
              })
            return applied
          }
        }
      }
      // Approval responses and interrupts must stay available while a send is
      // waiting on them. Only turn preparation is serialized and deduplicated.
      if (command.kind !== 'send') return execute()
      const id = JSON.stringify([key.workspaceId, key.agentId])
      // A steer goes beside the send whose turn it joins, which is still
      // waiting on that turn here: queued behind it, it would wait for the
      // very end it was sent to beat. With no turn running yet, a send being
      // prepared goes first, and the steer is busy behind it, as a send is.
      const beside = steer && joinsTurn
      const pending = beside ? undefined : sending.get(id)
      if (pending)
        return pending.commandId === commandId && pending.deviceId === deviceId
          ? pending.promise
          : // Busy, not failed: a phone queues the message and sends it again.
            Promise.resolve({
              ok: false,
              code: 'busy',
              retryAfterMs: SEND_BUSY_RETRY_MS,
              message: 'A conversation send is already in progress.',
            })
      const hasImages = Boolean(command.uploadIds?.length)
      if (hasImages && imageSends >= 2)
        return Promise.resolve({
          ok: false,
          code: 'busy',
          retryAfterMs: SEND_BUSY_RETRY_MS,
          message: 'Image sends are busy. Please retry shortly.',
        })
      if (hasImages) imageSends++
      const promise = execute().finally(() => {
        if (sending.get(id)?.promise === promise) sending.delete(id)
        if (hasImages) imageSends--
      })
      if (!beside) sending.set(id, { commandId, deviceId, promise })
      return promise
    },
  }
}
