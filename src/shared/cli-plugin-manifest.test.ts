import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'

import { parseCliPluginManifest, validateCliPluginManifest, type CliPluginManifest } from './cli-plugin-manifest'

// A minimal-but-complete valid CLI plugin manifest.
const VALID: CliPluginManifest = {
  id: 'my-cli',
  displayName: 'My CLI',
  version: 1,
  binary: 'my-cli',
  permissionPresets: { bypass: { label: 'Bypass', args: ['--yes'] } },
  launch: { argv: ['my-cli', { spreadIf: 'extraArgs' }] },
  promptInjection: { mode: 'positional-arg' },
  completion: { mode: 'process-exit' },
  capabilities: { resumeSession: false, sessionIdFromCaller: false, toolUse: false, mcpServers: false },
}

test('accepts a minimal valid CLI manifest', () => {
  const result = validateCliPluginManifest(VALID)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.manifest.id, 'my-cli')
})

test('accepts a CLI with no bypass flag, which declares no presets', () => {
  assert.equal(validateCliPluginManifest({ ...VALID, permissionPresets: {} }).ok, true)
})

test('still accepts a manifest declaring presets from earlier vocabularies', () => {
  const legacy = { ...VALID, permissionPresets: { default: { label: 'Default', args: [] } } }
  assert.equal(validateCliPluginManifest(legacy).ok, true)
})

test('reports the offending path for each invalid field', () => {
  const result = validateCliPluginManifest({
    id: 'Bad Id',
    displayName: '',
    version: 0,
    binary: 'x',
    permissionPresets: [],
    launch: { argv: [] },
    promptInjection: { mode: 'nope' },
    completion: { mode: 'output-sentinel' },
    capabilities: { resumeSession: 'yes' },
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  const paths = result.issues.map((issue) => issue.path)
  assert.ok(paths.includes('id'))
  assert.ok(paths.includes('displayName'))
  assert.ok(paths.includes('version'))
  assert.ok(paths.includes('permissionPresets'))
  assert.ok(paths.includes('launch.argv'))
  assert.ok(paths.includes('promptInjection.mode'))
  assert.ok(paths.includes('completion.sentinel'))
  assert.ok(paths.includes('capabilities.resumeSession'))
})

test('requires a readiness signal for send-after-ready injection', () => {
  const result = validateCliPluginManifest({ ...VALID, promptInjection: { mode: 'send-after-ready' } })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.issues.some((issue) => issue.path === 'promptInjection.readiness'))
})

test('accepts both readiness signals for send-after-ready, and input overflow env', () => {
  for (const readiness of [
    { type: 'bracketed-paste', timeoutMs: 20_000 },
    { type: 'output-match', pattern: 'context: \\d+%', timeoutMs: 60_000 },
  ]) {
    const result = validateCliPluginManifest({
      ...VALID,
      promptInjection: { mode: 'send-after-ready', readiness, overflow: { mode: 'input', env: { NO_UPDATE: '1' } } },
    })
    assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues))
  }
})

test('rejects a readiness it cannot act on, and a file overflow for send-after-ready', () => {
  const cases: Array<[unknown, string]> = [
    [
      { mode: 'send-after-ready', readiness: { type: 'output-match', pattern: '(', timeoutMs: 1 } },
      'readiness.pattern',
    ],
    [{ mode: 'send-after-ready', readiness: { type: 'output-match', timeoutMs: 1 } }, 'readiness.pattern'],
    [{ mode: 'send-after-ready', readiness: { type: 'hook', timeoutMs: 1 } }, 'readiness.type'],
    [{ mode: 'send-after-ready', readiness: { type: 'bracketed-paste', timeoutMs: 0 } }, 'readiness.timeoutMs'],
    [{ mode: 'positional-arg', readiness: { type: 'bracketed-paste' } }, 'readiness.timeoutMs'],
    [
      {
        mode: 'send-after-ready',
        readiness: { type: 'bracketed-paste', timeoutMs: 1 },
        overflow: { mode: 'file', args: ['--file', '{{promptFile}}'] },
      },
      'overflow.mode',
    ],
    [{ mode: 'positional-arg', overflow: { mode: 'input', env: { A: 1 } } }, 'overflow.env'],
    [{ mode: 'positional-arg', overflow: { mode: 'file', args: ['{{promptFile}}'], env: {} } }, 'overflow.env'],
  ]
  for (const [promptInjection, path] of cases) {
    const result = validateCliPluginManifest({ ...VALID, promptInjection })
    assert.equal(result.ok, false, JSON.stringify(promptInjection))
    if (result.ok) continue
    assert.ok(
      result.issues.some((issue) => issue.path === `promptInjection.${path}`),
      `${JSON.stringify(promptInjection)}: ${JSON.stringify(result.issues)}`,
    )
  }
})

test('parseCliPluginManifest surfaces JSON errors', () => {
  const result = parseCliPluginManifest('{ not json')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.issues[0].message, /Invalid JSON/)
})

test('accepts themeSelection with a light/dark schemes map', () => {
  const result = validateCliPluginManifest({
    ...VALID,
    themeSelection: {
      args: ['-c', 'tui.theme="{{themeName}}"'],
      schemes: { light: 'catppuccin-latte', dark: 'catppuccin-mocha' },
    },
  })
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues))
})

test('rejects a themeSelection schemes map missing a scheme', () => {
  const result = validateCliPluginManifest({
    ...VALID,
    themeSelection: { args: ['-c', 'tui.theme="{{themeName}}"'], schemes: { light: 'catppuccin-latte' } },
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.issues.some((issue) => issue.path === 'themeSelection.schemes.dark'))
})

test('accepts the bundled codex plugin.json', () => {
  // The validator must accept manifests the running app ships and loads.
  const source = readFileSync(join(process.cwd(), 'resources', 'plugins', 'codex', 'plugin.json'), 'utf8')
  const result = parseCliPluginManifest(source)
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues))
})

test('accepts a valid agentStateSpec (hooks and plugin-file registrations)', () => {
  const hooks = validateCliPluginManifest({
    ...VALID,
    agentStateSpec: {
      registration: { kind: 'settings-json', path: '.claude/settings.local.json' },
      events: [
        { event: 'SessionStart', phase: 'starting' },
        { event: 'PostToolUse', matcher: '*', phase: 'thinking' },
        {
          event: 'Notification',
          phase: 'awaiting_input',
          when: { field: 'notificationType', oneOf: ['permission_prompt'] },
        },
        { event: 'PreToolUse', phase: 'tool_use', register: false },
        { event: 'Stop', phase: 'idle', turnEnd: true },
        { event: 'SubagentStart', phase: 'tool_use', background: 'start' },
        { event: 'SubagentStop', phase: 'thinking', background: 'stop' },
      ],
    },
  })
  assert.equal(hooks.ok, true, hooks.ok ? '' : JSON.stringify(hooks.issues))

  const pluginFile = validateCliPluginManifest({
    ...VALID,
    agentStateSpec: {
      registration: { kind: 'plugin-file', path: '.opencode/plugin/reporter.js', template: 'opencode-agent-state.mjs' },
      events: [
        { event: 'session.idle', phase: 'idle', turnEnd: true },
        { event: 'session.error', phase: 'idle', failure: true },
      ],
    },
  })
  assert.equal(pluginFile.ok, true, pluginFile.ok ? '' : JSON.stringify(pluginFile.issues))
})

test('rejects malformed agentStateSpec fields with precise paths', () => {
  const result = validateCliPluginManifest({
    ...VALID,
    agentStateSpec: {
      registration: { kind: 'carrier-pigeon', path: '../outside/config.json', template: 'x' },
      events: [
        { event: '', phase: 'meditating' },
        { event: 'Stop', phase: 'idle', turnEnd: 'yes' },
        { event: 'Stop', phase: 'idle' },
        { event: 'Notification', phase: 'awaiting_input', when: { field: 'toolName', oneOf: [] } },
        { event: 'SubagentStart', phase: 'tool_use', background: 'sideways' },
      ],
    },
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  const paths = result.issues.map((issue) => issue.path)
  assert.ok(paths.includes('agentStateSpec.registration.kind'))
  assert.ok(paths.includes('agentStateSpec.registration.path'), 'traversal path must be rejected')
  assert.ok(paths.includes('agentStateSpec.registration.template'), 'template only valid for plugin-file')
  assert.ok(paths.includes('agentStateSpec.events[0].event'))
  assert.ok(paths.includes('agentStateSpec.events[0].phase'))
  assert.ok(paths.includes('agentStateSpec.events[1].turnEnd'))
  assert.ok(paths.includes('agentStateSpec.events[2].event'), 'duplicate event must be rejected')
  assert.ok(paths.includes('agentStateSpec.events[3].when.field'))
  assert.ok(paths.includes('agentStateSpec.events[4].background'), 'background must be start or stop')
})

test('requires a template for plugin-file registrations and events to be non-empty', () => {
  const noTemplate = validateCliPluginManifest({
    ...VALID,
    agentStateSpec: {
      registration: { kind: 'plugin-file', path: '.x/plugin.js' },
      events: [{ event: 'e', phase: 'idle' }],
    },
  })
  assert.equal(noTemplate.ok, false)
  if (!noTemplate.ok) {
    assert.ok(noTemplate.issues.some((issue) => issue.path === 'agentStateSpec.registration.template'))
  }
  const noEvents = validateCliPluginManifest({
    ...VALID,
    agentStateSpec: { registration: { kind: 'owned-json', path: '.x/hooks.json' }, events: [] },
  })
  assert.equal(noEvents.ok, false)
  if (!noEvents.ok) {
    assert.ok(noEvents.issues.some((issue) => issue.path === 'agentStateSpec.events'))
  }
})

test('accepts the bundled claude-code and opencode plugin.json agentStateSpecs', () => {
  for (const id of ['claude-code', 'opencode', 'grok', 'zai', 'kimi-claude', 'cursor', 'codex', 'kimi-code']) {
    const source = readFileSync(join(process.cwd(), 'resources', 'plugins', id, 'plugin.json'), 'utf8')
    const result = parseCliPluginManifest(source)
    assert.equal(result.ok, true, result.ok ? id : `${id}: ${JSON.stringify(result.issues)}`)
  }
})

test('rejects drive-relative registration paths (Windows escape)', () => {
  const result = validateCliPluginManifest({
    ...VALID,
    agentStateSpec: {
      registration: { kind: 'owned-json', path: 'C:/evil/hooks.json' },
      events: [{ event: 'Stop', phase: 'idle' }],
    },
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.issues.some((issue) => issue.path === 'agentStateSpec.registration.path'))
})

test('accepts a user-scoped toml-array-block registration and rejects a bad scope', () => {
  const ok = validateCliPluginManifest({
    ...VALID,
    agentStateSpec: {
      registration: { kind: 'toml-array-block', path: '.kimi-code/config.toml', scope: 'user' },
      events: [{ event: 'Stop', phase: 'idle', turnEnd: true }],
    },
  })
  assert.equal(ok.ok, true, ok.ok ? '' : JSON.stringify(ok.issues))

  const bad = validateCliPluginManifest({
    ...VALID,
    agentStateSpec: {
      registration: { kind: 'toml-array-block', path: '.kimi-code/config.toml', scope: 'global' },
      events: [{ event: 'Stop', phase: 'idle' }],
    },
  })
  assert.equal(bad.ok, false)
  if (bad.ok) return
  assert.ok(bad.issues.some((issue) => issue.path === 'agentStateSpec.registration.scope'))
})

test('accepts a failureWhen discriminator and rejects an unknown discriminator field', () => {
  const ok = validateCliPluginManifest({
    ...VALID,
    agentStateSpec: {
      registration: { kind: 'flat-hooks-json', path: '.cursor/hooks.json' },
      events: [
        { event: 'stop', phase: 'idle', turnEnd: true, failureWhen: { field: 'status', oneOf: ['error', 'aborted'] } },
      ],
    },
  })
  assert.equal(ok.ok, true, ok.ok ? '' : JSON.stringify(ok.issues))

  const bad = validateCliPluginManifest({
    ...VALID,
    agentStateSpec: {
      registration: { kind: 'flat-hooks-json', path: '.cursor/hooks.json' },
      events: [
        { event: 'stop', phase: 'idle', failureWhen: { field: 'exitCode', oneOf: ['1'] } },
        { event: 'go', phase: 'idle', failureWhen: { field: 'status', oneOf: [] } },
      ],
    },
  })
  assert.equal(bad.ok, false)
  if (bad.ok) return
  const paths = bad.issues.map((issue) => issue.path)
  assert.ok(paths.includes('agentStateSpec.events[0].failureWhen.field'))
  assert.ok(paths.includes('agentStateSpec.events[1].failureWhen.oneOf'))
})

test('accepts an update and a selfUpdate given as the binary’s arguments', () => {
  const result = validateCliPluginManifest({
    ...VALID,
    update: { args: ['update'] },
    selfUpdate: { args: ['upgrade'] },
  })
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues))
})

test('rejects a selfUpdate or update with no arguments, or one that is not a list of words', () => {
  const result = validateCliPluginManifest({
    ...VALID,
    update: { args: [] },
    selfUpdate: { args: ['upgrade', ''] },
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(result.issues.map((issue) => issue.path).sort(), ['selfUpdate.args', 'update.args'])
  const shell = validateCliPluginManifest({ ...VALID, selfUpdate: 'grok update' })
  assert.equal(shell.ok, false)
})

test('the bundled Grok and OpenCode manifests name their own updaters for a script install', () => {
  for (const [id, args] of [
    ['grok', ['update']],
    ['opencode', ['upgrade']],
  ] as const) {
    const source = readFileSync(join(process.cwd(), 'resources/plugins', id, 'plugin.json'), 'utf8')
    const result = parseCliPluginManifest(source)
    assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues))
    assert.deepEqual((JSON.parse(source) as { selfUpdate?: { args: string[] } }).selfUpdate?.args, args)
  }
})
