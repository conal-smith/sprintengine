import { CONVERSATION_MAX_MESSAGE_CHARS } from './index.js'

// Reads that ask the chat's agent, not its transcript: a side question about
// the chat, and what fills its context window. Each is behind a capability of
// its own (handshake.ts), sent only on a socket that follows the chat, and
// answered by a `result` under its `requestId`. A desktop without the
// capability answers the frame `ok: false` with `invalid_frame`, which is the
// fallback each is shaped for: a client sends one only where it is advertised.

// ── Side questions ──────────────────────────────────────────────────────────
//
// A question about the chat so far, as the desktop composer's /btw asks one:
// answered from what the chat's agent knows, and added to nothing. Neither the
// question nor its answer reaches the transcript, the agent's context or the
// chat's history, and a turn the chat is running goes on as it was.

/** One question asked before in the same aside, and its answer. */
export type ConversationSideQuestionExchange = { question: string; answer: string }

/** The most earlier exchanges a question may lean on. A client keeps the newest that fit. */
export const CONVERSATION_MAX_SIDE_QUESTION_HISTORY = 20

/**
 * Ask a side question of the chat this socket follows
 * (`conversation-side-questions`). `questionId` is the client's own, so the
 * question can be called off while it is answered; `history` is the
 * questions asked before it in the same aside, oldest first, so a follow-up
 * can lean on them, at most `CONVERSATION_MAX_SIDE_QUESTION_HISTORY` and,
 * with the question, at most `CONVERSATION_MAX_MESSAGE_CHARS` characters.
 * Answered by a `result` whose `data` is a `ConversationSideQuestionAnswer`;
 * one called off, or one the agent could not answer, is refused in words. It
 * runs the chat's agent, so it needs `conversation:operate`, and a chat at
 * rest is resumed for it, as a send resumes one. Refused for a chat whose
 * provider cannot (the listed chat's `capabilities.sideQuestion`).
 */
export type ConversationAskSideQuestionRequest = {
  type: 'askSideQuestion'
  requestId: string
  questionId: string
  question: string
  history?: ConversationSideQuestionExchange[]
}

/** Call off a side question still being answered, by its `questionId`. Answered at once; the question is refused. */
export type ConversationCancelSideQuestionRequest = {
  type: 'cancelSideQuestion'
  requestId: string
  questionId: string
}

/** A side question's answer, as a `result`'s `data` carries it. */
export type ConversationSideQuestionAnswer = { answer: string }

// ── The context window ──────────────────────────────────────────────────────

/**
 * Read what fills the context window of the chat this socket follows
 * (`conversation-context-breakdown`), as its agent measures it. Answered by a
 * `result` whose `data` is a `ConversationContextBreakdownAnswer`. Refused in
 * words for a chat with no live session, which has no agent to ask until a
 * message starts one: a read never starts a session. Needs only
 * `conversation:read`.
 */
export type ConversationContextBreakdownRequest = { type: 'getContextBreakdown'; requestId: string }

/**
 * One row of the breakdown. `used` fills the window, `free` is what is left of
 * it, `buffer` is held back for compaction, and `deferred` is listed for
 * awareness but not in the window (tool schemas loaded on demand). A client
 * draws a kind it does not know as `used`.
 */
export type ConversationWireContextCategory = { name: string; tokens: number; kind: string }

/** A skill, memory file or custom agent and what it costs; `detail` is where it comes from. */
export type ConversationWireContextItem = { name: string; tokens: number; detail?: string }

/** An MCP server, the tokens its loaded tools' schemas take, and each tool. */
export type ConversationWireContextMcpServer = {
  name: string
  tokens: number
  tools: Array<{ name: string; tokens: number; loaded: boolean }>
}

export type ConversationWireContextBreakdown = {
  model: string
  usedTokens: number
  /** The window the agent measures against: the model's, or a smaller one it compacts at. */
  windowTokens: number
  categories: ConversationWireContextCategory[]
  mcpServers: ConversationWireContextMcpServer[]
  skills: ConversationWireContextItem[]
  memoryFiles: ConversationWireContextItem[]
  agents: ConversationWireContextItem[]
  /** Where the agent compacts on its own; null when it does not. */
  autoCompactAt: number | null
  /** The agent estimated the rows rather than counting each one. */
  estimated: boolean
  measuredAt: number
}

/** `stale`: the agent is not running now, and this is the last reading it gave. */
export type ConversationContextBreakdownAnswer = { breakdown: ConversationWireContextBreakdown; stale?: true }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1_000
}

/** A side question frame read as the contract says, or null. Unknown members are dropped. */
export function parseConversationSideQuestionRequest(
  value: Record<string, unknown>,
): ConversationAskSideQuestionRequest | ConversationCancelSideQuestionRequest | null {
  if (!id(value.requestId) || !id(value.questionId)) return null
  if (value.type === 'cancelSideQuestion')
    return { type: 'cancelSideQuestion', requestId: value.requestId, questionId: value.questionId }
  if (value.type !== 'askSideQuestion') return null
  const { question, history } = value
  if (typeof question !== 'string' || !question.trim()) return null
  if (history !== undefined && !(Array.isArray(history) && history.length <= CONVERSATION_MAX_SIDE_QUESTION_HISTORY))
    return null
  const exchanges: ConversationSideQuestionExchange[] = []
  for (const exchange of history ?? []) {
    if (!record(exchange) || typeof exchange.question !== 'string' || typeof exchange.answer !== 'string') return null
    exchanges.push({ question: exchange.question, answer: exchange.answer })
  }
  const chars = exchanges.reduce((sum, exchange) => sum + exchange.question.length + exchange.answer.length, 0)
  if (question.length + chars > CONVERSATION_MAX_MESSAGE_CHARS) return null
  return {
    type: 'askSideQuestion',
    requestId: value.requestId,
    questionId: value.questionId,
    question,
    ...(exchanges.length ? { history: exchanges } : {}),
  }
}

/** A side question's answer off a `result`'s `data`, or null when it is not one. */
export function parseConversationSideQuestionAnswer(value: unknown): ConversationSideQuestionAnswer | null {
  return record(value) && typeof value.answer === 'string' ? { answer: value.answer } : null
}

function items(value: unknown): ConversationWireContextItem[] | null {
  if (!Array.isArray(value)) return null
  const read: ConversationWireContextItem[] = []
  for (const entry of value) {
    if (!record(entry) || !text(entry.name) || !count(entry.tokens)) return null
    read.push({
      name: entry.name,
      tokens: entry.tokens,
      ...(text(entry.detail) ? { detail: entry.detail } : {}),
    })
  }
  return read
}

/**
 * A breakdown off a `result`'s `data`, or null when it is not one. A row whose
 * shape is wrong spoils the reading, since its totals would not add up; a
 * member this version does not know is dropped.
 */
export function parseConversationContextBreakdownAnswer(value: unknown): ConversationContextBreakdownAnswer | null {
  if (!record(value) || !record(value.breakdown)) return null
  const breakdown = value.breakdown
  if (
    !text(breakdown.model) ||
    !count(breakdown.usedTokens) ||
    !count(breakdown.windowTokens) ||
    !count(breakdown.measuredAt) ||
    typeof breakdown.estimated !== 'boolean' ||
    !(breakdown.autoCompactAt === null || count(breakdown.autoCompactAt)) ||
    !Array.isArray(breakdown.categories) ||
    !Array.isArray(breakdown.mcpServers)
  )
    return null
  const categories: ConversationWireContextCategory[] = []
  for (const entry of breakdown.categories) {
    if (!record(entry) || !text(entry.name) || !count(entry.tokens) || !text(entry.kind)) return null
    categories.push({ name: entry.name, tokens: entry.tokens, kind: entry.kind })
  }
  const mcpServers: ConversationWireContextMcpServer[] = []
  for (const entry of breakdown.mcpServers) {
    if (!record(entry) || !text(entry.name) || !count(entry.tokens) || !Array.isArray(entry.tools)) return null
    const tools: ConversationWireContextMcpServer['tools'] = []
    for (const tool of entry.tools) {
      if (!record(tool) || !text(tool.name) || !count(tool.tokens) || typeof tool.loaded !== 'boolean') return null
      tools.push({ name: tool.name, tokens: tool.tokens, loaded: tool.loaded })
    }
    mcpServers.push({ name: entry.name, tokens: entry.tokens, tools })
  }
  const skills = items(breakdown.skills ?? [])
  const memoryFiles = items(breakdown.memoryFiles ?? [])
  const agents = items(breakdown.agents ?? [])
  if (!skills || !memoryFiles || !agents) return null
  return {
    breakdown: {
      model: breakdown.model,
      usedTokens: breakdown.usedTokens,
      windowTokens: breakdown.windowTokens,
      categories,
      mcpServers,
      skills,
      memoryFiles,
      agents,
      autoCompactAt: breakdown.autoCompactAt as number | null,
      estimated: breakdown.estimated,
      measuredAt: breakdown.measuredAt,
    },
    ...(value.stale === true ? { stale: true as const } : {}),
  }
}
