import assert from 'node:assert/strict'
import { standIn } from '../../tests/stand-in'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { WebContents } from 'electron'
import type { McpSettings, TerminalSpawnResult } from '../shared/electron-api'
import { createTerminalSnapshotSidecarStore } from './terminal-snapshot-sidecar'
import { createAgentPromptStore } from './agent-prompt-store'
import { createAgentLaunchService } from './agent-launch-service'
import { emptyAgentLaunchSettings } from '../shared/launch-settings'
import { test } from 'vitest'

test('terminal-runtime', async () => {
  type RuntimeModule = typeof import('./terminal-runtime')
  type SyncMcpConfig = NonNullable<
    Parameters<(typeof import('./terminal-runtime'))['createTerminalRuntime']>[0]['syncMcpConfig']
  >
  type SyncInput = Parameters<SyncMcpConfig>[0]
  type SyncResult = Awaited<ReturnType<SyncMcpConfig>>
  type TerminalRuntime = ReturnType<RuntimeModule['createTerminalRuntime']>
  type AgentSessionMetadata = NonNullable<
    Parameters<TerminalRuntime['ipcHandlers']['spawnTerminal']>[1]['agentSession']
  >
  type AgentSessionExitEvent = Parameters<Parameters<TerminalRuntime['registerAgentSessionExitListener']>[0]>[0]
  type AgentPhaseEvent = Parameters<Parameters<TerminalRuntime['registerAgentPhaseListener']>[0]>[0]
  type AgentStateFrame = Parameters<TerminalRuntime['ingestAgentStateFrame']>[0]

  type SentEvent = {
    channel: string
    payload: unknown
  }

  type MockPtyProcess = {
    pid: number
    cols?: number
    rows?: number
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(): void
    onData(callback: (data: string) => void): { dispose(): void }
    onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
    emitData(data: string): void
    emitExit(event?: { exitCode: number; signal?: number }): void
    writes: string[]
    killed: boolean
    pause(): void
    resume(): void
    pauses: number
    resumes: number
  }

  type SpawnCall = {
    command: string
    args: string[]
    options: Record<string, unknown>
    process: MockPtyProcess
  }

  const mockPty = {
    spawnCalls: [] as SpawnCall[],
    spawnError: null as Error | null,
    beforeSpawn: null as null | (() => void | Promise<void>),
    spawn(command: string, args: string[], options: Record<string, unknown>): MockPtyProcess {
      if (mockPty.spawnError) {
        const error = mockPty.spawnError
        mockPty.spawnError = null
        throw error
      }
      if (mockPty.beforeSpawn) {
        const callback = mockPty.beforeSpawn
        mockPty.beforeSpawn = null
        const result = callback()
        if (result && typeof (result as Promise<void>).then === 'function') {
          throw new Error('mockPty.beforeSpawn must be synchronous')
        }
      }
      const process = createMockPtyProcess()
      // The size the pty was spawned at, as node-pty reports it.
      if (typeof options.cols === 'number') process.cols = options.cols
      if (typeof options.rows === 'number') process.rows = options.rows
      mockPty.spawnCalls.push({ command, args, options, process })
      return process
    },
  }

  const mockSender = createMockWebContents()
  const defaultMockWindows = [
    {
      isDestroyed: () => false,
      webContents: mockSender,
    },
  ]
  // What mocked Electron reports as the open windows. Headless assertions empty it
  // via `withNoWindows` to stand in for "every window closed"; every other
  // assertion runs against the single default window.
  let mockWindows: typeof defaultMockWindows = defaultMockWindows
  const mockElectron = {
    app: {
      getAppPath: () => process.cwd(),
      getPath: () => join(tmpdir(), 'sprintengine-terminal-runtime-test-user-data'),
    },
    BrowserWindow: {
      getAllWindows: () => mockWindows,
    },
  }

  async function withNoWindows<T>(run: () => Promise<T>): Promise<T> {
    mockWindows = []
    try {
      return await run()
    } finally {
      mockWindows = defaultMockWindows
    }
  }

  const restoreModules = standIn({ electron: mockElectron, 'node-pty': mockPty })

  async function main(): Promise<void> {
    try {
      const runtimeModule = (await import('./terminal-runtime')) as RuntimeModule
      // The gate-behavior sweeps below spawn only a handful of agents, which the
      // default recency floor (keep the N most recent alive) would spare wholesale.
      // Disable the floor so each per-session gate is exercised in isolation; the
      // dedicated floor assertion re-enables it.
      runtimeModule.setKeepRecentTerminalsAlive(0)
      // No assertion below except the pre-flight ones is about binary resolution,
      // and the real pre-flight spawns login shells to read this machine's PATH.
      // An empty registry makes every CLI undecided — the pre-flight's
      // "proceed exactly as before" answer.
      runtimeModule.__setAgentCliPreflightForTest({
        platform: 'darwin',
        shell: '/bin/zsh',
        deps: { listEntries: () => [] },
      })
      await assertIdleSweepRecencyFloorSparesMostRecent(runtimeModule)
      await assertUserLockHoldsReaperAndSuspendedRevealIsIdempotent(runtimeModule)
      await assertStandardAgentSpawnKeepsEnabledOptionalMcpSettings(runtimeModule)
      await assertAgentSpawnReportsSyncFailureWithoutPtySpawn(runtimeModule)
      await assertAgentSpawnExposesAgentIdentityEnv(runtimeModule)
      await assertIngestAgentStateFrameUpdatesSession(runtimeModule)
      await assertTurnEndIsHeldWhileBackgroundWorkIsOpen(runtimeModule)
      await assertTurnEndSurvivesLateFrames(runtimeModule)
      await assertFileLedgerFollowsHookReportedEdits(runtimeModule)
      await assertAgentChangelistSeamsFire(runtimeModule)
      await assertContextUsageFollowsStatusLineFrames(runtimeModule)
      await assertStatusLineUsageWindowsReachTheStoreOnlyWhenNews(runtimeModule)
      await assertObservedCheckoutReachesThePullRequestSeam(runtimeModule)
      await assertTerminalReattachUsesReplayChannel(runtimeModule)
      await assertHiddenTerminalOutputSkipsLiveIpcAndReplaysOnAttach(runtimeModule)
      await assertStaleSweepReapsOnlyUnseenHiddenTerminals(runtimeModule)
      await assertIdleSweepSuspendsRatherThanDisposes(runtimeModule)
      await assertSuspendSettlesAWorkingAgentToRest(runtimeModule)
      await assertSuspendSnapshotSidecarsSurviveRestart(runtimeModule)
      await assertSuspendReleasesRawStreamButKeepsFrozenScreen(runtimeModule)
      await assertSelfExitedAgentReleasesRawStreamButKeepsFinalScreen(runtimeModule)
      await assertSessionsBroadcastCarriesOnlyWhatChanged(runtimeModule)
      await assertRevealSendsOnlyWhatThePaneMissed(runtimeModule)
      await assertOnlyTheRoutedWindowSpeaksForVisibility(runtimeModule)
      await assertSettledAgentKeepsItsHistoryAndIsNotRepaintedOnReveal(runtimeModule)
      await assertRevealCatchUpCountsTowardFlowControl(runtimeModule)
      await assertSubagentStartOvertakenByItsStopIsNotCounted(runtimeModule)
      await assertFlowControlPausesThePtyWhileThePaneFallsBehind(runtimeModule)
      await assertSelfExitedAgentWritesSidecarButDisposeDoesNot(runtimeModule)
      await assertSpawnSkillInstallIsOrthogonalToMcpIsolation(runtimeModule)
      await assertAgentSessionExitListenerFiresSystemTaggedForAnySystem(runtimeModule)
      await assertResolveAgentExecutionIdMatchesLiveSession(runtimeModule)
      await assertHeadlessSpawnAttachesToLaterWindow(runtimeModule)
      await assertAgentLaunchServiceLaunchesWithNoWindows(runtimeModule)
      await assertGuardedSweepHoldsSessionsWithLiveSubtreeWork(runtimeModule)
      await assertPendingWakeupFrameHoldsIdleReaper(runtimeModule)
      await assertObservedCheckoutFollowsHookCwd(runtimeModule)
      await assertAgentPhaseListenerFiresOnlyForAcceptedFrames(runtimeModule)
      await assertSpawnLaunchesProbedPathAndFailsHonestlyWhenAbsent(runtimeModule)
      await assertSpawnWithoutCliRefusesInsteadOfDefaultingToCodex(runtimeModule)
      await assertSpawnRefusesAgentCliWithoutAgentStateSpec(runtimeModule)
      await assertSendAfterReadyTypesTheFirstMessageOnce(runtimeModule)
      await assertUndeliveredFirstMessageIsHandedBack(runtimeModule)
    } finally {
      restoreModules()
    }
  }

  // The pre-flight probes the machine's real PATH by spawning login shells, which
  // unit tests must not do. Pin the verdict (and the POSIX setup it is trusted on)
  // while leaving the pre-flight's own logic — the message, the cache, the IPC
  // shape — to the real code.
  function pinAgentCliPreflight(
    runtimeModule: RuntimeModule,
    detect: { installed: boolean; resolvedPath?: string | null },
  ): void {
    runtimeModule.__setAgentCliPreflightForTest({
      platform: 'darwin',
      shell: '/bin/zsh',
      deps: {
        listEntries: () => [
          {
            id: 'claude-code',
            displayName: 'Claude Code',
            source: 'bundled',
            version: 1,
            binary: 'claude',
            resumeSession: true,
            sessionIdFromCaller: true,
            agentStateCapable: true,
          },
        ],
        detect: async (cli) => ({
          cli,
          binary: 'claude',
          installed: detect.installed,
          version: detect.installed ? '2.0.0' : null,
          resolvedPath: detect.resolvedPath ?? null,
          hostId: 'local',
          error: null,
        }),
        // Each case is its own question; never serve another case's cached verdict.
        ttlMs: 0,
      },
    })
  }

  // A ScheduleWakeup hook frame must hold the idle reaper until the wake time:
  // the timer lives inside the CLI process, and the agent reads as 'idle' while
  // waiting — the exact state the reaper hunts. The hold rides the PURE policy
  // (no probe), so even the unguarded sync sweep respects it; a stop frame
  // disarms it and the session reaps normally.
  async function assertPendingWakeupFrameHoldsIdleReaper(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-wakeup-hold-'))
    mockPty.spawnCalls = []
    mockSender.sent = []

    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })

    const spawnResult = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session-wakeup',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      cli: 'codex',
      kind: 'agent',
      shellOnly: false,
      workspaceId: 'ws-wakeup',
      agentId: 'session-wakeup',
      visible: false,
      mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
    })
    assert.equal(spawnResult.ok, true, JSON.stringify(spawnResult))

    try {
      const scheduledAt = Date.now()
      // The agent schedules a 40-minute wakeup mid-turn (PostToolUse), then its
      // turn ends (Stop → idle). The Stop must NOT clear the pending wakeup.
      runtime.ingestAgentStateFrame({
        type: 'agent_state',
        agentId: 'session-wakeup',
        workspaceId: 'ws-wakeup',
        sessionId: null,
        phase: 'thinking',
        event: 'PostToolUse',
        ts: scheduledAt,
        wakeup: { delaySeconds: 40 * 60 },
      })
      runtime.ingestAgentStateFrame({
        type: 'agent_state',
        agentId: 'session-wakeup',
        workspaceId: 'ws-wakeup',
        sessionId: null,
        phase: 'idle',
        event: 'Stop',
        ts: scheduledAt + 1_000,
      })

      // 30 minutes on: rested well past the 15m idle threshold, but the wakeup
      // fires at +40m — the pure policy must hold it.
      const restedButPending = scheduledAt + 30 * 60 * 1000
      assert.ok(
        !runtimeModule.runIdleAgentReapSweep(restedButPending).includes('session-wakeup'),
        'an idle agent with a pending wakeup must be held by the pure policy',
      )

      // 70 minutes on: the wake time passed with no re-arm — reaps normally.
      const wakeupExpired = scheduledAt + 70 * 60 * 1000
      assert.ok(
        runtimeModule.runIdleAgentReapSweep(wakeupExpired).includes('session-wakeup'),
        'an expired wakeup must not park the session',
      )
    } finally {
      runtime.ipcHandlers.killTerminal('session-wakeup')
    }
  }

  // Observed checkout: the cwd a hook frame carries is where the
  // session IS, resolved through git into the checkout containing it, and it is
  // what the snapshot reports — not the launch cwd the agent may have left.
  async function assertObservedCheckoutFollowsHookCwd(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-observed-'))
    mockPty.spawnCalls = []
    mockSender.sent = []

    const worktreeRoot = join(workspaceRoot, '.sprintengine-worktrees', 'ws', 'feature')
    const resolveCalls: string[] = []
    let blockResolution: Promise<void> | null = null
    let gone = true
    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
      resolveObservedCheckout: async (cwd) => {
        resolveCalls.push(cwd)
        if (blockResolution) await blockResolution
        if (cwd === workspaceRoot || cwd.startsWith(workspaceRoot + '/src')) {
          return { gitRoot: workspaceRoot, repoRoot: workspaceRoot, branch: 'main', isLinkedWorktree: false }
        }
        if (cwd === worktreeRoot || cwd === '/race/wt') {
          return { gitRoot: worktreeRoot, repoRoot: workspaceRoot, branch: 'agent/feature', isLinkedWorktree: true }
        }
        if (cwd === '/race/src') {
          return { gitRoot: workspaceRoot, repoRoot: workspaceRoot, branch: 'main', isLinkedWorktree: false }
        }
        if (cwd === '/unanswerable') return null
        if (cwd === '/gone')
          return gone
            ? { gitRoot: null, repoRoot: null, branch: null, isLinkedWorktree: false, missing: true }
            : { gitRoot: null, repoRoot: null, branch: null, isLinkedWorktree: false }
        return { gitRoot: null, repoRoot: null, branch: null, isLinkedWorktree: false }
      },
    })

    const sessionId = 'session-observed'
    const spawnResult = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId,
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      cli: 'claude-code',
      kind: 'agent',
      shellOnly: false,
      workspaceId: 'ws-observed',
      agentId: sessionId,
      visible: false,
      mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
    })
    assert.equal(spawnResult.ok, true, JSON.stringify(spawnResult))

    const snapshot = () => runtime.ipcHandlers.listTerminals().find((entry) => entry.sessionId === sessionId)
    const settle = async () => {
      for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r))
      // The broadcast is coalesced behind a frame's timer; the resolver's
      // promise chain has settled by now, so this waits for the send itself.
      await delay(runtimeModule.TERMINAL_SESSIONS_BROADCAST_COALESCE_MS + 10)
    }
    const frame = (overrides: Partial<AgentStateFrame>): AgentStateFrame => ({
      type: 'agent_state',
      agentId: sessionId,
      workspaceId: 'ws-observed',
      sessionId: null,
      event: 'PostToolUse',
      ts: Date.now(),
      ...overrides,
    })

    try {
      assert.equal(snapshot()?.observedCheckout, undefined, 'nothing observed before the first hook frame')

      // First frame: the session starts where it was launched — and git says so.
      const t0 = Date.now()
      runtime.ingestAgentStateFrame(frame({ event: 'SessionStart', ts: t0, cwd: workspaceRoot }))
      assert.equal(snapshot()?.observedCheckout?.cwd, workspaceRoot, 'the cwd is observed synchronously')
      assert.equal(snapshot()?.observedCheckout?.resolved, false, 'unresolved until git answers')
      await settle()
      const main = snapshot()?.observedCheckout
      assert.equal(main?.resolved, true)
      assert.equal(main?.gitRoot, workspaceRoot)
      assert.equal(main?.branch, 'main')
      assert.equal(main?.isLinkedWorktree, false)
      assert.equal(main?.at, t0, '`at` is the frame that observed the cwd')

      // Same cwd on the next frames: no re-observation, no re-resolution.
      const callsBefore = resolveCalls.length
      runtime.ingestAgentStateFrame(frame({ ts: t0 + 10, cwd: workspaceRoot }))
      await settle()
      assert.equal(resolveCalls.length, callsBefore, 'an unchanged cwd resolves nothing')
      assert.equal(snapshot()?.observedCheckout?.at, t0, 'an unchanged cwd keeps its arrival time')

      // The agent creates a worktree and moves into it (EnterWorktree, or a
      // persisted cd): the PostToolUse that follows carries the new cwd.
      const t1 = t0 + 1000
      mockSender.sent = []
      runtime.ingestAgentStateFrame(frame({ ts: t1, cwd: worktreeRoot }))
      assert.equal(snapshot()?.observedCheckout?.cwd, worktreeRoot)
      assert.equal(snapshot()?.observedCheckout?.resolved, false)
      assert.ok(
        !mockSender.sent.some((event) => event.channel === 'terminal:sessions-delta'),
        'the move itself does not broadcast (unresolved renders as launch intent — a flicker)',
      )
      await settle()
      assert.ok(
        mockSender.sent.some((event) => event.channel === 'terminal:sessions-delta'),
        'git answering broadcasts, even though thinking↔tool_use churn does not',
      )
      const wt = snapshot()?.observedCheckout
      assert.equal(wt?.resolved, true)
      assert.equal(wt?.isLinkedWorktree, true, 'git says it is a linked worktree')
      assert.equal(wt?.branch, 'agent/feature')
      assert.equal(wt?.repoRoot, workspaceRoot, 'the worktree points back at the primary checkout')
      assert.equal(snapshot()?.cwd, workspaceRoot, 'launch intent is untouched')

      // A frame older than the observation cannot roll the cwd backwards.
      runtime.ingestAgentStateFrame(frame({ ts: t0 + 500, cwd: workspaceRoot }))
      await settle()
      assert.equal(snapshot()?.observedCheckout?.cwd, worktreeRoot, 'a stale frame does not move the cwd back')

      // A frame the spec DROPS for phase (an informational Notification) still
      // moves the cwd: the observation is applied before the phase drop.
      const t2 = t1 + 1000
      const insideSrc = join(workspaceRoot, 'src')
      runtime.ingestAgentStateFrame(
        frame({ event: 'Notification', notificationType: 'idle_prompt', ts: t2, cwd: insideSrc }),
      )
      assert.equal(snapshot()?.observedCheckout?.cwd, insideSrc, 'a phase-dropped frame still observes the cwd')
      await settle()
      assert.equal(snapshot()?.observedCheckout?.gitRoot, workspaceRoot, 'a subdirectory resolves to its checkout')
      assert.equal(snapshot()?.observedCheckout?.isLinkedWorktree, false)

      // A frame for an event the manifest does not name at all (a stale
      // CwdChanged registration from another tool) still observes its cwd.
      runtime.ingestAgentStateFrame(frame({ event: 'CwdChanged', ts: t2 + 5, cwd: insideSrc }))
      assert.equal(snapshot()?.observedCheckout?.cwd, insideSrc)

      // A turn end re-resolves the SAME cwd (the branch can move in place).
      const callsBeforeStop = resolveCalls.length
      runtime.ingestAgentStateFrame(frame({ event: 'Stop', ts: t2 + 10, cwd: insideSrc }))
      await settle()
      assert.equal(resolveCalls.length, callsBeforeStop + 1, 'a turn end re-asks git about the current cwd')
      assert.equal(resolveCalls[resolveCalls.length - 1], insideSrc)

      // Bouncing back to a directory answered moments ago is served from the
      // short cache: no git per tool call for an agent alternating two dirs.
      const callsBeforeBounce = resolveCalls.length
      runtime.ingestAgentStateFrame(frame({ ts: t2 + 20, cwd: worktreeRoot }))
      await settle()
      assert.equal(resolveCalls.length, callsBeforeBounce, 'a recently answered cwd is not re-resolved')
      assert.equal(snapshot()?.observedCheckout?.isLinkedWorktree, true, 'the cached answer is applied')
      assert.equal(snapshot()?.observedCheckout?.resolved, true)

      // A resolver that cannot answer leaves the observation unresolved (never
      // "folder"), so consumers fall back to launch intent — and that outcome is
      // broadcast, or the renderer would keep showing the checkout just left.
      const t3 = t2 + 2000
      mockSender.sent = []
      runtime.ingestAgentStateFrame(frame({ ts: t3, cwd: '/unanswerable' }))
      await settle()
      assert.equal(snapshot()?.observedCheckout?.cwd, '/unanswerable')
      assert.equal(snapshot()?.observedCheckout?.resolved, false, 'null from the resolver stays unresolved')
      assert.ok(
        mockSender.sent.some((event) => event.channel === 'terminal:sessions-delta'),
        'an unanswerable move still broadcasts the unresolved observation',
      )

      // A directory that vanished reads missing; when it comes back as a plain
      // folder the flag must not stick to the next answer.
      gone = true
      runtime.ingestAgentStateFrame(frame({ ts: t3 + 100, cwd: '/gone' }))
      await settle()
      assert.equal(snapshot()?.observedCheckout?.missing, true, 'a vanished cwd is missing')
      gone = false
      runtime.ingestAgentStateFrame(frame({ event: 'Stop', ts: t3 + 200, cwd: '/gone' }))
      await settle()
      assert.equal(snapshot()?.observedCheckout?.resolved, true)
      assert.equal(snapshot()?.observedCheckout?.missing, undefined, 'a recreated directory is no longer missing')

      // A slow resolution that finishes after a newer cwd arrived is discarded.
      let release: () => void = () => undefined
      blockResolution = new Promise<void>((resolve) => {
        release = resolve
      })
      const t4 = t3 + 1000
      runtime.ingestAgentStateFrame(frame({ ts: t4, cwd: '/race/wt' }))
      await settle()
      blockResolution = null
      const t5 = t4 + 1000
      runtime.ingestAgentStateFrame(frame({ ts: t5, cwd: '/race/src' }))
      await settle()
      release()
      await settle()
      assert.equal(snapshot()?.observedCheckout?.cwd, '/race/src')
      assert.equal(snapshot()?.observedCheckout?.gitRoot, workspaceRoot, 'the newest cwd wins over a late resolution')
      assert.equal(snapshot()?.observedCheckout?.isLinkedWorktree, false, 'the stale worktree answer was discarded')

      // Suspend then resume under the same session id: the observation rides
      // across the gap, so the resumed tab keeps saying where the agent was
      // until its first hook frame re-observes.
      runtime.ipcHandlers.suspendTerminal(sessionId)
      mockPty.spawnCalls[0]?.process.emitExit({ exitCode: 0 })
      await settle()
      assert.equal(snapshot()?.suspended, true)
      assert.equal(snapshot()?.observedCheckout?.cwd, '/race/src', 'a suspended session keeps its observation')
      const resumed = await runtime.ipcHandlers.resumeTerminal(mockSender as unknown as WebContents, {
        sessionId,
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-observed',
        agentId: sessionId,
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(resumed.ok, true, JSON.stringify(resumed))
      assert.equal(snapshot()?.suspended, false)
      assert.equal(
        snapshot()?.observedCheckout?.cwd,
        '/race/src',
        'resume carries the observation onto the fresh session',
      )
      assert.equal(snapshot()?.observedCheckout?.gitRoot, workspaceRoot)

      // A second session launched into a directory another session answered
      // moments ago asks fresh on its first observation: the cached answer may
      // predate a branch switch made just before this launch.
      const secondId = 'session-observed-2'
      const second = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: secondId,
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-observed',
        agentId: secondId,
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(second.ok, true, JSON.stringify(second))
      try {
        const callsBeforeSecond = resolveCalls.length
        runtime.ingestAgentStateFrame(
          frame({ agentId: secondId, event: 'SessionStart', ts: Date.now(), cwd: insideSrc }),
        )
        await settle()
        assert.equal(resolveCalls.length, callsBeforeSecond + 1, 'a first observation bypasses the cache')
      } finally {
        runtime.ipcHandlers.killTerminal(secondId)
      }

      // A pull request record change re-emits the sessions the record says it
      // reaches, and only those (epic `pull-request-marks`, decision 10). Which
      // sessions those are is the record's question — by repository and branch, or
      // by which session opened the pull request — so what the runtime owes is the
      // filter and the broadcast.
      // Let the previous session's teardown broadcast land before counting.
      await settle()
      const broadcasts = () => mockSender.sent.filter((event) => event.channel === 'terminal:sessions-delta').length
      const broadcastsBeforeRecord = broadcasts()
      const seen: string[] = []
      runtimeModule.notePullRequestRecordChanged((session) => {
        seen.push(session.sessionId)
        return false
      })
      await settle()
      assert.ok(seen.includes(sessionId), "every live session is offered to the record's filter")
      assert.equal(broadcasts(), broadcastsBeforeRecord, 'a change no live session is on never repaints a window')

      runtimeModule.notePullRequestRecordChanged((session) => session.sessionId === sessionId)
      await settle()
      assert.ok(broadcasts() > broadcastsBeforeRecord, 'the sessions the change reaches are re-emitted')
    } finally {
      runtime.ipcHandlers.killTerminal(sessionId)
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // The generic phase-listener seam. Two properties carry the weight, because a
  // consumer finalizes real work (opens a PR, deletes a worktree) off these events:
  // only frames the runtime ACCEPTED may be published (never a stale frame, never a
  // frame for a dead pty), and the wakeup a listener sees must be the one armed on
  // the SESSION — the turn-end frame that a consumer acts on never carries one, so
  // a passthrough of frame.wakeup would read "no wakeup" for every self-paced agent.
  async function assertAgentPhaseListenerFiresOnlyForAcceptedFrames(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-phase-'))
    mockPty.spawnCalls = []
    mockSender.sent = []

    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })

    const events: AgentPhaseEvent[] = []
    // Registered FIRST and throwing synchronously: a faulting listener must take
    // down neither the listeners behind it nor the frame ingest itself.
    const unregisterThrowing = runtime.registerAgentPhaseListener(() => {
      throw new Error('listener boom')
    })
    const unregister = runtime.registerAgentPhaseListener((event) => {
      events.push(event)
    })

    const spawnAgentTerminal = async (sessionId: string, agentId: string): Promise<MockPtyProcess> => {
      const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId,
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-phase',
        agentId,
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      const spawned = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
      assert.ok(spawned, `expected a pty for ${sessionId}`)
      return spawned
    }

    const frame = (
      overrides: Partial<AgentStateFrame> & Pick<AgentStateFrame, 'phase' | 'event' | 'ts'>,
    ): AgentStateFrame => ({
      type: 'agent_state',
      agentId: 'agent-phase',
      workspaceId: 'ws-phase',
      sessionId: null,
      ...overrides,
    })

    const listenerFailures: unknown[] = []
    const originalConsoleError = console.error
    console.error = (...args: unknown[]): void => {
      listenerFailures.push(args[0])
    }

    try {
      const pty = await spawnAgentTerminal('session-phase', 'agent-phase')
      const scheduledAt = Date.now()
      const wakeupAt = scheduledAt + 20 * 60 * 1000

      // Mid-turn: the ScheduleWakeup PostToolUse frame is the ONLY frame the
      // reporter ever attaches a wakeup to.
      runtime.ingestAgentStateFrame(
        frame({
          phase: 'thinking',
          event: 'PostToolUse',
          ts: scheduledAt,
          wakeup: { delaySeconds: 20 * 60 },
        }),
      )
      // Turn end: carries no wakeup of its own, but must still report the armed one.
      runtime.ingestAgentStateFrame(
        frame({
          phase: 'idle',
          event: 'Stop',
          ts: scheduledAt + 1_000,
          transcriptPath: '/tmp/transcript.jsonl',
        }),
      )
      await delay(20)

      assert.deepEqual(
        events.map((event) => event.event),
        ['PostToolUse', 'Stop'],
        'the raw reporter event name must ride the event unmodified, and a throwing listener ahead of this one must not have suppressed delivery',
      )
      assert.equal(listenerFailures.length, 2, 'each faulting listener call must be reported, not swallowed')
      assert.deepEqual(
        events[1],
        {
          workspaceId: 'ws-phase',
          agentId: 'agent-phase',
          executionId: null,
          phase: 'idle',
          previousPhase: 'thinking',
          event: 'Stop',
          // Resolved from the claude-code manifest's event table: Stop is the
          // session's turn end.
          turnEnd: true,
          turnFailure: false,
          ts: scheduledAt + 1_000,
          pendingWakeupAt: wakeupAt,
          transcriptPath: '/tmp/transcript.jsonl',
        },
        'a turn end must report the session-resolved pending wakeup, not the frame’s (absent) one',
      )
      assert.ok(
        (events[1]?.pendingWakeupAt ?? 0) > Date.now(),
        'the armed wakeup must still be in the future on the turn-end event',
      )

      // What the conversation peek reads off the session, left there by these same
      // frames: every prompt the session was sent. It is the peek's only source.
      runtime.ingestAgentStateFrame(
        frame({
          phase: 'thinking',
          event: 'UserPromptSubmit',
          ts: scheduledAt + 2_000,
          prompt: 'Check whether the prompt is persisted anywhere',
        }),
      )
      runtime.ingestAgentStateFrame(
        frame({
          phase: 'thinking',
          event: 'UserPromptSubmit',
          ts: scheduledAt + 3_000,
          prompt: 'Use the design system for this',
        }),
      )
      assert.deepEqual(
        await runtime.readConversationPeekSessionState('session-phase'),
        {
          // Claude Code reports messages, so a chat of its that has said nothing
          // yet must never be reported as a runtime that cannot report.
          reportsMessages: true,
          prompts: [
            { text: 'Check whether the prompt is persisted anywhere', at: scheduledAt + 2_000 },
            { text: 'Use the design system for this', at: scheduledAt + 3_000 },
          ],
        },
        'the peek must see every prompt the session was sent',
      )
      assert.equal(
        await runtime.readConversationPeekSessionState('session-nonexistent'),
        null,
        'a session that does not exist answers null, not an empty peek',
      )

      // A stale frame (older than the recorded phase) is rejected upstream of the
      // listener, so no consumer can act on a phase the runtime itself ignored.
      const before = events.length
      runtime.ingestAgentStateFrame(frame({ phase: 'thinking', event: 'PreToolUse', ts: scheduledAt - 1 }))
      await delay(20)
      assert.equal(events.length, before, 'a stale frame must not reach a phase listener')

      // A late frame for a dead pty must not reach a listener either: it would let
      // a consumer finalize a run whose agent is already gone.
      pty.emitExit({ exitCode: 0 })
      await delay(20)
      const beforeDeadFrame = events.length
      runtime.ingestAgentStateFrame(frame({ phase: 'idle', event: 'Stop', ts: Date.now() + 5_000 }))
      await delay(20)
      assert.equal(events.length, beforeDeadFrame, 'a frame for a dead pty must not reach a phase listener')

      // Unregister stops delivery — the registration seam is a real subscription.
      unregister()
      unregisterThrowing()
      const pty2 = await spawnAgentTerminal('session-phase-2', 'agent-phase-2')
      runtime.ingestAgentStateFrame(
        frame({
          agentId: 'agent-phase-2',
          phase: 'idle',
          event: 'Stop',
          ts: Date.now(),
        }),
      )
      await delay(20)
      assert.equal(
        events.some((event) => event.agentId === 'agent-phase-2'),
        false,
        'an unregistered listener must not receive further phase events',
      )

      // A consumer's reaction to a phase event is asynchronous — summarize the
      // transcript, open a PR, remove the worktree — so shutdown must WAIT on it
      // rather than tear the runtime down on top of half-finished finalization.
      // Gated rather than timed: the listener hangs until we release it, so
      // shutdown can only settle early by failing to track the work at all.
      let releaseFinalization = (): void => {}
      const finalization = new Promise<void>((resolve) => {
        releaseFinalization = resolve
      })
      let finalizationCompleted = false
      const unregisterSlow = runtime.registerAgentPhaseListener(async () => {
        await finalization
        finalizationCompleted = true
      })
      runtime.ingestAgentStateFrame(
        frame({
          agentId: 'agent-phase-2',
          phase: 'idle',
          event: 'Stop',
          ts: Date.now(),
        }),
      )

      let shutdownSettled = false
      const shutdownComplete = runtime.shutdown().then(() => {
        shutdownSettled = true
      })
      // Let the pty report its exit, so shutdown's terminal wait is satisfied and
      // the ONLY thing it can still be blocked on is the listener's finalization.
      await delay(20)
      pty2.emitExit({ exitCode: 0 })
      await delay(100)
      assert.equal(shutdownSettled, false, 'shutdown must not settle while a phase listener is still finalizing')

      releaseFinalization()
      await shutdownComplete
      unregisterSlow()
      assert.equal(finalizationCompleted, true, 'shutdown must drain in-flight phase-listener work')
    } finally {
      console.error = originalConsoleError
      unregister()
      unregisterThrowing()
      await runtime.shutdown()
    }
  }

  // Headless spawn + window attach: main spawns an agent with no window using the
  // headless sender — the PTY runs and retains scrollback while every outbound
  // send no-ops — and a window that opens later reattaches through the
  // spawnTerminal existing-session branch, adopting the real WebContents and
  // replaying the buffered output.
  async function assertHeadlessSpawnAttachesToLaterWindow(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-headless-'))
    mockPty.spawnCalls = []
    mockSender.sent = []

    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })

    const { createHeadlessTerminalSender } = await import('./terminal-session')

    const headless = await runtime.ipcHandlers.spawnTerminal(createHeadlessTerminalSender(), {
      sessionId: 'session-headless',
      cols: 100,
      rows: 30,
      cwd: workspaceRoot,
      cli: 'codex',
      kind: 'agent',
      shellOnly: false,
      workspaceId: 'ws-headless',
      agentId: 'session-headless',
      visible: false,
      mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
    })
    assert.equal(headless.ok, true, JSON.stringify(headless))
    assert.equal(mockPty.spawnCalls.length, 1, 'headless spawn still creates the PTY')

    try {
      // Output emitted with no window buffers into retained scrollback without
      // throwing (the headless sender reports destroyed, so nothing sends).
      mockPty.spawnCalls[0]!.process.emitData('headless output before any window\r\n')

      // A window opens later: the same-sessionId spawn adopts the real sender
      // and replays the buffered scrollback instead of respawning.
      const reattach = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'session-headless',
        cols: 100,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'codex',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-headless',
        agentId: 'session-headless',
        visible: true,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(reattach.ok, true, JSON.stringify(reattach))
      assert.equal(mockPty.spawnCalls.length, 1, 'reattach adopts the live session; no second PTY')
      const replay = mockSender.sent.find((event) => event.channel === 'terminal:replay:session-headless')
      assert.ok(replay, 'reattach replays scrollback to the newly attached window')
      assert.ok(
        String(replay?.payload ?? '').includes('headless output before any window'),
        'replay carries output produced while headless',
      )

      // The agent dragged to another chat reattaches from there: the session
      // follows it, and still says which chat its process was launched in,
      // which is the one that process names in everything it reports.
      const moved = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'session-headless',
        cols: 100,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'codex',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-moved',
        agentId: 'session-headless',
        visible: true,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(moved.ok, true, JSON.stringify(moved))
      const snapshot = runtime.ipcHandlers.listTerminals().find((entry) => entry.sessionId === 'session-headless')
      assert.equal(snapshot?.workspaceId, 'ws-moved')
      assert.equal(snapshot?.launchWorkspaceId, 'ws-headless')
    } finally {
      runtime.ipcHandlers.killTerminal('session-headless')
    }
  }

  // AgentLaunchService end to end with zero windows, which is the whole
  // point of the item: `agent.launch` used to fail with no window open because the
  // COMPOSITION lived in a React hook, even though the spawn below never needed a
  // window. This drives the real service over the real runtime, so it proves the
  // composed CLI, permission preset, MCP config, and initial prompt reach an
  // actual pty with every window closed — and that a window opened afterwards
  // adopts that same session with its scrollback rather than starting a second one.
  async function assertAgentLaunchServiceLaunchesWithNoWindows(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-agent-launch-headless-'))
    mockPty.spawnCalls = []
    mockSender.sent = []

    const syncInputs: SyncInput[] = []
    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
      syncMcpConfig: async (input): Promise<SyncResult> => {
        syncInputs.push(input)
        return { ok: true }
      },
    })
    pinAgentCliPreflight(runtimeModule, { installed: true, resolvedPath: '/usr/local/bin/claude' })

    const service = createAgentLaunchService({
      listWorkspaces: () => [{ id: 'ws-headless-launch', mode: 'standard', folderPath: workspaceRoot, agents: {} }],
      getLaunchSettings: () => ({
        ...emptyAgentLaunchSettings(),
        lastSelectedCli: 'claude-code',
        lastAgentSpawnPermissionPreset: 'bypass',
        mcp: { syncEnabled: true, servers: {} },
      }),
      terminal: {
        list: () => runtime.ipcHandlers.listTerminals(),
        spawn: (payload) => runtime.ipcHandlers.spawnTerminal(runtimeModule.resolveSpawnEventSink(), payload),
        kill: (sessionId) => runtime.ipcHandlers.killTerminal(sessionId),
      },
    })

    try {
      const launched = await withNoWindows(() =>
        service.launch({
          workspaceId: 'ws-headless-launch',
          prompt: 'Audit the auth flow.',
        }),
      )
      assert.equal(launched.ok, true, JSON.stringify(launched))
      if (!launched.ok) return
      assert.equal(mockPty.spawnCalls.length, 1, 'a windowless agent.launch still creates the pty')
      assert.equal(
        (await runtime.ipcHandlers.getTerminalStatus(launched.sessionId)).processAlive,
        true,
        'the launched session is live with no window open',
      )

      // The composition main did, read off the real launch: the user's CLI and
      // permission preset rendered into the startup script, their MCP settings
      // handed to the config sync, and the caller's prompt carried verbatim.
      const startupScript = await readFile(String(mockPty.spawnCalls[0]!.args.at(-1)), 'utf8')
      assert.match(startupScript, /claude/, 'the last-selected CLI is what launched')
      assert.match(startupScript, /--permission-mode bypassPermissions/, 'the app-level spawn preset reached the argv')
      assert.match(startupScript, /Audit the auth flow\./, 'and carries the caller directive')
      assert.deepEqual(
        syncInputs.at(-1)?.settings,
        { syncEnabled: true, servers: {} },
        "the user's MCP settings synced",
      )

      // The launch record rides the session snapshot — this is what the renderer
      // projects a tab from when a window finally opens.
      const snapshot = runtime.ipcHandlers.listTerminals().find((entry) => entry.sessionId === launched.sessionId)
      assert.equal(snapshot?.agentRecord?.agentId, launched.agentId)
      assert.equal(snapshot?.agentRecord?.cli, 'claude-code')
      assert.equal(snapshot?.agentRecord?.cliPermissionPreset, 'bypass')

      // The run's correlation key. An agent-backed automation finalizes on its
      // agent's exit, and the runtime only reports that exit for a session with an
      // execution identity — so a launch that composed everything else correctly
      // and omitted this would start runs that could never end.
      assert.equal(
        runtime.resolveAgentExecutionId({ workspaceId: 'ws-headless-launch', agentId: launched.agentId }),
        launched.sessionId,
      )

      mockPty.spawnCalls[0]!.process.emitData('launched output before any window\r\n')

      // A window opens later and the projected tab attaches by session id — the
      // same-sessionId spawn the renderer issues — replaying what buffered.
      const reattach = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: launched.sessionId,
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        resume: true,
        workspaceId: 'ws-headless-launch',
        agentId: launched.agentId,
        visible: true,
      })
      assert.equal(reattach.ok, true, JSON.stringify(reattach))
      assert.equal(mockPty.spawnCalls.length, 1, 'the projected tab attaches; it never launches a second agent')
      const replay = mockSender.sent.find((event) => event.channel === `terminal:replay:${launched.sessionId}`)
      assert.ok(replay, 'the later window replays the headless launch scrollback')
      assert.ok(
        String(replay?.payload ?? '').includes('launched output before any window'),
        'replay carries output produced while headless',
      )
    } finally {
      // Restore the file-wide empty-registry pin, NOT `null`. Clearing the
      // override entirely re-enables the real probe, which reads this machine's
      // PATH and caches a live verdict for 60s — and the pre-flight assertion
      // later in this file then reads that cached "installed" over its own pinned
      // "absent" and stops testing anything.
      runtimeModule.__setAgentCliPreflightForTest({
        platform: 'darwin',
        shell: '/bin/zsh',
        deps: { listEntries: () => [] },
      })
      await runtime.shutdown()
    }
  }

  // The guarded sweep must HOLD an idle-past-threshold agent whose pty subtree
  // still has live work under it — the canonical case is a `run_in_background`
  // shell idling toward a result (0% CPU, no port; only the shell-snapshot
  // wrapper signature marks it). Killing the CLI would kill that shell and the
  // resumed session would report "No completion record was found for this
  // background shell command". Once the subtree probes clean, the same session
  // reaps normally on the next sweep.
  async function assertGuardedSweepHoldsSessionsWithLiveSubtreeWork(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-guarded-sweep-'))
    mockPty.spawnCalls = []
    mockSender.sent = []

    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })

    const spawnHiddenAgent = async (sessionId: string, agentWorkspaceId: string): Promise<MockPtyProcess> => {
      const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId,
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'codex',
        kind: 'agent',
        shellOnly: false,
        workspaceId: agentWorkspaceId,
        agentId: sessionId,
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      const spawned = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
      assert.ok(spawned, `expected a pty for ${sessionId}`)
      return spawned
    }

    try {
      const busyProcess = await spawnHiddenAgent('session-bg-shell', 'ws-guard-busy')
      await spawnHiddenAgent('session-guard-quiet', 'ws-guard-quiet')
      markAgentAtRest(runtime, 'session-bg-shell', 'ws-guard-busy')
      markAgentAtRest(runtime, 'session-guard-quiet', 'ws-guard-quiet')

      const wellPastIdle = Date.now() + 30 * 60 * 1000 + 1_000
      // ps tree: the busy agent's pty root has a Claude tool-shell child (a
      // backgrounded `sleep`-style waiter: 0% CPU, no listening port).
      const busyPsTree = [
        `${busyProcess.pid} 1 0.0 /bin/zsh -l startup.sh`,
        `${busyProcess.pid + 100_000} ${busyProcess.pid} 0.0 /bin/zsh -c source /Users/dev/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'sleep 300'`,
      ].join('\n')

      const heldSweep = await runtimeModule.runGuardedTerminalReapSweeps(wellPastIdle, {
        subtree: { platform: 'darwin', runPs: async () => busyPsTree, runLsofListening: async () => '' },
      })
      assert.ok(
        !heldSweep.idleReaped.includes('session-bg-shell'),
        'an idle agent with a live background tool shell must be held, not reaped',
      )
      assert.ok(
        heldSweep.idleReaped.includes('session-guard-quiet'),
        'an idle agent whose subtree probes clean must still reap in the same sweep',
      )
      assert.equal(busyProcess.killed, false, 'holding must not touch the pty')

      // The background shell finished: the subtree probes clean and the same
      // session now reaps normally.
      const cleanSweep = await runtimeModule.runGuardedTerminalReapSweeps(wellPastIdle + 1_000, {
        subtree: {
          platform: 'darwin',
          runPs: async () => `${busyProcess.pid} 1 0.0 /bin/zsh -l startup.sh`,
          runLsofListening: async () => '',
        },
      })
      assert.ok(
        cleanSweep.idleReaped.includes('session-bg-shell'),
        'once the background work finishes the held session must reap on the next sweep',
      )
    } finally {
      runtime.ipcHandlers.killTerminal('session-bg-shell')
      runtime.ipcHandlers.killTerminal('session-guard-quiet')
    }
  }

  // The in-session memory reaper must SUSPEND idle agents (freeze-the-view), not
  // dispose them: a disposed session loses its painted scrollback and falls
  // through to the renderer's resume-spawn on reopen, silently relaunching the
  // agent. Suspending keeps the session with `suspended = true` so reopening
  // replays the frozen history and only resumes on the first keystroke. An agent
  // whose authoritative hook phase is non-idle (here: awaiting_input) is never
  // reaped regardless of how long it has been idle by keystroke.
  async function assertIdleSweepSuspendsRatherThanDisposes(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-idle-suspend-'))
    mockPty.spawnCalls = []
    mockSender.sent = []

    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })

    const spawnHiddenAgent = async (sessionId: string, agentWorkspaceId: string): Promise<MockPtyProcess> => {
      const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId,
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'codex',
        kind: 'agent',
        shellOnly: false,
        workspaceId: agentWorkspaceId,
        agentId: sessionId,
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      const spawned = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
      assert.ok(spawned, `expected a pty for ${sessionId}`)
      return spawned
    }

    try {
      // Two agents authoritatively at rest (Stop frames) and one that is
      // authoritatively awaiting user input (its hook frame protects it).
      const oldProcess = await spawnHiddenAgent('session-old', 'ws-old')
      await spawnHiddenAgent('session-idle-b', 'ws-b')
      await spawnHiddenAgent('session-awaiting', 'ws-awaiting')
      markAgentAtRest(runtime, 'session-old', 'ws-old')
      markAgentAtRest(runtime, 'session-idle-b', 'ws-b')

      // Mark the protected agent as awaiting_input via an authoritative hook frame.
      runtime.ingestAgentStateFrame({
        type: 'agent_state',
        agentId: 'session-awaiting',
        workspaceId: 'ws-awaiting',
        sessionId: null,
        phase: 'awaiting_input',
        event: null,
        ts: Date.now(),
      })

      // Fresh sweep leaves everything alive (nothing past the idle threshold yet).
      assert.deepEqual(
        runtimeModule.runIdleAgentReapSweep(Date.now()),
        [],
        'recently active agents must not be suspended',
      )

      // Past the idle threshold: both hookless idle agents reap; the awaiting_input
      // agent is protected by its hook phase, not by any hot-set membership.
      const wellPastIdle = Date.now() + 30 * 60 * 1000 + 1_000
      const reaped = runtimeModule.runIdleAgentReapSweep(wellPastIdle).sort()
      assert.deepEqual(
        reaped,
        ['session-idle-b', 'session-old'],
        'every idle agent past the threshold reaps; the awaiting_input agent does not',
      )

      // Suspend finalizes when the killed pty reports exit.
      oldProcess.emitExit({ exitCode: 0 })
      await delay(20)

      assert.equal(oldProcess.killed, true, 'suspending must kill the underlying pty to reclaim RAM')

      const oldStatus = await runtime.ipcHandlers.getTerminalStatus('session-old')
      assert.deepEqual(
        oldStatus,
        { processAlive: false, suspended: true },
        'reaped agent must be suspended (frozen + resumable), not gone',
      )

      const stillListed = runtime.ipcHandlers.listTerminals().map((session) => session.sessionId)
      assert.ok(
        stillListed.includes('session-old'),
        'suspended session must be retained so its painted scrollback can replay on reopen',
      )

      assert.equal(
        mockSender.sent.some((event) => event.channel === 'terminal:exit:session-old'),
        false,
        'a suspend is not an exit: the view must stay painted, so no terminal:exit is emitted',
      )

      // The awaiting-input agent stays live: a terminal blocked on the user must
      // never be frozen out from under them.
      assert.deepEqual(
        await runtime.ipcHandlers.getTerminalStatus('session-awaiting'),
        { processAlive: true, suspended: false },
        'an agent awaiting user input must never be suspended by the reaper',
      )
    } finally {
      await runtime.shutdown()
    }
  }

  // Suspend mid-turn must leave the session AT REST, not frozen mid-claim.
  //
  // `starting`/`thinking`/`tool_use`, and the `working` activity bridged from
  // them, describe a running process — and suspend just killed it. Nothing
  // revisits them afterwards (the stall watch is disarmed, resume spawns fresh),
  // so a phase frozen verbatim outlives its pty and the sidebar draws the chat as
  // a turn in flight until the app restarts. The reaper only suspends an at-rest
  // agent, but the pause control has no such gate, which is how a chat gets stuck
  // bright (observed 2026-09-10: an agent paused a second after launch sat at
  // `starting`/`working` for 70 minutes).
  async function assertSuspendSettlesAWorkingAgentToRest(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-suspend-rest-'))
    mockPty.spawnCalls = []
    mockSender.sent = []

    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })

    try {
      const sessionId = 'session-suspend-mid-turn'
      const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId,
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'codex',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-suspend-rest',
        agentId: sessionId,
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      const spawned = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
      assert.ok(spawned, 'expected a pty')

      // An authoritative hook frame puts the agent mid-turn.
      runtime.ingestAgentStateFrame({
        type: 'agent_state',
        agentId: sessionId,
        workspaceId: 'ws-suspend-rest',
        sessionId: null,
        phase: 'thinking',
        event: null,
        ts: Date.now(),
      })
      const midTurn = runtime.ipcHandlers.listTerminals().find((s) => s.sessionId === sessionId)
      assert.equal(midTurn?.activity.kind, 'working', 'precondition: the agent reads as working')
      assert.equal(midTurn?.agentState?.phase, 'thinking')

      // Pause it mid-turn, the way the agent pane's suspend control does.
      runtime.ipcHandlers.suspendTerminal(sessionId)
      spawned.emitExit({ exitCode: 0 })
      await delay(20)

      const frozen = runtime.ipcHandlers.listTerminals().find((s) => s.sessionId === sessionId)
      assert.equal(frozen?.suspended, true, 'the session is still there, frozen and resumable')
      assert.equal(frozen?.processAlive, false)
      assert.equal(frozen?.activity.kind, 'idle', 'a paused chat must not keep claiming a turn in flight')
      assert.equal(
        frozen?.agentState?.phase,
        'idle',
        'the phase describes a process that no longer exists; it settles with it',
      )
    } finally {
      await runtime.shutdown()
    }
  }

  // Recency floor ("Always keep running"): with the configured keep-alive count
  // set, an idle sweep reaps only down to that many live agent terminals, sparing
  // the most recently used — so a user's active set can never be paused wholesale.
  async function assertIdleSweepRecencyFloorSparesMostRecent(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-recency-floor-'))
    mockPty.spawnCalls = []
    mockSender.sent = []

    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })

    const spawnHiddenAgent = async (sessionId: string, agentWorkspaceId: string): Promise<MockPtyProcess> => {
      const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId,
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'codex',
        kind: 'agent',
        shellOnly: false,
        workspaceId: agentWorkspaceId,
        agentId: sessionId,
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      const spawned = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
      assert.ok(spawned, `expected a pty for ${sessionId}`)
      return spawned
    }

    try {
      runtimeModule.setKeepRecentTerminalsAlive(2)

      const oldProcess = await spawnHiddenAgent('floor-old', 'ws-floor-old')
      await spawnHiddenAgent('floor-mid', 'ws-floor-mid')
      await spawnHiddenAgent('floor-new', 'ws-floor-new')
      // Stagger real keystrokes so the recency order is unambiguous (spawn
      // timestamps can share a millisecond): mid, then new, most recent last.
      await delay(5)
      runtime.ipcHandlers.writeTerminal('floor-mid', 'x')
      await delay(5)
      runtime.ipcHandlers.writeTerminal('floor-new', 'x')

      // At rest the hook way: every selectable CLI reports lifecycle frames now
      // (the spawn stamp `starting` is a protected working phase), so the sweep
      // only sees rest as an authoritative idle. Stagger to keep the resting
      // order unambiguous: oldest first.
      for (const id of ['floor-old', 'floor-mid', 'floor-new']) {
        runtime.ingestAgentStateFrame({
          type: 'agent_state',
          agentId: id,
          workspaceId: `ws-${id}`,
          sessionId: null,
          event: 'Stop',
          ts: Date.now(),
        })
        await delay(5)
      }

      // All three are idle past the threshold, but the floor of 2 spares the two
      // most recently used — only the oldest is suspended.
      const wellPastIdle = Date.now() + 30 * 60 * 1000 + 1_000
      assert.deepEqual(
        runtimeModule.runIdleAgentReapSweep(wellPastIdle),
        ['floor-old'],
        'the sweep must reap only down to the keep-alive floor, oldest-rested first',
      )

      // Finalize the suspend (the killed pty reports exit) so the suspended
      // session drops out of the live-agent population.
      oldProcess.emitExit({ exitCode: 0 })
      await delay(20)

      // A later sweep still holds: the survivors ARE the floor.
      assert.deepEqual(
        runtimeModule.runIdleAgentReapSweep(wellPastIdle + 60_000),
        [],
        'the spared agents form the floor and must stay alive on subsequent sweeps',
      )
    } finally {
      runtimeModule.setKeepRecentTerminalsAlive(0)
      await runtime.shutdown()
    }
  }

  // Per-terminal user lock + idempotent suspended reveal:
  // 1. A locked (reapExempt) agent survives the idle sweep and the 24h stale
  //    backstop; unlocking makes it reapable again.
  // 2. Revealing a suspended session into a fresh pane resends the painted
  //    replay even when main already has visible=true (a renderer
  //    reload/remount can miss the unmount hide; edge-triggered reveal left the
  //    fresh xterm blank under "Paused"). A repeat reveal of the pane that
  //    already holds it sends nothing: the frozen screen can be megabytes.
  async function assertUserLockHoldsReaperAndSuspendedRevealIsIdempotent(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-lock-'))
    mockPty.spawnCalls = []
    mockSender.sent = []

    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })

    try {
      for (const sessionId of ['session-lock-a', 'session-lock-b']) {
        const spawned = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
          sessionId,
          cols: 120,
          rows: 30,
          cwd: workspaceRoot,
          cli: 'codex',
          kind: 'agent',
          shellOnly: false,
          workspaceId: `ws-${sessionId}`,
          agentId: sessionId,
          visible: false,
          mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
        })
        assert.equal(spawned.ok, true, JSON.stringify(spawned))
      }
      mockPty.spawnCalls[0]?.process.emitData('painted output a\r\n')
      mockPty.spawnCalls[1]?.process.emitData('painted output b\r\n')
      await delay(20)
      markAgentAtRest(runtime, 'session-lock-a', 'ws-session-lock-a')
      markAgentAtRest(runtime, 'session-lock-b', 'ws-session-lock-b')

      runtime.ipcHandlers.setTerminalReapExempt('session-lock-a', true)
      assert.equal(
        runtime.ipcHandlers.listTerminals().find((s) => s.sessionId === 'session-lock-a')?.reapExempt,
        true,
        'the lock must surface on the session snapshot for the renderer control',
      )

      // Idle sweep well past the threshold: only the unlocked agent is suspended.
      const wellPastIdle = Date.now() + 30 * 60 * 1000 + 1_000
      assert.deepEqual(
        runtimeModule.runIdleAgentReapSweep(wellPastIdle),
        ['session-lock-b'],
        'the locked agent must survive the idle sweep',
      )
      mockPty.spawnCalls[1]?.process.emitExit({ exitCode: 0 })
      await delay(20)
      assert.deepEqual(await runtime.ipcHandlers.getTerminalStatus('session-lock-b'), {
        processAlive: false,
        suspended: true,
      })

      // The first setVisible(true) is the hidden→visible edge and paints the
      // pane. A second one from the same pane finds it already holding the
      // screen and sends nothing. A fresh pane (a remount that missed the edge)
      // says so, and must STILL be sent the replay — a suspended pty is dead,
      // so that resend is the only thing that can paint it.
      mockSender.sent = []
      const sender = mockSender as unknown as WebContents
      runtime.ipcHandlers.setTerminalVisible('session-lock-b', true, sender)
      runtime.ipcHandlers.setTerminalVisible('session-lock-b', true, sender)
      const replaysOf = () => mockSender.sent.filter((event) => event.channel === 'terminal:replay:session-lock-b')
      assert.equal(replaysOf().length, 1, 'a repeat reveal of a pane that holds the screen sends nothing')
      runtime.ipcHandlers.setTerminalVisible('session-lock-b', true, sender, { freshPane: true })
      const replays = replaysOf()
      assert.equal(replays.length, 2, 'a fresh pane must be sent the replay even when already visible')
      assert.ok(
        replays.every((event) => typeof event.payload === 'string' && event.payload.length > 0),
        'suspended reveal replays must carry painted content',
      )

      // 24h stale backstop: the locked agent is hidden and unseen well past the
      // stale window, but the lock is absolute — dispose is forbidden too.
      const wellPastStale = Date.now() + 25 * 60 * 60 * 1000
      const staleReaped = runtimeModule.reapStaleTerminals(wellPastStale)
      assert.equal(staleReaped.includes('session-lock-a'), false, 'the locked agent must survive the stale backstop')
      assert.ok(
        runtime.ipcHandlers.listTerminals().some((s) => s.sessionId === 'session-lock-a'),
        'the locked agent must still be listed after the stale sweep',
      )

      // Unlock → the very next idle sweep reclaims it.
      runtime.ipcHandlers.setTerminalReapExempt('session-lock-a', false)
      assert.deepEqual(
        runtimeModule.runIdleAgentReapSweep(wellPastIdle),
        ['session-lock-a'],
        'unlocking must make the agent reapable again',
      )
    } finally {
      await runtime.shutdown()
    }
  }

  // T1 decoupled the core runtime from any one feature: the runtime fires its
  // agent-session-exit listener for ANY system (filtering is the caller's job)
  // and reports live executions as system-tagged entries. This locks in that
  // generic behavior — the runtime must not special-case a system, and the exit
  // payload must carry system + workspace identity for every agent session.
  async function assertAgentSessionExitListenerFiresSystemTaggedForAnySystem(
    runtimeModule: RuntimeModule,
  ): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-agent-exit-'))
    mockPty.spawnCalls = []
    mockSender.sent = []

    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })

    const events: AgentSessionExitEvent[] = []
    const unregister = runtime.registerAgentSessionExitListener((event) => {
      events.push(event)
    })

    const spawnAgent = async (
      overrides: Pick<AgentSessionMetadata, 'executionId' | 'system'> & { workspaceId: string },
    ): Promise<MockPtyProcess> => {
      const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: overrides.executionId,
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        workspaceId: overrides.workspaceId,
        agentId: overrides.executionId,
        agentSession: {
          executionId: overrides.executionId,
          system: overrides.system,
          workspaceId: overrides.workspaceId,
          workspaceRoot,
          displayName: `Agent ${overrides.executionId}`,
        },
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      const spawned = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
      assert.ok(spawned, `expected a pty for ${overrides.executionId}`)
      return spawned
    }

    try {
      // A manual session and a module-owned session prove the runtime is
      // system-agnostic: both must surface in the inventory and both must fire
      // the exit listener. The runtime knows nothing about either system.
      const manualPty = await spawnAgent({
        executionId: 'exec-manual',
        system: 'manual',
        workspaceId: 'ws-manual',
      })
      const modulePty = await spawnAgent({
        executionId: 'exec-module',
        system: 'weather-deck',
        workspaceId: 'ws-module',
      })

      const liveById = new Map(
        runtime.getLiveAgentExecutionIds().map((execution) => [execution.executionId, execution.system]),
      )
      assert.deepEqual(
        liveById,
        new Map([
          ['exec-manual', 'manual'],
          ['exec-module', 'weather-deck'],
        ]),
        'getLiveAgentExecutionIds must return system-tagged entries for every live agent session, not a single-system id list',
      )

      manualPty.emitExit({ exitCode: 7 })
      modulePty.emitExit({ exitCode: 0 })
      await delay(20)

      const byExecution = new Map(events.map((event) => [event.executionId, event]))
      assert.deepEqual(
        byExecution.get('exec-manual'),
        {
          system: 'manual',
          workspaceRoot,
          workspaceId: 'ws-manual',
          // The spawn keys the terminal's agentId to the executionId; the pair is
          // what an automation correlates on once the execution is gone.
          agentId: 'exec-manual',
          executionId: 'exec-manual',
          exitCode: 7,
        },
        'a manual session exit must fire the generic listener with the full system-tagged payload',
      )
      assert.deepEqual(
        byExecution.get('exec-module'),
        {
          system: 'weather-deck',
          workspaceRoot,
          workspaceId: 'ws-module',
          agentId: 'exec-module',
          executionId: 'exec-module',
          exitCode: 0,
        },
        'a second system must also fire the listener: filtering is the caller’s job, not the runtime’s',
      )

      // Unregister stops delivery — the registration seam is a real subscription.
      unregister()
      const afterUnregister = await spawnAgent({
        executionId: 'exec-after-unregister',
        system: 'manual',
        workspaceId: 'ws-manual',
      })
      afterUnregister.emitExit({ exitCode: 1 })
      await delay(20)
      assert.equal(
        events.some((event) => event.executionId === 'exec-after-unregister'),
        false,
        'an unregistered listener must not receive further exit events',
      )
    } finally {
      unregister()
      await runtime.shutdown()
    }
  }

  async function assertResolveAgentExecutionIdMatchesLiveSession(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-resolve-exec-'))
    mockPty.spawnCalls = []
    mockSender.sent = []

    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })

    const spawnAgent = async (
      overrides: Pick<AgentSessionMetadata, 'executionId' | 'system'> & { workspaceId: string },
    ): Promise<MockPtyProcess> => {
      const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: overrides.executionId,
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        workspaceId: overrides.workspaceId,
        agentId: overrides.executionId,
        agentSession: {
          executionId: overrides.executionId,
          system: overrides.system,
          workspaceId: overrides.workspaceId,
          workspaceRoot,
          displayName: `Agent ${overrides.executionId}`,
        },
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      const spawned = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
      assert.ok(spawned, `expected a pty for ${overrides.executionId}`)
      return spawned
    }

    try {
      // The spawn keys the session's agentId to its executionId, so
      // resolveAgentExecutionId is exercised by matching (workspaceId, agentId).
      const agentPty = await spawnAgent({
        executionId: 'exec-resolve-1',
        system: 'manual',
        workspaceId: 'ws-resolve',
      })

      assert.equal(
        runtime.resolveAgentExecutionId({ workspaceId: 'ws-resolve', agentId: 'exec-resolve-1' }),
        'exec-resolve-1',
        'a live session must resolve its executionId by (workspaceId, agentId)',
      )
      // Wrong workspaceId or agentId yields no match.
      assert.equal(runtime.resolveAgentExecutionId({ workspaceId: 'ws-other', agentId: 'exec-resolve-1' }), undefined)
      assert.equal(runtime.resolveAgentExecutionId({ workspaceId: 'ws-resolve', agentId: 'no-such-agent' }), undefined)

      // After the pty exits, the session is no longer live and must not resolve.
      agentPty.emitExit({ exitCode: 0 })
      await delay(20)
      assert.equal(
        runtime.resolveAgentExecutionId({ workspaceId: 'ws-resolve', agentId: 'exec-resolve-1' }),
        undefined,
        'a dead session must not resolve an executionId',
      )
    } finally {
      await runtime.shutdown()
    }
  }

  async function assertStaleSweepReapsOnlyUnseenHiddenTerminals(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-stale-'))
    mockPty.spawnCalls = []
    mockSender.sent = []

    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })

    try {
      const hiddenSpawn = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'session_stale_hidden',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        kind: 'terminal',
        shellOnly: true,
        visible: false,
      })
      assert.equal(hiddenSpawn.ok, true, JSON.stringify(hiddenSpawn))

      const visibleSpawn = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'session_stale_visible',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        kind: 'terminal',
        shellOnly: true,
        visible: true,
      })
      assert.equal(visibleSpawn.ok, true, JSON.stringify(visibleSpawn))

      const beforeSweep = runtime.ipcHandlers
        .listTerminals()
        .map((session) => session.sessionId)
        .sort()
      assert.deepEqual(beforeSweep, ['session_stale_hidden', 'session_stale_visible'])

      const freshSweep = runtimeModule.reapStaleTerminals(Date.now())
      assert.deepEqual(freshSweep, [], 'recently spawned terminals must survive the sweep')

      const wellPastStale = Date.now() + 25 * 60 * 60 * 1000
      const reaped = runtimeModule.reapStaleTerminals(wellPastStale)
      assert.deepEqual(reaped, ['session_stale_hidden'], 'only the unseen hidden terminal is reaped')

      const afterSweep = runtime.ipcHandlers.listTerminals().map((session) => session.sessionId)
      assert.deepEqual(afterSweep, ['session_stale_visible'])
      const hiddenProcess = mockPty.spawnCalls.find((call) => call.process)?.process
      assert.equal(hiddenProcess?.killed, true, 'reaping must kill the underlying pty')
      assert.equal(
        mockSender.sent.some((event) => event.channel === 'terminal:exit:session_stale_hidden'),
        false,
        'reaped terminals must not emit terminal:exit so renderer launch flags survive for resume',
      )
    } finally {
      await runtime.shutdown()
    }
  }

  // Durable freeze-the-view: a suspended agent's painted screen must survive an
  // app restart. Suspend writes a snapshot sidecar; quit (runtime shutdown) dumps
  // each live agent's raw retained stream; a fresh runtime — the terminals map is
  // empty after shutdown, exactly like a relaunch — rehydrates a suspended
  // placeholder from the sidecar (status reports suspended, reveal replays the
  // painted screen), and resume/dispose consume the sidecar so nothing stale
  // lingers.
  async function assertSuspendSnapshotSidecarsSurviveRestart(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-sidecar-ws-'))
    const userDataDir = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-sidecar-data-'))
    const sidecarStore = createTerminalSnapshotSidecarStore({
      resolveUserDataDir: () => userDataDir,
    })
    mockPty.spawnCalls = []
    mockSender.sent = []

    const waitFor = async (
      label: string,
      predicate: () => boolean | Promise<boolean>,
      timeoutMs = 5_000,
    ): Promise<void> => {
      const start = Date.now()
      while (!(await predicate())) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
        await delay(20)
      }
    }

    const agentPromptStore = createAgentPromptStore({ resolveUserDataDir: () => userDataDir })
    const runtimeOptions = {
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
      snapshotSidecars: sidecarStore,
      agentPrompts: agentPromptStore,
    }

    const spawnAgent = async (
      runtime: TerminalRuntime,
      sessionId: string,
      agentWorkspaceId: string,
    ): Promise<MockPtyProcess> => {
      const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId,
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'codex',
        kind: 'agent',
        shellOnly: false,
        workspaceId: agentWorkspaceId,
        agentId: sessionId,
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      const spawned = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
      assert.ok(spawned, `expected a pty for ${sessionId}`)
      return spawned
    }

    // ── "Run 1": suspend one agent, leave the other live, then quit. ──
    // When the frozen chat was prompted. Named out here because run 2 asserts the
    // same stamp came back off the disk; stamped at ingest, since a frame older
    // than the session's own start is rejected as stale.
    let promptAt = 0
    const runtime = runtimeModule.createTerminalRuntime(runtimeOptions)
    try {
      const frozenProcess = await spawnAgent(runtime, 'session-frozen', 'ws-frozen')
      frozenProcess.emitData('frozen painted output\r\n')
      // Codex's `UserPromptSubmit` hook, which is the only account of this chat's
      // messages the app will ever have: nothing here writes a Claude-shaped
      // transcript, and Codex's own rollout file is a format this app cannot read.
      promptAt = Date.now()
      runtime.ingestAgentStateFrame({
        type: 'agent_state',
        agentId: 'session-frozen',
        workspaceId: 'ws-frozen',
        // Codex mints its own session id and reports it on every hook frame.
        sessionId: '01a09735-0f86-7441-99fa-1af8310d6733',
        event: 'UserPromptSubmit',
        ts: promptAt,
        cwd: workspaceRoot,
        prompt: 'Port voice dictation to Studio',
      })
      const liveProcess = await spawnAgent(runtime, 'session-live', 'ws-live')
      liveProcess.emitData('live painted output\r\n')
      await delay(20)

      runtime.ipcHandlers.suspendTerminal('session-frozen')
      frozenProcess.emitExit({ exitCode: 0 })
      // The suspend-time sidecar lands once the async headless render settles.
      await waitFor('suspend-time sidecar write', async () => (await sidecarStore.read('session-frozen')) !== null)
      const frozenSidecar = await sidecarStore.read('session-frozen')
      assert.ok(
        frozenSidecar?.snapshot?.includes('frozen painted output'),
        'suspend must persist a serialized snapshot carrying the painted content',
      )
    } finally {
      await runtime.shutdown()
    }

    // Quit dumped the still-live agent's raw retained stream.
    const liveSidecar = await sidecarStore.read('session-live')
    assert.ok(
      liveSidecar?.rawReplay?.includes('live painted output'),
      "runtime shutdown must dump each live agent terminal's retained stream to its sidecar",
    )

    // ── "Run 2": a fresh runtime (empty terminals map = post-relaunch state). ──
    const runtime2 = runtimeModule.createTerminalRuntime(runtimeOptions)
    try {
      // The conversation peek answers for a PARKED chat, before anything has
      // rehydrated it — `terminals` is empty here, exactly as after a relaunch,
      // and this is the case the card is most wanted for. The CLI comes from the
      // sidecar and the prompts from the agent's prompt store.
      const parked = await runtime2.readConversationPeekSessionState('session-frozen')
      assert.deepEqual(
        parked,
        {
          // codex's manifest declares UserPromptSubmit, so the card must not say
          // this runtime cannot report its messages.
          reportsMessages: true,
          prompts: [{ text: 'Port voice dictation to Studio', at: promptAt }],
        },
        'a parked session must still answer after a restart',
      )
      assert.equal(
        await runtime2.readConversationPeekSessionState('session-never-existed'),
        null,
        'a session with no live record, no sidecar and no stored prompts answers null',
      )

      assert.deepEqual(
        await runtime2.ipcHandlers.getTerminalStatus('session-frozen', mockSender as unknown as WebContents),
        { processAlive: false, suspended: true },
        'a persisted suspend must rehydrate as suspended so the renderer pauses instead of launching',
      )
      mockSender.sent = []
      runtime2.ipcHandlers.setTerminalVisible('session-frozen', true, mockSender as unknown as WebContents)
      const frozenReplay = mockSender.sent.find((event) => event.channel === 'terminal:replay:session-frozen')
      assert.ok(
        typeof frozenReplay?.payload === 'string' && frozenReplay.payload.includes('frozen painted output'),
        'revealing the rehydrated terminal must replay the painted screen',
      )

      // Quit-path sidecars carry raw bytes; rehydration renders them to a
      // faithful snapshot before the placeholder is revealed.
      assert.deepEqual(
        await runtime2.ipcHandlers.getTerminalStatus('session-live', mockSender as unknown as WebContents),
        { processAlive: false, suspended: true },
        'a quit-dumped live agent must also rehydrate as suspended',
      )
      mockSender.sent = []
      runtime2.ipcHandlers.setTerminalVisible('session-live', true, mockSender as unknown as WebContents)
      const liveReplay = mockSender.sent.find((event) => event.channel === 'terminal:replay:session-live')
      assert.ok(
        typeof liveReplay?.payload === 'string' && liveReplay.payload.includes('live painted output'),
        'revealing a quit-dumped terminal must replay its painted screen',
      )

      // Resume consumes the sidecar (dispose-then-respawn under the same id).
      mockPty.spawnCalls = []
      const resumed = await runtime2.ipcHandlers.resumeTerminal(mockSender as unknown as WebContents, {
        sessionId: 'session-frozen',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'codex',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-frozen',
        agentId: 'session-frozen',
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(resumed.ok, true, JSON.stringify(resumed))
      assert.equal(mockPty.spawnCalls.length, 1, 'resume must re-spawn a fresh pty under the same session id')
      assert.equal(
        await sidecarStore.read('session-frozen'),
        null,
        'resume disposes the placeholder, which deletes the consumed sidecar',
      )

      // Dispose is terminal: killing the rehydrated placeholder deletes its sidecar.
      runtime2.ipcHandlers.killTerminal('session-live')
      assert.equal(
        await sidecarStore.read('session-live'),
        null,
        'disposing a rehydrated placeholder must delete its sidecar (gone means gone)',
      )
    } finally {
      await runtime2.shutdown()
    }

    // The sidecar goes at 30 days while the agent stays in the sidebar. Its
    // prompts do not go with it: the agent's store still names the session.
    await rm(join(userDataDir, 'terminal-snapshots', 'session-frozen.json'), { force: true })
    const sweptStore = createTerminalSnapshotSidecarStore({ resolveUserDataDir: () => userDataDir })
    assert.equal(await sweptStore.read('session-frozen'), null, 'the sidecar is gone')
    const runtime3 = runtimeModule.createTerminalRuntime({ ...runtimeOptions, snapshotSidecars: sweptStore })
    try {
      assert.deepEqual(
        await runtime3.readConversationPeekSessionState('session-frozen'),
        { reportsMessages: true, prompts: [{ text: 'Port voice dictation to Studio', at: promptAt }] },
        'the stored prompts outlive the sidecar',
      )
    } finally {
      await runtime3.shutdown()
    }
  }

  // The owner's rule for a paused agent: its last painted screen and scrollback
  // come back instantly when its workspace is opened — in this run and after a
  // restart — without the CLI being started. What goes is the raw pty stream
  // behind that screen (up to 2.5 MB per agent), once the screen has been
  // rendered from it.
  async function assertSuspendReleasesRawStreamButKeepsFrozenScreen(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-release-ws-'))
    const userDataDir = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-release-data-'))
    const sidecarStore = createTerminalSnapshotSidecarStore({ resolveUserDataDir: () => userDataDir })
    const runtimeOptions = {
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
      snapshotSidecars: sidecarStore,
    }
    mockPty.spawnCalls = []
    mockSender.sent = []
    const sender = mockSender as unknown as WebContents
    const listed = (runtime: TerminalRuntime) =>
      runtime.ipcHandlers.listTerminals().find((session) => session.sessionId === 'session-release')

    const runtime = runtimeModule.createTerminalRuntime(runtimeOptions)
    try {
      const result = await runtime.ipcHandlers.spawnTerminal(sender, {
        sessionId: 'session-release',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'codex',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-release',
        agentId: 'session-release',
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      const pty = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
      assert.ok(pty)
      for (let line = 0; line < 2_000; line += 1)
        pty.emitData(`\x1b[38;2;120;120;200mscrollback line ${line} ─╮\x1b[0m\r\n`)
      pty.emitData('the last thing the agent painted\r\n')
      await delay(20)
      assert.ok((listed(runtime)?.retainedOutputBytes ?? 0) > 100_000, 'a live agent retains its stream')

      runtime.ipcHandlers.suspendTerminal('session-release')
      pty.emitExit({ exitCode: 0 })
      const start = Date.now()
      while (!(await sidecarStore.read('session-release'))) {
        if (Date.now() - start > 5_000) throw new Error('timed out waiting for the suspend sidecar')
        await delay(20)
      }

      const paused = listed(runtime)
      assert.equal(paused?.suspended, true)
      assert.equal(paused?.retainedOutputBytes, 0, 'the raw stream is released once the screen is rendered')
      assert.equal(paused?.outputBufferLength, 0)

      // The frozen screen is still there, instantly, and nothing was spawned.
      const spawnsBefore = mockPty.spawnCalls.length
      mockSender.sent = []
      runtime.ipcHandlers.setTerminalVisible('session-release', true, sender)
      const replay = mockSender.sent.find((event) => event.channel === 'terminal:replay:session-release')
      assert.ok(
        typeof replay?.payload === 'string' && replay.payload.includes('the last thing the agent painted'),
        'revealing the paused agent repaints its last screen',
      )
      assert.ok(
        typeof replay?.payload === 'string' && replay.payload.includes('scrollback line 1990'),
        'and the scrollback above it',
      )
      assert.equal(mockPty.spawnCalls.length, spawnsBefore, 'without starting the CLI')
      assert.ok(
        runtime.readTerminalOutput('session-release')?.includes('the last thing the agent painted'),
        'the agent control plane still reads what the paused agent printed',
      )
    } finally {
      await runtime.shutdown()
    }

    // After a restart: the placeholder paints from the sidecar and holds no raw stream.
    const runtime2 = runtimeModule.createTerminalRuntime(runtimeOptions)
    try {
      assert.deepEqual(await runtime2.ipcHandlers.getTerminalStatus('session-release', sender), {
        processAlive: false,
        suspended: true,
      })
      assert.equal(listed(runtime2)?.retainedOutputBytes, 0, 'a restored paused agent holds only its frozen screen')
      mockSender.sent = []
      runtime2.ipcHandlers.setTerminalVisible('session-release', true, sender)
      const replay = mockSender.sent.find((event) => event.channel === 'terminal:replay:session-release')
      assert.ok(
        typeof replay?.payload === 'string' && replay.payload.includes('the last thing the agent painted'),
        'the frozen screen survives the restart',
      )

      // Settled: disposing releases the screen too, and the session is gone.
      runtime2.ipcHandlers.killTerminal('session-release')
      assert.equal(listed(runtime2), undefined)
      assert.equal(runtime2.readTerminalOutput('session-release'), undefined)
    } finally {
      await runtime2.shutdown()
    }
  }

  // A settled agent drops what it holds. An agent whose CLI exits on its own is
  // settled, but its tab reopens on its last screen and the agent control plane
  // reads what it printed synchronously — so the screen is rendered once and the
  // raw stream behind it goes, exactly as on suspend. A plain shell keeps its
  // stream: painted-pause is an agent promise.
  async function assertSelfExitedAgentReleasesRawStreamButKeepsFinalScreen(
    runtimeModule: RuntimeModule,
  ): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-exit-release-'))
    mockPty.spawnCalls = []
    mockSender.sent = []
    const sender = mockSender as unknown as WebContents
    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })
    const listed = (sessionId: string) =>
      runtime.ipcHandlers.listTerminals().find((session) => session.sessionId === sessionId)
    const spawn = async (sessionId: string, kind: 'agent' | 'terminal'): Promise<MockPtyProcess> => {
      const result = await runtime.ipcHandlers.spawnTerminal(sender, {
        sessionId,
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'codex',
        kind,
        shellOnly: kind === 'terminal',
        workspaceId: 'ws-exit-release',
        agentId: sessionId,
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      const spawned = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
      assert.ok(spawned, `expected a pty for ${sessionId}`)
      return spawned
    }

    try {
      const pty = await spawn('session-exit-release', 'agent')
      for (let line = 0; line < 2_000; line += 1)
        pty.emitData(`\x1b[38;2;120;120;200mscrollback line ${line} ─╮\x1b[0m\r\n`)
      await delay(20)
      // A reader that has seen everything up to here, and nothing after.
      const midCursor = runtime.readTerminalOutputSince('session-exit-release', 0)?.cursor ?? 0
      assert.ok(midCursor > 0)
      // Laid out by cursor position for the 120 columns it was spawned at, and
      // never resized: the screen must be rendered at that width, not at 80.
      pty.emitData('\x1b[30;1Hleft edge\x1b[30;100Hfar right\r\n')
      pty.emitData('the final screen of the finished run\r\n')
      await delay(20)
      assert.ok((listed('session-exit-release')?.retainedOutputBytes ?? 0) > 100_000, 'a live agent retains its stream')

      const shell = await spawn('session-exit-shell', 'terminal')
      shell.emitData('$ echo still here\r\n')
      await delay(20)

      pty.emitExit({ exitCode: 0 })
      shell.emitExit({ exitCode: 0 })
      const start = Date.now()
      while ((listed('session-exit-release')?.retainedOutputBytes ?? 0) > 0) {
        if (Date.now() - start > 5_000) throw new Error('timed out waiting for the exited agent to release its stream')
        await delay(20)
      }
      assert.equal(listed('session-exit-release')?.processAlive, false)
      assert.equal(listed('session-exit-release')?.outputBufferLength, 0, 'the raw stream is released')

      // The module-facing reads still answer, synchronously, from the screen.
      assert.ok(
        runtime.readTerminalOutput('session-exit-release')?.includes('the final screen of the finished run'),
        'the agent control plane still reads what the exited agent printed',
      )
      assert.ok(
        runtime
          .readTerminalOutputSince('session-exit-release', 0)
          ?.text.includes('the final screen of the finished run'),
        'a read from the start is served from the rendered screen',
      )
      assert.ok(
        runtime
          .readTerminalOutputSince('session-exit-release', midCursor)
          ?.text.includes('the final screen of the finished run'),
        'a reader that had not reached the end is handed the screen rather than nothing',
      )
      const end = runtime.readTerminalOutputSince('session-exit-release', midCursor)?.cursor ?? 0
      assert.equal(
        runtime.readTerminalOutputSince('session-exit-release', end)?.text,
        '',
        'a reader that had seen the end gets nothing new',
      )

      // Reopening the tab paints the final screen and its scrollback, and spawns nothing.
      const spawnsBefore = mockPty.spawnCalls.length
      mockSender.sent = []
      runtime.ipcHandlers.setTerminalVisible('session-exit-release', true, sender)
      const replay = mockSender.sent.find((event) => event.channel === 'terminal:replay:session-exit-release')
      assert.ok(
        typeof replay?.payload === 'string' && replay.payload.includes('the final screen of the finished run'),
        'revealing the exited agent repaints its final screen',
      )
      assert.ok(
        typeof replay?.payload === 'string' && replay.payload.includes('scrollback line 1990'),
        'and the scrollback above it',
      )
      assert.equal(mockPty.spawnCalls.length, spawnsBefore, 'without starting the CLI')
      assert.ok(
        typeof replay?.payload === 'string' && replay.payload.includes('left edge\x1b[90Cfar right'),
        'rendered at the width the agent drew for, never a default 80 columns',
      )

      assert.ok((listed('session-exit-shell')?.retainedOutputBytes ?? 0) > 0, 'an exited plain shell keeps its stream')
    } finally {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // The sessions broadcast used to be a full snapshot of every session — file
  // ledgers included — cloned into every window on every change to any one of
  // them. It now carries the sessions that changed, their lists only when those
  // moved, and the ids that went away.
  async function assertSessionsBroadcastCarriesOnlyWhatChanged(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-delta-'))
    mockPty.spawnCalls = []
    mockSender.sent = []
    const sender = mockSender as unknown as WebContents
    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })
    type Delta = import('../shared/ipc/terminal').TerminalSessionsDelta
    const deltas = (): Delta[] =>
      mockSender.sent
        .filter((event) => event.channel === 'terminal:sessions-delta')
        .map((event) => event.payload as Delta)
    const spawn = async (sessionId: string): Promise<void> => {
      const result = await runtime.ipcHandlers.spawnTerminal(sender, {
        sessionId,
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-delta',
        agentId: sessionId,
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
    }
    try {
      await spawn('delta-a')
      await spawn('delta-b')
      runtime.flushSessionsBroadcast()
      const first = deltas().flatMap((delta) => delta.upserts)
      assert.ok(
        first.some((entry) => entry.sessionId === 'delta-a' && Array.isArray(entry.fileChanges)),
        'a session is sent whole the first time',
      )

      const base = Date.now() + 10
      mockSender.sent = []
      runtime.ingestAgentStateFrame({
        type: 'agent_state',
        agentId: 'delta-a',
        workspaceId: 'ws-delta',
        sessionId: null,
        event: 'PostToolUse',
        ts: base,
        fileChange: { path: '/Users/dev/app/src/a.ts', additions: 4, deletions: 1 },
      })
      runtime.flushSessionsBroadcast()
      let sent = deltas()
      assert.equal(sent.length, 1)
      assert.deepEqual(
        sent[0]?.upserts.map((entry) => entry.sessionId),
        ['delta-a'],
        'only the session that changed is sent',
      )
      assert.deepEqual(
        sent[0]?.upserts[0]?.fileChanges?.map((change) => change.path),
        ['/Users/dev/app/src/a.ts'],
        'its ledger moved, so the ledger rides along',
      )

      mockSender.sent = []
      runtime.ingestAgentStateFrame({
        type: 'agent_state',
        agentId: 'delta-a',
        workspaceId: 'ws-delta',
        sessionId: null,
        event: 'Stop',
        ts: base + 100,
      })
      runtime.flushSessionsBroadcast()
      sent = deltas()
      assert.deepEqual(
        sent[0]?.upserts.map((entry) => entry.sessionId),
        ['delta-a'],
      )
      assert.equal(sent[0]?.upserts[0]?.activity.kind, 'idle')
      assert.equal('fileChanges' in (sent[0]?.upserts[0] ?? {}), false, 'an unchanged ledger is left out')
      assert.equal('pullRequests' in (sent[0]?.upserts[0] ?? {}), false, 'so are unchanged pull requests')

      mockSender.sent = []
      runtime.ipcHandlers.killTerminal('delta-b')
      runtime.flushSessionsBroadcast()
      sent = deltas()
      assert.deepEqual(sent, [{ upserts: [], removed: ['delta-b'] }], 'a disposed session is named, not re-listed')

      mockSender.sent = []
      runtime.flushSessionsBroadcast()
      assert.deepEqual(deltas(), [], 'nothing changed: nothing is sent')

      // The full list is still whole, for a window that is just subscribing.
      const listedA = runtime.ipcHandlers.listTerminals().find((session) => session.sessionId === 'delta-a')
      assert.equal(listedA?.fileChanges.length, 1)
    } finally {
      await runtime.shutdown()
    }
  }

  // Revealing a hidden live pane sends what it missed, not the whole window.
  async function assertRevealSendsOnlyWhatThePaneMissed(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-reveal-'))
    mockPty.spawnCalls = []
    mockSender.sent = []
    const sender = mockSender as unknown as WebContents
    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })
    const channel = (name: string) => mockSender.sent.filter((event) => event.channel === name)
    try {
      const result = await runtime.ipcHandlers.spawnTerminal(sender, {
        sessionId: 'session-reveal',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        kind: 'terminal',
        shellOnly: true,
        visible: true,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      const pty = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
      assert.ok(pty)
      pty.emitData('seen while visible\r\n')
      await delay(30)
      assert.equal(channel('terminal:data:session-reveal').length, 1)

      runtime.ipcHandlers.setTerminalVisible('session-reveal', false, sender)
      pty.emitData('missed ─ one\r\n')
      pty.emitData('missed two\r\n')
      await delay(30)
      mockSender.sent = []
      runtime.ipcHandlers.setTerminalVisible('session-reveal', true, sender)
      assert.deepEqual(channel('terminal:replay:session-reveal'), [], 'no reset-and-replay of the whole window')
      assert.deepEqual(
        channel('terminal:data:session-reveal').map((event) => event.payload),
        ['missed ─ one\r\nmissed two\r\n'],
        'exactly the bytes the pane missed, once',
      )

      // Caught up: live output continues from there, with nothing repeated.
      mockSender.sent = []
      pty.emitData('after the reveal\r\n')
      await delay(30)
      assert.deepEqual(
        channel('terminal:data:session-reveal').map((event) => event.payload),
        ['after the reveal\r\n'],
      )

      // Hidden through more output than is retained: what it missed is gone
      // from the head, so the pane is repainted from the whole window instead.
      runtime.ipcHandlers.setTerminalVisible('session-reveal', false, sender)
      const block = `${'z'.repeat(1_022)}\r\n`
      for (let index = 0; index < 3_000; index += 1) pty.emitData(block)
      await delay(30)
      mockSender.sent = []
      runtime.ipcHandlers.setTerminalVisible('session-reveal', true, sender)
      assert.equal(channel('terminal:replay:session-reveal').length, 1, 'fell off the head: full repaint')
      assert.equal(channel('terminal:data:session-reveal').length, 0)
    } finally {
      await runtime.shutdown()
    }
  }

  // A pane terminal popped out into a window of its own, and docked back: the
  // window it LEFT still reports it hidden — its panel's unmount does, and so
  // does its hidden-window sweep — and taken at its word that froze the
  // terminal in the window it had moved to. Only the window the session is
  // routed to speaks for its visibility.
  async function assertOnlyTheRoutedWindowSpeaksForVisibility(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-visibility-sender-'))
    mockPty.spawnCalls = []
    mockSender.sent = []
    const workspaceWindow = mockSender as unknown as WebContents
    const popOut = createMockWebContents()
    const popOutWindow = popOut as unknown as WebContents
    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })
    const dataTo = (contents: { sent: SentEvent[] }) =>
      contents.sent.filter((event) => event.channel === 'terminal:data:session-moving').map((event) => event.payload)
    const spawn = (sender: WebContents) =>
      runtime.ipcHandlers.spawnTerminal(sender, {
        sessionId: 'session-moving',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        kind: 'terminal',
        shellOnly: true,
        visible: true,
      })
    try {
      assert.equal((await spawn(workspaceWindow)).ok, true)
      const pty = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
      assert.ok(pty)

      // A window the session is not routed to says "hidden": nothing changes.
      runtime.ipcHandlers.setTerminalVisible('session-moving', false, popOutWindow)
      pty.emitData('still live in the workspace window\r\n')
      await delay(30)
      assert.deepEqual(dataTo(mockSender), ['still live in the workspace window\r\n'])

      // Popped out: the pop-out attaches and the session is routed there. The
      // workspace window's panel unmounts after, and its "hidden" is ignored.
      assert.equal((await spawn(popOutWindow)).ok, true)
      mockSender.sent = []
      popOut.sent = []
      runtime.ipcHandlers.setTerminalVisible('session-moving', false, workspaceWindow)
      pty.emitData('live in the pop-out\r\n')
      await delay(30)
      assert.deepEqual(dataTo(popOut), ['live in the pop-out\r\n'], 'the window it left does not freeze it')
      assert.deepEqual(dataTo(mockSender), [])

      // The routed window still decides for itself.
      runtime.ipcHandlers.setTerminalVisible('session-moving', false, popOutWindow)
      popOut.sent = []
      pty.emitData('missed while hidden\r\n')
      await delay(30)
      assert.deepEqual(dataTo(popOut), [], 'hidden by its own window, it is not fed')
      runtime.ipcHandlers.setTerminalVisible('session-moving', true, popOutWindow)
      assert.deepEqual(dataTo(popOut), ['missed while hidden\r\n'])

      // The pop-out closes while the output is still routed to it (its
      // re-attach landed after the workspace window took the terminal back).
      // The window that does show it takes the route on its next word, and is
      // sent the whole screen: nothing says what its pane holds.
      popOut.isDestroyed = () => true
      mockSender.sent = []
      runtime.ipcHandlers.setTerminalVisible('session-moving', true, workspaceWindow)
      const replays = mockSender.sent.filter((event) => event.channel === 'terminal:replay:session-moving')
      assert.equal(replays.length, 1, 'adopted, the pane is repainted')
      assert.match(String(replays[0]?.payload), /missed while hidden/)
      pty.emitData('back in the workspace window\r\n')
      await delay(30)
      assert.deepEqual(dataTo(mockSender), ['back in the workspace window\r\n'], 'and fed from then on')
    } finally {
      await runtime.shutdown()
    }
  }

  // A finished agent's pane is its history. Once the agent has exited and its
  // screen is rendered, the raw stream is released and the rendered screen is
  // all that is left, so it must carry the scrollback a live pane keeps — not
  // the last thousand rows. And switching away and back to a pane that was
  // watching when the agent finished must not reset and repaint it.
  async function assertSettledAgentKeepsItsHistoryAndIsNotRepaintedOnReveal(
    runtimeModule: RuntimeModule,
  ): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-settled-history-'))
    mockPty.spawnCalls = []
    mockSender.sent = []
    const sender = mockSender as unknown as WebContents
    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })
    const listed = () =>
      runtime.ipcHandlers.listTerminals().find((session) => session.sessionId === 'session-settled-history')
    const channel = (name: string) => mockSender.sent.filter((event) => event.channel === name)
    try {
      const result = await runtime.ipcHandlers.spawnTerminal(sender, {
        sessionId: 'session-settled-history',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'codex',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-settled-history',
        agentId: 'session-settled-history',
        visible: true,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      const pty = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
      assert.ok(pty)
      for (let line = 0; line < 3_000; line += 1) pty.emitData(`history line ${line}\r\n`)
      await delay(40)
      pty.emitExit({ exitCode: 0 })
      const start = Date.now()
      while ((listed()?.retainedOutputBytes ?? 0) > 0) {
        if (Date.now() - start > 5_000) throw new Error('timed out waiting for the exited agent to release its stream')
        await delay(20)
      }

      const read = runtime.readTerminalOutput('session-settled-history') ?? ''
      assert.ok(read.includes('history line 5\r'), 'the history far above the last screen is still readable')
      assert.ok(read.includes('history line 2999'))

      // A workspace switch away and back: the pane already holds all of it.
      runtime.ipcHandlers.setTerminalVisible('session-settled-history', false, sender)
      mockSender.sent = []
      runtime.ipcHandlers.setTerminalVisible('session-settled-history', true, sender)
      assert.deepEqual(channel('terminal:replay:session-settled-history'), [], 'no reset-and-repaint')
      assert.deepEqual(channel('terminal:data:session-settled-history'), [], 'and nothing to catch up')

      // The dying CLI's last bytes, after the release: not part of what is read.
      pty.emitData('a straggler after the screen was rendered\r\n')
      await delay(30)
      const after = runtime.readTerminalOutput('session-settled-history') ?? ''
      assert.ok(after.includes('history line 5\r'), 'late bytes do not replace the rendered history')
      assert.equal(after.includes('a straggler'), false)
      assert.equal(listed()?.retainedOutputBytes, 0, 'and are not kept')

      // A fresh pane (a remount) is painted in full, deep history included.
      mockSender.sent = []
      runtime.ipcHandlers.setTerminalVisible('session-settled-history', true, sender, { freshPane: true })
      const replay = channel('terminal:replay:session-settled-history')[0]?.payload
      assert.ok(typeof replay === 'string' && replay.includes('history line 5\r'), 'a fresh pane gets the history')
    } finally {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // A reveal's catch-up is live data the pane acknowledges like any other, so
  // it is counted in flight like any other: otherwise the pane's acks for it
  // cancel units main did count, and backpressure is off while the pane parses
  // what can be megabytes.
  async function assertRevealCatchUpCountsTowardFlowControl(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-catch-up-flow-'))
    mockPty.spawnCalls = []
    mockSender.sent = []
    const sender = mockSender as unknown as WebContents
    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })
    try {
      const result = await runtime.ipcHandlers.spawnTerminal(sender, {
        sessionId: 'session-catch-up-flow',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        kind: 'terminal',
        shellOnly: true,
        visible: true,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      const pty = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
      assert.ok(pty)
      pty.emitData('x'.repeat(1_000))
      await delay(30)

      runtime.ipcHandlers.setTerminalVisible('session-catch-up-flow', false, sender)
      pty.emitData('y'.repeat(150_000))
      await delay(30)
      mockSender.sent = []
      runtime.ipcHandlers.setTerminalVisible('session-catch-up-flow', true, sender)
      const caughtUp = mockSender.sent.filter((event) => event.channel === 'terminal:data:session-catch-up-flow')
      assert.equal(caughtUp.length, 1, 'the pane is caught up as live data')
      assert.equal(pty.pauses, 0, 'a pane that has not acked since the reveal is not waited on')

      runtime.ipcHandlers.ackTerminalOutput('session-catch-up-flow', 1_000, sender)
      assert.equal(pty.pauses, 1, 'the unparsed catch-up holds the pty back once the pane acks')
      runtime.ipcHandlers.ackTerminalOutput('session-catch-up-flow', 148_000, sender)
      assert.equal(pty.resumes, 1, 'and lets it go once the pane has parsed it')
    } finally {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // Every hook is its own reporter process, so a short subagent's stop can land
  // before its start. The stop closes nothing; the start that follows, stamped
  // earlier, must not open work nothing will close — or the next Stop is held
  // as working until the stall watch gives up on it.
  async function assertSubagentStartOvertakenByItsStopIsNotCounted(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-overtaken-start-'))
    mockPty.spawnCalls = []
    mockSender.sent = []
    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
      syncMcpConfig: async (): Promise<SyncResult> => ({ ok: true }),
    })
    const snapshot = () => runtime.ipcHandlers.listTerminals().find((session) => session.sessionId === 'sess-overtaken')
    try {
      const spawn = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'sess-overtaken',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-overtaken',
        agentId: 'agent-overtaken',
        agentName: 'Overtaken',
      })
      assert.equal(spawn.ok, true, JSON.stringify(spawn))
      const base = Date.now()
      const ingest = async (event: string, ts: number, extra: Partial<AgentStateFrame> = {}): Promise<void> => {
        runtime.ingestAgentStateFrame({
          type: 'agent_state',
          agentId: 'agent-overtaken',
          workspaceId: 'ws-overtaken',
          sessionId: null,
          event,
          ts: base + ts,
          ...extra,
        })
        await delay(5)
      }

      await ingest('SessionStart', 0)
      await ingest('UserPromptSubmit', 100)
      await ingest('PostToolUse', 1_000, { toolUseId: 'toolu_one' })
      await ingest('SubagentStop', 1_600)
      await ingest('SubagentStart', 1_500)
      assert.equal(snapshot()?.activeSubagents, 0, 'the start its stop overtook is already closed')
      await ingest('Stop', 5_000)
      assert.equal(snapshot()?.agentState?.phase, 'idle', 'so the turn end is not held')
      assert.equal(snapshot()?.activity.kind, 'idle')

      // A subagent that starts after that stop is real work, and holds the turn.
      await ingest('UserPromptSubmit', 6_000)
      await ingest('SubagentStart', 6_500)
      assert.equal(snapshot()?.activeSubagents, 1)
      await ingest('Stop', 7_000)
      assert.equal(snapshot()?.agentState?.phase, 'tool_use', 'a turn end with a subagent open is held')
      await ingest('SubagentStop', 8_000)
      assert.equal(snapshot()?.activeSubagents, 0)
    } finally {
      runtime.ipcHandlers.killTerminal('sess-overtaken')
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // Heavy output can no longer queue ahead of keystroke echo, or be dropped at
  // main's pending bound: the pty is paused while the pane has too much it has
  // not yet parsed, and resumed as it catches up.
  async function assertFlowControlPausesThePtyWhileThePaneFallsBehind(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-flow-'))
    mockPty.spawnCalls = []
    mockSender.sent = []
    const sender = mockSender as unknown as WebContents
    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })
    try {
      const result = await runtime.ipcHandlers.spawnTerminal(sender, {
        sessionId: 'session-flow',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        kind: 'terminal',
        shellOnly: true,
        visible: true,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      const pty = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
      assert.ok(pty)

      pty.emitData('x'.repeat(1_000))
      await delay(30)
      // Until the pane acknowledges anything, it is not waited on.
      pty.emitData('y'.repeat(150_000))
      assert.equal(pty.pauses, 0, 'a pane that has never acked does not pause the pty')
      await delay(30)

      runtime.ipcHandlers.ackTerminalOutput('session-flow', 1_000, sender)
      assert.equal(pty.pauses, 1, 'past the high watermark once the pane is known to ack')
      // Another window's ack is about a pane that is not this session's.
      runtime.ipcHandlers.ackTerminalOutput('session-flow', 150_000, {} as WebContents)
      assert.equal(pty.resumes, 0)
      runtime.ipcHandlers.ackTerminalOutput('session-flow', 140_000, sender)
      assert.equal(pty.resumes, 0, 'still above the low watermark')
      runtime.ipcHandlers.ackTerminalOutput('session-flow', 8_000, sender)
      assert.equal(pty.resumes, 1, 'resumed once the pane caught up')

      // Hiding the pane while paused lets the pty run: a hidden pane is sent nothing.
      pty.emitData('z'.repeat(150_000))
      assert.equal(pty.pauses, 2)
      runtime.ipcHandlers.setTerminalVisible('session-flow', false, sender)
      assert.equal(pty.resumes, 2)
    } finally {
      await runtime.shutdown()
    }
  }

  // An agent pty that ends on its own — an automation run finishing, a CLI
  // crashing — was never suspended and never saw app quit, so it used to write NO
  // sidecar. That is the COMMON case for a finished automation agent, and with no
  // painted screen on disk its tab had nothing to show on cold load. Self-exit is
  // the third write site. A deliberate dispose still means gone: dispose deletes
  // the sidecar and then kills the pty, so the exit handler must not resurrect it.
  async function assertSelfExitedAgentWritesSidecarButDisposeDoesNot(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-selfexit-ws-'))
    const userDataDir = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-selfexit-data-'))
    const sidecarStore = createTerminalSnapshotSidecarStore({
      resolveUserDataDir: () => userDataDir,
    })
    mockPty.spawnCalls = []
    mockSender.sent = []

    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
      snapshotSidecars: sidecarStore,
    })

    const spawnAgent = async (sessionId: string, kind: 'agent' | 'terminal'): Promise<MockPtyProcess> => {
      const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId,
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'codex',
        kind,
        shellOnly: kind === 'terminal',
        workspaceId: 'ws-selfexit',
        agentId: sessionId,
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      const spawned = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
      assert.ok(spawned, `expected a pty for ${sessionId}`)
      return spawned
    }

    try {
      // The automation case: the run finished and the CLI exited by itself.
      const finished = await spawnAgent('session-selfexit', 'agent')
      finished.emitData('automation run MM-37 complete\r\n')
      await delay(20)
      finished.emitExit({ exitCode: 0 })
      await delay(20)

      const sidecar = await sidecarStore.read('session-selfexit')
      assert.ok(
        sidecar?.rawReplay?.includes('automation run MM-37 complete'),
        'an agent pty that exits on its own must persist its painted content, so the tab reopens paused instead of relaunching',
      )

      // A deliberate dispose deletes the sidecar and then kills the pty. The exit
      // that follows must NOT write one back — gone means gone.
      const disposed = await spawnAgent('session-disposed', 'agent')
      disposed.emitData('disposed painted output\r\n')
      await delay(20)
      runtime.ipcHandlers.killTerminal('session-disposed')
      disposed.emitExit({ exitCode: 0 })
      await delay(20)
      assert.equal(
        await sidecarStore.read('session-disposed'),
        null,
        'a disposed terminal must not resurrect a sidecar on the exit that dispose itself triggered',
      )

      // Plain shells respawn fresh on reopen; painted-pause is an agent promise.
      const shell = await spawnAgent('session-shell', 'terminal')
      shell.emitData('$ echo hi\r\n')
      await delay(20)
      shell.emitExit({ exitCode: 0 })
      await delay(20)
      assert.equal(await sidecarStore.read('session-shell'), null, 'a plain shell writes no sidecar on exit')
    } finally {
      await runtime.shutdown()
    }
  }

  async function assertTerminalReattachUsesReplayChannel(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-replay-'))
    mockPty.spawnCalls = []
    mockSender.sent = []

    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })

    try {
      const firstSpawn = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'session_replay',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        kind: 'terminal',
        shellOnly: true,
      })
      assert.equal(firstSpawn.ok, true, JSON.stringify(firstSpawn))
      assert.equal(mockPty.spawnCalls.length, 1)

      mockPty.spawnCalls[0]?.process.emitData('retained terminal output\r\n')
      await delay(20)
      assert.equal(
        mockSender.sent.some((event) => event.channel === 'terminal:data:session_replay'),
        true,
        'initial live output should still use terminal:data',
      )

      mockSender.sent = []
      const reattach = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'session_replay',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        resume: true,
        kind: 'terminal',
        shellOnly: true,
      })

      assert.equal(reattach.ok, true, JSON.stringify(reattach))
      assert.deepEqual(
        mockSender.sent.filter((event) => event.channel === 'terminal:replay:session_replay'),
        [{ channel: 'terminal:replay:session_replay', payload: 'retained terminal output\r\n' }],
      )
      assert.equal(
        mockSender.sent.some((event) => event.channel === 'terminal:data:session_replay'),
        false,
        'reattached retained output must not be delivered as live terminal data',
      )
    } finally {
      await runtime.shutdown()
    }
  }

  async function assertHiddenTerminalOutputSkipsLiveIpcAndReplaysOnAttach(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-hidden-replay-'))
    mockPty.spawnCalls = []
    mockSender.sent = []

    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })

    try {
      const hiddenSpawn = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'session_hidden_replay',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        kind: 'terminal',
        shellOnly: true,
        visible: false,
      })
      assert.equal(hiddenSpawn.ok, true, JSON.stringify(hiddenSpawn))
      assert.equal(mockPty.spawnCalls.length, 1)

      mockPty.spawnCalls[0]?.process.emitData('hidden terminal output\r\n')
      await delay(20)
      assert.equal(
        mockSender.sent.some((event) => event.channel === 'terminal:data:session_hidden_replay'),
        false,
        'hidden terminal output must not fan out over live terminal:data IPC',
      )

      mockSender.sent = []
      const reattach = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'session_hidden_replay',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        resume: true,
        kind: 'terminal',
        shellOnly: true,
        visible: true,
      })

      assert.equal(reattach.ok, true, JSON.stringify(reattach))
      assert.deepEqual(
        mockSender.sent.filter((event) => event.channel === 'terminal:replay:session_hidden_replay'),
        [{ channel: 'terminal:replay:session_hidden_replay', payload: 'hidden terminal output\r\n' }],
      )
    } finally {
      await runtime.shutdown()
    }
  }

  // Phase 2 of the Backlog item ↔ agent link: a launched agent terminal carries
  // its durable identity (workspaceId + agentId) and name as SPRINTENGINE_* env vars
  // so a typed handoff can record the same link the drag-drop path writes. Only
  // the values actually present are emitted.
  async function assertAgentSpawnExposesAgentIdentityEnv(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-identity-'))
    mockPty.spawnCalls = []
    mockSender.sent = []

    // Simulate the app's own process inheriting a stale identity (e.g. launched
    // from inside an agent shell): it must never leak into spawned terminals.
    const priorAgentId = process.env.SPRINTENGINE_AGENT_ID
    process.env.SPRINTENGINE_AGENT_ID = 'stale-leak-from-app-process'

    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
      syncMcpConfig: async (): Promise<SyncResult> => ({ ok: true }),
    })

    try {
      const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'session_identity_env',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-42',
        agentId: 'agent-7',
        agentName: 'Fred Walsh',
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(mockPty.spawnCalls.length, 1)
      const env = (mockPty.spawnCalls[0]?.options.env ?? {}) as Record<string, string>
      assert.equal(env.SPRINTENGINE_WORKSPACE_ID, 'ws-42')
      assert.equal(env.SPRINTENGINE_AGENT_ID, 'agent-7', 'agent identity overrides any stale inherited id')
      assert.equal(env.SPRINTENGINE_AGENT_NAME, 'Fred Walsh')

      // No agent identity passed → identity vars are stripped, including the stale
      // value inherited from the app process, so a plain terminal claims none.
      mockPty.spawnCalls = []
      const plain = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'session_identity_env_plain',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        kind: 'terminal',
        terminalId: 'term-1',
        shellOnly: true,
      })
      assert.equal(plain.ok, true, JSON.stringify(plain))
      const plainEnv = (mockPty.spawnCalls[0]?.options.env ?? {}) as Record<string, string>
      assert.equal(
        plainEnv.SPRINTENGINE_AGENT_ID,
        undefined,
        'stale inherited identity must not leak into plain terminals',
      )
      assert.equal(plainEnv.SPRINTENGINE_WORKSPACE_ID, undefined)
    } finally {
      if (priorAgentId === undefined) delete process.env.SPRINTENGINE_AGENT_ID
      else process.env.SPRINTENGINE_AGENT_ID = priorAgentId
      await runtime.shutdown()
    }
  }

  // A Stop that arrives while a subagent is still running is not a turn end.
  // Claude fires Stop when it parks the model on "Waiting for 1 background agent
  // to finish" and re-invokes it, promptless, when the agent is done; read
  // literally, that Stop marked the sidebar row finished and let a run finalize
  // mid-work (owner, 2026-09-04). The manifest's `background` events keep a
  // per-session count, and the runtime holds the turn end while it is open.
  async function assertTurnEndIsHeldWhileBackgroundWorkIsOpen(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-background-'))
    mockPty.spawnCalls = []
    mockSender.sent = []

    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
      syncMcpConfig: async (): Promise<SyncResult> => ({ ok: true }),
    })
    const snapshotFor = (sessionId: string) =>
      runtime.ipcHandlers.listTerminals().find((session) => session.sessionId === sessionId)
    const events: AgentPhaseEvent[] = []
    const unregister = runtime.registerAgentPhaseListener((event) => {
      events.push(event)
    })
    const last = () => events[events.length - 1]

    try {
      const spawn = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'sess-background',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-background',
        agentId: 'agent-background',
        agentName: 'Background',
      })
      assert.equal(spawn.ok, true, JSON.stringify(spawn))

      const base = Date.now()
      const frame = (event: string, ts: number): AgentStateFrame => ({
        type: 'agent_state',
        agentId: 'agent-background',
        workspaceId: 'ws-background',
        sessionId: null,
        // The manifest owns the mapping; the reporter-asserted phase is ignored
        // whenever the event resolves, so it is deliberately wrong here.
        phase: 'idle',
        event,
        ts: base + ts,
      })
      const ingest = async (event: string, ts: number): Promise<void> => {
        runtime.ingestAgentStateFrame(frame(event, ts))
        await delay(5)
      }

      await ingest('UserPromptSubmit', 100)
      await ingest('SubagentStart', 200)
      await ingest('PostToolUse', 300)
      // The model parks on the background agent: Stop fires, work is not done.
      await ingest('Stop', 400)
      assert.equal(last()?.event, 'Stop')
      assert.equal(last()?.phase, 'tool_use', 'a Stop with a subagent outstanding is held as working')
      assert.equal(last()?.turnEnd, false, 'and is not a turn end — nothing may finalize on it')
      assert.equal(snapshotFor('sess-background')?.agentState?.phase, 'tool_use')
      assert.equal(snapshotFor('sess-background')?.activity.kind, 'working', 'the sidebar clock keeps running')

      // The agent finishes; the model is re-invoked and works to a real end.
      await ingest('SubagentStop', 500)
      assert.equal(last()?.phase, 'thinking', 'a subagent stopping is the parent resuming, never idle')
      await ingest('PostToolUse', 600)
      await ingest('Stop', 700)
      assert.equal(last()?.phase, 'idle', 'with nothing outstanding the Stop is the turn end')
      assert.equal(last()?.turnEnd, true)
      assert.equal(snapshotFor('sess-background')?.activity.kind, 'idle')

      // A synchronous subagent (start and stop inside one tool call) leaves
      // nothing open; a stop with nothing open clamps rather than going negative.
      await ingest('UserPromptSubmit', 800)
      await ingest('SubagentStart', 810)
      await ingest('SubagentStop', 820)
      await ingest('SubagentStop', 830)
      await ingest('Stop', 900)
      assert.equal(last()?.phase, 'idle')
      assert.equal(last()?.turnEnd, true, 'a balanced start/stop pair holds nothing')

      // A fresh process owns nothing from its previous life: a SessionStart
      // after an unmatched start resets the count, so the next Stop is real.
      await ingest('UserPromptSubmit', 1000)
      await ingest('SubagentStart', 1010)
      await ingest('SessionStart', 1100)
      await ingest('UserPromptSubmit', 1200)
      await ingest('Stop', 1300)
      assert.equal(last()?.turnEnd, true, 'a session start resets outstanding work')
    } finally {
      unregister()
      runtime.ipcHandlers.killTerminal('sess-background')
      await runtime.shutdown()
    }
  }

  // A finished turn stays finished. Captured from a real Claude Code session:
  // SessionStart, UserPromptSubmit, PostToolUse, Stop — then a SubagentStop with
  // no SubagentStart four seconds later (the CLI's own post-turn helper), which
  // used to put the row back on `thinking` and keep the sidebar clock running
  // until the stall watch caught it. A straggler of the finished turn, and the
  // same frame delivered twice by a doubled registration, must not reopen it
  // either; a real new prompt must.
  async function assertTurnEndSurvivesLateFrames(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-turn-end-'))
    mockPty.spawnCalls = []
    mockSender.sent = []

    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
      syncMcpConfig: async (): Promise<SyncResult> => ({ ok: true }),
    })
    const snapshot = () => runtime.ipcHandlers.listTerminals().find((session) => session.sessionId === 'sess-turn-end')
    const events: AgentPhaseEvent[] = []
    const unregister = runtime.registerAgentPhaseListener((event) => {
      events.push(event)
    })

    try {
      const spawn = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'sess-turn-end',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-turn-end',
        agentId: 'agent-turn-end',
        agentName: 'Turn end',
      })
      assert.equal(spawn.ok, true, JSON.stringify(spawn))

      const base = Date.now()
      const ingest = async (event: string, ts: number, extra: Partial<AgentStateFrame> = {}): Promise<void> => {
        runtime.ingestAgentStateFrame({
          type: 'agent_state',
          agentId: 'agent-turn-end',
          workspaceId: 'ws-turn-end',
          sessionId: null,
          event,
          ts: base + ts,
          ...extra,
        })
        await delay(5)
      }

      await ingest('SessionStart', 0)
      await ingest('UserPromptSubmit', 90)
      await ingest('PostToolUse', 2_430, { toolUseId: 'toolu_read' })
      await ingest('Stop', 3_750)
      assert.equal(snapshot()?.agentState?.phase, 'idle')
      assert.equal(snapshot()?.activity.kind, 'idle', 'the sidebar clock stops on Stop')
      const phaseEventsAtStop = events.length

      // The same PostToolUse again, as a second registration of the reporter
      // would deliver it: older than the Stop, so it is dropped.
      await ingest('PostToolUse', 2_430, { toolUseId: 'toolu_read' })
      // A straggler stamped just after the Stop (its reporter started late).
      await ingest('PostToolUse', 3_800, { toolUseId: 'toolu_read' })
      // The CLI's post-turn helper agent, with no SubagentStart before it.
      await ingest('SubagentStop', 8_450)
      assert.equal(snapshot()?.agentState?.phase, 'idle', 'no late frame reopens a finished turn')
      assert.equal(snapshot()?.activity.kind, 'idle', 'and the sidebar clock stays stopped')
      assert.equal(snapshot()?.activeSubagents, 0)
      assert.equal(events.length, phaseEventsAtStop, 'no phase event fires for a frame that changed nothing')

      // The person sends the next prompt: that is a turn, and it reads as one.
      await ingest('UserPromptSubmit', 20_000, { prompt: 'and now the next thing' })
      assert.equal(snapshot()?.agentState?.phase, 'thinking')
      assert.equal(snapshot()?.activity.kind, 'working')
      await ingest('Stop', 22_000)
      assert.equal(snapshot()?.activity.kind, 'idle')

      // A promptless re-invocation well after the Stop (a background task
      // finishing) still reads as working.
      await ingest('PostToolUse', 40_000, { toolUseId: 'toolu_later' })
      assert.equal(snapshot()?.agentState?.phase, 'thinking')
    } finally {
      unregister()
      runtime.ipcHandlers.killTerminal('sess-turn-end')
      await runtime.shutdown()
    }
  }

  // Context-window usage, from the session's own status line. The forwarder's
  // frames carry `event: 'StatusLine'`, which no manifest names — so the phase
  // resolution always DROPS them, and the reading has to be folded in before that
  // drop or it never arrives. A null percentage (right after a /compact) keeps the
  // last known reading, and only a change in the whole percent is worth a
  // broadcast.
  async function assertContextUsageFollowsStatusLineFrames(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-context-'))
    const userDataDir = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-context-data-'))
    const sidecarStore = createTerminalSnapshotSidecarStore({ resolveUserDataDir: () => userDataDir })
    mockPty.spawnCalls = []
    mockSender.sent = []

    const runtimeOptions = {
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
      snapshotSidecars: sidecarStore,
    }
    const runtime = runtimeModule.createTerminalRuntime(runtimeOptions)
    const snapshot = () => runtime.ipcHandlers.listTerminals().find((session) => session.sessionId === 'sess-context')
    const base = Date.now()
    const frame = (overrides: Partial<AgentStateFrame>): AgentStateFrame => ({
      type: 'agent_state',
      agentId: 'agent-context',
      workspaceId: 'ws-context',
      sessionId: null,
      event: 'StatusLine',
      ts: base,
      ...overrides,
    })
    const sentSessionsChanges = async (): Promise<number> => {
      await delay(runtimeModule.TERMINAL_SESSIONS_BROADCAST_COALESCE_MS + 10)
      return mockSender.sent.filter((event) => event.channel === 'terminal:sessions-delta').length
    }

    let contextPty: MockPtyProcess
    try {
      const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'sess-context',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-context',
        agentId: 'agent-context',
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      const spawned = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
      assert.ok(spawned, 'expected a pty for sess-context')
      contextPty = spawned
      assert.equal(snapshot()?.contextUsage, null, 'a session that has not made an API call knows nothing')

      // A first reading lands, and it broadcasts on its own: no phase moved.
      await sentSessionsChanges()
      mockSender.sent = []
      runtime.ingestAgentStateFrame(
        frame({
          ts: base + 100,
          statusLine: { usedPercentage: 8, contextWindowSize: 200_000, totalCostUsd: 0.5, model: 'Opus' },
        }),
      )
      assert.deepEqual(snapshot()?.contextUsage, { usedPercentage: 8, at: base + 100, contextWindowSize: 200_000 })
      assert.equal(await sentSessionsChanges(), 1, 'a context reading is broadcast-worthy on its own')

      // The same whole percent again is not news, however much the cost moved.
      mockSender.sent = []
      runtime.ingestAgentStateFrame(
        frame({ ts: base + 200, statusLine: { usedPercentage: 8, totalCostUsd: 0.9, linesAdded: 40 } }),
      )
      assert.deepEqual(
        snapshot()?.contextUsage,
        { usedPercentage: 8, at: base + 100, contextWindowSize: 200_000 },
        'the timestamp holds too',
      )
      assert.equal(await sentSessionsChanges(), 0, 'an unchanged percentage must not repaint every window')

      // A /compact reports the percentage as null, which arrives as an absent
      // field. The last known reading stands: "not known right now" is not "empty".
      mockSender.sent = []
      runtime.ingestAgentStateFrame(frame({ ts: base + 300, statusLine: { totalCostUsd: 1.1, sessionName: 'ledger' } }))
      assert.deepEqual(
        snapshot()?.contextUsage,
        { usedPercentage: 8, at: base + 100, contextWindowSize: 200_000 },
        'a null percentage after a compact keeps the last known reading',
      )
      assert.equal(await sentSessionsChanges(), 0)

      // The next real reading replaces it.
      mockSender.sent = []
      runtime.ingestAgentStateFrame(frame({ ts: base + 400, statusLine: { usedPercentage: 3 } }))
      assert.deepEqual(snapshot()?.contextUsage, { usedPercentage: 3, at: base + 400, contextWindowSize: 200_000 })
      assert.equal(await sentSessionsChanges(), 1)

      // Out of order: a status-line process is spawned per refresh and they can
      // finish in any order, so a reading older than the one already held is
      // ignored rather than rolling the number backwards.
      mockSender.sent = []
      runtime.ingestAgentStateFrame(frame({ ts: base + 350, statusLine: { usedPercentage: 71 } }))
      assert.deepEqual(
        snapshot()?.contextUsage,
        { usedPercentage: 3, at: base + 400, contextWindowSize: 200_000 },
        'a stale reading is ignored',
      )
      assert.equal(await sentSessionsChanges(), 0)

      // The window it is a percent OF is news too — a model switch changes it
      // with no percent moving, and the card's "84k / 200k" would go stale —
      // but it does not re-date the reading, which `at` says is the percent's.
      mockSender.sent = []
      runtime.ingestAgentStateFrame(frame({ ts: base + 450, statusLine: { contextWindowSize: 1_000_000 } }))
      assert.deepEqual(snapshot()?.contextUsage, { usedPercentage: 3, at: base + 400, contextWindowSize: 1_000_000 })
      assert.equal(await sentSessionsChanges(), 1, 'a new window size is broadcast')
      runtime.ingestAgentStateFrame(frame({ ts: base + 460, statusLine: { contextWindowSize: 200_000 } }))
      await sentSessionsChanges()

      // The frame's own event resolves to a drop for every Claude manifest, and a
      // drop must not take the phase with it either: the phase the session had
      // before the status line arrived is the phase it still has.
      runtime.ingestAgentStateFrame(frame({ ts: base + 500, event: 'UserPromptSubmit' }))
      assert.equal(snapshot()?.agentState?.phase, 'thinking')
      mockSender.sent = []
      runtime.ingestAgentStateFrame(frame({ ts: base + 600, statusLine: { usedPercentage: 9 } }))
      assert.equal(snapshot()?.agentState?.phase, 'thinking', 'a status-line refresh moves no phase')
      assert.deepEqual(snapshot()?.contextUsage, { usedPercentage: 9, at: base + 600, contextWindowSize: 200_000 })
      assert.equal(await sentSessionsChanges(), 1, 'and a dropped frame still publishes its reading')

      // The other gate: a reading riding a frame whose event the manifest DOES
      // name reaches the broadcast at the end of the function rather than the
      // early-return one, and both have to publish it. Nothing sends this today
      // — the forwarder's event is in no manifest — but the frame type allows a
      // reading on any frame, and a plugin manifest is data.
      mockSender.sent = []
      runtime.ingestAgentStateFrame(frame({ ts: base + 700, event: 'PostToolUse', statusLine: { usedPercentage: 15 } }))
      assert.deepEqual(snapshot()?.contextUsage, { usedPercentage: 15, at: base + 700, contextWindowSize: 200_000 })
      assert.equal(await sentSessionsChanges(), 1, 'an applied frame publishes its reading too')

      // Parked across an app restart: the reading rides the snapshot sidecar.
      contextPty.emitData('context painted output\r\n')
      await delay(20)
      runtime.ipcHandlers.suspendTerminal('sess-context')
      contextPty.emitExit({ exitCode: 0 })
      const start = Date.now()
      while (!(await sidecarStore.read('sess-context'))) {
        if (Date.now() - start > 5_000) throw new Error('timed out waiting for the context sidecar')
        await delay(20)
      }
      assert.deepEqual((await sidecarStore.read('sess-context'))?.contextUsage, {
        usedPercentage: 15,
        at: base + 700,
        contextWindowSize: 200_000,
      })
    } finally {
      await runtime.shutdown()
    }

    const runtime2 = runtimeModule.createTerminalRuntime(runtimeOptions)
    try {
      await runtime2.ipcHandlers.getTerminalStatus('sess-context', mockSender as unknown as WebContents)
      const rehydrated = runtime2.ipcHandlers
        .listTerminals()
        .find((session) => session.sessionId === 'sess-context')?.contextUsage
      assert.equal(rehydrated?.usedPercentage, 15, 'a chat parked across a restart still says how full it was')
      // The frames above are stamped on a synthetic clock that runs ahead of the
      // real one, and the sidecar reader clamps a future time to arrival — the
      // same rule the socket applies to a reporter's `ts`, pinned on its own in
      // terminal-session.test.ts. So the reading comes back, dated no later than
      // now.
      assert.ok(
        rehydrated !== null && rehydrated !== undefined && rehydrated.at > base - 1 && rehydrated.at <= Date.now(),
        `the persisted time came back clamped to arrival: ${JSON.stringify(rehydrated)}`,
      )
    } finally {
      await runtime2.shutdown()
    }
  }

  // A status line repeats the usage windows of its last API response on every
  // refresh, idle or not, and the usage-limit store keeps whatever it heard
  // last. Handing it every refresh let an idle terminal's old reading overwrite
  // a chat's newer one, dated as fresh. The windows go to the store when they
  // moved, or when the session's cost did (a new API response, so a current
  // reading even when it is the same).
  async function assertStatusLineUsageWindowsReachTheStoreOnlyWhenNews(runtimeModule: RuntimeModule): Promise<void> {
    const { forwardStatusLineRateLimits } = await import('./usage-limits/store')
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-usage-'))
    mockPty.spawnCalls = []
    mockSender.sent = []
    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })
    const base = Date.now()
    const frame = (ts: number, statusLine: AgentStateFrame['statusLine']): AgentStateFrame => ({
      type: 'agent_state',
      agentId: 'agent-usage',
      workspaceId: 'ws-usage',
      sessionId: null,
      event: 'StatusLine',
      ts,
      statusLine,
    })
    const forwarded: Array<{ rateLimits: unknown; at: number }> = []
    const stopForwarding = forwardStatusLineRateLimits((rateLimits, at) => forwarded.push({ rateLimits, at }))
    const twelve = { five_hour: { usedPercentage: 12, resetsAt: base + 3_600_000 } }
    try {
      const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'sess-usage',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-usage',
        agentId: 'agent-usage',
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, true, JSON.stringify(result))

      runtime.ingestAgentStateFrame(frame(base + 100, { totalCostUsd: 0.5, rateLimits: twelve }))
      assert.deepEqual(forwarded, [{ rateLimits: twelve, at: base + 100 }], 'a first reading reaches the store')

      // An idle refresh: the same windows, the same cost.
      runtime.ingestAgentStateFrame(frame(base + 200, { totalCostUsd: 0.5, rateLimits: twelve }))
      assert.equal(forwarded.length, 1, 'an idle refresh repeating the last reading is not handed on again')

      // A new API response: the cost moved, the windows read the same.
      runtime.ingestAgentStateFrame(frame(base + 300, { totalCostUsd: 0.6, rateLimits: twelve }))
      assert.deepEqual(forwarded.at(-1), { rateLimits: twelve, at: base + 300 }, 'a new response re-dates the reading')

      const moved = { five_hour: { usedPercentage: 14, resetsAt: base + 3_600_000 } }
      runtime.ingestAgentStateFrame(frame(base + 400, { totalCostUsd: 0.6, rateLimits: moved }))
      assert.deepEqual(forwarded.at(-1), { rateLimits: moved, at: base + 400 }, 'windows that moved are news')
      assert.equal(forwarded.length, 3)
    } finally {
      stopForwarding()
      await runtime.shutdown()
    }
  }

  // The per-session file ledger: what this agent edited, summed from its own
  // PostToolUse hooks and never from git (the checkout is shared; the ledger is
  // the agent's own work). Counts accumulate — a line edited twice counts twice —
  // the list reads newest-edited first, and a change is broadcast-worthy on its
  // own, because nothing else about the session need have moved.
  async function assertFileLedgerFollowsHookReportedEdits(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-ledger-'))
    const userDataDir = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-ledger-data-'))
    const sidecarStore = createTerminalSnapshotSidecarStore({ resolveUserDataDir: () => userDataDir })
    mockPty.spawnCalls = []
    mockSender.sent = []

    const runtimeOptions = {
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
      snapshotSidecars: sidecarStore,
    }
    const runtime = runtimeModule.createTerminalRuntime(runtimeOptions)
    const snapshot = () => runtime.ipcHandlers.listTerminals().find((session) => session.sessionId === 'sess-ledger')
    const base = Date.now()
    const frame = (overrides: Partial<AgentStateFrame>): AgentStateFrame => ({
      type: 'agent_state',
      agentId: 'agent-ledger',
      workspaceId: 'ws-ledger',
      sessionId: null,
      event: 'PostToolUse',
      ts: base,
      ...overrides,
    })
    // A broadcast is coalesced behind a frame's timer, so "did it send" is only
    // answerable after that window.
    const sentSessionsChanges = async (): Promise<number> => {
      await delay(runtimeModule.TERMINAL_SESSIONS_BROADCAST_COALESCE_MS + 10)
      return mockSender.sent.filter((event) => event.channel === 'terminal:sessions-delta').length
    }

    const spawnLedgerAgent = async (): Promise<MockPtyProcess> => {
      const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'sess-ledger',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-ledger',
        agentId: 'agent-ledger',
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      const spawned = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
      assert.ok(spawned, 'expected a pty for sess-ledger')
      return spawned
    }

    try {
      const ledgerPty = await spawnLedgerAgent()
      assert.deepEqual(snapshot()?.fileChanges, [], 'a fresh session has edited nothing — empty, never absent')
      assert.equal(snapshot()?.activeSubagents, 0)
      assert.equal(snapshot()?.contextUsage, null, "nothing has read this session's status line yet")

      // Two edits of the same file SUM: the ledger measures the work, not the
      // tree's distance from HEAD, so a line edited twice counts twice.
      await sentSessionsChanges()
      mockSender.sent = []
      runtime.ingestAgentStateFrame(
        frame({ ts: base + 100, fileChange: { path: '/repo/src/app.ts', additions: 12, deletions: 3 } }),
      )
      assert.equal(await sentSessionsChanges(), 1, 'an edit alone is worth a broadcast: it is rendered')
      runtime.ingestAgentStateFrame(
        frame({ ts: base + 200, fileChange: { path: '/repo/src/app.ts', additions: 5, deletions: 1 } }),
      )
      await delay(runtimeModule.TERMINAL_SESSIONS_BROADCAST_COALESCE_MS + 10)
      assert.deepEqual(
        snapshot()?.fileChanges,
        [{ path: '/repo/src/app.ts', additions: 17, deletions: 4, edits: 2, lastEditedAt: base + 200 }],
        'a second edit of the same file accumulates onto the first',
      )

      // Newest-edited first, and re-editing an older file moves it back to the top.
      runtime.ingestAgentStateFrame(
        frame({ ts: base + 300, fileChange: { path: '/repo/README.md', additions: 2, deletions: 0 } }),
      )
      await delay(runtimeModule.TERMINAL_SESSIONS_BROADCAST_COALESCE_MS + 10)
      assert.deepEqual(
        snapshot()?.fileChanges.map((change) => change.path),
        ['/repo/README.md', '/repo/src/app.ts'],
        'the ledger reads newest-edited first',
      )
      runtime.ingestAgentStateFrame(
        frame({ ts: base + 400, fileChange: { path: '/repo/src/app.ts', additions: 1, deletions: 0 } }),
      )
      await delay(runtimeModule.TERMINAL_SESSIONS_BROADCAST_COALESCE_MS + 10)
      assert.deepEqual(
        snapshot()?.fileChanges.map((change) => change.path),
        ['/repo/src/app.ts', '/repo/README.md'],
        're-editing a file moves it back to the front',
      )

      // A subagent's edit is the session's work. The reporter suppresses a
      // subagent's CWD (an isolated worktree is not where the session is) but
      // never its edits, and the runtime folds them in like any other.
      runtime.ingestAgentStateFrame(
        frame({ ts: base + 500, fileChange: { path: '/repo/src/subagent.ts', additions: 40, deletions: 0 } }),
      )
      // …including on a frame whose event this CLI's manifest does not name, which
      // drops before any phase is applied: the edit still happened.
      mockSender.sent = []
      runtime.ingestAgentStateFrame(
        frame({
          ts: base + 600,
          event: 'Notification',
          notificationType: 'idle_prompt',
          fileChange: { path: '/repo/src/dropped-event.ts', additions: 7, deletions: 2 },
        }),
      )
      assert.equal(await sentSessionsChanges(), 1, 'a dropped-phase frame still publishes the edit it carried')
      assert.deepEqual(
        snapshot()?.fileChanges.map((change) => [change.path, change.additions, change.deletions]),
        [
          ['/repo/src/dropped-event.ts', 7, 2],
          ['/repo/src/subagent.ts', 40, 0],
          ['/repo/src/app.ts', 18, 4],
          ['/repo/README.md', 2, 0],
        ],
        'every reported edit lands, whatever fired it',
      )

      // The subagent count main already keeps, surfaced for the renderer: it
      // changes with no phase change of its own, so it is broadcast on its own.
      mockSender.sent = []
      runtime.ingestAgentStateFrame(frame({ ts: base + 700, event: 'SubagentStart' }))
      assert.equal(await sentSessionsChanges(), 1, 'a subagent starting is a broadcast: the count is rendered')
      assert.equal(snapshot()?.activeSubagents, 1)
      runtime.ingestAgentStateFrame(frame({ ts: base + 800, event: 'SubagentStart' }))
      await delay(runtimeModule.TERMINAL_SESSIONS_BROADCAST_COALESCE_MS + 10)
      assert.equal(snapshot()?.activeSubagents, 2)
      runtime.ingestAgentStateFrame(frame({ ts: base + 900, event: 'SubagentStop' }))
      runtime.ingestAgentStateFrame(frame({ ts: base + 1000, event: 'SubagentStop' }))
      await delay(runtimeModule.TERMINAL_SESSIONS_BROADCAST_COALESCE_MS + 10)
      assert.equal(snapshot()?.activeSubagents, 0)

      // An out-of-order frame still counts. Claude spawns a hook process per tool
      // call and runs edits in parallel, so a later-stamped frame landing first is
      // ordinary — and the guard that stops a stale frame rolling the PHASE back
      // must not take the edit with it, because an edit has no order to roll back.
      mockSender.sent = []
      runtime.ingestAgentStateFrame(
        frame({
          ts: base + 500,
          fileChange: { path: '/repo/src/late.ts', additions: 3, deletions: 1 },
        }),
      )
      assert.equal(await sentSessionsChanges(), 1, 'a stale-phase frame still publishes the edit it carried')
      assert.deepEqual(
        snapshot()?.fileChanges.find((change) => change.path === '/repo/src/late.ts'),
        { path: '/repo/src/late.ts', additions: 3, deletions: 1, edits: 1, lastEditedAt: base + 500 },
        'the edit lands even though the frame is older than the recorded phase',
      )

      // The ledger is bounded: it rides every snapshot broadcast to every window,
      // so a run that touches thousands of files must not turn each send into
      // hundreds of kilobytes. Past the cap the LEAST recently edited entry is
      // the one that falls off — the list is read newest-first. On a session of
      // its own, so the ledger asserted above stays the one the edits built.
      const bulk = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'sess-ledger-bulk',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-ledger',
        agentId: 'agent-ledger-bulk',
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(bulk.ok, true, JSON.stringify(bulk))
      for (let i = 0; i < 600; i += 1) {
        runtime.ingestAgentStateFrame(
          frame({
            agentId: 'agent-ledger-bulk',
            ts: base + 2000 + i,
            fileChange: { path: `/repo/bulk/file-${i}.ts`, additions: 1, deletions: 0 },
          }),
        )
      }
      await delay(runtimeModule.TERMINAL_SESSIONS_BROADCAST_COALESCE_MS + 10)
      const capped =
        runtime.ipcHandlers.listTerminals().find((session) => session.sessionId === 'sess-ledger-bulk')?.fileChanges ??
        []
      assert.equal(capped.length, 500, 'the ledger is capped')
      assert.equal(capped[0]?.path, '/repo/bulk/file-599.ts', 'the newest edit is still at the front')
      assert.deepEqual(
        capped[capped.length - 1],
        { path: '/repo/bulk/file-100.ts', additions: 1, deletions: 0, edits: 1, lastEditedAt: base + 2100 },
        'the least recent edits fell off the end, and a survivor keeps its own counts',
      )

      // Nothing outlives the process it ran under: a session that dies owing
      // subagents must not keep rendering them as live work.
      const bulkPty = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
      assert.ok(bulkPty, 'expected a pty for sess-ledger-bulk')
      runtime.ingestAgentStateFrame(frame({ agentId: 'agent-ledger-bulk', ts: base + 3000, event: 'SubagentStart' }))
      await delay(runtimeModule.TERMINAL_SESSIONS_BROADCAST_COALESCE_MS + 10)
      const bulkSnapshot = () =>
        runtime.ipcHandlers.listTerminals().find((session) => session.sessionId === 'sess-ledger-bulk')
      assert.equal(bulkSnapshot()?.activeSubagents, 1)
      bulkPty.emitExit({ exitCode: 0 })
      await delay(runtimeModule.TERMINAL_SESSIONS_BROADCAST_COALESCE_MS + 10)
      assert.equal(bulkSnapshot()?.processAlive, false)
      assert.equal(bulkSnapshot()?.activeSubagents, 0, 'a dead session owns no subagents')
      assert.equal(
        bulkSnapshot()?.fileChanges.length,
        500,
        'but what it edited is still what it edited — the ledger outlives the turn, not the count of live work',
      )
      runtime.ipcHandlers.killTerminal('sess-ledger-bulk')

      // Parked across an app restart: the ledger is in the snapshot sidecar, the
      // only place it is ever written down, so a frozen chat still says what it
      // changed.
      // A sidecar is only written for a session with something painted on it.
      ledgerPty.emitData('ledger painted output\r\n')
      await delay(20)
      runtime.ipcHandlers.suspendTerminal('sess-ledger')
      ledgerPty.emitExit({ exitCode: 0 })
      const waitForSidecar = async (): Promise<void> => {
        const start = Date.now()
        while (!(await sidecarStore.read('sess-ledger'))) {
          if (Date.now() - start > 5_000) throw new Error('timed out waiting for the ledger sidecar')
          await delay(20)
        }
      }
      await waitForSidecar()
      assert.deepEqual(
        (await sidecarStore.read('sess-ledger'))?.fileChanges?.map((change) => change.path),
        [
          '/repo/src/late.ts',
          '/repo/src/dropped-event.ts',
          '/repo/src/subagent.ts',
          '/repo/src/app.ts',
          '/repo/README.md',
        ],
        'the sidecar persists the ledger newest-first',
      )
    } finally {
      await runtime.shutdown()
    }

    // A fresh runtime, as after a relaunch: the rehydrated placeholder carries
    // the ledger back, and a RESUME (which respawns the pty) starts a new one —
    // the ledger lives and dies with the process that earned it.
    const runtime2 = runtimeModule.createTerminalRuntime(runtimeOptions)
    try {
      await runtime2.ipcHandlers.getTerminalStatus('sess-ledger', mockSender as unknown as WebContents)
      const rehydrated = runtime2.ipcHandlers.listTerminals().find((session) => session.sessionId === 'sess-ledger')
      assert.deepEqual(
        rehydrated?.fileChanges,
        [
          { path: '/repo/src/late.ts', additions: 3, deletions: 1, edits: 1, lastEditedAt: base + 500 },
          { path: '/repo/src/dropped-event.ts', additions: 7, deletions: 2, edits: 1, lastEditedAt: base + 600 },
          { path: '/repo/src/subagent.ts', additions: 40, deletions: 0, edits: 1, lastEditedAt: base + 500 },
          { path: '/repo/src/app.ts', additions: 18, deletions: 4, edits: 3, lastEditedAt: base + 400 },
          { path: '/repo/README.md', additions: 2, deletions: 0, edits: 1, lastEditedAt: base + 300 },
        ],
        'a session parked across a restart keeps its ledger, counts and order intact',
      )
      assert.equal(rehydrated?.activeSubagents, 0, 'a placeholder owns no background work')

      mockPty.spawnCalls = []
      const resumed = await runtime2.ipcHandlers.resumeTerminal(mockSender as unknown as WebContents, {
        sessionId: 'sess-ledger',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-ledger',
        agentId: 'agent-ledger',
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(resumed.ok, true, JSON.stringify(resumed))
      assert.deepEqual(
        runtime2.ipcHandlers.listTerminals().find((session) => session.sessionId === 'sess-ledger')?.fileChanges,
        [],
        'a respawned pty starts a fresh ledger — the count belongs to the process that did the work',
      )
    } finally {
      await runtime2.shutdown()
    }
  }

  // A reporter frame updates the matching session's authoritative phase, bridges
  // it to the legacy activity field, ignores stale out-of-order frames, and is a
  // safe no-op for an unknown agent id.
  // The three seams the agent changelist feed hangs off (`agent-changelist-feed.ts`):
  // a launch, every reported edit, and the one exit. What is proved here is that
  // they fire where the feature needs them to — an edit even on a frame the phase
  // guards drop, a launch only for an AGENT, an exit exactly once — and that a
  // seam that throws cannot take a terminal down with it.
  async function assertAgentChangelistSeamsFire(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-changelists-'))
    mockPty.spawnCalls = []
    mockSender.sent = []

    const launched: Array<{ agentId?: string; agentName?: string; cwd?: string }> = []
    const edits: Array<{ agentId?: string; path: string; edits?: unknown; ts: number }> = []
    const exited: Array<string | undefined> = []
    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
      onAgentLaunched: (session) => {
        launched.push({ agentId: session.agentId, agentName: session.agentName, cwd: session.cwd })
      },
      onAgentFileEdit: (input) => {
        edits.push({ agentId: input.session.agentId, path: input.path, edits: input.edits, ts: input.ts })
        if (input.path.endsWith('explode.ts')) throw new Error('the store is on fire')
      },
      onAgentSessionExit: (session) => {
        exited.push(session.agentId)
      },
    })

    try {
      const spawn = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'sess-changelists',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-changelists',
        agentId: 'agent-changelists',
        agentName: 'Nadia',
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(spawn.ok, true, JSON.stringify(spawn))
      const agentPty = mockPty.spawnCalls[mockPty.spawnCalls.length - 1]?.process
      assert.ok(agentPty, 'expected a pty for sess-changelists')
      assert.deepEqual(
        launched,
        [{ agentId: 'agent-changelists', agentName: 'Nadia', cwd: workspaceRoot }],
        'a launched agent gets its changelist, named and rooted where it runs',
      )

      // A plain terminal has no agent and must never get an owned list.
      const shell = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'sess-changelists-shell',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        kind: 'terminal',
        shellOnly: true,
        visible: false,
      })
      assert.equal(shell.ok, true, JSON.stringify(shell))
      assert.equal(launched.length, 1, 'a plain terminal is not an agent')

      const base = Date.now()
      const frame = (overrides: Partial<AgentStateFrame>): AgentStateFrame => ({
        type: 'agent_state',
        agentId: 'agent-changelists',
        workspaceId: 'ws-changelists',
        sessionId: null,
        event: 'PostToolUse',
        ts: base,
        ...overrides,
      })

      runtime.ingestAgentStateFrame(
        frame({
          ts: base + 100,
          fileChange: {
            path: '/repo/src/app.ts',
            additions: 3,
            deletions: 1,
            edits: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 3 }],
          },
        }),
      )
      assert.deepEqual(
        edits,
        [
          {
            agentId: 'agent-changelists',
            path: '/repo/src/app.ts',
            edits: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 3 }],
            ts: base + 100,
          },
        ],
        'the reported regions reach the feed verbatim, with the session that wrote them',
      )

      // An edit whose patch the reporter could not read still reaches the feed —
      // a file-level claim is a smaller lie than none.
      edits.length = 0
      runtime.ingestAgentStateFrame(
        frame({
          ts: base + 200,
          fileChange: { path: '/repo/src/opaque.ts', additions: 0, deletions: 0 },
        }),
      )
      assert.deepEqual(
        edits.map((edit) => [edit.path, edit.edits]),
        [['/repo/src/opaque.ts', undefined]],
      )

      // …and so does one on a frame the guards drop: a STALE frame moves no phase,
      // but the edit it carries already happened. Same for an event this CLI's
      // manifest does not name.
      edits.length = 0
      runtime.ingestAgentStateFrame(
        frame({
          ts: base + 50,
          fileChange: { path: '/repo/src/late.ts', additions: 1, deletions: 0 },
        }),
      )
      runtime.ingestAgentStateFrame(
        frame({
          ts: base + 300,
          event: 'Notification',
          notificationType: 'idle_prompt',
          fileChange: { path: '/repo/src/dropped.ts', additions: 1, deletions: 0 },
        }),
      )
      assert.deepEqual(
        edits.map((edit) => edit.path),
        ['/repo/src/late.ts', '/repo/src/dropped.ts'],
        'an edit is order-independent: neither the stale guard nor a dropped event may eat it',
      )

      // A seam that throws is the feed's problem, never the session's.
      edits.length = 0
      runtime.ingestAgentStateFrame(
        frame({
          ts: base + 400,
          fileChange: { path: '/repo/src/explode.ts', additions: 1, deletions: 0 },
        }),
      )
      assert.equal(edits.length, 1, 'the throwing seam was called')
      assert.equal(
        runtime.ipcHandlers.listTerminals().some((session) => session.sessionId === 'sess-changelists'),
        true,
        'and the session survived it',
      )

      // The duplicate-registration guard. The app registers the agent-state
      // reporter twice — merged into `.claude/settings.local.json`, and declared
      // again by the studio plugin's `hooks/hooks.json`, which Claude Code
      // 2.1.266 loads natively of its own accord — so both fire on one tool call
      // and send byte-identical frames. Counted twice, the hover card's ledger
      // read exactly 2x the agent's edits; fed twice, `recordEdit` applied every
      // insert and delete twice and the changelist's spans went wrong. Both must
      // see each edit ONCE.
      const ledgerOf = (path: string) =>
        runtime.ipcHandlers
          .listTerminals()
          .find((session) => session.sessionId === 'sess-changelists')
          ?.fileChanges.find((change) => change.path === path)

      edits.length = 0
      const dupChange = {
        path: '/repo/src/dup.ts',
        additions: 4,
        deletions: 2,
        edits: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 4 }],
      }
      runtime.ingestAgentStateFrame(frame({ ts: base + 500, toolUseId: 'toolu_same', fileChange: dupChange }))
      runtime.ingestAgentStateFrame(frame({ ts: base + 500, toolUseId: 'toolu_same', fileChange: dupChange }))
      assert.equal(edits.length, 1, 'the second registration`s copy never reaches the changelist feed')
      assert.deepEqual(
        [
          ledgerOf('/repo/src/dup.ts')?.additions,
          ledgerOf('/repo/src/dup.ts')?.deletions,
          ledgerOf('/repo/src/dup.ts')?.edits,
        ],
        [4, 2, 1],
        'and it is counted once in the ledger — +4/-2, not +8/-4',
      )

      // A genuinely second edit is a second tool CALL, with its own id, and both
      // fold. (Claude Code's parallel edits share no id either — each call has
      // its own — so two concurrent edits both land.)
      edits.length = 0
      runtime.ingestAgentStateFrame(
        frame({
          ts: base + 600,
          toolUseId: 'toolu_a',
          fileChange: { path: '/repo/src/twice.ts', additions: 1, deletions: 0 },
        }),
      )
      runtime.ingestAgentStateFrame(
        frame({
          ts: base + 601,
          toolUseId: 'toolu_b',
          fileChange: { path: '/repo/src/twice.ts', additions: 1, deletions: 0 },
        }),
      )
      assert.equal(edits.length, 2, 'two different tool calls are two edits')
      assert.deepEqual([ledgerOf('/repo/src/twice.ts')?.additions, ledgerOf('/repo/src/twice.ts')?.edits], [2, 2])

      // One call, several FILES — a MultiEdit across files, a Codex multi-file
      // patch — arrives as N frames under ONE id. The key includes the path, so
      // every one of them folds.
      edits.length = 0
      runtime.ingestAgentStateFrame(
        frame({
          ts: base + 700,
          toolUseId: 'toolu_patch',
          fileChange: { path: '/repo/src/multi-a.ts', additions: 2, deletions: 0 },
        }),
      )
      runtime.ingestAgentStateFrame(
        frame({
          ts: base + 700,
          toolUseId: 'toolu_patch',
          fileChange: { path: '/repo/src/multi-b.ts', additions: 3, deletions: 0 },
        }),
      )
      assert.deepEqual(
        edits.map((edit) => edit.path),
        ['/repo/src/multi-a.ts', '/repo/src/multi-b.ts'],
        'one tool call, two files: the path is what separates them',
      )

      // A reporter with no id at all (Cursor's `afterFileEdit`) falls back to the
      // change's own shape inside a three-second window: a second identical frame
      // that fast is a second registration, not a second edit…
      edits.length = 0
      const idlessChange = { path: '/repo/src/idless.ts', additions: 5, deletions: 1 }
      runtime.ingestAgentStateFrame(frame({ ts: base + 800, fileChange: idlessChange }))
      runtime.ingestAgentStateFrame(frame({ ts: base + 900, fileChange: idlessChange }))
      assert.equal(edits.length, 1, 'two identical id-less frames 100ms apart are one edit reported twice')
      assert.deepEqual([ledgerOf('/repo/src/idless.ts')?.additions, ledgerOf('/repo/src/idless.ts')?.edits], [5, 1])

      // …while the same edit made again ten seconds later is a real one.
      runtime.ingestAgentStateFrame(frame({ ts: base + 10_900, fileChange: idlessChange }))
      assert.equal(edits.length, 2, 'ten seconds apart is a second edit, not a duplicate')
      assert.deepEqual([ledgerOf('/repo/src/idless.ts')?.additions, ledgerOf('/repo/src/idless.ts')?.edits], [10, 2])

      // MIXED: one registration forwards the tool-call id and the other does not
      // (a stale plugin copy from before the reporter carried ids — seen live).
      // The id-bearing frame stamps the shape too, so the id-less twin that
      // lands beside it is caught on the shape, in either order.
      edits.length = 0
      const mixedChange = { path: '/repo/src/mixed.ts', additions: 2, deletions: 2 }
      runtime.ingestAgentStateFrame(frame({ ts: base + 20_000, toolUseId: 'toolu_mixed', fileChange: mixedChange }))
      runtime.ingestAgentStateFrame(frame({ ts: base + 20_005, fileChange: mixedChange }))
      assert.equal(edits.length, 1, 'an id-less twin of an id-bearing frame is the same edit')
      runtime.ingestAgentStateFrame(
        frame({ ts: base + 21_000, fileChange: { ...mixedChange, path: '/repo/src/mixed2.ts' } }),
      )
      runtime.ingestAgentStateFrame(
        frame({
          ts: base + 21_004,
          toolUseId: 'toolu_mixed2',
          fileChange: { ...mixedChange, path: '/repo/src/mixed2.ts' },
        }),
      )
      assert.equal(edits.length, 2, 'and the other way round')
      assert.deepEqual([ledgerOf('/repo/src/mixed.ts')?.edits, ledgerOf('/repo/src/mixed2.ts')?.edits], [1, 1])

      // Exactly once, on the pty that died on its own.
      agentPty.emitExit({ exitCode: 0 })
      assert.deepEqual(exited, ['agent-changelists'], 'the agent’s list is marked exited once, on exit')
    } finally {
      runtime.ipcHandlers.killTerminal('sess-changelists-shell')
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function assertIngestAgentStateFrameUpdatesSession(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-ingest-'))
    mockPty.spawnCalls = []
    mockSender.sent = []

    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
      syncMcpConfig: async (): Promise<SyncResult> => ({ ok: true }),
    })

    const snapshotFor = (sessionId: string) =>
      runtime.ipcHandlers.listTerminals().find((session) => session.sessionId === sessionId)

    try {
      const spawn = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'sess-ingest',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-ingest',
        agentId: 'agent-ingest',
        agentName: 'Ingest',
      })
      assert.equal(spawn.ok, true, JSON.stringify(spawn))

      // Before any hook frame, an agent session exposes its lifecycle stamp —
      // `starting`, inferred — the one phase a fresh spawn can substantiate.
      // Nothing is guessed from output timing any more.
      const initial = snapshotFor('sess-ingest')
      assert.equal(initial?.agentState?.source, 'lifecycle')
      assert.equal(initial?.agentState?.phase, 'starting')

      // Timestamps are offsets on the spawn moment: the lifecycle stamp
      // (`starting`, since = spawn time) makes anything older a stale frame.
      const base = Date.now()
      const frame = (phase: string, ts: number) => ({
        type: 'agent_state' as const,
        agentId: 'agent-ingest',
        workspaceId: 'ws-ingest',
        sessionId: null,
        phase: phase as Parameters<typeof runtime.ingestAgentStateFrame>[0]['phase'],
        event: null,
        ts: base + ts,
      })

      // awaiting_input → recorded as hook phase, bridged activity reads idle.
      runtime.ingestAgentStateFrame(frame('awaiting_input', 1000))
      let snap = snapshotFor('sess-ingest')
      assert.equal(snap?.agentState?.phase, 'awaiting_input')
      assert.equal(snap?.agentState?.source, 'hook')
      assert.equal(snap?.agentState?.since, base + 1000)
      assert.equal(snap?.activity.kind, 'idle')

      // A stale (older-ts) frame must not roll the phase backward.
      runtime.ingestAgentStateFrame(frame('tool_use', 500))
      snap = snapshotFor('sess-ingest')
      assert.equal(snap?.agentState?.phase, 'awaiting_input', 'stale frame rolled the phase back')

      // A newer tool_use frame applies and bridges activity to working.
      runtime.ingestAgentStateFrame(frame('tool_use', 2000))
      snap = snapshotFor('sess-ingest')
      assert.equal(snap?.agentState?.phase, 'tool_use')
      assert.equal(snap?.activity.kind, 'working')
      assert.equal(
        snap?.activity.kind === 'working' ? snap.activity.since : -1,
        base + 2000,
        'working since anchors to the first working frame',
      )

      // Broadcast-storm guard: once "working", further within-working frames
      // (thinking ↔ tool_use) update the phase in place but must NOT re-broadcast,
      // and must preserve the working `since` so a "working for Xs" reading can
      // accumulate. The idle→working transition above already broadcast once;
      // these three churn frames must add zero broadcasts.
      const broadcastsBefore = mockSender.sent.filter((e) => e.channel === 'terminal:sessions-delta').length
      runtime.ingestAgentStateFrame(frame('thinking', 2001))
      runtime.ingestAgentStateFrame(frame('tool_use', 2002))
      runtime.ingestAgentStateFrame(frame('thinking', 2003))
      snap = snapshotFor('sess-ingest')
      assert.equal(snap?.agentState?.phase, 'thinking', 'phase tracks the latest within-working frame')
      assert.equal(snap?.agentState?.since, base + 2003)
      assert.equal(
        snap?.activity.kind === 'working' ? snap.activity.since : -1,
        base + 2000,
        'working since must be preserved across thinking ↔ tool_use churn',
      )
      const broadcastsAfter = mockSender.sent.filter((e) => e.channel === 'terminal:sessions-delta').length
      assert.equal(broadcastsAfter, broadcastsBefore, 'within-working churn must not re-broadcast')

      // Output arbitration: for a hook agent the output path must NOT override an
      // authoritative awaiting_input phase back to "working" — the permission
      // prompt's own bytes would otherwise fight the hook. Drive to awaiting_input,
      // emit output, and assert both the phase and the bridged activity hold.
      runtime.ingestAgentStateFrame(frame('awaiting_input', 3000))
      snap = snapshotFor('sess-ingest')
      assert.equal(snap?.activity.kind, 'idle', 'awaiting_input bridges to idle')
      const ptyProcess = mockPty.spawnCalls.at(-1)?.process
      assert.ok(ptyProcess, 'expected a spawned pty for the ingest session')
      ptyProcess?.emitData('Allow tool? (y/n) ')
      snap = snapshotFor('sess-ingest')
      assert.equal(snap?.agentState?.phase, 'awaiting_input', 'output must not change the authoritative phase')
      assert.equal(snap?.activity.kind, 'idle', 'output must not flip a hook awaiting_input agent to working')

      // …but the working frame that fires when the approved tool completes
      // (PostToolUse → thinking) DOES clear awaiting_input. This is the only
      // mid-turn clearer, which is why PostToolUse stays registered (see the
      // claude-code manifest's agentStateSpec); without it the "needs input"
      // signal would stay lit until Stop.
      runtime.ingestAgentStateFrame(frame('thinking', 3001))
      snap = snapshotFor('sess-ingest')
      assert.equal(snap?.agentState?.phase, 'thinking', 'a post-approval working frame must clear awaiting_input')
      assert.equal(snap?.activity.kind, 'working')

      // An unknown agent id is a safe no-op (no throw, nothing changed).
      runtime.ingestAgentStateFrame({
        type: 'agent_state',
        agentId: 'no-such-agent',
        workspaceId: 'ws-ingest',
        sessionId: null,
        phase: 'idle',
        event: null,
        ts: base + 3000,
      })
      snap = snapshotFor('sess-ingest')
      assert.equal(snap?.agentState?.phase, 'thinking', 'unknown-agent frame must not touch other sessions')

      // The CLI/harness session id the hook reports is captured onto the session
      // (distinct from our terminal id) so resume can target the conversation.
      // Routing is by the per-terminal agent id, so concurrent spawns can't
      // cross-assign it. (Frame ts must lead the prior applied frame.)
      assert.equal(snap?.cliSessionId, undefined, 'no cli session id before any hook reports one')
      runtime.ingestAgentStateFrame({
        type: 'agent_state',
        agentId: 'agent-ingest',
        workspaceId: 'ws-ingest',
        sessionId: 'codex-conv-abc123',
        phase: 'thinking',
        event: null,
        ts: base + 4000,
      })
      snap = snapshotFor('sess-ingest')
      assert.equal(snap?.cliSessionId, 'codex-conv-abc123', 'hook session_id is captured for resume')

      // On a real process exit the hook phase is cleared, so a stale working /
      // awaiting_input phase cannot outlive the pty and keep the attention glyph
      // lit. The snapshot then infers `exited` from the exit activity (source
      // 'lifecycle', not a stranded 'hook' awaiting_input).
      ptyProcess?.emitExit({ exitCode: 0 })
      snap = snapshotFor('sess-ingest')
      assert.equal(snap?.processAlive, false, 'exit marks the session not alive')
      assert.equal(snap?.activity.kind, 'exited', 'exit sets exited activity')
      assert.equal(snap?.agentState?.phase, 'exited', 'exit clears the hook phase to inferred exited')
      assert.equal(snap?.agentState?.source, 'lifecycle', 'post-exit phase is inferred from activity, not a stale hook')
    } finally {
      await runtime.shutdown()
    }
  }

  async function assertStandardAgentSpawnKeepsEnabledOptionalMcpSettings(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-standard-mcp-'))
    const syncInputs: SyncInput[] = []
    const mcpSettings = createOptionalMcpSettings()
    mockPty.spawnCalls = []
    mockSender.sent = []

    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
      syncMcpConfig: async (input): Promise<SyncResult> => {
        syncInputs.push(input)
        return { ok: true }
      },
    })

    try {
      const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'session_standard_optional_mcp',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        mcpSettings,
      })

      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(syncInputs.length, 1)
      assert.deepEqual(syncInputs[0]?.settings, mcpSettings)
      assert.equal(syncInputs[0]?.settings.servers.playwright?.enabled, true)
      assert.equal(mockPty.spawnCalls.length, 1)
    } finally {
      await runtime.shutdown()
    }
  }

  async function assertAgentSpawnReportsSyncFailureWithoutPtySpawn(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-failure-'))
    const failureMessage = 'MCP sync writer for format "generic" is not implemented yet; cannot launch an agent.'
    mockPty.spawnCalls = []
    mockSender.sent = []

    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
      syncMcpConfig: async (): Promise<SyncResult> => ({ ok: false, message: failureMessage }),
    })

    try {
      const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'session_failure',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        agentId: 'developer-1',
        cli: 'codex',
        kind: 'agent',
        shellOnly: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      const failedSnapshot = runtime.ipcHandlers
        .listTerminals()
        .find((session) => session.sessionId === 'session_failure')

      assert.deepEqual(result, {
        ok: false,
        sessionId: 'session_failure',
        message: failureMessage,
        exitCode: 1,
      })
      assert.equal(mockPty.spawnCalls.length, 0)
      assert.equal(failedSnapshot?.processAlive, false)
      assert.deepEqual(failedSnapshot?.activity, {
        kind: 'failed',
        at: failedSnapshot?.activity.kind === 'failed' ? failedSnapshot.activity.at : undefined,
        exitCode: 1,
        message: failureMessage,
      })
      assert.deepEqual(
        mockSender.sent.filter(
          (event) => event.channel.startsWith('terminal:error:') || event.channel.startsWith('terminal:exit:'),
        ),
        [
          { channel: 'terminal:error:session_failure', payload: failureMessage },
          { channel: 'terminal:exit:session_failure', payload: 1 },
        ],
      )
    } finally {
      await runtime.shutdown()
    }
  }

  function createOptionalMcpSettings(): McpSettings {
    return {
      syncEnabled: true,
      servers: {
        playwright: {
          id: 'playwright',
          name: 'Playwright',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@playwright/mcp@latest'],
          enabled: true,
          clients: ['codex', 'claude-code'],
          scope: 'workspace',
          source: 'bundled',
          riskLevel: 'local-command',
        },
        github: {
          id: 'github',
          name: 'GitHub',
          transport: 'http',
          url: 'https://api.githubcopilot.com/mcp/',
          enabled: true,
          clients: ['claude-code'],
          scope: 'workspace',
          source: 'custom',
          riskLevel: 'network',
        },
      },
    }
  }

  function createMockWebContents(): {
    isDestroyed(): boolean
    send(channel: string, payload: unknown): void
    sent: SentEvent[]
  } {
    return {
      sent: [],
      isDestroyed: () => false,
      send(channel: string, payload: unknown): void {
        this.sent.push({ channel, payload })
      },
    }
  }

  let nextMockPtyPid = 50_000

  function createMockPtyProcess(): MockPtyProcess {
    const dataCallbacks = new Set<(data: string) => void>()
    const exitCallbacks = new Set<(event: { exitCode: number; signal?: number }) => void>()
    return {
      pid: nextMockPtyPid++,
      writes: [],
      killed: false,
      pauses: 0,
      resumes: 0,
      pause(): void {
        this.pauses += 1
      },
      resume(): void {
        this.resumes += 1
      },
      write(data: string): void {
        this.writes.push(data)
      },
      resize: () => undefined,
      kill(): void {
        this.killed = true
      },
      onData(callback) {
        dataCallbacks.add(callback)
        return { dispose: () => dataCallbacks.delete(callback) }
      },
      onExit(callback) {
        exitCallbacks.add(callback)
        return { dispose: () => exitCallbacks.delete(callback) }
      },
      emitData(data: string): void {
        for (const callback of dataCallbacks) callback(data)
      },
      emitExit(event = { exitCode: 0 }): void {
        for (const callback of exitCallbacks) callback(event)
      },
    }
  }

  // Every selectable agent CLI reports lifecycle hooks now, and the spawn stamp
  // `starting` is a reaper-protected working phase — so tests put an agent at
  // rest the way production does: with an authoritative Stop frame.
  function markAgentAtRest(
    runtime: { ingestAgentStateFrame: (frame: AgentStateFrame) => void },
    agentId: string,
    workspaceId: string,
    ts = Date.now(),
  ): void {
    runtime.ingestAgentStateFrame({ type: 'agent_state', agentId, workspaceId, sessionId: null, event: 'Stop', ts })
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // spawnSkillId gates the skill install and connectorLaunch gates MCP isolation
  // — the worktree MCP-config git-exclude here (and the unlisted-server prune) —
  // and the two are orthogonal. A skill-only spawn must NOT exclude, a connector
  // launch excludes with or without a skill, and an ordinary spawn does neither.
  async function assertSpawnSkillInstallIsOrthogonalToMcpIsolation(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-connector-'))
    mockPty.spawnCalls = []
    mockSender.sent = []
    const ensureCalls: Array<{ workspaceRoot: string; skillId: string }> = []
    const excludeCalls: string[] = []

    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
      ensureBuiltinSkillInstalled: async (root, skillId) => {
        ensureCalls.push({ workspaceRoot: root, skillId })
      },
      excludeWorktreeMcpConfig: async (worktreePath) => {
        excludeCalls.push(worktreePath)
      },
    })

    const spawnConnector = async (
      sessionId: string,
      options: { spawnSkillId?: string; connectorLaunch?: boolean } = {},
    ): Promise<void> => {
      const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId,
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-connector',
        agentId: sessionId,
        visible: false,
        ...options,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
    }

    // Ordinary spawn: neither the connector install nor the MCP-config exclude
    // runs.
    await spawnConnector('session-connector-off')
    assert.deepEqual(ensureCalls, [], 'ordinary spawn must not install a skill')
    assert.deepEqual(excludeCalls, [], 'ordinary spawn must not exclude worktree MCP config')

    // A skill install without connectorLaunch (the composer's "+ Skill"
    // attachment) must not trigger MCP isolation — spawnSkillId never implies
    // pruning/excluding.
    await spawnConnector('session-connector-skill-only', { spawnSkillId: 'debug-helper' })
    assert.deepEqual(
      ensureCalls,
      [{ workspaceRoot, skillId: 'debug-helper' }],
      'skill-only spawn installs the named skill',
    )
    assert.deepEqual(excludeCalls, [], 'skill-only spawn must not exclude worktree MCP config')

    // A connector launch carrying a skill-at-spawn: install the skill AND exclude
    // the generated MCP config from the worktree git.
    await spawnConnector('session-connector-on', { spawnSkillId: 'debug-helper', connectorLaunch: true })
    assert.deepEqual(
      ensureCalls,
      [
        { workspaceRoot, skillId: 'debug-helper' },
        { workspaceRoot, skillId: 'debug-helper' },
      ],
      'connector spawn installs the named skill into the worktree before launch',
    )
    assert.deepEqual(excludeCalls, [workspaceRoot], 'connector spawn excludes the worktree MCP config from git')

    // A skill-less connector launch (plain installed MCP): no skill install, but
    // the MCP isolation still applies.
    await spawnConnector('session-connector-skillless', { connectorLaunch: true })
    assert.equal(ensureCalls.length, 2, 'skill-less connector launch installs no skill')
    assert.deepEqual(
      excludeCalls,
      [workspaceRoot, workspaceRoot],
      'skill-less connector launch still excludes the worktree MCP config',
    )
  }

  // On a fresh Mac every spawn produced a bare zsh prompt while the app
  // reported success: availability is probed through the user's interactive shell,
  // agents launch in a shell that never sources it, and the in-script guard echoed
  // and fell through. Both halves are asserted at the IPC the renderer calls.
  async function assertSpawnLaunchesProbedPathAndFailsHonestlyWhenAbsent(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-preflight-'))
    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })

    const spawn = (sessionId: string): Promise<TerminalSpawnResult> =>
      runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId,
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-preflight',
        agentId: sessionId,
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })

    try {
      // Absent binary: refused, with a message that names the CLI, and nothing
      // spawned — no bare shell, no `ok: true`.
      mockPty.spawnCalls = []
      pinAgentCliPreflight(runtimeModule, { installed: false })
      const missing = await spawn('session-preflight-missing')
      assert.equal(missing.ok, false, 'an absent CLI must not report a successful start')
      assert.equal(mockPty.spawnCalls.length, 0, 'an absent CLI must not spawn a pty at all')
      if (missing.ok) return
      assert.equal(missing.sessionId, 'session-preflight-missing')
      assert.equal(missing.exitCode, 127)
      assert.match(missing.message, /Claude Code/, 'the failure names the CLI the user picked')

      // Installed: the probe's absolute path is what the launch script executes —
      // both in the guard and in the invocation.
      mockPty.spawnCalls = []
      const probedPath = '/Users/dev/.nvm/versions/node/v22.3.0/bin/claude'
      pinAgentCliPreflight(runtimeModule, { installed: true, resolvedPath: probedPath })
      const started = await spawn('session-preflight-resolved')
      assert.equal(started.ok, true, JSON.stringify(started))
      assert.equal(mockPty.spawnCalls.length, 1)
      const startupScript = await readFile(String(mockPty.spawnCalls[0].args.at(-1)), 'utf8')
      assert.ok(
        startupScript.includes(`if ! command -v ${probedPath} >/dev/null 2>&1;`),
        `the guard must test the probed path: ${startupScript}`,
      )
      assert.ok(
        // An unnamed preset passes no permission flag, so the binary is
        // followed directly by the launch's own flags. An agent bound to a
        // workspace also carries its host context (the editor tools section)
        // as a file flag before the session id.
        new RegExp(`${probedPath} (--append-system-prompt-file \\S+ )?--session-id session-preflight-resolved`).test(
          startupScript,
        ),
        `the launch must execute the probed path: ${startupScript}`,
      )
      assert.ok(
        /exit 127; fi;/.test(startupScript),
        `the guard must exit rather than fall through to the shell exec: ${startupScript}`,
      )
      runtime.ipcHandlers.killTerminal('session-preflight-resolved')
    } finally {
      runtimeModule.__setAgentCliPreflightForTest({
        platform: 'darwin',
        shell: '/bin/zsh',
        deps: { listEntries: () => [] },
      })
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // An omitted `cli` defaulted to codex, so a payload that named no agent launched
  // a different one and reported success. Shell-only terminals legitimately carry
  // no CLI and must still spawn.
  async function assertSpawnWithoutCliRefusesInsteadOfDefaultingToCodex(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-nocli-'))
    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })
    mockPty.spawnCalls = []

    try {
      const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'session-no-cli',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-no-cli',
        agentId: 'session-no-cli',
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, false, 'an agent spawn naming no CLI must not start one')
      assert.equal(mockPty.spawnCalls.length, 0, 'nothing is spawned, least of all codex')

      // The legitimate CLI-less spawn still works.
      const shell = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'session-plain-shell',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        kind: 'terminal',
        shellOnly: true,
        visible: false,
      })
      assert.equal(shell.ok, true, JSON.stringify(shell))
      assert.equal(mockPty.spawnCalls.length, 1)
      runtime.ipcHandlers.killTerminal('session-plain-shell')
    } finally {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // Pull requests come only from branch lookups (owner ruling 2026-10-03): the
  // runtime tells the app where an agent is each time git answers for it, and a
  // turn end says so even when nothing moved, because that is when a pull
  // request the turn opened can be found. A `pullRequest` an older reporter
  // still puts on a frame reaches nothing.
  async function assertObservedCheckoutReachesThePullRequestSeam(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-pr-seam-'))
    mockPty.spawnCalls = []
    mockSender.sent = []
    const resolutions: Array<{ sessionId: string; branch: string | null; fresh: boolean }> = []
    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
      resolveObservedCheckout: async () => ({
        gitRoot: workspaceRoot,
        repoRoot: workspaceRoot,
        branch: 'agent/feature',
        isLinkedWorktree: false,
      }),
      onObservedCheckoutResolved: (session, resolution) =>
        resolutions.push({
          sessionId: session.sessionId,
          branch: session.observedCheckout?.branch ?? null,
          fresh: resolution.fresh,
        }),
    })
    try {
      const spawnResult = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'session-pr-seam',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'claude-code',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-pr-seam',
        agentId: 'agent-pr-seam',
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(spawnResult.ok, true, JSON.stringify(spawnResult))
      const base = Date.now()
      const frame = (overrides: Partial<AgentStateFrame>): AgentStateFrame => ({
        type: 'agent_state',
        agentId: 'agent-pr-seam',
        workspaceId: 'ws-pr-seam',
        sessionId: null,
        event: 'PostToolUse',
        ts: base,
        ...overrides,
      })
      const waitFor = async (predicate: () => boolean): Promise<void> => {
        const start = Date.now()
        while (!predicate()) {
          if (Date.now() - start > 5_000) throw new Error('timed out waiting for a checkout resolution')
          await delay(20)
        }
      }
      runtime.ingestAgentStateFrame(frame({ ts: base + 100, cwd: workspaceRoot }))
      await waitFor(() => resolutions.length >= 1)
      assert.deepEqual(resolutions[0], { sessionId: 'session-pr-seam', branch: 'agent/feature', fresh: true })
      // A turn end on the same branch: nothing moved, and the seam still hears it.
      runtime.ingestAgentStateFrame(
        frame({
          ts: base + 200,
          event: 'Stop',
          pullRequest: { url: 'https://github.com/acme/app/pull/4' },
        } as Partial<AgentStateFrame>),
      )
      await waitFor(() => resolutions.length >= 2)
      assert.deepEqual(resolutions[1], { sessionId: 'session-pr-seam', branch: 'agent/feature', fresh: true })
      const snapshot = runtime.ipcHandlers.listTerminals().find((entry) => entry.sessionId === 'session-pr-seam')
      assert.deepEqual(snapshot?.pullRequests ?? [], [], 'a URL on a frame files nothing')
    } finally {
      runtime.ipcHandlers.killTerminal('session-pr-seam')
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // Hooks-only selectability (decision of record 2026-08-31): the terminal spawn
  // is the LAST door, so a known plugin without an agentStateSpec (muse — its
  // beta cannot deliver hooks) is refused here even if every upstream gate
  // missed. An id the registry does not know at all still falls through to the
  // launch render's own unknown-plugin error.
  async function assertSpawnRefusesAgentCliWithoutAgentStateSpec(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-nohooks-'))
    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })
    mockPty.spawnCalls = []

    try {
      const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'session-muse-agent',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'muse',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-muse',
        agentId: 'session-muse-agent',
        visible: false,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, false, 'a hook-incapable CLI must not spawn as an agent')
      assert.match(
        !result.ok ? (result.message ?? '') : '',
        /cannot report agent status/,
        'the refusal names the reason, never silently substitutes',
      )
      assert.equal(mockPty.spawnCalls.length, 0, 'nothing is spawned for a refused CLI')
    } finally {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  const PASTE_START = '\x1b[200~'
  const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  // Kimi Code takes no first message on its command line, so the launch types it
  // in: once, and only once the composer is on screen. Its bracketed-paste mode
  // turns on for the trust dialog first, whose selected choice is Trust, so that
  // signal alone must type nothing.
  async function assertSendAfterReadyTypesTheFirstMessageOnce(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-send-after-ready-'))
    mockPty.spawnCalls = []
    mockSender.sent = []
    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })
    try {
      const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'session-kimi-first-message',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'kimi-code',
        initialPrompt: 'Summarise the README',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-kimi',
        agentId: 'agent-kimi',
        visible: true,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      const pty = mockPty.spawnCalls[0]?.process
      assert.ok(pty)
      const script = await readFile(String(mockPty.spawnCalls[0]?.args.at(-1)), 'utf8')
      assert.ok(!script.includes('Summarise the README'), 'the message is not on the command line')
      assert.ok(script.includes("KIMI_CODE_NO_AUTO_UPDATE='1' kimi"), script.slice(-400))
      assert.ok(script.includes('sprintengine-cli-exited'), 'the launch says when its CLI exits')

      pty.emitData('\x1b[?2004h Trust this folder?')
      await settle(800)
      assert.equal(pty.writes.length, 0, 'bracketed paste on a dialog is not the composer')

      pty.emitData('\x1b[38;2;224;224;224mcontext: 0%\x1b[39m')
      await settle(1_000)
      const pastes = pty.writes.filter((data) => data.startsWith(PASTE_START))
      assert.deepEqual(pastes, [`${PASTE_START}Summarise the README\x1b[201~`])
      assert.equal(pty.writes.filter((data) => data === '\r').length, 1, 'one Enter')

      // Anything the CLI says afterwards, a hook frame included, types nothing more.
      pty.emitData('context: 0%\x1b[?2004h')
      runtime.ingestAgentStateFrame({
        type: 'agent_state',
        agentId: 'agent-kimi',
        workspaceId: 'ws-kimi',
        sessionId: null,
        phase: 'thinking',
        event: 'UserPromptSubmit',
        ts: Date.now(),
      })
      await settle(800)
      assert.equal(pty.writes.filter((data) => data.startsWith(PASTE_START)).length, 1, 'delivered exactly once')
      assert.ok(!mockSender.sent.some((event) => event.channel === 'terminal:prompt-undelivered'))
    } finally {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  // A first message that could not be typed is handed back to the window, not
  // only logged: a CLI that exited first gets nothing typed after it (the shell
  // it leaves behind would run the text), and a composer that never appeared
  // gets nothing typed into whatever is there instead.
  async function assertUndeliveredFirstMessageIsHandedBack(runtimeModule: RuntimeModule): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-runtime-undelivered-'))
    mockPty.spawnCalls = []
    mockSender.sent = []
    const logged: string[] = []
    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
      logDiagnostic: (diagnostic) => logged.push(`${diagnostic.title}: ${diagnostic.message} ${diagnostic.details}`),
    })
    try {
      const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
        sessionId: 'session-kimi-exits',
        cols: 120,
        rows: 30,
        cwd: workspaceRoot,
        cli: 'kimi-code',
        initialPrompt: 'Refactor the parser',
        kind: 'agent',
        shellOnly: false,
        workspaceId: 'ws-kimi',
        agentId: 'agent-kimi-exits',
        agentName: 'Iris',
        visible: true,
        mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      const pty = mockPty.spawnCalls[0]?.process
      assert.ok(pty)

      // The person chose "Don't trust": Kimi exits and the startup script says
      // so before the interactive shell draws its own prompt.
      pty.emitData('\x1b[?2004h Trust this folder?')
      pty.emitData('\x1b]6973;sprintengine-cli-exited\x07')
      pty.emitData('\x1b[?2004h% ')
      pty.emitData('context: 0%')
      await settle(1_000)
      assert.equal(pty.writes.length, 0, 'nothing is typed into the shell the CLI left behind')

      const nudges = mockSender.sent.filter((event) => event.channel === 'terminal:prompt-undelivered')
      assert.equal(nudges.length, 1, 'the window is told there is something to take')
      assert.deepEqual(runtime.ipcHandlers.takeUndeliveredPrompts(), [
        {
          sessionId: 'session-kimi-exits',
          workspaceId: 'ws-kimi',
          agentId: 'agent-kimi-exits',
          agentName: 'Iris',
          cli: 'kimi-code',
          text: 'Refactor the parser',
          reason: 'exited',
        },
      ])
      assert.deepEqual(runtime.ipcHandlers.takeUndeliveredPrompts(), [], 'taken once, by one window')
      assert.equal(logged.length, 1)
      assert.ok(!logged[0]?.includes('Refactor the parser'), 'the log records that it happened, not the text')

      // With no window open (an automation, background mode) it waits in main
      // for the next window, and what comes back is what the person wrote.
      mockPty.spawnCalls = []
      mockSender.sent = []
      await withNoWindows(async () => {
        const headless = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
          sessionId: 'session-kimi-headless',
          cols: 120,
          rows: 30,
          cwd: workspaceRoot,
          cli: 'kimi-code',
          initialPrompt: 'Write the release notes',
          kind: 'agent',
          shellOnly: false,
          workspaceId: 'ws-kimi',
          agentId: 'agent-kimi-headless',
          visible: false,
          mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
        })
        assert.equal(headless.ok, true, JSON.stringify(headless))
        const headlessPty = mockPty.spawnCalls[0]?.process
        assert.ok(headlessPty)
        headlessPty.emitData('\x1b]6973;sprintengine-cli-exited\x07')
      })
      assert.equal(mockSender.sent.filter((event) => event.channel === 'terminal:prompt-undelivered').length, 0)
      const queued = runtime.ipcHandlers.takeUndeliveredPrompts()
      assert.deepEqual(
        queued.map((event) => [event.sessionId, event.text, event.reason]),
        [['session-kimi-headless', 'Write the release notes', 'exited']],
      )
    } finally {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})

test('the reap sweep runs every tick while focused, and one in a few while no window is', async () => {
  const { reapSweepTick, UNFOCUSED_REAP_SWEEP_EVERY } = await import('./terminal-runtime')
  const runs = (focus: boolean[]) => {
    let skipped = 0
    return focus.map((focused) => {
      const tick = reapSweepTick(focused, skipped)
      skipped = tick.skipped
      return tick.run
    })
  }
  assert.deepEqual(runs([true, true, true]), [true, true, true])
  const away = Array.from({ length: UNFOCUSED_REAP_SWEEP_EVERY * 2 }, () => false)
  const ran = runs(away)
  assert.equal(ran.filter(Boolean).length, 2)
  assert.equal(ran.at(-1), true)
  // Focus coming back runs at once, and the count starts over.
  assert.deepEqual(runs([false, true, false]), [false, true, false])
})
