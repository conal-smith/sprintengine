import type { ConversationJsonValue, ConversationToolKind, ConversationToolStatus } from './tool-types.js'

// The public event layer: what a conversation records, in a vocabulary no
// provider owns. Each provider adapter reads its CLI's own stream (an SDK
// message, an app-server notification, an ACP update) and writes these; the
// provider's own shapes never leave the adapter. Everything that follows a
// conversation — the chat view, a paired device, a module, an embedder — reads
// this layer and nothing under it.
//
// Additive by rule: a client skips an event type, or a payload member, it does
// not know (`parseConversationWireEvent` lets unknown types through for that
// reason), so a new kind or field ships without a version bump.

export type ConversationSessionStatus = 'starting' | 'ready' | 'active' | 'awaiting_approval' | 'stopped' | 'failed'

/** Every kind of event a conversation records, oldest first. */
export const CONVERSATION_EVENT_TYPES = [
  'session_started',
  'session_ready',
  'session_closed',
  // A session's own facts changed: its model, its preset, a notice about
  // either, the provider's capabilities. Stateful providers also report their
  // durable resume cursor here, which the desktop reads back from the
  // transcript to resume natively.
  'session_updated',
  // Recorded by the desktop at turn start with the person's message, so a
  // replayed transcript has the user's side of the conversation too. A message
  // the desktop itself sent carries an `origin` (`ConversationMessageOrigin`);
  // one without it is the person's.
  'user_message',
  'turn_started',
  'content_delta',
  'reasoning_delta',
  'tool_started',
  'tool_output',
  'approval_requested',
  'approval_resolved',
  // What the session spent and how full its context window is. Each member is
  // optional and a report carries the ones that moved: `inputTokens`,
  // `cachedInputTokens`, `outputTokens`, `totalTokens` (the exchange's cost),
  // `promptCache`, `costUsd`, and `contextWindow` (the model's window, in
  // tokens) with `contextUsed` (the tokens in the window now — the latest
  // request's size, never a sum over requests). Claude Code, Codex and ACP
  // agents report the last two.
  'usage_updated',
  // The provider summarised the conversation to free context (payload:
  // `trigger` 'manual' | 'auto', `preTokens`, `postTokens`).
  'context_compacted',
  // The provider started summarising the conversation, on `/compact` or on its
  // own when the window filled (payload: `turnId`). Says what the turn is doing
  // until `context_compacted`, or the next thing the turn says, supersedes it.
  'context_compacting',
  // What a command the CLI ran without the model printed (`/context`,
  // `/usage`; payload: `output`, `command` without its slash). `adapterNote:
  // true` marks a line the adapter wrote about the command instead, such as a
  // `/clear` having started a new conversation.
  'command_output',
  // The turn ended (payload: `ConversationTurnCompletedPayload`): the agent's
  // last message as `text`, what the turn spent as `usage`, and `costUsd`,
  // each where the provider can say it.
  'turn_completed',
  'turn_failed',
  // Where a spawned subagent's run stands (running, finished, failed, stopped),
  // keyed by the tool call that spawned it. Session-scoped: a background agent
  // outlives the turn that launched it, so this carries no turnId.
  'subagent_status',
  // Something a spawned agent said between its steps, keyed by the tool call
  // that spawned it. Its own record, not a content_delta: an agent's words
  // belong to its thread, never to the reply of the conversation that spawned
  // it. Session-scoped for the same reason as subagent_status.
  'subagent_message',
  // A model call in the turn failed and the provider will try it again
  // (payload: `ConversationTurnRetryingPayload`). Says why the turn has
  // produced nothing yet; the next event of the same turn supersedes it.
  'turn_retrying',
] as const

export type ConversationEventType = (typeof CONVERSATION_EVENT_TYPES)[number]

/** Whether a value names an event type this version of the protocol defines. */
export function isConversationEventType(value: unknown): value is ConversationEventType {
  return (CONVERSATION_EVENT_TYPES as readonly unknown[]).includes(value)
}

/** One event of a conversation, as it streams and as its transcript replays it. */
export type ConversationEvent = {
  id: string
  /**
   * Order within the conversation's log. Only increases, but not contiguous: a
   * run of text deltas can be merged into one numbered with the run's last
   * sequence. Absent only on events recorded before the desktop stamped one.
   */
  seq?: number
  sessionId: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  type: ConversationEventType
  createdAt: number
  payload?: Record<string, unknown>
}

/**
 * Why the desktop sent a chat a message of its own: an agent the chat started
 * finished or stopped (`agent-notice`), a usage limit that stopped the chat
 * has reset (`usage-resume`), or a pull request the chat's agent asked the
 * desktop to watch needs a look (`pull-request-watch`).
 */
export type ConversationStudioMessageReason = 'agent-notice' | 'usage-resume' | 'pull-request-watch'

/**
 * Who a `user_message` came from when it was not the person: the payload's
 * `origin`. Optional and additive: a message without one is the person's,
 * which is every message recorded before the member existed, and a reader that
 * does not know it shows the message as the person's, as it always did. The
 * agent still receives the message as text; `origin` is for whoever draws or
 * counts the conversation (a Studio notice is not the person writing).
 */
export type ConversationMessageOrigin = { kind: 'studio'; reason?: ConversationStudioMessageReason }

const STUDIO_MESSAGE_REASONS: readonly string[] = [
  'agent-notice',
  'usage-resume',
  'pull-request-watch',
] satisfies ConversationStudioMessageReason[]

/**
 * A `user_message` payload's `origin`, or null for the person's. A `studio`
 * origin with a reason this version does not know is still Studio's; the
 * reason is left out.
 */
export function readConversationMessageOrigin(value: unknown): ConversationMessageOrigin | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const origin = value as { kind?: unknown; reason?: unknown }
  if (origin.kind !== 'studio') return null
  return typeof origin.reason === 'string' && STUDIO_MESSAGE_REASONS.includes(origin.reason)
    ? { kind: 'studio', reason: origin.reason as ConversationStudioMessageReason }
    : { kind: 'studio' }
}

/**
 * Payload carried on `turn_retrying`. `error` is the provider's category for
 * the failure when it names one (`authentication_failed`, `rate_limit`,
 * `overloaded`, `server_error`, …); `status` is the HTTP status, absent when
 * the request got no response at all.
 */
export type ConversationTurnRetryingPayload = {
  turnId?: string
  /** The attempt about to run, counting from 1 for the first retry. */
  attempt: number
  maxAttempts: number
  /** How long the provider waits before that attempt. */
  retryInMs: number
  error?: string
  status?: number
}

/**
 * What one turn spent, in tokens, summed over every model request the turn
 * made (tool rounds included). `inputTokens` counts only the input the model
 * read fresh: the prompt cache's share is `cacheReadTokens`, and what the turn
 * wrote into the cache is `cacheWriteTokens`, so the four add up to everything
 * the turn sent and received. A member a provider cannot report is absent,
 * never zero: an ACP agent reports only what its own protocol carries.
 */
export type ConversationTurnUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/**
 * Payload carried on `turn_completed`. Every member but `turnId` is optional
 * and additive: a provider fills in what it can say, and a reader skips what is
 * absent.
 *
 * - `text`: the agent's last message of the turn, as the person reads it at
 *   the end of the turn (not the narration between its tool calls). Absent
 *   when the turn ended without one.
 * - `usage`: what the turn spent (`ConversationTurnUsage`).
 * - `costUsd`: what the turn cost, where the provider prices it.
 */
export type ConversationTurnCompletedPayload = {
  turnId?: string
  text?: string
  usage?: ConversationTurnUsage
  costUsd?: number
  durationMs?: number
}

/**
 * Payload carried on `tool_started`. `parentToolUseId` is what makes subagent
 * work visible: a provider that runs tools inside a spawned agent stamps the
 * child calls with the id of the tool call that spawned them, so consumers can
 * group them under that parent instead of flattening them into the turn.
 * Absent means an ordinary top-level tool call.
 */
export type ConversationToolStartedPayload = {
  toolUseId?: string
  kind?: ConversationToolKind
  name?: string
  input?: ConversationJsonValue
  inputTruncated?: boolean
  turnId?: string
  toolCallId?: string
  tool: string
  summary?: string
  addedLines?: number
  removedLines?: number
  parentToolUseId?: string
  /**
   * Set on the tool call that spawns a subagent. It heads a lane whose rows
   * are the tool calls carrying its `toolCallId` as their `parentToolUseId`;
   * its own `tool_output` closes the lane, so the lane's elapsed time is the
   * span between the two events. A background agent's call returns at once;
   * its lane stays open on `subagent_status` until the agent itself finishes.
   */
  subagentLane?: boolean
  /**
   * The kind of subagent the model asked for ('Explore', 'general-purpose', a
   * custom agent id), when the call names one. Lane label; absent means the
   * consumer falls back to `summary`.
   */
  subagentType?: string
  /**
   * An MCP tool's title as its server gives it (`tool.annotations.title`, or
   * a readable form of the wire name), and the server's own display name,
   * where the provider reports them (Claude Code does, for each call). Plain
   * text, at most 120 characters each; a reader without them makes the wire
   * name readable instead.
   */
  displayTitle?: string
  serverName?: string
}

/** Payload carried on `tool_output`. `parentToolUseId` mirrors `tool_started`. */
export type ConversationToolOutputPayload = {
  /**
   * How an adapter's `output` relates to the tool's earlier output events.
   * 'replace' (the default): it is the whole output so far. 'append': only the
   * text produced since the previous event. Events the desktop publishes are
   * always 'replace' and carry no `outputMode`.
   */
  outputMode?: 'append' | 'replace'
  partial?: boolean
  clipped?: boolean
  toolUseId?: string
  preview?: string
  totalBytes?: number
  truncated?: boolean
  status?: ConversationToolStatus
  exitCode?: number
  mime?: string
  turnId?: string
  toolCallId?: string
  output: string
  isError: boolean
  parentToolUseId?: string
  /**
   * The result of a background subagent, delivered when the agent finishes,
   * usually after the turn that launched it has ended. It closes the lane
   * wherever it started and needs no turn.
   */
  backgroundResult?: boolean
  /**
   * On a background result: the provider's id for the agent. An agent resumed
   * after the process that knew its lane ended reports under the call that
   * resumed it, and this is how a reader finds the lane it started in.
   */
  taskId?: string
  /**
   * The pictures the step returned (a browser screenshot, say), as files on
   * the desktop that ran it, in the order the tool returned them; at most
   * eight. The bytes are not in `output`. Optional and additive: absent, the
   * step returned no picture, or ran on a desktop from before this member.
   * The paths name files on that desktop, so a reader on another device can
   * say a step has pictures but cannot open them.
   */
  images?: string[]
}

export type ConversationSubagentState = 'running' | 'completed' | 'failed' | 'stopped'

/** Payload carried on `subagent_message`: one finished block of an agent's own text. */
export type ConversationSubagentMessagePayload = {
  /** The spawning tool call: the lane this belongs to. */
  parentToolUseId: string
  text: string
  /** The text was longer than a transcript event keeps; this is its beginning. */
  truncated?: boolean
}

/**
 * Payload carried on `subagent_status`: the latest known state of one spawned
 * agent. Each event repeats what it knows; a field it leaves out keeps the
 * value an earlier event reported.
 */
export type ConversationSubagentStatusPayload = {
  /** The spawning tool call: the lane this status belongs to. */
  toolUseId: string
  taskId?: string
  status: ConversationSubagentState
  /** Launched in the background: the agent runs on after the turn that launched it. */
  background?: boolean
  subagentType?: string
  description?: string
  /** The tool the agent called most recently. */
  lastToolName?: string
  /** A short present-tense line about what the agent is doing, when the provider generates one. */
  progressSummary?: string
  usage?: { totalTokens: number; toolUses: number; durationMs: number }
  /** Why a failed or stopped agent ended, when known. */
  error?: string
  endedAt?: number
  /**
   * The agent started again after it ended (Claude Code's SendMessage to an
   * agent that finished, or whose process ended): its lane reopens. A plain
   * `running` never reopens an ended lane, since a late progress report can
   * arrive after the end.
   */
  resumed?: boolean
}

/**
 * What a piece of background work is. A `command` is a shell left running
 * (a dev server, a watcher): the agent is done with it and may leave it for
 * hours. A `monitor` reports to the agent as it goes and wakes it when it has
 * something to say. A `task` is any other kind the provider names, a workflow
 * or a backgrounded MCP call, which wakes the agent when it ends.
 */
export type ConversationBackgroundTaskKind = 'command' | 'monitor' | 'task'

/**
 * One piece of background work the session's process still runs after the
 * turn that started it ended. Agents are not here: they have lanes of their
 * own (`subagent_status`).
 */
export type ConversationBackgroundTask = {
  /** The provider's id for the task, what Stop names. */
  taskId: string
  kind: ConversationBackgroundTaskKind
  description?: string
  /** A monitor with no deadline: it watches until it is stopped or the process ends. */
  persistent?: boolean
}

/**
 * What an `approval_requested` event asks for. Each kind has its own answer:
 * a `tool` permission is resolved with an approval decision, a `question`
 * with its answers, a `plan` with approve or reject.
 */
export type ConversationApprovalKind = 'tool' | 'question' | 'plan'

export type ConversationQuestionOption = {
  label: string
  description?: string
}

export type ConversationQuestion = {
  question: string
  header?: string
  multiSelect?: boolean
  allowFreeText?: boolean
  options: ConversationQuestionOption[]
}

/**
 * Payload carried on `approval_requested`: the members every provider sets,
 * and the ones each kind adds. A provider may add others; a client reads what
 * it knows. An absent `kind` is a `tool` permission.
 */
export type ConversationApprovalRequestedPayload = {
  requestId: string
  turnId?: string
  kind?: ConversationApprovalKind
  /** The tool the request is about, as the provider names it. */
  action?: string
  toolKind?: ConversationToolKind
  summary?: string
  /** Present on a `question`. */
  questions?: ConversationQuestion[]
  /** Present on a `plan`: the plan the agent proposes. */
  plan?: string
}

/** Payload carried on `approval_resolved`: how a request was answered. */
export type ConversationApprovalResolvedPayload = {
  requestId: string
  turnId?: string
  approved: boolean
  /** A question's answers, question text to the chosen answer. */
  answers?: Record<string, string>
}

/**
 * A window of a conversation's log. Merged runs of deltas appear as one event
 * numbered with the run's last sequence; `beforeCursor` is the first sequence
 * the page covers, to page back from with `loadEarlier`.
 */
export type ConversationPage = { events: ConversationEvent[]; hasMore: boolean; beforeCursor: number | null }

/**
 * What following one conversation delivers, in order: a `snapshot` (or, for a
 * cursor the desktop can vouch for, nothing), the events after it, then one
 * `synchronized` fence naming the sequence and log generation the follower is
 * now current to; live events after that. A `snapshot` with `reset: true`
 * replaces whatever the follower held. Keep the fence's `seq` and
 * `generation`: they are the cursor a later follow resumes from.
 */
export type ConversationStreamFrame =
  | { type: 'event'; event: ConversationEvent }
  | { type: 'snapshot'; page: ConversationPage; reset?: true; generation?: string }
  | { type: 'synchronized'; seq: number; generation?: string }
  | { type: 'error'; message: string }

/** Where a follower stands in a conversation's log: the last sequence it holds, and that log's generation. */
export type ConversationCursor = { afterSeq: number; generation: string }
