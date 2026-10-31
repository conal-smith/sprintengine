import { randomUUID } from 'node:crypto'

import {
  toolError,
  toolSuccess,
  type McpConnectionContext,
  type McpToolRegistration,
} from '../../shared/modules/mcp-tools'
import type {
  ConversationEvent,
  ConversationKey,
  ConversationPermissionPreset,
  ConversationSessionSummary,
} from '../../shared/conversation-runtime'
import {
  conversationSummaryPhase,
  conversationPhaseWorking,
  type ConversationPhase,
} from '../../shared/conversation/phase'
import type { ConversationCommand } from '../../../packages/conversation-protocol/src/public'
import type { ConversationGatewayCommandResult } from './tailnet/tailnet-conversation-host'
import { launchPermissionCeiling, refuseDrivingLooserChat, type AgentPermissionResolver } from './launch-permission-cap'

// One chat's agent driving another chat on this machine: sending it a message,
// reading what was said in it, waiting on it, and stopping it. The person does
// the same by hand, moving between chats; an agent orchestrating several
// pieces of work needs it without a person in between.
//
// A send goes through the chat's normal send path, the one a paired device's
// send takes (tailnet-conversation-host.ts): it resumes a chat at rest, holds
// a queued message here until the chat's turn ends (so it outlives a restart,
// as a paired machine's queued message does), and takes a steer into the
// running turn where the chat's CLI can, holding it for the turn's end where
// it cannot. A read is the chat as Export chat writes it, the words alone,
// a few turns at a time and inside a size budget, since it lands in the
// caller's context.
//
// An agent may only drive a chat that runs no looser than it does itself
// (owner ruling 2026-09-29, launch-permission-cap.ts): otherwise an agent on
// `manual` could hand any prompt to a chat on `bypass`, which is the same
// escape the cap closes for a launch. Reading and waiting drive nothing, and
// stopping a turn gives the caller nothing it did not have, so only a send is
// held to it. None of these is served to a paired device, which follows and
// drives this machine's chats over its own conversation lane.

/** As much as one message an agent sends may hold; a paired device's send holds no more. */
export const CHAT_SEND_MAX_CHARS = 100_000
/** Turns a read returns by default, and at most. */
export const CHAT_READ_DEFAULT_TURNS = 3
export const CHAT_READ_MAX_TURNS = 20
/** Characters a read returns by default, and at most: it lands in the caller's context. */
export const CHAT_READ_DEFAULT_CHARS = 20_000
export const CHAT_READ_MAX_CHARS = 100_000
/** How long a wait waits by default, and at most. An MCP client may give up on a call before the longest. */
export const CHAT_WAIT_DEFAULT_MS = 45_000
export const CHAT_WAIT_MAX_MS = 600_000
const CHAT_WAIT_POLL_MS = 500
/** How much of the chat's last reply a wait's answer quotes. */
const REPLY_TAIL_CHARS = 2_000

const ID = /^[\w.:-]{1,200}$/
const WAIT_CONDITIONS = ['idle', 'needs_input', 'finished'] as const
type WaitCondition = (typeof WAIT_CONDITIONS)[number]

/** What the tools need of this machine's chats. */
export type ConversationChatControl = {
  /** The chat agents a workspace holds, or null for a workspace this machine does not have. */
  chatAgentsOf(workspaceId: string): string[] | null
  /** The chat's folder-qualified key, or null when it has no folder here. */
  resolveKey(workspaceId: string, agentId: string): ConversationKey | null
  /** The chat's name, as its sidebar row shows it. */
  chatTitle(workspaceId: string): string | undefined
  /** The chat's live (or resting) session, if it has one. */
  session(workspaceId: string, agentId: string): ConversationSessionSummary | undefined
  /** The preset the chat runs on now, or would resume on. */
  permissionOf(key: ConversationKey): ConversationPermissionPreset
  /** Carry out one command as a paired device's would be: resuming, holding, steering. */
  command(
    key: ConversationKey,
    clientId: string,
    commandId: string,
    command: ConversationCommand,
  ): Promise<ConversationGatewayCommandResult>
  /** The newest `turns` turns, or the ones that end just before `before`. */
  readPage(
    key: ConversationKey,
    page: { before?: number; turns: number },
  ): Promise<
    { ok: true; events: ConversationEvent[]; hasMore: boolean; before: number | null } | { ok: false; message: string }
  >
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type ConversationChatToolsDeps = {
  /** The calling agent's own preset, which a chat it drives may not exceed. */
  resolveAgentPermissionPreset: AgentPermissionResolver
  /** Absent where this process has no chats to drive. */
  chats?: ConversationChatControl
}

type Target = { key: ConversationKey; workspaceId: string; agentId: string }

function targetSchema(): Record<string, unknown> {
  return {
    workspaceId: { type: 'string', description: "The chat's workspace id, from workspace.list." },
    agentId: {
      type: 'string',
      description: "Which of the workspace's chat agents; may be left out when the workspace has only one.",
    },
  }
}

function resolveTarget(
  chats: ConversationChatControl,
  args: Record<string, unknown>,
): { ok: true; target: Target } | { ok: false; code: string; message: string } {
  const workspaceId = typeof args.workspaceId === 'string' ? args.workspaceId.trim() : ''
  if (!ID.test(workspaceId)) return { ok: false, code: 'invalid_arguments', message: '"workspaceId" is required.' }
  if (args.agentId !== undefined && (typeof args.agentId !== 'string' || !ID.test(args.agentId.trim())))
    return { ok: false, code: 'invalid_arguments', message: '"agentId" must be an agent id when provided.' }
  const agents = chats.chatAgentsOf(workspaceId)
  if (!agents) return { ok: false, code: 'unknown_workspace', message: `No chat "${workspaceId}" on this machine.` }
  let agentId = typeof args.agentId === 'string' ? args.agentId.trim() : undefined
  if (agentId === undefined) {
    if (agents.length === 0)
      return { ok: false, code: 'unknown_agent', message: `Workspace "${workspaceId}" has no chat agent.` }
    if (agents.length > 1)
      return {
        ok: false,
        code: 'ambiguous',
        message: `Workspace "${workspaceId}" has ${agents.length} chat agents (${agents.join(', ')}); name one as "agentId".`,
      }
    agentId = agents[0]!
  } else if (!agents.includes(agentId)) {
    return { ok: false, code: 'unknown_agent', message: `Workspace "${workspaceId}" has no chat agent "${agentId}".` }
  }
  const key = chats.resolveKey(workspaceId, agentId)
  if (!key) return { ok: false, code: 'unavailable', message: 'The chat has no folder on this machine.' }
  return { ok: true, target: { key, workspaceId, agentId } }
}

/** Whether the call comes from the agent of the chat it names: it cannot wait on or message its own turn. */
function isCallersOwnChat(context: McpConnectionContext | undefined, target: Target): boolean {
  const metadata = context?.metadata
  return (
    metadata?.kind === 'studio-agent' &&
    metadata.agentId === target.agentId &&
    metadata.workspaceId === target.workspaceId
  )
}

/** Who a command is carried out for, so its receipts are kept apart from a paired device's. */
function clientIdOf(context: McpConnectionContext | undefined): string {
  const metadata = context?.metadata
  return metadata?.kind === 'studio-agent' && metadata.agentId
    ? `studio-agent:${metadata.workspaceId ?? ''}:${metadata.agentId}`
    : 'studio-local-gateway'
}

/** A chat's state, as the tools answer with it. */
export function chatStateOf(summary: ConversationSessionSummary | undefined): {
  phase: ConversationPhase | 'at_rest'
  working: boolean
  needsInput: boolean
  lastTurnEndedAt: number | null
} {
  if (!summary || summary.status === 'stopped')
    return { phase: 'at_rest', working: false, needsInput: false, lastTurnEndedAt: summary?.lastTurnEndedAt ?? null }
  const phase = conversationSummaryPhase(summary)
  return {
    phase,
    working: conversationPhaseWorking(phase),
    needsInput: phase === 'waiting_for_approval' || phase === 'waiting_for_input',
    lastTurnEndedAt: summary.lastTurnEndedAt ?? null,
  }
}

function waitReached(
  conditions: readonly WaitCondition[],
  state: ReturnType<typeof chatStateOf>,
  since: number,
): WaitCondition | null {
  for (const condition of conditions) {
    if (condition === 'needs_input' && state.needsInput) return condition
    if (condition === 'idle' && !state.working && !state.needsInput) return condition
    if (
      condition === 'finished' &&
      !state.working &&
      !state.needsInput &&
      state.lastTurnEndedAt !== null &&
      state.lastTurnEndedAt >= since
    )
      return condition
  }
  return null
}

/** The end of a text, at most `chars` long, cut at a line where one is near. */
function tailOf(text: string, chars: number): string {
  if (text.length <= chars) return text
  const cut = text.slice(text.length - chars)
  const newline = cut.indexOf('\n')
  return newline >= 0 && newline < chars / 4 ? cut.slice(newline + 1) : cut
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return null
  return value
}

export function createConversationChatTools(deps: ConversationChatToolsDeps): McpToolRegistration[] {
  const unavailable = () => toolError('unavailable', 'This process has no chats to reach.')
  return [
    {
      name: 'conversation.send',
      description:
        "Send a message to another chat on this machine, as if it were typed into that chat's composer. " +
        '`mode` "queue" (the default) sends it now when the chat is not in a turn, and otherwise holds it here ' +
        'and sends it the moment the turn ends (kept across a restart). "steer" delivers it into the running ' +
        "turn where the chat's CLI takes a message mid-turn, and is queued otherwise. A chat at rest is resumed " +
        'for it. Called by an agent of this app, the message is headed with which chat it came from, and the ' +
        "chat may run no looser than the caller's own permission preset: one that does is refused with " +
        '"permission_escalation". Answers `queued` (held for the turn\'s end) and `sentAt`, which ' +
        'conversation.wait takes as `since`. An agent cannot send to its own chat.',
      inputSchema: {
        type: 'object',
        properties: {
          ...targetSchema(),
          message: { type: 'string', description: `The message, at most ${CHAT_SEND_MAX_CHARS} characters.` },
          mode: { type: 'string', enum: ['queue', 'steer'], description: 'How a message to a chat mid-turn goes.' },
        },
        required: ['workspaceId', 'message'],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const chats = deps.chats
        if (!chats) return unavailable()
        if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > CHAT_SEND_MAX_CHARS)
          return toolError('invalid_arguments', `"message" must be 1 to ${CHAT_SEND_MAX_CHARS} characters.`)
        if (args.mode !== undefined && args.mode !== 'queue' && args.mode !== 'steer')
          return toolError('invalid_arguments', '"mode" must be "queue" or "steer".')
        const resolved = resolveTarget(chats, args)
        if (!resolved.ok) return toolError(resolved.code, resolved.message)
        const { target } = resolved
        if (isCallersOwnChat(context, target))
          return toolError('own_chat', 'This is your own chat; a message to it would wait on the turn sending it.')
        const ceiling = launchPermissionCeiling(context, deps.resolveAgentPermissionPreset)
        const refused = refuseDrivingLooserChat(chats.permissionOf(target.key), ceiling)
        if (refused) return toolError(refused.code, refused.message)
        const message = headedMessage(chats, context, args.message)
        const working = chatStateOf(chats.session(target.workspaceId, target.agentId))
        const steer = args.mode === 'steer'
        const sentAt = (chats.now ?? Date.now)()
        const send = (hold: boolean) =>
          chats.command(target.key, clientIdOf(context), randomUUID(), {
            kind: 'send',
            message,
            ...(steer ? { steer: true as const } : hold ? { queue: true as const } : {}),
          })
        // A chat free now takes the message at once, as the agent's own (the
        // held queue sends what it holds as the person's words). One in a turn
        // holds it for the turn's end; so does one whose turn began between
        // the look and the send, which refuses it `busy`.
        let queued = !steer && (working.working || working.needsInput)
        let result = await send(queued)
        if (!result.ok && result.code === 'busy' && !steer && !queued) {
          queued = true
          result = await send(true)
        }
        if (!result.ok)
          return toolError(result.code ?? 'refused', result.message ?? 'The chat did not take the message.')
        // A steer whose CLI could not take it mid-turn is held, and the host says so.
        if (steer && result.notice) queued = true
        return toolSuccess({
          ok: true,
          workspaceId: target.workspaceId,
          agentId: target.agentId,
          mode: steer ? 'steer' : 'queue',
          queued,
          sentAt,
          ...(result.notice ? { notice: result.notice } : {}),
        })
      },
    },
    {
      name: 'conversation.read',
      description:
        "Read what was said in a chat on this machine: the person's messages and the agent's replies as Export " +
        'chat writes them (no tool calls or their output), oldest first, each with `from` ("person" or ' +
        '"agent") and `at`. The newest `turns` turns by default; pass the answer\'s `before` back to page to ' +
        'earlier ones while `hasMore` is true. Inside `maxChars`, the newest messages are kept whole, one that ' +
        'does not fit is cut to its end (`cut`), and older ones are counted in `omitted`; ask for fewer turns ' +
        'to see them. `state` says whether the chat is working or waiting on a person. A chat link in a message ' +
        '(`sprintengine://chat/<id>`, what dragging a chat into the composer writes) names a chat here: its <id> ' +
        'is the `workspaceId`. Changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          ...targetSchema(),
          turns: {
            type: 'integer',
            minimum: 1,
            maximum: CHAT_READ_MAX_TURNS,
            description: `How many turns, ${CHAT_READ_DEFAULT_TURNS} by default.`,
          },
          before: { type: 'integer', minimum: 0, description: 'A previous answer\'s "before", to read earlier turns.' },
          maxChars: {
            type: 'integer',
            minimum: 500,
            maximum: CHAT_READ_MAX_CHARS,
            description: `How much text at most, ${CHAT_READ_DEFAULT_CHARS} by default.`,
          },
        },
        required: ['workspaceId'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const chats = deps.chats
        if (!chats) return unavailable()
        const turns = boundedInteger(args.turns, CHAT_READ_DEFAULT_TURNS, 1, CHAT_READ_MAX_TURNS)
        const maxChars = boundedInteger(args.maxChars, CHAT_READ_DEFAULT_CHARS, 500, CHAT_READ_MAX_CHARS)
        const before = boundedInteger(args.before, -1, 0, Number.MAX_SAFE_INTEGER)
        if (turns === null) return toolError('invalid_arguments', `"turns" must be 1 to ${CHAT_READ_MAX_TURNS}.`)
        if (maxChars === null)
          return toolError('invalid_arguments', `"maxChars" must be 500 to ${CHAT_READ_MAX_CHARS}.`)
        if (before === null) return toolError('invalid_arguments', '"before" must be a cursor from an earlier read.')
        const resolved = resolveTarget(chats, args)
        if (!resolved.ok) return toolError(resolved.code, resolved.message)
        const { target } = resolved
        const page = await chats.readPage(target.key, { turns, ...(before >= 0 ? { before } : {}) })
        if (!page.ok) return toolError('unavailable', page.message)
        // Loaded with the read: the export's Markdown parser is not part of
        // every process that serves these tools (the server bundle's start).
        const { chatMessagesOf } = await import('./conversation-chat-read')
        const { messages, omitted } = chatMessagesOf(page.events, maxChars)
        return toolSuccess({
          ok: true,
          workspaceId: target.workspaceId,
          agentId: target.agentId,
          title: chats.chatTitle(target.workspaceId) ?? null,
          state: chatStateOf(chats.session(target.workspaceId, target.agentId)),
          messages,
          omitted,
          hasMore: page.hasMore,
          before: page.hasMore ? page.before : null,
        })
      },
    },
    {
      name: 'conversation.wait',
      description:
        'Wait on a chat on this machine until it reaches one of `until`: "idle" (not in a turn: it finished, ' +
        'failed or is at rest), "needs_input" (stopped on an approval or a question for the person), or ' +
        '"finished" (a turn ended at or after `since`, the `sentAt` conversation.send answered; the call\'s ' +
        'own start when omitted). Defaults to ["idle", "needs_input"]. Answers at once when the chat is ' +
        `already there, or after \`timeoutMs\` (${CHAT_WAIT_DEFAULT_MS} by default, at most ${CHAT_WAIT_MAX_MS}) ` +
        "with `reached: null`. The answer carries the chat's `state` and the end of its last reply. A client " +
        'may give up on a long call first: wait again rather than asking for the longest. An agent cannot wait on ' +
        'its own chat.',
      inputSchema: {
        type: 'object',
        properties: {
          ...targetSchema(),
          until: {
            type: 'array',
            items: { type: 'string', enum: [...WAIT_CONDITIONS] },
            description: 'What to wait for; the first reached answers.',
          },
          since: { type: 'integer', minimum: 0, description: 'For "finished": epoch ms a turn must end at or after.' },
          timeoutMs: { type: 'integer', minimum: 0, maximum: CHAT_WAIT_MAX_MS },
        },
        required: ['workspaceId'],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const chats = deps.chats
        if (!chats) return unavailable()
        const until =
          args.until === undefined
            ? (['idle', 'needs_input'] as WaitCondition[])
            : Array.isArray(args.until) &&
                args.until.length > 0 &&
                args.until.every((item) => WAIT_CONDITIONS.includes(item as WaitCondition))
              ? (args.until as WaitCondition[])
              : null
        if (!until) return toolError('invalid_arguments', `"until" must list some of ${WAIT_CONDITIONS.join(', ')}.`)
        const timeoutMs = boundedInteger(args.timeoutMs, CHAT_WAIT_DEFAULT_MS, 0, CHAT_WAIT_MAX_MS)
        if (timeoutMs === null) return toolError('invalid_arguments', `"timeoutMs" must be 0 to ${CHAT_WAIT_MAX_MS}.`)
        const now = chats.now ?? Date.now
        const sleep = chats.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
        const started = now()
        const since = boundedInteger(args.since, started, 0, Number.MAX_SAFE_INTEGER)
        if (since === null) return toolError('invalid_arguments', '"since" must be epoch milliseconds.')
        const resolved = resolveTarget(chats, args)
        if (!resolved.ok) return toolError(resolved.code, resolved.message)
        const { target } = resolved
        if (isCallersOwnChat(context, target))
          return toolError('own_chat', 'This is your own chat; it cannot finish while you wait on it.')
        for (;;) {
          const summary = chats.session(target.workspaceId, target.agentId)
          const state = chatStateOf(summary)
          const reached = waitReached(until, state, since)
          const elapsed = now() - started
          if (reached || elapsed >= timeoutMs)
            return toolSuccess({
              ok: true,
              workspaceId: target.workspaceId,
              agentId: target.agentId,
              reached,
              waitedMs: elapsed,
              state,
              ...(summary?.lastAssistantTail ? { lastReply: tailOf(summary.lastAssistantTail, REPLY_TAIL_CHARS) } : {}),
            })
          await sleep(Math.min(CHAT_WAIT_POLL_MS, timeoutMs - elapsed))
        }
      },
    },
    {
      name: 'conversation.interrupt',
      description:
        'Stop the turn a chat on this machine is running, as its Stop button does. The chat keeps what was ' +
        "said and takes its next message as usual; a message queued for the turn's end then goes. A chat not " +
        'in a turn is left alone, with `interrupted: false`.',
      inputSchema: {
        type: 'object',
        properties: targetSchema(),
        required: ['workspaceId'],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const chats = deps.chats
        if (!chats) return unavailable()
        const resolved = resolveTarget(chats, args)
        if (!resolved.ok) return toolError(resolved.code, resolved.message)
        const { target } = resolved
        if (isCallersOwnChat(context, target))
          return toolError('own_chat', 'This is your own chat; end your turn instead.')
        const state = chatStateOf(chats.session(target.workspaceId, target.agentId))
        if (!state.working && !state.needsInput)
          return toolSuccess({
            ok: true,
            workspaceId: target.workspaceId,
            agentId: target.agentId,
            interrupted: false,
            state,
          })
        const result = await chats.command(target.key, clientIdOf(context), randomUUID(), { kind: 'interrupt' })
        if (!result.ok) return toolError(result.code ?? 'refused', result.message ?? 'The chat was not stopped.')
        return toolSuccess({ ok: true, workspaceId: target.workspaceId, agentId: target.agentId, interrupted: true })
      },
    },
  ]
}

/**
 * The message as the chat receives it: from an agent, headed with the chat it
 * came from, so the agent reading it knows it is not the person and where an
 * answer would go.
 */
function headedMessage(chats: ConversationChatControl, context: McpConnectionContext | undefined, message: string) {
  const metadata = context?.metadata
  if (metadata?.kind !== 'studio-agent' || !metadata.agentId) return message
  const title = metadata.workspaceId ? chats.chatTitle(metadata.workspaceId) : undefined
  const from = [
    title ? `"${title}"` : 'another chat',
    `(workspaceId ${metadata.workspaceId ?? 'unknown'}, agentId ${metadata.agentId})`,
  ].join(' ')
  return `[Sent by the agent in ${from} through Studio, not by the person.]\n\n${message}`
}
