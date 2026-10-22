import { spawnSync, type spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'

import { installHostRegistry, type HostRegistry } from '../hosts/host-registry'
import {
  cliHostSpawn,
  mcpServersOnWsl,
  prepareWslCliTarget,
  spawnCliHostChild,
  wslCliLaunchArgs,
  wslTargetForHost,
} from './cli-host-child'
import { resolveGatewayLaunchToken } from '../../server/core/gateway-launch-tokens'

const TOKEN = 'tok_0123456789abcdefghijklmnopqrstuvwxyz'

// The script `wsl.exe` hands to bash, decoded: what the distribution runs.
function decodedScript(args: readonly string[]): string {
  const encoded = /echo (\S+)\|base64 -d/u.exec(args.at(-1) ?? '')?.[1] ?? ''
  return Buffer.from(encoded, 'base64').toString('utf8')
}

// Everything after `--exec`, run by this machine's bash as the distribution would.
function runInsideBash(args: string[], home: string, extraEnv: Record<string, string> = {}, input = '') {
  const exec = args.indexOf('--exec')
  const [file, ...rest] = args.slice(exec + 1)
  return spawnSync(file, rest, {
    input,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...extraEnv },
  })
}

describe('cliHostSpawn', () => {
  it('starts a CLI on this machine as it is, in the workspace folder', () => {
    const plan = cliHostSpawn(
      { command: '/usr/local/bin/codex', args: ['app-server'], cwd: '/Users/dev/repo', env: { PATH: '/usr/bin' } },
      { platform: 'darwin' },
    )
    expect(plan.file).toBe('/usr/local/bin/codex')
    expect(plan.args).toEqual(['app-server'])
    expect(plan.options).toMatchObject({ cwd: '/Users/dev/repo', env: { PATH: '/usr/bin' }, windowsHide: true })
    expect(plan.options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
  })

  it("starts a Windows shim through the command processor, as this machine's CLIs always have", () => {
    const plan = cliHostSpawn(
      {
        command: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\opencode.cmd',
        args: ['acp'],
        cwd: 'C:\\Users\\dev\\repo',
        env: { ComSpec: 'cmd.exe' },
      },
      { platform: 'win32' },
    )
    expect(plan.file).toBe('cmd.exe')
    expect(plan.options).toMatchObject({ cwd: 'C:\\Users\\dev\\repo', windowsVerbatimArguments: true })
  })

  it("lists a distribution's folder as safe for the agent's git when the chat runs on This PC there", () => {
    const plan = cliHostSpawn(
      {
        command: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.exe',
        args: ['app-server'],
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app',
        // The person's own entry keeps its place; the folder's follow it.
        env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' },
      },
      { platform: 'win32' },
    )
    const env = plan.options.env as NodeJS.ProcessEnv
    expect(env.GIT_CONFIG_COUNT).toBe('5')
    expect([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0]).toEqual(['core.autocrlf', 'false'])
    expect([1, 2, 3, 4].map((n) => [env[`GIT_CONFIG_KEY_${n}`], env[`GIT_CONFIG_VALUE_${n}`]])).toEqual([
      ['safe.directory', '%(prefix)///wsl.localhost/Ubuntu/home/dev/app'],
      ['safe.directory', '%(prefix)///wsl.localhost/Ubuntu/home/dev'],
      ['safe.directory', '%(prefix)///wsl.localhost/Ubuntu/home'],
      ['safe.directory', '%(prefix)///wsl.localhost/Ubuntu'],
    ])
    // A folder on a drive, or a chat in the distribution itself, gets none.
    const onDrive = cliHostSpawn(
      { command: 'codex.exe', args: [], cwd: 'C:\\Users\\dev\\app', env: {} },
      { platform: 'win32' },
    )
    expect((onDrive.options.env as NodeJS.ProcessEnv).GIT_CONFIG_COUNT).toBeUndefined()
  })

  it('starts a CLI on a WSL machine inside the distribution, in the folder as Linux names it', () => {
    const env = { PATH: 'C:\\Windows', SPRINTENGINE_AGENT_ID: 'agent-1', APPDATA: 'C:\\Users\\dev\\AppData' }
    const plan = cliHostSpawn(
      {
        command: '/home/dev/.local/bin/codex',
        args: ['app-server', '--listen', 'stdio://'],
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
        env,
        wsl: {
          distro: 'Ubuntu',
          agentStateSocketPath: '/run/user/1000/agent.sock',
          forwardEnv: ['SPRINTENGINE_AGENT_ID'],
          unsetEnv: ['OPENAI_API_KEY'],
        },
      },
      { platform: 'win32', homedir: () => 'C:\\Users\\dev' },
    )
    expect(plan.file).toBe('wsl.exe')
    expect(plan.args.slice(0, 7)).toEqual(['-d', 'Ubuntu', '--cd', '~', '--exec', 'bash', '-c'])
    // `wsl.exe` starts in a folder every Windows process can open; the CLI
    // starts in the workspace.
    expect(plan.options.cwd).toBe('C:\\Users\\dev')
    expect(plan.options.env).toBe(env)
    const script = decodedScript(plan.args)
    expect(script).toContain('/home/dev/repo')
    expect(script).not.toContain('wsl.localhost')
    expect(script).toContain('/home/dev/.local/bin/codex')
    expect(script).toContain('SPRINTENGINE_AGENT_ID=agent-1')
    expect(script).toContain('SPRINTENGINE_AGENT_STATE_SOCKET=/run/user/1000/agent.sock')
    expect(script).toContain('OPENAI_API_KEY')
    // Nothing of this PC's environment goes in unless it is named.
    expect(script).not.toContain('APPDATA')
    expect(script).not.toContain('C:\\Windows')
  })

  it('names a folder on a Windows drive through its mount, and no folder as the Linux home', () => {
    const wsl = { distro: 'Ubuntu', agentStateSocketPath: null, forwardEnv: [] }
    const onDrive = cliHostSpawn({ command: 'grok', args: [], cwd: 'C:\\Users\\dev\\repo', env: {}, wsl })
    expect(decodedScript(onDrive.args)).toContain('/mnt/c/Users/dev/repo')
    const none = cliHostSpawn({ command: 'grok', args: [], cwd: '', env: {}, wsl })
    expect(decodedScript(none.args)).not.toContain('cd --')
  })
})

describe('wslCliLaunchArgs', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')(
    'sets only the named variables, and removes the auth the profile exports before the CLI starts',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'cli-host-child-'))
      dirs.push(home)
      writeFileSync(join(home, '.bash_profile'), 'export OPENAI_API_KEY=from-profile\nexport KEEP=profile\n')
      const fake = join(home, 'cli')
      writeFileSync(
        fake,
        '#!/bin/sh\nprintf "key=%s\\n" "${OPENAI_API_KEY:-unset}"\nprintf "keep=%s\\n" "$KEEP"\nprintf "id=%s\\n" "$SPRINTENGINE_AGENT_ID"\nprintf "win=%s\\n" "${APPDATA:-unset}"\n',
      )
      chmodSync(fake, 0o755)
      const args = wslCliLaunchArgs({
        distro: 'Ubuntu',
        cwd: home,
        command: fake,
        args: [],
        env: { SPRINTENGINE_AGENT_ID: 'agent-1', APPDATA: 'C:\\Users\\dev\\AppData' },
        forwardEnv: ['SPRINTENGINE_AGENT_ID', 'APPDATA_UNUSED'],
        unsetEnv: ['OPENAI_API_KEY'],
      })
      const result = runInsideBash(args, home)
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(['key=unset', 'keep=profile', 'id=agent-1', 'win=unset', ''].join('\n'))
    },
  )
})

describe('a secret for a WSL child', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const wsl = {
    distro: 'Ubuntu',
    agentStateSocketPath: null,
    forwardEnv: ['SPRINTENGINE_AGENT_ID'],
    stdinEnv: ['SPRINTENGINE_MCP_CHANNEL_TOKEN'],
  }

  it('is written to stdin, and is in neither the command line nor the environment of wsl.exe', () => {
    const env = { SPRINTENGINE_AGENT_ID: 'agent-1', SPRINTENGINE_MCP_CHANNEL_TOKEN: TOKEN }
    const plan = cliHostSpawn(
      { command: '/home/dev/.local/bin/claude', args: [], cwd: '/home/dev/repo', env, wsl },
      { platform: 'win32', homedir: () => 'C:\\Users\\dev' },
    )
    expect(plan.stdin).toBe(`${TOKEN}\n`)
    expect(plan.args.join(' ')).not.toContain(TOKEN)
    const script = decodedScript(plan.args)
    expect(script).not.toContain(TOKEN)
    expect(script).toContain('read -r SPRINTENGINE_MCP_CHANNEL_TOKEN')
    expect(script).toContain('SPRINTENGINE_AGENT_ID=agent-1')
    expect(plan.options.env).toEqual({ SPRINTENGINE_AGENT_ID: 'agent-1' })
  })

  it("includes every value a chat's MCP servers name by reference, each read once", () => {
    const env = { SPRINTENGINE_MCP_CHANNEL_TOKEN: TOKEN, SPRINTENGINE_MCP_SECRET_1: 'sk-test-header' }
    const plan = cliHostSpawn(
      {
        command: 'codex',
        args: [],
        cwd: '',
        env,
        wsl: { ...wsl, stdinEnv: ['SPRINTENGINE_MCP_CHANNEL_TOKEN', 'SPRINTENGINE_MCP_SECRET_1'] },
      },
      { platform: 'win32', homedir: () => 'C:\\Users\\dev' },
    )
    expect(plan.stdin).toBe(`${TOKEN}\nsk-test-header\n`)
    const script = decodedScript(plan.args)
    expect(script).not.toContain('sk-test-header')
    expect(script.match(/read -r SPRINTENGINE_MCP_SECRET_1/gu)).toHaveLength(1)
    expect(plan.options.env).toEqual({})
    // Named by nobody: still a secret, still on stdin.
    const unnamed = cliHostSpawn(
      { command: 'claude', args: [], cwd: '', env: { SPRINTENGINE_MCP_SECRET_1: 'sk-test-header' }, wsl },
      { platform: 'win32', homedir: () => 'C:\\Users\\dev' },
    )
    expect(unnamed.stdin).toBe('sk-test-header\n')
    expect(unnamed.args.join(' ')).not.toContain('sk-test-header')
  })

  it('is not read at all when it has no value, and is refused when it spans lines', () => {
    const none = cliHostSpawn({ command: 'claude', args: [], cwd: '', env: {}, wsl })
    expect(none.stdin).toBeUndefined()
    expect(decodedScript(none.args)).not.toContain('read -r')
    expect(() =>
      cliHostSpawn({ command: 'claude', args: [], cwd: '', env: { SPRINTENGINE_MCP_CHANNEL_TOKEN: 'a\nb' }, wsl }),
    ).toThrow(/more than one line/u)
    expect(() =>
      wslCliLaunchArgs({ ...wsl, cwd: '~', command: 'claude', args: [], env: {}, stdinEnv: ['A;B'] }),
    ).toThrow(/not a variable name/u)
  })

  it.skipIf(process.platform === 'win32')(
    'reaches the CLI through a profile that reads stdin, and leaves the rest of stdin to the CLI',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'cli-host-secret-'))
      dirs.push(home)
      writeFileSync(join(home, '.bash_profile'), 'echo hello from profile\nread -t 1 _ || true\n')
      const fake = join(home, 'cli')
      writeFileSync(fake, '#!/bin/sh\nprintf "token=%s\\n" "$SPRINTENGINE_MCP_CHANNEL_TOKEN"\ncat\n')
      chmodSync(fake, 0o755)
      const plan = cliHostSpawn({
        command: fake,
        args: [],
        cwd: '',
        env: { SPRINTENGINE_MCP_CHANNEL_TOKEN: TOKEN },
        wsl: { ...wsl, forwardEnv: [] },
      })
      const result = runInsideBash(plan.args, home, {}, `${plan.stdin}{"jsonrpc":"2.0"}\n`)
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(`token=${TOKEN}\n{"jsonrpc":"2.0"}\n`)
      // A relay that turned the line ending into CRLF does not change the value.
      const crlf = runInsideBash(plan.args, home, {}, `${TOKEN}\r\n{"jsonrpc":"2.0"}\n`)
      expect(crlf.status).toBe(0)
      expect(crlf.stdout).toBe(`token=${TOKEN}\n{"jsonrpc":"2.0"}\n`)
    },
  )
})

describe('spawnCliHostChild', () => {
  type Call = { file: string; args: string[]; options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } }
  function fakeSpawn(calls: Call[], started = true) {
    const children: Array<EventEmitter & { stdin: PassThrough; pid?: number }> = []
    const stand = ((file: string, args: string[], options: Call['options']) => {
      calls.push({ file, args, options })
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        pid: started ? 7 : undefined,
      })
      children.push(child)
      return child
    }) as unknown as typeof spawn
    return { spawn: stand, children }
  }
  function issuer() {
    const issued: string[] = []
    const revoked: string[] = []
    return {
      issued,
      revoked,
      issueChannelToken: () => {
        const token = `${TOKEN}${issued.length}`
        issued.push(token)
        return { token, revoke: () => revoked.push(token) }
      },
    }
  }

  it('issues a WSL child its own token on stdin, and takes it back once when the child ends', () => {
    const calls: Call[] = []
    const { spawn, children } = fakeSpawn(calls)
    const tokens = issuer()
    const signal = new AbortController().signal
    const child = spawnCliHostChild(
      {
        command: '/home/dev/.local/bin/codex',
        args: ['app-server'],
        cwd: '',
        env: { SPRINTENGINE_AGENT_ID: 'agent-1' },
        wsl: {
          distro: 'Ubuntu',
          agentStateSocketPath: null,
          forwardEnv: [],
          issueChannelToken: tokens.issueChannelToken,
        },
      },
      { spawn, signal, platform: 'win32', homedir: () => 'C:\\Users\\dev' },
    )
    expect(tokens.issued).toHaveLength(1)
    const [token] = tokens.issued
    expect(calls[0].file).toBe('wsl.exe')
    expect(calls[0].args.join(' ')).not.toContain(token)
    expect(decodedScript(calls[0].args)).not.toContain(token)
    expect(calls[0].options.env?.SPRINTENGINE_MCP_CHANNEL_TOKEN).toBeUndefined()
    expect(calls[0].options.signal).toBe(signal)
    expect(children[0].stdin.read()?.toString()).toBe(`${token}\n`)
    child.emit('error', new Error('kill failed'))
    expect(tokens.revoked).toEqual([])
    child.emit('close', 0, null)
    child.emit('close', 0, null)
    expect(tokens.revoked).toEqual([token])
  })

  it('takes the token back when the child never started', () => {
    const tokens = issuer()
    const wsl = {
      distro: 'Ubuntu',
      agentStateSocketPath: null,
      forwardEnv: [],
      issueChannelToken: tokens.issueChannelToken,
    }
    const input = { command: 'codex', args: [], cwd: '', env: {}, wsl }
    const notStarted = fakeSpawn([], false)
    spawnCliHostChild(input, { spawn: notStarted.spawn }).emit('error', new Error('ENOENT'))
    const throwing = (() => {
      throw new Error('EACCES')
    }) as unknown as typeof spawn
    expect(() => spawnCliHostChild(input, { spawn: throwing })).toThrow('EACCES')
    expect(tokens.revoked).toEqual(tokens.issued)
    expect(tokens.issued).toHaveLength(2)
  })

  it('takes the token back when the start is refused before anything is spawned', () => {
    const tokens = issuer()
    const calls: Call[] = []
    const { spawn } = fakeSpawn(calls)
    const wsl = {
      distro: 'Ubuntu',
      agentStateSocketPath: null,
      forwardEnv: [],
      issueChannelToken: tokens.issueChannelToken,
    }
    // A secret named by something that is not a variable name.
    expect(() =>
      spawnCliHostChild(
        { command: 'codex', args: [], cwd: '', env: { 'A;B': 'x' }, wsl: { ...wsl, stdinEnv: ['A;B'] } },
        { spawn },
      ),
    ).toThrow(/not a variable name/u)
    // A token that cannot travel as one line.
    const multiline = {
      ...wsl,
      issueChannelToken: () => {
        const channel = tokens.issueChannelToken()
        return { ...channel, token: `${channel.token}\nmore` }
      },
    }
    expect(() =>
      spawnCliHostChild({ command: 'codex', args: [], cwd: '', env: {}, wsl: multiline }, { spawn }),
    ).toThrow(/more than one line/u)
    expect(calls).toHaveLength(0)
    expect(tokens.issued).toHaveLength(2)
    expect(tokens.revoked).toEqual(tokens.issued)
  })

  it('issues nothing to a child on this machine, or to one whose machine has no token to give', () => {
    const calls: Call[] = []
    const { spawn, children } = fakeSpawn(calls)
    spawnCliHostChild({ command: '/usr/local/bin/codex', args: [], cwd: '/Users/dev/repo', env: {} }, { spawn })
    spawnCliHostChild(
      {
        command: 'codex',
        args: [],
        cwd: '',
        env: {},
        wsl: { distro: 'Ubuntu', agentStateSocketPath: null, forwardEnv: [], issueChannelToken: () => null },
      },
      { spawn },
    )
    expect(children.map((child) => child.stdin.read())).toEqual([null, null])
    expect(decodedScript(calls[1].args)).not.toContain('read -r')
  })
})

describe('prepareWslCliTarget', () => {
  afterEach(() => installHostRegistry(null))

  it("hands out the machine's own channel tokens, and takes them back through it", async () => {
    const revoked: string[] = []
    const host = {
      prepare: async () => undefined,
      agentIntegration: () => ({ agentStateSocketPath: '/run/user/1000/agent.sock' }),
      issueChannelToken: () => TOKEN,
      revokeChannelToken: (token: string) => revoked.push(token),
    }
    installHostRegistry({ get: () => host } as unknown as HostRegistry)
    const target = await prepareWslCliTarget('wsl:Ubuntu')
    expect(target).toMatchObject({ distro: 'Ubuntu', agentStateSocketPath: '/run/user/1000/agent.sock' })
    const channel = target.issueChannelToken?.()
    expect(channel?.token).toBe(TOKEN)
    channel?.revoke()
    expect(revoked).toEqual([TOKEN])

    installHostRegistry({ get: () => ({ ...host, issueChannelToken: undefined }) } as unknown as HostRegistry)
    expect((await prepareWslCliTarget('wsl:Ubuntu')).issueChannelToken?.()).toBeNull()
  })
})

describe('wslTargetForHost', () => {
  it('readies a WSL machine and leaves this one alone', async () => {
    const prepared: string[] = []
    const prepare = async (hostId: string) => {
      prepared.push(hostId)
      return { distro: 'Ubuntu', agentStateSocketPath: null }
    }
    expect(await wslTargetForHost('local', prepare)).toBeNull()
    expect(await wslTargetForHost(undefined, prepare)).toBeNull()
    expect(await wslTargetForHost('wsl:Ubuntu', prepare)).toEqual({ distro: 'Ubuntu', agentStateSocketPath: null })
    expect(prepared).toEqual(['wsl:Ubuntu'])
  })
})

describe('mcpServersOnWsl', () => {
  it("translates a stdio server's Windows paths and leaves everything else as written", () => {
    expect(
      mcpServersOnWsl([
        {
          id: 'files',
          name: 'Files',
          transport: 'stdio',
          command: 'C:\\tools\\node.exe',
          args: ['C:\\tools\\server.js', '--root', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo', '--verbose'],
          env: { TOKEN_FILE: 'C:\\secrets\\token' },
        },
        { id: 'npx', name: 'Npx', transport: 'stdio', command: 'npx', args: ['-y', 'server'] },
        { id: 'web', name: 'Web', transport: 'http', url: 'http://127.0.0.1:4000/mcp' },
      ]),
    ).toEqual([
      {
        id: 'files',
        name: 'Files',
        transport: 'stdio',
        command: '/mnt/c/tools/node.exe',
        args: ['/mnt/c/tools/server.js', '--root', '/home/dev/repo', '--verbose'],
        env: { TOKEN_FILE: 'C:\\secrets\\token' },
      },
      { id: 'npx', name: 'Npx', transport: 'stdio', command: 'npx', args: ['-y', 'server'] },
      { id: 'web', name: 'Web', transport: 'http', url: 'http://127.0.0.1:4000/mcp' },
    ])
  })
})

describe('launch tokens for chat children', () => {
  function spawnRecorder() {
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = []
    const children: EventEmitter[] = []
    const stand = ((_file: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      calls.push(options)
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        pid: 9,
      })
      children.push(child)
      return child
    }) as unknown as typeof spawn
    return { spawn: stand, calls, children }
  }
  const identity = {
    SPRINTENGINE_WORKSPACE_ID: 'ws-1',
    SPRINTENGINE_AGENT_ID: 'chat-1',
    SPRINTENGINE_AGENT_CLI: 'codex',
  }

  it('gives a conversation’s child on this machine a token bound to that conversation, until it ends', () => {
    const recorder = spawnRecorder()
    spawnCliHostChild({ command: 'codex', args: [], cwd: '/Users/dev/app', env: identity }, { spawn: recorder.spawn })
    const token = recorder.calls[0].env?.SPRINTENGINE_MCP_CHANNEL_TOKEN ?? ''
    expect(token).toMatch(/^selaunch_/)
    expect(resolveGatewayLaunchToken(token)).toEqual({ workspaceId: 'ws-1', agentId: 'chat-1', cliId: 'codex' })
    recorder.children[0].emit('close', 0)
    expect(resolveGatewayLaunchToken(token)).toBeNull()
  })

  it('hands a child that is no conversation’s no token, not even one the app inherited', () => {
    const recorder = spawnRecorder()
    spawnCliHostChild(
      { command: 'codex', args: [], cwd: '/Users/dev/app', env: { SPRINTENGINE_MCP_CHANNEL_TOKEN: TOKEN } },
      { spawn: recorder.spawn },
    )
    expect(recorder.calls[0].env?.SPRINTENGINE_MCP_CHANNEL_TOKEN).toBeUndefined()
  })

  it('binds a WSL child’s channel token to its conversation', () => {
    const recorder = spawnRecorder()
    const named: unknown[] = []
    spawnCliHostChild(
      {
        command: 'codex',
        args: [],
        cwd: '',
        env: identity,
        wsl: {
          distro: 'Ubuntu',
          agentStateSocketPath: null,
          forwardEnv: [],
          issueChannelToken: (bound) => {
            named.push(bound)
            return { token: TOKEN, revoke: () => undefined }
          },
        },
      },
      { spawn: recorder.spawn, platform: 'win32', homedir: () => 'C:\\Users\\dev' },
    )
    expect(named).toEqual([{ workspaceId: 'ws-1', agentId: 'chat-1', cliId: 'codex' }])
  })

  it('hands a child the token its runtime issued for it in place of one of its own, and takes it back', () => {
    const recorder = spawnRecorder()
    const revoked: string[] = []
    // The environment names no conversation (an ACP agent's): the runtime issued the token itself.
    spawnCliHostChild(
      {
        command: 'agent',
        args: ['acp'],
        cwd: '/Users/dev/app',
        env: {},
        launch: { token: TOKEN, revoke: () => revoked.push(TOKEN) },
      },
      { spawn: recorder.spawn },
    )
    expect(recorder.calls[0].env?.SPRINTENGINE_MCP_CHANNEL_TOKEN).toBe(TOKEN)
    recorder.children[0].emit('close', 0)
    expect(revoked).toEqual([TOKEN])

    // A child that cannot be started gives it back at once.
    const failed: string[] = []
    expect(() =>
      spawnCliHostChild(
        {
          command: 'agent',
          args: [],
          cwd: '/Users/dev/app',
          env: {},
          launch: { token: TOKEN, revoke: () => failed.push(TOKEN) },
        },
        {
          spawn: (() => {
            throw new Error('spawn agent ENOENT')
          }) as unknown as typeof spawn,
        },
      ),
    ).toThrow('ENOENT')
    expect(failed).toEqual([TOKEN])

    // Null from the runtime is no token, not one of the child's own.
    spawnCliHostChild(
      { command: 'codex', args: [], cwd: '/Users/dev/app', env: identity, launch: null },
      { spawn: recorder.spawn },
    )
    expect(recorder.calls[1].env?.SPRINTENGINE_MCP_CHANNEL_TOKEN).toBeUndefined()
  })
})
