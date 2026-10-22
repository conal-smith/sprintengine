import {
  isTailnetScope,
  TAILNET_SCOPES,
  type TailnetApprovePairRequestView,
  type TailnetDeviceOrigin,
  type TailnetPairingOfferView,
  type TailnetRemoteStatus,
} from '../../../shared/tailnet'
import type { TailnetPeerScan } from '../../../shared/tailnet-peers'
import { toolError, toolSuccess, type McpToolRegistration } from '../../../shared/modules/mcp-tools'

// The `tailnet.*` gateway family: configuring remote control from an agent
// rather than from Settings (it was originally IPC-only).
//
// These tools are LOCAL-ONLY. `tailnet-scopes.ts` classifies the family, and
// the listener's gate drops it from `tools/list` and refuses `tools/call`, so
// they exist on the owner-only Unix socket and nowhere else. The reason is the
// half of the original decision that still holds: a paired device that could
// call `tailnet.offer_pairing` could pair further devices with scopes wider
// than its own, and revoking the device it came in on would not take those
// away. One grant must not be able to manufacture the next one.
//
// What the local socket gives up by comparison is small: its auth model is
// filesystem permissions, so anything that can call these tools can already
// read and write the same `<userData>` files the service persists to.

/**
 * The tailnet half of the automation service. Declared structurally so this
 * file does not import the service that (transitively) owns the tool set.
 */
export type TailnetToolsFrontDoor = {
  getTailnetStatus(): TailnetRemoteStatus
  setTailnetEnabled(enabled: boolean): Promise<TailnetRemoteStatus>
  offerTailnetPairing(input?: { scopes?: unknown; origin?: TailnetDeviceOrigin }): TailnetPairingOfferView
  approveTailnetPairRequest(input: {
    id: string
    scopes?: unknown
    code?: unknown
    via?: 'ipc' | 'tool'
  }): TailnetApprovePairRequestView
  denyTailnetPairRequest(id: string, via?: 'ipc' | 'tool'): TailnetRemoteStatus
  cancelTailnetPairing(): TailnetRemoteStatus
  revokeTailnetDevice(deviceId: string): TailnetRemoteStatus
  listTailnetPeers(): Promise<TailnetPeerScan>
}

/** The `tailnet.*` tools that change state, for `isStudioGatewayMutation`. */
export const TAILNET_MUTATION_TOOL_NAMES: readonly string[] = [
  'tailnet.set_enabled',
  'tailnet.offer_pairing',
  'tailnet.cancel_pairing',
  'tailnet.revoke_device',
  'tailnet.approve_pair_request',
  'tailnet.deny_pair_request',
]

export function createTailnetTools(options: {
  /**
   * Resolved per call, never captured: the tool set is built before the
   * automation service that owns the tailnet lifecycle exists. Null until it
   * does, which is answered rather than thrown.
   */
  resolveTailnet: () => TailnetToolsFrontDoor | null
}): McpToolRegistration[] {
  const unavailable = toolError(
    'tailnet_unavailable',
    'Tailnet remote control is not wired up in this process yet. Retry once the app has finished starting.',
  )
  const front = (): TailnetToolsFrontDoor | null => options.resolveTailnet()

  const status: McpToolRegistration = {
    name: 'tailnet.status',
    description:
      'Read tailnet remote control on this machine: whether it is enabled, whether the listener is actually running ' +
      "and on what endpoint, this machine's Tailscale address, the paired devices, the outstanding pairing offer " +
      '(its scopes and expiry — never the code itself), and any pairing requests from other machines waiting to be ' +
      'answered here (who asked, from where, and when — never the six digits the asking machine shows). Served ' +
      'only over the local socket.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const service = front()
      if (!service) return unavailable
      return toolSuccess({ status: service.getTailnetStatus() })
    },
  }

  const setEnabled: McpToolRegistration = {
    name: 'tailnet.set_enabled',
    description:
      'Turn tailnet remote control on or off on this machine. Turning it on starts the listener only if Tailscale is ' +
      'up — with no tailnet interface the setting persists and the call reports why nothing is listening. Turning it ' +
      'off stops the listener and drops any outstanding pairing offer; already-paired devices keep their tokens ' +
      '(use tailnet.revoke_device for those). Served only over the local socket.',
    inputSchema: {
      type: 'object',
      properties: { enabled: { type: 'boolean', description: 'True to start the listener, false to stop it.' } },
      required: ['enabled'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const service = front()
      if (!service) return unavailable
      if (typeof args.enabled !== 'boolean') {
        return toolError('invalid_enabled', '"enabled" must be true or false.')
      }
      const next = await service.setTailnetEnabled(args.enabled)
      // Asked to enable and nothing is listening is a failed request, not a
      // quiet partial success — the setting persisted, and the answer says so
      // alongside the reason so the caller does not go on to mint a code.
      if (args.enabled && !next.running) {
        return toolError(
          'tailnet_listener_not_running',
          `The setting is saved, but nothing is listening. ${next.lastError ?? 'The listener did not start.'}`,
        )
      }
      return toolSuccess({ status: next })
    },
  }

  const offerPairing: McpToolRegistration = {
    name: 'tailnet.offer_pairing',
    description:
      'Mint a one-time pairing code for another machine to redeem, valid for 30 days. Returns the code and the ' +
      'sprintengine-tailnet:// pairing URL ONCE — neither is re-readable afterwards, and neither is ever returned by ' +
      'tailnet.status. Replaces any outstanding offer, including one a person is part-way through using in Settings. ' +
      'The code does not survive an app restart. Served only over the local socket.',
    inputSchema: {
      type: 'object',
      properties: {
        scopes: {
          type: 'array',
          items: { type: 'string', enum: [...TAILNET_SCOPES] },
          description: `Scopes to grant the device that redeems this code. Defaults to every scope (${TAILNET_SCOPES.join(', ')}).`,
        },
      },
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const service = front()
      if (!service) return unavailable
      const scopes = args.scopes === undefined ? undefined : readScopes(args.scopes)
      if (typeof scopes === 'string') return toolError('invalid_scopes', scopes)
      // The same rule the Settings panel enforces: a pairing code is a URL
      // pointing at a listener, so minting one while nothing is listening
      // produces a credential that cannot be redeemed anywhere.
      const current = service.getTailnetStatus()
      if (!current.running) {
        return toolError(
          'tailnet_not_running',
          current.enabled
            ? `Tailnet remote control is enabled but not listening, so a pairing code would point at nothing. ${current.lastError ?? 'Check that Tailscale is up.'}`
            : 'Tailnet remote control is off. Turn it on with tailnet.set_enabled first — a pairing code is a link to a listener.',
        )
      }
      // The device that redeems this code records that an agent minted it,
      // and which one — so a test grant left behind is recognisable as one
      // in the device list rather than an unplaceable row.
      const metadata = context?.metadata as Record<string, unknown> | undefined
      const agentName =
        typeof metadata?.agentName === 'string' && metadata.agentName
          ? metadata.agentName
          : typeof metadata?.agentId === 'string' && metadata.agentId
            ? metadata.agentId
            : null
      const offer = service.offerTailnetPairing({
        ...(scopes ? { scopes } : {}),
        origin: { kind: 'agent', by: agentName },
      })
      return toolSuccess({
        pairing: offer,
        // Stated rather than left to be inferred from the timestamp: this is the
        // one call whose result stops being obtainable the moment it returns.
        note: 'The code and pairing URL are shown once. They are not recoverable from tailnet.status, and an app restart invalidates an unredeemed offer.',
      })
    },
  }

  const cancelPairing: McpToolRegistration = {
    name: 'tailnet.cancel_pairing',
    description:
      'Withdraw the outstanding pairing offer so the code can no longer be redeemed. Devices already paired are ' +
      'unaffected. Succeeds whether or not an offer was outstanding. Served only over the local socket.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const service = front()
      if (!service) return unavailable
      return toolSuccess({ status: service.cancelTailnetPairing() })
    },
  }

  const revokeDevice: McpToolRegistration = {
    name: 'tailnet.revoke_device',
    description:
      'Revoke a paired device by id (from tailnet.status). Its token stops working on the very next request and any ' +
      'live stream it holds is closed immediately. Served only over the local socket.',
    inputSchema: {
      type: 'object',
      properties: { deviceId: { type: 'string', description: 'Device id from tailnet.status.' } },
      required: ['deviceId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const service = front()
      if (!service) return unavailable
      const deviceId = typeof args.deviceId === 'string' ? args.deviceId.trim() : ''
      if (!deviceId) return toolError('invalid_device_id', '"deviceId" must be a non-empty string from tailnet.status.')
      const before = service.getTailnetStatus()
      if (!before.devices.some((device) => device.id === deviceId)) {
        // Reported rather than absorbed: revokeDevice is idempotent by design,
        // so a silent success on a typo'd id would read as "that device is gone".
        return toolError('unknown_device', `No device "${deviceId}" is paired with this machine.`)
      }
      return toolSuccess({ status: service.revokeTailnetDevice(deviceId) })
    },
  }

  const approvePairRequest: McpToolRegistration = {
    name: 'tailnet.approve_pair_request',
    description:
      'Approve a pairing request another machine has made (see tailnet.status for the waiting ones), granting exactly ' +
      "the scopes named here. Requires the six-digit code shown on the ASKING machine's screen — ask the person to " +
      'read it off that screen; nothing on this machine reports it. Three wrong codes decline the request. The requesting machine collects its ' +
      'device token on its next poll. The scopes are NOT the ones the requester asked for — it cannot influence what ' +
      'approving it grants. Served only over the local socket.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Request id from tailnet.status.' },
        code: {
          type: 'string',
          description:
            "The six digits shown on the asking machine's screen. Required; typed by the person, never guessed.",
        },
        scopes: {
          type: 'array',
          items: { type: 'string', enum: [...TAILNET_SCOPES] },
          description: 'Scopes to grant. Defaults to every scope.',
        },
      },
      required: ['requestId', 'code'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const service = front()
      if (!service) return unavailable
      const requestId = typeof args.requestId === 'string' ? args.requestId.trim() : ''
      if (!requestId)
        return toolError('invalid_request_id', '"requestId" must be a non-empty string from tailnet.status.')
      const code = typeof args.code === 'string' ? args.code.trim() : ''
      if (!code) {
        return toolError('code_required', '"code" must be the six digits shown on the asking machine\'s screen.')
      }
      let scopes: string[] = [...TAILNET_SCOPES]
      if (args.scopes !== undefined) {
        const read = readScopes(args.scopes)
        if (typeof read === 'string') return toolError('invalid_scopes', read)
        scopes = read
      }
      // `via: 'tool'` suppresses the service's own audit write: this call is
      // already an audited mutation by the time it reaches here.
      const outcome = service.approveTailnetPairRequest({ id: requestId, scopes, code, via: 'tool' })
      // Refused rather than absorbed, for the same reason revoke_device reports
      // an unknown id: "approved" for a request that had already lapsed would
      // read as a machine now being paired when nothing was granted.
      if (!outcome.ok) return toolError(outcome.code, outcome.message)
      return toolSuccess({ device: outcome.device, status: outcome.status })
    },
  }

  const denyPairRequest: McpToolRegistration = {
    name: 'tailnet.deny_pair_request',
    description:
      'Decline a pairing request another machine has made. The requester is told it was declined, and that peer cannot ' +
      'ask again for a short cooldown. Served only over the local socket.',
    inputSchema: {
      type: 'object',
      properties: { requestId: { type: 'string', description: 'Request id from tailnet.status.' } },
      required: ['requestId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const service = front()
      if (!service) return unavailable
      const requestId = typeof args.requestId === 'string' ? args.requestId.trim() : ''
      if (!requestId)
        return toolError('invalid_request_id', '"requestId" must be a non-empty string from tailnet.status.')
      const before = service.getTailnetStatus()
      if (!before.pairRequests.some((request) => request.id === requestId)) {
        return toolError('unknown_request', `No pairing request "${requestId}" is waiting on this machine.`)
      }
      return toolSuccess({ status: service.denyTailnetPairRequest(requestId, 'tool') })
    },
  }

  const listPeers: McpToolRegistration = {
    name: 'tailnet.list_peers',
    description:
      'List the machines on this tailnet, as Tailscale itself reports them, and which of them answer as a ' +
      "SprintEngine Studio. Never a network scan. Works with this machine's own listener off — finding somewhere to " +
      'connect to does not require having opened your own door. Served only over the local socket.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const service = front()
      if (!service) return unavailable
      return toolSuccess({ peers: await service.listTailnetPeers() })
    },
  }

  return [status, setEnabled, offerPairing, cancelPairing, revokeDevice, approvePairRequest, denyPairRequest, listPeers]
}

/**
 * Read a requested scope list, or return the sentence explaining the refusal.
 *
 * `normalizeTailnetScopes` drops what it does not recognise, which is right for
 * reading a stored device and wrong here: a caller that misspells a scope would
 * silently get the default grant instead of the one it asked for.
 */
function readScopes(value: unknown): string[] | string {
  if (!Array.isArray(value)) return '"scopes" must be an array of scope strings.'
  const unknown = value.filter((entry) => !isTailnetScope(entry))
  if (unknown.length > 0) {
    return `Unknown scope(s): ${unknown.map((entry) => JSON.stringify(entry)).join(', ')}. Valid scopes are: ${TAILNET_SCOPES.join(', ')}.`
  }
  if (value.length === 0) return '"scopes" cannot be empty. Omit it for the default structured-command set.'
  return value as string[]
}
