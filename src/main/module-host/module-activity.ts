// The person's Studio chats for capability modules (SDK `getActivityService`,
// permission `conversation:read-all`): a summary of every chat in the open
// workspaces, and the messages the person sent with the end of each reply.
//
// Read-only, and narrow on purpose. It reads the transcripts the chat view
// reads, through the runtime's own reader, and hands back only three things
// out of them: what the person typed, the tail of the agent's reply text, and
// the chat's counts. Tool calls, tool output, attachments, reasoning and
// approvals never leave, and every event is redacted the way the conversation
// service redacts what it hands modules before anything is read off it.
// Chats a module started are the person's too and are included; chats in a
// closed workspace are not reachable here.

import { conversationWorkingRoot, type AgentState } from '../../shared/agent-state'
import { cliForConversationProvider } from '../../shared/conversation-harness'
import type { ConversationThreadsResult } from '../../shared/conversation-index'
import {
  readConversationMessageOrigin,
  type ConversationEvent,
  type ConversationListSessionsInput,
  type ConversationListSessionsResult,
  type ConversationTranscriptInput,
  type ConversationTranscriptResult,
} from '../../shared/conversation-runtime'
import type {
  ActivityChatSummary,
  ActivityPrompt,
  ModuleActivityErrorCode,
  ModuleActivityRegistry,
} from '../../shared/modules/activity-service'
import { redactEvent } from '../companion-agent-service'
import { quotesToPlainText } from '../../shared/chat-quotes'

export type ModuleActivityWorkspace = {
  id: string
  folderPath?: string | null
  agents: Record<string, AgentState | undefined>
}

/** The slice of the conversation runtime the service reads through. */
export type ModuleActivityRuntime = {
  listThreads(input: { workspaceRoot: string; workspaceId: string }): Promise<ConversationThreadsResult>
  listSessions(input?: ConversationListSessionsInput): ConversationListSessionsResult
  readTranscript(
    input: ConversationTranscriptInput,
    options?: { all?: boolean; closeOpenTurns?: boolean },
  ): Promise<ConversationTranscriptResult>
}

export type ModuleActivityDeps = {
  /** Open workspaces with their agent records, read fresh on each call. */
  getWorkspaces: () => readonly ModuleActivityWorkspace[]
  runtime: ModuleActivityRuntime
  getModulePermissions: (moduleId: string) => readonly string[] | undefined
}

type Failure = { ok: false; code: ModuleActivityErrorCode; message: string }

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000
const MAX_PROMPT_CHARS = 8000
const REPLY_TAIL_CHARS = 400

type Chat = {
  workspaceId: string
  agent: AgentState
  root: string
  summary: ActivityChatSummary
}

const failure = (code: ModuleActivityErrorCode, message: string): Failure => ({ ok: false, code, message })

export function createModuleActivityRegistry(deps: ModuleActivityDeps): ModuleActivityRegistry {
  function denied(moduleId: string): Failure | null {
    if (deps.getModulePermissions(moduleId)?.includes('conversation:read-all')) return null
    return failure(
      'permission_missing',
      `Module "${moduleId}" does not declare the "conversation:read-all" permission, so it cannot read your chats.`,
    )
  }

  function liveStatus(workspaceId: string, agentId: string): { status: ActivityChatSummary['status']; model?: string } {
    const listed = deps.runtime.listSessions({ workspaceId, agentId })
    if (!listed.ok) return { status: 'absent' }
    const live = listed.sessions
      .filter((session) => session.status !== 'stopped')
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    return live ? { status: live.status, model: live.modelId } : { status: 'absent' }
  }

  // Every chat with a transcript, read through the runtime's thread index (a
  // cache it keeps per workspace folder, re-reading only transcripts that
  // changed), joined with the chat's record and its live session.
  async function chats(workspaceId?: string): Promise<Chat[]> {
    const found: Chat[] = []
    for (const workspace of deps.getWorkspaces()) {
      if (workspaceId !== undefined && workspace.id !== workspaceId) continue
      const byRoot = new Map<string, AgentState[]>()
      for (const agent of Object.values(workspace.agents)) {
        if (!agent || agent.runtimeKind !== 'conversation') continue
        const root = conversationWorkingRoot(agent, workspace.folderPath)
        if (!root) continue
        byRoot.set(root, [...(byRoot.get(root) ?? []), agent])
      }
      for (const [root, agents] of byRoot) {
        const listed = await deps.runtime.listThreads({ workspaceRoot: root, workspaceId: workspace.id })
        if (!listed.ok) continue
        const threads = new Map(listed.threads.map((thread) => [thread.agentId, thread]))
        for (const agent of agents) {
          const thread = threads.get(agent.id)
          if (!thread) continue
          const live = liveStatus(workspace.id, agent.id)
          const providerId = agent.conversation?.providerId ?? thread.providerId
          found.push({
            workspaceId: workspace.id,
            agent,
            root,
            summary: {
              workspaceId: workspace.id,
              agentId: agent.id,
              title: thread.title || agent.name,
              cli: cliForConversationProvider(providerId) ?? providerId,
              providerId,
              model: live.model ?? agent.conversation?.modelId ?? thread.model,
              createdAt: thread.createdAt,
              updatedAt: thread.updatedAt,
              turnCount: thread.turnCount,
              status: live.status,
            },
          })
        }
      }
    }
    return found
  }

  return {
    async listChats(moduleId, input) {
      const refused = denied(moduleId)
      if (refused) return refused
      const invalid = invalidWindow(input?.from, input?.to, false) ?? invalidWorkspace(input?.workspaceId)
      if (invalid) return failure('invalid_input', invalid)
      try {
        const listed = (await chats(input?.workspaceId))
          .map((chat) => chat.summary)
          .filter(
            (chat) =>
              (input?.from === undefined || chat.updatedAt >= input.from) &&
              (input?.to === undefined || chat.createdAt < input.to),
          )
          .sort((a, b) => b.updatedAt - a.updatedAt)
        return { ok: true, chats: listed }
      } catch (error) {
        return failure('unavailable', error instanceof Error ? error.message : String(error))
      }
    },

    async prompts(moduleId, input) {
      const refused = denied(moduleId)
      if (refused) return refused
      const invalid =
        invalidWindow(input?.from, input?.to, true) ??
        invalidWorkspace(input?.workspaceId) ??
        invalidLimit(input?.limit)
      if (invalid) return failure('invalid_input', invalid)
      const limit = input.limit ?? DEFAULT_LIMIT
      try {
        const prompts: ActivityPrompt[] = []
        for (const chat of await chats(input.workspaceId)) {
          // A chat idle before the window, or started after it, has nothing in it.
          if (chat.summary.updatedAt < input.from || chat.summary.createdAt >= input.to) continue
          const transcript = await deps.runtime.readTranscript(
            { workspaceRoot: chat.root, workspaceId: chat.workspaceId, agentId: chat.agent.id },
            { all: true, closeOpenTurns: false },
          )
          if (!transcript.ok) continue
          prompts.push(...promptsOf(transcript.events.map(redactEvent), chat, input.from, input.to))
        }
        prompts.sort((a, b) => a.at - b.at)
        const truncated = prompts.length > limit
        return { ok: true, prompts: truncated ? prompts.slice(-limit) : prompts, truncated }
      } catch (error) {
        return failure('unavailable', error instanceof Error ? error.message : String(error))
      }
    },
  }
}

/**
 * The person's messages in [from, to), each with the tail of the agent's reply
 * text in the same turn: the turn's final text when the runtime recorded it on
 * `turn_completed`, else its text deltas joined. A message the app sent on the
 * person's behalf (a notice, a resume) carries an origin and is not theirs.
 */
export function promptsOf(
  events: readonly ConversationEvent[],
  chat: Pick<Chat, 'workspaceId'> & { agent: Pick<AgentState, 'id'> },
  from: number,
  to: number,
): ActivityPrompt[] {
  type Open = { prompt: ActivityPrompt; turnId: string | null; reply: string; final: string | null }
  const found: Open[] = []
  let current: Open | null = null
  for (const event of events) {
    const payload = event.payload ?? {}
    const turnId = typeof payload.turnId === 'string' ? payload.turnId : null
    if (event.type === 'user_message') {
      if (readConversationMessageOrigin(payload.origin)) continue
      // An extension reads the person's words: a quote as its passage and comment.
      const text = typeof payload.text === 'string' ? quotesToPlainText(payload.text).trim() : ''
      current = null
      if (!text || event.createdAt < from || event.createdAt >= to) continue
      current = {
        prompt: {
          at: event.createdAt,
          workspaceId: chat.workspaceId,
          agentId: chat.agent.id,
          text: text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS - 1)}…` : text,
        },
        turnId,
        reply: '',
        final: null,
      }
      found.push(current)
      continue
    }
    if (!current || (current.turnId && turnId && turnId !== current.turnId)) continue
    if (event.type === 'content_delta' && typeof payload.text === 'string') {
      // Only the tail is kept, so a long reply costs no more than a short one.
      current.reply = (current.reply + payload.text).slice(-REPLY_TAIL_CHARS * 4)
    } else if (event.type === 'turn_completed' && typeof payload.text === 'string' && payload.text.trim()) {
      current.final = payload.text
    }
  }
  return found.map(({ prompt, reply, final }) => {
    const tail = tailOf(final ?? reply)
    return tail ? { ...prompt, replyTail: tail } : prompt
  })
}

function tailOf(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= REPLY_TAIL_CHARS) return trimmed
  return `…${trimmed.slice(-(REPLY_TAIL_CHARS - 1)).trimStart()}`
}

function invalidWindow(from: unknown, to: unknown, required: boolean): string | null {
  for (const [name, value] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (value === undefined && !required) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) return `"${name}" must be a time in epoch ms.`
  }
  if (typeof from === 'number' && typeof to === 'number' && to <= from) return '"to" must be after "from".'
  return null
}

function invalidWorkspace(workspaceId: unknown): string | null {
  if (workspaceId === undefined) return null
  return typeof workspaceId === 'string' && workspaceId.trim() ? null : '"workspaceId" must be a workspace id.'
}

function invalidLimit(limit: unknown): string | null {
  if (limit === undefined) return null
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 && limit <= MAX_LIMIT
    ? null
    : `"limit" must be a whole number from 1 to ${MAX_LIMIT}.`
}
