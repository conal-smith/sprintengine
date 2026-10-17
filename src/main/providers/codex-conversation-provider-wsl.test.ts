// A Codex chat on a WSL machine, with a stand-in machine: the app-server is
// started inside the distribution from the CLI found there, in the folder as
// Linux names it, with the chat's identity and none of the API auth; Codex is
// spoken to in Linux paths and what it names comes back as this machine opens
// it. Nothing here runs `wsl.exe`.

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, test } from 'vitest'

import type { ConversationEvent, ConversationMcpServer } from '../../shared/conversation-runtime'
import { conversationCommandsFor } from '../conversation-commands/registry'
import { createCodexConversationProvider, probeCodexConversationCommands } from './codex-conversation-provider'
import { createCodexRpcTransport, type CodexRpcOptions, type RpcMessage } from './codex-json-rpc'

const ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'
const WSL_TARGET = { distro: 'Ubuntu', agentStateSocketPath: '/run/user/1000/sprintengine/agent.sock' }
const TOKEN = 'codex_chat_token_0123456789'
// The machine's token issuer, as `prepareWslCliTarget` hands it out.
const issueChannelToken = () => ({ token: TOKEN, revoke: () => undefined })

function decodedScript(args: readonly string[]): string {
  const encoded = /echo (\S+)\|base64 -d/u.exec(args.at(-1) ?? '')?.[1] ?? ''
  return Buffer.from(encoded, 'base64').toString('utf8')
}

function wslFixture(mcpServers: ConversationMcpServer[] = [], gateway: ConversationMcpServer | null = null) {
  let connection!: CodexRpcOptions
  const asked: unknown[] = []
  const calls: { method: string; params: unknown }[] = []
  const prepared: string[] = []
  let resolveStarted!: () => void
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve
  })
  const adapter = createCodexConversationProvider({
    prepareWslTarget: async (hostId) => {
      prepared.push(hostId)
      return { ...WSL_TARGET, issueChannelToken }
    },
    resolveExecutable: async () => '/home/dev/.local/bin/codex',
    ...(gateway
      ? {
          resolveStudioMcpServer: async (input: unknown) => {
            asked.push(input)
            return gateway
          },
        }
      : {}),
    buildEnv: async () => ({
      PATH: 'C:\\Windows\\System32',
      SPRINTENGINE_AGENT_ID: 'agent',
      SPRINTENGINE_CONVERSATION_SESSION_ID: 'session',
    }),
    createTransport(options) {
      connection = options
      return {
        pid: 42,
        async request(method, params) {
          calls.push({ method, params })
          if (method === 'account/read') return { requiresOpenaiAuth: true, account: { type: 'chatgpt' } }
          if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'native-thread' } }
          if (method === 'skills/list')
            return {
              data: [
                { cwd: '/home/dev/repo', skills: [{ name: 'release-notes', description: 'Notes', enabled: true }] },
              ],
            }
          if (method === 'turn/start') {
            resolveStarted()
            return { turn: { id: 'native-turn' } }
          }
          return {}
        },
        notify: (method, params) => calls.push({ method, params }),
        respond: () => undefined,
        reject: () => undefined,
        close: () => undefined,
      }
    },
  })
  const input = {
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'codex-agent',
    modelId: 'default',
    workspaceRoot: ROOT,
    cliRuntimes: { codex: { command: '', hostId: 'wsl:Ubuntu' as const } },
    ...(mcpServers.length ? { mcpServers } : {}),
  }
  return {
    adapter,
    input,
    calls,
    prepared,
    asked,
    started,
    get connection() {
      return connection
    },
    message: (value: RpcMessage) => connection.onMessage(value),
  }
}

test('a Codex chat on a WSL machine starts that machine’s app-server in the folder as Linux names it', async () => {
  const f = wslFixture([
    {
      id: 'files',
      name: 'Files',
      transport: 'stdio',
      command: 'C:\\tools\\node.exe',
      args: ['C:\\tools\\files-server.js'],
    },
  ])
  await f.adapter.startSession(f.input)
  const events: ConversationEvent[] = []
  const turn = (async () => {
    for await (const event of (await f.adapter.sendTurn({
      ...f.input,
      turnId: 'turn',
      requestId: 'request',
      message: 'Look around.',
    })) as AsyncIterable<ConversationEvent>)
      events.push(event)
  })()
  await f.started
  expect(f.prepared).toEqual(['wsl:Ubuntu'])
  expect(f.connection.command).toBe('/home/dev/.local/bin/codex')
  expect(f.connection.wsl).toMatchObject({
    distro: 'Ubuntu',
    agentStateSocketPath: WSL_TARGET.agentStateSocketPath,
  })
  expect(f.connection.wsl?.forwardEnv).toEqual(
    expect.arrayContaining(['SPRINTENGINE_AGENT_ID', 'SPRINTENGINE_CONVERSATION_SESSION_ID']),
  )
  expect(f.connection.wsl?.unsetEnv).toEqual(expect.arrayContaining(['OPENAI_API_KEY', 'CODEX_API_KEY']))
  // The app-server is issued its channel token as it starts (createCodexRpcTransport).
  expect(f.connection.wsl?.issueChannelToken).toBe(issueChannelToken)
  // The session's MCP server is started by the Linux side, so its paths are the distribution's.
  expect(f.connection.args?.join(' ')).toContain('"/mnt/c/tools/node.exe"')
  expect(f.connection.args?.join(' ')).toContain('"/mnt/c/tools/files-server.js"')
  expect(f.calls.find((call) => call.method === 'thread/start')?.params).toMatchObject({ cwd: '/home/dev/repo' })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.calls.find((call) => call.method === 'skills/list')?.params).toEqual({ cwds: ['/home/dev/repo'] })
  // The menu is keyed by the folder as this machine names it, which is where the chat box looks.
  expect(conversationCommandsFor('codex', ROOT).commands.map((command) => command.name)).toContain('release-notes')

  // A picture Codex saved in the distribution is opened from this machine.
  await f.message({
    method: 'item/completed',
    params: {
      item: {
        id: 'picture',
        type: 'imageGeneration',
        status: 'completed',
        revisedPrompt: null,
        result: '',
        failure: null,
        savedPath: '/home/dev/.codex/generated_images/a.png',
      },
    },
  })
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await turn
  const picture = events.find((event) => event.type === 'tool_started' && event.payload?.toolUseId === 'picture')
  expect(picture?.payload?.input).toMatchObject({
    path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.codex\\generated_images\\a.png',
  })
  f.adapter.disposeAll?.()
})

test("a Codex chat on a WSL machine is handed that machine's gateway, its token named and never carried", async () => {
  // The gateway as the distribution's helper describes it: the bridge there,
  // and the token by name, since the app-server inherits it from its stdin.
  const gateway: ConversationMcpServer = {
    id: 'sprintengine-studio',
    name: 'SprintEngine Studio MCP',
    transport: 'stdio',
    command: '/home/dev/.sprintengine/bin/studio',
    args: ['mcp'],
    env: { SPRINTENGINE_USER_DATA_DIR: '/home/dev/.local/share/sprintengine-studio' },
    envVarNames: ['SPRINTENGINE_MCP_CHANNEL_TOKEN'],
  }
  const f = wslFixture([], gateway)
  await f.adapter.startSession(f.input)
  const turn = (async () => {
    for await (const _ of (await f.adapter.sendTurn({
      ...f.input,
      turnId: 'turn',
      requestId: 'request',
      message: 'Hi.',
    })) as AsyncIterable<ConversationEvent>);
  })()
  await f.started
  expect(f.asked).toEqual([{ hostId: 'wsl:Ubuntu' }])
  expect(f.connection.args).toEqual([
    '-c',
    'mcp_optional_startup_grace_ms=10000',
    '-c',
    'mcp_servers.sprintengine-studio={ "command" = "/home/dev/.sprintengine/bin/studio", "args" = ["mcp"], "env_vars" = ["SPRINTENGINE_MCP_CHANNEL_TOKEN"], "env" = { "SPRINTENGINE_USER_DATA_DIR" = "/home/dev/.local/share/sprintengine-studio", "SPRINTENGINE_WORKSPACE_ID" = "workspace", "SPRINTENGINE_AGENT_ID" = "agent", "SPRINTENGINE_AGENT_CLI" = "codex" } }',
  ])
  expect(f.connection.args?.join(' ')).not.toContain(TOKEN)
  // The token the gateway will see is the app-server's own, issued as it starts.
  expect(f.connection.wsl?.issueChannelToken).toBe(issueChannelToken)
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await turn
  f.adapter.disposeAll?.()
})

test('a Codex chat on this machine is started as it always was', async () => {
  const f = wslFixture()
  const local = { ...f.input, workspaceRoot: '/Users/dev/repo', cliRuntimes: undefined }
  await f.adapter.startSession(local)
  const turn = (async () => {
    for await (const _ of (await f.adapter.sendTurn({
      ...local,
      turnId: 'turn',
      requestId: 'request',
      message: 'Hi.',
    })) as AsyncIterable<ConversationEvent>);
  })()
  await f.started
  expect(f.prepared).toEqual([])
  expect(f.connection.wsl).toBeNull()
  expect(f.calls.find((call) => call.method === 'thread/start')?.params).toMatchObject({ cwd: '/Users/dev/repo' })
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await turn
  f.adapter.disposeAll?.()
})

test("Codex's skills for a folder on a WSL machine are asked of that machine's app-server", async () => {
  const asked: unknown[] = []
  let options!: CodexRpcOptions
  const cwd = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\probe'
  await probeCodexConversationCommands(
    { cwd, cliRuntimes: { codex: { hostId: 'wsl:Ubuntu' } } },
    {
      prepareWslTarget: async () => ({ ...WSL_TARGET, issueChannelToken }),
      resolveExecutable: async () => '/home/dev/.local/bin/codex',
      buildEnv: async () => ({}),
      createTransport: (given) => {
        options = given
        return {
          pid: 1,
          async request(method, params) {
            if (method !== 'skills/list') return {}
            asked.push(params)
            return { data: [{ cwd: '/home/dev/probe', skills: [{ name: 'triage', description: '', enabled: true }] }] }
          },
          notify: () => undefined,
          respond: () => undefined,
          reject: () => undefined,
          close: () => undefined,
        }
      },
    },
  )
  expect(options.wsl?.distro).toBe('Ubuntu')
  // It opens no thread, so it starts no MCP server and needs no token.
  expect(options.wsl?.issueChannelToken).toBeUndefined()
  expect(asked).toEqual([{ cwds: ['/home/dev/probe'] }])
  expect(conversationCommandsFor('codex', cwd).commands.map((command) => command.name)).toContain('triage')
})

test('the app-server for a WSL chat is one wsl.exe running codex inside the distribution', () => {
  const spawned: unknown[][] = []
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 7,
    exitCode: 0 as number | null,
    kill: () => true,
  })
  const transport = createCodexRpcTransport({
    command: '/home/dev/.local/bin/codex',
    cwd: 'C:\\Users\\dev\\repo',
    env: { PATH: 'C:\\Windows', SPRINTENGINE_AGENT_ID: 'agent' },
    platform: 'win32',
    wsl: { ...WSL_TARGET, forwardEnv: ['SPRINTENGINE_AGENT_ID'], unsetEnv: ['OPENAI_API_KEY'] },
    spawnChild: ((...args: unknown[]) => {
      spawned.push(args)
      return child
    }) as unknown as CodexRpcOptions['spawnChild'],
    onMessage: () => undefined,
    onClose: () => undefined,
  })
  const [file, args] = spawned[0] as [string, string[]]
  expect(file).toBe('wsl.exe')
  expect(args.slice(0, 2)).toEqual(['-d', 'Ubuntu'])
  const script = decodedScript(args)
  expect(script).toContain('/home/dev/.local/bin/codex')
  expect(script).toContain('app-server')
  expect(script).toContain('stdio://')
  expect(script).toContain('/mnt/c/Users/dev/repo')
  expect(script).toContain('SPRINTENGINE_AGENT_ID=agent')
  expect(script).not.toContain('C:\\Windows')
  transport.close()
})

test("a WSL app-server's MCP channel token is read from stdin before the protocol, and taken back when it ends", async () => {
  const spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = []
  const revoked: string[] = []
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 7,
    exitCode: null as number | null,
    kill: () => true,
  })
  const transport = createCodexRpcTransport({
    command: '/home/dev/.local/bin/codex',
    cwd: 'C:\\Users\\dev\\repo',
    env: { SPRINTENGINE_AGENT_ID: 'agent' },
    platform: 'win32',
    wsl: {
      ...WSL_TARGET,
      forwardEnv: ['SPRINTENGINE_AGENT_ID'],
      issueChannelToken: () => ({ token: TOKEN, revoke: () => revoked.push(TOKEN) }),
    },
    spawnChild: ((_file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      spawned.push({ args, env: options.env })
      return child
    }) as unknown as CodexRpcOptions['spawnChild'],
    onMessage: () => undefined,
    onClose: () => undefined,
  })
  void transport.request('initialize', {}).catch(() => undefined)
  const written = child.stdin.read()?.toString() ?? ''
  // Codex hands the token to the gateway its config names it for (`env_vars`).
  expect(written.split('\n')[0]).toBe(TOKEN)
  expect(JSON.parse(written.split('\n')[1])).toMatchObject({ method: 'initialize' })
  expect(spawned[0].args.join(' ')).not.toContain(TOKEN)
  expect(decodedScript(spawned[0].args)).not.toContain(TOKEN)
  expect(decodedScript(spawned[0].args)).toContain('read -r SPRINTENGINE_MCP_CHANNEL_TOKEN')
  expect(spawned[0].env.SPRINTENGINE_MCP_CHANNEL_TOKEN).toBeUndefined()
  expect(revoked).toEqual([])
  child.exitCode = 0
  child.emit('close', 0)
  expect(revoked).toEqual([TOKEN])
})
