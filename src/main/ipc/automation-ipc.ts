import type { IpcMain } from 'electron'
import { AUTOMATION_GET_STATUS_CHANNEL } from '../../shared/automation'
import { MCP_HTTP_CREATE_CHANNEL, MCP_HTTP_REVOKE_CHANNEL, MCP_HTTP_STATUS_CHANNEL } from '../../shared/mcp-http'
import {
  TAILNET_CANCEL_PAIRING_CHANNEL,
  TAILNET_GET_LIVE_STATE_CHANNEL,
  TAILNET_GET_STATUS_CHANNEL,
  TAILNET_APPROVE_PAIR_REQUEST_CHANNEL,
  TAILNET_DENY_PAIR_REQUEST_CHANNEL,
  TAILNET_OFFER_PAIRING_CHANNEL,
  TAILNET_REVOKE_DEVICE_CHANNEL,
  TAILNET_SET_ENABLED_CHANNEL,
  TAILNET_UPDATE_DEVICE_SCOPES_CHANNEL,
} from '../../shared/tailnet'
import { TAILNET_FORGET_MACHINE_CHANNEL } from '../../shared/tailnet-mesh'
import { TAILNET_LIST_PEERS_CHANNEL } from '../../shared/tailnet-peers'
import {
  TAILNET_SHARE_PORT_CHANNEL,
  TAILNET_SHARE_STATUS_CHANNEL,
  TAILNET_UNSHARE_PORT_CHANNEL,
} from '../../shared/tailnet-share'
import type { AutomationService } from '../automation/automation-service'
import { createTailnetShareService } from '../automation/tailnet/tailnet-share-service'
import { asRecord } from '../../shared/records'

// Status only: a window reads whether the gateway is up and may turn it off.
// The respond half of the old renderer-delegate pair went with the delegate
// — no gateway request travels to a window any more.
//
// The tailnet channels are the configuration front door for the opt-in remote
// listener: enable it, mint or cancel a pairing code, revoke a paired
// device. They are IPC-only on purpose — none of this is reachable through the
// MCP gateway itself, so no agent (local or remote) can pair a new device or
// widen its own reach.
export function registerAutomationIpc(ipcMain: IpcMain, service: AutomationService): void {
  ipcMain.handle(AUTOMATION_GET_STATUS_CHANNEL, () => service.getStatus())
  // The HTTP endpoint's tokens: made, named and revoked from a window only, as
  // a pairing is, so no caller of the gateway can mint itself another door.
  ipcMain.handle(MCP_HTTP_STATUS_CHANNEL, () => service.getMcpHttpStatus())
  ipcMain.handle(MCP_HTTP_CREATE_CHANNEL, (_event, name: unknown) =>
    service.createMcpHttpClient(typeof name === 'string' ? name : ''),
  )
  ipcMain.handle(MCP_HTTP_REVOKE_CHANNEL, (_event, id: unknown) =>
    service.revokeMcpHttpClient(typeof id === 'string' ? id : ''),
  )
  ipcMain.handle(TAILNET_GET_STATUS_CHANNEL, () => service.getTailnetStatus())
  // The initial read behind the push channel: a subscriber takes this snapshot
  // once, then stores each pushed payload's fresher copy.
  ipcMain.handle(TAILNET_GET_LIVE_STATE_CHANNEL, () => service.getTailnetLiveState())
  ipcMain.handle(TAILNET_SET_ENABLED_CHANNEL, (_event, enabled: unknown) => service.setTailnetEnabled(enabled === true))
  ipcMain.handle(TAILNET_OFFER_PAIRING_CHANNEL, (_event, scopes: unknown) => service.offerTailnetPairing({ scopes }))
  ipcMain.handle(TAILNET_CANCEL_PAIRING_CHANNEL, () => service.cancelTailnetPairing())
  // Answering a request is the same authority as minting a code, so it lives on
  // the same IPC-only front door: a remote device can ask, and only this
  // keyboard can say yes.
  // The code is the six digits on the ASKER's screen, typed here: main
  // compares, so a window cannot approve what its person did not read.
  ipcMain.handle(TAILNET_APPROVE_PAIR_REQUEST_CHANNEL, (_event, id: unknown, scopes: unknown, code: unknown) =>
    service.approveTailnetPairRequest({ id: typeof id === 'string' ? id : '', scopes, code }),
  )
  ipcMain.handle(TAILNET_DENY_PAIR_REQUEST_CHANNEL, (_event, id: unknown) =>
    service.denyTailnetPairRequest(typeof id === 'string' ? id : ''),
  )
  ipcMain.handle(TAILNET_REVOKE_DEVICE_CHANNEL, (_event, deviceId: unknown) =>
    service.revokeTailnetDevice(typeof deviceId === 'string' ? deviceId : ''),
  )
  // Widening an existing pairing is the same authority as granting one, so it
  // is on this same IPC-only door and nowhere else. `tailnet-scopes.ts` says
  // why the family has no gateway tool: a device that could widen its own grant
  // would make revoking the device it came in on meaningless.
  ipcMain.handle(TAILNET_UPDATE_DEVICE_SCOPES_CHANNEL, (_event, deviceId: unknown, scopes: unknown) =>
    service.updateTailnetDeviceScopes(typeof deviceId === 'string' ? deviceId : '', scopes),
  )
  // Both halves of one pairing, ended together: the device that machine holds
  // here, and the credential this machine holds there. Either may be absent.
  ipcMain.handle(TAILNET_FORGET_MACHINE_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input)
    return service.forgetTailnetMachine({ deviceId: record?.deviceId, connectionId: record?.connectionId })
  })
  // Discovery is a read of the local Tailscale daemon plus a probe of a public
  // health endpoint, so it changes nothing and is safe to call with the
  // listener off. It is still IPC-only for the same reason as the rest: a
  // remote device must not be able to make this machine enumerate the tailnet.
  ipcMain.handle(TAILNET_LIST_PEERS_CHANNEL, () => service.listTailnetPeers())

  // Publishing a dev server on the tailnet (Track 1). IPC-only for the same
  // reason as everything above it: sharing a port widens what this machine
  // exposes, so it is a decision the person at the keyboard makes. No agent —
  // local or remote — can reach these, and `unshare` refuses any port outside
  // the ladder so a hand-written serve mapping is never taken down by Studio.
  const shareService = createTailnetShareService()
  ipcMain.handle(TAILNET_SHARE_STATUS_CHANNEL, () => shareService.readStatus())
  ipcMain.handle(TAILNET_SHARE_PORT_CHANNEL, (_event, input: unknown) =>
    shareService.share(Number(asRecord(input)?.localPort)),
  )
  ipcMain.handle(TAILNET_UNSHARE_PORT_CHANNEL, (_event, input: unknown) =>
    shareService.unshare(Number(asRecord(input)?.servePort)),
  )
}
