import { BrowserWindow, type WebContents } from 'electron'
import * as pty from 'node-pty'
import type {
  AgentCli,
  AgentPhase,
  AgentSessionIdentity,
  AgentSessionMetadata,
  McpSettings,
  SessionActivity,
  TerminalPathStyle,
  TerminalPromptUndelivered,
  TerminalSessionSnapshot,
  TerminalSpawnResult,
  TerminalVisibilityOptions,
} from '../shared/electron-api'
import type {
  AgentPhaseEvent,
  AgentPhaseListener,
  AgentSessionExitListener,
  LiveAgentExecution,
} from '../shared/agent-runtime'
import { appendLivePeekPrompt, type ConversationPeekSessionState } from './conversation-peek/service'
import type { AgentPromptStore } from './agent-prompt-store'
import { raiseChildOomScore } from './agent-oom-score'
import {
  agentStateSpecReportsPrompts,
  applyBackgroundWork,
  backgroundStartAlreadyClosed,
  deriveActivityFromPhase,
  evaluateAgentStall,
  holdTurnEndForBackgroundWork,
  isAtRestAgentPhase,
  keepsTurnEnd,
  resolveAgentStateEvent,
  selectAgentStateTarget,
  type AgentStateFrame,
} from './agent-state'
import { resolveCheckoutForCwd, type ObservedCheckoutResolver, type ResolvedCheckoutFacts } from './checkout-resolve'
import {
  parseObservedCheckout,
  sameObservedCheckout,
  unresolvedObservedCheckout,
  type ObservedCheckout,
} from '../shared/observed-checkout'
import type { TerminalSpawnPayload } from './ipc/terminal-ipc'
import { normalizeExecutionHostId, wslHostId } from '../shared/execution-host'
import { isWindowsPath, wslToWindowsPath } from '../shared/host-paths'
import { hostRegistry } from './hosts/host-registry'
import {
  issueGatewayLaunchToken,
  revokeGatewayLaunchToken,
  type GatewayLaunchIdentity,
} from '../server/core/gateway-launch-tokens'
import { resolveWslDistroForPath } from './hosts/wsl-distro'
import type { HostAgentIntegration, HostLaunchTarget, HostProcessRef } from './hosts/execution-host'
import {
  agentIdentityEnv,
  cleanupHostContextFile,
  cleanupTerminalStartupScript,
  applyAgentIdentityEnv,
  getPlainShellLaunchConfig,
  getShellLaunchConfig,
  getTerminalEnv,
} from './terminal-launch'
import {
  createDeferredPromptDelivery,
  type DeferredPromptOutcome,
  type DeferredPromptReadiness,
} from './deferred-prompt-delivery'
import { isCanvasWorkerWindow } from './canvas/canvas-worker-window'
import { getSharedCredentialStore } from './secret-store'
import { getErrorMessage } from './error-message'
import { getTerminalErrorMessage } from './terminal-error'
import { getPluginById } from './plugin-registry-instance'
import { cliResumeCapabilities } from './cli-resume-capabilities'
import { permissionRenderKey } from './plugin-render'
import { cliCredentialLaunchBlock, pluginIdForCli } from './agent-launch-render'
import {
  agentCliLaunchFailureResult,
  preflightAgentCliLaunch,
  type DetectAgentCliAvailabilityDeps,
} from './cli-availability'
import {
  appendTerminalOutput,
  clearAgentStallTimer,
  clearTerminalIdleTimer,
  createFailedTerminalSession,
  createHeadlessTerminalSender,
  createInitialAgentState,
  createInitialTerminalActivity,
  createSuspendedPlaceholderSession,
  getTerminalUnseenSince,
  getTerminalSize,
  getTerminalSnapshot,
  getTerminalSnapshotBase,
  getTerminalIdleTimeoutMs,
  isTerminalProcessAlive,
  isTerminalSessionStale,
  listSessionFileChanges,
  listSessionPullRequests,
  materializeTerminalReplay,
  readTerminalOutputSince as readSessionOutputSince,
  parseSessionContextUsage,
  parseSessionFileChanges,
  parseSessionPrompts,
  noteFoldedFileChange,
  recordSessionFileChange,
  recordSessionStatusLine,
  recordTerminalInput,
  recordTerminalVisibility,
  releaseSettledTerminalSession,
  releaseTerminalOutput,
  transitionTerminalActivity,
  type TerminalSession,
} from './terminal-session'
import { buildReplaySnapshot } from './terminal-replay-snapshot'
import { TerminalReplayBuffer } from './terminal-replay-buffer'
import type { SubtreeLiveReason, SubtreeProbeDeps } from './terminal-subtree-probe'
import type { TerminalSnapshotSidecarStore } from './terminal-snapshot-sidecar'
import { createTerminalDiagnostics } from './terminal-diagnostics'
import {
  createTerminalOutputBuffer,
  TERMINAL_FLOW_HIGH_WATERMARK,
  TERMINAL_FLOW_LOW_WATERMARK,
  TERMINAL_FLOW_STALL_RESUME_MS,
} from './terminal-output-buffer'
import {
  explainSessionReapDecision,
  selectReapableSessions,
  clampSuspendIdleAfterMs,
  clampKeepRecentTerminalsAlive,
  DEFAULT_SUSPEND_IDLE_AFTER_MS,
  DEFAULT_KEEP_RECENT_TERMINALS_ALIVE,
  type ReapCandidate,
} from './terminal-reap-policy'
import { recordReapEvent } from './terminal-reap-log'
import type { TerminalRootInfo } from './workspace-memory'
import type { ChangelistEdit } from '../shared/git/changelists'
import type { TerminalSessionDeltaEntry, TerminalSessionsDelta } from '../shared/ipc/terminal'
import { parsePromptCacheReading } from '../shared/prompt-cache'
import { noteStatusLineRateLimits } from './usage-limits/store'
import { broadcastToAllWindows } from './window-broadcast'

type TerminalRuntimeOptions = {
  diagnosticsEnabled: boolean
  logMainPerfEvent(scope: string, event: string, payload: Record<string, unknown>): void
  // Turns a hook-reported cwd into the checkout containing it.
  // Defaults to the git-backed resolver; tests inject a stub so no git runs.
  resolveObservedCheckout?: ObservedCheckoutResolver
  syncMcpConfig?(input: {
    workspaceRoot: string
    settings: McpSettings
    clients: AgentCli[]
    pruneUnlistedServers?: boolean
    executionPathStyle?: TerminalPathStyle
    // The machine the CLI runs on: it decides the gateway entry (this app's
    // own binary here, the pinned Node and the helper's bridge in WSL).
    hostId?: string
    // What that machine's `agentIntegration()` said when this launch was
    // prepared. The sync answers from it rather than asking again, so a
    // helper restarting mid-launch cannot make the gateway entry and the
    // launch disagree.
    integration?: HostAgentIntegration | null
  }): Promise<{ ok: true } | { ok: false; message: string }>
  // Ensures a built-in skill is installed into the workspace before an agent
  // launches, so a prefilled invocation of it (a Backlog handoff's `/backlog`)
  // resolves to a real skill. Best-effort: the caller swallows failures and
  // the prompt still states what to do. `cli` is the agent about to launch: a
  // bundled skill its launch carries in the app's own plugin directory is not
  // copied into the workspace at all (see `ensureSkillInstalled`). `launch` is
  // the machine the agent runs on and what it said when the launch was
  // prepared, which is what decides whether its launch carries the skill.
  ensureBuiltinSkillInstalled?(
    workspaceRoot: string,
    skillId: string,
    cli?: string,
    launch?: { hostId: string; integration: HostAgentIntegration | null },
  ): Promise<void>
  // Keeps the generated managed MCP config (`.mcp.json` / `.codex/config.toml`)
  // out of a connector chat's worktree git by appending them to the worktree's
  // info/exclude. Invoked at a connector spawn (connectorLaunch set) after the
  // per-spawn MCP sync writes those files. Best-effort: the caller swallows
  // failures so an exclude write never blocks a launch. Absent in tests (no-op).
  excludeWorktreeMcpConfig?(worktreePath: string): Promise<void>
  // The machine a workspace runs on, from main's workspace registry. Asked
  // when a spawn names no host of its own, so every door into a terminal —
  // the agent tab, a plain terminal, the Git panel's diff shell, a module's
  // agent — lands on its workspace's machine without each carrying it.
  resolveWorkspaceHostId?(workspaceId: string): string | null
  // Installs the authoritative-agent-state reporter hook into the workspace
  // before a supported agent (Claude Code / Codex) launches, so the agent's
  // lifecycle hooks report its true phase over the agent-state socket. The
  // installer dispatches on `cli`. Strictly best-effort: the implementation
  // swallows its own failures, so awaiting it never blocks or fails a launch.
  // Absent in tests / when the feature is unwired (no-op).
  prepareAgentStateHook?(
    workspaceRoot: string,
    cli: string,
    execution?: { pathStyle?: TerminalPathStyle; hostId?: string; integration?: HostAgentIntegration | null },
  ): Promise<void>
  // Durable freeze-the-view: per-terminal snapshot sidecars on disk, so a
  // suspended terminal reopens painted-and-paused after an app restart. Absent
  // when unwired (tests): suspend/quit skip persistence and rehydration never
  // finds anything — in-process behavior is unchanged.
  snapshotSidecars?: TerminalSnapshotSidecarStore
  // Where an agent's captured prompts outlive its session, the app and the
  // sidecar sweep, for the conversation peek. Absent in tests: prompts then
  // live on the session (and its sidecar) only, as they always did.
  agentPrompts?: AgentPromptStore
  // Whether any app window has focus. While none has, the reap sweep runs one
  // tick in `UNFOCUSED_REAP_SWEEP_EVERY` (see there). Absent (tests): focused.
  isAppFocused?(): boolean
  // Persists reaper decisions to the daily diagnostics JSONL: every reap
  // action, plus rate-limited "parked past threshold by gate X" skips. The
  // in-memory ring buffer (terminal-reap-log) dies with the process; the
  // 2026-07-07 parked-agents incident was only diagnosable via timer-alignment
  // forensics because no durable decision trail existed. Best-effort and
  // absent in tests (no-op).
  logDiagnostic?(input: {
    level: 'info' | 'warning'
    title: string
    message: string
    details?: string
    workspaceId?: string
    agentId?: string
    sessionId?: string
  }): void
  // --- Agent changelists (agent-changelist-feed.ts) -------------------------
  //
  // Three seams, one feed. They are OPTIONAL and must never be able to fail a
  // session: the runtime calls them inside a try/catch and ignores whatever
  // comes back, because the changelist store is a convenience and a terminal is
  // not.
  //
  // `onAgentLaunched` fires where a session goes live (`attachTerminalSession`),
  // which is the ONE seam every launch path passes through — the launch service,
  // a renderer spawn, and a resume alike — so an agent launched by any of them
  // gets its list. `onAgentFileEdit` fires per reported edit, and
  // `onAgentSessionExit` once per pty that dies on its own.
  onAgentLaunched?(session: TerminalSession): void
  onAgentFileEdit?(input: { session: TerminalSession; path: string; edits?: ChangelistEdit[]; ts: number }): void
  onAgentSessionExit?(session: TerminalSession): void
  // --- Pull request marks ------------------------------------------------------
  //
  // Where an agent session is, each time git answers for it: at every turn end
  // and session start (`fresh`), and when its working directory moves. It
  // decides which of the agent's pull requests are from the branch it is on.
  // And every tool call the reporter forwarded for the Studio server's pull
  // request reader, which is how the server hears that a terminal agent opened
  // one (terminal-pull-requests.ts). Fire-and-forget like the changelist seams
  // above.
  onObservedCheckoutResolved?(session: TerminalSession, resolution: { fresh: boolean }): void
  onAgentToolCall?(session: TerminalSession, toolCall: NonNullable<AgentStateFrame['toolCall']>): void
}

type TerminalIpcHandlers = {
  spawnTerminal(sender: WebContents, payload: TerminalSpawnPayload): Promise<TerminalSpawnResult>
  writeTerminal(sessionId: string, data: string): void
  resizeTerminal(sessionId: string, cols: number, rows: number): void
  getTerminalStatus(sessionId: string, sender?: WebContents): Promise<{ processAlive: boolean; suspended: boolean }>
  listTerminals(): TerminalSessionSnapshot[]
  setTerminalVisible(
    sessionId: string,
    visible: boolean,
    sender?: WebContents,
    options?: TerminalVisibilityOptions,
  ): void
  suspendTerminal(sessionId: string): void
  resumeTerminal(sender: WebContents, payload: TerminalSpawnPayload): Promise<TerminalSpawnResult>
  killTerminal(sessionId: string): void
  setIdleSuspendThresholdMs(value: unknown): void
  setKeepRecentTerminalsAlive(value: unknown): void
  setTerminalReapExempt(sessionId: string, exempt: boolean): void
  ackTerminalOutput(sessionId: string, units: number, sender?: WebContents): void
  /** First messages that could not be typed in, handed to the window that asks, once. */
  takeUndeliveredPrompts(): TerminalPromptUndelivered[]
}

type TerminalRuntime = {
  ipcHandlers: TerminalIpcHandlers
  // The conversation peek's read of a session: whether its runtime reports
  // prompts, and the prompts captured for it. Exposed as a plain reader rather
  // than an IPC handler so the peek service can be assembled outside the
  // runtime and unit-tested without one.
  readConversationPeekSessionState(sessionId: string): Promise<ConversationPeekSessionState | null>
  shutdown(): Promise<void>
  getLiveAgentExecutionIds(): LiveAgentExecution[]
  resolveAgentExecutionId(input: { workspaceId: string; agentId: string }): string | undefined
  registerAgentSessionExitListener(listener: AgentSessionExitListener): () => void
  // Fires on every accepted agent-state phase transition (see ingestAgentStateFrame):
  // frames for a dead pty and stale frames never reach a listener.
  registerAgentPhaseListener(listener: AgentPhaseListener): () => void
  // Applies an authoritative agent-state frame (from the lifecycle-hook reporter
  // socket) to the matching live session. Validated upstream by the service.
  ingestAgentStateFrame(frame: AgentStateFrame): void
  // The session's retained output, for main-process readers (the agent control
  // plane's `read`/`wait`). `undefined` means there is no such session — a
  // known session with nothing buffered yet returns an empty string, which is a
  // different answer. Distinct from the renderer replay path, which also
  // prefers the serialized screen snapshot: this is the raw stream, because a
  // caller matching a pattern needs the text the agent printed.
  readTerminalOutput(sessionId: string): string | undefined
  // Only what the session printed after `cursor` (the cursor an earlier call
  // returned; 0 for "everything retained"). For a poller: the agent control
  // plane's pattern wait asks this every 100 ms, and joining a multi-megabyte
  // scrollback each time was the whole cost of a wait.
  readTerminalOutputSince(sessionId: string, cursor: number): { text: string; cursor: number } | undefined
  // Fires once per coalesced sessions broadcast — the same beat the windows
  // hear — so a main-process consumer (the launched-agent reconcile) never
  // polls the session list. Carries nothing: the listener reads.
  subscribeSessionsChanged(listener: () => void): () => void
  // Send the pending sessions broadcast now. The quit path and the tests
  // that read the wire synchronously are its callers.
  flushSessionsBroadcast(): void
}

let terminalDiagnostics = createTerminalDiagnostics({
  enabled: false,
  logMainPerfEvent: () => {},
})
let logMainPerfEvent: TerminalRuntimeOptions['logMainPerfEvent'] = () => {}
const agentSessionExitListeners = new Set<AgentSessionExitListener>()
const agentPhaseListeners = new Set<AgentPhaseListener>()
let syncMcpConfig: TerminalRuntimeOptions['syncMcpConfig']
let ensureBuiltinSkillInstalled: TerminalRuntimeOptions['ensureBuiltinSkillInstalled']
let excludeWorktreeMcpConfig: TerminalRuntimeOptions['excludeWorktreeMcpConfig']
let prepareAgentStateHook: TerminalRuntimeOptions['prepareAgentStateHook']
let resolveWorkspaceHostId: TerminalRuntimeOptions['resolveWorkspaceHostId']
let snapshotSidecars: TerminalRuntimeOptions['snapshotSidecars']
let agentPrompts: TerminalRuntimeOptions['agentPrompts']
let logReapDiagnostic: TerminalRuntimeOptions['logDiagnostic']
let onAgentLaunched: TerminalRuntimeOptions['onAgentLaunched']
let onAgentFileEdit: TerminalRuntimeOptions['onAgentFileEdit']
let onObservedCheckoutResolved: TerminalRuntimeOptions['onObservedCheckoutResolved']
let onAgentToolCall: TerminalRuntimeOptions['onAgentToolCall']
let onAgentSessionExit: TerminalRuntimeOptions['onAgentSessionExit']

// Whether a CLI can report authoritative agent state: true exactly when its
// plugin manifest declares an `agentStateSpec` (the capability that also drives
// the reporter install and the event→phase mapping — one lookup, no hand-kept
// gate/installer lock-step). A CLI without the spec installs nothing and emits
// no frames.
function agentStateSupportsCli(cli: string | undefined): cli is string {
  if (!cli) return false
  return Boolean(getPluginById(pluginIdForCli(cli))?.manifest.agentStateSpec)
}

// The resolving plugin's agentStateSpec for a live session, consulted per
// frame to map the raw reporter event to a phase (see resolveAgentStateEvent).
let resolveObservedCheckout: ObservedCheckoutResolver = resolveCheckoutForCwd

function agentStateSpecForSession(session: TerminalSession) {
  const cli = session.cli
  if (!cli) return null
  return getPluginById(pluginIdForCli(cli))?.manifest.agentStateSpec ?? null
}

// True when the CLI resumes using the session id WE mint and pass at launch
// (`sessionIdFromCaller`) — so our terminal key equals its resume id (Claude).
// For these it is safe to resume against the terminal key when no harness id was
// captured. CLIs that mint their own id (Codex) must NOT fall back to our key —
// a bare `resume` (last session) is the correct default instead.
function cliResumesWithCallerSessionId(cli: string | undefined): boolean {
  return cliResumeCapabilities(cli).sessionIdFromCaller
}
export function createTerminalRuntime(options: TerminalRuntimeOptions): TerminalRuntime {
  resolveObservedCheckout = options.resolveObservedCheckout ?? resolveCheckoutForCwd
  agentSessionExitListeners.clear()
  agentPhaseListeners.clear()
  syncMcpConfig = options.syncMcpConfig
  ensureBuiltinSkillInstalled = options.ensureBuiltinSkillInstalled
  excludeWorktreeMcpConfig = options.excludeWorktreeMcpConfig
  prepareAgentStateHook = options.prepareAgentStateHook
  resolveWorkspaceHostId = options.resolveWorkspaceHostId
  snapshotSidecars = options.snapshotSidecars
  agentPrompts = options.agentPrompts
  logReapDiagnostic = options.logDiagnostic
  isAppFocused = options.isAppFocused
  onAgentLaunched = options.onAgentLaunched
  onAgentFileEdit = options.onAgentFileEdit
  onObservedCheckoutResolved = options.onObservedCheckoutResolved
  onAgentToolCall = options.onAgentToolCall
  onAgentSessionExit = options.onAgentSessionExit
  reapSkipLogState.clear()
  logMainPerfEvent = options.logMainPerfEvent
  terminalDiagnostics = createTerminalDiagnostics({
    enabled: options.diagnosticsEnabled,
    logMainPerfEvent: options.logMainPerfEvent,
  })
  startStaleTerminalSweep()

  return {
    readConversationPeekSessionState,
    shutdown: shutdownTerminalRuntime,
    getLiveAgentExecutionIds,
    resolveAgentExecutionId,
    registerAgentSessionExitListener,
    registerAgentPhaseListener,
    ingestAgentStateFrame,
    readTerminalOutput,
    readTerminalOutputSince,
    subscribeSessionsChanged(listener) {
      terminalSessionsChangedListeners.add(listener)
      return () => terminalSessionsChangedListeners.delete(listener)
    },
    flushSessionsBroadcast: flushTerminalSessionsBroadcast,
    ipcHandlers: {
      spawnTerminal: spawnTerminalFromIpc,
      writeTerminal: writeTerminalInput,
      resizeTerminal: safeResizeTerminal,
      async getTerminalStatus(sessionId, sender) {
        const session = terminals.get(sessionId) ?? (await rehydrateSuspendedTerminalFromSidecar(sessionId, sender))
        return {
          processAlive: Boolean(session && isTerminalProcessAlive(session)),
          suspended: Boolean(session?.suspended && !session.isDisposed),
        }
      },
      listTerminals() {
        return [...terminals.values()].filter((session) => !session.isDisposed).map(getTerminalSnapshot)
      },
      setTerminalVisible: setTerminalVisible,
      suspendTerminal: suspendTerminal,
      resumeTerminal: resumeTerminal,
      killTerminal: disposeTerminal,
      setIdleSuspendThresholdMs: setIdleSuspendThresholdMs,
      setKeepRecentTerminalsAlive: setKeepRecentTerminalsAlive,
      setTerminalReapExempt: setTerminalReapExempt,
      ackTerminalOutput,
      takeUndeliveredPrompts: () => undeliveredPrompts.splice(0),
    },
  }
}

// ── Claude Code CLI Terminal IPC ──────────────────────────────────────────────

const terminals = new Map<string, TerminalSession>()
// A resume disposes the suspended record and re-spawns under the same id; the
// turn-end stamp rides across that gap here so the fresh session still says
// when the agent last finished (the sidebar's idle time) until its next Stop.
const resumeTurnEndCarryover = new Map<string, number>()
function takeResumeTurnEnd(sessionId: string): number | null {
  const at = resumeTurnEndCarryover.get(sessionId) ?? null
  resumeTurnEndCarryover.delete(sessionId)
  return at
}
// The observed checkout rides the same gap: a resumed agent keeps
// saying where it was until its first hook frame re-observes (the resumed
// CLI's SessionStart re-resolves it, since the branch may have moved).
const resumeObservedCheckoutCarryover = new Map<string, ObservedCheckout>()
function takeResumeObservedCheckout(sessionId: string): ObservedCheckout | undefined {
  const checkout = resumeObservedCheckoutCarryover.get(sessionId)
  resumeObservedCheckoutCarryover.delete(sessionId)
  return checkout
}

// In-flight listener work from both agent-session seams (exit + phase). Shutdown
// drains this set, so a consumer whose reaction to an event is asynchronous —
// finalizing a run, opening a PR, removing a worktree — is not abandoned
// half-done when the app tears the runtime down.
const pendingAgentListenerRecords = new Set<Promise<void>>()

function trackAgentListenerRecord(record: Promise<void>): void {
  pendingAgentListenerRecords.add(record)
  void record.finally(() => {
    pendingAgentListenerRecords.delete(record)
  })
}

function sendTerminalEvent(sender: Electron.WebContents, channel: string, payload: string | number): void {
  if (!sender.isDestroyed()) {
    sender.send(channel, payload)
  }
}

const terminalOutput = createTerminalOutputBuffer({
  getSession: (sessionId) => terminals.get(sessionId),
  sendTerminalEvent,
  recordDataBatch: (session, cause, chunkCount, byteCount) => {
    terminalDiagnostics.recordDataBatch(session, cause, chunkCount, byteCount)
  },
  flowControl: {
    highWatermark: TERMINAL_FLOW_HIGH_WATERMARK,
    lowWatermark: TERMINAL_FLOW_LOW_WATERMARK,
    stallResumeMs: TERMINAL_FLOW_STALL_RESUME_MS,
    pause: (session) => {
      if (!isTerminalProcessAlive(session)) return
      try {
        session.process.pause()
      } catch {
        // A pty that died between the check and the call has nothing to pause.
      }
    },
    resume: (session) => {
      if (!isTerminalProcessAlive(session)) return
      try {
        session.process.resume()
      } catch {
        // Same race as pause: a dead pty has nothing to resume.
      }
    },
  },
})

/**
 * The renderer parsed `units` of a session's output (xterm's write callback).
 * Only the window the session is routed to may speak for its pane: another
 * window's late ack is about a pane that no longer receives this stream.
 */
function ackTerminalOutput(sessionId: string, units: number, sender?: WebContents): void {
  const session = terminals.get(sessionId)
  if (!session || session.isDisposed) return
  if (sender && session.sender !== sender) return
  terminalOutput.ack(sessionId, units)
}

/**
 * The event sink for a main-process spawn. A live window streams output to the
 * UI immediately; with every window closed the headless sender stands in — the
 * sender is an event sink, not a capability, so the pty still runs and buffers,
 * and a window opened later reattaches through `spawnTerminalFromIpc`'s
 * existing-session branch, adopting the real WebContents and replaying
 * scrollback. The one definition for every main-process spawn: the launch
 * service's spawn port in `src/main/app-services.ts`.
 */
export function resolveSpawnEventSink(): WebContents {
  return (
    BrowserWindow.getAllWindows().find(
      (win) => !win.isDestroyed() && !win.webContents.isDestroyed() && !isCanvasWorkerWindow(win),
    )?.webContents ?? createHeadlessTerminalSender()
  )
}

/**
 * How long session changes are gathered before one broadcast carries them.
 *
 * Seventeen call sites fire this — every hook-frame activity change, every
 * cwd resolution, every turn end, every exit — and each used to snapshot
 * every session and structured-clone the array into every window on its own.
 * Sampled on 2026-09-05 that was a steady fifteen percent of the main thread
 * in IPC serialization between the stalls. A frame's worth of coalescing
 * turns a burst of frames into one send; nothing a person can see arrives
 * later than a paint would have.
 */
export const TERMINAL_SESSIONS_BROADCAST_COALESCE_MS = 16

let pendingSessionsBroadcast: ReturnType<typeof setTimeout> | null = null
const terminalSessionsChangedListeners = new Set<() => void>()

/**
 * What the next broadcast carries. It used to be a full snapshot of every
 * session — file ledgers of up to 500 entries each included — structured-cloned
 * into every window on every change to any one of them. Now it names the
 * sessions that changed and the ones that went away, and nothing else.
 *
 * An exited session is not special-cased: it is sent when it changes (its exit
 * is a change) and never again because some other session moved.
 */
const dirtySessionIds = new Set<string>()
const removedSessionIds = new Set<string>()
// Per session OBJECT (a resume is a new object under the same id, and must send
// its lists afresh): the ledger version and pull request list last broadcast,
// so a delta carries a list only when that list moved.
const broadcastListState = new WeakMap<TerminalSession, { fileChangesVersion: number; pullRequestsKey: string }>()

/**
 * Note that `session` changed WITHOUT scheduling a broadcast. For state no
 * window needs promptly — the phase churn between two tool calls, a keystroke's
 * `lastInputAt` — that used to reach the windows only because the NEXT
 * broadcast re-sent every session. It still does: it rides whichever broadcast
 * goes out next.
 */
function markTerminalSessionChanged(session: TerminalSession): void {
  if (terminals.get(session.sessionId) !== session) return
  dirtySessionIds.add(session.sessionId)
}

function noteTerminalSessionRemoved(sessionId: string): void {
  dirtySessionIds.delete(sessionId)
  removedSessionIds.add(sessionId)
  broadcastTerminalSessionsChanged(null)
}

/** `session` changed in a way a window renders; tell them, coalesced. `null` only schedules. */
function broadcastTerminalSessionsChanged(session: TerminalSession | null): void {
  if (session) markTerminalSessionChanged(session)
  if (pendingSessionsBroadcast) return
  pendingSessionsBroadcast = setTimeout(() => {
    pendingSessionsBroadcast = null
    flushTerminalSessionsBroadcast()
  }, TERMINAL_SESSIONS_BROADCAST_COALESCE_MS)
  pendingSessionsBroadcast.unref?.()
}

/**
 * One session OBJECT by id, and the live ones — not snapshots.
 *
 * A caller that only needs to read a session's own fields (its observed
 * checkout, say) must not have to build `listTerminals()`, which is a full
 * snapshot of EVERY session and, for the pull request marks, calls back into
 * the record for each one. Resolving a single session that way made a hover
 * O(sessions) snapshot builds.
 *
 * `listLiveTerminalSessions` deliberately drops the exited and disposed ones:
 * a background refresh has nothing to learn from a session whose process is
 * gone, and a fan-out that includes them is that much wider for nothing. A
 * lookup by id still answers for an exited session — its marks are still drawn,
 * and hovering one is still a reason to refresh.
 */
export function getTerminalSessionById(sessionId: string): TerminalSession | null {
  return terminals.get(sessionId) ?? null
}

export function listLiveTerminalSessions(): TerminalSession[] {
  return [...terminals.values()].filter((session) => !session.isDisposed && !session.hasExited)
}

/**
 * A pull request record changed: re-emit the sessions the change reaches (epic
 * `pull-request-marks`, decision 10). Which sessions those are is the record's
 * question, not this module's — a session is reached either because it sits on
 * the repository and branch that changed or because it opened one of the pull
 * requests in it, possibly in another repository entirely — so the predicate
 * comes from there. Each reached session goes out on the existing coalesced
 * broadcast as a delta entry, which carries its pull request list only when that
 * list moved; the point of the check is that a change no live session is on
 * buys no broadcast and no repaint at all.
 */
export function notePullRequestRecordChanged(affectsSession: (session: TerminalSession) => boolean): void {
  for (const session of terminals.values()) {
    if (session.isDisposed) continue
    if (!affectsSession(session)) continue
    broadcastTerminalSessionsChanged(session)
  }
}

/**
 * One changed session as the broadcast carries it: the snapshot without its two
 * lists, plus each list only if it moved since this session last went out. The
 * renderer keeps the list it has when one is absent (terminalSessionsStore).
 */
function buildTerminalSessionDeltaEntry(session: TerminalSession): TerminalSessionDeltaEntry {
  const entry: TerminalSessionDeltaEntry = getTerminalSnapshotBase(session)
  const sent = broadcastListState.get(session)
  const fileChangesVersion = session.fileChangesVersion ?? 0
  if (!sent || sent.fileChangesVersion !== fileChangesVersion) entry.fileChanges = listSessionFileChanges(session)
  const pullRequests = listSessionPullRequests(session)
  const pullRequestsKey = pullRequests.length > 0 ? JSON.stringify(pullRequests) : ''
  if (!sent || sent.pullRequestsKey !== pullRequestsKey) entry.pullRequests = pullRequests
  broadcastListState.set(session, { fileChangesVersion, pullRequestsKey })
  return entry
}

/** Send now whatever is pending — the quit path, and tests that read the wire synchronously. */
function flushTerminalSessionsBroadcast(): void {
  if (pendingSessionsBroadcast) {
    clearTimeout(pendingSessionsBroadcast)
    pendingSessionsBroadcast = null
  }
  const upserts: TerminalSessionDeltaEntry[] = []
  for (const sessionId of dirtySessionIds) {
    const session = terminals.get(sessionId)
    if (!session || session.isDisposed) continue
    upserts.push(buildTerminalSessionDeltaEntry(session))
  }
  // An id removed and re-added inside one window (a resume disposes and
  // respawns under the same id) is an update, not a removal.
  const removed = [...removedSessionIds].filter((sessionId) => {
    const session = terminals.get(sessionId)
    return !session || session.isDisposed
  })
  dirtySessionIds.clear()
  removedSessionIds.clear()

  if (upserts.length > 0 || removed.length > 0) {
    const delta: TerminalSessionsDelta = { upserts, removed }
    broadcastToAllWindows('terminal:sessions-delta', delta)
  }
  // Main-process listeners hear the same beat the windows do, so none of them
  // has to poll the session list.
  for (const listener of terminalSessionsChangedListeners) {
    try {
      listener()
    } catch (error) {
      console.warn('[terminal-runtime] sessions-changed listener failed', error)
    }
  }
}

function setTerminalVisible(
  sessionId: string,
  visible: boolean,
  sender?: WebContents,
  options?: TerminalVisibilityOptions,
): void {
  const session = terminals.get(sessionId)
  if (!session || session.isDisposed) return
  // Only the window the session is routed to speaks for its visibility. A pane
  // terminal can move between windows — popped out of its workspace window and
  // docked back — and the window it left still says "hidden" for it: its
  // panel's unmount does, and so does its own hidden-window sweep over every
  // session of a workspace it shows. Taken at its word, that froze the window
  // the terminal is actually in. The same rule the output acks follow
  // (`ackTerminalOutput`). A suspended session is the exception: its recorded
  // sender can be a dead window or a sidecar's noop sink, and the reveal below
  // adopts whichever window is painting it.
  if (sender && session.sender !== sender && !session.suspended && !session.sender.isDestroyed()) return
  // A pane that has just been built holds nothing, whatever the last pane in
  // its place was sent. Forget that, so the reveal below (now or later) paints
  // it in full instead of "catching up" an empty xterm by zero bytes.
  const freshPane = options?.freshPane === true
  if (freshPane) {
    session.rendererDeliveredOffset = undefined
    session.rendererDeliveredTo = undefined
  }
  // A suspended session has no live pty routing output anywhere, and its
  // recorded sender can be a dead window (or the noop sender of a placeholder
  // rehydrated from a snapshot sidecar). Adopt the revealing window so the
  // replay below actually reaches the view being painted. So does a live one
  // routed to a window that is gone — a pane terminal's pop-out window that
  // closed while its output went there: left routed, the window that does
  // show it stays blank. Adopted, that window is sent the screen in full
  // (nothing says what it holds), whether or not this is a hidden→visible
  // edge.
  const adopted = Boolean(sender && session.sender !== sender && (session.suspended || session.sender.isDestroyed()))
  if (adopted && sender) {
    session.sender = sender
  }
  // While a terminal is hidden the agent keeps running and we keep appending to
  // the retained replay buffer, but we stop forwarding output to its (frozen)
  // renderer xterm (see terminal-output-buffer flush gate). On becoming visible
  // again the xterm is behind by exactly what arrived while it was hidden, so
  // that is what it is sent (see revealCatchUp); only when that is no longer
  // all retained does the pane reset and replay the whole window. This is the
  // cold-layer reveal path; warm/active layers never go hidden so they never
  // pay this.
  const wasVisible = session.visible
  const becameVisible = visible && session.visible === false
  // A suspended session's reveal must not be only edge-triggered: a renderer
  // window reload or a TerminalView remount that never delivered its unmount
  // hide leaves `session.visible === true` in main, so the fresh xterm's reveal
  // misses the hidden→visible edge and — with a dead pty that will never
  // repaint — stays blank forever under the Paused footer. So a suspended
  // session is repainted whenever main cannot vouch that this pane already has
  // its screen: a fresh pane (above), a window it was never sent to. A repeat
  // reveal of a pane that does have it sends nothing — the frozen screen can be
  // a couple of megabytes, and a workspace switch should not repaint it.
  const shouldReplay =
    becameVisible ||
    (visible && (freshPane || adopted || (session.suspended === true && !rendererHoldsSessionOutput(session))))
  if (becameVisible) {
    // Drop any batch buffered-but-not-forwarded while hidden: it is already in
    // the retained replay we are about to send, so forwarding it after the
    // replay would duplicate the tail.
    terminalOutput.flush(sessionId, 'visibility')
  } else if (shouldReplay) {
    // A fresh pane shown without a hidden→visible edge: the replay below holds
    // whatever batch was queued for the pane it replaces.
    terminalOutput.discard(sessionId)
  }
  recordTerminalVisibility(session, visible)
  // A pane going hidden or coming back has nothing in flight worth waiting on:
  // a hidden one receives nothing, and a revealed one is about to be caught up.
  // Nor has a fresh one: it has been sent nothing yet.
  if (visible !== wasVisible || freshPane) terminalOutput.resetRendererFlow(sessionId)
  if (shouldReplay) {
    const catchUp = becameVisible ? revealCatchUp(session) : null
    if (catchUp !== null) {
      if (catchUp) {
        sendTerminalEvent(session.sender, `terminal:data:${sessionId}`, catchUp)
        // Only a live pty has a flow to hold back; a dead one's state is gone.
        if (isTerminalProcessAlive(session)) terminalOutput.noteRendererSent(sessionId, catchUp.length)
      }
      noteRendererCaughtUp(session)
      logMainPerfEvent('TerminalRuntime', 'terminal-reveal-catch-up-sent', {
        sessionId,
        workspaceId: session.workspaceId,
        agentId: session.agentId,
        terminalId: session.terminalId,
        kind: session.kind,
        catchUpChars: catchUp.length,
      })
    } else {
      // A suspended session prefers its faithful screen snapshot (alt-screen TUIs
      // don't reconstruct from the raw stream); live sessions have none and fall
      // back to the retained scrollback.
      const replay = session.replaySnapshot ?? materializeTerminalReplay(session)
      noteRendererCaughtUp(session)
      if (replay) {
        sendTerminalEvent(session.sender, `terminal:replay:${sessionId}`, replay)
        logMainPerfEvent('TerminalRuntime', 'terminal-replay-sent', {
          sessionId,
          workspaceId: session.workspaceId,
          agentId: session.agentId,
          terminalId: session.terminalId,
          kind: session.kind,
          replayChars: replay.length,
          cause: 'revisible',
        })
      }
    }
  }
  broadcastTerminalSessionsChanged(session)
}

/**
 * What a live pane that is being revealed missed while it was hidden — the
 * output past the last byte it was sent — or null when it has to be repainted
 * from the whole retained window instead.
 *
 * The reveal used to resend all of it, up to 2.5 MB, and the pane reset and
 * re-parsed every byte: several megabytes of allocation and structured clone
 * in main and a visible stall in the renderer on every tab switch, to redraw a
 * screen that was already right up to the moment it was hidden. The pane's
 * xterm is the same instance it was then, still holding everything before that
 * point, so appending the rest leaves it exactly where a pane that was never
 * hidden would be.
 *
 * Null (repaint in full) whenever that reasoning does not hold:
 *   - a suspended session, or one showing its frozen snapshot, that produced
 *     output the pane was not sent: there is no live stream to continue, and
 *     the snapshot is a different thing from it;
 *   - the pane is in a different window from the one that was sent the bytes
 *     (the session was adopted by another window since);
 *   - nothing was ever sent to it, or what it missed has already been cut from
 *     the head of the retained window.
 */
function revealCatchUp(session: TerminalSession): string | null {
  if (!rendererHoldsSessionOutput(session)) return null
  const deliveredOffset = session.rendererDeliveredOffset as number
  // Nothing arrived while it was hidden: the pane is already exactly right.
  // This holds for a settled session too — releasing its stream keeps the
  // stream's end offset — so a finished or paused agent the pane watched to
  // the end is not reset and repainted on every workspace switch.
  if (deliveredOffset === session.output.endOffset) return ''
  if (session.suspended || session.replaySnapshot) return null
  return session.output.readFrom(deliveredOffset)
}

/** Whether the session's current pane was sent its output, by this window. */
function rendererHoldsSessionOutput(session: TerminalSession): boolean {
  return session.rendererDeliveredOffset !== undefined && session.rendererDeliveredTo === session.sender
}

/** The pane now holds everything the session has produced, by replay or by catch-up. */
function noteRendererCaughtUp(session: TerminalSession): void {
  session.rendererDeliveredOffset = session.output.endOffset
  session.rendererDeliveredTo = session.sender
}

// How long after a pty resize to treat incoming output as a repaint (alt-screen
// redraw) rather than agent activity. A few hundred ms covers the redraw burst;
// real agent output that follows lands outside the window and counts normally.
const REPAINT_GRACE_MS = 400

function safeResizeTerminal(sessionId: string, cols: number, rows: number): void {
  const session = terminals.get(sessionId)
  if (!session || !isTerminalProcessAlive(session)) return

  const size = getTerminalSize(cols, rows)
  if (process.platform === 'win32' && !session.isReady) {
    session.pendingResize = size
    return
  }

  // Dedupe: a reveal / tab-switch re-fits to the SAME dimensions. Resizing the
  // pty then makes the alt-screen TUI (Claude/Codex) repaint, and that repaint
  // flows through onData as spurious output — bumping lastOutputAt and flipping
  // activity to "working". Skip when the size is unchanged so liveness/recency
  // reflect real agent output, not repaints.
  if (session.appliedCols === size.cols && session.appliedRows === size.rows) return

  try {
    session.process.resize(size.cols, size.rows)
    session.appliedCols = size.cols
    session.appliedRows = size.rows
    // Output in the brief window after a resize is the TUI repainting, not the
    // agent working — buffer it but don't count it toward liveness/recency.
    session.repaintGraceUntil = Date.now() + REPAINT_GRACE_MS
  } catch {
    // node-pty can report resize-after-exit races before its exit event is delivered.
    setTerminalActivity(session, { kind: 'exited', at: Date.now(), exitCode: session.exitCode ?? 0 })
  }
}

function flushPendingTerminalResize(sessionId: string, session: TerminalSession): void {
  const pendingResize = session.pendingResize
  if (!pendingResize) return

  session.pendingResize = undefined
  safeResizeTerminal(sessionId, pendingResize.cols, pendingResize.rows)
}

// Freeze-the-view: kill the agent process to reclaim its RAM but KEEP the
// session (painted scrollback + --resume launch flags) so it can be resumed on
// the next keystroke. Unlike disposeTerminal this does not remove the session
// and does not fire `terminal:exit` (the view stays painted). The pty `onExit`
// handler finalizes the suspend
// (sets `suspended`, broadcasts) by branching on the `suspending` flag set here.
export function suspendTerminal(sessionId: string): void {
  const session = terminals.get(sessionId)
  if (!session || session.isDisposed || session.suspended || session.suspending) return
  if (!isTerminalProcessAlive(session)) return
  session.suspending = true
  // Capture any pending output before the process dies, but keep the buffer so
  // the scrollback can be replayed for the painted view.
  terminalOutput.flush(sessionId, 'dispose')
  terminalOutput.forgetSession(sessionId)
  clearTerminalIdleTimer(session)
  // A suspend kills the pty without going through the exited/failed activity
  // transition (the onExit branch returns early), so clear the stall timer here
  // too or it lingers armed against a dead process until it self-expires.
  clearAgentStallTimer(session)
  // Snapshot the painted screen for a faithful blank-free reopen. Read the size
  // and materialize the retained stream BEFORE the kill, then render+serialize
  // off-thread (best-effort): a failure just leaves the raw replay in place.
  const snapshotCols = session.process.cols
  const snapshotRows = session.process.rows
  const snapshotSource = materializeTerminalReplay(session)
  try {
    session.process.kill()
  } catch {
    // If the process already died, the onExit path has run; the guards above
    // keep this from double-finalizing.
  }
  // Suspend's contract is "process dead, session resumable" — a CLI
  // child that survives the pty's SIGHUP breaks the first half invisibly.
  // Verify by argv and SIGKILL survivors (resume uses the CLI's own
  // `--resume` token, which needs no live process).
  killSessionSurvivors(session)
  void buildReplaySnapshot(snapshotSource, snapshotCols, snapshotRows).then((snapshot) => {
    // Only attach if this exact session is still the suspended one (not disposed,
    // resumed, or replaced) — otherwise a stale snapshot could shadow live output.
    // Accept `suspending` too: it is set synchronously before the kill, while
    // `suspended` only flips in the async pty `onExit` — and this render usually
    // resolves first, so gating on `suspended` alone would discard most snapshots.
    // A resume/dispose removes the session from the map (so `current === session`
    // fails) and sets `isDisposed`, keeping this safe against a stale shadow.
    const current = terminals.get(sessionId)
    if (current === session && (session.suspending || session.suspended) && !session.isDisposed) {
      if (snapshot) {
        session.replaySnapshot = snapshot
        // The frozen screen is what a paused pane reopens on — every reveal,
        // reattach and remote attach prefers it — so the raw stream it was
        // rendered from is now megabytes nobody will read. Only on success: a
        // failed render leaves the raw replay as the painted view's fallback.
        releaseTerminalOutput(session)
      }
      // Durable freeze-the-view: give the snapshot a disk lifecycle so this
      // terminal reopens painted-and-paused after an app restart too. A failed
      // render (timeout, serialize error) persists the raw stream instead so
      // the sidecar is never silently skipped; rehydration re-renders it.
      writeTerminalSnapshotSidecar(session, {
        snapshot: snapshot ?? undefined,
        rawReplay: snapshot ? undefined : snapshotSource,
        cols: snapshotCols,
        rows: snapshotRows,
      })
    }
  })
}

// A settled agent drops what it holds in memory. An agent whose pty ended on
// its own is settled, but its tab stays open on its last screen and the agent
// control plane can still read what it printed, synchronously. So, as suspend
// does, render that screen once and let the raw stream behind it go: every
// reveal and reattach already prefers `replaySnapshot`, and
// `readTerminalOutput` / `readTerminalOutputSince` answer from it once the
// stream is released. Until the render lands the raw stream serves every read,
// and a failed render keeps it as the fallback.
//
// The sidecar written on exit keeps its raw dump; a restart renders it, and the
// quit path rewrites it from this snapshot if the app is still running then.
function settleExitedAgentScreen(session: TerminalSession, source: string): void {
  if (session.kind !== 'agent') return
  // The size the CLI drew for: the last applied resize, else the size the pty
  // was spawned at. An agent launched in the background may never have been
  // fitted, and a render at a default 80 columns would garble its layout.
  const cols = session.appliedCols ?? session.process.cols ?? 80
  const rows = session.appliedRows ?? session.process.rows ?? 24
  void buildReplaySnapshot(source, cols, rows).then((snapshot) => {
    if (!snapshot) return
    // Only onto this exact exited session: a respawn under the same id is a new
    // record, and a dispose has already released everything.
    if (terminals.get(session.sessionId) !== session || session.isDisposed) return
    if (isTerminalProcessAlive(session) || session.replaySnapshot) return
    session.replaySnapshot = snapshot
    releaseTerminalOutput(session)
  })
}

// A frozen view is at rest by construction — the same stamp
// `createSuspendedPlaceholderSession` puts on the restart-rehydration path,
// applied to the in-process suspend so the two agree.
//
// The suspend branch of `onExit` keeps the session's phase deliberately (unlike
// a real exit, which stamps `exited`), and that is right for a phase that
// describes the AGENT — but `starting`/`thinking`/`tool_use`, and the `working`
// activity bridged from them, describe a RUNNING PROCESS, and the process is
// what suspend just killed. Frozen verbatim they outlive it: nothing re-reads
// them (the stall watch that would have expired a working phase is disarmed
// here, and `resumeSuspendedTerminal` spawns a fresh session), so the sidebar
// lights a paused chat as a turn in flight until the app restarts. The reaper
// only ever suspends an at-rest agent, but the pause control has no such gate:
// pausing mid-turn is exactly how a chat gets stuck bright (observed
// 2026-09-10, session frozen at `starting` for 70 minutes).
//
// Only a working claim is rewritten. An `idle`/`awaiting_input` stamp already
// says when the agent came to rest, and moving it here would relabel the
// suspend as the turn's end — the very thing `deriveWorkspaceIdleSince` reads
// `lastTurnEndedAt` to avoid.
function settleSuspendedAgentRest(session: TerminalSession): void {
  const phase = session.agentState?.phase
  const claimsWork =
    session.activity.kind === 'working' || phase === 'starting' || phase === 'thinking' || phase === 'tool_use'
  if (!claimsWork) return
  // When the turn ended, if one ever did; else the moment the process died,
  // which is all a session suspended mid-turn can honestly say.
  const restingSince = session.lastTurnEndedAt ?? Date.now()
  if (session.agentState) session.agentState = { phase: 'idle', since: restingSince, source: 'lifecycle' }
  // Broadcast is the caller's: it sends one snapshot for the whole finalize.
  setTerminalActivity(session, { kind: 'idle', since: restingSince }, { broadcast: false })
}

function writeTerminalSnapshotSidecar(
  session: TerminalSession,
  payload: { snapshot?: string; rawReplay?: string; cols: number; rows: number },
): void {
  if (!snapshotSidecars) return
  // Painted-pause is an agent-terminal promise (the paused footer, resume-on-
  // click); plain shells respawn fresh on reopen as they always have.
  if (session.kind !== 'agent') return
  if (!payload.snapshot && !payload.rawReplay) return
  // A dead/mock pty can report undefined dimensions; clamp so the sidecar
  // always validates on read (buildReplaySnapshot applies the same defaults).
  const size = getTerminalSize(payload.cols, payload.rows)
  snapshotSidecars.write({
    version: 1,
    sessionId: session.sessionId,
    savedAt: Date.now(),
    cols: size.cols,
    rows: size.rows,
    kind: session.kind,
    workspaceId: session.workspaceId,
    agentId: session.agentId,
    terminalId: session.terminalId,
    cli: session.cli,
    cliSessionId: session.cliSessionId,
    ...(session.hostId ? { hostId: session.hostId } : {}),
    cwd: session.cwd,
    executionMode: session.executionMode,
    worktreeId: session.worktreeId,
    worktreePath: session.worktreePath,
    observedCheckout: session.observedCheckout,
    // The file ledger dies with the pty, so the sidecar is the only place it
    // survives a restart — a parked chat must still say what it changed. It
    // rides the painted screen rather than being persisted on its own: a
    // session with nothing painted is never rehydrated, so there would be
    // nothing to read the ledger back onto.
    ...(session.fileChanges?.size ? { fileChanges: listSessionFileChanges(session) } : {}),
    // The context reading rides the same sidecar and for the same reason: a
    // parked chat that says nothing about how full it is looks like a fresh one.
    ...(session.contextUsage ? { contextUsage: session.contextUsage } : {}),
    // And the prompt cache, so the parked session goes cold on time.
    ...(session.promptCache ? { promptCache: session.promptCache } : {}),
    // The prompts, for the same reason again: they are the peek's only source,
    // and a parked chat with none here has nothing to show until its agent's
    // prompt store is read.
    ...(session.peekPrompts?.length ? { prompts: session.peekPrompts } : {}),
    lastTurnEndedAt: session.lastTurnEndedAt ?? undefined,
    snapshot: payload.snapshot,
    rawReplay: payload.rawReplay,
  })
}

// Durable freeze-the-view, read side: no live session for this id, but a
// snapshot sidecar survives from a previous app run — materialize a suspended
// placeholder so the renderer's existing pause-instead-of-launch flow fires:
// status reports suspended, reveal replays the painted screen, and resume
// disposes the placeholder (deleting the sidecar) and re-spawns with --resume.
// Quit-path sidecars carry the raw stream; render it to a faithful snapshot
// here (alt-screen TUIs do not reconstruct from raw replay), falling back to
// seeding the raw buffer when the render fails.
async function rehydrateSuspendedTerminalFromSidecar(
  sessionId: string,
  sender?: WebContents,
): Promise<TerminalSession | undefined> {
  if (!snapshotSidecars) return undefined
  const sidecar = await snapshotSidecars.read(sessionId)
  if (!sidecar) return undefined
  let snapshot = sidecar.snapshot
  if (!snapshot && sidecar.rawReplay) {
    snapshot = (await buildReplaySnapshot(sidecar.rawReplay, sidecar.cols, sidecar.rows)) ?? undefined
  }
  // The render awaited above can race a concurrent spawn/rehydrate for the same
  // id; an existing live record wins.
  const existing = terminals.get(sessionId)
  if (existing && !existing.isDisposed) return existing
  const session = createSuspendedPlaceholderSession({
    sessionId,
    sender,
    savedAt: sidecar.savedAt,
    kind: sidecar.kind,
    workspaceId: sidecar.workspaceId,
    agentId: sidecar.agentId,
    terminalId: sidecar.terminalId,
    cli: sidecar.cli,
    cliSessionId: sidecar.cliSessionId,
    hostId: normalizeExecutionHostId(sidecar.hostId) ?? undefined,
    cwd: sidecar.cwd,
    executionMode: sidecar.executionMode,
    worktreeId: sidecar.worktreeId,
    worktreePath: sidecar.worktreePath,
    observedCheckout: parseObservedCheckout(sidecar.observedCheckout) ?? undefined,
    fileChanges: parseSessionFileChanges(sidecar.fileChanges),
    contextUsage: parseSessionContextUsage(sidecar.contextUsage),
    promptCache: parsePromptCacheReading(sidecar.promptCache) ?? undefined,
    peekPrompts: parseSessionPrompts(sidecar.prompts),
    lastTurnEndedAt: typeof sidecar.lastTurnEndedAt === 'number' ? sidecar.lastTurnEndedAt : null,
    replaySnapshot: snapshot,
    rawReplay: snapshot ? undefined : sidecar.rawReplay,
  })
  terminals.set(sessionId, session)
  logMainPerfEvent('TerminalRuntime', 'terminal-suspended-rehydrated', {
    sessionId,
    workspaceId: session.workspaceId,
    agentId: session.agentId,
    terminalId: session.terminalId,
    cli: session.cli,
    kind: session.kind,
    savedAt: sidecar.savedAt,
    snapshotSource: sidecar.snapshot ? 'sidecar-snapshot' : snapshot ? 'rendered-raw' : 'raw-fallback',
  })
  broadcastTerminalSessionsChanged(session)
  return session
}

// Freeze-the-view: relaunch a suspended agent under the SAME session id with
// --resume, triggered by the renderer on the first keystroke. The suspended
// session's pty is already dead, so we dispose the stale record and re-spawn with
// `resume: true` — the existing launch path renders `--resume <sessionId>` for
// Claude and attaches a fresh pty. A non-suspended session falls through to the
// normal spawn/reattach path unchanged (no-op relaunch).
async function resumeTerminal(sender: WebContents, payload: TerminalSpawnPayload): Promise<TerminalSpawnResult> {
  const existing = terminals.get(payload.sessionId)
  // Carry the agent's captured harness session id forward from the suspended
  // session before it is disposed, so an in-session resume still targets the
  // right conversation even if the renderer's payload lacks it (e.g. a resume
  // thunk closed over the agent before the lifecycle hook reported the id). An
  // explicit payload value still wins.
  const cliSessionId = payload.cliSessionId ?? existing?.cliSessionId
  if (existing && existing.suspended) {
    // Refuse BEFORE disposing: dispose deletes the snapshot sidecar, so a
    // resume the spawn gate would reject (a suspended session on a CLI that
    // lost agent eligibility — e.g. muse after the hooks-only rule, or a BYO
    // plugin authored before agentStateSpec existed) must keep the frozen view
    // intact instead of erasing it and then failing to spawn anything.
    const resumeCli = payload.cli ?? existing.cli
    if (
      !payload.shellOnly &&
      resumeCli &&
      getPluginById(pluginIdForCli(resumeCli)) &&
      !agentStateSupportsCli(resumeCli)
    ) {
      return {
        ok: false,
        sessionId: payload.sessionId,
        message: `Agent CLI "${resumeCli}" cannot report agent status (its plugin declares no lifecycle-hook support), so this session cannot be resumed as an agent. Its frozen view is kept.`,
        exitCode: 1,
      } satisfies TerminalSpawnResult
    }
    if (typeof existing.lastTurnEndedAt === 'number') {
      resumeTurnEndCarryover.set(payload.sessionId, existing.lastTurnEndedAt)
    }
    if (existing.observedCheckout) {
      resumeObservedCheckoutCarryover.set(payload.sessionId, existing.observedCheckout)
    }
    disposeTerminal(payload.sessionId)
  }
  // The host too: a resumed CLI's conversation lives in the home of the
  // machine it ran on, whatever the payload now asks for.
  const hostId = existing?.hostId ?? payload.hostId
  return spawnTerminalFromIpc(sender, { ...payload, resume: true, cliSessionId, ...(hostId ? { hostId } : {}) })
}

function disposeTerminal(sessionId: string): void {
  const session = terminals.get(sessionId)
  if (!session) return

  // Dispose means gone — never rehydrated or repainted. Covers resume (the
  // sidecar is consumed), fresh spawn, agent deletion, and the reap sweeps.
  // App-quit teardown deliberately does NOT run through here (disposeAllTerminals
  // inlines its own loop), so quit never erases the sidecars it just wrote.
  snapshotSidecars?.remove(sessionId)
  session.deferredPrompt?.cancel()
  cleanupTerminalStartupScript(session.startupScriptPath)
  cleanupHostContextFile(session.hostContextPath)
  cleanupHostContextFile(session.launchPromptPath)
  discardHostLaunchFiles(session)
  terminalOutput.flush(sessionId, 'dispose')
  terminalDiagnostics.clear(sessionId)
  // The spawn-armed stall timer would otherwise hold the session object alive
  // up to 90s past dispose (its fire is a guaranteed no-op, but the reference
  // is not free).
  clearTerminalIdleTimer(session)
  clearAgentStallTimer(session)
  session.isDisposed = true
  setTerminalActivity(
    session,
    { kind: 'exited', at: Date.now(), exitCode: session.exitCode ?? 0 },
    { broadcast: false },
  )
  terminals.delete(sessionId)
  terminalOutput.forgetSession(sessionId)
  noteTerminalSessionRemoved(sessionId)
  // Settled: nothing this session held for a view is wanted again. Released
  // here rather than left to the collector, because the pty's exit handler and
  // any git resolution still in flight keep the session object reachable for a
  // while after this, and with it megabytes of stream and painted screen.
  releaseSettledTerminalSession(session)

  try {
    session.process.kill()
  } catch {
    // ignore kill errors if process died first
  }
  // The pty kill reaches the shell, but a CLI child that survives the
  // resulting SIGHUP reparents to launchd and nothing tracks it afterwards —
  // dispose has deleted the session record, so a survivor is a permanent leak
  // (15 idle Opus agents in the 2026-07-26 incident). Verify by argv and
  // SIGKILL survivors; a clean exit makes this a no-op.
  killSessionSurvivors(session)
  releaseSessionHost(session)
}

// The session's machine ends what it left running: `ps` by `--session-id` on
// macOS and Linux, CIM on Windows, and inside the distribution for WSL, where
// killing `wsl.exe` on the Windows side does not reach the Linux processes.
// There the helper also ends the session shell's whole subtree (found through
// its pid file), so a plain WSL terminal that carries no CLI session id still
// leaves nothing behind.
function killSessionSurvivors(session: TerminalSession): void {
  const host = hostRegistry().get(session.hostId)
  if (!session.cliSessionId && host.kind !== 'wsl') return
  // A suspended WSL session had its survivors ended when it was suspended.
  // Closing it later must not start a stopped helper (and wake the VM) to look
  // again for what is already gone.
  if (host.kind === 'wsl' && session.suspended) return
  void host
    .killSessionSurvivors(session.cliSessionId ?? '', { startupScriptPath: session.startupScriptPath })
    .catch(() => [])
}

// A session holds its machine while its pty lives: for WSL that keeps the
// helper running, and the last release lets it stop a while later so the VM
// can idle. Keyed per pty, so a relaunch under the same session id never has
// its hold dropped by the old pty's late exit.
let nextHostLease = 1

function retainSessionHost(session: TerminalSession): void {
  if (session.hostLease) return
  session.hostLease = `${session.sessionId}#${nextHostLease}`
  nextHostLease += 1
  hostRegistry().get(session.hostId).retainSession(session.hostLease)
}

function releaseSessionHost(session: TerminalSession): void {
  // The launch is over: a bridge it started, or anything that copied its
  // token, can no longer open an MCP channel on its machine.
  if (session.channelToken) {
    hostRegistry().get(session.hostId).revokeChannelToken?.(session.channelToken)
    revokeGatewayLaunchToken(session.channelToken)
    session.channelToken = undefined
  }
  const lease = session.hostLease
  if (!lease) return
  session.hostLease = undefined
  hostRegistry().get(session.hostId).releaseSession(lease)
}

// A launch's files on another machine (WSL: the startup script and the
// host-context file inside the distribution), removed there. The local
// cleanups beside each call leave such paths alone.
function discardHostLaunchFiles(session: TerminalSession): void {
  if (session.pathStyle !== 'wsl') return
  hostRegistry()
    .get(session.hostId)
    .discardLaunchFiles?.([session.startupScriptPath, session.hostContextPath, session.launchPromptPath])
}

async function waitForTerminalExit(session: TerminalSession, timeoutMs: number): Promise<boolean> {
  // A suspended session's pty has already exited (we killed it); its `onExit`
  // already fired, so waiting for another would block the full timeout on
  // shutdown. Treat it as already-exited.
  if (session.hasExited || session.isDisposed || session.suspended) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      disposable.dispose()
      resolve(false)
    }, timeoutMs)
    const disposable = session.process.onExit(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

// Cadence of the idle-agent reap sweep. Kept well under the idle-suspend
// threshold (default 15m) so a freshly-dormant agent is suspended soon after it
// crosses the threshold rather than up to a sweep-interval later.
export const STALE_TERMINAL_SWEEP_INTERVAL_MS = 3 * 60 * 1000

// User-configurable idle-suspend threshold (ms), set from the renderer's
// "Pause idle terminals after" setting. Defaults to the policy default until the
// renderer syncs its persisted value on startup.
let configuredSuspendIdleAfterMs = DEFAULT_SUSPEND_IDLE_AFTER_MS

export function setIdleSuspendThresholdMs(value: unknown): void {
  configuredSuspendIdleAfterMs = clampSuspendIdleAfterMs(value)
}

// User-configurable recency floor ("Always keep running"), set from the
// renderer's setting. The idle sweep never suspends/disposes below this many
// live agent terminals — the most recently used survive even once idle past
// the threshold. Defaults until the renderer syncs its persisted value.
let configuredKeepRecentAliveCount = DEFAULT_KEEP_RECENT_TERMINALS_ALIVE

export function setKeepRecentTerminalsAlive(value: unknown): void {
  configuredKeepRecentAliveCount = clampKeepRecentTerminalsAlive(value)
}

// Test-only seam for the spawn pre-flight. Its probe spawns real login shells
// and reads the machine's own PATH, so a unit test driving the spawn IPC must
// be able to pin the verdict (and the platform/shell the verdict is trusted on)
// without touching the pre-flight's own logic — the message, the cache reuse and
// the returned IPC shape all still come from the real code.
type AgentCliPreflightTestOverrides = {
  deps?: DetectAgentCliAvailabilityDeps
  platform?: NodeJS.Platform
  shell?: string
}

let agentCliPreflightOverrides: AgentCliPreflightTestOverrides = {}

export function __setAgentCliPreflightForTest(overrides: AgentCliPreflightTestOverrides | null): void {
  agentCliPreflightOverrides = overrides ?? {}
}

// Per-terminal user lock: while set, both reap sweeps skip this session. The
// broadcast keeps every view's lock control in sync with the session snapshot.
export function setTerminalReapExempt(sessionId: string, exempt: boolean): void {
  const session = terminals.get(sessionId)
  if (!session || session.isDisposed) return
  const next = exempt === true
  if ((session.reapExempt === true) === next) return
  session.reapExempt = next
  logMainPerfEvent('TerminalRuntime', 'terminal-reap-exempt-changed', {
    sessionId,
    workspaceId: session.workspaceId,
    agentId: session.agentId,
    kind: session.kind,
    reapExempt: next,
  })
  broadcastTerminalSessionsChanged(session)
}

let staleTerminalSweepTimer: ReturnType<typeof setInterval> | undefined
let isAppFocused: TerminalRuntimeOptions['isAppFocused']

// While no app window is focused the reap sweep runs one tick in this many.
// Its guard reads `ps` and a machine-wide `lsof` whenever anything is up for
// reaping, which on a laptop nobody is looking at is charge spent every three
// minutes; an idle agent suspended a few minutes later is not something anyone
// is there to see. Focus coming back does not wait: the next tick runs.
export const UNFOCUSED_REAP_SWEEP_EVERY = 3

/** Whether this tick of the sweep runs, and the unfocused ticks skipped since one last did. */
export function reapSweepTick(focused: boolean, skipped: number): { run: boolean; skipped: number } {
  if (focused || skipped + 1 >= UNFOCUSED_REAP_SWEEP_EVERY) return { run: true, skipped: 0 }
  return { run: false, skipped: skipped + 1 }
}

function startStaleTerminalSweep(): void {
  if (staleTerminalSweepTimer) clearInterval(staleTerminalSweepTimer)
  let skipped = 0
  staleTerminalSweepTimer = setInterval(() => {
    const tick = reapSweepTick(isAppFocused?.() ?? true, skipped)
    skipped = tick.skipped
    // 24h coarse backstop (catches anything ancient), then the recency policy
    // sweep that suspends idle agent terminals (hook-state-driven) within a
    // session. Guarded: sessions whose pty subtree holds live work (background
    // shells, dev servers, busy builds) or whose agent has a pending
    // self-scheduled wakeup are held — killing the CLI would abort that work.
    if (tick.run) void runGuardedTerminalReapSweeps().catch(() => undefined)
    // Reclaim snapshot sidecars past their TTL (painted history nobody
    // reopened). Piggybacked here rather than owning another timer.
    snapshotSidecars?.sweepExpired()
  }, STALE_TERMINAL_SWEEP_INTERVAL_MS)
  staleTerminalSweepTimer.unref?.()
}

function stopStaleTerminalSweep(): void {
  if (!staleTerminalSweepTimer) return
  clearInterval(staleTerminalSweepTimer)
  staleTerminalSweepTimer = undefined
}

// Reap terminals nobody has looked at for the stale window: not on screen, no
// user input, and no process output (see `getTerminalUnseenSince`). Disposing
// through `disposeTerminal` deliberately skips the renderer `terminal:exit`
// event, so agent launch flags stay intact and reopening the workspace
// re-launches the CLI with resume.
// `guardHolds` (sessionId → hold reason, built by the guarded sweep) names
// sessions that must NOT be reaped this pass because killing the CLI would
// abort live work under it; absent (legacy/test callers) means unguarded.
export function reapStaleTerminals(
  now = Date.now(),
  guardHolds?: ReadonlyMap<string, string>,
  probedSessionIds?: ReadonlySet<string>,
): string[] {
  const staleSessionIds = [...terminals.values()]
    .filter((session) => isTerminalSessionStale(session, now))
    // The user lock is absolute: a locked terminal survives even the coarse
    // 24h backstop — "do not reap" means dispose too, not just suspend.
    .filter((session) => session.reapExempt !== true)
    // Guarded sweep: only act on sessions that went through the live-work
    // probe. A session that became eligible during the probe await (e.g. its
    // lock was released) was never probed; defer it to the next sweep.
    .filter((session) => !probedSessionIds || probedSessionIds.has(session.sessionId))
    .filter((session) => !recordGuardHoldSkip(session.sessionId, guardHolds, now, 'stale backstop'))
    .map((session) => session.sessionId)

  for (const sessionId of staleSessionIds) {
    const session = terminals.get(sessionId)
    if (!session) continue
    const unseenMs = now - getTerminalUnseenSince(session)
    logMainPerfEvent('TerminalRuntime', 'terminal-stale-reaped', {
      sessionId,
      kind: session.kind,
      workspaceId: session.workspaceId,
      agentId: session.agentId,
      terminalId: session.terminalId,
      cli: session.cli,
      processAlive: isTerminalProcessAlive(session),
      lastSeenAt: getTerminalUnseenSince(session),
      unseenMs,
    })
    recordReapEvent({
      reapedAt: now,
      reason: 'stale-dispose',
      sessionId,
      workspaceId: session.workspaceId ?? null,
      agentId: session.agentId ?? null,
      terminalId: session.terminalId ?? null,
      cli: session.cli ?? null,
      kind: session.kind,
      unseenMs,
    })
    logReapDiagnostic?.({
      level: 'info',
      title: 'Terminal reaper',
      message: 'Stale backstop disposed a terminal',
      details: [
        `Unseen for ${Math.round(unseenMs / 3_600_000)}h`,
        `Kind: ${session.kind}; CLI: ${session.cli ?? 'unknown'}`,
      ].join('\n'),
      ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
      ...(session.agentId ? { agentId: session.agentId } : {}),
      sessionId,
    })
    disposeTerminal(sessionId)
  }
  return staleSessionIds
}

// In-session reaper: suspend idle agent terminals that have fallen out of the
// recency hot set — or that have sat idle past the absolute ceiling even while
// nominally "hot" (so a session left untouched for days after the user walks
// away is still reclaimed) — so a long session doesn't accumulate dozens of idle
// agents holding GBs. Driven ONLY by repaint-immune signals — real user input
// (lastInputAt), visibility, and run-state — so revealing a workspace (which
// makes its TUIs repaint) can't reset the idle clock or look like activity. The
// decision lives in the pure policy (terminal-reap-policy); this maps live
// sessions to candidates and SUSPENDS what it clears via `suspendTerminal`
// (freeze-the-view): the pty is killed to reclaim its RAM but the session and
// its painted scrollback are retained with `suspended = true`. Reopening the
// workspace then replays the frozen history and resumes the agent (`--resume`
// where the cli supports it) only on the first keystroke, pane click, or the paused footer —
// it never auto-respawns. Disposing instead (the old behavior) dropped the
// session and scrollback, so reopen fell through to the renderer's resume-spawn
// and the agent silently relaunched. The 24h `reapStaleTerminals` backstop still
// disposes, reclaiming the retained buffer once the history is no longer worth
// keeping.
// Rate limit for persisted "parked past threshold by gate X" skip entries: one
// per session per hour, re-logged sooner only when the holding gate CHANGES.
// Bounds volume (a working agent on a long autonomous run legitimately parks
// past the keystroke threshold for hours) while keeping the forensic trail the
// 2026-07-07 incident lacked. Entries for sessions that left the terminals map
// are pruned each sweep.
const REAP_SKIP_LOG_INTERVAL_MS = 60 * 60 * 1000
const reapSkipLogState = new Map<string, { hold: string; loggedAt: number }>()

// True when `guardHolds` names this session, meaning the caller must skip it
// this pass. Logs the skip (rate-limited like the gate audit above) so a
// session parked by live work leaves the forensic trail the 2026-07-07
// incident lacked.
function recordGuardHoldSkip(
  sessionId: string,
  guardHolds: ReadonlyMap<string, string> | undefined,
  now: number,
  sweep: string,
): boolean {
  const hold = guardHolds?.get(sessionId)
  if (hold === undefined) return false
  const previous = reapSkipLogState.get(sessionId)
  if (!previous || previous.hold !== hold || now - previous.loggedAt >= REAP_SKIP_LOG_INTERVAL_MS) {
    reapSkipLogState.set(sessionId, { hold, loggedAt: now })
    const session = terminals.get(sessionId)
    logMainPerfEvent('TerminalRuntime', 'terminal-reap-held', {
      sessionId,
      hold,
      sweep,
      cli: session?.cli ?? null,
      workspaceId: session?.workspaceId ?? null,
    })
    logReapDiagnostic?.({
      level: 'info',
      title: 'Terminal reaper',
      message: `Reap held: ${hold}`,
      details: [
        `Sweep: ${sweep}`,
        `CLI: ${session?.cli ?? 'unknown'}`,
        'Killing the CLI would abort live work under it; re-evaluated next sweep.',
      ].join('\n'),
      ...(session?.workspaceId ? { workspaceId: session.workspaceId } : {}),
      ...(session?.agentId ? { agentId: session.agentId } : {}),
      sessionId,
    })
  }
  return true
}

function terminalLastInteractionAt(session: TerminalSession): number {
  return Math.max(session.startedAt, session.lastInputAt ?? 0)
}

// Maps live sessions to pure reap-policy candidates. Shared by the sync sweep
// and the guarded wrapper (which needs the would-reap set BEFORE probing).
function buildReapCandidates(): ReapCandidate[] {
  return [...terminals.values()].map((session) => ({
    sessionId: session.sessionId,
    workspaceId: session.workspaceId ?? null,
    kind: session.kind,
    cli: session.cli ?? null,
    processAlive: isTerminalProcessAlive(session),
    // The session's lifecycle/hook phase. An agent carries one from birth (the
    // spawn stamp `starting`, held as working until the first frame or the
    // stall watchdog); output timing never guesses a phase, so an alt-screen
    // repaint can no longer masquerade as work. Null only for non-agent
    // sessions, where the keystroke-recency floor decides. At-rest phases —
    // 'idle', and 'stalled' after its own full rest threshold — are reapable;
    // working/awaiting_input are protected.
    agentPhase: session.agentState?.phase ?? null,
    lastInteractionAt: terminalLastInteractionAt(session),
    // When the agent went to rest — keeps a just-finished (or just-stalled)
    // agent alive until it has actually rested past the threshold.
    idleSince: isAtRestAgentPhase(session.agentState?.phase) ? (session.agentState?.since ?? null) : null,
    reapExempt: session.reapExempt === true,
    // Hook-reported self-scheduled wakeup (see ingestAgentStateFrame): a future
    // wake time holds the session in the pure policy.
    pendingWakeupAt: session.pendingWakeupAt ?? null,
  }))
}

export function runIdleAgentReapSweep(
  now = Date.now(),
  guardHolds?: ReadonlyMap<string, string>,
  probedSessionIds?: ReadonlySet<string>,
): string[] {
  const candidates = buildReapCandidates()
  const decision = selectReapableSessions(candidates, {
    now,
    idleThresholdMs: configuredSuspendIdleAfterMs,
    keepRecentAliveCount: configuredKeepRecentAliveCount,
  })

  // Skip audit: persist which gate is holding an agent that has otherwise
  // rested past the threshold ("would have been reaped but for X"). Routine
  // "not idle long enough yet" skips are noise and never logged. Rate-limited
  // per session (see REAP_SKIP_LOG_INTERVAL_MS); state pruned for sessions
  // that left the map so it cannot grow unbounded.
  for (const staleKey of reapSkipLogState.keys()) {
    if (!terminals.has(staleKey)) reapSkipLogState.delete(staleKey)
  }
  if (logReapDiagnostic) {
    for (const candidate of candidates) {
      if (candidate.kind !== 'agent') continue
      const explanation = explainSessionReapDecision(candidate, {
        now,
        idleThresholdMs: configuredSuspendIdleAfterMs,
      })
      if (explanation.verdict !== 'held') continue
      if (explanation.hold === 'resting_recently' || explanation.hold === 'dead_process') continue
      if (explanation.restingForMs <= configuredSuspendIdleAfterMs) continue
      const previous = reapSkipLogState.get(candidate.sessionId)
      if (previous && previous.hold === explanation.hold && now - previous.loggedAt < REAP_SKIP_LOG_INTERVAL_MS) {
        continue
      }
      reapSkipLogState.set(candidate.sessionId, { hold: explanation.hold, loggedAt: now })
      logReapDiagnostic({
        level: 'info',
        title: 'Terminal reaper',
        message: `Idle sweep kept a rested agent: ${explanation.hold}`,
        details: [
          `Resting for ${Math.round(explanation.restingForMs / 60_000)}m (threshold ${Math.round(configuredSuspendIdleAfterMs / 60_000)}m)`,
          `Phase: ${candidate.agentPhase ?? 'none (not an agent)'}`,
          `CLI: ${candidate.cli ?? 'unknown'}`,
        ].join('\n'),
        ...(candidate.workspaceId ? { workspaceId: candidate.workspaceId } : {}),
        sessionId: candidate.sessionId,
      })
    }
  }

  // Recency-floor audit: these passed every per-session gate but sit inside the
  // "always keep running" count. Same rate limit as the gate audit above.
  if (logReapDiagnostic) {
    for (const sessionId of decision.heldByRecencyFloorSessionIds) {
      const session = terminals.get(sessionId)
      if (!session) continue
      const previous = reapSkipLogState.get(sessionId)
      if (previous && previous.hold === 'recency_floor' && now - previous.loggedAt < REAP_SKIP_LOG_INTERVAL_MS) {
        continue
      }
      reapSkipLogState.set(sessionId, { hold: 'recency_floor', loggedAt: now })
      logReapDiagnostic({
        level: 'info',
        title: 'Terminal reaper',
        message: 'Idle sweep kept a rested agent: recency_floor',
        details: [
          `Among the ${configuredKeepRecentAliveCount} most recently used live agents`,
          `CLI: ${session.cli ?? 'unknown'}`,
        ].join('\n'),
        ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
        sessionId,
      })
    }
  }

  // Guard holds (live subtree work / pending wakeup) trump the pure decision:
  // killing the CLI would abort real work, so the session waits for a sweep
  // where the work has finished. On the guarded path, additionally act ONLY on
  // sessions the probe actually covered: the decision is recomputed after the
  // probe await, and state changes during it (a keystroke, a phase frame, a
  // released lock) can promote a previously floor-held or ineligible session
  // into the reap slice — reaping it un-probed is exactly the live-work kill
  // the guard exists to prevent. Deferred sessions are re-selected and probed
  // on the next 3-minute sweep.
  const actionableSessionIds = decision.reapableSessionIds
    .filter((sessionId) => !probedSessionIds || probedSessionIds.has(sessionId))
    .filter((sessionId) => !recordGuardHoldSkip(sessionId, guardHolds, now, 'idle sweep'))

  for (const sessionId of actionableSessionIds) {
    const session = terminals.get(sessionId)
    if (!session || session.isDisposed) continue
    const idleMs = now - terminalLastInteractionAt(session)
    logMainPerfEvent('TerminalRuntime', 'terminal-idle-reaped', {
      sessionId,
      kind: session.kind,
      workspaceId: session.workspaceId,
      agentId: session.agentId,
      cli: session.cli,
      lastInteractionAt: terminalLastInteractionAt(session),
      agentPhase: session.agentState?.phase ?? null,
      idleMs,
      action: 'suspend',
    })
    recordReapEvent({
      reapedAt: now,
      reason: 'idle-suspend',
      sessionId,
      workspaceId: session.workspaceId ?? null,
      agentId: session.agentId ?? null,
      terminalId: session.terminalId ?? null,
      cli: session.cli ?? null,
      kind: session.kind,
      idleMs,
    })
    logReapDiagnostic?.({
      level: 'info',
      title: 'Terminal reaper',
      message: 'Idle sweep suspended an agent',
      details: [
        `Idle for ${Math.round(idleMs / 60_000)}m (threshold ${Math.round(configuredSuspendIdleAfterMs / 60_000)}m)`,
        `Phase: ${session.agentState?.phase ?? 'none (not an agent)'}`,
        `CLI: ${session.cli ?? 'unknown'}`,
      ].join('\n'),
      ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
      ...(session.agentId ? { agentId: session.agentId } : {}),
      sessionId,
    })
    suspendTerminal(sessionId)
  }
  return actionableSessionIds
}

// One guarded pass of both reap sweeps — the production path (the 3-minute
// interval). The pure sweeps above stay synchronous and unguarded for direct
// callers/tests; here, every session a sweep WOULD act on is first probed for
// live work the phase gates cannot see: a `run_in_background` shell idling
// toward a result, a dev server holding a port, a busy build. The agent's hook
// phase is 'idle' while these run (its turn ended), but killing the CLI kills
// them and the resumed session reports "No completion record was found…".
// (Self-scheduled wakeups need no probe: they arrive as hook frames and hold
// inside the pure policy — see ReapCandidate.pendingWakeupAt.)
// Held sessions are skipped this pass and re-evaluated next sweep, so they
// reap normally once the work completes. Fail-safe: an undetermined subtree
// probe (ps/lsof failure) holds the session rather than risking live work.
export async function runGuardedTerminalReapSweeps(
  now = Date.now(),
  deps: { subtree?: SubtreeProbeDeps } = {},
): Promise<{ staleReaped: string[]; idleReaped: string[] }> {
  const staleTargets = [...terminals.values()]
    .filter((session) => isTerminalSessionStale(session, now) && session.reapExempt !== true)
    .map((session) => session.sessionId)
  const idleDecision = selectReapableSessions(buildReapCandidates(), {
    now,
    idleThresholdMs: configuredSuspendIdleAfterMs,
    keepRecentAliveCount: configuredKeepRecentAliveCount,
  })
  const targets = new Set([...staleTargets, ...idleDecision.reapableSessionIds])
  const guardHolds = await buildReapGuardHolds(targets, deps)
  // Pass the probed target set: the sweeps recompute their decisions after the
  // await above, and any session that entered the reap set during it must be
  // deferred to the next sweep (it was never probed for live subtree work).
  return {
    staleReaped: reapStaleTerminals(now, guardHolds, targets),
    idleReaped: runIdleAgentReapSweep(now, guardHolds, targets),
  }
}

// Probes the would-reap set and names every session that must be held. Only a
// LIVE pty can hold live work: suspended placeholders and exited sessions have
// nothing left to kill. (The stale backstop leaves settled agents alone for
// its own reason, and still reclaims exited plain shells.)
async function buildReapGuardHolds(
  targetSessionIds: ReadonlySet<string>,
  deps: { subtree?: SubtreeProbeDeps },
): Promise<Map<string, string>> {
  const holds = new Map<string, string>()
  // Grouped by machine, one read per machine: `ps` on macOS and Linux, CIM for
  // native Windows, and the helper's /proc read for each WSL distribution,
  // whose pty pid is only `wsl.exe` (the helper finds the session shell from
  // the pid file its startup script wrote).
  const byHost = new Map<string, HostProcessRef[]>()
  const probed: string[] = []
  for (const sessionId of targetSessionIds) {
    const session = terminals.get(sessionId)
    if (!session || session.isDisposed || !isTerminalProcessAlive(session)) continue
    const pid = session.process.pid
    if (typeof pid !== 'number' || pid <= 0) continue
    const hostId = hostRegistry().get(session.hostId).id
    const refs = byHost.get(hostId) ?? []
    refs.push({ sessionId, rootPid: pid, startupScriptPath: session.startupScriptPath })
    byHost.set(hostId, refs)
    probed.push(sessionId)
  }
  const verdicts = new Map<string, SubtreeLiveReason | null>()
  await Promise.all(
    [...byHost].map(async ([hostId, refs]) => {
      const answer = await hostRegistry()
        .get(hostId)
        .probeSubtrees(refs, deps.subtree)
        .catch(() => new Map<string, SubtreeLiveReason | null>())
      for (const [sessionId, reason] of answer) verdicts.set(sessionId, reason)
    }),
  )
  for (const sessionId of probed) {
    const reason = verdicts.get(sessionId)
    if (reason === undefined) holds.set(sessionId, 'subtree_undetermined')
    else if (reason !== null) holds.set(sessionId, `live_subtree_${reason}`)
  }
  return holds
}

// Live terminal sessions reduced to what per-workspace memory attribution needs:
// the pty root pid (for subtree RSS walking) plus the metadata the diagnostics
// panel shows. The session snapshot deliberately omits pids, so this main-only
// accessor exposes them to the workspace-memory sampler.
export function listTerminalRoots(): TerminalRootInfo[] {
  return (
    [...terminals.values()]
      // A placeholder rehydrated from a snapshot sidecar has an inert process
      // with no pid — there is no subtree to attribute, so it has no root entry.
      .filter((session) => !session.isDisposed && typeof session.process.pid === 'number')
      .map((session) => ({
        sessionId: session.sessionId,
        rootPid: session.process.pid,
        workspaceId: session.workspaceId ?? null,
        agentId: session.agentId ?? null,
        terminalId: session.terminalId ?? null,
        kind: session.kind,
        cli: session.cli ?? null,
        activityKind: session.activity.kind,
        processAlive: isTerminalProcessAlive(session),
        startedAt: session.startedAt,
      }))
  )
}

async function shutdownTerminalRuntime(): Promise<void> {
  stopStaleTerminalSweep()
  await disposeAllTerminals()
  // A prompt that arrived just before quit is still being written.
  await agentPrompts?.flush()
}

async function disposeAllTerminals(): Promise<void> {
  const sessions = [...terminals.values()].filter((session) => !session.isDisposed)
  for (const session of sessions) {
    session.deferredPrompt?.cancel()
    cleanupTerminalStartupScript(session.startupScriptPath)
    cleanupHostContextFile(session.hostContextPath)
    cleanupHostContextFile(session.launchPromptPath)
    terminalOutput.flush(session.sessionId, 'dispose')
    terminalDiagnostics.clear(session.sessionId)
    clearTerminalIdleTimer(session)
    clearAgentStallTimer(session)
    // Durable freeze-the-view, quit path: persist each agent terminal's painted
    // content before its process dies, so reopening the workspace after relaunch
    // shows it painted-and-paused instead of black. A suspended session's
    // already-built snapshot is preferred; live sessions get the cheap raw byte
    // dump (no headless render on the quit path) and rehydration renders it.
    writeTerminalSnapshotSidecar(session, {
      snapshot: session.replaySnapshot,
      rawReplay: session.replaySnapshot ? undefined : materializeTerminalReplay(session),
      cols: session.appliedCols ?? 80,
      rows: session.appliedRows ?? 24,
    })
    try {
      session.process.kill()
    } catch {
      // ignore kill errors if process died first
    }
    // Each session's stretch above is synchronous: the replay materialized
    // from its whole history, and on Windows a ConPTY close that blocks until
    // the console host lets go. Back to the event loop between sessions, so a
    // quit with many terminals never holds the main thread for the five
    // seconds after which Windows calls the app's windows "not responding",
    // and the update progress window keeps painting.
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  // The sidecars are queued writes now, not synchronous ones; the quit path
  // is the one place they must have landed before the process goes.
  await snapshotSidecars?.flush()
  const settled = await Promise.all(sessions.map((session) => waitForTerminalExit(session, 1_500)))
  sessions.forEach((session, index) => {
    if (!settled[index] && !session.hasExited && !session.isDisposed) {
      try {
        session.process.kill('SIGKILL')
      } catch {
        // node-pty kill is best-effort during app shutdown.
      }
    }
  })
  await Promise.all(sessions.map((session) => waitForTerminalExit(session, 500)))
  // A WSL terminal's pty is the Windows `wsl.exe`; ending it does not reach
  // the Linux processes under it, so each machine's helper ends what its
  // sessions left running (by pid file and `--session-id`), with no grace:
  // the ptys were just waited on. A suspended session's were ended when it
  // was suspended. Bounded, so a wedged helper cannot hold the quit; the
  // helper's own shutdown, which follows, ends every session it knows of too.
  const survivorKills = sessions.flatMap((session) => {
    const host = hostRegistry().get(session.hostId)
    if (host.kind !== 'wsl' || session.suspended) return []
    return [
      host
        .killSessionSurvivors(session.cliSessionId ?? '', {
          startupScriptPath: session.startupScriptPath,
          quitting: true,
        })
        .catch(() => []),
    ]
  })
  if (survivorKills.length > 0) {
    let quitTimer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled(survivorKills),
      new Promise<void>((resolve) => {
        quitTimer = setTimeout(resolve, 5_000)
        quitTimer.unref?.()
      }),
    ])
    if (quitTimer) clearTimeout(quitTimer)
  }
  await Promise.allSettled([...pendingAgentListenerRecords])

  for (const session of sessions) {
    if (terminals.get(session.sessionId) === session) {
      session.isDisposed = true
      setTerminalActivity(
        session,
        { kind: 'exited', at: Date.now(), exitCode: session.exitCode ?? 0 },
        { broadcast: false },
      )
      terminals.delete(session.sessionId)
      terminalOutput.forgetSession(session.sessionId)
      releaseSettledTerminalSession(session)
      removedSessionIds.add(session.sessionId)
    }
  }
  broadcastTerminalSessionsChanged(null)
}

function getLiveAgentExecutionIds(): LiveAgentExecution[] {
  return [...terminals.values()]
    .filter((session) => isTerminalProcessAlive(session) && Boolean(session.agentSession?.executionId))
    .map((session) => ({
      system: session.agentSession!.system,
      executionId: session.agentSession!.executionId,
    }))
}

// Resolve the executionId of the live agent session matching a (workspaceId,
// agentId) pair. Used at automation launch-confirm time to record the run's
// correlation key. Returns undefined when no live session matches — the caller
// must treat a miss as best-effort and not fail the launch.
function resolveAgentExecutionId(input: { workspaceId: string; agentId: string }): string | undefined {
  for (const session of terminals.values()) {
    if (
      isTerminalProcessAlive(session) &&
      session.agentId === input.agentId &&
      session.agentSession?.workspaceId === input.workspaceId &&
      session.agentSession.executionId
    ) {
      return session.agentSession.executionId
    }
  }
  return undefined
}

function registerAgentSessionExitListener(listener: AgentSessionExitListener): () => void {
  agentSessionExitListeners.add(listener)
  return () => {
    agentSessionExitListeners.delete(listener)
  }
}

function registerAgentPhaseListener(listener: AgentPhaseListener): () => void {
  agentPhaseListeners.add(listener)
  return () => {
    agentPhaseListeners.delete(listener)
  }
}

function disposeOtherAgentSessions(
  sessionId: string,
  workspaceId: string | undefined,
  agentId: string | undefined,
): void {
  if (!workspaceId || !agentId) return

  const duplicateSessionIds = [...terminals.values()]
    .filter(
      (session) =>
        session.sessionId !== sessionId &&
        isTerminalProcessAlive(session) &&
        session.kind === 'agent' &&
        session.workspaceId === workspaceId &&
        session.agentId === agentId,
    )
    .map((session) => session.sessionId)

  duplicateSessionIds.forEach(disposeTerminal)
}

function scheduleTerminalIdleTransition(session: TerminalSession): void {
  clearTerminalIdleTimer(session)
  if (!isTerminalProcessAlive(session)) return
  // Agents carry no output idle-timer at all: their activity is bridged from
  // hook-reported phases in ingestAgentStateFrame (Stop reports the real idle;
  // the stall watchdog catches a genuine hang). The timer is plain-terminal
  // working/idle bolding only — output-timing status inference for agents was
  // deleted (decision of record 2026-08-31).
  if (session.kind === 'agent') return

  session.idleDeadline = Date.now() + getTerminalIdleTimeoutMs(session)
  armTerminalIdleTimer(session, getTerminalIdleTimeoutMs(session))
}

/**
 * Push a plain terminal's idle deadline out on output, WITHOUT touching the
 * timer. Output used to clear and re-arm it for every chunk; now the deadline
 * moves and a timer that fires early simply re-arms for what is left.
 */
function extendTerminalIdleDeadline(session: TerminalSession): void {
  if (session.kind === 'agent') return
  if (!session.idleTimer) {
    scheduleTerminalIdleTransition(session)
    return
  }
  session.idleDeadline = Date.now() + getTerminalIdleTimeoutMs(session)
}

function armTerminalIdleTimer(session: TerminalSession, delayMs: number): void {
  session.idleTimer = setTimeout(() => {
    session.idleTimer = undefined
    if (!isTerminalProcessAlive(session)) return
    const remaining = (session.idleDeadline ?? 0) - Date.now()
    if (remaining > 0) {
      armTerminalIdleTimer(session, remaining)
      return
    }
    setTerminalActivity(session, { kind: 'idle', since: Date.now() })
  }, delayMs)
}

function setTerminalActivity(
  session: TerminalSession,
  nextActivity: SessionActivity,
  options: { broadcast?: boolean } = {},
): boolean {
  const previousActivity = session.activity
  const changed = transitionTerminalActivity(session, nextActivity)
  if (!changed) return false

  terminalDiagnostics.recordActivityTransition(session, previousActivity, session.activity)
  if (options.broadcast !== false && terminals.get(session.sessionId) === session) {
    broadcastTerminalSessionsChanged(session)
  }
  return true
}

// Disposed sessions are excluded here; the alive check happens in the caller so
// a late frame for a process that has exited is dropped. Matching + workspace
// disambiguation + most-recent tie-break live in the pure `selectAgentStateTarget`.
function resolveSessionForAgentStateFrame(frame: AgentStateFrame): TerminalSession | undefined {
  const candidates = [...terminals.values()]
    .filter((session) => !session.isDisposed && session.kind === 'agent')
    .map((session) => ({
      value: session,
      agentId: session.agentId,
      executionId: session.agentSession?.executionId,
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      launchWorkspaceId: session.launchWorkspaceId,
      alive: isTerminalProcessAlive(session),
      startedAt: session.startedAt,
    }))
  return selectAgentStateTarget(candidates, frame)
}

// A hook-reported working agent (starting/thinking/tool_use) silent for this
// long — no follow-up frame and no terminal output — is flagged as (inferred)
// stalled. Conservative: long but silent legitimate tools (a quiet build) are
// rare, and the flag is a soft, inference-sourced hint, not an authoritative
// state. Stalled is also the reaper's expiry path for sessions whose final
// frame was lost: it rides the full idle threshold again before reclaim.
const AGENT_STALL_THRESHOLD_MS = 90_000

function scheduleAgentStallCheck(session: TerminalSession): void {
  clearAgentStallTimer(session)
  if (!isTerminalProcessAlive(session)) return
  const state = session.agentState
  if (!state) return
  // Arm for a hook-driven working phase — idle/awaiting/terminal phases are
  // not "stuck mid-work" — and for `starting` regardless of source:
  //   * hook 'starting': a resumed session that never receives a prompt has
  //     SessionStart as its ONLY frame (no Stop ever follows);
  //   * the 'starting' lifecycle stamp every agent spawns with — a session
  //     whose hooks never fire at all (broken install) has no other path off
  //     "working".
  // Without conversion to 'stalled' either would read as working — and be
  // protected from the idle reaper — forever.
  if (state.phase !== 'starting' && state.phase !== 'thinking' && state.phase !== 'tool_use') return
  if (state.source !== 'hook' && state.phase !== 'starting') return
  session.agentStallTimer = setTimeout(() => runAgentStallCheck(session), AGENT_STALL_THRESHOLD_MS)
}

function runAgentStallCheck(session: TerminalSession): void {
  session.agentStallTimer = undefined
  if (!isTerminalProcessAlive(session) || !session.agentState) return
  const decision = evaluateAgentStall({
    phase: session.agentState.phase,
    source: session.agentState.source,
    phaseSince: session.agentState.since,
    lastOutputAt: session.lastOutputAt,
    now: Date.now(),
    thresholdMs: AGENT_STALL_THRESHOLD_MS,
  })
  if (decision.action === 'recheck') {
    // Output advanced since arming (a streaming tool): keep watching.
    session.agentStallTimer = setTimeout(() => runAgentStallCheck(session), decision.afterMs)
    return
  }
  if (decision.action !== 'stalled') return

  session.agentState = { phase: 'stalled', since: Date.now(), source: 'lifecycle' }
  // A live background agent keeps the parent's pane spinning, so a quiet pane
  // means nothing is outstanding: whatever the count says, it has drifted (a
  // lost SubagentStop), and left alone it would hold every future Stop.
  session.backgroundWork = 0
  // stalled bridges to idle activity; suppress its broadcast and emit once.
  const derived = deriveActivityFromPhase('stalled', session.agentState.since)
  if (derived) setTerminalActivity(session, derived, { broadcast: false })
  if (terminals.get(session.sessionId) === session) broadcastTerminalSessionsChanged(session)
}

// Observed checkout: record where the session's hooks say it IS.
// Returns true when the cwd moved; a frame older than the current observation
// cannot roll it backwards, and the same cwd again is a no-op — the `at` stays
// the moment the session ARRIVED there. The move itself is not broadcast: an
// unresolved observation renders as launch intent, so publishing it would only
// flicker a worktree tab back to "main" until git answers a few ms later. The
// resolution broadcasts.
function observeSessionCwd(session: TerminalSession, cwd: string, ts: number, options: { fresh: boolean }): boolean {
  const current = session.observedCheckout
  if (current && current.at > ts) return false
  if (current && current.cwd === cwd) return false
  session.observedCheckout = unresolvedObservedCheckout(cwd, ts)
  // A session's FIRST observation asks fresh: another session's cached
  // answer for the same directory may predate a branch switch made just
  // before this one was launched into it.
  scheduleObservedCheckoutResolution(session, { fresh: options.fresh || !current })
  return true
}

// Recent answers by cwd, so an agent whose tool calls alternate between two
// directories (a build in the worktree, a test in the main checkout) costs one
// round of git per directory per window rather than per tool call. A turn end
// or session start asks fresh — that is the moment a branch move is noticed.
const OBSERVED_CHECKOUT_CACHE_TTL_MS = 15_000
const OBSERVED_CHECKOUT_CACHE_LIMIT = 64
const observedCheckoutCache = new Map<string, { facts: ResolvedCheckoutFacts; at: number }>()

function rememberObservedCheckout(cwd: string, facts: ResolvedCheckoutFacts, now: number): void {
  observedCheckoutCache.delete(cwd)
  observedCheckoutCache.set(cwd, { facts, at: now })
  while (observedCheckoutCache.size > OBSERVED_CHECKOUT_CACHE_LIMIT) {
    const oldest = observedCheckoutCache.keys().next().value
    if (oldest === undefined) break
    observedCheckoutCache.delete(oldest)
  }
}

function recentObservedCheckout(cwd: string, now: number): ResolvedCheckoutFacts | null {
  const entry = observedCheckoutCache.get(cwd)
  if (!entry) return null
  if (now - entry.at > OBSERVED_CHECKOUT_CACHE_TTL_MS) {
    observedCheckoutCache.delete(cwd)
    return null
  }
  return entry.facts
}

// Ask git what the observed cwd is (primary checkout, linked worktree, plain
// folder) off the frame path, and publish the answer. A ticket per session
// discards a resolution that finishes after a newer cwd arrived; a resolver
// that cannot answer (null, or throws) leaves the observation unresolved so
// consumers keep launch intent rather than reading "folder" into a failure.
// Re-run on every turn end and session start as well as on a cwd change,
// because the branch can move in place (`git checkout` mid-turn).
function scheduleObservedCheckoutResolution(session: TerminalSession, options: { fresh: boolean }): void {
  const target = session.observedCheckout
  if (!target) return
  const ticket = (session.observedCheckoutSeq ?? 0) + 1
  session.observedCheckoutSeq = ticket
  const cached = options.fresh ? null : recentObservedCheckout(target.cwd, Date.now())
  void Promise.resolve()
    .then(() => cached ?? resolveObservedCheckout(target.cwd))
    .then((facts) => {
      if (session.observedCheckoutSeq !== ticket) return
      const current = session.observedCheckout
      if (!current || current.cwd !== target.cwd) return
      const live = !session.isDisposed && terminals.get(session.sessionId) === session
      if (!facts) {
        // Unanswerable: the observation stays unresolved, and that IS the
        // news — without a broadcast the renderer would keep showing the
        // checkout the session just left.
        if (live) broadcastTerminalSessionsChanged(session)
        return
      }
      if (!cached) rememberObservedCheckout(target.cwd, facts, Date.now())
      // Built from the facts, never spread over the previous answer: a stale
      // `missing` must not survive the directory coming back.
      const next: ObservedCheckout = {
        cwd: current.cwd,
        at: current.at,
        resolved: true,
        gitRoot: facts.gitRoot,
        repoRoot: facts.repoRoot,
        branch: facts.branch,
        isLinkedWorktree: facts.isLinkedWorktree,
        ...(facts.missing ? { missing: true } : {}),
      }
      if (!sameObservedCheckout(current, next)) {
        session.observedCheckout = next
        if (live) broadcastTerminalSessionsChanged(session)
      }
      // Told even when nothing moved: a turn end on the same branch is the
      // moment a pull request the turn opened can be found.
      if (live && onObservedCheckoutResolved) {
        try {
          onObservedCheckoutResolved(session, { fresh: options.fresh })
        } catch (error) {
          console.warn('[terminal-runtime] observed checkout listener failed', error)
        }
      }
    })
    .catch((error) => {
      logMainPerfEvent('TerminalRuntime', 'observed-checkout-resolve-failed', {
        sessionId: session.sessionId,
        cwd: target.cwd,
        error: error instanceof Error ? error.message : String(error),
      })
      if (!session.isDisposed && terminals.get(session.sessionId) === session) broadcastTerminalSessionsChanged(session)
    })
}

/**
 * Append a prompt to the session's bounded list (terminal-session.ts,
 * `peekPrompts`) and, for an agent, to its durable prompt store. The store is
 * written behind the session: the in-memory list answers a hover at once, and
 * the next restart reads the file.
 */
function rememberSessionPrompt(session: TerminalSession, text: string, at: number): void {
  session.peekPrompts = appendLivePeekPrompt(session.peekPrompts, text, at)
  const owner = promptOwnerFor(session)
  const store = agentPrompts
  if (!owner || !store) return
  // The first prompt a session sees after a restart must not replace the
  // agent's stored history with a list of one: the session's list, this prompt
  // included, is folded into the store once, and later prompts append behind
  // that fold.
  const first = !session.peekPromptsReinflated
  const reinflated = reinflateSessionPrompts(session)
  if (first) return
  void reinflated.then(() => store.append(owner, { text, at }))
}

/** The agent a session's prompts are stored under, or null for a session that is not one. */
function promptOwnerFor(
  session: Pick<TerminalSession, 'kind' | 'workspaceId' | 'agentId' | 'cli' | 'sessionId'>,
): { workspaceId: string; agentId: string; cli?: string; sessionId: string } | null {
  if (session.kind !== 'agent' || !session.workspaceId || !session.agentId) return null
  return {
    workspaceId: session.workspaceId,
    agentId: session.agentId,
    ...(session.cli ? { cli: session.cli } : {}),
    sessionId: session.sessionId,
  }
}

/**
 * Bring an agent session's prompt list and its agent's stored list into line,
 * once per session: what the store kept from earlier runs comes back onto the
 * session, and anything the session holds that the store lacks (a prompt that
 * arrived before this ran, or a list an older build kept only in the sidecar)
 * goes into it. Later prompts append to both as they arrive.
 */
function reinflateSessionPrompts(session: TerminalSession): Promise<void> {
  if (session.peekPromptsReinflated) return session.peekPromptsReinflated
  const owner = promptOwnerFor(session)
  const store = agentPrompts
  if (!owner || !store) {
    session.peekPromptsReinflated = Promise.resolve()
    return session.peekPromptsReinflated
  }
  session.peekPromptsReinflated = (async () => {
    const merged = await store.merge(owner, session.peekPrompts ?? [])
    // A prompt that arrived while the store was being read is on the session
    // but not in `merged`; it stays on the session here, and its own
    // `rememberSessionPrompt` appends it to the store once this settles.
    const seen = new Set(merged.map((prompt) => `${prompt.at}\0${prompt.text}`))
    let next = merged
    for (const prompt of session.peekPrompts ?? []) {
      if (seen.has(`${prompt.at}\0${prompt.text}`)) continue
      next = appendLivePeekPrompt(next, prompt.text, prompt.at)
    }
    if (next.length > 0) session.peekPrompts = next
  })().catch(() => undefined)
  return session.peekPromptsReinflated
}

/**
 * What the conversation peek needs to answer for `sessionId`, or null when
 * nothing at all is known about it: no live session, no sidecar, and no agent
 * whose stored prompts name it.
 */
async function readConversationPeekSessionState(sessionId: string): Promise<ConversationPeekSessionState | null> {
  const session = terminals.get(sessionId)
  if (session && !session.isDisposed) {
    await reinflateSessionPrompts(session)
    return { reportsMessages: cliReportsMessages(session.cli), prompts: session.peekPrompts ?? [] }
  }
  // No live session. A chat parked across an app restart may still have a
  // snapshot sidecar naming its agent and CLI; its prompts come from the
  // agent's store first and from what an older build wrote into the sidecar
  // otherwise.
  const sidecar = await snapshotSidecars?.read(sessionId)
  if (sidecar && sidecar.kind === 'agent') {
    const stored =
      sidecar.workspaceId && sidecar.agentId
        ? await agentPrompts?.read({ workspaceId: sidecar.workspaceId, agentId: sidecar.agentId })
        : null
    return {
      reportsMessages: cliReportsMessages(sidecar.cli),
      prompts: stored ?? parseSessionPrompts(sidecar.prompts) ?? [],
    }
  }
  // Nor a sidecar — killed rather than quit, or swept at 30 days. The agent's
  // store still knows which sessions were its own.
  const found = await agentPrompts?.findBySessionId(sessionId)
  if (found) return { reportsMessages: cliReportsMessages(found.cli), prompts: found.prompts }
  return null
}

/**
 * Whether this CLI reports the person's messages at all — its manifest declares
 * the hook event that carries a prompt. The peek needs it to tell "nothing said
 * yet" from "cannot say": OpenCode and Muse answer false, and only they should
 * make the card say the runtime does not report its messages.
 */
function cliReportsMessages(cli: string | undefined): boolean {
  if (!cli) return false
  const spec = getPluginById(pluginIdForCli(cli))?.manifest.agentStateSpec ?? null
  return agentStateSpecReportsPrompts(spec)
}

function ingestAgentStateFrame(frame: AgentStateFrame): void {
  const session = resolveSessionForAgentStateFrame(frame)
  if (!session) return

  // Map the raw reporter event to a phase via the resolving plugin's
  // manifest-declared agentStateSpec — the reporter forwards vocabulary, the
  // manifest owns meaning. Resolved FIRST (it is pure) because the phase, not
  // the event name, is what the session-lifecycle bookkeeping below keys on:
  // each CLI spells its events its own way ('SessionEnd' vs 'sessionEnd'), and
  // the manifest already normalizes that into the phase vocabulary.
  const resolved = resolveAgentStateEvent(agentStateSpecForSession(session), frame)

  if (!isTerminalProcessAlive(session)) return
  // Much of what a frame changes is deliberately not broadcast on its own (the
  // thinking ↔ tool_use churn below), but it is still state a window reads, and
  // it used to reach them with whichever broadcast came next, because every
  // broadcast carried every session. It still does: this session rides the
  // next one.
  markTerminalSessionChanged(session)

  // What the agent just edited, folded into the session's ledger ahead of BOTH
  // guards below. An edit is order-independent by construction — the counts are
  // summed and the timestamp is a max — so unlike a phase, it does not care
  // which of two frames arrives first, and it must not be thrown away by a
  // guard that exists to stop the PHASE rolling backward. Claude Code spawns a
  // hook process per tool call and runs edits in parallel, so a later-stamped
  // frame landing first is ordinary, and a ledger that silently undercounted
  // when it did would be worth less than no ledger.
  //
  // A subagent's edit counts too: the work is the session's, and the reporter's
  // subagent suppression is a cwd rule only.
  //
  // A DUPLICATE is dropped before either fold. The same reporter can be
  // registered twice for one session: merged by hand into
  // `.claude/settings.local.json` and declared again by the studio plugin's own
  // `hooks/hooks.json` (Claude Code 2.1.266 auto-registered our directory
  // marketplace into its user-global registry and loaded the plugin's hooks
  // itself). A launch that carries the plugin directory now writes no workspace
  // registration and takes an earlier one back out before the CLI starts, but
  // a workspace the tidy could not rewrite, a session started in the startup
  // window before the plugin copy landed, or a person who added our
  // marketplace themselves can still produce both, and they fire on every tool
  // call with byte-identical frames. Counted twice, the ledger reads 2x the
  // agent's edits; fed twice, `recordEdit` applies every insert and delete
  // twice and the changelist's span coordinates go wrong. `noteFoldedFileChange`
  // keys a small per-session ring on the CLI's own tool-call id and the path
  // (and, for the reporters that have no id, on the change's shape inside a
  // three-second window). Only the file change is guarded: the phase, cwd,
  // status line and pull request the same frame carries are idempotent on
  // re-ingest and still fold as they always did.
  const fileChange =
    frame.fileChange && noteFoldedFileChange(session, frame.fileChange, frame.toolUseId, frame.ts)
      ? frame.fileChange
      : null
  const ledgerChanged = fileChange ? recordSessionFileChange(session, fileChange, frame.ts) : false
  // The same edit, handed to the agent changelist feed. Here rather than after
  // the guards below for exactly the reason the ledger fold is: the edit already
  // happened, and a frame dropped as stale or as an unnamed event still carries
  // a true one. Only an AGENT session claims lines — a plain terminal has no
  // list to put them in — and the feed can never throw into the runtime.
  if (fileChange && session.agentId && onAgentFileEdit) {
    try {
      onAgentFileEdit({
        session,
        path: fileChange.path,
        ...(fileChange.edits ? { edits: fileChange.edits } : {}),
        ts: frame.ts,
      })
    } catch (error) {
      console.warn('[terminal-runtime] agent changelist edit feed failed', error)
    }
  }
  // A tool call that may have opened a pull request, handed on before the
  // guards below for the same reason as the edit: the call happened whatever
  // becomes of the frame's phase. Recording one is idempotent, so a second
  // registration's identical frame costs nothing.
  if (frame.toolCall && session.agentId && onAgentToolCall) {
    try {
      onAgentToolCall(session, frame.toolCall)
    } catch (error) {
      console.warn('[terminal-runtime] agent tool call feed failed', error)
    }
  }
  // How full the context window is, from the session's own status line — folded
  // in here for the same reason and in the same place as the edit above. It
  // arrives on `event: 'StatusLine'`, which is in no manifest's agentStateSpec
  // and therefore always resolves to a DROP: a status-line refresh is not a
  // lifecycle event and must move no phase. Folding it before the drop is what
  // makes the reading arrive at all.
  //
  // Only a change in the whole-percent reading or in the prompt cache counts as
  // a change worth broadcasting; the cost and line counts move on every
  // refresh and nothing renders them yet.
  //
  // The usage windows riding the same reading are the account's, not the
  // session's: they go to the usage-limit store and nowhere on the session.
  const { rateLimits, ...statusLineReading } = frame.statusLine ?? {}
  if (rateLimits) noteStatusLineRateLimits(rateLimits, frame.ts)
  const statusLineChanged = frame.statusLine ? recordSessionStatusLine(session, statusLineReading, frame.ts) : false
  // Every path out of this function that does not reach the broadcast at the
  // end still has to publish an edit or a context reading: they are rendered,
  // and this is the only place they would be.
  const publishLedgerChange = (): void => {
    if ((ledgerChanged || statusLineChanged) && terminals.get(session.sessionId) === session) {
      broadcastTerminalSessionsChanged(session)
    }
  }

  // A stale frame (older than the phase we already recorded) is ignored so
  // out-of-order socket delivery can't roll the phase backward.
  if (session.agentState && session.agentState.since > frame.ts) {
    publishLedgerChange()
    return
  }

  // Where the session is rides every frame that carries a cwd and
  // is applied BEFORE the phase drop below: an informational Notification or an
  // event the spec does not name still tells the truth about the cwd.
  // A turn end or session start that itself moves the cwd asks git fresh, as
  // the same events do for an unchanged cwd below.
  const observedChanged = frame.cwd
    ? observeSessionCwd(session, frame.cwd, frame.ts, {
        fresh: resolved.action === 'apply' && (resolved.turnEnd || resolved.phase === 'starting'),
      })
    : false

  // A frame whose event the spec does not name (or whose discriminator value
  // is not allow-listed — Claude's informational Notification types) drops
  // here: the prior phase stands, exactly as when the reporter used to filter
  // these client-side. A ledger entry it carried is still published: it is
  // rendered, and this is the only place it would be.
  if (resolved.action !== 'apply') {
    publishLedgerChange()
    return
  }

  // Background work the session still owns (agent-state.ts): a session start
  // owns nothing from its previous life; a `background` event opens or closes
  // one piece; and a turn end that arrives with work still open is held as
  // working — Claude fires Stop when it parks the model on "waiting for N
  // background agents", and re-invokes it when they finish.
  const previousBackgroundWork = session.backgroundWork ?? 0
  if (resolved.phase === 'starting') {
    session.backgroundWork = 0
    session.unmatchedBackgroundStopAt = undefined
  }
  // A start its own stop overtook in delivery is already closed; a stop that
  // closes nothing is remembered so that start is recognized when it lands.
  const background =
    resolved.background === 'start' && backgroundStartAlreadyClosed(frame.ts, session.unmatchedBackgroundStopAt)
      ? undefined
      : resolved.background
  if (background === 'stop' && (session.backgroundWork ?? 0) <= 0) {
    session.unmatchedBackgroundStopAt = Math.max(session.unmatchedBackgroundStopAt ?? frame.ts, frame.ts)
  }
  session.backgroundWork = applyBackgroundWork(session.backgroundWork ?? 0, background)
  // The count is rendered ("2 running"), so a subagent starting or stopping is
  // a broadcast-worthy change even though it moves no phase.
  const backgroundWorkChanged = session.backgroundWork !== previousBackgroundWork
  const resolution = holdTurnEndForBackgroundWork(resolved, session.backgroundWork)

  // A finished turn stays finished against a frame that is not new work: a
  // background stop that closed nothing (Claude Code's own post-turn helper)
  // or a straggler of the turn that just ended. See `keepsTurnEnd`.
  if (
    keepsTurnEnd({
      spec: agentStateSpecForSession(session),
      event: frame.event,
      resolution,
      outstandingBefore: previousBackgroundWork,
      current: session.agentState ?? null,
      lastTurnEndedAt: session.lastTurnEndedAt,
      frameTs: frame.ts,
    })
  ) {
    // Neither kind moves the background count (a stop that closed nothing
    // clamps at zero), so only a ledger change carried alongside is news.
    publishLedgerChange()
    return
  }

  const previousPhase = session.agentState?.phase
  session.agentState = { phase: resolution.phase, since: frame.ts, source: 'hook' }
  // The CLI's own hook says it is up; a first message waiting on it can go
  // once the screen is quiet.
  session.deferredPrompt?.observeHookFrame()
  // The moment the turn ended, kept apart from `activity` (owner, 2026-09-05):
  // the reaper's suspend and the quit-path sidecar both restamp activity with
  // when the PROCESS died, which is what every parked row used to show as its
  // idle time. A held turn end (subagents still running) is not an end; a
  // failed turn is still a stop, and the failure keeps its own precedence in
  // the renderer.
  if (resolution.turnEnd) session.lastTurnEndedAt = frame.ts
  // The branch can change in place between observations (a `git checkout`
  // mid-turn, a resume after work landed elsewhere): re-ask git at every turn
  // end and session start. A cwd change already scheduled its own resolution.
  if (!observedChanged && (resolution.turnEnd || resolution.phase === 'starting')) {
    scheduleObservedCheckoutResolution(session, { fresh: true })
  }

  // The person's own prompt, carried only on UserPromptSubmit. Retained on the
  // session so the terminal tab can show "what was I working on here?" and a new
  // chat can be named after its first real request. Broadcast-worthy: it is
  // rendered, unlike the thinking ↔ tool_use churn below.
  const promptChanged = Boolean(frame.prompt) && frame.prompt !== session.lastPrompt?.text
  if (frame.prompt) {
    session.lastPrompt = { text: frame.prompt, at: frame.ts }
    // The same prompt also joins the session's bounded list, which is the
    // conversation peek's only source. Appended here rather than derived from
    // `lastPrompt` later, which keeps only the newest: the card shows the whole
    // thread. The list is written to the agent's prompt store from here, so it
    // outlives the session, the app and the sidecar sweep.
    rememberSessionPrompt(session, frame.prompt, frame.ts)
  }

  // Self-scheduled wakeup bookkeeping: a schedule frame arms the reap hold, a
  // stop frame disarms it, and a session-start frame (phase `starting`, however
  // the CLI spells the event) clears — a fresh or resumed CLI process carries
  // no timer from its previous life, so a stale hold would park the session
  // for nothing. Expiry needs no handling here: the policy compares
  // pendingWakeupAt against `now`.
  if (resolution.phase === 'starting') session.pendingWakeupAt = null
  if (frame.wakeup) {
    session.pendingWakeupAt = 'stop' in frame.wakeup ? null : frame.ts + frame.wakeup.delaySeconds * 1000
  }

  // Capture the agent's own session id within its CLI/harness (Claude's equals
  // our terminal id since we mint and pass it; Codex/others mint their own and
  // we only learn it here). This is the id used to resume the conversation, so
  // persist it the first time the hook reports one. The frame is already routed
  // to the right session by the per-terminal agent identity env, so concurrent
  // spawns can't cross-assign it.
  const cliSessionIdChanged = !!frame.sessionId && frame.sessionId !== session.cliSessionId
  if (cliSessionIdChanged) session.cliSessionId = frame.sessionId ?? session.cliSessionId

  // Bridge to the legacy activity field so existing consumers (sidebar bolding,
  // reaping, diagnostics) reflect the authoritative phase. Suppress its own
  // broadcast; we decide below whether a broadcast is warranted.
  //
  // Within-"working" churn (thinking ↔ tool_use) must NOT re-broadcast: keep the
  // existing working `since` so the bridged activity compares equal and only a
  // genuine working↔idle flip (or the awaiting_input boundary below) triggers a
  // snapshot IPC. Without this every frame bumps `since`, so the activity always
  // reads "changed" and broadcasts per frame — a storm — and the displayed
  // "working since" never accumulates. Mirrors the output path, which likewise
  // never bumps `since` while already working.
  const derived = deriveActivityFromPhase(resolution.phase, frame.ts)
  const bridged =
    derived && derived.kind === 'working' && session.activity.kind === 'working'
      ? { kind: 'working' as const, since: session.activity.since }
      : derived
  const activityChanged = bridged ? setTerminalActivity(session, bridged, { broadcast: false }) : false

  // Arm/refresh/clear the stall watch for the new phase: a fresh working frame
  // resets the clock; a non-working phase disarms it.
  scheduleAgentStallCheck(session)

  // Only broadcast when something a consumer actually renders changed: the
  // bridged activity flipped (working ↔ idle), or the attention state crossed
  // the awaiting_input boundary. The frequent thinking ↔ tool_use churn within
  // "working" updates `agentState` in place but does not re-broadcast — matching
  // the renderer's dedupe signature and avoiding a snapshot IPC per tool call.
  //
  // The file ledger and the subagent count are the exceptions that DO ride
  // every frame that moves them: unlike the phase churn, they change at most
  // once per edit or per subagent, and each carries a number a person is
  // reading. The 16ms coalescing above (TERMINAL_SESSIONS_BROADCAST_COALESCE_MS)
  // folds a burst of them into one send.
  const attentionChanged = (previousPhase === 'awaiting_input') !== (resolution.phase === 'awaiting_input')
  if (
    (activityChanged ||
      attentionChanged ||
      cliSessionIdChanged ||
      promptChanged ||
      ledgerChanged ||
      statusLineChanged ||
      backgroundWorkChanged) &&
    terminals.get(session.sessionId) === session
  ) {
    broadcastTerminalSessionsChanged(session)
  }

  notifyAgentPhaseListeners(session, frame, resolution, previousPhase ?? null)
}

// Publish an ACCEPTED phase transition. Called last in ingestAgentStateFrame: past
// the liveness guard (a late frame for a dead pty must never drive a consumer's
// finalization) and the stale-frame guard, past the pendingWakeupAt bookkeeping,
// and past the activity bridge — so a listener that calls back into the runtime
// reads settled session state.
//
// `pendingWakeupAt` is resolved from the SESSION, never passed through from the
// frame: the reporter attaches `wakeup` to the ScheduleWakeup PostToolUse frame
// only, never to the turn end a consumer acts on, so `frame.wakeup` would read
// "none" for every self-paced agent at exactly the moment it matters.
function notifyAgentPhaseListeners(
  session: TerminalSession,
  frame: AgentStateFrame,
  resolution: { phase: AgentPhase; turnEnd: boolean; turnFailure: boolean },
  previousPhase: AgentPhase | null,
): void {
  if (agentPhaseListeners.size === 0) return

  const phaseEvent: AgentPhaseEvent = {
    workspaceId: session.workspaceId ?? null,
    ...(session.launchWorkspaceId && session.launchWorkspaceId !== session.workspaceId
      ? { launchWorkspaceId: session.launchWorkspaceId }
      : {}),
    // A session carrying no agentId of its own was matched on the id the frame
    // carries, so that id is still its correlation handle.
    agentId: session.agentId ?? frame.agentId,
    executionId: session.agentSession?.executionId ?? null,
    phase: resolution.phase,
    previousPhase,
    event: frame.event,
    // Turn semantics resolved from the CLI's manifest event table — consumers
    // read these, never event names (several events share a phase, and only
    // the manifest knows which one is the session's turn end).
    turnEnd: resolution.turnEnd,
    turnFailure: resolution.turnFailure,
    ts: frame.ts,
    pendingWakeupAt: session.pendingWakeupAt ?? null,
    ...(frame.transcriptPath === undefined ? {} : { transcriptPath: frame.transcriptPath }),
  }

  const reportListenerFailure = (error: unknown): void => {
    console.error(`Agent phase listener failed for ${phaseEvent.agentId}: ${String(error)}`)
  }
  for (const listener of agentPhaseListeners) {
    // One faulting listener must take down neither the others nor the caller's
    // transition — and must not fail silently: a listener that throws here is a
    // consumer (run finalization) that did not run.
    try {
      trackAgentListenerRecord(Promise.resolve(listener(phaseEvent)).catch(reportListenerFailure))
    } catch (error) {
      reportListenerFailure(error)
    }
  }
}

function retainFailedTerminalSession(input: {
  sessionId: string
  sender?: WebContents
  message: string
  exitCode?: number
  kind?: TerminalSession['kind']
  pathStyle?: TerminalSession['pathStyle']
  workspaceId?: string
  agentId?: string
  agentName?: string
  terminalId?: string
  cli?: TerminalSession['cli']
  cwd?: string
  executionMode?: TerminalSession['executionMode']
  worktreeId?: string
  worktreePath?: string
  agentSession?: TerminalSession['agentSession']
  visible?: boolean
}): TerminalSession {
  const at = Date.now()
  if (terminals.has(input.sessionId)) {
    disposeTerminal(input.sessionId)
  }
  const session = createFailedTerminalSession({
    ...input,
    at,
    exitCode: input.exitCode ?? 1,
  })
  terminals.set(input.sessionId, session)
  terminalDiagnostics.recordActivityTransition(session, { kind: 'working', since: at }, session.activity)
  broadcastTerminalSessionsChanged(session)
  return session
}

function materializeAgentSessionIdentity(
  sessionId: string,
  workspaceId: string | undefined,
  agentSession: AgentSessionMetadata | undefined,
): AgentSessionIdentity | undefined {
  if (!agentSession) return undefined

  return {
    sessionId: agentSession.sessionId ?? sessionId,
    executionId: agentSession.executionId,
    system: agentSession.system,
    workspaceId: agentSession.workspaceId || workspaceId || '',
    workspaceRoot: agentSession.workspaceRoot,
    displayName: agentSession.displayName,
  }
}

/**
 * Type a first message the launch's command line did not carry into the CLI
 * once it is ready (`deferred-prompt-delivery.ts`): one paste, one Enter, once.
 * Lives on the session so its output, hook frames, exit and dispose reach it.
 * A message that could not be typed is handed back to the person
 * (`reportUndeliveredPrompt`), never only logged.
 */
function armDeferredPrompt(session: TerminalSession, text: string, personText: string | undefined): void {
  const readiness = deferredPromptReadinessFor(session.cli)
  session.deferredPrompt = createDeferredPromptDelivery({
    text,
    ...(readiness ? { readiness } : {}),
    write: (data) => {
      recordTerminalInput(session)
      session.process.write(data)
    },
    onSettled: (outcome) => {
      session.deferredPrompt = undefined
      logMainPerfEvent('TerminalRuntime', `deferred-prompt-${outcome.kind}`, {
        sessionId: session.sessionId,
        cli: session.cli,
        promptLength: text.length,
        ...(outcome.kind === 'delivered' ? { via: outcome.via, atMs: outcome.atMs } : { reason: outcome.reason }),
      })
      // The hand-back is what the person wrote, not what the launch would have
      // typed: for a CLI whose host context rides the prompt, that also carries
      // the whole host-context document.
      if (outcome.kind === 'abandoned')
        reportUndeliveredPrompt(session, personText?.trim() ? personText : text, outcome.reason)
    },
  })
}

/**
 * The manifest's `promptInjection.readiness`, in the shape the delivery takes.
 * Undefined (the delivery's default) for a manifest that declares none, and for
 * one whose pattern will not compile — the SDK validator refuses that, so it is
 * only reachable through a manifest that skipped validation.
 */
function deferredPromptReadinessFor(cli: string | undefined): DeferredPromptReadiness | undefined {
  const declared = cli ? getPluginById(pluginIdForCli(cli))?.manifest.promptInjection?.readiness : undefined
  if (!declared) return undefined
  if (declared.type === 'bracketed-paste') return { type: 'bracketed-paste', timeoutMs: declared.timeoutMs }
  try {
    return { type: 'output-match', pattern: new RegExp(declared.pattern), timeoutMs: declared.timeoutMs }
  } catch {
    return undefined
  }
}

// First messages that could not be typed in, waiting for a workspace window to
// take them. Held in memory only, and taken once: the window that takes them
// shows them and keeps them in its bell. A launch with no window open (an
// automation, the agent-launch tool, background mode) queues here until one
// opens. Bounded, oldest dropped, so a runaway never grows it.
const undeliveredPrompts: TerminalPromptUndelivered[] = []
const MAX_UNDELIVERED_PROMPTS = 20

/**
 * Tell the person their first message never reached the CLI, and hand it back:
 * queue it, and tell every window there is something to take (only a workspace
 * window takes it, so an aux or diagnostics window never swallows it). The
 * diagnostics log records that it happened, without the text. A session torn
 * down on purpose (`cancelled`) says nothing: the person closed it, or the app
 * is quitting.
 */
function reportUndeliveredPrompt(
  session: TerminalSession,
  text: string,
  reason: Extract<DeferredPromptOutcome, { kind: 'abandoned' }>['reason'],
): void {
  if (reason === 'cancelled') return
  const event: TerminalPromptUndelivered = {
    sessionId: session.sessionId,
    ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
    ...(session.agentId ? { agentId: session.agentId } : {}),
    ...(session.agentName ? { agentName: session.agentName } : {}),
    ...(session.cli ? { cli: session.cli } : {}),
    text,
    reason,
  }
  logReapDiagnostic?.({
    level: 'warning',
    title: 'First message not sent',
    message: `The first message for ${session.cli ?? 'an agent'} was not typed in (${reason}).`,
    details: `${text.length} characters`,
    ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
    ...(session.agentId ? { agentId: session.agentId } : {}),
    sessionId: session.sessionId,
  })
  undeliveredPrompts.push(event)
  if (undeliveredPrompts.length > MAX_UNDELIVERED_PROMPTS) undeliveredPrompts.shift()
  broadcastToAllWindows('terminal:prompt-undelivered', undefined, { skipCanvasWorker: true })
}

function attachTerminalSession(
  sessionId: string,
  terminalSession: TerminalSession,
  initialInput: string | undefined,
): void {
  terminals.set(sessionId, terminalSession)
  // Only a live pty holds its machine; a placeholder rehydrated from a sidecar
  // has no process and holds nothing.
  if (typeof terminalSession.process.pid === 'number') retainSessionHost(terminalSession)
  // The agent's own changelist, made and made ACTIVE at launch (decision of
  // record): edits that bypass the reporter hook — a Bash `sed`, a formatter on
  // save — are then adopted into the launching agent's list rather than into
  // whichever list happened to be active. A resume runs through here too, which
  // is right: the same agent is launching again.
  if (terminalSession.kind === 'agent' && terminalSession.agentId && onAgentLaunched) {
    try {
      onAgentLaunched(terminalSession)
    } catch (error) {
      console.warn('[terminal-runtime] agent changelist launch feed failed', error)
    }
  }
  scheduleTerminalIdleTransition(terminalSession)
  // Arms for the spawn-stamped `starting` phase, so an agent whose hooks never
  // report converts to `stalled` (and becomes reclaimable) instead of parking.
  scheduleAgentStallCheck(terminalSession)
  broadcastTerminalSessionsChanged(terminalSession)

  terminalSession.process.onData((data) => {
    // A settled session's screen has been rendered and its stream released.
    // What a dying CLI still writes after that (its goodbye text after a pause
    // kill, a straggler after exit on Windows) is not part of the screen the
    // pane and every reader now show, and keeping it would put a scrap of
    // stream back behind the snapshot. The process is dead or dying: drop it.
    if (terminalSession.replaySnapshot) return
    terminalSession.deferredPrompt?.observeOutput(data)
    if (!terminalSession.isReady) {
      terminalSession.isReady = true
      flushPendingTerminalResize(sessionId, terminalSession)
    }
    const now = Date.now()
    // Output right after a resize is the TUI repainting, not agent activity:
    // keep the painted scrollback complete but don't advance liveness/recency or
    // flip to "working" — otherwise revealing a workspace makes its idle agents
    // look active and reorders the sidebar.
    const isRepaint = now < (terminalSession.repaintGraceUntil ?? 0)
    const bytes = appendTerminalOutput(terminalSession, data, now, !isRepaint)
    if (!isRepaint) {
      // For AGENTS the hooks are the sole driver of activity in both
      // directions: output must not flip to "working" here, or the
      // prompt/result text that an authoritative awaiting_input/idle phase
      // prints would override it back to working (a transient
      // spinner-vs-needs-input fight). lastOutputAt was already advanced by
      // appendTerminalOutput above and still feeds the stall watchdog, so
      // output stays a liveness co-signal without owning status. Plain
      // terminals keep the output-driven working/idle bolding.
      if (terminalSession.kind !== 'agent' && terminalSession.activity.kind !== 'working') {
        setTerminalActivity(terminalSession, { kind: 'working', since: terminalSession.lastOutputAt ?? now })
      }
      extendTerminalIdleDeadline(terminalSession)
    }
    terminalOutput.send(terminalSession, data, bytes)
  })

  terminalSession.process.onExit((event) => {
    releaseSessionHost(terminalSession)
    // A first message still waiting for the CLI to be ready has nobody left to
    // read it — a suspend-kill included, whose relaunch is a resume.
    terminalSession.deferredPrompt?.observeExit()
    // Freeze-the-view: a suspend-kill is NOT a real exit. Finalize the suspended
    // state and keep the session + painted scrollback; do not mark the session
    // exited or fire `terminal:exit` (which would unmount the view). Resume
    // relaunches under the same session id.
    if (terminalSession.suspending || terminalSession.suspended) {
      terminalSession.suspending = false
      // Order matters: the rest stamp below goes through the ordinary activity
      // transition, which declines to move a session that is no longer alive.
      settleSuspendedAgentRest(terminalSession)
      terminalSession.suspended = true
      // Whatever the session was still waiting on died with the process. The
      // count is rendered ("2 running"), so leaving it standing would have a
      // frozen row claim live subagents forever — and it is not persisted, so a
      // restart would answer differently for the same parked chat.
      terminalSession.backgroundWork = 0
      if (terminals.get(sessionId) === terminalSession) {
        broadcastTerminalSessionsChanged(terminalSession)
      }
      return
    }
    cleanupTerminalStartupScript(terminalSession.startupScriptPath)
    cleanupHostContextFile(terminalSession.hostContextPath)
    cleanupHostContextFile(terminalSession.launchPromptPath)
    discardHostLaunchFiles(terminalSession)
    terminalOutput.flush(sessionId, 'exit')
    if (terminals.get(sessionId) === terminalSession) terminalOutput.forgetSession(sessionId)
    // Durable freeze-the-view, self-exit path: an agent whose pty ends on its own
    // (an automation run finishing, a CLI crashing) was never suspended and never
    // saw app quit, so before this it wrote NO sidecar at all — the common case,
    // not an edge one. With no painted screen on disk the tab has nothing to show
    // on cold load, and the only outcomes used to be pause (unreachable without a
    // sidecar) or spawn. Persist the painted content here so the terminal reopens
    // painted-and-paused like a suspended one, instead of inert or relaunched.
    //
    // Cheap raw byte dump, no headless render (same choice as the quit path):
    // rehydration renders it lazily on first status.
    //
    // Guarded on dispose: `disposeTerminal` deletes the sidecar and THEN kills the
    // pty, so this handler runs afterwards — writing unconditionally would
    // resurrect the very sidecar dispose just removed, and a deliberate dispose
    // (resume, fresh spawn, agent deletion) means gone, never
    // repainted. Only a pty that died on its own gets a snapshot: still in the map,
    // not disposed.
    if (terminals.get(sessionId) === terminalSession && !terminalSession.isDisposed) {
      const rawReplay = terminalSession.replaySnapshot ? undefined : materializeTerminalReplay(terminalSession)
      writeTerminalSnapshotSidecar(terminalSession, {
        snapshot: terminalSession.replaySnapshot,
        rawReplay,
        cols: terminalSession.appliedCols ?? 80,
        rows: terminalSession.appliedRows ?? 24,
      })
      if (rawReplay) settleExitedAgentScreen(terminalSession, rawReplay)
    }
    terminalDiagnostics.clear(sessionId)
    // Lifecycle stamp: the pty exit OWNS the terminal phase (it carries the
    // exit code no hook frame does), and stamping `exited` here is what clears
    // a stale `awaiting_input`/working phase so it cannot outlive the process.
    // Only on a real exit: the suspend branch above returns early so a frozen,
    // resumable view keeps its phase.
    terminalSession.agentState =
      terminalSession.kind === 'agent' ? { phase: 'exited', since: Date.now(), source: 'lifecycle' } : undefined
    // Nothing survives the process it ran under: a subagent count left standing
    // would render as live work on a dead session (the stall watchdog that
    // otherwise clears it is disarmed on this path).
    terminalSession.backgroundWork = 0
    setTerminalActivity(terminalSession, { kind: 'exited', at: Date.now(), exitCode: event.exitCode })
    const agentSession = terminalSession.agentSession
    if (agentSession?.executionId && agentSessionExitListeners.size > 0) {
      const exitEvent = {
        system: agentSession.system,
        workspaceRoot: agentSession.workspaceRoot,
        workspaceId: agentSession.workspaceId,
        agentId: terminalSession.agentId,
        executionId: agentSession.executionId,
        exitCode: event.exitCode,
      }
      for (const listener of agentSessionExitListeners) {
        trackAgentListenerRecord(Promise.resolve(listener(exitEvent)).catch(() => {}))
      }
    }
    // The agent's changelist is marked exited here — once, on the one path a pty
    // dies on its own. NOT on the suspend branch above, which returns early:
    // a frozen session is coming back, and a list whose owner has "exited" is a
    // list reconcile deletes the moment it empties. `agentSession` is not
    // required (a hand-launched agent terminal has none); an agentId is.
    if (terminalSession.agentId && onAgentSessionExit) {
      try {
        onAgentSessionExit(terminalSession)
      } catch (error) {
        console.warn('[terminal-runtime] agent changelist exit feed failed', error)
      }
    }
    if (terminals.get(sessionId) === terminalSession) {
      broadcastTerminalSessionsChanged(terminalSession)
    }
    if (!terminalSession.isDisposed) {
      sendTerminalEvent(terminalSession.sender, `terminal:exit:${sessionId}`, event.exitCode)
    }
  })

  if (initialInput) {
    recordTerminalInput(terminalSession)
    terminalSession.process.write(initialInput)
  }
}

async function spawnTerminalFromIpc(
  sender: WebContents,
  {
    sessionId,
    cols,
    rows,
    cwd,
    resume,
    cli,
    initialPrompt,
    cliRuntimes,
    shellOnly,
    cliSessionId,
    kind,
    workspaceId,
    hostId: requestedHostId,
    agentId,
    agentName,
    terminalId,
    executionMode,
    worktreeId,
    worktreePath,
    cliPermissionPreset = 'none',
    cliPermissionMode,
    cliModel,
    cliReasoning,
    memoryRootPath,
    memoryRelativeRoot,
    agentSession,
    visible = true,
    mcpSettings,
    connectorLaunch,
    spawnSkillId,
    agentRecord,
  }: TerminalSpawnPayload,
): Promise<TerminalSpawnResult> {
  const existingSession = terminals.get(sessionId)
  if (existingSession && !existingSession.isDisposed) {
    logMainPerfEvent('TerminalRuntime', 'terminal-reattach-existing-session', {
      sessionId,
      workspaceId: workspaceId ?? existingSession.workspaceId,
      agentId: agentId ?? existingSession.agentId,
      terminalId: terminalId ?? existingSession.terminalId,
      kind: kind ?? existingSession.kind,
      processAlive: isTerminalProcessAlive(existingSession),
      resumeRequested: resume,
      visible,
    })
    existingSession.sender = sender
    existingSession.workspaceId = workspaceId ?? existingSession.workspaceId
    existingSession.agentId = agentId ?? existingSession.agentId
    existingSession.agentName = agentName ?? existingSession.agentName
    existingSession.terminalId = terminalId ?? existingSession.terminalId
    existingSession.kind = kind ?? existingSession.kind
    existingSession.executionMode = executionMode ?? existingSession.executionMode
    existingSession.worktreeId = worktreeId ?? existingSession.worktreeId
    existingSession.worktreePath = worktreePath ?? existingSession.worktreePath
    existingSession.agentSession =
      materializeAgentSessionIdentity(sessionId, workspaceId, agentSession) ?? existingSession.agentSession
    recordTerminalVisibility(existingSession, visible)
    // Only resize a live pty. A suspended session (pty killed, view kept
    // painted) is being re-viewed here, not relaunched — resume happens via
    // `resumeTerminal` on keystroke. Resizing its dead pty would be a no-op at
    // best, so guard on liveness rather than `!hasExited`.
    if (isTerminalProcessAlive(existingSession)) {
      safeResizeTerminal(sessionId, cols, rows)
    }
    // Prefer a suspended session's faithful screen snapshot over the raw stream.
    const replay = existingSession.replaySnapshot ?? materializeTerminalReplay(existingSession)
    // The replay already holds whatever was queued for the old pane and not yet
    // sent; sending that batch after it would print its tail twice. And the new
    // pane starts with nothing in flight.
    terminalOutput.discard(sessionId)
    terminalOutput.resetRendererFlow(sessionId)
    noteRendererCaughtUp(existingSession)
    if (replay) {
      sendTerminalEvent(sender, `terminal:replay:${sessionId}`, replay)
      logMainPerfEvent('TerminalRuntime', 'terminal-replay-sent', {
        sessionId,
        workspaceId: workspaceId ?? existingSession.workspaceId,
        agentId: agentId ?? existingSession.agentId,
        terminalId: terminalId ?? existingSession.terminalId,
        kind: kind ?? existingSession.kind,
        replayChars: replay.length,
      })
    }
    if (existingSession.hasExited) {
      sendTerminalEvent(sender, `terminal:exit:${sessionId}`, existingSession.exitCode ?? 0)
    }
    broadcastTerminalSessionsChanged(existingSession)
    return { ok: true, sessionId } satisfies TerminalSpawnResult
  }

  // An omitted `cli` used to default to codex: a payload that named no agent
  // silently launched a different one, and reported success. Refuse instead of
  // guessing. Reattaching above needs no CLI, and plain shells carry none.
  if (!shellOnly && !cli) {
    return {
      ok: false,
      sessionId,
      message: 'This agent terminal did not say which CLI to launch, so nothing was started.',
      exitCode: 1,
    } satisfies TerminalSpawnResult
  }
  // Hooks-only selectability (decision of record 2026-08-31): a KNOWN plugin
  // whose manifest declares no agentStateSpec cannot report agent status and
  // is refused as an agent — never silently substituted. This is the last
  // door, so every launch path (renderer picker fallback, persisted
  // defaults, MCP, automations) is covered even if an upstream gate missed.
  // An id the registry doesn't know at all falls through — the launch render
  // rejects it with its own unknown-plugin error, and refusing here would
  // also refuse during a registry reload window.
  if (!shellOnly && cli && getPluginById(pluginIdForCli(cli)) && !agentStateSupportsCli(cli)) {
    return {
      ok: false,
      sessionId,
      message: `Agent CLI "${cli}" cannot report agent status (its plugin declares no lifecycle-hook support), so it is not selectable as an agent.`,
      exitCode: 1,
    } satisfies TerminalSpawnResult
  }
  // Non-null on every path that reads it: a fresh agent spawn with no CLI
  // returned above, and shell-only spawns never reach an agent-CLI consumer.
  const agentCli = cli as AgentCli
  // The machine this runs on: the session's own when it is being relaunched,
  // else the workspace's, else the distribution the folder lives in, else this
  // one. Everything below asks it rather than the platform: the path style the
  // CLI's hooks and MCP config are written in, the command the CLI runs as
  // there, and the shape of the startup script.
  let host = hostRegistry().resolve({
    bound: existingSession?.hostId,
    requested: requestedHostId ?? (workspaceId ? resolveWorkspaceHostId?.(workspaceId) : null),
    folder: cwd,
  })
  // A plain terminal in a folder Windows cannot name (a bare Linux path) opens
  // in the default distribution, as it always has, and so is that machine's.
  if (shellOnly && host.kind === 'windows' && cwd && !isWindowsPath(wslToWindowsPath(cwd))) {
    const distro = await resolveWslDistroForPath(cwd).catch(() => null)
    if (distro) host = hostRegistry().get(wslHostId(distro))
  }
  const executionPathStyle: TerminalPathStyle = host.pathStyle
  const launchCliRuntimes: typeof cliRuntimes = shellOnly
    ? cliRuntimes
    : { ...cliRuntimes, [agentCli]: host.cliRuntime(agentCli, cliRuntimes?.[agentCli]) }

  // A WSL machine needs its helper before anything is launched there: it
  // writes the startup script inside the distribution (nothing is run through
  // a `/mnt/<drive>` mount), and an agent's hooks, status line and MCP bridge
  // all report through it. Every launch there, a plain terminal's too, waits
  // for it (installing it on first use) and fails with the reason when it
  // cannot start. The local hosts are always ready.
  if (!shellOnly || host.kind === 'wsl') {
    try {
      await host.prepare()
    } catch (error) {
      const message = getErrorMessage(error)
      logMainPerfEvent('TerminalRuntime', 'host-prepare-failed', { sessionId, hostId: host.id, message })
      return { ok: false, sessionId, message, exitCode: 1 } satisfies TerminalSpawnResult
    }
  }
  const hostIntegration = shellOnly ? null : host.agentIntegration()
  const baseLaunchTarget = host.launchTarget()
  const launchTarget: HostLaunchTarget =
    baseLaunchTarget.kind === 'wsl' && !shellOnly
      ? {
          ...baseLaunchTarget,
          integration: hostIntegration,
          identity: agentIdentityEnv({ workspaceId, agentId, agentName, cli: agentCli }),
        }
      : baseLaunchTarget

  disposeTerminal(sessionId)
  logMainPerfEvent('TerminalRuntime', 'terminal-spawn-fresh', {
    sessionId,
    workspaceId,
    agentId,
    terminalId,
    kind: kind ?? (shellOnly ? 'terminal' : 'agent'),
    resumeRequested: resume,
    visible,
  })

  const workingDirectory = cwd || process.cwd()
  let channelToken: string | undefined
  // A first message the launch wrote to a file: the session reaps it once it
  // owns it, and a spawn that fails before then reaps it here.
  let unownedLaunchPromptPath: string | undefined
  try {
    // Resolve the agent's binary before this launch touches anything, and
    // refuse the spawn when the CLI is definitively absent. Both halves
    // matter: the launch shell does not source the interactive config the
    // probe does, so an installed CLI is executed by its probed absolute path
    // rather than a name the launch shell cannot resolve; and a missing one
    // fails here — ahead of the sibling-session dispose, the MCP sync, skill
    // installs and the pty — instead of dropping the user into a bare shell
    // reported as a successful start.
    let resolvedBinaryPath: string | undefined
    if (!shellOnly) {
      const preflight = await preflightAgentCliLaunch(
        {
          cli: agentCli,
          cliRuntimes: launchCliRuntimes,
          platform: agentCliPreflightOverrides.platform,
          shell: agentCliPreflightOverrides.shell,
        },
        agentCliPreflightOverrides.deps ?? {},
      )
      const failure = agentCliLaunchFailureResult(preflight, sessionId)
      if (failure) {
        logMainPerfEvent('TerminalRuntime', 'agent-cli-preflight-missing', { sessionId, cli: agentCli })
        return failure
      }
      if (preflight.status === 'resolved') resolvedBinaryPath = preflight.binaryPath
    }

    if ((kind ?? (shellOnly ? 'terminal' : 'agent')) === 'agent') {
      disposeOtherAgentSessions(sessionId, workspaceId, agentId)
    }

    if (!shellOnly && syncMcpConfig) {
      const syncResult = await syncMcpConfig({
        workspaceRoot: workingDirectory,
        settings: mcpSettings ?? { syncEnabled: false, servers: {} },
        clients: [agentCli],
        executionPathStyle,
        hostId: host.id,
        integration: hostIntegration,
        // A connector launch (connectorLaunch set, paired with the
        // single-server connectorMcpSettings) writes an isolated worktree
        // config that must contain only the connector — prune any MCP server
        // the base repo committed into the worktree, never merge it in.
        // connectorLaunch is the ONLY isolation signal: spawnSkillId is the
        // orthogonal skill-install concern and must never imply pruning
        // (a skill-only spawn would otherwise wipe the workspace's MCP
        // config).
        pruneUnlistedServers: connectorLaunch === true,
      })
      if (!syncResult.ok) {
        retainFailedTerminalSession({
          sessionId,
          sender,
          message: syncResult.message,
          kind: kind ?? (shellOnly ? 'terminal' : 'agent'),
          workspaceId,
          agentId,
          agentName,
          terminalId,
          cli: shellOnly ? undefined : cli,
          cwd: workingDirectory,
          executionMode,
          worktreeId,
          worktreePath,
          agentSession: materializeAgentSessionIdentity(sessionId, workspaceId, agentSession),
          visible,
        })
        sendTerminalEvent(sender, `terminal:error:${sessionId}`, syncResult.message)
        sendTerminalEvent(sender, `terminal:exit:${sessionId}`, 1)
        return {
          ok: false,
          sessionId,
          message: syncResult.message,
          exitCode: 1,
        } satisfies TerminalSpawnResult
      }
    }

    // Skill-at-spawn: install the attached builtin skill (the composer's
    // "+ Skill" attachment, a Backlog handoff, or a scheduled automation's
    // skill) into the working directory so the prefilled invocation resolves
    // to a present skill. Independent of connector isolation — only connector
    // launches get the MCP-config exclusion below. Best-effort: a failure is
    // logged and never blocks the spawn.
    if (spawnSkillId && !shellOnly && ensureBuiltinSkillInstalled) {
      try {
        await ensureBuiltinSkillInstalled(workingDirectory, spawnSkillId, agentCli, {
          hostId: host.id,
          integration: hostIntegration,
        })
      } catch (error) {
        logMainPerfEvent('TerminalRuntime', 'spawn-skill-install-failed', {
          sessionId,
          cli,
          spawnSkillId,
          message: getErrorMessage(error),
        })
      }
    }
    if (connectorLaunch && !shellOnly) {
      if (excludeWorktreeMcpConfig) {
        try {
          await excludeWorktreeMcpConfig(workingDirectory)
        } catch (error) {
          logMainPerfEvent('TerminalRuntime', 'connector-mcp-exclude-failed', {
            sessionId,
            cli,
            message: getErrorMessage(error),
          })
        }
      }
    }

    // The launch command's session id is the agent's own CLI/harness id when
    // resuming — `claude --resume <id>` / `codex resume <id>`. Prefer the
    // renderer-supplied (persisted) id, then any id captured on the session
    // being relaunched, then fall back to our terminal key ONLY for CLIs that
    // resume with the id we minted (Claude). For a self-id CLI (Codex) with no
    // captured id, pass empty so the manifest renders a bare `resume` (last
    // session) rather than `resume <terminal-key>`. Fresh launch: terminal key.
    const launchSessionId = resume
      ? (cliSessionId ?? existingSession?.cliSessionId ?? (cliResumesWithCallerSessionId(cli) ? sessionId : ''))
      : sessionId
    // Resolve a CLI auth token (only CLIs whose manifest declares `auth`, e.g.
    // Z.AI, return one) from the shared credential store so the manifest's
    // `launch.env` `{{secret}}` resolves into the spawned process env. Skipped
    // for plain shells (no agent CLI to authenticate).
    const cliAuthSecret = shellOnly ? null : await getSharedCredentialStore().resolveSecret(agentCli)
    const cliAuthToken = cliAuthSecret?.ok ? cliAuthSecret.value : undefined
    // If this CLI requires an API key (declares `auth`, e.g. Z.AI) and none is
    // configured, don't launch it into an auth error — return a clear,
    // actionable message. The renderer surfaces it and leaves the terminal
    // unstarted (see TerminalView spawn-failure handling).
    if (!shellOnly && cliAuthSecret) {
      const authPlugin = getPluginById(agentCli)
      const block = cliCredentialLaunchBlock({
        displayName: authPlugin?.manifest.displayName ?? agentCli,
        auth: authPlugin?.manifest.auth,
        secretConfigured: cliAuthSecret.ok,
      })
      if (block) return { ok: false, sessionId, message: block.message, exitCode: 1 }
    }
    // Every agent launch is issued its own gateway token, bound to its
    // conversation: the agent's MCP bridge presents it, and the gateway takes
    // the agent's identity from it. In WSL it is also the token the bridge
    // opens its channel with, exported by the startup script; here it rides in
    // the terminal's environment. The session revokes it when it ends.
    const launchIdentity: GatewayLaunchIdentity | null =
      !shellOnly && workspaceId && agentId
        ? { workspaceId, agentId, ...(agentName ? { agentName } : {}), cliId: agentCli }
        : null
    channelToken = shellOnly
      ? undefined
      : launchTarget.kind === 'wsl'
        ? host.issueChannelToken?.(launchIdentity)
        : launchIdentity
          ? issueGatewayLaunchToken(launchIdentity)
          : undefined
    const launchFor: HostLaunchTarget =
      channelToken && launchTarget.kind === 'wsl' ? { ...launchTarget, channelToken } : launchTarget
    const {
      command,
      args,
      cwd: launchCwd,
      pathStyle,
      initialInput,
      env,
      startupScriptPath,
      hostContextPath,
      deferredPrompt,
      launchPromptPath,
      hostFiles,
    } = shellOnly
      ? getPlainShellLaunchConfig(workingDirectory, sessionId, launchFor)
      : getShellLaunchConfig(
          workingDirectory,
          launchSessionId,
          resume,
          agentCli,
          initialPrompt,
          launchCliRuntimes,
          permissionRenderKey(getPluginById(agentCli)?.manifest, cliPermissionPreset, cliPermissionMode),
          cliModel,
          memoryRootPath,
          memoryRelativeRoot,
          undefined,
          cliAuthToken,
          cliReasoning,
          resolvedBinaryPath,
          launchFor,
          {
            // An agent bound to a workspace reaches the editor tools through its
            // gateway connection, so its host context says when to use them.
            editorTools: Boolean(workspaceId && agentId),
            // The bundled skill this launch's prompt invokes, the one ensured
            // above: a launch that takes the app's plugin directories is handed
            // it as a plugin of its own, and the install above wrote nothing
            // for it (`delivered-at-launch`).
            launchSkills: spawnSkillId ? [spawnSkillId] : [],
          },
        )
    unownedLaunchPromptPath = launchPromptPath
    // A WSL launch's startup script (and host-context file) are written inside
    // the distribution by its helper, and the terminal runs them from there.
    if (hostFiles && hostFiles.length > 0) {
      const label = host.summary().label
      if (!host.writeLaunchFiles) throw new Error(`${label} cannot take this terminal's startup script.`)
      try {
        await host.writeLaunchFiles(hostFiles)
      } catch (error) {
        throw new Error(`Couldn't write this terminal's startup script into ${label}: ${getErrorMessage(error)}`)
      }
    }
    // Install the authoritative-agent-state reporter into the workspace before
    // launching a supported agent, so its lifecycle hooks report phase the
    // moment it starts. Awaited so the hooks exist when the CLI reads its
    // settings; best-effort inside (never throws), so it cannot fail a launch.
    if (!shellOnly && agentStateSupportsCli(cli)) {
      await prepareAgentStateHook?.(launchCwd ?? workingDirectory, cli, {
        pathStyle: executionPathStyle,
        hostId: host.id,
        integration: hostIntegration,
      })
    }

    const initialSize = getTerminalSize(cols, rows)
    const termProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: initialSize.cols,
      rows: initialSize.rows,
      cwd: launchCwd ?? workingDirectory,
      // Expose this agent's identity so a typed Backlog handoff can record the
      // item ↔ agent link. Strips any inherited identity first, so plain
      // terminals carry none and a moved/relaunched session never keeps a
      // stale id.
      env: applyAgentIdentityEnv(env ?? getTerminalEnv(), {
        workspaceId,
        agentId,
        agentName,
        ...(shellOnly ? {} : { cli: agentCli }),
        // In WSL the startup script exports it; wsl.exe itself needs none.
        ...(channelToken && launchTarget.kind !== 'wsl' ? { launchToken: channelToken } : {}),
      }),
    })
    // On Linux the kernel's out-of-memory killer takes this terminal (and the
    // agent in it) before the app. Not awaited: it never holds up a launch.
    void raiseChildOomScore(termProcess.pid)
    const startedAt = Date.now()
    const terminalSession: TerminalSession = {
      sessionId,
      process: termProcess,
      sender,
      isReady: process.platform !== 'win32',
      hasExited: false,
      exitedAt: null,
      isDisposed: false,
      activity: createInitialTerminalActivity(startedAt),
      agentState: createInitialAgentState(kind ?? (shellOnly ? 'terminal' : 'agent'), startedAt),
      lastTurnEndedAt: takeResumeTurnEnd(sessionId),
      observedCheckout: takeResumeObservedCheckout(sessionId),
      output: new TerminalReplayBuffer(),
      kind: kind ?? (shellOnly ? 'terminal' : 'agent'),
      pathStyle,
      hostId: host.id,
      workspaceId,
      launchWorkspaceId: workspaceId,
      agentId,
      agentName,
      terminalId,
      // Seed the harness session id from the resume payload so it is known
      // (and snapshotted) immediately; the lifecycle hook refreshes it once
      // the relaunched agent reports its own id.
      cliSessionId: cliSessionId ?? undefined,
      cli: shellOnly ? undefined : cli,
      cwd: launchCwd ?? workingDirectory,
      executionMode,
      worktreeId,
      worktreePath,
      agentSession: materializeAgentSessionIdentity(sessionId, workspaceId, agentSession),
      agentRecord,
      visible,
      startedAt,
      lastOutputAt: startedAt,
      lastInputAt: null,
      lastVisibleAt: visible ? startedAt : null,
      startupScriptPath,
      hostContextPath,
      ...(launchPromptPath ? { launchPromptPath } : {}),
      ...(channelToken ? { channelToken } : {}),
    }
    if (deferredPrompt) armDeferredPrompt(terminalSession, deferredPrompt, initialPrompt)
    unownedLaunchPromptPath = undefined

    attachTerminalSession(sessionId, terminalSession, initialInput)

    return { ok: true, sessionId } satisfies TerminalSpawnResult
  } catch (error) {
    if (channelToken) {
      host.revokeChannelToken?.(channelToken)
      revokeGatewayLaunchToken(channelToken)
    }
    if (unownedLaunchPromptPath) void cleanupHostContextFile(unownedLaunchPromptPath)
    const message = getTerminalErrorMessage(error)
    retainFailedTerminalSession({
      sessionId,
      sender,
      message,
      kind: kind ?? (shellOnly ? 'terminal' : 'agent'),
      workspaceId,
      agentId,
      agentName,
      terminalId,
      cli: shellOnly ? undefined : cli,
      cwd: cwd || process.cwd(),
      executionMode,
      worktreeId,
      worktreePath,
      agentSession: materializeAgentSessionIdentity(sessionId, workspaceId, agentSession),
      visible,
    })
    sendTerminalEvent(sender, `terminal:error:${sessionId}`, message)
    sendTerminalEvent(sender, `terminal:exit:${sessionId}`, 1)
    return {
      ok: false,
      sessionId,
      message,
      exitCode: 1,
    } satisfies TerminalSpawnResult
  }
}

// Raw retained output for a session, for in-process readers. A disposed session
// is gone, so it reads as absent rather than as an empty screen.
function readTerminalOutput(sessionId: string): string | undefined {
  const session = terminals.get(sessionId)
  if (!session || session.isDisposed) return undefined
  // A paused or exited agent let go of its raw stream once its screen was
  // rendered, so what is left to read is that screen and the scrollback above
  // it — rendered as deep as a live pane keeps it, so the history the agent
  // printed is all there, as text laid out on the screen rather than as the
  // raw stream (cursor movement and repaints already applied). A snapshot
  // exists only once the stream behind it has been released.
  if (session.replaySnapshot) return session.replaySnapshot
  return materializeTerminalReplay(session)
}

function readTerminalOutputSince(sessionId: string, cursor: number): { text: string; cursor: number } | undefined {
  const session = terminals.get(sessionId)
  if (!session || session.isDisposed) return undefined
  const read = readSessionOutputSince(session, cursor)
  // A paused or exited agent let go of its stream once its screen was
  // rendered. A reader that had not yet seen the end of that stream is handed
  // the rendered screen and its scrollback, which carry the text the stream
  // did, instead of nothing: a pattern wait started after the release still
  // sees what the agent printed.
  // The screen can repeat text that reader already had: which part it missed
  // cannot be told once the stream is gone, and a repeat is the lesser error
  // for a reader looking for the agent's last words.
  if (read.text === '' && (cursor === 0 || cursor < read.cursor) && session.replaySnapshot) {
    return { text: session.replaySnapshot, cursor: read.cursor }
  }
  return { text: read.text, cursor: read.cursor }
}

function writeTerminalInput(sessionId: string, data: string): void {
  const startedAt = Date.now()
  const session = terminals.get(sessionId)
  if (!session || !isTerminalProcessAlive(session)) return
  // A paste arriving while a first message is still waiting to be typed in
  // (the composer's skill prefill is written right after spawn) goes after that
  // message's Enter, never into it. Keystrokes are not held: the pane answers
  // the CLI's terminal queries through this same write.
  if (data.startsWith('\x1b[200~') && session.deferredPrompt?.holdPaste(data)) return

  try {
    recordTerminalInput(session, startedAt, data)
    // `lastInputAt` is not worth a broadcast of its own per keystroke; it goes
    // out with the next one, as it always has.
    markTerminalSessionChanged(session)
    session.process.write(data)
    terminalDiagnostics.recordInputWrite(session, Buffer.byteLength(data), Date.now() - startedAt, true)
  } catch (error) {
    setTerminalActivity(session, {
      kind: 'failed',
      at: Date.now(),
      exitCode: session.exitCode ?? 1,
      message: getErrorMessage(error),
    })
    terminalDiagnostics.recordInputWrite(session, Buffer.byteLength(data), Date.now() - startedAt, false)
  }
}
