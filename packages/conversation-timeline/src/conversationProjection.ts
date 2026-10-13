// How a conversation's event log becomes the entries the chat renders:
// turns, tool calls, subagent lanes, approvals and questions.

import type { ConversationImageAttachment, ConversationStoredImageAttachment } from './attachments.js'
import type {
  ConversationApprovalKind,
  ConversationBackgroundTask,
  ConversationQuestion,
  ConversationSessionStatus,
  ConversationEvent,
  ConversationJsonValue,
  ConversationToolKind,
  ConversationSubagentStatusPayload,
  ConversationToolStatus,
  ConversationMessageOrigin,
} from './protocol.js'
import { readConversationMessageOrigin } from './protocol.js'
import { parseConversationMentions, type ConversationMentionRef } from './mentions.js'
import { parseConversationAttachedFiles, type ConversationAttachedFile } from './attachedFiles.js'
import { normalizeApiKeySource } from './apiKeySource.js'
import { applyPromptCacheEvent, type PromptCacheReading } from './promptCache.js'
import { isBackgroundLaunchAck, readSubagentStatus } from './subagents.js'
import { readBackgroundTasks } from './backgroundTasks.js'

// ── Pure projection ─────────────────────────────────────────────────────────

// What is known about the agent a lane spawned, beyond its tool calls.
// 'unknown' is a background agent from a transcript recorded before its end
// was reported: it ran, but how it ended was never written down.
export type TranscriptAgentState = {
  state: 'running' | 'completed' | 'failed' | 'stopped' | 'unknown'
  // The provider's id for the agent, which outlives the call that spawned it:
  // a resumed agent is found by it.
  taskId?: string
  background?: boolean
  description?: string
  lastToolName?: string
  progressSummary?: string
  usage?: { totalTokens: number; toolUses: number; durationMs: number }
  error?: string
}

// One tool call in a turn's work timeline. A call the model made to spawn a
// background agent (Task/Agent) is a *lane*: `subagentLane` marks it, and the
// tool calls that ran inside that agent hang off it as `children` instead of
// flattening into the turn. Named separately from the union because the type
// is recursive (an agent can spawn an agent).
export type TranscriptToolEntry = {
  kind: 'tool'
  id: string
  turnId: string
  name: string
  status: 'running' | 'done'
  output?: string
  toolKind?: ConversationToolKind
  input?: ConversationJsonValue
  inputTruncated?: boolean
  truncated?: boolean
  totalBytes?: number
  outputStatus?: ConversationToolStatus
  exitCode?: number
  mime?: string
  // The pictures the step returned (a screenshot), as files on the desktop
  // that ran it: `images` on its `tool_output`. Absent when it returned none.
  images?: string[]
  // One-line input summary from the provider (e.g. "Bash: npm test") —
  // the row reads as "what it did", not just the tool name.
  summary?: string
  startedAt?: number
  completedAt?: number
  // Line-count chips for edit-shaped tools (shipped by the adapter).
  addedLines?: number
  removedLines?: number
  // Set by the provider on the spawning call; true means this row is a lane
  // header whose elapsed time spans the whole subagent run.
  subagentLane?: boolean
  // Which kind of agent was spawned ('Explore', 'general-purpose', a custom
  // agent id) when the call named one; the lane's label.
  subagentType?: string
  // An MCP tool's own title and its server's name, where the provider sent them.
  displayTitle?: string
  serverName?: string
  // The lane this call ran inside, when it is a subagent's own tool call.
  parentToolUseId?: string
  // Tool calls made inside this lane, in the order they started.
  children?: TranscriptToolEntry[]
  // The spawned agent's own state, on a lane the provider reported it for.
  agent?: TranscriptAgentState
  // What the agent said between its steps, in the order it said it.
  messages?: TranscriptAgentMessage[]
}

export type TranscriptAgentMessage = { at: number; text: string; truncated?: boolean }

// Reasoning the model did before a tool call, kept at that point in the turn
// rather than merged into one block: thinking between steps explains the step
// after it. `durationMs` sums the windows in which it streamed.
export type ReasoningSegment = { text: string; beforeToolUseId: string; durationMs?: number }

export type TranscriptEntry =
  | {
      kind: 'user'
      id: string
      createdAt?: number
      seq?: number
      reverted?: boolean
      // The turnSeq that undoes the revert covering this turn; set only on the
      // turns of the most recent revert, the one an undo can still restore.
      undoRevertSeq?: number
      // Files changed after that revert (a later turn, another revert or undo),
      // so undoing it would replace that later work.
      undoOverwritesLaterWork?: boolean
      text: string
      // Images the user attached to this turn, as the local send carried them.
      attachments?: ConversationImageAttachment[]
      // The same images as the transcript remembers them, for a bubble with no
      // live send behind it (replayed after a restart): references into the
      // attachment store, read back when the bubble is drawn.
      storedAttachments?: ConversationStoredImageAttachment[]
      mentions?: ConversationMentionRef[]
      // Files attached by path, by the paths the send carried (attachedFiles.ts).
      files?: ConversationAttachedFile[]
      skills?: string[]
      // Studio sent this message itself (a launched agent's notice, a resume
      // after a usage limit): drawn as Studio's notice, not the person's
      // bubble. Absent for the person's, which every older transcript is.
      origin?: ConversationMessageOrigin
    }
  | {
      kind: 'assistant'
      turnId: string
      text: string
      intermediateText?: { text: string; beforeToolUseId: string }[]
      reasoningSegments?: ReasoningSegment[]
      // Reasoning since the last top-level tool call: the whole turn's when it
      // ran no tools, otherwise the thinking before the final reply.
      reasoning: string
      status: 'streaming' | 'complete' | 'failed' | 'interrupted'
      failureReason?: string
      // Full provider failure message (payload `message`), for the error
      // block's "Show details" disclosure; failureReason is the short code.
      failureDetail?: string
      startedAt?: number
      completedAt?: number
      // Model the turn actually ran on (from the turn's events), for the byline.
      modelId?: string
      // How long `reasoning` streamed: each reasoning_delta run until the next
      // non-reasoning event, summed; feeds "Thought for Ns". Absent while the
      // first run is still open.
      reasoningDurationMs?: number
      // A run of `reasoning` is streaming now. A second stretch of thinking
      // after prose already has a duration from the first, so that alone
      // cannot tell "Thinking" from "Thought for Ns".
      reasoningLive?: boolean
      // The provider's last call failed and it is waiting to try again. Cleared
      // by whatever the turn reports next, so it is only ever the latest word.
      retry?: TurnRetry
      // The provider is summarising the conversation. Cleared by the summary
      // landing or by whatever else the turn reports next.
      compacting?: true
      costUsd?: number
      durationMs?: number
      numTurns?: number
      // Tokens the provider reported for this turn alone.
      inputTokens?: number
      // The share of `inputTokens` the prompt cache served.
      cachedInputTokens?: number
      outputTokens?: number
      // Credential source in force when the turn ended, so a cost is shown only
      // for a turn that billed API usage — replayed history included.
      apiKeySource?: string
      checkpointTurnSeq?: number
      checkpointAvailable?: boolean
      checkpointSummary?: { files: number; addedLines: number; removedLines: number }
      reverted?: boolean
      undoRevertSeq?: number
      undoOverwritesLaterWork?: boolean
    }
  | TranscriptToolEntry
  | {
      kind: 'approval'
      requestId: string
      turnId?: string
      summary: string
      // Tool name behind the request ("Bash", "Edit"…), so the permission card
      // can render the literal command instead of generic copy.
      action?: string
      input?: ConversationJsonValue
      cwd?: string
      originAgentId?: string
      defaultToNo?: boolean
      suppressAlwaysAllowRule?: boolean
      autoApproved?: boolean
      ruleLabel?: string
      status: 'pending' | 'approved' | 'denied' | 'cancelled'
      // Structured request cards: 'question' renders options as buttons,
      // 'plan' renders the plan text with approve/reject. Absent/'tool' is a
      // plain permission row.
      requestKind?: ConversationApprovalKind
      questions?: ConversationQuestion[]
      plan?: string
      // Where the agent keeps that plan, when it keeps one (Claude Code's plan
      // file). Only ever a path on the machine the agent ran on.
      planFilePath?: string
      // Answers chosen when a question card resolved (question → answer), so
      // the resolved card keeps showing what was picked — including on replay.
      answers?: Record<string, string>
    }
  | CompactionEntry
  | CommandOutputEntry

// What a command the CLI ran by itself printed (`/context`, `/usage`), in the
// place its turn's reply would be: such a turn has no reply of its own. A
// note the adapter wrote about a command (`note`) reads as a line, not output.
export type CommandOutputEntry = {
  kind: 'commandOutput'
  id: string
  turnId?: string
  /** The command without its slash, when the CLI named it. */
  command?: string
  output: string
  note?: boolean
  createdAt: number
}

// The provider summarised the conversation to free context. It sits between
// the message of the turn it happened in and that turn's reply, or after the
// last turn when it came between turns.
type CompactionEntry = {
  kind: 'compaction'
  id: string
  turnId?: string
  trigger?: 'manual' | 'auto'
  preTokens?: number
  postTokens?: number
  createdAt: number
}

export type UserTurn = {
  id: string
  text: string
  createdAt?: number
  attachments?: ConversationImageAttachment[]
  mentions?: ConversationMentionRef[]
  files?: ConversationAttachedFile[]
  skills?: string[]
}

/**
 * Token counts the session has reported so far; null until the first report.
 *
 * `inputTokens` / `outputTokens` are the latest exchange's cost as the runtime
 * reported it. `contextWindow` / `contextUsed` are the context window and how
 * much of it the conversation holds now — the latest request's size, never a
 * sum over requests — for a runtime that reports them (Claude Code, Codex and
 * ACP agents do). Absent is "no reading", which is not the same as zero.
 */
export type ConversationUsage = {
  inputTokens: number
  outputTokens: number
  contextWindow?: number
  contextUsed?: number
}

/**
 * The session's usage after one `usage_updated`. An event reports whichever
 * counter moved, so a field it leaves out keeps the value already held rather
 * than resetting it to zero — the window's reading as much as the counts: a
 * runtime that names its window once, at a turn's end, keeps it through the
 * next turn's mid-stream readings.
 */
export function nextConversationUsage(
  previous: ConversationUsage | null,
  payload: Record<string, unknown> | undefined,
): ConversationUsage {
  const base: ConversationUsage = previous ?? { inputTokens: 0, outputTokens: 0 }
  const contextWindow = positiveReading(readNumber(payload, 'contextWindow')) ?? base.contextWindow
  const contextUsed = readNumber(payload, 'contextUsed') ?? base.contextUsed
  return {
    inputTokens: readNumber(payload, 'inputTokens') ?? base.inputTokens,
    outputTokens: readNumber(payload, 'outputTokens') ?? base.outputTokens,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(contextUsed !== undefined && contextUsed >= 0 ? { contextUsed } : {}),
  }
}

// A window of zero tokens is a runtime that did not know its size.
function positiveReading(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined
}

export type ConversationProjection = {
  sessionStatus: ConversationSessionStatus | 'idle'
  activeTurn: boolean
  awaitingApproval: boolean
  entries: TranscriptEntry[]
  usage: ConversationUsage | null
  lastError: string | null
  // The failure's full provider message (payload `message`); lastError is
  // often only its short code ('provider'), which says nothing in a log.
  lastErrorDetail: string | null
  // Credential source the CLI child reported on init ('none' = subscription
  // login, the guaranteed path). Anything else means the session is billing
  // outside the subscription and the chat must say so.
  apiKeySource: string | null
  // A provider's note about the live session the person should know, such as
  // a stored session that could not be reopened and was replaced.
  sessionNotice: string | null
  // The shells and monitors the session's process still runs after its turn
  // ended, as it last reported them: what the agent is waiting on.
  backgroundTasks: ConversationBackgroundTask[]
  // What each kind of agent this session can spawn is for, by type name
  // ('Explore', 'Plan', a custom agent), as the provider described them.
  agentTypes: Record<string, string>
  // The checkpoint the most recent revert still in effect went back to.
  revertedAfterSeq: number | null
  // The conversation's prompt cache, from the provider's per-request reports:
  // the same fold main's runtime makes (applyPromptCacheEvent). Null for a
  // provider that reports none.
  promptCache: PromptCacheReading | null
}

// The image references a `user_message` recorded. Anything malformed is left
// out rather than failing the bubble: a transcript outlives the build that
// wrote it, and one bad entry should cost one thumbnail.
export function parseStoredAttachments(value: unknown): ConversationStoredImageAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined
  const stored = value.flatMap((entry): ConversationStoredImageAttachment[] => {
    if (!entry || typeof entry !== 'object') return []
    const { id, mediaType, name, byteLength, ref } = entry as Record<string, unknown>
    if (typeof id !== 'string' || typeof mediaType !== 'string' || typeof ref !== 'string') return []
    return [
      {
        id,
        mediaType,
        ref,
        byteLength: typeof byteLength === 'number' ? byteLength : 0,
        ...(typeof name === 'string' ? { name } : {}),
      },
    ]
  })
  return stored.length ? stored : undefined
}

export function readString(payload: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!payload) return undefined
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** The most pictures a step's `images` is read for, as the desktop keeps at most. */
export const MAX_TOOL_IMAGES = 8

/** A `tool_output`'s `images`: the paths that are text, at most eight; undefined when there are none. */
export function readImagePaths(payload: Record<string, unknown> | undefined): string[] | undefined {
  const value = payload?.images
  if (!Array.isArray(value)) return undefined
  const paths = value.filter(
    (path): path is string => typeof path === 'string' && path.length > 0 && path.length <= 4096,
  )
  return paths.length ? paths.slice(0, MAX_TOOL_IMAGES) : undefined
}

export function readNumber(payload: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = payload?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function readApprovalKind(payload: Record<string, unknown> | undefined): ConversationApprovalKind {
  const value = payload?.kind
  return value === 'question' || value === 'plan' ? value : 'tool'
}

export function readQuestions(payload: Record<string, unknown> | undefined): ConversationQuestion[] | undefined {
  const raw = payload?.questions
  if (!Array.isArray(raw)) return undefined
  const questions: ConversationQuestion[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (typeof record.question !== 'string' || !record.question.trim()) continue
    const options = Array.isArray(record.options)
      ? record.options
          .map((option) => {
            if (!option || typeof option !== 'object' || Array.isArray(option)) return null
            const optionRecord = option as Record<string, unknown>
            if (typeof optionRecord.label !== 'string' || !optionRecord.label.trim()) return null
            return {
              label: optionRecord.label,
              ...(typeof optionRecord.description === 'string' ? { description: optionRecord.description } : {}),
            }
          })
          .filter((option): option is { label: string; description?: string } => option !== null)
      : []
    questions.push({
      question: record.question,
      ...(typeof record.header === 'string' ? { header: record.header } : {}),
      multiSelect: record.multiSelect === true,
      allowFreeText: record.allowFreeText !== false,
      options,
    })
  }
  return questions.length > 0 ? questions : undefined
}

export function readBoolean(payload: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = payload?.[key]
  return typeof value === 'boolean' ? value : undefined
}

function readCheckpointSummary(
  payload: Record<string, unknown> | undefined,
): { files: number; addedLines: number; removedLines: number } | undefined {
  const summary = payload?.checkpointSummary
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return undefined
  const values = summary as Record<string, unknown>
  if (
    typeof values.files !== 'number' ||
    typeof values.addedLines !== 'number' ||
    typeof values.removedLines !== 'number'
  )
    return undefined
  return { files: values.files, addedLines: values.addedLines, removedLines: values.removedLines }
}

// A plan request names the agent's plan file on its payload; one recorded
// before it did still carries the path inside the tool input Claude Code sent.
function readPlanFilePath(payload: Record<string, unknown> | undefined): string | undefined {
  const named = readString(payload, 'planFilePath')
  if (named) return named
  const input = payload?.input
  return input && typeof input === 'object' && !Array.isArray(input)
    ? readString(input as Record<string, unknown>, 'planFilePath')
    : undefined
}

// A payload's JSON value as it came. Payloads arrive structured-cloned (IPC) or
// parsed (a paired machine), are never written to, and keep their identity from
// fold to fold, which is what lets an unchanged entry be recognised without
// comparing a file's worth of Edit input.
function readJson(payload: Record<string, unknown> | undefined, key: string): ConversationJsonValue | undefined {
  const value = payload?.[key]
  return value === undefined ? undefined : (value as ConversationJsonValue)
}

function inferToolKind(name: string): ConversationToolKind {
  if (/^(Bash|Shell|Command)$/iu.test(name)) return 'command'
  if (/^(Edit|MultiEdit|NotebookEdit)$/iu.test(name)) return 'file_edit'
  if (/^(Read|Get-Content)$/iu.test(name)) return 'file_read'
  if (/^(Write|Set-Content)$/iu.test(name)) return 'file_write'
  if (/^(Grep|Glob|Search)$/iu.test(name)) return 'search'
  if (/^(Task|Agent)$/iu.test(name)) return 'subagent'
  if (name.startsWith('Web')) return 'web'
  return 'other'
}

function readToolKind(payload: Record<string, unknown> | undefined, name: string): ConversationToolKind {
  const kind = payload?.kind
  if (
    kind === 'command' ||
    kind === 'file_edit' ||
    kind === 'file_read' ||
    kind === 'file_write' ||
    kind === 'search' ||
    kind === 'list' ||
    kind === 'web' ||
    kind === 'mcp' ||
    kind === 'subagent' ||
    kind === 'todo' ||
    kind === 'other'
  )
    return kind
  return inferToolKind(name)
}

function readToolStatus(payload: Record<string, unknown> | undefined): ConversationToolStatus | undefined {
  const status = payload?.status
  return status === 'ok' || status === 'error' || status === 'declined' || status === 'stopped' ? status : undefined
}

export function readAnswers(payload: Record<string, unknown> | undefined): Record<string, string> | undefined {
  const raw = payload?.answers
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const answers: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') answers[key] = value
  }
  return Object.keys(answers).length > 0 ? answers : undefined
}

// A new stretch of thinking joins the text of the one before it as its own
// paragraph: the provider streams each thinking block's words with nothing
// between blocks, so two runs would otherwise read as one run-on sentence.
export function openReasoningRun(previous: string, delta: string): string {
  return previous.trim() ? `${previous.trimEnd()}\n\n${delta.trimStart()}` : previous + delta
}

/** A `turn_retrying` notice, as the transcript keeps it. */
export type TurnRetry = {
  attempt: number
  maxAttempts: number
  retryInMs: number
  error?: string
  status?: number
  at: number
}

export type TurnAccumulator = {
  turnId: string
  text: string
  intermediateText?: { text: string; beforeToolUseId: string }[]
  reasoningSegments?: ReasoningSegment[]
  reasoning: string
  status: 'streaming' | 'complete' | 'failed' | 'interrupted'
  failureReason?: string
  failureDetail?: string
  startedAt?: number
  completedAt?: number
  modelId?: string
  // The reasoning run streaming now, and the closed runs of `reasoning` summed.
  reasoningOpenedAt?: number
  reasoningMs?: number
  retry?: TurnRetry
  compacting?: true
  costUsd?: number
  durationMs?: number
  numTurns?: number
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  apiKeySource?: string
  checkpointTurnSeq?: number
  checkpointAvailable?: boolean
  checkpointSummary?: { files: number; addedLines: number; removedLines: number }
  seq?: number
  // Every tool call of the turn keyed by call id, subagent children included;
  // nesting into lanes happens once, when the transcript entries are built.
  tools: Map<string, ToolAccumulator>
  approvals: string[]
}

export type ToolAccumulator = {
  id: string
  // The turn this call was reported on — not necessarily its lane's turn.
  turnId: string
  name: string
  status: 'running' | 'done'
  output?: string
  toolKind?: ConversationToolKind
  input?: ConversationJsonValue
  inputTruncated?: boolean
  truncated?: boolean
  totalBytes?: number
  outputStatus?: ConversationToolStatus
  exitCode?: number
  mime?: string
  images?: string[]
  summary?: string
  startedAt?: number
  completedAt?: number
  addedLines?: number
  removedLines?: number
  subagentLane?: boolean
  subagentType?: string
  displayTitle?: string
  serverName?: string
  parentToolUseId?: string
  agent?: TranscriptAgentState
  messages?: TranscriptAgentMessage[]
}

export const SESSION_STATUS_BY_EVENT: Partial<Record<ConversationEvent['type'], ConversationSessionStatus>> = {
  session_started: 'starting',
  session_ready: 'ready',
  session_closed: 'stopped',
}

// Optimistic bubble for a send whose `user_message` event has not arrived yet.
export function userEntryFromLocalTurn(userTurn: UserTurn): Extract<TranscriptEntry, { kind: 'user' }> {
  return {
    kind: 'user',
    id: userTurn.id,
    text: userTurn.text,
    ...(userTurn.createdAt !== undefined ? { createdAt: userTurn.createdAt } : {}),
    ...(userTurn.attachments?.length ? { attachments: userTurn.attachments } : {}),
    ...(userTurn.mentions?.length ? { mentions: userTurn.mentions } : {}),
    ...(userTurn.files?.length ? { files: userTurn.files } : {}),
    ...(userTurn.skills?.length ? { skills: userTurn.skills } : {}),
  }
}

export function projectConversation(
  events: readonly ConversationEvent[],
  userTurns: UserTurn[] = [],
): ConversationProjection {
  const turns = new Map<string, TurnAccumulator>()
  const turnOrder: string[] = []
  // User bubbles recorded in the event stream itself (persisted transcript);
  // when present these are authoritative and the locally tracked userTurns
  // only fill the optimistic gap between a send and its first event.
  const eventUserTurns = new Map<
    string,
    UserTurn & {
      seq?: number
      localTurnId?: string
      storedAttachments?: ConversationStoredImageAttachment[]
      origin?: ConversationMessageOrigin
    }
  >()
  const representedLocalTurnIds = new Set<string>()
  // The persisted `user_message` event names its images by store reference,
  // not by their bytes. While the local send that produced a bubble is still
  // here its in-memory images are used, so a live bubble never waits on a
  // read; after a restart the bubble reads the references back instead.
  const localAttachments = new Map<string, ConversationImageAttachment[]>()
  for (const userTurn of userTurns) {
    if (userTurn.attachments?.length) localAttachments.set(userTurn.id, userTurn.attachments)
  }
  const approvals = new Map<string, Omit<Extract<TranscriptEntry, { kind: 'approval' }>, 'kind'>>()
  const approvalOrder: string[] = []
  // Every tool call of the session by call id. A subagent that finishes after
  // its turn's result reports over the continuation channel, so its calls (and
  // the lane's own closing output) carry a *different* turnId than the `Task`
  // call that spawned them — lookups must not be scoped to one turn.
  const toolsById = new Map<string, ToolAccumulator>()
  // Agent states reported before their lane's call arrived (paging can split
  // them), applied when it does.
  const pendingAgents = new Map<string, TranscriptAgentState>()
  // The lane each agent started in, by task: a resumed agent goes on in it.
  const lanesByTask = new Map<string, string>()
  const pendingMessages = new Map<string, TranscriptAgentMessage[]>()
  let sessionStatus: ConversationSessionStatus | 'idle' = 'idle'
  let usage: ConversationUsage | null = null
  let lastError: string | null = null
  let lastErrorDetail: string | null = null
  let apiKeySource: string | null = null
  let sessionNotice: string | null = null
  let backgroundTasks: ConversationBackgroundTask[] = []
  const agentTypes: Record<string, string> = {}
  let promptCache: PromptCacheReading | null = null
  // Reverts still in effect, oldest first. Each covers the turns from its
  // checkpoint up to the revert itself: a turn sent after a revert started from
  // the reverted files and is not undone by it. An undo removes its revert.
  const reverts: Array<{ afterSeq: number; beforeSeq: number }> = []
  // The last event that could have changed files: a turn sent, a revert, an undo.
  let lastFileChangeSeq = 0
  let highestSeq = 0
  // Compactions by the turn they happened in, and those between turns by the
  // turn they followed ('' before the first).
  const compactionsInTurn = new Map<string, CompactionEntry[]>()
  const compactionsAfterTurn = new Map<string, CompactionEntry[]>()
  // Command output by the turn that printed it; one with no turn follows the
  // last turn, as a compaction between turns does.
  const commandOutputsInTurn = new Map<string, CommandOutputEntry[]>()
  // "Edit from here": each rewind takes the turns from its message up to the
  // rewind itself out of view. The log keeps them; the provider dropped them.
  const rewinds: Array<{ fromSeq: number; beforeSeq: number }> = []
  // Where each turn begins in the log, which is what a rewind's range covers.
  const turnStartSeq = new Map<string, number>()

  const ensureTurn = (turnId: string): TurnAccumulator => {
    let turn = turns.get(turnId)
    if (!turn) {
      turn = { turnId, text: '', reasoning: '', status: 'streaming', tools: new Map(), approvals: [] }
      turns.set(turnId, turn)
      turnOrder.push(turnId)
    }
    return turn
  }

  // The runtime/mock provider emits an interrupt as `turn_failed` with no
  // turnId, so resolve it against the latest turn still streaming.
  const latestActiveTurnId = (): string | undefined => {
    for (let i = turnOrder.length - 1; i >= 0; i -= 1) {
      const id = turnOrder[i]
      if (turns.get(id)?.status === 'streaming') return id
    }
    return undefined
  }

  // A reasoning run closes at the next non-reasoning signal of the turn; the
  // model can think again later, and that run adds to the same segment until a
  // tool call starts a new one.
  const closeReasoning = (turn: TurnAccumulator, at: number): void => {
    if (turn.reasoningOpenedAt === undefined) return
    turn.reasoningMs = (turn.reasoningMs ?? 0) + Math.max(0, at - turn.reasoningOpenedAt)
    turn.reasoningOpenedAt = undefined
  }

  for (const event of events) {
    const sessionMapped = SESSION_STATUS_BY_EVENT[event.type]
    if (sessionMapped) sessionStatus = sessionMapped
    if (event.seq !== undefined && event.seq > highestSeq) highestSeq = event.seq
    const turnId = readString(event.payload, 'turnId')
    if (turnId && event.seq !== undefined && !turnStartSeq.has(turnId)) turnStartSeq.set(turnId, event.seq)
    promptCache = applyPromptCacheEvent(promptCache, event)
    // A retry notice says why the turn has nothing to show yet. Anything else
    // the turn reports means the call went through, or the turn ended.
    if (turnId && event.type !== 'turn_retrying') {
      const turn = turns.get(turnId)
      if (turn?.retry) turn.retry = undefined
    }
    // So does a compaction notice, but a usage report can land mid-summary.
    if (turnId && event.type !== 'context_compacting' && event.type !== 'usage_updated') {
      const turn = turns.get(turnId)
      if (turn?.compacting) turn.compacting = undefined
    }
    switch (event.type) {
      case 'context_compacting': {
        if (turnId) ensureTurn(turnId).compacting = true
        break
      }
      case 'turn_retrying': {
        const attempt = readNumber(event.payload, 'attempt')
        const maxAttempts = readNumber(event.payload, 'maxAttempts')
        if (!turnId || attempt === undefined || maxAttempts === undefined) break
        const status = readNumber(event.payload, 'status')
        const error = readString(event.payload, 'error')
        ensureTurn(turnId).retry = {
          attempt,
          maxAttempts,
          retryInMs: readNumber(event.payload, 'retryInMs') ?? 0,
          ...(error ? { error } : {}),
          ...(status !== undefined ? { status } : {}),
          at: event.createdAt,
        }
        break
      }
      case 'session_started': {
        // Each session binds credentials afresh; a previous session's reported
        // source must not carry over (a replayed transcript would otherwise
        // false-alarm the API-key banner after a restart).
        apiKeySource = null
        sessionNotice = null
        // A new session's process runs nothing yet.
        backgroundTasks = []
        break
      }
      case 'session_updated': {
        // Transcripts written before the field was kept unredacted carry
        // `[redacted]` here, which says nothing about the session's billing.
        const source = normalizeApiKeySource(readString(event.payload, 'apiKeySource'))
        if (source) apiKeySource = source
        const notice = readString(event.payload, 'notice')
        if (notice) sessionNotice = notice
        backgroundTasks = readBackgroundTasks(event.payload) ?? backgroundTasks
        if (Array.isArray(event.payload?.agents))
          for (const agent of event.payload.agents) {
            const name = readString(agent as Record<string, unknown>, 'name')
            const description = readString(agent as Record<string, unknown>, 'description')
            if (name && description) agentTypes[name] = description
          }
        const rewoundFrom = readNumber(event.payload, 'rewoundFromSeq')
        if (rewoundFrom !== undefined) {
          rewinds.push({ fromSeq: rewoundFrom, beforeSeq: event.seq ?? highestSeq + 1 })
          // A failure is only ever the latest turn's, and that turn is gone.
          lastError = null
        }
        const reverted = readNumber(event.payload, 'revertedAfterSeq')
        if (reverted !== undefined) {
          lastFileChangeSeq = event.seq ?? highestSeq + 1
          if (event.payload?.undo === true) {
            const undone = reverts.findLastIndex((range) => range.afterSeq === reverted)
            if (undone !== -1) reverts.splice(undone, 1)
          } else {
            // A revert event read without a seq still bounds what came before it.
            reverts.push({ afterSeq: reverted, beforeSeq: event.seq ?? highestSeq + 1 })
          }
        }
        break
      }
      case 'user_message': {
        if (event.seq !== undefined) lastFileChangeSeq = event.seq
        if (turnId) {
          ensureTurn(turnId)
          const localTurnId = readString(event.payload, 'localTurnId')
          const origin = readConversationMessageOrigin(event.payload?.origin)
          eventUserTurns.set(turnId, {
            // The acknowledgement replaces an optimistic bubble in place. The
            // local identity is persisted too, so remounts keep the same key.
            id: localTurnId ?? event.id,
            text: readString(event.payload, 'text') ?? '',
            createdAt: event.createdAt,
            ...(event.seq !== undefined ? { seq: event.seq } : {}),
            ...(localTurnId ? { localTurnId } : {}),
            storedAttachments: parseStoredAttachments(event.payload?.attachments),
            mentions: parseConversationMentions(event.payload?.mentions) ?? undefined,
            files: parseConversationAttachedFiles(event.payload?.files) ?? undefined,
            skills: Array.isArray(event.payload?.skills)
              ? event.payload.skills.filter((id): id is string => typeof id === 'string')
              : undefined,
            ...(origin ? { origin } : {}),
          })
          ensureTurn(turnId).seq = event.seq
          if (localTurnId) representedLocalTurnIds.add(localTurnId)
        }
        break
      }
      case 'turn_started': {
        if (turnId) {
          const turn = ensureTurn(turnId)
          turn.status = 'streaming'
          turn.startedAt = turn.startedAt ?? event.createdAt
          if (event.modelId) turn.modelId = event.modelId
        }
        break
      }
      case 'content_delta': {
        if (turnId) {
          const turn = ensureTurn(turnId)
          closeReasoning(turn, event.createdAt)
          turn.text += readString(event.payload, 'text', 'delta') ?? ''
        }
        break
      }
      case 'reasoning_delta': {
        if (turnId) {
          const turn = ensureTurn(turnId)
          const delta = readString(event.payload, 'text', 'delta') ?? ''
          if (turn.reasoningOpenedAt === undefined) {
            turn.reasoningOpenedAt = event.createdAt
            turn.reasoning = openReasoningRun(turn.reasoning, delta)
          } else turn.reasoning += delta
        }
        break
      }
      case 'tool_started': {
        // A background agent's step after the turn that launched it ended
        // carries no turn: it joins the agent's lane, in the turn that holds it.
        const parentToolUseId = readString(event.payload, 'parentToolUseId')
        const ownerTurnId = turnId ?? (parentToolUseId ? toolsById.get(parentToolUseId)?.turnId : undefined)
        if (!ownerTurnId) break
        const turn = ensureTurn(ownerTurnId)
        closeReasoning(turn, event.createdAt)
        const id =
          readString(event.payload, 'toolUseId', 'callId', 'id', 'toolCallId') ?? `${ownerTurnId}:${turn.tools.size}`
        const name = readString(event.payload, 'name', 'toolName', 'tool') ?? 'tool'
        // Prose before a tool explains that work, rather than ending the turn.
        // Updates to an existing call must not shift the explanation again.
        if (!turn.tools.has(id) && !parentToolUseId && turn.text) {
          turn.intermediateText ??= []
          turn.intermediateText.push({ text: turn.text, beforeToolUseId: id })
          turn.text = ''
        }
        // Thinking before a tool stays at that point in the turn, like prose.
        if (!turn.tools.has(id) && !parentToolUseId && turn.reasoning) {
          turn.reasoningSegments ??= []
          turn.reasoningSegments.push({
            text: turn.reasoning,
            beforeToolUseId: id,
            ...(turn.reasoningMs !== undefined ? { durationMs: turn.reasoningMs } : {}),
          })
          turn.reasoning = ''
          turn.reasoningMs = undefined
        }
        const tool: ToolAccumulator = {
          id,
          turnId: ownerTurnId,
          name,
          toolKind: readToolKind(event.payload, name),
          input: readJson(event.payload, 'input'),
          inputTruncated: readBoolean(event.payload, 'inputTruncated'),
          status: 'running',
          summary: readString(event.payload, 'summary'),
          // A call reported again (its input filled in on completion) keeps
          // the moment it began.
          startedAt: turn.tools.get(id)?.startedAt ?? event.createdAt,
          addedLines: readNumber(event.payload, 'addedLines'),
          removedLines: readNumber(event.payload, 'removedLines'),
          subagentLane: readBoolean(event.payload, 'subagentLane'),
          subagentType: readString(event.payload, 'subagentType'),
          displayTitle: readString(event.payload, 'displayTitle') ?? turn.tools.get(id)?.displayTitle,
          serverName: readString(event.payload, 'serverName') ?? turn.tools.get(id)?.serverName,
          parentToolUseId,
        }
        const pendingMessage = pendingMessages.get(id)
        if (pendingMessage) {
          pendingMessages.delete(id)
          tool.messages = pendingMessage
        }
        const pendingAgent = pendingAgents.get(id)
        if (pendingAgent) {
          pendingAgents.delete(id)
          applyAgentState(tool, pendingAgent, event.createdAt)
        }
        turn.tools.set(id, tool)
        toolsById.set(id, tool)
        break
      }
      case 'tool_output': {
        // A background agent's answer goes to the lane its task started in,
        // as its statuses do (`lanesByTask`).
        const resultTaskId = backgroundResultTaskId(event.payload)
        const id =
          (resultTaskId && lanesByTask.get(resultTaskId)) ||
          readString(event.payload, 'toolUseId', 'callId', 'id', 'toolCallId')
        // A background agent's result carries no turn: it closes its lane by id.
        if (!turnId && !id) break
        const turn = turnId ? ensureTurn(turnId) : undefined
        // A call id closes that exact call wherever it started — a lane opened
        // in an earlier turn closes on the continuation turn that carries its
        // result. Without an id, fall back inside the event's own turn and
        // lane: a subagent's output must never land on the parent's row. An id
        // whose call is not loaded (an earlier page) only matches a call that
        // was never given one, never some other call of this turn.
        const parentToolUseId = readString(event.payload, 'parentToolUseId')
        const unnamed = (tool: ToolAccumulator) => !id || tool.id.startsWith(`${tool.turnId}:`)
        const existing =
          (id && toolsById.get(id)) ||
          [...(turn?.tools.values() ?? [])]
            .filter((tool) => tool.parentToolUseId === parentToolUseId && unnamed(tool))
            .at(-1)
        const output = readString(event.payload, 'preview', 'output', 'text')
        if (existing?.subagentLane && isBackgroundLaunchAck(output)) {
          // The launch notice of a background agent is for the model. The lane
          // stays open for the agent's own report; a transcript that never
          // recorded one (older versions) can only say it ran in the background.
          existing.agent = { ...existing.agent, state: existing.agent?.state ?? 'unknown', background: true }
          if (existing.agent.state === 'unknown') {
            existing.status = 'done'
            existing.completedAt = event.createdAt
          }
          break
        }
        if (existing) {
          if (event.payload?.partial !== true) {
            existing.status = 'done'
            existing.completedAt = event.createdAt
          }
          existing.output = output ?? existing.output
          existing.truncated = readBoolean(event.payload, 'truncated') ?? existing.truncated
          existing.totalBytes = readNumber(event.payload, 'totalBytes') ?? existing.totalBytes
          existing.outputStatus = readToolStatus(event.payload) ?? existing.outputStatus
          existing.exitCode = readNumber(event.payload, 'exitCode') ?? existing.exitCode
          existing.mime = readString(event.payload, 'mime') ?? existing.mime
          existing.images = readImagePaths(event.payload) ?? existing.images
        }
        break
      }
      case 'subagent_status': {
        const status = readSubagentStatus(event.payload)
        if (!status) break
        const lane = status.taskId ? lanesByTask.get(status.taskId) : undefined
        if (status.taskId && !lane) lanesByTask.set(status.taskId, status.toolUseId)
        const toolUseId = lane ?? status.toolUseId
        const agent = agentStateOf(status)
        const tool = toolsById.get(toolUseId)
        if (tool) {
          if (isResumed(status, lane)) reopenAgentLane(tool)
          applyAgentState(tool, agent, status.endedAt ?? event.createdAt)
        } else pendingAgents.set(toolUseId, { ...pendingAgents.get(toolUseId), ...agent })
        break
      }
      case 'subagent_message': {
        const parentToolUseId = readString(event.payload, 'parentToolUseId')
        const text = readString(event.payload, 'text')
        if (!parentToolUseId || !text) break
        const message: TranscriptAgentMessage = {
          at: event.createdAt,
          text,
          ...(event.payload?.truncated === true ? { truncated: true } : {}),
        }
        const lane = toolsById.get(parentToolUseId)
        if (lane) (lane.messages ??= []).push(message)
        else pendingMessages.set(parentToolUseId, [...(pendingMessages.get(parentToolUseId) ?? []), message])
        break
      }
      case 'approval_requested': {
        const requestId = readString(event.payload, 'requestId')
        if (!requestId) break
        const requestKind = readApprovalKind(event.payload)
        approvals.set(requestId, {
          requestId,
          turnId,
          summary: readString(event.payload, 'summary', 'action') ?? 'Approval requested.',
          action: readString(event.payload, 'action'),
          input: readJson(event.payload, 'input'),
          cwd: readString(event.payload, 'cwd'),
          originAgentId: readString(event.payload, 'originAgentId'),
          defaultToNo: readBoolean(event.payload, 'defaultToNo'),
          suppressAlwaysAllowRule: readBoolean(event.payload, 'suppressAlwaysAllowRule'),
          status: 'pending',
          requestKind,
          questions: requestKind === 'question' ? readQuestions(event.payload) : undefined,
          plan: requestKind === 'plan' ? (readString(event.payload, 'plan') ?? '') : undefined,
          planFilePath: requestKind === 'plan' ? readPlanFilePath(event.payload) : undefined,
        })
        approvalOrder.push(requestId)
        if (turnId) ensureTurn(turnId).approvals.push(requestId)
        break
      }
      case 'approval_resolved': {
        const requestId = readString(event.payload, 'requestId')
        const approval = requestId ? approvals.get(requestId) : undefined
        if (approval) {
          const approved = event.payload?.approved === true
          approval.status = approved ? 'approved' : 'denied'
          approval.answers = readAnswers(event.payload)
          approval.autoApproved = readBoolean(event.payload, 'autoApproved')
          approval.ruleLabel = readString(event.payload, 'ruleLabel')
        }
        break
      }
      case 'usage_updated': {
        usage = nextConversationUsage(usage, event.payload)
        // A report stamped with its turn is that turn's own count.
        if (turnId) {
          const turn = ensureTurn(turnId)
          turn.inputTokens = readNumber(event.payload, 'inputTokens') ?? turn.inputTokens
          turn.cachedInputTokens = readNumber(event.payload, 'cachedInputTokens') ?? turn.cachedInputTokens
          turn.outputTokens = readNumber(event.payload, 'outputTokens') ?? turn.outputTokens
        }
        break
      }
      case 'context_compacted': {
        const trigger = event.payload?.trigger
        const compaction: CompactionEntry = {
          kind: 'compaction',
          id: event.id,
          createdAt: event.createdAt,
          ...(turnId ? { turnId } : {}),
          ...(trigger === 'manual' || trigger === 'auto' ? { trigger } : {}),
          ...(readNumber(event.payload, 'preTokens') !== undefined
            ? { preTokens: readNumber(event.payload, 'preTokens') }
            : {}),
          ...(readNumber(event.payload, 'postTokens') !== undefined
            ? { postTokens: readNumber(event.payload, 'postTokens') }
            : {}),
        }
        // A compaction gives context back. The window holds what the summary
        // left where the runtime says how much that is, and is unread until
        // the next request otherwise — the size from before is no longer true.
        // Widened on purpose: the fold assigns `usage` in other cases of this
        // switch, which narrowing at this point does not see.
        const held = usage as ConversationUsage | null
        if (held && held.contextUsed !== undefined) {
          const postTokens = readNumber(event.payload, 'postTokens')
          usage = {
            inputTokens: held.inputTokens,
            outputTokens: held.outputTokens,
            ...(held.contextWindow !== undefined ? { contextWindow: held.contextWindow } : {}),
            ...(postTokens !== undefined ? { contextUsed: postTokens } : {}),
          }
        }
        if (turnId) {
          ensureTurn(turnId)
          const list = compactionsInTurn.get(turnId) ?? []
          compactionsInTurn.set(turnId, [...list, compaction])
        } else {
          const after = turnOrder.at(-1) ?? ''
          compactionsAfterTurn.set(after, [...(compactionsAfterTurn.get(after) ?? []), compaction])
        }
        break
      }
      case 'command_output': {
        const output = readString(event.payload, 'output')
        if (!output) break
        const command = readString(event.payload, 'command')
        const entry: CommandOutputEntry = {
          kind: 'commandOutput',
          id: event.id,
          createdAt: event.createdAt,
          output,
          ...(turnId ? { turnId } : {}),
          ...(command ? { command } : {}),
          ...(readBoolean(event.payload, 'adapterNote') ? { note: true } : {}),
        }
        const key = turnId ?? ''
        if (turnId) ensureTurn(turnId)
        commandOutputsInTurn.set(key, [...(commandOutputsInTurn.get(key) ?? []), entry])
        break
      }
      case 'turn_completed': {
        if (turnId) {
          const turn = ensureTurn(turnId)
          closeReasoning(turn, event.createdAt)
          turn.status = 'complete'
          turn.completedAt = event.createdAt
          turn.costUsd = readNumber(event.payload, 'costUsd') ?? turn.costUsd
          turn.durationMs = readNumber(event.payload, 'durationMs') ?? turn.durationMs
          turn.numTurns = readNumber(event.payload, 'numTurns') ?? turn.numTurns
          if (apiKeySource) turn.apiKeySource = apiKeySource
          turn.checkpointTurnSeq = readNumber(event.payload, 'checkpointTurnSeq') ?? turn.checkpointTurnSeq
          turn.checkpointAvailable = readBoolean(event.payload, 'checkpointAvailable') ?? turn.checkpointAvailable
          turn.checkpointSummary = readCheckpointSummary(event.payload) ?? turn.checkpointSummary
        }
        break
      }
      case 'turn_failed': {
        const reason = readString(event.payload, 'reason', 'message')
        const interrupted = reason === 'interrupted'
        // Interrupts (and any failure event) can arrive without a turnId; apply
        // them to the latest streaming turn so Stop actually ends the active
        // turn instead of leaving the projection stuck in a responding state.
        const targetTurnId = turnId ?? latestActiveTurnId()
        if (targetTurnId) {
          const turn = ensureTurn(targetTurnId)
          closeReasoning(turn, event.createdAt)
          turn.status = interrupted ? 'interrupted' : 'failed'
          turn.retry = undefined
          turn.compacting = undefined
          turn.failureReason = reason
          turn.failureDetail = readString(event.payload, 'message') ?? turn.failureDetail
          turn.completedAt = event.createdAt
          turn.checkpointTurnSeq = readNumber(event.payload, 'checkpointTurnSeq') ?? turn.checkpointTurnSeq
          turn.checkpointAvailable = readBoolean(event.payload, 'checkpointAvailable') ?? turn.checkpointAvailable
          turn.checkpointSummary = readCheckpointSummary(event.payload) ?? turn.checkpointSummary
          // A call the provider never closed before the turn ended is not still
          // running; left open its row would pulse forever.
          for (const tool of turn.tools.values()) {
            if (tool.status !== 'running') continue
            // A background agent outlives the turn that launched it.
            if (tool.agent?.background && tool.agent.state === 'running') continue
            tool.status = 'done'
            tool.completedAt = event.createdAt
            tool.outputStatus ??= 'stopped'
          }
          // A resolved turn can't keep a pending approval blocking the composer.
          for (const requestId of turn.approvals) {
            const approval = approvals.get(requestId)
            if (approval?.status === 'pending') approval.status = 'cancelled'
          }
        }
        if (!interrupted) {
          lastError = reason ?? 'The turn failed.'
          lastErrorDetail = readString(event.payload, 'message') ?? null
        }
        break
      }
      default:
        break
    }
  }

  const activeTurn = turnOrder.some((id) => turns.get(id)?.status === 'streaming')
  const awaitingApproval = approvalOrder.some((id) => approvals.get(id)?.status === 'pending')

  // Interleave: each user turn precedes the assistant turn it triggered. When
  // the event stream carries `user_message` events (persisted transcripts),
  // those are authoritative and local userTurns only render the optimistic
  // tail (a send whose events have not arrived yet). Legacy streams without
  // user events fall back to index-pairing of local turns, which line up
  // because sends are blocked while a turn is active.
  const entries: TranscriptEntry[] = []
  const laneIndex = buildLaneIndex(
    turnOrder.map((id) => turns.get(id)).filter((turn): turn is TurnAccumulator => turn !== undefined),
    toolsById,
  )
  const useEventUserTurns = eventUserTurns.size > 0
  const blockCount = useEventUserTurns ? turnOrder.length : Math.max(turnOrder.length, userTurns.length)
  entries.push(...(compactionsAfterTurn.get('') ?? []))
  const rewound = (turnId: string | undefined): boolean => {
    const start = turnId === undefined ? undefined : turnStartSeq.get(turnId)
    return start !== undefined && rewinds.some((range) => start >= range.fromSeq && start < range.beforeSeq)
  }
  for (let i = 0; i < blockCount; i += 1) {
    const turnId = turnOrder[i]
    if (rewound(turnId)) continue
    const eventUserTurn = turnId ? eventUserTurns.get(turnId) : undefined
    if (useEventUserTurns) {
      if (eventUserTurn) {
        const attachments = eventUserTurn.localTurnId ? localAttachments.get(eventUserTurn.localTurnId) : undefined
        entries.push({
          kind: 'user',
          id: eventUserTurn.id,
          ...(eventUserTurn.seq !== undefined ? { seq: eventUserTurn.seq } : {}),
          text: eventUserTurn.text,
          createdAt: eventUserTurn.createdAt,
          mentions: eventUserTurn.mentions,
          ...(eventUserTurn.files?.length ? { files: eventUserTurn.files } : {}),
          skills: eventUserTurn.skills,
          ...(eventUserTurn.origin ? { origin: eventUserTurn.origin } : {}),
          ...(attachments
            ? { attachments }
            : eventUserTurn.storedAttachments
              ? { storedAttachments: eventUserTurn.storedAttachments }
              : {}),
        })
      }
    } else {
      const userTurn = userTurns[i]
      if (userTurn) entries.push(userEntryFromLocalTurn(userTurn))
    }
    if (!turnId) continue
    const turn = turns.get(turnId)
    if (!turn) continue
    entries.push(...(compactionsInTurn.get(turnId) ?? []))
    entries.push(...(commandOutputsInTurn.get(turnId) ?? []))
    entries.push({
      kind: 'assistant',
      turnId: turn.turnId,
      text: turn.text,
      intermediateText: turn.intermediateText,
      reasoningSegments: turn.reasoningSegments,
      reasoning: turn.reasoning,
      status: turn.status,
      failureReason: turn.failureReason,
      failureDetail: turn.failureDetail,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      modelId: turn.modelId,
      reasoningDurationMs: turn.reasoningMs,
      reasoningLive: turn.reasoningOpenedAt !== undefined ? true : undefined,
      ...(turn.retry ? { retry: turn.retry } : {}),
      ...(turn.compacting ? { compacting: true as const } : {}),
      costUsd: turn.costUsd,
      durationMs: turn.durationMs,
      numTurns: turn.numTurns,
      inputTokens: turn.inputTokens,
      cachedInputTokens: turn.cachedInputTokens,
      outputTokens: turn.outputTokens,
      apiKeySource: turn.apiKeySource,
      checkpointTurnSeq: turn.checkpointTurnSeq,
      checkpointAvailable: turn.checkpointAvailable,
      checkpointSummary: turn.checkpointSummary,
    })
    for (const tool of nestSubagentLanes(turn, laneIndex)) entries.push(tool)
    for (const requestId of turn.approvals) {
      const approval = approvals.get(requestId)
      if (approval) entries.push({ kind: 'approval', ...approval })
    }
    entries.push(...(compactionsAfterTurn.get(turnId) ?? []))
  }
  entries.push(...(commandOutputsInTurn.get('') ?? []))
  // Optimistic tail: local sends not yet represented by user_message events.
  if (useEventUserTurns) {
    for (const userTurn of userTurns) {
      if (!representedLocalTurnIds.has(userTurn.id)) {
        entries.push(userEntryFromLocalTurn(userTurn))
      }
    }
  }
  // Approvals not attached to a known turn still need to surface.
  for (const requestId of approvalOrder) {
    const approval = approvals.get(requestId)
    if (approval && !approval.turnId) entries.push({ kind: 'approval', ...approval })
  }

  if (reverts.length > 0) {
    const latest = reverts.at(-1)!
    const covering = (seq: number | undefined) =>
      seq === undefined ? undefined : reverts.findLast((range) => seq >= range.afterSeq && seq < range.beforeSeq)
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]
      if (entry.kind !== 'user' && entry.kind !== 'assistant') continue
      const range = covering(
        entry.kind === 'user' ? entry.seq : (entry.checkpointTurnSeq ?? turns.get(entry.turnId)?.seq),
      )
      if (!range) continue
      entries[index] = {
        ...entry,
        reverted: true,
        ...(range === latest
          ? {
              undoRevertSeq: range.afterSeq,
              ...(lastFileChangeSeq > range.beforeSeq ? { undoOverwritesLaterWork: true } : {}),
            }
          : {}),
      }
    }
  }
  return {
    sessionStatus,
    activeTurn,
    awaitingApproval,
    entries,
    usage,
    lastError,
    lastErrorDetail,
    apiKeySource,
    sessionNotice,
    backgroundTasks,
    agentTypes,
    revertedAfterSeq: reverts.at(-1)?.afterSeq ?? null,
    promptCache,
  }
}

// Fold an agent's reported state into its lane. Running only ever updates
// what the agent is doing: a lane closes on its result or a terminal status,
// and a late progress report must not reopen one.
export function agentStateOf(status: NonNullable<ReturnType<typeof readSubagentStatus>>): TranscriptAgentState {
  return {
    state: status.status,
    ...(status.taskId ? { taskId: status.taskId } : {}),
    ...(status.background !== undefined ? { background: status.background } : {}),
    ...(status.description ? { description: status.description } : {}),
    ...(status.lastToolName ? { lastToolName: status.lastToolName } : {}),
    ...(status.progressSummary ? { progressSummary: status.progressSummary } : {}),
    ...(status.usage ? { usage: status.usage } : {}),
    ...(status.error ? { error: status.error } : {}),
  }
}

export function applyAgentState(
  tool: Pick<ToolAccumulator, 'agent' | 'status' | 'completedAt' | 'outputStatus'>,
  agent: TranscriptAgentState,
  at: number,
): void {
  const merged: TranscriptAgentState = { ...tool.agent, ...agent }
  if (agent.state === 'running' && tool.agent && tool.agent.state !== 'running') merged.state = tool.agent.state
  tool.agent = merged
  if (merged.state === 'running') return
  tool.status = 'done'
  tool.completedAt = tool.completedAt ?? at
  if (merged.state === 'failed') tool.outputStatus = 'error'
  else if (merged.state === 'stopped') tool.outputStatus ??= 'stopped'
  else tool.outputStatus ??= 'ok'
}

/** The task a background agent's result names, when the event is one. */
export function backgroundResultTaskId(payload: Record<string, unknown> | undefined): string | undefined {
  if (payload?.backgroundResult !== true) return undefined
  return typeof payload.taskId === 'string' && payload.taskId ? payload.taskId : undefined
}

// Whether a status starts an ended agent again. The provider says so; a
// transcript written before it did names only the call that resumed the agent
// (Claude Code's SendMessage) in place of the lane the agent started in.
export function isResumed(status: ConversationSubagentStatusPayload, lane: string | undefined): boolean {
  if (status.status !== 'running') return false
  return status.resumed === true || (lane !== undefined && lane !== status.toolUseId)
}

// An ended lane whose agent started again: running, with nothing of its end
// left on it. Its output stays until the agent's next answer replaces it.
export function reopenAgentLane(
  tool: Pick<ToolAccumulator, 'agent' | 'status' | 'completedAt' | 'outputStatus'>,
): void {
  if (!tool.agent || tool.agent.state === 'running') return
  const { error: _error, ...agent } = tool.agent
  tool.agent = { ...agent, state: 'running' }
  tool.status = 'running'
  tool.completedAt = undefined
  tool.outputStatus = undefined
}

// Index of which calls hang off which lane, built once per projection over
// every turn: a subagent's calls can land on a later continuation turn than the
// `Task` call that spawned them, and they still belong to that lane.
export type LaneIndex = {
  toolsById: Map<string, ToolAccumulator>
  childrenByParent: Map<string, ToolAccumulator[]>
  // Calls already emitted under a lane, so one never renders twice; also what
  // stops a cyclic parent chain (provider data, so untrusted) from recursing.
  claimed: Set<string>
}

export function buildLaneIndex(turns: TurnAccumulator[], toolsById: Map<string, ToolAccumulator>): LaneIndex {
  const childrenByParent = new Map<string, ToolAccumulator[]>()
  for (const turn of turns) {
    for (const tool of turn.tools.values()) {
      const parentId = tool.parentToolUseId
      if (!parentId || parentId === tool.id || !toolsById.has(parentId)) continue
      const siblings = childrenByParent.get(parentId)
      if (siblings) siblings.push(tool)
      else childrenByParent.set(parentId, [tool])
    }
  }
  return { toolsById, childrenByParent, claimed: new Set() }
}

// Fold one turn's tool map into lane-nested transcript entries: a call whose
// `parentToolUseId` names a known call becomes that call's child instead of a
// sibling row. A child whose parent never arrived stays a top-level row —
// subagent work is never dropped just because its lane header is missing.
export function nestSubagentLanes(turn: TurnAccumulator, index: LaneIndex): TranscriptToolEntry[] {
  const { toolsById, childrenByParent, claimed } = index
  const build = (tool: ToolAccumulator): TranscriptToolEntry => {
    claimed.add(tool.id)
    const children = (childrenByParent.get(tool.id) ?? []).filter((child) => !claimed.has(child.id)).map(build)
    return {
      kind: 'tool',
      id: tool.id,
      turnId: tool.turnId,
      name: tool.name,
      status: tool.status,
      output: tool.output,
      toolKind: tool.toolKind,
      input: tool.input,
      inputTruncated: tool.inputTruncated,
      truncated: tool.truncated,
      totalBytes: tool.totalBytes,
      outputStatus: tool.outputStatus,
      exitCode: tool.exitCode,
      mime: tool.mime,
      ...(tool.images ? { images: tool.images } : {}),
      summary: tool.summary,
      startedAt: tool.startedAt,
      completedAt: tool.completedAt,
      addedLines: tool.addedLines,
      removedLines: tool.removedLines,
      // A call that spawned children is a lane even if the provider did not
      // stamp the flag (older event streams, or a renamed spawn tool).
      ...(tool.subagentLane || children.length > 0 ? { subagentLane: true } : {}),
      ...(tool.subagentType ? { subagentType: tool.subagentType } : {}),
      ...(tool.displayTitle ? { displayTitle: tool.displayTitle } : {}),
      ...(tool.serverName ? { serverName: tool.serverName } : {}),
      ...(tool.parentToolUseId ? { parentToolUseId: tool.parentToolUseId } : {}),
      ...(children.length > 0 ? { children } : {}),
      ...(tool.agent ? { agent: tool.agent } : {}),
      ...(tool.messages?.length ? { messages: tool.messages } : {}),
    }
  }

  const rows: TranscriptToolEntry[] = []
  for (const tool of turn.tools.values()) {
    const parentId = tool.parentToolUseId
    if (parentId && parentId !== tool.id && toolsById.has(parentId)) continue
    if (claimed.has(tool.id)) continue
    rows.push(build(tool))
  }
  return rows
}
