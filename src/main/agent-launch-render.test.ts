import assert from 'node:assert/strict'
import { join } from 'node:path'

import type { CliPermissionPreset } from '../shared/electron-api'
import {
  argvToPosixShellCommand,
  buildAgentShellCommand,
  cliCredentialLaunchBlock,
  pluginIdForCli,
  quotePosixToken,
  renderAgentLaunchArgv,
  renderAgentLaunchPreview,
  resolveCliRuntimeSettings,
} from './agent-launch-render'
import { createPluginRegistry } from './plugin-registry'
import { declaredPermissionPresets, permissionRenderKey, resolvePermissionArgs } from './plugin-render'
import { buildCodexLegacyNativeAgentLaunchPowerShellScript } from './terminal-launch'
import { __resetPluginRegistryForTest, __setPluginRegistryForTest, getPluginById } from './plugin-registry-instance'
import { test } from 'vitest'

test('agent-launch-render', async () => {
  const BUNDLED_ROOT = join(process.cwd(), 'resources', 'plugins')

  async function main(): Promise<void> {
    await usingBundledRegistry(async () => {
      testPluginCliMapping()
      testClaudeCodeRenderDefault()
      testClaudeCodeRenderWithBypass()
      testClaudeCodeRenderResume()
      testClaudeCodeRenderWithRuntimeBinaryOverride()
      testLaunchExecutesProbedPathAndGuardFailsHard()
      testCodexRenderDefault()
      testCodexRenderWithBypass()
      testEveryBundledCliRendersItsModes()
      testCodexRenderResume()
      testOpenCodeRenderDefault()
      testOpenCodeRenderWithBypassAndModel()
      testOpenCodeRenderResume()
      testClaudeCodeRenderWithModel()
      testCodexRenderWithModel()
      testOrdinaryCliRendersNoLaunchEnv()
      testZaiRenderInjectsLaunchEnv()
      testZaiRenderOmitsModelFlag()
      testKimiClaudeRenderInjectsLaunchEnv()
      testCodexRenderWithReasoning()
      testClaudeCodeRenderWithReasoning()
      testUndeclaredCliRendersNoReasoning()
      testCodexLegacyWindowsReasoning()
      testCliCredentialLaunchBlock()
      testQuoteTokenLeavesSafeStringsBare()
      testQuoteTokenWrapsSpecialChars()
      testArgvToPosixShellCommand()
      testBuildAgentShellCommandClaudeCode()
      testBuildAgentShellCommandCodex()
      testRenderArgvIncludesBinaryAsFirstElement()
      testResolveCliRuntimeSettings()
      testLaunchPreviewMatchesTheLaunchItPreviews()
      testLaunchPreviewCarriesEveryControlOnTheRow()
      testNoHostContextRendersNothingAnywhere()
      testClaudeCodeTakesTheContextFileOnLaunchAndResume()
      testCodexTakesTheContextAsAnEscapedTomlOverride()
      testGrokTakesTheContextTextOnLaunchAndResume()
      testOpenCodeTakesTheContextThroughItsConfigEnv()
      testOpenCodeContextAndPermissionRulesShareOneConfigDocument()
      testPromptFallbackCliRendersNoContextFlag()
      testCursorTakesTheContextAsAPluginDirOnLaunchAndResume()
      testAModuleHostContextSectionRidesTheDeclaredChannel()
      testLaunchPreviewNeverShowsHostContext()
      testLaunchPluginDirsReachLaunchAndResume()
      testLaunchSettingsReachLaunchAndResume()
    })

    console.log('agent-launch-render tests passed')
  }

  async function usingBundledRegistry(fn: () => Promise<void> | void): Promise<void> {
    __resetPluginRegistryForTest()
    const registry = createPluginRegistry({
      bundledRoot: BUNDLED_ROOT,
      userRoot: join(process.cwd(), '.does-not-exist', 'sprintengine', 'plugins'),
    })
    const report = registry.loadSync()
    assert.deepEqual(
      report.rejected,
      [],
      `bundled manifests should load clean: ${JSON.stringify(report.rejected, null, 2)}`,
    )
    __setPluginRegistryForTest(registry, report)
    try {
      await fn()
    } finally {
      __resetPluginRegistryForTest()
    }
  }

  /** The directories named by a launch's `--plugin-dir` flags, in order. */
  function pluginDirFlags(argv: string[]): string[] {
    return argv.flatMap((token, index) => (token === '--plugin-dir' ? [argv[index + 1] ?? ''] : []))
  }

  // The app's own skills, hook and MCP server reach an agent through the launch,
  // for that session only — nothing is written into the person's repository, and
  // a CLI started outside this app gets none of it.
  function testLaunchPluginDirsReachLaunchAndResume(): void {
    const dirs = ['/data/agent-integration/1.2.3/sprintengine-studio', '/data/agent-integration/1.2.3/studio-skills']

    const launch = renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 's1', pluginDirs: dirs })
    assert.deepEqual(pluginDirFlags(launch.argv), dirs, 'one flag per directory, in order')

    const resumed = renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 's1', resume: true, pluginDirs: dirs })
    assert.deepEqual(pluginDirFlags(resumed.argv), dirs, 'a resumed session is re-told the same plugins')

    // The other CLIs that run the same `claude` binary take the same flag.
    for (const cli of ['kimi-claude', 'zai'] as const) {
      assert.deepEqual(
        pluginDirFlags(renderAgentLaunchArgv({ cli, sessionId: 's1', pluginDirs: dirs }).argv),
        dirs,
        cli,
      )
    }
    // Cursor deliberately declares none, though its CLI has the same flag: the
    // directory this app passes carries Claude's nested PascalCase hooks.json,
    // and Cursor reads a flat camelCase one. Opting it in would load the skills
    // and silently lose its agent state, because the workspace install that
    // writes .cursor/hooks.json would be skipped for a hook it cannot read.
    assert.deepEqual(
      pluginDirFlags(renderAgentLaunchArgv({ cli: 'cursor', sessionId: 's1', pluginDirs: dirs }).argv),
      [],
    )

    // Codex declares no `launchPlugins`, so it never sees the flag however many
    // directories the app resolved — its agent state keeps coming from the
    // workspace installer until its own launch-scoped path is verified.
    assert.deepEqual(
      pluginDirFlags(renderAgentLaunchArgv({ cli: 'codex', sessionId: 's1', pluginDirs: dirs }).argv),
      [],
    )

    // And an app that has not materialised its copy yet renders the launch it
    // always did — no empty flag, nothing half-passed.
    assert.deepEqual(pluginDirFlags(renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 's1' }).argv), [])
    assert.deepEqual(
      renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 's1' }).argv,
      renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 's1', pluginDirs: [] }).argv,
    )
  }

  // The `--settings` document a launch asked for actually arrives.
  //
  // This is the regression the render boundary was silently eating: the launch
  // path resolved a status line, handed it to `buildAgentShellCommand` in an
  // object literal, and `renderAgentLaunchArgv` never copied it onto the render
  // context — so every Claude session launched with `--settings {"theme":"…"}`
  // and nothing else, and the app stopped learning how full any context window
  // was. Nothing failed and nothing in the terminal changed, which is exactly why
  // it went unnoticed. TypeScript could not catch it either: a spread in an
  // object literal is exempt from excess-property checking.
  function settingsDocument(argv: string[]): Record<string, unknown> | null {
    const at = argv.indexOf('--settings')
    if (at < 0) return null
    return JSON.parse(argv[at + 1] ?? 'null') as Record<string, unknown>
  }

  function testLaunchSettingsReachLaunchAndResume(): void {
    const statusLine = { type: 'command', command: 'node "/data/hooks/status-line.mjs" --socket "/tmp/a.sock"' }

    const launch = renderAgentLaunchArgv({
      cli: 'claude-code',
      sessionId: 's1',
      colorScheme: 'dark',
      launchSettings: { statusLine },
    })
    assert.deepEqual(
      settingsDocument(launch.argv),
      { theme: 'dark', statusLine },
      'the status line rides the same --settings document as the theme',
    )
    assert.equal(
      launch.argv.filter((token) => token === '--settings').length,
      1,
      'one --settings, never two: repeating the flag is undocumented',
    )

    const resumed = renderAgentLaunchArgv({
      cli: 'claude-code',
      sessionId: 's1',
      resume: true,
      colorScheme: 'dark',
      launchSettings: { statusLine },
    })
    assert.deepEqual(
      settingsDocument(resumed.argv),
      { theme: 'dark', statusLine },
      'a resumed session reports its context usage too',
    )

    // The other CLIs running the same `claude` binary declare the same slot.
    for (const cli of ['kimi-claude', 'zai'] as const) {
      const out = renderAgentLaunchArgv({ cli, sessionId: 's1', launchSettings: { statusLine } })
      assert.deepEqual(settingsDocument(out.argv), { statusLine }, cli)
    }

    // And a launch that resolved none renders exactly the argv it always did.
    assert.deepEqual(
      renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 's1', colorScheme: 'dark', launchSettings: {} }).argv,
      renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 's1', colorScheme: 'dark' }).argv,
    )
  }

  function testPluginCliMapping(): void {
    assert.equal(pluginIdForCli('claude-code'), 'claude-code')
    assert.equal(pluginIdForCli('codex'), 'codex')
  }

  function testResolveCliRuntimeSettings(): void {
    assert.deepEqual(
      resolveCliRuntimeSettings('claude-code', {
        'claude-code': { command: ' /opt/claude/bin/claude ', hostId: 'wsl:Ubuntu' },
      }),
      { command: '/opt/claude/bin/claude', hostId: 'wsl:Ubuntu' },
      'claude-code launch reads its plugin-id command override and the machine it is for',
    )
    assert.deepEqual(
      resolveCliRuntimeSettings('claude-code', {
        'claude-code': { command: '' },
      }),
      { command: '' },
      'a blank claude-code command means manifest binary at render',
    )
    assert.deepEqual(
      resolveCliRuntimeSettings('codex', undefined),
      { command: '' },
      'no override resolves to a blank command (manifest binary at render)',
    )
  }

  function testClaudeCodeRenderDefault(): void {
    const out = renderAgentLaunchArgv({
      cli: 'claude-code',
      sessionId: 'sid_demo',
    })
    assert.deepEqual(out.argv, ['claude', '--session-id', 'sid_demo'])
    assert.equal(out.binary, 'claude')
  }

  // The ordinary CLIs declare no `launch.env`, so the rendered env is empty and
  // their spawn is byte-for-byte unchanged by the provider-env wire.
  function testOrdinaryCliRendersNoLaunchEnv(): void {
    for (const cli of ['claude-code', 'codex', 'opencode'] as const) {
      const out = renderAgentLaunchArgv({ cli, sessionId: 'sid_env' })
      assert.deepEqual(out.env, {}, `${cli} should declare no launch.env`)
    }
  }

  // The Z.AI runtime runs the `claude` binary redirected at Z.AI's
  // Anthropic-compatible endpoint via `launch.env`. The base URL + GLM model map
  // are static; the auth token expands from the resolved `{{secret}}`.
  function testZaiRenderInjectsLaunchEnv(): void {
    const withToken = renderAgentLaunchArgv({
      cli: 'zai',
      sessionId: 'sid_zai',
      secretToken: 'zai-secret-123',
    })
    assert.equal(withToken.binary, 'claude', 'Z.AI runs the claude binary')
    assert.equal(withToken.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic')
    assert.equal(withToken.env.ANTHROPIC_AUTH_TOKEN, 'zai-secret-123')
    assert.equal(withToken.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm-5.2')
    assert.equal(withToken.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.2')
    assert.equal(withToken.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-4.7')

    // With no resolved token, renderEnv drops the empty value so no blank
    // ANTHROPIC_AUTH_TOKEN is injected (the endpoint stays unauthenticated until a
    // key is configured, rather than launching with an empty token).
    const noToken = renderAgentLaunchArgv({ cli: 'zai', sessionId: 'sid_zai2' })
    assert.equal(noToken.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic')
    assert.equal('ANTHROPIC_AUTH_TOKEN' in noToken.env, false, 'no empty token is injected')
  }

  // Model tier is driven entirely by ANTHROPIC_DEFAULT_*_MODEL env, so the Z.AI
  // launch argv must never pass `--model` (which would send a model name to the
  // GLM endpoint and bypass the tier mapping).
  function testZaiRenderOmitsModelFlag(): void {
    const out = renderAgentLaunchArgv({ cli: 'zai', sessionId: 'sid_zai3', cliModel: 'glm-4.7' })
    assert.equal(out.argv.includes('--model'), false, 'Z.AI argv must not carry --model')
  }

  // Codex's reasoningSelection renders `-c model_reasoning_effort="…"` only for a
  // declared non-default level: the default (medium), an unset level, and an
  // undeclared level all leave the argv byte-for-byte unchanged.
  function testCodexRenderWithReasoning(): void {
    const high = renderAgentLaunchArgv({ cli: 'codex', sessionId: 'sid_r1', cliReasoning: 'high' })
    assert.deepEqual(high.argv, ['codex', '-c', 'model_reasoning_effort="high"'])

    const atDefault = renderAgentLaunchArgv({ cli: 'codex', sessionId: 'sid_r2', cliReasoning: 'medium' })
    assert.equal(atDefault.argv.includes('-c'), false, 'default level renders no effort flag')

    const unset = renderAgentLaunchArgv({ cli: 'codex', sessionId: 'sid_r3' })
    assert.equal(unset.argv.includes('-c'), false, 'unset level renders no effort flag')

    // `ultra` and `max` are now declared (they exist on gpt-5.6-sol/terra per
    // `codex debug models`), so they render; a level no manifest declares does not.
    const ultra = renderAgentLaunchArgv({ cli: 'codex', sessionId: 'sid_r4', cliReasoning: 'ultra' })
    assert.deepEqual(ultra.argv, ['codex', '-c', 'model_reasoning_effort="ultra"'])
    const bogus = renderAgentLaunchArgv({ cli: 'codex', sessionId: 'sid_r4b', cliReasoning: 'bogus' })
    assert.equal(bogus.argv.includes('-c'), false, 'undeclared level renders no effort flag')

    // Codex's resume argv declares no reasoningArgs spread: the CLI persists the
    // level per session, so re-passing it would clobber a mid-session change.
    const resume = renderAgentLaunchArgv({
      cli: 'codex',
      sessionId: 'sid_r4c',
      resume: true,
      cliReasoning: 'high',
    })
    assert.deepEqual(
      resume.argv,
      renderAgentLaunchArgv({ cli: 'codex', sessionId: 'sid_r4c', resume: true }).argv,
      'codex resume argv does not re-pass the effort level',
    )
  }

  // claude-code's reasoningSelection (`--effort <level>`, five levels, and
  // deliberately NO declared default because the CLI's own default effort is
  // undocumented). The argv assertions are what catch the silent no-op this item
  // exists to prevent: without the `{"spreadIf": "reasoningArgs"}` entry in its
  // launch argv the declaration renders nothing at all.
  function testClaudeCodeRenderWithReasoning(): void {
    const high = renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 'sid_cr1', cliReasoning: 'high' })
    assert.deepEqual(
      high.argv,
      ['claude', '--effort', 'high', '--session-id', 'sid_cr1'],
      'a picked level renders --effort, after modelArgs and before the session id',
    )

    // With a model too, both spreads render in manifest order.
    const withModel = renderAgentLaunchArgv({
      cli: 'claude-code',
      sessionId: 'sid_cr2',
      cliModel: 'claude-opus-5',
      cliReasoning: 'max',
    })
    assert.deepEqual(withModel.argv, [
      'claude',
      '--model',
      'claude-opus-5',
      '--effort',
      'max',
      '--session-id',
      'sid_cr2',
    ])

    // No declared default means every declared level renders a flag, and only a
    // blank/absent level renders none — the picker's contract.
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const out = renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 'sid_cr3', cliReasoning: level })
      assert.deepEqual(
        out.argv,
        ['claude', '--effort', level, '--session-id', 'sid_cr3'],
        `claude-code renders the declared level ${level}`,
      )
    }

    // An empty or absent level passes no flag, asserted on the rendered argv and
    // byte-compared against the untouched launch.
    const baseline = renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 'sid_cr4' }).argv
    for (const level of [undefined, '', '   ']) {
      assert.deepEqual(
        renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 'sid_cr4', cliReasoning: level }).argv,
        baseline,
        'a blank level leaves the launch argv byte-identical',
      )
    }
    assert.deepEqual(baseline, ['claude', '--session-id', 'sid_cr4'])

    // An undeclared level renders nothing rather than a value the CLI would warn
    // about and ignore.
    assert.deepEqual(
      renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 'sid_cr4', cliReasoning: 'ultra' }).argv,
      baseline,
      'a level claude-code does not declare renders no flag',
    )

    // Resume argv carries no effort: claude-code's resume spec declares no
    // reasoningArgs spread (checked here rather than trusted, since the manifests
    // are inconsistent about which spreads their resume argv repeats).
    assert.deepEqual(
      renderAgentLaunchArgv({
        cli: 'claude-code',
        sessionId: 'sid_cr5',
        resume: true,
        cliReasoning: 'high',
      }).argv,
      ['claude', '--resume', 'sid_cr5'],
      'claude-code resume argv does not re-pass the effort level',
    )
  }

  // A CLI whose manifest declares no reasoningSelection never renders an effort
  // flag, whatever it is handed.
  function testUndeclaredCliRendersNoReasoning(): void {
    for (const cli of ['opencode', 'zai'] as const) {
      assert.equal(getPluginById(cli)?.manifest.reasoningSelection, undefined, `${cli} declares no reasoningSelection`)
      const baseline = renderAgentLaunchArgv({ cli, sessionId: 'sid_nr' }).argv
      for (const level of ['high', 'max', 'ultra']) {
        assert.deepEqual(
          renderAgentLaunchArgv({ cli, sessionId: 'sid_nr', cliReasoning: level }).argv,
          baseline,
          `${cli} ignores a reasoning level entirely`,
        )
      }
    }
  }

  // Kimi K3 via Claude Code runs the `claude` binary redirected at Moonshot's
  // Anthropic-compatible endpoint via `launch.env` (the zai pattern). All model
  // tiers pin kimi-k3 per Moonshot's Claude Code guide; the auth token expands
  // from the resolved `{{secret}}` and is dropped when unconfigured.
  function testKimiClaudeRenderInjectsLaunchEnv(): void {
    const withToken = renderAgentLaunchArgv({
      cli: 'kimi-claude',
      sessionId: 'sid_kimi',
      secretToken: 'moonshot-secret-123',
    })
    assert.equal(withToken.binary, 'claude', 'Kimi K3 (Claude Code) runs the claude binary')
    assert.equal(withToken.env.ANTHROPIC_BASE_URL, 'https://api.moonshot.ai/anthropic')
    assert.equal(withToken.env.ANTHROPIC_AUTH_TOKEN, 'moonshot-secret-123')
    assert.equal(withToken.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'kimi-k3')
    assert.equal(withToken.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'kimi-k3')
    assert.equal(withToken.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'kimi-k3')

    const noToken = renderAgentLaunchArgv({ cli: 'kimi-claude', sessionId: 'sid_kimi2' })
    assert.equal(noToken.env.ANTHROPIC_BASE_URL, 'https://api.moonshot.ai/anthropic')
    assert.equal('ANTHROPIC_AUTH_TOKEN' in noToken.env, false, 'no empty token is injected')
  }

  // A CLI that declares `auth` with no configured key is blocked from launching
  // with an actionable message; a configured key or a CLI without auth proceeds.
  function testCliCredentialLaunchBlock(): void {
    const blocked = cliCredentialLaunchBlock({
      displayName: 'Z.AI',
      auth: { label: 'Z.AI API key' },
      secretConfigured: false,
    })
    assert.equal(blocked?.message, 'Z.AI needs an API key before it can start. Add it in Settings → Agents.')

    assert.equal(
      cliCredentialLaunchBlock({ displayName: 'Z.AI', auth: { label: 'Z.AI API key' }, secretConfigured: true }),
      null,
      'a configured key proceeds',
    )
    assert.equal(
      cliCredentialLaunchBlock({ displayName: 'Claude Code', secretConfigured: false }),
      null,
      'a CLI without auth never blocks',
    )
  }

  function testClaudeCodeRenderWithBypass(): void {
    const out = renderAgentLaunchArgv({
      cli: 'claude-code',
      sessionId: 'sid_42',
      initialPrompt: 'build the auth flow',
      cliPermissionPreset: 'bypass',
    })
    assert.deepEqual(out.argv, [
      'claude',
      '--permission-mode',
      'bypassPermissions',
      '--session-id',
      'sid_42',
      '--',
      'build the auth flow',
    ])
  }

  function testClaudeCodeRenderResume(): void {
    const out = renderAgentLaunchArgv({
      cli: 'claude-code',
      sessionId: 'sid_42',
      resume: true,
    })
    assert.deepEqual(out.argv, ['claude', '--resume', 'sid_42'])
  }

  function testClaudeCodeRenderWithRuntimeBinaryOverride(): void {
    const out = renderAgentLaunchArgv({
      cli: 'claude-code',
      sessionId: 'sid_5',
      cliRuntime: { command: '/opt/claude/bin/claude' },
    })
    assert.deepEqual(out.argv, ['/opt/claude/bin/claude', '--session-id', 'sid_5'])
    assert.equal(out.binary, '/opt/claude/bin/claude')
  }

  function testClaudeCodeRenderWithModel(): void {
    const out = renderAgentLaunchArgv({
      cli: 'claude-code',
      sessionId: 'sid_m1',
      cliModel: 'opus',
      cliPermissionPreset: 'bypass',
    })
    assert.deepEqual(out.argv, [
      'claude',
      '--permission-mode',
      'bypassPermissions',
      '--model',
      'opus',
      '--session-id',
      'sid_m1',
    ])

    // Resume must NOT pass --model: Claude Code persists the model per session id,
    // so a resumed session keeps its own model — including a mid-session `/model`
    // switch. Re-passing the spawned-with model here would clobber that change on
    // every reopen. (Verified empirically against claude 2.1.177.)
    const resumed = renderAgentLaunchArgv({
      cli: 'claude-code',
      sessionId: 'sid_m1',
      resume: true,
      cliModel: 'opus',
    })
    assert.deepEqual(resumed.argv, ['claude', '--resume', 'sid_m1'])
  }

  function testCodexRenderWithModel(): void {
    const out = renderAgentLaunchArgv({
      cli: 'codex',
      sessionId: 'sid_m2',
      cliModel: 'gpt-5-codex',
    })
    assert.deepEqual(out.argv, ['codex', '--model', 'gpt-5-codex'])

    // Resume omits --model, same as Claude Code: the CLI tracks its own session
    // model, so re-passing it would clobber a mid-session switch. This is a
    // per-manifest choice (resume.argv), not engine behavior — a CLI that does NOT
    // persist its session model can keep modelArgs in its own resume.argv. The
    // harness session id IS appended (targeted resume).
    const resumed = renderAgentLaunchArgv({
      cli: 'codex',
      sessionId: 'sid_m2',
      resume: true,
      cliModel: 'gpt-5-codex',
    })
    assert.deepEqual(resumed.argv, ['codex', 'resume', 'sid_m2'])

    // No model selected → manifest renders no model flag at all.
    const noModel = renderAgentLaunchArgv({ cli: 'codex', sessionId: 'sid_m3' })
    assert.deepEqual(noModel.argv, ['codex'])
  }

  function testCodexRenderDefault(): void {
    const out = renderAgentLaunchArgv({
      cli: 'codex',
      sessionId: 'sid_x',
      initialPrompt: 'fix the parser',
    })
    assert.deepEqual(out.argv, ['codex', '--', 'fix the parser'])
  }

  function testCodexRenderWithBypass(): void {
    const out = renderAgentLaunchArgv({
      cli: 'codex',
      sessionId: 'sid_y',
      initialPrompt: 'fix it',
      cliPermissionPreset: 'bypass',
    })
    assert.deepEqual(out.argv, ['codex', '--dangerously-bypass-approvals-and-sandbox', '--', 'fix it'])
  }

  // The four modes, for every bundled CLI: each is that CLI's own setting for
  // it, and `none` is no permission flag at all. A mode a CLI has no setting
  // for is not declared, renders no flag, and is not listed as one it takes.
  function testEveryBundledCliRendersItsModes(): void {
    // Claude Code against another model endpoint keeps acceptEdits for Auto:
    // the classifier mode Claude Code's own Auto uses is not offered there.
    const claudeEndpointModes = {
      manual: ['--permission-mode', 'default'],
      auto: ['--permission-mode', 'acceptEdits'],
      bypass: ['--permission-mode', 'bypassPermissions'],
    }
    const modeArgs: Record<string, Partial<Record<'manual' | 'auto' | 'bypass', string[]>>> = {
      'claude-code': { ...claudeEndpointModes, auto: ['--permission-mode', 'auto'] },
      'kimi-claude': claudeEndpointModes,
      zai: claudeEndpointModes,
      codex: {
        manual: ['--ask-for-approval', 'on-request', '--sandbox', 'read-only'],
        auto: ['--approve-for-me'],
        bypass: ['--dangerously-bypass-approvals-and-sandbox'],
      },
      cursor: { auto: ['--auto-review'], bypass: ['--force'] },
      grok: {
        manual: ['--permission-mode', 'default'],
        auto: ['--permission-mode', 'auto'],
        bypass: ['--always-approve', '--trust'],
      },
      // OpenCode is told Manual and Auto through its environment.
      opencode: { manual: [], auto: [], bypass: ['--auto'] },
      'kimi-code': { bypass: ['--auto'] },
      muse: {},
      'generic-shell': {},
    }
    for (const [cli, modes] of Object.entries(modeArgs)) {
      const plugin = getPluginById(cli)
      assert.ok(plugin, `bundled ${cli} is loaded`)
      for (const mode of ['manual', 'auto', 'bypass'] as const)
        assert.deepEqual(resolvePermissionArgs(plugin!.manifest, mode), modes[mode] ?? [], `${cli}: ${mode} flags`)
      assert.deepEqual(resolvePermissionArgs(plugin!.manifest, 'none'), [], `${cli}: none passes no flag`)
      assert.deepEqual(
        declaredPermissionPresets(plugin!.manifest),
        (['manual', 'none', 'auto', 'bypass'] as const).filter((mode) => mode === 'none' || mode in modes),
        `${cli}: the modes it takes`,
      )
    }

    // And through the launch itself: no flag between the binary and the prompt.
    const none = renderAgentLaunchArgv({
      cli: 'claude-code',
      sessionId: 'sid_n',
      initialPrompt: 'go',
      cliPermissionPreset: 'none',
    })
    assert.deepEqual(none.argv, ['claude', '--session-id', 'sid_n', '--', 'go'])

    // Each CLI's other modes render their own flags at the preset they sit at.
    // A mode at another preset, or one the CLI does not have, renders the
    // preset's own: never nothing, never a flag the CLI lacks.
    const ownModes: Array<[string, CliPermissionPreset, string, string[]]> = [
      ['claude-code', 'auto', 'acceptEdits', ['--permission-mode', 'acceptEdits']],
      ['claude-code', 'manual', 'dontAsk', ['--permission-mode', 'dontAsk']],
      ['claude-code', 'bypass', 'acceptEdits', ['--permission-mode', 'bypassPermissions']],
      ['claude-code', 'auto', 'workspace', ['--permission-mode', 'auto']],
      ['codex', 'auto', 'workspace', ['--ask-for-approval', 'on-request', '--sandbox', 'workspace-write']],
      ['grok', 'auto', 'acceptEdits', ['--permission-mode', 'acceptEdits']],
      ['grok', 'manual', 'dontAsk', ['--permission-mode', 'dontAsk']],
      ['zai', 'manual', 'dontAsk', ['--permission-mode', 'dontAsk']],
      ['cursor', 'auto', 'acceptEdits', ['--auto-review']],
    ]
    for (const [cli, preset, mode, args] of ownModes) {
      const manifest = getPluginById(cli)!.manifest
      assert.deepEqual(
        resolvePermissionArgs(manifest, permissionRenderKey(manifest, preset, mode)),
        args,
        `${cli}: ${mode} at ${preset}`,
      )
    }
  }

  function testCodexRenderResume(): void {
    // Targeted resume: a known harness session id is appended so Codex reattaches
    // that specific conversation (`codex resume <id>`).
    const out = renderAgentLaunchArgv({
      cli: 'codex',
      sessionId: 'sid_z',
      resume: true,
    })
    assert.deepEqual(out.argv, ['codex', 'resume', 'sid_z'])

    // Bare fallback: no harness id known yet → plain `codex resume`.
    const bare = renderAgentLaunchArgv({
      cli: 'codex',
      sessionId: '',
      resume: true,
    })
    assert.deepEqual(bare.argv, ['codex', 'resume'])
  }

  // OpenCode launch: prompt is positional, placed after `run`. The manifest's
  // default preset contributes no permission args, so a bare launch is just
  // [opencode, run, <prompt>]. Renders against the real loaded opencode manifest.
  function testOpenCodeRenderDefault(): void {
    const out = renderAgentLaunchArgv({
      cli: 'opencode',
      sessionId: 'sid_oc',
      initialPrompt: 'fix the parser',
    })
    assert.deepEqual(out.argv, ['opencode', 'run', 'fix the parser'])
    assert.equal(out.binary, 'opencode')
  }

  // OpenCode bypass + model: the bypass preset adds
  // --auto (OpenCode's only permission flag; a fix corrected this from the
  // non-existent --dangerously-skip-permissions) and modelSelection adds --model <id>, both
  // ahead of the positional prompt (launch.argv order: binary, run,
  // permissionArgs, modelArgs, prompt).
  function testOpenCodeRenderWithBypassAndModel(): void {
    const out = renderAgentLaunchArgv({
      cli: 'opencode',
      sessionId: 'sid_oc2',
      initialPrompt: 'build the auth flow',
      cliPermissionPreset: 'bypass',
      cliModel: 'anthropic/claude-opus-4',
    })
    assert.deepEqual(out.argv, [
      'opencode',
      'run',
      '--auto',
      '--model',
      'anthropic/claude-opus-4',
      'build the auth flow',
    ])
  }

  // OpenCode resume: targeted reattach to a known session id via
  // `--continue --session <id>`, with the prompt appended positionally. Default
  // preset contributes no permission/model args.
  function testOpenCodeRenderResume(): void {
    const out = renderAgentLaunchArgv({
      cli: 'opencode',
      sessionId: 'sid_oc3',
      resume: true,
      initialPrompt: 'keep going',
    })
    assert.deepEqual(out.argv, ['opencode', 'run', '--continue', '--session', 'sid_oc3', 'keep going'])
  }

  function testQuoteTokenLeavesSafeStringsBare(): void {
    assert.equal(quotePosixToken('claude'), 'claude')
    assert.equal(quotePosixToken('--session-id'), '--session-id')
    assert.equal(quotePosixToken('sid_42'), 'sid_42')
    assert.equal(quotePosixToken('/opt/claude/bin/claude'), '/opt/claude/bin/claude')
  }

  function testQuoteTokenWrapsSpecialChars(): void {
    assert.equal(quotePosixToken('hello world'), `'hello world'`)
    assert.equal(quotePosixToken(`don't`), `'don'"'"'t'`)
    assert.equal(quotePosixToken('a;b'), `'a;b'`)
  }

  function testArgvToPosixShellCommand(): void {
    const shell = argvToPosixShellCommand([
      'claude',
      '--permission-mode',
      'bypassPermissions',
      '--session-id',
      'sid_42',
      'build the auth flow',
    ])
    assert.equal(shell, `claude --permission-mode bypassPermissions --session-id sid_42 'build the auth flow'`)
  }

  function testBuildAgentShellCommandClaudeCode(): void {
    const out = buildAgentShellCommand({
      cli: 'claude-code',
      sessionId: 'sid_42',
      initialPrompt: 'hello there',
      cliPermissionPreset: 'bypass',
    })
    assert.equal(
      out,
      `if ! command -v claude >/dev/null 2>&1; then echo 'Claude CLI was not found. Check the claude-code command in Settings.' >&2; exit 127; fi; claude --permission-mode bypassPermissions --session-id sid_42 -- 'hello there'`,
    )

    const resumeOut = buildAgentShellCommand({
      cli: 'claude-code',
      sessionId: 'sid_42',
      resume: true,
    })
    assert.equal(
      resumeOut,
      `if ! command -v claude >/dev/null 2>&1; then echo 'Claude CLI was not found. Check the claude-code command in Settings.' >&2; exit 127; fi; claude --resume sid_42`,
    )

    // The level survives quoting into the shell command every posix/WSL launch
    // runs — the layer between the rendered argv and the spawned process.
    assert.equal(
      buildAgentShellCommand({ cli: 'claude-code', sessionId: 'sid_43', cliReasoning: 'xhigh' }),
      `if ! command -v claude >/dev/null 2>&1; then echo 'Claude CLI was not found. Check the claude-code command in Settings.' >&2; exit 127; fi; claude --effort xhigh --session-id sid_43`,
    )
    assert.equal(
      buildAgentShellCommand({ cli: 'claude-code', sessionId: 'sid_43', resume: true, cliReasoning: 'xhigh' }),
      buildAgentShellCommand({ cli: 'claude-code', sessionId: 'sid_43', resume: true }),
      'the resume shell command carries no effort flag',
    )
  }

  function testRenderArgvIncludesBinaryAsFirstElement(): void {
    // The PowerShell launch path relies on argv[0] being the binary so it can
    // hand the tail to base64-encoded $arguments. Guard against regressions in
    // the argv shape that would break Windows-native launches for Claude and
    // any future plugin.
    const claude = renderAgentLaunchArgv({
      cli: 'claude-code',
      sessionId: 'sid_win',
      initialPrompt: 'do it',
      cliPermissionPreset: 'bypass',
    })
    assert.equal(claude.argv[0], 'claude')
    assert.deepEqual(claude.argv.slice(1), [
      '--permission-mode',
      'bypassPermissions',
      '--session-id',
      'sid_win',
      '--',
      'do it',
    ])

    const claudeOverride = renderAgentLaunchArgv({
      cli: 'claude-code',
      sessionId: 'sid_win',
      cliRuntime: { command: 'C:/tools/claude.exe' },
    })
    assert.equal(claudeOverride.argv[0], 'C:/tools/claude.exe')
    assert.equal(claudeOverride.binary, 'C:/tools/claude.exe')
  }

  function testBuildAgentShellCommandCodex(): void {
    const out = buildAgentShellCommand({
      cli: 'codex',
      sessionId: 'sid_y',
      initialPrompt: 'fix it',
      cliPermissionPreset: 'bypass',
    })
    assert.equal(
      out,
      `if ! command -v codex >/dev/null 2>&1; then echo 'Codex CLI was not found. Check the codex command in Settings.' >&2; exit 127; fi; codex --dangerously-bypass-approvals-and-sandbox -- 'fix it'`,
    )

    const resumeOut = buildAgentShellCommand({
      cli: 'codex',
      sessionId: 'sid_y',
      resume: true,
    })
    assert.equal(
      resumeOut,
      `if ! command -v codex >/dev/null 2>&1; then echo 'Codex CLI was not found. Check the codex command in Settings.' >&2; exit 127; fi; codex resume sid_y`,
    )
  }

  // Two halves of the same defect:
  //
  // 1. The probe resolves an absolute path (it consults the user's interactive
  //    shell); the launch shell does not source that config, so it must EXECUTE
  //    that path rather than the bare manifest name.
  // 2. The guard must exit non-zero. This snippet is joined ahead of an
  //    `exec $SHELL -l`, so a guard that echoed and fell through left the user in
  //    a bare shell with no agent, while the spawn reported success.
  function testLaunchExecutesProbedPathAndGuardFailsHard(): void {
    const resolved = buildAgentShellCommand({
      cli: 'claude-code',
      sessionId: 'sid_probed',
      resolvedBinaryPath: '/Users/dev/.nvm/versions/node/v22.3.0/bin/claude',
    })
    assert.equal(
      resolved,
      `if ! command -v /Users/dev/.nvm/versions/node/v22.3.0/bin/claude >/dev/null 2>&1; then ` +
        `echo 'Claude CLI was not found. Check the claude-code command in Settings.' >&2; exit 127; fi; ` +
        `/Users/dev/.nvm/versions/node/v22.3.0/bin/claude --session-id sid_probed`,
      'both the guard and the invocation use the probed absolute path',
    )

    // A path with spaces stays one shell word on both sides of the guard.
    const quoted = buildAgentShellCommand({
      cli: 'codex',
      sessionId: 'sid_space',
      resolvedBinaryPath: '/Applications/My Tools/codex',
    })
    assert.ok(
      quoted.startsWith(`if ! command -v '/Applications/My Tools/codex' >/dev/null 2>&1;`),
      `probed path must be quoted in the guard: ${quoted}`,
    )
    assert.ok(
      quoted.endsWith(`'/Applications/My Tools/codex'`),
      `probed path must be quoted in the invocation: ${quoted}`,
    )

    // The probe runs against the user's command override, so its resolved path IS
    // that override made absolute and outranks the bare override name.
    assert.equal(
      renderAgentLaunchArgv({
        cli: 'claude-code',
        sessionId: 'sid_both',
        cliRuntime: { command: 'claude' },
        resolvedBinaryPath: '/opt/homebrew/bin/claude',
      }).binary,
      '/opt/homebrew/bin/claude',
    )

    // The guard's failure branch reaches no interactive shell: the launch script
    // appends `exec $SHELL -l` after this snippet, and `exit` ends the script.
    const guardFailure = resolved.slice(0, resolved.indexOf('fi;') + 2)
    assert.ok(/exit 127;\s*fi$/.test(guardFailure), `guard must exit non-zero: ${guardFailure}`)
    assert.ok(!/else/.test(resolved), 'the guard no longer falls through to an else branch')
  }

  // Decode the base64-wrapped `$arguments = @(...)` line that the Windows-native
  // launch scripts emit, so a test can assert on the real argv the codex CLI
  // receives rather than on the obfuscated script text. Base64 payloads never
  // contain a single quote, so the single-quote delimiter match is unambiguous.
  function decodeWindowsScriptArgs(script: string): string[] {
    const argsLine = script.split('\r\n').find((line) => line.startsWith('$arguments = @('))
    assert.ok(argsLine, 'rendered script defines an $arguments array')
    return [...argsLine.matchAll(/FromBase64String\('([^']*)'\)/g)].map(([, b64]) =>
      Buffer.from(b64, 'base64').toString('utf8'),
    )
  }

  // Native Windows uses the manifest renderer for effort and permission flags.
  // Keep coverage at the generated-script boundary so dropped arguments are
  // caught even when the shared renderer itself is correct.
  function testCodexLegacyWindowsReasoning(): void {
    const cwd = 'C:/work/repo'
    const runtime = { command: '' }
    const script = (reasoning?: string): string[] =>
      decodeWindowsScriptArgs(
        buildCodexLegacyNativeAgentLaunchPowerShellScript(
          'sid_legacy_r',
          false,
          cwd,
          'go',
          runtime,
          'none',
          'gpt-5.6-sol',
          reasoning,
        ),
      )

    assert.deepEqual(
      script('high'),
      ['-C', cwd, '--model', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="high"', '--', 'go'],
      'codex-legacy renders the effort flag after the model flag',
    )
    const baseline = script(undefined)
    assert.deepEqual(baseline, ['-C', cwd, '--model', 'gpt-5.6-sol', '--', 'go'])
    for (const level of [undefined, '', 'medium', 'bogus']) {
      assert.deepEqual(script(level), baseline, `codex-legacy passes no effort flag for ${JSON.stringify(level)}`)
    }

    // Resume leaves the session's effort alone, as declared by its manifest.
    const resumeArgs = (reasoning?: string): string[] =>
      decodeWindowsScriptArgs(
        buildCodexLegacyNativeAgentLaunchPowerShellScript(
          'sid_legacy_r',
          true,
          cwd,
          undefined,
          runtime,
          'none',
          'gpt-5.6-sol',
          reasoning,
        ),
      )
    assert.deepEqual(
      resumeArgs('high'),
      resumeArgs(undefined),
      'codex-legacy resume argv does not re-pass the effort level',
    )
    assert.equal(
      resumeArgs('high').some((arg) => arg.includes('model_reasoning_effort')),
      false,
      'codex-legacy resume argv carries no effort config override',
    )
  }

  // The new-agent tab prints the invocation a spawn WOULD make. The
  // value of that line is entirely in it being true, so it is rendered through
  // renderAgentLaunchArgv — these two tests are the proof, and they fail the day
  // someone reimplements the preview by hand.
  function testLaunchPreviewMatchesTheLaunchItPreviews(): void {
    const cases: Array<{ cli: 'claude-code' | 'codex' | 'opencode'; model?: string; preset?: CliPermissionPreset }> = [
      { cli: 'claude-code' },
      { cli: 'claude-code', preset: 'bypass', model: 'claude-opus-5' },
      { cli: 'codex', preset: 'bypass' },
      { cli: 'codex', preset: 'none' },
      { cli: 'opencode', model: 'anthropic/claude-opus-5' },
    ]

    for (const { cli, model, preset } of cases) {
      const preview = renderAgentLaunchPreview({
        cli,
        cliModel: model,
        cliPermissionPreset: preset,
      })
      // The same inputs through the spawn's own renderer, prompt-free and on the
      // preview's placeholder session, must produce the identical argv.
      const launched = renderAgentLaunchArgv({
        cli,
        sessionId: 'preview',
        cliModel: model,
        cliPermissionPreset: preset,
      })

      assert.deepEqual(
        [preview.binary, ...preview.args],
        launched.argv,
        `${cli}: the preview must BE the launch argv, not a copy of it`,
      )
      assert.equal(
        preview.display,
        argvToPosixShellCommand(launched.argv),
        `${cli}: the display line is the same argv, posix-quoted`,
      )
      assert.equal(preview.args.includes('preview'), preview.args.includes('preview'))
    }
  }

  // Every control the argument row offers has to reach the line; a control whose
  // change leaves the receipt unmoved is a control the user cannot verify.
  function testLaunchPreviewCarriesEveryControlOnTheRow(): void {
    const base = renderAgentLaunchPreview({ cli: 'claude-code' })

    const bypassed = renderAgentLaunchPreview({ cli: 'claude-code', cliPermissionPreset: 'bypass' })
    assert.ok(
      bypassed.args.includes('--permission-mode') && bypassed.args.includes('bypassPermissions'),
      'approval reaches the line as the flag it becomes',
    )
    assert.notEqual(base.display, bypassed.display, 'changing approval moves the line')

    const withModel = renderAgentLaunchPreview({ cli: 'claude-code', cliModel: 'claude-opus-5' })
    assert.ok(withModel.args.includes('--model') && withModel.args.includes('claude-opus-5'), 'model reaches the line')

    const withReasoning = renderAgentLaunchPreview({
      cli: 'claude-code',
      cliModel: 'claude-opus-5',
      cliReasoning: 'high',
    })
    assert.notEqual(withModel.display, withReasoning.display, 'reasoning moves the line on a CLI that declares levels')

    assert.equal(base.display, renderAgentLaunchPreview({ cli: 'claude-code' }).display, 'the preview is stable')

    // The runtime override is what actually gets executed, so it is what shows.
    const overridden = renderAgentLaunchPreview({
      cli: 'claude-code',
      cliRuntime: { command: '/opt/homebrew/bin/claude' },
    })
    assert.equal(overridden.binary, '/opt/homebrew/bin/claude', 'the receipt names the binary that will run')
  }

  // ── Host context ────────────────────────────────────────────────────────────
  //
  // One document, delivered per the manifest's `contextInjection`. These run
  // against the BUNDLED manifests through the same renderer every spawn uses, so a
  // manifest edit that broke a channel fails here rather than in a real session.

  const HOST_CONTEXT_FILE = '/ctx/sid.md'
  const HOST_CONTEXT_TEXT = 'Host context.\nA design system is attached at `design-system/`.'

  // A launch with nothing to say renders no flag and no env, on every CLI. This is
  // the invariant that keeps an ordinary repo's spawn byte-identical.
  function testNoHostContextRendersNothingAnywhere(): void {
    for (const cli of ['claude-code', 'codex', 'grok', 'opencode', 'cursor'] as const) {
      const out = renderAgentLaunchArgv({ cli, sessionId: 'sid_none' })
      assert.ok(!out.argv.includes('--append-system-prompt-file'), cli)
      assert.ok(!out.argv.includes('--append-system-prompt'), cli)
      assert.ok(!out.argv.includes('--plugin-dir'), cli)
      assert.ok(!out.argv.some((arg) => arg.startsWith('developer_instructions=')), cli)
      assert.equal('OPENCODE_CONFIG_CONTENT' in out.env, false, cli)
    }
  }

  function testClaudeCodeTakesTheContextFileOnLaunchAndResume(): void {
    const launch = renderAgentLaunchArgv({
      cli: 'claude-code',
      sessionId: 'sid_ctx',
      contextFile: HOST_CONTEXT_FILE,
      contextText: HOST_CONTEXT_TEXT,
    })
    assert.deepEqual(launch.argv, [
      'claude',
      '--append-system-prompt-file',
      HOST_CONTEXT_FILE,
      '--session-id',
      'sid_ctx',
    ])
    // Being re-told on resume is the whole reason this moved off the first user
    // message: the old prompt append was skipped entirely when resuming.
    const resume = renderAgentLaunchArgv({
      cli: 'claude-code',
      sessionId: 'sid_ctx',
      resume: true,
      contextFile: HOST_CONTEXT_FILE,
      contextText: HOST_CONTEXT_TEXT,
    })
    assert.deepEqual(resume.argv, ['claude', '--append-system-prompt-file', HOST_CONTEXT_FILE, '--resume', 'sid_ctx'])
    // The two hosted-model runtimes run the same binary and take the same flag.
    for (const cli of ['kimi-claude', 'zai'] as const) {
      const hosted = renderAgentLaunchArgv({
        cli,
        sessionId: 'sid_ctx',
        contextFile: HOST_CONTEXT_FILE,
        contextText: HOST_CONTEXT_TEXT,
      })
      assert.ok(hosted.argv.includes('--append-system-prompt-file'), cli)
    }
  }

  function testCodexTakesTheContextAsAnEscapedTomlOverride(): void {
    const launch = renderAgentLaunchArgv({
      cli: 'codex',
      sessionId: 'sid_ctx',
      contextFile: HOST_CONTEXT_FILE,
      contextText: HOST_CONTEXT_TEXT,
    })
    const override = launch.argv[launch.argv.indexOf('-c') + 1]
    // `-c` parses its value as TOML: a raw newline would be a parse error, and a
    // raw quote would silently truncate the document.
    assert.equal(override, 'developer_instructions="Host context.\\nA design system is attached at `design-system/`."')
    assert.ok(!override.includes('\n'), 'no literal newline reaches codex’s TOML parser')

    // Codex persists its own per-session config, so re-passing the override on
    // resume would clobber whatever the session already has — the same rule the
    // reasoning-effort override follows there.
    const resume = renderAgentLaunchArgv({
      cli: 'codex',
      sessionId: 'sid_ctx',
      resume: true,
      contextFile: HOST_CONTEXT_FILE,
      contextText: HOST_CONTEXT_TEXT,
    })
    assert.ok(!resume.argv.some((arg) => arg.startsWith('developer_instructions=')))
  }

  function testGrokTakesTheContextTextOnLaunchAndResume(): void {
    for (const resume of [false, true]) {
      const out = renderAgentLaunchArgv({
        cli: 'grok',
        sessionId: 'sid_ctx',
        resume,
        contextFile: HOST_CONTEXT_FILE,
        contextText: HOST_CONTEXT_TEXT,
      })
      const flagAt = out.argv.indexOf('--append-system-prompt')
      assert.ok(flagAt >= 0, `grok should carry the flag (resume: ${resume})`)
      // Text, not a path: grok documents no file-taking variant.
      assert.equal(out.argv[flagAt + 1], HOST_CONTEXT_TEXT)
    }
  }

  function testAModuleHostContextSectionRidesTheDeclaredChannel(): void {
    const text = [HOST_CONTEXT_TEXT, '', '## Weather Deck', '', 'Use the weather CLI for forecast tools.'].join('\n')
    const grok = renderAgentLaunchArgv({
      cli: 'grok',
      sessionId: 'sid_mod',
      contextFile: HOST_CONTEXT_FILE,
      contextText: text,
    })
    const grokFlag = grok.argv.indexOf('--append-system-prompt')
    assert.ok(grokFlag >= 0)
    assert.equal(grok.argv[grokFlag + 1], text)
    assert.ok(String(grok.argv[grokFlag + 1]).includes('## Weather Deck'))

    const claude = renderAgentLaunchArgv({
      cli: 'claude-code',
      sessionId: 'sid_mod',
      contextFile: HOST_CONTEXT_FILE,
      contextText: text,
    })
    assert.deepEqual(
      [claude.argv[claude.argv.indexOf('--append-system-prompt-file') + 1]],
      [HOST_CONTEXT_FILE],
      'claude still takes the file; the extra section lives in the document, not the argv',
    )
  }

  function testOpenCodeTakesTheContextThroughItsConfigEnv(): void {
    for (const resume of [false, true]) {
      const out = renderAgentLaunchArgv({
        cli: 'opencode',
        sessionId: 'sid_ctx',
        resume,
        contextFile: HOST_CONTEXT_FILE,
        contextText: HOST_CONTEXT_TEXT,
      })
      assert.equal(out.env.OPENCODE_CONFIG_CONTENT, `{"instructions":[${JSON.stringify(HOST_CONTEXT_FILE)}]}`)
      // The env is the channel; nothing goes on the command line.
      assert.ok(!out.argv.some((arg) => arg.includes('instructions')), 'no argv leakage')
    }
    // A Windows path has backslashes, which are escapes inside a JSON string: the
    // path is embedded as a JSON literal so the config still parses.
    const windowsFile = 'C:\\Users\\me\\AppData\\Roaming\\Studio\\host-context\\sid.md'
    const windows = renderAgentLaunchArgv({
      cli: 'opencode',
      sessionId: 'sid_ctx',
      contextFile: windowsFile,
      contextText: HOST_CONTEXT_TEXT,
    })
    const parsed = JSON.parse(windows.env.OPENCODE_CONFIG_CONTENT) as { instructions: string[] }
    assert.deepEqual(parsed.instructions, [windowsFile])
  }

  // OpenCode 2 reads its permission rules only from the config document, which
  // also carries the host context's instructions: both must arrive, on launch
  // and on resume, and the variable 1.x reads still goes with them.
  function testOpenCodeContextAndPermissionRulesShareOneConfigDocument(): void {
    for (const resume of [false, true]) {
      for (const [preset, edit] of [
        ['manual', 'ask'],
        ['auto', 'allow'],
      ] as const) {
        const out = renderAgentLaunchArgv({
          cli: 'opencode',
          sessionId: 'sid_ctx',
          resume,
          cliPermissionPreset: preset,
          contextFile: HOST_CONTEXT_FILE,
          contextText: HOST_CONTEXT_TEXT,
        })
        const content = JSON.parse(out.env.OPENCODE_CONFIG_CONTENT) as {
          instructions: string[]
          permission: Record<string, string>
        }
        assert.deepEqual(content.instructions, [HOST_CONTEXT_FILE], `${preset}: the context is kept`)
        assert.equal(Object.keys(content.permission)[0], '*', `${preset}: the wildcard leads`)
        assert.equal(content.permission.bash, 'ask', `${preset}: commands ask`)
        assert.equal(content.permission.edit, edit, `${preset}: edits`)
        assert.deepEqual(JSON.parse(out.env.OPENCODE_PERMISSION), content.permission, `${preset}: 1.x is told the same`)
      }
    }
  }

  // A CLI with no out-of-band channel declares `prompt`: main wraps the document
  // into the prompt instead, and the manifest renders no flag and no env.
  function testPromptFallbackCliRendersNoContextFlag(): void {
    for (const cli of ['kimi-code', 'muse'] as const) {
      const out = renderAgentLaunchArgv({
        cli,
        sessionId: 'sid_ctx',
        contextFile: HOST_CONTEXT_FILE,
        contextText: HOST_CONTEXT_TEXT,
      })
      assert.ok(!out.argv.includes(HOST_CONTEXT_FILE), cli)
      assert.ok(!out.argv.includes(HOST_CONTEXT_TEXT), cli)
      assert.deepEqual(out.env, {}, cli)
    }
  }

  // Cursor has no system-prompt flag. The document is packed as a plugin
  // directory and handed over --plugin-dir, on launch AND resume, so a resumed
  // session is still told — the same reason Claude's file flag rides resume.
  function testCursorTakesTheContextAsAPluginDirOnLaunchAndResume(): void {
    const pluginDir = '/ctx/sid-plugin'
    const launch = renderAgentLaunchArgv({
      cli: 'cursor',
      sessionId: 'sid_ctx',
      initialPrompt: 'fix the tests',
      contextFile: pluginDir,
      contextText: HOST_CONTEXT_TEXT,
    })
    assert.deepEqual(launch.argv, ['cursor-agent', '--plugin-dir', pluginDir, '--', 'fix the tests'])
    assert.ok(!launch.argv.includes(HOST_CONTEXT_TEXT), 'the document itself does not ride argv or the prompt')
    const resume = renderAgentLaunchArgv({
      cli: 'cursor',
      sessionId: 'sid_ctx',
      resume: true,
      contextFile: pluginDir,
      contextText: HOST_CONTEXT_TEXT,
    })
    assert.deepEqual(resume.argv, ['cursor-agent', '--plugin-dir', pluginDir, '--continue', '--resume', 'sid_ctx'])
  }

  // The receipt line previews the flags a launch would carry. Host context is not
  // one of them: it is not a control on the row, and a whole markdown document (or
  // a userData path) rendered into a one-line receipt tells the reader nothing.
  function testLaunchPreviewNeverShowsHostContext(): void {
    const preview = renderAgentLaunchPreview({ cli: 'claude-code' })
    assert.ok(!preview.args.includes('--append-system-prompt-file'))
  }

  const suiteRun = main().catch((err) => {
    console.error(err)
    process.exit(1)
  })

  await suiteRun
})
