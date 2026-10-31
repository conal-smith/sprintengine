import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'
import { AUTOMATION_GET_STATUS_CHANNEL, type AutomationServerStatus } from '../../shared/automation'
import {
  MCP_HTTP_CREATE_CHANNEL,
  MCP_HTTP_REVOKE_CHANNEL,
  MCP_HTTP_STATUS_CHANNEL,
  type McpHttpCreateResult,
  type McpHttpStatus,
} from '../../shared/mcp-http'
import {
  TAILNET_CANCEL_PAIRING_CHANNEL,
  TAILNET_EVENT_CHANNEL,
  TAILNET_GET_LIVE_STATE_CHANNEL,
  TAILNET_GET_STATUS_CHANNEL,
  TAILNET_APPROVE_PAIR_REQUEST_CHANNEL,
  TAILNET_DENY_PAIR_REQUEST_CHANNEL,
  TAILNET_OFFER_PAIRING_CHANNEL,
  TAILNET_REVOKE_DEVICE_CHANNEL,
  TAILNET_SET_ENABLED_CHANNEL,
  TAILNET_UPDATE_DEVICE_SCOPES_CHANNEL,
  REMOTE_OPEN_REQUESTED_CHANNEL,
  type TailnetApprovePairRequestView,
  type TailnetLiveState,
  type TailnetPairingOfferView,
  type TailnetPushPayload,
  type TailnetRemoteStatus,
  type TailnetScope,
} from '../../shared/tailnet'
import { TAILNET_LIST_PEERS_CHANNEL, type TailnetPeerScan } from '../../shared/tailnet-peers'
import {
  TAILNET_SHARE_PORT_CHANNEL,
  TAILNET_SHARE_STATUS_CHANNEL,
  TAILNET_UNSHARE_PORT_CHANNEL,
  type TailnetShareResult,
  type TailnetShareStatus,
} from '../../shared/tailnet-share'
import { TAILNET_FORGET_MACHINE_CHANNEL, type TailnetForgetMachineResult } from '../../shared/tailnet-mesh'
import type { ElectronApi } from '../../shared/electron-api'

// Status only for the always-on gateway. Its mutations are main services, so
// nothing asks a window to perform one and there is no request/respond pair
// here.
//
// The tailnet half is the Remote panel's whole data path:
// configuration for the opt-in listener — enable it, mint or cancel a one-time
// pairing code, revoke a device — plus the discovery sweep that finds the other
// machines on this tailnet.
export const automationApi = {
  automationGetStatus: (): Promise<AutomationServerStatus> =>
    ipcRenderer.invoke(AUTOMATION_GET_STATUS_CHANNEL) as Promise<AutomationServerStatus>,
  mcpHttpStatus: (): Promise<McpHttpStatus> => ipcRenderer.invoke(MCP_HTTP_STATUS_CHANNEL) as Promise<McpHttpStatus>,
  mcpHttpCreate: (name: string): Promise<McpHttpCreateResult> =>
    ipcRenderer.invoke(MCP_HTTP_CREATE_CHANNEL, name) as Promise<McpHttpCreateResult>,
  mcpHttpRevoke: (id: string): Promise<McpHttpStatus> =>
    ipcRenderer.invoke(MCP_HTTP_REVOKE_CHANNEL, id) as Promise<McpHttpStatus>,
  tailnetGetStatus: (): Promise<TailnetRemoteStatus> =>
    ipcRenderer.invoke(TAILNET_GET_STATUS_CHANNEL) as Promise<TailnetRemoteStatus>,
  tailnetSetEnabled: (enabled: boolean): Promise<TailnetRemoteStatus> =>
    ipcRenderer.invoke(TAILNET_SET_ENABLED_CHANNEL, enabled) as Promise<TailnetRemoteStatus>,
  tailnetOfferPairing: (scopes?: TailnetScope[]): Promise<TailnetPairingOfferView> =>
    ipcRenderer.invoke(TAILNET_OFFER_PAIRING_CHANNEL, scopes) as Promise<TailnetPairingOfferView>,
  tailnetCancelPairing: (): Promise<TailnetRemoteStatus> =>
    ipcRenderer.invoke(TAILNET_CANCEL_PAIRING_CHANNEL) as Promise<TailnetRemoteStatus>,
  tailnetRevokeDevice: (deviceId: string): Promise<TailnetRemoteStatus> =>
    ipcRenderer.invoke(TAILNET_REVOKE_DEVICE_CHANNEL, deviceId) as Promise<TailnetRemoteStatus>,
  tailnetUpdateDeviceScopes: (deviceId: string, scopes: TailnetScope[]): Promise<TailnetRemoteStatus> =>
    ipcRenderer.invoke(TAILNET_UPDATE_DEVICE_SCOPES_CHANNEL, deviceId, scopes) as Promise<TailnetRemoteStatus>,
  tailnetForgetMachine: (input: { deviceId?: string; connectionId?: string }): Promise<TailnetForgetMachineResult> =>
    ipcRenderer.invoke(TAILNET_FORGET_MACHINE_CHANNEL, input) as Promise<TailnetForgetMachineResult>,
  tailnetApprovePairRequest: (
    id: string,
    scopes: TailnetScope[],
    code: string,
  ): Promise<TailnetApprovePairRequestView> =>
    ipcRenderer.invoke(
      TAILNET_APPROVE_PAIR_REQUEST_CHANNEL,
      id,
      scopes,
      code,
    ) as Promise<TailnetApprovePairRequestView>,
  tailnetDenyPairRequest: (id: string): Promise<TailnetRemoteStatus> =>
    ipcRenderer.invoke(TAILNET_DENY_PAIR_REQUEST_CHANNEL, id) as Promise<TailnetRemoteStatus>,
  onRemoteOpenRequested: (cb: () => void): (() => void) => {
    const handler = () => cb()
    ipcRenderer.on(REMOTE_OPEN_REQUESTED_CHANNEL, handler)
    return () => ipcRenderer.removeListener(REMOTE_OPEN_REQUESTED_CHANNEL, handler)
  },
  tailnetListPeers: (): Promise<TailnetPeerScan> =>
    ipcRenderer.invoke(TAILNET_LIST_PEERS_CHANNEL) as Promise<TailnetPeerScan>,
  tailnetGetLiveState: (): Promise<TailnetLiveState> =>
    ipcRenderer.invoke(TAILNET_GET_LIVE_STATE_CHANNEL) as Promise<TailnetLiveState>,
  tailnetShareStatus: (): Promise<TailnetShareStatus> =>
    ipcRenderer.invoke(TAILNET_SHARE_STATUS_CHANNEL) as Promise<TailnetShareStatus>,
  tailnetSharePort: (localPort: number): Promise<TailnetShareResult> =>
    ipcRenderer.invoke(TAILNET_SHARE_PORT_CHANNEL, { localPort }) as Promise<TailnetShareResult>,
  tailnetUnsharePort: (servePort: number): Promise<TailnetShareResult> =>
    ipcRenderer.invoke(TAILNET_UNSHARE_PORT_CHANNEL, { servePort }) as Promise<TailnetShareResult>,
  // The push half (remote-sessions-ux): main broadcasts every tailnet change;
  // each payload carries fresh status + live state, so a subscriber stores the
  // latest and never re-fetches.
  onTailnetEvent: (cb: (payload: TailnetPushPayload) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, payload: TailnetPushPayload) => cb(payload)
    ipcRenderer.on(TAILNET_EVENT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(TAILNET_EVENT_CHANNEL, handler)
  },
} satisfies Pick<
  ElectronApi,
  | 'automationGetStatus'
  | 'mcpHttpStatus'
  | 'mcpHttpCreate'
  | 'mcpHttpRevoke'
  | 'tailnetGetStatus'
  | 'tailnetSetEnabled'
  | 'tailnetOfferPairing'
  | 'tailnetCancelPairing'
  | 'tailnetRevokeDevice'
  | 'tailnetUpdateDeviceScopes'
  | 'tailnetForgetMachine'
  | 'tailnetApprovePairRequest'
  | 'tailnetDenyPairRequest'
  | 'onRemoteOpenRequested'
  | 'tailnetListPeers'
  | 'tailnetGetLiveState'
  | 'onTailnetEvent'
  | 'tailnetShareStatus'
  | 'tailnetSharePort'
  | 'tailnetUnsharePort'
>
