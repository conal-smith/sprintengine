import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PluginManifest, PluginMcpConfigFormat } from '../../shared/plugin-manifest'
import { createPluginRegistry } from '../plugin-registry'
import { createAppPluginRegistryOptions } from '../plugin-registry-instance'
import { parseClaudeCodeMcpServers } from './claude-code'
import { parseCodexMcpServers } from './codex'
import { parseOpencodeMcpServers } from './opencode'
import { createFileMcpConfigReader, type McpConfigReader } from './reader'
import { MCP_CONFIG_READERS } from './registry'
import { createMcpServerResolver, type McpConfigTarget } from './resolve-servers'
import { test } from 'vitest'

test('read-path', async () => {
  const CLAUDE_CONFIG = JSON.stringify(
    {
      mcpServers: {
        linear: { type: 'stdio', command: 'npx', args: ['-y', 'linear-mcp'], env: { TOKEN: 'x' } },
        docs: { type: 'http', url: 'https://example.test/mcp' },
        'no-command': { type: 'stdio' },
      },
    },
    null,
    2,
  )

  const CODEX_CONFIG = [
    'model = "gpt-5.6-sol"',
    '',
    '[mcp_servers.linear]',
    'command = "npx"',
    'args = ["-y", "linear-mcp"]',
    '',
    '[mcp_servers.docs]',
    'url = "https://example.test/mcp"',
    'bearer_token_env_var = "DOCS_TOKEN"',
    '',
    '[shell_environment_policy]',
    'enabled = false',
    '',
  ].join('\n')

  const OPENCODE_CONFIG = JSON.stringify(
    {
      mcp: {
        linear: { type: 'local', command: ['npx', '-y', 'linear-mcp'], environment: { TOKEN: 'x' } },
        docs: { type: 'remote', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer {env:T}' } },
        empty: { type: 'local', command: [] },
      },
    },
    null,
    2,
  )

  function bundledManifests(): Map<string, PluginManifest> {
    const registry = createPluginRegistry(
      createAppPluginRegistryOptions(
        join(process.cwd(), 'node_modules', '.cache', 'sprintengine'),
        join(process.cwd(), 'resources', 'plugins'),
        join(process.cwd(), 'node_modules', '.cache', 'sprintengine', 'plugins-none'),
      ),
    )
    registry.loadSync()
    return new Map(
      registry
        .list()
        .map((entry) => [entry.id, registry.get(entry.id)?.manifest])
        .filter((pair): pair is [string, PluginManifest] => Boolean(pair[1])),
    )
  }

  function testParsers(): void {
    const claude = parseClaudeCodeMcpServers(CLAUDE_CONFIG)
    assert.deepEqual(
      claude.map((server) => [server.id, server.transport, server.command ?? server.url]),
      [
        ['linear', 'stdio', 'npx'],
        ['docs', 'http', 'https://example.test/mcp'],
      ],
      'an entry naming neither command nor url is not a server the CLI can reach',
    )
    assert.deepEqual(claude[0].args, ['-y', 'linear-mcp'])
    assert.deepEqual(claude[0].env, { TOKEN: 'x' })

    const codex = parseCodexMcpServers(CODEX_CONFIG)
    assert.deepEqual(
      codex.map((server) => [server.id, server.transport, server.command ?? server.url]),
      [
        ['linear', 'stdio', 'npx'],
        ['docs', 'http', 'https://example.test/mcp'],
      ],
    )
    assert.deepEqual(codex[1].envVarNames, ['DOCS_TOKEN'])
    // A table that is not ours ends the server it follows: `enabled = false` under
    // [shell_environment_policy] must not disable the last MCP server declared.
    assert.equal(codex[1].enabled, true)

    const opencode = parseOpencodeMcpServers(OPENCODE_CONFIG)
    assert.deepEqual(
      opencode.map((server) => [server.id, server.transport, server.command ?? server.url]),
      [
        ['linear', 'stdio', 'npx'],
        ['docs', 'http', 'https://example.test/mcp'],
      ],
    )
    assert.deepEqual(opencode[0].args, ['-y', 'linear-mcp'], 'the argv tail is the arguments')
    assert.deepEqual(opencode[0].env, { TOKEN: 'x' })

    // Each parser rejects its own format's garbage rather than reporting zero
    // servers; the file reader turns that into `malformed`.
    assert.throws(() => parseClaudeCodeMcpServers('{ "mcpServers": '))
    assert.throws(() => parseClaudeCodeMcpServers('[]'))
    assert.throws(() => parseOpencodeMcpServers('not json'))
    assert.throws(() => parseCodexMcpServers('[mcp_servers.linear]\nargs = ["a",\n'))

    // A valid config that simply declares no servers is not a fault.
    assert.deepEqual(parseClaudeCodeMcpServers('{"other": 1}'), [])
    assert.deepEqual(parseOpencodeMcpServers('{"model": "x"}'), [])
    assert.deepEqual(parseCodexMcpServers('model = "gpt-5.6-sol"\n'), [])
  }

  async function testFileReasons(temp: string): Promise<void> {
    const reader = MCP_CONFIG_READERS.get('claude-code')
    assert.ok(reader, 'claude-code has a registered adapter')

    const missing = await reader.read(join(temp, 'nope', '.mcp.json'))
    assert.equal(missing.ok, false)
    assert.equal(missing.ok === false && missing.reason, 'missing')

    const malformedPath = join(temp, 'malformed.json')
    await writeFile(malformedPath, '{ "mcpServers": ', 'utf-8')
    const malformed = await reader.read(malformedPath)
    assert.equal(malformed.ok, false)
    assert.equal(malformed.ok === false && malformed.reason, 'malformed')
    assert.ok(malformed.ok === false && malformed.message.length > 0, 'the parse error is carried')

    // A directory where the config file should be cannot be opened at all.
    const notAFile = join(temp, 'directory.json')
    await mkdir(notAFile, { recursive: true })
    const unreadable = await reader.read(notAFile)
    assert.equal(unreadable.ok, false)
    assert.equal(unreadable.ok === false && unreadable.reason, 'unreadable')

    const locked = join(temp, 'locked.json')
    await writeFile(locked, CLAUDE_CONFIG, 'utf-8')
    await chmod(locked, 0o000)
    try {
      const denied = await reader.read(locked)
      // Running as root defeats the permission bits; only assert where it bit.
      if (!denied.ok) assert.equal(denied.reason, 'unreadable')
    } finally {
      await chmod(locked, 0o644)
    }
  }

  async function testSharedConfigIsReadOnce(temp: string, manifests: Map<string, PluginManifest>): Promise<void> {
    const workspaceRoot = join(temp, 'shared')
    await mkdir(workspaceRoot, { recursive: true })
    await writeFile(join(workspaceRoot, '.mcp.json'), CLAUDE_CONFIG, 'utf-8')

    const reads: string[] = []
    const counting: McpConfigReader = {
      format: 'claude-code',
      read: async (path) => {
        reads.push(path)
        return { ok: true, servers: parseClaudeCodeMcpServers(CLAUDE_CONFIG) }
      },
    }
    const resolver = createMcpServerResolver({
      readers: new Map([['claude-code', counting]]),
      homeDir: () => join(temp, 'home'),
    })

    // Grok left this file for its own ~/.grok/config.toml when the app stopped
    // writing the gateway into repositories.
    const sharing = ['claude-code', 'kimi-claude', 'zai']
    const targets = sharing.map((pluginId): McpConfigTarget => {
      const spec = manifests.get(pluginId)?.mcpConfig
      assert.ok(spec, `${pluginId} declares an mcpConfig`)
      assert.equal(spec.path, '{{workspaceRoot}}/.mcp.json')
      return { pluginId, spec }
    })

    const resolved = await resolver.resolve({ workspaceRoot, targets })
    assert.equal(reads.length, 1, 'three CLIs sharing one file read it once')
    assert.equal(reads[0], join(workspaceRoot, '.mcp.json'))
    assert.deepEqual([...resolved.keys()].sort(), [...sharing].sort(), 'three attributions')
    for (const pluginId of sharing) {
      const entry = resolved.get(pluginId)
      assert.ok(entry)
      assert.deepEqual(
        entry.servers.map((server) => server.id),
        ['docs', 'linear'],
      )
      assert.deepEqual(entry.diagnostics, [])
      assert.ok(
        entry.servers.every(
          (server) => server.scope === 'workspace' && server.configPath === join(workspaceRoot, '.mcp.json'),
        ),
      )
      assert.ok(
        entry.servers.every((server) => !('toolCount' in server)),
        'no tool count is present that nothing read',
      )
    }
  }

  async function testWorkspaceOverridesUser(temp: string, manifests: Map<string, PluginManifest>): Promise<void> {
    // Both CLIs that declare a `userPath` were checked against the CLI itself
    // before this was written: `codex mcp list --json` with CODEX_HOME pointed at
    // a fixture home, and `opencode mcp list` with XDG_CONFIG_HOME, both resolve
    // the project entry over the user entry of the same id and union the rest.
    const cases = [
      {
        pluginId: 'codex',
        home: 'codex-home',
        workspaceFile: ['.codex', 'config.toml'],
        userFile: ['.codex', 'config.toml'],
        workspaceConfig:
          '[mcp_servers.shared]\ncommand = "workspace-command"\n\n[mcp_servers.ws_only]\ncommand = "w"\n',
        userConfig: '[mcp_servers.shared]\ncommand = "user-command"\n\n[mcp_servers.user_only]\ncommand = "u"\n',
      },
      {
        pluginId: 'opencode',
        home: 'opencode-home',
        workspaceFile: ['opencode.json'],
        userFile: ['.config', 'opencode', 'opencode.json'],
        workspaceConfig: JSON.stringify({
          mcp: {
            shared: { type: 'local', command: ['workspace-command'] },
            ws_only: { type: 'local', command: ['w'] },
          },
        }),
        userConfig: JSON.stringify({
          mcp: {
            shared: { type: 'local', command: ['user-command'] },
            user_only: { type: 'local', command: ['u'] },
          },
        }),
      },
    ]

    for (const scenario of cases) {
      const workspaceRoot = join(temp, `${scenario.pluginId}-workspace`)
      const home = join(temp, scenario.home)
      await mkdir(join(workspaceRoot, ...scenario.workspaceFile.slice(0, -1)), { recursive: true })
      await mkdir(join(home, ...scenario.userFile.slice(0, -1)), { recursive: true })
      await writeFile(join(workspaceRoot, ...scenario.workspaceFile), scenario.workspaceConfig, 'utf-8')
      await writeFile(join(home, ...scenario.userFile), scenario.userConfig, 'utf-8')

      const spec = manifests.get(scenario.pluginId)?.mcpConfig
      assert.ok(spec?.userPath, `${scenario.pluginId} declares both scopes`)

      const resolved = await createMcpServerResolver({ homeDir: () => home }).resolve({
        workspaceRoot,
        targets: [{ pluginId: scenario.pluginId, spec }],
      })
      const entry = resolved.get(scenario.pluginId)
      assert.ok(entry)
      assert.deepEqual(entry.diagnostics, [])
      assert.deepEqual(
        entry.servers.map((server) => [server.id, server.scope]),
        [
          ['shared', 'workspace'],
          ['user_only', 'user'],
          ['ws_only', 'workspace'],
        ],
        `${scenario.pluginId}: workspace wins the shared id, both scopes contribute their own`,
      )
      assert.equal(
        entry.servers.find((server) => server.id === 'shared')?.configPath,
        join(workspaceRoot, ...scenario.workspaceFile),
      )
      assert.equal(
        entry.servers.find((server) => server.id === 'user_only')?.configPath,
        join(home, ...scenario.userFile),
      )
    }
  }

  async function testMalformedIsNamed(temp: string, manifests: Map<string, PluginManifest>): Promise<void> {
    const workspaceRoot = join(temp, 'broken')
    await mkdir(workspaceRoot, { recursive: true })
    await writeFile(join(workspaceRoot, '.mcp.json'), '{ "mcpServers": ', 'utf-8')

    const spec = manifests.get('claude-code')?.mcpConfig
    assert.ok(spec)
    const resolved = await createMcpServerResolver({ homeDir: () => join(temp, 'home') }).resolve({
      workspaceRoot,
      targets: [{ pluginId: 'claude-code', spec }],
    })
    const entry = resolved.get('claude-code')
    assert.ok(entry)
    assert.deepEqual(entry.servers, [], 'a file that would not parse contributes nothing')
    assert.equal(entry.diagnostics.length, 1)
    assert.equal(entry.diagnostics[0].capability, 'servers')
    assert.equal(entry.diagnostics[0].reason, 'malformed')
    assert.equal(entry.diagnostics[0].path, join(workspaceRoot, '.mcp.json'), 'the fault names the file')

    // A workspace with no config at all is normal: no servers, and no fault.
    const emptyRoot = join(temp, 'no-config')
    await mkdir(emptyRoot, { recursive: true })
    const quiet = await createMcpServerResolver({ homeDir: () => join(temp, 'home') }).resolve({
      workspaceRoot: emptyRoot,
      targets: [{ pluginId: 'claude-code', spec }],
    })
    assert.deepEqual(quiet.get('claude-code'), { servers: [], diagnostics: [] })
  }

  async function testUnregisteredFormat(temp: string): Promise<void> {
    const workspaceRoot = join(temp, 'unregistered')
    await mkdir(workspaceRoot, { recursive: true })
    await writeFile(join(workspaceRoot, 'agent.conf'), 'servers = 1\n', 'utf-8')

    const spec = { path: '{{workspaceRoot}}/agent.conf', format: 'generic' as PluginMcpConfigFormat }
    const resolved = await createMcpServerResolver({ homeDir: () => join(temp, 'home') }).resolve({
      workspaceRoot,
      targets: [{ pluginId: 'fixture-cli', spec }],
    })
    const entry = resolved.get('fixture-cli')
    assert.ok(entry, 'a format with no adapter is still an answer, not a crash')
    assert.deepEqual(entry.servers, [])
    assert.equal(entry.diagnostics.length, 1, 'stated once, not once per scope')
    assert.equal(entry.diagnostics[0].capability, 'servers')
    assert.equal(entry.diagnostics[0].path, join(workspaceRoot, 'agent.conf'))
    assert.match(entry.diagnostics[0].message, /generic/)

    // Registering an adapter for that format is a registry entry and nothing
    // else: the resolver is not edited, and does not know a format name.
    const withAdapter = createMcpServerResolver({
      readers: new Map([
        ...MCP_CONFIG_READERS,
        [
          'generic',
          createFileMcpConfigReader('generic', (raw) =>
            raw.trim() ? [{ id: raw.split('=')[0]!.trim(), transport: 'stdio', command: 'fixture' }] : [],
          ),
        ],
      ]),
      homeDir: () => join(temp, 'home'),
    })
    const registered = await withAdapter.resolve({ workspaceRoot, targets: [{ pluginId: 'fixture-cli', spec }] })
    assert.deepEqual(registered.get('fixture-cli')?.diagnostics, [])
    assert.deepEqual(
      registered.get('fixture-cli')?.servers.map((server) => server.id),
      ['servers'],
    )
  }

  function testEveryDeclaredFormatHasAnAdapter(manifests: Map<string, PluginManifest>): void {
    const declared = [...manifests.values()]
      .map((manifest) => manifest.mcpConfig?.format)
      .filter((format): format is PluginMcpConfigFormat => Boolean(format))
    assert.ok(declared.length >= 7, 'the bundled plugins declaring mcpConfig are covered')
    for (const format of new Set(declared)) {
      assert.ok(MCP_CONFIG_READERS.has(format), `bundled format "${format}" has a reader`)
    }
  }

  async function main(): Promise<void> {
    const temp = await mkdtemp(join(tmpdir(), 'sprintengine-mcp-read-path-'))
    const manifests = bundledManifests()

    testParsers()
    testEveryDeclaredFormatHasAnAdapter(manifests)
    await testFileReasons(temp)
    await testSharedConfigIsReadOnce(temp, manifests)
    await testWorkspaceOverridesUser(temp, manifests)
    await testMalformedIsNamed(temp, manifests)
    await testUnregisteredFormat(temp)

    console.log('mcp-config-readers tests passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
