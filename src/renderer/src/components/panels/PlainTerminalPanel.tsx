import { NotOnMachineYet, useWorkspaceMachine } from '../environments/NotOnMachineYet'
import React, { useEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import { resolveWorkspaceTerminalCwd, resolveWorkspaceWorktree } from '../../utils/workspaceWorktree'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { recordReplayProfile } from '../../utils/diagnostics/replayProfileStore'
import { createStudioTerminal, type StudioTerminal, type TerminalSurface } from '../../utils/createStudioTerminal'
import { useTerminalFind } from '../../hooks/useTerminalFind'
import { isTerminalChromeTarget, TERMINAL_SURFACE_ATTRIBUTE } from '../../utils/keyboard'
import { createTerminalDiagnostics } from '../../utils/terminalDiagnostics'
import { createTerminalFileLinkProvider, terminalWslDistro } from '../../utils/terminalFileLinks'
import { parseTerminalOscCwd } from '../../utils/terminalOscLinks'
import { registerMountedTerminalPromptNavigation } from '../../utils/terminalPromptNavigation'
import {
  createTerminalShellMarkTracker,
  terminalPromptSearchAnchor,
  type TerminalShellMarkTracker,
} from '../../utils/terminalShellMarks'
import { createXtermOutputQueue, createXtermReplayGate } from '../../utils/xtermOutputQueue'
import { createSessionAckReporter } from '../../utils/terminalOutputAck'
import { registerTerminalInstance, unregisterTerminalInstance } from '../../utils/diagnostics/terminalInstanceRegistry'
import { TerminalReplaySkeleton } from '../ui/TerminalReplaySkeleton'
import { bindTerminalClipboardHandlers } from '../../utils/terminalClipboard'
import { createTerminalFitScheduler } from '../../utils/terminalFitScheduler'
import { onTerminalFocusRequest } from '../../utils/terminalFocusRequest'
import {
  hasCommitDropData,
  hasFileDropData,
  hasSkillDropData,
  pasteDroppedCommitIntoTerminal,
  pasteDroppedFilesIntoTerminal,
} from '../../utils/terminalDrop'
import { CursorErrorPopover } from '../ui/CursorErrorPopover'
import { TerminalMount } from '../terminal/TerminalMount'
import { FOCUS_RING_TERMINAL_CLASS } from '../ui/tokens'
import { TerminalFindBar } from '../terminal/TerminalFindBar'
import { TerminalJumpToLatest } from '../terminal/TerminalJumpToLatest'
import { TerminalLinkMenu } from '../terminal/TerminalLinkMenu'
import type { TerminalLinkTarget } from '../../utils/terminalLinkActions'
import { hostPlatform } from '../../clientCapabilities'

interface Props {
  workspaceId: string
  terminalId: string
  cwdOverride?: string | null
  killOnUnmount?: boolean
  shouldKillOnUnmount?: (sessionId: string) => boolean
}

function PlainTerminalPanelOnThisComputer({
  workspaceId,
  terminalId,
  cwdOverride = null,
  killOnUnmount = false,
  shouldKillOnUnmount,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  // The padding-free box xterm is opened into; see TerminalMount.
  const terminalMountRef = useRef<HTMLDivElement>(null)
  const sessionIdRef = useRef(`terminal-${terminalId}`)
  // The live terminal, for anything outside the mount effect that needs it —
  // today `useTerminalFind`, which loads the search addon on the first find.
  const studioTerminalRef = useRef<StudioTerminal | null>(null)
  const find = useTerminalFind({ workspaceId, containerRef, terminalRef: studioTerminalRef })
  // Scrolled up away from the newest output, so "Jump to latest" is offered.
  const [scrolledAway, setScrolledAway] = useState(false)
  // Set by the mount effect, which owns the terminal and its focus path.
  const jumpToLatestRef = useRef<(() => void) | null>(null)
  const [isFileDragOver, setIsFileDragOver] = useState(false)
  // A failed file drop or a dead link, anchored to the pointer that raised it so
  // the error surfaces next to the cursor instead of a corner toast.
  const [cursorError, setCursorError] = useState<{ message: string; x: number; y: number } | null>(null)
  // A clicked link awaiting a destination, exactly as an agent pane
  // does it: the click opens a chooser rather than firing one hard-wired action.
  const [linkMenu, setLinkMenu] = useState<{
    target: TerminalLinkTarget
    x: number
    y: number
    line?: number
    column?: number
  } | null>(null)
  const {
    folderPath: savedFolderPath,
    folderReadyPath,
    folderMissing,
    checkingFolder,
    message: folderStatusMessage,
  } = useWorkspaceFolderStatus(workspaceId)
  // Derived string, not the workspace object: a workspace record churns object
  // identity on every store write, but the gitRoot string is stable, so the
  // spawn effect below re-runs at most once (null -> path).
  const workspaceWorktreeGitRoot = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return ws ? (resolveWorkspaceWorktree(ws)?.gitRoot ?? null) : null
  })
  const workspaceName = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.name)
  // Read by the effect below only to label a diagnostic, so it goes through a
  // ref: as a dependency, renaming the workspace tore the terminal down and
  // rebuilt it — a fresh xterm and a full replay of the shell's history — for a
  // label nobody sees until something fails.
  const workspaceNameRef = useRef(workspaceName)
  workspaceNameRef.current = workspaceName

  useEffect(() => {
    const container = containerRef.current
    const mount = terminalMountRef.current
    if (!container || !mount) return
    if (!cwdOverride && savedFolderPath && !folderReadyPath) return

    const sessionId = sessionIdRef.current
    // A shell pane carries its workspace root and no launch-time execution root:
    // unlike an agent, nothing here resolves a cwd of its own up front. The live
    // one arrives over the wire instead — see the OSC 7 handler below.
    const terminalSurface: TerminalSurface = {
      kind: 'shell',
      workspaceRoot: folderReadyPath ?? savedFolderPath ?? null,
    }
    // Where this shell actually IS, in two layers, newest first.
    //
    // `launchExecutionRoot` is the directory the pty was spawned in, which is
    // only known after the async worktree probe below — so it is written there
    // rather than captured here, and the link provider reads both through a
    // thunk.
    //
    // `oscExecutionRoot` is what the shell itself reports over OSC 7, and it is
    // the only one that stays true: the launch directory stops being the cwd the
    // first time the user types `cd`, and every relative path printed afterwards
    // then resolves into a tree the shell left. That failure is invisible —
    // the same relative path usually exists in the old tree too — so the link
    // opens the wrong copy instead of failing.
    let launchExecutionRoot: string | null = null
    let oscExecutionRoot: string | null = null
    const inspectPath = async (path: string): Promise<{ exists: boolean; isDirectory: boolean }> => {
      try {
        const stat = await window.api.statPath(path)
        return { exists: true, isDirectory: stat.isDirectory }
      } catch {
        return { exists: false, isDirectory: false }
      }
    }
    const openFileLinkMenu = (
      {
        resolvedPath,
        isDirectory,
        line,
        column,
      }: {
        resolvedPath: string
        isDirectory: boolean
        line?: number
        column?: number
      },
      anchor: { x: number; y: number },
    ): void => {
      setLinkMenu({
        target: {
          kind: 'file',
          resolvedPath,
          isDirectory,
          workspaceRoot: terminalSurface.workspaceRoot,
        },
        x: anchor.x,
        y: anchor.y,
        line,
        column,
      })
    }
    // OSC 133 — the shell's own prompt/command marks, emitted by the same
    // generated shell integration that emits OSC 7 (`terminal-launch.ts`), for
    // `shell` panes only. What they buy is shell ergonomics: prompt boundaries
    // to jump between and a per-command exit status.
    //
    // They are NOT an agent status source and must never become one. Agent
    // phase comes from `agent-state.ts` over the state socket (decision of
    // record 2026-08-31, hooks only); an agent pane is `TerminalView`, which
    // constructs no tracker and registers no 133 handler.
    //
    // The handler is a CONSTRUCTION option and the tracker needs the terminal it
    // marks, so the two are tied together through this binding rather than one
    // waiting on the other. Nothing can be written to a terminal that does not
    // exist yet, so `?? true` is a guard against a future reordering, not a
    // live case.
    let markTracker: TerminalShellMarkTracker | null = null
    const studioTerminal = createStudioTerminal({
      surface: terminalSurface,
      oscLinks: {
        inspectPath,
        onActivateFile: openFileLinkMenu,
        onActivateUrl: (url, anchor) => {
          setLinkMenu({ target: { kind: 'url', url }, x: anchor.x, y: anchor.y })
        },
        onOpenError: (message, anchor) => setCursorError({ message, x: anchor.x, y: anchor.y }),
      },
      onWebLink: (event, uri) => {
        setLinkMenu({ target: { kind: 'url', url: uri }, x: event.clientX, y: event.clientY })
      },
      onScrolledAwayChange: setScrolledAway,
      // OSC 7 — the shell reporting its working directory. xterm registers
      // handlers for 0,1,2,4,8,10-12,104,110-112 and NOT 7, so without this the
      // sequence the startup script now emits (`terminal-launch.ts`) would be
      // parsed and thrown away.
      oscHandlers: {
        7: (data) => {
          // Same gate as an OSC 8 payload, and for the same reason: this is a
          // sequence any program with a pane can print. A payload naming
          // another host leaves the previous value standing.
          const cwd = parseTerminalOscCwd(data)
          if (cwd) oscExecutionRoot = cwd
          // Handled either way: nothing else in the app wants OSC 7, and
          // reporting it unhandled would only put it back on xterm's floor.
          return true
        },
        // OSC 133 — prompt start/end, pre-execution, command finished. xterm
        // registers no handler for it either. Registered here through the
        // factory's slot rather than on the terminal by hand, so it is torn
        // down with everything else the factory owns.
        133: (data) => markTracker?.handleOsc133(data) ?? true,
      },
    })
    studioTerminalRef.current = studioTerminal
    const term = studioTerminal.terminal
    markTracker = createTerminalShellMarkTracker(term)
    // Jump to the previous or next prompt — `terminal.promptPrevious` and
    // `terminal.promptNext`. The viewport's top line is the cursor for this,
    // not the text cursor: the user is navigating what they are LOOKING at.
    //
    // `lastPromptJump` is what the last jump AIMED at, which is not always where
    // the viewport ended up: `scrollToLine` clamps at the bottom of the buffer,
    // so without it a second Next inside the last screenful finds the same
    // prompt again and nothing moves. `terminalPromptSearchAnchor` drops it
    // again as soon as the user scrolls the target off screen.
    let lastPromptJump: number | null = null
    const disposePromptNavigation = registerMountedTerminalPromptNavigation({
      workspaceId,
      isFocused: () => {
        const active = document.activeElement
        return Boolean(active && container.contains(active))
      },
      scrollToPrompt: (direction) => {
        const from = terminalPromptSearchAnchor({
          viewportY: term.buffer.active.viewportY,
          rows: term.rows,
          lastJumpLine: lastPromptJump,
        })
        const line =
          direction === 'previous'
            ? (markTracker?.previousPromptLine(from) ?? null)
            : (markTracker?.nextPromptLine(from) ?? null)
        if (line === null) return false
        term.scrollToLine(line)
        lastPromptJump = line
        return true
      },
    })
    registerTerminalInstance(sessionId, term)
    const fitAddon = studioTerminal.fitAddon
    const terminalDiagnostics = createTerminalDiagnostics({
      scope: 'PlainTerminalPanel',
      sessionId,
      workspaceId,
      terminalId,
      kind: 'terminal',
    })

    const fitTerminal = () => {
      if (mount.clientWidth === 0 || mount.clientHeight === 0) return
      fitAddon.fit()
      if (term.cols > 0 && term.rows > 0) {
        void window.api.terminalResize(sessionId, term.cols, term.rows)
      }
    }

    const focusTerminal = () => {
      terminalDiagnostics.recordFocus()
      term.focus()
    }
    // Back to the bottom, and the keyboard back to the terminal: the person
    // jumped there to see what the program is doing now, usually to answer it.
    jumpToLatestRef.current = () => {
      term.scrollToBottom()
      focusTerminal()
    }

    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown') {
        terminalDiagnostics.recordKeydown(event)
      }
      return true
    })
    term.open(mount)
    // Immediately after `open()`: the WebGL addon reads `term.element`, and a
    // GPU failure loaded before that point escapes through `open()` itself.
    studioTerminal.loadWebglRenderer()

    const linkRoots = studioTerminal.linkRoots
    const fileLinkDisposable = term.registerLinkProvider(
      createTerminalFileLinkProvider({
        terminal: term,
        workspaceRoot: linkRoots.workspaceRoot,
        // A thunk, so a `cd` (or the async spawn-cwd resolution below) reaches the
        // links already on screen without re-registering the provider.
        executionRoot: () => oscExecutionRoot ?? launchExecutionRoot,
        // A shell under WSL reports its cwd and prints its paths the Linux
        // way; a folder inside a distribution's share says which one.
        wslDistro: () =>
          terminalWslDistro({
            platform: hostPlatform(),
            roots: [oscExecutionRoot ?? launchExecutionRoot, linkRoots.workspaceRoot],
          }),
        inspectPath,
        onActivate: openFileLinkMenu,
        onOpenError: (message, anchor) => setCursorError({ message, x: anchor.x, y: anchor.y }),
        // A matched path that never became a link leaves no trace on screen, so
        // count it — a workspace with no configured folder drops every relative
        // path in the pane and looks identical to a pane containing none.
        onDrop: terminalDiagnostics.recordFileLinkDrop,
      }),
    )

    // Loaded AFTER the file-link provider on purpose: xterm resolves link
    // providers in registration order and the earlier one's links suppress the
    // later one's on the same row, so a path that is also a valid URL fragment
    // must reach the file provider first.
    studioTerminal.loadWebLinks()

    fitTerminal()
    focusTerminal()
    let disposed = false
    // Fits once the code face has loaded, and again whenever Settings changes
    // it: the cells change size under a container that does not.
    studioTerminal.followCodeFont(() => {
      if (disposed) return
      fitTerminal()
      term.refresh(0, Math.max(0, term.rows - 1))
    })
    let reportedTerminalFailure = false
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
      onReplayProfile: (profile) => {
        logPerfEvent('PlainTerminalPanel', 'terminal-replay-profile', {
          sessionId,
          workspaceId,
          terminalId,
          kind: 'terminal',
          ...profile,
        })
        recordReplayProfile({
          ...profile,
          recordedAt: Date.now(),
          sessionId,
          workspaceId,
          terminalId,
          kind: 'terminal',
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
      term.write(`\r\n\x1b[31m[Terminal exited with code ${code}]\x1b[0m\r\n`)
      if (code !== 0 && !reportedTerminalFailure) {
        reportedTerminalFailure = true
        publishDiagnosticSync({
          level: 'error',
          source: 'terminal',
          title: 'Terminal exited',
          message: `Terminal exited with code ${code}.`,
          details: `Session: ${sessionId}`,
          workspaceId,
          workspaceName: workspaceNameRef.current,
          sessionId,
        })
      }
    })

    const disposeError = window.api.onTerminalError(sessionId, (message) => {
      term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`)
      reportedTerminalFailure = true
      publishDiagnosticSync({
        level: 'error',
        source: 'terminal',
        title: 'Terminal failed to start',
        message,
        details: `Session: ${sessionId}`,
        workspaceId,
        workspaceName: workspaceNameRef.current,
        sessionId,
      })
    })

    const onDataDisposable = term.onData((data) => {
      terminalDiagnostics.recordInput(data)
      window.api.terminalWriteFast(sessionId, data)
      terminalDiagnostics.recordInputDispatch(data)
    })

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
    })
    // Opening a workspace hands the keyboard to its visible terminal
    // (WorkspaceManager); the mount-time focusTerminal above can't do that job
    // because it also fires in panes stacked behind the visible tab.
    const disposeFocusRequest = onTerminalFocusRequest({ workspaceId, terminalId }, focusTerminal)

    if (cwdOverride || !(savedFolderPath && !folderReadyPath)) {
      void (async () => {
        // Redirect the spawn into the run worktree when this workspace is
        // worktree-backed; short-circuits (no fs probe) for normal, worktree-
        // opened, and connector-chat workspaces. Awaited before spawn so the pty
        // starts in the right directory.
        const resolved = await resolveWorkspaceTerminalCwd(
          workspaceWorktreeGitRoot,
          folderReadyPath,
          window.api.pathExists,
        )
        if (disposed) return
        const terminalCwd = cwdOverride ?? resolved.cwd ?? folderReadyPath ?? undefined
        // The directory the pty is about to start in — the resolution base for
        // relative paths until the shell reports one of its own. It matters most
        // for a pane with a `cwdOverride` or a worktree redirect, where it is
        // NOT the workspace root the surface carries.
        launchExecutionRoot = terminalCwd ?? null
        if (resolved.missing) {
          term.write(
            `\r\n\x1b[31m[worktree missing — opened in main checkout: ${terminalCwd ?? savedFolderPath ?? 'the workspace folder'}]\x1b[0m\r\n`,
          )
        }
        void window.api
          .terminalStatus(sessionId)
          .then((status) => {
            logPerfEvent(
              'PlainTerminalPanel',
              status.processAlive ? 'terminal-reattach-existing-session' : 'terminal-spawn-fresh',
              {
                sessionId,
                workspaceId,
                terminalId,
                kind: 'terminal',
                processAlive: status.processAlive,
                resumeRequested: false,
                willSpawnFresh: !status.processAlive,
              },
            )
          })
          .catch(() => {})
        replayGate.beginReplayWait()
        void window.api
          .terminalSpawn(sessionId, term.cols, term.rows, terminalCwd, false, undefined, undefined, undefined, true, {
            kind: 'terminal',
            workspaceId,
            terminalId,
            visible: true,
          })
          .then((spawnResult) => {
            replayGate.finishReplayWait()
            // A pane gone before its answer came — a popped-out terminal brought
            // back, whose re-attach main refused — has nothing to report.
            if (spawnResult.ok || disposed) return
            if (!reportedTerminalFailure) {
              reportedTerminalFailure = true
              publishDiagnosticSync({
                level: 'error',
                source: 'terminal',
                title: 'Terminal was not started',
                message: spawnResult.message,
                details: [
                  `Session: ${sessionId}`,
                  `Workspace path: ${terminalCwd ?? savedFolderPath ?? 'default app path'}`,
                ]
                  .filter(Boolean)
                  .join('\n'),
                workspaceId,
                workspaceName: workspaceNameRef.current,
                sessionId,
              })
            }
          })
          .catch((error) => {
            replayGate.finishReplayWait()
            if (reportedTerminalFailure) return
            reportedTerminalFailure = true
            publishDiagnosticSync({
              level: 'error',
              source: 'terminal',
              title: 'Terminal was not started',
              message: error instanceof Error ? error.message : 'Failed to start terminal.',
              details: `Session: ${sessionId}`,
              workspaceId,
              workspaceName: workspaceNameRef.current,
              sessionId,
            })
          })
      })()
    }
    const settleTimer = window.setTimeout(() => {
      fitTerminal()
      focusTerminal()
    }, 50)

    return () => {
      disposed = true
      window.clearTimeout(settleTimer)
      resizeObserver.disconnect()
      fitScheduler.dispose()
      container.removeEventListener('mousedown', focusTerminalFromPointer)
      container.removeEventListener('mouseup', focusTerminalFromPointer)
      container.removeEventListener('click', focusTerminalFromPointer)
      container.removeEventListener('focus', focusTerminal)
      disposeClipboardHandlers()
      disposeFocusRequest()
      disposeData()
      disposeReplay()
      disposeExit()
      disposeError()
      onDataDisposable.dispose()
      onResizeDisposable.dispose()
      fileLinkDisposable.dispose()
      disposePromptNavigation()
      markTracker?.dispose()
      terminalDiagnostics.dispose()
      replayGate.dispose()
      outputQueue.dispose()
      ackReporter.dispose()
      unregisterTerminalInstance(sessionId)
      studioTerminalRef.current = null
      // The next terminal this effect builds starts at its bottom.
      jumpToLatestRef.current = null
      setScrolledAway(false)
      // Last: it unbinds the theme and disposes the terminal itself, so nothing
      // above may still be reading `term`.
      studioTerminal.dispose()
      if (killOnUnmount || shouldKillOnUnmount?.(sessionId)) {
        void window.api.terminalKill(sessionId).catch(() => {})
      } else {
        logPerfEvent('PlainTerminalPanel', 'terminal-detached-from-renderer', {
          sessionId,
          workspaceId,
          terminalId,
          kind: 'terminal',
        })
        void window.api.terminalSetVisible(sessionId, false).catch(() => {})
      }
    }
  }, [
    cwdOverride,
    folderReadyPath,
    killOnUnmount,
    savedFolderPath,
    shouldKillOnUnmount,
    terminalId,
    workspaceId,
    workspaceWorktreeGitRoot,
  ])

  const folderBlocked = Boolean(!cwdOverride && savedFolderPath && !folderReadyPath)
  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    // A skill dragged here is caught and refused rather than ignored: this is a
    // shell, and an ignored drop would let the raw id land in it as plain text.
    // `none` refuses it for the whole hover, which says so earlier than a
    // message after the release, and no drop-target highlight is drawn.
    if (hasSkillDropData(event.dataTransfer)) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'none'
      return
    }
    if (!hasFileDropData(event.dataTransfer) && !hasCommitDropData(event.dataTransfer)) return
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

    const dropAnchor = { x: event.clientX, y: event.clientY }
    const showDropError = (message: string) => setCursorError({ message, x: dropAnchor.x, y: dropAnchor.y })

    // Normally unreachable — the refusal above ends the drag — but it is what
    // stops a skill that did reach here falling through to the file path and
    // reporting "no file was dropped", which explains nothing.
    if (isSkillDrop) {
      showDropError('This is a plain terminal. Drop a skill onto an agent instead.')
      return
    }

    if (isCommitDrop) {
      const commitResult = await pasteDroppedCommitIntoTerminal({
        dataTransfer: event.dataTransfer,
        sessionId: sessionIdRef.current,
      }).catch((error): { ok: false; message: string } => ({
        ok: false,
        message: error instanceof Error ? error.message : 'Could not drop the commit into the terminal.',
      }))
      if (!commitResult.ok) showDropError(commitResult.message)
      return
    }

    const result = await pasteDroppedFilesIntoTerminal({
      dataTransfer: event.dataTransfer,
      sessionId: sessionIdRef.current,
      workspaceId,
    }).catch((error): { ok: false; message: string } => ({
      ok: false,
      message: error instanceof Error ? error.message : 'Could not drop the file into the terminal.',
    }))

    if (!result.ok) showDropError(result.message)
  }

  return (
    <div className="relative h-full bg-[color:var(--bg-app)]">
      <div
        ref={containerRef}
        tabIndex={0}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(event) => void handleDrop(event)}
        className={`${FOCUS_RING_TERMINAL_CLASS} absolute inset-0 cursor-text overflow-hidden p-2`}
        // Marks this as a terminal surface, so a ⌘F pressed anywhere in it —
        // including in the find bar — activates the `terminal` command scope.
        {...{ [TERMINAL_SURFACE_ATTRIBUTE]: '' }}
      >
        <TerminalMount ref={terminalMountRef} />
        <TerminalFindBar find={find} />
        <TerminalJumpToLatest visible={scrolledAway} onJump={() => jumpToLatestRef.current?.()} />
        {/* No replay skeleton on terminals (see TerminalView): xterm renders
            its own content; keep the skeleton only for the folder check. */}
        {folderBlocked && checkingFolder ? <TerminalReplaySkeleton /> : null}
        {isFileDragOver ? (
          <div className="pointer-events-none absolute inset-2 z-10 rounded-md border border-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)]" />
        ) : null}
        {cursorError ? (
          <CursorErrorPopover
            key={`${cursorError.x},${cursorError.y},${cursorError.message}`}
            message={cursorError.message}
            anchor={{ x: cursorError.x, y: cursorError.y }}
            onDismiss={() => setCursorError(null)}
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
            // A failed destination reports through the same pointer-anchored
            // error surface the link click already used, at the click point.
            onError={(message) => setCursorError({ message, x: linkMenu.x, y: linkMenu.y })}
          />
        ) : null}
        {folderBlocked && folderMissing ? (
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-meta text-[color:var(--text-muted)]">
            {folderStatusMessage ??
              'Saved workspace folder is missing. Relink it from the Files pane before starting this terminal.'}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** A terminal runs on this computer; a workspace on an SSH machine says so instead (phase 8). */
export default function PlainTerminalPanel(props: Props) {
  const machine = useWorkspaceMachine(props.workspaceId)
  if (machine) return <NotOnMachineYet what="Terminals" machine={machine} />
  return <PlainTerminalPanelOnThisComputer {...props} />
}
