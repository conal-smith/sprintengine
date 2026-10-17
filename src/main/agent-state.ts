import { existsSync, readFileSync } from 'fs'
import { copyFile, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, join, resolve, sep } from 'path'
import type { AgentPhase, AgentStateSource, SessionActivity } from '../shared/electron-api'
import type { PluginAgentStateSpec } from '../shared/plugin-manifest'
import { isAbsoluteObservedPath, MAX_OBSERVED_CWD_LENGTH } from '../shared/observed-checkout'
import { isRecord } from '../shared/records'
import { parsePromptCacheReading, type PromptCacheReading } from '../shared/prompt-cache'
import { isClaudeUsageWindowId } from '../shared/usage-limits'
import type { StatusLineRateLimit } from './usage-limits/sources'
import type { ChangelistEdit } from '../shared/git/changelists'
import { resolveClaudeConfigDir } from './claude-config-dir'
import { withConfigFileLock, writeFileAtomically } from './config-file-write'
import {
  buildLauncherCommand,
  launcherCommandPattern,
  usableLocalLauncherRef,
  type StudioLauncherRef,
} from './integrations/launcher'
import { recordIntegrationWrite } from './integrations/ledger'
import { runGitCommand } from './git-run'

// =============================================================================
// Authoritative agent state — pure core (no Electron deps, fully unit-testable)
//
// This module owns three concerns that need no main-process runtime:
//   1. Resolving a reporter frame against a CLI's manifest-declared
//      `agentStateSpec` (event → AgentPhase, discriminators, turn-end flags).
//      The per-CLI vocabulary is DATA on each plugin manifest, never code here.
//   2. The AgentPhase → legacy SessionActivity bridge (so existing consumers
//      keep working untouched while the richer phase rides alongside).
//   3. Validating an untrusted reporter frame and (un)installing the reporter
//      into a workspace, dispatched by the spec's registration kind.
//
// The Electron-bound half (the socket listener + session resolution + renderer
// broadcast + launch-time install) lives in a sibling service module so this
// stays importable from a plain Node test harness.
// =============================================================================

export const AGENT_STATE_HOOK_TAG = 'sprintengine-agent-state'

// Where the reporter script is copied inside a workspace. The reporter also
// honours a SPRINTENGINE_AGENT_STATE_SOCKET env fallback (see the .mjs), but the
// install always passes the socket via --socket, so it is not referenced here.
export const AGENT_STATE_HOOK_SCRIPT_REL = join('.sprintengine', 'hooks', 'agent-state.mjs')

// =============================================================================
// Frame resolution against a manifest agentStateSpec
//
// The reporter forwards the RAW event name (plus the payload discriminator
// fields the specs consult — today only `notificationType`); the mapping to a
// phase happens HERE, from the resolving plugin's manifest data. That keeps
// every CLI's vocabulary in one authored, validated place and out of the
// reporter scripts, which used to carry a second copy that had to be mirrored
// by hand.
//
// Turn-end and turn-failure ride the same table as per-event flags, raw-event-
// level deliberately: several events share a phase (Claude's Stop and
// SubagentStop both map to `idle`; OpenCode's session.error maps to `idle` like
// its session.idle), so only the event name can tell a session's turn end from
// a subagent's, or a crash from a clean finish. Consumers read the computed
// flags off the phase event, never event names.
// =============================================================================

export type AgentStateEventResolution =
  | { action: 'drop' }
  | { action: 'apply'; phase: AgentPhase; turnEnd: boolean; turnFailure: boolean; background?: 'start' | 'stop' }

export type AppliedAgentStateEvent = Extract<AgentStateEventResolution, { action: 'apply' }>

/**
 * Fold an event name to the form event matching compares on: lower-cased with
 * `_` and `-` removed, so `PreToolUse`, `pre_tool_use`, `pre-tool-use` and
 * `preToolUse` are all one event.
 *
 * Why this exists: a CLI's CONFIG spelling and its PAYLOAD spelling
 * need not agree. Grok Build reads `PreToolUse` in `.grok/hooks/*.json` (and
 * accepts the snake_case and Cursor camelCase spellings there too) but stamps
 * the payload `"hookEventName": "pre_tool_use"`. Matching the manifest's
 * PascalCase against that frame exactly dropped EVERY Grok frame, so a Grok
 * agent never left `starting` until the stall watch flagged it.
 *
 * One fold, not per-event aliases: an alias table is a second vocabulary to
 * maintain per CLI, and it is silently wrong for the next event nobody listed.
 * The manifests keep the CLI's own written spelling (Grok/Claude PascalCase,
 * Cursor camelCase, OpenCode dotted) — this only decides EQUALITY.
 *
 * `.` is deliberately NOT stripped: OpenCode's `session.idle` /
 * `tool.execute.before` are structured names whose dots separate real segments,
 * and folding them would collapse distinct events.
 *
 * Collision safety is a per-manifest property (two entries in ONE spec must not
 * fold together); every shipped manifest is checked by test, since the first
 * canonical match wins.
 */
export function canonicalEventName(event: string): string {
  return event.replace(/[_-]/g, '').toLowerCase()
}

// Read the frame field a discriminator NAMES, never a hardcoded one, so a
// widened field enum can't silently misread.
function discriminatorValue(
  field: 'notificationType' | 'status',
  frame: Pick<AgentStateFrame, 'notificationType' | 'status'>,
): string | undefined {
  return field === 'notificationType' ? frame.notificationType : frame.status
}

export function resolveAgentStateEvent(
  spec: PluginAgentStateSpec | null | undefined,
  frame: Pick<AgentStateFrame, 'event' | 'phase' | 'notificationType' | 'status'>,
): AgentStateEventResolution {
  if (spec && frame.event) {
    // Canonical, not exact: the frame carries the CLI's PAYLOAD spelling, which
    // can differ in case/underscores from the manifest's written form (see
    // canonicalEventName). An exact compare dropped every Grok frame.
    const frameEvent = canonicalEventName(frame.event)
    const entry = spec.events.find((candidate) => canonicalEventName(candidate.event) === frameEvent)
    // An event the spec does not name carries no phase for this CLI — the
    // prior phase stands. (This is also what makes a discriminator allow-list
    // fail SAFE: see below.)
    if (!entry) return { action: 'drop' }
    // Failure discriminator: a turn-end whose payload carries the outcome
    // (Cursor's stop status error|aborted) counts as a failed turn — a crash
    // finalized as completed opens a PR from failed work.
    const failureValue = entry.failureWhen ? discriminatorValue(entry.failureWhen.field, frame) : undefined
    const turnFailure =
      entry.failure === true ||
      Boolean(entry.failureWhen && failureValue && entry.failureWhen.oneOf.includes(failureValue))
    if (entry.when) {
      // Discriminator: the phase applies only for allow-listed payload values.
      // Claude's `Notification` is the canonical case — it fires for real
      // permission/elicitation prompts AND informational nudges (idle_prompt),
      // and `awaiting_input` is sticky for a dormant agent, so an unlisted or
      // absent value must drop (falsely "needs input" parks a session forever;
      // a false idle is recoverable — the 2026-07-07 parked-agents incident).
      const value = discriminatorValue(entry.when.field, frame)
      if (!value || !entry.when.oneOf.includes(value)) {
        // Stale-reporter compatibility: a reporter copy from before the
        // dumb-forwarder change filtered discriminated events CLIENT-side and
        // asserted the mapped phase without forwarding the discriminator
        // field. Until the next successful install replaces it (install is
        // best-effort and can fail on e.g. a read-only tree), honor its own
        // filtering: no discriminator + the exact phase this entry maps to
        // means the old allow-list already passed. Anything else drops.
        if (!value && frame.phase === entry.phase) {
          return {
            action: 'apply',
            phase: entry.phase,
            turnEnd: entry.turnEnd === true,
            turnFailure,
            ...(entry.background ? { background: entry.background } : {}),
          }
        }
        return { action: 'drop' }
      }
    }
    return {
      action: 'apply',
      phase: entry.phase,
      turnEnd: entry.turnEnd === true,
      turnFailure,
      ...(entry.background ? { background: entry.background } : {}),
    }
  }
  // No spec (a CLI outside the manifest capability whose reporter still emits
  // frames) or an event-less frame: trust the reporter-asserted phase, with no
  // turn-end semantics — those are manifest data only.
  if (frame.phase) return { action: 'apply', phase: frame.phase, turnEnd: false, turnFailure: false }
  return { action: 'drop' }
}

// =============================================================================
// Background work (pure; the runtime keeps the count on the session)
//
// Claude Code fires `Stop` the moment the MODEL stops — including when it has
// parked itself on "Waiting for N background agents to finish" and will be
// re-invoked, with no prompt from the person, the moment they do. Read as a
// turn end, that Stop marked the sidebar row finished and finalized runs whose
// work was still in flight (owner, 2026-09-04). The manifest's `background`
// flag names the events that open and close such work (SubagentStart /
// SubagentStop); the count of what is still open decides whether a turn end
// is real.
//
// A held turn end lands on `tool_use` — the session is inside a tool whose
// result has not come back — with `turnEnd` false, so no consumer finalizes.
// A FAILED turn end is never held: an aborted or crashed turn is over whatever
// was outstanding. The count clamps at zero (a stop with nothing open is a
// subagent that started before the reporter was installed) and the runtime
// resets it on a session start (a fresh process owns nothing from its previous
// life) and on a stall (the watchdog found the pane quiet, which a live
// background agent's spinner never is — so the count had drifted).
// =============================================================================

export function applyBackgroundWork(outstanding: number, background: 'start' | 'stop' | undefined): number {
  if (background === 'start') return outstanding + 1
  if (background === 'stop') return Math.max(0, outstanding - 1)
  return outstanding
}

/**
 * Whether a background start was already answered by a stop that closed
 * nothing: it is stamped at or before the newest such stop.
 *
 * Every hook is its own reporter process, so a short subagent's `SubagentStop`
 * can land before its `SubagentStart`. The stop closes nothing (the count is at
 * zero) and moves no phase — see `keepsTurnEnd` — and when the start lands
 * after it, stamped earlier, it is not stale to the stale-frame guard, because
 * that stop never moved the phase's timestamp. Counted, it would open work that
 * nothing is left to close, and the next `Stop` would be held as working until
 * the stall watch gave up on it. So the time of each stop that closed nothing
 * is kept, and a start stamped at or before it is taken as already closed.
 *
 * Only a start stamped within a delivery window of that stop is taken: a
 * reporter delivers for up to two seconds, so only a subagent that short can
 * have its stop land first. A start that belongs to a later subagent is stamped
 * after the stop and counts, and so does one stamped well before an unrelated
 * stop — that is real work still running, and dropping it would let the agent
 * read idle, and be reclaimed, mid-subagent.
 */
export function backgroundStartAlreadyClosed(frameTs: number, unmatchedStopAt: number | null | undefined): boolean {
  if (typeof unmatchedStopAt !== 'number') return false
  return frameTs <= unmatchedStopAt && unmatchedStopAt - frameTs < TURN_END_STRAGGLER_WINDOW_MS
}

export function holdTurnEndForBackgroundWork(
  resolution: AppliedAgentStateEvent,
  outstanding: number,
): AppliedAgentStateEvent {
  if (!resolution.turnEnd || resolution.turnFailure || outstanding <= 0) return resolution
  return { ...resolution, phase: 'tool_use', turnEnd: false }
}

// =============================================================================
// Turn-end latch (pure; the runtime asks it before applying a working phase)
//
// A turn end is the one phase change a person is waiting on: it stops the
// sidebar's working clock, finalizes an automation run, and makes the agent
// reclaimable. Two kinds of frame used to undo it, and neither is the agent
// working again.
//
// 1. A background stop that closes nothing. Claude Code runs a helper agent of
//    its own after a turn and reports it with a `SubagentStop` (empty
//    `agent_type`) and no `SubagentStart`, four to five seconds after `Stop`
//    (observed on CLI 2.1.281, 2026-09-24; not after every turn). Mapped as
//    "the parent resumes", it put a finished session back on `thinking`, where
//    it stayed until the stall watch found it 90 seconds later. A stop only means the parent resumes when it closes
//    work the count holds open — that case is the held Stop above, and it
//    still works — so one that closes nothing moves no phase at all.
//
// 2. A straggler from the turn that just ended. Every hook is its own reporter
//    process, stamped when it has started up rather than when the CLI fired
//    it, and a delivery retries for up to two seconds; a `PostToolUse` spawned
//    before `Stop` can therefore carry a later timestamp and land after it. The
//    stale-frame guard cannot see that, so a short window after a turn end
//    admits only a frame that OPENS work: the person's prompt, a session
//    start, a background agent starting.
//
// The window is short on purpose. Claude Code re-invokes the model without a
// prompt (a background task finishing, a scheduled wakeup), and those turns
// report tool calls well after the Stop they follow; they must still read as
// working. And the window applies only to a CLI whose manifest reports the
// person's prompt, because only there does a real new turn have an opener to
// be recognized by — OpenCode starts one with `message.updated`, and holding
// that back would hide a turn rather than a straggler.
// =============================================================================

// Reporter delivery deadline (TOTAL_DEADLINE_MS in the reporter, 2 s) plus the
// time a reporter process takes to start and stamp its frame.
export const TURN_END_STRAGGLER_WINDOW_MS = 3_000

export function keepsTurnEnd(input: {
  spec: Pick<PluginAgentStateSpec, 'events'> | null | undefined
  event: string | null
  resolution: AppliedAgentStateEvent
  // Background work the session held open BEFORE this frame was counted.
  outstandingBefore: number
  // The phase the session is in now, and since when.
  current: { phase: AgentPhase; since: number } | null
  lastTurnEndedAt: number | null | undefined
  frameTs: number
}): boolean {
  const { resolution } = input
  if (resolution.phase !== 'thinking' && resolution.phase !== 'tool_use') return false
  // (1) Anywhere: a stop that closes nothing is not the parent resuming.
  if (resolution.background === 'stop' && input.outstandingBefore <= 0) return true
  // (2) Only while the session rests on the turn end itself.
  const turnEndedAt = input.lastTurnEndedAt
  if (turnEndedAt == null || !input.current) return false
  if (input.current.phase !== 'idle' || input.current.since !== turnEndedAt) return false
  if (resolution.background === 'start') return false
  if (input.event && PROMPT_REPORTING_EVENTS.has(canonicalEventName(input.event))) return false
  if (!agentStateSpecReportsPrompts(input.spec)) return false
  return input.frameTs - turnEndedAt < TURN_END_STRAGGLER_WINDOW_MS
}

// The registration subset of a spec's event table: what actually gets written
// into the CLI's hook config. `register: false` entries are mapped if a frame
// ever arrives (a stale registration from an older release) but never
// registered anew — e.g. Claude's PreToolUse, dropped because PostToolUse alone
// clears awaiting_input and halves the per-tool reporter spawns (the manifest
// $comment on the claude-code plugin carries the full rationale).
/**
 * The hook events on which the reporter forwards the person's prompt
 * (`resources/hooks/sprintengine-agent-state.mjs`). `UserPromptSubmit` is
 * Claude/Codex/Kimi vocabulary; Cursor spells the same moment
 * `beforeSubmitPrompt`. Named here because the reporter's list and any reader's
 * idea of "does this runtime report messages" have to be the same list.
 *
 * Held canonically (see canonicalEventName) and compared canonically, for the
 * same reason resolveAgentStateEvent does: a manifest that writes the moment
 * `user_prompt_submit` names the same event as one that writes
 * `UserPromptSubmit`, and this question must not turn on the spelling.
 */
const PROMPT_REPORTING_EVENTS: ReadonlySet<string> = new Set(
  ['UserPromptSubmit', 'beforeSubmitPrompt'].map(canonicalEventName),
)

/**
 * True when this CLI's manifest declares an event that carries what the person
 * typed. The conversation peek asks this to tell "has said nothing yet" apart
 * from "cannot report at all" — OpenCode has an agentStateSpec and still
 * forwards no prompt, so the presence of a spec is not the same question.
 */
export function agentStateSpecReportsPrompts(spec: Pick<PluginAgentStateSpec, 'events'> | null | undefined): boolean {
  return Boolean(spec?.events.some((entry) => PROMPT_REPORTING_EVENTS.has(canonicalEventName(entry.event))))
}

export function registeredAgentStateEvents(
  spec: Pick<PluginAgentStateSpec, 'events'>,
): Array<{ event: string; matcher?: string }> {
  return spec.events
    .filter((entry) => entry.register !== false)
    .map(({ event, matcher }) => (matcher === undefined ? { event } : { event, matcher }))
}

// =============================================================================
// Phase → legacy SessionActivity bridge
//
// Keeps the existing 4-variant activity field honest from the richer phase so
// every current consumer (sidebar bolding, reaping, diagnostics) keeps working.
// Returns null for terminal phases (`exited`/`failed`): a real process exit is
// owned authoritatively by the pty onExit handler, which carries the exit code
// a hook frame does not — we never synthesize an exit from a hook.
// =============================================================================

// At-rest phases the idle reaper may reclaim once rested past its threshold:
// 'idle' (authoritative turn end) and 'stalled' (inferred quiet ≥90s). Stalled
// counts as rest deliberately — a lost Stop frame lands a genuinely-finished
// agent there, and treating stalled as protected parked sessions forever
// (2026-07-07 incident). Read by the reap candidate mapping.
export function isAtRestAgentPhase(phase: AgentPhase | null | undefined): boolean {
  return phase === 'idle' || phase === 'stalled'
}

export function deriveActivityFromPhase(phase: AgentPhase, since: number): SessionActivity | null {
  switch (phase) {
    case 'starting':
    case 'thinking':
    case 'tool_use':
      return { kind: 'working', since }
    case 'awaiting_input':
    case 'idle':
    case 'stalled':
      return { kind: 'idle', since }
    case 'exited':
    case 'failed':
      return null
    default:
      return null
  }
}

// =============================================================================
// Stall evaluation (pure; the runtime drives the timer from this decision)
//
// A hook-reported working phase (`starting`/`thinking`/`tool_use`) that goes
// quiet — no newer frame and no terminal output — past the threshold is treated
// as stalled. Output advancing `lastOutputAt` (a streaming tool, a startup
// banner) or a newer frame keeps it alive; the runtime re-checks after the
// returned delay rather than firing once. `starting` is included so a resumed
// session that never receives a prompt (SessionStart is its only frame — no
// Stop ever follows) converts to `stalled` and becomes reclaimable via the
// reap policy's stalled expiry, instead of parking as "working" forever.
// =============================================================================

export type StallEvaluation = { action: 'stalled' } | { action: 'recheck'; afterMs: number } | { action: 'clear' }

export function evaluateAgentStall(input: {
  phase: AgentPhase
  source: AgentStateSource
  phaseSince: number
  lastOutputAt: number | null
  now: number
  thresholdMs: number
}): StallEvaluation {
  if (input.phase !== 'starting' && input.phase !== 'thinking' && input.phase !== 'tool_use') {
    return { action: 'clear' }
  }
  // A hook-driven working phase can stall, and so can the `starting` lifecycle
  // stamp every agent gets at spawn: a session whose hooks never fire at all (a
  // broken or failed install — there is no output-timing fallback any more)
  // must convert to `stalled` and expire via the reap policy rather than
  // reading as working, and being reaper-protected, forever. No lifecycle
  // thinking/tool_use exists to be evaluated: those only ever come from hooks.
  if (input.source !== 'hook' && input.phase !== 'starting') return { action: 'clear' }
  const lastActivityAt = Math.max(input.phaseSince, input.lastOutputAt ?? 0)
  const quietForMs = input.now - lastActivityAt
  if (quietForMs >= input.thresholdMs) return { action: 'stalled' }
  return { action: 'recheck', afterMs: input.thresholdMs - quietForMs }
}

// =============================================================================
// Untrusted frame validation
//
// Frames arrive over a local socket from a reporter process. Treat every field
// as untrusted data: validate shape and the phase enum, never act on anything
// beyond the typed fields below.
// =============================================================================

// A self-scheduled wakeup reported by the CLI's PostToolUse hook (Claude Code's
// ScheduleWakeup tool; Codex shares the hook payload schema, and the OpenCode
// adapter can emit the same field if that CLI grows an equivalent). `stop`
// tears the loop down; `delaySeconds` arms a timer inside the CLI process.
type AgentStateFrameWakeup = { stop: true } | { delaySeconds: number }

// ScheduleWakeup's runtime clamps delaySeconds to [60, 3600]. Anything past
// clamp+slack is a reporter/clock anomaly — cap it so one bad frame cannot
// park a session on a far-future hold.
export const MAX_WAKEUP_DELAY_SECONDS = 2 * 3600

// Absurd lengths are a reporter/payload anomaly, not a path. Cap so an unbounded
// untrusted string cannot ride the frame into a consumer.
export const MAX_TRANSCRIPT_PATH_LENGTH = 4096

// One file the agent's PostToolUse hook says it just changed: the path plus the
// line counts the reporter summed off the tool's own diff hunks. Never the
// patch or the content — see the reporter.
export type AgentStateFrameFileChange = {
  path: string
  additions: number
  deletions: number
  // The MINIMAL changed regions of the call, in git's hunk convention (agent
  // changelists): four small ints each, and the only thing that lets an agent's
  // changelist own the LINES it wrote in a file two agents share. Absent when
  // the reporter could not read the patch's shape — a file-level claim, which
  // is what every consumer already falls back to.
  edits?: ChangelistEdit[]
}

// A single tool call that rewrote more than this many separate regions is a
// whole-file rewrite in all but name. The reporter caps too; this is the
// enforcement, since the reporter is untrusted input.
export const MAX_FILE_CHANGE_EDITS = 200

// A path this long is a broken reporter, not a file. Same bound as the observed
// cwd, and for the same reason: the value is retained per session and broadcast
// to every renderer.
export const MAX_FILE_CHANGE_PATH_LENGTH = MAX_OBSERVED_CWD_LENGTH

// A single tool call cannot honestly add ten million lines; past that the frame
// is anomalous. Capped rather than dropped, so an absurd count degrades to a
// large one instead of erasing the fact that the file was edited.
export const MAX_FILE_CHANGE_COUNT = 10_000_000

// Same ceiling for the status line's own numbers (the context window size in
// tokens, and the session's cumulative line counts). Capped rather than dropped:
// an absurd number degrades to a large one instead of erasing the reading.
export const MAX_STATUS_LINE_COUNT = MAX_FILE_CHANGE_COUNT

// Cap on the forwarded user prompt. The reporter truncates too, but it is
// untrusted, so this is the enforcement: the value is retained per session and
// broadcast to every renderer, and an unbounded string would ride into both.
// Sized well above a title (~42 chars) because the same field feeds the tab
// hover preview, which shows several lines.
export const MAX_AGENT_PROMPT_LENGTH = 2000

export type AgentStateFrame = {
  type: 'agent_state'
  agentId: string
  workspaceId: string | null
  sessionId: string | null
  // The reporter-asserted phase. Optional: the stdin-filter reporter is a dumb
  // forwarder (event + discriminator fields only; the phase is derived in main
  // via the resolving plugin's agentStateSpec). Present on frames from the
  // OpenCode plugin reporter (which maps internally for its dedup) and from
  // stale reporter copies of older releases — consumed only when no spec entry
  // resolves the event (see resolveAgentStateEvent).
  phase?: AgentPhase
  event: string | null
  // The payload discriminator fields specs may consult (Claude's
  // `notification_type`; Cursor's turn-outcome `status`), forwarded under one
  // spelling each. Untrusted, capped.
  notificationType?: string
  status?: string
  ts: number
  wakeup?: AgentStateFrameWakeup
  // The CLI's session transcript, forwarded by the reporter on a turn end only.
  // Untrusted: this is a file path chosen by the reporter, so whoever READS it
  // owns containment (absolute + `.jsonl` + size cap). Validation here is shape
  // only, and a bad value drops the field, never the frame.
  transcriptPath?: string
  // The verbatim text the person submitted, forwarded by the reporter on
  // `UserPromptSubmit` only. Untrusted like every other reporter field: capped
  // on receipt, and a value over the cap is truncated rather than dropping the
  // frame (a long prompt is a normal prompt, not an anomaly — unlike a 4KB
  // "path", which signals a broken reporter).
  prompt?: string
  // The session's current working directory as the CLI's hook payload reports
  // it (`cwd` is in the base payload of every Claude Code / Codex / Grok hook),
  // forwarded by the reporter on every frame that carries one. A cwd
  // only changes through a tool call, so the PostToolUse frame that follows
  // carries the new one — no dedicated event is registered for it. Untrusted:
  // shape-checked on receipt (absolute, capped) and a bad value drops the
  // field, never the frame — the phase it rides with is still real.
  cwd?: string
  // The file the agent just edited, forwarded on the PostToolUse of an editing
  // tool (Edit/Write/MultiEdit/NotebookEdit). Folded into the session's file
  // ledger. Untrusted like the rest: absolute path, bounded, non-negative
  // integer counts — a bad value drops the FIELD, never the frame, so a
  // malformed count cannot cost the session its phase transition.
  fileChange?: AgentStateFrameFileChange
  // The CLI's OWN id for the tool call this frame reports, forwarded on every
  // PostToolUse-shaped frame that carries one (Claude/Codex/Kimi `tool_use_id`,
  // Grok `toolUseId`, OpenCode `callID`; Cursor's `afterFileEdit` has none).
  //
  // It exists for exactly one job: telling a SECOND registration of the same
  // reporter apart from a second edit. Two registrations — the by-hand merge in
  // `.claude/settings.local.json` and the plugin's own `hooks/hooks.json` — can
  // both be live for one session (a launch carrying the plugin directory tidies
  // the first away, but not in every case: see the ring's own note in
  // terminal-runtime.ts). They fire the same hook on the same tool call, and
  // the two frames are identical down to this id, because it is the CLI's, not
  // the reporter's. A genuinely second edit is a second tool call and carries a
  // different one. See the ring in terminal-session.ts (`noteFoldedFileChange`).
  //
  // Untrusted like the rest: bounded, control-character-free, and a bad value
  // drops the FIELD, never the frame — a frame without it falls back to the
  // ring's timestamp-windowed key rather than losing its edit.
  toolUseId?: string
  // What the session's own status line last said about itself, forwarded by the
  // status-line forwarder on `event: 'StatusLine'` — an event no manifest names,
  // so the frame's phase resolution DROPS it and the status line is folded in
  // before that drop, exactly like a file change. Every field is optional
  // because the payload's are: `usedPercentage` is null before the first API
  // call and again right after a /compact, and a session is unnamed until it is
  // named. Untrusted like the rest: a bad value drops the FIELD.
  statusLine?: AgentStateFrameStatusLine
  // A tool call that may have opened a pull request, forwarded on the
  // PostToolUse of a shell command or an MCP tool whose output holds a URL
  // (owner ruling 2026-10-04). The reporter decides nothing: the server's one
  // reader (src/shared/git/pull-request-opened.ts) does, the same one it uses
  // for a chat's calls. Untrusted like the rest: bounded, and a bad value drops
  // the FIELD, never the frame.
  toolCall?: AgentStateFrameToolCall
}

/** A forwarded tool call: its name, the shell command it ran, and its output as text. */
export type AgentStateFrameToolCall = { name: string; command?: string; output: string; failed?: boolean }

// Caps on a forwarded tool call, matched to what `pullRequests.noteToolCall`
// accepts (STUDIO_PULL_REQUESTS_MAX_COMMAND / _MAX_OUTPUT): over a cap the
// field is dropped, because a cut output could cut a URL into another one.
const MAX_TOOL_CALL_NAME_LENGTH = 200
const MAX_TOOL_CALL_COMMAND_LENGTH = 4096
const MAX_TOOL_CALL_OUTPUT_LENGTH = 32 * 1024

// One reading from a session's status line. The numbers are the CLI's own —
// nothing here is derived, and nothing else from the status-line payload (the
// transcript path, the repo identity, the prompt cache's statistics) is
// carried: see the forwarder.
//
// The rate limits are carried, as two numbers per window: a terminal session
// is the only place a subscriber who never opens a chat says where their
// five-hour and weekly windows stand. They are the account's, not the
// session's, so the ingest hands them to the usage-limit store and never
// keeps them on the session or broadcasts them with it.
export type AgentStateFrameStatusLine = {
  // 0..100, rounded to a whole percent on the way in: it is rendered as a ring
  // and a number, and a broadcast per hundredth of a percent is a broadcast per
  // token. Absent when the CLI does not know yet.
  usedPercentage?: number
  contextWindowSize?: number
  totalCostUsd?: number
  linesAdded?: number
  linesRemoved?: number
  model?: string
  sessionName?: string
  // The main conversation's prompt cache, whole: its nulls (nothing cached, a
  // re-cache size not known yet after a compaction) are part of the reading.
  promptCache?: PromptCacheReading
  // The subscription's usage windows, by the CLI's id (`five_hour`,
  // `seven_day`…): 0..100 used, and the reset in epoch ms when it said.
  rateLimits?: Record<string, StatusLineRateLimit>
}

// Cap on the two free-text status-line fields. A model display name is a word
// and a session name is a title; anything longer is a broken forwarder, and the
// value is retained per session for however long that session lives.
export const MAX_STATUS_LINE_NAME_LENGTH = 256

// And a ceiling on the cost, so that every number off this socket is bounded.
// A session cannot honestly have spent a million dollars; past that the frame is
// anomalous. Capped rather than dropped, like the counts.
export const MAX_STATUS_LINE_COST_USD = 1_000_000

const VALID_PHASES: ReadonlySet<AgentPhase> = new Set<AgentPhase>([
  'starting',
  'thinking',
  'tool_use',
  'awaiting_input',
  'idle',
  'exited',
  'failed',
  'stalled',
])

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

// Cap on the forwarded tool-call id. Every CLI's is a short opaque token
// (Claude's `toolu_…` is 29 chars); anything longer is a payload anomaly, and
// the value is only ever compared for equality, so an oversized string is
// dropped rather than truncated — a truncated id could collide with another.
export const MAX_TOOL_USE_ID_LENGTH = 256

// Cap on the forwarded discriminator value: documented notification types are
// short tokens; anything longer is a payload anomaly, and the value is compared
// against manifest allow-lists so an oversized string is dropped, not truncated.
const MAX_NOTIFICATION_TYPE_LENGTH = 128

export function parseAgentStateFrame(raw: unknown, now: number): AgentStateFrame | null {
  if (!isRecord(raw)) return null
  if (raw.type !== 'agent_state') return null
  const agentId = optionalString(raw.agentId)
  if (!agentId) return null
  // A frame must carry a raw event name (mapped in main via the resolving
  // plugin's agentStateSpec), a reporter-asserted phase (the OpenCode plugin,
  // stale reporter copies), or both. Neither ⇒ nothing to apply.
  const event = optionalString(raw.event)
  const phase =
    typeof raw.phase === 'string' && VALID_PHASES.has(raw.phase as AgentPhase) ? (raw.phase as AgentPhase) : null
  if (!event && !phase) return null
  // Clamp to server arrival time: raw.ts is reporter-supplied and compared
  // cross-clock against the main-process clock (terminal-runtime drops frames
  // where since > frame.ts, and since is written from Date.now()). A far-future
  // ts would pin the phase forever and future-date "working since"; a reporter
  // cannot legitimately be ahead of now, so cap it.
  const ts = typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? Math.min(raw.ts, now) : now
  const frame: AgentStateFrame = {
    type: 'agent_state',
    agentId,
    workspaceId: optionalString(raw.workspaceId),
    sessionId: optionalString(raw.sessionId),
    event,
    ts,
  }
  if (phase) frame.phase = phase
  const notificationType = optionalString(raw.notificationType)
  if (notificationType && notificationType.length <= MAX_NOTIFICATION_TYPE_LENGTH) {
    frame.notificationType = notificationType
  }
  const status = optionalString(raw.status)
  if (status && status.length <= MAX_NOTIFICATION_TYPE_LENGTH) {
    frame.status = status
  }
  const wakeup = parseFrameWakeup(raw.wakeup)
  if (wakeup) frame.wakeup = wakeup
  const transcriptPath = optionalString(raw.transcriptPath)
  if (transcriptPath && transcriptPath.length <= MAX_TRANSCRIPT_PATH_LENGTH) frame.transcriptPath = transcriptPath
  const prompt = optionalString(raw.prompt)
  if (prompt) {
    const trimmed = prompt.trim()
    if (trimmed) frame.prompt = trimmed.slice(0, MAX_AGENT_PROMPT_LENGTH)
  }
  const cwd = parseFrameCwd(raw.cwd)
  if (cwd) frame.cwd = cwd
  const fileChange = parseFrameFileChange(raw.fileChange)
  if (fileChange) frame.fileChange = fileChange
  const toolUseId = parseFrameToolUseId(raw.toolUseId)
  if (toolUseId) frame.toolUseId = toolUseId
  const statusLine = parseFrameStatusLine(raw.statusLine)
  if (statusLine) frame.statusLine = statusLine
  const toolCall = parseFrameToolCall(raw.toolCall)
  if (toolCall) frame.toolCall = toolCall
  return frame
}

function parseFrameToolCall(raw: unknown): AgentStateFrameToolCall | null {
  if (!isRecord(raw)) return null
  const name = optionalString(raw.name)?.trim()
  if (!name || name.length > MAX_TOOL_CALL_NAME_LENGTH || hasControlCharacters(name)) return null
  if (typeof raw.output !== 'string' || raw.output.length > MAX_TOOL_CALL_OUTPUT_LENGTH) return null
  const call: AgentStateFrameToolCall = { name, output: raw.output }
  if (raw.command !== undefined) {
    if (typeof raw.command !== 'string' || raw.command.length > MAX_TOOL_CALL_COMMAND_LENGTH) return null
    call.command = raw.command
  }
  if (raw.failed === true) call.failed = true
  return call
}

// A status-line reading, field by field: each one that fails its own rule is
// simply absent, because they are independent readings and a bad cost must not
// cost the session its context percentage. A reading with NOTHING valid in it
// drops entirely — the field then never reaches the session, which is what lets
// the ingest treat "present" as "there is something to fold".
//
// The path rules follow the file ledger's: bounded, control characters refused,
// counts finite and not negative.
function parseFrameStatusLine(raw: unknown): AgentStateFrameStatusLine | null {
  if (!isRecord(raw)) return null
  const statusLine: AgentStateFrameStatusLine = {}
  // A percentage outside 0..100 is not a percentage. Refused rather than
  // clamped: a forwarder that reports 900% has read the wrong field, and
  // clamping it to 100 would paint a full context ring on an empty session.
  const usedPercentage = raw.usedPercentage
  if (
    typeof usedPercentage === 'number' &&
    Number.isFinite(usedPercentage) &&
    usedPercentage >= 0 &&
    usedPercentage <= 100
  ) {
    statusLine.usedPercentage = Math.round(usedPercentage)
  }
  const contextWindowSize = parseStatusLineCount(raw.contextWindowSize)
  if (contextWindowSize !== null) statusLine.contextWindowSize = contextWindowSize
  // Cost is money, not a line count: it keeps the fraction the counts floor
  // away, and is refused when negative or not finite, capped when absurd.
  if (typeof raw.totalCostUsd === 'number' && Number.isFinite(raw.totalCostUsd) && raw.totalCostUsd >= 0) {
    statusLine.totalCostUsd = Math.min(raw.totalCostUsd, MAX_STATUS_LINE_COST_USD)
  }
  const linesAdded = parseStatusLineCount(raw.linesAdded)
  if (linesAdded !== null) statusLine.linesAdded = linesAdded
  const linesRemoved = parseStatusLineCount(raw.linesRemoved)
  if (linesRemoved !== null) statusLine.linesRemoved = linesRemoved
  const model = parseStatusLineName(raw.model)
  if (model) statusLine.model = model
  const sessionName = parseStatusLineName(raw.sessionName)
  if (sessionName) statusLine.sessionName = sessionName
  const promptCache = parsePromptCacheReading(raw.promptCache)
  if (promptCache) statusLine.promptCache = promptCache
  const rateLimits = parseStatusLineRateLimits(raw.rateLimits)
  if (rateLimits) statusLine.rateLimits = rateLimits
  return Object.keys(statusLine).length > 0 ? statusLine : null
}

// The usage windows, each by its own rules: a known window id, a percentage in
// 0..100 (refused, not clamped, like the context's), and a reset that is a real
// time. A window that fails drops alone.
function parseStatusLineRateLimits(raw: unknown): Record<string, StatusLineRateLimit> | null {
  if (!isRecord(raw)) return null
  const out: Record<string, StatusLineRateLimit> = {}
  for (const [id, value] of Object.entries(raw)) {
    if (!isClaudeUsageWindowId(id) || !isRecord(value)) continue
    const used = value.usedPercentage
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) continue
    const resetsAt = value.resetsAt
    out[id] =
      typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > 0
        ? { usedPercentage: used, resetsAt }
        : { usedPercentage: used }
  }
  return Object.keys(out).length > 0 ? out : null
}

function parseStatusLineCount(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null
  return Math.min(Math.floor(raw), MAX_STATUS_LINE_COUNT)
}

// A name is a name: trimmed, bounded, and free of control characters for the
// same reason a reported path is — it is retained per session, and the surfaces
// that will read it paint it. (The rule is the paths' one: C0 and DEL. A model
// name is display text rather than a path, so it is a loose fit, but one rule
// for every string off this socket beats two.)
function parseStatusLineName(raw: unknown): string | null {
  const value = optionalString(raw)?.trim()
  if (!value || value.length > MAX_STATUS_LINE_NAME_LENGTH) return null
  if (hasControlCharacters(value)) return null
  return value
}

// The CLI's tool-call id, or nothing. Bounded and free of control characters
// like every other string off this socket; it is keyed on in a per-session ring
// and never rendered, so it is compared, never truncated. A bad value drops the
// FIELD and never the frame — the ring simply falls back to its no-id key.
function parseFrameToolUseId(raw: unknown): string | null {
  const value = optionalString(raw)?.trim()
  if (!value || value.length > MAX_TOOL_USE_ID_LENGTH) return null
  if (hasControlCharacters(value)) return null
  return value
}

// A reported file change must name an absolute path (a relative one is
// meaningless off the reporter's own process cwd, and the ledger is shown to a
// person as the file they can open) with two counts that are real, finite and
// not negative. Anything else drops the field — the frame still carries its
// phase, and a missing ledger entry is a smaller lie than a wrong one.
function parseFrameFileChange(raw: unknown): AgentStateFrameFileChange | null {
  if (!isRecord(raw)) return null
  const path = optionalString(raw.path)?.trim()
  if (!path || !isValidFileChangePath(path)) return null
  const additions = parseFileChangeCount(raw.additions)
  const deletions = parseFileChangeCount(raw.deletions)
  if (additions === null || deletions === null) return null
  const edits = parseFrameFileChangeEdits(raw.edits)
  return { path, additions, deletions, ...(edits ? { edits } : {}) }
}

// The changed regions, or nothing. Every one of the four numbers must be a
// whole, finite, non-negative int in git's hunk convention (a zero-length side
// is an anchor, and `+0,0` is a real deletion at the head of a file — which is
// why zero is allowed on a `start`), and a malformed member drops the whole
// FIELD rather than the frame: the file was still edited, and a file-level claim
// is a smaller lie than a line range that is off by a region.
//
// Over the cap the list is TRUNCATED rather than dropped: the regions ascend, so
// the ones that are kept are still exactly right, and the rest fall to the
// changelist model's remainder rule.
function parseFrameFileChangeEdits(raw: unknown): ChangelistEdit[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const edits: ChangelistEdit[] = []
  for (const entry of raw.slice(0, MAX_FILE_CHANGE_EDITS)) {
    if (!isRecord(entry)) return null
    const bound = (value: unknown): number | null =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
    const oldStart = bound(entry.oldStart)
    const oldLines = bound(entry.oldLines)
    const newStart = bound(entry.newStart)
    const newLines = bound(entry.newLines)
    if (oldStart === null || oldLines === null || newStart === null || newLines === null) return null
    edits.push({ oldStart, oldLines, newStart, newLines })
  }
  return edits.length > 0 ? edits : null
}

// What a file path in the ledger has to be, wherever it arrives from — a
// reporter frame over the socket, or a snapshot sidecar read back off disk.
// Absolute (a relative path is meaningless off the process that reported it, and
// the ledger hands a person a file to open), bounded, and free of control
// characters: `isAbsoluteObservedPath` only inspects a prefix, and this value is
// retained per session, written to disk, keyed on and painted in every window.
export function isValidFileChangePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_FILE_CHANGE_PATH_LENGTH) return false
  if (hasControlCharacters(path)) return false
  return isAbsoluteObservedPath(path)
}

// Counts are whole lines: a fractional value is rounded down rather than
// dropped (the edit still happened), a negative or non-finite one is refused
// outright, and an absurd one is capped.
//
// Refusing (rather than defaulting to zero) is deliberate, and is the one place
// this differs from the reporter's "record the touch even when the shape cannot
// be counted" rule: the reporter emits a real 0 for a shape it cannot read, so a
// count arriving as anything but a number means the FRAME is malformed, not that
// the count is unknown — and a malformed frame is not something to half-believe.
function parseFileChangeCount(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  if (raw < 0) return null
  return Math.min(Math.floor(raw), MAX_FILE_CHANGE_COUNT)
}

// A reported cwd must be absolute (a relative value is meaningless off the
// reporter's own process cwd) and bounded; anything else drops the field.
// Trailing whitespace is trimmed — a `\n`-terminated value from a reporter that
// piped a command's output is still the same directory.
function parseFrameCwd(raw: unknown): string | null {
  const value = optionalString(raw)?.trim()
  if (!value) return null
  if (value.length > MAX_OBSERVED_CWD_LENGTH) return null
  if (hasControlCharacters(value)) return null
  if (!isAbsoluteObservedPath(value)) return null
  return value
}

// `isAbsoluteObservedPath` only inspects a path's PREFIX, so a value that starts
// `/` passes however it continues. A real path from a real CLI carries no
// control characters; one that does is either a broken reporter or an attempt to
// smuggle a NUL, an embedded newline or an ANSI escape into a value the app
// retains per session, writes to a sidecar, keys a map on and paints in every
// window. Refuse it at the door rather than at each of those.
function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value)
}

// A malformed wakeup drops (frame stands without it) — the reporter is
// untrusted, and a bogus hold is worse than a missed one: it parks a session.
function parseFrameWakeup(raw: unknown): AgentStateFrameWakeup | null {
  if (!isRecord(raw)) return null
  if (raw.stop === true) return { stop: true }
  if (typeof raw.delaySeconds === 'number' && Number.isFinite(raw.delaySeconds) && raw.delaySeconds > 0) {
    return { delaySeconds: Math.min(raw.delaySeconds, MAX_WAKEUP_DELAY_SECONDS) }
  }
  return null
}

// =============================================================================
// Frame → session resolution (pure; tested independently of the runtime)
//
// The reporter frame carries SPRINTENGINE_AGENT_ID — for an interactively-launched
// agent that equals the session's agentId; we also match the execution and PTY
// session ids so resolution is robust to launch paths that key identity
// differently. When more than one live session matches the same id (e.g. a
// relaunch reusing it), the most recently started wins.
//
// An agent id is only unique WITHIN a chat: nearly every chat's first agent is
// `agent-1`. So the frame's workspace (SPRINTENGINE_WORKSPACE_ID, which every
// launch with a workspace exports beside the agent id) is a hard boundary, not a
// preference: a frame from one chat never moves another chat's terminal. A frame
// whose workspace has no live match is a late hook from a closed chat, and is
// dropped rather than handed to the newest `agent-1` somewhere else.
//
// A frame with no workspace (a session launched without one, or a reporter that
// predates the variable) is placed only when that cannot be a guess: every
// matching LIVE session lives in the same workspace. Two chats' live `agent-1`s
// are ambiguous, and an ambiguous frame is dropped — a missed phase is corrected
// by the next frame, a wrong one paints another chat working. Sessions with no
// process are left out of that count: after a restart every old chat holds a
// parked `agent-1`, and counting them dropped every such frame even with one
// `agent-1` running. They are still the answer when nothing matching is live,
// for the caller to drop as a late frame.
//
// The execution and PTY session ids are unique on their own, so a frame naming
// one of them is placed whatever the workspace says.
//
// A session's workspace can change under a live process: an agent moved to
// another chat reattaches its pane from there, while the process env (and so
// every frame) still names the chat it was launched in. So the frame's
// workspace is matched against the one each session was launched with first.
// Only a session with no launch workspace on record is matched by the one it
// is in now: one that moved in from another chat names that chat in its
// frames, so a frame naming this one was never its.
// =============================================================================

export type AgentStateCandidate<T> = {
  value: T
  agentId?: string
  executionId?: string
  sessionId?: string
  workspaceId?: string
  launchWorkspaceId?: string
  // False for a session with no process behind it (exited, or parked after a
  // restart). Absent reads as live.
  alive?: boolean
  startedAt: number
}

function newestCandidate<T>(pool: ReadonlyArray<AgentStateCandidate<T>>): AgentStateCandidate<T> {
  return pool.reduce((latest, candidate) => (candidate.startedAt > latest.startedAt ? candidate : latest))
}

export function selectAgentStateTarget<T>(
  candidates: ReadonlyArray<AgentStateCandidate<T>>,
  frame: { agentId: string; workspaceId: string | null },
): T | undefined {
  const byUniqueId = candidates.filter(
    (candidate) => candidate.executionId === frame.agentId || candidate.sessionId === frame.agentId,
  )
  if (byUniqueId.length > 0) return newestCandidate(byUniqueId).value

  const matches = candidates.filter((candidate) => candidate.agentId === frame.agentId)
  if (matches.length === 0) return undefined
  if (frame.workspaceId) {
    const launched = matches.filter((candidate) => candidate.launchWorkspaceId === frame.workspaceId)
    const scoped =
      launched.length > 0
        ? launched
        : matches.filter((candidate) => !candidate.launchWorkspaceId && candidate.workspaceId === frame.workspaceId)
    return scoped.length > 0 ? newestCandidate(scoped).value : undefined
  }
  const live = matches.filter((candidate) => candidate.alive !== false)
  const pool = live.length > 0 ? live : matches
  const workspaces = new Set(pool.map((candidate) => candidate.workspaceId))
  return workspaces.size === 1 ? newestCandidate(pool).value : undefined
}

// =============================================================================
// settings.local.json merge / unmerge (idempotent, tagged)
//
// Mirrors the proven pattern in memory-activity.ts: preserve every hook the user
// or another feature configured, replace only our prior tagged entries, and
// drop emptied blocks/events on uninstall so nothing dangles.
// =============================================================================

type ClaudeHookEntry = {
  type: 'command'
  command: string
  _sprintengine?: string
}

type ClaudeMatcherBlock = {
  matcher?: string
  hooks?: ClaudeHookEntry[]
}

type ClaudeSettings = {
  hooks?: Record<string, ClaudeMatcherBlock[]>
  [key: string]: unknown
}

// Raw shell command both install paths embed (Claude into JSON, Codex into TOML).
// `scriptPath` MUST be absolute: hook commands run with no guaranteed cwd (the
// session's working directory can drift into a subdirectory mid-run), so a
// workspace-relative path would misresolve and fail with MODULE_NOT_FOUND. The
// path is normalized to forward slashes (Node accepts them everywhere, incl.
// `C:/...` on Windows, which also avoids embedding unescaped backslashes).
// `socketPath` is VERBATIM: on Windows it is a `\\.\pipe\...` named pipe whose
// backslashes must survive (a separator rewrite would corrupt it to
// `//./pipe/...`, which connect() can't open); on POSIX it has none. Both args
// are double-quoted so spaces survive the shell.
//
// A command for another host (a WSL distribution) is the exception on both
// counts: see `AgentStateCommandRuntime`.
export type AgentStateCommandRuntime = {
  /** The host's own Node, as its shell names it. */
  executable: string
  env?: Record<string, string>
  /**
   * How a script main copied (a native path under `\\wsl.localhost\`) is
   * named on the host (`/home/...`). A runtime means the command runs in a
   * POSIX shell on that host, so its arguments are single-quoted: nothing in a
   * path there, a `$` or a backtick in a folder name included, is ever
   * expanded by it.
   */
  toCommandPath?: (nativePath: string) => string
  /**
   * The Studio launcher inside that host (`~/.sprintengine/bin/studio-run`,
   * as the host names it). Every hook written for the host runs it rather
   * than `executable` directly, so the hook survives the pinned Node or the
   * app payload moving (see `integrations/launcher.ts`).
   */
  launcher?: StudioLauncherRef
}

function quotePosixCommandArgument(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`
}

function commandRuntimePrefix(runtime?: AgentStateCommandRuntime): string {
  if (!runtime) return 'node'
  const env = Object.entries(runtime.env ?? {}).map(([key, value]) => `${key}=${quotePosixCommandArgument(value)}`)
  return ['env', ...env, quotePosixCommandArgument(runtime.executable)].join(' ')
}

function quoteCommandArgument(value: string, runtime?: AgentStateCommandRuntime): string {
  return runtime ? quotePosixCommandArgument(value) : `"${value}"`
}

// This script-path form is for a command only a session the app launched ever
// reads (the launch-scoped plugin copy under userData). Anything written where
// it can outlive the app uses `buildLauncherHookCommand` instead.
export function buildAgentStateReporterCommand(
  scriptPath: string,
  socketPath: string,
  runtime?: AgentStateCommandRuntime,
): string {
  const hostScript = runtime?.toCommandPath ? runtime.toCommandPath(scriptPath) : scriptPath
  const script = quoteCommandArgument(hostScript.split(sep).join('/'), runtime)
  return `${commandRuntimePrefix(runtime)} ${script} --socket ${quoteCommandArgument(socketPath, runtime)}`
}

/**
 * The launcher a hook written for this machine (under `homeDir`) or for the
 * host `runtime` describes should run. Null for a runtime that carries no
 * launcher, which then keeps the script-path form.
 */
export function agentStateLauncherFor(
  homeDir: string,
  runtime?: AgentStateCommandRuntime,
  platform: NodeJS.Platform = process.platform,
): StudioLauncherRef | null {
  if (runtime) return runtime.launcher ?? null
  return usableLocalLauncherRef(homeDir, platform)
}

/**
 * A hook command that runs `target` through the Studio launcher: the form every
 * hook written into a repository or a CLI's user config takes, so a machine with
 * no Node on PATH, an app that moved, or an app that is gone costs a quiet exit
 * rather than an error on every event.
 */
export function buildLauncherHookCommand(
  launcher: StudioLauncherRef,
  target: 'agent-state' | 'status-line',
  socketPath: string,
  runtime?: AgentStateCommandRuntime,
): string {
  return buildLauncherCommand(launcher, target, ['--socket', socketPath], runtime?.env ?? {})
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, 'utf8')
    if (!text.trim()) return {} as T
    return JSON.parse(text) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

// Reporter entries are recognized primarily by the `_sprintengine` tag, but other
// writers round-trip settings.local.json through schemas that drop unknown keys
// (Claude Code does this when it records e.g. enabledMcpjsonServers), stripping
// the tag. An untagged entry is unremovable by tag alone, and once the workspace
// root moves its absolute script path dangles, firing MODULE_NOT_FOUND on every
// event forever. So also claim untagged entries whose command has the exact
// shape buildAgentStateReporterCommand emits: `node`, or `env …` for a
// runtime, then the script path, always forward-slashed and ending in this
// suffix, immediately followed by `--socket`. Either quote style, because a
// command run through WSL single-quotes its arguments.
//
// A launcher command (`… studio-run' agent-state --socket …`) is claimed the
// same way: the launcher's path and the target are fixed, and nothing else
// writes that pair.
const AGENT_STATE_COMMAND_SIGNATURE = /\/\.sprintengine\/hooks\/agent-state\.mjs(["']) --socket \1/u
const AGENT_STATE_LAUNCHER_SIGNATURE = launcherCommandPattern('agent-state')

export function isAgentStateReporterCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  if (AGENT_STATE_LAUNCHER_SIGNATURE.test(command)) return true
  return (command.startsWith('node "') || command.startsWith('env ')) && AGENT_STATE_COMMAND_SIGNATURE.test(command)
}

function isAgentStateEntry(entry: ClaudeHookEntry): boolean {
  if (entry?._sprintengine === AGENT_STATE_HOOK_TAG) return true
  return isAgentStateReporterCommand(entry?.command)
}

function ensureMatcherBlock(blocks: ClaudeMatcherBlock[], matcher: string | undefined): ClaudeMatcherBlock {
  const found = blocks.find((b) => b.matcher === matcher)
  if (found) {
    if (!Array.isArray(found.hooks)) found.hooks = []
    return found
  }
  const next: ClaudeMatcherBlock = matcher === undefined ? { hooks: [] } : { matcher, hooks: [] }
  blocks.push(next)
  return next
}

// Remove every studio-tagged reporter entry from ALL event keys, pruning
// emptied matcher-blocks and then emptied event keys. Sweeping all keys — rather
// than only the currently-registered event set — self-heals an
// entry left behind by a prior release that registered an event we have since
// dropped (e.g. PreToolUse). Without this, that stale hook would keep spawning
// the reporter on every tool call and uninstall could never reach it.
function stripAgentStateEntries(hooks: Record<string, ClaudeMatcherBlock[]>): void {
  for (const event of Object.keys(hooks)) {
    const blocks = hooks[event]
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (!Array.isArray(block.hooks)) continue
      block.hooks = block.hooks.filter((entry) => !isAgentStateEntry(entry))
    }
    const kept = blocks.filter((b) => Array.isArray(b.hooks) && b.hooks.length > 0)
    if (kept.length === 0) delete hooks[event]
    else hooks[event] = kept
  }
}

export async function mergeAgentStateHooks(
  settingsPath: string,
  command: string,
  events: ReadonlyArray<{ event: string; matcher?: string }>,
  // The status line to write in the same pass, when this spec declares one.
  // ONE read-modify-write, deliberately: this file is shared with Claude Code
  // itself, which rewrites it whenever a person answers "allow always", so a
  // second write cycle here is a window in which their permission is silently
  // clobbered.
  statusLine?: StatusLineForwarderInstall | null,
): Promise<void> {
  const existing = (await readJsonIfExists<ClaudeSettings>(settingsPath)) ?? {}
  const settings: ClaudeSettings = { ...existing }
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}

  // Clean up first (incl. entries for events we no longer register), then add the
  // current set — so install is both idempotent and a migration for stale hooks.
  stripAgentStateEntries(settings.hooks)

  for (const { event, matcher } of events) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = []
    const blocks = settings.hooks[event]
    const block = ensureMatcherBlock(blocks, matcher)
    const ours: ClaudeHookEntry = { type: 'command', command, _sprintengine: AGENT_STATE_HOOK_TAG }
    const filtered = (block.hooks ?? []).filter((entry) => !isAgentStateEntry(entry))
    filtered.push(ours)
    block.hooks = filtered
  }

  if (statusLine) applyStatusLineForwarder(settings, statusLine)

  await mkdir(resolve(settingsPath, '..'), { recursive: true })
  await writeFileAtomically(settingsPath, JSON.stringify(settings, null, 2) + '\n')
}

// Exported for the studio plugin's migration: a workspace that was written to
// before the launch carried these hooks must have them taken back out, or the
// stale entry and the launch's own registration both fire for every event.
export async function unmergeAgentStateHooks(settingsPath: string): Promise<void> {
  const existing = await readJsonIfExists<ClaudeSettings>(settingsPath)
  if (!existing?.hooks || typeof existing.hooks !== 'object') return

  // Sweep ALL event keys (not just the currently-registered ones) so uninstall
  // also removes hooks left by an older release under a since-dropped event.
  stripAgentStateEntries(existing.hooks)
  if (Object.keys(existing.hooks).length === 0) delete existing.hooks

  await writeFileAtomically(settingsPath, JSON.stringify(existing, null, 2) + '\n')
}

// =============================================================================
// Status line (Claude Code's `statusLine` setting) — install / uninstall
//
// Hooks say what an agent is DOING; none of them says how much of the model's
// context window is gone. Claude Code puts that number (and the session's cost,
// line counts, model and name) on stdin of the `statusLine` command, refreshed
// after every assistant message, after a /compact, on a permission-mode change
// and on a rate-limit reset. So the app makes itself that command — the
// forwarder script beside the reporter — and turns each refresh into a frame.
//
// A person may already have a status line, and taking it away to read a number
// would be a straight theft of their terminal. So install WRAPS: their command
// is base64'd into `--wrap`, the forwarder runs it with the same stdin bytes and
// passes its stdout and exit code through, and the object we displaced is kept
// verbatim under `_sprintengineWrapped` so uninstall can put it back exactly.
//
// Same `_sprintengine` discipline as the hooks: our entry is recognizable, ours
// alone is ever replaced, every other key in the file is preserved, and install
// is idempotent (a second install unwraps our own entry rather than wrapping
// itself). Serialization is the caller's, and it is the SAME per-target-file
// chain the hooks use — both writers touch settings.local.json.
// =============================================================================

// Where the forwarder script is copied inside a workspace, beside the reporter.
export const STATUS_LINE_HOOK_SCRIPT_REL = join('.sprintengine', 'hooks', 'status-line.mjs')

// The same tag-stripping problem the hook entries have (a writer round-tripping
// settings.local.json through a schema that drops unknown keys would take
// `_sprintengine` with it, leaving an unremovable entry pointing at a script path
// that dangles the moment the workspace moves). So ours is claimed by the
// command's shape too, exactly as buildStatusLineForwarderCommand emits it.
const STATUS_LINE_COMMAND_SIGNATURE = /\/\.sprintengine\/hooks\/status-line\.mjs(["']) --socket \1/u
const STATUS_LINE_LAUNCHER_SIGNATURE = launcherCommandPattern('status-line')

export function isStatusLineForwarderCommand(command: unknown): boolean {
  return (
    typeof command === 'string' &&
    (STATUS_LINE_LAUNCHER_SIGNATURE.test(command) || STATUS_LINE_COMMAND_SIGNATURE.test(command))
  )
}

// The person's own command, as it rides in our argv: base64 of
// {"command": "..."}, double-quoted. Read back out of a command string when a
// tag-stripping writer has taken `_sprintengineWrapped` — the envelope is then the
// only surviving copy of what we displaced.
const STATUS_LINE_WRAP_ARGUMENT = /--wrap "([A-Za-z0-9+/=]+)"/

// A status line command longer than this is not one we will carry through a
// base64 argv round trip — nothing is installed (their status line stays
// exactly as it is) rather than truncating, because half a command is a
// command.
const MAX_WRAPPED_STATUS_LINE_COMMAND_LENGTH = 4096

// And the rendered command has its own ceiling, because the base64 envelope is
// a third longer than what it carries and the whole string is executed as a
// command line: cmd.exe refuses one past 8191 characters, so a wrapped command
// that is legal on its own can render a status line Windows cannot run. Checked
// on the RENDERED string, which is the thing with the limit.
const MAX_STATUS_LINE_RENDERED_COMMAND_LENGTH = 7000

// Which of the three settings files the wrapped status line was displaced from.
// Recorded because only the LOCAL one is the file we overwrite: a status line
// that lives in the person's `~/.claude/settings.json` is still sitting there
// untouched, so writing a copy of it back into the project's
// settings.local.json on uninstall would leave a stale duplicate shadowing the
// original forever after they next edit it.
export type WrappedStatusLineOrigin = 'local' | 'project' | 'user'

export type WrappedStatusLine = {
  statusLine: Record<string, unknown>
  origin: WrappedStatusLineOrigin
}

// What the settings write does about the status line: put ours in (wrapping the
// status line it displaced, null when it displaced nothing), or take ours out.
export type StatusLineForwarderInstall =
  { action: 'write'; command: string; wrapped: WrappedStatusLine | null } | { action: 'remove' }

const WRAPPED_STATUS_LINE_ORIGINS: ReadonlySet<string> = new Set<WrappedStatusLineOrigin>(['local', 'project', 'user'])

// `scriptPath` is forward-slashed and `socketPath` verbatim for exactly the
// reasons buildAgentStateReporterCommand documents. The wrap envelope is
// base64 (alphabet A-Z a-z 0-9 + / =) so no shell on any platform can find
// anything to interpret in the person's own command while it rides in our argv;
// it is double-quoted anyway, like the other two.
export function buildStatusLineForwarderCommand(
  scriptPath: string,
  socketPath: string,
  wrapped: WrappedStatusLine | null,
  runtime?: AgentStateCommandRuntime,
): string {
  return withWrapArgument(buildAgentStateReporterCommand(scriptPath, socketPath, runtime), wrapped)
}

/** The status line written into a settings file: the launcher's `status-line` target. */
export function buildLauncherStatusLineCommand(
  launcher: StudioLauncherRef,
  socketPath: string,
  wrapped: WrappedStatusLine | null,
  runtime?: AgentStateCommandRuntime,
): string {
  return withWrapArgument(buildLauncherHookCommand(launcher, 'status-line', socketPath, runtime), wrapped)
}

function withWrapArgument(base: string, wrapped: WrappedStatusLine | null): string {
  const command = typeof wrapped?.statusLine.command === 'string' ? wrapped.statusLine.command : null
  if (!command) return base
  const envelope = Buffer.from(JSON.stringify({ command }), 'utf8').toString('base64')
  return `${base} --wrap "${envelope}"`
}

/** Whether a `statusLine` value is one this app wrote. */
function isOurStatusLine(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value._sprintengine === true) return true
  return isStatusLineForwarderCommand(value.command)
}

/**
 * A person's status line reduced to "can we run this on their behalf". Only
 * Claude's `command` type exists, so anything else - a missing command, a
 * non-string one, an absurd one, or (defensively) one of ours - is not
 * wrappable.
 *
 * An unwrappable status line is never DISPLACED: see the resolution below. A
 * type this code has not heard of is the case that matters, because it is what
 * a future Claude release looks like, and installing over it would delete a
 * setting we merely failed to recognize.
 */
function wrappableStatusLine(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || isOurStatusLine(value)) return null
  if (value.type !== 'command') return null
  const command = value.command
  if (typeof command !== 'string' || !command.trim()) return null
  if (command.length > MAX_WRAPPED_STATUS_LINE_COMMAND_LENGTH) return null
  return value
}

// A settings file that another tool half-wrote (or a `~/.claude/settings.json`
// with a trailing comma in it) must not take the agent-state install down with
// it: an unreadable file simply carries no status line.
async function readSettingsLeniently(path: string): Promise<Record<string, unknown> | null> {
  try {
    return (await readJsonIfExists<Record<string, unknown>>(path)) ?? null
  } catch {
    return null
  }
}

// What the scan tells the writer to do. Three outcomes, kept apart because two
// of them used to be one `null` and the difference between them is a person's
// status line:
//   write  — install ours, wrapping `wrapped` (null = there was nothing to wrap)
//   remove — take ours back out: the person now has a status line we cannot run
//            for them, and ours is the only thing standing in front of it
//   leave  — touch the setting at all and something is lost
export type StatusLineResolution =
  { kind: 'write'; wrapped: WrappedStatusLine | null } | { kind: 'remove' } | { kind: 'leave' }

/**
 * What one of our own entries displaced, as far as it can still be told.
 *
 *   value    — the status line we replaced. `origin: 'unknown'` means it was
 *              recovered from the command's own `--wrap` envelope after a writer
 *              stripped the bookkeeping keys, so where it came from is lost.
 *   none     — we installed over nothing, and there is nothing to recover.
 *   unusable — something IS recorded but is not a status line we can re-wrap (a
 *              hand-edit, a type from a later Claude). It is still the record
 *              uninstall restores from, so it must not be overwritten.
 */
type DisplacedStatusLine =
  | { kind: 'value'; statusLine: Record<string, unknown>; origin: WrappedStatusLineOrigin | 'unknown' }
  | { kind: 'none' }
  | { kind: 'unusable' }

// The person's own status line rebuilt out of OUR entry — the only surviving
// copy once a schema-normalizing writer has taken `_sprintengineWrapped`. The
// command comes from the base64 in our argv; `padding` and `refreshInterval`
// come from our own entry, which carries them precisely so that Claude keeps
// running their script the way they configured it. `padding: 0` is a setting a
// person can see, not a default, so it is recovered like the rest.
function statusLineFromWrapArgument(ours: Record<string, unknown>): Record<string, unknown> | null {
  const command = ours.command
  if (typeof command !== 'string') return null
  const match = STATUS_LINE_WRAP_ARGUMENT.exec(command)
  if (!match) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'))
    if (!isRecord(parsed) || typeof parsed.command !== 'string') return null
    const recovered: Record<string, unknown> = { type: 'command', command: parsed.command }
    if (typeof ours.padding === 'number' && Number.isFinite(ours.padding)) recovered.padding = ours.padding
    if (typeof ours.refreshInterval === 'number' && Number.isFinite(ours.refreshInterval)) {
      recovered.refreshInterval = ours.refreshInterval
    }
    return wrappableStatusLine(recovered)
  } catch {
    return null
  }
}

// The origin recorded on one of our entries, when it is still there and still
// one of the three we write.
function recordedStatusLineOrigin(ours: Record<string, unknown>): WrappedStatusLineOrigin | null {
  const recorded = ours._sprintengineWrappedFrom
  return typeof recorded === 'string' && WRAPPED_STATUS_LINE_ORIGINS.has(recorded)
    ? (recorded as WrappedStatusLineOrigin)
    : null
}

function displacedStatusLine(ours: Record<string, unknown>): DisplacedStatusLine {
  const previous = ours._sprintengineWrapped
  if (isRecord(previous)) {
    const statusLine = wrappableStatusLine(previous)
    if (!statusLine) return { kind: 'unusable' }
    return { kind: 'value', statusLine, origin: recordedStatusLineOrigin(ours) ?? 'local' }
  }
  // Explicitly null: we installed over nothing.
  if (previous === null) return { kind: 'none' }
  // Absent: the same writer the command-shape signature exists for has round-
  // tripped this file through a schema that drops unknown keys, taking
  // `_sprintengineWrapped` with the tag. It may or may not have taken the origin
  // too — when the origin survived it is still the truth about where the
  // command came from, and using it is what stops a project-level status line
  // being copied down into the local file as a permanent shadow of itself.
  const recovered = statusLineFromWrapArgument(ours)
  if (!recovered) return { kind: 'none' }
  return { kind: 'value', statusLine: recovered, origin: recordedStatusLineOrigin(ours) ?? 'unknown' }
}

/**
 * The status line the person would see if this app installed nothing, read in
 * Claude Code's own precedence: the settings file we write (project-local),
 * then the project settings beside it, then the user's (honouring
 * `CLAUDE_CONFIG_DIR`, first comma entry, the way every other Claude reader in
 * this app resolves it).
 *
 * Our own entry is never wrapped. It is unwrapped instead:
 *   - displaced from THIS file  -> that is the answer, and install is idempotent.
 *   - recovered from the argv envelope, origin lost -> also the answer, and
 *     immediately: the file it was found in outranks everything below, so
 *     deferring to a lower one would run a command Claude never would have and
 *     throw away the only copy of the one it did.
 *   - displaced from the project or user file -> the scan CONTINUES, so the LIVE
 *     value from that file wins. Those two are never restored by uninstall
 *     (they were never removed from their own file), so the copy we hold is only
 *     "what to run", and a person who has since edited it means the edit.
 *   - nothing displaced (we installed over nothing) -> the scan continues, so a
 *     status line added after we installed is picked up rather than shadowed.
 *
 * A status line we cannot run for them stops the scan. If ours is sitting in the
 * local file it is REMOVED — otherwise our entry, which outranks every file
 * below it, would shadow the person's new status line silently and forever.
 */
export async function resolveWrappedStatusLine(
  settingsPath: string,
  options: { homeDir: string; env: NodeJS.ProcessEnv },
): Promise<StatusLineResolution> {
  const projectPath = resolve(settingsPath, '..', 'settings.json')
  const userPath = resolve(resolveClaudeConfigDir(options.homeDir, options.env), 'settings.json')
  // Derived from the registration's own path rather than hardcoded, and
  // de-duplicated: a manifest is only validated to register a settings-JSON
  // kind, not which of Claude's settings files it names.
  const candidates: Array<{ path: string; origin: WrappedStatusLineOrigin }> = [{ path: settingsPath, origin: 'local' }]
  if (projectPath !== settingsPath) candidates.push({ path: projectPath, origin: 'project' })
  if (userPath !== settingsPath && userPath !== projectPath) candidates.push({ path: userPath, origin: 'user' })

  const read = await Promise.all(candidates.map((candidate) => readSettingsLeniently(candidate.path)))
  return resolveWrappedStatusLineFrom(
    candidates.map((candidate, index) => ({ ...candidate, settings: read[index] ?? null })),
  )
}

/**
 * The precedence scan itself, over settings that have already been read.
 *
 * Pure, and shared by the two callers that must never disagree: the install,
 * which reads the files with `fs/promises`, and the LAUNCH
 * (`buildLaunchStatusLineSetting`), which is called from the synchronous
 * launch-config path and reads them with `readFileSync`. One copy of this
 * reasoning, because "wrap theirs, leave what we cannot run, and never shadow a
 * status line silently" is the whole contract and two copies of it would drift.
 */
function resolveWrappedStatusLineFrom(
  candidates: Array<{ path: string; origin: WrappedStatusLineOrigin; settings: Record<string, unknown> | null }>,
): StatusLineResolution {
  let oursIsInstalled = false
  for (const { origin, settings } of candidates) {
    const raw = settings?.statusLine
    if (!isRecord(raw)) continue
    if (isOurStatusLine(raw)) {
      if (origin === 'local') oursIsInstalled = true
      const displaced = displacedStatusLine(raw)
      // Something is recorded that we cannot re-wrap: leave the whole setting
      // alone rather than overwrite the record uninstall restores from.
      if (displaced.kind === 'unusable') return { kind: 'leave' }
      if (displaced.kind === 'none') continue
      if (displaced.origin === 'local' || displaced.origin === 'unknown') {
        // The candidate's OWN origin, not a hardcoded 'local': every shipped
        // manifest registers the local file, so these are the same value today,
        // but a manifest registering `.claude/settings.json` would otherwise
        // make one workspace's scan claim another install's record as its own
        // to restore.
        return { kind: 'write', wrapped: { statusLine: displaced.statusLine, origin } }
      }
      continue
    }
    const statusLine = wrappableStatusLine(raw)
    if (statusLine) return { kind: 'write', wrapped: { statusLine, origin } }
    return oursIsInstalled ? { kind: 'remove' } : { kind: 'leave' }
  }
  return { kind: 'write', wrapped: null }
}

/**
 * The `statusLine` a launch passes in its `--settings` document, or null when
 * it must pass none.
 *
 * This is the launch-time twin of the install: a CLI handed its plugins on the
 * command line has nothing written into its workspace, so the status line —
 * which no plugin can declare, and which is the ONLY way this app learns how
 * much of a session's context window is gone — has to travel the same way.
 *
 * Synchronous because the launch config is built synchronously, and reading
 * three small JSON files is cheaper than threading an async resolution through
 * every spawn path. The scan itself is the shared pure core, so the launch and
 * the install always answer the same question the same way.
 *
 * Returns null — meaning "send no status line at all" — when:
 *   - the forwarder did not ship, so the command would name a script that is
 *     not there;
 *   - the person has a status line this app cannot run on their behalf
 *     ('leave'), or has one sitting under an entry of ours that cannot be
 *     re-wrapped ('remove'). `--settings` outranks every settings FILE, so
 *     sending ours in either case would silently shadow theirs — the one thing
 *     the install has always refused to do;
 *   - the rendered command exceeds what a command line can carry.
 */
export function buildLaunchStatusLineSetting(input: {
  workspaceRoot: string
  /** The forwarder inside the app's own plugin copy. */
  scriptPath: string
  socketPath: string
  homeDir: string
  env: NodeJS.ProcessEnv
  /**
   * Another host's runtime (WSL). The script path is then that host's own,
   * which this process cannot stat; the host installed it and vouches for it.
   */
  runtime?: AgentStateCommandRuntime
  /**
   * Run the forwarder through the Studio launcher instead of `node`: native
   * Windows, where the CLI's shell is not known to find a Node and the
   * launcher is what every hook there has run.
   */
  launcher?: StudioLauncherRef | null
}): Record<string, unknown> | null {
  if (!input.scriptPath.trim()) return null
  if (!input.runtime && !existsSync(input.scriptPath)) return null
  const localPath = resolve(input.workspaceRoot, '.claude', 'settings.local.json')
  const projectPath = resolve(input.workspaceRoot, '.claude', 'settings.json')
  const userPath = resolve(resolveClaudeConfigDir(input.homeDir, input.env), 'settings.json')
  const candidates: Array<{ path: string; origin: WrappedStatusLineOrigin }> = [{ path: localPath, origin: 'local' }]
  if (projectPath !== localPath) candidates.push({ path: projectPath, origin: 'project' })
  if (userPath !== localPath && userPath !== projectPath) candidates.push({ path: userPath, origin: 'user' })

  const resolved = resolveWrappedStatusLineFrom(
    candidates.map((candidate) => ({ ...candidate, settings: readSettingsLenientlySync(candidate.path) })),
  )
  if (resolved.kind !== 'write') return null

  const command = input.launcher
    ? buildLauncherStatusLineCommand(input.launcher, input.socketPath, resolved.wrapped)
    : buildStatusLineForwarderCommand(input.scriptPath, input.socketPath, resolved.wrapped, input.runtime)
  if (command.length > MAX_STATUS_LINE_RENDERED_COMMAND_LENGTH) return null

  // No `_sprintengine` bookkeeping here, unlike the install: nothing is written to
  // disk, so there is no entry for a later run to recognise or restore from.
  const setting: Record<string, unknown> = { type: 'command', command }
  // Carried over for the same reason the install carries them: they configure
  // how Claude RUNS the command, and the person's own script is still the one
  // printing.
  const padding = resolved.wrapped?.statusLine.padding
  if (typeof padding === 'number' && Number.isFinite(padding)) setting.padding = padding
  const refreshInterval = resolved.wrapped?.statusLine.refreshInterval
  if (typeof refreshInterval === 'number' && Number.isFinite(refreshInterval)) {
    setting.refreshInterval = refreshInterval
  }
  return setting
}

/** The sync twin of `readSettingsLeniently`; see `resolveWrappedStatusLineFrom`. */
function readSettingsLenientlySync(path: string): Record<string, unknown> | null {
  try {
    const text = readFileSync(path, 'utf8')
    if (!text.trim()) return {}
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Write our status line into a settings object, preserving every other key.
 * `padding` and `refreshInterval` are carried over from the status line we
 * displaced: they configure how Claude RUNS the command (indentation, and the
 * timer that re-runs it while the session is idle), so dropping them would
 * silently change the behaviour of the person's own script, which is still the
 * one printing.
 */
function applyStatusLineForwarder(settings: ClaudeSettings, install: StatusLineForwarderInstall): void {
  if (install.action === 'remove') {
    removeStatusLineForwarder(settings)
    return
  }
  // The scan read this file, and the copy of the forwarder happened after. A
  // status line written into that window — Claude Code's own `/statusline`, a
  // person with an editor open — is not the one we resolved against, and
  // overwriting it would lose it AND record the stale value as the thing to
  // restore. Leave it; the next install wraps it properly.
  const current = settings.statusLine
  if (
    isRecord(current) &&
    !isOurStatusLine(current) &&
    JSON.stringify(current) !== JSON.stringify(install.wrapped?.statusLine ?? null)
  ) {
    return
  }
  const ours: Record<string, unknown> = { type: 'command', command: install.command }
  const padding = install.wrapped?.statusLine.padding
  if (typeof padding === 'number' && Number.isFinite(padding)) ours.padding = padding
  const refreshInterval = install.wrapped?.statusLine.refreshInterval
  if (typeof refreshInterval === 'number' && Number.isFinite(refreshInterval)) {
    ours.refreshInterval = refreshInterval
  }
  ours._sprintengine = true
  // Verbatim, so restore is byte-identical to what was there. Explicitly null
  // (rather than absent) when we installed over nothing: uninstall reads the
  // difference between "restore this" and "delete the key".
  ours._sprintengineWrapped = install.wrapped?.statusLine ?? null
  if (install.wrapped) ours._sprintengineWrappedFrom = install.wrapped.origin
  settings.statusLine = ours
}

/**
 * Take our status line back out of a settings object, putting back the one it
 * displaced. Restoring is not the same question as wrapping: this puts a value
 * BACK where it was, so a status line we could no longer run for them is still
 * theirs to have.
 *
 * Only a status line displaced from THIS file is restored — one that came from
 * the project or user settings is still sitting in its own file, untouched, and
 * copying it down here would shadow every later edit of the original. An entry
 * whose bookkeeping a schema-normalizing writer stripped is restored from our
 * own argv, which is then the only copy of it left anywhere; and an entry with
 * no recorded origin predates the bookkeeping. Both of those restore, which is
 * the direction that keeps a command running.
 */
function removeStatusLineForwarder(settings: ClaudeSettings): void {
  const current = settings.statusLine
  if (!isOurStatusLine(current) || !isRecord(current)) return
  const previous = current._sprintengineWrapped
  const recordedOrigin = recordedStatusLineOrigin(current)
  const restorable = recordedOrigin === null || recordedOrigin === 'local'
  if (restorable && isRecord(previous) && !isOurStatusLine(previous)) {
    settings.statusLine = previous
    return
  }
  // Gated on the same `restorable`: an origin that survived the stripping still
  // says the command came from another file, where it is still sitting.
  if (restorable && previous === undefined) {
    const recovered = statusLineFromWrapArgument(current)
    if (recovered) {
      settings.statusLine = recovered
      return
    }
  }
  delete settings.statusLine
}

/**
 * Work out what the status line should be and copy the forwarder into place,
 * ready for the settings write to carry it. Returns null when nothing should be
 * written - and null is the safe answer for every failure here, because the
 * hooks are the load-bearing half of this install and a status line must never
 * cost a workspace its agent state.
 *
 * Nothing is written when the person's own status line is one we cannot run for
 * them: displacing a setting we merely failed to recognize would delete it.
 */
async function prepareStatusLineForwarder(
  workspaceRoot: string,
  settingsPath: string,
  options: {
    statusLineScriptPath: string
    socketPath: string
    homeDir: string
    env: NodeJS.ProcessEnv
    commandRuntime?: AgentStateCommandRuntime
    /** Runs the forwarder; see `agentStateLauncherFor`. Null keeps the older copied-script form. */
    launcher: StudioLauncherRef | null
  },
): Promise<StatusLineForwarderInstall | null> {
  try {
    const resolved = await resolveWrappedStatusLine(settingsPath, {
      homeDir: options.homeDir,
      env: options.env,
    })
    if (resolved.kind === 'leave') return null
    // Resolved BEFORE the script is looked for: taking ours back out of the way
    // of a status line we cannot wrap is exactly the thing a build that shipped
    // without the forwarder still has to be able to do.
    if (resolved.kind === 'remove') return { action: 'remove' }
    if (!existsSync(options.statusLineScriptPath)) return null
    const destScript = resolve(workspaceRoot, STATUS_LINE_HOOK_SCRIPT_REL)
    // The launcher runs the forwarder that ships with the app, so nothing is
    // copied into the workspace.
    const command = options.launcher
      ? buildLauncherStatusLineCommand(options.launcher, options.socketPath, resolved.wrapped, options.commandRuntime)
      : buildStatusLineForwarderCommand(destScript, options.socketPath, resolved.wrapped, options.commandRuntime)
    // A command the platform will not run is not one to install: cmd.exe caps a
    // command line at 8191 characters, and the base64 envelope is a third longer
    // than what it carries. Their status line stays exactly as it is.
    if (command.length > MAX_STATUS_LINE_RENDERED_COMMAND_LENGTH) return null
    if (!options.launcher) {
      await mkdir(resolve(destScript, '..'), { recursive: true })
      await copyFile(options.statusLineScriptPath, destScript)
    }
    return { action: 'write', command, wrapped: resolved.wrapped }
  } catch {
    return null
  }
}

/** Put the person's status line back, on disk. */
// Exported alongside `unmergeAgentStateHooks`, for the same migration: the
// status line we installed points at a script under the workspace that the
// migration deletes, so leaving the setting would run a command that is gone.
export async function unmergeStatusLineForwarder(settingsPath: string): Promise<void> {
  const existing = await readJsonIfExists<ClaudeSettings>(settingsPath)
  if (!existing) return
  // A status line that is not ours is left exactly as it is — a person who
  // replaced ours by hand has said what they want, and uninstall is not the
  // place to argue.
  if (!isOurStatusLine(existing.statusLine)) return
  removeStatusLineForwarder(existing)
  await writeFileAtomically(settingsPath, JSON.stringify(existing, null, 2) + '\n')
}

// =============================================================================
// Flat hooks JSON (registration kind 'flat-hooks-json')
//
// Cursor's hooks.json: { "version": 1, "hooks": { "<event>": [ { "command",
// "timeout"?, "matcher"? } ] } } — event keys map straight to entry arrays,
// with no matcher-block nesting. The file is shared with the user's own hooks,
// so this merges rather than owns. Unlike the Claude settings writer, NO
// `_sprintengine` tag key is written: the entry schema is the vendor's, an
// unknown key risks strict-validation rejection, and the command-shape
// signature (the same one that reclaims tag-stripped Claude entries) is a
// sufficient identity on its own.
// =============================================================================

type FlatHooksEntry = { command?: unknown; [key: string]: unknown }

type FlatHooksFile = {
  version?: unknown
  hooks?: Record<string, FlatHooksEntry[]>
  [key: string]: unknown
}

function isAgentStateFlatEntry(entry: FlatHooksEntry): boolean {
  return isAgentStateReporterCommand(entry?.command)
}

function stripFlatAgentStateEntries(hooks: Record<string, FlatHooksEntry[]>): void {
  for (const event of Object.keys(hooks)) {
    const entries = hooks[event]
    if (!Array.isArray(entries)) continue
    const kept = entries.filter((entry) => !isAgentStateFlatEntry(entry))
    if (kept.length === 0) delete hooks[event]
    else hooks[event] = kept
  }
}

async function mergeFlatAgentStateHooks(
  hooksPath: string,
  command: string,
  events: ReadonlyArray<{ event: string; matcher?: string }>,
): Promise<void> {
  const existing = (await readJsonIfExists<FlatHooksFile>(hooksPath)) ?? {}
  const file: FlatHooksFile = { ...existing }
  if (typeof file.version !== 'number') file.version = 1
  // An array-shaped `hooks` (malformed — the vendor schema wants an object)
  // would silently swallow string-keyed event assignments; replace it so the
  // registration actually lands rather than reporting ok and installing nothing.
  if (!file.hooks || typeof file.hooks !== 'object' || Array.isArray(file.hooks)) file.hooks = {}

  // Clean up first (all event keys, incl. ones we no longer register), then add
  // the current set — install is both idempotent and a migration.
  stripFlatAgentStateEntries(file.hooks)
  for (const { event, matcher } of events) {
    if (!Array.isArray(file.hooks[event])) file.hooks[event] = []
    const entry: FlatHooksEntry = matcher === undefined ? { command } : { command, matcher }
    file.hooks[event].push(entry)
  }

  await mkdir(resolve(hooksPath, '..'), { recursive: true })
  await writeFileAtomically(hooksPath, JSON.stringify(file, null, 2) + '\n')
}

// =============================================================================
// TOML managed block (registration kind 'toml-block')
//
// A single tagged managed block (own markers, never the MCP block's) so the
// rest of the user's config file is preserved and the block is idempotently
// replaceable — the same discipline the MCP writer uses, which avoids the known
// footgun of an installer corrupting config.toml. The marker literals predate
// this generic writer (they shipped with the Codex integration) and MUST stay
// byte-identical so existing installed blocks are still recognized and replaced.
// =============================================================================

export const AGENT_STATE_TOML_START = '# >>> sprintengine agent-state hooks managed'
export const AGENT_STATE_TOML_END = '# <<< sprintengine agent-state hooks managed'

// TOML basic strings share JSON's escaping (matches the repo's MCP writer), so
// JSON.stringify yields a valid quoted value — and correctly escapes the Windows
// pipe path's backslashes.
function tomlBasicString(value: string): string {
  return JSON.stringify(value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function renderTomlAgentStateHooksBlock(
  command: string,
  events: ReadonlyArray<{ event: string; matcher?: string }>,
): string {
  const lines: string[] = [
    AGENT_STATE_TOML_START,
    '# Generated for authoritative agent-state reporting. Remove this block to disable.',
  ]
  for (const { event, matcher } of events) {
    lines.push('', `[[hooks.${event}]]`)
    if (matcher !== undefined) lines.push(`matcher = ${tomlBasicString(matcher)}`)
    lines.push(`[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${tomlBasicString(command)}`)
  }
  lines.push(AGENT_STATE_TOML_END)
  return lines.join('\n')
}

// Replace our managed hooks block, preserving
// everything else in the file. Mirrors the MCP writer's replaceManagedBlock.
function replaceTomlAgentStateBlock(previous: string, block: string): string {
  const pattern = new RegExp(
    `${escapeRegExp(AGENT_STATE_TOML_START)}[\\s\\S]*?${escapeRegExp(AGENT_STATE_TOML_END)}\\n?`,
    'm',
  )
  const trimmed = previous.replace(pattern, '').trimEnd()
  if (!block) return trimmed ? `${trimmed}\n` : ''
  return `${trimmed}${trimmed ? '\n\n' : ''}${block}\n`
}

export function mergeTomlAgentStateHooks(
  previous: string,
  command: string,
  events: ReadonlyArray<{ event: string; matcher?: string }>,
): string {
  return replaceTomlAgentStateBlock(previous, renderTomlAgentStateHooksBlock(command, events))
}

// The array-of-tables variant (registration kind 'toml-array-block'): Kimi
// Code's hooks are `[[hooks]]` entries with an `event` key per table, not
// Codex's `[[hooks.<Event>]]` nesting. Same marker discipline (and the same
// marker literals — the two kinds never share a file, since each CLI names its
// own config path).
export function renderTomlArrayAgentStateHooksBlock(
  command: string,
  events: ReadonlyArray<{ event: string; matcher?: string }>,
): string {
  const lines: string[] = [
    AGENT_STATE_TOML_START,
    '# Generated for authoritative agent-state reporting. Remove this block to disable.',
  ]
  for (const { event, matcher } of events) {
    lines.push('', '[[hooks]]', `event = ${tomlBasicString(event)}`)
    if (matcher !== undefined) lines.push(`matcher = ${tomlBasicString(matcher)}`)
    lines.push(`command = ${tomlBasicString(command)}`)
  }
  lines.push(AGENT_STATE_TOML_END)
  return lines.join('\n')
}

export function mergeTomlArrayAgentStateHooks(
  previous: string,
  command: string,
  events: ReadonlyArray<{ event: string; matcher?: string }>,
): string {
  return replaceTomlAgentStateBlock(previous, renderTomlArrayAgentStateHooksBlock(command, events))
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

// =============================================================================
// Owned JSON hook config (registration kind 'owned-json')
//
// For CLIs whose hook discovery is per-file (Grok Build reads standalone JSON
// files under .grok/hooks/*.json) we own our config file outright: install is a
// plain write, uninstall a plain remove — no merge/unmerge bookkeeping. The
// per-event structure ({ matcher?, hooks: [{ type: 'command', command }] })
// mirrors Claude Code's settings hooks, which is the format Grok documents.
//
// SPELLING. Event names are written here EXACTLY as the manifest
// spells them — no folding on the way out. Config spelling is a property of the
// registration kind and is not the same question as frame matching
// (canonicalEventName), which is deliberately spelling-blind because a CLI's
// payload spelling need not match its config spelling.
//
// Verified against grok 1.0.13 on 2026-09-09 by writing candidate
// `.grok/hooks/*.json` files and counting what `grok inspect` loaded (its
// loader filters unknown event names — a file of invented names loads 0):
//   PascalCase  `PreToolUse`    loaded (all 15 events)  <- what we emit
//   snake_case  `pre_tool_use`  loaded
//   camelCase   `preToolUse`    loaded (documented Cursor-compat alias)
//   kebab-case  `pre-tool-use`  SKIPPED
//   SCREAMING   `PRETOOLUSE`    SKIPPED
// So Grok accepts a fixed alias SET, not arbitrary case folding, and the
// manifest's PascalCase is inside it: this emitter needs no per-kind rule
// today. If a future owned-json CLI reads only one spelling, convert HERE
// (keyed off the registration kind) and leave both the manifest's written form
// and canonical matching alone.
// =============================================================================

export function renderOwnedJsonAgentStateHooksConfig(
  command: string,
  events: ReadonlyArray<{ event: string; matcher?: string }>,
): string {
  const hooks: Record<string, Array<Record<string, unknown>>> = {}
  for (const { event, matcher } of events) {
    const block: Record<string, unknown> = {}
    if (matcher !== undefined) block.matcher = matcher
    block.hooks = [{ type: 'command', command }]
    hooks[event] = [block]
  }
  return JSON.stringify({ hooks }, null, 2) + '\n'
}

// =============================================================================
// Plugin-file reporter (registration kind 'plugin-file')
//
// For CLIs with no command-hook mechanism (OpenCode auto-loads in-process JS
// plugins and exposes a typed event stream), the reporter is a bundled plugin
// TEMPLATE named by the manifest's registration. It subscribes to the CLI's
// events itself and emits the same socket frames; the manifest's `events` table
// remains the canonical event→phase mapping the main process applies — the
// template's internal mapping only decides which events it reports and dedups
// on (frame `phase` is consulted solely when no spec entry resolves the event).
//
// A plugin can't take a --socket arg, so the live socket path is baked into the
// file at install time (token substitution); the plugin also honours
// SPRINTENGINE_AGENT_STATE_SOCKET as a fallback. Note the OpenCode dest extension
// is .js while the bundled template ships as .mjs (the packaging filter is
// **/*.mjs; OpenCode's loader picks up .js/.ts but not .mjs, verified against
// opencode v1.17.11) — the manifest declares both names, so the rename is data.
// =============================================================================

// The quoted token in a plugin template that install replaces with the live
// socket path. Replacing the WHOLE quoted literal with JSON.stringify(path) keeps
// the value valid even for a Windows pipe path full of backslashes (splicing a
// bare string back inside the quotes would let those backslashes act as JS
// escapes and corrupt the path).
const PLUGIN_SOCKET_PLACEHOLDER = "'__SPRINTENGINE_AGENT_STATE_SOCKET__'"

export function renderAgentStatePluginTemplate(template: string, socketPath: string): string {
  return template.split(PLUGIN_SOCKET_PLACEHOLDER).join(JSON.stringify(socketPath))
}

// =============================================================================
// Install / uninstall — one dispatcher over the spec's registration kind
//
// The caller (the Electron-bound service) resolves the bundled reporter script
// (the shared stdin filter, or the plugin-file template the registration
// names) and the live socket path; this stays free of Electron so it is
// testable. Strictly best-effort at the call site: a failed install must never
// block or break the launch that awaits it.
// =============================================================================

export type AgentStateInstallResult =
  { ok: true; settingsPath: string; hookScriptPath: string; createdFile?: boolean } | { ok: false; message: string }

// A user-scoped registration (Kimi Code's user-global config.toml) resolves
// against the home directory instead of the workspace. `homeDir` is injectable
// so tests never touch the real home.
function resolveRegistrationPath(
  workspaceRoot: string,
  registration: PluginAgentStateSpec['registration'],
  homeDir: string,
): string {
  const base = registration.scope === 'user' ? homeDir : workspaceRoot
  return resolve(base, ...registration.path.split('/'))
}

export async function installAgentStateReporter(
  workspaceRoot: string,
  spec: PluginAgentStateSpec,
  options: {
    sourceScriptPath: string
    socketPath: string
    homeDir?: string
    // The bundled status-line forwarder, for a spec that opts into it. Null or
    // absent (the script did not ship, or this CLI declares no status line) and
    // the install writes hooks only — a missing forwarder must never cost a
    // workspace its agent state.
    statusLineScriptPath?: string | null
    commandRuntime?: AgentStateCommandRuntime
    // Environment the Claude settings precedence is read against
    // (CLAUDE_CONFIG_DIR). Injected so tests never read the real one.
    env?: NodeJS.ProcessEnv
    // For the integration ledger: which CLI this is for, and on which machine.
    cli?: string
    hostId?: string
  },
): Promise<AgentStateInstallResult> {
  if (!workspaceRoot?.trim()) return { ok: false, message: 'Workspace root is required.' }
  if (!options.socketPath?.trim()) return { ok: false, message: 'Agent-state socket path is required.' }
  if (!options.sourceScriptPath || !existsSync(options.sourceScriptPath)) {
    return { ok: false, message: 'Agent-state reporter script is missing from this build.' }
  }

  const registration = spec.registration
  try {
    const homeDir = options.homeDir ?? homedir()
    const targetPath = resolveRegistrationPath(workspaceRoot, registration, homeDir)
    // Under the per-file lock every writer of these CLI configs shares: the MCP
    // sync read-modify-writes `.claude/settings.local.json` and Codex's
    // `config.toml` too, often for a launch in the same checkout at once.
    const ledgerBase = {
      hostId: options.hostId ?? 'local',
      ...(options.cli ? { cli: options.cli } : {}),
      ...(registration.scope === 'user' ? {} : { repo: workspaceRoot }),
    }
    return await withConfigFileLock(targetPath, async (): Promise<AgentStateInstallResult> => {
      await mkdir(resolve(targetPath, '..'), { recursive: true })
      const createdFile = !existsSync(targetPath)

      if (registration.kind === 'plugin-file') {
        const template = await readFile(options.sourceScriptPath, 'utf8')
        await writeFileAtomically(targetPath, renderAgentStatePluginTemplate(template, options.socketPath))
        recordIntegrationWrite({
          kind: 'agent-state-hooks',
          path: targetPath,
          marker: 'plugin-file',
          createdFile: true,
          ...ledgerBase,
        })
        return { ok: true, settingsPath: targetPath, hookScriptPath: targetPath }
      }

      // Command-hook kinds run the reporter the app ships, through the Studio
      // launcher at a path that never moves (`integrations/launcher.ts`), so
      // nothing is copied next to the registration and a hook outlives the app
      // quietly. A user-scoped registration (Kimi's user-global config) names
      // the launcher in the same home it lives in.
      //
      // A runtime from before the launcher (none ships today) keeps the older
      // arrangement: the reporter copied beside the registration and named by
      // its ABSOLUTE path (hook commands run with no guaranteed cwd).
      const launcher = agentStateLauncherFor(homeDir, options.commandRuntime)
      let destScript: string
      let command: string
      if (launcher) {
        destScript = launcher.path
        command = buildLauncherHookCommand(launcher, 'agent-state', options.socketPath, options.commandRuntime)
      } else {
        destScript =
          registration.scope === 'user'
            ? resolve(homeDir, AGENT_STATE_HOOK_SCRIPT_REL)
            : resolve(workspaceRoot, AGENT_STATE_HOOK_SCRIPT_REL)
        await mkdir(resolve(destScript, '..'), { recursive: true })
        await copyFile(options.sourceScriptPath, destScript)
        if (registration.scope !== 'user') await ensureWorkspaceHooksDirSelfIgnored(resolve(destScript, '..'))
        command = buildAgentStateReporterCommand(destScript, options.socketPath, options.commandRuntime)
      }
      const events = registeredAgentStateEvents(spec)
      let wroteStatusLine = false

      switch (registration.kind) {
        case 'settings-json': {
          // The status line rides the same settings file and the same WRITE.
          // Workspace-scoped only: the precedence scan reads the project's own
          // .claude/, which a user-global registration has none of. Everything
          // about it is best-effort — it resolves to null rather than throwing,
          // so the hooks land whatever happens to it.
          const statusLine =
            spec.statusLine === true && registration.scope !== 'user' && options.statusLineScriptPath
              ? await prepareStatusLineForwarder(workspaceRoot, targetPath, {
                  statusLineScriptPath: options.statusLineScriptPath,
                  socketPath: options.socketPath,
                  homeDir,
                  env: options.env ?? process.env,
                  commandRuntime: options.commandRuntime,
                  launcher,
                })
              : null
          await mergeAgentStateHooks(targetPath, command, events, statusLine)
          wroteStatusLine = statusLine?.action === 'write'
          break
        }
        case 'flat-hooks-json':
          await mergeFlatAgentStateHooks(targetPath, command, events)
          break
        case 'toml-block': {
          const previous = (await readTextIfExists(targetPath)) ?? ''
          await writeFileAtomically(targetPath, mergeTomlAgentStateHooks(previous, command, events))
          break
        }
        case 'toml-array-block': {
          const previous = (await readTextIfExists(targetPath)) ?? ''
          await writeFileAtomically(targetPath, mergeTomlArrayAgentStateHooks(previous, command, events))
          break
        }
        case 'owned-json':
          await writeFileAtomically(targetPath, renderOwnedJsonAgentStateHooksConfig(command, events))
          break
      }
      recordIntegrationWrite(
        {
          kind: 'agent-state-hooks',
          path: targetPath,
          marker: registration.kind,
          createdFile: createdFile || registration.kind === 'owned-json',
          ...ledgerBase,
        },
        ...(wroteStatusLine
          ? [{ kind: 'status-line' as const, path: targetPath, marker: 'statusLine', createdFile, ...ledgerBase }]
          : []),
      )
      return { ok: true, settingsPath: targetPath, hookScriptPath: destScript, createdFile }
    })
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Failed to install agent-state reporter.',
    }
  }
}

// =============================================================================
// Taking a workspace registration back out
//
// A CLI whose launch carries the app's plugin directory registers this reporter
// for its session from there, so the copy an earlier build merged into the
// workspace is both a second registration (every event fires twice) and a file
// in the person's repository that any `claude` run from a plain terminal in that
// checkout would also obey. The launch-time installer calls this instead of
// installing, so an existing workspace is tidied on the next app-launched run.
// =============================================================================

// The self-ignore a workspace hooks directory gets: the scripts in it are this
// app's runtime plumbing, and the registrations naming them hold absolute paths
// to this machine. Same one-line file the backlog cache and the browser
// captures already write, and for the same reason — editing someone's own
// `.gitignore` to hide our state is not ours to do.
const HOOKS_DIR_IGNORE_FILE = '.gitignore'
const HOOKS_DIR_IGNORE_BODY = '*\n'

async function ensureWorkspaceHooksDirSelfIgnored(directory: string): Promise<void> {
  try {
    // `wx`: a file that is already there (or one a person edited) is never
    // clobbered, and a failure only costs an untidy `git status`.
    await writeFile(join(directory, HOOKS_DIR_IGNORE_FILE), HOOKS_DIR_IGNORE_BODY, { encoding: 'utf8', flag: 'wx' })
  } catch {
    // Present already, or not writable.
  }
}

/**
 * Remove one CLI's app-written agent-state registration from a workspace, and
 * the scripts it named once nothing else there runs them. Returns the
 * workspace-relative paths it changed or deleted, for a diagnostic.
 *
 * The Claude settings kind is handled here; every other workspace kind (Codex's
 * managed `config.toml` block, OpenCode's plugin file, Cursor's and Grok's hook
 * files), now that those CLIs take the hook at launch or from user-level
 * config, goes through `removeAgentStateRegistrationAt`, with a file it leaves
 * empty deleted only while git does not track it. Narrow about what it deletes,
 * in the same way the installer is narrow about what it replaces:
 *   - only hook entries and a status line this app wrote (tag or command shape)
 *     are removed, and a settings file that holds nothing of ours is not even
 *     rewritten, so a person's formatting survives;
 *   - a settings file left holding nothing at all is deleted, and its `.claude`
 *     directory with it when empty — the app is what created them;
 *   - the shared reporter script stays while any other CLI's registration in
 *     this workspace (Codex's `config.toml`, Cursor's `hooks.json`, …) still
 *     names one, because deleting it would break THAT CLI's hooks.
 *
 * Idempotent and never throws: a workspace with nothing of ours is untouched.
 */
export async function removeWorkspaceAgentStateRegistration(
  workspaceRoot: string,
  registration: PluginAgentStateSpec['registration'],
  options: { otherSpecs?: readonly PluginAgentStateSpec[] } = {},
): Promise<string[]> {
  const changed: string[] = []
  const root = workspaceRoot?.trim() ?? ''
  if (root === '') return changed
  if (registration.scope === 'user') return changed
  if (registration.kind !== 'settings-json') {
    const path = resolveRegistrationPath(root, registration, homedir())
    if (!existsSync(path)) return changed
    const tracked = await gitTracksFile(dirname(path), basename(path))
    const outcome = await removeAgentStateRegistrationAt(path, registration.kind, { deleteIfEmpty: !tracked }).catch(
      () => 'skipped' as const,
    )
    if (outcome === 'removed') changed.push(registration.path)
    return changed
  }

  const settingsPath = resolveRegistrationPath(root, registration, homedir())
  // The same per-file lock the install and the MCP sync take for this file.
  await withConfigFileLock(settingsPath, async () => {
    try {
      const raw = await readFile(settingsPath, 'utf8').catch(() => null)
      const parsed: unknown = raw === null || raw.trim() === '' ? null : JSON.parse(raw)
      if (isRecord(parsed)) {
        const settings = parsed as ClaudeSettings
        let touched = false
        if (settings.hooks && typeof settings.hooks === 'object') {
          const before = JSON.stringify(settings.hooks)
          stripAgentStateEntries(settings.hooks)
          if (JSON.stringify(settings.hooks) !== before) touched = true
          if (Object.keys(settings.hooks).length === 0) {
            delete settings.hooks
            touched = true
          }
        }
        if (isOurStatusLine(settings.statusLine)) {
          removeStatusLineForwarder(settings)
          touched = true
        }
        if (touched) {
          if (Object.keys(settings).length === 0) {
            await rm(settingsPath, { force: true })
            await rmdir(resolve(settingsPath, '..')).catch(() => undefined)
          } else {
            await writeFileAtomically(settingsPath, JSON.stringify(settings, null, 2) + '\n')
          }
          changed.push(registration.path)
        }
      }
    } catch {
      // Unparseable or unwritable: someone's work in progress keeps its stale
      // entry, and the next launch tries again.
    }
  })

  // The status-line forwarder is only ever named by a Claude settings file, so
  // it goes once the entry above has.
  if (await removeIfPresent(resolve(root, STATUS_LINE_HOOK_SCRIPT_REL))) changed.push(STATUS_LINE_HOOK_SCRIPT_REL)

  // The reporter is shared by every command-hook kind in this workspace.
  const reporterStillNamed = await workspaceRegistrationsNameReporter(root, registration.path, options.otherSpecs ?? [])
  if (!reporterStillNamed) {
    if (await removeIfPresent(resolve(root, AGENT_STATE_HOOK_SCRIPT_REL))) changed.push(AGENT_STATE_HOOK_SCRIPT_REL)
    await removeHooksDirIfOnlyOurs(resolve(root, AGENT_STATE_HOOK_SCRIPT_REL, '..'))
  }
  return changed
}

// Fails closed, like the quit removal's check: an answer other than "not a
// repository" or an empty listing counts as tracked, and a tracked file is
// only ever edited, never deleted.
async function gitTracksFile(cwd: string, name: string): Promise<boolean> {
  const result = await runGitCommand(cwd, ['ls-files', '--', name]).catch(() => null)
  if (!result) return true
  if (result.ok) return result.stdout.trim() !== ''
  return !/not a git repository/iu.test(`${result.stderr}\n${result.message ?? ''}`)
}

async function removeIfPresent(path: string): Promise<boolean> {
  if (!existsSync(path)) return false
  try {
    await rm(path, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Whether any OTHER workspace-scoped command-hook registration still names the
 * workspace copy of the reporter. Read as text and matched on the script's file
 * name: every command kind embeds the path verbatim (or JSON/TOML-escaped, which
 * keeps the name), and a false positive only keeps a file, never breaks a hook.
 */
async function workspaceRegistrationsNameReporter(
  workspaceRoot: string,
  excludedPath: string,
  specs: readonly PluginAgentStateSpec[],
): Promise<boolean> {
  const scriptName = AGENT_STATE_HOOK_SCRIPT_REL.split(sep).pop() ?? 'agent-state.mjs'
  const seen = new Set<string>([excludedPath])
  for (const other of specs) {
    const registration = other.registration
    if (registration.scope === 'user' || registration.kind === 'plugin-file') continue
    if (seen.has(registration.path)) continue
    seen.add(registration.path)
    const text = await readFile(resolveRegistrationPath(workspaceRoot, registration, homedir()), 'utf8').catch(
      () => null,
    )
    if (text?.includes(scriptName)) return true
  }
  return false
}

/** Remove `.sprintengine/hooks` (and an emptied `.sprintengine`) when only our files were in it. */
export async function removeHooksDirIfOnlyOurs(hooksDir: string): Promise<void> {
  const entries = await readdir(hooksDir).catch(() => null)
  if (entries === null) return
  if (entries.some((name) => name !== HOOKS_DIR_IGNORE_FILE)) return
  if (entries.includes(HOOKS_DIR_IGNORE_FILE)) {
    const body = await readFile(join(hooksDir, HOOKS_DIR_IGNORE_FILE), 'utf8').catch(() => null)
    // A person's own ignore file is theirs; only the one this app writes goes.
    if (body !== HOOKS_DIR_IGNORE_BODY) return
    await rm(join(hooksDir, HOOKS_DIR_IGNORE_FILE), { force: true }).catch(() => undefined)
  }
  await rmdir(hooksDir).catch(() => undefined)
  await rmdir(resolve(hooksDir, '..')).catch(() => undefined)
}

// =============================================================================
// Taking any registration back out, by kind
//
// `removeWorkspaceAgentStateRegistration` above is the launch-time tidy, which
// only ever has the Claude kind to tidy. This is the general form the
// integration removal and the user-scoped cleanup use: given the file a
// registration lives in and its kind, take out exactly what this app wrote
// there and nothing else.
// =============================================================================

export type AgentStateRemoval = 'removed' | 'absent' | 'skipped'

/**
 * Remove this app's agent-state registration from one file.
 *
 *   - `settings-json`: our hook entries and our status line (the person's own
 *     is put back), every other key untouched;
 *   - `flat-hooks-json`: our entries;
 *   - `toml-block` / `toml-array-block`: the marked block;
 *   - `owned-json` / `plugin-file`: the file, when it is still recognisably ours.
 *
 * A file this leaves with nothing in it is deleted only when `deleteIfEmpty`
 * says the app created it; otherwise it is written back empty. 'skipped' means
 * the file could not be read or parsed, and is left exactly as it was.
 */
export async function removeAgentStateRegistrationAt(
  path: string,
  kind: PluginAgentStateSpec['registration']['kind'],
  options: { deleteIfEmpty?: boolean } = {},
): Promise<AgentStateRemoval> {
  return withConfigFileLock(path, async (): Promise<AgentStateRemoval> => {
    const raw = await readTextIfExists(path).catch(() => undefined)
    if (raw === undefined) return 'skipped'
    if (raw === null) return 'absent'
    if (kind === 'owned-json' || kind === 'plugin-file') {
      const ours = kind === 'plugin-file' ? raw.includes('SPRINTENGINE_AGENT_STATE') : ownedJsonIsOurs(raw)
      if (!ours) return 'skipped'
      await rm(path, { force: true })
      // `.grok/hooks`, `.opencode/plugin` and their parents, when this was all
      // they held — the install made them. Never a directory with anything left.
      if (
        await rmdir(resolve(path, '..')).then(
          () => true,
          () => false,
        )
      ) {
        await rmdir(resolve(path, '..', '..')).catch(() => undefined)
      }
      return 'removed'
    }
    if (kind === 'toml-block' || kind === 'toml-array-block') {
      if (!raw.includes(AGENT_STATE_TOML_START)) return 'absent'
      const next = replaceTomlAgentStateBlock(raw, '')
      await writeOrDelete(path, next, next.trim() === '' && options.deleteIfEmpty === true)
      return 'removed'
    }
    let parsed: unknown
    try {
      parsed = raw.trim() === '' ? {} : JSON.parse(raw)
    } catch {
      return 'skipped'
    }
    if (!isRecord(parsed)) return 'skipped'
    const before = JSON.stringify(parsed)
    if (kind === 'settings-json') {
      const settings = parsed as ClaudeSettings
      if (isRecord(settings.hooks)) {
        stripAgentStateEntries(settings.hooks)
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks
      }
      if (isOurStatusLine(settings.statusLine)) removeStatusLineForwarder(settings)
    } else {
      const file = parsed as FlatHooksFile
      if (isRecord(file.hooks)) {
        stripFlatAgentStateEntries(file.hooks as Record<string, FlatHooksEntry[]>)
        if (Object.keys(file.hooks).length === 0) delete file.hooks
      }
      // `version` alone is the scaffold the merge added, not the person's content.
      if (Object.keys(file).length === 1 && 'version' in file) delete file.version
    }
    if (JSON.stringify(parsed) === before) return 'absent'
    const empty = Object.keys(parsed).length === 0
    await writeOrDelete(path, `${JSON.stringify(parsed, null, 2)}\n`, empty && options.deleteIfEmpty === true)
    return 'removed'
  })
}

function ownedJsonIsOurs(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || !isRecord(parsed.hooks)) return false
    const commands: unknown[] = []
    for (const blocks of Object.values(parsed.hooks)) {
      if (!Array.isArray(blocks)) return false
      for (const block of blocks) {
        const hooks = isRecord(block) && Array.isArray(block.hooks) ? block.hooks : []
        for (const hook of hooks) commands.push(isRecord(hook) ? hook.command : undefined)
      }
    }
    return commands.length > 0 && commands.every((command) => isAgentStateReporterCommand(command))
  } catch {
    return false
  }
}

async function writeOrDelete(path: string, content: string, remove: boolean): Promise<void> {
  if (remove) {
    await rm(path, { force: true })
    await rmdir(resolve(path, '..')).catch(() => undefined)
    return
  }
  await writeFileAtomically(path, content)
}
