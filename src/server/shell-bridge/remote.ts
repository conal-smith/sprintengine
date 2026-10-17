import type { AgentLaunchResult } from '../../shared/agent-launch'
import { ControlRpcError, type ControlRpc } from '../bootstrap/control-rpc'
import { SHELL_BRIDGE_EVENTS, SHELL_BRIDGE_METHODS, type ShellBridge } from './shell-bridge'

// The server's `ShellBridge` when the shell is another process: each member is
// a request on the control channel, which the shell serves with its own
// in-process bridge (src/main/server-supervisor/serve-shell-bridge.ts).
//
// A shell that is not there (the channel closed, or it never answered) is a
// failure of that call and nothing more: a seal rejects, a launch answers
// `shell_unavailable`, a reveal answers false, a notice is dropped, a picture
// stays the size it was sent. Nothing here retries; the caller already has a
// rule for each of those.

/** How long a seal or an open may take: a keychain prompt on a locked Mac is answered by a person. */
const CIPHER_TIMEOUT_MS = 120_000
/**
 * A terminal launch may cut a worktree before it spawns, with no budget of its
 * own in the shell: the same deadline as the shell's `agent.launch` tool, so a
 * slow checkout is not reported as a shell that stopped answering while the
 * agent it started comes up anyway.
 */
const LAUNCH_TIMEOUT_MS = 120_000
/** The launcher and plugin home are written at boot; past this, launches stop waiting for them. */
const INTEGRATIONS_TIMEOUT_MS = 120_000
/** A camera photo decodes and resizes in well under a second; past this the upload goes on unshrunk. */
const IMAGE_DOWNSCALE_TIMEOUT_MS = 20_000

export function createRemoteShellBridge(rpc: ControlRpc): ShellBridge {
  // One question, answered by the shell once its launcher and plugin home are
  // written (at once for a server that starts after that). Like the gate it
  // stands for, it never fails: a shell that cannot answer lets launches go
  // ahead, and each launch reports its own failure.
  let integrations: Promise<void> | null = null

  const bytes = async (method: string, input: Uint8Array): Promise<Uint8Array> => {
    const value = await rpc.call<unknown>(method, input, { timeoutMs: CIPHER_TIMEOUT_MS })
    if (!(value instanceof Uint8Array)) throw new Error(`${method} answered something other than bytes.`)
    return value
  }

  return {
    cipher: {
      available: () => rpc.call<boolean>(SHELL_BRIDGE_METHODS.cipherAvailable).catch(() => false),
      seal: (plain) => bytes(SHELL_BRIDGE_METHODS.cipherSeal, plain),
      open: (sealed) => bytes(SHELL_BRIDGE_METHODS.cipherOpen, sealed),
    },
    terminals: {
      launchAgent: (request) =>
        rpc
          .call<AgentLaunchResult>(SHELL_BRIDGE_METHODS.launchAgent, request, { timeoutMs: LAUNCH_TIMEOUT_MS })
          .catch((error: unknown): AgentLaunchResult => ({
            ok: false,
            code: 'shell_unavailable',
            message:
              error instanceof ControlRpcError && error.code !== 'failed'
                ? 'Studio’s window process is not answering, so no terminal agent can start right now.'
                : error instanceof Error
                  ? error.message
                  : String(error),
          })),
    },
    reveal: {
      tab: (target) => rpc.call<boolean>(SHELL_BRIDGE_METHODS.revealTab, target).catch(() => false),
    },
    notify(notice) {
      rpc.emit(SHELL_BRIDGE_EVENTS.notify, notice)
    },
    analytics(event) {
      rpc.emit(SHELL_BRIDGE_EVENTS.analytics, event)
    },
    images: {
      // A shell that cannot answer leaves the picture as it was sent; the
      // upload's own ceiling still decides whether it can be used.
      async downscale(input, mediaType) {
        const original = { bytes: input, mediaType }
        const value = await rpc
          .call<unknown>(
            SHELL_BRIDGE_METHODS.imageDownscale,
            { bytes: input, mediaType },
            {
              timeoutMs: IMAGE_DOWNSCALE_TIMEOUT_MS,
            },
          )
          .catch(() => null)
        const answer = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
        if (!(answer?.bytes instanceof Uint8Array) || typeof answer.mediaType !== 'string') return original
        return { bytes: answer.bytes, mediaType: answer.mediaType }
      },
    },
    integrationsReady() {
      integrations ??= rpc
        .call(SHELL_BRIDGE_METHODS.integrationsReady, undefined, { timeoutMs: INTEGRATIONS_TIMEOUT_MS })
        .then(
          () => undefined,
          () => undefined,
        )
      return integrations
    },
  }
}
