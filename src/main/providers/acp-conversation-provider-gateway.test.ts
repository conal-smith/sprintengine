// An ACP chat (Cursor, OpenCode, Grok, Kimi Code) is handed the app's MCP gateway when its
// session opens, beside the session's own servers, with its own gateway token
// bound to the chat. The agent's environment names no conversation, so the
// token rides on the gateway's entry, in the protocol on the child's stdin; a
// stand-in agent records what it was told.

import { spawn } from 'node:child_process'
import { expect, test } from 'vitest'

import type { ConversationEvent, ConversationMcpServer } from '../../shared/conversation-runtime'
import type { GatewayLaunchIdentity } from '../../server/core/gateway-launch-tokens'
import { resolveGatewayLaunchToken } from '../../server/core/gateway-launch-tokens'
import { ACP_PROFILES, createAcpConversationProvider, type AcpProfile } from './acp-conversation-provider'
import type { MockAdapterSessionInput } from './conversation-provider-adapter'

const TOKEN_ENV = 'SPRINTENGINE_MCP_CHANNEL_TOKEN'
const STUDIO_ID = 'sprintengine-studio'

// The gateway as this machine's resolver hands it out.
const LOCAL_GATEWAY: ConversationMcpServer = {
  id: STUDIO_ID,
  name: 'SprintEngine Studio MCP',
  transport: 'stdio',
  command: '/Users/dev/.sprintengine/bin/studio',
  args: ['mcp'],
  env: { SPRINTENGINE_USER_DATA_DIR: '/Users/dev/Library/Application Support/SprintEngine Studio' },
}
// And as a WSL machine's: the token is named, never carried, since it is the CLI's own there.
const WSL_GATEWAY: ConversationMcpServer = {
  ...LOCAL_GATEWAY,
  command: '/home/dev/.sprintengine/bin/studio',
  env: { SPRINTENGINE_USER_DATA_DIR: '/home/dev/.local/share/sprintengine-studio' },
  envVarNames: [TOKEN_ENV],
}
const OWN_SERVER: ConversationMcpServer = {
  id: 'railway',
  name: 'Railway',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@railway/mcp'],
}

// Answers the handshake (it can load and branch sessions), opens and reopens
// sessions, and on any prompt reports every session request it was sent, with
// the first stdin line when it was started the way a WSL child is.
const agent = (readsToken: boolean) => `
const { createInterface } = require('node:readline');
let token = ${readsToken ? 'null' : "''"};
const told = [];
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  if (token === null) { token = line; return; }
  const m = JSON.parse(line), p = m.params || {};
  if (!m.method) return;
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } }, authMethods: [] } });
  if (m.method === 'session/new' || m.method === 'session/load' || m.method === 'session/fork') {
    told.push({ method: m.method, mcpServers: p.mcpServers });
    return send({ id: m.id, result: m.method === 'session/load' ? {} : { sessionId: m.method === 'session/fork' ? 'branch' : 'native' } });
  }
  if (m.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ told, token, env: process.env.${TOKEN_ENV} ?? null }) } } } });
    return send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
  if (m.id !== undefined) send({ id: m.id, result: {} });
});
`

type McpEntry = { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
type Report = { told: Array<{ method: string; mcpServers: McpEntry[] }>; token: string; env: string | null }

async function report(
  provider: ReturnType<typeof createAcpConversationProvider>,
  input: MockAdapterSessionInput,
): Promise<Report> {
  let text = ''
  for await (const event of (await provider.sendTurn({
    ...input,
    turnId: 'turn',
    requestId: 'request',
    message: 'report',
  })) as AsyncIterable<ConversationEvent>)
    if (event.type === 'content_delta') text += String(event.payload?.text ?? '')
  return JSON.parse(text) as Report
}

const envOf = (entry: McpEntry) => Object.fromEntries(entry.env.map(({ name, value }) => [name, value]))

type Spawned = { file: string; args: string[]; env: NodeJS.ProcessEnv }

function localProvider(profile: AcpProfile, spawned: Spawned[], asked: unknown[] = []) {
  return createAcpConversationProvider({ ...profile, authenticate: undefined } satisfies AcpProfile, {
    detect: async () => `/usr/local/bin/${profile.cli}`,
    buildEnv: async () => ({ PATH: process.env.PATH }),
    resolveStudioMcpServer: async (input) => {
      asked.push(input)
      return LOCAL_GATEWAY
    },
    spawnChild: ((file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      spawned.push({ file, args, env: options.env })
      return spawn(process.execPath, ['-e', agent(false)], { stdio: ['pipe', 'pipe', 'pipe'], env: options.env })
    }) as unknown as typeof spawn,
    startupTimeoutMs: 5_000,
  })
}

const sessionInput = (profile: AcpProfile, extra: Partial<MockAdapterSessionInput> = {}): MockAdapterSessionInput => ({
  sessionId: `session-${profile.cli}`,
  workspaceId: 'workspace',
  agentId: `agent-${profile.cli}`,
  providerId: profile.id,
  modelId: 'default',
  workspaceRoot: process.cwd(),
  // A server of the session's own that reuses the gateway's id would be a second gateway.
  mcpServers: [OWN_SERVER, { ...OWN_SERVER, id: STUDIO_ID, name: 'Stale Studio entry' }],
  ...extra,
})

for (const profile of ACP_PROFILES) {
  test(`a ${profile.displayName} chat opens its session with one gateway, carrying a token bound to the chat`, async () => {
    const spawned: Spawned[] = []
    const asked: unknown[] = []
    const provider = localProvider(profile, spawned, asked)
    const input = sessionInput(profile)
    let token = ''
    try {
      await provider.startSession(input)
      const told = await report(provider, input)
      expect(asked).toEqual([{}])
      const servers = told.told[0]!.mcpServers
      // The gateway first and once, the person's own server after it, and nothing else under the gateway's name.
      expect(servers.map((server) => server.name)).toEqual([STUDIO_ID, 'railway'])
      const gateway = servers[0]!
      expect(gateway).toMatchObject({ command: LOCAL_GATEWAY.command, args: ['mcp'] })
      const env = envOf(gateway)
      expect(env).toMatchObject({
        SPRINTENGINE_USER_DATA_DIR: LOCAL_GATEWAY.env!.SPRINTENGINE_USER_DATA_DIR,
        SPRINTENGINE_WORKSPACE_ID: 'workspace',
        SPRINTENGINE_AGENT_ID: `agent-${profile.cli}`,
        SPRINTENGINE_AGENT_CLI: profile.cli,
      })
      token = env[TOKEN_ENV]!
      expect(token).toMatch(/^selaunch_/u)
      expect(gateway.env.filter(({ name }) => name === TOKEN_ENV)).toHaveLength(1)
      // The gateway takes the chat from the token.
      expect(resolveGatewayLaunchToken(token)).toEqual({
        workspaceId: 'workspace',
        agentId: `agent-${profile.cli}`,
        cliId: profile.cli,
      } satisfies GatewayLaunchIdentity)
      // The child holds the same token, and no command line names it.
      expect(told.env).toBe(token)
      expect(spawned).toHaveLength(1)
      expect(spawned[0]!.args.join(' ')).not.toContain(token)
    } finally {
      provider.disposeAll?.()
    }
    // Taken back with the child.
    await expect.poll(() => resolveGatewayLaunchToken(token)).toBeNull()
  })
}

test('a reopened ACP session is handed a fresh token, and a branch of one is handed none', async () => {
  const profile = ACP_PROFILES.find((entry) => entry.cli === 'opencode')!
  const spawned: Spawned[] = []
  const first = localProvider(profile, spawned)
  const input = sessionInput(profile, { mcpServers: [] })
  let opened = ''
  try {
    await first.startSession(input)
    const told = await report(first, input)
    opened = envOf(told.told[0]!.mcpServers[0]!)[TOKEN_ENV]!
    // A fork at the newest reply branches this session. The branch is another
    // chat's, opened by that chat's own child: this one's token is not handed to it.
    expect(await first.fork!({ ...input, cursor: null, exact: false, latest: true })).toEqual({
      ok: true,
      cursor: { sessionId: 'branch', at: null },
    })
    const after = await report(first, input)
    const fork = after.told.find((entry) => entry.method === 'session/fork')!
    expect(fork.mcpServers.map((server) => server.name)).not.toContain(STUDIO_ID)
    expect(JSON.stringify(fork)).not.toContain(opened)
  } finally {
    first.disposeAll?.()
  }
  await expect.poll(() => resolveGatewayLaunchToken(opened)).toBeNull()

  // The chat reopened later (the app restarted, or its child was settled): a new child and a new token.
  const second = localProvider(profile, spawned)
  const resumed = { ...input, resumeSessionId: 'native' }
  try {
    await second.startSession(resumed)
    const told = await report(second, resumed)
    expect(told.told.map((entry) => entry.method)).toEqual(['session/load'])
    const reopened = envOf(told.told[0]!.mcpServers[0]!)[TOKEN_ENV]!
    expect(reopened).toMatch(/^selaunch_/u)
    expect(reopened).not.toBe(opened)
    expect(resolveGatewayLaunchToken(reopened)).toMatchObject({ workspaceId: 'workspace', agentId: input.agentId })
  } finally {
    second.disposeAll?.()
  }
})

test('an ACP chat whose gateway cannot be resolved still starts, with only its own servers', async () => {
  const profile = ACP_PROFILES[0]!
  const provider = createAcpConversationProvider({ ...profile, authenticate: undefined } satisfies AcpProfile, {
    detect: async () => `/usr/local/bin/${profile.cli}`,
    buildEnv: async () => ({ PATH: process.env.PATH }),
    resolveStudioMcpServer: async () => {
      throw new Error('The launcher could not be written.')
    },
    spawnChild: (() =>
      spawn(process.execPath, ['-e', agent(false)], { stdio: ['pipe', 'pipe', 'pipe'] })) as unknown as typeof spawn,
    startupTimeoutMs: 5_000,
  })
  const input = sessionInput(profile, { mcpServers: [OWN_SERVER] })
  try {
    await provider.startSession(input)
    const told = await report(provider, input)
    expect(told.told[0]!.mcpServers.map((server) => server.name)).toEqual(['railway'])
  } finally {
    provider.disposeAll?.()
  }
})

function decodedScript(args: readonly string[]): string {
  const encoded = /echo (\S+)\|base64 -d/u.exec(args.at(-1) ?? '')?.[1] ?? ''
  return Buffer.from(encoded, 'base64').toString('utf8')
}

for (const profile of ACP_PROFILES) {
  test(`a ${profile.displayName} chat on a WSL machine carries its channel token on the gateway's entry, never on argv`, async () => {
    const token = `acp_${profile.cli}_gateway_token_0123456789`
    const issued: Array<GatewayLaunchIdentity | null | undefined> = []
    const revoked: string[] = []
    const asked: unknown[] = []
    const spawned: Spawned[] = []
    const provider = createAcpConversationProvider({ ...profile, authenticate: undefined } satisfies AcpProfile, {
      prepareWslTarget: async () => ({
        distro: 'Ubuntu',
        agentStateSocketPath: null,
        issueChannelToken: (identity) => {
          issued.push(identity)
          return { token, revoke: () => revoked.push(token) }
        },
      }),
      detect: async () => `/home/dev/.local/bin/${profile.cli}`,
      buildEnv: async () => ({}),
      resolveStudioMcpServer: async (input) => {
        asked.push(input)
        return WSL_GATEWAY
      },
      spawnChild: ((file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        spawned.push({ file, args, env: options.env })
        return spawn(process.execPath, ['-e', agent(true)], { stdio: ['pipe', 'pipe', 'pipe'] })
      }) as unknown as typeof spawn,
      startupTimeoutMs: 5_000,
    })
    const input = sessionInput(profile, {
      workspaceRoot: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
      cliRuntimes: { [profile.cli]: { command: '', hostId: 'wsl:Ubuntu' as const } },
    })
    try {
      await provider.startSession(input)
      const told = await report(provider, input)
      expect(asked).toEqual([{ hostId: 'wsl:Ubuntu' }])
      // Issued for this chat, and handed to the child on stdin as before.
      expect(issued).toEqual([{ workspaceId: 'workspace', agentId: `agent-${profile.cli}`, cliId: profile.cli }])
      expect(told.token).toBe(token)
      const servers = told.told[0]!.mcpServers
      expect(servers.map((server) => server.name)).toEqual([STUDIO_ID, 'railway'])
      const gateway = servers[0]!
      expect(gateway.command).toBe(WSL_GATEWAY.command)
      expect(gateway.env.filter(({ name }) => name === TOKEN_ENV)).toEqual([{ name: TOKEN_ENV, value: token }])
      expect(envOf(gateway)).toMatchObject({ SPRINTENGINE_AGENT_ID: `agent-${profile.cli}` })
      // Never on `wsl.exe`'s command line, nor in its environment, nor through WSLENV.
      expect(spawned[0]!.file).toBe('wsl.exe')
      expect(spawned[0]!.args.join(' ')).not.toContain(token)
      expect(decodedScript(spawned[0]!.args)).not.toContain(token)
      expect(spawned[0]!.env[TOKEN_ENV]).toBeUndefined()
      expect(spawned[0]!.env.WSLENV ?? '').not.toContain(TOKEN_ENV)
    } finally {
      provider.disposeAll?.()
    }
    await expect.poll(() => revoked).toEqual([token])
  })
}
