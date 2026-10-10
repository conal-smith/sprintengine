// An agent CLI's stdio child on the machine its runtime names: this one, or a
// WSL distribution.
//
// Every chat runtime that drives a CLI over stdio (Claude Code through the
// SDK, Codex's app-server, the ACP agents) starts it here, so a chat on a WSL
// machine runs that machine's CLI the same way whichever CLI it is. On this
// machine the child is started directly, through its shim on Windows
// (`cliSpawnTarget`). On a WSL machine it becomes one `wsl.exe` whose stdio is
// the child's, and what runs inside is the person's own login shell
// (`bash -lic`, as a WSL terminal's startup does): the CLI sees exactly what
// the one in their terminal sees, their PATH, the login and settings under
// their Linux home, and whatever their profile exports (proxies, CA bundles,
// a gateway). Nothing of this PC's environment is carried in except the
// variables the runtime names, because a Windows PATH, `APPDATA` or a
// Windows-side setting would only mislead a Linux CLI.
//
// Two things keep the stream clean. A profile that prints (a greeting, a
// version manager's notice) would write into the protocol on stdout, so the
// shell's stdout and stdin are parked on spare descriptors while the profile
// runs and handed back only to the CLI. They are 57 and 58 because an
// interactive login bash closes 3 through 19 as it starts. And the script
// travels base64-encoded in a single argument: `wsl.exe` re-reads its command
// line, and a quote or a `%` inside an argument is not guaranteed to survive
// that.
//
// That argument is a command line, which any process on this PC can read for
// as long as the child runs. A secret never goes there: the script reads it
// from the first lines of its stdin, before the profile runs, and exports it
// (`stdinEnv`). The one secret today is the MCP channel token a WSL terminal's
// startup script exports for the same reason: the app's MCP bridge in the
// distribution opens its channel with it, and the CLI's own children inherit
// it from the CLI.
//
// Every child that is a conversation's agent is issued that token, on this
// machine as in a distribution: it is the launch's gateway token, bound to the
// conversation, and the gateway takes the agent's identity from it rather
// than from what its bridge declares.

import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithStdioTuple,
  type StdioPipe,
} from 'node:child_process'
import { homedir } from 'node:os'

import { distroOfHostId, isWslHostId, type ExecutionHostId } from '../../shared/execution-host'
import { isWindowsPath, toWslPath } from '../../shared/host-paths'
import type { ConversationMcpServer } from '../../shared/conversation-runtime'
import { MCP_CHANNEL_TOKEN_ENV } from '../../shared/studio-env'
import {
  issueGatewayLaunchToken,
  launchIdentityOfEnv,
  revokeGatewayLaunchToken,
  type GatewayLaunchIdentity,
} from '../../server/core/gateway-launch-tokens'
import { RAISE_OOM_SCORE_SHELL_LINE, raiseChildOomScore } from '../agent-oom-score'
import { argvToPosixShellCommand } from '../agent-launch-render'
import { wslDistroArgs } from '../hosts/wsl-distro'
import { cliSpawnTarget } from './cli-child-process'
import { wslShareSafeDirectoryEnv } from '../git-run'

/**
 * The variables that say which chat a child belongs to, carried into a
 * distribution for every runtime. The agent-state socket is not among them:
 * this PC's socket path means nothing in Linux, and the distribution's own
 * comes from its helper (`WslCliTarget.agentStateSocketPath`).
 */
export const CONVERSATION_IDENTITY_ENV_KEYS = [
  'SPRINTENGINE_WORKSPACE_ID',
  'SPRINTENGINE_AGENT_ID',
  'SPRINTENGINE_AGENT_NAME',
  'SPRINTENGINE_AGENT_CLI',
  'SPRINTENGINE_CONVERSATION_SESSION_ID',
] as const

/** A token one child's MCP bridge opens its channel to the app with, and how it is taken back. */
export type WslChannelToken = { token: string; revoke(): void }

/** Where a WSL chat's child runs, resolved once per spawn. */
export type WslCliTarget = {
  distro: string
  /** The helper's agent-state socket there, for the hooks a chat's CLI runs; null when unknown. */
  agentStateSocketPath: string | null
  /**
   * Issues the MCP channel token for one child (`MCP_CHANNEL_TOKEN_ENV`), as a
   * WSL terminal launch is issued one: without it the app's MCP bridge there
   * is refused. Bound to the child's conversation when it has one, so the
   * gateway knows which agent it is. Absent or null: the child gets none.
   */
  issueChannelToken?: (identity?: GatewayLaunchIdentity | null) => WslChannelToken | null
}

/** A WSL target with what a runtime carries into it of the child's environment. */
export type WslCliChild = WslCliTarget & {
  /** The names whose values in `env` are set inside the distribution; nothing else goes in. */
  forwardEnv: readonly string[]
  /**
   * Variables removed from the login shell's environment before the CLI
   * starts: auth a runtime keeps its child off (an API key the profile
   * exports would take the chat off the person's login, as it would here).
   */
  unsetEnv?: readonly string[]
  /**
   * Names whose values in `env` are secrets: they reach the distribution on
   * the first lines of the child's stdin, never in its command line.
   */
  stdinEnv?: readonly string[]
}

/**
 * The `wsl.exe` argv that runs `command args` in `cwd` (as Linux names it)
 * inside `distro`, through the person's login shell.
 */
export function wslCliLaunchArgs(input: {
  distro: string
  cwd: string
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  forwardEnv: readonly string[]
  unsetEnv?: readonly string[]
  /** Read, in this order, one line each from stdin before anything else runs, and exported. */
  stdinEnv?: readonly string[]
  agentStateSocketPath?: string | null
}): string[] {
  const reads = (input.stdinEnv ?? []).map((key) => {
    if (!ENV_NAME.test(key)) throw new Error(`"${key}" is not a variable name.`)
    // A carriage return the stdin relay may add before the newline is not
    // part of the value.
    return `read -r ${key} || exit 1\n${key}=\${${key}%$'\\r'}\nexport ${key}`
  })
  const assignments: string[] = []
  for (const key of input.forwardEnv) {
    const value = input.env[key]
    if (value !== undefined && value !== '') assignments.push(`${key}=${value}`)
  }
  if (input.agentStateSocketPath) assignments.push(`SPRINTENGINE_AGENT_STATE_SOCKET=${input.agentStateSocketPath}`)
  const unset = (input.unsetEnv ?? []).flatMap((key) => ['-u', key])
  // Runs after the profile: stdio back to the CLI, then the folder (a
  // profile may `cd`), then the CLI itself with the chat's variables.
  const inner = [
    'exec 1>&57 57>&- 0<&58 58<&-',
    input.cwd === '~' ? 'cd' : `cd -- ${argvToPosixShellCommand([input.cwd])} || exit 1`,
    `exec ${argvToPosixShellCommand(['env', ...unset, ...assignments, input.command, ...input.args])}`,
  ].join('\n')
  // The secrets first, while stdin is still the app's (bash reads a pipe a
  // byte at a time, so nothing past their lines is taken from the CLI). Then
  // stdout and stdin are parked while the login shell reads the profile;
  // anything it prints lands on stderr, which the providers only keep a tail
  // of. The exported values pass through the profile into the CLI.
  const outer = [
    ...reads,
    // The kernel's out-of-memory killer takes the agent before the app's
    // server in the distribution; the `exec`s below keep this pid, so the CLI
    // and everything it starts inherit the score (agent-oom-score.ts).
    RAISE_OOM_SCORE_SHELL_LINE,
    'exec 57>&1 1>&2 58<&0 0</dev/null',
    `exec ${argvToPosixShellCommand(['bash', '-lic', inner, 'bash'])}`,
  ].join('\n')
  const encoded = Buffer.from(outer, 'utf8').toString('base64')
  // `set -f` and an empty IFS make the decoded script one word, unglobbed, so
  // `eval` runs it exactly as written.
  return [
    ...wslDistroArgs(input.distro),
    '--cd',
    '~',
    '--exec',
    'bash',
    '-c',
    `set -f;IFS=;eval $(echo ${encoded}|base64 -d)`,
  ]
}

type PipedSpawnOptions = SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe> & {
  windowsVerbatimArguments?: boolean
}

// A POSIX variable name, the only thing `read` and `export` may be handed here.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u

/**
 * What `spawn` is called with for one CLI child. `stdin`, when present, is
 * written to the child before anything else: the secrets a WSL child reads.
 */
export type CliHostSpawn = { file: string; args: string[]; options: PipedSpawnOptions; stdin?: string }

/**
 * How to start a CLI as a stdio child on its machine. `command` is the path the
 * runtime's CLI detection found on that machine (a Linux path for WSL), and
 * `cwd` the workspace folder as this machine names it; a WSL child gets it as
 * the distribution names it (`/home/…`, `/mnt/c/…`).
 */
export function cliHostSpawn(
  input: {
    command: string
    args: readonly string[]
    cwd: string
    env: NodeJS.ProcessEnv
    wsl?: WslCliChild | null
  },
  deps: { platform?: NodeJS.Platform; homedir?: () => string } = {},
): CliHostSpawn {
  const base = {
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'] as [StdioPipe, StdioPipe, StdioPipe],
    windowsHide: true,
  }
  if (!input.wsl) {
    const target = cliSpawnTarget(input.command, [...input.args], {
      platform: deps.platform,
      env: input.env,
      cwd: input.cwd,
    })
    return {
      file: target.file,
      args: target.args,
      options: {
        ...base,
        // On This PC in a folder inside a WSL distribution, the agent's own
        // git needs the folder listed as safe, as the app's git has it.
        env: wslShareSafeDirectoryEnv(input.env, input.cwd, deps.platform),
        cwd: input.cwd,
        ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      },
    }
  }
  const secrets = (input.wsl.stdinEnv ?? []).flatMap((key) => {
    const value = input.env[key]
    if (value === undefined || value === '') return []
    if (/[\r\n]/u.test(value)) throw new Error(`${key} cannot be handed to WSL: it spans more than one line.`)
    return [[key, value] as const]
  })
  return {
    file: 'wsl.exe',
    args: wslCliLaunchArgs({
      distro: input.wsl.distro,
      cwd: input.cwd ? toWslPath(input.cwd) : '~',
      command: input.command,
      args: input.args,
      env: input.env,
      forwardEnv: input.wsl.forwardEnv,
      unsetEnv: input.wsl.unsetEnv,
      stdinEnv: secrets.map(([key]) => key),
      agentStateSocketPath: input.wsl.agentStateSocketPath,
    }),
    // `wsl.exe` itself needs nothing of the folder, and a `\\wsl.localhost`
    // path is not a directory every Windows process can start in. Nor does it
    // need the secrets in its own environment: they arrive on stdin.
    options: {
      ...base,
      ...(secrets.length > 0 ? { env: withoutKeys(input.env, input.wsl.stdinEnv ?? []) } : {}),
      cwd: (deps.homedir ?? homedir)(),
    },
    ...(secrets.length > 0 ? { stdin: secrets.map(([, value]) => `${value}\n`).join('') } : {}),
  }
}

function withoutKeys(env: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv {
  const next = { ...env }
  for (const key of keys) delete next[key]
  return next
}

/**
 * Starts a CLI as a stdio child on its machine (`cliHostSpawn`), the way every
 * chat runtime starts one. A child in WSL is issued its own MCP channel token
 * when its machine has one to give, handed to it on stdin and taken back when
 * the child ends, so the app's MCP gateway it starts there is accepted as a
 * WSL terminal agent's is.
 *
 * `launch` is a token the runtime issued for this child itself, because it
 * also hands the value to the gateway entry it tells the agent about (an ACP
 * agent, whose environment names no conversation). It is handed to the child
 * as an issued one would be, and taken back when the child ends or fails to
 * start; null hands it none.
 */
export function spawnCliHostChild(
  request: Parameters<typeof cliHostSpawn>[0] & { launch?: WslChannelToken | null },
  deps: Parameters<typeof cliHostSpawn>[1] & { spawn?: typeof spawn; signal?: AbortSignal } = {},
): ChildProcessWithoutNullStreams {
  const { launch, ...input } = request
  const identity = launchIdentityOfEnv(input.env)
  const channel =
    launch !== undefined
      ? launch
      : input.wsl
        ? (input.wsl.issueChannelToken?.(identity) ?? null)
        : localLaunchToken(identity)
  let revoked = false
  const revoke = () => {
    if (revoked || !channel) return
    revoked = true
    channel.revoke()
  }
  // Everything that can refuse the start is inside: a token issued to a child
  // that never ran is taken back at once, not left valid until the helper restarts.
  let plan: CliHostSpawn
  let child: ChildProcessWithoutNullStreams
  try {
    plan = cliHostSpawn(
      channel && input.wsl
        ? {
            ...input,
            env: { ...input.env, [MCP_CHANNEL_TOKEN_ENV]: channel.token },
            wsl: { ...input.wsl, stdinEnv: [...(input.wsl.stdinEnv ?? []), MCP_CHANNEL_TOKEN_ENV] },
          }
        : channel
          ? { ...input, env: { ...input.env, [MCP_CHANNEL_TOKEN_ENV]: channel.token } }
          : // A token the app's own process inherited is no launch's: never handed on.
            { ...input, env: withoutKeys(input.env, [MCP_CHANNEL_TOKEN_ENV]) },
      deps,
    )
    child = (deps.spawn ?? spawn)(plan.file, plan.args, {
      ...plan.options,
      ...(deps.signal ? { signal: deps.signal } : {}),
    })
  } catch (error) {
    revoke()
    throw error
  }
  if (channel) {
    child.once('close', revoke)
    // A child that could not be started is not certain to emit `close`.
    child.on('error', () => {
      if (child.pid === undefined) revoke()
    })
  }
  // On Linux (This PC, or the Studio server on a WSL or SSH machine) the
  // kernel's out-of-memory killer takes the agent before the app. A child in
  // WSL started from Windows is `wsl.exe`, whose launch line raises it there
  // (`wslCliLaunchArgs`). A stand-in spawn's pid names no process of ours.
  if (!input.wsl && (deps.spawn ?? spawn) === spawn) void raiseChildOomScore(child.pid)
  if (plan.stdin) child.stdin.write(plan.stdin)
  return child
}

/**
 * A gateway token for a child on this machine that is a conversation's agent,
 * handed to it in its environment and taken back when it ends. Null for a
 * child that is no conversation's.
 */
export function localLaunchToken(identity: GatewayLaunchIdentity | null): WslChannelToken | null {
  if (!identity) return null
  const token = issueGatewayLaunchToken(identity)
  return { token, revoke: () => revokeGatewayLaunchToken(token) }
}

/**
 * Gets a WSL machine ready for a chat: the helper started (so a broken
 * distribution fails here, with the reason) and its agent-state socket known.
 */
export async function prepareWslCliTarget(hostId: ExecutionHostId): Promise<WslCliTarget> {
  const distro = distroOfHostId(hostId)
  if (!distro) throw new Error(`"${hostId}" is not a WSL machine.`)
  const { hostRegistry } = await import('../hosts/host-registry')
  const host = hostRegistry().get(hostId)
  await host.prepare()
  return {
    distro,
    agentStateSocketPath: host.agentIntegration()?.agentStateSocketPath ?? null,
    issueChannelToken: (identity) => {
      const token = host.issueChannelToken?.(identity ?? null)
      return token ? { token, revoke: () => host.revokeChannelToken?.(token) } : null
    },
  }
}

/**
 * The WSL target for a runtime's host id, or null when it runs on this
 * machine. `prepare` stands in for the host registry in tests.
 */
export async function wslTargetForHost(
  hostId: string | null | undefined,
  prepare: (hostId: ExecutionHostId) => Promise<WslCliTarget> = prepareWslCliTarget,
): Promise<WslCliTarget | null> {
  return isWslHostId(hostId) ? prepare(hostId) : null
}

/** The machine a runtime's host id names, as an error message says it. */
export function hostMachineName(hostId: string): string {
  return hostId.replace(/^wsl:/u, 'WSL: ')
}

/**
 * A chat's MCP servers as a CLI in WSL is handed them. Their entries were
 * built on this PC, so a stdio server's `command` and `args` may name `C:\…`
 * or `\\wsl.localhost\…` paths, which a Linux process cannot open; each such
 * path becomes the path in the distribution. Anything else (a bare `npx`, a
 * flag, a URL) is left exactly as written.
 */
export function mcpServersOnWsl(servers: readonly ConversationMcpServer[]): ConversationMcpServer[] {
  return servers.map((server) =>
    server.transport === 'stdio'
      ? {
          ...server,
          ...(server.command ? { command: wslArg(server.command) } : {}),
          ...(server.args ? { args: server.args.map(wslArg) } : {}),
        }
      : server,
  )
}

/** One argument as a Linux process in WSL needs it: a Windows path translated, anything else as it is. */
export function wslArg(value: string): string {
  return isWindowsPath(value) ? toWslPath(value) : value
}
