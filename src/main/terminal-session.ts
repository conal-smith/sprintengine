import type { WebContents } from 'electron'
import type { ObservedCheckout } from '../shared/observed-checkout'
import type { BranchPullRequest } from '../shared/git/pull-request'
import type * as pty from 'node-pty'
import type {
  AgentCli,
  AgentExecutionMode,
  AgentSessionIdentity,
  AgentState,
  SessionActivity,
  SessionContextUsage,
  SessionFileChange,
  SessionPrompt,
  TerminalKind,
  TerminalPathStyle,
  TerminalSessionSnapshot,
} from '../shared/electron-api'
import type { AgentLaunchRecord } from '../shared/agent-launch'
import type { ExecutionHostId } from '../shared/execution-host'
import type { AgentStateFrameStatusLine } from './agent-state'
import { samePromptCacheReading, type PromptCacheReading } from '../shared/prompt-cache'
import type { DeferredPromptDelivery } from './deferred-prompt-delivery'
import { isValidFileChangePath, MAX_AGENT_PROMPT_LENGTH, MAX_FILE_CHANGE_COUNT } from './agent-state'
import { MAX_LIVE_PEEK_PROMPTS } from './conversation-peek/service'
import {
  getTerminalHistoryTier,
  getTerminalReplayLimitBytes,
  TERMINAL_RECENT_REPLAY_BYTES,
} from '../shared/terminal-history'
import { TerminalReplayBuffer } from './terminal-replay-buffer'

export type TerminalSize = {
  cols: number
  rows: number
}

type FailedTerminalSessionInput = {
  sessionId: string
  sender?: WebContents
  message: string
  at?: number
  exitCode?: number
  kind?: TerminalKind
  pathStyle?: TerminalPathStyle
  // The machine the session runs on (see shared/execution-host.ts). A resume
  // reads it before anything else, so a CLI's transcript is always looked for
  // in the home it was written to.
  hostId?: ExecutionHostId
  workspaceId?: string
  agentId?: string
  agentName?: string
  terminalId?: string
  cli?: AgentCli
  cwd?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  agentSession?: AgentSessionIdentity
  visible?: boolean
  lastOutputAt?: number | null
  lastInputAt?: number | null
}

export type TerminalSession = {
  sessionId: string
  process: pty.IPty
  sender: WebContents
  isReady: boolean
  hasExited: boolean
  exitedAt: number | null
  exitCode?: number
  isDisposed: boolean
  // Freeze-the-view: the agent process was killed to reclaim memory but the
  // session is kept (painted scrollback + --resume flags) so it can be resumed
  // on the next keystroke. Distinct from `isDisposed` (gone for good) and from a
  // real exit. `suspending` is the transient flag set just before `process.kill()`
  // so the pty `onExit` handler treats the death as a suspend, not a crash/exit.
  suspended?: boolean
  suspending?: boolean
  // User lock ("keep running"): while set, the reaper's idle-suspend and stale-
  // dispose sweeps skip this session entirely. Session-scoped; set over IPC from
  // the terminal's lock control.
  reapExempt?: boolean
  idleTimer?: ReturnType<typeof setTimeout>
  // When a plain terminal's working bolding should lapse to idle. Output moves
  // the deadline; the timer is only re-armed when it fires early, instead of
  // being cleared and set again for every chunk.
  idleDeadline?: number
  // Watches a hook-reported working phase for a stall: a `tool_use`/`thinking`
  // agent that goes silent (no follow-up frame and no output) past the threshold
  // is flipped to an inferred `stalled` phase. See scheduleAgentStallCheck.
  agentStallTimer?: ReturnType<typeof setTimeout>
  activity: SessionActivity
  // The agent's phase. Lifecycle-stamped `starting` (inferred) at spawn, then
  // authoritative from the CLI's hook frames; the stall watchdog and the pty
  // exit path stamp `stalled`/`exited`/`failed`. Never derived from output
  // timing. Absent for plain terminals. See agent-state.ts.
  agentState?: AgentState
  // The last prompt the person submitted to this session, from the reporter's
  // `UserPromptSubmit` frame. Drives the terminal tab's hover preview ("what was
  // I working on here?") and names a new chat after its first real prompt.
  // Absent for plain terminals, for hookless CLIs, and until the first prompt.
  lastPrompt?: SessionPrompt
  // The prompts this chat has been sent, oldest first and bounded (see
  // rememberSessionPrompt). This is the conversation peek's only source: the
  // peek never reads a CLI's own transcript (owner ruling 2026-09-24).
  //
  // Written to disk in two places, both under userData and mode 0600: the
  // snapshot sidecar, beside a painted screen that already shows this text, and
  // for an agent the agent prompt store (agent-prompt-store.ts), which outlives
  // the sidecar's 30-day sweep so a chat still in the sidebar keeps its card.
  // Never the workspace registry, never a log.
  peekPrompts?: SessionPrompt[]
  // Set once this session's prompts have been reconciled with its agent's
  // stored list (terminal-runtime.ts, reinflateSessionPrompts), and settled
  // when that is done. Never persisted.
  peekPromptsReinflated?: Promise<void>
  // When the agent's last turn ended (hook-reported Stop). Stamped in
  // ingestAgentStateFrame, carried across resume and through the snapshot
  // sidecar; never overwritten by suspend/exit. See the snapshot field.
  lastTurnEndedAt?: number | null
  // When the agent self-scheduled a wakeup (ScheduleWakeup hook frame), the
  // epoch-ms time it fires. The timer lives inside the CLI process, so the idle
  // reaper holds the session until then (terminal-reap-policy). Cleared by a
  // stop frame, a SessionStart frame (a fresh/resumed process has no timer
  // from its previous life), or naturally by expiry.
  pendingWakeupAt?: number | null
  // What this session has edited, keyed by absolute path. Fed by the
  // reporter's PostToolUse `fileChange` frames (ingestAgentStateFrame) and read
  // out newest-first for the snapshot. Insertion order IS the recency order:
  // every observation re-inserts its entry at the end (see
  // recordSessionFileChange), so the newest edit is always the last key.
  //
  // Lives and dies with the pty: a fresh session starts empty, and a resume
  // respawns the pty, so its ledger starts over too. A parked session keeps
  // its ledger through the snapshot sidecar, which is the only place it is
  // written down.
  fileChanges?: Map<string, SessionFileChange>
  // The file-change folds this session has already applied, newest last, so a
  // DUPLICATE frame is not counted twice.
  //
  // The app registers the agent-state reporter twice — merged by hand into
  // `.claude/settings.local.json`, and declared again by the studio plugin's
  // own `hooks/hooks.json` — and Claude Code 2.1.266 loads the plugin natively
  // whether or not this app asks it to, so both registrations fire on every
  // tool call. The two frames are identical, so without this the ledger read
  // exactly 2x the agent's edits and the changelist line tracker applied every
  // insert and delete twice, corrupting its spans.
  //
  // Keys are `noteFoldedFileChange`'s, values the frame ts they were folded at
  // (the no-id key needs it for its window). Bounded to
  // MAX_FOLDED_FILE_CHANGE_KEYS and evicted oldest-first: this is a duplicate
  // guard for frames seconds apart, not a history.
  //
  // In memory only, and deliberately not on the snapshot: a rehydrated session
  // is not going to receive the duplicate of a frame the pty that sent it no
  // longer exists to send.
  foldedFileChanges?: Map<string, FoldedFileChange>
  // The last reading from this session's own status line (the status-line
  // forwarder's `StatusLine` frames). Only `contextUsage` below is on the
  // snapshot today; the cost, the line counts, the model and the session name
  // are kept here for the surfaces that will read them, so the forwarder is
  // written once rather than once per consumer.
  statusLine?: SessionStatusLine
  // The usage windows this session's status line last handed to the
  // usage-limit store, with the cost beside them (`statusLineRateLimitsAreNews`).
  // In memory only: a rehydrated session's next reading is news.
  forwardedRateLimits?: string
  // How much of the context window this session has consumed, as of the reading
  // that last MOVED it. A null percentage — which the CLI reports before its
  // first API call and again right after a /compact — deliberately does NOT
  // clear this: "not known right now" is not "empty", and painting a compacted
  // session as unknown would lose the number a person was watching seconds
  // before the next real reading replaces it.
  contextUsage?: SessionContextUsage
  // When something was last TYPED or pasted into this session — `lastInputAt`
  // without the focus reports and query answers the terminal sends on its own.
  // What says a draft may be sitting at the prompt (terminalCompactBlocker):
  // switching windows is not typing.
  lastKeyInputAt?: number
  // The main conversation's prompt cache, from the same status line: its
  // lifetime, when it goes cold, and what a cold resume re-caches. Replaced
  // WHOLE by each reading that carries one — its nulls are facts — and kept
  // when a reading carries none, as the context percentage is.
  promptCache?: PromptCacheReading
  // Background work the agent still owns — subagents started and not yet
  // stopped, per the manifest's `background` events. A turn end that arrives
  // while this is above zero is held as working (agent-state.ts,
  // holdTurnEndForBackgroundWork). Reset on a session start and on a stall.
  backgroundWork?: number
  // When the newest background stop that closed nothing was stamped; a start
  // stamped at or before it is not counted (agent-state.ts,
  // `backgroundStartAlreadyClosed`).
  unmatchedBackgroundStopAt?: number
  // The retained pty stream, as UTF-8 bytes (terminal-replay-buffer.ts). Its
  // `truncated` flag is what licenses the head resync in
  // {@link materializeTerminalReplay}: an untouched buffer starts where the CLI
  // started and must be replayed byte for byte.
  //
  // Emptied once a suspend has a faithful snapshot of the screen, and on
  // dispose: a paused agent's frozen view is `replaySnapshot` alone.
  output: TerminalReplayBuffer
  // Faithful screen snapshot captured at suspend: the retained output stream is
  // rendered once through a headless terminal and serialized, so reopening a
  // paused agent repaints its last screen (including alternate-screen TUI state)
  // without a live process. Preferred over the raw replay when present; absent
  // for live sessions and cleared on resume. See terminal-replay-snapshot.ts.
  replaySnapshot?: string
  // Bumped on every fold into `fileChanges`, so the sessions broadcast can tell
  // whether the ledger moved since it last sent it without comparing the list.
  fileChangesVersion?: number
  // How far into the output stream (`output.endOffset` terms) the renderer's
  // xterm has been sent, and to which window. Revealing a hidden pane sends
  // only what lies past it when that is still retained, instead of resetting
  // the pane and replaying the whole window.
  rendererDeliveredOffset?: number
  rendererDeliveredTo?: WebContents
  kind: TerminalKind
  pathStyle?: TerminalPathStyle
  // The machine the session runs on (see shared/execution-host.ts). A resume
  // reads it before anything else, so a CLI's transcript is always looked for
  // in the home it was written to.
  hostId?: ExecutionHostId
  // This pty's hold on its machine (see `retainSessionHost`); cleared on release.
  hostLease?: string
  workspaceId?: string
  // The workspace this pty's process was launched with — the
  // SPRINTENGINE_WORKSPACE_ID its hooks report. `workspaceId` follows an agent
  // moved to another chat (its pane reattaches from there); the process env
  // does not, so its hook frames go on naming this one.
  launchWorkspaceId?: string
  agentId?: string
  // Display name from spawn metadata, surfaced on the snapshot so the session
  // manager can label agents that have no workspace.agents record.
  agentName?: string
  terminalId?: string
  // The agent's own session id within its CLI/harness, captured from lifecycle
  // hooks. Distinct from `sessionId` (our terminal-tracking id): this is the id
  // the CLI uses to resume the conversation. For Claude it equals our minted
  // id; Codex and others mint their own, learned via the hook after launch.
  cliSessionId?: string
  cli?: AgentCli
  cwd?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  // Where the session's hooks last saw it: the reported cwd plus
  // git's answer for it. Kept apart from `cwd`/`worktreePath` (launch intent).
  observedCheckout?: ObservedCheckout
  // Monotonic ticket for the async git resolution of `observedCheckout`, so a
  // resolution that finishes after a newer cwd arrived is discarded.
  observedCheckoutSeq?: number
  agentSession?: AgentSessionIdentity
  // The launch decisions the main-process AgentLaunchService made for this
  // session. Retained here so it lives exactly as long as the session
  // does: the renderer projects a tab from it, and when the pty is gone there is
  // nothing left to project. Absent for renderer-launched and plain sessions.
  agentRecord?: AgentLaunchRecord
  visible: boolean
  startedAt: number
  lastOutputAt: number | null
  lastInputAt: number | null
  lastVisibleAt: number | null
  // The last moment this session was painted in a pane someone could see:
  // stamped while it is shown and when it stops being shown, never by a hide
  // repeated while it was already hidden. See `isTerminalSessionStale`.
  lastOnScreenAt?: number
  pendingResize?: TerminalSize
  // Last dimensions actually applied to the pty. A reveal/tab-switch re-fits to
  // the SAME size; resizing the pty then makes the alt-screen TUI repaint, and
  // that repaint counts as spurious output/activity. Skip the resize when these
  // match so "last output" stays honest (real output, not repaints).
  appliedCols?: number
  appliedRows?: number
  // Output arriving before this time is treated as a host-triggered repaint (the
  // TUI redrawing after a resize), not agent activity: buffered but not counted
  // toward lastOutputAt / "working". Set in safeResizeTerminal.
  repaintGraceUntil?: number
  startupScriptPath?: string
  /**
   * This session's host-context document, when the launch wrote one. Reaped
   * with the startup script at teardown — the file is per-session and rewritten
   * on every launch and resume, so nothing outlives the pty.
   */
  hostContextPath?: string
  /**
   * Where the launch wrote a first message too long for the command line, for
   * a CLI that reads it from a file. Reaped with the host-context document.
   */
  launchPromptPath?: string
  /**
   * A first message too long for the command line, still to be typed into the
   * CLI once it is ready (`deferred-prompt-delivery.ts`). Fed the session's
   * output and hook frames; settles once, delivered or abandoned.
   */
  deferredPrompt?: DeferredPromptDelivery
  /**
   * A WSL agent launch's MCP channel token (`ExecutionHost.issueChannelToken`),
   * revoked with the session so a bridge outliving it cannot open a channel.
   */
  channelToken?: string
}

// Working/idle bolding for PLAIN terminals only: agent sessions' activity is
// bridged from their hook-reported phases (ingestAgentStateFrame), never from
// output timing — the agent idle-flip variant died with the status inference.
const DEFAULT_IDLE_POLICY = {
  flipToIdleAfterMs: 3_000,
} as const

export function getTerminalSize(cols: number, rows: number): TerminalSize {
  return {
    cols: Math.max(Number.isFinite(cols) ? Math.floor(cols) : 80, 20),
    rows: Math.max(Number.isFinite(rows) ? Math.floor(rows) : 24, 8),
  }
}

export function isTerminalProcessAlive(session: TerminalSession): boolean {
  // A suspended session's pty has been killed to reclaim memory; it is not live
  // (so it un-bolds, drops out of resident memory, and is not re-reaped) but is
  // not gone either — `suspended` is its own state, distinct from exit/dispose.
  return !session.hasExited && !session.isDisposed && !session.suspended
}

export function clearTerminalIdleTimer(session: TerminalSession): void {
  if (!session.idleTimer) return
  clearTimeout(session.idleTimer)
  session.idleTimer = undefined
}

export function clearAgentStallTimer(session: TerminalSession): void {
  if (!session.agentStallTimer) return
  clearTimeout(session.agentStallTimer)
  session.agentStallTimer = undefined
}

// The lifecycle stamp an agent session is born with: `starting` — the one phase
// a fresh spawn can substantiate without a hook frame. The first
// reporter frame replaces it with authoritative state; a session whose hooks
// never fire (a broken install) converts to `stalled` via the stall watch
// instead of parking as working forever. Output-timing NEVER guesses a phase:
// the old inference (`inferAgentStateFromActivity`) was deleted outright —
// hooks are the only status mechanism (decision of record 2026-08-31), and
// every selectable agent CLI now reports them.
export function createInitialAgentState(kind: TerminalKind, startedAt: number): AgentState | undefined {
  return kind === 'agent' ? { phase: 'starting', since: startedAt, source: 'lifecycle' } : undefined
}

export function getTerminalIdleTimeoutMs(_session: TerminalSession): number {
  return DEFAULT_IDLE_POLICY.flipToIdleAfterMs
}

export function createInitialTerminalActivity(startedAt: number): SessionActivity {
  return { kind: 'working', since: startedAt }
}

export function transitionTerminalActivity(session: TerminalSession, next: SessionActivity): boolean {
  if (next.kind === 'exited' || next.kind === 'failed') {
    clearTerminalIdleTimer(session)
    clearAgentStallTimer(session)
    session.hasExited = true
    session.exitedAt ??= next.at
    session.exitCode = next.exitCode
  } else if (!isTerminalProcessAlive(session)) {
    return false
  }

  if (sessionActivitiesEqual(session.activity, next)) return false
  session.activity = next
  return true
}

export function recordTerminalInput(session: TerminalSession, at = Date.now(), data?: string): void {
  session.lastInputAt = at
  if (data !== undefined && !isTerminalReport(data)) session.lastKeyInputAt = at
}

// What the terminal sends on its own rather than on a keystroke: focus in and
// out (`CSI I` / `CSI O`, which Claude Code turns on), and its answers to the
// CLI's queries — device attributes (`CSI ? … c`, `CSI > … c`), status
// (`CSI … n`) and the cursor position (`CSI row ; col R`). Several can arrive
// in one write.
const TERMINAL_REPORT = /^(?:\x1b\[[\d;?>]*[IOcnR])+$/

function isTerminalReport(data: string): boolean {
  return TERMINAL_REPORT.test(data)
}

// Visibility recency feeds the stale-terminal sweep. Both transitions count as
// "the user looked at this": becoming visible marks the view starting, and
// becoming hidden marks the moment the user navigated away.
export function recordTerminalVisibility(session: TerminalSession, visible: boolean, at = Date.now()): void {
  if (visible || session.visible) session.lastOnScreenAt = at
  session.visible = visible
  session.lastVisibleAt = at
}

// A terminal nobody has seen on screen, typed into, or had output from for
// this long is reaped by the main-process sweep.
export const STALE_TERMINAL_MAX_UNSEEN_MS = 24 * 60 * 60 * 1000

// "When real activity last happened on this terminal": the spawn moment plus the
// last genuine input or output. Deliberately EXCLUDES lastVisibleAt — merely
// opening a workspace or clicking a tab marks a terminal visible, and counting
// that would reset the idle clock every time the user just *looked*. Idle reaping
// must key off real interaction (typing) and real work (output), not attention.
// lastVisibleAt is still recorded for the snapshot/diagnostics; the stale
// backstop adds on-screen time separately, in isTerminalSessionStale.
export function getTerminalLastSeenAt(session: TerminalSession): number {
  return Math.max(session.startedAt, session.lastInputAt ?? 0, session.lastOutputAt ?? 0)
}

/**
 * The start of the stretch the stale backstop measures: the later of the last
 * real activity and the last moment the session was on screen.
 *
 * `visible` alone cannot be the guard any more, because it now means
 * "painted": a minimized or locked window and an inactive workspace all report
 * their panes hidden, and a live terminal whose last output was days ago
 * would be disposed at the first sweep after its window was minimized.
 * Counting from when it was last shown reaps only what nobody has looked at
 * for the whole window. (Settled agents are not reaped at all; see
 * `isTerminalSessionStale`.)
 */
export function getTerminalUnseenSince(session: TerminalSession): number {
  return Math.max(getTerminalLastSeenAt(session), session.lastOnScreenAt ?? 0)
}

export function isTerminalSessionStale(
  session: TerminalSession,
  now = Date.now(),
  maxUnseenMs = STALE_TERMINAL_MAX_UNSEEN_MS,
): boolean {
  if (session.isDisposed) return false
  // A settled agent — paused, or finished on its own — is never reaped here.
  // Its process is already gone and its raw stream already released, so
  // disposing it would free a rendered screen of a few megabytes at most, and
  // would delete the sidecar that is the only copy of its history a restart
  // can reopen. Its tab closing, or the agent being deleted, is what ends it;
  // the sidecar's own TTL bounds the disk.
  if (session.kind === 'agent' && (session.suspended || session.hasExited)) return false
  // A session painted in a pane right now is on screen; only trust the flag
  // while its window still exists.
  if (session.visible && !session.sender.isDestroyed()) return false
  return now - getTerminalUnseenSince(session) > maxUnseenMs
}

export function markTerminalExited(session: TerminalSession, exitCode: number, at = Date.now()): void {
  transitionTerminalActivity(session, { kind: 'exited', at, exitCode })
}

export function markTerminalFailed(
  session: TerminalSession,
  exitCode: number,
  message: string | undefined,
  at = Date.now(),
): void {
  transitionTerminalActivity(
    session,
    message ? { kind: 'failed', at, exitCode, message } : { kind: 'failed', at, exitCode },
  )
}

export function createFailedTerminalSession(input: FailedTerminalSessionInput): TerminalSession {
  const at = input.at ?? Date.now()
  const kind = input.kind ?? 'agent'
  return {
    sessionId: input.sessionId,
    process: createInactiveTerminalProcess(),
    sender: input.sender ?? createNoopWebContents(),
    isReady: true,
    hasExited: true,
    exitedAt: at,
    exitCode: input.exitCode ?? 1,
    isDisposed: false,
    activity: {
      kind: 'failed',
      at,
      exitCode: input.exitCode ?? 1,
      message: input.message,
    },
    // Lifecycle stamp, not inference: a retained failure IS the failed phase.
    ...(kind === 'agent' ? { agentState: { phase: 'failed' as const, since: at, source: 'lifecycle' as const } } : {}),
    output: new TerminalReplayBuffer(),
    kind: input.kind ?? 'agent',
    pathStyle: input.pathStyle,
    hostId: input.hostId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    agentName: input.agentName,
    terminalId: input.terminalId,
    cli: input.cli,
    cwd: input.cwd,
    executionMode: input.executionMode,
    worktreeId: input.worktreeId,
    worktreePath: input.worktreePath,
    agentSession: input.agentSession,
    visible: input.visible ?? false,
    startedAt: at,
    lastOutputAt: input.lastOutputAt === undefined ? at : input.lastOutputAt,
    lastInputAt: input.lastInputAt ?? null,
    lastVisibleAt: input.visible ? at : null,
  }
}

type SuspendedPlaceholderSessionInput = {
  sessionId: string
  sender?: WebContents
  // When the sidecar was written (the suspend/quit moment) — the honest "last
  // output" time for the painted content.
  savedAt: number
  // When the agent's last turn ended, if the sidecar carried it. Seeds the
  // placeholder's idle stamp so the sidebar row says when the agent finished,
  // not when the app quit — every quit-path sidecar shares one savedAt.
  lastTurnEndedAt?: number | null
  kind?: TerminalKind
  workspaceId?: string
  agentId?: string
  terminalId?: string
  cli?: AgentCli
  cliSessionId?: string
  // The machine it ran on, so the resume that replaces this placeholder
  // relaunches there.
  hostId?: ExecutionHostId
  cwd?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  observedCheckout?: ObservedCheckout
  // The file ledger the sidecar persisted, newest-edited first, so a session
  // parked across an app restart still says what it changed.
  fileChanges?: Map<string, SessionFileChange>
  // The context reading the sidecar persisted, so a parked chat still says how
  // full it was.
  contextUsage?: SessionContextUsage
  // And its prompt cache, so a parked chat still goes cold on time.
  promptCache?: PromptCacheReading
  // The prompts the sidecar persisted, oldest first, so the conversation peek
  // for a parked chat survives the restart along with the screen.
  peekPrompts?: SessionPrompt[]
  replaySnapshot?: string
  // Raw retained pty stream, used only when no serialized snapshot could be
  // built — seeds the replay buffer so reveal still paints something.
  rawReplay?: string
  at?: number
}

// Durable freeze-the-view: materialize a suspended session from a persisted
// snapshot sidecar after an app restart, so the existing pause/replay/resume
// flow treats it exactly like a session suspended in this process: processAlive
// false, `suspended` true, painted content preferred from `replaySnapshot`.
// There is no pty behind it; resume disposes it and re-spawns under the same
// session id.
export function createSuspendedPlaceholderSession(input: SuspendedPlaceholderSessionInput): TerminalSession {
  const at = input.at ?? Date.now()
  const session: TerminalSession = {
    sessionId: input.sessionId,
    process: createInactiveTerminalProcess(),
    sender: input.sender ?? createNoopWebContents(),
    isReady: true,
    hasExited: false,
    exitedAt: null,
    isDisposed: false,
    suspended: true,
    // At rest since the turn ended when the sidecar knows it, else since the
    // sidecar was written. The quit path writes every agent's sidecar at one
    // moment, so without the turn end every rehydrated row read the same
    // "idle since the app quit" (owner, 2026-09-05).
    activity: { kind: 'idle', since: input.lastTurnEndedAt ?? input.savedAt },
    // A frozen view is at rest by construction — stamped, not guessed from
    // output timing (an in-process suspend keeps the live phase; this is the
    // restart-rehydration path, where no phase survived).
    ...((input.kind ?? 'agent') === 'agent'
      ? {
          agentState: {
            phase: 'idle' as const,
            since: input.lastTurnEndedAt ?? input.savedAt,
            source: 'lifecycle' as const,
          },
        }
      : {}),
    lastTurnEndedAt: input.lastTurnEndedAt ?? null,
    output: new TerminalReplayBuffer(),
    replaySnapshot: input.replaySnapshot,
    kind: input.kind ?? 'agent',
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    terminalId: input.terminalId,
    cliSessionId: input.cliSessionId,
    cli: input.cli,
    hostId: input.hostId,
    cwd: input.cwd,
    executionMode: input.executionMode,
    worktreeId: input.worktreeId,
    worktreePath: input.worktreePath,
    observedCheckout: input.observedCheckout,
    fileChanges: input.fileChanges,
    contextUsage: input.contextUsage,
    promptCache: input.promptCache,
    ...(input.peekPrompts?.length
      ? { peekPrompts: input.peekPrompts, lastPrompt: input.peekPrompts[input.peekPrompts.length - 1] }
      : {}),
    agentSession: undefined,
    visible: false,
    // The rehydration moment, NOT savedAt: getTerminalLastSeenAt feeds the 24h
    // stale backstop, and dating the placeholder from its suspend time would let
    // the backstop dispose it (deleting the sidecar) the moment it reappears.
    startedAt: at,
    lastOutputAt: input.savedAt,
    lastInputAt: null,
    lastVisibleAt: null,
  }
  if (!input.replaySnapshot && input.rawReplay) {
    appendTerminalOutput(session, input.rawReplay, input.savedAt, false)
  }
  return session
}

// `markAsRealOutput` lets the caller append bytes to the scrollback WITHOUT
// advancing `lastOutputAt`. Host-triggered repaints (an alt-screen TUI redrawing
// after a resize on mount/reveal) are real bytes but NOT agent activity, so they
// must keep the painted buffer complete while never bumping recency/liveness —
// otherwise opening a workspace makes its agents look "active" and reorders the
// sidebar. The repaint window is set in `safeResizeTerminal`.
//
// Returns the chunk's UTF-8 byte length, measured once here and handed on to
// the output batcher rather than measured again at every step.
//
// The budget is always the recent tier's. The tier is decided by the newest of
// the session's activity stamps, and a chunk arriving now IS activity now, so
// a session receiving output is by definition inside the recent window; this
// used to be worked out by copying the whole session per chunk to ask. The
// standard tier only applies to a session that has gone quiet, and it is
// applied when that session is next read (compactTerminalReplayToLimit).
export function appendTerminalOutput(
  session: TerminalSession,
  data: string,
  at = Date.now(),
  markAsRealOutput = true,
): number {
  const bytes = session.output.append(data, TERMINAL_RECENT_REPLAY_BYTES)
  if (markAsRealOutput) session.lastOutputAt = at
  return bytes
}

/**
 * How far into a cut replay to look for somewhere safe to start. A terminal
 * line is tens of bytes and an alt-screen paint opens with an escape sequence
 * almost immediately, so the resync point is always within a few hundred; the
 * window exists so that a buffer holding one pathological line — a `cat` of a
 * minified file, a progress bar drawn with carriage returns alone — loses a
 * scrap of garbage at worst instead of its entire scrollback.
 */
const REPLAY_RESYNC_WINDOW_BYTES = 8 * 1024

/**
 * `text` from the first point a terminal can safely start reading it.
 *
 * Only ever called on a replay whose head was CUT (see `output.truncated`), and
 * that cut is the whole problem: chunks are pty read boundaries, not escape
 * sequence boundaries, so dropping the oldest ones routinely leaves the window
 * starting in the middle of one. xterm has no introducer to match, so it prints
 * the remainder as text, and a chat reopened after a busy run greets its owner
 * with `38;2;139;139;140;48;2;34;34;37m` across the top of an otherwise black
 * screen (observed 2026-09-12, a Codex chat switched away from and back).
 *
 * Two resync points, whichever comes first:
 *   - an ESC, which BEGINS a sequence, so everything from there parses;
 *   - the byte after a newline, which no CSI sequence can span.
 * What sits before it is the tail of a sequence nobody can interpret, plus at
 * most a line of text that was already losing its colour with it.
 */
export function resyncTerminalReplayHead(text: string): string {
  // Already at a sequence boundary — the common case for a cut that happened to
  // land on one, and nothing to do.
  if (text.charCodeAt(0) === 0x1b) return text
  const window = Math.min(text.length, REPLAY_RESYNC_WINDOW_BYTES)
  for (let index = 0; index < window; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 0x1b) return text.slice(index)
    if (code === 0x0a) return text.slice(index + 1)
  }
  // Nothing to resync to within the window. Whatever is at the head is plain
  // enough to print, and gutting the scrollback to be sure would cost more than
  // the garbage it saves.
  return text
}

/**
 * The retained output appended after `cursor` (a value of
 * `output.appendedUnits` from an earlier read — UTF-16 units, as the text is
 * measured), plus the cursor to pass next time. Only the newest bytes that can
 * cover the gap are decoded, so a caller polling a busy session pays for what
 * is new rather than for the whole scrollback on every poll. When eviction has
 * already dropped part of the gap, what is still retained is returned and
 * `truncated` says so.
 */
export function readTerminalOutputSince(
  session: TerminalSession,
  cursor: number,
): { text: string; cursor: number; truncated: boolean } {
  const output = session.output
  const end = output.appendedUnits
  const retainedFrom = end - output.retainedUnits
  const from = Math.max(0, cursor, retainedFrom)
  const wanted = end - from
  if (wanted <= 0) return { text: '', cursor: end, truncated: false }
  // No UTF-16 unit takes more than three UTF-8 bytes, so the newest
  // `wanted * 3` bytes always hold the `wanted` units asked for.
  const { text } = output.tail(wanted * 3)
  return { text: text.slice(text.length - wanted), cursor: end, truncated: cursor < retainedFrom }
}

export function materializeTerminalReplay(session: TerminalSession): string {
  compactTerminalReplayToLimit(session)
  const replay = session.output.materialize()
  // A buffer that has never been cut is replayed byte for byte: its head is
  // where the CLI itself started, and resyncing would eat the banner.
  return session.output.truncated ? resyncTerminalReplayHead(replay) : replay
}

/**
 * Let go of the retained stream. The painted screen a paused agent reopens on is
 * its `replaySnapshot`, so once that exists the raw bytes behind it are several
 * megabytes of nothing anyone will read.
 */
export function releaseTerminalOutput(session: TerminalSession): void {
  session.output.clear()
}

/**
 * Everything a SETTLED session held for its views: the stream, the painted
 * screen, the ledger, the prompts. Called when a session is disposed, so the
 * memory goes at once rather than whenever the last closure holding the
 * session object (a pty exit handler, a pending git resolution) lets go.
 */
export function releaseSettledTerminalSession(session: TerminalSession): void {
  session.output.clear()
  session.replaySnapshot = undefined
  session.fileChanges = undefined
  session.foldedFileChanges = undefined
  session.peekPrompts = undefined
  session.statusLine = undefined
  session.rendererDeliveredTo = undefined
}

// What one session's ledger is allowed to cost. It rides every snapshot
// broadcast to every window, so it cannot be unbounded: a run that touches
// thousands of files would turn each IPC send into a large one. Two bounds,
// because either alone is a lie — a path is capped at 4096 characters, so five
// hundred of them is megabytes, while five hundred ordinary paths is tens of
// kilobytes. Past either bound the LEAST recently edited entry is dropped: the
// list is read newest-first, so what falls off the end is what nobody was
// looking at.
export const MAX_SESSION_FILE_CHANGES = 500
export const MAX_SESSION_FILE_CHANGE_PATH_CHARS = 64 * 1024

/**
 * Fold one reported edit into the session's ledger. Counts ACCUMULATE (a line
 * edited twice counts twice — see SessionFileChange), `edits` counts the tool
 * calls, and the entry is re-inserted so the map's last key is always the most
 * recent edit.
 *
 * Returns whether anything changed, which is what decides whether the caller
 * broadcasts. An edit always changes something (`edits` at minimum), so this is
 * true whenever a well-formed change arrives — the return value exists so the
 * call site reads like the other observations, and so a future no-op case has
 * somewhere to live.
 */
/**
 * How many recent folds the duplicate ring remembers. A duplicate arrives
 * within milliseconds of its twin (two hook processes on one tool call), so the
 * window only has to outlive the burst of frames one call produces — a Codex
 * multi-file patch is the widest, at one frame per file. 128 covers that many
 * times over and costs a few KB.
 */
/** One fold the ring remembers: when, and which tool call (null for an id-less reporter). */
export type FoldedFileChange = { at: number; toolUseId: string | null }

export const MAX_FOLDED_FILE_CHANGE_KEYS = 128

/**
 * How far apart two IDENTICAL file changes with no tool-call id may be and
 * still be read as one edit reported twice. Cursor's `afterFileEdit` is the
 * only reporter shape with no id; a second registration's copy of a frame
 * arrives in the same instant, while a person's agent genuinely re-making the
 * identical edit to the identical file is seconds of model output away.
 */
export const DUPLICATE_FILE_CHANGE_WINDOW_MS = 3000

/**
 * Whether this file change is one this session has NOT already folded — true
 * for a first sighting (which it records), false for a duplicate.
 *
 * Two keys, because not every reporter has an id to give:
 *
 *   - With a `toolUseId`, the key is `(toolUseId, path)`. The id is the CLI's,
 *     so both registrations of the reporter forward the SAME one for one tool
 *     call, and a genuinely second edit is a second call with a different id.
 *     The PATH is in the key because one call legitimately reports several
 *     files — a MultiEdit across files, a Codex multi-file patch — as N frames
 *     under one id, and every one of them must fold. No time window on this
 *     key: a duplicate registration's copy is a duplicate however late it
 *     lands, and a reporter RETRYING a socket write that failed is safe either
 *     way — the failed write never reached this ring, so the retry is the
 *     first arrival and folds; a retry of one that did land is caught.
 *   - Without one, the key is the change's whole shape — path, both counts and
 *     the edit regions — and it only counts as a duplicate inside
 *     DUPLICATE_FILE_CHANGE_WINDOW_MS of the fold it matches. A second
 *     identical edit that fast is a second registration; the same edit made
 *     again ten seconds later is a real one, and re-folds (and re-stamps the
 *     key, so a third arrival is measured from the second).
 *
 * Claude Code's parallel edits share no id BETWEEN calls — each tool call has
 * its own — so two concurrent edits to different files both fold on either key.
 */
export function noteFoldedFileChange(
  session: TerminalSession,
  change: { path: string; additions: number; deletions: number; edits?: unknown },
  toolUseId: string | undefined,
  at: number,
): boolean {
  const ring = (session.foldedFileChanges ??= new Map<string, FoldedFileChange>())
  // BOTH keys, always. The two registrations of one edit need not agree on
  // whether they carry an id: a stale plugin copy left over from before the
  // reporter forwarded tool-call ids fires an id-less frame beside the current
  // reporter's id-bearing one (seen live, 2026-09-09), and two keys that never
  // meet fold the edit twice. So the shape key is checked and stamped on every
  // frame, and the id key in addition when there is one. The shape match only
  // counts when at least one of the two frames is id-less: two frames with two
  // DIFFERENT ids are two tool calls by the CLI's own word, however alike.
  const shapeKey = `shape\u0000${change.path}\u0000${change.additions}\u0000${change.deletions}\u0000${
    change.edits ? JSON.stringify(change.edits) : ''
  }`
  const idKey = toolUseId ? `id\u0000${toolUseId}\u0000${change.path}` : null
  const byShape = ring.get(shapeKey)
  const shapeSaysDuplicate =
    byShape !== undefined &&
    Math.abs(at - byShape.at) <= DUPLICATE_FILE_CHANGE_WINDOW_MS &&
    (!toolUseId || !byShape.toolUseId || byShape.toolUseId === toolUseId)
  if ((idKey !== null && ring.has(idKey)) || shapeSaysDuplicate) return false
  if (byShape !== undefined) ring.delete(shapeKey)
  const entry: FoldedFileChange = { at, toolUseId: toolUseId ?? null }
  ring.set(shapeKey, entry)
  if (idKey !== null) ring.set(idKey, entry)
  while (ring.size > MAX_FOLDED_FILE_CHANGE_KEYS) {
    const oldest = ring.keys().next().value
    if (oldest === undefined) break
    ring.delete(oldest)
  }
  return true
}

export function recordSessionFileChange(
  session: TerminalSession,
  change: { path: string; additions: number; deletions: number },
  at: number,
): boolean {
  const ledger = (session.fileChanges ??= new Map<string, SessionFileChange>())
  const existing = ledger.get(change.path)
  // Delete before set so the entry moves to the end of the insertion order:
  // that order is the recency order the snapshot reads back. Only when this
  // observation is actually the newest one for the file — a late-arriving
  // earlier edit adds its lines where the file already sits rather than
  // promoting it past files edited after it. (`set` on an existing key keeps
  // its position.)
  if (existing && at >= existing.lastEditedAt) ledger.delete(change.path)
  ledger.set(change.path, {
    path: change.path,
    additions: (existing?.additions ?? 0) + change.additions,
    deletions: (existing?.deletions ?? 0) + change.deletions,
    edits: (existing?.edits ?? 0) + 1,
    // A frame that arrives out of order must not move the ledger backwards.
    lastEditedAt: Math.max(existing?.lastEditedAt ?? 0, at),
  })
  evictOldestFileChangesPastBudget(ledger)
  session.fileChangesVersion = (session.fileChangesVersion ?? 0) + 1
  return true
}

/** Drop least-recently-edited entries until the ledger is inside both bounds. */
function evictOldestFileChangesPastBudget(ledger: Map<string, SessionFileChange>): void {
  let pathChars = 0
  for (const path of ledger.keys()) pathChars += path.length
  while (ledger.size > MAX_SESSION_FILE_CHANGES || pathChars > MAX_SESSION_FILE_CHANGE_PATH_CHARS) {
    const oldest = ledger.keys().next().value
    if (oldest === undefined) break
    // Never evict the only entry: the newest edit is the one thing the ledger
    // must always be able to state, however long its path.
    if (ledger.size === 1) break
    ledger.delete(oldest)
    pathChars -= oldest.length
  }
}

/**
 * Where the snapshot's `pullRequests` come from (epic `pull-request-marks`,
 * decision 10). The record that owns them is the Studio server's
 * (`src/server/pull-requests/`), and the shell's client of it
 * (`terminal-pull-requests.ts`) is wired in by the app rather than imported here: this module knows a session, not a
 * checkout's GitHub history, and a session snapshot must stay buildable in a
 * test with no store behind it. Unset — a plain terminal, a test, main before
 * the record exists — every snapshot simply carries an empty list.
 */
export type SessionPullRequestReader = (session: TerminalSession) => BranchPullRequest[]

let readSessionPullRequests: SessionPullRequestReader | null = null

export function setSessionPullRequestReader(reader: SessionPullRequestReader | null): void {
  readSessionPullRequests = reader
}

export function listSessionPullRequests(session: TerminalSession): BranchPullRequest[] {
  if (!readSessionPullRequests) return []
  try {
    return readSessionPullRequests(session)
  } catch {
    // A snapshot is built on every broadcast; a store that threw must cost a
    // list, never a session.
    return []
  }
}

/** The ledger as the renderer reads it: newest-edited first. */
export function listSessionFileChanges(session: TerminalSession): SessionFileChange[] {
  if (!session.fileChanges || session.fileChanges.size === 0) return []
  return [...session.fileChanges.values()].reverse()
}

/**
 * Rebuild a ledger from a persisted (newest-first) list — the snapshot sidecar,
 * which is a file on disk and therefore untrusted input like any other. Shape
 * is checked here; the entries are re-inserted oldest-first so the recency
 * order survives the round trip.
 */
export function parseSessionFileChanges(raw: unknown): Map<string, SessionFileChange> | undefined {
  if (!Array.isArray(raw)) return undefined
  const ledger = new Map<string, SessionFileChange>()
  const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
  // Read the head of the list — it is newest-first — rather than reversing the
  // whole thing: a corrupt file naming a million entries must not buy itself a
  // million iterations on the main thread during rehydration. Inserted in
  // reverse so the map's insertion order comes back as the recency order.
  const head = raw.slice(0, MAX_SESSION_FILE_CHANGES).reverse()
  for (const entry of head) {
    if (!entry || typeof entry !== 'object') continue
    const candidate = entry as Partial<SessionFileChange>
    // The same rules the socket applies (agent-state.ts): a sidecar is a file on
    // disk, no more trusted than a reporter frame, and this path is broadcast to
    // every window and keyed on.
    if (typeof candidate.path !== 'string' || !isValidFileChangePath(candidate.path)) continue
    if (!isCount(candidate.additions) || !isCount(candidate.deletions) || !isCount(candidate.edits)) continue
    if (!isCount(candidate.lastEditedAt)) continue
    ledger.delete(candidate.path)
    ledger.set(candidate.path, {
      path: candidate.path,
      additions: Math.min(Math.floor(candidate.additions), MAX_FILE_CHANGE_COUNT),
      deletions: Math.min(Math.floor(candidate.deletions), MAX_FILE_CHANGE_COUNT),
      edits: Math.min(Math.floor(candidate.edits), MAX_FILE_CHANGE_COUNT),
      lastEditedAt: Math.floor(candidate.lastEditedAt),
    })
    evictOldestFileChangesPastBudget(ledger)
  }
  return ledger.size > 0 ? ledger : undefined
}

/**
 * Prompts read back from a snapshot sidecar — a file on disk, and therefore
 * untrusted input, however this app wrote it. Shape and bounds are re-applied
 * here rather than assumed: the caps are the live path's own
 * ({@link MAX_LIVE_PEEK_PROMPTS} entries, MAX_AGENT_PROMPT_LENGTH each), so a
 * hand-edited or corrupt file can put nothing on a card that the hook itself
 * could not have.
 */
export function parseSessionPrompts(raw: unknown): SessionPrompt[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const prompts: SessionPrompt[] = []
  // The head, not the whole list: a file naming a million prompts must not buy
  // itself a million iterations on the main thread during rehydration. The list
  // is oldest-first and the first entry is the one the card quotes in full, so
  // the head is also the half worth keeping.
  for (const entry of raw.slice(0, MAX_LIVE_PEEK_PROMPTS)) {
    if (!entry || typeof entry !== 'object') continue
    const candidate = entry as Partial<SessionPrompt>
    if (typeof candidate.text !== 'string') continue
    const text = candidate.text.slice(0, MAX_AGENT_PROMPT_LENGTH)
    if (!text.trim()) continue
    if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at) || candidate.at < 0) continue
    prompts.push({ text, at: Math.floor(candidate.at) })
  }
  return prompts.length > 0 ? prompts : undefined
}

/**
 * The session's own status line, as its last reading left it. Everything except
 * `at` is optional for the same reason the frame's fields are: the CLI reports
 * what it knows.
 */
export type SessionStatusLine = {
  usedPercentage?: number
  contextWindowSize?: number
  totalCostUsd?: number
  linesAdded?: number
  linesRemoved?: number
  model?: string
  sessionName?: string
  promptCache?: PromptCacheReading
  // When the reading that produced this state arrived. Also the ordering guard:
  // a status line refreshes several times a turn and its frames can be
  // delivered out of order.
  at: number
}

/**
 * Whether a status line's usage windows are worth handing to the usage-limit
 * store, which dates a reading by the frame that carried it and keeps the
 * latest. The CLI repeats the windows of its last API response on every
 * refresh, idle or not: an idle terminal re-sending 12% would overwrite a
 * chat's newer 95% and look fresh doing it. The windows are news when they
 * moved, or when the session's cost did, which takes a new API response, so
 * they are current even when they read the same.
 */
export function statusLineRateLimitsAreNews(
  session: TerminalSession,
  rateLimits: unknown,
  totalCostUsd: number | undefined,
): boolean {
  const reading = JSON.stringify([rateLimits, totalCostUsd ?? null])
  if (session.forwardedRateLimits === reading) return false
  session.forwardedRateLimits = reading
  return true
}

/**
 * Fold one status-line reading into the session.
 *
 * Returns whether the SNAPSHOT changed — that is, whether the whole-percent
 * context usage (or the window it is a percent of) moved. That is the only part
 * of this that a window renders today besides the prompt cache,
 * and the status line refreshes after every assistant message: broadcasting on
 * a cost that ticked by a thousandth of a cent would be a broadcast per turn
 * per session for nothing anyone can see.
 *
 * The reading MERGES rather than replaces. A payload whose `used_percentage` is
 * null (before the first API call, and again right after a /compact) arrives
 * with the field simply absent, and must not take the cost, the model or the
 * last known percentage with it.
 *
 * `contextUsage.at` is the moment the percentage LAST MOVED, not the moment of
 * the last reading, so that what is held is exactly what was last broadcast —
 * a timestamp that advanced silently on every refresh would drift away from
 * every window and from the sidecar written off it.
 *
 * Unlike the file ledger beside it, a reading is NOT order-independent: it is a
 * level, not a sum, so a late-arriving older one is dropped rather than folded.
 */
export function recordSessionStatusLine(
  session: TerminalSession,
  reading: AgentStateFrameStatusLine,
  at: number,
): boolean {
  const previous = session.statusLine
  // Out of order: a status-line process is spawned per refresh and they can
  // finish in any order. An older reading carries older facts, and the next
  // refresh repairs anything this drops.
  if (previous && previous.at > at) return false
  session.statusLine = { ...previous, ...reading, at }

  let changed = false
  if (reading.promptCache && !samePromptCacheReading(session.promptCache, reading.promptCache)) {
    session.promptCache = reading.promptCache
    changed = true
  }
  // The window size comes from the MERGED reading: a refresh that carries the
  // percentage need not repeat the size, and one that carries only the size
  // (before the first API call) has no percentage to hang it on yet.
  const contextWindowSize = session.statusLine.contextWindowSize
  const usedPercentage = reading.usedPercentage ?? session.contextUsage?.usedPercentage
  if (
    usedPercentage !== undefined &&
    (session.contextUsage?.usedPercentage !== usedPercentage ||
      session.contextUsage?.contextWindowSize !== contextWindowSize)
  ) {
    session.contextUsage = {
      usedPercentage,
      // Only a moved PERCENT re-stamps `at`; a new window size (a model switch)
      // is the same reading described against a different whole.
      at: session.contextUsage?.usedPercentage === usedPercentage ? session.contextUsage.at : at,
      ...(contextWindowSize !== undefined ? { contextWindowSize } : {}),
    }
    changed = true
  }
  return changed
}

/**
 * Read a persisted context reading back off the snapshot sidecar. A file on
 * disk is untrusted input like a reporter frame, so this applies the same rules
 * the socket does (whole percent, 0..100, a real timestamp).
 */
export function parseSessionContextUsage(raw: unknown, now = Date.now()): SessionContextUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const candidate = raw as Partial<SessionContextUsage>
  const { usedPercentage, at } = candidate
  if (typeof usedPercentage !== 'number' || !Number.isFinite(usedPercentage)) return undefined
  if (usedPercentage < 0 || usedPercentage > 100) return undefined
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) return undefined
  // Clamped to arrival, exactly as a reporter frame's `ts` is: a far-future
  // time on disk would be re-written to the sidecar on the next suspend and
  // ride into every window from there.
  const usage: SessionContextUsage = { usedPercentage: Math.round(usedPercentage), at: Math.min(Math.floor(at), now) }
  // Optional, and dropped alone when bad: a sidecar written before the field
  // existed, or a mangled size, still keeps its percentage.
  const size = candidate.contextWindowSize
  if (typeof size === 'number' && Number.isFinite(size) && size > 0) usage.contextWindowSize = Math.floor(size)
  return usage
}

/**
 * A session snapshot without its two lists — the file ledger (up to 500
 * entries) and the pull request marks. The sessions broadcast sends this for
 * every session that changed and adds a list only when that list itself moved;
 * {@link getTerminalSnapshot} is the whole thing, for `terminal:list` and the
 * remote transports.
 */
export type TerminalSessionSnapshotBase = Omit<TerminalSessionSnapshot, 'fileChanges' | 'pullRequests'>

export function getTerminalSnapshotBase(session: TerminalSession): TerminalSessionSnapshotBase {
  compactTerminalReplayToLimit(session)
  return {
    sessionId: session.sessionId,
    processAlive: isTerminalProcessAlive(session),
    kind: session.kind,
    pathStyle: session.pathStyle,
    ...(session.hostId ? { hostId: session.hostId } : {}),
    workspaceId: session.workspaceId,
    ...(session.launchWorkspaceId ? { launchWorkspaceId: session.launchWorkspaceId } : {}),
    agentId: session.agentId,
    agentName: session.agentName,
    terminalId: session.terminalId,
    cliSessionId: session.cliSessionId,
    cli: session.cli,
    cwd: session.cwd,
    executionMode: session.executionMode,
    worktreeId: session.worktreeId,
    worktreePath: session.worktreePath,
    observedCheckout: session.observedCheckout,
    agentSession: session.agentSession,
    agentRecord: session.agentRecord,
    visible: session.visible,
    suspended: session.suspended ?? false,
    reapExempt: session.reapExempt ?? false,
    startedAt: session.startedAt,
    lastOutputAt: session.lastOutputAt,
    lastInputAt: session.lastInputAt,
    lastVisibleAt: session.lastVisibleAt,
    activity: session.activity,
    // Verbatim: agents carry lifecycle-stamped state from birth (`starting`
    // at spawn, hook frames thereafter, `stalled`/`exited`/`failed` from the
    // watchdog and pty lifecycle). Nothing is guessed from output timing, and
    // plain terminals carry none.
    agentState: session.agentState,
    lastPrompt: session.lastPrompt,
    activeSubagents: session.backgroundWork ?? 0,
    // The status-line forwarder's reading, or null for a session whose CLI has
    // no status line and for one that has not made an API call yet.
    contextUsage: session.contextUsage ?? null,
    promptCache: session.promptCache ?? null,
    lastKeyInputAt: session.lastKeyInputAt ?? null,
    lastTurnEndedAt: session.lastTurnEndedAt ?? null,
    exitedAt: session.exitedAt,
    outputBufferLength: session.output.retainedUnits,
    retainedOutputBytes: session.output.retainedBytes,
    historyTier: getTerminalHistoryTier(session),
    replayLimitBytes: getTerminalReplayLimitBytes(session),
  }
}

export function getTerminalSnapshot(session: TerminalSession): TerminalSessionSnapshot {
  return {
    ...getTerminalSnapshotBase(session),
    // What this agent has edited, newest first. Hook truth; a session with no
    // hooks reports an empty ledger, never absence.
    fileChanges: listSessionFileChanges(session),
    // Where this conversation's work went, newest first. Empty until its
    // checkout resolves and GitHub has actually been asked — the app draws a
    // mark only for a pull request it definitely has.
    pullRequests: listSessionPullRequests(session),
  }
}

// A session that has gone quiet for a day drops to the standard tier's budget
// the next time anything reads it.
function compactTerminalReplayToLimit(session: TerminalSession, now = Date.now()): void {
  const limit = getTerminalReplayLimitBytes(session, now)
  if (session.output.retainedBytes > limit) session.output.evict(limit)
}

function sessionActivitiesEqual(first: SessionActivity, second: SessionActivity): boolean {
  if (first.kind !== second.kind) return false
  if (first.kind === 'working' && second.kind === 'working') return first.since === second.since
  if (first.kind === 'idle' && second.kind === 'idle') return first.since === second.since
  if (first.kind === 'exited' && second.kind === 'exited') {
    return first.at === second.at && first.exitCode === second.exitCode
  }
  if (first.kind === 'failed' && second.kind === 'failed') {
    return first.at === second.at && first.exitCode === second.exitCode && first.message === second.message
  }
  return false
}

function createInactiveTerminalProcess(): pty.IPty {
  return {
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as pty.IPty
}

function createNoopWebContents(): WebContents {
  return {
    isDestroyed: () => true,
    send: () => undefined,
  } as unknown as WebContents
}

/**
 * Event sink for sessions spawned with no window (a headless launch). Every
 * outbound send is guarded on
 * `isDestroyed()`, so a headless session simply emits nothing until a window
 * attaches — the reattach path (`spawnTerminalFromIpc` existing-session
 * branch) then adopts the real WebContents and replays scrollback.
 */
export function createHeadlessTerminalSender(): WebContents {
  return createNoopWebContents()
}
