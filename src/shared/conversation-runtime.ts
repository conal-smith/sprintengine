// The conversation contract — events, their payloads, pages and stream
// frames — is @sprintengine/conversation-protocol's, which every transport
// speaks (the chat view's IPC, the tailnet lane, the module SDK). It is
// re-exported here under the names app code has always imported; what stays
// below is the runtime's own: session inputs, results and summaries.
import type {
  ConversationApprovalKind,
  ConversationBackgroundTask,
  ConversationEvent,
  ConversationJsonValue,
  ConversationMessageOrigin,
  ConversationPage,
  ConversationSessionStatus,
  ConversationToolKind,
  ConversationToolOutputPayload,
  ConversationToolStartedPayload,
  ConversationToolStatus,
} from '../../packages/conversation-protocol/src/public'
export type {
  ConversationApprovalKind,
  ConversationApprovalRequestedPayload,
  ConversationBackgroundTask,
  ConversationBackgroundTaskKind,
  ConversationApprovalResolvedPayload,
  ConversationCursor,
  ConversationEvent,
  ConversationEventType,
  ConversationGoal,
  ConversationGoalStatus,
  ConversationHandoffPayload,
  ConversationJsonValue,
  ConversationMessageOrigin,
  ConversationPage,
  ConversationQuestion,
  ConversationQuestionOption,
  ConversationSessionStatus,
  ConversationStreamFrame as ConversationSessionFrame,
  ConversationSubagentMessagePayload,
  ConversationSubagentState,
  ConversationSubagentStatusPayload,
  ConversationToolKind,
  ConversationToolOutputPayload,
  ConversationToolStartedPayload,
  ConversationToolStatus,
  ConversationTurnCompletedPayload,
  ConversationTurnRetryingPayload,
  ConversationTurnUsage,
} from '../../packages/conversation-protocol/src/public'
// Who a `user_message` came from when it was not the person (`origin`).
export { readConversationMessageOrigin } from '../../packages/conversation-protocol/src/public'

/**
 * A file one of a conversation's tool calls is reading or editing, or did a
 * moment ago: what the Files tree marks while the agent works. One entry per
 * path, so a patch across three files is three.
 */
export type ConversationFileActivity = {
  /** Absolute and `/`-separated, a relative path placed against the root the agent runs in. */
  path: string
  verb: 'reading' | 'editing'
  /** The tool call. */
  toolUseId: string
  /** The call that spawned the agent doing it, for a spawned agent's step; absent for the conversation's own. */
  laneId?: string
  startedAt: number
  /** Absent while the call runs. */
  endedAt?: number
}

export type ConversationSessionSummary = {
  sessionId: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  status: ConversationSessionStatus
  createdAt: number
  updatedAt: number
  displayName?: string
  capabilities?: ConversationCapabilities
  phase?: import('./conversation/phase').ConversationPhase
  currentToolTitle?: string
  firstUserText?: string
  lastUserText?: string
  // The opening of the agent's last reply (the sidebar's preview)…
  lastAssistantText?: string
  // …and its end, where an agent puts its conclusion: what a launch notice
  // quotes to the agent that started this one.
  lastAssistantTail?: string
  // Background subagents still running. They keep the conversation working
  // after its turn has ended, so the sidebar and tab still show activity.
  backgroundAgents?: number
  // Shells and monitors the chat's process still runs after its turn ended.
  // They keep that process alive, and a monitor keeps the chat working too,
  // since it wakes the agent when it has something to say. Absent when none.
  backgroundTasks?: ConversationBackgroundTask[]
  // When the most recent turn completed or failed (the event's own time, so it
  // survives a resume). Absent until a turn has ended. The sidebar and the tab
  // count "finished" from this rather than `updatedAt`, which also moves on a
  // model or permission change.
  lastTurnEndedAt?: number
  // When the turn now running began: its message was sent, or the agent
  // carried on by itself. A message steered into a running turn does not move
  // it. Absent between turns, so a "working for" count needs no event stream.
  turnStartedAt?: number
  // When the chat's current stretch of work began (conversation/
  // workingStretch.ts): the person's message that began it, carried through
  // the turns the chat opens by itself while a background agent or a monitor
  // still works, where `turnStartedAt` restarts with each. The sidebar's
  // "working for" count, here and on a paired machine. Present only while the
  // summary reads as working (`conversationSummaryPhase` running or
  // starting), and absent from a server built before it, where the sidebar
  // keeps its own reading.
  workingSince?: number
  // When the chat began waiting on the person: the request (an approval or a
  // question) that stopped it, by the event's own time, so a resume restores
  // it from the transcript. A second card while one is up does not move it.
  // Absent while nothing is asked. `updatedAt` cannot stand in: it also moves
  // on a model or permission change.
  waitingSince?: number
  // When the person last sent the chat a message (the event's own time, so it
  // survives a resume). `updatedAt` also moves on a model or permission
  // change, which is not the person saying anything. Absent until one is sent.
  lastUserMessageAt?: number
  // Settle, Snooze or the idle sweep ended the chat's child process and
  // nothing has started it again; the next message does. The session and its
  // resume cursor stay, so its status still reads `ready`, but it holds no
  // process and is not warm to switch into. Absent while a child may be live.
  resting?: true
  // The main conversation's prompt cache, as its provider's last request left
  // it: when it goes cold and what a cold resume re-caches
  // (shared/prompt-cache.ts). Absent for a provider that reports no cache.
  promptCache?: import('./prompt-cache').PromptCacheReading
  // The files the conversation's tool calls are reading and editing, and the
  // ones they finished with in the last minute (shared/conversation/
  // fileActivity.ts): what the Files tree marks. Absent when there are none,
  // and from a server built before it existed, which the tree reads as an
  // agent touching nothing.
  fileActivity?: ConversationFileActivity[]
  // The preset currently in force, when the session carries one. Absent means
  // the session never set one and the provider passes no permission override,
  // as `none` does. Changing it mid-conversation goes through
  // `conversation:sessions:set-permission`.
  permissionPreset?: ConversationPermissionPreset
  // The CLI's own mode at that preset (Claude Code's Accept edits), when one
  // other than the preset's own is in force (cli-permission-mode.ts). Absent,
  // the preset's own mode.
  permissionMode?: string
  // The session was started with tools it may use without asking
  // (`allowedTools`). For those tools that is as loose as `bypass`, so anything
  // holding a caller to a ceiling counts it as bypass. The tools themselves
  // are not listed here.
  allowsUnaskedTools?: true
}

// Loose mirror of the CLI runtime override map (`appSettings.cliRuntimes`)
// so stateful CLI-backed providers can honor a custom binary path. Kept
// structural (not the electron-api types) to avoid a shared-type cycle.
export type ConversationCliRuntimeOverrides = Record<
  string,
  { command?: string; hostId?: import('./execution-host').ExecutionHostId; models?: string[] } | undefined
>

// Mirrors the terminal-side `cliPermissionPreset` vocabulary
// (CliPermissionPreset, shared/cli-permission-preset.ts, where each mode's
// meaning is written down) without importing electron-api types. The value
// tuple is exported so the IPC boundary validates against one list.
export const CONVERSATION_PERMISSION_PRESETS = ['none', 'manual', 'auto', 'bypass'] as const

export type ConversationPermissionPreset = (typeof CONVERSATION_PERMISSION_PRESETS)[number]

/**
 * An MCP server a chat's session is started with, on top of whatever the
 * person's own CLI configuration loads: a connector automation's server, or
 * the app's own gateway. The fields an installed server (`McpServerConfig`)
 * carries for the CLI; `envVarNames` names variables the CLI hands the server
 * from its own environment (an HTTP server's bearer token is the first).
 */
export type ConversationMcpServer = {
  id: string
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  envVarNames?: string[]
}

export type ConversationStartSessionInput = {
  workspaceRoot: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  cliRuntimes?: ConversationCliRuntimeOverrides
  // How tool permissions behave for CLI-backed stateful providers: 'bypass'
  // skips the CLI's permission prompts (the default for every agent), 'auto'
  // lets workspace edits through and asks before anything riskier, 'manual'
  // asks before every edit, command and outside call, and 'none' passes no
  // override and lets the CLI's own configuration decide — which can still
  // ask, as approval cards.
  permissionPreset?: ConversationPermissionPreset
  // The CLI's own mode at that preset, read only beside it; one the provider
  // does not run (`capabilities.permissionModes`) starts the preset's own.
  permissionMode?: string
  // Tools auto-allowed without an approval card. Lets unattended flows (the
  // long-running authoring sessions) run file writes without stalling while interactive tools
  // (AskUserQuestion) still surface as cards — unlike bypass, which would
  // silence them entirely.
  allowedTools?: string[]
  // MCP servers this session alone runs with. Main-only: a start that comes
  // over IPC never carries them. A provider that cannot take servers per
  // session refuses a start that names any, rather than running without them.
  mcpServers?: ConversationMcpServer[]
}

export type ConversationProvidersListInput = {
  cliRuntimes?: ConversationCliRuntimeOverrides
}

// Signing a chat's CLI back in after its login lapsed: the line a plain
// terminal on this machine runs, resolved to the executable the provider runs.
export type ConversationProviderSignInInput = {
  providerId: string
  cliRuntimes?: ConversationCliRuntimeOverrides
}

export type ConversationProviderSignInResult =
  | {
      ok: true
      commandLine: string
      cwd: string
      platform: string
      /** The machine the sign-in terminal opens on; absent is this one. */
      hostId?: import('./execution-host').ExecutionHostId
    }
  | { ok: false; message: string }

export type ConversationTranscriptInput = {
  workspaceRoot: string
  workspaceId: string
  agentId: string
}

export type ConversationTranscriptResult = { ok: true; events: ConversationEvent[] } | { ok: false; message: string }

// The images a turn carries, as the timeline package defines them.
import type {
  ConversationImageAttachment,
  ConversationStoredImageAttachment,
} from '../../packages/conversation-timeline/src/attachments'
export type { ConversationImageAttachment, ConversationStoredImageAttachment }

export type ConversationAttachmentInput = { ref: string }
export type ConversationAttachmentResult =
  { ok: true; mediaType: string; dataBase64: string } | { ok: false; message: string }

// A plan the agent proposed, as a file the workspace pane can open. `plan` is
// the text the transcript recorded; `planFilePath` is the agent's own copy
// when it keeps one on this machine (Claude Code's plan file). The result is
// that file when it still holds this plan, otherwise a copy in app data.
export type ConversationPlanDocumentInput = ConversationKey & {
  plan: string
  title?: string
  planFilePath?: string
}
export type ConversationPlanDocumentResult = { ok: true; path: string } | { ok: false; message: string }

export type ConversationSendTurnInput = {
  // What the command was, hashed by whoever named its id: a receipt keeps it,
  // and the same id coming back for a different command is refused rather
  // than answered with the first one's result. Never sent by a window's IPC.
  commandFingerprint?: string
  mentions?: import('./conversation/mentions').ConversationMentionRef[]
  // Files attached by path from this computer: the agent is told where each
  // is, after the words, and the `user_message` keeps them beside the text
  // so the bubble draws them as cards. The text stays the person's words.
  files?: import('./conversation/attachedFiles').ConversationAttachedFile[]
  reasoningEffort?: string
  mode?: 'default' | 'plan' | 'ask'
  commandId?: string
  skills?: ConversationSkillRef[]
  sessionId: string
  message: string
  // Renderer-generated id of the optimistic user bubble for this send; echoed
  // back on the persisted `user_message` event so the projection can replace
  // the optimistic entry with the authoritative one deterministically.
  localTurnId?: string
  // Images attached to this turn. Honored only by vision-capable providers
  // (currently the claude-agent provider); other providers ignore them, so no
  // image block is ever sent to them. Main keeps a copy in the attachment store
  // so the replayed bubble can show them; the model sees them on this turn only.
  attachments?: ConversationImageAttachment[]
  // Deliver into the turn that is running instead of waiting for it to end.
  // Honored where the provider declares `capabilities.steer`; the running
  // turn closes where the message lands, and the reply carries on as this
  // one's.
  steer?: boolean
  // Studio sent this message itself (a launched agent's notice, a resume after
  // a usage limit), not the person: recorded on the `user_message` so the chat
  // draws it as Studio's and nothing counts it as the person writing. Set only
  // by Studio's own senders in main; neither a window's IPC nor the Studio
  // protocol's `session.send` passes one through.
  origin?: ConversationMessageOrigin
  // When the person wrote the message, on the sending device's clock (epoch
  // ms): a paired device's `send` says so. Recorded on the `user_message`,
  // and a send under a command id written longer ago than the lane's limit is
  // refused `stale` unless `confirmedStale` says the person asked for it to go
  // now (`isStaleConversationSend`). A message held on a device while it slept
  // is not one the person still means hours later.
  composedAt?: number
  confirmedStale?: boolean
}

export type ConversationInterruptInput = {
  // What the command was, hashed by whoever named its id: a receipt keeps it,
  // and the same id coming back for a different command is refused rather
  // than answered with the first one's result. Never sent by a window's IPC.
  commandFingerprint?: string
  commandId?: string
  sessionId: string
}

export type ConversationRespondToRequestInput = {
  // What the command was, hashed by whoever named its id: a receipt keeps it,
  // and the same id coming back for a different command is refused rather
  // than answered with the first one's result. Never sent by a window's IPC.
  commandFingerprint?: string
  commandId?: string
  decision?: import('./conversation/approvalRules').ConversationApprovalDecision
  sessionId: string
  requestId: string
  approved: boolean
  // Structured answers for question-kind requests (AskUserQuestion): question
  // text → chosen answer (multi-select answers comma-separated, free-text
  // "other" answers verbatim). Ignored for plain tool approvals.
  answers?: Record<string, string>
  // The kind of request the caller believes it is answering. Given, an answer
  // to a request of another kind is refused rather than read as that kind's:
  // a plan approved by a client that meant to answer a tool permission is not
  // the same decision. Absent, any kind is answered, as before.
  requestKind?: ConversationApprovalKind
}

// Change how tool permissions behave on a session that is already running. The
// interactive path only: the change reaches the live provider session and takes
// effect on its next tool call, without recreating the session or losing
// history.
export type ConversationSetPermissionInput = {
  // What the command was, hashed by whoever named its id: a receipt keeps it,
  // and the same id coming back for a different command is refused rather
  // than answered with the first one's result. Never sent by a window's IPC.
  commandFingerprint?: string
  commandId?: string
  sessionId: string
  permissionPreset: ConversationPermissionPreset
  // The CLI's own mode at that preset; absent, the preset's own.
  permissionMode?: string
}

// Switch a running conversation to another model of the same provider. The
// CLI's own default row is `default`. Applies from the next turn.
export type ConversationSetModelInput = {
  // What the command was, hashed by whoever named its id: a receipt keeps it,
  // and the same id coming back for a different command is refused rather
  // than answered with the first one's result. Never sent by a window's IPC.
  commandFingerprint?: string
  commandId?: string
  sessionId: string
  modelId: string
}

/** What can be done to one of a live chat's MCP servers from its composer. */
export type ConversationMcpServerAction = 'reconnect' | 'enable' | 'disable' | 'sign-in'

export type ConversationMcpServerActionInput = {
  sessionId: string
  serverId: string
  action: ConversationMcpServerAction
}

/**
 * `authUrl` is where a sign-in is finished, in the person's browser; the CLI
 * waits on its own callback and reconnects the server once it arrives.
 */
export type ConversationMcpServerActionResult = { ok: true; authUrl?: string } | { ok: false; message: string }

/** One agent a chat spawned, named by the call that spawned it (its lane), to stop on its own. */
export type ConversationStopSubagentInput = {
  sessionId: string
  toolUseId: string
}

/**
 * A side question about a chat: answered from what the chat's agent knows, and
 * kept out of the conversation. Neither the question nor its answer enters the
 * agent's context, the transcript or the chat's history, and a turn the chat
 * is running goes on undisturbed. `requestId` is the caller's, so the question
 * can be called off while it is answered (`cancelSideQuestion`). `history` is
 * the side questions asked before it in the same aside, oldest first, so a
 * follow-up can lean on them.
 */
export type ConversationSideQuestionInput = {
  sessionId: string
  requestId: string
  question: string
  history?: ConversationSideQuestionExchange[]
}
export type ConversationSideQuestionExchange = { question: string; answer: string }
/** `cancelled`: called off before it was answered, which says nothing to the person. */
export type ConversationSideQuestionResult =
  { ok: true; answer: string } | { ok: false; message: string; cancelled?: true; code?: string }
export type ConversationCancelSideQuestionInput = { sessionId: string; requestId: string }

export type ConversationStopSessionInput = {
  // What the command was, hashed by whoever named its id: a receipt keeps it,
  // and the same id coming back for a different command is refused rather
  // than answered with the first one's result. Never sent by a window's IPC.
  commandFingerprint?: string
  sessionId: string
  // With one, the stop goes through the conversation's durable receipts like
  // any other command: a retry is answered with the first result, so a resend
  // after a reconnect cannot stop a session started since.
  commandId?: string
}

// Settle and Snooze: end the session's child process but keep the session, so
// the next message respawns it and resumes the same provider session.
export type ConversationSuspendSessionInput = {
  sessionId: string
}

// Resume in terminal: the chat's CLI session is taken over by a terminal agent
// running the CLI's own resume (`claude --resume <id>`, `codex resume <id>`).
export type ConversationTerminalHandoffInput =
  | { sessionId: string }
  // The chat by its identity, for a caller that holds no session of it (a tab's
  // menu): main hands over the session it has running, or starts one from the
  // chat's record to read the CLI session from its transcript, as after an app
  // restart, when nothing has been sent to the chat yet.
  | { workspaceId: string; agentId: string }

export type ConversationTerminalHandoffResult =
  // The terminal agent now carrying the conversation on, in the chat's workspace.
  { ok: true; workspaceId: string; agentId: string } | { ok: false; message: string }

export type ConversationListSessionsInput = {
  workspaceId?: string
  agentId?: string
}

export type ConversationStartSessionResult =
  { ok: true; session: ConversationSessionSummary } | { ok: false; message: string; event?: ConversationEvent }

export type ConversationSessionActionResult =
  // `notice` is a plain sentence for the user about a change that was accepted
  // but does not apply yet (switching to Bypass while a turn is still
  // streaming). The action succeeded; this is not an error.
  | { ok: true; session: ConversationSessionSummary; notice?: string }
  // `code` names a refusal a caller acts on by itself. The runtime gives three:
  // `command_id_conflict`, a command id already used for a different command,
  // `session_not_found` (CONVERSATION_SESSION_NOT_FOUND), and `busy`, a send
  // that arrived while a turn runs, to send again after `retryAfterMs`.
  | { ok: false; message: string; event?: ConversationEvent; code?: string; retryAfterMs?: number }

/**
 * The refusal of a call about a session the runtime does not hold: the
 * server that held it restarted (a WSL distribution's, an SSH machine's, the
 * desktop's own out of process), or the chat started another. Whoever holds
 * the id starts the chat's session again, which resumes it from its
 * transcript, and sends again on that one.
 */
export const CONVERSATION_SESSION_NOT_FOUND = 'session_not_found'

export type ConversationListSessionsResult =
  { ok: true; sessions: ConversationSessionSummary[] } | { ok: false; message: string }

export type ConversationToolDetail = {
  input: ConversationJsonValue
  output: ConversationJsonValue
  status: ConversationToolStatus
  exitCode?: number
  mime?: string
  totalBytes?: number
  clipped: boolean
}
export type ConversationToolDetailInput = ConversationTranscriptInput & { toolUseId: string }
export type ConversationToolEvent =
  | (Omit<ConversationEvent, 'type' | 'payload'> & {
      type: 'tool_started'
      payload: ConversationToolStartedPayload & {
        toolUseId: string
        kind: ConversationToolKind
        name: string
        input: ConversationJsonValue
      }
    })
  | (Omit<ConversationEvent, 'type' | 'payload'> & {
      type: 'tool_output'
      payload: ConversationToolOutputPayload & {
        toolUseId: string
        preview: string
        totalBytes: number
        truncated: boolean
        status: ConversationToolStatus
      }
    })
export type ConversationToolDetailResult =
  | { ok: true; detail: ConversationToolDetail }
  | { ok: false; code: 'not_found' | 'invalid_input' | 'unavailable'; message: string }
export type ConversationCapabilities = {
  permissionPresets?: ConversationPermissionPreset[]
  // The CLI's own modes this chat can run beside the presets' own, by the ids
  // its CLI's manifest keys them under (`conversationPermissionModes`).
  permissionModes?: string[]
  tools: boolean
  approvals: boolean
  questions: boolean
  planMode: boolean
  images: boolean
  // `native`: the provider loads attached skills itself. `context`: the
  // runtime delivers them, as the CLI's own invocation by name when a CLI
  // stands behind the chat (conversation-skills.ts), else as instructions.
  skills: 'native' | 'context' | 'none'
  reasoningEfforts: string[] | null
  interrupt: boolean
  resume: boolean
  subagents: boolean
  cost: boolean
  contextMeter: boolean
  liveModelSwitch: boolean
  // What the composer may do to the chat's MCP servers while it runs.
  mcpServerActions?: ConversationMcpServerAction[]
  checkpoints?: boolean
  // The provider reads `@path` in a prompt as a reference to that workspace
  // file and opens it itself, so a mention can be passed as `@path`.
  atMentions?: boolean
  // The provider takes a user message into a turn it is already running
  // (`steer` on a send). Without it, sending now means stopping the turn first.
  steer?: boolean
  // The provider can take the conversation back to before one of its user
  // messages, dropping that message and everything after it from its own
  // context ("Edit from here"). Without it the action is not offered.
  rewind?: boolean
  // A new chat can be made holding this one up to an earlier message, and
  // carry on from there on its own ("Fork from here"). Without it the action
  // is not offered.
  fork?: boolean
  // A fork at the newest reply branches the session the chat is running
  // (an ACP agent's `session/fork`), so the chat's session is started first.
  forkFromLiveSession?: boolean
  // The chat can be handed off to a fresh provider session that is pointed
  // at a file of its messages ("Handoff", `ConversationHandoffInput`).
  // Without it the action is not offered.
  handoff?: boolean
  // One agent the chat spawned can be stopped by itself, leaving the chat,
  // its turn and its other agents running. Without it a lane offers no Stop.
  stopSubagent?: boolean
  // A side question can be asked about the chat and answered from its
  // context without entering it, even while a turn runs. Without it the
  // action is not offered.
  sideQuestion?: boolean
}
export type ConversationCheckpointFile = {
  path: string
  status: 'added' | 'modified' | 'deleted'
  addedLines: number
  removedLines: number
  binary: boolean
}
export type ConversationCheckpointDiff = { files: ConversationCheckpointFile[]; submodulesExcluded: true }
export type ConversationTurnDiffInput = { key: ConversationKey; turnSeq: number; path?: string }
export type ConversationTurnDiffResult =
  | { ok: true; diff: ConversationCheckpointDiff; patch?: string; original?: string; modified?: string }
  | { ok: false; message: string }
/** A confirmed revert names the exact paths the preview showed; any drift refuses with `changed`. */
export type ConversationRevertInput = {
  key: ConversationKey
  turnSeq: number
  confirmed?: boolean
  undo?: boolean
  files?: string[]
}
export type ConversationRevertResult =
  | {
      ok: true
      files: ConversationCheckpointFile[]
      reverted: boolean
      undoRef?: string
      /** Listed as added but left in place: the checkpoint's ignore rules ignore them. */
      kept?: string[]
    }
  | { ok: false; message: string; changed?: true }
/**
 * Take the conversation back to before the user message at `turnSeq`: that
 * message and every turn after it leave the provider's context and the
 * transcript's view. Files are not touched; a caller that wants them back
 * reverts the turn's checkpoint first.
 */
export type ConversationRewindInput = { key: ConversationKey; turnSeq: number }
export type ConversationRewindResult = { ok: true } | { ok: false; message: string }
/**
 * Hand a chat off to a fresh provider session instead of compacting it: its
 * messages (no tool calls, no tool output) are saved to a file in the
 * project's store, the provider session is let go, and the next message the
 * person sends points the new session at the file. The chat's history stays
 * as it was, with a divider where the handoff happened. Refused while the chat
 * is doing anything: a turn, a question, an agent, a shell or a monitor all
 * live in the process this ends.
 */
export type ConversationHandoffInput = { key: ConversationKey }
export type ConversationHandoffResult = { ok: true; path: string } | { ok: false; message: string }
/**
 * Start a new chat, `newAgentId`, holding this one up to a point: through the
 * reply of the turn `turnId` names, or up to (not including) the user message
 * at `turnSeq`. The new chat carries on by itself; this one is not touched.
 * `title` names it in the chat history.
 */
export type ConversationForkInput = {
  key: ConversationKey
  newAgentId: string
  title?: string
} & ({ side: 'assistant'; turnId: string } | { side: 'user'; turnSeq: number })
export type ConversationForkResult = { ok: true } | { ok: false; message: string }
/**
 * Give a new chat the history of a session an agent CLI saved on its own (one
 * a person ran in its terminal), ending in that session's id as the chat's
 * resume cursor, so the chat's next message continues the same session.
 * `events` are the history in this protocol's vocabulary, oldest first.
 */
export type ConversationImportTranscriptInput = {
  key: ConversationKey
  providerId: string
  modelId: string
  providerSessionId: string
  title?: string
  importedFrom: { source: string; sessionId: string }
  events: Array<{ type: ConversationEvent['type']; createdAt: number; payload: Record<string, unknown> }>
}
export type ConversationImportTranscriptResult = { ok: true } | { ok: false; message: string }
export type ConversationSkillRef = { id: string; sourcePath?: string }
export type ConversationApprovalRulesResult =
  | { ok: true; rules: import('./conversation/approvalRules').ConversationApprovalRule[] }
  | { ok: false; message: string }
export type ConversationApprovalRuleRevokeResult = { ok: true } | { ok: false; message: string }

export type ConversationKey = ConversationTranscriptInput
// `afterSeq` with the `generation` from an earlier snapshot or synchronized
// frame asks for only the events after that sequence. A cursor the log cannot
// vouch for (another generation, ahead of the log, or too far behind) gets a
// reset snapshot instead, as does a cursor sent without a generation.
export type ConversationSubscribeInput = {
  key: ConversationKey
  afterSeq?: number
  generation?: string
  turnLimit?: number
}
export type ConversationLoadEarlierInput = { key: ConversationKey; beforeCursor: number; turnLimit?: number }
export type ConversationPageResult = { ok: true; page: ConversationPage } | { ok: false; message: string }
