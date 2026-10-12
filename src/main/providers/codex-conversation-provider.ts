import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CONVERSATION_DEFAULT_MODEL_ID, conversationPermissionModes } from '../../shared/conversation-harness'
import { isWslHostId, type ExecutionHostId } from '../../shared/execution-host'
import { toWslPath, wslToWindowsPath } from '../../shared/host-paths'
import type {
  ConversationCliRuntimeOverrides,
  ConversationEvent,
  ConversationMcpServer,
  ConversationPermissionPreset,
  ConversationSubagentState,
  ConversationTurnUsage,
} from '../../shared/conversation-runtime'
import { addTurnUsage, turnUsageOf } from '../../shared/conversation/turn-usage'
import type {
  ConversationProviderAdapter,
  MockAdapterSessionInput,
  MockAdapterTurnInput,
} from './conversation-provider-adapter'
import {
  CODEX_RPC_TIMEOUT_MS,
  CodexRpcError,
  CodexSpawnError,
  codexAppServerArgs,
  createCodexRpcTransport,
  type CodexRpcOptions,
  type CodexRpcTransport,
  type RpcMessage,
} from './codex-json-rpc'
import { explainCodexInitializeTimeout, isCodexInitializeTimeout } from './codex-start-failure'
import { conversationCommandsFor, publishConversationCommands } from '../conversation-commands/registry'
import { mcpServerStatusFor, publishMcpServerStatus } from '../mcp-server-status/registry'
import type { AgentMcpServerStatus } from '../../shared/skills'
import { CODEX_COMPACT_COMMAND, codexCompactRequest, codexConversationCommands } from '../conversation-commands/codex'
import type { ConversationCommand } from '../../shared/conversation/commands'
import { codexPlanInput, codexTool, codexToolResult } from './codex-items'
import { saveToolResultImages, type SaveToolResultImages } from './tool-result-images'
import type { ThreadForkParams, ThreadItem, TurnPlanUpdatedNotification } from './codex-protocol'
import {
  CONVERSATION_IDENTITY_ENV_KEYS,
  hostMachineName,
  mcpServersOnWsl,
  prepareWslCliTarget,
  wslTargetForHost,
  type WslCliChild,
  type WslCliTarget,
} from './cli-host-child'
import { studioGatewayForChat, withStudioGateway, type StudioMcpServerResolver } from './studio-gateway-entry'
import { GATEWAY_WORKTREE_LEASE_TOOLS, isInGitCheckout, worktreeLeaseInstruction } from './worktree-lease-guidance'
import { studioPlatform } from '../../server/platform/platform'
import { usageLimitsStore } from '../usage-limits/store'
import { codexBillingOf, codexRateLimitUpdates, isCodexUsageLimitError } from '../usage-limits/sources'

export const CODEX_CONVERSATION_PROVIDER_ID = 'codex-agent'
type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {}
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
// A count Codex reported, or nothing: a null window (a model Codex has no size
// for) and a zero are both "no reading", never an empty window.
const positiveNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
// How long a patch approval waits for its item (and so its diff) to arrive.
const PATCH_APPROVAL_WAIT_MS = 1_000
// The longest subagent message a transcript event keeps.
const CHILD_MESSAGE_CHARS = 32 * 1024
// Who this app is to Codex. The experimental API is what Codex's own clients
// run on, and the surface its newer items are reported through.
const CODEX_INITIALIZE = {
  clientInfo: { name: 'sprintengine_studio', title: 'SprintEngine Studio', version: '1.0.0' },
  capabilities: { experimentalApi: true },
}
// How long the read of the account's usage limits at start may take before it
// is let go. It never holds a turn up; the pushes that follow replace it.
export const CODEX_RATE_LIMITS_READ_TIMEOUT_MS = 3_000
// How long a stopped turn waits for Codex to confirm it with `turn/completed`.
// An app-server that never does is closed, so a hung turn can neither keep the
// process alive nor refuse every later message as "already running a turn".
export const CODEX_INTERRUPT_GRACE_MS = 10_000

class EventQueue implements AsyncIterable<ConversationEvent> {
  private values: ConversationEvent[] = []
  private wake?: () => void
  private ended = false
  push(event: ConversationEvent) {
    if (!this.ended) {
      this.values.push(event)
      this.wake?.()
    }
  }
  end() {
    this.ended = true
    this.wake?.()
  }
  async *[Symbol.asyncIterator]() {
    while (!this.ended || this.values.length) {
      const value = this.values.shift()
      if (value) yield value
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
    }
  }
}
type ActiveTurn = {
  id: string
  cancelled: boolean
  // The `turn/interrupt` already sent for this turn, so a second stop waits on
  // it rather than asking again.
  interrupting: Promise<unknown> | null
  // Ends a stopped turn Codex never confirms; see CODEX_INTERRUPT_GRACE_MS.
  watchdog: ReturnType<typeof setTimeout> | null
  // Settles once the turn has finished, however it finished.
  ended: Promise<void>
  settle: () => void
  nativeId: string | null
  queue: EventQueue
  textItems: Set<string>
  // The message whose text was streamed last, until a tool comes between.
  textItem: string | null
  items: Map<string, RecordValue>
  outputBytes: Map<string, number>
  deferredApprovals: Map<string, (item: RecordValue) => void>
  message: string
  text: string
  // The agent message said last, and its item: what `turn_completed` reports
  // as the turn's reply. Codex says its narration and its answer as separate
  // messages, and the answer is the last one.
  reply: string
  replyItem: string | null
  // What the turn's model requests spent, summed from each `last` report.
  usage: ConversationTurnUsage | null
  // A `/compact` turn: Codex runs it from `thread/compact/start`, not a prompt.
  compact: boolean
  // Notes already written this turn, so a failure Codex retries reads once.
  notes: Set<string>
  plans: number
  // Codex reported this turn's error as a plan's usage limit.
  usageLimit?: boolean
}
// A subagent Codex spawned: its own thread, drawn as a lane under the step
// that started it.
type Child = {
  toolUseId: string
  lastText: string
  done: boolean
}
type Session = {
  closed: boolean
  input: MockAdapterSessionInput
  threadId: string | null
  // A fork's first connection branches this thread through this turn
  // (`thread/fork`) instead of resuming one of its own.
  forkFrom: { threadId: string; lastTurnId: string } | null
  transport: CodexRpcTransport | null
  starting?: Promise<void>
  turn: ActiveTurn | null
  pending: Map<string, { rpcId: string | number; kind: 'tool' | 'question'; questions?: RecordValue[] }>
  // Completed exchanges of this process, replayed with the persisted history
  // when the thread they belonged to cannot be resumed.
  history: Array<{ user: string; assistant: string }>
  replayHistory: boolean
  lastActivityAt: number
  spawnedAt: number | null
  // Keyed by the child's thread id.
  children: Map<string, Child>
  // MCP servers already reported as failing to start, by name.
  failedServers: Set<string>
  // The preset moved to `none` from an override the thread keeps; the
  // app-server is restarted before the next turn so the thread resumes
  // without it. Set while a turn was running, when it could not be then.
  resetPolicy?: boolean
  // The distribution the app-server runs in, for a chat on a WSL machine;
  // null on this one. Known once the app-server has been started.
  wsl: WslCliTarget | null
  // How the signed-in account pays, from `account/read`: only a ChatGPT
  // sign-in has plan limits to read. Null until known.
  usageBilling?: 'subscription' | 'api' | null
}
export type CodexConversationProviderOptions = {
  resolveExecutable?: (input: MockAdapterSessionInput) => Promise<string>
  buildEnv?: (input: MockAdapterSessionInput) => Promise<NodeJS.ProcessEnv>
  createTransport?: (options: CodexRpcOptions) => CodexRpcTransport
  // Where a picture Codex generated without saving it is written; returns its path.
  saveGeneratedImage?: (input: { sessionId: string; itemId: string; base64: string }) => Promise<string>
  // Where a step's returned pictures are written; tests stand in.
  saveToolImages?: SaveToolResultImages
  // Readies a WSL machine for a chat whose `codex` runs there; tests stand in.
  prepareWslTarget?: (hostId: ExecutionHostId) => Promise<WslCliTarget>
  // The app's MCP gateway on the machine the chat's `codex` runs on. Null
  // leaves it out; the chat runs without Studio's tools rather than not at all.
  resolveStudioMcpServer?: StudioMcpServerResolver
  // The size of Codex's log database on the chat's machine, read when a start
  // times out. Tests stand in; the default lists the Codex home folder there.
  readCodexLogBytes?: (wslDistro: string | null, env: NodeJS.ProcessEnv) => Promise<number | null>
}

/**
 * The approval and sandbox override for a preset, matching the terminal
 * launch. Codex takes both on every `turn/start`, so a change reaches the next
 * turn without restarting anything.
 *
 * - `bypass` is Codex's YOLO: never ask, full access.
 * - `auto` is Codex's own auto-review, what a terminal's `--approve-for-me`
 *   sets: it reads, edits and runs commands inside the workspace sandbox
 *   without asking, and a request to go past it (a write outside the
 *   workspace, the network) is judged by Codex's reviewer instead of the
 *   person, as Claude's and Cursor's Auto are their classifiers.
 * - `manual` asks before every command Codex does not already know to be a
 *   safe read (`untrusted`), in a read-only sandbox, so every edit asks too.
 *   The app-server still takes `untrusted`; the command line no longer does.
 * - `none` sends no override at all, so Codex runs on its own configured default.
 * - Codex's own Default (`workspace`, at Auto) is what Auto was before
 *   auto-review: the workspace sandbox, with the person asked before anything
 *   leaves it.
 *
 * Every preset but `none` names its reviewer, `user` included: a turn's
 * reviewer stays with the thread like its policy does, so a chat moved off
 * Auto would otherwise keep sending its requests to the reviewer.
 */
export function codexPermissionPolicy(
  preset: ConversationPermissionPreset = 'none',
  mode?: string,
): {
  approvalPolicy?: 'never' | 'on-request' | 'untrusted'
  approvalsReviewer?: 'user' | 'auto_review'
  sandbox?: 'danger-full-access' | 'workspace-write' | 'read-only'
  sandboxPolicy?: Record<string, unknown>
} {
  if (preset === 'bypass')
    return {
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' },
    }
  if (preset === 'auto')
    return {
      approvalPolicy: 'on-request',
      approvalsReviewer: mode === 'workspace' ? 'user' : 'auto_review',
      sandbox: 'workspace-write',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    }
  if (preset === 'manual')
    return {
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    }
  return {}
}

export function createCodexConversationProvider(
  options: CodexConversationProviderOptions = {},
): ConversationProviderAdapter {
  const sessions = new Map<string, Session>()
  const models = ['gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna']
  function event(state: Session, type: ConversationEvent['type'], payload: RecordValue = {}): ConversationEvent {
    return {
      id: randomUUID(),
      sessionId: state.input.sessionId,
      workspaceId: state.input.workspaceId,
      agentId: state.input.agentId,
      providerId: state.input.providerId,
      modelId: state.input.modelId,
      type,
      createdAt: Date.now(),
      payload: { ...(state.turn ? { turnId: state.turn.id } : {}), ...payload },
    }
  }
  function emit(state: Session, type: ConversationEvent['type'], payload: RecordValue = {}) {
    state.lastActivityAt = Date.now()
    const next = event(state, type, payload)
    if (state.turn && type === 'content_delta') state.turn.text += text(payload.text)
    if (state.turn) state.turn.queue.push(next)
    else state.input.onSessionEvent?.(next)
  }
  /** `refused`: the message was turned away here, before Codex was asked anything. */
  function finish(state: Session, failure?: string, interrupted = false, refused = false) {
    if (!state.turn) return
    for (const requestId of state.pending.keys()) emit(state, 'approval_resolved', { requestId, approved: false })
    state.pending.clear()
    if (!failure && !interrupted && !state.turn.cancelled && !state.turn.compact)
      state.history.push({ user: state.turn.message, assistant: state.turn.text })
    // Where the thread stood once this turn was over: the turn a fork made at
    // its end branches the thread through (`thread/fork`'s `lastTurnId`).
    const providerCursor =
      state.threadId && state.turn.nativeId ? { sessionId: state.threadId, at: state.turn.nativeId } : null
    const reply = state.turn.reply.trim() ? state.turn.reply : ''
    emit(state, failure ? 'turn_failed' : 'turn_completed', {
      ...(failure
        ? { message: failure, reason: 'provider_error', ...(refused ? { refused: true } : {}) }
        : {
            interrupted,
            ...(reply && !interrupted ? { text: reply } : {}),
            ...(state.turn.usage ? { usage: state.turn.usage } : {}),
          }),
      ...(providerCursor ? { providerCursor } : {}),
    })
    if (state.turn.watchdog) clearTimeout(state.turn.watchdog)
    state.turn.queue.end()
    state.turn.settle()
    state.turn = null
  }
  // Subagent progress belongs to the lane, not to whichever turn is open when
  // it arrives: a spawned agent can outlive the turn that launched it.
  function emitSessionEvent(state: Session, type: ConversationEvent['type'], payload: RecordValue) {
    state.lastActivityAt = Date.now()
    const next = { ...event(state, type), payload }
    if (state.turn) state.turn.queue.push(next)
    else state.input.onSessionEvent?.(next)
  }
  // A line in the turn about something Codex reported beside the reply: a
  // tool that could not run, a retried error, a warning. Said once per turn.
  function note(state: Session, message: string) {
    const turn = state.turn
    if (!turn || !message || turn.notes.has(message)) return
    turn.notes.add(message)
    emit(state, 'command_output', { output: message, adapterNote: true })
  }
  // Codex says a turn's narration and its answer as separate messages. A
  // message that follows another with no tool between starts a paragraph of
  // its own instead of running on from the last sentence of the one before.
  function say(state: Session, turn: ActiveTurn, itemId: string, value: string) {
    turn.textItems.add(itemId)
    if (!value) return
    const seam = turn.textItem !== null && turn.textItem !== itemId
    turn.textItem = itemId
    if (turn.replyItem === itemId) turn.reply += value
    else {
      turn.replyItem = itemId
      turn.reply = value
    }
    emit(state, 'content_delta', { text: seam ? `\n\n${value}` : value })
  }
  // Closes the app-server so the next turn resumes the thread without the
  // approval and sandbox override an earlier turn left on it.
  function restartForPolicy(state: Session) {
    state.resetPolicy = false
    const transport = state.transport
    if (!transport) return
    state.transport = null
    state.spawnedAt = null
    stopLanes(state, 'The agent stopped when Codex restarted with the new permissions.')
    transport.close()
  }
  // Ends the turn on this side and closes the app-server, whose thread the
  // next turn resumes. Used when a stopped turn cannot be confirmed by Codex.
  // Its subagents run in that process, so their lanes end with it.
  function abandonTurn(state: Session) {
    const transport = state.transport
    state.transport = null
    state.spawnedAt = null
    if (transport) stopLanes(state, 'The agent stopped when its Codex process ended.')
    finish(state, undefined, true)
    transport?.close()
  }
  // What `account/read` says about billing, and for a subscription, where its
  // limits stand: read once as the app-server starts, in the background, and
  // let go after a short wait — the turn never waits on it, and the pushes
  // that follow every request keep it current from there.
  function noteCodexAccount(state: Session, transport: CodexRpcTransport, account: RecordValue) {
    const billing = codexBillingOf(account)
    state.usageBilling = billing?.billing ?? null
    if (!billing) return
    usageLimitsStore().noteBilling('codex', billing.billing, billing.plan)
    if (billing.billing !== 'subscription') return
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), CODEX_RATE_LIMITS_READ_TIMEOUT_MS)
      timer.unref?.()
    })
    const read = transport.request('account/rateLimits/read', { excludeResetCreditDetails: true }).catch(() => null)
    void Promise.race([read, timeout]).then((result) => {
      clearTimeout(timer)
      if (result && state.transport === transport && state.usageBilling === 'subscription')
        usageLimitsStore().noteWindows('codex', codexRateLimitUpdates(result))
    })
  }
  async function interrupt(state: Session): Promise<void> {
    const turn = state.turn
    if (!turn) return
    turn.cancelled = true
    if (!turn.watchdog) {
      turn.watchdog = setTimeout(() => {
        if (state.turn === turn) abandonTurn(state)
      }, CODEX_INTERRUPT_GRACE_MS)
      turn.watchdog.unref?.()
    }
    if (turn.interrupting) {
      await turn.interrupting
      return
    }
    if (!turn.nativeId || !state.transport) return
    turn.interrupting = state.transport.request('turn/interrupt', { threadId: state.threadId, turnId: turn.nativeId })
    await turn.interrupting
  }
  async function onMessage(state: Session, message: RpcMessage) {
    const params = record(message.params)
    // Another thread is either a subagent this thread spawned, or not ours.
    const foreign = typeof params.threadId === 'string' && state.threadId !== null && params.threadId !== state.threadId
    const child = foreign ? state.children.get(params.threadId as string) : undefined
    if (foreign && !child) {
      if (message.id !== undefined) state.transport?.reject(message.id, 'This thread is not owned by this session.')
      return
    }
    const turn = state.turn
    if (message.id !== undefined) {
      const rpcId = message.id
      if (!turn) {
        state.transport?.reject(rpcId, 'No active conversation turn.')
        return
      }
      const isCommand = message.method === 'item/commandExecution/requestApproval'
      const isPatch = message.method === 'item/fileChange/requestApproval'
      const isQuestion = message.method === 'item/tool/requestUserInput'
      if (!isCommand && !isPatch && !isQuestion) {
        state.transport?.reject(rpcId, 'This client does not support this request.')
        return
      }
      const itemId = text(params.itemId)
      const requestId = `${turn.id}:${String(rpcId)}`
      const questions = Array.isArray(params.questions) ? params.questions.map(record) : []
      state.pending.set(requestId, { rpcId, kind: isQuestion ? 'question' : 'tool', questions })
      const raise = (item: RecordValue) => {
        if (state.turn !== turn || !state.pending.has(requestId)) return
        const mapped = isCommand
          ? {
              name: 'Bash',
              kind: 'command',
              input: { command: params.command ?? item.command, cwd: params.cwd ?? item.cwd },
            }
          : codexTool(item as ThreadItem)
        emit(state, 'approval_requested', {
          requestId,
          action: isQuestion ? 'AskUserQuestion' : (mapped?.name ?? 'Edit'),
          kind: isQuestion ? 'question' : 'tool',
          input: mapped?.input ?? { reason: params.reason },
          toolKind: mapped?.kind ?? 'file_edit',
          cwd: state.input.workspaceRoot,
          summary:
            text(params.reason) ||
            (isCommand
              ? text(params.command ?? item.command)
              : isPatch
                ? 'Apply the proposed file changes?'
                : text(questions[0]?.question)),
          ...(isQuestion
            ? {
                questions: questions.map((question) => ({
                  question: text(question.question),
                  header: text(question.header),
                  multiSelect: false,
                  options: Array.isArray(question.options) ? question.options : [],
                })),
              }
            : {}),
        })
      }
      const known = turn.items.get(itemId)
      if (isPatch && Array.isArray(params.changes)) raise({ type: 'fileChange', changes: params.changes })
      else if (isPatch && !known && itemId) {
        // A patch approval can arrive before the item that carries its diff.
        // Asking without the diff would have the person approve blind, so the
        // card waits for the item, and only asks without it if none arrives.
        const timer = setTimeout(() => {
          turn.deferredApprovals.delete(itemId)
          raise({})
        }, PATCH_APPROVAL_WAIT_MS)
        timer.unref?.()
        turn.deferredApprovals.set(itemId, (item) => {
          clearTimeout(timer)
          turn.deferredApprovals.delete(itemId)
          raise(item)
        })
      } else raise(known ?? {})
      return
    }
    // Codex watches its skill folders and says when they change, whether or
    // not a turn is running; the list is asked for again rather than patched.
    if (message.method === 'skills/changed') {
      void publishSkills(state, true)
      return
    }
    // The account's usage after a request moved it, turn or no turn: a sparse
    // snapshot whose windows merge into the last ones read.
    if (message.method === 'account/rateLimits/updated') {
      if (state.usageBilling === 'subscription')
        usageLimitsStore().noteWindows('codex', codexRateLimitUpdates(params.rateLimits))
      return
    }
    const method = message.method
    if (child) return onChildMessage(state, child, method, params)
    if (!turn) return
    if (method === 'turn/started') {
      turn.nativeId = text(record(params.turn).id) || turn.nativeId
      return
    }
    if (method === 'item/agentMessage/delta') {
      say(state, turn, text(params.itemId), text(params.delta))
      return
    }
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      emit(state, 'reasoning_delta', { text: text(params.delta) })
      return
    }
    if (method === 'item/commandExecution/outputDelta') {
      // Only the new text: the runtime appends it to the tool's output, so a
      // long command costs each chunk once rather than its whole output again.
      const id = text(params.itemId)
      const totalBytes = (turn.outputBytes.get(id) ?? 0) + Buffer.byteLength(text(params.delta))
      turn.outputBytes.set(id, totalBytes)
      emit(state, 'tool_output', {
        toolUseId: id,
        output: text(params.delta),
        outputMode: 'append',
        totalBytes,
        partial: true,
        status: 'ok',
      })
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      const tokenUsage = record(params.tokenUsage)
      const usage = record(tokenUsage.last)
      // How full the window is: the latest request's whole exchange, which is
      // what Codex itself measures the window against — not `total`, the
      // session's running sum, which outgrows any window within a few turns.
      const contextUsed = positiveNumber(usage.totalTokens)
      const contextWindow = positiveNumber(tokenUsage.modelContextWindow)
      // `last` is one request's spend; the turn's is their sum. Codex counts
      // the cache's reads and writes inside its input (its total is input
      // plus output), so the fresh input is what is left of it.
      const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined
      const cacheRead = typeof usage.cachedInputTokens === 'number' ? usage.cachedInputTokens : undefined
      const cacheWrite = typeof usage.cacheWriteInputTokens === 'number' ? usage.cacheWriteInputTokens : undefined
      turn.usage = addTurnUsage(
        turn.usage,
        turnUsageOf({
          inputTokens: input !== undefined ? Math.max(0, input - (cacheRead ?? 0) - (cacheWrite ?? 0)) : undefined,
          outputTokens: usage.outputTokens,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
        }),
      )
      emit(state, 'usage_updated', {
        inputTokens: usage.inputTokens,
        // The share of the input OpenAI's prompt cache served. Codex reports no
        // cache lifetime, so this is all a chat on it can say about its cache.
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(contextUsed !== undefined ? { contextUsed } : {}),
      })
      return
    }
    // Codex's `update_plan`: the checklist as it stands after each call, a
    // step of its own each time as with any agent's plan updates.
    if (method === 'turn/plan/updated') {
      const id = `${turn.id}:plan:${++turn.plans}`
      turn.textItem = null
      emit(state, 'tool_started', {
        toolUseId: id,
        toolCallId: id,
        name: 'TodoWrite',
        tool: 'TodoWrite',
        kind: 'todo',
        input: codexPlanInput(params as unknown as TurnPlanUpdatedNotification),
      })
      emit(state, 'tool_output', { toolUseId: id, toolCallId: id, output: '', status: 'ok' })
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = record(params.item),
        id = text(item.id)
      if (!id) return
      const complete = method === 'item/completed'
      // Codex summarised the thread: on `/compact`, or on its own when the
      // window filled mid-turn. The transcript marks the seam the same way it
      // does for Claude Code.
      if (item.type === 'contextCompaction') {
        emit(
          state,
          complete ? 'context_compacted' : 'context_compacting',
          complete ? { trigger: turn.compact ? 'manual' : 'auto' } : {},
        )
        return
      }
      if (item.type === 'agentMessage' && complete && !turn.textItems.has(id)) {
        say(state, turn, id, text(item.text))
        return
      }
      if (item.type === 'subAgentActivity') return subAgentActivity(state, item)
      if (item.type === 'collabAgentToolCall') return collabAgentToolCall(state, item)
      await step(state, turn, item, complete)
      return
    }
    if (method === 'turn/completed') {
      const native = record(params.turn)
      turn.nativeId = text(native.id) || turn.nativeId
      // A turn a plan's usage limit refused: said to whatever waits to resume
      // it. When the limit lifts is the full window's reset, which the store has.
      if (
        native.status === 'failed' &&
        (turn.usageLimit || isCodexUsageLimitError(native.error)) &&
        state.usageBilling !== 'api'
      )
        usageLimitsStore().noteLimitHit({
          provider: 'codex',
          sessionId: state.input.sessionId,
          resetsAt: null,
          windowId: null,
        })
      finish(
        state,
        native.status === 'failed' ? text(record(native.error).message) || 'Codex turn failed.' : undefined,
        native.status === 'interrupted',
      )
      return
    }
    diagnostic(state, method, params)
  }
  // One of Codex's steps, drawn as a row: under the lane of the subagent that
  // took it when `parentToolUseId` names one.
  async function step(
    state: Session,
    turn: ActiveTurn,
    item: RecordValue,
    complete: boolean,
    parentToolUseId?: string,
  ) {
    const id = text(item.id)
    const mapped = codexTool(item as ThreadItem)
    if (!mapped) return
    const previous = turn.items.get(id)
    // A finished step is kept only as having been seen: its output, a
    // picture's bytes among them, is not needed again once it is reported, and
    // an approval only ever asks about a step still running.
    turn.items.set(id, complete ? { id, type: item.type } : item)
    // Text after a tool is laid out as a block of its own already.
    if (!previous && !parentToolUseId) turn.textItem = null
    const picture = item.type === 'imageGeneration' && complete ? await generatedImagePath(state, item) : null
    if (picture) mapped.input.path = picture
    // Completed file items may carry richer diff input than their start event,
    // and a picture's path is known only once it is made.
    if (!previous || item.type === 'fileChange' || picture)
      emit(state, 'tool_started', {
        toolUseId: id,
        toolCallId: id,
        name: mapped.name,
        tool: mapped.name,
        kind: mapped.kind,
        input: mapped.input,
        ...(parentToolUseId ? { parentToolUseId } : {}),
      })
    turn.deferredApprovals.get(id)?.(item)
    if (!complete) return
    const result = codexToolResult(item as ThreadItem)
    const partialBytes = turn.outputBytes.get(id)
    // With no aggregate, the streamed chunks are the output: close it without repeating them.
    const streamedOnly = item.type === 'commandExecution' && item.aggregatedOutput == null && partialBytes !== undefined
    // A step's pictures (a screenshot an MCP server returned), kept to show under it.
    // On disk before the step says where they are.
    let images: string[] = []
    if (result.images?.length && state.input.workspaceRoot) {
      const write = (options.saveToolImages ?? saveToolResultImages)({
        key: {
          workspaceRoot: state.input.workspaceRoot,
          workspaceId: state.input.workspaceId,
          agentId: state.input.agentId,
        },
        toolUseId: id,
        images: result.images,
      })
      await write.written
      images = write.paths
    }
    emit(state, 'tool_output', {
      toolUseId: id,
      toolCallId: id,
      output: streamedOnly ? '' : result.output,
      ...(streamedOnly ? { outputMode: 'append', totalBytes: partialBytes } : {}),
      status: result.status,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(images.length ? { images } : {}),
    })
  }
  // Where a generated picture is on disk: where Codex saved it, or where this
  // adapter wrote the bytes Codex sent, so it outlives the process that made it.
  async function generatedImagePath(state: Session, item: RecordValue): Promise<string | null> {
    // Codex in WSL names where it saved a picture the Linux way; the chat
    // opens it from this machine.
    if (typeof item.savedPath === 'string' && item.savedPath)
      return state.wsl ? wslToWindowsPath(item.savedPath, { distro: state.wsl.distro }) : item.savedPath
    const base64 = text(item.result).replace(/^data:[^;]+;base64,/, '')
    if (!base64) return null
    try {
      return await (options.saveGeneratedImage ?? saveGeneratedImage)({
        sessionId: state.input.sessionId,
        itemId: text(item.id),
        base64,
      })
    } catch {
      return null
    }
  }
  // Something Codex reported beside the reply, said as a line in the turn.
  function diagnostic(state: Session, method: string | undefined, params: RecordValue) {
    switch (method) {
      // An error Codex will not retry fails the turn, which says so already.
      case 'error':
        if (state.turn && isCodexUsageLimitError(params.error)) state.turn.usageLimit = true
        if (params.willRetry === true)
          note(state, `Codex hit an error and is retrying: ${text(record(params.error).message)}`)
        return
      case 'warning':
      case 'guardianWarning':
        note(state, text(params.message))
        return
      case 'configWarning':
      case 'deprecationNotice': {
        const details = text(params.details)
        note(state, `${text(params.summary)}${details ? ` ${details}` : ''}`)
        return
      }
      case 'model/rerouted':
        note(
          state,
          `Codex answered this turn with ${text(params.toModel)} instead of ${text(params.fromModel)}${
            params.reason === 'highRiskCyberActivity' ? ', as the request looked like high-risk security work' : ''
          }.`,
        )
        return
      // A server that failed to start fails every thread that uses it: said
      // once for the conversation, not on every turn.
      case 'mcpServer/oauthLogin/completed':
        void refreshMcpServers(state)
        return
      case 'mcpServer/startupStatus/updated': {
        const name = text(params.name)
        // Codex's error opens by naming the server again.
        const error = text(params.error).replace(
          /^MCP client for `[^`]*` failed to start:\s*(MCP startup failed:\s*)?/,
          '',
        )
        const status = CODEX_MCP_STATUS[text(params.status)]
        if (name && status && state.input.workspaceRoot)
          publishMcpServerStatus({
            cli: 'codex',
            cwd: state.input.workspaceRoot,
            servers: [{ id: name, status, ...(status === 'failed' && error ? { error } : {}) }],
          })
        if (params.status !== 'failed' || !name || state.failedServers.has(name)) return
        state.failedServers.add(name)
        note(state, `Codex's MCP server “${name}” did not start${error ? `: ${error}` : '.'}`)
        return
      }
    }
  }
  function toolFailure(state: Session, reason: string) {
    note(
      state,
      /code-mode host/i.test(reason)
        ? `Codex could not run its tools: ${reason}. Its code-mode host did not answer, so commands, edits and image generation all fail until Codex is updated or reinstalled.`
        : `Codex could not run a tool: ${reason}.`,
    )
  }
  // A subagent is a thread of its own. Its lane opens under the step that
  // spawned it, and carries its status and what it says.
  function openLane(state: Session, threadId: string, toolUseId: string, description: string) {
    if (!threadId || state.children.has(threadId)) return
    state.children.set(threadId, { toolUseId, lastText: '', done: false })
    if (state.turn) state.turn.textItem = null
    emit(state, 'tool_started', {
      toolUseId,
      toolCallId: toolUseId,
      name: 'Agent',
      tool: 'Agent',
      kind: 'subagent',
      subagentLane: true,
      input: { description },
    })
    emitSessionEvent(state, 'subagent_status', { toolUseId, status: 'running', description })
  }
  function settleLane(state: Session, child: Child, status: ConversationSubagentState, error?: string) {
    if (child.done) return
    child.done = true
    emitSessionEvent(state, 'subagent_status', {
      toolUseId: child.toolUseId,
      status,
      endedAt: Date.now(),
      ...(error ? { error } : {}),
    })
    emit(state, 'tool_output', {
      toolUseId: child.toolUseId,
      toolCallId: child.toolUseId,
      output: child.lastText || error || '',
      status: status === 'completed' ? 'ok' : status === 'failed' ? 'error' : 'stopped',
      // The turn that spawned it is over: the result closes the lane on its own.
      ...(state.turn ? {} : { backgroundResult: true }),
    })
  }
  function stopLanes(state: Session, reason: string) {
    for (const child of state.children.values()) settleLane(state, child, 'stopped', reason)
    state.children.clear()
  }
  function subAgentActivity(state: Session, item: RecordValue) {
    const threadId = text(item.agentThreadId)
    openLane(state, threadId, text(item.id), agentName(text(item.agentPath)))
    const child = state.children.get(threadId)
    if (!child) return
    if (item.kind === 'completed') settleLane(state, child, 'completed')
    else if (item.kind === 'interrupted') settleLane(state, child, 'stopped', 'The agent was interrupted.')
  }
  // The calls a thread makes to its agents. `wait` and the like are how Codex
  // coordinates them, not steps of the work, so they draw no rows: what they
  // learn about each agent moves its lane instead.
  function collabAgentToolCall(state: Session, item: RecordValue) {
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.map(text).filter(Boolean) : []
    if (item.tool === 'spawnAgent')
      for (const threadId of receivers)
        openLane(
          state,
          threadId,
          receivers.length > 1 ? `${text(item.id)}:${threadId}` : text(item.id),
          summarize(text(item.prompt)) || 'Codex agent',
        )
    for (const [threadId, value] of Object.entries(record(item.agentsStates))) {
      const child = state.children.get(threadId)
      if (!child) continue
      const agent = record(value)
      const message = text(agent.message)
      if (message) child.lastText = message
      if (agent.status === 'completed') settleLane(state, child, 'completed')
      else if (agent.status === 'errored') settleLane(state, child, 'failed', message || 'The agent failed.')
      else if (agent.status === 'notFound') settleLane(state, child, 'failed', 'Codex no longer knows this agent.')
      else if (agent.status === 'interrupted' || agent.status === 'shutdown') settleLane(state, child, 'stopped')
    }
  }
  // What a subagent's own thread says. Its turns and words go to its lane; its
  // steps are drawn under the lane while the turn that can show them is open.
  async function onChildMessage(state: Session, child: Child, method: string | undefined, params: RecordValue) {
    if (method === 'turn/started' && child.done) {
      // Given more to do after it finished (`sendInput`, a follow-up task):
      // its ended lane reopens, which a plain `running` never does.
      child.done = false
      emitSessionEvent(state, 'subagent_status', { toolUseId: child.toolUseId, status: 'running', resumed: true })
      return
    }
    if (method === 'turn/completed') {
      const turn = record(params.turn)
      if (turn.status === 'failed')
        settleLane(state, child, 'failed', text(record(turn.error).message) || 'The agent failed.')
      else if (turn.status === 'interrupted') settleLane(state, child, 'stopped', 'The agent was interrupted.')
      else settleLane(state, child, 'completed')
      return
    }
    if (method !== 'item/started' && method !== 'item/completed') return
    const item = record(params.item)
    if (item.type === 'agentMessage') {
      const said = text(item.text)
      if (method !== 'item/completed' || !said.trim()) return
      child.lastText = said
      const truncated = said.length > CHILD_MESSAGE_CHARS
      emitSessionEvent(state, 'subagent_message', {
        parentToolUseId: child.toolUseId,
        text: truncated ? said.slice(0, CHILD_MESSAGE_CHARS) : said,
        ...(truncated ? { truncated } : {}),
      })
      return
    }
    if (state.turn && text(item.id)) await step(state, state.turn, item, method === 'item/completed', child.toolUseId)
  }
  // The composer's `/` menu for this folder: `/compact`, which this adapter
  // runs, and the skills Codex lists for the folder as `$name` mentions.
  async function publishSkills(state: Session, forceReload = false) {
    const transport = state.transport
    const cwd = state.input.workspaceRoot ?? ''
    if (!transport || !cwd) return
    // Codex is asked about the folder as it names it; the menu is keyed by the
    // folder as this machine does.
    const codexCwd = hostCwd(cwd, state.wsl)
    try {
      const listed = await transport.request('skills/list', {
        cwds: [codexCwd],
        ...(forceReload ? { forceReload } : {}),
      })
      publishConversationCommands({ cli: 'codex', cwd, commands: codexConversationCommands(listed, codexCwd) })
    } catch (error) {
      if (state.transport !== transport) return
      publishConversationCommands({
        cli: 'codex',
        cwd,
        commands: [],
        error: error instanceof Error ? error.message : 'Codex could not list its skills.',
      })
    }
  }
  // Codex's own account of each MCP server: whether it connected, whether it
  // waits for a sign-in, and the tools it brought. Published for the composer
  // beside the startup states its notifications carry.
  async function refreshMcpServers(state: Session): Promise<void> {
    const transport = state.transport
    const cwd = state.input.workspaceRoot
    if (!transport || !cwd) return
    const answer = await transport
      .request('mcpServerStatus/list', { ...(state.threadId ? { threadId: state.threadId } : {}) })
      .catch(() => null)
    const listed = Array.isArray(record(answer).data) ? (record(answer).data as unknown[]) : null
    if (!listed || state.transport !== transport) return
    publishMcpServerStatus({
      cli: 'codex',
      cwd,
      replace: true,
      servers: listed.flatMap((entry) => {
        const server = record(entry)
        const id = text(server.name)
        const status = codexServerStatus(text(server.runtimeStatus), text(server.authStatus))
        if (!id || !status) return []
        const error = text(server.toolsError)
        const tools = record(server.tools)
        return [
          {
            id,
            status,
            ...(error ? { error } : {}),
            ...(status === 'connected' ? { toolCount: Object.keys(tools).length } : {}),
          },
        ]
      }),
    })
  }

  // A sign-in finishes in the browser; Codex says so with
  // `mcpServer/oauthLogin/completed`, and until then the list is read again
  // now and then for as long as a person takes to sign in.
  function watchSignIn(state: Session, serverId: string): void {
    const startedAt = Date.now()
    const check = async () => {
      if (!state.transport || Date.now() - startedAt > MCP_SIGN_IN_WATCH_MS) return
      await refreshMcpServers(state)
      const known = state.input.workspaceRoot
        ? mcpServerStatusFor('codex', state.input.workspaceRoot).get(serverId)
        : null
      if (known && known.status !== 'needs-auth' && known.status !== 'pending') return
      setTimeout(() => void check(), MCP_SIGN_IN_POLL_MS).unref?.()
    }
    setTimeout(() => void check(), MCP_SIGN_IN_POLL_MS).unref?.()
  }

  async function ensureConnected(state: Session) {
    if (state.transport) return
    if (state.starting) return state.starting
    state.starting = (async () => {
      // A chat on a WSL machine runs that machine's `codex`, with the login
      // and `config.toml` under its Linux home; everything below is the same.
      const wsl = await wslTargetForHost(
        state.input.cliRuntimes?.codex?.hostId,
        options.prepareWslTarget ?? prepareWslCliTarget,
      )
      if (state.closed) throw new Error('Codex conversation was closed.')
      const command = await (options.resolveExecutable ?? resolveExecutable)(state.input)
      const env = await (options.buildEnv ?? buildEnv)(state.input)
      const hostId = state.input.cliRuntimes?.codex?.hostId
      const gateway = await options.resolveStudioMcpServer?.({ ...(hostId ? { hostId } : {}) }).catch(() => null)
      // Only a chat that has the gateway has the worktree pool's tools, and
      // only one in a git checkout has a repository to lease a worktree of.
      const leasesWorktrees = Boolean(gateway) && (await isInGitCheckout(state.input.workspaceRoot))
      if (state.closed) throw new Error('Codex conversation was closed.')
      state.wsl = wsl
      // The app's gateway beside the session's own servers. The app-server is
      // issued its own gateway token as it starts (its environment names the
      // chat), and Codex starts a server with only the variables its entry
      // names, so the entry names the token's and never carries it: these
      // overrides are the app-server's command line.
      const mcpServers = withStudioGateway(
        gateway
          ? studioGatewayForChat(
              gateway,
              { workspaceId: state.input.workspaceId, agentId: state.input.agentId, cli: 'codex' },
              { byName: true },
            )
          : null,
        state.input.mcpServers ?? [],
      )
      const transport = (options.createTransport ?? createCodexRpcTransport)({
        command,
        cwd: state.input.workspaceRoot ?? '',
        env,
        wsl: wsl ? codexWslChild(wsl) : null,
        args: [
          ...codexAppServerArgs(env.SPRINTENGINE_CODEX_APP_SERVER_ARGS),
          // The gateway and the session's own MCP servers, as config overrides
          // on top of the person's own `config.toml`, for this process only.
          // The gateway's override is merged into an entry a terminal launch
          // pinned into the workspace's `.codex/config.toml` under the same
          // name, so the app-server starts one gateway, the launch's.
          ...codexMcpServerArgs(wsl ? mcpServersOnWsl(mcpServers) : mcpServers),
        ],
        onMessage: (message) => onMessage(state, message),
        onToolFailure: (reason) => toolFailure(state, reason),
        onClose: (error) => {
          if (state.transport !== transport) return
          state.transport = null
          state.spawnedAt = null
          stopLanes(state, 'The agent stopped when its Codex process ended.')
          finish(state, error.message)
        },
      })
      state.transport = transport
      state.spawnedAt = Date.now()
      try {
        await transport.request('initialize', CODEX_INITIALIZE)
        transport.notify('initialized', {})
        const account = record(await transport.request('account/read', { refreshToken: false }))
        if (account.requiresOpenaiAuth === true && !account.account)
          throw new Error('Codex is not logged in. Run codex login in a terminal, then retry.')
        noteCodexAccount(state, transport, account)
        const policy = codexPermissionPolicy(state.input.permissionPreset, state.input.permissionMode)
        const threadParams = {
          cwd: state.input.workspaceRoot === undefined ? undefined : hostCwd(state.input.workspaceRoot, wsl),
          ...(state.input.modelId !== CONVERSATION_DEFAULT_MODEL_ID ? { model: state.input.modelId } : {}),
          ...(policy.approvalPolicy
            ? {
                approvalPolicy: policy.approvalPolicy,
                approvalsReviewer: policy.approvalsReviewer,
                sandbox: policy.sandbox,
              }
            : {}),
          ...(leasesWorktrees
            ? await codexDeveloperInstructions(
                transport,
                state.input.workspaceRoot === undefined ? undefined : hostCwd(state.input.workspaceRoot, wsl),
              )
            : {}),
        }
        let resumeLost = false
        let forkLost = false
        let result: RecordValue
        if (state.forkFrom) {
          // A fork's thread is the parent's, through the turn it was forked
          // at. One Codex cannot branch there, because the thread or that turn
          // of it is gone, carries the conversation over as a lost resume does:
          // a saved point it refuses would otherwise refuse every start.
          const from = state.forkFrom
          const params: ThreadForkParams = { ...threadParams, threadId: from.threadId, lastTurnId: from.lastTurnId }
          try {
            result = record(await transport.request('thread/fork', params))
          } catch (error) {
            if (!isUnusableForkPoint(error)) throw error
            result = record(await transport.request('thread/start', threadParams))
            forkLost = true
          }
        } else if (state.threadId) {
          try {
            result = record(await transport.request('thread/resume', { ...threadParams, threadId: state.threadId }))
          } catch (error) {
            // Codex no longer has the thread (its history was cleared, or the
            // cursor came from another machine). Retrying the same id would
            // fail on every turn, so continue in a new thread, carry the
            // conversation over as context, and say so. Any other answer — the
            // thread is busy, a rate limit — fails this turn and keeps the id,
            // since the thread is still there to resume next time.
            if (!isMissingThreadError(error)) throw error
            result = record(await transport.request('thread/start', threadParams))
            resumeLost = true
          }
        } else result = record(await transport.request('thread/start', threadParams))
        const id = text(record(result.thread).id)
        if (!id) throw new Error('Codex did not return a conversation identity.')
        state.threadId = id
        state.forkFrom = null
        void publishSkills(state)
        void refreshMcpServers(state)
        if (resumeLost || forkLost) state.replayHistory = true
        emit(state, 'session_updated', {
          providerSessionId: id,
          ...(resumeLost
            ? {
                notice:
                  'The previous Codex thread could not be resumed, so this conversation continues in a new thread. The earlier messages were passed to it as context.',
              }
            : forkLost
              ? {
                  notice:
                    'Codex could not branch the thread this chat was forked from at that point, so it continues in a new thread. The earlier messages were passed to it as context.',
                }
              : {}),
        })
      } catch (error) {
        state.transport = null
        state.spawnedAt = null
        transport.close()
        if (error instanceof CodexSpawnError) forgetExecutable('codex')
        // A start Codex never answered says what to try, on which machine,
        // and names an oversized log database when that is the likely cause.
        if (isCodexInitializeTimeout(error))
          throw await explainCodexInitializeTimeout({
            timeoutMs: CODEX_RPC_TIMEOUT_MS,
            wslDistro: wsl?.distro ?? null,
            env,
            ...(options.readCodexLogBytes ? { readLogBytes: options.readCodexLogBytes } : {}),
          })
        throw error
      }
    })().finally(() => {
      state.starting = undefined
    })
    return state.starting
  }
  return {
    id: CODEX_CONVERSATION_PROVIDER_ID,
    displayName: 'Codex',
    executionHostCli: 'codex',
    sessions: 'stateful',
    acceptsMcpServers: true,
    listModels: () => [...models],
    capabilities: {
      permissionModes: [...conversationPermissionModes('codex')],
      tools: true,
      approvals: true,
      questions: true,
      planMode: false,
      images: true,
      skills: 'context',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      interrupt: true,
      resume: true,
      subagents: false,
      cost: false,
      contextMeter: false,
      liveModelSwitch: true,
      mcpServerActions: ['reconnect', 'sign-in'],
      fork: true,
    },
    // A fork branches the parent's thread through the turn it was made at,
    // on its first connection. Without a turn to name, the fork starts a
    // thread of its own and its first message carries the conversation.
    async fork(input) {
      return { ok: true, cursor: input.exact && input.cursor?.at ? input.cursor : null }
    },
    startSession(input) {
      // A cursor with a point in it is a fork's: Codex never rewinds.
      const forkFrom =
        input.resumeSessionId && input.resumeSessionAt
          ? { threadId: input.resumeSessionId, lastTurnId: input.resumeSessionAt }
          : null
      const state: Session = {
        input,
        closed: false,
        threadId: forkFrom ? null : (input.resumeSessionId ?? null),
        forkFrom,
        transport: null,
        turn: null,
        pending: new Map(),
        history: [],
        replayHistory: input.seedFromHistory === true,
        lastActivityAt: Date.now(),
        spawnedAt: null,
        children: new Map(),
        failedServers: new Set(),
        wsl: null,
      }
      sessions.set(input.sessionId, state)
      // The app-server starts with the first turn, and its skills follow. Until
      // then the menu offers what needs no app-server to know, unless a list
      // for this folder is already in hand. It goes in as not yet answered
      // (`fetchedAt` 0): the folder's skills are still to be asked for, and a
      // stand-in must neither hold that ask off nor be cached as the answer.
      if (input.workspaceRoot && !conversationCommandsFor('codex', input.workspaceRoot).commands.length)
        publishConversationCommands({
          cli: 'codex',
          cwd: input.workspaceRoot,
          commands: [CODEX_COMPACT_COMMAND],
          fetchedAt: 0,
        })
      return [event(state, 'session_started'), event(state, 'session_ready')]
    },
    async *sendTurn(input: MockAdapterTurnInput) {
      const state = sessions.get(input.sessionId)
      if (!state) throw new Error('Codex conversation is not active.')
      // A stopped turn Codex has not confirmed yet is over from the person's
      // side: wait for it (the watchdog bounds the wait) rather than refuse.
      if (state.turn?.cancelled) await state.turn.ended
      if (state.turn) throw new Error('Codex is already running a turn.')
      if (input.mode === 'plan') throw new Error('This Codex connection does not support plan mode.')
      const compact = codexCompactRequest(input.message, input.attachments?.length ?? 0)
      const queue = new EventQueue()
      let settle = () => {}
      const ended = new Promise<void>((resolve) => {
        settle = resolve
      })
      state.turn = {
        id: input.turnId,
        cancelled: false,
        interrupting: null,
        watchdog: null,
        ended,
        settle,
        nativeId: null,
        queue,
        textItems: new Set(),
        textItem: null,
        items: new Map(),
        outputBytes: new Map(),
        deferredApprovals: new Map(),
        message: input.message,
        text: '',
        reply: '',
        replyItem: null,
        usage: null,
        compact: compact !== null,
        notes: new Set(),
        plans: 0,
      }
      emit(state, 'turn_started')
      const abort = () => {
        void interrupt(state).catch((error: unknown) =>
          finish(state, error instanceof Error ? error.message : 'Could not interrupt Codex.'),
        )
      }
      input.signal?.addEventListener('abort', abort, { once: true })
      void (async () => {
        try {
          if (compact === 'refuse')
            return finish(
              state,
              'Send /compact on its own: Codex compacts the conversation without instructions or images.',
              false,
              true,
            )
          // A thread that has not had a turn yet has nothing to summarise; a
          // fork's has the turns it was forked with.
          if (compact && !state.threadId && !state.forkFrom && !state.history.length)
            return finish(state, 'There is no conversation to compact yet.', false, true)
          // Capture before starting the autonomous turn, not after an edit notification.
          await state.input.onBeforeTool?.('Edit')
          if (state.resetPolicy) restartForPolicy(state)
          await ensureConnected(state)
          if (state.closed || !state.turn || state.turn.cancelled || input.signal?.aborted) {
            finish(state, undefined, true)
            return
          }
          // Compaction is a turn of its own on Codex's side: `turn/started`,
          // a `contextCompaction` item and `turn/completed` arrive as for any
          // turn and close this one. Sent as text it would only reach the
          // model as a message to answer.
          if (compact) {
            await state.transport!.request('thread/compact/start', { threadId: state.threadId })
            if (state.turn?.cancelled || input.signal?.aborted) await interrupt(state)
            return
          }
          // Ask can inspect, never escalate an attempted write through approval.
          // This turn-only sandbox also overrides a remembered bypass preset.
          const policy: ReturnType<typeof codexPermissionPolicy> =
            input.mode === 'ask'
              ? { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
              : codexPermissionPolicy(state.input.permissionPreset, state.input.permissionMode)
          // The Ask override stays with the thread like any other. A session
          // whose own preset sends none (`none`) would keep it on every turn
          // after, read-only; the next turn restarts so the thread resumes
          // without it, as leaving an override for `none` does.
          if (input.mode === 'ask' && !codexPermissionPolicy(state.input.permissionPreset).approvalPolicy)
            state.resetPolicy = true
          const seeding = state.replayHistory
          const result = record(
            await state.transport!.request('turn/start', {
              threadId: state.threadId,
              ...(input.modelId !== CONVERSATION_DEFAULT_MODEL_ID ? { model: input.modelId } : {}),
              ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
              input: [
                { type: 'text', text: withReplayedHistory(state, input.message), text_elements: [] },
                ...(input.attachments ?? []).map((attachment) => ({
                  type: 'image',
                  url: `data:${attachment.mediaType};base64,${attachment.dataBase64}`,
                })),
              ],
              ...(policy.approvalPolicy
                ? {
                    approvalPolicy: policy.approvalPolicy,
                    approvalsReviewer: policy.approvalsReviewer,
                    sandboxPolicy: policy.sandboxPolicy,
                  }
                : {}),
            }),
          )
          if (state.turn) state.turn.nativeId = text(record(result.turn).id) || state.turn.nativeId
          // Codex has the conversation now; until here a failed start owes it
          // to the next message, after a restart too (`historySeeded`).
          if (seeding) {
            state.replayHistory = false
            emit(state, 'session_updated', { historySeeded: true })
          }
          if (state.turn?.cancelled || input.signal?.aborted) await interrupt(state)
        } catch (error) {
          finish(state, error instanceof Error ? error.message : 'Codex could not start this turn.')
        }
      })()
      try {
        yield* queue
      } finally {
        input.signal?.removeEventListener('abort', abort)
      }
    },
    resolveApproval(input) {
      const state = sessions.get(input.sessionId),
        pending = state?.pending.get(input.requestId)
      if (!state || !pending || !state.transport) throw new Error('This Codex approval is no longer pending.')
      if (pending.kind === 'question') {
        const answers: Record<string, { answers: string[] }> = {}
        for (const question of pending.questions ?? [])
          answers[text(question.id)] = {
            answers: input.approved ? [input.answers?.[text(question.question)] ?? ''] : [],
          }
        state.transport.respond(pending.rpcId, { answers })
      } else state.transport.respond(pending.rpcId, { decision: input.approved ? 'accept' : 'decline' })
      state.pending.delete(input.requestId)
      emit(state, 'approval_resolved', {
        requestId: input.requestId,
        approved: input.approved,
        ...(input.answers ? { answers: input.answers } : {}),
      })
      return []
    },
    async interrupt(input) {
      const state = sessions.get(input.sessionId)
      const turn = state?.turn
      if (!state || !turn) return []
      try {
        await interrupt(state)
      } catch (error) {
        // The watchdog already ended the turn and closed the app-server, which
        // is what rejected the request: the stop has happened.
        if (state.turn === turn) throw error
      }
      // Codex answering the request has only taken the stop: the turn runs on
      // until its `turn/completed`, and a patch it was applying can still land
      // before then. Returning only once the turn has ended (or the watchdog
      // has given up on it) lets the runtime end the turn, and capture its
      // files, after the last change Codex made.
      await turn.ended
      return []
    },
    stopSession(input) {
      const state = sessions.get(input.sessionId)
      if (!state) return []
      state.closed = true
      stopLanes(state, 'The agent stopped when its conversation ended.')
      finish(state, undefined, true)
      state.transport?.close()
      sessions.delete(input.sessionId)
      return [event(state, 'session_closed')]
    },
    // Every preset but `none` rides the next `turn/start` (codexPermissionPolicy),
    // so a change needs no restart and is accepted mid-turn as well: the turn
    // already running keeps the policy it started with, and the runtime answers
    // what it still asks by the new mode. A turn's override stays with the
    // thread for the turns after it, though, so omitting one cannot take a
    // thread back to Codex's configured default. Moving to `none` is therefore
    // a reconnect: the app-server is closed, and the next turn resumes the
    // thread with no override (ensureConnected), the way it would after the
    // idle reaper. Mid-turn that waits for the next message.
    async setPermissionPreset(input) {
      const state = sessions.get(input.sessionId)
      if (!state) return { ok: false, message: 'Codex conversation is not active.' }
      const previous = state.input.permissionPreset ?? 'none'
      state.input = { ...state.input, permissionPreset: input.permissionPreset, permissionMode: input.permissionMode }
      if (input.permissionPreset === 'none' && previous !== 'none') state.resetPolicy = true
      else if (input.permissionPreset !== 'none') state.resetPolicy = false
      if (state.turn) return { ok: true, notice: 'Codex takes the new permissions from your next message.' }
      if (state.resetPolicy) restartForPolicy(state)
      return { ok: true }
    },
    // Codex takes the model on every `turn/start`, and the runtime hands each
    // turn the session's current model, so a switch needs no reconnect: it is
    // recorded here for a thread resume and simply rides the next turn. The
    // turn already running keeps the model it started with.
    // Codex reloads every server from its config on a reconnect; switching
    // one on or off is its `config.toml`'s, not a running thread's.
    async mcpServerAction(input) {
      const state = sessions.get(input.sessionId)
      if (!state) return { ok: false, message: 'Codex conversation is not active.' }
      try {
        await ensureConnected(state)
        const transport = state.transport
        if (!transport) return { ok: false, message: 'Codex is not running for this chat.' }
        if (input.action === 'reconnect') await transport.request('config/mcpServer/reload', undefined)
        else if (input.action === 'sign-in') {
          const answer = record(
            await transport.request('mcpServer/oauth/login', {
              name: input.serverId,
              ...(state.threadId ? { threadId: state.threadId } : {}),
            }),
          )
          watchSignIn(state, input.serverId)
          const authUrl = text(answer.authorizationUrl)
          return { ok: true, ...(/^https?:\/\//u.test(authUrl) ? { authUrl } : {}) }
        } else return { ok: false, message: 'Codex switches its MCP servers on and off in its config.toml.' }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Codex refused that.' }
      }
      await refreshMcpServers(state)
      return { ok: true }
    },
    async setModel(input) {
      const state = sessions.get(input.sessionId)
      if (!state) return { ok: false, message: 'Codex conversation is not active.' }
      state.input = { ...state.input, modelId: input.nextModelId }
      return state.turn
        ? {
            ok: true,
            notice: 'The new model starts with your next message — this reply finishes on the model it started with.',
          }
        : { ok: true }
    },
    listLiveSessions: () =>
      [...sessions.values()].map((state) => ({
        sessionId: state.input.sessionId,
        workspaceId: state.input.workspaceId,
        agentId: state.input.agentId,
        workspaceRoot: state.input.workspaceRoot ?? '',
        providerSessionId: state.threadId,
        hasChildProcess: state.transport?.pid != null,
        childPid: state.transport?.pid ?? null,
        turnActive: Boolean(state.turn),
        pendingApproval: state.pending.size > 0,
        lastActivityAt: state.lastActivityAt,
        spawnedAt: state.spawnedAt,
      })),
    // A running turn keeps its process, except one already stopped: Settle
    // and Snooze interrupt and then dispose straight away, before Codex has
    // confirmed the interrupt, and the process has nothing left to do. A
    // subagent still working lives in this process too, and keeps it from the
    // idle sweep; `force` (Settle, Snooze) ends it with the process.
    disposeChildProcess(sessionId, options) {
      const state = sessions.get(sessionId)
      if (!state?.transport) return false
      if (
        !options?.force &&
        ((state.turn && !state.turn.cancelled) || [...state.children.values()].some((child) => !child.done))
      )
        return false
      abandonTurn(state)
      return true
    },
    disposeAll() {
      for (const state of sessions.values()) {
        state.closed = true
        finish(state, undefined, true)
        state.transport?.close()
      }
      sessions.clear()
    },
  }
}

// The first message to a thread that replaced a lost one, or that starts a
// fork Codex could not branch, carries the conversation so far, which is the
// only context the new thread gets.
function withReplayedHistory(state: Session, message: string): string {
  if (!state.replayHistory) return message
  const prior = [
    ...(state.input.fallbackHistory ?? []).map((entry) => `${entry.role}: ${entry.content}`),
    ...state.history.map((turn) => `User: ${turn.user}\nAssistant: ${turn.assistant}`),
  ].join('\n\n')
  return prior ? `Previous conversation:\n${prior}\n\nUser: ${message}` : message
}

// The executable could not be started from where it was found: look it up
// again on the next start.
function forgetExecutable(cli: 'codex') {
  void import('../cli-runtime-install').then(({ invalidateCliExecutable }) => invalidateCliExecutable(cli))
}
async function resolveExecutable(input: Pick<MockAdapterSessionInput, 'cliRuntimes'>): Promise<string> {
  const { resolveCliExecutable } = await import('../cli-runtime-install')
  const runtime = input.cliRuntimes?.codex
  const found = await resolveCliExecutable('codex', runtime)
  if (!found.path) {
    if (isWslHostId(runtime?.hostId))
      throw new Error(
        `Codex CLI was not found on ${hostMachineName(runtime.hostId)}. Install it in that distribution (or set its command for that machine in Settings) to chat there.` +
          (found.error ? ` ${found.error}` : ''),
      )
    throw new Error('Codex CLI is not installed. Install it or configure its command in Settings.')
  }
  return found.path
}

// The workspace folder as Codex names it: the Linux spelling for an
// app-server in WSL (`/home/…`, `/mnt/c/…`), this machine's otherwise.
function hostCwd(cwd: string, wsl: WslCliTarget | null): string {
  return wsl ? toWslPath(cwd) : cwd
}

// Auth that would take a chat's Codex off the person's login.
const CODEX_STRIPPED_AUTH_ENV_KEYS = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
] as const

/**
 * What an app-server in WSL is started with of the chat's environment: its
 * identity, and none of the API auth the profile there may export, for the
 * reason `codexChildEnv` strips it here.
 */
export function codexWslChild(target: WslCliTarget): WslCliChild {
  return { ...target, forwardEnv: CONVERSATION_IDENTITY_ENV_KEYS, unsetEnv: CODEX_STRIPPED_AUTH_ENV_KEYS }
}
async function buildEnv(input: MockAdapterSessionInput): Promise<NodeJS.ProcessEnv> {
  const { getTerminalEnv, applyAgentIdentityEnv } = await import('../terminal-launch')
  return codexChildEnv(
    applyAgentIdentityEnv(getTerminalEnv(), { workspaceId: input.workspaceId, agentId: input.agentId }),
    input,
  )
}

/** The environment a conversation's Codex child starts with. Conversations
 * are subscription-authenticated by contract, the rule the Claude provider
 * enforces too: an inherited OpenAI key would silently bill API usage instead
 * of the person's Codex login, and headless chat has no CLI chrome to say so. */
export function codexChildEnv(env: NodeJS.ProcessEnv, input: Pick<MockAdapterSessionInput, 'sessionId'>) {
  const next = { ...env }
  for (const key of [...CODEX_STRIPPED_AUTH_ENV_KEYS, 'ELECTRON_RUN_AS_NODE']) delete next[key]
  next.SPRINTENGINE_CONVERSATION_SESSION_ID = input.sessionId
  return next
}

/**
 * Codex's `/` menu for a folder before any chat there has started, published
 * for the composer. A short-lived app-server is asked only for its skills and
 * closed: it opens no thread and needs no sign-in, so it leaves nothing behind
 * and costs no model call.
 */
export async function probeCodexConversationCommands(
  input: { cwd: string; cliRuntimes?: ConversationCliRuntimeOverrides },
  options: {
    resolveExecutable?: (input: Pick<MockAdapterSessionInput, 'cliRuntimes'>) => Promise<string>
    buildEnv?: () => Promise<NodeJS.ProcessEnv>
    createTransport?: (options: CodexRpcOptions) => CodexRpcTransport
    prepareWslTarget?: (hostId: ExecutionHostId) => Promise<WslCliTarget>
  } = {},
): Promise<ConversationCommand[]> {
  const wsl = await wslTargetForHost(input.cliRuntimes?.codex?.hostId, options.prepareWslTarget ?? prepareWslCliTarget)
  const command = await (options.resolveExecutable ?? resolveExecutable)(input)
  const env =
    (await options.buildEnv?.()) ??
    (await (async () => {
      const { getTerminalEnv } = await import('../terminal-launch')
      const next = codexChildEnv(getTerminalEnv(), { sessionId: '' })
      delete next.SPRINTENGINE_CONVERSATION_SESSION_ID
      return next
    })())
  const transport = (options.createTransport ?? createCodexRpcTransport)({
    command,
    cwd: input.cwd,
    env,
    // It opens no thread, so it starts no MCP server and is issued no token.
    wsl: wsl ? codexWslChild({ distro: wsl.distro, agentStateSocketPath: wsl.agentStateSocketPath }) : null,
    args: codexAppServerArgs(env.SPRINTENGINE_CODEX_APP_SERVER_ARGS),
    onMessage: () => undefined,
    onClose: () => undefined,
    timeoutMs: 15_000,
  })
  const codexCwd = hostCwd(input.cwd, wsl)
  try {
    await transport.request('initialize', CODEX_INITIALIZE)
    transport.notify('initialized', {})
    const commands = codexConversationCommands(await transport.request('skills/list', { cwds: [codexCwd] }), codexCwd)
    publishConversationCommands({ cli: 'codex', cwd: input.cwd, commands })
    return commands
  } finally {
    transport.close()
  }
}

/**
 * Studio's worktree line, as the thread's developer instructions (taken by
 * `thread/start`, `thread/resume` and `thread/fork` alike). A thread's own
 * replace the `developer_instructions` the person set in their config rather
 * than adding to them, so theirs are read first and kept ahead of Studio's.
 * A Codex that cannot say what they are is given nothing, rather than having
 * them overwritten.
 */
async function codexDeveloperInstructions(
  transport: Pick<CodexRpcTransport, 'request'>,
  cwd: string | undefined,
): Promise<{ developerInstructions?: string }> {
  const line = worktreeLeaseInstruction(GATEWAY_WORKTREE_LEASE_TOOLS)
  try {
    const answer = record(await transport.request('config/read', { ...(cwd ? { cwd } : {}) }))
    const own = text(record(answer.config).developer_instructions).trim()
    return { developerInstructions: own ? `${own}\n\n${line}` : line }
  } catch {
    return {}
  }
}

/**
 * Codex's answer to `thread/fork` says the point cannot be branched at all: the
 * thread is gone, or it has no such turn to fork through (or that turn cannot
 * be the end of a fork). Anything else, a busy thread or a rate limit, may
 * pass, and keeps the point for the next message.
 */
function isUnusableForkPoint(error: unknown): boolean {
  return (
    isMissingThreadError(error) ||
    (error instanceof CodexRpcError &&
      /turn/i.test(error.message) &&
      /not found|unknown|invalid|no such|in progress/i.test(error.message))
  )
}

/** Codex's answer to `thread/resume` says the thread does not exist, rather than that it cannot be used right now. */
function isMissingThreadError(error: unknown): boolean {
  return (
    error instanceof CodexRpcError &&
    /not found|no rollout|no such thread|unknown thread|invalid thread id|does not exist/i.test(error.message)
  )
}

// A subagent's name from its path in the agent tree (`/root/reviewer`).
function agentName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? 'Codex agent'
}

// The first line of a spawn prompt, short enough for a lane's title.
function summarize(prompt: string): string {
  const line = prompt.trim().split('\n')[0] ?? ''
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

/** Writes a picture Codex generated but did not save, beside the app's other conversation data. */
async function saveGeneratedImage(input: { sessionId: string; itemId: string; base64: string }): Promise<string> {
  const safe = (value: string) => value.replace(/[^\w.-]/g, '_')
  const bytes = Buffer.from(input.base64, 'base64')
  const dir = join(studioPlatform().paths.dataDir(), 'conversation-images', safe(input.sessionId))
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${safe(input.itemId)}.${imageExtension(bytes)}`)
  await writeFile(file, bytes)
  return file
}

function imageExtension(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg'
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP')
    return 'webp'
  return 'png'
}

/**
 * A session's MCP servers as `-c mcp_servers.<id>=<table>` overrides for the
 * app-server, each an inline TOML table with the fields the person's own
 * `config.toml` would carry (mcp-config-service.ts writes the same ones).
 * Codex reads an override's key as a dotted path, so an id with a dot in it
 * cannot be named and refuses the start.
 */
// How long, and how often, a server's state is read again after a sign-in.
const MCP_SIGN_IN_WATCH_MS = 5 * 60_000
const MCP_SIGN_IN_POLL_MS = 3_000

/** A server in Codex's status list, as the picker says its connection; null for one not started. */
function codexServerStatus(runtime: string, auth: string): AgentMcpServerStatus | null {
  if (runtime === 'connected') return 'connected'
  if (runtime === 'authenticationRequired' || auth === 'notLoggedIn') return 'needs-auth'
  if (runtime === 'failed') return 'failed'
  if (runtime === 'starting') return 'pending'
  return null
}

/** Codex's startup states, as the picker says a server's connection. */
const CODEX_MCP_STATUS: Readonly<Record<string, AgentMcpServerStatus>> = {
  starting: 'pending',
  ready: 'connected',
  failed: 'failed',
}

export function codexMcpServerArgs(servers: readonly ConversationMcpServer[]): string[] {
  const str = (value: string): string => JSON.stringify(value)
  const table = (entries: Array<[string, string]>): string =>
    `{ ${entries.map(([key, value]) => `${str(key)} = ${value}`).join(', ')} }`
  const list = (values: readonly string[]): string => `[${values.map(str).join(', ')}]`
  return servers.flatMap((server) => {
    if (server.id.includes('.') || !server.id.trim()) {
      throw new Error(
        `Codex cannot be given the MCP server "${server.name || server.id}": its id "${server.id}" is not a Codex config key.`,
      )
    }
    const fields: Array<[string, string]> = []
    if (server.transport === 'stdio') {
      fields.push(['command', str(server.command ?? '')])
      if (server.args?.length) fields.push(['args', list(server.args)])
      if (server.envVarNames?.length) fields.push(['env_vars', list(server.envVarNames)])
      if (server.env && Object.keys(server.env).length > 0)
        fields.push(['env', table(Object.entries(server.env).map(([key, value]) => [key, str(value)]))])
    } else {
      fields.push(['url', str(server.url ?? '')])
      if (server.envVarNames?.length) fields.push(['bearer_token_env_var', str(server.envVarNames[0])])
      const headers = Object.entries(server.headers ?? {}).filter(
        ([key]) => !server.envVarNames?.length || key.toLowerCase() !== 'authorization',
      )
      if (headers.length > 0) fields.push(['http_headers', table(headers.map(([key, value]) => [key, str(value)]))])
    }
    return ['-c', `mcp_servers.${server.id}=${table(fields)}`]
  })
}
