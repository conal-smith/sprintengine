// An ACP chat on a WSL machine, with a stand-in machine: every shipped agent
// (Cursor, OpenCode, Grok) is started inside the distribution from the CLI
// found there, with its preset's flags and variables, and is told the folder
// as Linux names it. What would be `wsl.exe` is recorded, and a stand-in agent
// on this machine answers the protocol in its place.

import { spawn } from 'node:child_process'
import { expect, test } from 'vitest'

import type {
  ConversationEvent,
  ConversationMcpServer,
  ConversationPermissionPreset,
} from '../../shared/conversation-runtime'
import {
  ACP_PROFILES,
  acpClientPath,
  acpLaunchArgv,
  createAcpConversationProvider,
  probeAcpConversationCommands,
  type AcpProfile,
} from './acp-conversation-provider'
import type { MockAdapterSessionInput } from './conversation-provider-adapter'

const ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'
const WSL_TARGET = { distro: 'Ubuntu', agentStateSocketPath: null }

// Answers the handshake and a session, and reports what it was told when asked.
const agent = `
const { createInterface } = require('node:readline');
let session = null;
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line), p = m.params || {};
  if (!m.method) return;
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [], _meta: { availableCommands: [{ name: 'compact', description: 'Compact' }] } } });
  if (m.method === 'session/new') { session = { cwd: p.cwd, mcpServers: p.mcpServers }; return send({ id: m.id, result: { sessionId: 'native' } }); }
  if (m.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(session) } } } });
    return send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
  if (m.id !== undefined) send({ id: m.id, result: {} });
});
`

function decodedScript(args: readonly string[]): string {
  const encoded = /echo (\S+)\|base64 -d/u.exec(args.at(-1) ?? '')?.[1] ?? ''
  return Buffer.from(encoded, 'base64').toString('utf8')
}

type Spawned = { file: string; args: string[]; cwd: unknown }

// Records what would run and starts the stand-in agent in its place.
function standInSpawn(spawned: Spawned[]) {
  return ((file: string, args: string[], options: { cwd?: unknown }) => {
    spawned.push({ file, args, cwd: options.cwd })
    return spawn(process.execPath, ['-e', agent], { stdio: ['pipe', 'pipe', 'pipe'] })
  }) as unknown as typeof spawn
}

async function reported(
  provider: ReturnType<typeof createAcpConversationProvider>,
  input: MockAdapterSessionInput,
): Promise<{ cwd: string; mcpServers: Array<{ command?: string; args?: string[] }> }> {
  let text = ''
  for await (const event of (await provider.sendTurn({
    ...input,
    turnId: 'turn',
    requestId: 'request',
    message: 'report',
  })) as AsyncIterable<ConversationEvent>)
    if (event.type === 'content_delta') text += String(event.payload?.text ?? '')
  return JSON.parse(text)
}

const PRESETS: ConversationPermissionPreset[] = ['none', 'manual', 'auto', 'bypass']

for (const profile of ACP_PROFILES) {
  test(`a ${profile.displayName} chat on a WSL machine runs that machine's CLI, in the folder as Linux names it`, async () => {
    for (const preset of PRESETS) {
      if (preset !== 'none' && !profile.presets?.[preset]) continue
      const spawned: Spawned[] = []
      const prepared: string[] = []
      const provider = createAcpConversationProvider({ ...profile, authenticate: undefined } satisfies AcpProfile, {
        prepareWslTarget: async (hostId) => {
          prepared.push(hostId)
          return WSL_TARGET
        },
        detect: async () => `/home/dev/.local/bin/${profile.cli}`,
        buildEnv: async () => ({ PATH: 'C:\\Windows\\System32', APPDATA: 'C:\\Users\\dev\\AppData' }),
        spawnChild: standInSpawn(spawned),
        startupTimeoutMs: 5_000,
      })
      const input = {
        sessionId: `session-${preset}`,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: profile.id,
        modelId: 'default',
        workspaceRoot: ROOT,
        permissionPreset: preset,
        cliRuntimes: { [profile.cli]: { command: '', hostId: 'wsl:Ubuntu' as const } },
        mcpServers: [
          {
            id: 'files',
            name: 'Files',
            transport: 'stdio',
            command: 'C:\\tools\\node.exe',
            args: ['C:\\tools\\files-server.js'],
          } satisfies ConversationMcpServer,
        ],
      }
      try {
        await provider.startSession(input)
        expect(prepared).toEqual(['wsl:Ubuntu'])
        expect(spawned).toHaveLength(1)
        const [{ file, args }] = spawned
        expect(file).toBe('wsl.exe')
        expect(args.slice(0, 2)).toEqual(['-d', 'Ubuntu'])
        const script = decodedScript(args)
        expect(script).toContain(`/home/dev/.local/bin/${profile.cli}`)
        expect(script).toContain('/home/dev/repo')
        for (const flag of acpLaunchArgv(profile, preset)) expect(script, `${preset}: ${flag}`).toContain(flag)
        // A preset told through the environment goes in with the CLI; this PC's environment does not.
        for (const key of Object.keys(profile.presets?.[preset as 'auto']?.env ?? {}))
          expect(script, `${preset}: ${key}`).toContain(`${key}=`)
        expect(script).not.toContain('APPDATA')
        const told = await reported(provider, input)
        expect(told.cwd).toBe('/home/dev/repo')
        expect(told.mcpServers[0]).toMatchObject({
          command: '/mnt/c/tools/node.exe',
          args: ['/mnt/c/tools/files-server.js'],
        })
      } finally {
        provider.disposeAll?.()
      }
    }
  })
}

test('an ACP chat on this machine is started as it always was', async () => {
  const spawned: Spawned[] = []
  const profile = ACP_PROFILES.find((entry) => entry.cli === 'opencode')!
  const provider = createAcpConversationProvider(profile, {
    prepareWslTarget: async () => expect.unreachable('this machine is not a WSL machine'),
    detect: async () => '/usr/local/bin/opencode',
    buildEnv: async () => ({}),
    spawnChild: standInSpawn(spawned),
  })
  const input = {
    sessionId: 'local',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: profile.id,
    modelId: 'default',
    workspaceRoot: '/Users/dev/repo',
  }
  try {
    await provider.startSession(input)
    expect(spawned[0]).toMatchObject({ file: '/usr/local/bin/opencode', args: ['acp'], cwd: '/Users/dev/repo' })
    expect((await reported(provider, input)).cwd).toBe('/Users/dev/repo')
  } finally {
    provider.disposeAll?.()
  }
})

test("Grok's handshake commands for a folder on a WSL machine are asked of that machine's CLI", async () => {
  const spawned: Spawned[] = []
  const grok = ACP_PROFILES.find((entry) => entry.cli === 'grok')!
  const commands = await probeAcpConversationCommands(
    grok,
    { cwd: ROOT, cliRuntimes: { grok: { hostId: 'wsl:Ubuntu' } } },
    {
      prepareWslTarget: async () => WSL_TARGET,
      detect: async () => '/home/dev/.local/bin/grok',
      buildEnv: async () => ({}),
      spawnChild: standInSpawn(spawned),
    },
  )
  expect(commands?.map((command) => command.name)).toEqual(['compact'])
  expect(spawned[0]?.file).toBe('wsl.exe')
  expect(decodedScript(spawned[0]!.args)).toContain('/home/dev/repo')
})

test("Grok's handshake on a WSL machine is started there with its self-updater off", async () => {
  const spawned: Spawned[] = []
  const grok = ACP_PROFILES.find((entry) => entry.cli === 'grok')!
  await probeAcpConversationCommands(
    grok,
    { cwd: ROOT, cliRuntimes: { grok: { hostId: 'wsl:Ubuntu' } } },
    {
      prepareWslTarget: async () => WSL_TARGET,
      detect: async () => '/home/dev/.local/bin/grok',
      buildEnv: async () => ({}),
      spawnChild: standInSpawn(spawned),
    },
  )
  expect(decodedScript(spawned[0]!.args)).toContain('GROK_DISABLE_AUTOUPDATER=1')
})

// The stand-in in place of the script `wsl.exe` would run: it takes the
// token from the first line of stdin, as that script does, and reports it.
const agentWithToken = `
const { createInterface } = require('node:readline');
let token = null, session = null;
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  if (token === null) { token = line; return; }
  const m = JSON.parse(line), p = m.params || {};
  if (!m.method) return;
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  if (m.method === 'session/new') { session = { cwd: p.cwd, mcpServers: p.mcpServers, token }; return send({ id: m.id, result: { sessionId: 'native' } }); }
  if (m.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(session) } } } });
    return send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
  if (m.id !== undefined) send({ id: m.id, result: {} });
});
`

for (const profile of ACP_PROFILES) {
  test(`a ${profile.displayName} chat on a WSL machine is issued its own MCP channel token, on stdin`, async () => {
    const token = `acp_${profile.cli}_token_0123456789`
    const issued: string[] = []
    const revoked: string[] = []
    const spawned: Array<Spawned & { env: NodeJS.ProcessEnv }> = []
    const provider = createAcpConversationProvider({ ...profile, authenticate: undefined } satisfies AcpProfile, {
      prepareWslTarget: async () => ({
        ...WSL_TARGET,
        issueChannelToken: () => {
          issued.push(token)
          return { token, revoke: () => revoked.push(token) }
        },
      }),
      detect: async () => `/home/dev/.local/bin/${profile.cli}`,
      buildEnv: async () => ({}),
      spawnChild: ((file: string, args: string[], options: { cwd?: unknown; env: NodeJS.ProcessEnv }) => {
        spawned.push({ file, args, cwd: options.cwd, env: options.env })
        return spawn(process.execPath, ['-e', agentWithToken], { stdio: ['pipe', 'pipe', 'pipe'] })
      }) as unknown as typeof spawn,
      startupTimeoutMs: 5_000,
    })
    const input = {
      sessionId: 'session-token',
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: profile.id,
      modelId: 'default',
      workspaceRoot: ROOT,
      cliRuntimes: { [profile.cli]: { command: '', hostId: 'wsl:Ubuntu' as const } },
    }
    try {
      await provider.startSession(input)
      const told = (await reported(provider, input)) as { token?: string }
      // The agent passes it on to the app's gateway it starts from its own configuration.
      expect(told.token).toBe(token)
      expect(issued).toEqual([token])
      expect(spawned[0].args.join(' ')).not.toContain(token)
      expect(decodedScript(spawned[0].args)).not.toContain(token)
      expect(spawned[0].env.SPRINTENGINE_MCP_CHANNEL_TOKEN).toBeUndefined()
    } finally {
      provider.disposeAll?.()
    }
    await expect.poll(() => revoked).toEqual([token])
  })
}

test("a WSL agent's handshake probe is issued no token", async () => {
  const grok = ACP_PROFILES.find((entry) => entry.cli === 'grok')!
  const spawned: Spawned[] = []
  await probeAcpConversationCommands(
    grok,
    { cwd: ROOT, cliRuntimes: { grok: { hostId: 'wsl:Ubuntu' } } },
    {
      prepareWslTarget: async () => ({
        ...WSL_TARGET,
        issueChannelToken: () => expect.unreachable('a probe opens no session'),
      }),
      detect: async () => '/home/dev/.local/bin/grok',
      buildEnv: async () => ({}),
      spawnChild: standInSpawn(spawned),
    },
  )
  expect(decodedScript(spawned[0]!.args)).not.toContain('read -r')
})

test('a file an agent in WSL asks for is opened through the workspace as this machine names it', () => {
  expect(acpClientPath('/home/dev/repo/src/a.ts', ROOT, WSL_TARGET)).toBe(
    '//wsl.localhost/Ubuntu/home/dev/repo/src/a.ts',
  )
  expect(acpClientPath('/mnt/c/Users/dev/repo/a.ts', 'C:\\Users\\dev\\repo', WSL_TARGET)).toBe('C:/Users/dev/repo/a.ts')
  expect(acpClientPath('/Users/dev/repo/a.ts', '/Users/dev/repo', null)).toBe('/Users/dev/repo/a.ts')
})
