// A Claude chat on a WSL machine: its `claude` runs inside the distribution.
//
// The SDK builds the command line (`claude --output-format stream-json …`)
// and hands it to `spawnClaudeCodeProcess`; for a WSL chat that becomes one
// `wsl.exe` whose stdio is the child's, started the way every chat runtime
// starts its CLI in WSL (cli-host-child.ts). What this adds is which of the
// SDK's variables go in with it.

import type { spawn, ChildProcess } from 'node:child_process'

import type { ExecutionHostId } from '../../shared/execution-host'
import {
  CONVERSATION_IDENTITY_ENV_KEYS,
  prepareWslCliTarget,
  spawnCliHostChild,
  wslCliLaunchArgs,
  type WslCliTarget,
} from './cli-host-child'

/**
 * The variables of the SDK's environment that go into the distribution: the
 * SDK's own marks, the switch that turns on Claude Code's task tools (which
 * the provider sets for every chat), and the chat's identity. Everything else
 * is this PC's (a Windows PATH, `APPDATA`, a Windows-side Claude setting) and
 * would only mislead a Linux `claude`.
 */
export const WSL_FORWARDED_ENV_KEYS = [
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_AGENT_SDK_CLIENT_APP',
  'CLAUDE_CODE_ENABLE_TODO_TOOLS',
  ...CONVERSATION_IDENTITY_ENV_KEYS,
] as const

/** Where a WSL chat's child runs, resolved once per spawn. */
export type WslClaudeTarget = WslCliTarget

/**
 * The `wsl.exe` argv that runs `command args` in `cwd` (as Linux names it)
 * inside `distro`, through the person's login shell.
 */
export function wslClaudeLaunchArgs(input: {
  distro: string
  cwd: string
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  agentStateSocketPath?: string | null
}): string[] {
  return wslCliLaunchArgs({ ...input, forwardEnv: WSL_FORWARDED_ENV_KEYS })
}

/** What the SDK asks the provider to spawn, in the fields this module reads. */
export type ClaudeSpawnRequest = {
  command: string
  args: string[]
  cwd?: string
  env: Record<string, string | undefined>
  signal?: AbortSignal
}

/**
 * Spawns the SDK's request inside the distribution. `request.command` is
 * already the Linux path of `claude` (the WSL host's CLI detection found it
 * there) and `request.cwd` the native workspace folder. The child is issued
 * its own MCP channel token, which the app's gateway (handed to it in the
 * SDK's `mcpServers`) inherits from it and opens its channel with.
 */
export function spawnWslClaude(
  target: WslClaudeTarget,
  request: ClaudeSpawnRequest,
  deps: { spawn?: typeof spawn } = {},
): ChildProcess {
  return spawnCliHostChild(
    {
      command: request.command,
      args: request.args,
      cwd: request.cwd ?? '',
      env: request.env as NodeJS.ProcessEnv,
      wsl: { ...target, forwardEnv: WSL_FORWARDED_ENV_KEYS },
    },
    { ...deps, ...(request.signal ? { signal: request.signal } : {}) },
  )
}

/**
 * Gets a WSL machine ready for a chat: the helper started (so a broken
 * distribution fails here, with the reason) and its agent-state socket known.
 */
export function prepareWslClaudeTarget(hostId: ExecutionHostId): Promise<WslClaudeTarget> {
  return prepareWslCliTarget(hostId)
}
