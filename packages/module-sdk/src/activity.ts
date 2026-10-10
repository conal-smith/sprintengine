// The person's own agent activity, read-only: token usage across every agent
// session on this machine (`usage:read`), and the chats and prompts of their
// Studio chats (`conversation:read-all`). Both are broad reads the person
// consents to at install; neither lets a module change anything.

import type { ModuleConversationStatus } from './conversation.js'
import type { MainHost, ServiceToken } from './index.js'

// ── Usage (permission `usage:read`) ──────────────────────────────────────────

/** A dimension rows are summed over. With none, the query answers one total row (no row when nothing was used). */
export type UsageGroupBy = 'day' | 'model' | 'workspace' | 'session' | 'provider'

/**
 * A window of time, in epoch ms (`from` inclusive, `to` exclusive). Usage is
 * kept to the hour, so the window is too: an hour counts when it starts inside
 * the window.
 */
export type UsageQuery = {
  from: number
  to: number
  groupBy?: UsageGroupBy[]
}

/**
 * Tokens as the model provider billed them. `input` is the fresh input alone:
 * cache reads and cache writes are counted apart, never inside it.
 */
export type UsageTokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * One summed row. Only the dimensions you grouped by are set.
 *
 * - `day` — the local calendar day on this machine, `YYYY-MM-DD`.
 * - `model` — the model id as the session recorded it.
 * - `providerId` — the chat provider: `claude-agent` (Claude Code), `codex-agent`
 *   (Codex), or another provider a Studio chat ran on.
 * - `workspaceId` — the open Studio workspace the session belongs to (its chat,
 *   or the folder it ran in), null when none matches.
 * - `sessionId` — the agent CLI's session id; for a chat whose CLI keeps no log
 *   this machine reads, the chat's agent id. `agentId` and `chatTitle` are set
 *   when the session ran as a Studio chat.
 *
 * `reportedCostUsd` is the cost the agent runtime itself reported for these
 * turns, when it reported one; null otherwise. The service returns tokens, not
 * prices: pricing them is your module's job.
 */
export type UsageRow = {
  day?: string
  model?: string
  providerId?: string
  workspaceId?: string | null
  sessionId?: string
  agentId?: string
  chatTitle?: string | null
  tokens: UsageTokens
  requests: number
  reportedCostUsd: number | null
}

/** One place usage is read from, and whether it could be. */
export type UsageSource = {
  id: 'studio' | 'claude-code' | 'codex' | 'opencode' | 'gemini' | 'grok'
  /** Session logs (or transcripts) found there. */
  found: number
  error: string | null
}

export type ModuleUsageErrorCode = 'permission_missing' | 'invalid_input' | 'unavailable'

export type ModuleUsageResult<T extends object = object> =
  ({ ok: true } & T) | { ok: false; code: ModuleUsageErrorCode; message: string }

export type UsageQueryResult = ModuleUsageResult<{
  rows: UsageRow[]
  /** When the logs were last read (epoch ms); null before the first read finished. */
  scannedAt: number | null
  sources: UsageSource[]
}>

/**
 * Token usage of every agent session on this machine, obtained via
 * `getUsageService(host)`: Studio's own chats, and the Claude Code and Codex
 * sessions a person ran in a terminal. A session a Studio chat ran is counted
 * once, under that chat. Logs are read off the main thread, incrementally, and
 * never at startup: the first `query` waits for the first read, later ones
 * answer at once and read again in the background. Declare `usage:read`.
 */
export type ModuleUsageService = {
  query(query: UsageQuery): Promise<UsageQueryResult>
  /** Called after a read that changed the numbers. Returns the unsubscriber; call it in `onShutdown`. */
  onChanged(listener: () => void): () => void
}

type ModuleUsageRegistry = {
  [K in keyof ModuleUsageService]: (
    moduleId: string,
    ...args: Parameters<ModuleUsageService[K]>
  ) => ReturnType<ModuleUsageService[K]>
}

const usageModuleServiceToken: ServiceToken<ModuleUsageRegistry> = { key: 'usage.module-service' }

/**
 * The scoped usage service for `host`'s module. `host.supports('usage')` says
 * whether this host has it; declare `dependsOn: ['agent-runtime']`.
 */
export function getUsageService(host: MainHost): ModuleUsageService {
  const registry = host.requireService(usageModuleServiceToken)
  const moduleId = host.moduleId
  return {
    query: (query) => registry.query(moduleId, query),
    onChanged: (listener) => registry.onChanged(moduleId, listener),
  }
}

// ── Activity (permission `conversation:read-all`) ────────────────────────────

/** A Studio chat, summarised. Never its tool output. */
export type ActivityChatSummary = {
  workspaceId: string
  agentId: string
  title: string
  /** The agent runtime the chat runs on (`claude-code`, `codex`, …). */
  cli: string
  providerId: string
  model: string
  createdAt: number
  updatedAt: number
  turnCount: number
  status: ModuleConversationStatus | 'absent'
}

export type ActivityListChatsInput = {
  /** Only chats active at or after this instant (epoch ms). */
  from?: number
  /** Only chats started before this instant (epoch ms). */
  to?: number
  workspaceId?: string
}

/**
 * One message the person sent in a chat, with the end of the agent's reply to
 * it (`replyTail`, its last few hundred characters) when it has one. Text is
 * redacted the way the app redacts its own transcripts.
 */
export type ActivityPrompt = {
  at: number
  workspaceId: string
  agentId: string
  text: string
  replyTail?: string
}

export type ActivityPromptsInput = {
  from: number
  to: number
  workspaceId?: string
  /** At most this many, newest kept. Default 200, at most 1000. */
  limit?: number
}

export type ModuleActivityErrorCode = 'permission_missing' | 'invalid_input' | 'unavailable'

export type ModuleActivityResult<T extends object = object> =
  ({ ok: true } & T) | { ok: false; code: ModuleActivityErrorCode; message: string }

/**
 * The person's Studio chats in every open workspace, read-only, obtained via
 * `getActivityService(host)`. What it returns is summaries and the person's
 * own prompts with the tail of each reply — never tool calls, tool output,
 * attachments or anything secret-shaped. Chats in closed workspaces and agent
 * sessions outside Studio are not covered. Declare `conversation:read-all`:
 * the consent prompt flags it as a broad scope.
 */
export type ModuleActivityService = {
  listChats(input?: ActivityListChatsInput): Promise<ModuleActivityResult<{ chats: ActivityChatSummary[] }>>
  prompts(input: ActivityPromptsInput): Promise<ModuleActivityResult<{ prompts: ActivityPrompt[]; truncated: boolean }>>
}

type ModuleActivityRegistry = {
  [K in keyof ModuleActivityService]: (
    moduleId: string,
    ...args: Parameters<ModuleActivityService[K]>
  ) => ReturnType<ModuleActivityService[K]>
}

const activityModuleServiceToken: ServiceToken<ModuleActivityRegistry> = { key: 'activity.module-service' }

/**
 * The scoped activity service for `host`'s module. `host.supports('activity')`
 * says whether this host has it; declare `dependsOn: ['agent-runtime']`.
 */
export function getActivityService(host: MainHost): ModuleActivityService {
  const registry = host.requireService(activityModuleServiceToken)
  const moduleId = host.moduleId
  return {
    listChats: (input) => registry.listChats(moduleId, input),
    prompts: (input) => registry.prompts(moduleId, input),
  }
}
