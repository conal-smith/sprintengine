import type { AgentLaunchRequest } from '../../shared/agent-launch'
import type { ControlRpc } from '../bootstrap/control-rpc'
import {
  SHELL_BRIDGE_EVENTS,
  SHELL_BRIDGE_METHODS,
  type ShellAnalyticsEvent,
  type ShellBridge,
  type ShellNotice,
  type ShellRevealTarget,
} from './shell-bridge'
import { isRecord } from '../../shared/records'

// The shell's side of the bridge: what a server out of process asks on the
// control channel, answered by the shell's own in-process bridge. One
// implementation answers both paths, so the server sees the same behaviour
// whichever side of the channel it runs on.
//
// Every request is checked for shape here: the channel is process-private, but
// a server built from another commit (a dev rebuild) is still a peer whose
// frames are read, not trusted to be well formed.

export function serveShellBridge(rpc: ControlRpc, bridge: ShellBridge): () => void {
  const stops = [
    rpc.handle(SHELL_BRIDGE_METHODS.cipherAvailable, () => bridge.cipher.available()),
    rpc.handle(SHELL_BRIDGE_METHODS.cipherSeal, (params) => bridge.cipher.seal(bytesParam(params))),
    rpc.handle(SHELL_BRIDGE_METHODS.cipherOpen, (params) => bridge.cipher.open(bytesParam(params))),
    rpc.handle(SHELL_BRIDGE_METHODS.launchAgent, (params) => {
      if (!isRecord(params) || typeof params.workspaceId !== 'string') {
        throw new Error('A terminal launch names its workspace.')
      }
      return bridge.terminals.launchAgent(params as AgentLaunchRequest)
    }),
    rpc.handle(SHELL_BRIDGE_METHODS.revealTab, (params) => {
      const target = revealTarget(params)
      return target ? bridge.reveal.tab(target) : false
    }),
    rpc.handle(SHELL_BRIDGE_METHODS.imageDownscale, (params) => {
      if (!isRecord(params) || !(params.bytes instanceof Uint8Array) || typeof params.mediaType !== 'string') {
        throw new Error('A picture to shrink is its bytes and its media type.')
      }
      return bridge.images.downscale(params.bytes, params.mediaType)
    }),
    rpc.handle(SHELL_BRIDGE_METHODS.integrationsReady, async () => {
      await bridge.integrationsReady()
      return true
    }),
    rpc.on(SHELL_BRIDGE_EVENTS.notify, (payload) => {
      const notice = shellNotice(payload)
      if (notice) bridge.notify(notice)
    }),
    rpc.on(SHELL_BRIDGE_EVENTS.analytics, (payload) => {
      if (isRecord(payload) && typeof payload.name === 'string' && isRecord(payload.properties)) {
        bridge.analytics(payload as ShellAnalyticsEvent)
      }
    }),
  ]
  return () => {
    for (const stop of stops) stop()
  }
}

function bytesParam(params: unknown): Uint8Array {
  if (params instanceof Uint8Array) return params
  throw new Error('The cipher takes bytes.')
}

function revealTarget(value: unknown): ShellRevealTarget | null {
  if (!isRecord(value)) return null
  if (value.kind === 'remote') return { kind: 'remote' }
  if (value.kind === 'app') return { kind: 'app' }
  if (value.kind === 'chat' && typeof value.chatId === 'string' && value.chatId) {
    return {
      kind: 'chat',
      chatId: value.chatId,
      ...(typeof value.agentId === 'string' && value.agentId ? { agentId: value.agentId } : {}),
    }
  }
  return null
}

function shellNotice(value: unknown): ShellNotice | null {
  if (!isRecord(value) || typeof value.key !== 'string' || typeof value.title !== 'string') return null
  const activate = value.activate === undefined ? undefined : revealTarget(value.activate)
  return {
    key: value.key,
    title: value.title,
    ...(typeof value.body === 'string' ? { body: value.body } : {}),
    ...(typeof value.silent === 'boolean' ? { silent: value.silent } : {}),
    ...(activate ? { activate } : {}),
  }
}
