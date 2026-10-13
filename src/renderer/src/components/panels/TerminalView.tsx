import { NotOnMachineYet, useWorkspaceMachine } from '../environments/NotOnMachineYet'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hostIdForFolder, isWslHostId } from '../../../../shared/execution-host'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import type { AgentExecution, AgentExecutionMode } from '../../types/workspace'
import type {
  AgentSessionIdentity,
  AgentSessionSystem,
  TerminalSpawnMetadata,
  TerminalSpawnResult,
} from '../../../../shared/electron-api'
import { useSession } from '../../hooks/useTerminalSessions'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { recordReplayProfile } from '../../utils/diagnostics/replayProfileStore'
import { createTerminalFitScheduler } from '../../utils/terminalFitScheduler'
import { onTerminalFocusRequest } from '../../utils/terminalFocusRequest'
import { createTerminalDiagnostics } from '../../utils/terminalDiagnostics'
import { createStudioTerminal, type StudioTerminal, type TerminalSurface } from '../../utils/createStudioTerminal'
import { useTerminalFind } from '../../hooks/useTerminalFind'
import { isTerminalChromeTarget, TERMINAL_SURFACE_ATTRIBUTE } from '../../utils/keyboard'
import { TerminalFindBar } from '../terminal/TerminalFindBar'
import { TerminalJumpToLatest } from '../terminal/TerminalJumpToLatest'
import { createTerminalFileLinkProvider, terminalWslDistro } from '../../utils/terminalFileLinks'
import { createXtermOutputQueue, createXtermReplayGate } from '../../utils/xtermOutputQueue'
import { createSessionAckReporter } from '../../utils/terminalOutputAck'
import { registerTerminalInstance, unregisterTerminalInstance } from '../../utils/diagnostics/terminalInstanceRegistry'
import { TerminalReplaySkeleton } from '../ui/TerminalReplaySkeleton'
import { WorkingEdge } from '../ui/WorkingEdge'
import { bindTerminalClipboardHandlers, claudeImagePasteKey } from '../../utils/terminalClipboard'
import { windowActivity } from '../../utils/windowActivity'
import { clearPaneAttachedHidden, notePaneAttachedHidden } from '../../utils/terminalPaneVisibility'
import {
  hasCommitDropData,
  hasFileDropData,
  hasSkillDropData,
  pasteDroppedCommitIntoTerminal,
  pasteDroppedFilesIntoTerminal,
  pasteDroppedSkillIntoTerminal,
} from '../../utils/terminalDrop'
import { recordBacklogAgentHandoff } from '../../utils/backlogAgentHandoff'
import { resolveProjectKnowledgeConfig } from '../../utils/projectKnowledge'
import { knowledgeLaunchContext, type KnowledgeLaunchContext } from '../../../../shared/project-knowledge'
import { resolveAgentCliPermissionPreset } from '../../utils/agentCliPermissions'
import { agentCliSupportsConversationResume, agentCliUsesStableSessionIdForResume } from '../../utils/agentCliResume'
import { resumeCapabilitiesForCli } from '../../store/slices/pluginsSlice'
import {
  resolveWorkspaceTerminalCwd,
  resolveWorkspaceWorktree,
  resolveWorktreeSpawnFallback,
} from '../../utils/workspaceWorktree'
import { ensureChatWorktree } from '../../utils/chatWorktreeRestore'
import {
  clearAgentLaunchFailed,
  hasAgentLaunchFailedThisAppSession,
  hasLiveAgentLaunchIntent,
  markAgentLaunchFailed,
  markAgentSessionMinted,
  resolveAgentColdLoadDecision,
  wasAgentSessionMintedThisAppSession,
} from '../../utils/terminalColdLoad'
import type { McpSettings } from '../../types/workspace'
import { CursorErrorPopover } from '../ui/CursorErrorPopover'
import { TerminalMount } from '../terminal/TerminalMount'
import { FOCUS_RING_TERMINAL_CLASS } from '../ui/tokens'
import { TerminalLinkMenu } from '../terminal/TerminalLinkMenu'
import type { TerminalLinkTarget } from '../../utils/terminalLinkActions'
import { workspaceSyncClient } from '../../store/workspaceSyncClient'
import { hostPlatform } from '../../clientCapabilities'

interface Props {
  workspaceId: string
  agentId: string
  sessionId?: string
  shouldKillOnUnmount?: (sessionId: string) => boolean
}

type AgentExecutionRoot = {
  cwd: string | undefined
  mode: AgentExecutionMode
  worktreeId: string | undefined
  worktreePath: string | undefined
}

type MemoryLaunchContext = KnowledgeLaunchContext

const EMPTY_MCP_SETTINGS: McpSettings = { syncEnabled: false, servers: {} }

// Resolves after `count` animation frames: long enough for a layout change
// committed in this tick to reach the DOM and for its resize to be observed.
function nextAnimationFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (remaining: number) => {
      if (remaining <= 0) {
        resolve()
        return
      }
      window.requestAnimationFrame(() => step(remaining - 1))
    }
    step(count)
  })
}

function resolveAgentExecutionRoot(
  execution: AgentExecution | undefined,
  storedWorktreePath: string | undefined,
  workspaceReadyPath: string | null,
  workspaceWorktreeCwd: string | null,
): AgentExecutionRoot {
  if (execution?.mode !== 'worktree') {
    // A non-worktree agent (manually-added conversation agent, agent whose
    // execution predates baked worktree metadata, or cleared execution) in a
    // worktree-backed workspace still belongs in that workspace's worktree, not
    // its parent folderPath. Redirect only the cwd; the mode stays
    // 'current_workspace' (Decision 6) and agent.execution is not mutated.
    return {
      cwd: workspaceWorktreeCwd ?? workspaceReadyPath ?? undefined,
      mode: 'current_workspace',
      worktreeId: undefined,
      worktreePath: undefined,
    }
  }

  const worktreePath = execution.cwd ?? storedWorktreePath

  return {
    cwd: worktreePath ?? workspaceReadyPath ?? undefined,
    mode: 'worktree',
    worktreeId: execution.worktreeId ?? undefined,
    worktreePath,
  }
}

async function resolveMemoryLaunchContext(
  workspaceRoot: string | null,
  relativeRoot: string | null,
): Promise<MemoryLaunchContext> {
  const configuredRoot = relativeRoot?.trim()
  if (!configuredRoot) return { promptSuffix: null, rootPath: undefined, relativeRoot: undefined }

  const status = await window.api
    .memoryResolveRoot({
      workspaceRoot,
      relativeRoot: configuredRoot,
    })
    .catch((error): MemoryRootStatus => ({
      ok: false,
      status: 'inaccessible',
      relativeRoot: configuredRoot,
      message: error instanceof Error ? error.message : 'Unable to resolve workspace knowledge.',
    }))

  // Resolved through `shared/project-knowledge` for the ENV VARS the spawn
  // payload carries (`memoryRootPath` / `memoryRelativeRoot`). The sentence that
  // tells the agent the graph exists is no longer read here: main builds it into
  // the host-context document, from this same pair, for every launcher.
  return knowledgeLaunchContext(status)
}

// How long a paste held for a resuming agent waits for the relaunched CLI's
// first frame before it goes anyway. Well past the resume hold's own limits
// (a one-second first-frame deadline, two seconds to settle), which cover
// every CLI that prints at all.
const RESUME_INPUT_FALLBACK_MS = 5_000

/** Input taken while a paused agent's CLI is not yet reading it. */
type PendingResumeInput = { kind: 'keys'; data: string } | { kind: 'paste'; text: string }

/**
 * Whether this pane is being painted right now, as far as the pane can tell:
 * its window is visible. A pane mounting in a minimized, hidden or locked
 * window says so, instead of claiming to be on screen and being fed — and
 * waited on for acknowledgements a throttled page gives slowly — until
 * WorkspaceManager next corrects it. Whether its workspace is the active one
 * is WorkspaceManager's to say; it re-sends the answer whenever main reports
 * something else.
 */
function paneIsPainted(): boolean {
  return windowActivity().get().visible
}

function TerminalViewOnThisComputer({
  workspaceId,
  agentId,
  sessionId: attachedSessionId,
  shouldKillOnUnmount,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  // The padding-free box xterm is opened into; see TerminalMount.
  const terminalMountRef = useRef<HTMLDivElement>(null)
  const focusTerminalRef = useRef<() => void>(() => {
    containerRef.current?.focus()
  })
  // The live terminal, for anything outside the mount effect that needs it —
  // today `useTerminalFind`, which loads the search addon on the first find.
  const studioTerminalRef = useRef<StudioTerminal | null>(null)
  const find = useTerminalFind({ workspaceId, containerRef, terminalRef: studioTerminalRef })
  // Scrolled up away from the newest output, so "Jump to latest" is offered.
  const [scrolledAway, setScrolledAway] = useState(false)
  // Back to the bottom, and the keyboard back to the agent: the person jumped
  // there to see what it is doing now, usually to answer it.
  const jumpToLatest = () => {
    studioTerminalRef.current?.terminal.scrollToBottom()
    focusTerminalRef.current()
  }
  const [isFileDragOver, setIsFileDragOver] = useState(false)
  // A failed file-link click or file drop, anchored to the pointer that raised
  // it so the error surfaces next to the cursor instead of a corner toast.
  const [clickError, setClickError] = useState<{ message: string; x: number; y: number } | null>(null)
  // A clicked link awaiting a destination. Both link kinds — file
  // paths and http(s) URLs — route here instead of firing one hard-wired action.
  const [linkMenu, setLinkMenu] = useState<{
    target: TerminalLinkTarget
    x: number
    y: number
    line?: number
    column?: number
  } | null>(null)
  const agent = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.agents[agentId])
  const workspaceName = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.name)
  // Freeze-the-view resume: when this terminal's session is suspended (agent
  // process killed, scrollback painted), the first keystroke relaunches it under
  // the same id with --resume and flushes the keys typed during the boot. These
  // refs let the one-time `onData` handler read the live suspended state and the
  // captured resume thunk WITHOUT re-running the launch effect (which would
  // dispose the painted term).
  const effectiveSessionId = attachedSessionId ?? agent?.cliSessionId
  const suspendedSession = useSession(
    useCallback((s) => Boolean(effectiveSessionId) && s.sessionId === effectiveSessionId, [effectiveSessionId]),
  )
  const suspendedRef = useRef(false)
  const resumeThunkRef = useRef<(() => Promise<TerminalSpawnResult>) | null>(null)
  // What the person typed or pasted into a paused pane, in order, for the
  // relaunched CLI. Keystrokes go as soon as the relaunch is up (the pty holds
  // them until the CLI reads); a paste waits until the CLI's first frame is on
  // screen, because only then has xterm seen whether the CLI asked for
  // bracketed paste — pasted with the frozen view's modes, a multi-line paste
  // is read as typed lines and submitted at the first newline. Anything typed
  // behind a waiting paste waits with it, so nothing overtakes it.
  const pendingResumeInputRef = useRef<PendingResumeInput[]>([])
  const resumingRef = useRef(false)
  // Whether the relaunch resumes a conversation the CLI renders again itself —
  // in which case its render replaces the frozen view instead of following it.
  // Set beside `resumeThunkRef`, from the same resume capabilities.
  const resumeReplacesFrozenViewRef = useRef(false)
  // From the resume gesture until the relaunched CLI's first frame is on
  // screen: the working edge runs round the pane while the frozen view stays.
  const [isResuming, setIsResuming] = useState(false)
  // Cold-loaded with nothing to paint and nobody asking for it (decision 'inert',
  // utils/terminalColdLoad.ts). The tab is deliberately dead: no pty, no replay.
  // A click or keystroke is the user asking for it, which is what starts it.
  const inertRef = useRef(false)
  // Set by the launch effect (which owns the xterm instance) so this
  // store-driven sync can freeze/unfreeze the cursor: a blinking cursor is a
  // liveness signal, and a suspended snapshot is not live.
  const applyCursorFrozenRef = useRef<((frozen: boolean) => void) | null>(null)
  useEffect(() => {
    suspendedRef.current = Boolean(suspendedSession?.suspended)
    applyCursorFrozenRef.current?.(suspendedRef.current)
  }, [suspendedSession?.suspended])
  const {
    folderPath: savedFolderPath,
    folderReadyPath,
    folderMissing,
    checkingFolder,
    message: folderStatusMessage,
  } = useWorkspaceFolderStatus(workspaceId)
  const workspaceFolderPath = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath)
  const workspaceMemoryRelativeRoot = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.memory.relativeRoot,
  )
  const projectKnowledgeRoots = useWorkspaceStore((s) => s.appSettings.projectKnowledgeRoots)
  const memoryConfig = useMemo(
    () => resolveProjectKnowledgeConfig(workspaceFolderPath, projectKnowledgeRoots, workspaceMemoryRelativeRoot),
    [workspaceFolderPath, projectKnowledgeRoots, workspaceMemoryRelativeRoot],
  )
  const cliPermissionPreset = useWorkspaceStore((s) => {
    const workspace = s.workspaces.find((w) => w.id === workspaceId)
    return resolveAgentCliPermissionPreset(workspace, agentId)
  })
  const storedExecutionWorktreePath = useWorkspaceStore((s) => {
    const workspace = s.workspaces.find((w) => w.id === workspaceId)
    const worktreeId = workspace?.agents[agentId]?.execution.worktreeId
    return worktreeId ? workspace?.worktreeState.entries[worktreeId]?.path : undefined
  })
  // Derived string, not the workspace object: a workspace record churns object
  // identity on every store write, but the worktree gitRoot string is stable,
  // so the launch effect below re-runs at most once (null -> path).
  const workspaceWorktreeGitRoot = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return ws ? (resolveWorkspaceWorktree(ws)?.gitRoot ?? null) : null
  })
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  // The machine this agent runs on: its own once it has launched somewhere,
  // else its workspace's. Main keeps a resumed session on the machine it ran
  // on whatever this says; this is what a fresh launch asks for.
  const hostId = useWorkspaceStore((s) => {
    const workspace = s.workspaces.find((w) => w.id === workspaceId)
    // A workspace from before hosts, inside a distribution, runs there too.
    return agent?.hostId ?? workspace?.hostId ?? hostIdForFolder(workspace?.folderPath) ?? undefined
  })
  const mcpSettings = useWorkspaceStore((s) => s.appSettings.mcp ?? EMPTY_MCP_SETTINGS)
  const cli = agent?.cli
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const openFile = useWorkspaceStore((s) => s.openFile)
  const startupPrompt = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.agents[agentId]?.cliStartupPrompt ?? null,
  )
  const startupPromptRef = useRef<string | null>(startupPrompt)

  useEffect(() => {
    startupPromptRef.current = startupPrompt
  }, [startupPrompt])

  const launchContextRef = useRef({
    agent,
    cli,
    cliPermissionPreset,
    cliRuntimes,
    hostId,
    mcpSettings,
    memoryConfig,
    openFile,
    savedFolderPath,
    storedExecutionWorktreePath,
    updateAgent,
    workspaceName,
  })

  useEffect(() => {
    launchContextRef.current = {
      agent,
      cli,
      cliPermissionPreset,
      cliRuntimes,
      hostId,
      mcpSettings,
      memoryConfig,
      openFile,
      savedFolderPath,
      storedExecutionWorktreePath,
      updateAgent,
      workspaceName,
    }
  }, [
    agent,
    cli,
    cliPermissionPreset,
    cliRuntimes,
    hostId,
    mcpSettings,
    memoryConfig,
    openFile,
    savedFolderPath,
    storedExecutionWorktreePath,
    updateAgent,
    workspaceName,
  ])

  useEffect(() => {
    const currentContext = () => launchContextRef.current
    const initialContext = currentContext()
    const container = containerRef.current
    const mount = terminalMountRef.current
    if (!container || !mount) return
    if (initialContext.savedFolderPath && !folderReadyPath) return
    if (!initialContext.agent) return
    if (!initialContext.cli) {
      publishDiagnosticSync({
        level: 'error',
        source: 'terminal',
        title: `${initialContext.agent?.name ?? agentId} was not started`,
        message: 'Agent terminal is missing its CLI selection.',
        details: [
          `Workspace: ${initialContext.workspaceName}`,
          `Workspace ID: ${workspaceId}`,
          `Agent ID: ${agentId}`,
        ].join('\n'),
        workspaceId,
        workspaceName: initialContext.workspaceName,
        agentId,
      })
      return
    }

    if (!initialContext.agent?.cliSessionId && !attachedSessionId) {
      // [switch-regression] If this fires on a workspace switch, the agent's
      // cliSessionId was cleared while the PTY was still alive — relaunching with
      // a fresh id makes the main runtime dispose the old (live) session.
      logPerfEvent('TerminalView', 'terminal-spawn-fresh-after-switch-risk', {
        workspaceId,
        agentId,
        cli: initialContext.cli,
        reason: 'missing-cli-session-id',
      })
      // Remember that WE minted this id. A workspace's template agents are seeded
      // with no session id and no launch flags and rely on this branch to give
      // them one — which makes them look exactly like a cold-loaded record by the
      // time the launch decision runs. The mint registry is what tells them apart,
      // so a brand-new workspace's agent still spawns instead of sitting inert.
      const mintedSessionId = crypto.randomUUID()
      // Only a brand-new agent's minted id is allowed to force a spawn (cold-load
      // rule 5). If THIS agent's launch already failed this session (e.g. a missing
      // API key), the failure branch cleared its id and we are back here only
      // because of that clear — do NOT mark the replacement id as minted, or the
      // decision reads `spawn`, the spawn fails again, and it loops every tick,
      // spamming a notification each time. Leaving it unmarked lets the next
      // decision fall through to `inert`: the tab paints "click or type to start"
      // and waits, and a deliberate start clears the failure marker.
      if (!hasAgentLaunchFailedThisAppSession(workspaceId, agentId)) {
        markAgentSessionMinted(mintedSessionId)
      }
      initialContext.updateAgent(workspaceId, agentId, {
        cliSessionId: mintedSessionId,
        cliHasLaunched: false,
      })
      return
    }

    const sessionId = attachedSessionId ?? initialContext.agent?.cliSessionId
    if (!sessionId) return
    const shouldResume = attachedSessionId ? true : (initialContext.agent?.cliHasLaunched ?? false)
    const shouldResumeCodexConversation =
      initialContext.cli === 'codex' && Boolean(initialContext.agent?.cliResumeAvailable)
    // The roots a relative path in this pane resolves against. Both are null
    // exactly when the workspace has no configured folder — the launch effect
    // deliberately runs for that case (see the `savedFolderPath` guard above) —
    // and every relative match is then dropped, which is what `onDrop` below
    // makes countable.
    //
    // The last argument is `null` because the worktree cwd is only knowable
    // behind an async `pathExists`, which this synchronous registration cannot
    // wait on. That used to be the end of it, and it was wrong in a way nothing
    // showed: a non-worktree agent in a worktree-backed workspace resolved links
    // against the PARENT checkout while its process ran in the worktree, so a
    // clicked relative path opened the same file in the wrong copy rather than
    // failing. It is a starting value now — the launch path below overwrites
    // `launchExecutionRoot` with the cwd the pty actually got, and the provider
    // reads that through a thunk.
    const linkExecutionRoot = resolveAgentExecutionRoot(
      currentContext().agent?.execution,
      currentContext().storedExecutionWorktreePath,
      folderReadyPath,
      null,
    )
    let launchExecutionRoot: string | null = linkExecutionRoot.cwd ?? null
    const terminalSurface: TerminalSurface = {
      kind: 'agent',
      workspaceRoot: folderReadyPath ?? currentContext().savedFolderPath ?? null,
      executionRoot: linkExecutionRoot.cwd ?? null,
    }
    // statPath rejects for a path that is gone or unreadable; that routes to the
    // error popover, so a dead link never opens a menu of actions that would all
    // fail. Shared by the OSC 8 handler and the heuristic provider below.
    const inspectPath = async (path: string): Promise<{ exists: boolean; isDirectory: boolean }> => {
      try {
        const stat = await window.api.statPath(path)
        return { exists: true, isDirectory: stat.isDirectory }
      } catch {
        return { exists: false, isDirectory: false }
      }
    }
    const studioTerminal = createStudioTerminal({
      surface: terminalSurface,
      // OSC 8: a real hyperlink the CLI emitted, which carries its own absolute
      // target and needs no guessing. It rides the same chooser as everything
      // else — the click still asks rather than deciding.
      oscLinks: {
        inspectPath,
        onActivateFile: ({ resolvedPath, isDirectory }, anchor) => {
          setLinkMenu({
            target: {
              kind: 'file',
              resolvedPath,
              isDirectory,
              workspaceRoot: terminalSurface.workspaceRoot,
            },
            x: anchor.x,
            y: anchor.y,
          })
        },
        onActivateUrl: (url, anchor) => {
          setLinkMenu({ target: { kind: 'url', url }, x: anchor.x, y: anchor.y })
        },
        onOpenError: (message, anchor) => setClickError({ message, x: anchor.x, y: anchor.y }),
      },
      onWebLink: (event, uri) => {
        setLinkMenu({ target: { kind: 'url', url: uri }, x: event.clientX, y: event.clientY })
      },
      onScrolledAwayChange: setScrolledAway,
    })
    studioTerminalRef.current = studioTerminal
    const term = studioTerminal.terminal
    const fitAddon = studioTerminal.fitAddon
    const terminalDiagnostics = createTerminalDiagnostics({
      scope: 'TerminalView',
      sessionId,
      workspaceId,
      agentId,
      kind: 'agent',
    })

    const fitTerminal = () => {
      if (mount.clientWidth === 0 || mount.clientHeight === 0) return
      fitAddon.fit()
      if (term.cols > 0 && term.rows > 0) {
        void window.api.terminalResize(sessionId, term.cols, term.rows)
      }
    }

    /**
     * Take the pty's size back for this screen.
     *
     * A pty has ONE size and every attached client shares it, so a phone
     * opening this thread resizes it to about 40 columns and the terminal here
     * reflows to match (owner, 2026-09-05: "how do I get it to resize to the
     * correct size again on the computer?"). Focusing it here is the answer —
     * the same last-writer-wins rule, driven from the side you are actually
     * working on.
     *
     * It sends the dimensions this terminal already has rather than re-fitting:
     * nothing about THIS window changed, so a fit would compute the same
     * numbers it already holds. What has to change is the pty's idea of them.
     */
    const reclaimPtySize = () => {
      if (term.cols > 0 && term.rows > 0) {
        void window.api.terminalResize(sessionId, term.cols, term.rows)
      }
    }

    const focusTerminal = () => {
      terminalDiagnostics.recordFocus()
      term.focus()
      reclaimPtySize()
    }
    focusTerminalRef.current = focusTerminal

    // Suspended = frozen: stop the cursor blinking so the snapshot doesn't
    // impersonate a live terminal. Applied immediately (the session may already
    // be suspended when this term mounts) and re-applied by the suspend sync
    // effect whenever the store flag changes.
    const setCursorFrozen = (frozen: boolean) => {
      term.options.cursorBlink = !frozen
    }
    applyCursorFrozenRef.current = setCursorFrozen
    setCursorFrozen(suspendedRef.current)

    // Register for scrollback-footprint diagnostics; unregistered on dispose.
    registerTerminalInstance(sessionId, term)
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown') {
        terminalDiagnostics.recordKeydown(event)
      }
      if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey) {
        event.preventDefault()
        window.api.terminalWriteFast(sessionId, '\u001b[13;2u')
        terminalDiagnostics.recordInputDispatch('\u001b[13;2u')
        return false
      }
      return true
    })
    term.open(mount)
    // Immediately after `open()`: the WebGL addon reads `term.element`, and a
    // GPU failure loaded before that point escapes through `open()` itself.
    studioTerminal.loadWebglRenderer()
    fitTerminal()
    focusTerminal()

    // Clicking the terminal focuses xterm's own textarea directly, so the
    // reclaim rides THAT rather than `focusTerminal`, which only runs on the
    // programmatic paths (mount, and a drop onto the pane).
    const textarea = term.textarea
    textarea?.addEventListener('focus', reclaimPtySize)

    const linkRoots = studioTerminal.linkRoots
    const fileLinkDisposable = term.registerLinkProvider(
      createTerminalFileLinkProvider({
        terminal: term,
        workspaceRoot: linkRoots.workspaceRoot,
        // A thunk, so the correction the launch path makes below reaches the links
        // already on screen without re-registering the provider.
        executionRoot: () => launchExecutionRoot,
        // An agent under WSL prints Linux paths; the provider needs the
        // distribution to hand Windows a path it can open. Read late, like
        // the root.
        wslDistro: () =>
          terminalWslDistro({
            platform: hostPlatform(),
            hostId: currentContext().hostId,
            roots: [launchExecutionRoot, linkRoots.workspaceRoot],
          }),
        inspectPath,
        // The click no longer decides anything — it opens the chooser.
        onActivate: ({ resolvedPath, isDirectory, line, column }, anchor) => {
          setLinkMenu({
            target: { kind: 'file', resolvedPath, isDirectory, workspaceRoot: linkRoots.workspaceRoot },
            x: anchor.x,
            y: anchor.y,
            line,
            column,
          })
        },
        onOpenError: (message, anchor) => setClickError({ message, x: anchor.x, y: anchor.y }),
        // A matched path that never became a link leaves no trace on screen, so
        // count it. Both roots are null for a workspace with no configured folder
        // — the case this effect deliberately runs for — and every relative path
        // in the pane is then dropped for `no-root`, which is the one shape of
        // "the terminal linkifies nothing" a user can actually report.
        onDrop: terminalDiagnostics.recordFileLinkDrop,
      }),
    )

    // Loaded AFTER the file-link provider on purpose: xterm resolves link
    // providers in registration order and the earlier one's links suppress the
    // later one's on the same row, so a path that is also a valid URL fragment
    // must reach the file provider first.
    studioTerminal.loadWebLinks()

    let disposed = false
    // Fits once the code face has loaded, and again whenever Settings changes
    // it: the cells change size under a container that does not.
    studioTerminal.followCodeFont(() => {
      if (disposed) return
      fitTerminal()
      term.refresh(0, Math.max(0, term.rows - 1))
    })
    let reportedTerminalFailure = false
    let terminalLaunchDetails = [
      `Session: ${sessionId}`,
      `CLI: ${initialContext.cli}${initialContext.agent?.cliModel ? ` · ${initialContext.agent.cliModel}` : ''}`,
      `Workspace path: ${folderReadyPath ?? initialContext.savedFolderPath ?? 'default app path'}`,
    ].join('\n')
    // Flow control: tell main what this pane has parsed, so a burst the pane
    // cannot keep up with pauses the pty instead of queueing ahead of the
    // person's own keystroke echo.
    const ackReporter = createSessionAckReporter(sessionId)
    const outputQueue = createXtermOutputQueue(term, {
      recordWrite: terminalDiagnostics.recordOutputWrite,
      onConsumed: ackReporter.ack,
    })
    const replayGate = createXtermReplayGate(term, outputQueue, {
      recordWrite: terminalDiagnostics.recordOutputWrite,
      onResumeRelease: (release) => {
        if (disposed) return
        setIsResuming(false)
        resumeOutputLanded(release.reason === 'exit')
        logPerfEvent('TerminalView', 'terminal-resume-revealed', {
          sessionId,
          workspaceId,
          agentId,
          kind: 'agent',
          reason: release.reason,
          replacedFrozenView: release.replaceFrozenView,
          heldChars: release.data.length,
        })
      },
      onReplayProfile: (profile) => {
        logPerfEvent('TerminalView', 'terminal-replay-profile', {
          sessionId,
          workspaceId,
          agentId,
          kind: 'agent',
          ...profile,
        })
        recordReplayProfile({
          ...profile,
          recordedAt: Date.now(),
          sessionId,
          workspaceId,
          agentId,
          kind: 'agent',
        })
      },
    })

    const disposeData = window.api.onTerminalData(sessionId, (data) => {
      replayGate.handleLiveData(data)
    })
    const disposeReplay = window.api.onTerminalReplay(sessionId, (data) => {
      replayGate.handleReplay(data)
    })

    const disposeExit = window.api.onTerminalExit(sessionId, (code) => {
      const latestContext = currentContext()
      // If the process died mid-resume, reveal any held start-up output first so
      // a genuine startup error surfaces ahead of the exit banner — under the
      // frozen view, which stays.
      replayGate.releaseResumeHoldForExit()
      term.write(`\r\n\x1b[31m[Terminal exited with code ${code}]\x1b[0m\r\n`)
      const currentSessionId = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)?.agents[
        agentId
      ]?.cliSessionId
      if (code !== 0 && !reportedTerminalFailure) {
        reportedTerminalFailure = true
        publishDiagnosticSync({
          level: 'error',
          source: 'terminal',
          title: `${latestContext.agent?.name ?? agentId} exited`,
          message: `Terminal exited with code ${code}.`,
          details: terminalLaunchDetails,
          workspaceId,
          workspaceName: latestContext.workspaceName,
          agentId,
          sessionId,
        })
      }
      if (currentSessionId !== sessionId) return
      latestContext.updateAgent(workspaceId, agentId, {
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
        cliLastExitCode: code,
        cliLastExitedAt: Date.now(),
      })
      void workspaceSyncClient.dispatchUpdateTerminalLaunchState(workspaceId, agentId, {
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
      })
    })

    const disposeError = window.api.onTerminalError(sessionId, (message) => {
      const latestContext = currentContext()
      term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`)
      reportedTerminalFailure = true
      publishDiagnosticSync({
        level: 'error',
        source: 'terminal',
        title: `${latestContext.agent?.name ?? agentId} failed to start`,
        message,
        details: terminalLaunchDetails,
        workspaceId,
        workspaceName: latestContext.workspaceName,
        agentId,
        sessionId,
      })
    })

    // Input for a resuming agent (see `pendingResumeInputRef`). Held from the
    // resume gesture until both the relaunch has succeeded and the relaunched
    // CLI's first frame is on screen; keystrokes ahead of the first paste go
    // as soon as the relaunch succeeds.
    let resumeInputHeld = false
    let resumeLaunched = false
    let resumeFrameShown = false
    let deliveringResumeInput = false
    // Which resume a timer belongs to, so one from an earlier attempt cannot
    // let a later attempt's input go early.
    let resumeGeneration = 0

    const deliverResumeInput = (upToFirstPaste: boolean): void => {
      const queue = pendingResumeInputRef.current
      deliveringResumeInput = true
      try {
        while (queue.length > 0) {
          const next = queue[0] as PendingResumeInput
          if (next.kind === 'paste' && upToFirstPaste) return
          queue.shift()
          if (next.kind === 'keys') window.api.terminalWriteFast(sessionId, next.data)
          // Through xterm, now that it holds the live CLI's modes: bracketed
          // if that CLI asked for it, and out through `onData` like any paste.
          else term.paste(next.text)
        }
      } finally {
        deliveringResumeInput = false
      }
    }

    const deliverHeldResumeInput = (): void => {
      if (!resumeInputHeld || !resumeLaunched || !resumeFrameShown) return
      resumeInputHeld = false
      deliverResumeInput(false)
    }

    // The resume hold let go (gate `onResumeRelease`).
    const resumeOutputLanded = (exited: boolean): void => {
      if (!resumeInputHeld) return
      if (exited) {
        resumeInputHeld = false
        // A relaunch that failed keeps the input for the next attempt, as it
        // always has; a CLI that came up and died has nobody left to read it.
        if (resumeLaunched) pendingResumeInputRef.current = []
        return
      }
      replayGate.whenOutputWritten(() => {
        if (disposed) return
        resumeFrameShown = true
        deliverHeldResumeInput()
      })
    }

    // A paste into this pane (the clipboard handlers' `paste`).
    const pasteIntoPane = (text: string) => {
      if (suspendedRef.current && !inertRef.current) {
        pendingResumeInputRef.current.push({ kind: 'paste', text })
        void resumeFromSuspend()
        return
      }
      if (resumeInputHeld) {
        pendingResumeInputRef.current.push({ kind: 'paste', text })
        return
      }
      term.paste(text)
    }

    // Freeze-the-view: relaunch a suspended agent on the first keystroke, under
    // the same session id with --resume, then flush the keys typed during the
    // boot. Reuses the launch payload captured in `resumeThunkRef`; the existing
    // replay/data handlers on this same term pick up the resumed pty's output, so
    // the painted view is never torn down.
    //
    // The frozen view stays on screen, untouched, until the relaunched CLI's
    // first frame has arrived; the replay gate then swaps one for the other in a
    // single synchronized write (utils/terminalResumeHold.ts). Until then the
    // working edge says the click was heard.
    const resumeFromSuspend = async () => {
      if (resumingRef.current) return
      const resume = resumeThunkRef.current
      if (!resume) return
      resumingRef.current = true
      setIsResuming(true)
      resumeInputHeld = true
      resumeLaunched = false
      resumeFrameShown = false
      const generation = ++resumeGeneration
      // Tell the paused footer (AgentPanel) a resume is in flight. It gives its
      // row back to the pane now, not when the session stops reading suspended:
      // that happened after the relaunch, so the pane grew under a CLI that was
      // already drawing, and the resize made it clear and repaint its screen.
      // Success needs no counterpart event; failure rolls the footer back.
      window.dispatchEvent(
        new CustomEvent('sprintengine:terminal-resume-state', {
          detail: { sessionId, resuming: true },
        }),
      )
      // Let the footer's row come back to the pane and fit to it, so the
      // relaunch below is sized once, at the size it will keep.
      await nextAnimationFrames(2)
      if (disposed) return
      fitTerminal()
      replayGate.armResumeHold({ replaceFrozenView: resumeReplacesFrozenViewRef.current })
      const result = await resume().catch((): TerminalSpawnResult => ({
        ok: false,
        sessionId,
        message: 'Failed to resume terminal.',
        exitCode: 1,
      }))
      if (disposed) return
      if (result.ok) {
        suspendedRef.current = false
        // Unfreeze eagerly — the store's suspended flag clears a broadcast
        // later, and the cursor should read live the moment the TUI repaints.
        setCursorFrozen(false)
        if (resumeInputHeld) {
          resumeLaunched = true
          deliverResumeInput(true)
          deliverHeldResumeInput()
          // The hold starts timing only at the CLI's first byte. A CLI that
          // prints nothing, or a pane hidden before it was sent anything, would
          // otherwise keep a held paste — and every key typed behind it —
          // waiting indefinitely. Past this, the paste goes with whatever modes
          // xterm has.
          window.setTimeout(() => {
            if (disposed || generation !== resumeGeneration || !resumeInputHeld || !resumeLaunched) return
            resumeFrameShown = true
            deliverHeldResumeInput()
          }, RESUME_INPUT_FALLBACK_MS)
        } else {
          // The hold already let go: the CLI exited before this answer came.
          deliverResumeInput(false)
        }
      } else {
        // Nothing was launched, so nothing will arrive to end the hold.
        replayGate.releaseResumeHoldForExit()
        setIsResuming(false)
        window.dispatchEvent(
          new CustomEvent('sprintengine:terminal-resume-state', {
            detail: { sessionId, resuming: false },
          }),
        )
      }
      resumingRef.current = false
    }

    // An inert tab starts on a deliberate click or keystroke — the same gesture
    // that resumes a paused one, and the only way out of 'inert'. Recording the
    // intent is enough: `cliRestartNonce` is a dependency of this effect, so the
    // bump re-runs the launch, `hasLiveAgentLaunchIntent` now reads true, and the
    // decision comes back 'spawn'. Keeps `cliSessionId` (identity is durable) and
    // leaves `cliHasLaunched` false, so this is a FRESH start, never an
    // unattended `--resume`.
    const startInertAgent = () => {
      if (!inertRef.current) return
      inertRef.current = false
      // A deliberate click/keystroke is the user asking to try again. Drop any
      // "launch failed this session" marker so the mint branch re-mints normally
      // and the fresh attempt is allowed to spawn.
      clearAgentLaunchFailed(workspaceId, agentId)
      const startContext = currentContext()
      startContext.updateAgent(workspaceId, agentId, {
        cliStartRequested: true,
        cliHasLaunched: false,
        cliRestartNonce: (startContext.agent?.cliRestartNonce ?? 0) + 1,
      })
    }

    const onDataDisposable = term.onData((data) => {
      // Focus-report escapes (DECSET 1004: `ESC[I`/`ESC[O`) are not user intent.
      // During the suspend/resume window the PTY can echo them back as a visible
      // `^[[I`; worse, a focus event while suspended would otherwise be buffered
      // as "input" and kick a resume. Drop them in that window — a live PTY still
      // receives them so the CLI's focus tracking keeps working.
      if ((data === '\x1b[I' || data === '\x1b[O') && (suspendedRef.current || resumingRef.current)) {
        return
      }
      terminalDiagnostics.recordInput(data)
      // Inert: there is no pty and no conversation to resume — the keystroke is
      // the user starting the agent. Don't buffer it; it would be typed into a
      // CLI that has not booted yet.
      if (inertRef.current) {
        startInertAgent()
        return
      }
      // Suspended: buffer the keystroke and kick a resume instead of writing to a
      // dead pty (main drops writes to a suspended session anyway).
      if (suspendedRef.current) {
        pendingResumeInputRef.current.push({ kind: 'keys', data })
        void resumeFromSuspend()
        return
      }
      // Behind a paste still waiting for the resumed CLI: wait with it.
      if (resumeInputHeld && !deliveringResumeInput && pendingResumeInputRef.current.length > 0) {
        pendingResumeInputRef.current.push({ kind: 'keys', data })
        return
      }
      window.api.terminalWriteFast(sessionId, data)
      terminalDiagnostics.recordInputDispatch(data)
    })

    // Resume on a deliberate click of the frozen pane — voice dictation users
    // (and anyone reading the painted view) never type, so waiting for a keystroke
    // would strand them. Bound to `click` (not `mousedown`/`focus`): a click is an
    // intentional tap, whereas `focus` can fire when the pane mounts/auto-focuses,
    // which must NOT auto-resume a just-revealed workspace. No-op unless suspended;
    // `resumeFromSuspend` is idempotent via `resumingRef`.
    const onPaneClick = (event: Event) => {
      // The pane's own chrome (the find bar) is not the pane: clicking into the
      // find field must not start an inert agent or resume a suspended one.
      if (isTerminalChromeTarget(event.target)) return
      if (inertRef.current) {
        startInertAgent()
        return
      }
      if (suspendedRef.current) void resumeFromSuspend()
    }
    container.addEventListener('click', onPaneClick)

    // The paused-state footer (AgentPanel) lives in a different component and has
    // no access to the relaunch payload, so it asks this terminal to resume via a
    // window event keyed by session id — same path as typing.
    const onResumeRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail
      if (detail?.sessionId !== sessionId) return
      // The footer lives outside `container`, so its click doesn't hit the
      // focusTerminal listeners the way a pane click or keystroke does. Focus the
      // terminal here (synchronously, within the click gesture) so the user can
      // type immediately after resuming instead of having to click in again.
      focusTerminal()
      void resumeFromSuspend()
    }
    window.addEventListener('sprintengine:resume-terminal', onResumeRequest)

    // Opening a workspace hands the keyboard to its visible terminal
    // (WorkspaceManager). Answered here rather than by the mount-time
    // focusTerminal above because that one fires in every mounted pane,
    // including the ones stacked behind the visible tab.
    const disposeFocusRequest = onTerminalFocusRequest({ workspaceId, agentId }, focusTerminal)

    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      void window.api.terminalResize(sessionId, cols, rows)
    })

    const fitScheduler = createTerminalFitScheduler(fitTerminal, mount)
    const resizeObserver = new ResizeObserver(() => {
      fitScheduler.requestFit()
    })
    resizeObserver.observe(mount)
    // A pointer landing on the pane's own chrome (the find bar) is not a click
    // on the terminal: focusing here would take the keyboard back out of the
    // find field on the mouseup of the click that just entered it.
    const focusTerminalFromPointer = (event: Event) => {
      if (isTerminalChromeTarget(event.target)) return
      focusTerminal()
    }
    container.addEventListener('mousedown', focusTerminalFromPointer)
    container.addEventListener('mouseup', focusTerminalFromPointer)
    container.addEventListener('click', focusTerminalFromPointer)
    // `focus` does not bubble, so this only ever fires for the container itself.
    container.addEventListener('focus', focusTerminal)
    const disposeClipboardHandlers = bindTerminalClipboardHandlers({
      container,
      term,
      focusTerminal,
      recordKeydown: terminalDiagnostics.recordContainerKeydown,
      paste: pasteIntoPane,
      imagePasteKey: () => {
        const { cli: paneCli, hostId: paneHostId } = launchContextRef.current
        return claudeImagePasteKey(paneCli, isWslHostId(paneHostId))
      },
    })

    const launchTerminal = async () => {
      const latestContext = currentContext()
      const latestAgent = latestContext.agent
      const latestCli = latestContext.cli
      if (!latestAgent || !latestCli) return
      // A settled chat whose worktree the cleanup gave back has it checked out
      // again before its agent relaunches there (chatWorktreeRestore.ts). The
      // folder check already waits on that; a view kept mounted from before the
      // worktree went holds an older answer, so the launch asks as well.
      if (!(await ensureChatWorktree(workspaceId)) || disposed) return
      const terminalStatus = await window.api
        .terminalStatus(sessionId)
        .catch(() => ({ processAlive: false, suspended: false }))
      if (disposed) return
      const postStatusContext = currentContext()
      const postStatusAgent = postStatusContext.agent
      const postStatusCli = postStatusContext.cli
      if (!postStatusAgent || !postStatusCli) return
      if (postStatusContext.savedFolderPath && !folderReadyPath) return

      const resumeExistingPty = shouldResume && terminalStatus.processAlive
      // Prefer the resume capability stamped + persisted on the agent (survives a
      // cold restart), like the codex branch reads agent.cliResumeAvailable above.
      // The catalog is only a fallback for a pre-upgrade agent whose flag predates
      // this feature — reading it directly would be a startup race (the plugin
      // catalog loads async, so an early launchTerminal could see it empty and
      // silently spawn a claude-code/zai agent fresh, losing the conversation).
      const postStatusResumeCaps = resumeCapabilitiesForCli(
        postStatusCli,
        useWorkspaceStore.getState().pluginCatalogEntries,
      )
      const usesStableSessionId =
        postStatusAgent.cliUsesStableSessionId ?? agentCliUsesStableSessionIdForResume(postStatusResumeCaps)
      const shouldResumeClaudeConversation = usesStableSessionId && shouldResume
      const shouldResumeCli = resumeExistingPty || shouldResumeClaudeConversation || shouldResumeCodexConversation
      // What this tab should do, decided in one place (utils/terminalColdLoad.ts).
      //
      // 'paused' — reopening a suspended agent must NOT silently respawn it: the
      // reaper suspended it to reclaim memory, the painted scrollback is still on
      // the record, and the user opened the workspace just to read it. Replay the
      // history below and leave it suspended — the quiet paused footer (AgentPanel,
      // keyed off the same `suspended` flag), a click on the pane, and
      // type-to-resume are the controls. A live pty (background run) reports
      // suspended=false and reattaches normally.
      //
      // 'inert' — a cold-loaded persisted agent with no pty, no painted screen,
      // and no live launch intent. It has nothing to show and nobody asked for it,
      // so it must sit idle. Without this branch every cold load of such an
      // agent became a fresh CLI launch.
      const coldLoadDecision = resolveAgentColdLoadDecision({
        attachedSessionId,
        processAlive: terminalStatus.processAlive,
        suspended: terminalStatus.suspended,
        hasLaunchIntent: hasLiveAgentLaunchIntent(postStatusAgent),
        sessionMintedThisAppSession: wasAgentSessionMintedThisAppSession(sessionId),
        launchFailedThisAppSession: hasAgentLaunchFailedThisAppSession(workspaceId, agentId),
      })
      const pauseInsteadOfLaunch = coldLoadDecision === 'paused'
      inertRef.current = coldLoadDecision === 'inert'
      if (coldLoadDecision === 'inert') {
        // Return BEFORE the worktree resolution below. An idle agent's worktree
        // may have been removed since it last ran, and
        // `resolveWorktreeSpawnFallback` would silently redirect the spawn into
        // the main checkout — the dead-cwd relaunch loop. Inert outranks that
        // fallback: there is nothing to spawn, so there is nothing to redirect.
        setCursorFrozen(true)
        term.write('\r\n\x1b[2m[agent is not running — click or type to start it]\x1b[0m\r\n')
        logPerfEvent('TerminalView', 'terminal-inert-on-open', {
          sessionId,
          workspaceId,
          agentId,
          kind: 'agent',
          cli: postStatusCli,
        })
        return
      }
      logPerfEvent('TerminalView', shouldResumeCli ? 'terminal-reattach-existing-session' : 'terminal-spawn-fresh', {
        sessionId,
        workspaceId,
        agentId,
        kind: 'agent',
        processAlive: terminalStatus.processAlive,
        resumeRequested: shouldResume,
        attachedSessionId,
        cliHasLaunched: postStatusAgent?.cliHasLaunched,
        willSpawnFresh: !shouldResumeCli,
      })
      if (!shouldResumeCli && shouldResume) {
        logPerfEvent('TerminalView', 'terminal-spawn-fresh-after-switch-risk', {
          sessionId,
          workspaceId,
          agentId,
          kind: 'agent',
          processAlive: terminalStatus.processAlive,
          resumeRequested: shouldResume,
          attachedSessionId,
          cliHasLaunched: postStatusAgent?.cliHasLaunched,
          willSpawnFresh: true,
        })
      }
      const launchContext = currentContext()
      const launchAgent = launchContext.agent
      const launchCli = launchContext.cli
      if (!launchAgent || !launchCli) return
      // Redirect a non-worktree agent's spawn into the workspace's worktree.
      // Resolve the worktree cwd once here (one `pathExists`); a persisted
      // mode:'worktree' agent skips this — resolveAgentExecutionRoot ignores the
      // value on its worktree branch and resolveWorktreeSpawnFallback below
      // already guards that agent's own cwd, so resolving here would double-call
      // pathExists.
      const workspaceWorktreeCwd =
        launchAgent.execution?.mode === 'worktree'
          ? { cwd: null, missing: false }
          : await resolveWorkspaceTerminalCwd(workspaceWorktreeGitRoot, folderReadyPath, window.api.pathExists)
      if (disposed) return
      let executionRoot = resolveAgentExecutionRoot(
        launchAgent.execution,
        launchContext.storedExecutionWorktreePath,
        folderReadyPath,
        workspaceWorktreeCwd.cwd,
      )
      if (workspaceWorktreeCwd.missing) {
        // The worktree-backed workspace's worktree is gone (merge cleanup, the
        // Worktree manager, or `git worktree prune`). executionRoot already fell
        // back to folderReadyPath; note it so the user is not silently in the
        // parent instead of the worktree they expected. Same red bracketed banner
        // as Slice 2 (PlainTerminalPanel), showing the folder actually opened in.
        logPerfEvent('TerminalView', 'worktree-cwd-missing-fallback', {
          workspaceId,
          agentId,
          kind: 'agent',
          missingCwd: workspaceWorktreeGitRoot,
          fallbackCwd: executionRoot.cwd ?? null,
        })
        term.write(
          `\r\n\x1b[31m[worktree missing — opened in main checkout: ${executionRoot.cwd ?? folderReadyPath ?? 'the workspace folder'}]\x1b[0m\r\n`,
        )
      }
      // A worktree can be removed out from under a persisted agent (merge
      // cleanup, the Worktree manager, or `git worktree prune`). Spawning
      // into the vanished directory exits the terminal with code 1 on reopen.
      // Detect the missing worktree and fall back to the workspace folder for
      // THIS spawn. Deliberately a stateless, per-launch redirect: we do NOT
      // rewrite the persisted `agent.execution` here — that field is in this
      // effect's dependency array, so mutating it would re-run the launch effect
      // mid-spawn. The guard re-checks (one `pathExists`) on every launch and
      // self-corrects if the worktree reappears; completion teardown removes the
      // agent entirely, so a stale execution is short-lived either way.
      // Read imperatively (not via a selector) so the launch effect does not
      // re-run on every unrelated workspace write.
      const fallbackWorkspace = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)
      const worktreeFallback = await resolveWorktreeSpawnFallback(
        executionRoot.mode,
        executionRoot.cwd,
        fallbackWorkspace ? (fallbackWorkspace.folderPath ?? null) : folderReadyPath,
        window.api.pathExists,
      )
      if (disposed) return
      if (worktreeFallback.fellBack) {
        logPerfEvent('TerminalView', 'worktree-cwd-missing-fallback', {
          workspaceId,
          agentId,
          missingCwd: executionRoot.cwd,
          fallbackCwd: worktreeFallback.cwd ?? null,
        })
        executionRoot = {
          cwd: worktreeFallback.cwd,
          mode: 'current_workspace',
          worktreeId: undefined,
          worktreePath: undefined,
        }
      }
      // The link roots now agree with the process. Everything above — the
      // worktree redirect and the vanished-worktree fallback — moved the spawn
      // cwd away from the guess made before this terminal existed; leaving the
      // guess in place is what made a link open the right path in the wrong
      // checkout. Read through a thunk, so this lands on links already drawn.
      launchExecutionRoot = executionRoot.cwd ?? launchExecutionRoot
      terminalLaunchDetails = [
        `Session: ${sessionId}`,
        `CLI: ${launchCli}${launchAgent.cliModel ? ` · ${launchAgent.cliModel}` : ''}`,
        launchContext.cliPermissionPreset ? `CLI permissions: ${launchContext.cliPermissionPreset}` : null,
        `Workspace path: ${folderReadyPath ?? launchContext.savedFolderPath ?? 'default app path'}`,
        executionRoot.worktreePath ? `Worktree path: ${executionRoot.worktreePath}` : null,
      ]
        .filter(Boolean)
        .join('\n')
      const memoryContext = await resolveMemoryLaunchContext(
        launchContext.memoryConfig?.projectRoot ?? folderReadyPath ?? null,
        launchContext.memoryConfig?.relativeRoot ?? null,
      )
      if (disposed) return
      // The user's prompt, and only the user's prompt. Everything the HOST wants
      // the agent to know — the attached design system, the Knowledge Graph — is
      // built and delivered out of band by main (src/shared/host-context,
      // src/main/terminal-launch), because appending it here told the model the
      // user had said it, told a resumed session nothing at all, and never
      // reached an agent launched with no window.
      const launchInitialPrompt = shouldResumeCli ? undefined : (startupPromptRef.current ?? undefined)
      const finalContext = currentContext()
      const finalAgent = finalContext.agent
      const finalCli = finalContext.cli
      if (!finalAgent || !finalCli) return
      const finalResumeCaps = resumeCapabilitiesForCli(finalCli, useWorkspaceStore.getState().pluginCatalogEntries)
      resumeReplacesFrozenViewRef.current = agentCliSupportsConversationResume(finalResumeCaps)
      const agentSession: Omit<AgentSessionIdentity, 'sessionId'> | undefined = attachedSessionId
        ? undefined
        : {
            executionId: sessionId,
            system: 'manual' satisfies AgentSessionSystem,
            workspaceId,
            workspaceRoot: folderReadyPath ?? finalContext.savedFolderPath ?? '',
            displayName: finalAgent.name ?? agentId,
          }

      // Capture how to relaunch THIS agent under the same session id with
      // --resume (freeze-the-view resume-on-keystroke). Mirrors the spawn payload
      // below but forces resume and sends no fresh prompt; reads the live term
      // size at call time.
      resumeThunkRef.current = () =>
        window.api.terminalResume(
          sessionId,
          term.cols,
          term.rows,
          executionRoot.cwd,
          true,
          finalCli,
          undefined,
          finalContext.cliRuntimes,
          false,
          {
            kind: 'agent',
            workspaceId,
            ...(finalContext.hostId ? { hostId: finalContext.hostId } : {}),
            agentId,
            agentName: finalAgent.name,
            // The agent's own CLI/harness session id, used as the resume token so
            // non-Claude CLIs (e.g. Codex) reattach the right conversation. Read
            // live at call time — the resume thunk outlives this closure, and the
            // harness id is learned from the hook AFTER launch, so the captured
            // `finalAgent` may not have it yet. For Claude this coincides with the
            // terminal id, so main's fallback keeps `--resume <id>` identical.
            cliSessionId: currentContext().agent?.harnessSessionId ?? finalAgent.harnessSessionId,
            executionMode: executionRoot.mode,
            worktreeId: executionRoot.worktreeId,
            worktreePath: executionRoot.worktreePath,
            cliPermissionPreset: finalContext.cliPermissionPreset,
            // The CLI's own mode rides beside the preset it was chosen at.
            ...(finalContext.cliPermissionPreset && finalAgent.cliPermissionMode
              ? { cliPermissionMode: finalAgent.cliPermissionMode }
              : {}),
            cliModel: finalAgent.cliModel,
            cliReasoning: finalAgent.cliReasoning,
            memoryRootPath: memoryContext.rootPath,
            memoryRelativeRoot: memoryContext.relativeRoot,
            // A connector chat forwards its own connector-only MCP settings so the
            // spawn syncs that server into the worktree .mcp.json — never the
            // global appSettings.mcp. Ordinary agents fall through to the
            // workspace's MCP.
            mcpSettings: finalAgent.connectorMcpSettings ?? finalContext.mcpSettings,
            connectorLaunch: finalAgent.connectorMcpSettings != null,
            spawnSkillId: finalAgent.spawnSkillId,
            visible: paneIsPainted(),
            ...(agentSession ? { agentSession } : {}),
          } as TerminalSpawnMetadata & {
            executionMode: AgentExecutionMode
            worktreeId?: string
            worktreePath?: string
          },
        )

      if (pauseInsteadOfLaunch) {
        // Arm the freeze-the-view resume path (resumeThunkRef is set above) so
        // the paused footer / pane click / type-to-resume relaunches it, and
        // route the next keystroke through it. Reveal the session so main replays
        // the retained scrollback into this fresh xterm — the painted history is
        // readable while the agent process stays suspended.
        suspendedRef.current = true
        setCursorFrozen(true)
        // A fresh xterm: main paints it in full, now or — in a window that is
        // not being painted — when WorkspaceManager reveals it.
        const painted = paneIsPainted()
        await window.api.terminalSetVisible(sessionId, painted, { freshPane: true }).catch(() => {})
        if (!painted && !disposed) notePaneAttachedHidden(sessionId)
        logPerfEvent('TerminalView', 'terminal-paused-on-open', {
          sessionId,
          workspaceId,
          agentId,
          kind: 'agent',
          resumeRequested: shouldResume,
          attachedSessionId,
        })
        return
      }

      replayGate.beginReplayWait()
      const spawnPainted = paneIsPainted()
      const spawnResult = await window.api
        .terminalSpawn(
          sessionId,
          term.cols,
          term.rows,
          executionRoot.cwd,
          shouldResumeCli,
          finalCli,
          launchInitialPrompt,
          finalContext.cliRuntimes,
          false,
          {
            kind: 'agent',
            workspaceId,
            ...(finalContext.hostId ? { hostId: finalContext.hostId } : {}),
            agentId,
            agentName: finalAgent.name,
            // The agent's own CLI/harness session id, used as the resume token so
            // non-Claude CLIs (e.g. Codex) reattach the right conversation. Read
            // live at call time — the resume thunk outlives this closure, and the
            // harness id is learned from the hook AFTER launch, so the captured
            // `finalAgent` may not have it yet. For Claude this coincides with the
            // terminal id, so main's fallback keeps `--resume <id>` identical.
            cliSessionId: currentContext().agent?.harnessSessionId ?? finalAgent.harnessSessionId,
            executionMode: executionRoot.mode,
            worktreeId: executionRoot.worktreeId,
            worktreePath: executionRoot.worktreePath,
            cliPermissionPreset: finalContext.cliPermissionPreset,
            // The CLI's own mode rides beside the preset it was chosen at.
            ...(finalContext.cliPermissionPreset && finalAgent.cliPermissionMode
              ? { cliPermissionMode: finalAgent.cliPermissionMode }
              : {}),
            cliModel: finalAgent.cliModel,
            cliReasoning: finalAgent.cliReasoning,
            memoryRootPath: memoryContext.rootPath,
            memoryRelativeRoot: memoryContext.relativeRoot,
            // A connector chat forwards its own connector-only MCP settings so the
            // spawn syncs that server into the worktree .mcp.json — never the
            // global appSettings.mcp. Ordinary agents fall through to the
            // workspace's MCP.
            mcpSettings: finalAgent.connectorMcpSettings ?? finalContext.mcpSettings,
            connectorLaunch: finalAgent.connectorMcpSettings != null,
            spawnSkillId: finalAgent.spawnSkillId,
            visible: spawnPainted,
            ...(agentSession ? { agentSession } : {}),
          } as TerminalSpawnMetadata & {
            executionMode: AgentExecutionMode
            worktreeId?: string
            worktreePath?: string
          },
        )
        .catch((error): TerminalSpawnResult => ({
          ok: false,
          sessionId,
          message: error instanceof Error ? error.message : 'Failed to start terminal.',
          exitCode: 1,
        }))
      replayGate.finishReplayWait()
      if (disposed) return
      if (spawnResult.ok && !spawnPainted) notePaneAttachedHidden(sessionId)
      if (!spawnResult.ok) {
        const failureContext = currentContext()
        const currentSessionId = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)?.agents[
          agentId
        ]?.cliSessionId
        if (attachedSessionId) return
        if (currentSessionId !== sessionId) return
        // Record that this agent's launch failed this renderer session BEFORE we
        // clear the session id below. Clearing it re-enters the mint branch, and
        // this marker is what stops that branch from minting a fresh spawn-forcing
        // id — otherwise the failure respawns and re-notifies every effect cycle.
        markAgentLaunchFailed(workspaceId, agentId)
        failureContext.updateAgent(workspaceId, agentId, {
          cliSessionId: undefined,
          cliStartRequested: false,
          cliHasLaunched: false,
          cliOnboardingPromptSent: false,
        })
        void workspaceSyncClient.dispatchUpdateTerminalLaunchState(workspaceId, agentId, {
          cliSessionId: null,
          cliStartRequested: false,
          cliHasLaunched: false,
          cliOnboardingPromptSent: false,
        })
        if (!reportedTerminalFailure) {
          reportedTerminalFailure = true
          publishDiagnosticSync({
            level: 'error',
            source: 'terminal',
            title: `${failureContext.agent?.name ?? agentId} was not started`,
            message: spawnResult.message,
            details: terminalLaunchDetails,
            workspaceId,
            workspaceName: failureContext.workspaceName,
            agentId,
            sessionId,
          })
        }
        return
      }

      // Bind the agent to the machine it launched on, so a relaunch after a
      // restart (with no painted session to resume from) goes back there too.
      if (finalContext.hostId && finalAgent.hostId !== finalContext.hostId) {
        finalContext.updateAgent(workspaceId, agentId, { hostId: finalContext.hostId })
      }

      // The spawn succeeded — this agent is running again, so any stale
      // "launch failed this session" marker no longer applies.
      clearAgentLaunchFailed(workspaceId, agentId)

      if (!resumeExistingPty) {
        if (!attachedSessionId) {
          const successContext = currentContext()
          successContext.updateAgent(workspaceId, agentId, {
            cliHasLaunched: true,
            ...(agentCliSupportsConversationResume(finalResumeCaps)
              ? {
                  cliResumeAvailable: true,
                  cliUsesStableSessionId: agentCliUsesStableSessionIdForResume(finalResumeCaps),
                }
              : {}),
            ...(launchInitialPrompt
              ? {
                  cliOnboardingPromptSent: true,
                  cliStartupPrompt: undefined,
                }
              : {}),
            // One-shot: consumed by the paste below, cleared here so a
            // relaunch never re-pastes it.
            ...(finalAgent.cliPendingInput ? { cliPendingInput: undefined } : {}),
          })
          // Skill-at-spawn prefill: park the invocation at the CLI prompt,
          // bracketed and unsubmitted (the PTY buffers it until the CLI's
          // input line is ready). Never auto-sent — the user finishes it.
          if (finalAgent.cliPendingInput) {
            const pendingInput = finalAgent.cliPendingInput
            void window.api.terminalWrite(sessionId, `\x1b[200~${pendingInput}\x1b[201~`).catch(() => {})
          }
        }
      }
      // assign_session stamps cliResumeAvailable authoritatively from the main
      // registry (reliably loaded, unlike the async renderer catalog), so we no
      // longer echo a catalog-derived cliResumeAvailable here — doing so raced
      // the stamp and could overwrite a resume-capable agent with false during
      // startup. Only the prompt flag remains as a launch-state follow-up.
      void workspaceSyncClient.dispatchAssignTerminalSession(workspaceId, agentId, sessionId, finalCli)
      const launchState: Parameters<typeof workspaceSyncClient.dispatchUpdateTerminalLaunchState>[2] = {}
      if (launchInitialPrompt) launchState.cliOnboardingPromptSent = true
      if (Object.keys(launchState).length > 0) {
        void workspaceSyncClient.dispatchUpdateTerminalLaunchState(workspaceId, agentId, launchState)
      }
    }

    void launchTerminal()
    const settleTimer = window.setTimeout(() => {
      fitTerminal()
      focusTerminal()
    }, 50)

    return () => {
      disposed = true
      textarea?.removeEventListener('focus', reclaimPtySize)
      if (shouldKillOnUnmount?.(sessionId)) {
        void window.api.terminalKill(sessionId).catch(() => {})
      } else {
        logPerfEvent('TerminalView', 'terminal-detached-from-renderer', {
          sessionId,
          workspaceId,
          agentId,
          kind: 'agent',
        })
        void window.api.terminalSetVisible(sessionId, false).catch(() => {})
      }
      window.clearTimeout(settleTimer)
      resizeObserver.disconnect()
      fitScheduler.dispose()
      container.removeEventListener('mousedown', focusTerminalFromPointer)
      container.removeEventListener('mouseup', focusTerminalFromPointer)
      container.removeEventListener('click', focusTerminalFromPointer)
      container.removeEventListener('focus', focusTerminal)
      container.removeEventListener('click', onPaneClick)
      disposeClipboardHandlers()
      disposeData()
      disposeReplay()
      disposeExit()
      disposeError()
      window.removeEventListener('sprintengine:resume-terminal', onResumeRequest)
      disposeFocusRequest()
      onDataDisposable.dispose()
      onResizeDisposable.dispose()
      fileLinkDisposable.dispose()
      terminalDiagnostics.dispose()
      replayGate.dispose()
      outputQueue.dispose()
      ackReporter.dispose()
      unregisterTerminalInstance(sessionId)
      clearPaneAttachedHidden(sessionId)
      studioTerminalRef.current = null
      // Last: it unbinds the theme, disposes the web-links addon and disposes
      // the terminal itself, so nothing above may still be reading `term`.
      studioTerminal.dispose()
      applyCursorFrozenRef.current = null
      // A resume in flight dies with this terminal; its edge goes with it.
      setIsResuming(false)
      // And the next terminal starts at its bottom.
      setScrolledAway(false)
      focusTerminalRef.current = () => {
        containerRef.current?.focus()
      }
    }
  }, [
    workspaceId,
    agentId,
    agent?.cliSessionId,
    attachedSessionId,
    agent?.cliRestartNonce,
    agent?.execution.mode,
    agent?.execution.worktreeId,
    agent?.execution.cwd,
    folderReadyPath,
    workspaceWorktreeGitRoot,
    shouldKillOnUnmount,
  ])

  const folderBlocked = Boolean(savedFolderPath && !folderReadyPath)
  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (
      !hasFileDropData(event.dataTransfer) &&
      !hasCommitDropData(event.dataTransfer) &&
      !hasSkillDropData(event.dataTransfer)
    ) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setIsFileDragOver(true)
  }

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
    setIsFileDragOver(false)
  }

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    const isCommitDrop = hasCommitDropData(event.dataTransfer)
    const isSkillDrop = hasSkillDropData(event.dataTransfer)
    if (!hasFileDropData(event.dataTransfer) && !isCommitDrop && !isSkillDrop) return
    event.preventDefault()
    setIsFileDragOver(false)
    focusTerminalRef.current()

    const dropAnchor = { x: event.clientX, y: event.clientY }
    const showDropError = (message: string) => setClickError({ message, x: dropAnchor.x, y: dropAnchor.y })

    const sessionId = attachedSessionId ?? agent?.cliSessionId
    if (!sessionId) {
      showDropError(
        isCommitDrop
          ? 'Start this agent terminal before dropping a commit into it.'
          : isSkillDrop
            ? 'Start this agent terminal before dropping a skill into it.'
            : 'Start this agent terminal before dropping files into it.',
      )
      return
    }

    if (isSkillDrop) {
      // The workspace's own folder, never a root carried in the payload: the
      // invocation is decided by what THIS agent's harness directory holds.
      const workspaceRoot = folderReadyPath ?? savedFolderPath
      if (!workspaceRoot) {
        showDropError('Open this workspace’s project folder before dropping a skill into it.')
        return
      }
      const skillResult = await pasteDroppedSkillIntoTerminal({
        dataTransfer: event.dataTransfer,
        sessionId,
        workspaceId,
        workspaceRoot,
      }).catch((error): { ok: false; message: string } => ({
        ok: false,
        message: error instanceof Error ? error.message : 'Could not drop the skill into the terminal.',
      }))
      if (!skillResult.ok) showDropError(skillResult.message)
      return
    }

    if (isCommitDrop) {
      const commitResult = await pasteDroppedCommitIntoTerminal({
        dataTransfer: event.dataTransfer,
        sessionId,
      }).catch((error): { ok: false; message: string } => ({
        ok: false,
        message: error instanceof Error ? error.message : 'Could not drop the commit into the terminal.',
      }))
      if (!commitResult.ok) showDropError(commitResult.message)
      return
    }

    const result = await pasteDroppedFilesIntoTerminal({
      dataTransfer: event.dataTransfer,
      sessionId,
      workspaceId,
    }).catch((error): { ok: false; message: string } => ({
      ok: false,
      message: error instanceof Error ? error.message : 'Could not drop the file into the terminal.',
    }))

    if (!result.ok) {
      showDropError(result.message)
      return
    }

    // A backlog/ item handed to this agent: record the link on both sides so the
    // item shows its working agent and this terminal shows its Backlog glyph.
    // Best-effort and non-blocking — the paste already landed.
    if (result.backlog) {
      void recordBacklogAgentHandoff({
        workspaceId,
        workspaceRoot: result.backlog.workspaceRoot,
        agentId: result.backlog.agentId,
        relativePath: result.backlog.relativePath,
      })
    }
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(event) => void handleDrop(event)}
      className={`${FOCUS_RING_TERMINAL_CLASS} absolute inset-0 overflow-hidden bg-[color:var(--terminal-bg)] p-2 cursor-text`}
      // Marks this as a terminal surface, so a ⌘F pressed anywhere in it —
      // including in the find bar — activates the `terminal` command scope.
      {...{ [TERMINAL_SURFACE_ATTRIBUTE]: '' }}
    >
      <TerminalMount ref={terminalMountRef} />
      <TerminalFindBar find={find} />
      <TerminalJumpToLatest visible={scrolledAway} onJump={jumpToLatest} />
      {/* No replay skeleton on terminals: an xterm renders its own content
          progressively (and a revealed cold terminal resyncs in place), so a
          skeleton there just reads as a flash. Keep it only for the genuine
          pre-launch folder-verification wait. */}
      {folderBlocked && checkingFolder ? <TerminalReplaySkeleton /> : null}
      {/* A paused agent resuming: the frozen view stays readable and the edge
          says the click was heard, until the CLI's first frame replaces it. */}
      {isResuming ? <WorkingEdge label="Resuming agent" /> : null}
      {isFileDragOver ? (
        <div className="pointer-events-none absolute inset-2 z-10 rounded-md border border-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)]" />
      ) : null}
      {clickError ? (
        <CursorErrorPopover
          key={`${clickError.x},${clickError.y},${clickError.message}`}
          message={clickError.message}
          anchor={{ x: clickError.x, y: clickError.y }}
          onDismiss={() => setClickError(null)}
        />
      ) : null}
      {linkMenu ? (
        <TerminalLinkMenu
          workspaceId={workspaceId}
          target={linkMenu.target}
          x={linkMenu.x}
          y={linkMenu.y}
          line={linkMenu.line}
          column={linkMenu.column}
          onClose={() => setLinkMenu(null)}
          // A failed destination reports through the same pointer-anchored error
          // surface the link click already used, at the original click point.
          onError={(message) => setClickError({ message, x: linkMenu.x, y: linkMenu.y })}
        />
      ) : null}
      {folderBlocked && folderMissing ? (
        <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-meta text-[color:var(--text-muted)]">
          {folderStatusMessage ??
            'Saved workspace folder is missing. Relink it from the Files pane before starting this terminal.'}
        </div>
      ) : null}
    </div>
  )
}

/** A terminal runs on this computer; a workspace on an SSH machine says so instead (phase 8). */
export default function TerminalView(props: Props) {
  const machine = useWorkspaceMachine(props.workspaceId)
  if (machine) return <NotOnMachineYet what="Terminals" machine={machine} />
  return <TerminalViewOnThisComputer {...props} />
}
