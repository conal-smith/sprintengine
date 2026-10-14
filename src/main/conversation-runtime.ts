import { stat } from 'fs/promises'
import {
  MAX_CONVERSATION_METADATA_BYTES,
  readConversationStorage,
  removeConversationStorage,
  writeConversationStorage,
} from './conversation-persistence'

import type {
  ConversationAttachmentResult,
  ConversationPlanDocumentInput,
  ConversationPlanDocumentResult,
  ConversationCliRuntimeOverrides,
  ConversationPageResult,
  ConversationEvent,
  ConversationImageAttachment,
  ConversationInterruptInput,
  ConversationMcpServer,
  ConversationPermissionPreset,
  ConversationListSessionsInput,
  ConversationListSessionsResult,
  ConversationRespondToRequestInput,
  ConversationSendTurnInput,
  ConversationSessionActionResult,
  ConversationSessionSummary,
  ConversationSkillRef,
  ConversationSubagentStatusPayload,
  ConversationSetModelInput,
  ConversationMcpServerActionInput,
  ConversationMcpServerActionResult,
  ConversationSetPermissionInput,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationStopSessionInput,
  ConversationStopSubagentInput,
  ConversationSuspendSessionInput,
  ConversationTranscriptInput,
  ConversationTranscriptResult,
  ConversationToolDetailInput,
  ConversationToolDetailResult,
  ConversationToolDetail,
  ConversationJsonValue,
  ConversationToolStatus,
  ConversationTurnDiffInput,
  ConversationTurnDiffResult,
  ConversationRevertInput,
  ConversationRevertResult,
  ConversationRewindInput,
  ConversationRewindResult,
  ConversationForkInput,
  ConversationForkResult,
  ConversationImportTranscriptInput,
  ConversationImportTranscriptResult,
} from '../shared/conversation-runtime'
import { CONVERSATION_SESSION_NOT_FOUND, readConversationMessageOrigin } from '../shared/conversation-runtime'
import { cliRuntimesOnPlatform, distroOfHostId, type ExecutionHostId } from '../shared/execution-host'
import { wslInputInRootSpelling } from '../shared/host-paths'
import { inferConversationToolKind } from '../shared/conversation/toolKind'
import { isTurnlessSubagentStep, readSubagentStatus } from '../shared/conversation/subagents'
import { readBackgroundTasks } from '../shared/conversation/backgroundTasks'
import { applyFileActivityEvent } from '../shared/conversation/fileActivity'
import {
  readToolDetail,
  writeToolDetail,
  redactConversationValue,
  ToolDetailWriteQueue,
  ToolOutputStream,
  toolOutputStreamPath,
  TOOL_PREVIEW_CHARS,
} from './conversation-tool-details'
import {
  createConversationSkillsResolver,
  type ConversationSkillsResolver,
  type ResolvedConversationSkills,
} from './conversation-skills'
import { resolveConversationMentions } from './conversation-mentions'
import { attachedFilesContext } from './conversation-attached-files'
import { parseConversationAttachedFiles, type ConversationAttachedFile } from '../shared/conversation/attachedFiles'
import { ConversationCheckpoints } from './conversation-checkpoints'
import { ConversationIndex } from './conversation-index'
import type {
  ConversationWorkspaceKey,
  ConversationSearchInput,
  ConversationSearchHit,
  ConversationRenameInput,
} from '../shared/conversation-index'
import { presentToolItem } from '../shared/conversation/presentation'
import { plainLineBreaks } from '../shared/conversation/lineBreaks'
import { applyPromptCacheEvent } from '../shared/prompt-cache'
import { ConversationApprovalRuleStore } from './conversation-approval-rules'
import { ConversationAttachmentStore } from './conversation-attachment-store'
import { ConversationPlanStore } from './conversation-plan-store'
import { approvalRememberLabels, approvalRuleCandidate } from '../shared/conversation/approvalRules'
import {
  looksLikePermissionSettingRefusal,
  permissionFallbackNotice,
  permissionModeAllows,
  permissionModeApprovalLabel,
  type PermissionModeRequest,
} from '../shared/conversation/permissionModes'
import { isRecord } from '../shared/records'
import { getConversationProviderById } from './plugin-registry-instance'
import { ProviderSecretStore } from './secret-store'
import { clampSuspendIdleAfterMs, DEFAULT_SUSPEND_IDLE_AFTER_MS } from './terminal-reap-policy'
import type { TerminalRootInfo } from './workspace-memory'
import type { PowerActivity } from './power-activity'
import {
  type ConversationMessage,
  type ConversationProviderAdapter,
  type MockAdapterTurnInput,
  type ConversationProviderCursor,
  type ConversationProviderEventStream,
} from './providers/conversation-provider-adapter'
import { createMockConversationProvider } from './providers/mock-conversation-provider'
import { createOpenAiCompatibleProvider } from './providers/openai-compatible-provider'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider } from './providers/claude-agent-provider'
import { createCodexConversationProvider } from './providers/codex-conversation-provider'
import { ACP_PROFILES, createAcpConversationProvider } from './providers/acp-conversation-provider'
import { leadingCommandFor } from './conversation-commands/leading-command'
import { cliForConversationProvider } from '../shared/conversation-harness'
import { workspaceSidecarPath } from './workspace-sidecar'
import {
  ConversationEventLog,
  type ConversationAppendOutcome,
  type ConversationEventLogOptions,
} from './conversation-event-log'
import {
  ConversationTranscriptReader,
  DEFAULT_TRANSCRIPT_LIMITS,
  type ConversationTranscriptLimits,
  type TranscriptSyncResult,
} from './conversation-transcript-reader'

/** What a terminal needs to resume a chat's CLI session (`terminalHandoffTarget`). */
export type ConversationTerminalHandoffTarget = {
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  /** Where the chat runs: its worktree, else the workspace folder. The CLI keys its sessions by it. */
  workspaceRoot: string
  /** The CLI's own session id: Claude's session, Codex's thread. */
  providerSessionId: string
  permissionPreset?: ConversationPermissionPreset
  permissionMode?: string
  cliRuntimes?: ConversationCliRuntimeOverrides
}

type RuntimeSession = ConversationSessionSummary & {
  // The idle listeners were told this session came to rest, and it has not
  // been busy since (noteSettled).
  idleAnnounced?: boolean
  // Spawned agents still running, by spawning tool call.
  runningSubagents: Map<string, ConversationSubagentStatusPayload>
  workspaceRoot: string
  fileScope: string
  activeTurnId: string | null
  pendingRequestId: string | null
  activeTurnAbort: AbortController | null
  canceledTurnIds: Set<string>
  // Completed turns only, in send order, so each new turn carries prior context.
  // A failed/interrupted turn is not recorded, so a retry re-sends cleanly.
  // Kept for a stateless session only, which replays it every turn, and
  // dropped while it rests (null), to be read back from the transcript by the
  // next send. A stateful provider owns its history.
  history: ConversationMessage[] | null
  // True when the provider adapter owns history/resume (sessions: 'stateful').
  // Stateful sessions never replay history and resolve approvals mid-turn.
  stateful: boolean
  // The requestId allocated at turn start. For stateful sessions it doubles as
  // the send lock while a turn is streaming; mid-turn approvals temporarily
  // override pendingRequestId with their own ids.
  turnLockRequestId: string | null
  // All approval request ids currently unresolved on a stateful turn (the
  // provider can hold several permission callbacks open at once).
  pendingApprovalRequestIds: Set<string>
  // Serializes continuation-channel events (post-`result` turns the provider
  // opens outside a sendTurn) so their persistence and broadcast stay ordered.
  continuationTail: Promise<void>
  checkpointTurnSeq: number | null
  checkpointCapture: Promise<void> | null
  checkpointCaptured: boolean
  revertedNote?: string
  // Skills attached to a message that opened with a slash command. The CLI
  // runs that message as the command, so they wait here and go with the next
  // message that is not one, exactly once.
  pendingSkills?: ConversationSkillRef[]
  // Skills the CLI has been told to run in this chat. They live in its own
  // history from then on, so a skill that stays attached is run once, not on
  // every message.
  invokedSkills?: Set<string>
  approvalRequests: Map<string, PermissionModeRequest>
  automaticApprovals: Map<string, string>
  // Requests an answer has been sent for, by the person, a remembered rule or
  // the chat's mode, whose resolution the provider has not reported yet. A
  // second answer to one of them is refused, so a mode switch that sweeps the
  // waiting requests never answers, or labels, one the person just answered.
  answeredApprovals: Set<string>
  // Requests whose `approval_requested` is still being decided on (a
  // remembered rule is being looked up) and has not been published. The mode
  // is read again once that is done, so a switch meanwhile leaves them to it
  // rather than resolving a request no client has been shown yet.
  unpublishedApprovals: Set<string>
  cliRuntimes?: ConversationCliRuntimeOverrides
  permissionPreset?: ConversationPermissionPreset
  permissionChangeTail?: Promise<ConversationSessionActionResult>
  modelChangeTail?: Promise<ConversationSessionActionResult>
  allowedTools?: string[]
  // Handed to the adapter at start and never reported: a server's env and
  // headers can carry the person's tokens.
  mcpServers?: ConversationMcpServer[]
  // Detail files of tools still open in this session, closed when a turn ends.
  toolDetailPaths: Set<string>
  // The provider stream of the turn a send is running, once the provider has
  // been handed it; see ProviderTurn.
  providerTurn: ProviderTurn | null
}

/**
 * One provider stream: a send's, or a continuation the agent carried on with
 * by itself. Its events carry `streamTurnId`, the turn it was sent (or opened)
 * as, and count toward `turnId`: the same turn until a steer ends it where the
 * steered message lands and opens the next, after which the stream's
 * remaining events are that turn's. `finished` once the stream's own end has
 * been written; `ended` settles, through `settle`, when the stream closes.
 */
type ProviderTurn = {
  streamTurnId: string
  turnId: string
  finished: boolean
  continuation: boolean
  ended: Promise<ConversationSessionActionResult>
  settle: (result: ConversationSessionActionResult) => void
}

function openProviderTurn(turnId: string, continuation: boolean): ProviderTurn {
  let settle: (result: ConversationSessionActionResult) => void = () => undefined
  const ended = new Promise<ConversationSessionActionResult>((resolve) => (settle = resolve))
  return { streamTurnId: turnId, turnId, finished: false, continuation, ended, settle }
}

export type ConversationRuntimeOptions = {
  approvalRules?: ConversationApprovalRuleStore
  attachmentStore?: ConversationAttachmentStore
  planStore?: ConversationPlanStore
  resolveSkills?: ConversationSkillsResolver
  adapters?: ConversationProviderAdapter[]
  secretStore?: Pick<ProviderSecretStore, 'getStatus'> & Partial<Pick<ProviderSecretStore, 'resolveSecret'>>
  getProviderById?: typeof getConversationProviderById
  stat?: typeof stat
  // How transcript lines reach disk; tests shorten the delta flush or stub the
  // stream. Defaults to one append stream per transcript file.
  eventLog?: ConversationEventLogOptions
  // Read budgets for transcripts; tests shrink them to exercise long chats.
  transcriptLimits?: Partial<ConversationTranscriptLimits>
  now?: () => number
  randomId?: () => string
  // Least time between two running previews of one tool's output; tests shorten it.
  toolPreviewIntervalMs?: number
  // How long a running tool's replaced output waits before its detail file is
  // rewritten (TOOL_DETAIL_WRITE_WINDOW_MS); tests shorten it.
  toolDetailWriteWindowMs?: number
  // The app's own MCP gateway for a CLI chat (Claude Code, Codex, an ACP
  // agent), on the machine its CLI runs on (a WSL host's, or this one's). Null
  // leaves it out; the chat runs without Studio's tools rather than not at all.
  resolveStudioMcpServer?: (input: { hostId?: ExecutionHostId }) => Promise<ConversationMcpServer | null>
  // The platform this runtime runs on; tests stand in for another. Off
  // Windows a `wsl:` host id means nothing (a WSL server is handed the
  // runtimes a Windows front door built), so it is dropped at the start.
  platform?: NodeJS.Platform
}

type ConversationRuntimeListener = (event: ConversationEvent) => void
/** `lost`: highest sequence number published but not written; `recorded`: highest one on disk as such. */
type NonDurableLog = { root: string; lost: number; recorded: number; recording: boolean }
/** One running tool's preview cadence: when the last went out, what it showed, and the one waiting. */
type ToolPreviewThrottle = {
  session: RuntimeSession
  sentAt: number
  shown: string | null
  held: { event: ConversationEvent; options: EmitOptions } | null
  timer: NodeJS.Timeout | null
}
type EmitOptions = { turnId?: string; allowCanceledTurnId?: string | null; prepared?: boolean }
/**
 * What a provider stream's emitted events came to, counted as they go by. A
 * long agentic turn is tens of thousands of deltas and tool outputs, and the
 * turn's end needs only these.
 */
type EmittedSummary = {
  approvalsRequested: number
  approvalsResolved: number
  completed: boolean
  failed: boolean
  // The reply's text, gathered only when asked for (a stateless session's history).
  text: string
}

/**
 * A running tool's preview is a tail of up to {@link TOOL_PREVIEW_CHARS} of its
 * output, and every one that is published is also a transcript line, because
 * a client may hold its sequence number. At the log's own cadence a ten-minute
 * build left megabytes of near-identical previews, crowding a reconnecting
 * client out of its catch-up budget. The first preview goes out at once, then
 * at most one every this long, and only when it changed; the full output is in
 * the tool's detail file and its final event regardless.
 */
const DEFAULT_TOOL_PREVIEW_INTERVAL_MS = 5_000
/** How long a send turned away by a running turn waits before it is sent again. */
const TURN_BUSY_RETRY_MS = 1_000
/**
 * How much of the end of the last reply a session keeps: a little more than a
 * launch notice quotes (agent-launch-notices.ts), so a reply cut short there
 * is shown cut.
 */
const LAST_ASSISTANT_TAIL_CHARS = 320

const UNSAVED_NOTICE =
  'This conversation could not be saved to disk. It carries on here, but messages from now on may be missing after the app restarts.'

// Cap on how many persisted events a transcript replay returns to the
// renderer; the JSONL on disk keeps everything.
const MAX_TRANSCRIPT_REPLAY_EVENTS = 2000

// The most a step's detail, or its streamed output, can be on disk
// (conversation-tool-details.ts), with room to spare: what a fork copies of
// each.
const MAX_FORKED_DETAIL_BYTES = 6 * 1024 * 1024

// Stateful adapters that never read `fallbackHistory`: Claude Code resumes
// its own session and has no use for the conversation replayed as text. The
// history is up to a page of transcript, so it is not built for them.
const ADAPTERS_WITHOUT_FALLBACK_HISTORY: ReadonlySet<string> = new Set([CLAUDE_AGENT_PROVIDER_ID])

// How much of a chat's end the hover card reads for its newest turn. A turn
// longer than this shows its newest part; the card draws a few hundred
// characters of it either way.
const PEEK_TURN_BYTES = 256 * 1024

// How far back a picture request from a paired device looks for the step
// that made the picture. The host keeps what it found, so only the first
// request for a step pays for the scan.
const TOOL_CALL_SCAN_BYTES = 32 * 1024 * 1024

// Same cadence as the terminal runtime's stale-terminal sweep: often enough
// that an idle child process does not outlive the threshold by much, rare
// enough to be free.
const IDLE_SWEEP_INTERVAL_MS = 3 * 60 * 1000

// How often opening a conversation also expires a workspace's old checkpoint
// refs. A conversation's refs expire after it has been idle for 30 days, so
// looking once a day loses nothing, and each look lists every thread and
// every checkpoint ref of the repository.
const CHECKPOINT_EXPIRY_INTERVAL_MS = 24 * 60 * 60 * 1000

// How a refusal names a request of each kind, when an answer meant for one
// reaches another.
const REQUEST_KIND_NAMES: Record<string, string> = {
  tool: 'a tool permission',
  question: 'a question',
  plan: 'a plan',
}

/** The answer to a command id already used for a different command. */
function commandIdConflict(): ConversationSessionActionResult {
  return {
    ok: false,
    code: 'command_id_conflict',
    message: 'That command id was already used for a different command. Send this one under a new id.',
  }
}

/**
 * The answer about a session this runtime does not hold: one it never
 * started, or one held by a server that has since restarted. The caller
 * starts the chat's session again, which resumes it from its transcript, as
 * an app that restarts does.
 */
function sessionNotFound(): ConversationSessionActionResult {
  return { ok: false, code: CONVERSATION_SESSION_NOT_FOUND, message: 'Conversation session is invalid.' }
}

/** The fingerprint a receipt was kept with, if it has one. */
function receiptFingerprint(receipt: ConversationSessionActionResult): string | undefined {
  const value = (receipt as { fingerprint?: unknown }).fingerprint
  return typeof value === 'string' ? value : undefined
}

/** A receipt as its command's result: the fingerprint is the receipt's, not the answer's. */
function withoutFingerprint(receipt: ConversationSessionActionResult): ConversationSessionActionResult {
  if (receiptFingerprint(receipt) === undefined) return receipt
  const { fingerprint: _fingerprint, ...result } = receipt as ConversationSessionActionResult & { fingerprint: string }
  return result as ConversationSessionActionResult
}

export class ConversationRuntime {
  private readonly adapters = new Map<string, ConversationProviderAdapter>()
  private readonly secretStore: Pick<ProviderSecretStore, 'getStatus'> &
    Partial<Pick<ProviderSecretStore, 'resolveSecret'>>
  private readonly getProviderById: typeof getConversationProviderById
  private readonly stat: typeof stat
  private readonly eventLog: ConversationEventLog
  private readonly threadIndex: ConversationIndex
  private readonly transcripts: ConversationTranscriptReader
  private readonly transcriptLimits: ConversationTranscriptLimits
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly platform: NodeJS.Platform
  private readonly resolveSkills: ConversationSkillsResolver
  private readonly checkpoints = new ConversationCheckpoints()
  private readonly approvalRules: ConversationApprovalRuleStore
  private readonly attachmentStore: ConversationAttachmentStore
  private readonly planStore: ConversationPlanStore
  private readonly sessions = new Map<string, RuntimeSession>()
  private readonly deletingTranscripts = new Set<string>()
  private readonly startingTranscripts = new Set<string>()
  private readonly revertingScopes = new Set<string>()
  // Sessions whose CLI session is being handed to a terminal; a send waits for
  // the terminal rather than respawning the child it was just stopped in.
  private readonly terminalHandoffs = new Set<string>()
  // Chats (workspace and agent) whose CLI session a terminal took over. A
  // terminal now drives that session, so Studio's own sends (a launched
  // agent's notice, a resume after a usage limit) would respawn the chat's
  // child beside it; they are refused until the person writes to the chat
  // again, which is them taking it back.
  private readonly handedToTerminal = new Set<string>()
  // Transcripts being taken back to an earlier message; a send waits for it.
  private readonly rewindingTranscripts = new Set<string>()
  // The MCP servers a fork's session starts with when its start names none:
  // the ones the chat it was forked from was running with. Held for this run
  // only, as a session's own are; they are never written down.
  private readonly forkedMcpServers = new Map<string, ConversationMcpServer[]>()
  private readonly sequenceInitializations = new Map<string, Promise<void>>()
  private readonly listeners = new Set<ConversationRuntimeListener>()
  private readonly idleListeners = new Set<(summary: ConversationSessionSummary) => void>()
  private readonly sequences = new Map<string, number>()
  // When each workspace's checkpoint refs were last expired this run.
  private readonly checkpointsExpiredAt = new Map<string, number>()
  // Housekeeping that must not delay the caller but must finish before shutdown.
  private readonly background = new Set<Promise<unknown>>()
  // The index refresh a finished turn runs in the background, per transcript,
  // so stopping or settling the chat can wait for it: a refresh that landed
  // after the workspace was closed or deleted would write its folder back.
  private readonly indexRefreshes = new Map<string, Promise<unknown>>()
  private readonly emissionTails = new Map<string, Promise<unknown>>()
  private readonly receipts = new Map<string, Promise<Map<string, ConversationSessionActionResult>>>()
  private readonly pendingCommands = new Map<string, Promise<ConversationSessionActionResult>>()
  // What each command in flight was, by the same key, so a different command
  // under its id is refused while the first is still running too.
  private readonly pendingFingerprints = new Map<string, string | undefined>()
  private readonly receiptWrites = new Map<string, Promise<void>>()
  // Transcripts with a write that failed this run: a sequence number was
  // published that is not on disk, so they never serve incremental catch-up.
  // The highest such number is also recorded beside the transcript, so the
  // next run numbers above it rather than reusing numbers a client has seen.
  private readonly nonDurableLogs = new Map<string, NonDurableLog>()
  // Per tool detail path: the detail being built, its streamed output, and
  // its file's writes, in order, with the one still waiting that later
  // details join.
  private readonly toolDetails = new Map<string, ConversationToolDetail>()
  private readonly toolStreams = new Map<string, ToolOutputStream>()
  private readonly toolDetailWrites: ToolDetailWriteQueue
  private readonly toolPreviews = new Map<string, ToolPreviewThrottle>()
  private readonly toolPreviewIntervalMs: number
  private eventSequence = 0
  // Event ids must stay unique across app restarts: the persisted transcript
  // is replayed into the renderer, which dedupes live pushes against it by id.
  private readonly eventEpoch: string
  private idleThresholdMs = DEFAULT_SUSPEND_IDLE_AFTER_MS
  private idleSweepTimer: NodeJS.Timeout | null = null
  private idleSweepActivity: (() => void) | null = null

  constructor(options: ConversationRuntimeOptions = {}) {
    this.secretStore = options.secretStore ?? new ProviderSecretStore()
    this.getProviderById = options.getProviderById ?? getConversationProviderById
    // Every CLI chat is handed the app's gateway at launch, whichever agent runs it.
    const studioGateway = options.resolveStudioMcpServer
      ? { resolveStudioMcpServer: options.resolveStudioMcpServer }
      : {}
    const defaultAdapters = [
      createMockConversationProvider(),
      createOpenAiCompatibleProvider({
        getProviderById: this.getProviderById,
        resolveSecret: (providerId) => this.resolveSecret(providerId),
      }),
      createClaudeAgentProvider(studioGateway),
      createCodexConversationProvider(studioGateway),
      ...ACP_PROFILES.map((profile) => createAcpConversationProvider(profile, studioGateway)),
    ]
    for (const adapter of options.adapters ?? defaultAdapters) {
      this.adapters.set(adapter.id, adapter)
    }
    this.stat = options.stat ?? stat
    this.platform = options.platform ?? process.platform
    this.eventLog = new ConversationEventLog({
      onError: (filePath, error) => {
        console.warn(
          `[conversation-runtime] transcript write failed for ${filePath}:`,
          error instanceof Error ? error.message : error,
        )
      },
      ...options.eventLog,
    })
    this.transcriptLimits = { ...DEFAULT_TRANSCRIPT_LIMITS, ...options.transcriptLimits }
    this.transcripts = new ConversationTranscriptReader(this.transcriptLimits)
    this.threadIndex = new ConversationIndex({
      flush: (path) => this.eventLog.flush(path),
      close: (path) => this.eventLog.close(path),
      maxTranscriptBytes: this.transcriptLimits.fullReadBytes,
    })
    this.now = options.now ?? Date.now
    this.toolPreviewIntervalMs = options.toolPreviewIntervalMs ?? DEFAULT_TOOL_PREVIEW_INTERVAL_MS
    this.toolDetailWrites = new ToolDetailWriteQueue({
      read: readToolDetail,
      write: writeToolDetail,
      ...(options.toolDetailWriteWindowMs !== undefined ? { windowMs: options.toolDetailWriteWindowMs } : {}),
    })
    this.randomId = options.randomId ?? (() => Math.random().toString(36).slice(2, 10))
    this.resolveSkills = options.resolveSkills ?? createConversationSkillsResolver()
    this.approvalRules = options.approvalRules ?? new ConversationApprovalRuleStore()
    this.attachmentStore = options.attachmentStore ?? new ConversationAttachmentStore()
    this.planStore = options.planStore ?? new ConversationPlanStore()
    // Startup-time epoch (not randomId — tests inject deterministic id
    // sequences that must not be consumed by construction).
    this.eventEpoch = this.now().toString(36)
  }

  onEvent(listener: ConversationRuntimeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * A chat that has just let go of its turn: it runs none and waits on no
   * card, so a message sent now is taken rather than refused as busy. Told
   * once per settle, after the state the summary reads is in place. The
   * turn's end event is not that moment: it is published while the turn still
   * holds the session, so a send made on it is refused (main/agent-launch-
   * notices.ts waits for this instead).
   */
  onSessionIdle(listener: (summary: ConversationSessionSummary) => void): () => void {
    this.idleListeners.add(listener)
    return () => this.idleListeners.delete(listener)
  }

  // Tell the idle listeners when `session` has just come to rest. Called after
  // every event and at each place a turn lets go of the session; a check that
  // finds it busy re-arms the announcement for its next rest.
  private noteSettled(session: RuntimeSession): void {
    const settled =
      this.sessions.get(session.sessionId) === session &&
      (session.status === 'ready' || session.status === 'failed') &&
      !isSessionBusy(session)
    if (!settled) {
      session.idleAnnounced = false
      return
    }
    if (session.idleAnnounced) return
    session.idleAnnounced = true
    if (this.idleListeners.size === 0) return
    const summary = this.toSummary(session)
    for (const listener of [...this.idleListeners]) {
      try {
        listener(summary)
      } catch (error) {
        console.warn('[conversation-runtime] an idle listener failed:', error instanceof Error ? error.message : error)
      }
    }
  }
  getProviderCapabilities(providerId: string) {
    return this.getAdapterForProviderId(providerId)?.capabilities
  }
  getNativeProviderModels(providerId: string) {
    const adapter = this.getAdapterForProviderId(providerId)
    return adapter?.sessions === 'stateful'
      ? adapter.listModels().map((id) => ({ id, displayName: id === 'default' ? 'CLI default' : id }))
      : undefined
  }

  async startSession(input: ConversationStartSessionInput): Promise<ConversationStartSessionResult> {
    if (!input.workspaceRoot?.trim() || !input.workspaceId?.trim() || !input.agentId?.trim())
      return { ok: false, message: 'Conversation identity is required.' }
    const path = this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)
    // A rewind writes the marker the next start forks from; a start that read
    // the cursor before it would resume the whole session and undo the rewind.
    if (this.deletingTranscripts.has(path) || this.startingTranscripts.has(path) || this.rewindingTranscripts.has(path))
      return { ok: false, message: 'Conversation lifecycle operation is already in progress.' }
    const inherited = input.mcpServers === undefined ? this.forkedMcpServers.get(path) : undefined
    if (inherited) input = { ...input, mcpServers: inherited }
    const cliRuntimes = cliRuntimesOnPlatform(input.cliRuntimes, this.platform)
    if (cliRuntimes !== input.cliRuntimes) input = { ...input, cliRuntimes }
    this.startingTranscripts.add(path)
    try {
      return (await this.adoptLiveSession(input, path)) ?? (await this.startSessionNow(input))
    } finally {
      this.startingTranscripts.delete(path)
    }
  }

  /**
   * One session per chat: the chat's live session, when it has one, rather
   * than a second. A chat view keeps its session in component state, so a
   * remount (a tab moved or reopened, a row snoozed and woken, a window
   * reloaded) asks again for a chat main is still holding, as does a paired
   * device. A second session beside the first was a second agent on the
   * sidebar row with only one tab behind it, and a second CLI child resuming
   * the same provider session. A model or preset asked for that differs is
   * switched to on the live session; one its provider cannot switch, or a
   * different provider or runtime, retires the idle session, and a failed one
   * gives way, so a fresh one starts (`startSessionNow` clears what the chat
   * left behind). A busy session is adopted as it is, so the work it is doing
   * is never cut short.
   */
  private async adoptLiveSession(
    input: ConversationStartSessionInput,
    path: string,
  ): Promise<ConversationStartSessionResult | null> {
    const existing = this.liveSessionFor(path)
    if (!existing) return null
    if (isSessionBusy(existing)) return { ok: true, session: this.toSummary(existing) }
    if (existing.status === 'failed') return null
    const sameProcess =
      existing.providerId === input.providerId.trim() &&
      JSON.stringify(existing.cliRuntimes ?? null) === JSON.stringify(input.cliRuntimes ?? null) &&
      JSON.stringify(existing.allowedTools ?? null) === JSON.stringify(input.allowedTools ?? null) &&
      JSON.stringify(existing.mcpServers ?? null) === JSON.stringify(input.mcpServers ?? null)
    if (sameProcess) {
      const modelId = input.modelId.trim()
      const model =
        modelId && modelId !== existing.modelId
          ? await this.setModel({ sessionId: existing.sessionId, modelId })
          : { ok: true }
      const preset =
        model.ok &&
        input.permissionPreset !== undefined &&
        (input.permissionPreset !== existing.permissionPreset || input.permissionMode !== existing.permissionMode)
          ? await this.setPermission({
              sessionId: existing.sessionId,
              permissionPreset: input.permissionPreset,
              ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
            })
          : model
      if (preset.ok && existing.status !== 'stopped') return { ok: true, session: this.toSummary(existing) }
    }
    if (existing.status !== 'stopped' && !isSessionBusy(existing))
      await this.stopSession({ sessionId: existing.sessionId })
    return null
  }

  /** The newest session of a transcript that is not stopped. */
  private liveSessionFor(path: string): RuntimeSession | undefined {
    let live: RuntimeSession | undefined
    for (const session of this.sessions.values())
      if (
        session.status !== 'stopped' &&
        this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId) === path
      )
        live = session
    return live
  }

  private async startSessionNow(input: ConversationStartSessionInput): Promise<ConversationStartSessionResult> {
    // A live session on the same footing was adopted (`adoptLiveSession`);
    // anything else this chat left behind — stopped, failed, or retired —
    // gives way to the new one.
    const previous = Array.from(this.sessions.values()).filter(
      (session) => session.workspaceId === input.workspaceId.trim() && session.agentId === input.agentId.trim(),
    )
    const validation = await this.validateStartInput(input)
    if (!validation.ok) {
      return { ok: false, message: validation.message }
    }
    if (input.mcpServers?.length && !validation.adapter.acceptsMcpServers) {
      const provider = validation.adapter.displayName ?? input.providerId
      return {
        ok: false,
        message: `A ${provider} chat cannot be started with MCP servers of its own, so it cannot run with ${input.mcpServers.map((server) => `"${server.name || server.id}"`).join(', ')}. Choose a CLI whose chats can: Claude Code, Codex, or an ACP agent.`,
      }
    }
    for (const stale of previous) {
      if (stale.status !== 'stopped') await this.stopSession({ sessionId: stale.sessionId })
      this.sessions.delete(stale.sessionId)
    }

    const sessionId = `conv_${this.randomId()}`
    const now = this.now()
    const stateful = validation.adapter.sessions === 'stateful'
    const fileScope = await this.checkpoints.fileScope(input.workspaceRoot)
    if (this.revertingScopes.has(fileScope)) return { ok: false, message: 'Workspace files are being reverted.' }
    const session: RuntimeSession = {
      sessionId,
      workspaceId: input.workspaceId.trim(),
      agentId: input.agentId.trim(),
      providerId: input.providerId.trim(),
      modelId: input.modelId.trim(),
      status: 'starting',
      phase: 'starting',
      displayName: validation.adapter.displayName ?? input.providerId,
      capabilities: validation.adapter.capabilities
        ? {
            ...validation.adapter.capabilities,
            checkpoints:
              validation.adapter.capabilities.tools && (await this.checkpoints.available(input.workspaceRoot)),
          }
        : undefined,
      createdAt: now,
      updatedAt: now,
      workspaceRoot: input.workspaceRoot,
      fileScope,
      activeTurnId: null,
      pendingRequestId: null,
      activeTurnAbort: null,
      canceledTurnIds: new Set(),
      history: null,
      stateful,
      turnLockRequestId: null,
      pendingApprovalRequestIds: new Set(),
      continuationTail: Promise.resolve(),
      checkpointTurnSeq: null,
      checkpointCapture: null,
      checkpointCaptured: false,
      approvalRequests: new Map(),
      automaticApprovals: new Map(),
      answeredApprovals: new Set(),
      unpublishedApprovals: new Set(),
      cliRuntimes: input.cliRuntimes,
      permissionPreset: input.permissionPreset,
      ...(input.permissionPreset && input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      allowedTools: input.allowedTools,
      ...(input.mcpServers?.length ? { mcpServers: input.mcpServers } : {}),
      toolDetailPaths: new Set(),
      runningSubagents: new Map(),
      providerTurn: null,
    }
    await this.initializeSequence(input)
    const previousTranscript = await this.readRecentTranscript(input)
    let fallbackHistory: ConversationMessage[] | undefined
    if (previousTranscript) {
      const first = await this.transcripts
        .findFirst(
          input.workspaceRoot,
          this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId),
          isWordedUserMessage,
        )
        .catch(() => undefined)
      if (first) this.updateExcerpts(session, first)
      for (const event of previousTranscript) this.updateExcerpts(session, event)
      if (!stateful) session.history = completedHistory(previousTranscript)
      else if (!ADAPTERS_WITHOUT_FALLBACK_HISTORY.has(validation.adapter.id))
        fallbackHistory = completedHistory(previousTranscript)
    }
    if (this.revertingScopes.has(fileScope)) return { ok: false, message: 'Workspace files are being reverted.' }
    this.sessions.set(sessionId, session)

    // Stateful providers resume their own durable session; the latest cursor
    // lives in the JSONL transcript this runtime already writes.
    const resume = stateful
      ? await this.readResumeCursor(session.workspaceRoot, session.workspaceId, session.agentId, session.providerId)
      : undefined
    const start = () =>
      this.emitAll(
        session,
        validation.adapter.startSession({
          ...session,
          resumeSessionId: resume?.sessionId,
          ...(resume?.at ? { resumeSessionAt: resume.at } : {}),
          ...(resume?.seedFromHistory ? { seedFromHistory: true } : {}),
          ...(session.history ? { fallbackHistory: session.history } : fallbackHistory ? { fallbackHistory } : {}),
          // Continuation channel: the adapter opens a mirror turn here when its
          // child resumes after a `result` (background subagents completing).
          onSessionEvent: (event) => this.enqueueContinuationEvent(session, event),
          onBeforeTool: (name) => this.captureBeforeTool(session, name),
        }),
      )
    try {
      // A runtime that will not start under the chat's permission mode (a flag
      // its CLI no longer takes, a mode it refuses — said in so many words,
      // `isPermissionSettingRefusal`) is started again with no
      // permission setting rather than leaving the person with no chat, and
      // the chat says so. Only when that start works: a runtime that fails
      // either way reports its first failure, and keeps the mode it was given.
      let fellBack: string | null = null
      try {
        await start()
      } catch (error) {
        const preset = session.permissionPreset
        const mode = session.permissionMode
        if (
          !preset ||
          preset === 'none' ||
          this.sessions.get(sessionId) !== session ||
          !isPermissionSettingRefusal(error)
        )
          throw error
        validation.adapter.disposeChildProcess?.(sessionId)
        session.permissionPreset = 'none'
        delete session.permissionMode
        try {
          await start()
        } catch {
          session.permissionPreset = preset
          if (mode) session.permissionMode = mode
          throw error
        }
        fellBack = permissionFallbackNotice(
          session.displayName ?? session.providerId,
          preset,
          error instanceof Error ? error.message : String(error),
        )
      }
      if (fellBack)
        await this.emit(
          session,
          this.eventForSession(session, 'session_updated', { permissionPreset: 'none', notice: fellBack }),
          {},
        )
      // Shells and monitors the transcript left running belonged to a process
      // that is gone, and so did its agents.
      if (session.backgroundTasks)
        await this.emit(session, this.eventForSession(session, 'session_updated', { backgroundTasks: [] }), {})
      for (const agent of Array.from(session.runningSubagents.values()))
        await this.emit(
          session,
          this.eventForSession(session, 'subagent_status', {
            ...agent,
            status: 'stopped',
            error: 'The agent stopped when the conversation closed.',
          }),
          {},
        )
      session.status = 'ready'
      session.phase = 'idle'
      session.updatedAt = this.now()
      return { ok: true, session: this.toSummary(session) }
    } catch (error) {
      this.sessions.delete(sessionId)
      validation.adapter.disposeChildProcess?.(sessionId)
      return { ok: false, message: error instanceof Error ? error.message : 'Conversation could not start.' }
    }
  }

  async sendTurn(
    input: ConversationSendTurnInput & { sourceCommandId?: string },
  ): Promise<ConversationSessionActionResult> {
    if (input.commandId)
      return this.runCommand(
        input.sessionId,
        input.commandId,
        () => this.sendTurn({ ...input, sourceCommandId: input.commandId, commandId: undefined }),
        input.commandFingerprint,
        // A send turned away busy runs nothing, so it is answered before an
        // intent is written: a phone tries again every second while a turn
        // runs, and each try was a receipts write and then its removal.
        () => {
          const session = this.sessions.get(input.sessionId)
          return session && !input.steer && isSessionBusy(session) ? busyRefusal(session) : null
        },
      )
    const session = this.sessions.get(input.sessionId)
    if (!session) return sessionNotFound()
    if (this.revertingScopes.has(session.fileScope))
      return { ok: false, message: 'Workspace files are being reverted.' }
    if (this.deletingTranscripts.has(this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)))
      return { ok: false, message: 'Conversation is being deleted.' }
    if (this.rewindingTranscripts.has(this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)))
      return { ok: false, message: 'Conversation is going back to an earlier message.' }
    // A message queued behind the turn a handoff stopped goes out the moment
    // that turn ends; sent now, it would respawn the chat's child beside the
    // terminal opening the same CLI session.
    if (this.terminalHandoffs.has(session.sessionId))
      return { ok: false, message: 'This conversation is moving to a terminal, so the message was not sent.' }
    const chat = `${session.workspaceId}\0${session.agentId}`
    if (readConversationMessageOrigin(input.origin)) {
      if (this.handedToTerminal.has(chat))
        return {
          ok: false,
          message: 'This conversation continues in a terminal, so Studio did not send it this message.',
        }
    } else this.handedToTerminal.delete(chat)
    if (session.status === 'stopped') return { ok: false, message: 'Conversation session is stopped.' }
    if (isSessionBusy(session) && !input.steer) return busyRefusal(session)
    // One message, whatever separators the text that typed it used.
    const message = plainLineBreaks(input.message).trim()
    const attachments = input.attachments ?? []
    // Read again here: a send reaches this from the IPC, the Studio protocol
    // and the backend wire, and only the first parses it on the way in.
    const files = input.files === undefined ? [] : parseConversationAttachedFiles(input.files)
    if (files === null) return { ok: false, message: 'Attached files must be absolute paths, at most 50.' }
    // A turn needs some payload: text, an image, a mention, a skill or a file.
    if (!message && attachments.length === 0 && !input.mentions?.length && !input.skills?.length && !files.length)
      return { ok: false, message: 'Conversation turn message is required.' }

    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!adapter) return { ok: false, message: 'Conversation provider is unavailable.' }
    const steerRefused = isSessionBusy(session) ? steerRefusal(session, adapter) : null
    if (steerRefused) return steerBusy(steerRefused)

    if (input.mode === 'plan' && !session.capabilities?.planMode)
      return { ok: false, message: 'This provider does not support plan mode.' }

    // A message that opens with a slash command is run by the CLI, which reads
    // everything after the name as its arguments: skill text would push the
    // command into prose ahead of it or into its arguments after it. So that
    // turn goes without its skills, and they wait on the session for the next
    // message that is not a command. Only a stateful provider is a CLI that
    // runs commands; any other takes `/word` as prose, and its skills ride as a
    // system message beside the text rather than in it.
    const opensWithCommand =
      session.stateful &&
      leadingCommandFor(message, {
        cli: cliForConversationProvider(session.providerId),
        cwd: session.workspaceRoot,
      }) !== null
    const turnSkills = opensWithCommand ? [] : [...(session.pendingSkills ?? []), ...(input.skills ?? [])]
    let skills: ResolvedConversationSkills
    let mentions: Awaited<ReturnType<typeof resolveConversationMentions>>
    try {
      skills = await this.resolveSkills({
        workspaceRoot: session.workspaceRoot,
        skills: turnSkills,
        mode: adapter.capabilities?.skills ?? 'none',
        cli: cliForConversationProvider(session.providerId),
        ...(session.invokedSkills ? { invoked: session.invokedSkills } : {}),
      })
      mentions = await resolveConversationMentions({
        workspaceRoot: session.workspaceRoot,
        mentions: input.mentions ?? [],
        atMentions: session.capabilities?.atMentions === true,
        tools: session.capabilities?.tools === true,
      })
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Attached skills could not be loaded.' }
    }
    // Resolving a skill may await disk or installation; another send can take
    // the session while that happens, so acquire the turn only after rechecking.
    if (
      this.sessions.get(input.sessionId)?.status === 'stopped' ||
      this.sessions.get(input.sessionId) !== session ||
      this.revertingScopes.has(session.fileScope) ||
      this.deletingTranscripts.has(this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)) ||
      this.rewindingTranscripts.has(this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId))
    )
      return { ok: false, message: 'Conversation is no longer available.' }
    // A steer is sent only over a turn that is still open; a send made as a
    // steer over a turn that has since ended is an ordinary send.
    if (isSessionBusy(session) && !input.steer)
      return { ok: false, message: 'Conversation turn is already in progress.' }
    // The resolver keeps one of each skill, so a skill attached again is sent once.
    if (opensWithCommand) {
      if (input.skills?.length) session.pendingSkills = [...(session.pendingSkills ?? []), ...input.skills]
    } else session.pendingSkills = undefined
    // What the provider is handed: stateful providers own their history, so
    // they get the message with the skill context it needs; others get the
    // history below as well. A command turn goes without the reverted-files
    // note for the reason above; the note stays with the session and rides
    // every later turn.
    // The files attached by path go after the words, where they are, for the
    // agent to read off the disk; the transcript keeps them as a list.
    const filesContext = attachedFilesContext(files)
    if (skills.invocation && session.stateful && !opensWithCommand)
      session.invokedSkills = new Set([...(session.invokedSkills ?? []), ...skills.ids])
    // A skill run by name opens the message: the CLI reads a leading `/name`
    // as the command, and the person's words after it as what it is for.
    const providerMessage = [
      session.stateful && !opensWithCommand ? skills.invocation : undefined,
      session.stateful && !opensWithCommand ? skills.context : undefined,
      opensWithCommand ? undefined : session.revertedNote,
      message,
      mentions.context,
      filesContext,
    ]
      .filter(Boolean)
      .join('\n\n')
    if (input.steer && isSessionBusy(session))
      return this.steerRunningTurn(session, adapter, {
        message,
        providerMessage,
        attachments,
        localTurnId: input.localTurnId,
        sourceCommandId: input.sourceCommandId,
        skillIds: skills.ids,
        mentionRefs: mentions.refs,
        files,
        ...(input.origin ? { origin: input.origin } : {}),
      })

    const turnId = `turn_${this.randomId()}`
    const requestId = `approval_${this.randomId()}`
    const turnAbort = new AbortController()
    session.activeTurnId = turnId
    session.pendingRequestId = requestId
    session.turnLockRequestId = requestId
    session.activeTurnAbort = turnAbort
    session.status = 'active'
    session.phase = 'running'
    session.updatedAt = this.now()
    session.turnStartedAt = session.updatedAt
    // The provider starts the child again for this turn if it had rested.
    session.resting = undefined
    session.checkpointTurnSeq = null
    session.checkpointCapture = null
    session.checkpointCaptured = false
    const providerTurn = openProviderTurn(turnId, false)
    const result = await (async (): Promise<ConversationSessionActionResult> => {
      // Persist the user's side of the exchange so the JSONL transcript replays
      // as a complete conversation after a restart.
      try {
        const storedAttachments = await this.saveAttachments(session, attachments)
        await this.emit(
          session,
          this.eventForSession(session, 'user_message', {
            turnId,
            text: message,
            ...(storedAttachments.length ? { attachments: storedAttachments } : {}),
            ...(input.localTurnId ? { localTurnId: input.localTurnId } : {}),
            ...(input.sourceCommandId ? { commandId: input.sourceCommandId } : {}),
            ...(skills.ids.length ? { skills: skills.ids } : {}),
            ...(mentions.refs.length ? { mentions: mentions.refs } : {}),
            ...(files.length ? { files } : {}),
            ...(input.origin ? { origin: input.origin } : {}),
          }),
          { turnId },
        )
        // The model sees prior completed turns plus this message, so it has memory.
        // Stateful providers own their history natively — replaying ours would
        // duplicate context and defeat resume, so they get only the new message.
        if (!session.stateful && !session.history) session.history = await this.readHistory(session)
        const messages: ConversationMessage[] | undefined = session.stateful
          ? undefined
          : [
              ...(skills.context ? [{ role: 'system' as const, content: skills.context }] : []),
              ...(session.revertedNote ? [{ role: 'system' as const, content: session.revertedNote }] : []),
              ...(session.history ?? []),
              { role: 'user', content: [message, mentions.context, filesContext].filter(Boolean).join('\n\n') },
            ]
        // From here a steer can join this turn: the provider is being handed it.
        if (session.activeTurnId === turnId) session.providerTurn = providerTurn
        // Attachments are carried live into the turn call; only vision-capable
        // adapters read them. The model's history stays text-only: a later turn
        // does not re-send earlier images, and the transcript keeps references
        // for the bubbles, not the bytes.
        const emitted = await this.emitAll(
          session,
          this.turnWithoutFlagOnFailure(session, adapter, {
            ...session,
            turnId,
            requestId,
            message: providerMessage,
            skills: skills.ids,
            reasoningEffort: input.reasoningEffort,
            mode: input.mode,
            ...(attachments.length > 0 ? { attachments } : {}),
            messages,
            signal: turnAbort.signal,
          }),
          { turnId, collectText: !session.stateful },
        )
        // A steer may have moved the stream on to a later turn; the stream's
        // end is that turn's.
        const ownTurnId = providerTurn.turnId
        const currentSession = this.sessions.get(input.sessionId)
        if (
          currentSession &&
          currentSession.status !== 'stopped' &&
          currentSession.activeTurnId === ownTurnId &&
          !currentSession.canceledTurnIds.has(ownTurnId)
        ) {
          this.applyTurnState(currentSession, emitted, requestId)
          currentSession.activeTurnAbort = null
          // Record only a cleanly completed turn (no failure) into history, so a
          // failed turn leaves history untouched and a retry re-sends without
          // duplicating the user message. Stateful providers keep their own.
          if (!currentSession.stateful && emitted.completed && !emitted.failed) {
            // Dropped while the send ran (the chat was settled): the next send
            // reads it back from the transcript, this turn included.
            currentSession.history?.push({ role: 'user', content: message })
            if (emitted.text) currentSession.history?.push({ role: 'assistant', content: emitted.text })
          }
        }
        return { ok: true, session: this.toSummary(currentSession ?? session) }
      } catch (error) {
        return this.failTurn(session, error)
      }
    })()
    if (session.providerTurn === providerTurn) session.providerTurn = null
    providerTurn.settle(result)
    this.noteSettled(session)
    return result
  }

  /**
   * A turn whose runtime fails before it does anything, under a permission mode
   * that passes the CLI a setting, and says it refused that setting
   * (`isPermissionSettingRefusal`), is sent again with no permission setting:
   * the child a runtime starts for a turn (Claude Code's first message, a
   * relaunch after a mode change) or the turn itself (Codex's approval policy)
   * is where a setting the CLI no longer takes shows up. The retry's events
   * replace the failed attempt's, and the chat says why its mode is No flag
   * now. A retry that fails too puts the mode back and the first failure
   * stands, as it would have without the retry: that was not the setting.
   */
  private async *turnWithoutFlagOnFailure(
    session: RuntimeSession,
    adapter: ConversationProviderAdapter,
    input: MockAdapterTurnInput,
  ): AsyncIterable<ConversationEvent> {
    const preset = session.permissionPreset
    const mode = session.permissionMode
    const first = eventIterator(await adapter.sendTurn(input))
    if (!preset || preset === 'none' || !adapter.setPermissionPreset) {
      for (let next = await first.next(); !next.done; next = await first.next()) yield next.value
      return
    }
    // Everything goes out as it arrives; only a failure that comes before the
    // turn has done anything is held, until the retry says whose it was.
    let failure: ConversationEvent | null = null
    let started = false
    for (let next = await first.next(); !next.done; next = await first.next()) {
      // A message the runtime turned away itself (`refused`) never reached a
      // CLI, so it says nothing about the flag — and a guard that depends on
      // the mode, like refusing a typed command that loosens it, must not be
      // retried under No flag, where it lets the command through.
      if (
        !started &&
        next.value.type === 'turn_failed' &&
        next.value.payload?.refused !== true &&
        isPermissionSettingRefusal(next.value) &&
        !input.signal?.aborted
      ) {
        failure = next.value
        break
      }
      if (!TURN_OPENING_EVENTS.has(next.value.type)) started = true
      yield next.value
    }
    if (!failure) return
    await first.return?.()
    // A mode the person picked while the turn was starting is theirs: the
    // failure was under the old one, and neither No flag nor the old mode put
    // back after a failed retry may replace it.
    if (session.permissionPreset !== preset || session.permissionMode !== mode) {
      yield failure
      return
    }
    const noFlag = await adapter
      .setPermissionPreset({ ...session, permissionPreset: 'none', permissionMode: undefined })
      .catch((): { ok: false } => ({ ok: false }))
    if (!noFlag.ok) {
      yield failure
      return
    }
    session.permissionPreset = 'none'
    delete session.permissionMode
    // Still on the No flag set here, or moved on by the person since.
    const untouched = () => session.permissionPreset === 'none' && session.permissionMode === undefined
    const notice = () =>
      this.eventForSession(session, 'session_updated', {
        permissionPreset: 'none',
        notice: permissionFallbackNotice(session.displayName ?? session.providerId, preset, readTurnFailure(failure)),
      })
    const retry = eventIterator(await adapter.sendTurn({ ...input, permissionPreset: 'none' }))
    let retried = false
    for (let next = await retry.next(); !next.done; next = await retry.next()) {
      const event = next.value
      if (!retried && event.type === 'turn_failed') {
        await retry.return?.()
        if (untouched()) {
          await adapter
            .setPermissionPreset({ ...session, permissionPreset: preset, permissionMode: mode })
            .catch(() => undefined)
          session.permissionPreset = preset
          if (mode) session.permissionMode = mode
        }
        yield failure
        return
      }
      // The turn opened with the first attempt; the retry carries it on.
      if (event.type === 'turn_started') continue
      if (!retried && !TURN_OPENING_EVENTS.has(event.type)) {
        retried = true
        if (untouched()) yield notice()
      }
      yield event
    }
    if (!retried && untouched()) yield notice()
  }

  /**
   * Hand a message to the turn that is running (a steer), where the provider
   * takes one. The provider keeps the one stream it is running; no second
   * turn is started there. Here the running turn ends where the message
   * lands — its reply so far stays above the message — and the message opens
   * the next turn, which every event of that stream counts toward from then
   * on: the rest of the reply, tool results, approvals and the stream's own
   * end with its cost. The handover runs in the transcript's emission order,
   * so each event the stream produced before it is the old turn's and each
   * one after it the new turn's, an approval card included. Settles when the
   * stream does, as the send it continues does.
   */
  private async steerRunningTurn(
    session: RuntimeSession,
    adapter: ConversationProviderAdapter,
    input: {
      message: string
      providerMessage: string
      attachments: ConversationImageAttachment[]
      localTurnId?: string
      sourceCommandId?: string
      skillIds: string[]
      mentionRefs: Awaited<ReturnType<typeof resolveConversationMentions>>['refs']
      files: ConversationAttachedFile[]
      origin?: ConversationSendTurnInput['origin']
    },
  ): Promise<ConversationSessionActionResult> {
    const path = this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)
    const turnId = `turn_${this.randomId()}`
    // What the agent carried on with has already said goes out ahead of the
    // steer, not under the turn it opens. Waited on before joining the
    // emission queue: those events are written through it.
    await session.continuationTail.catch(() => undefined)
    const handover = (this.emissionTails.get(path) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async (): Promise<ProviderTurn | ConversationSessionActionResult> => {
        if (session.status === 'stopped' || this.sessions.get(session.sessionId) !== session)
          return { ok: false, message: 'Conversation is no longer available.' }
        const refused = steerRefusal(session, adapter)
        if (refused) return steerBusy(refused)
        const running = session.providerTurn!
        const delivered = await adapter.steer!({
          ...session,
          turnId: running.streamTurnId,
          message: input.providerMessage,
          ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
        })
        if (!delivered.ok) return steerBusy(delivered.message)
        const storedAttachments = await this.saveAttachments(session, input.attachments)
        // The work since the running turn's first file change is one change,
        // under that turn's number; a turn with none yet takes the new one.
        const checkpointTurnSeq = session.checkpointCapture ? session.checkpointTurnSeq : null
        await this.emitNow(
          session,
          this.eventForSession(session, 'turn_completed', {
            turnId: running.turnId,
            steered: true,
            ...(delivered.providerCursor ? { providerCursor: delivered.providerCursor } : {}),
          }),
          { turnId: running.turnId },
        )
        running.turnId = turnId
        session.activeTurnId = turnId
        session.updatedAt = this.now()
        await this.emitNow(
          session,
          this.eventForSession(session, 'user_message', {
            turnId,
            text: input.message,
            ...(storedAttachments.length ? { attachments: storedAttachments } : {}),
            ...(input.localTurnId ? { localTurnId: input.localTurnId } : {}),
            ...(input.sourceCommandId ? { commandId: input.sourceCommandId } : {}),
            ...(input.skillIds.length ? { skills: input.skillIds } : {}),
            ...(input.mentionRefs.length ? { mentions: input.mentionRefs } : {}),
            ...(input.files.length ? { files: input.files } : {}),
            ...(input.origin ? { origin: input.origin } : {}),
          }),
          { turnId },
        )
        await this.emitNow(session, this.eventForSession(session, 'turn_started', { turnId }), { turnId })
        if (checkpointTurnSeq !== null) session.checkpointTurnSeq = checkpointTurnSeq
        return running
      })
    this.emissionTails.set(path, handover)
    let outcome: ProviderTurn | ConversationSessionActionResult
    try {
      outcome = await handover
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The message could not be delivered.' }
    }
    if ('ok' in outcome) return outcome
    return outcome.ended
  }

  // Keep a turn's attached images in the attachment store; the event names
  // them by reference. One that cannot be kept costs its thumbnail after a
  // restart, never the turn.
  private saveAttachments(session: RuntimeSession, attachments: ConversationImageAttachment[]) {
    return this.attachmentStore.save(session, attachments).catch((error: unknown) => {
      console.warn(
        '[conversation-runtime] attached images were not kept:',
        error instanceof Error ? error.message : error,
      )
      return []
    })
  }

  private async failTurn(session: RuntimeSession, error: unknown): Promise<ConversationSessionActionResult> {
    const turnId = session.activeTurnId
    session.activeTurnAbort?.abort()
    this.closeContinuation(session)
    session.activeTurnId = null
    session.pendingRequestId = null
    session.turnLockRequestId = null
    session.pendingApprovalRequestIds.clear()
    session.activeTurnAbort = null
    session.status = 'failed'
    session.phase = 'failed'
    session.updatedAt = this.now()
    const message = error instanceof Error ? error.message : 'Conversation turn failed.'
    const event = this.eventForSession(session, 'turn_failed', { turnId, reason: 'runtime', message })
    try {
      const stamped = await this.emit(session, event, { allowCanceledTurnId: turnId })
      if (stamped) return { ok: false, message, event: stamped }
    } catch {
      // The transcript could not take it. Subscribers drop an event with no
      // sequence number, so it gets the next one; the log can no longer vouch
      // for its numbering, which sends its reconnects to a full snapshot.
      const path = this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)
      event.id = `conv_evt_${this.eventEpoch}_${++this.eventSequence}`
      event.seq = (this.sequences.get(path) ?? 0) + 1
      event.createdAt = this.now()
      this.sequences.set(path, event.seq)
      this.markNonDurable(session.workspaceRoot, path, event.seq)
      this.notify(event)
    }
    return { ok: false, message, event }
  }

  /**
   * Hand a persisted event to listeners. A superseded tool preview is not
   * published at all; the one that replaced it follows. A failed write is
   * still published — the live chat must not stall on a broken disk — but the
   * log can no longer vouch for its sequence numbers, so catch-up on it falls
   * back to a full snapshot until the process restarts.
   */
  private publish(root: string, path: string, event: ConversationEvent, outcome: ConversationAppendOutcome): void {
    if (outcome === 'superseded') return
    if (outcome === 'failed') {
      // The first loss of the run is said once, on the event that was lost, so
      // the person knows before a restart shows a gap.
      if (!this.nonDurableLogs.has(path)) event = { ...event, payload: { ...event.payload, notice: UNSAVED_NOTICE } }
      this.markNonDurable(root, path, event.seq ?? 0)
    }
    // The disk took a write again: record a lost number the first attempt could not.
    else if (this.nonDurableLogs.has(path)) this.recordLostSequence(path)
    this.notify(event)
  }

  private markNonDurable(root: string, path: string, seq: number): void {
    const log = this.nonDurableLogs.get(path) ?? { root, lost: 0, recorded: 0, recording: false }
    log.lost = Math.max(log.lost, seq)
    this.nonDurableLogs.set(path, log)
    this.recordLostSequence(path)
  }

  /**
   * Keep the highest published-but-unwritten sequence number on disk. Without
   * it a restart would resume numbering from the end of the file, reissue
   * numbers a client already holds under the same log generation, and that
   * client's catch-up would skip the new events carrying them.
   */
  private recordLostSequence(path: string): void {
    const log = this.nonDurableLogs.get(path)
    if (!log || log.recording || log.recorded >= log.lost) return
    log.recording = true
    const target = log.lost
    this.runInBackground(
      writeConversationStorage(log.root, lostSequencePath(path), JSON.stringify({ seq: target })).then(
        () => {
          log.recording = false
          log.recorded = Math.max(log.recorded, target)
          this.recordLostSequence(path)
        },
        () => {
          // Still failing: the next successful append or failure tries again.
          log.recording = false
        },
      ),
    )
  }

  private async readLostSequence(root: string, path: string): Promise<number> {
    try {
      const seq = JSON.parse((await readConversationStorage(root, lostSequencePath(path), 1024)).toString('utf8'))?.seq
      return Number.isSafeInteger(seq) && seq > 0 ? seq : 0
    } catch {
      return 0
    }
  }

  private notify(event: ConversationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        this.listeners.delete(listener)
      }
    }
  }

  async respondToRequest(input: ConversationRespondToRequestInput): Promise<ConversationSessionActionResult> {
    if (input.commandId)
      return this.runCommand(
        input.sessionId,
        input.commandId,
        () => this.respondToRequest({ ...input, commandId: undefined }),
        input.commandFingerprint,
      )
    const session = this.sessions.get(input.sessionId)
    if (!session) return sessionNotFound()
    const requestIsPending =
      session.pendingRequestId === input.requestId || session.pendingApprovalRequestIds.has(input.requestId)
    if (!session.activeTurnId || !requestIsPending) {
      return { ok: false, message: 'Conversation approval request is invalid.' }
    }
    if (session.answeredApprovals.has(input.requestId))
      return { ok: false, message: 'This request has already been answered.' }
    if (input.requestKind) {
      const asked = session.approvalRequests.get(input.requestId)?.requestKind ?? 'tool'
      if (asked !== input.requestKind)
        return {
          ok: false,
          message: `This request is ${REQUEST_KIND_NAMES[asked] ?? 'another kind of request'}, not ${REQUEST_KIND_NAMES[input.requestKind]}.`,
        }
    }
    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!adapter) return { ok: false, message: 'Conversation provider is unavailable.' }

    session.answeredApprovals.add(input.requestId)
    if (input.approved && (input.decision === 'conversation' || input.decision === 'always')) {
      const request = session.approvalRequests.get(input.requestId)
      if (!request || (request.requestKind && request.requestKind !== 'tool')) {
        session.answeredApprovals.delete(input.requestId)
        return { ok: false, message: 'This request can only be allowed once.' }
      }
      try {
        await this.approvalRules.remember(session.workspaceRoot, session.sessionId, request, input.decision)
      } catch (error) {
        session.answeredApprovals.delete(input.requestId)
        return { ok: false, message: error instanceof Error ? error.message : 'Permission rule could not be saved.' }
      }
    }

    let emitted: EmittedSummary
    try {
      emitted = await this.emitAll(
        session,
        adapter.resolveApproval({
          ...session,
          turnId: session.activeTurnId,
          requestId: input.requestId,
          approved: input.decision === 'deny' ? false : input.approved,
          answers: input.answers,
        }),
      )
    } catch (error) {
      session.answeredApprovals.delete(input.requestId)
      throw error
    }
    // A stateful adapter that ended the turn in answering (the provider that
    // asked is gone): the session is settled here as a stop settles it.
    // Marking it active again, as the branch below does for a turn that goes
    // on, locked the chat behind a turn nothing was running — no Send, and a
    // Stop with nothing to stop.
    if (session.stateful && (emitted.failed || emitted.completed)) {
      session.activeTurnId = null
      session.pendingRequestId = null
      session.turnLockRequestId = null
      session.activeTurnAbort = null
      session.status = 'ready'
      session.updatedAt = this.now()
      this.noteSettled(session)
      return { ok: true, session: this.toSummary(session) }
    }
    if (session.stateful) {
      // The turn is still streaming inside the adapter (the approval resolved
      // a mid-turn permission callback); restore the turn lock and let the
      // in-flight sendTurn stream carry the resolution + remaining events.
      // Other requests still open keep the session waiting on them.
      // This request counts as answered even before the adapter's stream
      // carries its resolution.
      const remaining = Array.from(session.pendingApprovalRequestIds).filter((id) => id !== input.requestId)
      session.pendingRequestId = remaining.at(-1) ?? session.turnLockRequestId
      session.status = remaining.length > 0 ? 'awaiting_approval' : 'active'
      session.updatedAt = this.now()
      return { ok: true, session: this.toSummary(session) }
    }
    session.activeTurnId = null
    session.pendingRequestId = null
    session.status = input.approved ? 'ready' : 'failed'
    session.updatedAt = this.now()
    this.noteSettled(session)
    return { ok: true, session: this.toSummary(session) }
  }

  // Change tool-permission behavior on a session that is already running. The
  // adapter applies it to its live provider session (taking effect on the next
  // tool call) and only then does the session record the new preset, so a
  // provider that refuses the change never leaves a preset it is not honoring.
  // An adapter that accepted the preset but cannot apply it to the turn already
  // running returns a `notice` — the change is recorded, and the sentence says
  // plainly when it starts applying.
  async setPermission(input: ConversationSetPermissionInput): Promise<ConversationSessionActionResult> {
    if (input.commandId)
      return this.runCommand(
        input.sessionId,
        input.commandId,
        () => this.setPermission({ ...input, commandId: undefined }),
        input.commandFingerprint,
      )
    const session = this.sessions.get(input.sessionId)
    if (!session) return sessionNotFound()
    const pending = (session.permissionChangeTail ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.applyPermission(session, input))
    session.permissionChangeTail = pending
    return pending
  }

  private async applyPermission(
    session: RuntimeSession,
    input: ConversationSetPermissionInput,
  ): Promise<ConversationSessionActionResult> {
    if (session.status === 'stopped') return { ok: false, message: 'Conversation session is stopped.' }
    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!adapter) return { ok: false, message: 'Conversation provider is unavailable.' }
    if (!adapter.setPermissionPreset) {
      return { ok: false, message: 'This conversation provider cannot change tool permissions mid-conversation.' }
    }
    const applied = await adapter.setPermissionPreset({
      ...session,
      permissionPreset: input.permissionPreset,
      permissionMode: input.permissionMode,
    })
    if (!applied.ok) return { ok: false, message: applied.message }
    session.permissionPreset = input.permissionPreset
    if (input.permissionMode) session.permissionMode = input.permissionMode
    else delete session.permissionMode
    session.updatedAt = this.now()
    this.answerWaitingApprovalsByMode(session)
    // Said on the stream, as a model switch is: a change made from a paired
    // device or an extension reaches every view of the chat, whose chip
    // follows the live session's own report and would otherwise keep the old
    // mode (and offer no way to pick it again).
    await this.emit(
      session,
      this.eventForSession(session, 'session_updated', {
        permissionPreset: input.permissionPreset,
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      }),
    )
    return { ok: true, session: this.toSummary(session), ...(applied.notice ? { notice: applied.notice } : {}) }
  }

  // The input approval checks place a request by. An agent running in WSL names
  // files the Linux way and the workspace root is a Windows path, so its paths
  // are respelled as the root spells them first — or every file in the
  // workspace reads as outside it, and Auto and "always allow" answer nothing.
  // Only for a session whose agent the provider runs in WSL; the event the
  // person sees and the answer the agent gets keep the input as it was sent.
  private approvalCheckInput(session: RuntimeSession, input: unknown): unknown {
    const cli = this.getAdapterForProviderId(session.providerId)?.executionHostCli
    // Only on Windows: a Linux server holding a stray `wsl:` id would respell
    // its own paths into UNC ones, and Auto would approve nothing.
    const distro = cli ? distroOfHostId(session.cliRuntimes?.[cli]?.hostId, this.platform) : null
    return distro ? wslInputInRootSpelling(input, session.workspaceRoot, distro) : input
  }

  // A mode chosen while requests wait answers the ones it covers, as it would
  // have had it been in force when they were asked; the rest keep waiting for
  // the person. One already answered (a click an instant before the switch,
  // "Allow and switch") is left to that answer. Nothing is ever denied here.
  private answerWaitingApprovalsByMode(session: RuntimeSession): void {
    const mode = session.permissionPreset
    for (const requestId of Array.from(session.pendingApprovalRequestIds)) {
      if (session.answeredApprovals.has(requestId) || session.unpublishedApprovals.has(requestId)) continue
      const request = session.approvalRequests.get(requestId)
      if (!request || !permissionModeAllows(mode, request, session.workspaceRoot)) continue
      const label = permissionModeApprovalLabel(mode!)
      session.automaticApprovals.set(requestId, label)
      // An answer that did not go through leaves no label behind to be pinned
      // on whatever answers the request next.
      const unlabel = () => {
        if (session.automaticApprovals.get(requestId) === label) session.automaticApprovals.delete(requestId)
      }
      void this.respondToRequest({ sessionId: session.sessionId, requestId, approved: true, decision: 'once' }).then(
        (answered) => {
          if (!answered.ok) unlabel()
        },
        unlabel,
      )
    }
  }

  // Switch a running conversation to another model of the same provider. The
  // adapter records it (and pushes it into a live provider session where it
  // can); only then does the session take it, and a `session_updated` event
  // carrying the new model is written so the transcript, the thread index, a
  // resume and a remote list all name the model the conversation is now on.
  // Gated on the adapter declaring `liveModelSwitch`, never on its id.
  /** Reconnect, switch or sign in to one of a live chat's MCP servers, through its provider. */
  async mcpServerAction(input: ConversationMcpServerActionInput): Promise<ConversationMcpServerActionResult> {
    const session = this.sessions.get(input.sessionId)
    if (!session || session.status === 'stopped') return { ok: false, message: 'Conversation session is not running.' }
    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!adapter?.mcpServerAction || !session.capabilities?.mcpServerActions?.includes(input.action))
      return { ok: false, message: 'This chat cannot do that to its MCP servers.' }
    return adapter.mcpServerAction({ ...session, serverId: input.serverId, action: input.action })
  }

  async setModel(input: ConversationSetModelInput): Promise<ConversationSessionActionResult> {
    if (input.commandId)
      return this.runCommand(
        input.sessionId,
        input.commandId,
        () => this.setModel({ ...input, commandId: undefined }),
        input.commandFingerprint,
      )
    const session = this.sessions.get(input.sessionId)
    if (!session) return sessionNotFound()
    const pending = (session.modelChangeTail ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.applyModel(session, input))
    session.modelChangeTail = pending
    return pending
  }

  private async applyModel(
    session: RuntimeSession,
    input: ConversationSetModelInput,
  ): Promise<ConversationSessionActionResult> {
    const modelId = input.modelId.trim()
    if (!modelId) return { ok: false, message: 'Conversation model is invalid.' }
    if (session.status === 'stopped') return { ok: false, message: 'Conversation session is stopped.' }
    if (modelId === session.modelId) return { ok: true, session: this.toSummary(session) }
    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!adapter) return { ok: false, message: 'Conversation provider is unavailable.' }
    if (!adapter.setModel || session.capabilities?.liveModelSwitch !== true) {
      return { ok: false, message: 'This conversation provider cannot change models mid-conversation.' }
    }
    const applied = await adapter.setModel({ ...session, nextModelId: modelId })
    if (!applied.ok) return { ok: false, message: applied.message }
    session.modelId = modelId
    session.updatedAt = this.now()
    await this.emit(session, this.eventForSession(session, 'session_updated', { modelId }))
    return { ok: true, session: this.toSummary(session), ...(applied.notice ? { notice: applied.notice } : {}) }
  }

  async interrupt(input: ConversationInterruptInput): Promise<ConversationSessionActionResult> {
    if (input.commandId)
      return this.runCommand(
        input.sessionId,
        input.commandId,
        () => this.interrupt({ ...input, commandId: undefined }),
        input.commandFingerprint,
      )
    const session = this.sessions.get(input.sessionId)
    if (!session) return sessionNotFound()
    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!session.activeTurnId) {
      // Between turns, Stop is for what the last turn left running: the
      // shells and monitors the chat names above its composer. Each reports
      // its own end, which takes it off that list.
      if (session.backgroundTasks && (await adapter?.stopBackgroundTasks?.(session.sessionId)))
        return { ok: true, session: this.toSummary(session) }
      return { ok: false, message: 'Conversation session has no active turn.' }
    }
    if (!adapter) return { ok: false, message: 'Conversation provider is unavailable.' }

    const turnId = session.activeTurnId
    if (turnId) this.cancelActiveTurn(session)
    const emitted = await this.emitAll(session, adapter.interrupt(session), { allowCanceledTurnId: turnId })
    if (!emitted.failed && !emitted.completed)
      await this.emit(
        session,
        this.eventForSession(session, 'turn_failed', {
          turnId,
          reason: 'interrupted',
          message: 'Conversation interrupted.',
        }),
        { allowCanceledTurnId: turnId },
      )
    session.activeTurnId = null
    session.pendingRequestId = null
    session.turnLockRequestId = null
    session.pendingApprovalRequestIds.clear()
    session.activeTurnAbort = null
    session.status = 'ready'
    session.updatedAt = this.now()
    this.noteSettled(session)
    return { ok: true, session: this.toSummary(session) }
  }

  // Stop one agent the chat spawned, by the call that spawned it, and leave the
  // chat, its turn and its other agents as they are. Between turns too: a
  // background agent works on with no turn open. The agent reports its own
  // end, which is what closes its lane.
  async stopSubagent(input: ConversationStopSubagentInput): Promise<ConversationSessionActionResult> {
    const session = this.sessions.get(input.sessionId)
    if (!session) return sessionNotFound()
    if (session.status === 'stopped') return { ok: false, message: 'Conversation session is stopped.' }
    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!adapter?.stopSubagent || session.capabilities?.stopSubagent !== true)
      return { ok: false, message: 'This chat cannot stop one agent by itself.' }
    if (!(await adapter.stopSubagent(session.sessionId, input.toolUseId)))
      return { ok: false, message: 'That agent is not running any more.' }
    return { ok: true, session: this.toSummary(session) }
  }

  async stopSession(input: ConversationStopSessionInput): Promise<ConversationSessionActionResult> {
    if (input.commandId)
      return this.runCommand(
        input.sessionId,
        input.commandId,
        () => this.stopSession({ sessionId: input.sessionId }),
        input.commandFingerprint,
      )
    const session = this.sessions.get(input.sessionId)
    if (!session) return sessionNotFound()
    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!adapter) return { ok: false, message: 'Conversation provider is unavailable.' }

    const turnId = session.activeTurnId
    if (turnId) {
      this.cancelActiveTurn(session)
      await this.emit(
        session,
        this.eventForSession(session, 'turn_failed', {
          turnId,
          reason: 'interrupted',
          message: 'Conversation stopped.',
        }),
        { allowCanceledTurnId: turnId },
      )
    }
    await this.emitAll(session, adapter.stopSession(session), { allowCanceledTurnId: turnId })
    // A child still being spawned when the stop came is cancelled, not left behind.
    adapter.disposeChildProcess?.(session.sessionId)
    const path = this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)
    await this.eventLog.close(path)
    await this.indexRefreshes.get(path)
    await this.closeToolStreams(session)
    session.activeTurnId = null
    session.pendingRequestId = null
    session.turnLockRequestId = null
    session.pendingApprovalRequestIds.clear()
    session.activeTurnAbort = null
    session.status = 'stopped'
    this.approvalRules.dropSession(session.sessionId)
    session.approvalRequests.clear()
    session.automaticApprovals.clear()
    session.answeredApprovals.clear()
    // Kept only to be listed until the chat's next session supersedes it, so
    // it holds nothing a turn would need.
    session.history = null
    session.canceledTurnIds.clear()
    session.runningSubagents.clear()
    session.backgroundAgents = 0
    session.backgroundTasks = undefined
    session.pendingSkills = undefined
    session.invokedSkills = undefined
    session.updatedAt = this.now()
    this.releaseTranscript(session)
    return { ok: true, session: this.toSummary(session) }
  }

  // Settle and Snooze: whatever the session is doing ends now. A running turn
  // is interrupted and the child process disposed, as the idle sweep does, so
  // the session and its resume cursor stay and the next message respawns the
  // child. Not `stopSession`: a stopped session refuses every later turn, and
  // a settled chat can be un-settled and typed into.
  async suspendSession(input: ConversationSuspendSessionInput): Promise<ConversationSessionActionResult> {
    const session = this.sessions.get(input.sessionId)
    if (!session) return sessionNotFound()
    if (session.status === 'stopped') return { ok: true, session: this.toSummary(session) }
    if (session.activeTurnId) {
      const interrupted = await this.interrupt({ sessionId: session.sessionId })
      if (!interrupted.ok) return interrupted
    }
    // Also while the session is still starting, or a send is spawning its
    // child: disposing cancels a spawn in flight, which would otherwise leave
    // a child running that nothing is waiting for.
    // Forced: Settle and Snooze end the child even while an agent it spawned
    // is working, which the idle sweep never does.
    if (this.getAdapterForProviderId(session.providerId)?.disposeChildProcess?.(session.sessionId, { force: true }))
      // No child is left to send events for a turn it was told to cancel.
      session.canceledTurnIds.clear()
    const path = this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)
    void this.eventLog.close(path)
    await this.indexRefreshes.get(path)
    // A settled chat drops what it holds, as a settled terminal agent does; a
    // send after it is woken reads back what it needs.
    if (!isSessionBusy(session)) {
      session.history = null
      session.approvalRequests.clear()
      session.automaticApprovals.clear()
      session.answeredApprovals.clear()
    }
    this.releaseTranscript(session)
    this.markResting(session)
    return { ok: true, session: this.toSummary(session) }
  }

  // Resume in terminal, the chat's half: what a terminal needs to take this
  // chat's CLI session over. A running turn or agent does not refuse it: the
  // caller stops those (`stopForTerminalHandoff`) before the terminal starts,
  // since the terminal and the chat's child would both write to the one
  // session. Everything that does refuse is checked here first, so a handoff
  // that cannot happen never stops anything.
  async terminalHandoffTarget(input: {
    sessionId: string
  }): Promise<{ ok: true; target: ConversationTerminalHandoffTarget } | { ok: false; message: string }> {
    const session = this.sessions.get(input.sessionId)
    if (!session) return { ok: false, message: 'Conversation session is invalid.' }
    // One handoff at a time: a second would open a second terminal on the session.
    if (this.terminalHandoffs.has(session.sessionId))
      return { ok: false, message: 'This chat is already moving to a terminal.' }
    if (!session.stateful)
      return { ok: false, message: 'This chat has no CLI session behind it for a terminal to resume.' }
    // Still opening, it has no settled CLI session to hand over yet.
    if (session.status === 'starting')
      return { ok: false, message: 'The chat is still starting. Try again in a moment.' }
    const cursor = await this.readResumeCursor(
      session.workspaceRoot,
      session.workspaceId,
      session.agentId,
      session.providerId,
    )
    // A turn that is running reports where the CLI session stands once it
    // reaches the CLI: its first turn names the session, and the turn after
    // Edit from here names the fork. Until then there is nothing to hand over.
    if (isSessionBusy(session) && (!cursor?.sessionId || cursor.at))
      return { ok: false, message: 'The agent has not opened its CLI session yet. Try again in a moment.' }
    if (!cursor?.sessionId) return { ok: false, message: 'This chat has no CLI session yet. Send it a message first.' }
    // A fork's CLI session is made by its first turn. Until then the id is
    // the chat it was forked from, and a terminal resuming it would carry
    // that chat on instead of this one.
    if (cursor.forked && cursor.at)
      return {
        ok: false,
        message:
          'This chat was forked from another and has no CLI session of its own yet. Send it a message first, so a terminal resumes the fork and not the chat it came from.',
      }
    // After Edit from here the chat's next turn forks the CLI session at an
    // earlier point. A terminal resuming the id would load the turns the
    // person edited away.
    if (cursor.at)
      return {
        ok: false,
        message:
          'This chat was taken back to an earlier message. Send it a message first, so a terminal resumes it from where it now stands.',
      }
    return {
      ok: true,
      target: {
        workspaceId: session.workspaceId,
        agentId: session.agentId,
        providerId: session.providerId,
        modelId: session.modelId,
        workspaceRoot: session.workspaceRoot,
        providerSessionId: cursor.sessionId,
        ...(session.permissionPreset ? { permissionPreset: session.permissionPreset } : {}),
        ...(session.permissionPreset && session.permissionMode ? { permissionMode: session.permissionMode } : {}),
        ...(session.cliRuntimes ? { cliRuntimes: session.cliRuntimes } : {}),
      },
    }
  }

  // Resume in terminal, when the chat is still working: the agent is stopped
  // first, by the composer's Stop (`interrupt`), which answers no to whatever
  // card it was waiting on, and once that has settled the chat is suspended,
  // so its child is gone before the terminal opens the session. Agents the
  // chat started live in that child and end with it; their cards are closed
  // here rather than left showing agents nothing is running. Until
  // `endTerminalHandoff`, a send is refused (see `sendTurn`).
  async stopForTerminalHandoff(input: {
    sessionId: string
  }): Promise<{ ok: true; stopped: { turn: boolean; agents: number } } | { ok: false; message: string }> {
    const session = this.sessions.get(input.sessionId)
    if (!session) return { ok: false, message: 'Conversation session is invalid.' }
    this.terminalHandoffs.add(session.sessionId)
    const turn = isSessionBusy(session)
    if (session.activeTurnId) {
      const interrupted = await this.interrupt({ sessionId: session.sessionId })
      // The turn can end by itself while it is being stopped; that is no failure.
      if (!interrupted.ok && session.activeTurnId) return interrupted
    }
    const suspended = await this.suspendSession({ sessionId: session.sessionId })
    if (!suspended.ok) return suspended
    const agents = Array.from(session.runningSubagents.values())
    for (const agent of agents)
      await this.emit(
        session,
        this.eventForSession(session, 'subagent_status', {
          ...agent,
          status: 'stopped',
          error: 'The agent stopped when the conversation moved to a terminal.',
        }),
      )
    return { ok: true, stopped: { turn, agents: agents.length } }
  }

  endTerminalHandoff(input: { sessionId: string }): void {
    this.terminalHandoffs.delete(input.sessionId)
  }

  // Tell the chat where its conversation went, in its own tray. Said only of
  // a handoff that happened: from here the terminal drives the session.
  async noteTerminalHandoff(input: { sessionId: string; notice: string }): Promise<void> {
    const session = this.sessions.get(input.sessionId)
    if (!session) return
    this.handedToTerminal.add(`${session.workspaceId}\0${session.agentId}`)
    await this.emit(session, this.eventForSession(session, 'session_updated', { notice: input.notice }))
  }

  /** The folder a session works in (a run's worktree when it has one), or null for a session not here. */
  sessionWorkspaceRoot(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.workspaceRoot ?? null
  }

  listSessions(input: ConversationListSessionsInput = {}): ConversationListSessionsResult {
    const sessions = Array.from(this.sessions.values())
      .filter((session) => !input.workspaceId || session.workspaceId === input.workspaceId)
      .filter((session) => !input.agentId || session.agentId === input.agentId)
      .map((session) => this.toSummary(session))
    return { ok: true, sessions }
  }

  // ── Lifecycle parity (idle disposal, quit disposal, process inventory) ────

  setIdleThresholdMs(value: unknown): void {
    this.idleThresholdMs = clampSuspendIdleAfterMs(value)
  }

  /**
   * Sweep for idle children every few minutes. With the machine's activity it
   * rests while the machine sleeps, as the app's other pollers do, and picks
   * up again on waking: nothing on a sleeping machine is worth a wakeup.
   */
  startIdleSweep(activity?: Pick<PowerActivity, 'isSuspended' | 'onSuspend' | 'onResume'>): void {
    if (activity && !this.idleSweepActivity) {
      const disposers = [
        activity.onSuspend(() => this.clearIdleSweepTimer()),
        activity.onResume(() => this.armIdleSweepTimer()),
      ]
      this.idleSweepActivity = () => {
        for (const dispose of disposers) dispose()
      }
    }
    if (!activity?.isSuspended()) this.armIdleSweepTimer()
  }

  stopIdleSweep(): void {
    this.idleSweepActivity?.()
    this.idleSweepActivity = null
    this.clearIdleSweepTimer()
  }

  private armIdleSweepTimer(): void {
    if (this.idleSweepTimer) return
    this.idleSweepTimer = setInterval(() => {
      this.sweepIdleSessions()
    }, IDLE_SWEEP_INTERVAL_MS)
    this.idleSweepTimer.unref?.()
  }

  private clearIdleSweepTimer(): void {
    if (!this.idleSweepTimer) return
    clearInterval(this.idleSweepTimer)
    this.idleSweepTimer = null
  }

  // Dispose the child process of every idle stateful session, keeping the
  // session (and its resume cursor) so the next turn transparently respawns.
  // Never disposes mid-turn, while an approval/question card is pending, or
  // while an agent, shell or monitor the chat started is still running: each
  // outlives the turn that launched it and works without moving `updatedAt`,
  // and each lives in the child this would end. A monitor ended this way
  // never wakes the agent it was set for, and a dev server just stops.
  sweepIdleSessions(now: number = this.now()): string[] {
    const disposed: string[] = []
    for (const session of this.sessions.values()) {
      if (isSessionBusy(session) || session.runningSubagents.size > 0 || session.backgroundTasks) continue
      if (now - session.updatedAt < this.idleThresholdMs) continue
      // An idle chat does not hold a file handle open for the rest of the run;
      // its next event reopens the stream.
      void this.eventLog.close(this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId))
      if (!session.stateful) continue
      if (session.status !== 'ready' && session.status !== 'failed') continue
      const adapter = this.getAdapterForProviderId(session.providerId)
      if (adapter?.disposeChildProcess?.(session.sessionId)) {
        disposed.push(session.sessionId)
        this.markResting(session)
      }
    }
    return disposed
  }

  /**
   * The session's child is gone and the session stays: its summary says so,
   * and every window's session list is told to read it again. Nothing is
   * written to the transcript, since nothing happened in the chat; the event
   * has no sequence number, so a chat reading its own events drops it.
   */
  private markResting(session: RuntimeSession): void {
    if (session.resting || session.status === 'stopped') return
    session.resting = true
    const event = this.eventForSession(session, 'session_updated', { resting: true })
    event.id = `conv_evt_${this.eventEpoch}_${++this.eventSequence}`
    event.createdAt = this.now()
    this.notify(event)
  }

  // Live child processes across all adapters, shaped like terminal roots so
  // workspace-memory attribution and the process tree can consume them as-is.
  listLiveConversationRoots(): TerminalRootInfo[] {
    const roots: TerminalRootInfo[] = []
    for (const adapter of this.adapters.values()) {
      for (const live of adapter.listLiveSessions?.() ?? []) {
        if (!live.childPid) continue
        // The CLI the chat runs, for the process tree and memory attribution;
        // an adapter id names no CLI.
        const providerId = this.sessions.get(live.sessionId)?.providerId ?? adapter.id
        roots.push({
          sessionId: live.sessionId,
          rootPid: live.childPid,
          workspaceId: live.workspaceId || null,
          agentId: live.agentId || null,
          terminalId: null,
          kind: 'agent',
          cli: cliForConversationProvider(providerId),
          activityKind: live.turnActive ? 'working' : 'idle',
          processAlive: true,
          startedAt: live.spawnedAt ?? live.lastActivityAt,
        })
      }
    }
    return roots
  }

  /**
   * The folders chats are working in right now: a live provider child's
   * working directory, or a running turn's. The agent worktree cleanup never
   * removes one from under it, as it never does a live terminal's. A resting
   * session (no child, no turn) is not here: its next turn waits on the
   * chat's worktree being on disk before it respawns there. A promise because
   * the shell asks it of an out-of-process server the same way.
   */
  liveConversationWorkspaceRoots(): Promise<string[]> {
    const roots = new Set<string>()
    for (const adapter of this.adapters.values()) {
      for (const live of adapter.listLiveSessions?.() ?? []) {
        if ((live.hasChildProcess || live.turnActive) && live.workspaceRoot) roots.add(live.workspaceRoot)
      }
    }
    for (const session of this.sessions.values()) {
      if (session.activeTurnId && session.workspaceRoot) roots.add(session.workspaceRoot)
    }
    return Promise.resolve([...roots])
  }

  // App-quit disposal: stop every live session so no headless child outlives
  // the app. Sessions keep their resume cursors in the JSONL transcripts.
  /**
   * Put every chat's buffered transcript on disk without stopping anything.
   * The first thing quit does for chats: the streamed text is what a person
   * would miss, and stopping each session (the rest of `shutdown`) can take
   * longer than a quit that is being cut short allows.
   */
  async flushTranscripts(): Promise<void> {
    await this.eventLog.flush()
  }

  async shutdown(): Promise<void> {
    this.stopIdleSweep()
    // All at once: each stop waits on its own child to go, and one after
    // another, a quit with many chats open outran any budget its caller has.
    // Best-effort each: adapter disposeAll below is the backstop.
    await Promise.allSettled(
      Array.from(this.sessions.values())
        .filter((session) => session.status !== 'stopped')
        .map((session) => this.stopSession({ sessionId: session.sessionId })),
    )
    await Promise.allSettled(Array.from(this.adapters.values(), async (adapter) => adapter.disposeAll?.()))
    this.dropToolPreviews()
    // A running tool's newest output still waiting out its write's window.
    await this.toolDetailWrites.flushAll()
    // Housekeeping can queue more of itself as it settles (a lost sequence
    // number recorded again after a newer one), so drain until none is left.
    while (this.background.size) await Promise.allSettled(this.background)
    await this.eventLog.closeAll()
    // The last writes can fail as they flush, and record their loss.
    while (this.background.size) await Promise.allSettled(this.background)
  }

  private runInBackground(task: Promise<unknown>): void {
    const tracked = task.catch(() => undefined).finally(() => this.background.delete(tracked))
    this.background.add(tracked)
  }

  private async validateStartInput(
    input: ConversationStartSessionInput,
  ): Promise<{ ok: true; adapter: ConversationProviderAdapter } | { ok: false; message: string }> {
    if (!input.workspaceRoot?.trim()) return { ok: false, message: 'Workspace root is required.' }
    try {
      const stats = await this.stat(input.workspaceRoot)
      if (!stats.isDirectory()) return { ok: false, message: 'Workspace path is unavailable.' }
    } catch {
      return { ok: false, message: 'Workspace path is unavailable.' }
    }

    const providerId = input.providerId.trim()
    const registryProvider = this.getProviderById(providerId)
    const adapter = this.getAdapterForProviderId(providerId)
    if (!adapter && !registryProvider) return { ok: false, message: 'Conversation provider is not installed.' }

    if (registryProvider?.adapter.execution === 'blocked') {
      return {
        ok: false,
        message: registryProvider.adapter.trustError ?? 'Conversation provider adapter is not trusted for execution.',
      }
    }

    // Providers with a live catalog (e.g. OpenRouter) accept any model id from
    // their `/models` endpoint, which is not in the static seed list — so only
    // enforce seed membership for static-only providers. Agent-harness
    // providers ride a local CLI whose model vocabulary (aliases like
    // 'opus[1m]', full model ids, custom ids) is far wider than the manifest
    // seed, so the CLI is the validator there too. A truly invalid model is
    // surfaced by the provider as a `turn_failed` model error at call time.
    const supportsDynamicModels =
      Boolean(registryProvider?.manifest.openaiCompatible?.modelsPath) ||
      registryProvider?.manifest.providerType === 'agent-harness'
    if (!input.modelId.trim()) return { ok: false, message: 'Conversation model is invalid.' }
    if (!supportsDynamicModels) {
      const models = registryProvider?.manifest.models.map((model) => model.id) ?? adapter?.listModels() ?? []
      if (!models.includes(input.modelId.trim())) return { ok: false, message: 'Conversation model is invalid.' }
    }

    if (registryProvider?.manifest.auth) {
      const secretStatus = await this.secretStore.getStatus(providerId)
      if (!secretStatus.ok) return { ok: false, message: secretStatus.message }
      if (!secretStatus.status.configured)
        return { ok: false, message: 'Conversation provider secret is not configured.' }
    }

    if (!adapter) return { ok: false, message: 'Conversation provider adapter is unavailable.' }

    return { ok: true, adapter }
  }

  private getAdapterForProviderId(providerId: string): ConversationProviderAdapter | undefined {
    const direct = this.adapters.get(providerId)
    if (direct) return direct
    const provider = this.getProviderById(providerId)
    if (provider?.manifest.openaiCompatible) return this.adapters.get('openai-compatible-api')
    return undefined
  }

  private async resolveSecret(
    providerId: string,
  ): Promise<{ ok: true; value: string } | { ok: false; message: string }> {
    if (!this.secretStore.resolveSecret) {
      return { ok: false, message: 'Conversation provider secret resolver is unavailable.' }
    }
    return this.secretStore.resolveSecret(providerId)
  }

  private cancelActiveTurn(session: RuntimeSession): void {
    const turnId = session.activeTurnId
    if (!turnId) return
    session.canceledTurnIds.add(turnId)
    session.activeTurnAbort?.abort()
    // A send's stream settles when the send returns; a continuation's has no
    // send to return, and its adapter may end it without another event.
    this.closeContinuation(session)
  }

  private closeContinuation(session: RuntimeSession): void {
    const running = session.providerTurn
    if (!running?.continuation) return
    session.providerTurn = null
    running.settle({ ok: true, session: this.toSummary(session) })
  }

  private async emitAll(
    session: RuntimeSession,
    events: ConversationProviderEventStream,
    options: { turnId?: string; allowCanceledTurnId?: string | null; collectText?: boolean } = {},
  ): Promise<EmittedSummary> {
    const { collectText, ...emitOptions } = options
    const emitted: EmittedSummary = {
      approvalsRequested: 0,
      approvalsResolved: 0,
      completed: false,
      failed: false,
      text: '',
    }
    const count = (stamped: ConversationEvent | null): void => {
      if (stamped?.type === 'approval_requested') emitted.approvalsRequested++
      else if (stamped?.type === 'approval_resolved') emitted.approvalsResolved++
      else if (stamped?.type === 'turn_completed') emitted.completed = true
      else if (stamped?.type === 'turn_failed') emitted.failed = true
      else if (collectText && stamped?.type === 'content_delta' && typeof stamped.payload?.text === 'string')
        emitted.text += stamped.payload.text
    }
    const resolved = await events
    if (isAsyncIterable(resolved)) {
      for await (const event of resolved) count(await this.emit(session, event, emitOptions))
      return emitted
    }
    for (const event of resolved) count(await this.emit(session, event, emitOptions))
    return emitted
  }

  private async emit(
    session: RuntimeSession,
    event: ConversationEvent,
    options: EmitOptions = {},
  ): Promise<ConversationEvent | null> {
    const path = this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)
    const result = (this.emissionTails.get(path) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.emitNow(session, event, options))
      .finally(() => this.noteSettled(session))
    this.emissionTails.set(path, result)
    return result
  }

  private async emitNow(
    session: RuntimeSession,
    event: ConversationEvent,
    options: EmitOptions,
  ): Promise<ConversationEvent | null> {
    // A provider stream a steer moved on: what it still sends as the turn it
    // was sent for is the turn the steer opened.
    const moved = session.providerTurn
    if (moved && moved.turnId !== moved.streamTurnId) {
      const payloadTurnId = typeof event.payload?.turnId === 'string' ? event.payload.turnId : undefined
      if ((payloadTurnId ?? options.turnId) === moved.streamTurnId) {
        if (payloadTurnId) event = { ...event, payload: { ...event.payload, turnId: moved.turnId } }
        options = { ...options, turnId: moved.turnId }
      }
    }
    if (this.shouldSuppressEvent(session, event, options)) return null
    // A turn a steer ended goes on as the next one: its tools keep running, its
    // cards stay open, and nothing is settled until the stream really ends.
    const steered = event.type === 'turn_completed' && event.payload?.steered === true
    const ends = (event.type === 'turn_completed' || event.type === 'turn_failed') && !steered
    const eventTurnId = typeof event.payload?.turnId === 'string' ? event.payload.turnId : options.turnId
    if (ends && session.providerTurn && eventTurnId === session.providerTurn.turnId)
      session.providerTurn.finished = true
    // A preview still waiting when its turn ends is the newest output of a
    // tool that never sent a final one: it goes out ahead of the turn's end.
    if (ends) await this.flushToolPreviews(session)
    const path = this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)
    // Preparing stores the output in the tool's detail file, so it happens for
    // every event, including a preview that is then held back.
    const prepared = options.prepared ? event : await this.prepareToolEvent(session, event)
    if (!options.prepared && this.holdToolPreview(session, prepared, options)) return null
    const stamped: ConversationEvent = {
      ...prepared,
      id: `conv_evt_${this.eventEpoch}_${++this.eventSequence}`,
      seq: (this.sequences.get(path) ?? 0) + 1,
      createdAt: this.now(),
    }
    this.sequences.set(path, stamped.seq!)
    if (stamped.type === 'user_message' || (stamped.type === 'turn_started' && session.checkpointTurnSeq === null))
      session.checkpointTurnSeq = stamped.seq!
    if (stamped.type === 'tool_started')
      await this.captureBeforeTool(session, String(stamped.payload?.name ?? stamped.payload?.tool ?? ''))
    if (ends && session.checkpointCaptured && session.checkpointTurnSeq) {
      const checkpoint = await this.checkpoints.capture(session, session.checkpointTurnSeq, 'post')
      stamped.payload = {
        ...stamped.payload,
        checkpointTurnSeq: session.checkpointTurnSeq,
        checkpointAvailable: checkpoint.ok,
      }
      if (checkpoint.ok) {
        const diff = await this.checkpoints.getTurnDiff({ key: session, turnSeq: session.checkpointTurnSeq })
        if (diff.ok)
          stamped.payload.checkpointSummary = {
            files: diff.diff.files.length,
            addedLines: diff.diff.files.reduce((sum, file) => sum + file.addedLines, 0),
            removedLines: diff.diff.files.reduce((sum, file) => sum + file.removedLines, 0),
          }
      }
    }
    this.trackStatefulSessionEvent(session, stamped)
    let automaticRequestId: string | undefined
    if (stamped.type === 'approval_requested' && typeof stamped.payload?.requestId === 'string') {
      const request: PermissionModeRequest = {
        action: String(stamped.payload.action ?? ''),
        input: this.approvalCheckInput(session, stamped.payload.input),
        toolKind: stamped.payload.toolKind as PermissionModeRequest['toolKind'],
        requestKind: String(stamped.payload.kind ?? 'tool'),
        defaultToNo: stamped.payload.defaultToNo === true,
        suppressAlwaysAllowRule: stamped.payload.suppressAlwaysAllowRule === true,
        mustAsk: stamped.payload.mustAsk === true,
      }
      const requestId = stamped.payload.requestId
      session.approvalRequests.set(requestId, request)
      // Whether "allow for this conversation" can be remembered, in the words
      // this app's own menu uses: a client on another machine has no
      // workspace root to work either out from.
      if (request.requestKind === 'tool') {
        const candidate = approvalRuleCandidate(request, session.workspaceRoot)
        stamped.payload = {
          ...stamped.payload,
          rememberable: candidate !== null,
          ...(candidate ? { rememberLabel: approvalRememberLabels(candidate).conversation } : {}),
        }
      }
      // Decide whether a human is needed before publication, so remembered
      // grants never briefly trigger OS attention.
      // Resolution starts only after this request has persisted and published.
      // A remembered rule first, then the chat's permission mode: a request
      // either one answers never reaches the person.
      session.unpublishedApprovals.add(requestId)
      const rule = await this.approvalRules
        .match(session.workspaceRoot, session.sessionId, request)
        .catch(() => null)
        .finally(() => session.unpublishedApprovals.delete(requestId))
      const mode = session.permissionPreset
      const label =
        rule?.label ??
        (permissionModeAllows(mode, request, session.workspaceRoot) ? permissionModeApprovalLabel(mode!) : null)
      if (
        label &&
        session.approvalRequests.has(requestId) &&
        !session.answeredApprovals.has(requestId) &&
        session.status !== 'stopped'
      ) {
        session.automaticApprovals.set(requestId, label)
        stamped.payload = { ...stamped.payload, autoApproved: true, ruleLabel: label }
        automaticRequestId = requestId
      }
    } else if (stamped.type === 'approval_resolved' && typeof stamped.payload?.requestId === 'string') {
      const requestId = stamped.payload.requestId
      const ruleLabel = session.automaticApprovals.get(requestId)
      if (ruleLabel) stamped.payload = { ...stamped.payload, autoApproved: true, ruleLabel }
      session.approvalRequests.delete(requestId)
      session.automaticApprovals.delete(requestId)
    }
    this.updateExcerpts(session, stamped)
    // Streamed events join the transcript's write batch and are published when
    // it lands, without holding the emission queue for the disk: the next token
    // is stamped while this one waits. Batches resolve in order and each
    // publication is registered before the next event is stamped, so listeners
    // still see sequence order.
    if (isStreamedEvent(stamped)) {
      this.persistEvent(session, stamped).then(
        (outcome) => this.publish(session.workspaceRoot, path, stamped, outcome),
        () => undefined,
      )
      return stamped
    }
    const outcome = await this.persistEvent(session, stamped)
    if (ends) await this.closeToolStreams(session)
    // Publish status at the same boundary as the terminal notification, after
    // persistence. Pollers and event-driven consumers must observe one state.
    if (session.status !== 'stopped' && ends) {
      session.status = stamped.type === 'turn_completed' ? 'ready' : 'failed'
      session.updatedAt = this.now()
    }
    this.publish(session.workspaceRoot, path, stamped, outcome)
    // The thread index is a cache, and a listing brings a stale row up to date
    // itself: refreshing it after the turn's end is out never holds that end,
    // or the events queued behind it, back from the chat.
    if (ends && stamped.type === 'turn_completed' && session.status !== 'stopped') {
      const refresh = this.threadIndex
        .refresh(session)
        .catch(() => undefined)
        .finally(() => {
          if (this.indexRefreshes.get(path) === refresh) this.indexRefreshes.delete(path)
        })
      this.indexRefreshes.set(path, refresh)
      this.runInBackground(refresh)
    }
    if (automaticRequestId)
      void this.respondToRequest({
        sessionId: session.sessionId,
        requestId: automaticRequestId,
        approved: true,
        decision: 'once',
      }).catch(() => undefined)
    return stamped
  }

  private updateExcerpts(session: RuntimeSession, event: ConversationEvent): void {
    // The prompt cache, from the requests the provider saw start (and reset by
    // a compaction) — the same fold the chat's own projection makes.
    const promptCache = applyPromptCacheEvent(session.promptCache ?? null, event)
    if (promptCache) session.promptCache = promptCache
    if ((event.type === 'session_started' || event.type === 'session_updated') && event.payload?.capabilities)
      session.capabilities = {
        ...session.capabilities,
        ...(event.payload.capabilities as import('../shared/conversation-runtime').ConversationCapabilities),
      }
    // The provider reports the whole list each time it changes; an empty one
    // says nothing runs any more.
    if (event.type === 'session_updated') {
      const backgroundTasks = readBackgroundTasks(event.payload)
      if (backgroundTasks) session.backgroundTasks = backgroundTasks.length > 0 ? backgroundTasks : undefined
    }
    if (event.type === 'session_updated' && typeof event.payload?.revertedAfterSeq === 'number')
      session.revertedNote = `Files were ${event.payload.undo ? 'restored from the undo checkpoint' : `reverted to before conversation turn ${event.payload.revertedAfterSeq}`}. Inspect the current files before continuing; later transcript messages describe the previous file state.`
    // The files its tool calls touch, a background agent's included: the Files
    // tree marks where the work is, whoever in the conversation is doing it.
    const fileActivity = applyFileActivityEvent(session.fileActivity ?? [], event, session.workspaceRoot)
    if (fileActivity) session.fileActivity = fileActivity.length > 0 ? fileActivity : undefined
    // A background agent's step between turns is not what the conversation is
    // doing: it would name a tool while the conversation sits idle.
    const ownStep = !isTurnlessSubagentStep(event)
    if (ownStep && event.type === 'tool_started')
      session.currentToolTitle = presentToolItem({
        kind: event.payload?.kind as import('../shared/conversation-runtime').ConversationToolKind,
        name: String(event.payload?.name ?? event.payload?.tool ?? ''),
        input: event.payload?.input as ConversationJsonValue | undefined,
        status: 'running',
        ...(typeof event.payload?.displayTitle === 'string' ? { displayTitle: event.payload.displayTitle } : {}),
        ...(typeof event.payload?.serverName === 'string' ? { serverName: event.payload.serverName } : {}),
      }).title
    // Summarising the conversation is the step, until the summary lands.
    else if (event.type === 'context_compacting') session.currentToolTitle = 'Compacting'
    // Streamed output (`partial`) arrives while the tool is still running.
    else if (
      event.type === 'context_compacted' ||
      (ownStep && event.type === 'tool_output' && event.payload?.partial !== true) ||
      (event.type === 'turn_completed' && event.payload?.steered !== true) ||
      event.type === 'turn_failed'
    )
      session.currentToolTitle = undefined
    // A steered turn's end is not the session's: the work goes on.
    if (event.type === 'turn_completed' && event.payload?.steered === true) return
    // When the last turn ended, read off the event rather than the clock so
    // the transcript replay on resume restores the true time, not the resume.
    if (event.type === 'turn_completed' || event.type === 'turn_failed') session.lastTurnEndedAt = event.createdAt
    const wasWaiting = isWaitingPhase(session.phase)
    // A turn the person stopped ended where they asked it to: the chat reads as
    // done, as its own transcript does, not as failed and needing a look.
    if (event.type === 'turn_completed' || (event.type === 'turn_failed' && isInterruptedTurn(event)))
      session.phase = 'completed'
    else if (event.type === 'turn_failed') session.phase = 'failed'
    else if (event.type === 'approval_resolved' && session.pendingApprovalRequestIds.size > 0) {
      // Another card is still up: the turn is still waiting on a person.
      const remaining = session.approvalRequests.get(Array.from(session.pendingApprovalRequestIds).at(-1)!)
      session.phase = remaining?.requestKind === 'question' ? 'waiting_for_input' : 'waiting_for_approval'
    } else if (event.type === 'turn_started' || event.type === 'user_message' || event.type === 'approval_resolved')
      session.phase = 'running'
    else if (event.type === 'approval_requested')
      session.phase = event.payload?.kind === 'question' ? 'waiting_for_input' : 'waiting_for_approval'
    // When it started waiting on the person, for "the next chat that needs
    // you" to visit the longest-waiting first.
    if (!isWaitingPhase(session.phase)) session.waitingSince = undefined
    else if (!wasWaiting || session.waitingSince === undefined)
      session.waitingSince = event.createdAt > 0 ? event.createdAt : this.now()
    if (event.type === 'subagent_status') {
      const status = readSubagentStatus(event.payload)
      if (status?.status === 'running')
        session.runningSubagents.set(status.toolUseId, {
          ...session.runningSubagents.get(status.toolUseId),
          ...status,
        })
      else if (status) session.runningSubagents.delete(status.toolUseId)
      session.backgroundAgents = Array.from(session.runningSubagents.values()).filter(
        (agent) => agent.background,
      ).length
    }
    // Read off the event, as the turn's end is, so a resume restores it. An
    // image-only message is the person's input too; one Studio sent (a
    // launched agent's notice, a resume after a usage limit) is not, and
    // neither moves the clock nor becomes the chat's first or last words.
    const fromPerson = event.type === 'user_message' && !readConversationMessageOrigin(event.payload?.origin)
    if (event.type === 'user_message' && !fromPerson) {
      session.lastAssistantText = ''
      session.lastAssistantTail = ''
    }
    if (fromPerson && event.createdAt > 0)
      session.lastUserMessageAt = Math.max(session.lastUserMessageAt ?? 0, event.createdAt)
    if (fromPerson && typeof event.payload?.text === 'string') {
      // An image-only turn carries no text, and an empty excerpt would pin the
      // chat's "first message" to nothing: the first turn with words keeps it.
      if (!session.firstUserText && event.payload.text.trim()) session.firstUserText = event.payload.text.slice(0, 240)
      session.lastUserText = event.payload.text.slice(0, 240)
      session.lastAssistantText = ''
      session.lastAssistantTail = ''
    } else if (event.type === 'content_delta' && typeof event.payload?.text === 'string') {
      // The opening is the sidebar's preview; the end is where an agent puts
      // its conclusion, which a launch notice quotes.
      session.lastAssistantText = ((session.lastAssistantText ?? '') + event.payload.text).slice(0, 240)
      session.lastAssistantTail = ((session.lastAssistantTail ?? '') + event.payload.text).slice(
        -LAST_ASSISTANT_TAIL_CHARS,
      )
    }
  }

  /**
   * Whether a session's command id has a receipt, or is being carried out
   * now: a repeat of it is answered from that receipt rather than run. A
   * caller that would otherwise need what the first attempt carried (a
   * picture it staged and has since let go of) asks this first.
   */
  async hasCommandReceipt(sessionId: string, commandId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    const path = this.receiptsPath(session)
    if (this.pendingCommands.has(`${path}:${commandId}`)) return true
    try {
      return (await this.loadReceipts(session.workspaceRoot, path)).has(commandId)
    } catch {
      return false
    }
  }

  private receiptsPath(session: { workspaceRoot: string; workspaceId: string; agentId: string }): string {
    return this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId).replace(
      /\.jsonl$/,
      '.receipts.json',
    )
  }

  private runCommand(
    sessionId: string,
    commandId: string,
    action: () => Promise<ConversationSessionActionResult>,
    fingerprint?: string,
    /**
     * A refusal known before anything runs, asked once a retry of a command
     * already carried out has been answered from its receipt: a command it
     * turns away is answered without an intent written for it.
     */
    refuseEarly?: () => ConversationSessionActionResult | null,
  ): Promise<ConversationSessionActionResult> {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.resolve(sessionNotFound())
    const path = this.receiptsPath(session)
    const key = `${path}:${commandId}`
    // A command id is the client's promise that it names one command. The
    // same id for a different command (by its fingerprint, where the caller
    // gave one) is refused, never answered with the first command's result.
    const conflict = (known: string | undefined) => Boolean(fingerprint && known && known !== fingerprint)
    const pending = this.pendingCommands.get(key)
    if (pending) return conflict(this.pendingFingerprints.get(key)) ? Promise.resolve(commandIdConflict()) : pending
    const result = (async (): Promise<ConversationSessionActionResult> => {
      let receipts: Map<string, ConversationSessionActionResult>
      try {
        receipts = await this.loadReceipts(session.workspaceRoot, path)
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Command receipts are unavailable.' }
      }
      const prior = receipts.get(commandId)
      if (prior) return conflict(receiptFingerprint(prior)) ? commandIdConflict() : withoutFingerprint(prior)
      const refused = refuseEarly?.()
      if (refused) return refused
      const persist = async () => {
        while (receipts.size > 256) receipts.delete(receipts.keys().next().value!)
        const serialized = JSON.stringify(Array.from(receipts))
        const write = (this.receiptWrites.get(path) ?? Promise.resolve())
          .catch(() => undefined)
          .then(() => writeConversationStorage(session.workspaceRoot, path, serialized))
        this.receiptWrites.set(path, write)
        await write
      }
      // The fingerprint is kept inside the receipt, so the file keeps its
      // shape and one written before fingerprints reads as it always has.
      const stamped = (value: ConversationSessionActionResult): ConversationSessionActionResult =>
        fingerprint ? Object.assign({}, value, { fingerprint }) : value
      // Write the intent before an adapter can do work. If the process dies
      // before completion, replay this uncertainty instead of executing twice.
      receipts.set(
        commandId,
        stamped({
          ok: false,
          message:
            'This command started before the connection was interrupted. Check the conversation before sending a new command.',
        }),
      )
      try {
        await persist()
      } catch (error) {
        // Nothing ran: a retry may execute it.
        receipts.delete(commandId)
        return { ok: false, message: error instanceof Error ? error.message : 'Command could not be recorded.' }
      }
      // A command that throws has still finished, so its failure is its result:
      // a retry is answered with it rather than with the crash-era uncertainty.
      let receipt: ConversationSessionActionResult
      try {
        receipt = JSON.parse(JSON.stringify(await action())) as ConversationSessionActionResult
      } catch (error) {
        receipt = { ok: false, message: error instanceof Error ? error.message : 'Conversation command failed.' }
      }
      // A `busy` refusal ran nothing, and is no answer to keep: a retry under
      // the same id, once the turn in its way is over, runs the command.
      if (!receipt.ok && receipt.code === 'busy') receipts.delete(commandId)
      else receipts.set(commandId, stamped(receipt))
      await persist().catch(() => undefined)
      return receipt
    })()
    this.pendingCommands.set(key, result)
    this.pendingFingerprints.set(key, fingerprint)
    void result
      .finally(() => {
        this.pendingCommands.delete(key)
        this.pendingFingerprints.delete(key)
      })
      .catch(() => undefined)
    return result
  }

  /**
   * The receipts for one conversation, read once per run. A failed read is not
   * remembered, so the next command tries again instead of every command
   * failing until restart. A receipts file that does not parse is moved aside
   * and replaced by an empty one: losing old receipts only means a very late
   * retry could run again, while refusing every command locks the chat.
   */
  private loadReceipts(root: string, path: string): Promise<Map<string, ConversationSessionActionResult>> {
    const cached = this.receipts.get(path)
    if (cached) return cached
    const loading = (async () => {
      let raw: Buffer
      try {
        raw = await readConversationStorage(root, path, MAX_CONVERSATION_METADATA_BYTES)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return new Map<string, ConversationSessionActionResult>()
        throw error
      }
      try {
        const entries = JSON.parse(raw.toString('utf8')) as unknown
        if (
          Array.isArray(entries) &&
          entries.every(
            (entry) =>
              Array.isArray(entry) &&
              entry.length === 2 &&
              typeof entry[0] === 'string' &&
              entry[1] &&
              typeof entry[1] === 'object' &&
              typeof entry[1].ok === 'boolean',
          )
        )
          return new Map<string, ConversationSessionActionResult>(entries)
      } catch {
        // Quarantined below.
      }
      console.warn(`[conversation-runtime] command receipts at ${path} are corrupt; moved aside`)
      await writeConversationStorage(root, `${path}.corrupt`, raw.toString('utf8')).catch(() => undefined)
      return new Map<string, ConversationSessionActionResult>()
    })()
    this.receipts.set(path, loading)
    loading.catch(() => {
      if (this.receipts.get(path) === loading) this.receipts.delete(path)
    })
    return loading
  }

  // Stateful adapters surface approvals mid-stream (the provider turn blocks
  // inside a permission callback while its event stream stays open), so the
  // pending-request cursor has to follow the events rather than the
  // end-of-stream summary that stateless turns use.
  private trackStatefulSessionEvent(session: RuntimeSession, event: ConversationEvent): void {
    if (!session.stateful) return
    if (event.type === 'approval_requested') {
      const requestId = typeof event.payload?.requestId === 'string' ? event.payload.requestId : null
      if (requestId) {
        session.pendingApprovalRequestIds.add(requestId)
        session.pendingRequestId = requestId
        session.status = 'awaiting_approval'
        session.updatedAt = this.now()
      }
    } else if (event.type === 'approval_resolved') {
      const requestId = typeof event.payload?.requestId === 'string' ? event.payload.requestId : null
      if (requestId) {
        session.pendingApprovalRequestIds.delete(requestId)
        session.answeredApprovals.delete(requestId)
      }
      const remaining = Array.from(session.pendingApprovalRequestIds)
      if (remaining.length > 0) {
        session.pendingRequestId = remaining[remaining.length - 1]
        session.status = 'awaiting_approval'
      } else {
        session.pendingRequestId = session.turnLockRequestId
        if (session.status === 'awaiting_approval') session.status = 'active'
      }
      session.updatedAt = this.now()
    } else if (event.type === 'turn_failed' || (event.type === 'turn_completed' && event.payload?.steered !== true)) {
      session.pendingApprovalRequestIds.clear()
      session.answeredApprovals.clear()
    }
  }

  // The session-scoped continuation channel: a stateful adapter pushes events
  // here when its child resumes after a `result` with no open sendTurn (e.g. a
  // background subagent completed and the model issued another tool call). Runs
  // outside any sendTurn IPC, so the composer stays free to end the prior turn.
  // Serialized through session.continuationTail to keep persistence ordered.
  private enqueueContinuationEvent(session: RuntimeSession, event: ConversationEvent): void {
    session.continuationTail = session.continuationTail
      .catch(() => undefined)
      .then(() => this.processContinuationEvent(session, event))
      .catch(async (error) => {
        await this.failTurn(session, error)
      })
  }

  private async processContinuationEvent(session: RuntimeSession, event: ConversationEvent): Promise<void> {
    if (session.status === 'stopped') return
    const streamTurnId = typeof event.payload?.turnId === 'string' ? event.payload.turnId : null
    // A steer may have moved the continuation on to a later turn; its events
    // are that turn's (emitNow restamps them).
    const continuing = streamTurnId && session.providerTurn?.streamTurnId === streamTurnId ? session.providerTurn : null
    const turnId = continuing ? continuing.turnId : streamTurnId
    if (turnId && session.canceledTurnIds.has(turnId)) return
    // First sight of a continuation turn: open a mirror in session state so its
    // events survive suppression and its approvals track through the normal
    // pendingRequestId path. A concurrently-completing sendTurn will see its own
    // turnId no longer active and skip its post-loop reset, so this stands.
    if (event.type === 'turn_started' && turnId && turnId !== session.activeTurnId) {
      // A live turn owns the session. The continuation raced a send that the
      // busy guard could not see yet (the channel is serialized off the send
      // path), and the adapter has since taken the turn over — so this mirror
      // would only blank the live turn by suppressing every event it has left.
      if (isSessionBusy(session)) return
      session.activeTurnId = turnId
      session.activeTurnAbort = null
      session.turnLockRequestId = null
      session.pendingRequestId = null
      session.pendingApprovalRequestIds.clear()
      session.status = 'active'
      session.checkpointTurnSeq = null
      session.checkpointCapture = null
      session.checkpointCaptured = false
      session.updatedAt = this.now()
      session.turnStartedAt = session.updatedAt
      // Only a live child carries on by itself.
      session.resting = undefined
      // From here a steer can join it, as it joins a send's turn.
      session.providerTurn = openProviderTurn(turnId, true)
    }
    await this.emit(session, event, streamTurnId ? { turnId: streamTurnId } : {})
    // Looked up again: a steer can have landed while the event waited its turn to be written.
    const stream = streamTurnId && session.providerTurn?.streamTurnId === streamTurnId ? session.providerTurn : null
    const ownTurnId = stream ? stream.turnId : streamTurnId
    const ends = event.type === 'turn_completed' || event.type === 'turn_failed'
    if (ends && stream) this.closeContinuation(session)
    if (ownTurnId && session.activeTurnId === ownTurnId && ends) {
      session.activeTurnId = null
      session.activeTurnAbort = null
      session.turnLockRequestId = null
      session.pendingRequestId = null
      session.pendingApprovalRequestIds.clear()
      session.status = event.type === 'turn_completed' ? 'ready' : 'failed'
      session.updatedAt = this.now()
      this.noteSettled(session)
    }
  }

  private shouldSuppressEvent(
    session: RuntimeSession,
    event: ConversationEvent,
    options: { turnId?: string; allowCanceledTurnId?: string | null },
  ): boolean {
    const eventTurnId =
      event.payload && typeof event.payload.turnId === 'string' ? event.payload.turnId : options.turnId
    if (!eventTurnId) return false
    if (eventTurnId === options.allowCanceledTurnId) return false
    if (session.status === 'stopped') return true
    if (session.canceledTurnIds.has(eventTurnId)) return true
    return session.activeTurnId !== eventTurnId
  }

  private eventForSession(
    session: RuntimeSession,
    type: ConversationEvent['type'],
    payload?: Record<string, unknown>,
  ): ConversationEvent {
    return {
      id: '',
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      agentId: session.agentId,
      providerId: session.providerId,
      modelId: session.modelId,
      type,
      createdAt: 0,
      payload,
    }
  }

  private applyTurnState(session: RuntimeSession, emitted: EmittedSummary, requestId: string): void {
    // A terminal event always wins: a dead turn cannot keep an approval
    // pending (e.g. the provider child crashed while a card was up — leaving
    // the session in awaiting_approval would wedge it forever, since the
    // adapter-side permission no longer exists to resolve).
    const { failed, completed } = emitted
    if (failed || completed) {
      session.pendingRequestId = null
      session.pendingApprovalRequestIds.clear()
      session.status = failed ? 'failed' : 'ready'
      session.activeTurnId = null
      session.turnLockRequestId = null
      session.updatedAt = this.now()
      return
    }
    // An approval is pending at end-of-stream only when a request was never
    // resolved. Stateless turns end their stream at the request; stateful
    // turns resolve requests mid-stream and keep going.
    if (emitted.approvalsRequested > emitted.approvalsResolved) {
      session.pendingRequestId = session.stateful ? session.pendingRequestId : requestId
      session.status = 'awaiting_approval'
    } else {
      session.pendingRequestId = null
      session.status = 'active'
    }
    session.updatedAt = this.now()
  }

  private persistEvent(session: RuntimeSession, event: ConversationEvent): Promise<ConversationAppendOutcome> {
    return this.eventLog.append(
      this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId),
      redactEvent(event),
      session.workspaceRoot,
    )
  }

  private toolDetailPath(input: ConversationToolDetailInput): string {
    return workspaceSidecarPath(
      input.workspaceRoot,
      'conversations',
      safeSegment(input.workspaceId),
      `${safeSegment(input.agentId)}.tools`,
      `${safeSegment(input.toolUseId)}.json`,
    )
  }

  async getToolDetail(input: ConversationToolDetailInput): Promise<ConversationToolDetailResult> {
    if (
      !input.workspaceRoot?.trim() ||
      !input.workspaceId?.trim() ||
      !input.agentId?.trim() ||
      !input.toolUseId?.trim()
    ) {
      return { ok: false, code: 'invalid_input', message: 'Conversation and tool identity are required.' }
    }
    const path = this.toolDetailPath(input)
    // A detail asked for mid-stream includes every chunk published so far,
    // and the newest output, which may still be waiting out its write's window.
    await this.toolStreams.get(path)?.settled()
    await this.toolDetailWrites.flush(path)
    return readToolDetail(input.workspaceRoot, path)
  }

  /**
   * The tool call a transcript recorded under one id, as its newest
   * `tool_started` says: a step can be announced again once more is known (a
   * generated picture's path arrives with its completion), and the last word
   * is the one that stands. Null when the transcript has no such call.
   */
  async findToolCall(input: ConversationToolDetailInput): Promise<{
    name: string
    kind: unknown
    input: ConversationJsonValue | undefined
    /** How the step ended, as its newest `tool_output` says; absent while it has not. */
    status?: ConversationToolStatus
    /**
     * Whether the step has ended at all (any `tool_output`, with a status or
     * from before steps carried one). Absent from a backend older than this.
     */
    ended?: boolean
  } | null> {
    if (
      !input.workspaceRoot?.trim() ||
      !input.workspaceId?.trim() ||
      !input.agentId?.trim() ||
      !input.toolUseId?.trim()
    )
      return null
    const path = this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)
    try {
      await this.eventLog.flush(path)
      const event = await this.transcripts.findLast(
        input.workspaceRoot,
        path,
        (candidate) => candidate.type === 'tool_started' && candidate.payload?.toolUseId === input.toolUseId,
        // A paired device asks for a step it was shown, so it is recent; a
        // miss past this reads as an unknown step rather than scanning the
        // whole transcript on every request.
        TOOL_CALL_SCAN_BYTES,
      )
      if (!event?.payload) return null
      const name = event.payload.name ?? event.payload.tool
      // A step announces itself before it is approved, so its end is read as
      // well: a declined read showed nothing, and must not serve its file.
      const output = await this.transcripts.findLast(
        input.workspaceRoot,
        path,
        (candidate) => candidate.type === 'tool_output' && candidate.payload?.toolUseId === input.toolUseId,
        TOOL_CALL_SCAN_BYTES,
      )
      const status = output?.payload?.status
      return {
        name: typeof name === 'string' ? name : '',
        kind: event.payload.kind,
        input: event.payload.input as ConversationJsonValue | undefined,
        ...(status === 'ok' || status === 'error' || status === 'declined' || status === 'stopped' ? { status } : {}),
        ended: output !== null && output !== undefined,
      }
    } catch {
      return null
    }
  }

  /** The bytes of an image a turn carried, by the reference its `user_message` recorded. */
  readAttachment(ref: unknown): Promise<ConversationAttachmentResult> {
    return this.attachmentStore.read(ref)
  }

  /** A proposed plan as a file the workspace pane can open (conversation-plan-store). */
  planDocument(input: ConversationPlanDocumentInput): Promise<ConversationPlanDocumentResult> {
    return this.planStore.document(input)
  }

  /** Explicit deletion removes the paired detail store as well as the transcript. */
  async listThreads(input: ConversationWorkspaceKey) {
    // The index flushes each transcript of the workspace before it reads it,
    // so chats in other workspaces keep their write batches.
    try {
      return { ok: true as const, threads: await this.threadIndex.list(input) }
    } catch (error) {
      return { ok: false as const, message: String(error) }
    }
  }

  async searchThreads(
    input: ConversationSearchInput,
    options: { signal?: AbortSignal; onBatch?: (hits: ConversationSearchHit[]) => void } = {},
  ) {
    try {
      return { ok: true as const, hits: await this.threadIndex.search(input, options) }
    } catch (error) {
      return { ok: false as const, message: String(error) }
    }
  }

  async renameThread(input: ConversationRenameInput, titleSource: 'user' | 'generated' = 'user') {
    if (this.deletingTranscripts.has(this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)))
      return { ok: false as const, message: 'Conversation is being deleted.' }
    const title = input.title.trim().slice(0, 200)
    if (!title) return { ok: false as const, message: 'A conversation title is required.' }
    try {
      const threads = await this.threadIndex.list(input)
      const thread = threads.find((entry) => entry.agentId === input.agentId)
      if (!thread) return { ok: false as const, message: 'Conversation was not found.' }
      if (titleSource === 'generated' && thread.titleSource === 'user') return { ok: true as const }
      const path = this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)
      const pending = (this.emissionTails.get(path) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          const previous = (await this.transcripts.tail(input.workspaceRoot, path, { events: 1 })).at(-1)
          if (!previous) throw new Error('Conversation was not found.')
          // The source event is authoritative even if another rename raced the index lookup.
          if (
            titleSource === 'generated' &&
            (await this.transcripts.findLast(
              input.workspaceRoot,
              path,
              (event) => event.payload?.titleSource === 'user',
            ))
          )
            return
          const event: ConversationEvent = {
            ...previous,
            id: `conv_evt_${this.eventEpoch}_${++this.eventSequence}`,
            seq: Math.max(this.sequences.get(path) ?? 0, previous.seq ?? 0) + 1,
            createdAt: this.now(),
            type: 'session_updated',
            payload: { conversationTitle: title, titleSource },
          }
          this.sequences.set(path, event.seq!)
          this.publish(input.workspaceRoot, path, event, await this.eventLog.append(path, event, input.workspaceRoot))
        })
      this.emissionTails.set(path, pending)
      await pending
      await this.threadIndex.refresh(input)
      return { ok: true as const }
    } catch (error) {
      return { ok: false as const, message: String(error) }
    }
  }

  async deleteTranscript(input: ConversationTranscriptInput): Promise<ConversationTranscriptResult> {
    if (!input.workspaceRoot?.trim() || !input.workspaceId?.trim() || !input.agentId?.trim())
      return { ok: false, message: 'Conversation identity is required.' }
    const path = this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)
    const fileScope = await this.checkpoints.fileScope(input.workspaceRoot)
    if (this.revertingScopes.has(fileScope)) return { ok: false, message: 'Workspace files are being reverted.' }
    if (this.deletingTranscripts.has(path) || this.startingTranscripts.has(path))
      return { ok: false, message: 'Conversation lifecycle operation is already in progress.' }
    const matching = Array.from(this.sessions.values()).filter(
      (session) =>
        session.workspaceRoot === input.workspaceRoot &&
        session.workspaceId === input.workspaceId &&
        session.agentId === input.agentId,
    )
    if (matching.some((session) => isSessionBusy(session) || session.status === 'starting'))
      return { ok: false, message: 'Stop the active conversation turn before deleting it.' }
    this.deletingTranscripts.add(path)
    try {
      for (const session of matching)
        if (session.status !== 'stopped') await this.stopSession({ sessionId: session.sessionId })
      await this.emissionTails.get(path)
      for (const session of matching) await session.continuationTail
      await this.threadIndex.delete(input)
      await this.checkpoints.deleteConversation(input)
      await this.attachmentStore.deleteConversation(input)
      await this.planStore.deleteConversation(input)
      const receiptsPath = path.replace(/\.jsonl$/, '.receipts.json')
      await this.receiptWrites.get(receiptsPath)
      await removeConversationStorage(input.workspaceRoot, receiptsPath)
      await removeConversationStorage(input.workspaceRoot, `${receiptsPath}.corrupt`)
      await removeConversationStorage(input.workspaceRoot, lostSequencePath(path))
      this.receipts.delete(receiptsPath)
      this.transcripts.forget(path)
      this.nonDurableLogs.delete(path)
      this.sequences.delete(path)
      this.emissionTails.delete(path)
      this.forkedMcpServers.delete(path)
      for (const session of matching) this.sessions.delete(session.sessionId)
      return { ok: true, events: [] }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    } finally {
      this.deletingTranscripts.delete(path)
    }
  }

  /**
   * Store a tool event's full input or output in its detail file and leave the
   * transcript event a bounded preview. Partial output never blocks the
   * emission queue on the detail file: appended text goes to the tool's output
   * file and replaced output is rewritten in the background, in order per
   * tool. The final output waits for all of it, so a finished tool's detail is
   * complete by the time its event is published.
   */
  private async prepareToolEvent(session: RuntimeSession, event: ConversationEvent): Promise<ConversationEvent> {
    if (event.type !== 'tool_started' && event.type !== 'tool_output') return event
    const payload = redactToolPayload(event.payload)
    const toolUseId =
      typeof payload.toolUseId === 'string'
        ? payload.toolUseId
        : typeof payload.toolCallId === 'string'
          ? payload.toolCallId
          : undefined
    const append = payload.outputMode === 'append'
    delete payload.outputMode
    if (!toolUseId) return { ...event, payload }
    payload.toolUseId = toolUseId
    const path = this.toolDetailPath({ ...session, toolUseId })
    if (event.type === 'tool_started') {
      // A step announced again mid-stream reads the output it has so far.
      await this.toolDetailWrites.flush(path)
      const previous = await readToolDetail(session.workspaceRoot, path)
      const detail: ConversationToolDetail = previous.ok
        ? previous.detail
        : { input: {}, output: '', status: 'ok', clipped: false }
      const name =
        typeof payload.name === 'string' ? payload.name : typeof payload.tool === 'string' ? payload.tool : ''
      payload.name = name
      payload.kind = payload.kind ?? inferConversationToolKind(name)
      detail.input = (payload.input ?? {}) as ConversationJsonValue
      if (Buffer.byteLength(JSON.stringify(detail.input)) > 64 * 1024) {
        payload.input = {}
        payload.inputTruncated = true
      }
      this.toolDetails.set(path, detail)
      session.toolDetailPaths.add(path)
      await this.toolDetailWrites.queue(session.workspaceRoot, path, detail)
      return { ...event, payload }
    }

    const partial = payload.partial === true
    const output = (payload.output ?? payload.preview ?? '') as ConversationJsonValue
    const text = typeof output === 'string' ? output : JSON.stringify(output)
    let stream = this.toolStreams.get(path)
    if (append && !stream) {
      stream = new ToolOutputStream(session.workspaceRoot, toolOutputStreamPath(path))
      this.toolStreams.set(path, stream)
      session.toolDetailPaths.add(path)
    }
    const mime = typeof payload.mime === 'string' ? payload.mime : undefined
    const binary = mime !== undefined && !/^(text\/|application\/(json|xml))/.test(mime)
    let totalBytes: number
    if (append) {
      stream!.append(text)
      payload.preview = binary ? '' : stream!.tail
      payload.truncated = binary || stream!.chars > TOOL_PREVIEW_CHARS
      totalBytes = stream!.totalBytes
    } else {
      // Output that streamed is read from its end, where the new lines are;
      // a one-shot result (a file read) from its beginning.
      const streamed = partial || stream !== undefined
      payload.preview = binary ? '' : streamed ? text.slice(-TOOL_PREVIEW_CHARS) : text.slice(0, TOOL_PREVIEW_CHARS)
      payload.truncated = binary || text.length > TOOL_PREVIEW_CHARS
      totalBytes = Buffer.byteLength(text)
    }
    if (typeof payload.totalBytes === 'number') totalBytes = Math.max(totalBytes, payload.totalBytes)
    const status =
      payload.status === 'declined' || payload.status === 'stopped' || payload.status === 'error'
        ? payload.status
        : payload.isError
          ? 'error'
          : 'ok'
    payload.output = payload.preview
    payload.totalBytes = totalBytes
    payload.status = status

    if (partial && append) return { ...event, payload }
    const known = this.toolDetails.get(path)
    const detail: ConversationToolDetail = known ?? {
      input: {},
      output: '',
      status: 'ok' as const,
      clipped: false,
    }
    detail.status = status
    detail.totalBytes = totalBytes
    if (payload.clipped === true) detail.clipped = true
    if (typeof payload.exitCode === 'number') detail.exitCode = payload.exitCode
    if (mime !== undefined) detail.mime = mime
    if (append) detail.output = ''
    else detail.output = binary ? '' : output
    if (partial) {
      // Replaced output mid-stream: the latest version, written behind the queue.
      this.toolDetails.set(path, detail)
      // The cached detail itself: a later write serializes the latest output,
      // and an input merged from disk by the first write stays for the rest.
      // Updates close together share one write (`coalesce`).
      void this.toolDetailWrites.queue(session.workspaceRoot, path, detail, { mergeInput: !known, coalesce: true })
      return { ...event, payload }
    }
    this.toolDetails.delete(path)
    this.toolStreams.delete(path)
    if (stream) {
      await stream.finish()
      if (stream.clipped) detail.clipped = true
      // A final output that carries everything supersedes what streamed.
      if (!append) await removeConversationStorage(session.workspaceRoot, stream.path).catch(() => undefined)
    }
    await this.toolDetailWrites.queue(session.workspaceRoot, path, detail, { mergeInput: !known })
    session.toolDetailPaths.delete(path)
    return { ...event, payload }
  }

  /** Close the output files of tools a turn left unfinished. */
  /**
   * Hold a running tool's preview back when one went out less than the
   * preview interval ago, keeping only the latest for when it has passed; drop
   * one that shows nothing new. True when the event is not to be emitted now.
   * A final output ends the tool's throttle and always goes out.
   */
  private holdToolPreview(session: RuntimeSession, event: ConversationEvent, options: EmitOptions): boolean {
    const toolUseId = event.type === 'tool_output' ? event.payload?.toolUseId : undefined
    if (typeof toolUseId !== 'string') return false
    const key = `${session.sessionId}\0${toolUseId}`
    const throttle = this.toolPreviews.get(key)
    if (event.payload?.partial !== true) {
      if (throttle?.timer) clearTimeout(throttle.timer)
      this.toolPreviews.delete(key)
      return false
    }
    const shown = `${String(event.payload.totalBytes ?? '')}:${String(event.payload.preview ?? '')}`
    const now = Date.now()
    if (!throttle) {
      this.toolPreviews.set(key, { session, sentAt: now, shown, held: null, timer: null })
      return false
    }
    if (shown === throttle.shown) {
      throttle.held = null
      return true
    }
    const wait = throttle.sentAt + this.toolPreviewIntervalMs - now
    if (wait <= 0 && !throttle.timer) {
      throttle.sentAt = now
      throttle.shown = shown
      return false
    }
    throttle.held = { event, options }
    if (!throttle.timer) {
      throttle.timer = setTimeout(() => this.releaseToolPreview(key), Math.max(0, wait))
      throttle.timer.unref?.()
    }
    return true
  }

  private releaseToolPreview(key: string): void {
    const throttle = this.toolPreviews.get(key)
    if (!throttle) return
    throttle.timer = null
    if (throttle.session.status === 'stopped') {
      this.toolPreviews.delete(key)
      return
    }
    if (!throttle.held) return
    // Decide in the emission queue, not here: the tool's final output may
    // already be queued ahead of this preview, and a preview released after
    // it would show stale output over the finished tool.
    const session = throttle.session
    const path = this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)
    const release = (this.emissionTails.get(path) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        const held = throttle.held
        if (this.toolPreviews.get(key) !== throttle || !held || session.status === 'stopped') return null
        throttle.held = null
        throttle.sentAt = Date.now()
        throttle.shown = `${String(held.event.payload?.totalBytes ?? '')}:${String(held.event.payload?.preview ?? '')}`
        return this.emitNow(session, held.event, { ...held.options, prepared: true })
      })
    this.emissionTails.set(path, release)
    this.runInBackground(release)
  }

  /** Emit a session's waiting previews now, from inside the emission queue, and end their throttles. */
  private async flushToolPreviews(session: RuntimeSession): Promise<void> {
    for (const [key, throttle] of Array.from(this.toolPreviews)) {
      if (throttle.session !== session) continue
      if (throttle.timer) clearTimeout(throttle.timer)
      this.toolPreviews.delete(key)
      if (throttle.held) await this.emitNow(session, throttle.held.event, { ...throttle.held.options, prepared: true })
    }
  }

  private dropToolPreviews(): void {
    for (const throttle of this.toolPreviews.values()) if (throttle.timer) clearTimeout(throttle.timer)
    this.toolPreviews.clear()
  }

  private async closeToolStreams(session: RuntimeSession): Promise<void> {
    for (const path of Array.from(session.toolDetailPaths)) {
      const stream = this.toolStreams.get(path)
      this.toolStreams.delete(path)
      this.toolDetails.delete(path)
      session.toolDetailPaths.delete(path)
      await stream?.finish().catch(() => undefined)
      await this.toolDetailWrites.flush(path)
    }
  }

  private transcriptPath(workspaceRoot: string, workspaceId: string, agentId: string): string {
    return workspaceSidecarPath(
      workspaceRoot,
      'conversations',
      safeSegment(workspaceId),
      `${safeSegment(agentId)}.jsonl`,
    )
  }

  // Replay the persisted transcript for one agent, bounded to the most recent
  // events so a long-lived chat cannot flood the renderer. `all` lifts the
  // event count but not the byte budget: a transcript longer than that comes
  // back as its newest part rather than as an error.
  async readTranscript(
    input: ConversationTranscriptInput,
    options: { all?: boolean; closeOpenTurns?: boolean; maxBytes?: number } = {},
  ): Promise<ConversationTranscriptResult> {
    if (!input.workspaceRoot?.trim() || !input.workspaceId?.trim() || !input.agentId?.trim()) {
      return { ok: false, message: 'Conversation transcript request is invalid.' }
    }
    const filePath = this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)
    // Buffered deltas first, so a reload mid-stream sees everything emitted.
    await this.eventLog.flush(filePath)
    let bounded: ConversationEvent[]
    try {
      bounded = await this.transcripts.tail(input.workspaceRoot, filePath, {
        events: options.all ? undefined : MAX_TRANSCRIPT_REPLAY_EVENTS,
        bytes: options.maxBytes,
      })
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Conversation transcript is unavailable.' }
    }
    const live = Array.from(this.sessions.values()).some(
      (session) =>
        session.workspaceRoot === input.workspaceRoot &&
        session.workspaceId === input.workspaceId &&
        session.agentId === input.agentId &&
        session.status !== 'stopped',
    )
    return {
      ok: true,
      events: [
        ...bounded,
        ...(options.closeOpenTurns !== false && !live ? syntheticTurnClosures(bounded, bounded.at(-1)?.seq ?? 0) : []),
      ],
    }
  }

  /**
   * The end of a chat as stored, bounded like a page (a model's context holds
   * far less than a long transcript): what a session's excerpts, and the
   * history a provider replays, are rebuilt from. Merged deltas stay merged;
   * both only fold their text. Null when the transcript cannot be read.
   */
  private async readRecentTranscript(input: ConversationTranscriptInput): Promise<ConversationEvent[] | null> {
    const path = this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)
    await this.eventLog.flush(path)
    try {
      return await this.transcripts.tail(input.workspaceRoot, path, {
        bytes: this.transcriptLimits.pageBytes,
        compact: true,
      })
    } catch {
      return null
    }
  }

  private async readHistory(session: RuntimeSession): Promise<ConversationMessage[]> {
    return completedHistory((await this.readRecentTranscript(session)) ?? [])
  }

  /**
   * Let go of what this run keeps for a transcript between writes: its cached
   * page offsets and, once the writes queued for it have settled, the tail of
   * its emission queue, which holds its last event. With no live session left
   * on it, its command receipts go too; a later command reads them back from
   * disk. Its sequence number stays: a session starting on it may already
   * have read it.
   */
  private releaseTranscript(session: RuntimeSession): void {
    const path = this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)
    const receiptsPath = path.replace(/\.jsonl$/, '.receipts.json')
    this.transcripts.forget(path)
    const tail = this.emissionTails.get(path)
    const receiptWrite = this.receiptWrites.get(receiptsPath)
    this.runInBackground(
      Promise.allSettled([tail, receiptWrite, session.continuationTail]).then(() => {
        if (this.emissionTails.get(path) === tail) this.emissionTails.delete(path)
        const live = this.liveSessionFor(path) !== undefined
        const commandPending = Array.from(this.pendingCommands.keys()).some((key) => key.startsWith(`${receiptsPath}:`))
        if (!commandPending && this.receiptWrites.get(receiptsPath) === receiptWrite) {
          this.receiptWrites.delete(receiptsPath)
          if (!live) this.receipts.delete(receiptsPath)
        }
      }),
    )
  }

  /**
   * What the hover card over a chat shows, read from the transcript's two
   * ends: the first message with words, and the newest turn within a small
   * budget. The chat between is never read, however long it has run.
   */
  async readPeekTranscript(input: ConversationTranscriptInput): Promise<ConversationEvent[]> {
    const path = this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)
    await this.eventLog.flush(path)
    const [first, latest] = await Promise.all([
      this.transcripts.findFirst(input.workspaceRoot, path, isWordedUserMessage),
      this.transcripts.lastTurn(input.workspaceRoot, path, PEEK_TURN_BYTES),
    ])
    return first && !latest.some((event) => event.id === first.id) ? [first, ...latest] : latest
  }

  /**
   * What a subscriber needs to join: the events after its cursor when the
   * cursor provably belongs to this log, otherwise a snapshot of the last
   * turns. Only published events are ever on disk ahead of a reader, so
   * nothing read here can be missing from, or repeated by, the live stream a
   * subscriber attached before calling this.
   */
  async readConversationSync(
    key: ConversationTranscriptInput,
    input: { afterSeq?: number; generation?: string; turnLimit?: number },
  ): Promise<({ ok: true } & TranscriptSyncResult) | { ok: false; message: string }> {
    const path = this.transcriptPath(key.workspaceRoot, key.workspaceId, key.agentId)
    try {
      const result = await this.transcripts.sync(key.workspaceRoot, path, {
        ...input,
        forceSnapshot: this.nonDurableLogs.has(path),
      })
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Conversation transcript is unavailable.' }
    }
  }

  async readConversationPage(
    key: ConversationTranscriptInput,
    beforeCursor: number,
    turnLimit?: number,
  ): Promise<ConversationPageResult> {
    const path = this.transcriptPath(key.workspaceRoot, key.workspaceId, key.agentId)
    try {
      return { ok: true, page: await this.transcripts.before(key.workspaceRoot, path, beforeCursor, turnLimit) }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Conversation transcript is unavailable.' }
    }
  }

  async recoverTranscript(input: ConversationTranscriptInput): Promise<void> {
    if (this.deletingTranscripts.has(this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)))
      throw new Error('Conversation is being deleted.')
    await this.initializeSequence(input)
  }

  private async initializeSequence(input: ConversationTranscriptInput): Promise<void> {
    const path = this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)
    const existing = this.sequenceInitializations.get(path)
    if (existing) return existing
    const pending = this.initializeSequenceNow(input)
    this.sequenceInitializations.set(path, pending)
    try {
      await pending
    } finally {
      if (this.sequenceInitializations.get(path) === pending) this.sequenceInitializations.delete(path)
    }
  }

  private async initializeSequenceNow(input: ConversationTranscriptInput): Promise<void> {
    const path = this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)
    if (this.sequences.has(path)) return
    await this.eventLog.flush(path)
    // Only the last turn can still be open, so the end of the log is all this
    // needs: its last sequence number and any turn it left unfinished.
    const sync = await this.transcripts.sync(input.workspaceRoot, path, { turnLimit: 1 })
    const live = Array.from(this.sessions.values()).some(
      (session) =>
        session.workspaceRoot === input.workspaceRoot &&
        session.workspaceId === input.workspaceId &&
        session.agentId === input.agentId &&
        session.status !== 'stopped',
    )
    const floor = Math.max(sync.head, await this.readLostSequence(input.workspaceRoot, path))
    const closures = sync.kind === 'snapshot' && !live ? syntheticTurnClosures(sync.page.events, floor) : []
    for (const event of closures) await this.eventLog.append(path, event, input.workspaceRoot)
    this.sequences.set(path, closures.at(-1)?.seq ?? floor)
    // Expiry lists every thread in the workspace; opening a conversation must not wait on it.
    const expiredAt = this.checkpointsExpiredAt.get(input.workspaceRoot)
    if (expiredAt !== undefined && this.now() - expiredAt < CHECKPOINT_EXPIRY_INTERVAL_MS) return
    this.checkpointsExpiredAt.set(input.workspaceRoot, this.now())
    this.runInBackground(
      this.threadIndex
        .list(input)
        .catch(() => [])
        .then((threads) =>
          this.checkpoints.collectExpired(input.workspaceRoot, this.now(), [
            { key: input, updatedAt: this.now() },
            ...threads.map((thread) => ({ key: { ...input, agentId: thread.agentId }, updatedAt: thread.updatedAt })),
          ]),
        ),
    )
  }

  private async captureBeforeTool(session: RuntimeSession, name: string): Promise<void> {
    if (!session.capabilities?.checkpoints || !session.checkpointTurnSeq) return
    if (['file_read', 'search', 'list', 'web', 'todo'].includes(inferConversationToolKind(name))) return
    if (!session.checkpointCapture) {
      session.checkpointCapture = (async () => {
        const result = await this.checkpoints.capture(session, session.checkpointTurnSeq!, 'pre')
        session.checkpointCaptured = result.ok
        // Said nowhere in the chat (owner ruling 2026-10-01): a turn with no
        // checkpoint offers no Revert, so there is nothing for a notice to
        // explain, and the line came back on every session that had one.
        if (!result.ok && !result.skipped)
          console.warn(`[conversation-runtime] checkpoint before a tool failed: ${result.message}`)
      })()
    }
    await session.checkpointCapture
  }

  getTurnDiff(input: ConversationTurnDiffInput): Promise<ConversationTurnDiffResult> {
    return this.checkpoints.getTurnDiff(input)
  }
  async listApprovalRules() {
    try {
      return { ok: true as const, rules: await this.approvalRules.list() }
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : 'Permission rules are unavailable.',
      }
    }
  }
  async revokeApprovalRule(ruleId: string) {
    try {
      await this.approvalRules.revoke(ruleId)
      return { ok: true as const }
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : 'Permission rule could not be revoked.',
      }
    }
  }

  async revertToTurn(input: ConversationRevertInput): Promise<ConversationRevertResult> {
    const scope = await this.checkpoints.fileScope(input.key.workspaceRoot)
    const path = this.transcriptPath(input.key.workspaceRoot, input.key.workspaceId, input.key.agentId)
    if (this.revertingScopes.has(scope) || this.deletingTranscripts.has(path) || this.startingTranscripts.has(path))
      return { ok: false, message: 'A workspace lifecycle operation is already in progress.' }
    const sharingFiles = Array.from(this.sessions.values()).filter((session) => session.fileScope === scope)
    if (sharingFiles.some((session) => isSessionBusy(session) || session.status === 'starting'))
      return { ok: false, message: 'Stop the running turn before reverting files.' }
    this.revertingScopes.add(scope)
    try {
      await this.initializeSequence(input.key)
      // Idle native children may produce background continuations. Resume their
      // durable cursors on the next send after the file transaction has finished.
      for (const session of sharingFiles)
        this.getAdapterForProviderId(session.providerId)?.disposeChildProcess?.(session.sessionId)
      const result = await this.checkpoints.revert(input)
      if (result.ok && result.reverted) {
        const pending = (this.emissionTails.get(path) ?? Promise.resolve())
          .catch(() => undefined)
          .then(async () => {
            await this.eventLog.flush(path)
            const previous = (await this.transcripts.tail(input.key.workspaceRoot, path, { events: 1 })).at(-1)
            const event: ConversationEvent = {
              id: `conv_evt_${this.eventEpoch}_${++this.eventSequence}`,
              seq: (this.sequences.get(path) ?? 0) + 1,
              createdAt: this.now(),
              workspaceId: input.key.workspaceId,
              agentId: input.key.agentId,
              sessionId: previous?.sessionId ?? 'recovered',
              providerId: previous?.providerId ?? '',
              modelId: previous?.modelId ?? '',
              type: 'session_updated',
              payload: { revertedAfterSeq: input.turnSeq, undo: input.undo === true },
            }
            this.sequences.set(path, event.seq!)
            const outcome = await this.eventLog.append(path, event, input.key.workspaceRoot)
            for (const session of sharingFiles) {
              if (session.workspaceId === input.key.workspaceId && session.agentId === input.key.agentId)
                this.updateExcerpts(session, event)
            }
            this.publish(input.key.workspaceRoot, path, event, outcome)
          })
        this.emissionTails.set(path, pending)
        await pending
      }
      return result
    } finally {
      this.revertingScopes.delete(scope)
    }
  }

  /**
   * "Edit from here": take the conversation back to before the user message
   * at `turnSeq`. The provider forgets that message and every turn after it,
   * and a `session_updated` carrying `rewoundFromSeq` takes them out of the
   * transcript's view; the JSONL keeps them, as it keeps everything. Files
   * are not touched: a caller that wants them back reverts the turn's
   * checkpoint once this has succeeded. Gated on the adapter declaring `rewind`.
   * A message steered into a turn before the provider had a point within it
   * to go back to takes that turn's own message with it (findRewindTarget).
   */
  async rewindToTurn(input: ConversationRewindInput): Promise<ConversationRewindResult> {
    const { key, turnSeq } = input
    if (!key?.workspaceRoot?.trim() || !key.workspaceId?.trim() || !key.agentId?.trim())
      return { ok: false, message: 'Conversation identity is required.' }
    if (!Number.isSafeInteger(turnSeq) || turnSeq < 1) return { ok: false, message: 'The message to edit is invalid.' }
    const path = this.transcriptPath(key.workspaceRoot, key.workspaceId, key.agentId)
    const scope = await this.checkpoints.fileScope(key.workspaceRoot)
    if (
      this.revertingScopes.has(scope) ||
      this.deletingTranscripts.has(path) ||
      this.startingTranscripts.has(path) ||
      this.rewindingTranscripts.has(path)
    )
      return { ok: false, message: 'A workspace lifecycle operation is already in progress.' }
    const live = Array.from(this.sessions.values()).filter(
      (session) =>
        session.workspaceRoot === key.workspaceRoot &&
        session.workspaceId === key.workspaceId &&
        session.agentId === key.agentId &&
        session.status !== 'stopped',
    )
    if (live.some((session) => isSessionBusy(session) || session.status === 'starting'))
      return { ok: false, message: 'Stop the running turn before editing an earlier message.' }
    this.rewindingTranscripts.add(path)
    try {
      await this.initializeSequence(key)
      await this.eventLog.flush(path)
      const target = await this.findRewindTarget(key, turnSeq)
      if (!target.ok) return target
      const providerId = live[0]?.providerId ?? target.event.providerId
      const adapter = this.getAdapterForProviderId(providerId)
      if (!adapter?.rewind || adapter.capabilities?.rewind !== true)
        return { ok: false, message: 'This agent cannot go back to an earlier message.' }
      // A live session drops its child now; without one, the next session
      // starts from the cursor the event below records.
      for (const session of live) {
        const rewound = await adapter.rewind({ ...session, cursor: target.cursor })
        if (!rewound.ok) return rewound
      }
      const pending = (this.emissionTails.get(path) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          const event: ConversationEvent = {
            id: `conv_evt_${this.eventEpoch}_${++this.eventSequence}`,
            seq: (this.sequences.get(path) ?? 0) + 1,
            createdAt: this.now(),
            workspaceId: key.workspaceId,
            agentId: key.agentId,
            sessionId: live[0]?.sessionId ?? target.event.sessionId,
            providerId,
            modelId: live[0]?.modelId ?? target.event.modelId,
            type: 'session_updated',
            // Also the resume cursor (readResumeCursor): no provider session
            // before the first turn, else the kept turn's end as a fork point.
            payload: {
              rewoundFromSeq: target.fromSeq,
              providerSessionId: target.cursor?.sessionId ?? null,
              ...(target.cursor?.at ? { providerResumeAt: target.cursor.at } : {}),
            },
          }
          this.sequences.set(path, event.seq!)
          const outcome = await this.eventLog.append(path, event, key.workspaceRoot)
          this.publish(key.workspaceRoot, path, event, outcome)
        })
      this.emissionTails.set(path, pending)
      await pending
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The conversation could not go back.' }
    } finally {
      this.rewindingTranscripts.delete(path)
    }
  }

  /**
   * The user message at `turnSeq` and where the provider stood before it: the
   * cursor on the end of the newest turn still in view before it, or null when
   * it is the conversation's first. Read from the end back, so rewinds already
   * made (each after the turns it hid) are known before the turns they hid.
   */
  private async findRewindTarget(
    key: ConversationTranscriptInput,
    turnSeq: number,
  ): Promise<
    | { ok: true; event: ConversationEvent; cursor: ConversationProviderCursor | null; fromSeq: number }
    | { ok: false; message: string }
  > {
    const hidden: Array<{ from: number; before: number }> = []
    // Turns that failed before reaching the provider left nothing in its
    // session, so the turn before them is as good a point as any.
    const unreached = new Set<string>()
    // Turns a steer ended before the provider had a point within them to go
    // back to. The steered message went into that turn's work, so going back
    // before it goes back before that turn's own message as well, and both
    // leave the view: what stays on screen is what the agent still knows.
    const joined = new Set<string>()
    const walk: {
      target?: ConversationEvent
      cursor: ConversationProviderCursor | null
      uncharted: boolean
      fromSeq: number
    } = {
      cursor: null,
      uncharted: false,
      fromSeq: turnSeq,
    }
    await this.transcripts.findLast(
      key.workspaceRoot,
      this.transcriptPath(key.workspaceRoot, key.workspaceId, key.agentId),
      (event) => {
        const seq = event.seq ?? 0
        const rewoundFrom = event.type === 'session_updated' ? event.payload?.rewoundFromSeq : undefined
        if (typeof rewoundFrom === 'number') {
          hidden.push({ from: rewoundFrom, before: seq })
          return false
        }
        if (hidden.some((range) => seq >= range.from && seq < range.before)) return false
        if (!walk.target) {
          if (seq === turnSeq) {
            walk.target = event
            return event.type !== 'user_message'
          }
          // Past it without meeting it: hidden by a rewind, or never there.
          return seq < turnSeq
        }
        const turnId = typeof event.payload?.turnId === 'string' ? event.payload.turnId : undefined
        if (event.type === 'turn_completed' || event.type === 'turn_failed') {
          const found = readProviderCursor(event.payload?.providerCursor)
          if (found?.at) {
            walk.cursor = found
            return true
          }
          if (turnId && event.payload?.steered === true) joined.add(turnId)
          const reason = event.payload?.reason
          if (turnId && !found && (reason === 'runtime' || reason === 'spawn')) unreached.add(turnId)
          return false
        }
        if (event.type === 'user_message' && turnId && joined.has(turnId)) {
          walk.fromSeq = seq
          return false
        }
        if (event.type === 'user_message' && !(turnId && unreached.has(turnId))) {
          walk.uncharted = true
          return true
        }
        return false
      },
    )
    const { target, cursor, uncharted, fromSeq } = walk
    if (target?.type !== 'user_message')
      return { ok: false, message: 'That message is no longer in this conversation.' }
    if (!cursor && uncharted)
      return {
        ok: false,
        message:
          'There is no record of where the agent stood before this message, so the conversation cannot go back to it.',
      }
    return { ok: true, event: target, cursor, fromSeq }
  }

  /**
   * "Fork from here": a new chat, `newAgentId`, holding this one up to a point
   * and carrying on from there by itself. Forked at a reply, it holds that
   * turn; forked at a user message, everything before it. This chat is not
   * touched, and both work in the same files.
   *
   * The fork's transcript is this one's events up to the point, as the view
   * shows them (turns a rewind hid are left out), then a mark saying where it
   * came from that is also its resume cursor (readResumeCursor). The adapter
   * says what that cursor is (`fork`): the parent's provider session at the
   * point, which the fork's first child branches from; a session it branched
   * already; or none, and the fork's first message carries the conversation
   * as text. A stateless provider replays the transcript and needs none.
   * Refused while this chat is working: a point inside a turn is no point.
   */
  async forkAtTurn(input: ConversationForkInput): Promise<ConversationForkResult> {
    const { key } = input
    const newAgentId = typeof input.newAgentId === 'string' ? input.newAgentId.trim() : ''
    if (!key?.workspaceRoot?.trim() || !key.workspaceId?.trim() || !key.agentId?.trim() || !newAgentId)
      return { ok: false, message: 'Conversation identity is required.' }
    if (newAgentId === key.agentId) return { ok: false, message: 'A fork needs a chat of its own.' }
    if (
      input.side === 'user'
        ? !Number.isSafeInteger(input.turnSeq) || input.turnSeq < 1
        : input.side !== 'assistant' || typeof input.turnId !== 'string' || !input.turnId
    )
      return { ok: false, message: 'The message to fork from is invalid.' }
    const path = this.transcriptPath(key.workspaceRoot, key.workspaceId, key.agentId)
    const forkPath = this.transcriptPath(key.workspaceRoot, key.workspaceId, newAgentId)
    const scope = await this.checkpoints.fileScope(key.workspaceRoot)
    if (
      this.revertingScopes.has(scope) ||
      [path, forkPath].some(
        (busy) =>
          this.deletingTranscripts.has(busy) ||
          this.startingTranscripts.has(busy) ||
          this.rewindingTranscripts.has(busy),
      )
    )
      return { ok: false, message: 'A workspace lifecycle operation is already in progress.' }
    const live = this.liveSessionFor(path)
    if (live && (isSessionBusy(live) || live.status === 'starting'))
      return { ok: false, message: 'Stop the running turn before forking from an earlier message.' }
    // The fork's transcript is held the way a start holds it, so nothing
    // starts a session on it while it is being written.
    this.startingTranscripts.add(forkPath)
    try {
      await this.initializeSequence(key)
      await this.eventLog.flush(path)
      if (
        this.liveSessionFor(forkPath) ||
        (await this.transcripts.tail(key.workspaceRoot, forkPath, { events: 1 })).length
      )
        return { ok: false, message: 'The chat to fork into already has a conversation.' }
      const stored = await this.transcripts.tail(key.workspaceRoot, path, { compact: true })
      const providerId = live?.providerId ?? stored.at(-1)?.providerId ?? ''
      const modelId = live?.modelId ?? stored.at(-1)?.modelId ?? ''
      const plan = planFork(stored, input, providerId)
      if (!plan.ok) return plan
      const adapter = this.getAdapterForProviderId(providerId)
      if (!adapter || adapter.capabilities?.fork !== true) return { ok: false, message: 'This agent cannot be forked.' }

      let cursor: ConversationProviderCursor | null = null
      if (adapter.sessions === 'stateful') {
        const resume = await this.readResumeCursor(key.workspaceRoot, key.workspaceId, key.agentId, providerId)
        const parent = live ?? { ...key, sessionId: '', providerId, modelId }
        const forked = adapter.fork
          ? await adapter.fork({
              ...parent,
              ...(resume?.sessionId ? { resumeSessionId: resume.sessionId } : {}),
              cursor: plan.cursor,
              exact: plan.exact,
              latest: plan.latest,
            })
          : ({ ok: true, cursor: null } as const)
        if (!forked.ok) return forked
        cursor = forked.cursor
      }
      // Without a session to branch, the fork's first message hands the new
      // one what came before; a fork with nothing before it needs nothing.
      const seed = adapter.sessions === 'stateful' && !cursor && completedHistory(plan.kept).length > 0

      const createdAt = this.now()
      const forkKey = { ...key, agentId: newAgentId }
      const events: ConversationEvent[] = []
      for (const [index, event] of plan.kept.entries()) {
        const payload = forkedPayload(event)
        // The images a message carried, copied into the fork's own folder, so
        // deleting the chat it came from leaves the fork's bubbles whole.
        const attachments = event.type === 'user_message' ? payload?.attachments : undefined
        events.push({
          ...event,
          agentId: newAgentId,
          workspaceId: key.workspaceId,
          seq: index + 1,
          payload: Array.isArray(attachments)
            ? { ...payload, attachments: await this.attachmentStore.copy(attachments, forkKey) }
            : payload,
        })
      }
      events.push({
        id: `conv_evt_${this.eventEpoch}_${++this.eventSequence}`,
        seq: events.length + 1,
        createdAt,
        workspaceId: key.workspaceId,
        agentId: newAgentId,
        sessionId: live?.sessionId ?? stored.at(-1)?.sessionId ?? 'forked',
        providerId,
        modelId,
        type: 'session_updated',
        payload: {
          forkedFrom: { agentId: key.agentId, turnSeq: plan.fromSeq },
          providerSessionId: cursor?.sessionId ?? null,
          ...(cursor?.at ? { providerResumeAt: cursor.at } : {}),
          ...(seed ? { seedFromHistory: true } : {}),
          ...(input.title?.trim() ? { conversationTitle: input.title.trim().slice(0, 200), titleSource: 'user' } : {}),
        },
      })
      const appended = events.map((event) => this.eventLog.append(forkPath, event, key.workspaceRoot))
      await this.eventLog.flush(forkPath)
      if ((await Promise.all(appended)).includes('failed')) {
        await this.eventLog.close(forkPath)
        await removeConversationStorage(key.workspaceRoot, forkPath).catch(() => undefined)
        return { ok: false, message: 'The fork could not be saved to disk.' }
      }
      this.sequences.set(forkPath, events.length)
      await this.eventLog.close(forkPath)
      await this.copyToolDetails(key, newAgentId, plan.kept)
      if (live?.mcpServers?.length) this.forkedMcpServers.set(forkPath, live.mcpServers)
      this.runInBackground(this.threadIndex.refresh(forkKey).catch(() => undefined))
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The conversation could not be forked.' }
    } finally {
      this.startingTranscripts.delete(forkPath)
    }
  }

  /**
   * Write a new chat's history from a session an agent CLI saved by itself,
   * the way a fork writes its own: the events as given, each step's full
   * input and output in its detail file and a bounded preview in the
   * transcript, then a mark naming the CLI's session as the resume cursor
   * (readResumeCursor). The chat's next message resumes that session, so the
   * agent remembers everything the history shows. Refused for a chat that
   * already has a conversation.
   */
  async importTranscript(input: ConversationImportTranscriptInput): Promise<ConversationImportTranscriptResult> {
    const { key } = input
    if (!key?.workspaceRoot?.trim() || !key.workspaceId?.trim() || !key.agentId?.trim())
      return { ok: false, message: 'Conversation identity is required.' }
    const providerSessionId = input.providerSessionId?.trim()
    if (!providerSessionId || !input.providerId?.trim())
      return { ok: false, message: 'The session to import is required.' }
    const path = this.transcriptPath(key.workspaceRoot, key.workspaceId, key.agentId)
    if (this.deletingTranscripts.has(path) || this.startingTranscripts.has(path) || this.liveSessionFor(path))
      return { ok: false, message: 'The chat to import into is in use.' }
    this.startingTranscripts.add(path)
    try {
      if ((await this.transcripts.tail(key.workspaceRoot, path, { events: 1 })).length)
        return { ok: false, message: 'The chat to import into already has a conversation.' }
      const envelope = {
        sessionId: 'imported',
        workspaceId: key.workspaceId,
        agentId: key.agentId,
        providerId: input.providerId,
        modelId: input.modelId,
      }
      const details = new Map<string, ConversationToolDetail>()
      const events: ConversationEvent[] = input.events.map((draft, index) => ({
        ...envelope,
        id: `conv_evt_${this.eventEpoch}_${++this.eventSequence}`,
        seq: index + 1,
        type: draft.type,
        createdAt: draft.createdAt,
        payload: importedToolPayload(draft.type, draft.payload, details),
      }))
      events.push({
        ...envelope,
        id: `conv_evt_${this.eventEpoch}_${++this.eventSequence}`,
        seq: events.length + 1,
        createdAt: events.at(-1)?.createdAt ?? this.now(),
        type: 'session_updated',
        payload: {
          providerSessionId,
          importedFrom: input.importedFrom,
          ...(input.title?.trim() ? { conversationTitle: input.title.trim().slice(0, 200), titleSource: 'user' } : {}),
        },
      })
      const appended = events.map((event) => this.eventLog.append(path, redactEvent(event), key.workspaceRoot))
      await this.eventLog.flush(path)
      if ((await Promise.all(appended)).includes('failed')) {
        await this.eventLog.close(path)
        await removeConversationStorage(key.workspaceRoot, path).catch(() => undefined)
        return { ok: false, message: 'The imported conversation could not be saved to disk.' }
      }
      this.sequences.set(path, events.length)
      await this.eventLog.close(path)
      for (const [toolUseId, detail] of details)
        await writeToolDetail(key.workspaceRoot, this.toolDetailPath({ ...key, toolUseId }), detail).catch(
          () => undefined,
        )
      this.runInBackground(this.threadIndex.refresh(key).catch(() => undefined))
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The conversation could not be imported.' }
    } finally {
      this.startingTranscripts.delete(path)
    }
  }

  // The details of the steps a fork holds, so its tool rows open as the
  // parent's do. Best effort: a step whose detail is missing shows its
  // preview, as one whose detail was never written does.
  private async copyToolDetails(
    key: ConversationTranscriptInput,
    newAgentId: string,
    events: ConversationEvent[],
  ): Promise<void> {
    const ids = new Set<string>()
    for (const event of events)
      if (event.type === 'tool_started' && typeof event.payload?.toolUseId === 'string' && event.payload.toolUseId)
        ids.add(event.payload.toolUseId)
    for (const toolUseId of ids) {
      const from = this.toolDetailPath({ ...key, toolUseId })
      const to = this.toolDetailPath({ ...key, agentId: newAgentId, toolUseId })
      await this.toolDetailWrites.flush(from)
      for (const [source, target] of [
        [from, to],
        [toolOutputStreamPath(from), toolOutputStreamPath(to)],
      ])
        await readConversationStorage(key.workspaceRoot, source, MAX_FORKED_DETAIL_BYTES)
          .then((content) => writeConversationStorage(key.workspaceRoot, target, content.toString('utf8')))
          .catch(() => undefined)
    }
  }

  // The latest provider-session cursor recorded in the transcript; stateful
  // providers use it to natively resume after a restart. A rewind is a cursor
  // too: to no session at all when it went back past the first turn, else to a
  // point inside one (`providerResumeAt`) that the next child forks at. So is
  // the mark a fork's transcript starts from (`forkedFrom`); until a turn of
  // the fork has completed, the cursor says so (`forked`), and whether its
  // next message carries the conversation as text (`seedFromHistory`): owed
  // until the adapter says a message carried it (`historySeeded`), so a first
  // send that never reached the provider (signed out, a CLI that would not
  // start) owes it still.
  private async readResumeCursor(
    workspaceRoot: string,
    workspaceId: string,
    agentId: string,
    providerId: string,
  ): Promise<{ sessionId?: string; at?: string; forked?: true; seedFromHistory?: true } | undefined> {
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
    // Only a cursor this provider wrote: a transcript restarted on another
    // provider holds that one's cursors too, and a session id means nothing to
    // any provider but the one that issued it (a Claude session id handed to
    // Codex, or a Codex thread id to Claude, fails every turn).
    const isCursor = (event: ConversationEvent) =>
      event.providerId === providerId &&
      (event.type === 'session_updated' || event.type === 'session_started') &&
      (text(event.payload?.providerSessionId) !== undefined ||
        typeof event.payload?.rewoundFromSeq === 'number' ||
        isForkMark(event))
    // The newest cursor, read on back to a message whose turn completed, a
    // seed's delivery or a fork's mark, whichever comes first: only a mark
    // read before either still speaks for the next start.
    const walk: {
      found?: ConversationEvent
      settled: boolean
      completed: Set<string>
      forked: boolean
      seed: boolean
    } = { settled: false, completed: new Set(), forked: false, seed: false }
    try {
      await this.eventLog.flush(this.transcriptPath(workspaceRoot, workspaceId, agentId))
      await this.transcripts.findLast(
        workspaceRoot,
        this.transcriptPath(workspaceRoot, workspaceId, agentId),
        (event) => {
          const turnId = typeof event.payload?.turnId === 'string' ? event.payload.turnId : undefined
          if (event.type === 'turn_completed' && turnId) walk.completed.add(turnId)
          if (
            (event.type === 'user_message' && turnId && walk.completed.has(turnId)) ||
            event.payload?.historySeeded === true
          )
            walk.settled = true
          if (!walk.found && isCursor(event)) walk.found = event
          if (isForkMark(event)) {
            walk.forked = !walk.settled
            walk.seed = !walk.settled && event.payload?.seedFromHistory === true
            return true
          }
          return walk.found !== undefined && walk.settled
        },
      )
      const sessionId = text(walk.found?.payload?.providerSessionId)
      const at = sessionId ? text(walk.found?.payload?.providerResumeAt) : undefined
      const cursor = {
        ...(sessionId ? { sessionId } : {}),
        ...(at ? { at } : {}),
        ...(walk.forked ? { forked: true as const } : {}),
        ...(walk.seed ? { seedFromHistory: true as const } : {}),
      }
      return Object.keys(cursor).length > 0 ? cursor : undefined
    } catch {
      return undefined
    }
  }

  private toSummary(session: RuntimeSession): ConversationSessionSummary {
    const { sessionId, workspaceId, agentId, providerId, modelId, status, createdAt, updatedAt, permissionPreset } =
      session
    return {
      sessionId,
      workspaceId,
      agentId,
      providerId,
      modelId,
      status,
      createdAt,
      updatedAt,
      displayName: session.displayName,
      capabilities: session.capabilities,
      phase: session.phase,
      currentToolTitle: session.currentToolTitle,
      firstUserText: session.firstUserText,
      lastUserText: session.lastUserText,
      lastAssistantText: session.lastAssistantText,
      lastAssistantTail: session.lastAssistantTail,
      ...(session.backgroundAgents ? { backgroundAgents: session.backgroundAgents } : {}),
      ...(session.backgroundTasks ? { backgroundTasks: session.backgroundTasks } : {}),
      ...(session.lastTurnEndedAt !== undefined ? { lastTurnEndedAt: session.lastTurnEndedAt } : {}),
      ...(session.lastUserMessageAt !== undefined ? { lastUserMessageAt: session.lastUserMessageAt } : {}),
      // Only while it is waiting: a turn can also leave the wait by a path
      // that sets the phase without an event (a send, a stop).
      ...(isWaitingPhase(session.phase) && session.waitingSince !== undefined
        ? { waitingSince: session.waitingSince }
        : {}),
      ...(session.resting && status !== 'stopped' ? { resting: true as const } : {}),
      // Only while a turn is open: every way a turn closes clears `activeTurnId`.
      ...(session.activeTurnId !== null && session.turnStartedAt !== undefined
        ? { turnStartedAt: session.turnStartedAt }
        : {}),
      ...(session.promptCache ? { promptCache: session.promptCache } : {}),
      ...(session.fileActivity?.length ? { fileActivity: session.fileActivity } : {}),
      // Only when the session carries one, so a session that never chose a
      // preset reports absence rather than an invented 'default'.
      ...(permissionPreset ? { permissionPreset } : {}),
      ...(permissionPreset && session.permissionMode ? { permissionMode: session.permissionMode } : {}),
      ...(session.allowedTools?.length ? { allowsUnaskedTools: true as const } : {}),
    }
  }
}

function isWaitingPhase(phase: ConversationSessionSummary['phase']): boolean {
  return phase === 'waiting_for_approval' || phase === 'waiting_for_input'
}

// The one busy predicate: a session is busy while any turn is open, whether it
// came from `sendTurn` or from the adapter's continuation channel. A
// continuation turn clears `pendingRequestId`, so that field alone would report
// an occupied session as free and let a second turn take it over.
function completedHistory(events: ConversationEvent[]): ConversationMessage[] {
  const history: ConversationMessage[] = []
  let user: string | undefined
  let assistant = ''
  for (const event of events) {
    if (event.type === 'user_message') {
      // The files a message attached ride beside its words in the transcript;
      // the history hands them back to the model as it first read them.
      user =
        typeof event.payload?.text === 'string'
          ? [event.payload.text, attachedFilesContext(parseConversationAttachedFiles(event.payload.files) ?? [])]
              .filter(Boolean)
              .join('\n\n')
          : undefined
      assistant = ''
    } else if (event.type === 'content_delta' && typeof event.payload?.text === 'string')
      assistant += event.payload.text
    else if (event.type === 'turn_completed' && user !== undefined) {
      history.push({ role: 'user', content: user })
      if (assistant) history.push({ role: 'assistant', content: assistant })
      user = undefined
      assistant = ''
    } else if (event.type === 'turn_failed') {
      user = undefined
      assistant = ''
    }
  }
  return history
}

// The first message with words: an image-only opener names nothing.
function isWordedUserMessage(event: ConversationEvent): boolean {
  return (
    event.type === 'user_message' && typeof event.payload?.text === 'string' && event.payload.text.trim().length > 0
  )
}

// How each runtime says a turn was stopped: the reason, or (an ACP agent
// cancelled mid-prompt) the bare word as its message.
function isInterruptedTurn(event: ConversationEvent): boolean {
  return event.payload?.reason === 'interrupted' || event.payload?.message === 'interrupted'
}

/**
 * Busy, not failed: a send from another device (a phone, while a turn started
 * here runs) is held there and sent again once the turn is over.
 */
function busyRefusal(session: RuntimeSession): ConversationSessionActionResult {
  return {
    ok: false,
    code: 'busy',
    retryAfterMs: TURN_BUSY_RETRY_MS,
    message: session.pendingRequestId
      ? 'Conversation turn is awaiting approval.'
      : 'Conversation turn is already in progress.',
  }
}

// A steer the running turn could not take ran nothing: it is answered as busy,
// as a send that met a turn is, so a retry under the same command id is run
// again rather than answered from a receipt of the refusal. Once the turn is
// over that retry goes as the next turn, so a client sending again cannot
// meet the same refusal for ever.
function steerBusy(message: string): ConversationSessionActionResult {
  return { ok: false, code: 'busy', retryAfterMs: TURN_BUSY_RETRY_MS, message }
}

function isSessionBusy(session: RuntimeSession): boolean {
  return session.activeTurnId !== null || session.pendingRequestId !== null
}

// Why a busy session cannot take a steer, or null when it can: the provider
// has to take messages mid-turn, a turn has to be running to take it, and a
// card the agent is blocked on is answered first — a message would only queue
// behind it. The running turn must have reached the provider, which is what
// the message joins, and must not have ended there: a message sent then goes
// as the next turn once this one is over.
function steerRefusal(session: RuntimeSession, adapter: ConversationProviderAdapter): string | null {
  if (session.capabilities?.steer !== true || !adapter.steer)
    return 'This agent cannot take a message while it is working.'
  // No turn running: the one the message was aimed at ended on its way here
  // (a handover that waited behind the turn's last events, or Stop).
  if (!session.activeTurnId) return 'The agent has just finished; the message goes as the next turn.'
  if (session.pendingApprovalRequestIds.size > 0) return 'Conversation turn is awaiting approval.'
  const running = session.providerTurn
  if (!running || running.turnId !== session.activeTurnId)
    return session.turnLockRequestId
      ? 'The agent has not started on the last message yet.'
      : 'The agent is carrying on by itself; the message goes when it stops.'
  if (running.finished) return 'The agent has just finished; the message goes as the next turn.'
  return null
}

function safeSegment(value: string): string {
  const encoded = encodeURIComponent(value.trim().replace(/[\\/]/g, '-'))
  return encoded === '.' || encoded === '..' ? encoded.replace(/\./g, '%2E') : encoded
}

// A transcript can end mid-turn (the app died while streaming). Replaying it
// verbatim would leave the projection permanently "streaming" and block the
// composer, so unfinished turns are closed with synthetic interrupt events —
// not persisted, only appended to the replay result.
function syntheticTurnClosures(events: ConversationEvent[], after: number): ConversationEvent[] {
  const openTurns = new Map<string, ConversationEvent>()
  for (const event of events) {
    const turnId = typeof event.payload?.turnId === 'string' ? event.payload.turnId : null
    if (!turnId) continue
    if (event.type === 'turn_started' || event.type === 'user_message') {
      if (!openTurns.has(turnId)) openTurns.set(turnId, event)
    } else if (event.type === 'turn_completed' || event.type === 'turn_failed') {
      openTurns.delete(turnId)
    }
  }
  let sequence = 0
  return Array.from(openTurns.entries()).map(([turnId, source]) => ({
    id: `conv_evt_replay_close_${++sequence}`,
    seq: after + sequence,
    sessionId: source.sessionId,
    workspaceId: source.workspaceId,
    agentId: source.agentId,
    providerId: source.providerId,
    modelId: source.modelId,
    type: 'turn_failed',
    createdAt: source.createdAt,
    payload: { turnId, reason: 'interrupted', message: 'The app closed while this turn was streaming.' },
  }))
}

/** A turn end's `providerCursor`, as the adapter recorded it; null when absent or malformed. */
function readProviderCursor(value: unknown): ConversationProviderCursor | null {
  if (!value || typeof value !== 'object') return null
  const { sessionId, at } = value as Record<string, unknown>
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null
  return { sessionId, at: typeof at === 'string' && at ? at : null }
}

/** The mark a fork's transcript starts from (`forkAtTurn`). */
function isForkMark(event: ConversationEvent): boolean {
  const from = event.payload?.forkedFrom
  return event.type === 'session_updated' && Boolean(from) && typeof from === 'object'
}

type ForkPlan = {
  ok: true
  // What the fork holds, oldest first, as stored (a run of deltas is one event).
  kept: ConversationEvent[]
  // The parent's message the fork was made at: the one it stops before, or
  // the one that opened the turn it ends with.
  fromSeq: number
  cursor: ConversationProviderCursor | null
  exact: boolean
  latest: boolean
}

/**
 * Where a fork cuts the parent's transcript and where the provider stood
 * there, from the stored events read oldest first. The view's turns only:
 * those a rewind hid stay behind, and so do the marks that refer to the
 * parent's numbering (rewinds, reverts) and its title. Forked at a user
 * message, the cut is before it; at a reply, after that turn's end. The
 * cursor is read back from the cut as a rewind reads it (findRewindTarget):
 * the newest turn end that recorded one, past turns that never reached the
 * provider; a message joined to the turn before it by a steer goes back with
 * that turn's own message, and a reply that was joined has no point of its
 * own (`exact` false). The copy keeps the newest events up to
 * MAX_TRANSCRIPT_REPLAY_EVENTS, from a turn's start.
 */
function planFork(
  stored: ConversationEvent[],
  input: ConversationForkInput,
  providerId: string,
): ForkPlan | { ok: false; message: string } {
  const hidden: Array<{ from: number; before: number }> = []
  for (const event of stored) {
    const from = event.type === 'session_updated' ? event.payload?.rewoundFromSeq : undefined
    if (typeof from === 'number') hidden.push({ from, before: event.seq ?? 0 })
  }
  const visible = stored.filter((event) => {
    const seq = event.seq ?? 0
    if (hidden.some((range) => seq >= range.from && seq < range.before)) return false
    const payload = event.payload ?? {}
    return !(
      event.type === 'session_updated' &&
      (typeof payload.rewoundFromSeq === 'number' ||
        typeof payload.revertedAfterSeq === 'number' ||
        typeof payload.conversationTitle === 'string')
    )
  })
  const turnOf = (event: ConversationEvent) =>
    typeof event.payload?.turnId === 'string' ? event.payload.turnId : undefined
  const isTurnEnd = (event: ConversationEvent) => event.type === 'turn_completed' || event.type === 'turn_failed'
  let cut: number
  let fromSeq: number
  if (input.side === 'user') {
    cut = visible.findIndex((event) => event.type === 'user_message' && event.seq === input.turnSeq)
    if (cut === -1) return { ok: false, message: 'That message is no longer in this conversation.' }
    fromSeq = input.turnSeq
  } else {
    const end = visible.findLastIndex((event) => isTurnEnd(event) && turnOf(event) === input.turnId)
    if (end === -1)
      return {
        ok: false,
        message: visible.some((event) => turnOf(event) === input.turnId)
          ? 'Only a reply that has finished can be forked from.'
          : 'That reply is no longer in this conversation.',
      }
    cut = end + 1
    const opened = visible.find((event) => event.type === 'user_message' && turnOf(event) === input.turnId)
    fromSeq = opened?.seq ?? visible[end].seq ?? 0
  }

  const joined = new Set<string>()
  const unreached = new Set<string>()
  let cursor: ConversationProviderCursor | null = null
  let uncharted = false
  for (let index = cut - 1; index >= 0; index--) {
    const event = visible[index]
    const turnId = turnOf(event)
    if (isTurnEnd(event)) {
      // Only a cursor the fork's own provider wrote: a transcript that moved
      // between runtimes holds the other one's too, which means nothing here.
      const found = event.providerId === providerId ? readProviderCursor(event.payload?.providerCursor) : null
      if (found?.at) {
        cursor = found
        break
      }
      if (turnId && event.payload?.steered === true) joined.add(turnId)
      const reason = event.payload?.reason
      if (turnId && !found && (reason === 'runtime' || reason === 'spawn')) unreached.add(turnId)
      continue
    }
    if (event.type !== 'user_message') continue
    if (turnId && joined.has(turnId)) {
      // Forked at a reply a steer ended, there is no point between it and the
      // message that joined it to go back to.
      if (input.side === 'assistant') {
        uncharted = true
        break
      }
      cut = index
      continue
    }
    if (!(turnId && unreached.has(turnId))) {
      uncharted = true
      break
    }
  }

  // Nothing the provider has seen comes after the cut: no message, and no
  // turn it opened by itself.
  const latest = !visible.slice(cut).some((event) => event.type === 'user_message' || event.type === 'turn_started')
  let kept = visible.slice(0, cut)
  if (kept.length > MAX_TRANSCRIPT_REPLAY_EVENTS) {
    const from = kept.length - MAX_TRANSCRIPT_REPLAY_EVENTS
    const start = kept.findIndex((event, index) => index >= from && event.type === 'user_message')
    kept = kept.slice(start === -1 ? from : start)
  }
  return { ok: true, kept, fromSeq, cursor, exact: cursor !== null || !uncharted, latest }
}

// A parent's event as its fork keeps it. A turn's checkpoint belongs to the
// parent, whose refs the fork has none of, so its changed-files card and
// revert stay with the parent.
function forkedPayload(event: ConversationEvent): ConversationEvent['payload'] {
  if (!event.payload || (event.type !== 'turn_completed' && event.type !== 'turn_failed')) return event.payload
  const {
    checkpointTurnSeq: _seq,
    checkpointAvailable: _available,
    checkpointSummary: _summary,
    ...rest
  } = event.payload
  return rest
}

/** Beside the transcript: the highest sequence number published that may not be in it. */
function lostSequencePath(transcriptPath: string): string {
  return transcriptPath.replace(/\.jsonl$/, '.lost-seq.json')
}

// Events a turn opens with before its runtime has done anything with it. A
// turn that fails after only these never got as far as the model: its child
// did not start, or the runtime refused the turn's settings.
const TURN_OPENING_EVENTS: ReadonlySet<ConversationEvent['type']> = new Set([
  'turn_started',
  'session_started',
  'session_ready',
  'session_updated',
])

function eventIterator(
  stream: ConversationEvent[] | AsyncIterable<ConversationEvent>,
): AsyncIterator<ConversationEvent> {
  return (isAsyncIterable(stream) ? stream : fromArray(stream))[Symbol.asyncIterator]()
}

async function* fromArray(events: ConversationEvent[]): AsyncIterable<ConversationEvent> {
  yield* events
}

// Whether a failure is the runtime refusing the permission setting it was
// started or sent with: the provider says so (`permissionRefused`), or its
// message does (`looksLikePermissionSettingRefusal`). Only then is a retry
// with no flag worth it. A timeout or a crash retried under No flag could
// work by luck and leave the chat on the CLI's own default, which may skip
// every prompt, while blaming a flag that was never the problem.
function isPermissionSettingRefusal(failure: unknown): boolean {
  if (isRecord(failure) && failure.permissionRefused === true) return true
  if (isRecord(failure) && isRecord(failure.payload)) {
    if (failure.payload.permissionRefused === true) return true
    return looksLikePermissionSettingRefusal(readTurnFailure(failure as ConversationEvent))
  }
  return looksLikePermissionSettingRefusal(failure instanceof Error ? failure.message : String(failure))
}

function readTurnFailure(event: ConversationEvent | null): string {
  const message = event?.payload?.message
  return typeof message === 'string' ? message : ''
}

function isAsyncIterable(
  value: ConversationEvent[] | AsyncIterable<ConversationEvent>,
): value is AsyncIterable<ConversationEvent> {
  return typeof (value as AsyncIterable<ConversationEvent>)[Symbol.asyncIterator] === 'function'
}

/**
 * An imported step's event as prepareToolEvent leaves a live one's: the call's
 * input and its whole result go to the detail kept under `details`, and the
 * transcript holds the opening of the result, as a one-shot result's preview
 * is read.
 */
function importedToolPayload(
  type: ConversationEvent['type'],
  source: Record<string, unknown>,
  details: Map<string, ConversationToolDetail>,
): Record<string, unknown> {
  const toolUseId = typeof source.toolUseId === 'string' ? source.toolUseId : undefined
  if ((type !== 'tool_started' && type !== 'tool_output') || !toolUseId) return source
  const payload = { ...source }
  const detail: ConversationToolDetail = details.get(toolUseId) ?? {
    input: {},
    output: '',
    status: 'ok',
    clipped: false,
  }
  details.set(toolUseId, detail)
  if (type === 'tool_started') {
    const name = typeof payload.name === 'string' ? payload.name : typeof payload.tool === 'string' ? payload.tool : ''
    payload.name = name
    payload.kind = payload.kind ?? inferConversationToolKind(name)
    detail.input = (payload.input ?? {}) as ConversationJsonValue
    if (Buffer.byteLength(JSON.stringify(detail.input)) > 64 * 1024) {
      payload.input = {}
      payload.inputTruncated = true
    }
    return payload
  }
  const output = (payload.output ?? '') as ConversationJsonValue
  const text = typeof output === 'string' ? output : JSON.stringify(output)
  const mime = typeof payload.mime === 'string' ? payload.mime : undefined
  const binary = mime !== undefined && !/^(text\/|application\/(json|xml))/.test(mime)
  const status =
    payload.status === 'declined' || payload.status === 'stopped' || payload.status === 'error'
      ? payload.status
      : payload.isError
        ? 'error'
        : 'ok'
  payload.preview = binary ? '' : text.slice(0, TOOL_PREVIEW_CHARS)
  payload.truncated = binary || text.length > TOOL_PREVIEW_CHARS
  payload.totalBytes = Math.max(
    Buffer.byteLength(text),
    typeof payload.totalBytes === 'number' ? payload.totalBytes : 0,
  )
  payload.output = payload.preview
  payload.status = status
  detail.status = status
  detail.totalBytes = payload.totalBytes as number
  detail.output = binary ? '' : output
  if (typeof payload.exitCode === 'number') detail.exitCode = payload.exitCode
  if (mime !== undefined) detail.mime = mime
  return payload
}

/**
 * A tool event's payload, redacted. Redaction goes by key, so output that is
 * only text (a string, or the list of text blocks some providers send) has
 * nothing in it to redact; it is set aside and put back rather than taken
 * through a JSON round trip, which a provider re-sending the whole output on
 * every update would pay again for each one.
 */
function redactToolPayload(payload: ConversationEvent['payload']): Record<string, unknown> {
  const output = payload?.output
  const plainText =
    typeof output === 'string' || (Array.isArray(output) && output.every((entry) => typeof entry === 'string'))
  if (!plainText) return redactConversationValue({ ...payload })
  const redacted: Record<string, unknown> = redactConversationValue({ ...payload, output: '' })
  redacted.output = output
  return redacted
}

function redactEvent(event: ConversationEvent): ConversationEvent {
  return isPlainDelta(event) ? event : redactConversationValue(event)
}

const ENVELOPE_KEYS = new Set([
  'id',
  'seq',
  'sessionId',
  'workspaceId',
  'agentId',
  'providerId',
  'modelId',
  'type',
  'createdAt',
  'payload',
])

/**
 * A reply or reasoning delta that is only its text: every token of a reply is
 * one, and redaction goes by key, so none of its keys has anything to redact.
 * Skipping it spares a JSON round trip per token. A delta carrying anything
 * else is redacted like any event.
 */
function isPlainDelta(event: ConversationEvent): boolean {
  if (event.type !== 'content_delta' && event.type !== 'reasoning_delta') return false
  for (const key in event) if (!ENVELOPE_KEYS.has(key)) return false
  for (const key in event.payload ?? {}) if (key !== 'text' && key !== 'turnId') return false
  return true
}

/** Events that ride the log's short batch instead of forcing a write. */
function isStreamedEvent(event: ConversationEvent): boolean {
  return (
    event.type === 'content_delta' ||
    event.type === 'reasoning_delta' ||
    (event.type === 'tool_output' && event.payload?.partial === true)
  )
}
