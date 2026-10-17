import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { connect, createServer, type Server } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PluginAgentStateSpec } from '../shared/plugin-manifest'
import { studioEnvEntry } from '../shared/studio-env'
import { parseAgentStateFrame, type AgentStateFrame } from './agent-state'
import { readOpenedPullRequest } from '../shared/git/pull-request-opened'
import { createAgentStateService, resolveAgentStateSocketPath } from './agent-state-service'
import { localLauncherRef } from './integrations/launcher'
import { test } from 'vitest'

test('agent-state-service', async () => {
  // The service resolves a CLI's spec from its plugin manifest; the tests feed it
  // the REAL bundled manifest data so the install targets under test are the
  // shipped ones.
  const bundledSpecs = new Map<string, PluginAgentStateSpec>()

  async function loadBundledSpecs(): Promise<void> {
    for (const id of ['claude-code', 'codex', 'grok', 'opencode', 'kimi-code']) {
      const manifestPath = join(process.cwd(), 'resources', 'plugins', id, 'plugin.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { agentStateSpec?: PluginAgentStateSpec }
      assert.ok(manifest.agentStateSpec, `${id} manifest must declare agentStateSpec`)
      bundledSpecs.set(id, manifest.agentStateSpec)
    }
  }

  const resolveSpec = (cli: string): PluginAgentStateSpec | null => bundledSpecs.get(cli) ?? null

  function writeLine(socketPath: string, line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath)
      socket.on('error', reject)
      socket.on('connect', () => {
        socket.write(line, () => socket.end())
      })
      socket.on('close', () => resolve())
    })
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now()
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  async function run(): Promise<void> {
    await loadBundledSpecs()

    // --- socket path resolution --------------------------------------------
    if (process.platform !== 'win32') {
      assert.equal(resolveAgentStateSocketPath('/short/dir'), '/short/dir/agent-state.sock')
      // A long userData dir falls back to the temp dir (POSIX sun_path limit).
      const long = '/' + 'x'.repeat(120)
      assert.match(resolveAgentStateSocketPath(long), /agent-state-[0-9a-f]{12}\.sock$/)
    }

    // --- socket round-trip: valid frame in, malformed dropped --------------
    const userDataDir = await mkdtemp(join(tmpdir(), 'se-agent-state-svc-'))
    const received: AgentStateFrame[] = []
    const service = createAgentStateService({
      resolveUserDataDir: () => userDataDir,
      resolveAgentStateSpec: resolveSpec,
      resolveReporterScriptPath: () => null,
      resolveReporterTemplatePath: () => null,
      onFrame: (frame) => received.push(frame),
      now: () => 4242,
    })
    await service.initialize()
    assert.equal(service.isRunning(), true)

    const socketPath = service.getSocketPath()
    // Malformed line is dropped silently; a valid frame is parsed and delivered.
    await writeLine(socketPath, 'not json\n')
    await writeLine(
      socketPath,
      JSON.stringify({
        type: 'agent_state',
        agentId: 'a1',
        workspaceId: 'w1',
        phase: 'tool_use',
        event: 'PreToolUse',
      }) + '\n',
    )
    await waitFor(() => received.length >= 1)
    assert.equal(received.length, 1)
    assert.equal(received[0].agentId, 'a1')
    assert.equal(received[0].phase, 'tool_use')
    // ts defaulted via the injected clock since the frame omitted it.
    assert.equal(received[0].ts, 4242)

    // A frame with an invalid phase is rejected by validation, not delivered.
    await writeLine(socketPath, JSON.stringify({ type: 'agent_state', agentId: 'a1', phase: 'bogus' }) + '\n')
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(received.length, 1)

    await service.shutdown()
    assert.equal(service.isRunning(), false)

    // --- install: serialized + run once per workspace ----------------------
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'se-agent-state-ws-'))
    const reporterSrc = join(workspaceRoot, 'reporter-src.mjs')
    await writeFile(reporterSrc, '// reporter\n', 'utf8')

    const opencodeReporterSrc = join(workspaceRoot, 'opencode-reporter-src.mjs')
    await writeFile(opencodeReporterSrc, "const BAKED = '__SPRINTENGINE_AGENT_STATE_SOCKET__'\n", 'utf8')

    let resolveCalls = 0
    let templateResolveCalls = 0
    let lastTemplateName: string | null = null
    const testHome = join(workspaceRoot, 'home')
    const installSvc = createAgentStateService({
      resolveUserDataDir: () => userDataDir,
      resolveHomeDir: () => testHome,
      resolveAgentStateSpec: resolveSpec,
      resolveReporterScriptPath: () => {
        resolveCalls += 1
        return reporterSrc
      },
      resolveReporterTemplatePath: (template) => {
        templateResolveCalls += 1
        lastTemplateName = template
        return opencodeReporterSrc
      },
      onFrame: () => {},
    })

    // A CLI with no agentStateSpec installs nothing — it cannot report state.
    await installSvc.installForWorkspace(workspaceRoot, 'muse')
    await installSvc.installForWorkspace(workspaceRoot, 'generic-shell')
    assert.equal(resolveCalls, 0, 'a spec-less CLI must not resolve a reporter')
    assert.equal(templateResolveCalls, 0)

    // Two concurrent claude-code installs for the same workspace must collapse to
    // a single real install (serialized chain + install-once guard).
    await Promise.all([
      installSvc.installForWorkspace(workspaceRoot, 'claude-code'),
      installSvc.installForWorkspace(workspaceRoot, 'claude-code'),
    ])
    assert.equal(resolveCalls, 1)
    // A later claude-code install is a no-op too.
    await installSvc.installForWorkspace(workspaceRoot, 'claude-code')
    assert.equal(resolveCalls, 1)

    const settings = JSON.parse(await readFile(join(workspaceRoot, '.claude', 'settings.local.json'), 'utf8')) as {
      hooks?: Record<string, unknown>
    }
    assert.ok(settings.hooks?.SessionStart, 'reporter hook not installed')
    assert.ok(settings.hooks?.PostToolUse, 'PostToolUse hook (awaiting-input clearer) not installed')
    assert.ok(!settings.hooks?.PreToolUse, 'PreToolUse must not be installed (trimmed)')

    // Codex in the SAME workspace is a distinct install (different file + key),
    // so it runs once more and writes the TOML target, not the JSON one.
    await installSvc.installForWorkspace(workspaceRoot, 'codex')
    assert.equal(resolveCalls, 2)

    // The same workspace can switch from a native Windows launch to WSL. The
    // execution style is part of the install key, so the second launch heals
    // the command instead of reusing a Windows-only invocation. In WSL the hook
    // runs the distribution's own Studio launcher and reports to the helper's
    // Unix socket. Nothing is a Windows program, so nothing needs interop or
    // WSLENV.
    const wslRoot = await mkdtemp(join(tmpdir(), 'se-agent-state-wsl-'))
    const wslWarnings: string[] = []
    const wslSvc = createAgentStateService({
      resolveUserDataDir: () => userDataDir,
      resolveHomeDir: () => join(wslRoot, 'native-home'),
      resolveAgentStateSpec: resolveSpec,
      resolveReporterScriptPath: () => reporterSrc,
      resolveReporterTemplatePath: () => null,
      onFrame: () => {},
      logDiagnostic: (diagnostic) => wslWarnings.push(diagnostic.details ?? diagnostic.message),
    })
    await wslSvc.installForWorkspace(wslRoot, 'codex', { pathStyle: 'windows' })
    let wslConfig = await readFile(join(wslRoot, '.codex', 'config.toml'), 'utf8')
    const nativeLauncher = localLauncherRef(join(wslRoot, 'native-home')).path
    assert.ok(wslConfig.includes(nativeLauncher), 'native launch runs this machine’s launcher')
    await wslSvc.installForWorkspace(wslRoot, 'codex', { pathStyle: 'wsl', hostId: 'wsl:Ubuntu', integration: null })
    assert.ok(
      (await readFile(join(wslRoot, '.codex', 'config.toml'), 'utf8')).includes(nativeLauncher),
      'without the helper nothing is written for WSL',
    )
    assert.ok(wslWarnings.some((line) => line.includes('WSL helper was not running')))
    const node = '/home/dev/.local/share/sprintengine-studio/runtime/node-v24.21.0/bin/node'
    await wslSvc.installForWorkspace(wslRoot, 'codex', {
      pathStyle: 'wsl',
      hostId: 'wsl:Ubuntu',
      integration: {
        agentStateSocketPath: '/run/user/1000/sprintengine/abc123def456/agent.sock',
        commandRuntime: {
          executable: node,
          toCommandPath: (nativePath) => nativePath.replace(wslRoot, '/home/dev/repo').split('\\').join('/'),
          launcher: { path: '/home/dev/.sprintengine/bin/studio-run', shell: 'posix' },
        },
        pluginDirs: [],
        statusLineScriptPath: null,
        studioMcpEntry: { command: node, args: [], env: {} },
        home: { host: '/home/dev', native: wslRoot },
      },
    })
    wslConfig = await readFile(join(wslRoot, '.codex', 'config.toml'), 'utf8')
    assert.ok(
      wslConfig.includes(
        `/bin/sh '/home/dev/.sprintengine/bin/studio-run' agent-state --socket '/run/user/1000/sprintengine/abc123def456/agent.sock'`,
      ),
      `the WSL hook runs the distribution's launcher and reports to the helper: ${wslConfig}`,
    )
    assert.ok(!wslConfig.includes(node), 'no hook names the pinned Node, which a Node update moves')
    assert.doesNotMatch(wslConfig, /WSLENV|ELECTRON_RUN_AS_NODE|\/mnt\//u, 'nothing crosses back into Windows')
    const codexConfig = await readFile(join(workspaceRoot, '.codex', 'config.toml'), 'utf8')
    assert.ok(codexConfig.includes('[[hooks.SessionStart]]'), 'codex reporter hook not installed')
    // …and is itself install-once.
    await installSvc.installForWorkspace(workspaceRoot, 'codex')
    assert.equal(resolveCalls, 2)

    // Grok shares the claude/codex stdin reporter but writes a standalone JSON
    // config into the home's .grok/hooks/ (the TUI takes no hook at launch), and
    // takes back out the copy an earlier build wrote into the workspace.
    await mkdir(join(workspaceRoot, '.grok', 'hooks'), { recursive: true })
    await writeFile(
      join(workspaceRoot, '.grok', 'hooks', 'sprintengine-agent-state.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: "/bin/sh '/Users/dev/.sprintengine/bin/studio-run' agent-state --socket '/x.sock'",
                },
              ],
            },
          ],
        },
      }),
      'utf8',
    )
    await installSvc.installForWorkspace(workspaceRoot, 'grok')
    assert.equal(resolveCalls, 3)
    assert.ok(
      !existsSync(join(workspaceRoot, '.grok', 'hooks', 'sprintengine-agent-state.json')),
      'the workspace copy an earlier build wrote is removed',
    )
    const grokHooksConfig = JSON.parse(
      await readFile(join(testHome, '.grok', 'hooks', 'sprintengine-agent-state.json'), 'utf8'),
    ) as { hooks?: Record<string, unknown> }
    assert.ok(grokHooksConfig.hooks?.SessionStart, 'grok reporter hook not installed')
    assert.ok(!grokHooksConfig.hooks?.PreToolUse, 'PreToolUse must not be installed for grok (trimmed)')
    // …and is itself install-once.
    await installSvc.installForWorkspace(workspaceRoot, 'grok')
    assert.equal(resolveCalls, 3)

    // OpenCode in the SAME workspace resolves the plugin-file TEMPLATE its
    // manifest names and writes an in-process plugin (.js) with the live socket
    // baked in — not the shared stdin reporter.
    await installSvc.installForWorkspace(workspaceRoot, 'opencode')
    assert.equal(templateResolveCalls, 1)
    assert.equal(lastTemplateName, 'opencode-agent-state.mjs', 'template name comes from the manifest registration')
    assert.equal(resolveCalls, 3, 'opencode must not consume the shared stdin reporter resolver')
    const opencodePlugin = await readFile(
      join(workspaceRoot, '.opencode', 'plugin', 'sprintengine-agent-state.js'),
      'utf8',
    )
    assert.ok(
      opencodePlugin.includes(JSON.stringify(installSvc.getSocketPath())),
      'opencode plugin missing baked socket path',
    )
    assert.ok(
      !opencodePlugin.includes("'__SPRINTENGINE_AGENT_STATE_SOCKET__'"),
      'opencode socket token left unsubstituted',
    )
    // …and is install-once.
    await installSvc.installForWorkspace(workspaceRoot, 'opencode')
    assert.equal(templateResolveCalls, 1)

    // --- a launch-injected CLI installs nothing ------------------------------
    // Claude Code is handed this app's plugin directories on its command line, so
    // the workspace must receive no reporter copy and no hook entry: a second
    // registration fires the reporter twice for every event, and the files would
    // be left behind in someone's repository for a colleague to inherit.
    const injectedRoot = await mkdtemp(join(tmpdir(), 'se-agent-state-injected-'))
    let injectedResolveCalls = 0
    const injectedSvc = createAgentStateService({
      resolveUserDataDir: () => userDataDir,
      resolveAgentStateSpec: resolveSpec,
      resolveReporterScriptPath: () => {
        injectedResolveCalls += 1
        return reporterSrc
      },
      resolveReporterTemplatePath: () => opencodeReporterSrc,
      resolveLaunchInjectsPlugins: (cli) => cli === 'claude-code',
      onFrame: () => {},
    })
    await injectedSvc.installForWorkspace(injectedRoot, 'claude-code')
    assert.equal(injectedResolveCalls, 0, 'a launch-injected CLI must not resolve a reporter')
    assert.equal(
      await readFile(join(injectedRoot, '.claude', 'settings.local.json'), 'utf8').catch(() => null),
      null,
      'and must write nothing into the workspace',
    )

    // A CLI the launch does not inject still installs, so the predicate can never
    // quietly turn agent state off for everything.
    await injectedSvc.installForWorkspace(injectedRoot, 'codex')
    assert.equal(injectedResolveCalls, 1)
    const injectedCodexConfig = await readFile(join(injectedRoot, '.codex', 'config.toml'), 'utf8').catch(() => null)
    assert.ok(injectedCodexConfig?.includes('[[hooks.SessionStart]]'), 'codex still gets its workspace install')

    // --- user-scoped registration: per-CLI install-once, injected home -------
    // Kimi's config is user-global, so the install key is independent of the
    // workspace: the first workspace's launch writes it, a second workspace's
    // launch is a no-op (the content is workspace-independent), and nothing
    // touches the real home because the test injects resolveHomeDir.
    const userScopeHome = await mkdtemp(join(tmpdir(), 'se-agent-state-home-'))
    const wsA = await mkdtemp(join(tmpdir(), 'se-agent-state-wsA-'))
    const wsB = await mkdtemp(join(tmpdir(), 'se-agent-state-wsB-'))
    let userScopeResolves = 0
    const userScopeSvc = createAgentStateService({
      resolveUserDataDir: () => userDataDir,
      resolveAgentStateSpec: resolveSpec,
      resolveReporterScriptPath: () => {
        userScopeResolves += 1
        return reporterSrc
      },
      resolveReporterTemplatePath: () => null,
      resolveHomeDir: () => userScopeHome,
      onFrame: () => {},
    })
    await userScopeSvc.installForWorkspace(wsA, 'kimi-code')
    assert.equal(userScopeResolves, 1)
    const kimiConfigOnDisk = await readFile(join(userScopeHome, '.kimi-code', 'config.toml'), 'utf8')
    assert.ok(kimiConfigOnDisk.includes('event = "Stop"'), 'kimi hooks block not installed under injected home')
    await userScopeSvc.installForWorkspace(wsB, 'kimi-code')
    assert.equal(userScopeResolves, 1, 'user-scoped install must be once per CLI, not per workspace')
    // It applies to every Kimi session on the machine, and only sessions the
    // app launched report through it — all of which end with the app. So quit
    // takes it back out, leaving the rest of the person's config as it was.
    await writeFile(
      join(userScopeHome, '.kimi-code', 'config.toml'),
      `default_model = "k2"\n\n${kimiConfigOnDisk}`,
      'utf8',
    )
    await userScopeSvc.shutdown()
    assert.equal(
      await readFile(join(userScopeHome, '.kimi-code', 'config.toml'), 'utf8'),
      'default_model = "k2"\n',
      'the user-level hook block is removed at quit',
    )

    // --- missing reporter script: safe no-op, never throws -----------------
    const noScriptWs = await mkdtemp(join(tmpdir(), 'se-agent-state-noscript-'))
    const noScriptSvc = createAgentStateService({
      resolveUserDataDir: () => userDataDir,
      resolveAgentStateSpec: resolveSpec,
      resolveReporterScriptPath: () => null,
      resolveReporterTemplatePath: () => null,
      onFrame: () => {},
    })
    await noScriptSvc.installForWorkspace(noScriptWs, 'claude-code') // must not throw
    await noScriptSvc.installForWorkspace(noScriptWs, 'opencode') // must not throw

    // --- reporter socket precedence: launch env wins over the baked arg ----
    // Executes the REAL bundled reporter script. The env address is injected
    // per-process by the launching instance; the --socket arg is baked into the
    // repo-shared settings.local.json, which another app instance may have
    // rewritten (last-writer-wins) — so env must win, arg is the fallback for
    // sessions launched outside the app.
    if (process.platform !== 'win32') {
      const reporterScript = join(process.cwd(), 'resources', 'hooks', 'sprintengine-agent-state.mjs')
      const sockDir = await mkdtemp(join(tmpdir(), 'se-agent-state-prec-'))

      const listenLines = async (socketPath: string, sink: string[]): Promise<Server> => {
        const server = createServer((socket) => {
          socket.setEncoding('utf8')
          // A frame longer than one chunk (a forwarded tool call's output)
          // arrives in pieces: lines are cut at their newline, not the chunk.
          let pending = ''
          socket.on('data', (chunk: string) => {
            const lines = (pending + chunk).split('\n')
            pending = lines.pop() ?? ''
            sink.push(...lines.filter(Boolean))
          })
          socket.on('end', () => {
            if (pending) sink.push(pending)
          })
        })
        await new Promise<void>((resolve, reject) => {
          server.on('error', reject)
          server.listen(socketPath, resolve)
        })
        return server
      }

      const runReporter = (
        envSocket: string | undefined,
        argSocket: string,
        payload: Record<string, unknown> = { hook_event_name: 'Stop', session_id: 'prec-session' },
      ): Promise<void> =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [reporterScript, '--socket', argSocket], {
            env: {
              ...process.env,
              // Always override: when this test itself runs inside a studio
              // agent session, the launch env carries the LIVE app's socket —
              // inheriting it would silently redirect the "fallback" run to the
              // real app. Empty string is falsy, so the reporter falls to --socket.
              // Both spellings: the reporter reads SPRINTENGINE_* first.
              ...studioEnvEntry('SPRINTENGINE_AGENT_ID', 'prec-agent'),
              ...studioEnvEntry('SPRINTENGINE_WORKSPACE_ID', 'prec-ws'),
              ...studioEnvEntry('SPRINTENGINE_AGENT_STATE_SOCKET', envSocket ?? ''),
            },
            stdio: ['pipe', 'ignore', 'ignore'],
          })
          child.on('error', reject)
          child.on('exit', () => resolve())
          child.stdin.end(JSON.stringify(payload))
        })

      const envSockPath = join(sockDir, 'env-instance.sock')
      const argSockPath = join(sockDir, 'arg-instance.sock')
      const envFrames: string[] = []
      const argFrames: string[] = []
      const envServer = await listenLines(envSockPath, envFrames)
      const argServer = await listenLines(argSockPath, argFrames)

      await runReporter(envSockPath, argSockPath)
      await waitFor(() => envFrames.length >= 1)
      assert.equal(argFrames.length, 0, 'env address set: baked --socket must receive nothing')
      const envFrame = JSON.parse(envFrames[0]) as { phase?: string; event?: string; agentId?: string }
      assert.equal(envFrame.phase, undefined, 'the reporter must not assert a phase (main maps via the manifest)')
      assert.equal(envFrame.event, 'Stop')
      assert.equal(envFrame.agentId, 'prec-agent')

      await runReporter(undefined, argSockPath)
      await waitFor(() => argFrames.length >= 1)
      assert.equal(envFrames.length, 1, 'no env address: frame falls back to the baked --socket')

      envServer.close()
      argServer.close()

      // --- reporter bounded retry -------------------------------------------
      // First attempt fails (no listener yet: ENOENT fast-fail), the listener
      // appears during the ~200ms backoff, and the retry delivers the frame.
      const lateSockPath = join(sockDir, 'late-instance.sock')
      const lateFrames: string[] = []
      const reporterRun = runReporter(lateSockPath, join(sockDir, 'never-exists.sock'))
      await new Promise((r) => setTimeout(r, 80))
      const lateServer = await listenLines(lateSockPath, lateFrames)
      await reporterRun
      await waitFor(() => lateFrames.length >= 1)
      const lateFrame = JSON.parse(lateFrames[0]) as { event?: string }
      assert.equal(lateFrame.event, 'Stop', 'retry delivered the Stop frame once the listener appeared')
      lateServer.close()

      // Permanently dead socket: still exits 0 (never throws into the CLI) and
      // stays well inside the bounded deadline (fast connect failures + backoff,
      // not the full per-attempt timeout).
      const deadStart = Date.now()
      await runReporter(join(sockDir, 'gone-a.sock'), join(sockDir, 'gone-b.sock'))
      assert.ok(Date.now() - deadStart < 3000, 'dead-socket reporter run must stay inside the retry deadline')

      // --- reporter camelCase payload (Grok Build) ---------------------------
      // Grok Build ships the same hook contract as Claude Code but names the
      // stdin fields camelCase (hookEventName / sessionId). The one shared
      // reporter must map those to the same frame.
      const grokSockPath = join(sockDir, 'grok-instance.sock')
      const grokFrames: string[] = []
      const grokServer = await listenLines(grokSockPath, grokFrames)
      await runReporter(grokSockPath, join(sockDir, 'unused.sock'), {
        hookEventName: 'UserPromptSubmit',
        sessionId: 'grok-session',
        cwd: '/tmp',
      })
      await waitFor(() => grokFrames.length >= 1)
      const grokFrame = JSON.parse(grokFrames[0]) as { sessionId?: string; event?: string; cwd?: string }
      assert.equal(grokFrame.event, 'UserPromptSubmit', 'camelCase hookEventName carried as the raw event')
      assert.equal(grokFrame.sessionId, 'grok-session', 'camelCase sessionId carried into the frame')
      assert.equal(grokFrame.cwd, '/tmp', 'the payload cwd rides every frame')
      grokServer.close()

      // --- reporter observed cwd -----------------------------------
      // Claude's CwdChanged names the destination `new_cwd`; it wins over a
      // stale `cwd` on the same payload. A payload with no cwd yields no field.
      const cwdSockPath = join(sockDir, 'cwd-instance.sock')
      const cwdFrames: string[] = []
      const cwdServer = await listenLines(cwdSockPath, cwdFrames)
      await runReporter(cwdSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'CwdChanged',
        session_id: 'cwd-session',
        old_cwd: '/repo',
        new_cwd: '/repo/.claude/worktrees/feature ',
      })
      await waitFor(() => cwdFrames.length >= 1)
      const cwdFrame = JSON.parse(cwdFrames[0]) as { event?: string; cwd?: string; phase?: string }
      assert.equal(cwdFrame.event, 'CwdChanged')
      assert.equal(cwdFrame.cwd, '/repo/.claude/worktrees/feature', 'new_cwd forwarded, trimmed')
      assert.equal(cwdFrame.phase, undefined, 'the reporter asserts no phase for an observation event')
      await runReporter(cwdSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'PostToolUse',
        session_id: 'cwd-session',
        tool_name: 'Bash',
      })
      await waitFor(() => cwdFrames.length >= 2)
      const noCwdFrame = JSON.parse(cwdFrames[1]) as { cwd?: string }
      assert.equal(noCwdFrame.cwd, undefined, 'a payload without a cwd carries no cwd field')
      // A subagent's hook (Claude stamps agent_id; a worktree-isolated subagent
      // has a cwd of its own) forwards its event but never its cwd.
      await runReporter(cwdSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'PostToolUse',
        session_id: 'cwd-session',
        tool_name: 'Bash',
        cwd: '/repo/.claude/worktrees/subagent-scratch',
        agent_id: 'agent-7f3a',
        agent_type: 'general-purpose',
      })
      await waitFor(() => cwdFrames.length >= 3)
      const subagentFrame = JSON.parse(cwdFrames[2]) as { event?: string; cwd?: string }
      assert.equal(subagentFrame.event, 'PostToolUse', 'the subagent event still reaches main')
      assert.equal(subagentFrame.cwd, undefined, 'a subagent cwd is never forwarded as the session cwd')
      // Cursor: the launch root wins over the Shell tool's per-command cwd.
      await runReporter(cwdSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'postToolUse',
        conversation_id: 'cursor-chat',
        workspace_roots: ['/Users/me/proj'],
        tool_name: 'Shell',
        cwd: '/tmp',
      })
      await waitFor(() => cwdFrames.length >= 4)
      const cursorFrame = JSON.parse(cwdFrames[3]) as { cwd?: string; sessionId?: string }
      assert.equal(
        cursorFrame.cwd,
        '/Users/me/proj',
        "Cursor reports its launch root, not a command's working directory",
      )
      assert.equal(cursorFrame.sessionId, 'cursor-chat')
      cwdServer.close()

      // --- reporter file ledger ---------------------------------------------
      // The payloads below are the REAL shapes (Claude Code, 2026-09-09):
      // PostToolUse's `tool_response` IS the tool's result object, and its
      // structuredPatch hunks are what the counts are summed from. The reporter
      // forwards path + counts only — never the patch, never the file content.
      const editSockPath = join(sockDir, 'edit-instance.sock')
      const editFrames: string[] = []
      const editServer = await listenLines(editSockPath, editFrames)
      type FileChangeFrame = {
        event?: string
        // The CLI's own id for the tool call, forwarded so main can tell a second
        // REGISTRATION of this reporter from a second edit.
        toolUseId?: string
        fileChange?: {
          path?: string
          additions?: number
          deletions?: number
          edits?: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number }>
        }
        [key: string]: unknown
      }
      const nextFileChangeFrame = async (index: number): Promise<FileChangeFrame> => {
        await waitFor(() => editFrames.length >= index + 1)
        return JSON.parse(editFrames[index]) as FileChangeFrame
      }

      await runReporter(editSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'PostToolUse',
        session_id: 'edit-session',
        cwd: '/repo',
        tool_name: 'Edit',
        tool_input: { file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' },
        tool_response: {
          filePath: '/repo/src/app.ts',
          oldString: 'a',
          newString: 'b',
          originalFile: 'a\nkeep\n',
          replaceAll: false,
          userModified: false,
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 3,
              newStart: 1,
              newLines: 4,
              lines: [' keep', '-gone', '-also gone', '+new one', '+new two', '+new three', ' tail'],
            },
            {
              oldStart: 40,
              oldLines: 2,
              newStart: 41,
              newLines: 2,
              lines: [' ctx', '-old tail', '+new tail', '\\ No newline at end of file'],
            },
          ],
        },
      })
      const editFrame = await nextFileChangeFrame(0)
      assert.deepEqual(
        { ...editFrame.fileChange, edits: undefined },
        { path: '/repo/src/app.ts', additions: 4, deletions: 3, edits: undefined },
        'every +/- line across every hunk counts; a "\\ No newline" marker counts as neither',
      )
      // The line RANGES the agent's changelist owns are the CHANGED lines, never
      // the hunk bounds: hunk one is `@@ -1,3 +1,4 @@` and claims old 2-3 → new
      // 2-4 only, because ' keep' and ' tail' are context the agent did not write.
      // Hunk two proves the same across a `\ No newline` marker, which is diff
      // bookkeeping and moves neither cursor.
      assert.deepEqual(
        editFrame.fileChange?.edits,
        [
          { oldStart: 2, oldLines: 2, newStart: 2, newLines: 3 },
          { oldStart: 41, oldLines: 1, newStart: 42, newLines: 1 },
        ],
        'context advances both cursors and never enters an edit',
      )
      assert.equal(
        JSON.stringify(editFrame).includes('new one'),
        false,
        'the patch text must never ride the socket — the frame line cap is 64KB',
      )

      // A Write that CREATES a file carries an EMPTY structuredPatch: additions
      // are the line count of `content`, and a trailing newline is not a line.
      await runReporter(editSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'PostToolUse',
        session_id: 'edit-session',
        tool_name: 'Write',
        tool_input: { file_path: '/repo/src/new.ts', content: 'one\ntwo\nthree\n' },
        tool_response: {
          type: 'create',
          filePath: '/repo/src/new.ts',
          content: 'one\ntwo\nthree\n',
          originalFile: '',
          structuredPatch: [],
          userModified: false,
        },
      })
      assert.deepEqual(
        (await nextFileChangeFrame(1)).fileChange,
        {
          path: '/repo/src/new.ts',
          additions: 3,
          deletions: 0,
          // git spells a whole-file creation `@@ -0,0 +1,3 @@`: `-0,0` is the
          // anchor before the first line of a file that did not exist.
          edits: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 }],
        },
        'a created file counts its content lines, since there is no patch to count',
      )

      // A file created with no `content` on the result: the tool's own input has
      // it, and a brand-new 300-line file reporting zero would be indetectable.
      // No trailing newline here — the strip is the one real off-by-one.
      await runReporter(editSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'PostToolUse',
        session_id: 'edit-session',
        tool_name: 'Write',
        tool_input: { file_path: '/repo/src/from-input.ts', content: 'one\ntwo' },
        tool_response: { type: 'create', filePath: '/repo/src/from-input.ts', structuredPatch: [] },
      })
      assert.deepEqual(
        (await nextFileChangeFrame(2)).fileChange,
        {
          path: '/repo/src/from-input.ts',
          additions: 2,
          deletions: 0,
          edits: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 }],
        },
        'the content falls back to the tool input, and a file with no trailing newline is not short a line',
      )

      // A FAILED edit reports nothing. A tool error comes back as a string (or an
      // object carrying `error`), and a file the agent did NOT change must never
      // appear in the ledger — it would be indistinguishable from a real edit
      // whose result shape could not be counted.
      await runReporter(editSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'PostToolUse',
        session_id: 'edit-session',
        tool_name: 'Edit',
        tool_input: { file_path: '/repo/src/untouched.ts', old_string: 'a', new_string: 'b' },
        tool_response: 'Error: String to replace not found in file.',
      })
      assert.equal(
        (await nextFileChangeFrame(3)).fileChange,
        undefined,
        'a failed edit is not an edit, however the CLI phrases the error',
      )
      await runReporter(editSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'PostToolUse',
        session_id: 'edit-session',
        tool_name: 'Write',
        tool_input: { file_path: '/repo/src/untouched.ts' },
        tool_response: { error: 'EACCES: permission denied', filePath: '/repo/src/untouched.ts' },
      })
      assert.equal((await nextFileChangeFrame(4)).fileChange, undefined, 'nor an error object carrying a path')

      // A subagent's edit (agent_id present) counts for the session that spawned
      // it — the cwd suppression above is a cwd rule, not a work rule.
      await runReporter(editSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'PostToolUse',
        session_id: 'edit-session',
        cwd: '/repo/.claude/worktrees/subagent-scratch',
        agent_id: 'agent-7f3a',
        tool_name: 'Write',
        tool_input: { file_path: '/repo/notes.md' },
        tool_response: {
          type: 'update',
          filePath: '/repo/notes.md',
          content: 'x',
          structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
        },
      })
      const subagentEdit = await nextFileChangeFrame(5)
      assert.deepEqual(subagentEdit.fileChange, {
        path: '/repo/notes.md',
        additions: 1,
        deletions: 1,
        edits: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }],
      })
      assert.equal(subagentEdit.cwd, undefined, 'the subagent cwd is still suppressed')

      // An editing tool whose result shape we have not verified (MultiEdit,
      // NotebookEdit) still records the file it touched, with no counts guessed.
      await runReporter(editSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'PostToolUse',
        session_id: 'edit-session',
        tool_name: 'NotebookEdit',
        tool_input: { notebook_path: '/repo/analysis.ipynb', new_source: 'print(1)' },
        tool_response: { ok: true },
      })
      assert.deepEqual(
        (await nextFileChangeFrame(6)).fileChange,
        { path: '/repo/analysis.ipynb', additions: 0, deletions: 0 },
        'an unverified result shape falls back to the input path with no counts',
      )

      // The result's own path wins over the input's: the tool reports where it
      // actually wrote, and a relative or since-resolved input path is the guess.
      await runReporter(editSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'PostToolUse',
        session_id: 'edit-session',
        tool_name: 'MultiEdit',
        tool_input: { file_path: 'src/relative.ts' },
        tool_response: {
          filePath: '/repo/src/resolved.ts',
          structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' keep', '+added'] }],
        },
      })
      assert.deepEqual(
        (await nextFileChangeFrame(7)).fileChange,
        {
          path: '/repo/src/resolved.ts',
          additions: 1,
          deletions: 0,
          // Inserted AFTER old line 1 — the context line the agent kept.
          edits: [{ oldStart: 1, oldLines: 0, newStart: 2, newLines: 1 }],
        },
        'the result path wins over the input path, and a MultiEdit that carries a patch is counted like any other',
      )

      // A non-editing tool carries no change at all, and neither does an editing
      // tool call that names no file.
      await runReporter(editSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'PostToolUse',
        session_id: 'edit-session',
        tool_name: 'Bash',
        tool_input: { command: 'sed -i s/a/b/ file.ts' },
        tool_response: { filePath: '/repo/via-bash.ts', structuredPatch: [] },
      })
      assert.equal(
        (await nextFileChangeFrame(8)).fileChange,
        undefined,
        'Bash is deliberately not attributed, however file-shaped its result looks',
      )
      await runReporter(editSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'PostToolUse',
        session_id: 'edit-session',
        tool_name: 'Edit',
        tool_input: {},
        tool_response: { structuredPatch: [] },
      })
      assert.equal((await nextFileChangeFrame(9)).fileChange, undefined, 'no path, no ledger entry')
      await runReporter(editSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'PostToolUse',
        session_id: 'edit-session',
        tool_name: 'Edit',
        tool_input: { file_path: '/' + 'x'.repeat(5000) },
        tool_response: {},
      })
      assert.equal((await nextFileChangeFrame(10)).fileChange, undefined, 'an absurd path is dropped, not sliced')
      // The reason the patch stays here rather than riding along: the listener
      // drops any line over MAX_LINE_BYTES (64KB). A path at the cap plus counts
      // must leave that budget almost untouched.
      await runReporter(editSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'PostToolUse',
        session_id: 'edit-session',
        tool_name: 'Write',
        tool_input: { file_path: `/${'x'.repeat(4095)}` },
        tool_response: {
          type: 'update',
          filePath: `/${'x'.repeat(4095)}`,
          content: 'y'.repeat(200_000),
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 20_000,
              newStart: 1,
              newLines: 20_000,
              lines: Array.from({ length: 20_000 }, (_unused, index) => `+line ${index}`),
            },
          ],
        },
      })
      const bigFrame = await nextFileChangeFrame(11)
      assert.equal(bigFrame.fileChange?.additions, 20_000, 'a 20k-line patch is counted')
      assert.ok(
        Buffer.byteLength(editFrames[11], 'utf8') < 8 * 1024,
        'the frame carries the count, never the patch — it must stay a rounding error against the 64KB line cap',
      )

      // A PURE DELETION between context lines: the region has no new-side lines,
      // so it is anchored after the new line before it (git's `+1,0`) — the one
      // spelling the changelist model's line tracker reads back.
      await runReporter(editSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'PostToolUse',
        session_id: 'edit-session',
        tool_name: 'Edit',
        tool_input: { file_path: '/repo/src/cut.ts' },
        tool_response: {
          filePath: '/repo/src/cut.ts',
          structuredPatch: [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 2, lines: [' a', '-b', '-c', ' d'] }],
        },
      })
      assert.deepEqual(
        (await nextFileChangeFrame(12)).fileChange,
        {
          path: '/repo/src/cut.ts',
          additions: 0,
          deletions: 2,
          edits: [{ oldStart: 2, oldLines: 2, newStart: 1, newLines: 0 }],
        },
        'a deletion is anchored after the new line that survives above it',
      )

      // CONTEXT-FREE hunks (context 0): the header's number is an ANCHOR on the
      // side that has no lines, not the first line of a run, so a hunk that opens
      // with `+` lines must not be read one line early.
      await runReporter(editSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'PostToolUse',
        session_id: 'edit-session',
        tool_name: 'Edit',
        tool_input: { file_path: '/repo/src/anchors.ts' },
        tool_response: {
          filePath: '/repo/src/anchors.ts',
          structuredPatch: [
            { oldStart: 4, oldLines: 0, newStart: 5, newLines: 2, lines: ['+x', '+y'] },
            { oldStart: 9, oldLines: 2, newStart: 0, newLines: 0, lines: ['-gone', '-also'] },
          ],
        },
      })
      assert.deepEqual(
        (await nextFileChangeFrame(13)).fileChange?.edits,
        [
          { oldStart: 4, oldLines: 0, newStart: 5, newLines: 2 },
          { oldStart: 9, oldLines: 2, newStart: 0, newLines: 0 },
        ],
        'an insertion keeps its `-4,0` anchor, and a head-of-file deletion keeps `+0,0`',
      )

      // A patch whose SHAPE cannot be read: the file is still reported (it was
      // edited) with no `edits` at all, which the app takes as a file-level claim.
      await runReporter(editSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'PostToolUse',
        session_id: 'edit-session',
        tool_name: 'Edit',
        tool_input: { file_path: '/repo/src/unreadable.ts' },
        tool_response: {
          filePath: '/repo/src/unreadable.ts',
          structuredPatch: [{ oldStart: 'one', newStart: null, lines: ['+a', '-b'] }],
        },
      })
      assert.deepEqual(
        (await nextFileChangeFrame(14)).fileChange,
        { path: '/repo/src/unreadable.ts', additions: 1, deletions: 1 },
        'an unreadable patch drops the ranges, never the file',
      )

      editServer.close()

      // --- reporter file ledger: the other CLIs' edit vocabularies ------------
      // Claude Code hands the reporter a diff. Codex hands it the V4A patch TEXT
      // it applied; Cursor, Kimi and Grok hand it the old/new STRINGS of a
      // search-replace. None of them carries a line number, so the reporter reads
      // the file the CLI just wrote and locates the post-image in it — which is
      // why these cases run against REAL files on disk.
      //
      // The Codex payloads below are the shapes captured live from codex-cli
      // 0.153.3 (2026-09-09), trimmed to the fields the reporter reads. Cursor,
      // Kimi and Grok could not be run on this machine (each refuses headless
      // without an account), so those payloads are built from vendor docs —
      // Grok's from the hook documentation embedded in its own binary.
      const vocabDir = await mkdtemp(join(tmpdir(), 'se-agent-state-vocab-'))
      const vocabSockPath = join(sockDir, 'vocab-instance.sock')
      const vocabFrames: string[] = []
      const vocabServer = await listenLines(vocabSockPath, vocabFrames)
      const nextVocabFrame = async (index: number): Promise<FileChangeFrame> => {
        await waitFor(() => vocabFrames.length >= index + 1)
        return JSON.parse(vocabFrames[index]) as FileChangeFrame
      }

      // === Codex: one apply_patch call, two files (VERIFIED payload) =========
      // The captured patch replaced line 5 of a 20-line file and created a new
      // one in the SAME call. `tool_input.command` is the raw patch; there is no
      // file_path field and no line number anywhere; `tool_response` is the exec
      // result STRING. Two files means TWO frames, phase-identical.
      const codexSample = join(vocabDir, 'sample.txt')
      const codexGreeting = join(vocabDir, 'greeting.txt')
      await writeFile(
        codexSample,
        Array.from({ length: 20 }, (_unused, index) =>
          index === 4 ? 'hello' : `line ${index + 1}: original content number ${index + 1}`,
        ).join('\n') + '\n',
        'utf8',
      )
      await writeFile(codexGreeting, 'hello\nworld\n', 'utf8')
      await runReporter(vocabSockPath, join(sockDir, 'unused.sock'), {
        session_id: '01a0863a-f119-7ae3-b988-f30e7d306232',
        cwd: vocabDir,
        hook_event_name: 'PostToolUse',
        tool_name: 'apply_patch',
        tool_input: {
          command: [
            '*** Begin Patch',
            `*** Update File: ${codexSample}`,
            '@@',
            '-line 5: original content number 5',
            '+hello',
            ' line 6: original content number 6',
            `*** Add File: ${codexGreeting}`,
            '+hello',
            '+world',
            '*** End Patch',
          ].join('\n'),
        },
        tool_response: `Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nA ${codexGreeting}\nM ${codexSample}\n`,
        tool_use_id: 'exec-08e5ecf6-8c44-429d-9598-8028ee8c8d67',
      })
      const codexUpdateFrame = await nextVocabFrame(0)
      const codexAddFrame = await nextVocabFrame(1)
      assert.deepEqual(
        codexUpdateFrame.fileChange,
        {
          path: codexSample,
          additions: 1,
          deletions: 1,
          // The hunk has no header and no numbers: line 5 comes from finding the
          // hunk's post-image ('hello' + the context line) in the file on disk,
          // and the context line is then walked off the region.
          edits: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }],
        },
        'a V4A hunk is located in the file the CLI just wrote',
      )
      assert.deepEqual(
        codexAddFrame.fileChange,
        {
          path: codexGreeting,
          additions: 2,
          deletions: 0,
          edits: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 }],
        },
        'an Add File section is a whole-file creation, git`s `@@ -0,0 +1,N @@`',
      )
      assert.equal(
        codexAddFrame.event,
        codexUpdateFrame.event,
        'both frames carry the identical event so the phase fold stays idempotent',
      )
      assert.equal(codexAddFrame.ts, codexUpdateFrame.ts, 'and the identical ts, so re-ingesting the second is a no-op')
      assert.equal(
        JSON.stringify(codexUpdateFrame).includes('original content'),
        false,
        'the patch text never rides the socket',
      )

      // Two hunks in ONE file: the second hunk sat two lines higher before the
      // first one inserted, and its OLD-side coordinates must say so — that is
      // the number recordEdit walks every other agent`s spans through.
      const codexMulti = join(vocabDir, 'multi.txt')
      await writeFile(
        codexMulti,
        'alpha\ninserted one\ninserted two\nbeta\ngamma\ndelta\nreplaced epsilon\nzeta\n',
        'utf8',
      )
      await runReporter(vocabSockPath, join(sockDir, 'unused.sock'), {
        session_id: 'codex-multi',
        cwd: vocabDir,
        hook_event_name: 'PostToolUse',
        tool_name: 'apply_patch',
        tool_input: {
          command: [
            '*** Begin Patch',
            '*** Update File: ./multi.txt',
            '@@',
            ' alpha',
            '+inserted one',
            '+inserted two',
            ' beta',
            '@@',
            ' delta',
            '-epsilon',
            '+replaced epsilon',
            ' zeta',
            '*** End Patch',
          ].join('\n'),
        },
        tool_response:
          'Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nM ./multi.txt\n',
      })
      assert.deepEqual(
        (await nextVocabFrame(2)).fileChange,
        {
          // A V4A path is whatever the model wrote: `./multi.txt` is legal and
          // the reader requires absolute, so it resolves against the payload cwd.
          path: codexMulti,
          additions: 3,
          deletions: 1,
          edits: [
            { oldStart: 1, oldLines: 0, newStart: 2, newLines: 2 },
            { oldStart: 5, oldLines: 1, newStart: 7, newLines: 1 },
          ],
        },
        'the second hunk`s old-side start is corrected by the lines the first one added',
      )

      // A patch that FAILED reports nothing: Codex`s response is the exec result,
      // so a non-zero exit is the tool saying it changed nothing.
      await runReporter(vocabSockPath, join(sockDir, 'unused.sock'), {
        session_id: 'codex-fail',
        cwd: vocabDir,
        hook_event_name: 'PostToolUse',
        tool_name: 'apply_patch',
        tool_input: { command: `*** Begin Patch\n*** Update File: ${codexSample}\n@@\n-nope\n+never\n*** End Patch` },
        tool_response: 'Exit code: 1\nWall time: 0 seconds\nOutput:\ninvalid patch: context not found\n',
      })
      const codexFailFrame = await nextVocabFrame(3)
      assert.equal(codexFailFrame.fileChange, undefined, 'a non-zero apply_patch exit is not an edit')
      assert.equal(codexFailFrame.event, 'PostToolUse', 'the phase frame still goes')

      // === Cursor: afterFileEdit ============================================
      // Its postToolUse payload carries no edit at all, so the manifest registers
      // afterFileEdit too. Entries apply IN ORDER, so the second edit`s old-side
      // coordinates must account for the line the first one added.
      const cursorFile = join(vocabDir, 'cursor.txt')
      await writeFile(cursorFile, 'one\nTWO\nEXTRA\nthree\nfour\nFIVE CHANGED\nsix\n', 'utf8')
      await runReporter(vocabSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'afterFileEdit',
        conversation_id: 'cursor-chat',
        workspace_roots: [vocabDir],
        file_path: cursorFile,
        edits: [
          { old_string: 'two', new_string: 'TWO\nEXTRA' },
          { old_string: 'five', new_string: 'FIVE CHANGED' },
        ],
      })
      assert.deepEqual(
        (await nextVocabFrame(4)).fileChange,
        {
          path: cursorFile,
          additions: 3,
          deletions: 2,
          edits: [
            { oldStart: 2, oldLines: 1, newStart: 2, newLines: 2 },
            { oldStart: 5, oldLines: 1, newStart: 6, newLines: 1 },
          ],
        },
        'each Cursor edit is located in the FINAL file and its old-side start rolled back through the earlier ones',
      )

      // An AMBIGUOUS new string (the replacement text already occurs elsewhere in
      // the file) costs the whole call its ranges: a region located at the wrong
      // copy would hand another agent`s lines to this one.
      const cursorDupe = join(vocabDir, 'dupe.txt')
      await writeFile(cursorDupe, 'dup\nother\ndup\n', 'utf8')
      await runReporter(vocabSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'afterFileEdit',
        conversation_id: 'cursor-chat',
        workspace_roots: [vocabDir],
        file_path: cursorDupe,
        edits: [{ old_string: 'x', new_string: 'dup' }],
      })
      assert.deepEqual(
        (await nextVocabFrame(5)).fileChange,
        { path: cursorDupe, additions: 1, deletions: 1 },
        'two matches is no match: the file is still claimed, the lines are not',
      )

      // A file OUTSIDE the workspace root is reported as itself — it is absolute,
      // it is what the agent changed, and the ledger hands a person a file to open.
      const outsideDir = await mkdtemp(join(tmpdir(), 'se-agent-state-outside-'))
      const outsideFile = join(outsideDir, 'outside.txt')
      await writeFile(outsideFile, 'a\nOUTSIDE\nc\n', 'utf8')
      await runReporter(vocabSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'afterFileEdit',
        conversation_id: 'cursor-chat',
        workspace_roots: [vocabDir],
        file_path: outsideFile,
        edits: [{ old_string: 'b', new_string: 'OUTSIDE' }],
      })
      assert.deepEqual(
        (await nextVocabFrame(6)).fileChange,
        {
          path: outsideFile,
          additions: 1,
          deletions: 1,
          edits: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }],
        },
        'an edit outside the workspace root is still that agent`s edit',
      )

      // Cursor`s postToolUse is deliberately NOT read for edits: its payload
      // carries none, and accepting the spelling would imply a support it cannot
      // deliver.
      await runReporter(vocabSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'postToolUse',
        conversation_id: 'cursor-chat',
        workspace_roots: [vocabDir],
        tool_name: 'Edit',
        tool_input: { file_path: cursorFile, old_string: 'two', new_string: 'TWO' },
      })
      assert.equal((await nextVocabFrame(7)).fileChange, undefined, 'Cursor`s postToolUse never carries a file change')

      // === Kimi Code 0.42: Edit / Write, named like Claude`s ================
      // Kimi reuses Claude`s tool NAMES with its own input (`path`, not
      // `file_path`) and a plain-text result with no structuredPatch, so the
      // field that names the file is what picks the reader. The file here is
      // CRLF: a line ENDING is not a line, so a \n-spelled tool argument must
      // still match it.
      const kimiFile = join(vocabDir, 'crlf.txt')
      await writeFile(kimiFile, 'alpha\r\nBETA\r\ngamma\r\n', 'utf8')
      await runReporter(vocabSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'PostToolUse',
        session_id: 'kimi-session',
        cwd: vocabDir,
        tool_name: 'Edit',
        tool_input: { path: 'crlf.txt', old_string: 'beta', new_string: 'BETA', replace_all: false },
        tool_response: 'The file crlf.txt has been updated. 1 occurrence replaced.',
      })
      assert.deepEqual(
        (await nextVocabFrame(8)).fileChange,
        { path: kimiFile, additions: 1, deletions: 1, edits: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }] },
        'a CRLF file locates the same way: the ending is normalized, the line numbers are not',
      )

      // A whole-file write claims the FILE, never a line range: without the
      // previous content there is no honest old-side range to give. A write whose
      // payload carries no content at all still records the touch.
      const kimiWrite = join(vocabDir, 'written.txt')
      await writeFile(kimiWrite, 'x\ny\n', 'utf8')
      await runReporter(vocabSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'PostToolUse',
        session_id: 'kimi-session',
        cwd: vocabDir,
        tool_name: 'Write',
        tool_input: { path: kimiWrite },
      })
      assert.deepEqual(
        (await nextVocabFrame(9)).fileChange,
        { path: kimiWrite, additions: 0, deletions: 0 },
        'a write with no content field is a file-level claim with nothing guessed',
      )

      // === Grok Build: post_tool_use / search_replace ========================
      // Grok`s envelope is camelCase and its payload spells the event
      // `post_tool_use` (its CONFIG stays PascalCase). search_replace is Grok`s
      // own name for Edit/Write/MultiEdit.
      const grokFile = join(vocabDir, 'grok.txt')
      await writeFile(grokFile, 'g1\nG TWO\ng3\n', 'utf8')
      await runReporter(vocabSockPath, join(sockDir, 'unused.sock'), {
        hookEventName: 'post_tool_use',
        sessionId: 'grok-session',
        cwd: vocabDir,
        workspaceRoot: vocabDir,
        permissionMode: 'default',
        toolName: 'search_replace',
        toolInput: { file_path: 'grok.txt', old_string: 'g2', new_string: 'G TWO' },
        toolUseId: 'toolu_grok',
        toolInputTruncated: false,
      })
      const grokEditFrame = await nextVocabFrame(10)
      assert.equal(
        grokEditFrame.event,
        'post_tool_use',
        'the raw event spelling is forwarded unmodified — main folds the case',
      )
      assert.deepEqual(
        grokEditFrame.fileChange,
        { path: grokFile, additions: 1, deletions: 1, edits: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }] },
        'the file-edit gate accepts the snake_case event spelling',
      )

      // An edit whose file was changed AGAIN before the hook ran: the new string
      // is no longer in the file, so there is nothing to locate — the file is
      // still claimed, which is what the app falls back to anyway.
      const racedFile = join(vocabDir, 'raced.txt')
      await writeFile(racedFile, 'someone else wrote this\n', 'utf8')
      await runReporter(vocabSockPath, join(sockDir, 'unused.sock'), {
        hookEventName: 'post_tool_use',
        sessionId: 'grok-session',
        cwd: vocabDir,
        toolName: 'search_replace',
        toolInput: { file_path: racedFile, old_string: 'before', new_string: 'after' },
      })
      assert.deepEqual(
        (await nextVocabFrame(11)).fileChange,
        { path: racedFile, additions: 1, deletions: 1 },
        'a file already rewritten under us degrades to a file-level claim, not a wrong range',
      )

      // A Kimi call that FAILED (`isError`) is not an edit, even though the file
      // it names is real and its input reads exactly like a successful one.
      await runReporter(vocabSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'PostToolUse',
        session_id: 'kimi-session',
        cwd: vocabDir,
        tool_name: 'Edit',
        tool_input: { path: 'crlf.txt', old_string: 'nowhere', new_string: 'BETA' },
        tool_response: { isError: true, output: 'old_string not found in crlf.txt' },
      })
      assert.equal((await nextVocabFrame(12)).fileChange, undefined, 'a Kimi isError result is not an edit')

      // === Claude Code: FileChanged (the file watcher) ======================
      // Claude Code 2.1.266's watcher event carries file_path and event
      // (change | add | unlink) and no diff at all — it is how an edit made
      // through Bash, a formatter or a codegen step reaches the changelist. It is
      // recorded as a TOUCH: path only, no counts, no ranges, so a FileChanged
      // that follows the Edit that caused it adds nothing to the ledger's numbers.
      const watchedFile = join(vocabDir, 'formatted.txt')
      await writeFile(watchedFile, 'formatted\n', 'utf8')
      await runReporter(vocabSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'FileChanged',
        session_id: 'watch-session',
        cwd: vocabDir,
        file_path: watchedFile,
        event: 'change',
      })
      const watchedFrame = await nextVocabFrame(13)
      assert.equal(watchedFrame.event, 'FileChanged', 'the watcher event is forwarded under its own name')
      assert.deepEqual(
        watchedFrame.fileChange,
        { path: watchedFile, additions: 0, deletions: 0 },
        'a watched-file change is a touch: the file, no counts, no ranges',
      )
      // A relative watcher path still resolves, and an unlink is still a touch.
      await runReporter(vocabSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'FileChanged',
        session_id: 'watch-session',
        cwd: vocabDir,
        file_path: 'formatted.txt',
        event: 'unlink',
      })
      assert.deepEqual(
        (await nextVocabFrame(14)).fileChange,
        { path: watchedFile, additions: 0, deletions: 0 },
        'a deleted file is a change the agent made, and its path is still absolute',
      )
      await runReporter(vocabSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'FileChanged',
        session_id: 'watch-session',
        cwd: vocabDir,
        event: 'change',
      })
      assert.equal((await nextVocabFrame(15)).fileChange, undefined, 'a watcher event with no path names nothing')

      // === The tool-call id rides the frame (the duplicate-registration guard) =
      // The app registers this reporter TWICE — merged into
      // `.claude/settings.local.json`, and declared again by the studio plugin's
      // `hooks/hooks.json`, which Claude Code 2.1.266 loads natively by itself —
      // so both fire on one tool call and send byte-identical frames. Identical
      // INCLUDING this id, because it is the CLI's and not the hook process's,
      // which is exactly what lets main tell the copy apart from a second edit.
      // Three payload spellings, one field on the way out.
      const idFile = join(vocabDir, 'ids.txt')
      await writeFile(idFile, 'one\ntwo\nthree\n', 'utf8')

      // Claude Code: snake_case `tool_use_id` beside an Edit.
      await runReporter(vocabSockPath, join(sockDir, 'unused.sock'), {
        session_id: 'id-claude',
        cwd: vocabDir,
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: idFile, old_string: 'two', new_string: 'TWO' },
        tool_response: { filePath: idFile },
        tool_use_id: 'toolu_01PEv1LG8ZsV17KL86fXpeAx',
      })
      const claudeIdFrame = await nextVocabFrame(16)
      assert.equal(claudeIdFrame.toolUseId, 'toolu_01PEv1LG8ZsV17KL86fXpeAx', 'Claude`s tool_use_id rides the frame')
      assert.equal(claudeIdFrame.fileChange?.path, idFile, 'and the edit it identifies still rides with it')

      // Codex: the same spelling, and a multi-file patch — ONE id, N frames, N
      // paths. Main keys on (id, path), so all of them fold.
      const idPatchA = join(vocabDir, 'patch-a.txt')
      const idPatchB = join(vocabDir, 'patch-b.txt')
      await writeFile(idPatchA, 'a1\na2\n', 'utf8')
      await runReporter(vocabSockPath, join(sockDir, 'unused.sock'), {
        session_id: 'id-codex',
        cwd: vocabDir,
        hook_event_name: 'PostToolUse',
        tool_name: 'apply_patch',
        tool_input: {
          command: [
            '*** Begin Patch',
            `*** Update File: ${idPatchA}`,
            '@@',
            '-a2',
            '+A TWO',
            `*** Add File: ${idPatchB}`,
            '+fresh',
            '*** End Patch',
          ].join('\n'),
        },
        tool_response: `Exit code: 0\nOutput:\nSuccess. Updated the following files:\nM ${idPatchA}\nA ${idPatchB}\n`,
        tool_use_id: 'exec-08e5ecf6-8c44-429d-9598-8028ee8c8d67',
      })
      const codexIdA = await nextVocabFrame(17)
      const codexIdB = await nextVocabFrame(18)
      assert.equal(
        codexIdA.toolUseId,
        'exec-08e5ecf6-8c44-429d-9598-8028ee8c8d67',
        'Codex`s tool_use_id rides the frame',
      )
      assert.equal(
        codexIdB.toolUseId,
        codexIdA.toolUseId,
        'both files of one patch carry the SAME id — the path is what separates them',
      )
      assert.deepEqual(
        [codexIdA.fileChange?.path, codexIdB.fileChange?.path].sort(),
        [idPatchA, idPatchB].sort(),
        'one call, two files, two frames',
      )

      // Grok Build: camelCase `toolUseId`, on its own event spelling.
      const idGrok = join(vocabDir, 'grok-id.txt')
      await writeFile(idGrok, 'g1\ng2\n', 'utf8')
      await runReporter(vocabSockPath, join(sockDir, 'unused.sock'), {
        hookEventName: 'post_tool_use',
        sessionId: 'id-grok',
        cwd: vocabDir,
        toolName: 'search_replace',
        toolInput: { file_path: idGrok, old_string: 'g2', new_string: 'G TWO' },
        toolUseId: 'toolu_grok_dup_guard',
      })
      assert.equal(
        (await nextVocabFrame(19)).toolUseId,
        'toolu_grok_dup_guard',
        'Grok`s camelCase toolUseId rides the frame',
      )

      // Cursor's own edit event has no tool wrapper and so no id at all: the
      // field is ABSENT rather than empty, and main falls back to its
      // timestamp-windowed key for those frames.
      const idCursor = join(vocabDir, 'cursor-id.txt')
      await writeFile(idCursor, 'c1\n', 'utf8')
      await runReporter(vocabSockPath, join(sockDir, 'unused.sock'), {
        hook_event_name: 'afterFileEdit',
        conversation_id: 'id-cursor',
        workspace_roots: [vocabDir],
        file_path: idCursor,
        edits: [{ old_string: 'c1', new_string: 'C ONE' }],
      })
      assert.equal((await nextVocabFrame(20)).toolUseId, undefined, 'Cursor`s afterFileEdit carries no tool-call id')

      vocabServer.close()

      // --- tool calls forwarded for the pull request reader -------------------
      // The reporter decides nothing about pull requests (owner ruling
      // 2026-10-04): it forwards a shell or MCP call whose output holds a URL,
      // and the server's one reader decides. Held to that reader here: what
      // the reporter forwards must read exactly as the chat path's input for the
      // same call does, so the two can never disagree.
      const prSockPath = join(sockDir, 'pr-instance.sock')
      const prFrames: string[] = []
      const prServer = await listenLines(prSockPath, prFrames)
      const forwarded = async (payload: Record<string, unknown>): Promise<AgentStateFrame['toolCall']> => {
        const before = prFrames.length
        await runReporter(prSockPath, join(sockDir, 'unused.sock'), {
          hook_event_name: 'PostToolUse',
          session_id: 'pr-session',
          cwd: vocabDir,
          ...payload,
        })
        await waitFor(() => prFrames.length > before)
        const frame = parseAgentStateFrame(JSON.parse(prFrames[before]) as unknown, Date.now() + 60_000)
        assert.ok(frame, 'main accepts the frame')
        return frame.toolCall
      }
      const parityCases: Array<{ name: string; tool_name: string; tool_input: unknown; tool_response: unknown }> = [
        {
          name: 'Claude Code Bash',
          tool_name: 'Bash',
          tool_input: { command: "gh pr create --title 'Ship it' --body 'Because'" },
          tool_response: { stdout: 'https://github.com/acme/app/pull/12\n', stderr: 'Creating pull request' },
        },
        {
          name: 'Codex shell, argv command, string result',
          tool_name: 'shell',
          tool_input: { command: ['bash', '-lc', 'glab mr create --fill --yes'] },
          tool_response:
            'Exit code: 0\nWall time: 2.1 seconds\nOutput:\n!4 Ship it (feature)\n https://gitlab.example.com/acme/app/-/merge_requests/4\n',
        },
        {
          name: 'an MCP create tool',
          tool_name: 'mcp__github__create_pull_request',
          tool_input: { owner: 'acme', repo: 'app', title: 'Ship it', head: 'feature', base: 'main' },
          tool_response: [
            {
              type: 'text',
              text: '{"url":"https://api.github.com/repos/acme/app/pulls/13","html_url":"https://github.com/acme/app/pull/13"}',
            },
          ],
        },
        {
          name: 'a listing, forwarded and refused by the reader',
          tool_name: 'Bash',
          tool_input: { command: 'gh pr list' },
          tool_response: { stdout: '12 Ship it https://github.com/acme/app/pull/12\n', stderr: '' },
        },
      ]
      for (const parity of parityCases) {
        const toolCall = await forwarded(parity)
        assert.ok(toolCall, `${parity.name}: forwarded`)
        assert.deepEqual(
          readOpenedPullRequest(toolCall),
          readOpenedPullRequest({ name: parity.tool_name, input: parity.tool_input, output: parity.tool_response }),
          `${parity.name}: the reporter's call reads as the chat path's does`,
        )
      }
      assert.equal(
        readOpenedPullRequest((await forwarded(parityCases[0]))!)?.url,
        'https://github.com/acme/app/pull/12',
      )
      // A long output is kept at both ends; a URL the head's cut runs through
      // is dropped, never forwarded as the shorter URL left of it.
      const prefix = '{"stdout":"'
      const cutUrl = 'https://github.com/acme/app/pull/1'
      const straddling = await forwarded({
        tool_name: 'Bash',
        tool_input: { command: 'gh pr create --fill' },
        tool_response: {
          stdout: `${' '.repeat(8 * 1024 - 1 - prefix.length - cutUrl.length)}https://github.com/acme/app/pull/1234 ${'z'.repeat(9_000)}`,
        },
      })
      assert.ok(straddling, 'forwarded')
      assert.doesNotMatch(straddling.output, /\/pull\/1\n/)
      assert.equal(readOpenedPullRequest(straddling), null)
      // Nothing to forward: a call with no URL in its output, and a tool that
      // is neither a shell nor an MCP tool.
      assert.equal(
        await forwarded({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a b' } }),
        undefined,
      )
      assert.equal(
        await forwarded({
          tool_name: 'Read',
          tool_input: { file_path: join(vocabDir, 'notes.md') },
          tool_response: 'see https://github.com/acme/app/pull/12',
        }),
        undefined,
      )
      prServer.close()

      // --- status-line forwarder ---------------------------------------------
      // Executes the REAL bundled forwarder: the payload below is Claude Code's
      // documented status-line document, and what comes back over the socket must
      // be the seven values, the prompt cache's three and the usage windows' two
      // each, and nothing else. Then the wrap path: the person's own
      // command runs with the same stdin bytes and its stdout is ours.
      const statusLineScript = join(process.cwd(), 'resources', 'hooks', 'sprintengine-status-line.mjs')
      const slSockPath = join(sockDir, 'status-line.sock')
      const slFrames: string[] = []
      const slServer = await listenLines(slSockPath, slFrames)

      const statusLinePayload = {
        cwd: '/repo',
        session_id: 'sl-session',
        session_name: 'hook ledger',
        transcript_path: '/Users/me/.claude/projects/-repo/sl-session.jsonl',
        model: { id: 'claude-opus-5', display_name: 'Opus' },
        workspace: { current_dir: '/repo', project_dir: '/repo' },
        version: '2.1.90',
        cost: {
          total_cost_usd: 0.01234,
          total_duration_ms: 45_000,
          total_api_duration_ms: 2300,
          total_lines_added: 156,
          total_lines_removed: 23,
        },
        context_window: {
          total_input_tokens: 15_500,
          total_output_tokens: 1200,
          context_window_size: 200_000,
          used_percentage: 8.4,
          remaining_percentage: 91.6,
          current_usage: { input_tokens: 8500, output_tokens: 1200 },
        },
        rate_limits: {
          five_hour: { used_percentage: 23.5, resets_at: 1_738_425_600 },
          seven_day: { used_percentage: 41, resets_at: 1_738_771_200 },
          spend_limit: { used_percentage: 12, resets_at: 1_738_771_200, used_usd: 6, limit_usd: 50, period: 'weekly' },
        },
        prompt_cache: {
          warm: true,
          caching_observed: true,
          ttl: '1h',
          expires_at: 1_738_429_200,
          hit_ratio: 0.91,
          misses: 2,
          miss_recache_tokens: 310_200,
          last_miss_at: 1_738_425_230,
          last_miss_cause: { causes: ['ttl_expired_5m'] },
          recache_tokens_if_cold: 45_000,
        },
      }

      const runStatusLine = (options: {
        envSocket?: string | undefined
        argSocket: string
        payload: unknown
        wrap?: { command: string }
        agentId?: string | undefined
      }): Promise<{ stdout: string; code: number | null }> =>
        new Promise((resolve, reject) => {
          const args = [statusLineScript, '--socket', options.argSocket]
          if (options.wrap) {
            args.push('--wrap', Buffer.from(JSON.stringify(options.wrap), 'utf8').toString('base64'))
          }
          const child = spawn(process.execPath, args, {
            env: {
              ...process.env,
              // Always overridden: this suite can itself be running inside a
              // studio agent terminal, whose launch env names the LIVE app's
              // socket and agent. Both spellings: the forwarder reads
              // SPRINTENGINE_* first.
              ...studioEnvEntry('SPRINTENGINE_AGENT_STATE_SOCKET', options.envSocket ?? ''),
              ...studioEnvEntry('SPRINTENGINE_AGENT_ID', options.agentId ?? ''),
              ...studioEnvEntry('SPRINTENGINE_WORKSPACE_ID', 'sl-ws'),
              // Pinned rather than inherited: the wrapped command runs under the
              // person's own $SHELL, and a suite whose result depends on the
              // developer's login shell is a suite that passes for the wrong
              // reason on one machine and fails on another.
              SHELL: '/bin/sh',
            },
            stdio: ['pipe', 'pipe', 'ignore'],
          })
          let stdout = ''
          child.stdout.setEncoding('utf8')
          child.stdout.on('data', (chunk: string) => {
            stdout += chunk
          })
          child.on('error', reject)
          child.on('close', (code) => resolve({ stdout, code }))
          child.stdin.end(typeof options.payload === 'string' ? options.payload : JSON.stringify(options.payload))
        })

      const bare = await runStatusLine({
        envSocket: slSockPath,
        argSocket: join(sockDir, 'unused.sock'),
        payload: statusLinePayload,
        agentId: 'sl-agent',
      })
      assert.equal(bare.stdout, '', 'with no wrapped command the forwarder prints nothing')
      assert.equal(bare.code, 0)
      await waitFor(() => slFrames.length >= 1)
      const slFrame = JSON.parse(slFrames[0]) as Record<string, unknown>
      assert.equal(slFrame.type, 'agent_state')
      assert.equal(slFrame.event, 'StatusLine', 'the event no manifest names, folded before phase resolution')
      assert.equal(slFrame.agentId, 'sl-agent')
      assert.equal(slFrame.workspaceId, 'sl-ws')
      assert.equal(slFrame.sessionId, 'sl-session')
      assert.equal(typeof slFrame.ts, 'number')
      assert.deepEqual(
        slFrame.statusLine,
        {
          usedPercentage: 8.4,
          contextWindowSize: 200_000,
          totalCostUsd: 0.01234,
          linesAdded: 156,
          linesRemoved: 23,
          model: 'Opus',
          sessionName: 'hook ledger',
          // The payload's epoch seconds arrive as milliseconds, like every
          // other time on the socket.
          promptCache: { ttl: '1h', expiresAt: 1_738_429_200_000, recacheTokens: 45_000 },
          // The subscription's windows, two numbers each, resets in ms.
          rateLimits: {
            five_hour: { usedPercentage: 23.5, resetsAt: 1_738_425_600_000 },
            seven_day: { usedPercentage: 41, resetsAt: 1_738_771_200_000 },
          },
        },
        "only the reading rides the socket — never the transcript path, the cwd or a gateway's spend limit",
      )
      assert.ok(
        !slFrames[0].includes('transcript') &&
          !slFrames[0].includes('rate_limits') &&
          !slFrames[0].includes('spend_limit') &&
          !slFrames[0].includes('used_usd') &&
          !slFrames[0].includes('/repo') &&
          !slFrames[0].includes('hit_ratio') &&
          !slFrames[0].includes('ttl_expired_5m'),
        'the forwarder must not leak the rest of the payload, the cache statistics included',
      )

      // A null used_percentage (before the first API call, and again right after a
      // /compact) is OMITTED, never sent as zero: the main process keeps the last
      // known reading rather than painting a session as empty.
      await runStatusLine({
        envSocket: slSockPath,
        argSocket: join(sockDir, 'unused.sock'),
        agentId: 'sl-agent',
        payload: {
          ...statusLinePayload,
          context_window: { ...statusLinePayload.context_window, used_percentage: null },
          prompt_cache: { ...statusLinePayload.prompt_cache, warm: false, recache_tokens_if_cold: null },
        },
      })
      await waitFor(() => slFrames.length >= 2)
      const compacted = JSON.parse(slFrames[1]) as { statusLine?: Record<string, unknown> }
      assert.equal(compacted.statusLine?.usedPercentage, undefined, 'a null percentage is omitted, not zeroed')
      assert.equal(compacted.statusLine?.contextWindowSize, 200_000, 'the rest of the reading still rides')
      // The cache rides WHOLE: a cache the CLI says is cold has no expiry, and
      // an unknown re-cache size (right after a compaction) is sent as unknown
      // rather than left to the previous reading.
      assert.deepEqual(compacted.statusLine?.promptCache, { ttl: '1h', expiresAt: null, recacheTokens: null })

      // --wrap: the person's own command runs with the SAME stdin bytes, and its
      // stdout is what Claude paints.
      const wrapped = await runStatusLine({
        envSocket: slSockPath,
        argSocket: join(sockDir, 'unused.sock'),
        agentId: 'sl-agent',
        payload: statusLinePayload,
        wrap: { command: 'cat' },
      })
      assert.equal(wrapped.code, 0)
      assert.deepEqual(JSON.parse(wrapped.stdout), statusLinePayload, 'the wrapped command receives the same stdin')
      await waitFor(() => slFrames.length >= 3)
      assert.equal((JSON.parse(slFrames[2]) as { event?: string }).event, 'StatusLine', 'wrapping still reports')

      const printed = await runStatusLine({
        envSocket: slSockPath,
        argSocket: join(sockDir, 'unused.sock'),
        agentId: 'sl-agent',
        payload: statusLinePayload,
        wrap: { command: "printf 'my status line'" },
      })
      assert.equal(printed.stdout, 'my status line', 'the wrapped stdout is passed through verbatim')
      assert.equal(printed.code, 0)

      // The wrapped command's exit code is ours.
      const failed = await runStatusLine({
        envSocket: slSockPath,
        argSocket: join(sockDir, 'unused.sock'),
        agentId: 'sl-agent',
        payload: statusLinePayload,
        wrap: { command: "printf 'still printed'; exit 3" },
      })
      assert.equal(failed.stdout, 'still printed')
      assert.equal(failed.code, 3, 'the wrapped exit code passes through')

      // A session launched OUTSIDE the app: no identity env, so nothing is
      // reported — but the person's status line still runs.
      const framesBefore = slFrames.length
      const outside = await runStatusLine({
        envSocket: slSockPath,
        argSocket: slSockPath,
        agentId: undefined,
        payload: statusLinePayload,
        wrap: { command: "printf 'outside'" },
      })
      assert.equal(outside.stdout, 'outside', 'an outside-app session keeps its status line')
      assert.equal(outside.code, 0)
      // "Nothing arrived" is asserted with a SENTINEL rather than a sleep: send a
      // payload that must report, and assert the next frame on the wire is that
      // one. A frame the silent run had sent would have to be ahead of it.
      await runStatusLine({
        envSocket: slSockPath,
        argSocket: join(sockDir, 'unused.sock'),
        agentId: 'sl-agent',
        payload: { ...statusLinePayload, session_name: 'sentinel-outside' },
      })
      await waitFor(() => slFrames.length > framesBefore)
      assert.equal(
        (JSON.parse(slFrames[framesBefore]) as { statusLine?: { sessionName?: string } }).statusLine?.sessionName,
        'sentinel-outside',
        'no identity env: report nothing — the next frame is the sentinel, not the silent run',
      )

      // A socket that is not there fails the connect outright; the status line
      // must not notice. (The hung-listener case is bounded by SOCKET_TIMEOUT_MS,
      // which no portable listener can be made to trigger from a test — a write
      // this small lands in the kernel buffer and our own end() closes it.)
      const deadSocket = await runStatusLine({
        envSocket: join(sockDir, 'no-such-status-line.sock'),
        argSocket: join(sockDir, 'no-such-status-line.sock'),
        agentId: 'sl-agent',
        payload: statusLinePayload,
        wrap: { command: "printf 'survived'" },
      })
      assert.equal(deadSocket.stdout, 'survived')
      assert.equal(deadSocket.code, 0)

      // The base64 envelope exists so that nothing in the person's own command is
      // interpreted while it rides in our argv. Metacharacters that would be a
      // command injection through any other encoding come out the far end intact.
      const hostile = await runStatusLine({
        envSocket: slSockPath,
        argSocket: join(sockDir, 'unused.sock'),
        agentId: 'sl-agent',
        payload: statusLinePayload,
        wrap: { command: "printf '%s' 'a b\"c$HOME;echo no'" },
      })
      assert.equal(
        hostile.stdout,
        'a b"c$HOME;echo no',
        'the wrapped command runs under their shell exactly as they wrote it, and nothing of ours is interpreted',
      )

      // Junk on stdin is dropped without a frame and without a crash.
      const beforeJunk = slFrames.length
      const junk = await runStatusLine({
        envSocket: slSockPath,
        argSocket: slSockPath,
        agentId: 'sl-agent',
        payload: 'not json at all',
        wrap: { command: "printf 'ok'" },
      })
      assert.equal(junk.stdout, 'ok')

      // A payload past the parse cap reports nothing — but the wrapped command
      // still receives EVERY byte of it. Half a JSON document is worse to hand a
      // person's script than the whole one.
      const oversized = JSON.stringify({
        ...statusLinePayload,
        session_name: 'far too large',
        padding: 'x'.repeat(1_200_000),
      })
      const big = await runStatusLine({
        envSocket: slSockPath,
        argSocket: join(sockDir, 'unused.sock'),
        agentId: 'sl-agent',
        payload: oversized,
        wrap: { command: 'wc -c' },
      })
      assert.equal(Number(big.stdout.trim()), Buffer.byteLength(oversized, 'utf8'), 'the wrapped command gets it all')

      await runStatusLine({
        envSocket: slSockPath,
        argSocket: join(sockDir, 'unused.sock'),
        agentId: 'sl-agent',
        payload: { ...statusLinePayload, session_name: 'sentinel-junk' },
      })
      await waitFor(() => slFrames.length > beforeJunk)
      assert.equal(
        (JSON.parse(slFrames[beforeJunk]) as { statusLine?: { sessionName?: string } }).statusLine?.sessionName,
        'sentinel-junk',
        'unparseable stdin and an over-cap payload both report nothing',
      )

      // Claude Code kills a status-line command that runs too long. That used to
      // kill the person's command directly; now it kills the forwarder, so the
      // signal has to reach the command underneath it — including a command that
      // TRAPS the signal to clean up, which is an ordinary thing for a status-line
      // script to do. An orphan here holds the status-line pipe open forever, one
      // per slow refresh.
      {
        const marker = join(sockDir, 'orphan-marker')
        const trapping = `trap 'sleep 30' TERM; printf '%s' start > ${JSON.stringify(marker)}; sleep 30`
        const child = spawn(
          process.execPath,
          [
            statusLineScript,
            '--socket',
            join(sockDir, 'unused.sock'),
            '--wrap',
            Buffer.from(JSON.stringify({ command: trapping }), 'utf8').toString('base64'),
          ],
          {
            env: {
              ...process.env,
              ...studioEnvEntry('SPRINTENGINE_AGENT_STATE_SOCKET', ''),
              ...studioEnvEntry('SPRINTENGINE_AGENT_ID', ''),
              SHELL: '/bin/sh',
            },
            stdio: ['pipe', 'ignore', 'ignore'],
          },
        )
        child.stdin.end(JSON.stringify(statusLinePayload))
        await waitFor(() => existsSync(marker))
        const closed = new Promise<void>((resolve) => child.on('close', () => resolve()))
        child.kill('SIGTERM')
        // The forwarder waits for the child, and insists shortly after — so this
        // resolves in well under the 30s the trapping command asked for.
        await Promise.race([
          closed,
          new Promise<void>((_resolve, reject) =>
            setTimeout(() => reject(new Error('the forwarder did not exit after SIGTERM')), 5_000),
          ),
        ])
        const survivors = await new Promise<string>((resolve) => {
          const ps = spawn(
            '/bin/sh',
            ['-c', `ps -eo pid,command | grep ${JSON.stringify(marker)} | grep -v grep || true`],
            {
              stdio: ['ignore', 'pipe', 'ignore'],
            },
          )
          let out = ''
          ps.stdout.setEncoding('utf8')
          ps.stdout.on('data', (chunk: string) => {
            out += chunk
          })
          ps.on('close', () => resolve(out.trim()))
        })
        assert.equal(survivors, '', `the wrapped command must not outlive the forwarder: ${survivors}`)
      }

      slServer.close()
    }

    console.log('agent-state-service.test.ts: all assertions passed')
  }

  const suiteRun = run().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
