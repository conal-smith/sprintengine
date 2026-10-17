// Three places decide whether a launch carries the app's own plugin copy: the
// launch flag (`--plugin-dir`), the agent-state installer and the workspace
// plugin installer. They must give one answer. When the workspace installer
// read only "has the copy landed" while the launch also asked "does this
// platform take it", Windows fell between them: the copy landed, the installer
// took the workspace hook out, and the launch passed no flag, so Claude there
// reported no agent state at all. Every platform takes the copy now, so the
// question is only whether it has landed (and, for WSL, landed inside the
// distribution).

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, test, vi } from 'vitest'

import type { SkillHarness } from '../shared/skills'
import { createPluginRegistry } from './plugin-registry'
import { __resetPluginRegistryForTest, __setPluginRegistryForTest } from './plugin-registry-instance'
import { createStudioPluginService } from './studio-plugin-service'
import {
  appLaunchPluginsActive,
  cleanupTerminalStartupScript,
  getShellLaunchConfig,
  launchCarriesAppPluginsFor,
  setLaunchPluginDirsResolver,
  setLaunchSkillPluginDirsResolver,
} from './terminal-launch'
import { installElectronPlatformOver } from '../../tests/electron-platform'

vi.mock('electron', () => import('../../tests/stubs/electron'))
// What terminal-launch writes beside the app's data goes under the stub's userData.
installElectronPlatformOver()

const PLUGIN_DIRS = ['C:\\Users\\dev\\AppData\\Roaming\\sprintengine-studio\\agent-integration\\1\\plugin']

let temp = ''

beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'se-launch-plugins-'))
  __resetPluginRegistryForTest()
  const registry = createPluginRegistry({
    bundledRoot: join(process.cwd(), 'resources', 'plugins'),
    userRoot: join(temp, 'no-user-plugins'),
  })
  __setPluginRegistryForTest(registry, registry.loadSync())
})

afterAll(() => {
  setLaunchPluginDirsResolver(null)
  __resetPluginRegistryForTest()
  rmSync(temp, { recursive: true, force: true })
})

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    return run()
  } finally {
    if (original) Object.defineProperty(process, 'platform', original)
  }
}

test('on Windows the plugin copy is active for launches once it has landed', () => {
  assert.equal(appLaunchPluginsActive(PLUGIN_DIRS, 'win32'), true)
  assert.equal(launchCarriesAppPluginsFor('claude-code', PLUGIN_DIRS, 'win32'), true)
  assert.equal(appLaunchPluginsActive([], 'win32'), false, 'no copy yet: the workspace install still runs')
})

test('elsewhere it is active once the copy has landed', () => {
  assert.equal(appLaunchPluginsActive(['/Users/dev/plugin'], 'darwin'), true)
  assert.equal(appLaunchPluginsActive([], 'darwin'), false, 'no copy yet: the workspace install still runs')
  assert.equal(launchCarriesAppPluginsFor('claude-code', ['/Users/dev/plugin'], 'linux'), true)
})

test('a WSL launch whose helper holds no copy passes no --plugin-dir, which is what the workspace installer is told', () => {
  setLaunchPluginDirsResolver(() => PLUGIN_DIRS)
  const cwd = join(temp, 'workspace-launch')
  mkdirSync(cwd, { recursive: true })
  const targets = [
    {
      kind: 'wsl',
      distro: 'Ubuntu',
      env: {},
      sessionDir: '/home/dev/.local/share/sprintengine-studio/sessions/abc123def456',
      pidDir: '/run/user/1000/sprintengine/abc123def456/sessions',
    },
  ] as const
  for (const target of targets) {
    const config = withPlatform('win32', () =>
      getShellLaunchConfig(
        cwd,
        'sid-plugins',
        false,
        'claude-code',
        undefined,
        { 'claude-code': { command: 'claude' } },
        'none',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        target,
      ),
    )
    // A WSL launch's script is handed to its helper to write inside the
    // distribution; any other is a file here.
    const hostScript = config.hostFiles?.find((file) => file.path === config.startupScriptPath)?.content
    try {
      const script = hostScript ?? readFileSync(config.startupScriptPath ?? '', 'utf8')
      assert.doesNotMatch(script, /--plugin-dir/u, `host=${target.kind}`)
    } finally {
      if (!hostScript) cleanupTerminalStartupScript(config.startupScriptPath)
    }
  }
  setLaunchPluginDirsResolver(null)
})

test('a launch is handed a bundled skill as one more --plugin-dir only when its prompt invokes it', () => {
  const base = '/Users/dev/agent-integration/1/sprintengine-studio'
  const backlogPlugin = '/Users/dev/agent-integration/1/launch-skills/backlog'
  setLaunchPluginDirsResolver(() => [base])
  setLaunchSkillPluginDirsResolver(() => ({ backlog: backlogPlugin }))
  const cwd = join(temp, 'workspace-launch-skills')
  mkdirSync(cwd, { recursive: true })
  const launchText = (launchSkills?: string[]): string => {
    const config = withPlatform('darwin', () =>
      getShellLaunchConfig(
        cwd,
        `sid-skills-${launchSkills?.join('-') ?? 'none'}`,
        false,
        'claude-code',
        undefined,
        { 'claude-code': { command: 'claude' } },
        'none',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { kind: 'posix' },
        launchSkills ? { launchSkills } : {},
      ),
    )
    try {
      const script = config.startupScriptPath ? readFileSync(config.startupScriptPath, 'utf8') : ''
      return `${script}\n${JSON.stringify(config.args)}\n${config.initialInput ?? ''}`
    } finally {
      cleanupTerminalStartupScript(config.startupScriptPath)
    }
  }
  try {
    const plain = launchText()
    assert.match(plain, /--plugin-dir/u, 'every launch carries the studio plugin')
    assert.equal(plain.includes(backlogPlugin), false, 'and no skill it did not ask for')
    assert.equal(plain.includes('studio-skills'), false, 'and never the retired bundle')

    const backlog = launchText(['backlog'])
    assert.equal(backlog.includes(backlogPlugin), true, 'a Backlog handoff is handed the backlog skill')
    // A skill this machine's copy does not hold adds nothing; that launch got
    // the workspace install instead, which is what `ensureSkillInstalled` was
    // told by the same map. `debug` is the one an older build would still ask for.
    const retired = launchText(['debug'])
    assert.equal(retired.includes('launch-skills'), false)
  } finally {
    setLaunchSkillPluginDirsResolver(null)
    setLaunchPluginDirsResolver(null)
  }
})

test('on Windows, as elsewhere, the workspace gets no Claude hook once the plugin copy has landed', async () => {
  const workspace = join(temp, 'workspace-install')
  const userData = join(temp, 'userData')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(userData, { recursive: true })
  const reporter = join(temp, 'sprintengine-agent-state.mjs')
  writeFileSync(reporter, '// reporter\n', 'utf8')
  const service = createStudioPluginService({
    resolveTemplateRoot: () => resolve(process.cwd(), 'resources', 'studio-plugin'),
    resolveAgentStateReporterPath: () => reporter,
    resolveBridgeScriptPath: () => join(temp, 'mcp-stdio-bridge.mjs'),
    resolveNodeCommand: () => join(temp, 'Electron'),
    resolveUserDataDir: () => userData,
    resolveAgentStateSocketPath: () => join(userData, 'agent-state.sock'),
    listHarnesses: async (): Promise<SkillHarness[]> => ['agents', 'claude'],
    // Exactly what app-services wires, with the platform pinned to Windows.
    resolveLaunchPluginsActive: () => appLaunchPluginsActive(PLUGIN_DIRS, 'win32'),
  })
  await service.ensureInstalledForRoots([workspace])
  const record = service.installed(workspace)
  assert.equal(record?.hookSettingsPath || null, null, 'the launch registers the hook, not the workspace')
  assert.equal(existsSync(join(workspace, '.claude', 'settings.local.json')), false)
  assert.equal(existsSync(join(workspace, '.sprintengine')), false, 'nothing of the app is in the repository')
})

test('what the launch integration carries reaches the command line, the settings and the environment', () => {
  const base = '/Users/dev/agent-integration/1/sprintengine-studio'
  setLaunchPluginDirsResolver(() => [base])
  const cwd = join(temp, 'workspace-integration')
  mkdirSync(cwd, { recursive: true })
  const launch = (cli: 'claude-code' | 'opencode' | 'codex', integration: Record<string, unknown>) => {
    const config = withPlatform('darwin', () =>
      getShellLaunchConfig(
        cwd,
        `sid-integration-${cli}`,
        false,
        cli,
        undefined,
        { [cli]: { command: cli === 'claude-code' ? 'claude' : cli } },
        'none',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { kind: 'posix' },
        { integration },
      ),
    )
    try {
      return {
        script: config.startupScriptPath ? readFileSync(config.startupScriptPath, 'utf8') : '',
        env: config.env ?? {},
      }
    } finally {
      cleanupTerminalStartupScript(config.startupScriptPath)
    }
  }
  try {
    const claude = launch('claude-code', {
      args: ['--mcp-config', '/Users/dev/launch/claude-mcp-1.json'],
      settings: { hooks: { PostToolUse: [] } },
      pluginDirs: ['/Users/dev/launch/skill-canvas'],
    })
    assert.match(claude.script, /--mcp-config/u)
    assert.match(claude.script, /\/Users\/dev\/launch\/claude-mcp-1\.json/u)
    assert.match(claude.script, /\/Users\/dev\/launch\/skill-canvas/u, 'a module skill rides beside the app plugin')
    // One --settings, carrying the integration's hooks with everything else.
    assert.equal(claude.script.match(/--settings/gu)?.length, 1)
    assert.match(claude.script, /PostToolUse/u)

    const codex = launch('codex', { args: ['-c', 'mcp_servers.docs={ "command" = "x" }'] })
    assert.match(codex.script, /mcp_servers\.docs=/u)

    // OpenCode's config content joins the host context's, never replacing it.
    const opencode = launch('opencode', {
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { docs: { type: 'local', command: ['x'] } } }) },
    })
    const content = JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT ?? '{}')
    assert.deepEqual(Object.keys(content.mcp ?? {}), ['docs'])
  } finally {
    setLaunchPluginDirsResolver(null)
  }
})

test("an OpenCode terminal agent's permission rules join the integration's config document in the startup script too", () => {
  const cwd = join(temp, 'workspace-opencode-rules')
  mkdirSync(cwd, { recursive: true })
  const mcp = { docs: { type: 'local', command: ['x'] } }
  const config = withPlatform('darwin', () =>
    getShellLaunchConfig(
      cwd,
      'sid-opencode-rules',
      false,
      'opencode',
      undefined,
      { opencode: { command: 'opencode' } },
      'manual',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { kind: 'posix' },
      { integration: { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp }) } } },
    ),
  )
  try {
    const script = config.startupScriptPath ? readFileSync(config.startupScriptPath, 'utf8') : ''
    // The script exports the document after the login profile, so what it
    // exports is what OpenCode reads: the rules and the MCP table together.
    const exported = /export OPENCODE_CONFIG_CONTENT='([^']*)'/u.exec(script)?.[1]
    assert.ok(exported, 'the startup script exports the config document')
    for (const content of [JSON.parse(exported), JSON.parse(config.env?.OPENCODE_CONFIG_CONTENT ?? '{}')]) {
      assert.deepEqual(content.mcp, mcp)
      assert.equal(content.permission?.['*'], 'ask')
      assert.equal(content.permission?.bash, 'ask')
    }
  } finally {
    cleanupTerminalStartupScript(config.startupScriptPath)
  }
})
