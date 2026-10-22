import type {
  ConversationCapabilities,
  ConversationCliRuntimeOverrides,
  ConversationContextBreakdownResult,
  ConversationEvent,
  ConversationImageAttachment,
  ConversationMcpServer,
  ConversationMcpServerAction,
  ConversationMcpServerActionResult,
  ConversationPermissionPreset,
  ConversationSideQuestionExchange,
  ConversationSideQuestionResult,
} from '../../shared/conversation-runtime'

/** A side question as the runtime hands it on: `signal` calls it off. */
export type ConversationProviderSideQuestionInput = {
  question: string
  history: ConversationSideQuestionExchange[]
  signal: AbortSignal
}

/** How far `disposeChildProcess` goes; see ConversationProviderAdapter. */
export type ConversationDisposeOptions = { force?: boolean }

export type ConversationProviderEventStream =
  | ConversationEvent[]
  | AsyncIterable<ConversationEvent>
  | Promise<ConversationEvent[] | AsyncIterable<ConversationEvent>>

// Lifecycle inventory entry for adapters that own a child process per session
// (stateful CLI-backed providers). Consumed by the runtime's idle sweep,
// app-quit disposal, and process diagnostics.
export type ConversationProviderLiveSession = {
  sessionId: string
  workspaceId: string
  agentId: string
  workspaceRoot: string
  providerSessionId: string | null
  hasChildProcess: boolean
  childPid: number | null
  turnActive: boolean
  pendingApproval: boolean
  lastActivityAt: number
  spawnedAt: number | null
}

export type ConversationProviderAdapter = {
  id: string
  displayName?: string
  capabilities?: ConversationCapabilities
  listModels(): string[]
  // 'stateless' (default when absent): the runtime owns chat history and
  // replays `[...history, user]` every turn. 'stateful': the adapter owns a
  // long-lived provider session (history, native resume, mid-turn approvals);
  // the runtime must not replay history and routes approval responses to the
  // still-active turn.
  sessions?: 'stateless' | 'stateful'
  // The adapter starts its provider with the session's `mcpServers`. Absent,
  // the runtime refuses a start that names any: a connector's agent run
  // without its connector would be a different agent.
  acceptsMcpServers?: boolean
  // The CLI whose `cliRuntimes` entry decides where this adapter's agent runs
  // (`claude-code`, `codex`, an ACP profile's CLI). The runtime reads that
  // entry's host to know when an agent runs in WSL, whose tool calls name files
  // the Linux way while the workspace root is a Windows path. Absent, the agent
  // is taken to run on this machine as it is.
  executionHostCli?: string
  startSession(input: MockAdapterSessionInput): ConversationProviderEventStream
  sendTurn(input: MockAdapterTurnInput): ConversationProviderEventStream
  resolveApproval(input: MockAdapterApprovalInput): ConversationProviderEventStream
  interrupt(input: MockAdapterSessionInput): ConversationProviderEventStream
  stopSession(input: MockAdapterSessionInput): ConversationProviderEventStream
  // Live permission-preset change on a running session. An adapter that owns a
  // provider session with its own permission mode implements this: it pushes the
  // new mode into the live session so the next tool call honors it, and records
  // the preset so a respawn keeps it. Absent means the adapter has no live
  // permission surface, and the runtime refuses the change instead of recording
  // a preset the provider would never honor.
  setPermissionPreset?(input: MockAdapterPermissionInput): Promise<ConversationProviderPermissionResult>
  // Live model switch on a running session, within the provider's own CLI. The
  // adapter records the model so every later turn (and a respawn) runs on it,
  // and pushes it into a live provider session where the provider has a way
  // to. An adapter that implements this declares `capabilities.liveModelSwitch`
  // so the renderer offers the switch; absent, the runtime refuses it.
  setModel?(input: MockAdapterModelInput): Promise<ConversationProviderPermissionResult>
  /** Reconnect, switch or sign in to one of the live session's MCP servers (`capabilities.mcpServerActions`). */
  mcpServerAction?(
    input: MockAdapterSessionInput & { serverId: string; action: ConversationMcpServerAction },
  ): Promise<ConversationMcpServerActionResult>
  // Take an idle session back to a point the adapter itself recorded: the
  // `providerCursor` it put on an earlier turn's end, or null for before the
  // first turn. The adapter drops its live child and continues from there on
  // the next turn, so the turns after the point leave the provider's context.
  // An adapter that implements this declares `capabilities.rewind`.
  rewind?(input: MockAdapterRewindInput): Promise<ConversationProviderPermissionResult>
  // Let an idle session's provider session go, and start the next one afresh,
  // pointed at a file of the conversation's messages (`handoffPath`) by the
  // next message that is not a command: what "Handoff" does instead of a
  // compaction. The adapter drops its live child, owes the pointer until a
  // message carries it, and then says so with `session_updated`
  // `historySeeded: true`. An adapter that implements this declares
  // `capabilities.handoff`.
  handoff?(input: MockAdapterHandoffInput): Promise<ConversationProviderPermissionResult>
  // Say where a new chat forked from this one starts its provider session
  // ("Fork from here"). Asked once, as the fork is made, with the chat's
  // session context (live or not) and where its provider stood at the point
  // forked at. The answer is the fork's own resume cursor: the parent's
  // session at that point, which the fork's first child branches from as a
  // rewind's does (`resumeSessionAt`), or a session the adapter already
  // branched off; null starts the fork's provider afresh, handed the
  // conversation so far as text (`seedFromHistory`). Absent, a stateful
  // adapter's forks are seeded that way and a stateless one's need nothing.
  // An adapter that can be forked declares `capabilities.fork`.
  fork?(input: MockAdapterForkInput): Promise<ConversationProviderForkResult>
  // Hand a user message to the turn that is running (`turnId`, the id its
  // `sendTurn` was given), which takes it in without a turn of its own: the
  // running turn's stream goes on carrying every event, and ends only once
  // the provider has answered this message too. It never starts new work or
  // respawns anything; a turn that has not reached the provider yet, or has
  // already ended, refuses. An adapter that implements this declares
  // `capabilities.steer`; without it, sending mid-turn means stopping first.
  steer?(input: MockAdapterSteerInput): Promise<ConversationProviderSteerResult>
  // Optional lifecycle surface for adapters holding child processes: inventory
  // for diagnostics/status, idle disposal (keeps the session + resume cursor;
  // the next turn respawns), and dispose-everything for app shutdown, which
  // settles once whatever the children left on disk is gone.
  listLiveSessions?(): ConversationProviderLiveSession[]
  // Without `force` a child still doing work (a running turn, a pending card,
  // a subagent) is kept and false returned, as the idle sweep needs. With it
  // the child ends whatever it is doing, as Settle and Snooze ask.
  disposeChildProcess?(sessionId: string, options?: ConversationDisposeOptions): boolean
  // Stop the shells, monitors and workflows the session's child still runs
  // after its turn ended (what `session_updated` lists as `backgroundTasks`),
  // as Stop between turns asks. Each reports its own end as it stops; the
  // child and the session stay. False when nothing runs that can be stopped.
  stopBackgroundTasks?(sessionId: string): Promise<boolean>
  // Stop one running agent the session spawned, named by the tool call that
  // spawned it (its lane), and nothing else: the turn, the child and the
  // session's other agents go on. The agent reports its own end, as one that
  // finished does. False when no such agent is running. An adapter that
  // implements this declares `capabilities.stopSubagent`.
  stopSubagent?(sessionId: string, toolUseId: string): Promise<boolean>
  // Answer a side question from what the session's agent knows, adding
  // nothing to it: the question and the answer reach neither the session's
  // events nor the provider's own record of the conversation, and a turn the
  // session is running carries on as it was. An adapter that implements this
  // declares `capabilities.sideQuestion`.
  askSideQuestion?(
    sessionId: string,
    input: ConversationProviderSideQuestionInput,
  ): Promise<ConversationSideQuestionResult>
  // Say what fills the session's context window, row by row and item by item,
  // as the provider itself measures it, adding nothing to the conversation.
  // Asked when a person opens the window's breakdown, never on a timer. An
  // adapter that implements this declares `capabilities.contextBreakdown`.
  readContextBreakdown?(sessionId: string): Promise<ConversationContextBreakdownResult>
  disposeAll?(): void | Promise<void>
}

export type MockAdapterSessionInput = {
  sessionId: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  // Stateful-session context. The runtime always passes these through from the
  // live session; they are optional so stateless adapters/tests stay minimal.
  workspaceRoot?: string
  resumeSessionId?: string
  // With `resumeSessionId`: resume only up to this point of that provider
  // session, as a fork, because the conversation was rewound to it, or is a
  // new chat forked from another there, and no turn has been sent since.
  resumeSessionAt?: string
  fallbackHistory?: ConversationMessage[]
  // A fork whose provider could not branch the parent's session: the first
  // message the provider is sent carries `fallbackHistory` ahead of it, the
  // only context the new session gets.
  seedFromHistory?: boolean
  // A handoff no message has carried yet (`handoff`): the next message that
  // is not a command points the new session at this file of the
  // conversation's messages.
  handoffPath?: string
  // The tool call that first spawned each agent the chat has seen, by task, as
  // its transcript and earlier sessions recorded them: an agent resumed after a
  // restart goes on in the lane it started in.
  knownSubagentLanes?: ReadonlyArray<readonly [taskId: string, toolUseId: string]>
  cliRuntimes?: ConversationCliRuntimeOverrides
  permissionPreset?: ConversationPermissionPreset
  // The CLI's own mode at that preset, when one other than its own is chosen.
  // A provider that does not map it runs the preset's own.
  permissionMode?: string
  allowedTools?: string[]
  // MCP servers the provider starts this session with (`acceptsMcpServers`).
  mcpServers?: ConversationMcpServer[]
  // Session-scoped continuation channel (provider → runtime), set on
  // startSession for stateful adapters whose child outlives a single turn. A
  // long-lived agent legitimately keeps working after the SDK `result` that
  // ends a `sendTurn` — most often when a background subagent (the Task tool)
  // completes and the model resumes to issue more tool calls or an
  // AskUserQuestion. Those events have no open `sendTurn` generator to carry
  // them; the adapter pushes them here instead. Contract: the adapter opens a
  // *continuation turn* by emitting `turn_started` with a fresh turnId, streams
  // its events (content, tool calls, `approval_requested`), and closes it with
  // `turn_completed`/`turn_failed`. The runtime mirrors that turn in its
  // session state and broadcasts through its normal event path, so an approval
  // card raised on this channel surfaces and resolves through the unchanged
  // respondToRequest → resolveApproval path. Absent for stateless adapters.
  onSessionEvent?: ConversationSessionEventSink
  onBeforeTool?: (name: string) => Promise<void>
}

// Callback the runtime hands a stateful adapter to deliver continuation-turn
// events outside a `sendTurn` generator. Fire-and-forget: the runtime serializes
// and persists internally, so the adapter never awaits it.
export type ConversationSessionEventSink = (event: ConversationEvent) => void

// `attachments` is structural parity with the turn input; v1 does not persist
// or replay it in history, so the runtime never populates it here.
export type ConversationMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
  attachments?: ConversationImageAttachment[]
}

export type MockAdapterTurnInput = MockAdapterSessionInput & {
  reasoningEffort?: string
  mode?: 'default' | 'plan' | 'ask'
  turnId: string
  requestId: string
  message: string
  skills?: string[]
  // Images attached to this turn, on this turn only: later turns' history does
  // not repeat them. Vision-capable adapters compose them into the provider
  // request, others ignore them.
  attachments?: ConversationImageAttachment[]
  // Full chat history including the current user turn, in send order. Providers
  // that support multi-turn context send this; absent for legacy/mock callers,
  // who fall back to the single `message`.
  messages?: ConversationMessage[]
  signal?: AbortSignal
}

// The session context, the running turn, and the message to hand it.
export type MockAdapterSteerInput = MockAdapterSessionInput & {
  turnId: string
  message: string
  attachments?: ConversationImageAttachment[]
}

// Whether the message went in. `providerCursor` is where the provider's own
// session stood as it did: what going back to before this message returns to.
export type ConversationProviderSteerResult =
  { ok: true; providerCursor?: ConversationProviderCursor } | { ok: false; message: string }

// The session context plus the preset to switch to, for `setPermissionPreset`,
// and the CLI's own mode at it when one other than the preset's own is chosen.
export type MockAdapterPermissionInput = MockAdapterSessionInput & {
  permissionPreset: ConversationPermissionPreset
  permissionMode?: string
}

// The session context plus the model to switch to, for `setModel`. `modelId`
// here is the NEW model; the CLI's own default row is `default`.
export type MockAdapterModelInput = MockAdapterSessionInput & { nextModelId: string }

// Where a stateful provider's own session stood at the end of a turn: which
// provider session, and the last entry of its history the turn left. Adapters
// that rewind put one on each turn end they emit (`providerCursor` in the
// payload); `at` is null when the adapter could not tell.
export type ConversationProviderCursor = { sessionId: string; at: string | null }

// The session context plus where to take it back to; null is before the
// conversation's first turn.
export type MockAdapterRewindInput = MockAdapterSessionInput & {
  cursor: ConversationProviderCursor | null
  // The point gone back to is the start of a session a handoff began, before
  // any message carried its pointer: the next message carries it again.
  handoffPath?: string
}

// The session context plus the file the conversation's messages were saved to.
export type MockAdapterHandoffInput = MockAdapterSessionInput & { handoffPath: string }

// The parent chat's session context (its session id may name no live
// session), plus where to fork it. `resumeSessionId` is the provider session
// the parent would resume now. `cursor` is where that provider stood at the
// point forked at, as the adapter recorded it on a turn's end, or null with
// `exact` when the fork holds no turn that reached the provider. `exact` is
// false when the transcript has no such record: the turns kept and the
// provider's session cannot be lined up. `latest`: nothing the parent's
// provider has seen comes after the point.
export type MockAdapterForkInput = MockAdapterSessionInput & {
  cursor: ConversationProviderCursor | null
  exact: boolean
  latest: boolean
}

// The fork's resume cursor (see `fork`), or why it cannot be made. A failure
// message is shown to the person.
export type ConversationProviderForkResult =
  { ok: true; cursor: ConversationProviderCursor | null } | { ok: false; message: string }

// Whether the adapter actually applied the preset. A failure message is shown to
// the user, so it must say what the provider refused rather than a generic error.
// `notice` accompanies a preset the adapter recorded but could not apply to the
// turn already running; it is shown as information, never as a failure.
export type ConversationProviderPermissionResult = { ok: true; notice?: string } | { ok: false; message: string }

export type MockAdapterApprovalInput = MockAdapterSessionInput & {
  turnId: string
  requestId: string
  approved: boolean
  // Structured answers for question-kind approvals (question text → answer).
  answers?: Record<string, string>
}
