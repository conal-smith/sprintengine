import { SERVER_IPC_CHANNELS } from '../../shared/ipc-channel-owners'
import { WEB_TUNNEL_REFUSED, webTunnelAllows } from '../../shared/web-client'
import type { TunnelPort } from '../ipc/ipc-tunnel'

// A web tab's IPC tunnel, as the server holds it (phase 9 spec, 14.8):
//
// - only the channels a web tab may reach (`webTunnelAllows`) are carried; any
//   other is answered `DesktopOnly` and never reaches a handler, so a tab
//   cannot pair an app or a machine, administer the tailnet, or set a key,
//   whatever its page sends;
// - every call that changes something is audited, as a paired app's protocol
//   requests are, under the browser's name: a browser is a client of this
//   server, not its window.

// A channel that only reads, by its name: not audited.
const READS =
  /:(get|list|status|read|home|search|threads|transcript|earlier|discover|get-snapshot|get-events-after|needs-hydration|token-status|list-repos|tool-detail|attachment|plan-document|diff|resolve-location|subscribe|unsubscribe|mark-seen|browse-folders)$/u

/** Whether a call on a tunnel channel is one the audit records. */
export function webTunnelAudited(channel: string): boolean {
  if (SERVER_IPC_CHANNELS[channel]?.retry === 'once') return false
  return !READS.test(channel) && !channel.endsWith(':search:cancel') && !channel.startsWith('web:previews:list')
}

export type WebTunnelAudit = (entry: { channel: string; ok: boolean; durationMs: number; workspaceId?: string }) => void

/** The folder a `workspace.created` dispatch names, when the frame is one. */
function createdWorkspaceFolder(channel: string, args: unknown): string | null {
  if (channel !== 'workspace-sync:dispatch' || !Array.isArray(args)) return null
  const command = args[0] as { type?: unknown; payload?: { insert?: { folderPath?: unknown } } } | null
  if (command?.type !== 'workspace.created') return null
  const folderPath = command.payload?.insert?.folderPath
  return typeof folderPath === 'string' && folderPath.trim() !== '' ? folderPath : null
}

export function guardWebTunnelPort(
  port: TunnelPort,
  options: {
    audit: WebTunnelAudit
    log?: (message: string) => void
    /**
     * Set for a browser on the tailnet: a workspace it creates must be on a
     * folder Studio already has a workspace for.
     */
    knownFolder?: (folderPath: string) => boolean
  },
): TunnelPort {
  // Audited calls in flight, by request id: when they started and what they named.
  const audited = new Map<unknown, { channel: string; started: number; workspaceId?: string }>()
  const guarded: TunnelPort = {
    postMessage(message) {
      const frame = message as { t?: unknown; id?: unknown; ok?: unknown } | null
      if (frame?.t === 'ipc.result' && audited.has(frame.id)) {
        const call = audited.get(frame.id)!
        audited.delete(frame.id)
        options.audit({
          channel: call.channel,
          ok: frame.ok === true,
          durationMs: Date.now() - call.started,
          ...(call.workspaceId ? { workspaceId: call.workspaceId } : {}),
        })
      }
      port.postMessage(message)
    },
    on: ((event: 'message' | 'close', listener: (event: { data: unknown }) => void) => {
      if (event === 'close') {
        port.on('close', listener as () => void)
        return guarded
      }
      port.on('message', (incoming) => {
        const frame = incoming.data as { t?: unknown; id?: unknown; channel?: unknown; args?: unknown } | null
        const channel = typeof frame?.channel === 'string' ? frame.channel : ''
        if ((frame?.t === 'ipc.invoke' || frame?.t === 'ipc.send') && !webTunnelAllows(channel)) {
          options.log?.(`a web tab asked for ${channel || 'an unnamed channel'}, which the desktop app alone offers`)
          if (frame.t === 'ipc.invoke')
            port.postMessage({
              t: 'ipc.result',
              id: frame.id,
              ok: false,
              error: { name: WEB_TUNNEL_REFUSED, message: `${channel} is available in the desktop app only.` },
            })
          return
        }
        const created = frame?.t === 'ipc.invoke' ? createdWorkspaceFolder(channel, frame.args) : null
        if (created !== null && options.knownFolder && !options.knownFolder(created)) {
          port.postMessage({
            t: 'ipc.result',
            id: frame!.id,
            ok: false,
            error: {
              name: 'UnknownFolder',
              message: 'A browser on the tailnet opens only folders Studio already has a workspace for.',
            },
          })
          return
        }
        if (frame?.t === 'ipc.invoke' && webTunnelAudited(channel)) {
          const first = Array.isArray(frame.args) ? (frame.args[0] as { workspaceId?: unknown } | null) : null
          audited.set(frame.id, {
            channel,
            started: Date.now(),
            ...(typeof first?.workspaceId === 'string' ? { workspaceId: first.workspaceId.slice(0, 200) } : {}),
          })
        }
        listener(incoming)
      })
      return guarded
    }) as TunnelPort['on'],
    start: () => port.start(),
    close: () => port.close(),
  }
  return guarded
}
