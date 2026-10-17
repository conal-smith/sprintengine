import { homedir } from 'node:os'
import type { ConversationCliRuntimeOverrides, ConversationProviderSignInResult } from '../shared/conversation-runtime'
import { cliForConversationProvider, conversationSignIn } from '../shared/conversation-harness'
import { isWslHostId, type ExecutionHostId } from '../shared/execution-host'
import { argvToPosixShellCommand } from './agent-launch-render'
import { detectCli } from './cli-runtime-install'

/**
 * The line a plain Studio terminal runs to sign a chat's CLI back in. It names
 * the executable the conversation provider resolves, not whatever `claude` the
 * shell finds first: on Windows a chat on This PC runs the native claude.exe,
 * whose login is not the one inside WSL, and a chat on a WSL machine runs the
 * `claude` in that distribution, whose login (a personal one, or the one an
 * organization manages) lives under its Linux home.
 */
export function signInCommandLine(executablePath: string, args: string[], platform: NodeJS.Platform): string {
  // A plain terminal on Windows opens PowerShell, which runs a quoted path
  // only through the call operator.
  if (platform === 'win32') return `& '${executablePath.replace(/'/g, "''")}' ${args.join(' ')}`
  return argvToPosixShellCommand([executablePath, ...args])
}

export async function resolveConversationSignIn(
  input: { providerId: string; cliRuntimes?: ConversationCliRuntimeOverrides },
  deps: {
    detect?: typeof detectCli
    platform?: NodeJS.Platform
    home?: () => string
    /** A WSL machine's home as this PC opens it; the host registry's answer by default. */
    wslHome?: (hostId: ExecutionHostId) => Promise<string | null>
  } = {},
): Promise<ConversationProviderSignInResult> {
  const cli = cliForConversationProvider(input.providerId)
  const signIn = conversationSignIn(cli)
  if (!cli || !signIn) return { ok: false, message: 'This provider has no sign-in to run.' }
  const args = [...signIn.args]
  const override = input.cliRuntimes?.[cli]
  const detection = await (deps.detect ?? detectCli)(cli, override)
  if (!detection.installed || !detection.resolvedPath) {
    return {
      ok: false,
      message: `${signIn.name} CLI is not installed. Install it (or set a command override in Settings) to sign in.`,
    }
  }
  // A chat on a WSL machine signs in there: a terminal on that machine, in
  // its home, running the CLI the chat runs.
  if (isWslHostId(override?.hostId)) {
    const hostId = override.hostId
    const home = await (deps.wslHome ?? defaultWslHome)(hostId)
    if (!home) return { ok: false, message: `Couldn't reach ${hostId.replace(/^wsl:/u, 'WSL: ')} to sign in there.` }
    return {
      ok: true,
      commandLine: signInCommandLine(detection.resolvedPath, args, 'linux'),
      cwd: home,
      platform: 'linux',
      hostId,
    }
  }
  const platform = deps.platform ?? process.platform
  return {
    ok: true,
    commandLine: signInCommandLine(detection.resolvedPath, args, platform),
    // Signing in does not depend on the folder; home is a folder every host
    // opens this machine's own shell in, where a workspace on a WSL path would
    // open the distribution's shell instead.
    cwd: (deps.home ?? homedir)(),
    platform,
  }
}

async function defaultWslHome(hostId: ExecutionHostId): Promise<string | null> {
  const { hostRegistry } = await import('./hosts/host-registry')
  const home = await hostRegistry().get(hostId).homeDir()
  return home?.native ?? null
}
