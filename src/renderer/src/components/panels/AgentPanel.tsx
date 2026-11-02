import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useSession } from '../../hooks/useTerminalSessions'
import type {
  AgentCli,
  AgentCliAvailabilityMap,
  AgentRuntimeKind,
  AgentState,
  CliRuntimeSettings,
  PluginCatalogEntry,
  PluginCatalogStatus,
} from '../../types/workspace'
import { normalizeAgentRuntime } from '../../store/slices/agentsSlice'
import {
  isAgentCliMissing,
  selectAgentCliCatalog,
  type CliAvailabilityFilterStatus,
} from '../workspace/newWorkspace/cliRuntimeOptions'
import { IconButton, RowButton, StarGlyph, Tooltip } from '../ui'
import { revealBacklogItemInPane } from '../workspace/pane/backlogPaneReveal'
import { requestPaletteOpen } from '../palette/paletteOpenRequest'
import { CliInstallCta } from '../workspace/cliInstallRoute'
import { ChatViewErrorBoundary } from './agentChat/ChatViewErrorBoundary'
import { AgentChatView } from './agentPanelChunks'

const TerminalView = React.lazy(() => import('./TerminalView'))

interface Props {
  workspaceId: string
  agentId: string
  sessionId?: string
  shouldKillTerminalOnUnmount?: (sessionId: string) => boolean
}

export function isStoredAgentCliUnavailable(
  cli: AgentCli | null | undefined,
  pluginCatalogStatus: PluginCatalogStatus,
  pluginCatalogEntries: PluginCatalogEntry[],
  cliRuntimes: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>> | undefined,
  availability?: { map: AgentCliAvailabilityMap | null | undefined; status: CliAvailabilityFilterStatus },
): boolean {
  if (pluginCatalogStatus !== 'ready') return false
  // Pass availability so an agent stored with a CLI whose binary is not
  // installed (e.g. Claude Code on a Codex-only machine) is flagged unavailable
  // and blocked from launching, not silently spawned against a missing binary.
  const catalog = selectAgentCliCatalog(pluginCatalogStatus, pluginCatalogEntries, cliRuntimes, availability)
  return isAgentCliMissing(cli, catalog)
}

// Decide which runtime drives the `agent` panel: only an agent that opted into
// a valid conversation runtime routes to the conversation UI. Mirrors
// `normalizeAgentRuntime`, so a partial/corrupt selection falls back to
// terminal.
export function resolveAgentRuntimeKind(
  agent: Pick<AgentState, 'runtimeKind' | 'conversation'> | null | undefined,
): AgentRuntimeKind {
  if (!agent) return 'terminal'
  return normalizeAgentRuntime(agent).runtimeKind
}

// Whether the agent pane mounts its terminal or shows the install pane. A
// standard agent mounts immediately — TerminalView owns the spawn/attach
// decision — so the install pane is only for a CLI that is not installed. It does
// NOT depend on an attached session id: a New chat has none yet, and gating on
// one left every new agent parked on an inert pane (regression, 2026-09-16,
// from reducing the old Sprint Engine gate the wrong way round).
export function agentPaneMountsTerminal(input: { agentCliUnavailable: boolean }): boolean {
  return !input.agentCliUnavailable
}

export default function AgentPanel({ workspaceId, agentId, sessionId, shouldKillTerminalOnUnmount }: Props) {
  const agent = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.agents[agentId])
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const cliAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)
  const runtimeKind = resolveAgentRuntimeKind(agent)
  const isConversationRuntime = runtimeKind === 'conversation'
  const cli = agent?.cli
  const agentCliUnavailable = useMemo(
    // Missing-CLI blocking is a terminal-runtime concern only; provider-backed
    // conversation agents do not launch a CLI and must not inherit it.
    () =>
      !isConversationRuntime &&
      isStoredAgentCliUnavailable(cli, pluginCatalogStatus, pluginCatalogEntries, cliRuntimes, {
        map: cliAvailability,
        status: cliAvailabilityStatus,
      }),
    [
      isConversationRuntime,
      cli,
      pluginCatalogStatus,
      pluginCatalogEntries,
      cliRuntimes,
      cliAvailability,
      cliAvailabilityStatus,
    ],
  )
  const hasStarted = agentPaneMountsTerminal({ agentCliUnavailable })
  // Freeze-the-view: when this agent's terminal has been suspended (process
  // killed to reclaim memory, scrollback kept painted), surface a glyph so the
  // user knows it is not live and will resume on the next keystroke. Tracked off
  // the session snapshot's `suspended` flag; `processAlive` co-varies, so the
  // (deduped) sessions signature re-renders this on suspend/resume.
  // The real terminal session id: the `sessionId` prop is only set for attached
  // sessions; a normally-launched agent carries its id on `agent.cliSessionId`
  // (TerminalView resolves it the same way). Keying the glyph/button off the bare
  // prop is why it never showed for normal agents.
  const effectiveSessionId = sessionId ?? agent?.cliSessionId
  const terminalSession = useSession(
    useCallback((s) => Boolean(effectiveSessionId) && s.sessionId === effectiveSessionId, [effectiveSessionId]),
  )
  const isTerminalSuspended = Boolean(terminalSession?.suspended)
  // Resume-in-flight: TerminalView relaunches the CLI and holds its output
  // until its first frame. It broadcasts the state (it owns the resume; typing
  // there also triggers one), and the footer gives its row back to the pane the
  // moment a resume starts: TerminalView sizes the relaunch after that, so the
  // CLI never sees the pane grow under it. The click is acknowledged on the
  // pane itself, by its working edge. Success sends no counterpart event;
  // failure sends `resuming: false` and the footer comes back. The pending flag
  // resets on the next suspend.
  const [isResumePending, setIsResumePending] = useState(false)
  useEffect(() => {
    if (!effectiveSessionId) return
    const onResumeState = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; resuming?: boolean }>).detail
      if (detail?.sessionId !== effectiveSessionId) return
      setIsResumePending(Boolean(detail?.resuming))
    }
    window.addEventListener('sprintengine:terminal-resume-state', onResumeState)
    return () => window.removeEventListener('sprintengine:terminal-resume-state', onResumeState)
  }, [effectiveSessionId])
  // Layout effect: a fresh suspend re-expands the footer, and the stale pending
  // flag from the previous resume must clear before that first paint or the
  // strip stays collapsed on a terminal that just paused.
  useLayoutEffect(() => {
    if (isTerminalSuspended) setIsResumePending(false)
  }, [isTerminalSuspended])
  // The terminal has a live agent process (green "live" dot). A suspended session
  // reports processAlive=false, so live and suspended are mutually exclusive.
  const isTerminalLive = Boolean(terminalSession?.processAlive)
  const showPausedStrip = isTerminalSuspended && !isResumePending
  // Only a live terminal can be suspended (not an exited or already-suspended one).
  const canSuspendTerminal = hasStarted && isTerminalLive && !isTerminalSuspended
  // User lock ("keep running"): while locked the reaper never pauses this
  // terminal, so the pause button gives way to the closed-lock control — the
  // two actions are contradictory and only one should be offered at a time.
  const isTerminalLocked = Boolean(terminalSession?.reapExempt)
  // Same precondition as suspend on purpose: lock and pause are the two faces
  // of the same live-terminal control cluster.
  const canLockTerminal = canSuspendTerminal
  const toggleTerminalLock = () => {
    if (!effectiveSessionId) return
    // Feature-guard: against an old preload (dev HMR, stale built renderer)
    // the method is missing and an unguarded call would throw synchronously
    // in the click handler — the .catch only covers the promise.
    if (typeof window.api.setTerminalReapExempt !== 'function') return
    void window.api.setTerminalReapExempt(effectiveSessionId, !isTerminalLocked).catch(() => {})
  }
  // "Use a skill": live PTY agents only. Worktree agents are excluded like the
  // backlog file-drop path — ensure-install writes the main checkout's harness
  // dirs, which a worktree CLI does not read.
  const workspaceFolderPath = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null,
  )
  const isWorktreeAgent = agent?.execution.mode === 'worktree'
  const canUseSkill = canSuspendTerminal && !isConversationRuntime && !isWorktreeAgent && Boolean(workspaceFolderPath)
  // The star opens the search-everywhere palette narrowed to skills and
  // plugins, aimed at THIS pane.
  //
  // It used to open `SkillPickerPopover`: a list of the skills the workspace
  // already had, with a substring filter. That answered "which of the ones I
  // have", which is not the question a person asks at a terminal — they ask
  // "is there a skill for this", and the answer usually lives in a source they
  // have not installed from yet. The palette searches every source's cached
  // scan as well as the inventory, and because the request carries this
  // session, choosing a row installs it and pastes its invocation HERE without
  // asking which agent. (The picker itself stays: the composer and the
  // workspace aside still list installed skills, which is their right
  // question.)
  const openSkillSearch = () => {
    if (!effectiveSessionId) return
    requestPaletteOpen({
      scope: 'skills',
      target: { sessionId: effectiveSessionId, cli: cli ?? undefined, workspaceId },
    })
  }
  const suspendTerminal = () => {
    if (!effectiveSessionId) return
    void window.api.terminalSuspend(effectiveSessionId).catch(() => {})
  }
  // Resume is owned by TerminalView (it holds the relaunch payload + keystroke
  // buffer), so the paused footer asks it to resume via a window event keyed by
  // session id — same path as typing into the suspended terminal.
  const resumeTerminal = () => {
    if (!effectiveSessionId) return
    window.dispatchEvent(new CustomEvent('sprintengine:resume-terminal', { detail: { sessionId: effectiveSessionId } }))
  }
  if (isConversationRuntime) {
    // A chat that throws while rendering, or whose code fails to load, stops
    // in its own pane rather than taking the window with it.
    return (
      <ChatViewErrorBoundary chatKey={`${workspaceId}:${agentId}`}>
        <React.Suspense fallback={null}>
          <AgentChatView workspaceId={workspaceId} agentId={agentId} />
        </React.Suspense>
      </ChatViewErrorBoundary>
    )
  }

  // The Backlog item this agent was handed, if any. Powers the glyph that
  // navigates back to it in the workspace pane's Backlog tab.
  const backlogItemRef = agent?.backlogItemRef
  const openLinkedBacklogItem = () => {
    if (!backlogItemRef) return
    revealBacklogItemInPane(workspaceId, backlogItemRef.relativePath)
  }

  return (
    <div className="flex h-full flex-col bg-[color:var(--bg-surface)] font-mono text-meta text-[color:var(--text-default)]">
      {/* No needs-input tint on the pane: the workspace tab's lifecycle glyph
          already carries that state, and a 1px tone-coloured inset line said it a
          second time by colour alone (2026-09-02, status-said-twice). */}
      <div className="group relative flex flex-1 flex-col overflow-hidden bg-[color:var(--bg-app)]">
        {hasStarted && (canSuspendTerminal || canLockTerminal || backlogItemRef || canUseSkill) ? (
          // The positioning lives on this wrapper, not the buttons: Tooltip wraps
          // its child in a `position: relative` span, so an `absolute` child
          // would anchor to that zero-size span (off-screen) instead of the
          // terminal surface. Liveness shows on the workspace tab (single source
          // of truth); here we keep the skill picker, pause, lock, and Backlog
          // link. The suspended state is surfaced by the quiet footer below,
          // not a button.
          <div className="absolute right-2 top-2 z-[var(--z-float)] flex items-center gap-1.5">
            {canUseSkill ? (
              <Tooltip content="Find a skill or plugin — Shift Shift" placement="bottom">
                {/* Kit icon button on the raised ground so it stays legible
                    over terminal output; hover-revealed, and focus-revealed
                    for the keyboard. */}
                <IconButton
                  onClick={openSkillSearch}
                  aria-label="Find a skill or plugin for this agent"
                  className="bg-[color:var(--bg-surface-raised)] opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <StarGlyph filled={false} stroked className="size-icon-sm" />
                </IconButton>
              </Tooltip>
            ) : null}
            {canSuspendTerminal && !isTerminalLocked ? (
              // Hover-revealed so it doesn't clutter the live terminal; the same
              // pause glyph as the suspended state (context disambiguates: a
              // button while live, a status indicator once suspended). Hidden
              // while locked — the lock's whole promise is "never paused".
              <Tooltip content="Suspend agent — free its memory, keep the output to read" placement="bottom">
                <IconButton
                  onClick={suspendTerminal}
                  aria-label="Suspend agent to free memory"
                  className="bg-[color:var(--bg-surface-raised)] opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <svg viewBox="0 0 16 16" fill="none" className="size-icon-sm" aria-hidden="true">
                    <rect x="5" y="4" width="2" height="8" rx="1" fill="currentColor" />
                    <rect x="9" y="4" width="2" height="8" rx="1" fill="currentColor" />
                  </svg>
                </IconButton>
              </Tooltip>
            ) : null}
            {canLockTerminal ? (
              // Lock ("keep running"): exempts this terminal from automatic
              // pausing. Locked state stays visible as a standing status mark;
              // unlocked is hover-revealed like its neighbors.
              <Tooltip
                content={
                  isTerminalLocked
                    ? 'Locked — never paused automatically. Click to unlock.'
                    : 'Lock — keep this terminal running, never pause it automatically'
                }
                placement="bottom"
              >
                <IconButton
                  onClick={toggleTerminalLock}
                  aria-label={
                    isTerminalLocked
                      ? 'Unlock terminal — allow automatic pausing'
                      : 'Lock terminal — never pause automatically'
                  }
                  aria-pressed={isTerminalLocked}
                  // The fill and the ink of the pressed state belong to the
                  // primitive (`pressed`), not to this className: spelled here
                  // they met `GHOST_TONE`'s own utilities at equal specificity
                  // and lost the hover step outright. What stays is the only
                  // thing local — a locked terminal keeps its glyph standing
                  // while its neighbours are hover-revealed.
                  pressed={isTerminalLocked}
                  className={`transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 ${
                    isTerminalLocked ? 'opacity-100' : 'bg-[color:var(--bg-surface-raised)] opacity-0'
                  }`}
                >
                  {isTerminalLocked ? (
                    // Closed padlock: shackle seated on the body.
                    <svg viewBox="0 0 16 16" fill="none" className="size-icon-sm" aria-hidden="true">
                      <rect x="3.75" y="7" width="8.5" height="5.75" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                      <path
                        d="M5.75 7V5.4a2.25 2.25 0 0 1 4.5 0V7"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                      />
                    </svg>
                  ) : (
                    // Open padlock: right leg of the shackle lifted clear of the body.
                    <svg viewBox="0 0 16 16" fill="none" className="size-icon-sm" aria-hidden="true">
                      <rect x="3.75" y="7" width="8.5" height="5.75" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                      <path
                        d="M5.75 7V4.4a2.25 2.25 0 0 1 4.5 0v.35"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                      />
                    </svg>
                  )}
                </IconButton>
              </Tooltip>
            ) : null}
            {backlogItemRef ? (
              <Tooltip content={`Open Backlog item: ${backlogItemRef.title}`} placement="bottom">
                <IconButton
                  onClick={openLinkedBacklogItem}
                  aria-label={`Open Backlog item: ${backlogItemRef.title}`}
                  className="bg-[color:var(--bg-surface-raised)]"
                >
                  {/* The same glyph as the header's Backlog switch and the pane's
                      Backlog tab, so the iconography reads as "the Backlog". */}
                  <svg viewBox="0 0 16 16" fill="none" className="size-icon-sm" aria-hidden="true">
                    <path d="M6 4.5h7M6 8h7M6 11.5h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    <circle cx="3" cy="4.5" r="1" fill="currentColor" />
                    <circle cx="3" cy="8" r="1" fill="currentColor" />
                    <circle cx="3" cy="11.5" r="1" fill="currentColor" />
                  </svg>
                </IconButton>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
        {/* Terminal area. `min-h-0` lets it shrink so the paused footer below can
            reserve its strip without ever overlapping output; TerminalView is
            `absolute inset-0`, so it anchors to this relative box (not the pane),
            and its ResizeObserver refits xterm when the footer claims/releases
            space. */}
        <div className="relative min-h-0 flex-1">
          {hasStarted ? (
            <React.Suspense fallback={null}>
              <TerminalView
                workspaceId={workspaceId}
                agentId={agentId}
                sessionId={sessionId}
                shouldKillOnUnmount={shouldKillTerminalOnUnmount}
              />
            </React.Suspense>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-5 text-center">
              <div className="max-w-sm text-meta leading-5 text-[color:var(--text-muted)]">
                Agent CLI "{cli}" is not installed. Install it before launching this agent.
              </div>
              <CliInstallCta />
            </div>
          )}
        </div>
        {/* Paused indicator: a quiet, reserved footer (not an overlay) so the
            frozen scrollback above stays fully readable and scrollable. It is the
            whole resume affordance — keyboard-focusable, click resumes (typing or
            a click on the pane also resume). It leaves the moment a resume starts
            (see isResumePending) and the pane's working edge takes over as the
            feedback. The wrapper stays mounted (inert at 0fr) so a pause animates
            the strip in instead of jumping the pane by a row; leaving for a
            resume is immediate, because TerminalView fits the pane to its final
            size before it relaunches the CLI. */}
        {hasStarted ? (
          <div
            aria-hidden={!showPausedStrip}
            className={`grid flex-none motion-reduce:transition-none ${
              isResumePending ? '' : 'transition-[grid-template-rows] duration-200 ease-out'
            } ${showPausedStrip ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
          >
            {/* The strip's own surface — the hairline and the ground — sits on
                this wrapper rather than on the row, so the row inside it is only
                the control and takes the kit's row inset, ink and hover. */}
            <div className="overflow-hidden border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-app)]">
              <RowButton
                density="bleed"
                onClick={resumeTerminal}
                tabIndex={showPausedStrip ? 0 : -1}
                aria-label="Resume paused agent — click or type to resume"
                className="group text-micro"
              >
                {/* Pause glyph, low-opacity — a status mark, not a call to action. */}
                <svg viewBox="0 0 16 16" fill="none" className="size-icon-xs opacity-60" aria-hidden="true">
                  <rect x="5" y="4" width="2" height="8" rx="1" fill="currentColor" />
                  <rect x="9" y="4" width="2" height="8" rx="1" fill="currentColor" />
                </svg>
                <span>Paused</span>
                {/* Hint stays hidden until pane hover (kept low-key), but reveals
                    at full muted contrast — a reduced opacity here fell under the
                    WCAG AA text threshold against --bg-app.
                    The keyboard path is this button's own `group` plus
                    `group-focus-visible`, not the pane's `focus-within`: the pane
                    holds the terminal, so focus-within there would pin the hint
                    open for the whole session instead of disclosing it. */}
                <span className="ml-auto opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none">
                  click or type to resume
                </span>
              </RowButton>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
