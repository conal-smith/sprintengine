// What a launch hands its CLI through the CLI's own channels, and what it
// takes back out of the repository on the way. Every fixture is a temporary
// directory; nothing here reads or writes this machine's home.

import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'

import type { McpServerConfig, McpSettings } from '../../shared/electron-api'
import type { PluginAgentStateSpec, PluginLaunchIntegrationSpec } from '../../shared/plugin-manifest'
import { MANAGED_SKILL_MANIFEST_FILE } from '../builtin-skills'
import { MANAGED_END, MANAGED_START } from '../mcp-config-service'
import {
  buildClaudeLaunchIntegration,
  buildCodexLaunchIntegration,
  buildCursorLaunchIntegration,
  buildOpencodeLaunchIntegration,
  ensureUserLevelSkillCopy,
  launchGatewayServer,
  prepareLaunchIntegration,
  pruneLaunchFiles,
  type PrepareLaunchIntegrationDeps,
} from './launch-integration'

const GATEWAY = {
  command: '/bin/sh',
  args: ['/Users/dev/.sprintengine/bin/studio-run', 'mcp'],
  env: { SPRINTENGINE_USER_DATA_DIR: '/Users/dev/Library/Application Support/SprintEngine Studio' },
}

function server(overrides: Partial<McpServerConfig> & { id: string }): McpServerConfig {
  return {
    name: overrides.id,
    transport: 'stdio',
    command: '/bin/echo',
    args: ['hello'],
    enabled: true,
    clients: ['claude-code', 'codex', 'opencode', 'cursor'],
    scope: 'workspace',
    source: 'custom',
    riskLevel: 'local-command',
    ...overrides,
  }
}

async function loadSpec(id: string): Promise<PluginAgentStateSpec> {
  const manifest = JSON.parse(await readFile(join(process.cwd(), 'resources', 'plugins', id, 'plugin.json'), 'utf8'))
  return manifest.agentStateSpec as PluginAgentStateSpec
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `se-launch-integration-${prefix}-`))
}

test('a Claude launch takes the synced servers as one owner-only --mcp-config file', async () => {
  const dir = await tempDir('claude')
  const integration = await buildClaudeLaunchIntegration({
    dir,
    servers: [server({ id: 'docs', env: { DOCS_TOKEN: 'secret' } })],
  })
  assert.equal(integration.args[0], '--mcp-config')
  const path = integration.args[1]!
  assert.ok(path.startsWith(dir))
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    mcpServers: { docs: { type: 'stdio', command: '/bin/echo', args: ['hello'], env: { DOCS_TOKEN: 'secret' } } },
  })
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.deepEqual(integration.carries, { mcp: true, agentState: true, skills: [] })

  // The same document is the same file: a resumed session finds it again.
  const again = await buildClaudeLaunchIntegration({
    dir,
    servers: [server({ id: 'docs', env: { DOCS_TOKEN: 'secret' } })],
  })
  assert.equal(again.args[1], path)
  assert.equal((await readdir(dir)).length, 1)
})

test('a Claude launch with nothing synced passes no flag, and carries the knowledge hook in its settings', async () => {
  const dir = await tempDir('claude-empty')
  const integration = await buildClaudeLaunchIntegration({
    dir,
    servers: [],
    knowledgeActivityCommand: "/bin/sh '/Users/dev/.sprintengine/bin/studio-run' knowledge-activity",
    bundledSkills: ['backlog'],
    skillPluginDirs: [{ id: 'canvas-draw', dir: '/Users/dev/skill-plugin' }],
  })
  assert.deepEqual(integration.args, [])
  assert.deepEqual(integration.settings, {
    hooks: {
      PostToolUse: [
        {
          matcher: 'Read|Edit|Write',
          hooks: [{ type: 'command', command: "/bin/sh '/Users/dev/.sprintengine/bin/studio-run' knowledge-activity" }],
        },
      ],
    },
  })
  assert.deepEqual(integration.pluginDirs, ['/Users/dev/skill-plugin'])
  assert.deepEqual(integration.carries.skills, ['backlog', 'canvas-draw'])
  assert.deepEqual(await readdir(dir).catch(() => []), [])
})

test('a Codex launch takes the gateway, the synced servers and the hook as -c overrides', async () => {
  const spec = await loadSpec('codex')
  const command = "/bin/sh '/Users/dev/.sprintengine/bin/studio-run' agent-state --socket '/tmp/agent.sock'"
  const integration = buildCodexLaunchIntegration({
    gateway: launchGatewayServer(GATEWAY, 'codex', { passIdentityByName: true }),
    servers: [server({ id: 'docs', required: true }), server({ id: 'bad.id' })],
    agentState: { spec, command },
  })
  const overrides = integration.args.filter((_, index) => index % 2 === 1)
  assert.ok(integration.args.filter((_, index) => index % 2 === 0).every((flag) => flag === '-c'))
  const gateway = overrides.find((value) => value.startsWith('mcp_servers.sprintengine-studio='))
  assert.ok(gateway, 'the gateway rides the launch')
  assert.match(gateway, /"SPRINTENGINE_AGENT_CLI" = "codex"/u)
  // Codex hands a server only the variables it names: the agent's ids and the
  // launch token, so the bridge can still say which launch it belongs to.
  assert.match(
    gateway,
    /"env_vars" = \["SPRINTENGINE_WORKSPACE_ID", "SPRINTENGINE_AGENT_ID", "SPRINTENGINE_AGENT_NAME", "SPRINTENGINE_MCP_CHANNEL_TOKEN"\]/u,
  )
  assert.ok(
    overrides.includes(
      'mcp_servers.docs={ "command" = "/bin/echo", "args" = ["hello"], "enabled" = true, "required" = true }',
    ),
  )
  assert.deepEqual(integration.skippedServers, ['bad.id'], 'an id Codex cannot name is left out and reported')

  const hookEvents = overrides.filter((value) => value.startsWith('hooks.')).map((value) => value.split('=')[0])
  const registered = spec.events.filter((entry) => entry.register !== false).map((entry) => `hooks.${entry.event}`)
  assert.deepEqual(hookEvents.sort(), [...new Set(registered)].sort())
  const postToolUse = overrides.find((value) => value.startsWith('hooks.PostToolUse='))
  assert.ok(postToolUse?.includes(`command = ${JSON.stringify(command)}`), postToolUse ?? 'no PostToolUse')
  assert.equal(integration.carries.agentState, true)
})

test('an OpenCode launch takes its plugin, servers and skills in one config document', async () => {
  const dir = await tempDir('opencode')
  const template = join(dir, 'template.mjs')
  await writeFile(
    template,
    "const BAKED_SOCKET = '__SPRINTENGINE_AGENT_STATE_SOCKET__'\nexport const X = async () => ({})\n",
  )
  const skillDir = join(dir, 'skills-src', 'backlog')
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: backlog\n---\n')
  const integration = await buildOpencodeLaunchIntegration({
    dir: join(dir, 'launch'),
    gateway: launchGatewayServer(GATEWAY, 'opencode'),
    servers: [server({ id: 'docs' }), server({ id: 'stream', transport: 'sse', url: 'https://example.com/sse' })],
    agentState: { templatePath: template, socketPath: '/tmp/agent.sock' },
    skills: [{ id: 'backlog', sourceDir: skillDir }],
  })
  const content = JSON.parse(integration.env.OPENCODE_CONFIG_CONTENT!) as Record<string, any>
  const pluginPath = fileURLToPath(content.plugin[0])
  assert.ok(pluginPath.endsWith('.js'), 'OpenCode does not load .mjs plugins')
  assert.match(await readFile(pluginPath, 'utf8'), /const BAKED_SOCKET = "\/tmp\/agent.sock"/u)
  assert.deepEqual(Object.keys(content.mcp).sort(), ['docs', 'sprintengine-studio'])
  assert.deepEqual(content.mcp['sprintengine-studio'].environment.SPRINTENGINE_AGENT_CLI, 'opencode')
  assert.deepEqual(content.skills, { paths: [skillDir] })
  assert.deepEqual(integration.skippedServers, ['stream'])
  assert.deepEqual(integration.carries, { mcp: true, agentState: true, skills: ['backlog'] })
})

test('a Cursor launch takes one more plugin directory, named for the app whatever its contents', async () => {
  const dir = await tempDir('cursor')
  const skillDir = join(dir, 'skills-src', 'backlog')
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: backlog\n---\n')
  const integration = await buildCursorLaunchIntegration({
    dir,
    gateway: launchGatewayServer(GATEWAY, 'cursor'),
    servers: [server({ id: 'docs' })],
    skills: [{ id: 'backlog', sourceDir: skillDir }],
  })
  assert.equal(integration.args[0], '--plugin-dir')
  const root = integration.args[1]!
  // Cursor names a plugin's servers after its folder, so the folder never
  // changes with what the plugin holds.
  assert.ok(root.endsWith(join('', 'sprintengine-studio')))
  assert.equal(
    JSON.parse(await readFile(join(root, '.cursor-plugin', 'plugin.json'), 'utf8')).name,
    'sprintengine-studio',
  )
  const mcp = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'))
  assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ['docs', 'sprintengine-studio'])
  assert.ok(existsSync(join(root, 'skills', 'backlog', 'SKILL.md')))
  assert.equal(integration.carries.agentState, false, 'the hook stays user-level: plugin stop hooks do not fire alone')

  const again = await buildCursorLaunchIntegration({
    dir,
    gateway: launchGatewayServer(GATEWAY, 'cursor'),
    servers: [server({ id: 'docs' })],
    skills: [{ id: 'backlog', sourceDir: skillDir }],
  })
  assert.equal(again.args[1], root)
})

function deps(overrides: Partial<PrepareLaunchIntegrationDeps> & { launchDir: string }): PrepareLaunchIntegrationDeps {
  const { launchDir, ...rest } = overrides
  return {
    spec: () => null,
    isThisMachine: () => true,
    carriesAppPlugins: () => true,
    launchFilesDir: () => launchDir,
    gateway: () => GATEWAY,
    agentStateSpec: () => null,
    agentStateHookCommand: () => "/bin/sh '/Users/dev/.sprintengine/bin/studio-run' agent-state --socket '/tmp/s'",
    agentStateTemplatePath: () => null,
    socketPath: () => '/tmp/s',
    bundledSkillPluginDir: () => null,
    skillSourceDir: () => null,
    skill: () => null,
    homeDir: () => join(launchDir, 'home'),
    knowledgeActivityCommand: async () => null,
    gitTracks: async () => false,
    ...rest,
  }
}

const NO_SETTINGS: McpSettings = { syncEnabled: false, servers: {} }

function input(workspaceRoot: string, cli: string, overrides: Record<string, unknown> = {}) {
  return {
    workspaceRoot,
    cli,
    settings: NO_SETTINGS,
    skillIds: [],
    connectorLaunch: false,
    ...overrides,
  } as Parameters<typeof prepareLaunchIntegration>[0]
}

test('a launch with no route of its own is left to the workspace writers', async () => {
  const launchDir = await tempDir('none')
  const codex: PluginLaunchIntegrationSpec = { route: 'codex' }
  assert.equal((await prepareLaunchIntegration(input(launchDir, 'codex'), deps({ launchDir }))).ok, true)
  for (const [label, prepared] of [
    ['no route declared', await prepareLaunchIntegration(input(launchDir, 'codex'), deps({ launchDir }))],
    [
      'another machine',
      await prepareLaunchIntegration(
        input(launchDir, 'codex'),
        deps({ launchDir, spec: () => codex, isThisMachine: () => false }),
      ),
    ],
    [
      'a connector launch',
      await prepareLaunchIntegration(
        input(launchDir, 'codex', { connectorLaunch: true }),
        deps({ launchDir, spec: () => codex }),
      ),
    ],
    [
      'a Claude launch without the plugin copy',
      await prepareLaunchIntegration(
        input(launchDir, 'claude-code'),
        deps({ launchDir, spec: () => ({ route: 'claude' }), carriesAppPlugins: () => false }),
      ),
    ],
  ] as const) {
    assert.deepEqual(prepared, { ok: true, integration: null }, label)
  }
})

test('a required synced server that cannot start stops the launch, as the sync did', async () => {
  const launchDir = await tempDir('required')
  const settings: McpSettings = {
    syncEnabled: true,
    servers: { gone: server({ id: 'gone', command: 'sprintengine-no-such-command', required: true }) },
  }
  const prepared = await prepareLaunchIntegration(
    input(launchDir, 'codex', { settings }),
    deps({ launchDir, spec: () => ({ route: 'codex' }) }),
  )
  assert.equal(prepared.ok, false)
})

test('a Codex launch takes the managed block an earlier sync wrote back out of the repository', async () => {
  const workspace = await tempDir('codex-ws')
  const launchDir = await tempDir('codex-launch')
  const configPath = join(workspace, '.codex', 'config.toml')
  await mkdir(join(workspace, '.codex'), { recursive: true })
  await writeFile(
    configPath,
    `model = "gpt-5"\n\n${MANAGED_START}\n# generated\n\n[mcp_servers.sprintengine-studio]\ncommand = "/bin/sh"\nenabled = true\n${MANAGED_END}\n`,
  )
  const prepared = await prepareLaunchIntegration(
    input(workspace, 'codex'),
    deps({ launchDir, spec: () => ({ route: 'codex' }), agentStateSpec: () => null }),
  )
  assert.ok(prepared.ok && prepared.integration)
  assert.equal(await readFile(configPath, 'utf8'), 'model = "gpt-5"\n', 'the person’s own settings stay')

  // A file that held nothing else goes, with its folder.
  await writeFile(configPath, `${MANAGED_START}\n[mcp_servers.x]\ncommand = "y"\n${MANAGED_END}\n`)
  await prepareLaunchIntegration(input(workspace, 'codex'), deps({ launchDir, spec: () => ({ route: 'codex' }) }))
  assert.equal(existsSync(join(workspace, '.codex')), false)
})

test('a CLI with no launch-time skill folder gets the skill in its user folder, marked as the app’s', async () => {
  const launchDir = await tempDir('user-skill')
  const source = join(launchDir, 'source', 'backlog')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'SKILL.md'), '---\nname: backlog\n---\nWork the item.\n')
  const prepared = await prepareLaunchIntegration(
    input(launchDir, 'grok', { skillIds: ['backlog'] }),
    deps({
      launchDir,
      spec: () => ({ userSkillsDir: '.grok/skills' }),
      skillSourceDir: () => source,
      skill: (id) => ({ id, version: '1.3.0' }),
    }),
  )
  assert.ok(prepared.ok && prepared.integration)
  assert.deepEqual(prepared.integration.carries, { mcp: false, agentState: false, skills: ['backlog'] })
  const copy = join(launchDir, 'home', '.grok', 'skills', 'backlog')
  assert.ok(existsSync(join(copy, 'SKILL.md')))
  const manifest = JSON.parse(await readFile(join(copy, MANAGED_SKILL_MANIFEST_FILE), 'utf8'))
  assert.equal(manifest.source, 'sprintengine-builtin')
})

test('a skill of the same name the person keeps is theirs, and is never written over', async () => {
  const root = await tempDir('own-skill')
  const source = join(root, 'source', 'backlog')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'SKILL.md'), 'ours\n')
  const skillsDir = join(root, 'skills')
  await mkdir(join(skillsDir, 'backlog'), { recursive: true })
  await writeFile(join(skillsDir, 'backlog', 'SKILL.md'), 'theirs\n')
  const path = await ensureUserLevelSkillCopy({
    skillsDir,
    skill: { id: 'backlog', version: '1' },
    sourceDir: source,
    cli: 'codex',
  })
  assert.equal(path, join(skillsDir, 'backlog'))
  assert.equal(await readFile(join(skillsDir, 'backlog', 'SKILL.md'), 'utf8'), 'theirs\n')
})

test('the launch files are emptied at the next start', async () => {
  const dir = await tempDir('prune')
  await buildClaudeLaunchIntegration({ dir, servers: [server({ id: 'docs' })] })
  assert.equal((await readdir(dir)).length, 1)
  await pruneLaunchFiles(dir)
  assert.deepEqual(await readdir(dir), [])
  await pruneLaunchFiles(join(dir, 'missing'))
})

test("a Codex launch hands the synced servers' env values and headers to the terminal's environment, not its command line", () => {
  const secret = 'sk-test-0123456789abcdef'
  const integration = buildCodexLaunchIntegration({
    gateway: null,
    servers: [
      server({ id: 'stripe', env: { STRIPE_TEST_SECRET_KEY: secret } }),
      server({
        id: 'acme',
        transport: 'http',
        command: undefined,
        args: undefined,
        url: 'https://mcp.example.com/mcp',
        headers: { 'X-Api-Key': secret },
      }),
    ],
  })
  assert.equal(integration.args.join(' ').includes(secret), false)
  assert.deepEqual(integration.env, { STRIPE_TEST_SECRET_KEY: secret, SPRINTENGINE_MCP_SECRET_1: secret })
  assert.match(integration.args[1], /"env_vars" = \["STRIPE_TEST_SECRET_KEY"\]/u)
  assert.match(integration.args[3], /"env_http_headers" = \{ "X-Api-Key" = "SPRINTENGINE_MCP_SECRET_1" \}/u)
})
