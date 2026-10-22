import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { ConversationProviderManifest } from '../shared/plugin-manifest'
import { canonicalManifestPayload } from '../shared/modules/third-party-manifest'
import { agentCliSupportsConversationResume, agentCliUsesStableSessionIdForResume } from '../shared/agent-cli-resume'
import { createPluginRegistry, validateManifestSource } from './plugin-registry'
import { renderPluginLaunch } from './plugin-render'
import { manifestFingerprint, verifyModuleSignature } from './modules/module-signature'
import { createAppPluginRegistryOptions } from './plugin-registry-instance'
import { test } from 'vitest'

test('plugin-registry', async () => {
  const BUNDLED_ROOT = join(process.cwd(), 'resources', 'plugins')
  const FIXTURE_ROOT = join(process.cwd(), 'tests', 'fixtures', 'plugin-manifests')

  async function main(): Promise<void> {
    await testBundledManifestsLoad()
    await testResumeCapabilitiesProjectedAndConsistent()
    await testClaudeBundledRenderMatchesExpected()
    await testCodexBundledRenderMatchesExpected()
    await testGrokBundledRenderMatchesExpected()
    await testOpencodeBundledRenderMatchesExpected()
    await testKimiCodeBundledRenderMatchesExpected()
    await testCursorBundledRenderMatchesExpected()
    await testBundledManifestsDeclareOnlyCurrentPresets()
    await testFixtureManifestsValidate()
    await testUserPluginCannotAddOrReplaceAnAgentCli()
    await testUserProviderCannotTakeABundledId()
    await testInvalidManifestRejectedWithIssues()
    await testIdDirectoryMismatchRejected()
    await testMissingPermissionPresetsRejected()
    await testInvalidArgvTokenRejected()
    await testSendAfterReadyRequiresReadiness()
    await testCompletionFallbackValidated()
    await testSkillIntegrationValidated()
    await testInvalidSkillIntegrationRejected()
    await testProviderManifestLoadsThroughProviderListOnly()
    await testOpenAiCompatibleProviderConfigValidated()
    await testProviderCliFieldMixingRejected()
    await testCliProviderFieldMixingRejected()
    await testBundledExecutableProviderClassifiedAsExecutable()
    await testUnsignedExecutableProviderBlockedInProduction()
    await testUnsignedExecutableProviderBlockedEvenWhenContentTrusted()
    await testSignedTrustedExecutableProviderClassifiedAsExecutable()
    await testAppRegistryTrustStoreClassifiesSignedProviderExecutable()
    await testTamperedExecutableProviderBlocked()
    await testTamperedExecutableProviderEntryBlocked()
    await testUnsafeExecutableProviderEntryRejected()

    console.log('plugin-registry tests passed')
  }

  async function testBundledManifestsLoad(): Promise<void> {
    const registry = createPluginRegistry({
      bundledRoot: BUNDLED_ROOT,
      userRoot: join(await mkdtemp(join(tmpdir(), 'sprintengine-no-user-plugins-')), 'plugins'),
    })
    const report = await registry.load()
    assert.deepEqual(
      report.rejected,
      [],
      `bundled manifests should validate cleanly: ${JSON.stringify(report.rejected, null, 2)}`,
    )

    const ids = registry
      .list()
      .map((p) => p.id)
      .sort()
    assert.deepEqual(ids, [
      'claude-code',
      'codex',
      'cursor',
      'generic-shell',
      'grok',
      'kimi-claude',
      'kimi-code',
      'muse',
      'opencode',
      'zai',
    ])
    assert.equal(
      registry.listConversationProviders().some((provider) => provider.id === 'openrouter'),
      true,
    )
    assert.equal(
      registry.listConversationProviders().some((provider) => provider.id === 'xai'),
      true,
    )
    // CLI `auth` surfaces only its label to the renderer (gates the key-entry row);
    // CLIs without auth omit the field entirely.
    const zaiEntry = registry.list().find((entry) => entry.id === 'zai')
    assert.deepEqual(zaiEntry?.auth, { label: 'Z.AI API key' })
    const kimiClaudeEntry = registry.list().find((entry) => entry.id === 'kimi-claude')
    assert.deepEqual(kimiClaudeEntry?.auth, { label: 'Moonshot API key' })
    const claudeEntry = registry.list().find((entry) => entry.id === 'claude-code')
    assert.equal(claudeEntry?.auth, undefined)

    // `hostedVia` is derived (claude binary + ANTHROPIC_BASE_URL redirect), never
    // declared: the two hosted-model runtimes carry it, the host itself must not.
    assert.equal(kimiClaudeEntry?.hostedVia, 'claude-code')
    assert.equal(zaiEntry?.hostedVia, 'claude-code')
    assert.equal(claudeEntry?.hostedVia, undefined)

    // Codex's reasoningSelection projects levels + default to the renderer
    // (arg templates stay main-process-only, mirroring modelSelection). `max` and
    // `ultra` are the live catalogue's top levels (`codex debug models`).
    const codexReasoning = registry.list().find((entry) => entry.id === 'codex')?.reasoningSelection
    assert.deepEqual(codexReasoning, {
      levels: [
        { id: 'low', label: 'Low' },
        { id: 'medium', label: 'Medium' },
        { id: 'high', label: 'High' },
        { id: 'xhigh', label: 'Extra high' },
        { id: 'max', label: 'Max' },
        { id: 'ultra', label: 'Ultra' },
      ],
      default: 'medium',
    })

    // claude-code declares the five levels `claude --help` documents (CLI 2.1.220)
    // and NO default: the CLI's own default effort is undocumented, so the picker
    // treats blank as "the CLI decides" and every picked level renders a flag.
    const claudeReasoning = registry.list().find((entry) => entry.id === 'claude-code')?.reasoningSelection
    assert.deepEqual(claudeReasoning, {
      levels: [
        { id: 'low', label: 'Low' },
        { id: 'medium', label: 'Medium' },
        { id: 'high', label: 'High' },
        { id: 'xhigh', label: 'Extra high' },
        { id: 'max', label: 'Max' },
      ],
    })

    const codexEntry = registry.list().find((entry) => entry.id === 'codex')
    assert.equal(codexEntry?.skillIntegration?.support, 'native')
    assert.equal(codexEntry?.skillIntegration?.harnessId, 'codex')
    assert.equal(codexEntry?.skillIntegration?.installTargets.length, 1)
    assert.equal(codexEntry?.skillIntegration?.installTargets[0].path, '{{workspaceRoot}}/.codex/skills/{{skillId}}')
    // False since 2026-07-29: Codex picks up a skill directory created while it
    // is running (verified against codex-cli 0.146.0), so the manifest no longer
    // claims a restart the surface would warn about.
    assert.equal(codexEntry?.skillIntegration?.installTargets[0].restartRequired, false)
    assert.equal(codexEntry?.skillIntegration?.invocation?.fileDropTemplate, 'Use ${{skillId}} to work {{path}}.')
    assert.equal(
      registry.list().some((entry) => entry.id === 'openrouter'),
      false,
      'bundled provider manifests must not appear in the terminal CLI catalog',
    )

    for (const id of ids) {
      const plugin = registry.get(id)
      assert.ok(plugin, `${id} should be retrievable`)
      assert.equal(plugin!.source, 'bundled')
    }
  }

  // Manifest-conformance guardrail (the key regression net): the projection must
  // carry every bundled CLI's resume capabilities, and the resume predicates must
  // agree with the declared manifest capability per plugin. A future CLI wired
  // incorrectly (or a manifest whose capability drifts from the predicate) turns
  // a silent lost-conversation into a red build. Also pins the current bundled
  // values, incl. opencode's deliberate resume-off.
  async function testResumeCapabilitiesProjectedAndConsistent(): Promise<void> {
    const registry = createPluginRegistry({
      bundledRoot: BUNDLED_ROOT,
      userRoot: join(await mkdtemp(join(tmpdir(), 'sprintengine-no-user-plugins-')), 'plugins'),
    })
    await registry.load()

    const expected: Record<string, { resumeSession: boolean; sessionIdFromCaller: boolean }> = {
      'claude-code': { resumeSession: true, sessionIdFromCaller: true },
      zai: { resumeSession: true, sessionIdFromCaller: true },
      codex: { resumeSession: true, sessionIdFromCaller: false },
      opencode: { resumeSession: false, sessionIdFromCaller: false },
      // Grok Build's claude-style resume argv is wired but unverified end-to-end,
      // so resume stays off (the confirm-first discipline) until confirmed
      // against a real install; launch does pass our minted --session-id.
      grok: { resumeSession: false, sessionIdFromCaller: true },
      // Kimi K3 via Claude Code shares the claude binary's endpoint-independent
      // local session store (the verified zai path), so resume is on. The native
      // Kimi Code CLI and Cursor have their resume argv wired but unverified
      // end-to-end, so resume stays off (confirm-first discipline) and both
      // mint their own session ids.
      'kimi-claude': { resumeSession: true, sessionIdFromCaller: true },
      'kimi-code': { resumeSession: false, sessionIdFromCaller: false },
      cursor: { resumeSession: false, sessionIdFromCaller: false },
      'generic-shell': { resumeSession: false, sessionIdFromCaller: false },
      // Muse Code's restart-safety is an in-process guarantee of its local event
      // log, not a caller-driven resume: no --resume/--session-id flag is
      // documented, so it neither resumes nor takes our session id. Both flip
      // together, config-only, once a real install is probed.
      muse: { resumeSession: false, sessionIdFromCaller: false },
    }

    // Hooks-only selectability pins (decision of record 2026-08-31): the entry
    // boolean mirrors agentStateSpec presence, and exactly these two bundled
    // plugins lack one — generic-shell (a bare sh pipe) and muse (its beta
    // ignores its own hooks config; returns to eligibility when hooks GA and its
    // manifest gains a spec). A drift here silently changes which CLIs every
    // agent surface offers.
    const expectedAgentStateCapable: Record<string, boolean> = {
      'claude-code': true,
      zai: true,
      'kimi-claude': true,
      codex: true,
      opencode: true,
      grok: true,
      cursor: true,
      'kimi-code': true,
      'generic-shell': false,
      muse: false,
    }

    for (const entry of registry.list()) {
      const plugin = registry.get(entry.id)
      assert.ok(plugin, `${entry.id} should be retrievable`)
      const caps = plugin!.manifest.capabilities

      // Projection (Approach B): the list entry mirrors the manifest capabilities.
      assert.equal(entry.resumeSession, caps.resumeSession, `${entry.id} projected resumeSession`)
      assert.equal(entry.sessionIdFromCaller, caps.sessionIdFromCaller, `${entry.id} projected sessionIdFromCaller`)
      assert.equal(
        entry.agentStateCapable,
        Boolean(plugin!.manifest.agentStateSpec),
        `${entry.id} projected agentStateCapable`,
      )
      assert.equal(
        entry.agentStateCapable,
        expectedAgentStateCapable[entry.id],
        `${entry.id}: agentStateCapable pin (update the pin AND the epic's gate rationale together)`,
      )

      // Predicate ⟺ declared capability (resolved from the projected entry).
      const resolved = { resumeSession: entry.resumeSession, sessionIdFromCaller: entry.sessionIdFromCaller }
      assert.equal(
        agentCliSupportsConversationResume(resolved),
        caps.resumeSession,
        `${entry.id}: resume predicate must equal capabilities.resumeSession`,
      )
      assert.equal(
        agentCliUsesStableSessionIdForResume(resolved),
        caps.sessionIdFromCaller,
        `${entry.id}: stable-session predicate must equal capabilities.sessionIdFromCaller`,
      )

      const pin = expected[entry.id]
      assert.ok(pin, `unexpected bundled CLI ${entry.id} — update the resume-capability guardrail`)
      assert.deepEqual(
        { resumeSession: entry.resumeSession, sessionIdFromCaller: entry.sessionIdFromCaller },
        pin,
        entry.id,
      )
    }
  }

  async function testClaudeBundledRenderMatchesExpected(): Promise<void> {
    const registry = createPluginRegistry({
      bundledRoot: BUNDLED_ROOT,
      userRoot: join(await mkdtemp(join(tmpdir(), 'sprintengine-no-user-plugins-')), 'plugins'),
    })
    await registry.load()
    const plugin = registry.get('claude-code')
    assert.ok(plugin)

    const launched = renderPluginLaunch(plugin!.manifest, {
      sessionId: 'sid_demo',
      prompt: 'do the thing',
      permissionPreset: 'bypass',
    })
    assert.deepEqual(launched.argv, [
      'claude',
      '--permission-mode',
      'bypassPermissions',
      '--session-id',
      'sid_demo',
      '--',
      'do the thing',
    ])

    // `none` and an unnamed preset send no permission flag: Claude Code runs on
    // its own configured default.
    for (const permissionPreset of ['none', undefined]) {
      const launchedNone = renderPluginLaunch(plugin!.manifest, { sessionId: 'sid_demo', permissionPreset })
      assert.deepEqual(launchedNone.argv, ['claude', '--session-id', 'sid_demo'], `${permissionPreset}: no flag`)
    }
    // Manual is the CLI's asking mode, Auto its own classifier mode.
    for (const [permissionPreset, mode] of [
      ['manual', 'default'],
      ['auto', 'auto'],
    ] as const) {
      const launchedMode = renderPluginLaunch(plugin!.manifest, { sessionId: 'sid_demo', permissionPreset })
      assert.deepEqual(launchedMode.argv, ['claude', '--permission-mode', mode, '--session-id', 'sid_demo'])
    }
  }

  async function testCodexBundledRenderMatchesExpected(): Promise<void> {
    const registry = createPluginRegistry({
      bundledRoot: BUNDLED_ROOT,
      userRoot: join(await mkdtemp(join(tmpdir(), 'sprintengine-no-user-plugins-')), 'plugins'),
    })
    await registry.load()
    const plugin = registry.get('codex')
    assert.ok(plugin)

    const launched = renderPluginLaunch(plugin!.manifest, {
      prompt: 'fix the parser',
      permissionPreset: 'bypass',
    })
    assert.deepEqual(launched.argv, ['codex', '--dangerously-bypass-approvals-and-sandbox', '--', 'fix the parser'])
    const none = renderPluginLaunch(plugin!.manifest, { prompt: 'fix the parser', permissionPreset: 'none' })
    assert.deepEqual(none.argv, ['codex', '--', 'fix the parser'], 'none leaves Codex on its configured approvals')
  }

  async function testGrokBundledRenderMatchesExpected(): Promise<void> {
    const registry = createPluginRegistry({
      bundledRoot: BUNDLED_ROOT,
      userRoot: join(await mkdtemp(join(tmpdir(), 'sprintengine-no-user-plugins-')), 'plugins'),
    })
    await registry.load()
    const plugin = registry.get('grok')
    assert.ok(plugin)

    // --trust rides the bypass preset ONLY: it trusts every project-level .grok
    // config (including hooks committed in the repo itself), so `none` must not
    // carry it — a freshly cloned repo would get arbitrary
    // command execution. The prompt rides last, after `--`: Grok 1.0.41's
    // `--help` documents a positional [PROMPT] for the interactive session, and
    // the separator keeps a one-word prompt from being read as a subcommand.
    const launched = renderPluginLaunch(plugin!.manifest, {
      sessionId: 'sid_demo',
      prompt: 'do the thing',
      permissionPreset: 'bypass',
      model: 'grok-4.5',
    })
    assert.deepEqual(launched.argv, [
      'grok',
      '--always-approve',
      '--trust',
      '--model',
      'grok-4.5',
      '--session-id',
      'sid_demo',
      '--',
      'do the thing',
    ])
    // `none` grants neither a mode nor trust, and Auto and Manual set a mode
    // without trust: trust would run the hooks committed in the repository,
    // which nobody is asked about.
    const launchedAuto = renderPluginLaunch(plugin!.manifest, { sessionId: 'sid_demo', permissionPreset: 'auto' })
    assert.deepEqual(launchedAuto.argv, ['grok', '--permission-mode', 'auto', '--session-id', 'sid_demo'])
    const launchedManual = renderPluginLaunch(plugin!.manifest, { sessionId: 'sid_demo', permissionPreset: 'manual' })
    assert.deepEqual(launchedManual.argv, ['grok', '--permission-mode', 'default', '--session-id', 'sid_demo'])
    const launchedNone = renderPluginLaunch(plugin!.manifest, {
      sessionId: 'sid_demo',
      permissionPreset: 'none',
    })
    assert.deepEqual(launchedNone.argv, ['grok', '--session-id', 'sid_demo'])
    assert.equal(plugin!.manifest.promptInjection.mode, 'positional-arg')
  }

  async function bundledRegistry(): Promise<ReturnType<typeof createPluginRegistry>> {
    const registry = createPluginRegistry({
      bundledRoot: BUNDLED_ROOT,
      userRoot: join(await mkdtemp(join(tmpdir(), 'sprintengine-no-user-plugins-')), 'plugins'),
    })
    await registry.load()
    return registry
  }

  // OpenCode has exactly one permission flag, `--auto`. The bypass preset
  // used to send `--dangerously-skip-permissions`, which OpenCode does not define;
  // its parser is not strict, so the flag was dropped silently and a user who
  // asked for bypass kept getting prompts with no error anywhere. Pin the real
  // flag so the regression cannot come back as another plausible-looking guess.
  async function testOpencodeBundledRenderMatchesExpected(): Promise<void> {
    const registry = await bundledRegistry()
    const plugin = registry.get('opencode')
    assert.ok(plugin)

    const presets = plugin!.manifest.permissionPresets
    assert.deepEqual(presets.bypass?.args, ['--auto'], 'opencode bypass must send the flag that exists')

    const bypassed = renderPluginLaunch(plugin!.manifest, { permissionPreset: 'bypass', prompt: 'do the thing' })
    assert.deepEqual(bypassed.argv, ['opencode', 'run', '--auto', 'do the thing'])

    const none = renderPluginLaunch(plugin!.manifest, { permissionPreset: 'none', prompt: 'do the thing' })
    assert.deepEqual(none.argv, ['opencode', 'run', 'do the thing'])
    assert.equal(none.env.OPENCODE_PERMISSION, undefined)

    // Manual and Auto have no flag: they travel as OpenCode's own permission
    // rule set, the wildcard first so every named tool after it wins.
    for (const [permissionPreset, edit] of [
      ['manual', 'ask'],
      ['auto', 'allow'],
    ] as const) {
      const launched = renderPluginLaunch(plugin!.manifest, { permissionPreset, prompt: 'do the thing' })
      assert.deepEqual(launched.argv, ['opencode', 'run', 'do the thing'])
      const rules = JSON.parse(launched.env.OPENCODE_PERMISSION ?? '{}') as Record<string, string>
      assert.equal(Object.keys(rules)[0], '*')
      assert.deepEqual(
        { '*': rules['*'], read: rules.read, edit: rules.edit, bash: rules.bash },
        { '*': 'ask', read: 'allow', edit, bash: 'ask' },
        permissionPreset,
      )
    }
  }

  // Kimi's flags read backwards from their names: `--yolo` auto-approves
  // regular tool calls but the agent MAY STILL ASK questions, while `--auto` is
  // fully autonomous and never asks. Bypass is `--auto`.
  async function testKimiCodeBundledRenderMatchesExpected(): Promise<void> {
    const registry = await bundledRegistry()
    const plugin = registry.get('kimi-code')
    assert.ok(plugin)

    const presets = plugin!.manifest.permissionPresets
    assert.deepEqual(presets.bypass?.args, ['--auto'], 'the flag that never asks is bypass')

    assert.deepEqual(renderPluginLaunch(plugin!.manifest, { permissionPreset: 'none' }).argv, ['kimi'])
    assert.deepEqual(renderPluginLaunch(plugin!.manifest, { permissionPreset: 'bypass' }).argv, ['kimi', '--auto'])
  }

  // A bundled manifest declares presets under the names the app offers, never
  // a pre-rename spelling, and the list the renderer reads says which ones. A
  // mode of the CLI's own names the preset it sits at, and `none` is keyed only
  // for its label.
  async function testBundledManifestsDeclareOnlyCurrentPresets(): Promise<void> {
    const registry = await bundledRegistry()
    for (const entry of registry.list()) {
      const manifest = registry.get(entry.id)?.manifest
      assert.ok(manifest, `${entry.id}: registry.get must resolve a listed plugin`)
      for (const [name, preset] of Object.entries(manifest.permissionPresets ?? {})) {
        if (name === 'none') {
          assert.deepEqual(preset.args, [], `${manifest.id}: none passes nothing`)
          continue
        }
        assert.ok(
          ['manual', 'auto', 'bypass'].includes(name) ||
            (!['default', 'auto_workspace', 'bypass_all'].includes(name) &&
              ['manual', 'auto', 'bypass'].includes(preset.level ?? '')),
          `${manifest.id}: declares a "${name}" preset`,
        )
      }
      // Every mode the menus list has a name and a line of its own.
      for (const mode of entry.permissionModes ?? []) {
        assert.ok(mode.label.trim(), `${manifest.id}: ${mode.id} is named`)
        if (mode.id !== 'none' || 'none' in manifest.permissionPresets)
          assert.ok(mode.summary?.trim(), `${manifest.id}: ${mode.id} has a summary`)
      }
      assert.deepEqual(
        entry.permissionPresets,
        ['manual', 'none', 'auto', 'bypass'].filter((name) => name === 'none' || name in manifest.permissionPresets),
        `${manifest.id}: listed presets`,
      )
    }
  }

  async function testCursorBundledRenderMatchesExpected(): Promise<void> {
    const registry = await bundledRegistry()
    const plugin = registry.get('cursor')
    assert.ok(plugin)

    const presets = plugin!.manifest.permissionPresets
    assert.deepEqual(presets.bypass?.args, ['--force'], '--yolo is only an alias; one flag is sent')

    // `--model` is already on the launch argv; the empty seed is what left the
    // picker blank. A selected id has to ride the same renderer every spawn uses.
    const withModel = renderPluginLaunch(plugin!.manifest, {
      sessionId: 'sid_cursor',
      prompt: 'fix the tests',
      model: 'composer-2.5',
    })
    assert.deepEqual(withModel.argv, ['cursor-agent', '--model', 'composer-2.5', '--', 'fix the tests'])
    const withoutModel = renderPluginLaunch(plugin!.manifest, {
      sessionId: 'sid_cursor',
      prompt: 'fix the tests',
    })
    assert.deepEqual(
      withoutModel.argv,
      ['cursor-agent', '--', 'fix the tests'],
      'an unset model still launches with no --model, so the CLI default (auto) wins',
    )
  }

  async function testFixtureManifestsValidate(): Promise<void> {
    const registry = createPluginRegistry({
      bundledRoot: FIXTURE_ROOT,
      userRoot: join(await mkdtemp(join(tmpdir(), 'sprintengine-no-user-plugins-')), 'plugins'),
    })
    const report = await registry.load()
    assert.deepEqual(
      report.rejected,
      [],
      `fixture manifests should validate cleanly: ${JSON.stringify(report.rejected, null, 2)}`,
    )
    const ids = registry
      .list()
      .map((p) => p.id)
      .sort()
    assert.deepEqual(ids, ['aider', 'opencode', 'pi'])
  }

  // M-F5: a user plugin named `claude-code` used to replace the built-in
  // launcher — binary, argv and the installer's shell — for every agent that
  // chose Claude Code. Agent CLIs now come from the app bundle only: a CLI
  // manifest in the user root is refused, the bundled one stays, and a new CLI
  // id does not appear either.
  async function testUserPluginCannotAddOrReplaceAnAgentCli(): Promise<void> {
    const userRootParent = await mkdtemp(join(tmpdir(), 'sprintengine-user-plugins-'))
    const userRoot = join(userRootParent, 'plugins')
    const overrideRoot = join(userRoot, 'claude-code')
    await mkdir(overrideRoot, { recursive: true })

    const overrideManifest = {
      id: 'claude-code',
      displayName: 'Claude Code (Custom Fork)',
      version: 2,
      binary: '/usr/local/bin/claude',
      permissionPresets: {
        default: { label: 'Default', args: [] },
      },
      launch: { argv: ['{{binary}}', '--custom'] },
      promptInjection: { mode: 'positional-arg' },
      completion: { mode: 'process-exit' },
      capabilities: {
        resumeSession: false,
        sessionIdFromCaller: true,
        toolUse: true,
        mcpServers: false,
      },
    }
    await writeFile(join(overrideRoot, 'plugin.json'), JSON.stringify(overrideManifest, null, 2), 'utf-8')

    const newCliRoot = join(userRoot, 'aider')
    await mkdir(newCliRoot, { recursive: true })
    await writeFile(
      join(newCliRoot, 'plugin.json'),
      JSON.stringify({ ...overrideManifest, id: 'aider', displayName: 'Aider' }, null, 2),
      'utf-8',
    )

    const report = await createPluginRegistry({ bundledRoot: BUNDLED_ROOT, userRoot }).load()
    const refused = report.rejected.filter((rejected) => rejected.source === 'user')
    assert.equal(refused.length, 2)
    for (const rejected of refused) assert.match(rejected.issues[0]?.message ?? '', /Agent CLIs ship with the app/)
    // The synchronous load the launch path uses answers the same.
    const registry = createPluginRegistry({ bundledRoot: BUNDLED_ROOT, userRoot })
    registry.loadSync()
    const loaded = registry.get('claude-code')
    assert.ok(loaded)
    assert.equal(loaded!.source, 'bundled')
    assert.notEqual(loaded!.manifest.binary, '/usr/local/bin/claude')
    assert.equal(registry.get('aider'), undefined)
    assert.equal(registry.list().filter((p) => p.id === 'claude-code').length, 1)
  }

  // A provider is what the user root is for, but not under a name the app
  // already uses — a CLI's or a bundled provider's.
  async function testUserProviderCannotTakeABundledId(): Promise<void> {
    const userRootParent = await mkdtemp(join(tmpdir(), 'sprintengine-user-providers-'))
    const userRoot = join(userRootParent, 'plugins')
    for (const id of ['claude-agent', 'codex']) {
      await mkdir(join(userRoot, id), { recursive: true })
      await writeFile(
        join(userRoot, id, 'plugin.json'),
        JSON.stringify({
          kind: 'provider',
          id,
          displayName: `Not ${id}`,
          version: 1,
          providerType: 'model-provider',
          models: [{ id: 'm' }],
        }),
        'utf-8',
      )
    }
    const registry = createPluginRegistry({ bundledRoot: BUNDLED_ROOT, userRoot })
    const report = await registry.load()
    const refused = report.rejected.filter((rejected) => rejected.source === 'user')
    assert.equal(refused.length, 2)
    for (const rejected of refused) assert.match(rejected.issues[0]?.message ?? '', /built-in id/)
    assert.notEqual(registry.getConversationProvider('claude-agent')?.source, 'user')
    assert.equal(registry.getConversationProvider('codex'), undefined)
  }

  async function testInvalidManifestRejectedWithIssues(): Promise<void> {
    const result = validateManifestSource('not json')
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.issues.length, 1)
    assert.match(result.issues[0].message, /not valid JSON/)
  }

  async function testSkillIntegrationValidated(): Promise<void> {
    const result = validateManifestSource(
      JSON.stringify({
        id: 'pi',
        displayName: 'Pi',
        version: 1,
        binary: 'pi',
        permissionPresets: { default: { label: 'Default', args: [] } },
        launch: { argv: ['{{binary}}'] },
        promptInjection: { mode: 'stdin-pipe' },
        completion: { mode: 'process-exit' },
        capabilities: {
          resumeSession: false,
          sessionIdFromCaller: false,
          toolUse: false,
          mcpServers: false,
        },
        skillIntegration: {
          support: 'native',
          harnessId: 'pi',
          installTargets: [
            {
              scope: 'workspace',
              path: '{{workspaceRoot}}/.pi/skills/{{skillId}}',
              format: 'generic',
            },
          ],
          invocation: {
            fileDropTemplate: 'pi skill {{skillId}} {{path}}',
          },
        },
      }),
    )
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.manifest.kind, undefined)
    assert.equal(result.manifest.skillIntegration?.support, 'native')
  }

  async function testInvalidSkillIntegrationRejected(): Promise<void> {
    const result = validateManifestSource(
      JSON.stringify({
        id: 'bad-skill-cli',
        displayName: 'Bad Skill CLI',
        version: 1,
        binary: 'bad',
        permissionPresets: { default: { label: 'Default', args: [] } },
        launch: { argv: ['{{binary}}'] },
        promptInjection: { mode: 'stdin-pipe' },
        completion: { mode: 'process-exit' },
        capabilities: {
          resumeSession: false,
          sessionIdFromCaller: false,
          toolUse: false,
          mcpServers: false,
        },
        skillIntegration: {
          support: 'native',
          harnessId: 'bad',
          installTargets: [
            {
              scope: 'workspace',
              path: '{{home}}/.bad/skills/{{skillId}}',
              format: 'generic',
            },
          ],
          invocation: {
            fileDropTemplate: 'bad {{unknown}}',
          },
        },
      }),
    )
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.issues.some((issue) => issue.path === 'skillIntegration.installTargets[0].path'))
    assert.ok(result.issues.some((issue) => issue.path === 'skillIntegration.invocation.fileDropTemplate'))
  }

  async function testIdDirectoryMismatchRejected(): Promise<void> {
    const userRootParent = await mkdtemp(join(tmpdir(), 'sprintengine-mismatch-'))
    const userRoot = join(userRootParent, 'plugins')
    const dir = join(userRoot, 'wrong-dir-name')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'plugin.json'),
      JSON.stringify({
        id: 'plugin-id',
        displayName: 'X',
        version: 1,
        binary: 'x',
        permissionPresets: { default: { label: 'Default', args: [] } },
        launch: { argv: ['{{binary}}'] },
        promptInjection: { mode: 'positional-arg' },
        completion: { mode: 'process-exit' },
        capabilities: {
          resumeSession: false,
          sessionIdFromCaller: false,
          toolUse: false,
          mcpServers: false,
        },
      }),
      'utf-8',
    )
    const registry = createPluginRegistry({ bundledRoot: BUNDLED_ROOT, userRoot })
    const report = await registry.load()
    const mismatch = report.rejected.find((r) => r.manifestPath.includes('wrong-dir-name'))
    assert.ok(mismatch, 'mismatched directory should be rejected')
    assert.match(mismatch!.issues[0].message, /does not match its containing directory/)
  }

  // An empty object is valid (a CLI with no bypass flag declares nothing); a
  // missing or non-object one is not.
  async function testMissingPermissionPresetsRejected(): Promise<void> {
    const result = validateManifestSource(
      JSON.stringify({
        id: 'x',
        displayName: 'X',
        version: 1,
        binary: 'x',
        permissionPresets: [],
        launch: { argv: ['{{binary}}'] },
        promptInjection: { mode: 'positional-arg' },
        completion: { mode: 'process-exit' },
        capabilities: {
          resumeSession: false,
          sessionIdFromCaller: false,
          toolUse: false,
          mcpServers: false,
        },
      }),
    )
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.issues.some((i) => i.path === 'permissionPresets'))
  }

  async function testInvalidArgvTokenRejected(): Promise<void> {
    const result = validateManifestSource(
      JSON.stringify({
        id: 'x',
        displayName: 'X',
        version: 1,
        binary: 'x',
        permissionPresets: { default: { label: 'D', args: [] } },
        launch: { argv: [{ unknownDirective: 'foo' }] },
        promptInjection: { mode: 'positional-arg' },
        completion: { mode: 'process-exit' },
        capabilities: {
          resumeSession: false,
          sessionIdFromCaller: false,
          toolUse: false,
          mcpServers: false,
        },
      }),
    )
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.issues.some((i) => i.message.includes('argv directive')))
  }

  async function testSendAfterReadyRequiresReadiness(): Promise<void> {
    const result = validateManifestSource(
      JSON.stringify({
        id: 'x',
        displayName: 'X',
        version: 1,
        binary: 'x',
        permissionPresets: { default: { label: 'D', args: [] } },
        launch: { argv: ['{{binary}}'] },
        promptInjection: { mode: 'send-after-ready' },
        completion: { mode: 'process-exit' },
        capabilities: {
          resumeSession: false,
          sessionIdFromCaller: false,
          toolUse: false,
          mcpServers: false,
        },
      }),
    )
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.issues.some((i) => i.path === 'promptInjection.readiness'))
  }

  async function testCompletionFallbackValidated(): Promise<void> {
    const result = validateManifestSource(
      JSON.stringify({
        id: 'x',
        displayName: 'X',
        version: 1,
        binary: 'x',
        permissionPresets: { default: { label: 'D', args: [] } },
        launch: { argv: ['{{binary}}'] },
        promptInjection: { mode: 'positional-arg' },
        completion: {
          mode: 'output-sentinel',
          sentinel: 'done',
          fallback: { mode: 'idle-at-prompt' },
        },
        capabilities: {
          resumeSession: false,
          sessionIdFromCaller: false,
          toolUse: false,
          mcpServers: false,
        },
      }),
    )
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(
      result.issues.some((i) => i.path.startsWith('completion.fallback.')),
      'fallback completion validation should surface issues with fallback fields',
    )
  }

  async function testProviderManifestLoadsThroughProviderListOnly(): Promise<void> {
    const userRootParent = await mkdtemp(join(tmpdir(), 'sprintengine-provider-plugins-'))
    const userRoot = join(userRootParent, 'plugins')
    const providerRoot = join(userRoot, 'openai-compatible')
    await mkdir(providerRoot, { recursive: true })
    await writeFile(
      join(providerRoot, 'plugin.json'),
      JSON.stringify({
        kind: 'provider',
        id: 'openai-compatible',
        displayName: 'OpenAI Compatible',
        version: 1,
        providerType: 'model-provider',
        models: [{ id: 'gpt-5', displayName: 'GPT-5' }, { id: 'gpt-5-mini' }],
        auth: { type: 'api-key', label: 'API key', env: 'OPENAI_API_KEY' },
      }),
      'utf-8',
    )

    const registry = createPluginRegistry({ bundledRoot: BUNDLED_ROOT, userRoot })
    const report = await registry.load()
    assert.deepEqual(report.rejected, [])
    assert.equal(registry.get('openai-compatible'), undefined)
    assert.equal(
      registry.listConversationProviders().find((provider) => provider.id === 'claude-agent')?.credentialSource,
      'native',
    )
    assert.ok(registry.getConversationProvider('openai-compatible'))
    assert.ok(
      !registry.list().some((entry) => entry.id === 'openai-compatible'),
      'provider manifests must not appear in the terminal CLI catalog',
    )
    assert.deepEqual(
      registry.listConversationProviders().filter((entry) => entry.id === 'openai-compatible'),
      [
        {
          id: 'openai-compatible',
          displayName: 'OpenAI Compatible',
          source: 'user',
          version: 1,
          providerType: 'model-provider',
          models: [{ id: 'gpt-5', displayName: 'GPT-5' }, { id: 'gpt-5-mini' }],
          supportsDynamicModels: false,
          credentialSource: 'api-key',
          adapter: {
            kind: 'declarative',
            execution: 'declarative',
            trust: 'not_required',
          },
        },
      ],
    )
  }

  async function testProviderCliFieldMixingRejected(): Promise<void> {
    const result = validateManifestSource(
      JSON.stringify({
        kind: 'provider',
        id: 'mixed-provider',
        displayName: 'Mixed Provider',
        version: 1,
        providerType: 'model-provider',
        models: [{ id: 'demo' }],
        binary: 'demo',
      }),
    )
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.issues.some((issue) => issue.path === 'binary'))
  }

  async function testOpenAiCompatibleProviderConfigValidated(): Promise<void> {
    const invalidBase = validateManifestSource(
      JSON.stringify({
        kind: 'provider',
        id: 'openai-compatible',
        displayName: 'OpenAI Compatible',
        version: 1,
        providerType: 'model-provider',
        models: [{ id: 'demo' }],
        openaiCompatible: { baseUrl: 'file:///tmp/provider', chatCompletionsPath: '/v1/chat/completions' },
      }),
    )
    assert.equal(invalidBase.ok, false)
    if (!invalidBase.ok) {
      assert.ok(invalidBase.issues.some((issue) => issue.path === 'openaiCompatible.baseUrl'))
    }

    const invalidPath = validateManifestSource(
      JSON.stringify({
        kind: 'provider',
        id: 'openai-compatible',
        displayName: 'OpenAI Compatible',
        version: 1,
        providerType: 'model-provider',
        models: [{ id: 'demo' }],
        openaiCompatible: { baseUrl: 'https://api.example.test', chatCompletionsPath: '../chat' },
      }),
    )
    assert.equal(invalidPath.ok, false)
    if (!invalidPath.ok) {
      assert.ok(invalidPath.issues.some((issue) => issue.path === 'openaiCompatible.chatCompletionsPath'))
    }

    const invalidModelsPath = validateManifestSource(
      JSON.stringify({
        kind: 'provider',
        id: 'openrouter',
        displayName: 'OpenRouter',
        version: 1,
        providerType: 'model-provider',
        models: [{ id: 'demo' }],
        openaiCompatible: { baseUrl: 'https://openrouter.ai', modelsPath: 'api/v1/models' },
      }),
    )
    assert.equal(invalidModelsPath.ok, false)
    if (!invalidModelsPath.ok) {
      assert.ok(invalidModelsPath.issues.some((issue) => issue.path === 'openaiCompatible.modelsPath'))
    }

    const validDynamic = validateManifestSource(
      JSON.stringify({
        kind: 'provider',
        id: 'openrouter',
        displayName: 'OpenRouter',
        version: 1,
        providerType: 'model-provider',
        models: [{ id: 'openai/gpt-4o-mini', displayName: 'GPT-4o mini' }],
        auth: { type: 'api-key', label: 'OpenRouter API key', env: 'OPENROUTER_API_KEY' },
        openaiCompatible: {
          baseUrl: 'https://openrouter.ai',
          chatCompletionsPath: '/api/v1/chat/completions',
          modelsPath: '/api/v1/models',
        },
      }),
    )
    assert.equal(validDynamic.ok, true, 'a valid OpenRouter manifest with modelsPath passes validation')
  }

  async function testCliProviderFieldMixingRejected(): Promise<void> {
    const result = validateManifestSource(
      JSON.stringify({
        kind: 'cli',
        id: 'mixed-cli',
        displayName: 'Mixed CLI',
        version: 1,
        binary: 'demo',
        permissionPresets: { default: { label: 'D', args: [] } },
        launch: { argv: ['{{binary}}'] },
        promptInjection: { mode: 'positional-arg' },
        completion: { mode: 'process-exit' },
        capabilities: {
          resumeSession: false,
          sessionIdFromCaller: false,
          toolUse: false,
          mcpServers: false,
        },
        providerType: 'model-provider',
      }),
    )
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.issues.some((issue) => issue.path === 'providerType'))
  }

  async function testBundledExecutableProviderClassifiedAsExecutable(): Promise<void> {
    const bundledRoot = await mkdtemp(join(tmpdir(), 'sprintengine-bundled-provider-'))
    const providerRoot = join(bundledRoot, 'bundled-adapter')
    await mkdir(providerRoot, { recursive: true })
    await writeProviderManifest(providerRoot, {
      kind: 'provider',
      id: 'bundled-adapter',
      displayName: 'Bundled Adapter',
      version: 1,
      providerType: 'model-provider',
      models: [{ id: 'demo' }],
      adapter: executableAdapterSpec(),
    })

    const registry = createPluginRegistry({
      bundledRoot,
      userRoot: join(await mkdtemp(join(tmpdir(), 'sprintengine-no-user-plugins-')), 'plugins'),
    })
    const report = await registry.load()
    assert.deepEqual(report.rejected, [])
    const provider = registry.getConversationProvider('bundled-adapter')
    assert.ok(provider)
    assert.deepEqual(provider!.adapter, {
      kind: 'trusted-executable',
      execution: 'executable',
      trust: 'trusted',
      entry: 'dist/provider.js',
    })
  }

  async function testUnsignedExecutableProviderBlockedInProduction(): Promise<void> {
    const userRoot = await createUserProvider('unsigned-adapter', {
      kind: 'provider',
      id: 'unsigned-adapter',
      displayName: 'Unsigned Adapter',
      version: 1,
      providerType: 'model-provider',
      models: [{ id: 'demo' }],
      adapter: executableAdapterSpec(),
    })

    const registry = createPluginRegistry({ bundledRoot: BUNDLED_ROOT, userRoot, productionMode: true })
    const report = await registry.load()
    assert.deepEqual(report.rejected, [])
    const provider = registry.getConversationProvider('unsigned-adapter')
    assert.ok(provider)
    assert.equal(provider!.adapter.execution, 'blocked')
    assert.equal(provider!.adapter.trust, 'unsigned')
    assert.match(provider!.adapter.trustError ?? '', /cannot run in production/)
  }

  async function testUnsignedExecutableProviderBlockedEvenWhenContentTrusted(): Promise<void> {
    const manifest: ConversationProviderManifest = {
      kind: 'provider',
      id: 'trusted-unsigned-adapter',
      displayName: 'Trusted Unsigned Adapter',
      version: 1,
      providerType: 'model-provider',
      models: [{ id: 'demo' }],
      adapter: executableAdapterSpec(),
    }
    const userRoot = await createUserProvider('trusted-unsigned-adapter', manifest)

    const registry = createPluginRegistry({
      bundledRoot: BUNDLED_ROOT,
      userRoot,
      productionMode: true,
      providerTrustContext: {
        trustedModules: new Map([[manifest.id, manifestFingerprint(manifest)]]),
      },
    })
    const report = await registry.load()
    assert.deepEqual(report.rejected, [])
    const provider = registry.getConversationProvider('trusted-unsigned-adapter')
    assert.ok(provider)
    assert.equal(provider!.adapter.execution, 'blocked')
    assert.equal(provider!.adapter.trust, 'unsigned')
  }

  async function testSignedTrustedExecutableProviderClassifiedAsExecutable(): Promise<void> {
    const signed = signProviderManifest({
      kind: 'provider',
      id: 'signed-adapter',
      displayName: 'Signed Adapter',
      version: 1,
      providerType: 'model-provider',
      models: [{ id: 'demo' }],
      adapter: executableAdapterSpec(),
    })
    const fingerprint = verifyModuleSignature(signed).fingerprint
    assert.equal(typeof fingerprint, 'string')
    const userRoot = await createUserProvider('signed-adapter', signed)

    const registry = createPluginRegistry({
      bundledRoot: BUNDLED_ROOT,
      userRoot,
      providerTrustContext: { trustedModules: new Map(), trustedKeyFingerprints: new Set([fingerprint!]) },
    })
    const report = await registry.load()
    assert.deepEqual(report.rejected, [])
    const provider = registry.getConversationProvider('signed-adapter')
    assert.ok(provider)
    assert.equal(provider!.adapter.execution, 'executable')
    assert.equal(provider!.adapter.trust, 'trusted')
    assert.equal(provider!.adapter.fingerprint, fingerprint)
  }

  async function testAppRegistryTrustStoreClassifiesSignedProviderExecutable(): Promise<void> {
    const signed = signProviderManifest({
      kind: 'provider',
      id: 'app-trusted-adapter',
      displayName: 'App Trusted Adapter',
      version: 1,
      providerType: 'model-provider',
      models: [{ id: 'demo' }],
      adapter: executableAdapterSpec(),
    })
    const userRoot = await createUserProvider('app-trusted-adapter', signed)
    const userDataDir = await mkdtemp(join(tmpdir(), 'sprintengine-provider-trust-store-'))
    await writeTrustedModules(userDataDir, { [signed.id]: manifestFingerprint(signed) })

    const registry = createPluginRegistry(createAppPluginRegistryOptions(userDataDir, BUNDLED_ROOT, userRoot))
    const report = await registry.load()
    assert.deepEqual(report.rejected, [])
    const provider = registry.getConversationProvider('app-trusted-adapter')
    assert.ok(provider)
    assert.equal(provider!.adapter.execution, 'executable')
    assert.equal(provider!.adapter.trust, 'trusted')
  }

  async function testTamperedExecutableProviderBlocked(): Promise<void> {
    const signed = signProviderManifest({
      kind: 'provider',
      id: 'tampered-adapter',
      displayName: 'Tampered Adapter',
      version: 1,
      providerType: 'model-provider',
      models: [{ id: 'demo' }],
      adapter: executableAdapterSpec(),
    })
    const tampered: ConversationProviderManifest = { ...signed, displayName: 'Tampered Adapter Changed' }
    const userRoot = await createUserProvider('tampered-adapter', tampered)

    const registry = createPluginRegistry({ bundledRoot: BUNDLED_ROOT, userRoot })
    const report = await registry.load()
    assert.deepEqual(report.rejected, [])
    const provider = registry.getConversationProvider('tampered-adapter')
    assert.ok(provider)
    assert.equal(provider!.adapter.execution, 'blocked')
    assert.equal(provider!.adapter.trust, 'invalid')
    assert.match(provider!.adapter.trustError ?? '', /tampered/)
  }

  async function testTamperedExecutableProviderEntryBlocked(): Promise<void> {
    const signed = signProviderManifest({
      kind: 'provider',
      id: 'entry-tampered-adapter',
      displayName: 'Entry Tampered Adapter',
      version: 1,
      providerType: 'model-provider',
      models: [{ id: 'demo' }],
      adapter: executableAdapterSpec(),
    })
    const userRoot = await createUserProvider('entry-tampered-adapter', signed)
    await writeFile(join(userRoot, 'entry-tampered-adapter', 'dist', 'provider.js'), 'tampered-entry', 'utf-8')

    const registry = createPluginRegistry({
      bundledRoot: BUNDLED_ROOT,
      userRoot,
      providerTrustContext: {
        trustedModules: new Map([[signed.id, manifestFingerprint(signed)]]),
      },
    })
    const report = await registry.load()
    assert.deepEqual(report.rejected, [])
    const provider = registry.getConversationProvider('entry-tampered-adapter')
    assert.ok(provider)
    assert.equal(provider!.adapter.execution, 'blocked')
    assert.equal(provider!.adapter.trust, 'invalid')
    assert.match(provider!.adapter.trustError ?? '', /hash does not match/)
  }

  async function testUnsafeExecutableProviderEntryRejected(): Promise<void> {
    const result = validateManifestSource(
      JSON.stringify({
        kind: 'provider',
        id: 'unsafe-adapter',
        displayName: 'Unsafe Adapter',
        version: 1,
        providerType: 'model-provider',
        models: [{ id: 'demo' }],
        adapter: { kind: 'trusted-executable', entry: '../provider.js', sha256: adapterSha256() },
      }),
    )
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.issues.some((issue) => issue.path === 'adapter.entry'))
  }

  async function createUserProvider(id: string, manifest: ConversationProviderManifest): Promise<string> {
    const userRootParent = await mkdtemp(join(tmpdir(), 'sprintengine-provider-plugins-'))
    const userRoot = join(userRootParent, 'plugins')
    await writeProviderManifest(join(userRoot, id), manifest)
    return userRoot
  }

  async function writeProviderManifest(root: string, manifest: ConversationProviderManifest): Promise<void> {
    await mkdir(root, { recursive: true })
    if (manifest.adapter?.kind === 'trusted-executable') {
      const entryPath = join(root, manifest.adapter.entry)
      await mkdir(dirname(entryPath), { recursive: true })
      await writeFile(entryPath, ADAPTER_CONTENT, 'utf-8')
    }
    await writeFile(join(root, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf-8')
  }

  function signProviderManifest(manifest: ConversationProviderManifest): ConversationProviderManifest {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const signature = sign(null, Buffer.from(canonicalManifestPayload(manifest), 'utf8'), privateKey).toString('base64')
    const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    return {
      ...manifest,
      signature: { algorithm: 'ed25519', publicKey: publicKeyB64, signature },
    }
  }

  async function writeTrustedModules(userDataDir: string, trusted: Record<string, string>): Promise<void> {
    await mkdir(userDataDir, { recursive: true })
    await writeFile(join(userDataDir, 'trusted-modules.json'), JSON.stringify(trusted), 'utf-8')
  }

  const ADAPTER_CONTENT = 'export default function providerAdapter() { return null }\n'

  function executableAdapterSpec(): Extract<ConversationProviderManifest['adapter'], { kind: 'trusted-executable' }> {
    return { kind: 'trusted-executable', entry: 'dist/provider.js', sha256: adapterSha256() }
  }

  function adapterSha256(): string {
    return createHash('sha256').update(Buffer.from(ADAPTER_CONTENT)).digest('hex')
  }

  const suiteRun = main().catch((err) => {
    console.error(err)
    process.exit(1)
  })

  await suiteRun
})
