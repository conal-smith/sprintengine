// Stateful conversation provider backed by the Claude Agent SDK.
//
// Spawns the user's own installed Claude Code CLI headlessly (subscription
// auth — whatever `claude auth login` already holds; no API key touches this
// path) and maps the SDK's message stream onto the studio's canonical
// ConversationEvents. One long-lived child process per session, kept across
// turns via the SDK's streaming-input mode; the CLI session id is surfaced as
// `session_updated` events so the runtime can resume natively after the
// process (or the whole app) goes away.
//
// All Claude Agent SDK types are confined to this file on purpose — the SDK
// moves fast, so version churn must not leak past this adapter. The package
// is ESM-only and the main bundle is CJS, so the SDK is loaded via dynamic
// import on first use.
import { saveToolResultImages, toolResultImages, type SaveToolResultImages } from './tool-result-images'
import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConfinedExistingFile, readBoundedConversationFile } from '../conversation-file-access'
import { asRecord } from '../../shared/records'
import { CONVERSATION_DEFAULT_MODEL_ID, conversationPermissionModes } from '../../shared/conversation-harness'
import { isWslHostId, type ExecutionHostId } from '../../shared/execution-host'
import { isWindowsPath, toWslPath } from '../../shared/host-paths'
import { isLooserCliPermissionPreset } from '../../shared/cli-permission-preset'
import { AGENT_IDENTITY_ENV_KEYS, MCP_CHANNEL_TOKEN_ENV } from '../../shared/studio-env'
import { inferConversationToolKind } from '../../shared/conversation/toolKind'
import { summarizeToolInput } from '../../shared/conversation/approvalSummary'
import { normalizeApiKeySource } from '../../shared/conversation/apiKeySource'
import { usageLimitsStore } from '../usage-limits/store'
import {
  claudeBillingOf,
  claudeBillingOfAccount,
  isClaudeUsageLimitResult,
  readClaudeRateLimitInfo,
  useClaudeUsageLimitPrefixes,
} from '../usage-limits/sources'
import type { PromptCacheTtl } from '../../shared/prompt-cache'
import { leadingCommandFor, leadingSlashCommand } from '../conversation-commands/leading-command'
import {
  conversationCommandsFor,
  publishConversationCommands,
  touchConversationCommands,
} from '../conversation-commands/registry'
import {
  prepareWslClaudeTarget,
  spawnWslClaude,
  type ClaudeSpawnRequest,
  type WslClaudeTarget,
} from './claude-wsl-child'
import { raiseChildOomScore } from '../agent-oom-score'
import { localLaunchToken } from './cli-host-child'
import { launchIdentityOfEnv } from '../../server/core/gateway-launch-tokens'
import { processIsRunning } from '../../server/platform/process-alive'
import {
  CLAUDE_COMMANDS_CLI,
  claudeCommandsFromInit,
  initSkillNames,
  initTerminalCommands,
  mapClaudeCommands,
  sameCommandNames,
} from '../conversation-commands/claude'
import { isBackgroundLaunchAck, isSubagentStep } from '../../shared/conversation/subagents'
export { summarizeToolInput } from '../../shared/conversation/approvalSummary'
import { cliStderrSummary, LOOKUP_TOOL_KINDS } from '../../shared/conversation/permissionModes'
import { wslShareSafeDirectoryEnv } from '../git-run'
import { isMcpServerStatus, publishMcpServerStatus } from '../mcp-server-status/registry'
import type { AgentMcpServerStatus } from '../../shared/skills'

import type {
  Options,
  PermissionResult,
  Query,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'

import type {
  ConversationBackgroundTask,
  ConversationBackgroundTaskKind,
  ConversationCliRuntimeOverrides,
  ConversationEvent,
  ConversationImageAttachment,
  ConversationMcpServer,
  ConversationPermissionPreset,
  ConversationQuestion,
  ConversationSubagentMessagePayload,
  ConversationSubagentState,
  ConversationSubagentStatusPayload,
  ConversationToolOutputPayload,
  ConversationToolStartedPayload,
  ConversationTurnRetryingPayload,
  ConversationTurnUsage,
} from '../../shared/conversation-runtime'
import { addTurnUsage, turnUsageOf } from '../../shared/conversation/turn-usage'
import type {
  ConversationProviderAdapter,
  ConversationProviderForkResult,
  ConversationProviderLiveSession,
  ConversationProviderPermissionResult,
  ConversationSessionEventSink,
  MockAdapterApprovalInput,
  MockAdapterForkInput,
  MockAdapterModelInput,
  MockAdapterPermissionInput,
  MockAdapterRewindInput,
  MockAdapterSessionInput,
  MockAdapterSteerInput,
  MockAdapterTurnInput,
  ConversationProviderSteerResult,
  ConversationDisposeOptions,
} from './conversation-provider-adapter'

export const CLAUDE_AGENT_PROVIDER_ID = 'claude-agent'
// The CLI accepts these on --model regardless of account tier; they track the
// CLI's own vocabulary rather than a remote catalog. Tier aliases float to
// whatever that tier currently resolves to; a full model id pins one release.
// Keep in sync with resources/plugins/claude-agent/plugin.json `models`.
const CLAUDE_AGENT_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'sonnet', 'opus', 'haiku'] as const

// Env marker so process-tree diagnostics can attribute the headless child to
// its conversation session (the SDK exposes no child PID).
export const CLAUDE_AGENT_SESSION_ENV_KEY = 'SPRINTENGINE_CONVERSATION_SESSION_ID'

type SdkQueryFunction = typeof import('@anthropic-ai/claude-agent-sdk').query

export type ClaudeAgentProviderOptions = {
  // Injectable seams for tests; defaults wire the real SDK + CLI detection.
  loadQuery?: () => Promise<SdkQueryFunction>
  resolveExecutable?: (cliRuntimes?: ConversationCliRuntimeOverrides) => Promise<string>
  buildEnv?: (input: {
    workspaceId: string
    agentId: string
    sessionId: string
  }) => Record<string, string> | Promise<Record<string, string>>
  now?: () => number
  // Where attached-skill plugins are staged; tests point it at their own folder.
  tempDir?: string
  // Readies a WSL machine for a chat whose `claude` runs there; tests stand in.
  prepareWslTarget?: (hostId: ExecutionHostId) => Promise<WslClaudeTarget>
  // Starts the child inside that machine; tests stand in.
  spawnWslChild?: (target: WslClaudeTarget, request: ClaudeSpawnRequest) => ChildProcess
  // How long a child has to answer a stop or a mode switch before it is taken
  // to be wedged. Tests shorten it.
  childAnswerTimeoutMs?: number
  // The app's own MCP gateway on the machine the child runs on, handed to
  // every child. Null or absent leaves it out.
  resolveStudioMcpServer?: (input: { hostId?: ExecutionHostId }) => Promise<ConversationMcpServer | null>
}

export type ClaudeAgentProviderAdapter = ConversationProviderAdapter & {
  listLiveSessions(): ConversationProviderLiveSession[]
  // Claude's child is always disposed; `force` changes nothing here.
  disposeChildProcess(sessionId: string, options?: ConversationDisposeOptions): boolean
  stopBackgroundTasks(sessionId: string): Promise<boolean>
  disposeAll(): Promise<void>
  setPermissionPreset(input: MockAdapterPermissionInput): Promise<ConversationProviderPermissionResult>
  setModel(input: MockAdapterModelInput): Promise<ConversationProviderPermissionResult>
  rewind(input: MockAdapterRewindInput): Promise<ConversationProviderPermissionResult>
  fork(input: MockAdapterForkInput): Promise<ConversationProviderForkResult>
  steer(input: MockAdapterSteerInput): Promise<ConversationProviderSteerResult>
}

type PermissionDecision = {
  approved: boolean
  answers?: Record<string, string>
}

type PendingPermissionResolve = (decision: PermissionDecision) => void

// A permission callback the child is blocked on, tagged with the turn whose
// card carries it — ending that turn must resolve it, or the child waits
// forever on a card nobody can answer.
type PendingPermission = {
  turnId: string
  resolve: PendingPermissionResolve
  // Whether bypass would have answered it without asking: switching to bypass
  // while it waits answers it the same way.
  bypassable: boolean
}

// A spawned agent the child reported through its task messages, keyed by the
// tool call that spawned it.
type TrackedSubagent = {
  taskId: string
  toolUseId: string
  background: boolean
  subagentType?: string
  description?: string
  // The agent's latest text: its answer, once it has finished.
  lastText?: string
  endedAt?: number
  error?: string
}

// A task the child reported that is not an agent: a shell, a monitor, a
// workflow. `background` once it runs on past the call that started it; a
// foreground one is the turn's own work and is not listed.
type TrackedTask = { task: ConversationBackgroundTask; background: boolean }

type ActiveTurn = {
  turnId: string
  requestId: string
  approvalSequence: number
  queue: PushStream<ConversationEvent>
}

type SessionState = {
  sessionId: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  workspaceRoot: string
  // Pictures being written for the steps of the message being read (mapSdkMessage).
  toolImageWrites?: Promise<void>[]
  cliRuntimes?: ConversationCliRuntimeOverrides
  permissionPreset: ConversationPermissionPreset
  // Claude Code's own mode at that preset (Accept edits, Don't ask), when one
  // other than the preset's own was chosen.
  permissionMode?: string
  allowedTools?: string[]
  // The session's own MCP servers (a connector run's), on every child it spawns.
  mcpServers?: ConversationMcpServer[]
  skillIds?: string[]
  // The per-child plugin directory that carries the attached skills; removed
  // with the child that loaded it.
  skillPluginDir: string | null
  mode?: 'default' | 'plan' | 'ask'
  reasoningEffort?: string
  onBeforeTool?: (name: string) => Promise<void>
  providerSessionId: string | null
  // The newest entry of the provider session's main chain this process has
  // seen; each turn end carries it as the point a rewind can go back to.
  lastChainUuid: string | null
  // The newest main-chain entry that leaves no tool call waiting for its
  // result, and the calls still waiting. Mid-turn this is the point a rewind
  // can fork at: one taken at a tool call would resume a call with no answer.
  settledChainUuid: string | null
  openToolUseIds: Set<string>
  // Set by a rewind: the next child resumes `providerSessionId` only up to
  // this entry, as a fork. Cleared once a child has started from it.
  resumeAt: string | null
  query: Query | null
  inputQueue: PushStream<SDKUserMessage> | null
  abort: AbortController | null
  childPid: number | null
  spawnedAt: number | null
  turn: ActiveTurn | null
  // Claude Code can hold several permission callbacks open at once (parallel
  // tool_use blocks), so pending permissions are keyed by requestId.
  pendingPermissions: Map<string, PendingPermission>
  // The preset the live child runs under: the one it was spawned with, or
  // the one a live switch moved it to. Null when it runs under neither — a
  // bypass child switched back mid-reply is on 'default', which is not
  // necessarily the CLI's own default that `none` means — so the next turn
  // respawns it (resumed) under the preset the session recorded.
  childPreset: ConversationPermissionPreset | null
  // And the mode of Claude Code's own it runs at that preset, null for the
  // preset's own.
  childMode: string | null
  // Session-level events (resume cursor updates) that arrived while no turn
  // stream was open to carry them; flushed at the next turn start.
  pendingSessionEvents: ConversationEvent[]
  // Session-scoped continuation channel (set at startSession). When the child
  // resumes after a `result` with no open `sendTurn`, post-`result` events —
  // and any approval they raise — flow to the runtime over this sink via a
  // lazily opened continuation turn instead of being dropped/denied.
  onSessionEvent: ConversationSessionEventSink | null
  // Monotonic counter for continuation-turn ids, unique within the session.
  continuationSequence: number
  lastActivityAt: number
  stderrTail: string
  // The SDK reports cost as a running total for the life of one query() call;
  // the total already attributed to earlier turns of the live child.
  queryCostUsd: number
  // The child being spawned, while it is; see ensureQuery.
  spawning: Promise<void> | null
  // Bumped when the session is stopped or its child disposed from outside
  // (suspend, the idle sweep, quit). A spawn that began before the bump gives
  // up instead of starting a child nothing tracks any more.
  spawnGeneration: number
  // Ids of the user messages handed to the child that no `result` has
  // answered yet. A turn is over only once every one has been: a message
  // steered in after the CLI's last tool round is answered by a result of
  // its own, after the one for the message the turn started with.
  pendingSendUuids: Set<string>
  // Ids of the messages a Stop cut off. The CLI still plays out the tail of
  // that exchange after the interrupt — partial text, its own "interrupted"
  // note, and a failed result naming these ids — and none of it belongs to a
  // turn any more: the one it was for has already ended as stopped, and the
  // next one must not end on that result.
  interruptedSendUuids: Set<string>
  // A result answered part of what the child was sent and the next exchange
  // answers the rest in the same turn: its first text starts a paragraph of
  // its own instead of running on from the last sentence of the reply before.
  textSeam: boolean
  // Tool calls this app refused, so their results read as declined rather
  // than as tools that failed on their own.
  declinedToolUseIds: Set<string>
  // Agents the child has running, by spawning tool call.
  subagents: Map<string, TrackedSubagent>
  // The tool call that first spawned each agent this chat has seen, by task.
  // Kept across children: an agent resumed later (SendMessage, after the
  // child that ran it ended) reports under the resuming call, and its lane is
  // still the one that spawned it.
  agentLanes: Map<string, string>
  // Shells, monitors and workflows the child runs, by task. The background
  // ones are what `session_updated` lists as `backgroundTasks`.
  tasks: Map<string, TrackedTask>
  // Monitor calls whose task has not started yet, by tool call. A monitor
  // runs as a shell, so only the call that started it tells the two apart.
  monitorCalls: Map<string, { persistent: boolean }>
  // What the child's last init said about its commands: which names are
  // skills and which are bound to the terminal, so a later `commands_changed`
  // push is read the same way. Null until an init has said.
  commandSkills: string[] | null
  terminalCommands: string[] | null
  // The exchange has already shown a local command's output (the CLI reports
  // it more than one way), and whether it compacted, whose divider already
  // says what `/compact` printed. Both reset when the exchange ends.
  commandOutputShown: boolean
  compactedInExchange: boolean
  // How the session bills, once its init or its account has said (see
  // mapSdkMessage's state and `reportAccount`).
  usageBilling?: 'subscription' | 'api' | null
}

// Event types that belong to a turn (carry a turnId and must be suppressed by
// the runtime when they do not match the active turn). Everything else is
// session-scoped and needs no turn to be delivered.
const SESSION_SCOPED_EVENT_TYPES = new Set<ConversationEvent['type']>([
  'session_started',
  'session_ready',
  'session_closed',
  'session_updated',
  'user_message',
  'subagent_status',
  'subagent_message',
])

// A background agent's result belongs to no turn: it closes a lane opened by a
// turn that has usually ended, so it must not open a continuation turn.
function isSessionScopedEvent(event: ConversationEvent): boolean {
  return (
    SESSION_SCOPED_EVENT_TYPES.has(event.type) ||
    (event.type === 'tool_output' && event.payload?.backgroundResult === true)
  )
}

// Session-scoped events that still matter between turns and ride the session
// channel when no turn is open to carry them. A background agent's own steps
// ride it too: the agent works on after the turn that launched it has ended,
// and its steps belong to its lane, not to a turn of the conversation.
function ridesSessionChannel(event: ConversationEvent): boolean {
  return (
    event.type === 'session_updated' ||
    event.type === 'subagent_status' ||
    event.type === 'subagent_message' ||
    (event.type === 'tool_output' && event.payload?.backgroundResult === true) ||
    isSubagentStep(event)
  )
}

// Activity after the turn's `result` that means the model itself is working
// again, so it needs a continuation turn. A background agent's steps do not:
// opened for them, the turn would hold the conversation busy, refuse the
// person's next send, and end in a "done" notice and a diff for a turn nobody
// sent. An approval the agent raises still opens one, from the permission
// callback, because the agent is then waiting on the person.
function opensContinuationTurn(event: ConversationEvent): boolean {
  return !isSessionScopedEvent(event) && !isSubagentStep(event)
}

// Minimal push-based async iterable: producers push/end, one consumer drains.
class PushStream<T> implements AsyncIterable<T> {
  private readonly queue: T[] = []
  private readonly resolvers: Array<(result: IteratorResult<T>) => void> = []
  private ended = false

  push(value: T): void {
    if (this.ended) return
    const resolve = this.resolvers.shift()
    if (resolve) resolve({ value, done: false })
    else this.queue.push(value)
  }

  get closed(): boolean {
    return this.ended
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const resolve of this.resolvers.splice(0)) {
      resolve({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.queue.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.resolvers.push(resolve))
      },
      return: (): Promise<IteratorResult<T>> => {
        this.end()
        return Promise.resolve({ value: undefined as never, done: true })
      },
    }
  }
}

export function createClaudeAgentProvider(options: ClaudeAgentProviderOptions = {}): ClaudeAgentProviderAdapter {
  const loadQuery = options.loadQuery ?? defaultLoadQuery
  const resolveExecutable = options.resolveExecutable ?? defaultResolveExecutable
  const buildEnv = options.buildEnv ?? defaultBuildEnv
  const now = options.now ?? Date.now
  const tempDir = options.tempDir ?? tmpdir()
  const prepareWslTarget = options.prepareWslTarget ?? prepareWslClaudeTarget
  const spawnWslChild = options.spawnWslChild ?? spawnWslClaude
  const childAnswerTimeoutMs = options.childAnswerTimeoutMs ?? UNRESPONSIVE_CHILD_MS
  const sessions = new Map<string, SessionState>()
  // Staged plugin folders still being removed, so shutdown can wait for them.
  const removals = new Set<Promise<void>>()
  // A quit that never finished removing (a crash, a force-quit) leaves plugin
  // folders behind; the next start clears those, then stages anything new.
  const swept = sweepStaleSkillPlugins(tempDir).catch(() => undefined)

  function removeSkillPlugin(dir: string): void {
    const removal = rm(dir, { recursive: true, force: true })
      .catch(() => undefined)
      .finally(() => removals.delete(removal))
    removals.add(removal)
  }

  // The turn still taking events. One whose stream has closed (its result
  // arrived, or its reader stopped) takes none: pushed there, they are lost.
  function openTurn(state: SessionState): ActiveTurn | null {
    return state.turn && !state.turn.queue.closed ? state.turn : null
  }

  function deliver(state: SessionState, events: ConversationEvent[]): void {
    for (const event of events) {
      // Post-`result` turn-scoped activity with no open `sendTurn`: open a
      // continuation turn so the event (and any approval it raises) reaches the
      // runtime instead of being dropped. Requires the session channel.
      if (!openTurn(state) && state.onSessionEvent && opensContinuationTurn(event)) {
        ensureContinuationTurn(state)
      }
      const turn = openTurn(state)
      if (turn) {
        // Events mapped before the continuation turn existed carry no turnId;
        // stamp the continuation id so the runtime attaches them to its mirror.
        turn.queue.push(withContinuationTurnId(event, turn.turnId))
      } else if (ridesSessionChannel(event)) {
        // A resume-cursor update or a background agent's progress or steps
        // between turns: ride the session channel if it is open, else buffer
        // for the next turn start.
        if (state.onSessionEvent) state.onSessionEvent(event)
        else state.pendingSessionEvents.push(event)
      }
      // Non-session events with no open turn and no channel have nowhere to go
      // (the turn they belonged to was interrupted); drop them.
    }
  }

  // Lazily open a continuation turn for post-`result` activity. Reuses the
  // per-turn machinery (queue, approval sequencing) so handleCanUseTool and
  // deliver are unchanged; a background drain forwards the queue to the session
  // channel. Returns null when no session channel is available.
  function ensureContinuationTurn(state: SessionState): ActiveTurn | null {
    const open = openTurn(state)
    if (open) return open
    if (!state.onSessionEvent) return null
    state.continuationSequence += 1
    const turnId = `${state.sessionId}_cont_${state.continuationSequence}`
    const turn: ActiveTurn = {
      turnId,
      requestId: `approval_${turnId}`,
      approvalSequence: 0,
      queue: new PushStream<ConversationEvent>(),
    }
    state.turn = turn
    state.lastActivityAt = now()
    // Announce the turn first so the runtime opens its mirror before any
    // content or approval events arrive over the channel.
    turn.queue.push(eventFor(state, 'turn_started', { turnId }))
    void drainContinuationTurn(state, turn)
    return turn
  }

  async function drainContinuationTurn(state: SessionState, turn: ActiveTurn): Promise<void> {
    try {
      for await (const event of turn.queue) state.onSessionEvent?.(event)
    } finally {
      if (state.turn === turn) state.turn = null
      // A permission still open when the continuation ends must not leave the
      // child blocked forever — including when the turn ended because a send
      // took the session over.
      resolvePendingPermissionsForTurn(state, turn.turnId, { approved: false })
      state.lastActivityAt = now()
    }
  }

  // The turn is over once its stream ends, so nothing more is pushed there:
  // activity after it opens a continuation turn instead.
  function endTurn(state: SessionState): void {
    state.turn?.queue.end()
    state.turn = null
    state.lastActivityAt = now()
  }

  // Hand the child a user message, stamped with an id of our own so the
  // results can say which messages they answered.
  function pushUserMessage(state: SessionState, content: SDKUserMessage['message']['content']): void {
    const uuid = randomUUID()
    state.pendingSendUuids.add(uuid)
    state.inputQueue?.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: state.providerSessionId ?? '',
      uuid,
    })
  }

  // Stop the child's turn, and with it any message steered in that the CLI
  // had not folded in yet: without `cancelQueued` such a message survives the
  // interrupt and runs by itself afterwards. The option is honored from the
  // CLI that advertises `interrupt_cancel_queued_v1`; the SDK passes it
  // through although its typed signature does not declare it yet. An older
  // CLI ignores it, and the message it still runs arrives as a continuation
  // turn rather than being lost.
  function interruptChild(state: SessionState): Promise<boolean> {
    for (const uuid of state.pendingSendUuids) state.interruptedSendUuids.add(uuid)
    state.pendingSendUuids.clear()
    state.textSeam = false
    const interrupt = state.query?.interrupt as ((options?: { cancelQueued?: boolean }) => Promise<unknown>) | undefined
    if (!interrupt) return Promise.resolve(true)
    // A refusal is still an answer: the child is alive to give it.
    return answeredWithin(
      interrupt.call(state.query, { cancelQueued: true }).catch(() => undefined),
      childAnswerTimeoutMs,
    )
  }

  // Stop, on a child that never acknowledges it, ends the child. A process
  // wedged inside WSL — or anywhere — holds the turn's permission callback and
  // reads none of what it is sent, so the card's Allow and the composer's Stop
  // both landed in a process that would never act on them, and the chat had no
  // way out but closing it. Ended, the next message respawns the child on the
  // same session (resumed), which is what a person retrying expects.
  function endUnresponsiveChildAfterStop(state: SessionState, acknowledged: Promise<boolean>): void {
    const query = state.query
    if (!query) return
    void acknowledged.then((answered) => {
      if (!answered && state.query === query) disposeChild(state)
    })
  }

  function resolveAllPendingPermissions(state: SessionState, decision: PermissionDecision): void {
    const pending = Array.from(state.pendingPermissions.values())
    state.pendingPermissions.clear()
    for (const { resolve } of pending) resolve(decision)
  }

  function resolvePendingPermissionsForTurn(state: SessionState, turnId: string, decision: PermissionDecision): void {
    for (const [requestId, pending] of Array.from(state.pendingPermissions)) {
      if (pending.turnId !== turnId) continue
      state.pendingPermissions.delete(requestId)
      pending.resolve(decision)
    }
  }

  function disposeChild(state: SessionState): boolean {
    const hadChild = state.query !== null
    stopTrackedSubagents(state)
    stopTrackedTasks(state)
    resolveAllPendingPermissions(state, { approved: false })
    endTurn(state)
    state.pendingSendUuids.clear()
    state.interruptedSendUuids.clear()
    state.textSeam = false
    state.openToolUseIds.clear()
    state.inputQueue?.end()
    state.inputQueue = null
    state.abort?.abort()
    state.abort = null
    state.query = null
    state.childPreset = null
    state.childMode = null
    state.childPid = null
    state.spawnedAt = null
    if (state.skillPluginDir) removeSkillPlugin(state.skillPluginDir)
    state.skillPluginDir = null
    return hadChild
  }

  // Background agents run inside the child: when it goes, they go with it. Say
  // so, or their lanes would read as working forever.
  function stopTrackedSubagents(state: SessionState): void {
    const stopped = Array.from(state.subagents.values())
    state.subagents.clear()
    const events = stopped.map((agent) =>
      eventFor(state, 'subagent_status', {
        ...subagentStatusFields(agent, 'stopped'),
        error: 'The agent stopped when its Claude Code process ended.',
      }),
    )
    for (const event of events) {
      if (state.onSessionEvent) state.onSessionEvent(event)
      else state.pendingSessionEvents.push(event)
    }
  }

  // Whether the live child runs under the session's recorded preset.
  function childHonorsPreset(state: SessionState): boolean {
    return state.childPreset === state.permissionPreset && state.childMode === ownSdkMode(state)
  }

  // Shells and monitors run inside the child too, and end with it. The list
  // the chat shows is emptied, so it does not go on waiting on a monitor that
  // will never report.
  function stopTrackedTasks(state: SessionState): void {
    const listed = backgroundTaskList(state.tasks)
    state.tasks.clear()
    state.monitorCalls.clear()
    if (listed.length === 0) return
    const event = eventFor(state, 'session_updated', { backgroundTasks: [] })
    if (state.onSessionEvent) state.onSessionEvent(event)
    else state.pendingSessionEvents.push(event)
  }

  // Whether the child can be replaced now without ending anything. A
  // background agent, shell or monitor works inside the child with no turn
  // open, so an idle turn alone does not say the child is free.
  function childIsIdle(state: SessionState): boolean {
    if (state.turn) return false
    for (const agent of state.subagents.values()) if (agent.background) return false
    for (const tracked of state.tasks.values()) if (tracked.background) return false
    return true
  }

  async function pump(state: SessionState, q: Query): Promise<void> {
    try {
      for await (const message of q as AsyncIterable<Record<string, unknown>>) {
        if (state.query !== q) return
        if (state.interruptedSendUuids.size > 0) {
          // A new child exchange has begun, so whatever the stopped one left
          // unsaid will not come any more: an older CLI that ends an
          // interrupted exchange without a result cannot hold the next one up.
          if (message.type === 'system' && message.subtype === 'init') state.interruptedSendUuids.clear()
          else if (message.type !== 'system') {
            if (message.type !== 'result' || answersOnlyInterrupted(state.interruptedSendUuids, message)) {
              // Still read for where the session stands and what it cost —
              // the cost stays in the running total, so the next result
              // carries it — but shown nowhere.
              mapSdkMessage(state, message, { interrupted: true })
              if (message.type === 'result') state.interruptedSendUuids.clear()
              continue
            }
            // A result that also answers a message sent since: the stopped
            // exchange and the new one ended as one, and it is the new turn's.
            state.interruptedSendUuids.clear()
          }
        }
        if (message.type === 'system') {
          noteCommandList(state, message)
          noteMcpServers(state, message)
        }
        const forking = state.resumeAt !== null
        const ends = message.type === 'result' && resultEndsExchange(state.pendingSendUuids, message)
        const events = mapSdkMessage(state, message, { exchangeContinues: message.type === 'result' && !ends })
        // A step's pictures are on disk before the step says where they are.
        if (state.toolImageWrites?.length) await Promise.all(state.toolImageWrites.splice(0))
        deliver(state, events)
        if (ends) endTurn(state)
        // The fork point a rewind asked for is not in the session: this child
        // runs a session of its own nobody recorded. The next send starts a
        // child on the session as it was.
        if (forking && message.type === 'result' && state.resumeAt === null) {
          disposeChild(state)
          return
        }
      }
    } catch (error) {
      if (state.query !== q) return
      if (state.turn) {
        deliver(state, [
          eventFor(state, 'turn_failed', {
            turnId: state.turn.turnId,
            reason: 'provider',
            message: describeSpawnFailure(error, state.stderrTail),
            ...providerCursorPayload(state),
          }),
        ])
      }
    } finally {
      if (state.query === q) {
        // Child process ended (crash, auth failure, natural exit): close the
        // turn stream so a pending sendTurn resolves, keep the resume cursor.
        if (state.turn) {
          deliver(state, [
            eventFor(state, 'turn_failed', {
              turnId: state.turn.turnId,
              reason: 'provider',
              message: describeSpawnFailure(null, state.stderrTail),
              ...providerCursorPayload(state),
            }),
          ])
        }
        disposeChild(state)
      }
    }
  }

  // What the live child says its commands are, for the composer's `/` menu.
  // The init (sent at the start of every exchange) names them; a
  // `commands_changed` push replaces them whole. Published only when the list
  // changed, and never into the transcript: it is the folder's list, not
  // something that happened in the chat. A chat with skills attached runs its
  // child on those skills alone (the `skills` option) plus a plugin of its
  // own, so its list is not the folder's and is kept out of it.
  function noteCommandList(state: SessionState, message: Record<string, unknown>): void {
    if (message.subtype !== 'init' && message.subtype !== 'commands_changed') return
    if (message.subtype === 'init') {
      state.commandSkills = initSkillNames(message) ?? state.commandSkills
      state.terminalCommands = initTerminalCommands(message) ?? state.terminalCommands
    }
    if (state.skillIds?.length || !state.workspaceRoot) return
    const known = conversationCommandsFor(CLAUDE_COMMANDS_CLI, state.workspaceRoot)
    const next =
      message.subtype === 'init'
        ? claudeCommandsFromInit(message, known.commands)
        : Array.isArray(message.commands)
          ? mapClaudeCommands(message.commands, { skills: state.commandSkills, terminal: state.terminalCommands })
          : null
    if (!next) return
    // An init repeats the same names every exchange; only a change is news.
    // The repeat still says the list is current, so it is marked fresh: a `/`
    // typed later then reads it instead of starting a Claude process to ask
    // again. A push carries descriptions too, so it is taken whenever it arrives.
    if (message.subtype === 'init' && known.fetchedAt > 0 && !known.error && sameCommandNames(next, known.commands)) {
      touchConversationCommands(CLAUDE_COMMANDS_CLI, state.workspaceRoot)
      return
    }
    publishConversationCommands({ cli: CLAUDE_COMMANDS_CLI, cwd: state.workspaceRoot, commands: next })
  }

  // Every server the CLI loaded, from its own settings and plugins as well as
  // the ones this app gave it, with whether each connected: the init names
  // them all at the start of every exchange.
  function noteMcpServers(state: SessionState, message: Record<string, unknown>): void {
    if (message.subtype !== 'init' || !state.workspaceRoot || !Array.isArray(message.mcp_servers)) return
    const servers = message.mcp_servers.flatMap((entry: unknown) => {
      const { name, status } = (entry ?? {}) as { name?: unknown; status?: unknown }
      if (typeof name !== 'string' || !name || !isMcpServerStatus(status)) return []
      return [{ id: name, status }]
    })
    publishMcpServerStatus({ cli: CLAUDE_COMMANDS_CLI, cwd: state.workspaceRoot, servers, replace: true })
    // The init names each server's state; the child's own status adds why one
    // failed and how many tools a connected one brought.
    void refreshMcpServers(state)
  }

  async function refreshMcpServers(state: SessionState): Promise<AgentMcpServerStatus[]> {
    const q = state.query
    if (!q || !state.workspaceRoot || typeof q.mcpServerStatus !== 'function') return []
    const listed = await q.mcpServerStatus().catch(() => null)
    if (!listed || state.query !== q) return []
    publishMcpServerStatus({
      cli: CLAUDE_COMMANDS_CLI,
      cwd: state.workspaceRoot,
      replace: true,
      servers: listed.flatMap((server) =>
        isMcpServerStatus(server.status)
          ? [
              {
                id: server.name,
                status: server.status,
                ...(server.error ? { error: server.error } : {}),
                ...(Array.isArray(server.tools) ? { toolCount: server.tools.length } : {}),
              },
            ]
          : [],
      ),
    })
    return listed.flatMap((server) => (isMcpServerStatus(server.status) ? [server.status] : []))
  }

  // A sign-in finishes in the browser and the child reconnects the server
  // itself; its state is read again every few seconds until it has, for as
  // long as a person takes to sign in, so the picker shows it connected.
  function watchSignIn(state: SessionState, serverId: string): void {
    const startedAt = now()
    const check = async () => {
      const q = state.query
      if (!q || now() - startedAt > MCP_SIGN_IN_WATCH_MS) return
      const listed = await q.mcpServerStatus().catch(() => null)
      await refreshMcpServers(state)
      const server = listed?.find((entry) => entry.name === serverId)
      if (server && server.status !== 'needs-auth' && server.status !== 'pending') return
      setTimeout(() => void check(), MCP_SIGN_IN_POLL_MS).unref?.()
    }
    setTimeout(() => void check(), MCP_SIGN_IN_POLL_MS).unref?.()
  }

  function ensureQuery(state: SessionState): Promise<void> {
    // A preset the live child does not run under (changed after it spawned) is
    // reconciled here, so the turn about to start runs under the preset the
    // session actually recorded. The respawn below resumes the same provider
    // session, so the conversation continues rather than restarting.
    if (state.query && !childHonorsPreset(state)) disposeChild(state)
    if (state.query) return Promise.resolve()
    // Two callers racing past the check above would each stage a plugin folder
    // and spawn a child, and only one of either would ever be cleaned up.
    state.spawning ??= spawnQuery(state).finally(() => {
      state.spawning = null
    })
    return state.spawning
  }

  // A spawn awaits several steps before the child starts. The session may be
  // stopped or suspended during any of them, and a child started after that
  // would belong to no session: invisible to the idle sweep and to quit.
  function assertSpawnWanted(state: SessionState, generation: number): void {
    if (state.spawnGeneration !== generation || sessions.get(state.sessionId) !== state)
      throw new Error('The conversation was closed before Claude Code started.')
  }

  async function spawnQuery(state: SessionState): Promise<void> {
    // A chat on a WSL machine runs that machine's `claude`, with the login
    // and settings under its Linux home; everything below is the same.
    const generation = state.spawnGeneration
    const hostId = state.cliRuntimes?.['claude-code']?.hostId
    const wslTarget = isWslHostId(hostId) ? await prepareWslTarget(hostId) : null
    assertSpawnWanted(state, generation)
    const executablePath = await resolveExecutable(state.cliRuntimes)
    assertSpawnWanted(state, generation)
    const sdkQuery = await loadQuery()
    const env = await buildEnv({
      workspaceId: state.workspaceId,
      agentId: state.agentId,
      sessionId: state.sessionId,
    })
    assertSpawnWanted(state, generation)
    const instructions = await readWorkspaceInstructions(state.workspaceRoot)
    // A WSL gateway entry names its channel token (`envVarNames`) and never
    // carries it: the SDK puts `mcpServers` on the child's command line. The
    // child is issued the token on stdin (spawnWslClaude) and the bridge it
    // starts inherits it, as a WSL terminal's `claude` hands it on.
    const studioGateway = await options.resolveStudioMcpServer?.({ ...(hostId ? { hostId } : {}) }).catch(() => null)
    const mcpServers = claudeMcpServers(
      [...(studioGateway ? [withAgentIdentity(studioGateway, env)] : []), ...(state.mcpServers ?? [])],
      { wsl: wslTarget !== null },
    )
    await swept
    assertSpawnWanted(state, generation)
    const skillPlugin = state.skillIds?.length
      ? await stageAttachedSkills(tempDir, state.workspaceRoot, state.skillIds)
      : null
    try {
      assertSpawnWanted(state, generation)
    } catch (error) {
      if (skillPlugin) removeSkillPlugin(skillPlugin)
      throw error
    }
    state.skillPluginDir = skillPlugin
    const inputQueue = new PushStream<SDKUserMessage>()
    const abort = new AbortController()
    const permissionMode = nativePermissionMode(state, state.mode)
    const queryOptions: Options = {
      cwd: state.workspaceRoot,
      pathToClaudeCodeExecutable: executablePath,
      // The CLI's own default row passes no model, as a terminal launch without
      // `--model` does.
      ...(state.modelId !== CONVERSATION_DEFAULT_MODEL_ID ? { model: state.modelId } : {}),
      ...(state.reasoningEffort ? { effort: state.reasoningEffort as Options['effort'] } : {}),
      includePartialMessages: true,
      // A one-line "what it is doing now" for each running agent, forked from
      // the agent's own context about every 30s; shown on its lane and card.
      agentProgressSummaries: true,
      permissionMode,
      // Every child may be switched into bypass while it runs: the CLI takes
      // `setPermissionMode('bypassPermissions')` only from a child started with
      // this opt-in. The opt-in itself bypasses nothing; the mode does. It
      // also lets a `defaultMode` of bypassPermissions in the user's own
      // settings stand under `none`, which is that CLI's own default.
      allowDangerouslySkipPermissions: true,
      ...(state.allowedTools?.length ? { allowedTools: state.allowedTools } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', ...(instructions ? { append: instructions } : {}) },
      // Never the repository's own settings. `.claude/settings.json` and
      // `settings.local.json` can carry allow rules, which would answer tool
      // permissions before canUseTool is asked and so skip the approvals a
      // session on the CLI's default would show here, and hooks, which run
      // commands on this machine as soon as the session starts. Omitting the option loads every source,
      // so the list is always explicit. What the project contributes that the
      // agent does need arrives another way: its CLAUDE.md through the system
      // prompt above, and attached skills as a plugin of their own.
      settingSources: ['user'],
      // Which is also why the app's MCP gateway is passed here rather than
      // read from the workspace's `.mcp.json`: a project's MCP servers are
      // project settings, and this child loads none. The session's own servers
      // (a connector run's) ride the same option; the person's user-scoped
      // servers still load from their own configuration.
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      // Plain `--plugin-dir`, never `skipMcpDiscovery`: the SDK spells that
      // `--plugin-dir-no-mcp`, which a Claude Code older than the SDK does not
      // know, and the child exits on it. There is nothing to skip anyway: the
      // staged plugin is written here with no `.mcp.json` and no `mcpServers`,
      // so it can carry skills and nothing else.
      ...(skillPlugin ? { plugins: [{ type: 'local', path: wslTarget ? toWslPath(skillPlugin) : skillPlugin }] } : {}),
      ...(state.skillIds?.length ? { skills: state.skillIds.map(attachedSkillName) } : {}),
      env,
      abortController: abort,
      canUseTool: (toolName, toolInput, callbackOptions) =>
        handleCanUseTool(state, toolName, toolInput, callbackOptions?.signal, callbackOptions),
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name === 'PreToolUse') {
                  if (
                    state.mode === 'ask' &&
                    !['file_read', 'search', 'list', 'web'].includes(inferConversationToolKind(input.tool_name))
                  ) {
                    state.declinedToolUseIds.add(input.tool_use_id)
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse' as const,
                        permissionDecision: 'deny' as const,
                        permissionDecisionReason: 'Ask mode permits read-only tools only.',
                      },
                    }
                  }
                  if (manualAsks(state, input.tool_name)) {
                    await state.onBeforeTool?.(input.tool_name)
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse' as const,
                        permissionDecision: 'ask' as const,
                        permissionDecisionReason: 'Manual mode asks before every action that changes something.',
                      },
                    }
                  }
                  await state.onBeforeTool?.(input.tool_name)
                }
                return {}
              },
            ],
          },
        ],
      },
      // Spawn the child ourselves (same command/args the SDK computed) so the
      // PID is known: process-tree diagnostics attribute the headless child to
      // this session, and the SDK exposes no PID of its own.
      spawnClaudeCodeProcess: (spawnInput: SpawnOptions): SpawnedProcess =>
        spawnTrackedChild(
          state,
          wslTarget ? () => spawnWslChild(wslTarget, spawnInput) : () => spawnLocalChild(spawnInput),
          now,
        ),
      ...(state.providerSessionId ? { resume: state.providerSessionId } : {}),
      // After a rewind the child forks the session at the kept turn's last
      // entry, so the turns after it leave the context and the session they
      // were in stays as it was.
      ...(state.providerSessionId && state.resumeAt ? { resumeSessionAt: state.resumeAt, forkSession: true } : {}),
    }
    const q = sdkQuery({ prompt: inputQueue, options: queryOptions })
    state.query = q
    state.queryCostUsd = 0
    state.childPreset = state.permissionPreset
    state.childMode = ownSdkMode(state)
    state.inputQueue = inputQueue
    state.abort = abort
    void pump(state, q)
    void reportSupportedAgents(state, q)
    void reportAccount(state, q)
  }

  // How the session bills, from the account its initialize answered with: the
  // init's `apiKeySource: none` is a claude.ai login only on Anthropic's own
  // API. A cloud provider, a gateway or a key has no plan limits, and the
  // store forgets any subscription reading it held for one.
  async function reportAccount(state: SessionState, q: Query): Promise<void> {
    if (typeof q.initializationResult !== 'function') return
    const answer = await q.initializationResult().catch(() => null)
    if (!answer || state.query !== q) return
    const billing = claudeBillingOfAccount(answer.account, normalizeApiKeySource(answer.account?.apiKeySource))
    if (!billing) return
    state.usageBilling = billing.billing
    usageLimitsStore().noteBilling('claude', billing.billing, billing.plan)
  }

  // The native permission mode a chat mode runs the child in. Ask is plan mode
  // with a hook that reads `state.mode` for every tool call.
  function nativePermissionMode(state: SessionState, mode: SessionState['mode']) {
    return mode === 'plan' || mode === 'ask' ? 'plan' : sdkPermissionMode(state)
  }

  // Whether Manual sends this call to a card even where the CLI would run it
  // unasked. 'default' already asks before edits and most commands, but it
  // runs the commands it judges read-only and whatever the person's own allow
  // rules name; Manual promises a card for every action that changes something
  // or reaches out. Read-only lookups still run, and questions and plans reach
  // canUseTool anyway. Read from the session's preset, not the child's, so
  // choosing Manual mid-reply holds the very next call.
  function manualAsks(state: SessionState, toolName: string): boolean {
    // Don't ask is at Manual's level and asks about nothing: what its rules do
    // not allow is refused, not carded.
    if (state.permissionPreset !== 'manual' || ownSdkMode(state) || state.mode === 'plan' || state.mode === 'ask')
      return false
    if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') return false
    // A tool the session was started pre-approved for stays pre-approved.
    if (state.allowedTools?.includes(toolName)) return false
    return !LOOKUP_TOOL_KINDS.has(inferConversationToolKind(toolName))
  }

  // Move the live child to another chat mode over the control channel rather
  // than respawning it, which costs a cold start, a re-read of the session
  // file, and any background agent it had running. False when only a respawn
  // can do it: under `none`, default mode is the child's own configured one,
  // which no control-channel mode names.
  async function switchModeLive(state: SessionState, next: NonNullable<SessionState['mode']>): Promise<boolean> {
    if (!state.query || !childHonorsPreset(state)) return false
    const target = nativePermissionMode(state, next)
    if (target === undefined) return false
    if (target === nativePermissionMode(state, state.mode)) return true
    try {
      await state.query.setPermissionMode(target)
      return true
    } catch {
      return false
    }
  }

  // The agent types this child can spawn, with what each is for, so an agent's
  // card can say what kind of helper it is (custom agents included).
  async function reportSupportedAgents(state: SessionState, q: Query): Promise<void> {
    if (typeof q.supportedAgents !== 'function') return
    const agents = await q.supportedAgents().catch(() => null)
    if (!agents || state.query !== q) return
    deliver(state, [
      eventFor(state, 'session_updated', {
        providerSessionId: state.providerSessionId,
        agents: agents
          .filter((agent) => typeof agent?.name === 'string' && agent.name)
          .map((agent) => ({
            name: agent.name,
            ...(typeof agent.description === 'string' && agent.description ? { description: agent.description } : {}),
          })),
      }),
    ])
  }

  async function handleCanUseTool(
    state: SessionState,
    toolName: string,
    toolInput: Record<string, unknown>,
    signal?: AbortSignal,
    permissionContext?: {
      agentID?: string
      toolUseID?: string
      defaultToNo?: boolean
      suppressAlwaysAllowRule?: boolean
      matchedAskRule?: unknown
    },
  ): Promise<PermissionResult> {
    // Bypass means no approval cards, subagents included. The CLI still asks
    // for some calls under bypassPermissions (an Explore subagent's compound
    // Bash it can't prove read-only), so answer those here. Two asks still
    // reach the person: a safety check the CLI marks as not approvable by a
    // stray keystroke, and one forced by the user's own `permissions.ask`
    // rule. Questions and plans are answers, not permissions, so they always
    // show. The child has to run under bypass, so a live switch to bypass
    // answers the rest of the reply too; and the chat has to still be on it,
    // so a stricter mode chosen while a child that could not take it goes on
    // bypassing holds whatever that child still asks about.
    const bypassable =
      state.mode !== 'plan' &&
      state.mode !== 'ask' &&
      toolName !== 'AskUserQuestion' &&
      toolName !== 'ExitPlanMode' &&
      !permissionContext?.defaultToNo &&
      !permissionContext?.matchedAskRule
    if (bypassable && state.childPreset === 'bypass' && state.permissionPreset === 'bypass')
      return { behavior: 'allow', updatedInput: toolInput }
    // A tool that fires after the turn's `result` (e.g. once a background
    // subagent completes and the model resumes) has no open turn. Open a
    // continuation turn so its approval card reaches the UI instead of being
    // auto-denied; deny only when there is no session channel to carry it.
    const turn = openTurn(state) ?? ensureContinuationTurn(state)
    if (!turn) return { behavior: 'deny', message: 'Conversation turn is not active.' }
    turn.approvalSequence += 1
    const requestId = turn.approvalSequence === 1 ? turn.requestId : `${turn.requestId}_${turn.approvalSequence}`

    // Interactive tools become structured cards instead of plain allow/deny:
    // AskUserQuestion renders its options as buttons, ExitPlanMode shows the
    // plan for approval. Everything else is a generic tool-permission card.
    const questions = toolName === 'AskUserQuestion' ? parseAskUserQuestions(toolInput) : null
    const plan = toolName === 'ExitPlanMode' ? readPlanText(toolInput) : null
    // Claude Code keeps the plan in a file and names it on the request; the
    // workspace pane opens that file while it still holds this plan.
    const planFilePath = plan !== null && typeof toolInput.planFilePath === 'string' ? toolInput.planFilePath : null
    const requestPayload: Record<string, unknown> = {
      turnId: turn.turnId,
      requestId,
      action: toolName,
      input: toolInput,
      toolKind: inferConversationToolKind(toolName),
      cwd: state.workspaceRoot,
      ...(permissionContext?.agentID ? { originAgentId: permissionContext.agentID } : {}),
      ...(permissionContext?.defaultToNo ? { defaultToNo: true } : {}),
      ...(permissionContext?.suppressAlwaysAllowRule ? { suppressAlwaysAllowRule: true } : {}),
      // What bypass would still have asked (a safety check, the person's own
      // ask rule, anything in plan or ask mode): no mode answers it for them.
      ...(bypassable ? {} : { mustAsk: true }),
      summary: questions
        ? (questions[0]?.question ?? 'The agent has a question.')
        : plan !== null
          ? 'The agent proposed a plan.'
          : summarizeToolInput(toolName, toolInput),
      kind: questions ? 'question' : plan !== null ? 'plan' : 'tool',
      ...(questions ? { questions } : {}),
      ...(plan !== null ? { plan } : {}),
      ...(planFilePath ? { planFilePath } : {}),
    }
    turn.queue.push(eventFor(state, 'approval_requested', requestPayload))

    const decision = await new Promise<PermissionDecision>((resolve) => {
      state.pendingPermissions.set(requestId, { turnId: turn.turnId, resolve, bypassable })
      signal?.addEventListener(
        'abort',
        () => {
          if (state.pendingPermissions.delete(requestId)) resolve({ approved: false })
        },
        { once: true },
      )
    })
    state.pendingPermissions.delete(requestId)
    let planTransitionError: string | undefined
    if (decision.approved && plan !== null && state.mode === 'plan') {
      try {
        await state.query?.setPermissionMode(sdkPermissionMode(state) ?? 'default')
        state.mode = 'default'
      } catch (error) {
        decision.approved = false
        planTransitionError = error instanceof Error ? error.message : 'Could not leave plan mode.'
      }
    }
    turn.queue.push(
      eventFor(state, 'approval_resolved', {
        turnId: turn.turnId,
        requestId,
        approved: decision.approved,
        ...(decision.answers ? { answers: decision.answers } : {}),
      }),
    )
    if (!decision.approved) {
      if (permissionContext?.toolUseID) state.declinedToolUseIds.add(permissionContext.toolUseID)
      return {
        behavior: 'deny',
        message:
          planTransitionError ??
          (questions
            ? 'The user dismissed the question without answering.'
            : plan !== null
              ? 'The user rejected this plan. Revise it and keep planning.'
              : 'The user denied this tool use in SprintEngine.'),
      }
    }
    if (questions) {
      // AskUserQuestion completes headlessly when the answers ride the input:
      // the CLI-side tool returns them to the model without prompting.
      return { behavior: 'allow', updatedInput: { ...toolInput, answers: decision.answers ?? {} } }
    }
    return { behavior: 'allow', updatedInput: toolInput }
  }

  const adapter: ClaudeAgentProviderAdapter = {
    id: CLAUDE_AGENT_PROVIDER_ID,
    displayName: 'Claude Code',
    executionHostCli: 'claude-code',
    capabilities: {
      permissionModes: [...conversationPermissionModes('claude-code')],
      tools: true,
      approvals: true,
      questions: true,
      planMode: true,
      images: true,
      skills: 'native',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      interrupt: true,
      resume: true,
      subagents: true,
      cost: true,
      contextMeter: false,
      liveModelSwitch: true,
      mcpServerActions: ['reconnect', 'enable', 'disable', 'sign-in'],
      atMentions: true,
      steer: true,
      rewind: true,
      fork: true,
    },
    sessions: 'stateful',
    acceptsMcpServers: true,
    listModels: () => [...CLAUDE_AGENT_MODELS],

    startSession(input: MockAdapterSessionInput) {
      const state: SessionState = {
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        providerId: input.providerId,
        modelId: input.modelId,
        workspaceRoot: input.workspaceRoot ?? '',
        cliRuntimes: input.cliRuntimes,
        permissionPreset: input.permissionPreset ?? 'none',
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
        allowedTools: input.allowedTools,
        ...(input.mcpServers?.length ? { mcpServers: input.mcpServers } : {}),
        skillPluginDir: null,
        onBeforeTool: input.onBeforeTool,
        providerSessionId: input.resumeSessionId?.trim() || null,
        lastChainUuid: null,
        settledChainUuid: null,
        openToolUseIds: new Set(),
        resumeAt: (input.resumeSessionId?.trim() && input.resumeSessionAt?.trim()) || null,
        query: null,
        inputQueue: null,
        abort: null,
        childPid: null,
        spawnedAt: null,
        turn: null,
        pendingPermissions: new Map(),
        childPreset: null,
        childMode: null,
        pendingSessionEvents: [],
        onSessionEvent: input.onSessionEvent ?? null,
        continuationSequence: 0,
        lastActivityAt: now(),
        stderrTail: '',
        queryCostUsd: 0,
        spawning: null,
        spawnGeneration: 0,
        pendingSendUuids: new Set(),
        interruptedSendUuids: new Set(),
        textSeam: false,
        declinedToolUseIds: new Set(),
        subagents: new Map(),
        agentLanes: new Map(),
        tasks: new Map(),
        monitorCalls: new Map(),
        commandSkills: null,
        terminalCommands: null,
        commandOutputShown: false,
        compactedInExchange: false,
      }
      sessions.set(input.sessionId, state)
      return [
        eventFor(state, 'session_started', {
          providerSessionId: state.providerSessionId,
          // A rewind no turn has been sent after still applies on the next
          // restart, so the cursor this event records keeps it.
          ...(state.resumeAt ? { providerResumeAt: state.resumeAt } : {}),
          resumed: state.providerSessionId !== null,
        }),
        eventFor(state, 'session_ready'),
      ]
    },

    async *sendTurn(input: MockAdapterTurnInput): AsyncIterable<ConversationEvent> {
      const state = sessions.get(input.sessionId)
      if (!state) {
        yield turnFailure(input, 'invalid_session', 'Conversation session is not registered with the Claude provider.')
        return
      }
      yield eventFor(state, 'turn_started', { turnId: input.turnId })
      try {
        const nextMode = input.mode ?? 'default'
        if (state.reasoningEffort !== input.reasoningEffort) {
          disposeChild(state)
          state.mode = nextMode
          state.reasoningEffort = input.reasoningEffort
        } else if (state.mode !== nextMode) {
          if (!(await switchModeLive(state, nextMode))) disposeChild(state)
          state.mode = nextMode
        }
        const skillIds = [...new Set(input.skills ?? [])].sort()
        if (JSON.stringify(skillIds) !== JSON.stringify(state.skillIds ?? [])) {
          disposeChild(state)
          state.skillIds = skillIds
        }
        await ensureQuery(state)
      } catch (error) {
        yield eventFor(state, 'turn_failed', {
          turnId: input.turnId,
          reason: 'spawn',
          message: error instanceof Error ? error.message : 'Claude Code could not be started.',
        })
        return
      }
      const turn: ActiveTurn = {
        turnId: input.turnId,
        requestId: input.requestId,
        approvalSequence: 0,
        queue: new PushStream<ConversationEvent>(),
      }
      // Taking the session's turn over (a continuation opened in the window
      // before the runtime's busy guard could see it): end the queue being
      // replaced first, so its drain stops instead of awaiting an iterator
      // nobody will ever end.
      state.turn?.queue.end()
      state.turn = turn
      state.lastActivityAt = now()
      for (const pendingEvent of state.pendingSessionEvents.splice(0)) turn.queue.push(pendingEvent)

      const onAbort = (): void => {
        interruptChild(state)
        resolveAllPendingPermissions(state, { approved: false })
        turn.queue.end()
      }
      if (input.signal?.aborted) {
        onAbort()
      } else {
        input.signal?.addEventListener('abort', onAbort, { once: true })
      }

      // The turn is the session's before its message reaches the child, and
      // nothing between the two yields: a steer finds this turn only once the
      // child has what it joins. The note naming the attached skills goes
      // ahead of prose only: Claude Code runs a message as a slash command
      // when it starts with `/`, and read after a note it would be prose. The
      // skills stay loaded for the command either way.
      const opensWithCommand =
        leadingCommandFor(input.message, { cli: CLAUDE_COMMANDS_CLI, cwd: state.workspaceRoot }) !== null
      if (!turn.queue.closed)
        pushUserMessage(
          state,
          buildUserMessageContent(
            input.skills?.length && !opensWithCommand
              ? `Use the attached skills: ${input.skills.map(attachedSkillName).join(', ')}.\n\n${input.message}`
              : input.message,
            input.attachments,
            opensWithCommand,
          ),
        )

      try {
        for await (const event of turn.queue) yield event
      } finally {
        input.signal?.removeEventListener('abort', onAbort)
        if (state.turn === turn) state.turn = null
        // A permission that never resolved (turn torn down first) must not
        // leave the child blocked forever.
        resolvePendingPermissionsForTurn(state, turn.turnId, { approved: false })
        state.lastActivityAt = now()
      }
    },

    // A message for the turn that is running: it goes into the child's input
    // and the CLI takes it in at its next tool round, or, when none is left,
    // answers it by itself right after the reply it is writing. Either way the
    // running turn stays the one carrying the events, and ends only once a
    // result has answered this message too (pendingSendUuids). Nothing that
    // would respawn the child — a mode, effort, skills or preset change — is
    // applied here, since a respawn would drop the work the message is meant
    // to redirect; the next ordinary send applies it.
    async steer(input: MockAdapterSteerInput): Promise<ConversationProviderSteerResult> {
      const state = sessions.get(input.sessionId)
      if (!state) return { ok: false, message: 'Conversation session is not registered with the Claude provider.' }
      const turn = openTurn(state)
      if (!turn || turn.turnId !== input.turnId || !state.query || !state.inputQueue)
        return { ok: false, message: 'The agent is not working on that turn any more.' }
      // Where the session stands as the message goes in: what "Edit from
      // here" on it goes back to.
      const sessionId = state.providerSessionId
      const at = state.settledChainUuid
      pushUserMessage(
        state,
        buildUserMessageContent(
          input.message,
          input.attachments,
          leadingCommandFor(input.message, { cli: CLAUDE_COMMANDS_CLI, cwd: state.workspaceRoot }) !== null,
        ),
      )
      state.lastActivityAt = now()
      return { ok: true, ...(sessionId && at ? { providerCursor: { sessionId, at } } : {}) }
    },

    resolveApproval(input: MockAdapterApprovalInput) {
      const state = sessions.get(input.sessionId)
      if (!state) return []
      const pending = state.pendingPermissions.get(input.requestId)
      if (!pending) {
        // Nothing here is waiting on that answer any more — the child that
        // asked ended, or was replaced, while the card was up. Answering into
        // nothing left the card standing and the chat locked behind it with
        // no way on, so the card is closed instead, and a turn whose child is
        // gone is ended: the next message respawns it, resumed.
        const turnId = input.turnId || state.turn?.turnId
        const events = [
          eventFor(state, 'approval_resolved', {
            ...(turnId ? { turnId } : {}),
            requestId: input.requestId,
            approved: false,
          }),
        ]
        if (!state.query && turnId) {
          endTurn(state)
          events.push(
            eventFor(state, 'turn_failed', {
              turnId,
              reason: 'provider',
              message: 'Claude Code stopped while this was waiting for an answer. Send a message to carry on.',
              ...providerCursorPayload(state),
            }),
          )
        }
        return events
      }
      state.pendingPermissions.delete(input.requestId)
      pending.resolve({ approved: input.approved, answers: input.answers })
      // approval_resolved is emitted through the still-open turn stream so the
      // transcript stays ordered; nothing to return here.
      return []
    },

    // Live permission switch. The preset is recorded and pushed into a running
    // child through the SDK's `setPermissionMode`, which takes effect at once,
    // mid-reply included: Manual is the child's 'default' (and the hook in
    // `manualAsks`), Auto its classifier 'auto', Bypass its 'bypassPermissions'
    // (every child is spawned able to take it). Approvals already waiting that
    // bypass would not have asked are answered yes, through the same callback a
    // person's answer takes; the runtime answers the ones Auto covers
    // (shared/conversation/permissionModes.ts). `none` is the CLI's own default,
    // which no mode names: mid-reply the child drops to 'default' so nothing
    // looser carries on, and the next turn respawns it (resumed) as `none`
    // spawns; an idle child is replaced at once. A child that refuses the mode
    // is replaced the same way, and mid-reply that waits for the next message,
    // since disposing it would drop the reply the user is reading — though a
    // looser mode is answered by the runtime meanwhile, so only a stricter one
    // says so. A child that does not answer at all counts as refusing. A child a
    // background agent is still working in waits the same way, or the agent
    // would end with it.
    async setPermissionPreset(input: MockAdapterPermissionInput): Promise<ConversationProviderPermissionResult> {
      const state = sessions.get(input.sessionId)
      if (!state) return { ok: false, message: 'Conversation session is not registered with the Claude provider.' }
      state.permissionPreset = input.permissionPreset
      if (input.permissionMode) state.permissionMode = input.permissionMode
      else delete state.permissionMode
      state.lastActivityAt = now()
      if (state.mode === 'ask' || state.mode === 'plan')
        return { ok: true, notice: 'The permission preset applies when you return to the default mode.' }
      if (!state.query || childHonorsPreset(state)) return { ok: true }
      const next = state.permissionPreset
      const nextMode = ownSdkMode(state)
      const target = sdkPermissionMode(state)
      if (target === undefined && childIsIdle(state)) {
        disposeChild(state)
        return { ok: true }
      }
      const query = state.query
      const before = state.childPreset
      // Until the child answers, which mode it is on is not known: a switch
      // back made meanwhile sends its own mode rather than take the one this
      // is replacing as still in force, and the requests reach it in order.
      state.childPreset = null
      state.childMode = null
      // Bounded: a child that never answers the control request (a process
      // wedged inside WSL) held the switch — and the chip, and the answer the
      // person had just given — for as long as the process lived.
      const switched = await answeredWithin(query.setPermissionMode(target ?? 'default'), childAnswerTimeoutMs, {
        rejectAsUnanswered: true,
      })
      if (!switched) {
        if (state.query !== query) return { ok: true }
        // Which mode the child ends on is not known: it may yet take this one
        // late. It is trusted with neither, so a switch back sends its mode
        // and the next turn respawns the child, rather than taking the old
        // preset as still in force under a child that went to bypass.
        state.childPreset = null
        state.childMode = null
        if (childIsIdle(state)) {
          disposeChild(state)
          return { ok: true }
        }
        // A LOOSER mode is in force at once all the same: the child still
        // asks, and the runtime answers by the session's recorded mode
        // (permissionModeAllows), so the very next request the new mode covers
        // never reaches the person. Manual is in force at once too, through
        // the hook in `manualAsks`, which reads the session's preset. Only
        // another STRICTER mode waits — the child would run, unasked, what it
        // now should ask about — and only that is worth a sentence.
        if ((next === 'manual' && !nextMode) || (before && isLooserCliPermissionPreset(next, before)))
          return { ok: true }
        return { ok: true, notice: 'The stricter permissions apply from your next message.' }
      }
      if (state.query !== query) return { ok: true }
      // Moved again while the child answered: which mode it ended on is not
      // known here, so it is trusted with nothing more and the next turn
      // respawns it. `none` has no mode of its own either.
      const settled = target !== undefined && state.permissionPreset === next && ownSdkMode(state) === nextMode
      state.childPreset = settled ? next : null
      state.childMode = settled ? nextMode : null
      if (state.childPreset !== 'bypass') return { ok: true }
      for (const [requestId, pending] of Array.from(state.pendingPermissions)) {
        if (!pending.bypassable) continue
        state.pendingPermissions.delete(requestId)
        pending.resolve({ approved: true })
      }
      return { ok: true }
    },

    // Live model switch. The model is recorded for every later turn and pushed
    // into the running query (the SDK's `setModel`, which takes effect on the
    // next message it reads). A query that refuses is replaced instead when no
    // turn is running: the next turn respawns it with `resume` on the new
    // model, so the conversation continues. Mid-turn the reply on screen
    // finishes on the model it started with.
    // The child is started for it when the chat is resting: its servers are
    // its own, and only a running one can reconnect or sign in to one.
    async mcpServerAction(input) {
      const state = sessions.get(input.sessionId)
      if (!state) return { ok: false, message: 'Conversation session is not registered with the Claude provider.' }
      try {
        await ensureQuery(state)
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Claude Code could not be started.' }
      }
      const q = state.query
      if (!q) return { ok: false, message: 'Claude Code is not running for this chat.' }
      try {
        if (input.action === 'reconnect') await q.reconnectMcpServer(input.serverId)
        else if (input.action === 'enable' || input.action === 'disable')
          await q.toggleMcpServer(input.serverId, input.action === 'enable')
        else {
          // Not in the SDK's declared surface yet, but sent by its own client
          // (`mcp_authenticate`): the CLI answers the URL to sign in at and
          // listens for the callback itself.
          const authenticate = (q as unknown as { mcpAuthenticate?: (name: string) => Promise<unknown> })
            .mcpAuthenticate
          if (typeof authenticate !== 'function')
            return {
              ok: false,
              message: 'This Claude Code cannot sign in to MCP servers from here. Run /mcp in its terminal.',
            }
          const answer = (await authenticate.call(q, input.serverId)) as { authUrl?: unknown } | null
          watchSignIn(state, input.serverId)
          const authUrl =
            typeof answer?.authUrl === 'string' && /^https?:\/\//u.test(answer.authUrl) ? answer.authUrl : null
          return { ok: true, ...(authUrl ? { authUrl } : {}) }
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Claude Code refused that.' }
      }
      await refreshMcpServers(state)
      return { ok: true }
    },

    async setModel(input: MockAdapterModelInput): Promise<ConversationProviderPermissionResult> {
      const state = sessions.get(input.sessionId)
      if (!state) return { ok: false, message: 'Conversation session is not registered with the Claude provider.' }
      state.modelId = input.nextModelId
      state.lastActivityAt = now()
      const notice = state.turn
        ? 'The new model starts with your next message — this reply finishes on the model it started with.'
        : undefined
      if (!state.query) return { ok: true, ...(notice ? { notice } : {}) }
      try {
        await state.query.setModel(input.nextModelId === CONVERSATION_DEFAULT_MODEL_ID ? undefined : input.nextModelId)
      } catch {
        if (childIsIdle(state)) disposeChild(state)
      }
      return { ok: true, ...(notice ? { notice } : {}) }
    },

    interrupt(input: MockAdapterSessionInput) {
      const state = sessions.get(input.sessionId)
      if (!state) return []
      const turnId = state.turn?.turnId
      endUnresponsiveChildAfterStop(state, interruptChild(state))
      resolveAllPendingPermissions(state, { approved: false })
      endTurn(state)
      return [
        eventFor(state, 'turn_failed', {
          ...(turnId ? { turnId } : {}),
          reason: 'interrupted',
          ...providerCursorPayload(state),
        }),
      ]
    },

    // Take an idle session back to the end of an earlier turn (or before the
    // first). The live child is dropped rather than asked: the next turn
    // spawns one that forks the provider session at that turn's last entry,
    // so what came after it is out of the model's context while the session
    // it came from stays untouched on disk.
    async rewind(input: MockAdapterRewindInput): Promise<ConversationProviderPermissionResult> {
      const state = sessions.get(input.sessionId)
      if (!state) return { ok: false, message: 'Conversation session is not registered with the Claude provider.' }
      if (state.turn) return { ok: false, message: 'Stop the running turn before editing an earlier message.' }
      if (input.cursor && !input.cursor.at)
        return { ok: false, message: 'Claude Code did not record where this conversation stood before that message.' }
      disposeChild(state)
      state.providerSessionId = input.cursor?.sessionId ?? null
      state.resumeAt = input.cursor?.at ?? null
      state.lastChainUuid = input.cursor?.at ?? null
      state.settledChainUuid = input.cursor?.at ?? null
      state.pendingSessionEvents = []
      state.lastActivityAt = now()
      return { ok: true }
    },

    // A fork branches this chat's session where a rewind would: its first
    // child resumes the session up to the turn's last entry as a fork of its
    // own (`resumeSessionAt`), so the session it came from stays as it was
    // whatever the parent does meanwhile. That needs the entry the turn's end
    // recorded; a Claude chat has no other way in, since it does not take the
    // conversation as text.
    async fork(input: MockAdapterForkInput): Promise<ConversationProviderForkResult> {
      if (input.exact && input.cursor?.at) return { ok: true, cursor: input.cursor }
      if (input.exact && !input.cursor) return { ok: true, cursor: null }
      return {
        ok: false,
        message:
          'Claude Code did not record where this conversation stood at that point, so it cannot be forked there.',
      }
    },

    stopSession(input: MockAdapterSessionInput) {
      const state = sessions.get(input.sessionId)
      if (!state) return []
      state.spawnGeneration += 1
      disposeChild(state)
      sessions.delete(input.sessionId)
      return [eventFor(state, 'session_closed')]
    },

    listLiveSessions(): ConversationProviderLiveSession[] {
      return Array.from(sessions.values()).map((state) => ({
        sessionId: state.sessionId,
        workspaceId: state.workspaceId,
        agentId: state.agentId,
        workspaceRoot: state.workspaceRoot,
        providerSessionId: state.providerSessionId,
        hasChildProcess: state.query !== null,
        childPid: state.childPid,
        turnActive: state.turn !== null,
        pendingApproval: state.pendingPermissions.size > 0,
        lastActivityAt: state.lastActivityAt,
        spawnedAt: state.spawnedAt,
      }))
    },

    // Each listed task is stopped by name, and reports `stopped` the way it
    // would have reported its end: that is what takes it off the list. Agents
    // are not among them; their lanes are stopped with the turn. Bounded, as
    // every request to the child is: one that never answers holds nothing.
    async stopBackgroundTasks(sessionId: string): Promise<boolean> {
      const state = sessions.get(sessionId)
      const q = state?.query
      if (!state || !q) return false
      const listed = backgroundTaskList(state.tasks)
      if (listed.length === 0) return false
      state.lastActivityAt = now()
      await Promise.all(listed.map((task) => answeredWithin(q.stopTask(task.taskId), childAnswerTimeoutMs)))
      return true
    },

    disposeChildProcess(sessionId: string, _options?: ConversationDisposeOptions): boolean {
      const state = sessions.get(sessionId)
      if (!state) return false
      // A child still being spawned is called off, so it cannot outlive a
      // Settle or a suspend that came while it was starting.
      const spawning = state.spawning !== null
      if (spawning) state.spawnGeneration += 1
      if (state.query === null) return spawning
      return disposeChild(state)
    },

    async disposeAll(): Promise<void> {
      for (const state of sessions.values()) {
        state.spawnGeneration += 1
        disposeChild(state)
      }
      await Promise.all(removals)
    },
  }

  return adapter
}

// Attached skills reach the child as one local plugin, because the project's
// own skill directory is only read together with the project's settings. The
// resolver has already installed each one under `.claude/skills/<id>`; they are
// copied so the plugin holds nothing the workspace could later swap.
const ATTACHED_SKILLS_PLUGIN = 'attached-skills'
// A plugin-qualified id names a skill of a plugin the user installed, which
// the user setting source still loads; only workspace skills are staged.
const attachedSkillName = (id: string) => (id.includes(':') ? id : `${ATTACHED_SKILLS_PLUGIN}:${id}`)

// Staged folders are named for the process that made them, so a sweep can
// tell one a running app still uses from one a dead process left behind.
const SKILL_PLUGIN_PREFIX = 'sprintengine-claude-skills-'

async function stageAttachedSkills(tempDir: string, workspaceRoot: string, skillIds: string[]): Promise<string | null> {
  skillIds = skillIds.filter((id) => !id.includes(':'))
  if (!skillIds.length) return null
  const dir = await mkdtemp(join(tempDir, `${SKILL_PLUGIN_PREFIX}${process.pid}-`))
  try {
    await mkdir(join(dir, '.claude-plugin'))
    await writeFile(
      join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: ATTACHED_SKILLS_PLUGIN, description: 'Skills attached to this conversation.' }),
    )
    for (const id of skillIds) {
      if (!/^[\w.-]+$/.test(id) || id === '.' || id === '..') throw new Error(`Attached skill ${id} is invalid.`)
      const source = await realpath(join(workspaceRoot, '.claude', 'skills', id))
      await cp(source, join(dir, 'skills', id), { recursive: true })
    }
    return dir
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Remove plugin folders that no running process owns: named for a process
 * that has exited, or from before folders were named for one and older than
 * a day. A folder of this process, or of another app still running, stays.
 * Only real directories this user owns, created before this process started,
 * are ever touched.
 */
export async function sweepStaleSkillPlugins(tempDir: string): Promise<void> {
  const startedAt = Date.now() - process.uptime() * 1000
  const uid = process.getuid?.()
  for (const name of await readdir(tempDir)) {
    if (!name.startsWith(SKILL_PLUGIN_PREFIX)) continue
    const path = join(tempDir, name)
    const info = await lstat(path).catch(() => null)
    if (!info?.isDirectory() || info.isSymbolicLink() || info.mtimeMs >= startedAt) continue
    if (uid !== undefined && info.uid !== uid) continue
    const owner = /^(\d+)-/.exec(name.slice(SKILL_PLUGIN_PREFIX.length))?.[1]
    if (owner ? isRunning(Number(owner)) : Date.now() - info.mtimeMs < 24 * 60 * 60 * 1000) continue
    await rm(path, { recursive: true, force: true }).catch(() => undefined)
  }
}

function isRunning(pid: number): boolean {
  return pid === process.pid || processIsRunning(pid)
}

// The project instructions Claude Code would read from a trusted checkout. The
// project setting source is off (see ensureQuery), so they are read here and
// appended to the system prompt: instructions only, never settings.
const INSTRUCTION_FILES = ['CLAUDE.md', join('.claude', 'CLAUDE.md')]
const INSTRUCTION_BYTES = 64 * 1024

async function readWorkspaceInstructions(workspaceRoot: string): Promise<string> {
  const sections: string[] = []
  for (const name of INSTRUCTION_FILES) {
    try {
      const file = await openConfinedExistingFile(workspaceRoot, name)
      try {
        if ((await file.stat()).size > INSTRUCTION_BYTES) continue
        const text = (await readBoundedConversationFile(file, INSTRUCTION_BYTES)).toString('utf8').trim()
        if (text) sections.push(`Contents of ${join(workspaceRoot, name)} (project instructions):\n\n${text}`)
      } finally {
        await file.close()
      }
    } catch {
      // Absent, a symlink, or unreadable: the session runs without it.
    }
  }
  return sections.join('\n\n')
}

// How long a child has to answer a control request — a permission-mode switch,
// a stop — before it is taken to be wedged. A live child answers in
// milliseconds; this only ever fires on one that will not answer at all.
const UNRESPONSIVE_CHILD_MS = 5_000
// How long, and how often, a server's state is read again after a sign-in.
const MCP_SIGN_IN_WATCH_MS = 5 * 60_000
const MCP_SIGN_IN_POLL_MS = 3_000

/**
 * Whether `promise` settled within `ms`. A rejection counts as an answer
 * unless `rejectAsUnanswered` — for a request whose refusal means the same as
 * silence to the caller.
 */
function answeredWithin(
  promise: Promise<unknown>,
  ms: number,
  options: { rejectAsUnanswered?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    timer.unref?.()
    promise.then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      () => {
        clearTimeout(timer)
        resolve(!options.rejectAsUnanswered)
      },
    )
  })
}

// Terminal-preset → SDK permission-mode mapping, mirroring the claude-code
// plugin manifest's flags (`--permission-mode default|auto|
// bypassPermissions`). `none` maps to undefined on purpose: it means "pass no
// permission flag and let the harness's own default win", which for the SDK is
// leaving permissionMode unset rather than pinning it to 'default'.
//
// Auto is the CLI's own classifier mode, 'auto' (owner ruling 2026-10-01), as
// Cursor's Auto is its auto-review: a person who picks Auto for Claude expects
// Claude's auto mode, and 'acceptEdits' — which asked before every command —
// was not it. What the classifier blocks goes back to Claude, not to a card.
// An account or model the classifier is not offered to gets the CLI's asking
// mode instead, and the runtime still answers what Auto covers there
// (shared/conversation/permissionModes.ts).
const SDK_PERMISSION_MODE_BY_PRESET: Record<
  ConversationPermissionPreset,
  'default' | 'auto' | 'bypassPermissions' | undefined
> = {
  none: undefined,
  manual: 'default',
  auto: 'auto',
  bypass: 'bypassPermissions',
}

// Claude Code's other modes a chat runs, by the id its manifest keys them
// under, each at the preset it sits at (conversationPermissionModes). Accept
// edits is what Auto was before it became the classifier; Don't ask refuses
// whatever the person's allow rules do not cover, and asks about nothing.
const SDK_PERMISSION_MODE_BY_OWN_MODE: Readonly<
  Record<string, { level: ConversationPermissionPreset; sdk: 'acceptEdits' | 'dontAsk' }>
> = {
  acceptEdits: { level: 'auto', sdk: 'acceptEdits' },
  dontAsk: { level: 'manual', sdk: 'dontAsk' },
}

// The mode of Claude Code's own a session runs, or null for its preset's own:
// one it does not have, or has at another preset, is not run in its place.
function ownSdkMode(state: { permissionPreset: ConversationPermissionPreset; permissionMode?: string }) {
  const own =
    state.permissionMode && Object.hasOwn(SDK_PERMISSION_MODE_BY_OWN_MODE, state.permissionMode)
      ? SDK_PERMISSION_MODE_BY_OWN_MODE[state.permissionMode]
      : undefined
  return own && own.level === state.permissionPreset ? state.permissionMode! : null
}

// The SDK permission mode a session's child runs under, outside plan and ask.
function sdkPermissionMode(state: { permissionPreset: ConversationPermissionPreset; permissionMode?: string }) {
  const own = ownSdkMode(state)
  return own ? SDK_PERMISSION_MODE_BY_OWN_MODE[own]!.sdk : SDK_PERMISSION_MODE_BY_PRESET[state.permissionPreset]
}

// Sanitize the CLI tool's AskUserQuestion input into the provider-neutral
// question payload. Returns null when the shape is unrecognized so the call
// degrades to a generic tool approval instead of a broken card.
function parseAskUserQuestions(toolInput: Record<string, unknown>): ConversationQuestion[] | null {
  const rawQuestions = toolInput.questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null
  const questions: ConversationQuestion[] = []
  for (const rawQuestion of rawQuestions) {
    const record = asRecord(rawQuestion)
    if (!record || typeof record.question !== 'string' || !record.question.trim()) return null
    const rawOptions = Array.isArray(record.options) ? record.options : []
    const options = rawOptions
      .map((rawOption) => {
        const option = asRecord(rawOption)
        if (!option || typeof option.label !== 'string' || !option.label.trim()) return null
        return {
          label: option.label,
          ...(typeof option.description === 'string' && option.description.trim()
            ? { description: option.description }
            : {}),
        }
      })
      .filter((option): option is { label: string; description?: string } => option !== null)
    if (options.length === 0) return null
    questions.push({
      question: record.question,
      ...(typeof record.header === 'string' && record.header.trim() ? { header: record.header } : {}),
      multiSelect: record.multiSelect === true,
      // The CLI's own question UI always offers a free-text "Other"; mirror it.
      allowFreeText: true,
      options,
    })
  }
  return questions.length > 0 ? questions : null
}

function readPlanText(toolInput: Record<string, unknown>): string {
  return typeof toolInput.plan === 'string' ? toolInput.plan : ''
}

// Compose the SDK user-message content. Text-only turns keep the plain string
// shape (unchanged path); when images are attached, the content becomes a
// multimodal block array — the text block (when present) followed by one base64
// `image` block per attachment. Media types are already validated at the IPC
// boundary, so they are trusted here.
//
// A message that opens with a slash command keeps its text last instead:
// Claude Code runs a block array as a command only when its *last* block is
// text starting with `/` (read off Claude Code 2.1.284, which checks
// `content.at(-1)`), so images ahead of it ride along with the command rather
// than turning it into prose.
export function buildUserMessageContent(
  message: string,
  attachments: ConversationImageAttachment[] | undefined,
  // Whether the message runs as a command: the session judges that against the
  // list its CLI reported, and without one the message's look decides.
  opensWithCommand = leadingSlashCommand(message) !== null,
): SDKUserMessage['message']['content'] {
  if (!attachments || attachments.length === 0) return message
  const blocks: Exclude<SDKUserMessage['message']['content'], string> = []
  const commandLast = opensWithCommand
  if (message && !commandLast) blocks.push({ type: 'text', text: message })
  for (const attachment of attachments) {
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        // The IPC boundary already constrains this to the SDK's image set; the
        // cast is the only widening TS cannot see through.
        media_type: attachment.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
        data: attachment.dataBase64,
      },
    })
  }
  if (commandLast) blocks.push({ type: 'text', text: message })
  return blocks
}

// Whether a `result` ends the exchange: every message handed to the child has
// been answered and the CLI holds none queued. A message steered in while a
// tool ran is folded into that same exchange and named by its one result; one
// steered in while the final reply was being written is answered by a second
// result of its own, which is the one that ends the turn. The `result` names
// the messages it answered by the ids they were sent with; a CLI that names
// none has answered everything sent. A failed result ends the exchange
// regardless, so its error is shown rather than waited past — unless it names
// only messages nothing is waiting on, which makes it the late end of an
// exchange that is already over (one a Stop cut off) and none of this turn's.
function resultEndsExchange(pendingSendUuids: Set<string>, message: Record<string, unknown>): boolean {
  const answered = answeredSendUuids(message)
  if (pendingSendUuids.size > 0 && answered?.length && !answered.some((uuid) => pendingSendUuids.has(uuid)))
    return false
  if (message.subtype !== 'success' || message.is_error === true) {
    pendingSendUuids.clear()
    return true
  }
  // The child takes messages in the order they were sent, so one answered
  // answers every one sent before it too, whether or not the result lists
  // them all (merged sends name only their last before the list existed).
  const sent = Array.from(pendingSendUuids)
  const through = answered === null ? sent.length - 1 : Math.max(-1, ...answered.map((uuid) => sent.indexOf(uuid)))
  for (const uuid of sent.slice(0, through + 1)) pendingSendUuids.delete(uuid)
  const queued = typeof message.queued_turn_count === 'number' && message.queued_turn_count > 0
  return pendingSendUuids.size === 0 && !queued
}

// The ids of the messages a `result` says it answered; null from a CLI that
// names none.
function answeredSendUuids(message: Record<string, unknown>): string[] | null {
  return Array.isArray(message.user_message_uuids)
    ? message.user_message_uuids.filter((uuid): uuid is string => typeof uuid === 'string')
    : typeof message.user_message_uuid === 'string'
      ? [message.user_message_uuid]
      : null
}

// Whether a `result` is the end of the exchange a Stop cut off: it names only
// messages sent before the Stop, or names none at all, from a CLI whose
// results never do.
function answersOnlyInterrupted(interruptedSendUuids: Set<string>, message: Record<string, unknown>): boolean {
  const answered = answeredSendUuids(message)
  return !answered?.length || answered.every((uuid) => interruptedSendUuids.has(uuid))
}

// Stamp a continuation turn id onto a turn-scoped event that was mapped before
// the continuation turn existed (its payload.turnId is absent). Session-scoped
// events and events that already carry a turnId are returned unchanged, so the
// normal per-turn path is a no-op.
function withContinuationTurnId(event: ConversationEvent, turnId: string): ConversationEvent {
  if (isSessionScopedEvent(event)) return event
  const current = event.payload?.turnId
  if (typeof current === 'string' && current) return event
  return { ...event, payload: { ...event.payload, turnId } }
}

// Spawn the SDK-computed command ourselves so the child PID lands on the
// session state (the default SDK spawn hides it). Also owns stderr capture:
// the SDK's `stderr` option only applies to its internal spawn path.
// The child is issued its own gateway token, in its environment: the app's
// MCP bridge it starts inherits it and presents it, and the gateway takes the
// chat's identity from it. Taken back when the child ends.
function spawnLocalChild(spawnInput: SpawnOptions): ChildProcess {
  const env = spawnInput.env as Record<string, string | undefined>
  const launch = localLaunchToken(launchIdentityOfEnv(env))
  let child: ChildProcess
  try {
    child = spawn(spawnInput.command, spawnInput.args, {
      cwd: spawnInput.cwd,
      env: claudeLocalChildEnv(env, launch?.token ?? null, spawnInput.cwd),
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: spawnInput.signal,
      windowsHide: true,
    })
  } catch (error) {
    launch?.revoke()
    throw error
  }
  if (launch) {
    child.once('close', () => launch.revoke())
    child.on('error', () => {
      if (child.pid === undefined) launch.revoke()
    })
  }
  // On Linux the kernel's out-of-memory killer takes the agent before the app.
  void raiseChildOomScore(child.pid)
  return child
}

/**
 * The environment a Claude child on this machine starts with: the SDK's, with
 * this child's own gateway token in place of any inherited one, and, on This
 * PC in a folder inside a WSL distribution, that folder listed as safe for
 * the agent's own git, as the app's git has it.
 */
export function claudeLocalChildEnv(
  env: Record<string, string | undefined>,
  launchToken: string | null,
  cwd: string | undefined,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return wslShareSafeDirectoryEnv(
    { ...withoutLaunchToken(env), ...(launchToken ? { [MCP_CHANNEL_TOKEN_ENV]: launchToken } : {}) },
    cwd,
    platform,
  )
}

function withoutLaunchToken(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const next = { ...env }
  delete next[MCP_CHANNEL_TOKEN_ENV]
  return next
}

function spawnTrackedChild(state: SessionState, start: () => ChildProcess, now: () => number): SpawnedProcess {
  const child = start()
  state.childPid = child.pid ?? null
  state.spawnedAt = now()
  child.stderr?.on('data', (data: Buffer) => {
    state.stderrTail = `${state.stderrTail}${data.toString()}`.slice(-4000)
  })
  child.once('exit', () => {
    if (state.childPid === child.pid) state.childPid = null
  })
  // Not started at all: the remembered path is looked up again next time.
  child.once('error', () => {
    if (child.pid === undefined)
      void import('../cli-runtime-install').then(({ invalidateCliExecutable }) =>
        invalidateCliExecutable('claude-code'),
      )
  })
  return {
    stdin: child.stdin!,
    stdout: child.stdout!,
    get killed() {
      return child.killed
    },
    get exitCode() {
      return child.exitCode
    },
    kill: (signal: NodeJS.Signals) => child.kill(signal),
    on: child.on.bind(child),
    once: child.once.bind(child),
    off: child.off.bind(child),
  }
}

async function defaultLoadQuery(): Promise<SdkQueryFunction> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  // The words a turn refused by a usage limit ends with, as this SDK knows
  // them: the fallback for a CLI that does not say `terminal_reason`.
  useClaudeUsageLimitPrefixes(sdk.USAGE_LIMIT_ERROR_PREFIXES)
  return sdk.query
}

// The `claude` a chat runs, which the command probe runs too.
export { defaultResolveExecutable as resolveClaudeExecutable }

async function defaultResolveExecutable(cliRuntimes?: ConversationCliRuntimeOverrides): Promise<string> {
  const { resolveCliExecutable } = await import('../cli-runtime-install')
  const runtime = cliRuntimes?.['claude-code']
  const found = await resolveCliExecutable('claude-code', runtime)
  if (!found.path) {
    if (isWslHostId(runtime?.hostId)) {
      const machine = runtime.hostId.replace(/^wsl:/u, 'WSL: ')
      throw new Error(
        `Claude Code CLI was not found on ${machine}. Install it in that distribution (or set its command for that machine in Settings) to chat there.` +
          (found.error ? ` ${found.error}` : ''),
      )
    }
    throw new Error(
      'Claude Code CLI is not installed. Install it (or set a command override in Settings) to use Claude conversation agents.',
    )
  }
  return found.path
}

// Auth env this provider must never pass to the child. The conversation path
// is subscription-auth by contract: the CLI binds its own `claude login`
// credentials only when ANTHROPIC_API_KEY is absent — an inherited key wins
// silently and bills API usage with no visible banner (headless chat shows no
// CLI chrome). AUTH_TOKEN/BASE_URL redirect the CLI to third-party endpoints;
// they belong to the terminal zai/GLM launch path, never to this provider.
// CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR hands the CLI an API key through a pipe,
// which it binds ahead of the login just as it would the variable.
export const STRIPPED_ANTHROPIC_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
] as const

export function stripAnthropicAuthEnv(env: Record<string, string>): Record<string, string> {
  const next = { ...env }
  for (const key of STRIPPED_ANTHROPIC_AUTH_ENV_KEYS) delete next[key]
  return next
}

/**
 * The environment every chat child starts from, before it is marked with the
 * conversation it belongs to: the terminal's, without the auth that would
 * take the child off the person's login. The command probe asks with it, so
 * the CLI it asks sees what a chat's CLI sees.
 */
export async function claudeChatBaseEnv(): Promise<Record<string, string>> {
  // Deferred import keeps terminal-launch (and its transitive electron/pty
  // imports) out of unit tests that only exercise the mapping logic. It must
  // be import() — a bare require('../terminal-launch') survives bundling as a
  // runtime lookup relative to out/main/index.js and fails in the built app.
  const { getTerminalEnv } = await import('../terminal-launch')
  return stripAnthropicAuthEnv(getTerminalEnv())
}

async function defaultBuildEnv(input: {
  workspaceId: string
  agentId: string
  sessionId: string
}): Promise<Record<string, string>> {
  const { applyAgentIdentityEnv } = await import('../terminal-launch')
  const env = applyAgentIdentityEnv(await claudeChatBaseEnv(), {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
  })
  env[CLAUDE_AGENT_SESSION_ENV_KEY] = input.sessionId
  return env
}

// --- SDKMessage → ConversationEvent mapping (structural on purpose: the SDK
// message union churns across versions; unknown shapes are dropped) ---

export function mapSdkMessage(
  state: {
    sessionId: string
    workspaceId: string
    agentId: string
    providerId: string
    modelId: string
    providerSessionId: string | null
    turn: { turnId: string } | null
    queryCostUsd?: number
    declinedToolUseIds?: Set<string>
    subagents?: Map<string, TrackedSubagent>
    agentLanes?: Map<string, string>
    tasks?: Map<string, TrackedTask>
    monitorCalls?: Map<string, { persistent: boolean }>
    lastChainUuid?: string | null
    settledChainUuid?: string | null
    openToolUseIds?: Set<string>
    resumeAt?: string | null
    textSeam?: boolean
    // The lifetime of the cache the main chain's requests last wrote. A request
    // that only reads says nothing about it, so it carries over.
    promptCacheTtl?: PromptCacheTtl | null
    commandOutputShown?: boolean
    compactedInExchange?: boolean
    // The context window's reading, carried between the messages that make
    // it up: the model the init named (whose `modelUsage` row is the main
    // chain's), and the size of the main chain's latest request — what it sent
    // and what came back — which is what the window holds now.
    contextModel?: string | null
    contextPromptTokens?: number
    contextOutputTokens?: number
    // How the session bills, from its init's key source and its account
    // (`reportAccount`): a session that does not bill a plan reports no plan
    // limits, and none of what it says is taken as one.
    usageBilling?: 'subscription' | 'api' | null
    // The usage limits refusing this exchange's requests, by kind of limit (a
    // rejected `rate_limit_event`): an event that lets one kind through again
    // clears that kind and no other. Cleared at every result.
    usageRefusals?: Map<string, { windowId: string | null; resetsAt: number | null }>
    // The main chain's latest assistant message carried the CLI's
    // `rate_limit` error, and whether one this exchange said its sign-in
    // failed, which no usage limit explains. Cleared at every result.
    assistantRateLimited?: boolean
    assistantAuthFailed?: boolean
    // What the open turn has spent so far: each exchange's result reports its
    // own, and a turn a steered message extended is several exchanges. Told
    // on `turn_completed` and cleared at every turn end.
    turnUsage?: ConversationTurnUsage
    // The file reads among this session's calls: a picture a read returns is
    // the file the chat already shows by its path, and is not kept twice.
    fileReadToolUseIds?: Set<string>
    // The folder the session works in: with its workspace and agent, the
    // conversation a step's pictures are kept under (tool-result-images.ts).
    workspaceRoot?: string
    // Pictures being written for steps this message reported; the caller
    // waits for them before the events go out, so no path names a missing file.
    toolImageWrites?: Promise<void>[]
  },
  message: Record<string, unknown>,
  // exchangeContinues: a `result` that answers only part of what the child was
  // sent: the turn goes on, so it reports usage but neither ends the turn nor
  // counts its cost. interrupted: the tail of an exchange a Stop cut off, read
  // only for where the session stands; its result settles the chain and leaves
  // its cost in the running total for the next result to report.
  // saveToolImages: where a step's returned pictures are written
  // (tool-result-images.ts); false keeps none, as an import does.
  options: {
    exchangeContinues?: boolean
    interrupted?: boolean
    saveToolImages?: SaveToolResultImages | false
  } = {},
): ConversationEvent[] {
  const turnId = state.turn?.turnId
  const events: ConversationEvent[] = []
  const init = message.type === 'system' && message.subtype === 'init'
  noteMonitorCalls(state, message)
  // Only the child's init names the session it runs. Anything before it can
  // carry an id no session was ever written under: a fork that failed to find
  // its point reports its error under a fresh one.
  const messageSessionId = init && typeof message.session_id === 'string' ? message.session_id : null
  // The main chain's newest entry: what the turn's end records as the point a
  // rewind can fork at. A subagent's messages live in a chain of their own,
  // and the copy of a local command's output the CLI makes for its stream is
  // not an entry of the session at all.
  if (
    (message.type === 'assistant' || message.type === 'user') &&
    !readParentToolUseId(message) &&
    typeof message.local_command_source !== 'string' &&
    typeof message.uuid === 'string' &&
    message.uuid
  ) {
    state.lastChainUuid = message.uuid
    const blocks = asRecord(message.message)?.content
    for (const block of Array.isArray(blocks) ? blocks.map(asRecord) : []) {
      if (block?.type === 'tool_use' && typeof block.id === 'string') state.openToolUseIds?.add(block.id)
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string')
        state.openToolUseIds?.delete(block.tool_use_id)
    }
    if (!state.openToolUseIds?.size) state.settledChainUuid = message.uuid
  }
  // A child that started from a rewind's fork point has taken it; the session
  // it reports is the one to resume from now on, and is recorded as such below
  // even when its id did not change, so a restart does not fork again.
  const forked = init && Boolean(state.resumeAt)
  if (forked) state.resumeAt = null

  // The CLI init message reports which credential source the child actually
  // bound (`none` = the subscription login this provider guarantees). Ride it
  // on `session_updated` so the chat can warn when a session is somehow not
  // metering against the subscription. Only the SDK's labels pass: the value
  // is written to the transcript as is.
  const apiKeySource = init ? normalizeApiKeySource(message.apiKeySource) : null
  if (init && typeof message.model === 'string' && message.model) state.contextModel = message.model
  const billing = init ? claudeBillingOf(apiKeySource) : null
  if (billing) {
    state.usageBilling = billing
    usageLimitsStore().noteBilling('claude', billing)
  }
  if (message.type === 'assistant' && !readParentToolUseId(message)) {
    state.assistantRateLimited = message.error === 'rate_limit'
    if (message.error === 'authentication_failed') state.assistantAuthFailed = true
  }

  if (messageSessionId && messageSessionId !== state.providerSessionId) {
    state.providerSessionId = messageSessionId
    events.push(
      eventFor(state, 'session_updated', {
        providerSessionId: messageSessionId,
        ...(apiKeySource ? { apiKeySource } : {}),
      }),
    )
  } else if (apiKeySource) {
    events.push(eventFor(state, 'session_updated', { providerSessionId: state.providerSessionId, apiKeySource }))
  } else if (forked && state.providerSessionId) {
    events.push(eventFor(state, 'session_updated', { providerSessionId: state.providerSessionId }))
  }

  // What a command the CLI ran by itself printed (`/context`, `/usage`…): no
  // model turn, so no streamed text either. Shown once per exchange whichever
  // way the CLI reported it. `/compact` prints a line the compaction divider
  // already says, so a compacting exchange shows the divider alone.
  const commandOutput = (output: string, command: string | undefined): void => {
    const text = stripLocalCommandTags(output).trim()
    if (!text || state.commandOutputShown) return
    if (command === 'compact' && state.compactedInExchange) return
    state.commandOutputShown = true
    events.push(eventFor(state, 'command_output', { turnId, ...(command ? { command } : {}), output: text }))
  }

  switch (message.type) {
    // Where the subscription's windows stand, sent whenever that changes. Not
    // a transcript event: the reading is the account's, not the chat's.
    case 'rate_limit_event': {
      if (state.usageBilling === 'api') break
      const reading = readClaudeRateLimitInfo(message.rate_limit_info, state.contextModel)
      if (!reading) break
      usageLimitsStore().noteWindows('claude', reading.updates)
      const refusals = (state.usageRefusals ??= new Map())
      if (reading.rejected) refusals.set(reading.type, reading.rejected)
      else refusals.delete(reading.type)
      break
    }
    case 'system': {
      if (message.subtype === 'local_command_output') {
        if (typeof message.content === 'string') commandOutput(stripLocalCommandTags(message.content), undefined)
        break
      }
      // A model call failed and the CLI will try it again after a wait. It
      // backs off for minutes before it gives up, and a turn that only ever
      // said "Thinking…" through all of it looked hung, an expired sign-in
      // most of all.
      if (message.subtype === 'api_retry') {
        const attempt = finiteNumber(message.attempt)
        const maxAttempts = finiteNumber(message.max_retries)
        if (attempt === undefined || maxAttempts === undefined) break
        const status = finiteNumber(message.error_status)
        events.push(
          eventFor(state, 'turn_retrying', {
            turnId,
            attempt,
            maxAttempts,
            retryInMs: finiteNumber(message.retry_delay_ms) ?? 0,
            ...(typeof message.error === 'string' && message.error ? { error: message.error } : {}),
            ...(status !== undefined ? { status } : {}),
          } satisfies ConversationTurnRetryingPayload),
        )
        break
      }
      // The CLI summarised the conversation to free context, on /compact or
      // on its own when the window filled. The transcript marks the seam, since
      // the model no longer sees what came before it verbatim.
      if (message.subtype !== 'compact_boundary') {
        // Spawned agents report through `task_*` system messages, and so do
        // the shells and monitors the child runs in the background.
        events.push(...mapTaskMessage(state, message))
        events.push(...mapBackgroundTaskMessage(state, message))
        break
      }
      state.compactedInExchange = true
      const metadata = asRecord(message.compact_metadata)
      const trigger = metadata?.trigger === 'manual' || metadata?.trigger === 'auto' ? metadata.trigger : undefined
      const preTokens = finiteNumber(metadata?.pre_tokens)
      const postTokens = finiteNumber(metadata?.post_tokens)
      // The window holds the summary from here, not the last request read off
      // the stream: a `/compact` makes no request this mapper sees before its
      // result, which would otherwise report the window as full as it was.
      state.contextPromptTokens = postTokens
      state.contextOutputTokens = 0
      events.push(
        eventFor(state, 'context_compacted', {
          turnId,
          ...(trigger ? { trigger } : {}),
          ...(preTokens !== undefined ? { preTokens } : {}),
          ...(postTokens !== undefined ? { postTokens } : {}),
        }),
      )
      break
    }
    case 'stream_event': {
      // Text and thinking deltas produced inside a subagent stay dropped: they
      // would interleave into the parent assistant's own streaming bubble. A
      // subagent's visible work rides its parent-linked tool events below.
      if (message.parent_tool_use_id) break
      const streamEvent = asRecord(message.event)
      // Each API request of the main chain opens with its usage: how big the
      // conversation it sent is, and how much of it the cache served or took.
      // That is the prompt cache's reading (shared/prompt-cache.ts); the
      // runtime stamps when it goes cold off this event's own time.
      if (streamEvent?.type === 'message_start') {
        const requestUsage = asRecord(asRecord(streamEvent.message)?.usage)
        const promptCache = readRequestPromptCache(state, requestUsage)
        // The same request's size is also how full the context window is:
        // everything the model was sent this time, cache hits included. A
        // reading per request rather than per turn, because a turn of tool
        // rounds sends the conversation many times over and the sum of those
        // is not anything the window ever held.
        const contextUsed = requestContextTokens(requestUsage)
        if (contextUsed !== null) {
          state.contextPromptTokens = contextUsed
          state.contextOutputTokens = 0
        }
        if (promptCache || contextUsed !== null)
          events.push(
            eventFor(state, 'usage_updated', {
              turnId,
              ...(promptCache ? { promptCache } : {}),
              ...(contextUsed !== null ? { contextUsed } : {}),
            }),
          )
        break
      }
      // What the request wrote back joins the context too; the closing usage
      // of a message counts its output so far.
      if (streamEvent?.type === 'message_delta') {
        const output = finiteNumber(asRecord(streamEvent.usage)?.output_tokens)
        if (output !== undefined) state.contextOutputTokens = output
        break
      }
      // Each thinking block is its own thought. Back-to-back blocks arrive as
      // one reasoning run, so a block's start is a paragraph break in it rather
      // than the two running together mid-sentence.
      if (streamEvent?.type === 'content_block_start' && asRecord(streamEvent.content_block)?.type === 'thinking') {
        events.push(eventFor(state, 'reasoning_delta', { turnId, text: '\n\n' }))
        break
      }
      if (streamEvent?.type !== 'content_block_delta') break
      const delta = asRecord(streamEvent.delta)
      if (!delta) break
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        events.push(
          eventFor(state, 'content_delta', { turnId, text: state.textSeam ? `\n\n${delta.text}` : delta.text }),
        )
        state.textSeam = false
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
        events.push(eventFor(state, 'reasoning_delta', { turnId, text: delta.thinking }))
      }
      break
    }
    case 'assistant': {
      // A subagent's own tool calls arrive as assistant messages stamped with
      // the id of the Task call that spawned them; they are emitted as ordinary
      // tool events carrying that link, so the lane can nest them.
      const parentToolUseId = readParentToolUseId(message)
      const content = asRecord(message.message)?.content
      if (!Array.isArray(content)) break
      // Claude Code 2.1.284 hands a local command's output over as an
      // assistant message of its own making (marked by `local_command_source`)
      // that nothing streams, so it is read here or not at all.
      if (!parentToolUseId && typeof message.local_command_source === 'string') {
        commandOutput(extractResultText(content), readString(asRecord(message.local_command_run)?.command))
        break
      }
      const tracked = parentToolUseId ? state.subagents?.get(parentToolUseId) : undefined
      for (const rawBlock of content) {
        const block = asRecord(rawBlock)
        // What an agent says between its steps belongs to its own thread. A
        // background agent's last words are also its answer: its spawning
        // call only ever returned the launch notice.
        if (parentToolUseId && block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          if (tracked) tracked.lastText = block.text
          const truncated = block.text.length > SUBAGENT_MESSAGE_CHARS
          const payload: ConversationSubagentMessagePayload = {
            parentToolUseId,
            text: truncated ? block.text.slice(0, SUBAGENT_MESSAGE_CHARS) : block.text,
            ...(truncated ? { truncated } : {}),
          }
          events.push(eventFor(state, 'subagent_message', payload))
          continue
        }
        if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue
        if (block.name === 'Read' && typeof block.id === 'string')
          (state.fileReadToolUseIds ??= new Set()).add(block.id)
        const toolInput = asRecord(block.input) ?? {}
        const payload: ConversationToolStartedPayload = {
          turnId,
          toolCallId: typeof block.id === 'string' ? block.id : undefined,
          tool: block.name,
          toolUseId: typeof block.id === 'string' ? block.id : undefined,
          name: block.name,
          kind: inferConversationToolKind(block.name),
          input: JSON.parse(
            JSON.stringify({
              ...toolInput,
              ...(typeof toolInput.file_path === 'string' ? { path: toolInput.file_path } : {}),
              ...(typeof toolInput.old_string === 'string' ? { oldText: toolInput.old_string } : {}),
              ...(typeof toolInput.new_string === 'string' ? { newText: toolInput.new_string } : {}),
            }),
          ),
          ...computeEditDiffCounts(block.name, toolInput),
          ...(parentToolUseId ? { parentToolUseId } : {}),
          ...subagentLaneFields(block.name, toolInput),
        }
        events.push(eventFor(state, 'tool_started', payload))
        // Text after a tool is laid out as a block of its own already.
        if (!parentToolUseId) state.textSeam = false
      }
      break
    }
    case 'user': {
      const parentToolUseId = readParentToolUseId(message)
      const content = asRecord(message.message)?.content
      if (!Array.isArray(content)) break
      for (const rawBlock of content) {
        const block = asRecord(rawBlock)
        if (block?.type !== 'tool_result') continue
        const binary = Array.isArray(block.content)
          ? block.content.map(asRecord).find((entry) => entry?.type === 'image' || entry?.type === 'document')
          : undefined
        const source = asRecord(binary?.source)
        const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined
        const output = extractResultText(block.content)
        // The notice a background agent's call returns at once is for the
        // model, not the person; the lane stays open until the agent reports.
        if (toolUseId && state.subagents?.get(toolUseId)?.background && isBackgroundLaunchAck(output)) continue
        const declined = toolUseId !== undefined && state.declinedToolUseIds?.delete(toolUseId) === true
        const command = commandOutcome(message.tool_use_result, block.is_error === true, output)
        // A screenshot, or any picture a tool hands back, kept to show under
        // its step; a file read's picture is the file itself, shown by path.
        const fileRead = toolUseId !== undefined && state.fileReadToolUseIds?.delete(toolUseId) === true
        const keep = options.saveToolImages === false ? null : (options.saveToolImages ?? saveToolResultImages)
        const pictures =
          keep && state.workspaceRoot && !fileRead && toolUseId && !declined ? toolResultImages(block.content) : []
        let images: string[] = []
        if (keep && pictures.length) {
          const write = keep({
            key: { workspaceRoot: state.workspaceRoot!, workspaceId: state.workspaceId, agentId: state.agentId },
            toolUseId: toolUseId!,
            images: pictures,
          })
          // The same list, which the write trims of any file it could not make.
          images = write.paths
          ;(state.toolImageWrites ??= []).push(write.written)
        }
        const payload: ConversationToolOutputPayload = {
          turnId,
          toolCallId: toolUseId,
          toolUseId,
          output,
          status: declined ? 'declined' : command.stopped ? 'stopped' : block.is_error === true ? 'error' : 'ok',
          ...(command.exitCode !== undefined && !declined ? { exitCode: command.exitCode } : {}),
          ...(typeof source?.media_type === 'string'
            ? {
                mime: source.media_type,
                totalBytes: typeof source.data === 'string' ? Buffer.byteLength(source.data, 'base64') : 0,
              }
            : {}),
          isError: block.is_error === true,
          ...(parentToolUseId ? { parentToolUseId } : {}),
          ...(images.length ? { images } : {}),
        }
        events.push(eventFor(state, 'tool_output', payload))
      }
      break
    }
    case 'result': {
      // A result that answers a local command repeats its output: the one
      // report left when the CLI sent it no other way.
      if (typeof message.local_command === 'string' && typeof message.result === 'string')
        commandOutput(message.result, message.local_command)
      state.commandOutputShown = false
      state.compactedInExchange = false
      const refusals = [...(state.usageRefusals?.values() ?? [])]
      const heardRefusal = refusals.length > 0 || state.assistantRateLimited === true
      const authFailed = state.assistantAuthFailed === true
      state.usageRefusals?.clear()
      state.assistantRateLimited = false
      state.assistantAuthFailed = false
      if (options.interrupted) {
        state.openToolUseIds?.clear()
        if (state.lastChainUuid) state.settledChainUuid = state.lastChainUuid
        state.turnUsage = undefined
        break
      }
      const usage = asRecord(message.usage)
      // The exchange's spend, by the turn-usage contract: `input_tokens` is
      // already the fresh share, with the cache's reads and writes beside it.
      const exchangeUsage = usage
        ? turnUsageOf({
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheReadTokens: usage.cache_read_input_tokens,
            cacheWriteTokens: usage.cache_creation_input_tokens,
          })
        : null
      const turnUsage = addTurnUsage(state.turnUsage, exchangeUsage)
      if (options.exchangeContinues) state.turnUsage = turnUsage ?? undefined
      else state.turnUsage = undefined
      if (usage) {
        const inputTokens =
          numberOr(usage.input_tokens, 0) +
          numberOr(usage.cache_creation_input_tokens, 0) +
          numberOr(usage.cache_read_input_tokens, 0)
        const outputTokens = numberOr(usage.output_tokens, 0)
        // `usage` is the exchange's sum over every request it made, so it says
        // what the turn cost, not how full the window is: that is the latest
        // request's size, read off its stream, and the window the CLI ran the
        // main chain's model with.
        const contextWindow = resultContextWindow(message.modelUsage, state.contextModel ?? null)
        const contextUsed =
          state.contextPromptTokens !== undefined
            ? state.contextPromptTokens + (state.contextOutputTokens ?? 0)
            : undefined
        events.push(
          eventFor(state, 'usage_updated', {
            turnId,
            inputTokens,
            // The share of the input the prompt cache served, at a tenth of the
            // price or less.
            cachedInputTokens: numberOr(usage.cache_read_input_tokens, 0),
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            ...(contextWindow !== undefined ? { contextWindow } : {}),
            ...(contextUsed !== undefined ? { contextUsed } : {}),
          }),
        )
      }
      // The CLI answers a message steered in after its last tool round with an
      // exchange of its own; the turn stays open for it, and the cost of both
      // is counted when that one ends.
      if (options.exchangeContinues) {
        state.textSeam = true
        break
      }
      // Every exchange ends settled, whatever the tool calls it left open.
      state.openToolUseIds?.clear()
      if (state.lastChainUuid) state.settledChainUuid = state.lastChainUuid
      // A running total for the live query(); each turn reports what it added.
      // A lower, non-zero total means the SDK started counting again (/clear).
      // A zero total below the last one is a result that carries no cost at
      // all (a crash): taking it as a restart would make the next turn report
      // the whole session again, so the total stays until a new child starts.
      let costUsd: number | undefined
      if (typeof message.total_cost_usd === 'number' && Number.isFinite(message.total_cost_usd)) {
        const seen = state.queryCostUsd ?? 0
        const total = message.total_cost_usd
        if (total >= seen || total > 0) {
          costUsd = total >= seen ? total - seen : total
          state.queryCostUsd = total
        }
      }
      const isError = message.is_error === true || message.subtype !== 'success'
      if (isError) {
        const errors = Array.isArray(message.errors) ? message.errors.filter((entry) => typeof entry === 'string') : []
        const resultText = typeof message.result === 'string' ? message.result : ''
        const reported = errors.join('; ') || resultText
        // A child asked to fork at a point its session does not have fails
        // before it starts. The rewind cannot be taken up; the session goes
        // on from where it was, and the cursor the rewind recorded is replaced
        // so a restart does not try the same point again.
        const missingForkPoint = Boolean(state.resumeAt) && /No message found with message\.uuid/i.test(reported)
        // A turn a usage limit refused: said to whatever waits to resume it,
        // with when the limit lifts if the CLI told us — the last of the
        // refusing windows to reset, and only when each said when.
        if (
          state.usageBilling !== 'api' &&
          isClaudeUsageLimitResult(message, { refused: heardRefusal, authFailed, reported })
        ) {
          const latest = refusals.reduce<(typeof refusals)[number] | null>(
            (best, refusal) => (best === null || (refusal.resetsAt ?? 0) > (best.resetsAt ?? 0) ? refusal : best),
            null,
          )
          const everyResetKnown = refusals.length > 0 && refusals.every((refusal) => refusal.resetsAt !== null)
          usageLimitsStore().noteLimitHit({
            provider: 'claude',
            sessionId: state.sessionId,
            windowId: latest?.windowId ?? null,
            resetsAt: everyResetKnown ? (latest?.resetsAt ?? null) : null,
          })
        }
        if (missingForkPoint) {
          state.resumeAt = null
          // The point it was given is not one to go back to either.
          state.lastChainUuid = null
          state.settledChainUuid = null
          if (state.providerSessionId)
            events.push(eventFor(state, 'session_updated', { providerSessionId: state.providerSessionId }))
        }
        events.push(
          eventFor(state, 'turn_failed', {
            turnId,
            reason: typeof message.subtype === 'string' && message.subtype !== 'success' ? message.subtype : 'provider',
            message: missingForkPoint
              ? 'Claude Code could not go back to that earlier message because its session no longer has it, so this message was not answered. Send it again to continue from the latest point of the conversation; the agent will still remember the messages after the one you edited.'
              : reported || 'Claude Code reported an error for this turn.',
            ...providerCursorPayload(state),
          }),
        )
      } else {
        // The CLI's `result` is the text of the turn's last assistant message.
        const text = typeof message.result === 'string' && message.result.trim() ? message.result : undefined
        events.push(
          eventFor(state, 'turn_completed', {
            turnId,
            ...(text !== undefined ? { text } : {}),
            ...(turnUsage ? { usage: turnUsage } : {}),
            ...(costUsd !== undefined ? { costUsd } : {}),
            ...(typeof message.duration_ms === 'number' ? { durationMs: message.duration_ms } : {}),
            ...(typeof message.num_turns === 'number' ? { numTurns: message.num_turns } : {}),
            ...providerCursorPayload(state),
          }),
        )
      }
      break
    }
    case 'conversation_reset': {
      // `/clear` (typed, since the menu does not offer it) started a new CLI
      // conversation. The next init names it, and the chat follows it from
      // there; the transcript says the model no longer has what came before.
      events.push(
        eventFor(state, 'command_output', {
          turnId,
          command: 'clear',
          adapterNote: true,
          output: 'Claude Code started a new conversation. The messages above are no longer in its context.',
        }),
      )
      break
    }
    default:
      break
  }
  return events
}

// Claude Code reports each spawned agent through `task_*` system messages:
// started, progress (latest tool, token use, a one-line summary), updated
// (moved to the background, ended) and a final notification. Only agents are
// followed; background shells, monitors and ambient watchers are not lanes.
function mapTaskMessage(
  state: Parameters<typeof mapSdkMessage>[0],
  message: Record<string, unknown>,
): ConversationEvent[] {
  const subagents = state.subagents
  if (!subagents) return []
  const taskId = typeof message.task_id === 'string' ? message.task_id : null
  if (!taskId) return []
  const find = (): TrackedSubagent | undefined => {
    const toolUseId = typeof message.tool_use_id === 'string' ? message.tool_use_id : null
    if (toolUseId && subagents.has(toolUseId)) return subagents.get(toolUseId)
    for (const agent of subagents.values()) if (agent.taskId === taskId) return agent
    return undefined
  }
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

  switch (message.subtype) {
    case 'task_started': {
      const startedBy = text(message.tool_use_id)
      if (!startedBy || message.ambient === true || message.skip_transcript === true) return []
      if (message.task_type !== undefined && message.task_type !== 'local_agent') return []
      // A resumed agent starts again under the call that resumed it, while its
      // steps still name the call that spawned it: it goes on in that lane,
      // which reopens.
      const lane = state.agentLanes?.get(taskId)
      const toolUseId = lane ?? startedBy
      state.agentLanes?.set(taskId, toolUseId)
      const agent: TrackedSubagent = {
        taskId,
        toolUseId,
        background: message.is_backgrounded === true,
        subagentType: text(message.subagent_type),
        description: text(message.description),
      }
      subagents.set(toolUseId, agent)
      return [
        eventFor(state, 'subagent_status', {
          ...subagentStatusFields(agent, 'running'),
          ...(lane ? { resumed: true } : {}),
        }),
      ]
    }
    case 'task_progress': {
      const agent = find()
      if (!agent) return []
      return [
        eventFor(state, 'subagent_status', {
          ...subagentStatusFields(agent, 'running'),
          ...optional('lastToolName', text(message.last_tool_name)),
          ...optional('progressSummary', text(message.summary)),
          ...optional('usage', readTaskUsage(message.usage)),
        }),
      ]
    }
    case 'task_updated': {
      const agent = find()
      const patch = asRecord(message.patch)
      if (!agent || !patch) return []
      if (typeof patch.end_time === 'number') agent.endedAt = patch.end_time
      if (text(patch.error)) agent.error = text(patch.error)
      // A foreground agent sent to the background keeps running after its
      // call returns, exactly like one launched there.
      if (patch.is_backgrounded === true && !agent.background) {
        agent.background = true
        return [eventFor(state, 'subagent_status', subagentStatusFields(agent, 'running'))]
      }
      return []
    }
    case 'task_notification': {
      const agent = find()
      if (!agent) return []
      subagents.delete(agent.toolUseId)
      const status: ConversationSubagentState =
        message.status === 'failed' ? 'failed' : message.status === 'stopped' ? 'stopped' : 'completed'
      const events: ConversationEvent[] = []
      if (agent.background) {
        // The answer the model is about to read, and the result the lane has
        // been waiting for since its call returned the launch notice.
        const output = agent.lastText ?? text(message.summary) ?? ''
        const payload: ConversationToolOutputPayload = {
          toolCallId: agent.toolUseId,
          toolUseId: agent.toolUseId,
          output,
          status: status === 'failed' ? 'error' : status === 'stopped' ? 'stopped' : 'ok',
          isError: status === 'failed',
          backgroundResult: true,
          taskId: agent.taskId,
        }
        events.push(eventFor(state, 'tool_output', payload))
      }
      events.push(
        eventFor(state, 'subagent_status', {
          ...subagentStatusFields(agent, status),
          ...optional('usage', readTaskUsage(message.usage)),
          ...(status === 'completed' ? {} : optional('error', agent.error ?? text(message.summary))),
        }),
      )
      return events
    }
    default:
      return []
  }
}

// The task types listed as background work, and what each is. A shell is a
// command unless a Monitor call started it. Agents have lanes of their own,
// and a type this build does not know is left out rather than guessed at.
function backgroundTaskKind(taskType: unknown, monitor: boolean): ConversationBackgroundTaskKind | null {
  if (taskType === 'local_bash') return monitor ? 'monitor' : 'command'
  if (taskType === 'local_workflow' || taskType === 'mcp_task') return 'task'
  return null
}

function backgroundTaskList(tasks: Map<string, TrackedTask> | undefined): ConversationBackgroundTask[] {
  return Array.from(tasks?.values() ?? [])
    .filter((tracked) => tracked.background)
    .map((tracked) => tracked.task)
}

// A Monitor call, wherever it is made: its task starts under it, and is a
// monitor rather than a shell for that.
function noteMonitorCalls(
  state: { monitorCalls?: Map<string, { persistent: boolean }> },
  message: Record<string, unknown>,
): void {
  if (!state.monitorCalls || message.type !== 'assistant') return
  const blocks = asRecord(message.message)?.content
  for (const block of Array.isArray(blocks) ? blocks.map(asRecord) : []) {
    if (block?.type !== 'tool_use' || block.name !== 'Monitor' || typeof block.id !== 'string') continue
    state.monitorCalls.set(block.id, { persistent: asRecord(block.input)?.persistent === true })
  }
}

// The shells, monitors and workflows the child runs in the background, as one
// list on `session_updated` whenever it changes. `background_tasks_changed` is
// the whole list, and replaces what is known; the `task_*` messages on either
// side of it keep the list right for a CLI that does not send it, and say what
// each task is. Housekeeping (`ambient`) is not work anyone waits on.
function mapBackgroundTaskMessage(
  state: Parameters<typeof mapSdkMessage>[0],
  message: Record<string, unknown>,
): ConversationEvent[] {
  const tasks = state.tasks
  if (!tasks) return []
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
  const before = JSON.stringify(backgroundTaskList(tasks))
  const taskId = text(message.task_id)
  switch (message.subtype) {
    case 'background_tasks_changed': {
      if (!Array.isArray(message.tasks)) return []
      const live = new Set<string>()
      for (const entry of message.tasks.map(asRecord)) {
        const id = text(entry?.task_id)
        if (!entry || !id || entry.ambient === true) continue
        const known = tasks.get(id)
        const kind = known?.task.kind ?? backgroundTaskKind(entry.task_type, false)
        if (!kind) continue
        live.add(id)
        tasks.set(id, {
          task: known?.task ?? { taskId: id, kind, ...optional('description', text(entry.description)) },
          background: true,
        })
      }
      for (const [id, tracked] of tasks) if (tracked.background && !live.has(id)) tasks.delete(id)
      break
    }
    case 'task_started': {
      if (!taskId || message.ambient === true || message.skip_transcript === true) return []
      const toolUseId = text(message.tool_use_id)
      const monitor = toolUseId ? state.monitorCalls?.get(toolUseId) : undefined
      if (toolUseId) state.monitorCalls?.delete(toolUseId)
      const kind = backgroundTaskKind(message.task_type, monitor !== undefined)
      if (!kind) return []
      tasks.set(taskId, {
        task: {
          taskId,
          kind,
          ...optional('description', text(message.description)),
          ...(monitor?.persistent ? { persistent: true } : {}),
        },
        // Set for shells; a workflow or an MCP task always runs on its own.
        background: tasks.get(taskId)?.background === true || message.is_backgrounded !== false,
      })
      break
    }
    case 'task_updated': {
      const tracked = taskId ? tasks.get(taskId) : undefined
      const patch = asRecord(message.patch)
      if (!taskId || !tracked || !patch) return []
      if (patch.status === 'completed' || patch.status === 'failed' || patch.status === 'killed') tasks.delete(taskId)
      // A foreground shell sent to the background runs on past its call.
      else if (patch.is_backgrounded === true) tracked.background = true
      break
    }
    case 'task_notification': {
      if (taskId) tasks.delete(taskId)
      break
    }
    default:
      return []
  }
  const after = backgroundTaskList(tasks)
  if (JSON.stringify(after) === before) return []
  return [eventFor(state, 'session_updated', { backgroundTasks: after })]
}

function subagentStatusFields(
  agent: TrackedSubagent,
  status: ConversationSubagentState,
): ConversationSubagentStatusPayload {
  return {
    toolUseId: agent.toolUseId,
    taskId: agent.taskId,
    status,
    background: agent.background,
    ...optional('subagentType', agent.subagentType),
    ...optional('description', agent.description),
    ...(status !== 'running' ? optional('endedAt', agent.endedAt) : {}),
  }
}

function readTaskUsage(value: unknown): ConversationSubagentStatusPayload['usage'] | undefined {
  const usage = asRecord(value)
  if (!usage) return undefined
  return {
    totalTokens: numberOr(usage.total_tokens, 0),
    toolUses: numberOr(usage.tool_uses, 0),
    durationMs: numberOr(usage.duration_ms, 0),
  }
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}

// The CLI wraps what a local command printed in the tags its own transcript
// keeps it in; the output is what is between them.
function stripLocalCommandTags(text: string): string {
  return text.replace(/<\/?local-command-(?:stdout|stderr)>/g, '')
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

// What a shell command's result says about how it ended. The structured
// result of the Bash tool carries `interrupted` but no exit status; a command
// that exited non-zero is reported as an error whose text starts with it.
function commandOutcome(
  structured: unknown,
  isError: boolean,
  output: string,
): { stopped: boolean; exitCode?: number } {
  const result = asRecord(structured)
  const isCommand = typeof result?.interrupted === 'boolean' && typeof result.stdout === 'string'
  const stopped = result?.interrupted === true
  const reported = isError ? /^Exit code (-?\d+)\b/.exec(output) : null
  if (reported) return { stopped, exitCode: Number(reported[1]) }
  return isCommand && !isError && !stopped ? { stopped, exitCode: 0 } : { stopped }
}

// The SDK stamps every message produced inside a spawned agent with the id of
// the tool call that spawned it; top-level traffic carries null.
function readParentToolUseId(message: Record<string, unknown>): string | null {
  const parentToolUseId = message.parent_tool_use_id
  return typeof parentToolUseId === 'string' && parentToolUseId ? parentToolUseId : null
}

// How much of one block of an agent's own text a transcript event keeps. An
// agent's report can run long; its whole text is its lane's result.
const SUBAGENT_MESSAGE_CHARS = 32 * 1024

// Names the CLI exposes for spawning a subagent; installed versions differ, so
// both are recognized and either one is the header of a lane.
const SUBAGENT_TOOL_NAMES = new Set(['Task', 'Agent'])

function subagentLaneFields(
  tool: string,
  toolInput: Record<string, unknown>,
): Pick<ConversationToolStartedPayload, 'subagentLane' | 'subagentType'> {
  if (!SUBAGENT_TOOL_NAMES.has(tool)) return {}
  const subagentType = typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type.trim() : ''
  return { subagentLane: true, ...(subagentType ? { subagentType } : {}) }
}

// Where the provider session stands as a turn ends, carried on that end so a
// later rewind can go back to it (ConversationProviderCursor). Absent until
// this process has seen an entry of the session: a point it cannot name is no
// point to go back to.
function providerCursorPayload(state: { providerSessionId: string | null; lastChainUuid?: string | null }): {
  providerCursor?: { sessionId: string; at: string }
} {
  return state.providerSessionId && state.lastChainUuid
    ? { providerCursor: { sessionId: state.providerSessionId, at: state.lastChainUuid } }
    : {}
}

function eventFor(
  state: { sessionId: string; workspaceId: string; agentId: string; providerId: string; modelId: string },
  type: ConversationEvent['type'],
  payload?: Record<string, unknown>,
): ConversationEvent {
  return {
    id: '',
    sessionId: state.sessionId,
    workspaceId: state.workspaceId,
    agentId: state.agentId,
    providerId: state.providerId,
    modelId: state.modelId,
    type,
    createdAt: 0,
    payload,
  }
}

function turnFailure(input: MockAdapterTurnInput, reason: string, message: string): ConversationEvent {
  return {
    id: '',
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    providerId: input.providerId,
    modelId: input.modelId,
    type: 'turn_failed',
    createdAt: 0,
    payload: { turnId: input.turnId, reason, message },
  }
}

// Line-count deltas for edit-shaped tool calls, shipped on `tool_started` so
// the chat's work timeline can render `+N −N` chips without re-reading files.
// Write reports additions only (the file's previous content is not visible
// here); unknown tools return null and ship no counts.
function computeEditDiffCounts(
  tool: string,
  input: Record<string, unknown>,
): { addedLines: number; removedLines?: number } | null {
  if (tool === 'Edit') {
    return { addedLines: countLines(input.new_string), removedLines: countLines(input.old_string) }
  }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    let addedLines = 0
    let removedLines = 0
    for (const rawEdit of input.edits) {
      const edit = asRecord(rawEdit)
      if (!edit) continue
      addedLines += countLines(edit.new_string)
      removedLines += countLines(edit.old_string)
    }
    return { addedLines, removedLines }
  }
  if (tool === 'Write') {
    return { addedLines: countLines(input.content) }
  }
  return null
}

function countLines(value: unknown): number {
  return typeof value === 'string' && value.length > 0 ? value.split('\n').length : 0
}

function extractResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((entry) => {
      const block = asRecord(entry)
      return block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

function describeSpawnFailure(error: unknown, stderrTail: string): string {
  const base = error instanceof Error && error.message ? error.message : 'Claude Code exited unexpectedly.'
  const tail = cliStderrSummary(stderrTail)
  return tail ? `${base} (${tail})` : base
}

/**
 * One request's prompt cache, from the usage its `message_start` carries: the
 * size of the conversation it sent (what a cold resume would write to the cache
 * again), whether anything was cached at all, and — from which lifetime its
 * cache WRITE went to — whether the cache lives for five minutes or an hour. A
 * request that only reads keeps the lifetime the last write reported.
 */
function readRequestPromptCache(
  state: { promptCacheTtl?: PromptCacheTtl | null },
  usage: Record<string, unknown> | null,
): { ttl: PromptCacheTtl | null; cached: boolean; recacheTokens: number } | null {
  if (!usage) return null
  const written = numberOr(usage.cache_creation_input_tokens, 0)
  const read = numberOr(usage.cache_read_input_tokens, 0)
  const recacheTokens = numberOr(usage.input_tokens, 0) + written + read
  if (recacheTokens <= 0) return null
  const writes = asRecord(usage.cache_creation)
  if (numberOr(writes?.ephemeral_1h_input_tokens, 0) > 0) state.promptCacheTtl = '1h'
  else if (numberOr(writes?.ephemeral_5m_input_tokens, 0) > 0) state.promptCacheTtl = '5m'
  return { ttl: state.promptCacheTtl ?? null, cached: written + read > 0, recacheTokens }
}

/**
 * How many tokens one request of the main chain sent: its fresh input, what it
 * wrote to the prompt cache and what it read from it. Null when the usage says
 * nothing, so an empty `message_start` is not a window emptied to zero.
 */
function requestContextTokens(usage: Record<string, unknown> | null): number | null {
  if (!usage) return null
  const total =
    numberOr(usage.input_tokens, 0) +
    numberOr(usage.cache_creation_input_tokens, 0) +
    numberOr(usage.cache_read_input_tokens, 0)
  return total > 0 ? total : null
}

/**
 * The context window the CLI ran the conversation's model with, from a
 * result's `modelUsage` (one row per model the session has used, each naming
 * its window). The init's model is the main chain's; failing a row under that
 * name — an alias the CLI resolved — the largest window is taken, since a
 * subagent's smaller model is the only other row there and the main chain is
 * the one whose window the chat fills.
 */
export function resultContextWindow(modelUsage: unknown, model: string | null): number | undefined {
  const rows = asRecord(modelUsage)
  if (!rows) return undefined
  const windowOf = (row: unknown): number | undefined => {
    const value = finiteNumber(asRecord(row)?.contextWindow)
    return value !== undefined && value > 0 ? value : undefined
  }
  const named = model ? windowOf(rows[model]) : undefined
  if (named !== undefined) return named
  let largest: number | undefined
  for (const row of Object.values(rows)) {
    const value = windowOf(row)
    if (value !== undefined && (largest === undefined || value > largest)) largest = value
  }
  return largest
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * The SDK's `mcpServers` for a child: each server as Claude Code's own
 * `.mcp.json` writer renders it (mcp-config-service.ts), keyed by id. A bearer
 * token named by `envVarNames` stays a `${NAME}` reference, which the CLI
 * expands from its own environment. A child in WSL gets a stdio server's
 * Windows paths as the distribution sees them.
 */
export function claudeMcpServers(
  servers: readonly ConversationMcpServer[],
  options: { wsl?: boolean } = {},
): NonNullable<Options['mcpServers']> {
  const hostPath = (value: string): string => (options.wsl && isWindowsPath(value) ? toWslPath(value) : value)
  const out: NonNullable<Options['mcpServers']> = {}
  for (const server of servers) {
    if (server.transport === 'stdio') {
      if (!server.command) continue
      out[server.id] = {
        type: 'stdio',
        command: hostPath(server.command),
        args: (server.args ?? []).map(hostPath),
        ...(server.env ? { env: server.env } : {}),
      }
      continue
    }
    if (!server.url) continue
    const headers = { ...server.headers }
    if (!headers.Authorization && server.envVarNames?.[0]) headers.Authorization = `Bearer \${${server.envVarNames[0]}}`
    out[server.id] = {
      type: server.transport,
      url: server.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    }
  }
  return out
}

// The gateway's bridge says which agent is calling from its environment. A
// stdio server inherits the child's, but the identity is set on the entry too,
// so the launch cap never rests on how the CLI builds a server's environment.
function withAgentIdentity(server: ConversationMcpServer, env: Record<string, string>): ConversationMcpServer {
  const identity = Object.fromEntries(AGENT_IDENTITY_ENV_KEYS.flatMap((key) => (env[key] ? [[key, env[key]]] : [])))
  return { ...server, env: { ...server.env, ...identity, SPRINTENGINE_AGENT_CLI: 'claude-code' } }
}
