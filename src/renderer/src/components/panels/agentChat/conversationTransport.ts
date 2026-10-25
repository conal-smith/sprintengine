import { createContext, useContext } from 'react'

import { windowStudioClient } from '../../../studio/windowStudioClient'
import { ipcChatServices, type ChatServices } from './chatServices'
import { createStudioChatServices, createStudioConversationParts } from './studioChat'
import { remotePullRequestHost, type PullRequestHost } from './pullRequestHost'
import type {
  ConversationAttachmentInput,
  ConversationAttachmentResult,
  ConversationForkInput,
  ConversationForkResult,
  ConversationInterruptInput,
  ConversationLoadEarlierInput,
  ConversationPageResult,
  ConversationRespondToRequestInput,
  ConversationRevertInput,
  ConversationRevertResult,
  ConversationRewindInput,
  ConversationHandoffInput,
  ConversationHandoffResult,
  ConversationMcpServerActionInput,
  ConversationMcpServerActionResult,
  ConversationRewindResult,
  ConversationSendTurnInput,
  ConversationSessionFrame,
  ConversationSessionSummary,
  ConversationSetModelInput,
  ConversationStopSubagentInput,
  ConversationCancelSideQuestionInput,
  ConversationContextBreakdownInput,
  ConversationContextBreakdownResult,
  ConversationSideQuestionInput,
  ConversationSideQuestionResult,
  ConversationSetPermissionInput,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationSubscribeInput,
  ConversationToolDetailInput,
  ConversationToolDetailResult,
  ConversationTurnDiffInput,
  ConversationTurnDiffResult,
} from '../../../../../shared/conversation-runtime'
import { parseConversationRevertAnswer } from '../../../../../../packages/conversation-protocol/src/public'
import type { ConversationCommandCatalog } from '../../../../../shared/conversation/commands'
import type { ConversationFileSearchEntry } from '../../../../../../packages/conversation-protocol/src/public'
import type {
  MeshConversationAccess,
  MeshConversationCommandResult,
  MeshConversationKey,
  MeshConversationLink,
  MeshQueuedMessage,
} from '../../../../../shared/tailnet-mesh'

// Where a chat view's conversation lives. The view — its transcript, pending
// dock, composer — is the same whether the conversation runs on this machine
// or on a paired one; only the calls behind it differ. The local transport is
// the conversation IPC; a remote one is the Mesh's, which follows the
// conversation over the tailnet from main.
//
// What a transport cannot do is said by its capabilities, not inferred from a
// provider id: a remote device may not choose a permanent approval rule or a
// bypass preset, reverts a checkpoint on the other machine's disk only where
// that machine does it, and has none of this machine's skills, files or
// history index to offer.
//
// A conversation on this machine is reached one of two ways, chosen once per
// window (`window.api.studioChatTransport`): the conversation IPC, or the
// Studio protocol over the window's Studio client. Both answer every call
// with the same shapes, and the chat view cannot tell them apart. The IPC is
// the default while the protocol path has its release beside it.

export type ConversationTransportCapabilities = {
  /** Send, stop, answer approvals and questions, change the preset. */
  operate: boolean
  /** Start a provider session here before the first send. A remote send resumes one over there. */
  startSession: boolean
  /** Offer "always allow" rules, which outlive the conversation. */
  permanentApprovals: boolean
  /**
   * Revert a turn's files from its checkpoint. A paired machine's chat does,
   * in that machine's checkout, where it advertises doing so
   * (`conversation-checkpoint-revert`).
   */
  checkpointRevert: boolean
  /**
   * Pick another model of the chat's CLI: before the first turn, and — where
   * the provider declares `liveModelSwitch` — mid-conversation too.
   */
  modelSwitch: boolean
  /** Attach skills and mention files from this machine. */
  composerContext: boolean
  /**
   * Mention files and folders of the chat's folder (@). Here, this machine's,
   * searched on this disk; on a paired machine, that machine's, searched there
   * through `searchMentions`, where it advertises the search and takes the
   * mentions (`conversation-file-search`, `conversation-send-mentions`).
   */
  mentions: boolean
  /**
   * Attach files of any type by their path on this computer. Here the agent
   * reads each where it is; for a paired machine each goes up to it with the
   * message, where it advertises taking files (`conversation-message-files`).
   */
  attachFiles: boolean
  /**
   * The `/` menu lists what the chat's CLI runs in the chat's folder. Here,
   * asked of this machine; on a paired machine, of that machine through
   * `listCommands`, where it advertises the list (`conversation-commands`).
   */
  commandList: boolean
  /**
   * Carry the images a message attaches to wherever the chat runs. Offered
   * only where the session says its provider reads them (`capabilities.images`).
   * A paired machine's chat carries them too: main puts each in that
   * machine's upload store, as the phone does, and the send names them.
   */
  imageAttachments: boolean
  /** The local history index: the editable title, cost, search. */
  localHistory: boolean
  /** Paths in the transcript name files on this machine's disk. */
  localFiles: boolean
  /** The runtime echoes an optimistic turn's id back on its `user_message`. */
  optimisticTurns: boolean
  /**
   * The session's permission preset is known before a session reports it. A
   * remote one is known only once the machine's list names it — a desktop
   * built before the list carried it never does — and a picker showing a guess
   * would be worse than none.
   */
  reportsPreset: boolean
  /**
   * The chat takes all four permission presets. A paired machine built before
   * Manual and Auto came back reads either as No flag, so there only Bypass
   * and No flag are offered.
   */
  permissionModes: boolean
  /**
   * Hand a message to a turn that is running (a steer), where the provider
   * takes one. Without it, sending a queued message now stops the turn first.
   */
  steer: boolean
  /**
   * A message queued while the turn runs is handed at once to the machine the
   * chat runs on (`queue`), which holds it and sends it when the turn ends,
   * and which says what it holds. Without it the queue is this view's own,
   * sent from here when the turn ends — so only while this machine is awake.
   */
  hostQueue: boolean
  /**
   * Attach skills to a message. Here, the workspace's own; on a paired
   * machine, that machine's, listed through `remoteExtensions`, where it
   * advertises taking them (`conversation-send-skills`).
   */
  skills: boolean
  /**
   * The machine the chat runs on opens a pull request for it: Create PR asks
   * it through `pullRequestHost`, where it advertises that
   * (`chat-create-pull-request`). False here, where the chat's checkout is
   * this computer's and Create PR asks this computer's shell.
   */
  hostPullRequests: boolean
}

/** What an action answers: the local session API's result, or a remote command's. */
type ConversationTransportResult =
  | { ok: true; session?: ConversationSessionSummary; notice?: string }
  // `code` as the runtime names a refusal (`session_not_found`: the session is gone there).
  | { ok: false; message: string; code?: string }

export type ConversationTransport = {
  kind: 'local' | 'remote'
  /** The paired machine the conversation runs on, for a remote transport. */
  machineName?: string
  /** Where a remote chat's skills and MCP servers are listed: the machine and the project there. */
  remoteExtensions?: { connectionId: string; workspaceId: string }
  /**
   * What a remote chat's `/` list is kept under in this window, in place of a
   * folder (`remoteCommandsFolder`): no folder of this disk names it.
   */
  commandsFolder?: string
  /** Where a remote chat's Create PR does its work, used where `capabilities.hostPullRequests` is. */
  pullRequestHost?: PullRequestHost
  capabilities: ConversationTransportCapabilities
  subscribe(input: ConversationSubscribeInput, cb: (frame: ConversationSessionFrame) => void): () => void
  loadEarlier(input: ConversationLoadEarlierInput): Promise<ConversationPageResult>
  toolDetail(input: ConversationToolDetailInput): Promise<ConversationToolDetailResult>
  turnDiff(input: ConversationTurnDiffInput): Promise<ConversationTurnDiffResult>
  send(input: ConversationSendTurnInput): Promise<ConversationTransportResult>
  interrupt(input: ConversationInterruptInput): Promise<ConversationTransportResult>
  respond(input: ConversationRespondToRequestInput): Promise<ConversationTransportResult>
  setPermissionPreset(input: ConversationSetPermissionInput): Promise<ConversationTransportResult>
  /** Switch a running session's model; absent where the transport cannot. */
  setModel?(input: ConversationSetModelInput): Promise<ConversationTransportResult>
  /**
   * Set the reasoning effort the chat runs at from its next turn, on the
   * machine that keeps it; none is its provider's own default. Absent for a
   * chat here, whose record is the one the view writes and the runtime reads.
   * A paired machine's chat has it, offered where its session lists efforts,
   * which it does only where that machine takes the command
   * (`conversation-reasoning-effort`).
   */
  setReasoningEffort?(input: { sessionId: string; effort?: string }): Promise<ConversationTransportResult>
  /**
   * Hand a message to the machine the chat runs on, to hold until the turn
   * ends and send then; answered once it holds it. Used where
   * `capabilities.hostQueue` is.
   */
  queue?(input: { message: string }): Promise<ConversationTransportResult>
  /** Take back a message that machine holds, by its id there. */
  cancelQueued?(input: { queuedId: string }): Promise<ConversationTransportResult>
  /**
   * The files and folders in the chat's folder on the machine it runs on whose
   * names match `query`, by their paths relative to that folder. Present for a
   * paired machine's chat, used where `capabilities.mentions` is; a chat here
   * is searched through `services.files`.
   */
  searchMentions?(input: {
    query: string
  }): Promise<{ ok: true; entries: ConversationFileSearchEntry[] } | { ok: false; message: string }>
  /**
   * The slash commands the chat's CLI runs in its folder on the machine it
   * runs on, as that machine lists them; rejects with that machine's words
   * when it cannot. Present for a paired machine's chat, used where
   * `capabilities.commandList` is; a chat here reads `services.commands`.
   */
  listCommands?(input: { refresh?: boolean }): Promise<ConversationCommandCatalog>
  /**
   * A sent image by the reference its `user_message` recorded. A remote
   * conversation's are in the other machine's store, and are asked of it
   * (`conversation-message-images`); a machine that does not serve them
   * answers that it cannot, and the bubble says the image is over there.
   */
  attachment?(input: ConversationAttachmentInput): Promise<ConversationAttachmentResult>
  /**
   * Take the conversation back to before one of its user messages ("Edit
   * from here"). A paired machine's chat has it too, and its session declares
   * `rewind` only where that machine takes the command (`conversation-rewind`).
   * Offered only where the session declares `rewind` as well.
   */
  rewind?(input: ConversationRewindInput): Promise<ConversationRewindResult>
  /**
   * Hand the chat off to a fresh session pointed at a file of its messages,
   * instead of compacting it. A paired machine's chat has it too, and its
   * session declares `handoff` only where that machine takes the command
   * (`conversation-handoff`). Offered only where the session declares
   * `handoff` as well.
   */
  handoff?(input: ConversationHandoffInput): Promise<ConversationHandoffResult>
  /**
   * Start a new chat beside this one holding it up to an earlier message
   * ("Fork from here"). Absent where the transport cannot. A paired machine's
   * chat has it: the fork is made over there, beside the chat, and opens
   * here as a pane of its own onto that machine (`forkRemoteChat`); its
   * session declares `fork` only where that machine takes the command
   * (`conversation-fork`). The key a remote fork is handed is not the one it
   * forks: it names the chat by its ids over there. Offered only where the
   * session declares `fork` as well.
   */
  fork?(input: ConversationForkInput): Promise<ConversationForkResult>
  /**
   * A step's picture as a data URL, asked of the machine the conversation runs
   * on by the step's id. Absent for a local chat, which reads it off this disk.
   * `unsupported` is a machine that does not serve pictures: the picture stays
   * over there.
   */
  toolImage?(input: { toolUseId: string }): Promise<ConversationToolImageResult>
  /** Start the chat's provider session here. Present where `capabilities.startSession` is. */
  startSession?(input: ConversationStartSessionInput): Promise<ConversationStartSessionResult>
  /** Revert a turn's files from its checkpoint, or preview that. Used where `capabilities.checkpointRevert` is. */
  revert?(input: ConversationRevertInput): Promise<ConversationRevertResult>
  /**
   * Stop one running agent the chat spawned, by its lane, leaving the chat and
   * its turn running. Absent where the transport cannot: a window on the
   * Studio protocol, which has no method for it yet. A paired machine's chat
   * has it, and its session declares `stopSubagent` only where that machine
   * takes the command (`conversation-stop-subagent`). Offered only where the
   * session declares `stopSubagent` as well.
   */
  stopSubagent?(input: ConversationStopSubagentInput): Promise<ConversationTransportResult>
  /**
   * Restart the chat's agent on the machine it runs on, as Restart agent
   * session does for a chat here (which suspends its session through the
   * conversation IPC itself): answered with a `notice` where it had none
   * running, and nothing was done. A paired machine's chat has it, refused in
   * words for a machine that does not take the command
   * (`conversation-restart-session`).
   */
  restartSession?(): Promise<ConversationTransportResult>
  /**
   * Reconnect, switch or sign in to one of a live chat's MCP servers, where
   * the session lists the action (`capabilities.mcpServerActions`). A paired
   * machine's chat has it too, its session listing an action only where that
   * machine takes the command (`conversation-mcp-server-actions`), and never
   * a sign-in, whose callback that machine's CLI waits for there.
   */
  mcpServerAction?(input: ConversationMcpServerActionInput): Promise<ConversationMcpServerActionResult>
  /**
   * Ask a side question about the chat: answered from its context, added to
   * nothing, a running turn left as it was. Absent where the transport
   * cannot, as `stopSubagent` is. A paired machine's chat has it, asked of
   * its agent over there, and its session declares `sideQuestion` only where
   * that machine answers one (`conversation-side-questions`). Offered only
   * where the session declares `sideQuestion` as well.
   */
  askSideQuestion?(input: ConversationSideQuestionInput): Promise<ConversationSideQuestionResult>
  /** Call off a side question still being answered. Present wherever `askSideQuestion` is. */
  cancelSideQuestion?(
    input: ConversationCancelSideQuestionInput,
  ): Promise<{ ok: true } | { ok: false; message: string }>
  /**
   * What fills the chat's context window, as its agent measures it. Absent
   * where the transport cannot ask, as `stopSubagent` is; the ring then opens
   * on the total alone. A paired machine's chat has it, read from its agent
   * over there, and its session declares `contextBreakdown` only where that
   * machine says (`conversation-context-breakdown`). Asked only where the
   * session declares `contextBreakdown` as well.
   */
  readContextBreakdown?(input: ConversationContextBreakdownInput): Promise<ConversationContextBreakdownResult>
  /**
   * The Studio this window belongs to: providers, files, plans and command
   * lists. The same for every chat in the window, whichever machine it runs on.
   */
  services: ChatServices
}

export type ConversationToolImageResult =
  { ok: true; src: string } | { ok: false; unsupported: boolean; message: string }

const LOCAL_CAPABILITIES: ConversationTransportCapabilities = {
  operate: true,
  startSession: true,
  permanentApprovals: true,
  checkpointRevert: true,
  modelSwitch: true,
  composerContext: true,
  mentions: true,
  attachFiles: true,
  commandList: true,
  imageAttachments: true,
  localHistory: true,
  localFiles: true,
  optimisticTurns: true,
  reportsPreset: true,
  permissionModes: true,
  steer: true,
  // The chat runs here: its queue is on the machine that sends it already.
  hostQueue: false,
  skills: true,
  hostPullRequests: false,
}

type LocalParts = Omit<ConversationTransport, 'kind' | 'capabilities' | 'services'>

/** The conversation IPC, read off `window.api` at call time so a test's stub is the one used. */
const ipcConversationParts: Required<
  Pick<LocalParts, 'setModel' | 'attachment' | 'rewind' | 'handoff' | 'fork' | 'startSession' | 'revert'>
> &
  LocalParts = {
  subscribe: (input, cb) => window.api.onConversationSession(input, cb),
  loadEarlier: (input) => window.api.conversationLoadEarlier(input),
  toolDetail: (input) => window.api.conversationToolDetail(input),
  turnDiff: (input) => window.api.conversationTurnDiff(input),
  send: (input) => window.api.conversationSessionSendTurn(input),
  interrupt: (input) => window.api.conversationSessionInterrupt(input),
  respond: (input) => window.api.conversationSessionRespondToRequest(input),
  setPermissionPreset: async (input) =>
    typeof window.api.conversationSessionSetPermission === 'function'
      ? window.api.conversationSessionSetPermission(input)
      : { ok: false, message: 'Changing tool permissions mid-conversation needs an app restart.' },
  setModel: (input) => window.api.conversationSessionSetModel(input),
  attachment: (input) => window.api.conversationAttachment(input),
  rewind: (input) => window.api.conversationRewindToTurn(input),
  handoff: (input) => window.api.conversationHandoff(input),
  fork: (input) => window.api.conversationForkAtTurn(input),
  startSession: (input) => window.api.conversationSessionStart(input),
  revert: (input) => window.api.conversationRevertToTurn(input),
  stopSubagent: (input) => window.api.conversationSessionStopSubagent(input),
  askSideQuestion: (input) => window.api.conversationSessionAskSideQuestion(input),
  cancelSideQuestion: (input) => window.api.conversationSessionCancelSideQuestion(input),
  readContextBreakdown: (input) => window.api.conversationSessionContextBreakdown(input),
}

// One Studio implementation per window object, so its client and the
// subscriptions keyed by transport are this window's.
const studioImplementations = new WeakMap<object, { parts: LocalParts; services: ChatServices }>()

function studioImplementation(): { parts: LocalParts; services: ChatServices } {
  const api = window.api as object
  let known = studioImplementations.get(api)
  if (!known) {
    const client = () => windowStudioClient(window.api)
    known = { parts: createStudioConversationParts(client), services: createStudioChatServices(client) }
    studioImplementations.set(api, known)
  }
  return known
}

/** Whether this window's chat view is on the Studio protocol. */
export function chatOverStudioProtocol(): boolean {
  return typeof window !== 'undefined' && window.api?.studioChatTransport === 'studio'
}

const localParts = (): typeof ipcConversationParts =>
  chatOverStudioProtocol() ? (studioImplementation().parts as typeof ipcConversationParts) : ipcConversationParts

/** The window's services, by the same choice as its conversations. */
export function windowChatServices(): ChatServices {
  return chatOverStudioProtocol() ? studioImplementation().services : ipcChatServices
}

// Each call is answered by the implementation the window chose, read when it
// is made; the object itself never changes, so what is keyed by it (a shared
// subscription, a picture cache) stays put.
const windowServices: ChatServices = {
  providers: {
    list: (input) => windowChatServices().providers.list(input),
    models: (input) => windowChatServices().providers.models(input),
    secretStatus: (input) => windowChatServices().providers.secretStatus(input),
  },
  files: {
    get canStat() {
      return windowChatServices().files.canStat
    },
    search: (rootPath, query, options) => windowChatServices().files.search(rootPath, query, options),
    cancelSearch: (channel) => windowChatServices().files.cancelSearch(channel),
    stat: (path) => windowChatServices().files.stat(path),
    readImage: (path) => windowChatServices().files.readImage(path),
    repoRoot: (folderPath, hostId) => windowChatServices().files.repoRoot(folderPath, hostId),
  },
  planDocument: (input) => windowChatServices().planDocument(input),
  commands: {
    get list() {
      return windowChatServices().commands.list
    },
    get onChanged() {
      return windowChatServices().commands.onChanged
    },
  },
}

export const localConversationTransport: ConversationTransport = {
  kind: 'local',
  capabilities: LOCAL_CAPABILITIES,
  subscribe: (input, cb) => localParts().subscribe(input, cb),
  loadEarlier: (input) => localParts().loadEarlier(input),
  toolDetail: (input) => localParts().toolDetail(input),
  turnDiff: (input) => localParts().turnDiff(input),
  send: (input) => localParts().send(input),
  interrupt: (input) => localParts().interrupt(input),
  respond: (input) => localParts().respond(input),
  setPermissionPreset: (input) => localParts().setPermissionPreset(input),
  setModel: (input) => localParts().setModel(input),
  attachment: (input) => localParts().attachment(input),
  rewind: (input) => localParts().rewind(input),
  handoff: (input) => localParts().handoff(input),
  fork: (input) => localParts().fork(input),
  startSession: (input) => localParts().startSession(input),
  revert: (input) => localParts().revert(input),
  // The IPC's, in a window on either implementation, as the composer's server
  // rows have always asked it.
  mcpServerAction: (input) => window.api.conversationSessionMcpAction(input),
  // Read off the implementation the window chose, so it is absent where that
  // one has no way to do it.
  get stopSubagent() {
    return localParts().stopSubagent
  },
  get askSideQuestion() {
    return localParts().askSideQuestion
  },
  get cancelSideQuestion() {
    return localParts().cancelSideQuestion
  },
  get readContextBreakdown() {
    return localParts().readContextBreakdown
  },
  services: windowServices,
}

const ConversationTransportContext = createContext<ConversationTransport>(localConversationTransport)

export const ConversationTransportProvider = ConversationTransportContext.Provider

export function useConversationTransport(): ConversationTransport {
  return useContext(ConversationTransportContext)
}

/**
 * What a paired machine's chat's command list is kept under in this window:
 * the chat itself, as no folder of this disk names it, so two of that
 * machine's chats in different folders never share a list.
 */
export function remoteCommandsFolder(key: MeshConversationKey): string {
  return `mesh:${key.connectionId}/${key.workspaceId}/${key.agentId}`
}

const commandResult = (result: MeshConversationCommandResult): ConversationTransportResult =>
  result.ok ? { ok: true, ...(result.notice ? { notice: result.notice } : {}) } : { ok: false, message: result.message }

/**
 * A conversation on a paired machine, over the Mesh. The key it was made for
 * is the one every call names: the local key a view passes carries this
 * machine's idea of a workspace root, which means nothing over there.
 * `onLink` receives the connection state main narrates beside the frames, and
 * `onQueued` what the machine holds for the conversation's turn to end.
 */
export function createRemoteConversationTransport(input: {
  key: MeshConversationKey
  machineName: string
  access: MeshConversationAccess | null
  onLink?: (link: MeshConversationLink) => void
  onQueued?: (messages: MeshQueuedMessage[]) => void
  /** The machine recorded a pull request Create PR opened there as the chat's. */
  onPullRequestRecorded?: () => void
}): ConversationTransport {
  const { key } = input
  return {
    kind: 'remote',
    machineName: input.machineName,
    capabilities: {
      operate: input.access === 'operate',
      startSession: false,
      permanentApprovals: false,
      // Turned on from the machine's list, when it reverts a turn's files
      // itself (`conversation-checkpoint-revert`): the checkpoint is on its disk.
      checkpointRevert: false,
      modelSwitch: false,
      composerContext: false,
      // Turned on from the machine's list, when it searches a chat's folder
      // and takes what is mentioned of it; when it takes files; and when it
      // lists the slash commands a chat's CLI runs there.
      mentions: false,
      attachFiles: false,
      commandList: false,
      // Whether this chat takes them is the machine's list's to say, through
      // the session the pane builds from it.
      imageAttachments: true,
      localHistory: false,
      localFiles: false,
      optimisticTurns: false,
      reportsPreset: false,
      // Turned on from the machine's list, when it advertises the four modes.
      permissionModes: false,
      // Turned on from the machine's list, when it takes a message into a
      // running turn (`conversation-steer-sends`). Without it a remote Send
      // now stops the turn and sends after.
      steer: false,
      // Turned on from the machine's list, when it advertises queued sends.
      hostQueue: false,
      // Turned on from the machine's list, when it takes skills with a message.
      skills: false,
      // Turned on from the machine's list, when it opens pull requests for its chats.
      hostPullRequests: false,
    },
    remoteExtensions: { connectionId: key.connectionId, workspaceId: key.workspaceId },
    commandsFolder: remoteCommandsFolder(key),
    pullRequestHost: remotePullRequestHost(key, () => input.onPullRequestRecorded?.()),
    subscribe: (subscription, cb) =>
      window.api.onMeshConversationSession({ key, turnLimit: subscription.turnLimit }, (frame) => {
        if (frame.type === 'link') input.onLink?.(frame)
        else if (frame.type === 'queued') input.onQueued?.(frame.messages)
        else cb(frame)
      }),
    loadEarlier: (page) =>
      window.api.meshConversationLoadEarlier({ key, beforeCursor: page.beforeCursor, turnLimit: page.turnLimit }),
    toolDetail: (detail) => window.api.meshConversationToolDetail({ key, toolUseId: detail.toolUseId }),
    turnDiff: (diff) => window.api.meshConversationTurnDiff({ key, turnSeq: diff.turnSeq, path: diff.path }),
    // The images go as a chat here sends them; main uploads each to the
    // machine before the send that names them.
    send: async (turn) =>
      commandResult(
        await window.api.meshConversationSend({
          key,
          message: turn.message,
          ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
          // The machine resolves them against its own folder, as its own
          // composer's chips are.
          ...(turn.skills?.length ? { skills: turn.skills.map((skill) => skill.id) } : {}),
          // Named by their paths in the chat's folder there, as its search
          // named them; offered only where the machine takes them.
          ...(turn.mentions?.length ? { mentions: turn.mentions } : {}),
          // Files from this computer: main puts each in that machine's store
          // first, and the send names them, as it names the images.
          ...(turn.files?.length ? { files: turn.files } : {}),
          ...(turn.steer ? { steer: true } : {}),
          // The mode the chat's turn runs in, as a chat here sends it. Main
          // refuses one other than the default for a machine that would run
          // it in the default mode instead.
          ...(turn.mode && turn.mode !== 'default' ? { mode: turn.mode } : {}),
        }),
      ),
    queue: async (turn) =>
      commandResult(await window.api.meshConversationSend({ key, message: turn.message, queue: true })),
    cancelQueued: async (held) =>
      commandResult(await window.api.meshConversationCancelQueued({ key, queuedId: held.queuedId })),
    searchMentions: async ({ query }) => {
      const result = await window.api.meshConversationSearchFiles({ key, query })
      return result.ok ? { ok: true, entries: result.entries } : { ok: false, message: result.message }
    },
    // Kept as this window keeps a list read here: under the chat's own key,
    // never a folder of this disk's (`remoteCommandsFolder`).
    listCommands: async ({ refresh }) => {
      const result = await window.api.meshConversationCommands({ key, ...(refresh ? { refresh: true } : {}) })
      if (!result.ok) throw new Error(result.message)
      return {
        cli: result.cli,
        cwd: remoteCommandsFolder(key),
        commands: result.commands,
        fetchedAt: result.fetchedAt,
        ...(result.error ? { error: result.error } : {}),
      }
    },
    interrupt: async () => commandResult(await window.api.meshConversationInterrupt({ key })),
    restartSession: async () => commandResult(await window.api.meshConversationRestartSession({ key })),
    // Offered only for an action the pane's session lists, which it does
    // where the machine takes the command; a sign-in never is.
    mcpServerAction: async (asked) => {
      if (asked.action === 'sign-in')
        return {
          ok: false,
          message: `Sign in to ${asked.serverId} on ${input.machineName}: its agent waits for the sign-in there.`,
        }
      const done = await window.api.meshConversationMcpServerAction({
        key,
        serverId: asked.serverId,
        action: asked.action,
      })
      return done.ok ? { ok: true } : { ok: false, message: done.message }
    },
    // Offered only where the machine takes it and lists the chat's provider
    // as able (the pane's session says `stopSubagent`).
    stopSubagent: async (input) =>
      commandResult(await window.api.meshConversationStopSubagent({ key, toolUseId: input.toolUseId })),
    // Offered only where the machine takes it and lists the chat's provider as
    // able (the pane's session says `handoff`). The file is written over
    // there, so its path means nothing here.
    handoff: async () => {
      const handed = await window.api.meshConversationHandoff({ key })
      return handed.ok ? { ok: true, path: '' } : { ok: false, message: handed.message }
    },
    // Offered only where the machine takes it and lists the chat's provider
    // as able (the pane's session says `rewind`).
    rewind: async (turn) => {
      const rewound = await window.api.meshConversationRewind({ key, turnSeq: turn.turnSeq })
      return rewound.ok ? { ok: true } : { ok: false, message: rewound.message }
    },
    // Used only where the machine reverts files itself (the pane turns
    // `checkpointRevert` on). The paths are that machine's checkout's, shown
    // in the dialog and sent back as they came, never looked for here.
    revert: async (turn) => {
      const result = await window.api.meshConversationRevert({
        key,
        turnSeq: turn.turnSeq,
        ...(turn.undo ? { undo: true } : {}),
        ...(turn.confirmed ? { confirmed: true, files: turn.files ?? [] } : {}),
      })
      const answer = parseConversationRevertAnswer(result.data)
      if (!result.ok)
        return { ok: false, message: result.message, ...(answer && 'changed' in answer ? { changed: true } : {}) }
      if (!answer || 'changed' in answer)
        return { ok: false, message: `${input.machineName} answered with files this build cannot read.` }
      return { ok: true, ...answer }
    },
    // Each of these offered only where the machine takes it and lists the
    // chat's provider as able (the pane's session says `fork`, `sideQuestion`,
    // `contextBreakdown`). Every one names the chat by its ids over there; the
    // session id a view passes is the list's, which means nothing to them.
    fork: async (fork) => {
      const forked = await window.api.meshConversationFork({
        key,
        fork:
          fork.side === 'user'
            ? { kind: 'fork', newAgentId: fork.newAgentId, side: 'user', turnSeq: fork.turnSeq }
            : { kind: 'fork', newAgentId: fork.newAgentId, side: 'assistant', turnId: fork.turnId },
      })
      return forked.ok ? { ok: true } : { ok: false, message: forked.message }
    },
    askSideQuestion: (question) =>
      window.api.meshConversationSideQuestion({
        key,
        requestId: question.requestId,
        question: question.question,
        ...(question.history?.length ? { history: question.history } : {}),
      }),
    cancelSideQuestion: (question) =>
      window.api.meshConversationCancelSideQuestion({ key, requestId: question.requestId }),
    readContextBreakdown: () => window.api.meshConversationContextBreakdown({ key }),
    respond: async (response) => {
      if (response.answers && response.approved)
        return commandResult(
          await window.api.meshConversationAnswerQuestion({
            key,
            requestId: response.requestId,
            answers: response.answers,
          }),
        )
      if (response.decision === 'always')
        return { ok: false, message: 'A remote device cannot choose a permanent rule.' }
      const decision = !response.approved ? 'deny' : response.decision === 'conversation' ? 'conversation' : 'once'
      return commandResult(
        await window.api.meshConversationResolveApproval({ key, requestId: response.requestId, decision }),
      )
    },
    // The CLI's own mode rides beside its preset where the chat's session
    // lists any, which the pane does only for a machine that runs them.
    setPermissionPreset: async (change) =>
      commandResult(
        await window.api.meshConversationSetPermissionPreset({
          key,
          preset: change.permissionPreset,
          ...(change.permissionMode ? { permissionMode: change.permissionMode } : {}),
        }),
      ),
    // Offered only while the machine advertises model switching; the pane turns
    // `modelSwitch` on from its list, and the chip stays locked without it.
    setModel: async (change) =>
      commandResult(await window.api.meshConversationSetModel({ key, modelId: change.modelId })),
    // That machine keeps the chat's effort and sends each turn at it, so the
    // send leaves it out.
    setReasoningEffort: async (change) =>
      commandResult(
        await window.api.meshConversationSetReasoningEffort({
          key,
          ...(change.effort ? { effort: change.effort } : {}),
        }),
      ),
    toolImage: async (image) => {
      const result = await window.api.meshConversationToolImage({ key, toolUseId: image.toolUseId })
      return result.ok
        ? { ok: true, src: result.dataUrl }
        : { ok: false, unsupported: result.code === 'images_unsupported', message: result.message }
    },
    attachment: async (stored) => {
      const result = await window.api.meshConversationAttachment({ key, ref: stored.ref })
      const picture = result.ok ? /^data:([^;,]+);base64,(.*)$/su.exec(result.dataUrl) : null
      return picture
        ? { ok: true, mediaType: picture[1]!, dataBase64: picture[2]! }
        : { ok: false, message: result.ok ? 'The picture could not be read.' : result.message }
    },
    // A chat followed from a paired machine still reads this window's Studio
    // for providers, files, plans and command lists, as it always has.
    services: windowServices,
  }
}
