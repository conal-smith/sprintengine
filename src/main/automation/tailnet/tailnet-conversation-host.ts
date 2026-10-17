import {
  CONVERSATION_DEFAULT_MODEL_ID,
  CONVERSATION_MAX_REPLY_PREVIEW,
  type ConversationCommand,
  type ConversationQueuedMessage,
  type ConversationThread,
  type ConversationWireErrorCode,
  type ConversationWireHost,
  type ConversationWirePullRequest,
  type ConversationWireModels,
} from '../../../../packages/conversation-protocol/src/public'
import { isPlaceholderAgentName } from '../../../shared/agent-names'
import { isSettledWorkspace, workspaceLastUserMessageAt } from '../../../shared/workspace-lifecycle'
import type {
  ConversationKey,
  ConversationImageAttachment,
  ConversationMessageOrigin,
  ConversationPermissionPreset,
  ConversationSessionActionResult,
  ConversationSessionFrame,
  ConversationSessionSummary,
  ConversationSubscribeInput,
} from '../../../shared/conversation-runtime'
import type { ConversationBackend } from '../../../server/core/conversation-backend'
import type { ConversationModelCatalog } from '../../conversation-model-catalog'
import { ConversationSessionApi } from '../../conversation-session-api'
import { latestTurnEnd } from '../conversation-lifecycle'
import { randomUUID } from 'node:crypto'
import { DEFAULT_AGENT_SPAWN_PERMISSION_PRESET } from '../../../shared/launch-settings'
import { parseCliPermissionModeId } from '../../../shared/cli-permission-mode'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import type { ConversationAttachedFile } from '../../../shared/conversation/attachedFiles'
import { openConfinedExistingFile } from '../../conversation-file-access'
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
const wireCapabilities = (session: ConversationSessionSummary) =>
  session.capabilities
    ? {
        images: session.capabilities.images,
        approvals: session.capabilities.approvals,
        questions: session.capabilities.questions,
        planMode: session.capabilities.planMode,
        interrupt: session.capabilities.interrupt,
        checkpoints: session.capabilities.checkpoints === true,
        ...(session.capabilities.permissionPresets
          ? { permissionPresets: [...session.capabilities.permissionPresets] }
          : {}),
        ...(session.capabilities.permissionModes ? { permissionModes: [...session.capabilities.permissionModes] } : {}),
        // Whether a `send` that says `steer` can go into the turn now running
        // (`conversation-steer-sends`); a client offers Steer only where it can.
        steer: session.capabilities.steer === true,
      }
    : undefined

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
 * A runtime answer as a command's result. Two refusals the runtime names by a
 * code are kept: a command id already used for a different command, and
 * `busy` with its delay (a send that arrived while a turn runs, which the
 * device sends again). The commands built here name none other, and the
 * runtime's words stay in the message.
 */
function relay(
  result: ConversationGatewayCommandResult | ConversationSessionActionResult,
): ConversationGatewayCommandResult {
  if (result.ok || result.code === undefined || result.code === 'command_id_conflict' || result.code === 'busy')
    return result as ConversationGatewayCommandResult
  const { code: _unnamed, ...rest } = result
  return rest as ConversationGatewayCommandResult
}

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
  /** This machine's own kind and colour. */
  selfMachine?: () => { kind: string; color: string }
  /**
   * The branch each workspace's folder is checked out on, keyed by workspace
   * id; a folder that is not a repository, or sits on a detached HEAD, is
   * left out. Read from the checkout's HEAD file, remembered against it, so a
   * list asked for again runs no git.
   */
  branchesOf?: (workspaceIds: string[]) => Promise<Map<string, string>>
}

const restingRecord = (record: ConversationListWorkspace | null): boolean =>
  record !== null && isSettledWorkspace(record)

const epoch = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/** When the turn a live session is running began, left out between turns. */
function turnStartOf(summary: ConversationSessionSummary | undefined): Pick<ConversationThread, 'turnStartedAt'> {
  return epoch(summary?.turnStartedAt) ? { turnStartedAt: Math.trunc(summary.turnStartedAt) } : {}
}

/** A listed chat's lifecycle members, each left out when there is nothing true to say. */
function lifecycleOf(
  record: ConversationListWorkspace | null,
  lastTurnEndedAt: number | undefined,
): Pick<
  ConversationThread,
  'chatTitle' | 'lastUserMessageAt' | 'lastTurnEndedAt' | 'lastVisitedAt' | 'visitRewoundAt'
> {
  const chatTitle = record?.name.trim()
  return {
    ...(chatTitle ? { chatTitle } : {}),
    ...(epoch(record?.lastUserMessageAt) ? { lastUserMessageAt: record.lastUserMessageAt } : {}),
    ...(lastTurnEndedAt !== undefined ? { lastTurnEndedAt } : {}),
    ...(epoch(record?.lastVisitedAt) ? { lastVisitedAt: record.lastVisitedAt } : {}),
    // Read only from the record, which only Mark unread's own command stamps.
    ...(epoch(record?.visitRewoundAt) ? { visitRewoundAt: record.visitRewoundAt } : {}),
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
}

/**
 * One chat's held messages, told now and again on each change that touches
 * them: every chat's changes arrive on the one channel, and a follower is told
 * only when its own chat's list reads differently.
 */
function watchHeld(
  held: ConversationHeldMessages,
  chat: ChatOf,
  listener: (messages: ConversationQueuedMessage[]) => void,
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
  // The machine once per workspace, and the pull requests in one read of the
  // record for the whole list. A failed read leaves the rows without them, as
  // from a desktop that never listed them: the list itself still answers.
  const withMarks = async (listed: ConversationThread[]): Promise<ConversationThread[]> => {
    if (!marks.machineOf && !marks.machineReader && !marks.pullRequestsOf && !marks.branchesOf) return listed
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
    let branches: Map<string, string> | null = null
    if (marks.branchesOf && listed.length > 0) {
      branches = await marks.branchesOf([...new Set(listed.map((thread) => thread.workspaceId))]).catch(() => null)
    }
    return listed.map((thread) => {
      const host = machineOf(thread.workspaceId)
      const branch = branches?.get(thread.workspaceId)
      return {
        ...thread,
        ...(host ? { host } : {}),
        ...(branch ? { branch } : {}),
        ...(pullRequests ? { pullRequests: pullRequests.get(`${thread.workspaceId}:${thread.agentId}`) ?? [] } : {}),
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
            ...(summary ? { sessionId: summary.sessionId, capabilities: wireCapabilities(summary) } : {}),
            ...turnStartOf(summary),
            ...lifecycleOf(recordOf(workspace.workspaceId), latestTurnEnd(sessions, key, thread.lastTurnEndedAt)),
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
          capabilities: wireCapabilities(summary),
          ...turnStartOf(summary),
          ...lifecycleOf(recordOf(summary.workspaceId), latestTurnEnd(sessions, summary)),
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
        return { ok: true, path: isAbsolute(path) ? path : resolve(sessionRoot || key.workspaceRoot, path) }
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
    command(key, deviceId, commandId, command, fingerprint) {
      if (command.kind === 'setModel') return setModel(key, commandId, command.modelId, fingerprint)
      const held = registry.heldMessages
      const chat = { workspaceId: key.workspaceId, agentId: key.agentId }
      if (command.kind === 'cancelQueued')
        return Promise.resolve(
          held ? held.cancel(chat, command.queuedId) : { ok: false, message: 'This desktop holds no queued messages.' },
        )
      // A queued message is held here and sent from here when the turn ends,
      // answered as soon as it is held: no session is resumed for it now, and
      // nothing waits on the turn. Held under the device's own command, so a
      // repeat after a dropped connection holds it once.
      if (command.kind === 'send' && command.queue && held)
        return Promise.resolve(held.hold(chat, command.message, JSON.stringify([deviceId, commandId])))
      // A steer the running turn cannot take is held for the turn's end, as a
      // queued send is, and answered at once with a notice saying so: the
      // person's words are never lost to a provider that cannot take them, or
      // to a turn that ended on their way. A held message is its words alone,
      // so one with pictures or skills is refused busy instead, which a phone
      // sends again as it does any send made mid-turn.
      const steer = command.kind === 'send' && command.steer === true
      const holdInstead = (reason: string): ConversationGatewayCommandResult => {
        if (command.kind !== 'send' || !held || command.uploadIds?.length || command.skills?.length)
          return { ok: false, code: 'busy', retryAfterMs: SEND_BUSY_RETRY_MS, message: reason }
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
            const retry =
              ids.length > 0 &&
              ids.every((id) => spent.get(id)?.deviceId === deviceId && spent.get(id)?.commandId === commandId)
            // Into the running turn, where there is one; with none, the runtime
            // sends it as the next turn, as an ordinary send.
            const turnSteer = steer ? { steer: true } : {}
            if (retry)
              return api.send({
                sessionId: session.sessionId,
                commandId,
                message: command.message,
                attachments: [],
                ...turnEffort,
                ...turnSkills,
                ...turnSteer,
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
                ...turnSteer,
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
