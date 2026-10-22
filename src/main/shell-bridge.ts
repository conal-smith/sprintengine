import type { SafeStorage } from 'electron'

import type { AgentLaunchRequest, AgentLaunchResult } from '../shared/agent-launch'
import type { Notifier } from '../server/platform/notifier'
import { safeStorageProtects } from './platform/safe-storage-protects'
import { downscaleConversationImage, type ImageCodec } from './conversation-image-downscale'
import {
  utf8Bytes,
  utf8Text,
  type ShellAnalyticsEvent,
  type ShellBridge,
  type ShellRevealTarget,
} from '../server/shell-bridge/shell-bridge'

// The shell's own `ShellBridge`: each member is the shell service that does
// the thing. The server's code calls this directly when it runs in main (the
// flag-off path), and the shell serves it over the control channel when the
// server runs in a process of its own (serve-shell-bridge.ts), so the two paths
// meet the same answers.
//
// Everything is handed in, so a test builds one over stand-ins and the
// contract suite runs the same cases against this and the remote one.

export type InProcessShellBridgeDeps = {
  safeStorage: Pick<SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'> &
    Partial<Pick<SafeStorage, 'getSelectedStorageBackend'>>
  /**
   * The shell's composed agent launch, bound once the terminal runtime exists.
   * Until then, and in a shell that has none, a launch answers that it cannot.
   */
  launchAgent: () => ((request: AgentLaunchRequest) => Promise<AgentLaunchResult>) | null
  /** Bring the target forward; false when no window could show it. */
  reveal: (target: ShellRevealTarget) => boolean
  /** The OS notification centre (the Electron platform's notifier). */
  notifier: Notifier
  analytics: (event: ShellAnalyticsEvent) => void
  /** The shell's integrations gate: the launcher and plugin home written. */
  integrationsReady: () => Promise<void>
  /** The image codec uploads are shrunk with (`nativeImage` in the app). */
  imageCodec: ImageCodec
}

export function createInProcessShellBridge(deps: InProcessShellBridgeDeps): ShellBridge {
  return {
    cipher: {
      available: async () => safeStorageProtects(deps.safeStorage),
      seal: async (plain) => new Uint8Array(deps.safeStorage.encryptString(utf8Text(plain))),
      open: async (sealed) => utf8Bytes(deps.safeStorage.decryptString(Buffer.from(sealed))),
    },
    terminals: {
      async launchAgent(request) {
        const launch = deps.launchAgent()
        if (!launch) {
          return {
            ok: false,
            code: 'shell_unavailable',
            message: 'Terminals are not ready yet, so no agent can start.',
          }
        }
        return launch(request)
      },
    },
    reveal: {
      tab: async (target) => deps.reveal(target),
    },
    notify(notice) {
      const target = notice.activate
      deps.notifier.notify({
        key: notice.key,
        title: notice.title,
        ...(notice.body ? { body: notice.body } : {}),
        ...(notice.silent !== undefined ? { silent: notice.silent } : {}),
        ...(target ? { onActivate: () => void deps.reveal(target) } : {}),
      })
    },
    analytics(event) {
      deps.analytics(event)
    },
    integrationsReady: () => deps.integrationsReady(),
    images: {
      downscale: async (bytes, mediaType) => downscaleConversationImage(deps.imageCodec, bytes, mediaType),
    },
  }
}
