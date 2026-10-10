// The person's own agent activity as modules read it: token usage across every
// agent session on this machine (permission `usage:read`, served by
// main/usage/usage-service.ts) and their Studio chats and prompts (permission
// `conversation:read-all`, served by main/module-host/module-activity.ts).
// The SDK mirrors these shapes by hand and the drift guard pins the two
// together. Type-only.

import type { ModuleConversationStatus } from './conversation-service'

// ── Usage ────────────────────────────────────────────────────────────────────

export type UsageGroupBy = 'day' | 'model' | 'workspace' | 'session' | 'provider'

export type UsageQuery = {
  from: number
  to: number
  groupBy?: UsageGroupBy[]
}

export type UsageTokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

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

export type UsageSource = {
  id: 'studio' | 'claude-code' | 'codex' | 'opencode' | 'gemini' | 'grok'
  found: number
  error: string | null
}

export type ModuleUsageErrorCode = 'permission_missing' | 'invalid_input' | 'unavailable'

export type ModuleUsageResult<T extends object = object> =
  ({ ok: true } & T) | { ok: false; code: ModuleUsageErrorCode; message: string }

export type UsageQueryResult = ModuleUsageResult<{
  rows: UsageRow[]
  scannedAt: number | null
  sources: UsageSource[]
}>

export type ModuleUsageService = {
  query(query: UsageQuery): Promise<UsageQueryResult>
  onChanged(listener: () => void): () => void
}

export type ModuleUsageRegistry = {
  [K in keyof ModuleUsageService]: (
    moduleId: string,
    ...args: Parameters<ModuleUsageService[K]>
  ) => ReturnType<ModuleUsageService[K]>
}

// ── Activity ─────────────────────────────────────────────────────────────────

export type ActivityChatSummary = {
  workspaceId: string
  agentId: string
  title: string
  cli: string
  providerId: string
  model: string
  createdAt: number
  updatedAt: number
  turnCount: number
  status: ModuleConversationStatus | 'absent'
}

export type ActivityListChatsInput = {
  from?: number
  to?: number
  workspaceId?: string
}

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
  limit?: number
}

export type ModuleActivityErrorCode = 'permission_missing' | 'invalid_input' | 'unavailable'

export type ModuleActivityResult<T extends object = object> =
  ({ ok: true } & T) | { ok: false; code: ModuleActivityErrorCode; message: string }

export type ModuleActivityService = {
  listChats(input?: ActivityListChatsInput): Promise<ModuleActivityResult<{ chats: ActivityChatSummary[] }>>
  prompts(input: ActivityPromptsInput): Promise<ModuleActivityResult<{ prompts: ActivityPrompt[]; truncated: boolean }>>
}

export type ModuleActivityRegistry = {
  [K in keyof ModuleActivityService]: (
    moduleId: string,
    ...args: Parameters<ModuleActivityService[K]>
  ) => ReturnType<ModuleActivityService[K]>
}
