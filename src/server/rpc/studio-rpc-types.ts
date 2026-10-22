import type {
  ConversationCommand,
  ConversationCreateRequest,
  ConversationThread,
  ConversationWirePermissionPreset,
  StudioAuth,
  StudioClientInfo,
  StudioCreatedConversation,
  StudioGrant,
} from '../../../packages/studio-protocol/src/public'
import type {
  ConversationAttachmentResult,
  ConversationForkInput,
  ConversationForkResult,
  ConversationInterruptInput,
  ConversationKey,
  ConversationPageResult,
  ConversationPlanDocumentInput,
  ConversationPlanDocumentResult,
  ConversationProvidersListInput,
  ConversationRespondToRequestInput,
  ConversationRevertInput,
  ConversationRevertResult,
  ConversationRewindInput,
  ConversationRewindResult,
  ConversationHandoffInput,
  ConversationHandoffResult,
  ConversationSendTurnInput,
  ConversationSessionActionResult,
  ConversationSessionFrame,
  ConversationSetModelInput,
  ConversationSetPermissionInput,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationToolDetailResult,
  ConversationTurnDiffResult,
} from '../../shared/conversation-runtime'
import type { ConversationCommandCatalog } from '../../shared/conversation/commands'
import type {
  ConversationProviderListResult,
  ConversationProviderModelsResult,
  ConversationSecretStatusResult,
} from '../../shared/ipc/conversations'
import type { FileSearchResult, FileSystemStat } from '../../shared/ipc/filesystem'

// What the Studio RPC needs from the rest of Studio, as interfaces, so the
// router and the connection import nothing from Electron or from main: the
// conversations it serves, and who may connect.

/** How a command ended, as the conversation host words it. */
export type StudioCommandOutcome = {
  ok: boolean
  code?: string
  message?: string
  /** With `busy`: when trying again can succeed. */
  retryAfterMs?: number
  notice?: string
}

/**
 * The conversations the RPC serves. Main implements it over the same
 * conversation host the tailnet lane wraps, the launch service and the
 * runtime, so a chat behaves the same whichever way it is reached.
 */
export type StudioConversationBackend = {
  list(): Promise<ConversationThread[]>
  /** The conversation's place on disk, or null when its workspace is not here. */
  resolveKey(workspaceId: string, agentId: string): ConversationKey | null
  /** Follow one conversation from a cursor: snapshot or catch-up, a fence, then live events. */
  follow(
    key: ConversationKey,
    cursor: { afterSeq?: number; generation?: string; turnLimit?: number },
    listener: (frame: ConversationSessionFrame) => void,
  ): { dispose(): void; ready: Promise<void> }
  loadEarlier(key: ConversationKey, beforeCursor: number, turnLimit?: number): Promise<ConversationPageResult>
  toolDetail(key: ConversationKey, toolUseId: string): Promise<ConversationToolDetailResult>
  turnDiff(key: ConversationKey, turnSeq: number, path?: string): Promise<ConversationTurnDiffResult>
  /**
   * Carry out one command under an id already namespaced to its client. The
   * runtime's durable receipts answer a retry of the same id with the first
   * attempt's result.
   */
  command(
    key: ConversationKey,
    clientId: string,
    commandId: string,
    command: ConversationCommand,
    /** What the command was, kept with its receipt: the id for another command is then refused. */
    fingerprint?: string,
  ): Promise<StudioCommandOutcome>
  /**
   * End the conversation's live session, if it has one, under the command id
   * already namespaced to its client: the receipt answers a resend with the
   * first result rather than stopping a session started since.
   */
  stop(
    key: ConversationKey,
    commandId: string,
    fingerprint?: string,
  ): Promise<{ ok: true } | { ok: false; message: string; code?: string }>
  /** The preset the conversation runs on now, or resumes on. */
  permissionOf(key: ConversationKey): ConversationWirePermissionPreset
  /** The conversation an earlier create under this namespaced id started, if it still exists. */
  findCreated(launchCommandId: string): StudioCreatedConversation | null
  /** Start a conversation. `request` has already been held to the client's ceiling. */
  create(
    request: ConversationCreateRequest,
    launchCommandId: string,
  ): Promise<{ ok: true; conversation: StudioCreatedConversation } | { ok: false; code: string; message: string }>
  /**
   * What a client is shown of anything read from a conversation — an event, a
   * page, a tool's detail, a turn's diff: secret-shaped members redacted, as
   * the tailnet lane redacts them. Returns a copy.
   */
  redact<T>(value: T): T
}

/**
 * What a chat view needs beside the conversation lane (`chat.ts` in the
 * protocol), as main serves its own windows: the same handlers, so a chat over
 * the RPC and a chat over IPC are one chat. Inputs arrive shape-checked; each
 * implementation checks what they mean by the rules its IPC applies. A session
 * command carries a command id already namespaced to its client.
 */
export type StudioChatBackend = {
  startSession(input: ConversationStartSessionInput): Promise<ConversationStartSessionResult>
  sendTurn(input: ConversationSendTurnInput): Promise<ConversationSessionActionResult>
  /** Whether a session command's id has a receipt (or is being carried out): a repeat is answered from it. */
  hasReceipt(input: { sessionId: string; commandId: string }): Promise<boolean>
  interrupt(input: ConversationInterruptInput): Promise<ConversationSessionActionResult>
  respond(input: ConversationRespondToRequestInput): Promise<ConversationSessionActionResult>
  setPermission(input: ConversationSetPermissionInput): Promise<ConversationSessionActionResult>
  setModel(input: ConversationSetModelInput): Promise<ConversationSessionActionResult>
  revert(input: ConversationRevertInput): Promise<ConversationRevertResult>
  rewind(input: ConversationRewindInput): Promise<ConversationRewindResult>
  handoff(input: ConversationHandoffInput): Promise<ConversationHandoffResult>
  fork(input: ConversationForkInput): Promise<ConversationForkResult>
  attachment(ref: string): Promise<ConversationAttachmentResult>
  planDocument(input: ConversationPlanDocumentInput): Promise<ConversationPlanDocumentResult>
  commands(input: { cli: string; cwd: string; refresh?: boolean; probe?: false }): Promise<ConversationCommandCatalog>
  /** Every `/` command list published from now on, for whichever (CLI, folder). */
  onCommandsChanged(listener: (catalog: ConversationCommandCatalog) => void): () => void
  providers(input: ConversationProvidersListInput): Promise<ConversationProviderListResult>
  providerModels(input: { providerId: string }): Promise<ConversationProviderModelsResult>
  secretStatus(input: { providerId: string }): Promise<ConversationSecretStatusResult>
  /**
   * File search, in the slot of the connection asking: a newer search on the
   * same channel ends the older one, and a closed connection's are ended.
   */
  searchFiles(
    slot: number,
    input: {
      rootPath: string
      query: string
      limit?: number
      purpose?: 'mention'
      channel?: string
      recentAt?: Record<string, number>
    },
  ): Promise<FileSearchResult>
  cancelFileSearch(slot: number, channel?: string): void
  releaseFileSearches(slot: number): void
  stat(path: string): Promise<FileSystemStat>
  readImage(path: string): Promise<string>
  repoRoot(folderPath: string, hostId?: string): Promise<string | null>
  workspaces(): Array<{ id: string; name: string; folderPath: string | null; hostId?: string }>
}

/** Who a request came from, beyond its grant. */
export type StudioRequestContext = {
  connectionId: string
  /** A number this connection alone holds, for the file search slots main keys by number. */
  slot: number
  /**
   * The connection is one of Studio's own windows, over the port main handed
   * it: the app's own chat view, which reads conversations over IPC as they
   * are. Its replies are not redacted, its mutations are not audited, and a
   * failure below is told in its own words, as the IPC tells it.
   */
  ownWindow: boolean
  /**
   * Whether its mutations are audited. Unset, a client's are and a window's
   * are not; an owner's web tab is Studio's own view but a client of the
   * server all the same, and is audited (phase 9 spec, 14.8).
   */
  audited?: boolean
}

export type StudioAuthOutcome = { ok: true; grant: StudioGrant; pairingToken?: string } | { ok: false; message: string }

/** Who may connect, and what each may do now. */
export type StudioAuthenticator = {
  /** Check a hello's credential; a pairing code is redeemed here, once. */
  authenticate(auth: StudioAuth, client: StudioClientInfo): StudioAuthOutcome
  /** The client's grant as it stands now, or null once it is revoked. Read on every request. */
  grantFor(clientId: string): StudioGrant | null
  onRevoked(listener: (clientId: string) => void): () => void
  onGrantChanged(listener: (clientId: string) => void): () => void
  recordSeen?(clientId: string): void
}

/** One mutation, or one refusal at the door, as the audit records it. Never a message's text. */
export type StudioAuditEntry = {
  clientId: string | null
  clientName: string
  /** The method (`conversation.send`), or `studio.auth_refused` / `studio.paired`. */
  tool: string
  workspaceId?: string
  agentId?: string
  commandId?: string
  /** An offer or a withdrawal: the toolset's name and how many tools it holds. Never a tool's input or result. */
  toolset?: string
  tools?: number
  ok: boolean
  code?: string
  durationMs: number
}
