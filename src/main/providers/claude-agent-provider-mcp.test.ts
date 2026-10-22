import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

import type { ConversationEvent, ConversationMcpServer } from '../../shared/conversation-runtime'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  CLAUDE_AGENT_PROVIDER_ID,
  claudeMcpLaunch,
  claudeMcpServers,
  createClaudeAgentProvider,
  mapSdkMessage,
} from './claude-agent-provider'
import type { MockAdapterTurnInput } from './conversation-provider-adapter'

// A Claude chat's child loads the person's user settings only, so neither the
// gateway pinned into a workspace's `.mcp.json` nor a connector written there
// would reach it. The gateway is handed to the SDK's `mcpServers`, which the
// SDK puts on the child's command line; a connector's servers, which carry
// its secrets, are registered over the child's stdin before its first message.

afterEach(() => {
  vi.restoreAllMocks()
})

const GATEWAY: ConversationMcpServer = {
  id: 'sprintengine-studio',
  name: 'SprintEngine Studio',
  transport: 'stdio',
  command: '/Applications/Studio.app/launcher',
  args: ['mcp'],
  env: { SPRINTENGINE_USER_DATA_DIR: '/Users/dev/Library/Application Support/Studio' },
}
const RAILWAY: ConversationMcpServer = {
  id: 'railway',
  name: 'Railway',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@railway/mcp'],
}

function harness(
  gateway: ConversationMcpServer | null | 'throws',
  // How the child answers the registration of the session's servers.
  register: (servers: Record<string, unknown>) => Promise<unknown> = async (servers) => ({
    added: Object.keys(servers),
    removed: [],
    errors: {},
  }),
) {
  const options: Record<string, unknown>[] = []
  const gatewayAskedFor: Array<{ hostId?: ExecutionHostId }> = []
  // What reached the child, in order: each registration and each message.
  const sent: Array<{ registered: Record<string, unknown> } | { message: unknown } | { reconnected: string }> = []
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
    options.push(params.options)
    const pending: Record<string, unknown>[] = []
    let wake = null as (() => void) | null
    let ended = false
    void (async () => {
      for await (const message of params.prompt) {
        sent.push({ message: (message.message as { content: unknown }).content })
        pending.push({ type: 'result', subtype: 'success', is_error: false, session_id: 'mcp' })
        wake?.()
      }
    })()
    return {
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (!pending.length) await new Promise<void>((resolve) => (wake = resolve))
          while (pending.length) yield pending.shift()!
        }
      },
      interrupt: async () => {
        ended = true
        wake?.()
      },
      setPermissionMode: async () => undefined,
      setMcpServers: async (servers: Record<string, unknown>) => {
        const answer = await register(servers)
        sent.push({ registered: servers })
        return answer
      },
      reconnectMcpServer: async (name: string) => {
        sent.push({ reconnected: name })
      },
      mcpServerStatus: async () => [],
    }
  }
  const adapter = createClaudeAgentProvider({
    mcpRegistrationTimeoutMs: 50,
    loadQuery: (async () => query) as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: (input) => ({
      PATH: '/usr/bin',
      SPRINTENGINE_WORKSPACE_ID: input.workspaceId,
      SPRINTENGINE_AGENT_ID: input.agentId,
    }),
    // A WSL machine that is always ready; its child is never spawned here.
    prepareWslTarget: async () => ({ distro: 'Ubuntu', agentStateSocketPath: '/run/user/1000/agent.sock' }),
    resolveStudioMcpServer: async (input) => {
      gatewayAskedFor.push(input)
      if (gateway === 'throws') throw new Error('no launcher')
      return gateway
    },
  })
  const turn = (overrides: Partial<MockAdapterTurnInput> = {}): MockAdapterTurnInput => ({
    sessionId: 'conv_1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    workspaceRoot: '/Users/dev/app',
    turnId: 'turn_1',
    requestId: 'approval_1',
    message: 'hello',
    ...overrides,
  })
  const firstTurn = async (overrides: Partial<MockAdapterTurnInput> = {}) => {
    await adapter.startSession(turn(overrides))
    const events: ConversationEvent[] = []
    for await (const event of (await adapter.sendTurn(turn(overrides))) as AsyncIterable<ConversationEvent>)
      events.push(event)
    return options.at(-1)!
  }
  return { adapter, firstTurn, gatewayAskedFor, sent }
}

// A connector's server as it is installed: its key in the environment it
// starts with, its token in a header.
const STRIPE: ConversationMcpServer = {
  id: 'stripe',
  name: 'Stripe',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@stripe/mcp'],
  env: { STRIPE_SECRET_KEY: 'sk_test_secret' },
}
const STRIPE_RENDERED = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@stripe/mcp'],
  env: { STRIPE_SECRET_KEY: 'sk_test_secret' },
}
const SENTRY: ConversationMcpServer = {
  id: 'sentry',
  name: 'Sentry',
  transport: 'http',
  url: 'https://mcp.sentry.dev/mcp',
  headers: { Authorization: 'Bearer sntrys_secret' },
}

test('claude-agent-provider mcp servers', async () => {
  // The gateway reaches every chat, carrying the chat's identity for the launch cap.
  {
    const { adapter, firstTurn, gatewayAskedFor } = harness(GATEWAY)
    assert.equal(adapter.acceptsMcpServers, true)
    const options = await firstTurn()
    assert.deepEqual(options.settingSources, ['user'])
    assert.deepEqual(options.mcpServers, {
      'sprintengine-studio': {
        type: 'stdio',
        command: '/Applications/Studio.app/launcher',
        args: ['mcp'],
        env: {
          SPRINTENGINE_USER_DATA_DIR: '/Users/dev/Library/Application Support/Studio',
          SPRINTENGINE_WORKSPACE_ID: 'ws-1',
          SPRINTENGINE_AGENT_ID: 'agent-1',
          SPRINTENGINE_AGENT_CLI: 'claude-code',
        },
      },
    })
    assert.deepEqual(gatewayAskedFor, [{}])
    await adapter.disposeAll()
  }

  // A connector run's server is registered with the running child instead.
  {
    const { adapter, firstTurn, sent } = harness(GATEWAY)
    const options = await firstTurn({ mcpServers: [RAILWAY] })
    assert.deepEqual(Object.keys(options.mcpServers as object), ['sprintengine-studio'])
    assert.deepEqual(sent[0], {
      registered: { railway: { type: 'stdio', command: 'npx', args: ['-y', '@railway/mcp'] } },
    })
    await adapter.disposeAll()
  }

  // No gateway (or one that could not be resolved) leaves it out; the chat still runs.
  for (const gateway of [null, 'throws'] as const) {
    const { adapter, firstTurn } = harness(gateway)
    assert.equal((await firstTurn()).mcpServers, undefined)
    await adapter.disposeAll()
  }

  // A chat on a WSL machine asks for that machine's gateway.
  {
    const { firstTurn, gatewayAskedFor, adapter } = harness(null)
    await firstTurn({ cliRuntimes: { 'claude-code': { hostId: 'wsl:Ubuntu' } } })
    assert.deepEqual(gatewayAskedFor, [{ hostId: 'wsl:Ubuntu' }])
    await adapter.disposeAll()
  }

  // That gateway names the channel token its bridge opens with, and the entry
  // the SDK puts on the child's command line carries neither the token nor a
  // reference to it: the bridge inherits it from the child (spawnWslClaude).
  {
    const { firstTurn, adapter } = harness({
      id: 'sprintengine-studio',
      name: 'SprintEngine Studio',
      transport: 'stdio',
      command: '/home/dev/.local/share/sprintengine-studio/launcher',
      args: ['mcp'],
      env: { SPRINTENGINE_USER_DATA_DIR: '/run/user/1000/sprintengine' },
      envVarNames: ['SPRINTENGINE_MCP_CHANNEL_TOKEN'],
    })
    const options = await firstTurn({ cliRuntimes: { 'claude-code': { hostId: 'wsl:Ubuntu' } } })
    const entry = (options.mcpServers as Record<string, { env?: Record<string, string> }>)['sprintengine-studio']
    assert.equal(entry.env?.SPRINTENGINE_USER_DATA_DIR, '/run/user/1000/sprintengine')
    assert.doesNotMatch(JSON.stringify(entry), /SPRINTENGINE_MCP_CHANNEL_TOKEN/u)
    await adapter.disposeAll()
  }

  // The rendering: HTTP and SSE with a bearer token the CLI expands, Windows
  // paths for a child in WSL, and a server with nothing to start left out.
  assert.deepEqual(
    claudeMcpServers([
      {
        id: 'linear',
        name: 'Linear',
        transport: 'http',
        url: 'https://mcp.linear.app/mcp',
        envVarNames: ['LINEAR_TOKEN'],
      },
      { id: 'events', name: 'Events', transport: 'sse', url: 'https://example.com/sse', headers: { 'X-Team': 'acme' } },
      { id: 'broken', name: 'Broken', transport: 'stdio' },
    ]),
    {
      linear: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' } },
      events: { type: 'sse', url: 'https://example.com/sse', headers: { 'X-Team': 'acme' } },
    },
  )
  assert.deepEqual(
    claudeMcpServers(
      [{ id: 'local', name: 'Local', transport: 'stdio', command: 'C:\\tools\\mcp.exe', args: ['--x'] }],
      {
        wsl: true,
      },
    ).local,
    { type: 'stdio', command: '/mnt/c/tools/mcp.exe', args: ['--x'] },
  )
})

test('a connector’s secrets never reach the child’s command line, and its tools are there for the first message', async () => {
  const { adapter, firstTurn, sent } = harness(GATEWAY)
  const options = await firstTurn({ mcpServers: [STRIPE, SENTRY] })
  assert.doesNotMatch(JSON.stringify(options), /sk_test_secret|sntrys_secret/u)
  assert.deepEqual(sent, [
    {
      registered: {
        stripe: STRIPE_RENDERED,
        sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp', headers: { Authorization: 'Bearer sntrys_secret' } },
      },
    },
    { message: 'hello' },
  ])
  await adapter.disposeAll()
})

test('a chat without servers of its own registers none', async () => {
  const { adapter, firstTurn, sent } = harness(GATEWAY)
  await firstTurn()
  assert.deepEqual(sent, [{ message: 'hello' }])
  await adapter.disposeAll()
})

test('a server the child could not connect is named in the log, without what it was started with', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const { adapter, firstTurn, sent } = harness(GATEWAY, async () => ({
    added: ['sentry'],
    removed: [],
    errors: { stripe: 'spawn failed with STRIPE_SECRET_KEY=sk_test_secret' },
  }))
  await firstTurn({ mcpServers: [STRIPE, SENTRY] })
  assert.deepEqual(sent.at(-1), { message: 'hello' })
  assert.deepEqual(warn.mock.calls, [['[claude-agent] mcp-servers-unavailable', { servers: ['stripe'] }]])
  await adapter.disposeAll()
})

test('a child that refuses or never answers the registration still gets the message', async () => {
  for (const register of [
    async () => {
      throw new Error('Unsupported control request')
    },
    () => new Promise<never>(() => undefined),
  ]) {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { adapter, firstTurn, sent } = harness(GATEWAY, register)
    await firstTurn({ mcpServers: [STRIPE] })
    assert.deepEqual(sent, [{ message: 'hello' }])
    assert.deepEqual(warn.mock.calls, [['[claude-agent] mcp-servers-unavailable', { servers: ['stripe'] }]])
    warn.mockRestore()
    await adapter.disposeAll()
  }
})

test('a server that names a reference the CLI expands stays on the command line, and the gateway always does', () => {
  const linear: ConversationMcpServer = {
    id: 'linear',
    name: 'Linear',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    envVarNames: ['LINEAR_TOKEN'],
  }
  const launch = claudeMcpLaunch(GATEWAY, [linear, STRIPE])
  assert.deepEqual(Object.keys(launch.commandLine), ['sprintengine-studio', 'linear'])
  assert.deepEqual(Object.keys(launch.control), ['stripe'])
  assert.deepEqual(claudeMcpLaunch(null, []), { commandLine: {}, control: {}, env: {} })
})

test('a server on the command line names its literal values by reference, never carrying them', () => {
  const secret = 'sk-test-0123456789abcdef'
  const launch = claudeMcpLaunch(null, [
    {
      id: 'acme',
      name: 'Acme',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { 'X-Api-Key': secret },
      envVarNames: ['ACME_TOKEN'],
    },
    {
      id: 'tool',
      name: 'Tool',
      transport: 'stdio',
      command: 'tool',
      args: ['--key', secret, '--profile=${TOOL_PROFILE}'],
      env: { TOOL_SECRET: secret },
    },
  ])
  assert.deepEqual(Object.keys(launch.commandLine), ['acme', 'tool'])
  assert.equal(JSON.stringify(launch.commandLine).includes(secret), false)
  assert.deepEqual(launch.commandLine.acme, {
    type: 'http',
    url: 'https://mcp.example.com/mcp',
    headers: { 'X-Api-Key': '${SPRINTENGINE_MCP_SECRET_1}', Authorization: 'Bearer ${ACME_TOKEN}' },
  })
  assert.deepEqual(launch.commandLine.tool, {
    type: 'stdio',
    command: 'tool',
    args: ['${SPRINTENGINE_MCP_SECRET_2}', '${SPRINTENGINE_MCP_SECRET_3}', '--profile=${TOOL_PROFILE}'],
    env: { TOOL_SECRET: '${SPRINTENGINE_MCP_SECRET_4}' },
  })
  assert.deepEqual(launch.env, {
    SPRINTENGINE_MCP_SECRET_1: secret,
    SPRINTENGINE_MCP_SECRET_2: '--key',
    SPRINTENGINE_MCP_SECRET_3: secret,
    SPRINTENGINE_MCP_SECRET_4: secret,
  })
})

test('a server action asked while the child registers its servers waits for them', async () => {
  let answer = (): void => undefined
  const registering = new Promise<void>((resolve) => (answer = resolve))
  const { adapter, sent } = harness(GATEWAY, async (servers) => {
    await registering
    return { added: Object.keys(servers), removed: [], errors: {} }
  })
  const input = {
    sessionId: 'conv_1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    workspaceRoot: '/Users/dev/app',
    mcpServers: [STRIPE],
  }
  await adapter.startSession(input)
  const first = adapter.mcpServerAction!({ ...input, serverId: 'stripe', action: 'reconnect' })
  // The child runs and is registering; a second action finds it there.
  await new Promise((resolve) => setTimeout(resolve, 10))
  const second = adapter.mcpServerAction!({ ...input, serverId: 'stripe', action: 'reconnect' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(sent, [])
  answer()
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }])
  assert.deepEqual(sent, [
    { registered: { stripe: STRIPE_RENDERED } },
    { reconnected: 'stripe' },
    { reconnected: 'stripe' },
  ])
  await adapter.disposeAll()
})

test('an MCP call carries the title and server name Claude Code gave it, as short plain text', () => {
  const state = {
    sessionId: 'conv_1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    providerSessionId: null as string | null,
    turn: { turnId: 'turn_1' },
  }
  const events = mapSdkMessage(
    state,
    {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_mail',
            name: 'mcp__claude_ai_Gmail__search_threads',
            input: { query: 'invoice' },
          },
          { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/Users/dev/app/a.ts' } },
          { type: 'tool_use', id: 'toolu_bare', name: 'mcp__acme__run', input: {} },
        ],
      },
      tool_use_meta: [
        {
          id: 'toolu_mail',
          display_name: 'Search\nthreads\u0007',
          server_display_name: 'Gmail',
          icon_url: 'https://example.com/gmail.png',
        },
        // Built-in tools carry none; one that did is not an MCP call's.
        { id: 'toolu_read', display_name: 'Read file' },
        { id: 'toolu_bare', display_name: 'R'.repeat(300) },
      ],
    },
    { saveToolImages: false },
  )
  const started = new Map(
    events.filter((event) => event.type === 'tool_started').map((event) => [event.payload?.toolUseId, event.payload]),
  )
  assert.equal(started.get('toolu_mail')?.displayTitle, 'Search threads')
  assert.equal(started.get('toolu_mail')?.serverName, 'Gmail')
  assert.equal('icon_url' in (started.get('toolu_mail') ?? {}), false)
  assert.equal('iconUrl' in (started.get('toolu_mail') ?? {}), false)
  assert.equal(started.get('toolu_read')?.displayTitle, undefined)
  assert.equal((started.get('toolu_bare')?.displayTitle as string).length, 120)
  assert.equal(started.get('toolu_bare')?.serverName, undefined)
})
