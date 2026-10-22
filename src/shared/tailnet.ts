// Tailnet remote control: contracts shared between the main-process listener
// (src/main/automation/tailnet/) and the surfaces that configure it.
//
// The listener itself is opt-in and bound to the Tailscale interface address
// only.

/**
 * Per-device scopes, mirroring the gateway's tool families.
 *
 * Read and operate are separate grants so "watch my backlog from the laptop"
 * does not carry the power to change it.
 *
 * There is no terminal tier. `terminal:observe` and `terminal:control` were
 * retired on 2026-09-29, when terminals stopped crossing the tailnet: a stored
 * device that holds them loads without them (`normalizeTailnetScopes`), and
 * nothing a device can be granted reaches a shell on this machine.
 */
export const TAILNET_SCOPES = [
  'workspace:read',
  'workspace:operate',
  'backlog:read',
  'backlog:operate',
  'conversation:read',
  'conversation:operate',
] as const

export type TailnetScope = (typeof TAILNET_SCOPES)[number]

/** Missing scope lists in older pairing requests must not grant features added later. */
export const TAILNET_LEGACY_REQUEST_SCOPES: readonly TailnetScope[] = [
  'workspace:read',
  'workspace:operate',
  'backlog:read',
  'backlog:operate',
]

export function isTailnetScope(value: unknown): value is TailnetScope {
  return typeof value === 'string' && (TAILNET_SCOPES as readonly string[]).includes(value)
}

export function normalizeTailnetScopes(value: unknown): TailnetScope[] {
  if (!Array.isArray(value)) return []
  const unique = new Set<TailnetScope>()
  // Anything outside the vocabulary is dropped rather than rejected, which is
  // also how a device paired against a retired tool family loads: it keeps every
  // scope that still means something and silently loses the ones that do not.
  for (const entry of value) if (isTailnetScope(entry)) unique.add(entry)
  // Stable vocabulary order, so a stored device and a freshly minted one compare equal.
  return TAILNET_SCOPES.filter((scope) => unique.has(scope))
}

/**
 * Whether a set of granted scopes satisfies a required one.
 *
 * `operate` implies `read` within its family: a device trusted to change a
 * backlog item is necessarily trusted to see it, and granting them separately
 * would only produce devices that mutate blind. The implication is one-way — no
 * amount of read access ever confers operate — and never crosses families.
 */
export function tailnetScopeGrantsAccess(granted: ReadonlySet<TailnetScope>, required: TailnetScope): boolean {
  if (granted.has(required)) return true
  if (!required.endsWith(':read')) return false
  return granted.has(`${required.slice(0, -':read'.length)}:operate` as TailnetScope)
}

/**
 * How a paired device came to exist (pair-from-the-scan-and-stay-paired,
 * phase 5). Recorded at mint and never changed: the answer to "what is
 * this row?" when a person cannot place a device in their list.
 *
 * - `code`: someone redeemed a carried pairing link (the QR / URL path).
 * - `approval`: a person here allowed a request from another machine; `by`
 *   is the peer node the transport proved, when whois resolved it.
 * - `agent`: an agent on this machine minted it through
 *   `tailnet.offer_pairing`; `by` is the agent's name.
 * - `reverse`: the other half of a both-ways pairing — THIS machine asked to
 *   drive another, and granted it a device here in the same exchange; `by`
 *   is that machine's name.
 * - `unknown`: a record from before origins were kept.
 */
export type TailnetDeviceOrigin = {
  kind: 'code' | 'approval' | 'agent' | 'reverse' | 'unknown'
  by: string | null
}

/** A paired device, as any surface may see it. The device token is never part of this. */
export type TailnetDevice = {
  id: string
  name: string
  scopes: TailnetScope[]
  createdAt: string
  /** Last authenticated request, or null for a device that has never connected. */
  lastSeenAt: string | null
  /** Tailscale node name resolved at the last request; null when whois was unavailable. */
  lastPeerNode: string | null
  origin: TailnetDeviceOrigin
}

/** An outstanding pairing offer — what it grants and when it lapses, never the code. */
export type TailnetPairingState = {
  scopes: TailnetScope[]
  expiresAt: string
}

export type TailnetRemoteStatus = {
  /** The user's setting. False in every build until someone turns it on. */
  enabled: boolean
  running: boolean
  /** `address:port` while running, for the pairing URL. */
  endpoint: string | null
  port: number
  /** This machine's Tailscale address, or null when Tailscale is not up. */
  tailnetAddress: string | null
  /** Why the listener is not running when it was asked to be. */
  lastError: string | null
  /** Whether pairing and reachability events raise OS notifications (phase 3). Defaults on. */
  notifications: boolean
  devices: TailnetDevice[]
  pairing: TailnetPairingState | null
  /** Requests from other machines waiting to be approved or denied here. */
  pairRequests: TailnetPairRequest[]
}

export const TAILNET_GET_STATUS_CHANNEL = 'tailnet:get-status'
export const TAILNET_SET_ENABLED_CHANNEL = 'tailnet:set-enabled'
export const TAILNET_OFFER_PAIRING_CHANNEL = 'tailnet:offer-pairing'
export const TAILNET_CANCEL_PAIRING_CHANNEL = 'tailnet:cancel-pairing'
export const TAILNET_REVOKE_DEVICE_CHANNEL = 'tailnet:revoke-device'
/**
 * Replace a paired device's scopes from this machine (remote-settings-rebuild).
 *
 * IPC-only, exactly like the rest of this family and for the same reason
 * `tailnet-scopes.ts` gives: a device that could widen its own grant would make
 * revoking the device it came in on meaningless. Only this keyboard may.
 */
export const TAILNET_UPDATE_DEVICE_SCOPES_CHANNEL = 'tailnet:update-device-scopes'

/** What `offer-pairing` returns: the one-time code, shown once and never re-readable. */
export type TailnetPairingOfferView = {
  token: string
  scopes: TailnetScope[]
  expiresAt: string
  /** Full pairing URL when the listener is up, so a QR encodes one scannable string. */
  pairingUrl: string | null
}

/**
 * A pairing request waiting for a person to answer it on the machine being
 * driven.
 *
 * The other pairing path — a code minted here and carried to the other machine
 * — stays exactly as it was: a machine with nobody in front of it cannot
 * approve anything, which is the normal case for a server and a common one for
 * a desktop in another room. This adds a path rather than replacing one.
 */
export type TailnetPairRequest = {
  id: string
  /** The name the requesting client asked to be known by, once paired. */
  deviceName: string
  /**
   * Tailscale's name for the requesting node, or null when `whois` could not
   * resolve it. Null is shown as the bare address and marked unverified rather
   * than dropped: refusing an unresolvable peer would make the feature dead on
   * any machine without the Tailscale CLI, which is most of them.
   */
  peerNode: string | null
  /** The tailnet address the request arrived from. */
  peerAddress: string
  // The six digits the person types to allow the request are deliberately not
  // here: they are shown on the ASKING machine only, and read off that screen.
  // This record is what a status, an event and the tools carry, and a code
  // anything on this machine could read would be one nobody had to look at
  // the other screen for. The store keeps it (`TailnetPairRequestWithCode`).
  createdAt: string
  expiresAt: string
  /**
   * The scopes the asking machine asked for.
   *
   * A request, never a grant: what is actually granted is whatever the person
   * here approves, and the approving surface may tick any subset or superset of
   * this. It exists so that surface can open pre-ticked to what was asked for
   * rather than to a house default the asker never wanted — the difference
   * between answering the question that was put and answering a different one.
   *
   * An asker that names nothing (an older build, or a client that does not
   * care) is recorded as `TAILNET_LEGACY_REQUEST_SCOPES`, the same set every
   * pairing path defaulted to before this field existed.
   *
   * Optional in the TYPE, always present at runtime: this machine's store fills
   * it on every request it accepts. It is optional because a status payload
   * from a main process older than this field would not carry one, and a
   * consumer must read it as `request.requestedScopes ?? TAILNET_LEGACY_REQUEST_SCOPES`
   * rather than as an empty grant.
   */
  requestedScopes?: TailnetScope[]
}

/** What a requesting client learns when it polls its own request. */
export type TailnetPairRequestOutcome =
  | { status: 'pending'; comparisonCode: string; expiresAt: string }
  | {
      status: 'approved'
      deviceId: string
      deviceName: string
      /** Returned exactly once, to the poll that collects it. */
      deviceToken: string
      scopes: TailnetScope[]
    }
  // Denied and expired are distinct because the client should say different
  // things: one is an answer, the other is nobody having answered. An UNKNOWN
  // id also reports expired — there is nothing useful in telling a caller that
  // an id it invented never existed.
  | { status: 'denied' }
  | { status: 'expired' }

/**
 * How many wrong codes an approver may type before the request is declined
 * for them. Three is a typo allowance, not a guessing budget: the code is on
 * the asker's screen, and a person who cannot see it should not be approving.
 */
export const PAIR_REQUEST_CODE_ATTEMPTS = 3

/**
 * What a surface learns when it answers a request: the device, and fresh status.
 *
 * `code_mismatch` carries how many tries remain; on the last one the request
 * is declined outright and the answer says so, so the card does not offer
 * another go at a request that no longer exists.
 */
export type TailnetApprovePairRequestView =
  | { ok: true; device: TailnetDevice; status: TailnetRemoteStatus }
  | { ok: false; code: 'request_not_found' | 'code_required'; message: string; status: TailnetRemoteStatus }
  | {
      ok: false
      code: 'code_mismatch'
      message: string
      status: TailnetRemoteStatus
      attemptsLeft: number
      /** True when this mismatch was the last allowed and the request has been declined. */
      declined: boolean
    }

/**
 * The reverse half of a both-ways pairing (phase 6): what the ASKING machine
 * sends with its final collect so the machine that approved it can drive it
 * back. The asker minted this device for the approver on its own store; the
 * token travels exactly once, inside the collect that also takes the
 * approver's token, and only over the request the approver already said yes
 * to. Absent when the asker has no listener (a phone) or did not offer it.
 */
export type TailnetReverseGrant = {
  /** `address:port` of the asker's listener, for the approver to dial. */
  endpoint: string
  /** The asker's name for itself, as the approver's Mesh will list it. */
  machineName: string
  deviceId: string
  /** The name the approver's machine was granted under on the asker. */
  deviceName: string
  deviceToken: string
  scopes: TailnetScope[]
}

export const TAILNET_APPROVE_PAIR_REQUEST_CHANNEL = 'tailnet:approve-pair-request'
export const TAILNET_DENY_PAIR_REQUEST_CHANNEL = 'tailnet:deny-pair-request'
/** Main → renderer: open the Remote popover (an OS notification was clicked). */
export const REMOTE_OPEN_REQUESTED_CHANNEL = 'remote:open-requested'

// ── Live state, pushed (MC: remote-sessions-ux / tailnet-live-state-push) ────
//
// Everything above is request/response. These types are the push half: main
// broadcasts a `TailnetPushPayload` to every window whenever the listener,
// a pairing request, or a device's live connection changes, so the renderer
// never polls for a fact main already holds. The payload always carries a
// fresh status + live snapshot beside the event that caused it — a consumer
// stores the latest and can never drift from main by missing one event.

/** One inbound device's live connections, derived from open sockets — never persisted. */
export type TailnetLiveDevice = {
  deviceId: string
  deviceName: string
  /** An RPC stream is open right now. */
  connected: boolean
  /** Epoch ms of the first socket in the current connected stretch, or null. */
  connectedSince: number | null
  /**
   * Epoch ms of the last observed activity — a socket opening or closing, or
   * an authenticated HTTP call — on this device, or null.
   */
  lastActivityAt: number | null
  /**
   * Transport-proven identity of the peer holding the sockets: Tailscale's
   * name for the node when `whois` resolved it, and the address the last
   * socket arrived from. Distinct from `deviceName`, which is what the client
   * CALLED itself at pairing. No user agent or platform: nothing on this
   * transport sends one, and a field main does not hold is not reported.
   */
  peerNode: string | null
  peerAddress: string | null
}

export type TailnetLiveState = {
  /**
   * The service's monotonic change counter at the time of the read, so a
   * subscriber can drop this snapshot when a pushed payload already applied
   * is newer (the initial read resolving after a push — the mount race).
   */
  revision: number
  devices: TailnetLiveDevice[]
}

/**
 * How a pair request stopped waiting. Distinct because the surfaces say
 * different things — an answer given here, an answer nobody gave, and a
 * listener that went away underneath the request are three stories.
 */
export type TailnetPairRequestPhase = 'received' | 'approved' | 'denied' | 'expired' | 'cancelled'

/** Every phase after `received`: the request no longer exists to be answered. */
export function isPairRequestTerminalPhase(phase: TailnetPairRequestPhase): boolean {
  return phase !== 'received'
}

type TailnetLiveEvent =
  | { kind: 'listener'; running: true }
  /**
   * Down, with the reason when it was ASKED to be up: a port already taken
   * or an interface that vanished at boot reaches every window as this,
   * without waiting for someone to open Settings. `error` is null for a
   * stop that was requested.
   */
  | { kind: 'listener'; running: false; error: string | null }
  | {
      kind: 'pair-request'
      phase: TailnetPairRequestPhase
      requestId: string
      deviceName: string
      peerNode: string | null
    }
  | { kind: 'device-connection'; deviceId: string; deviceName: string; connected: boolean }
  | { kind: 'devices-changed' }

export type TailnetPushPayload = {
  /**
   * Monotonically increasing per service lifetime: a subscriber applies a payload
   * only when it is newer than the last one applied, so out-of-order delivery
   * or a late initial read can never roll presence backwards.
   */
  revision: number
  event: TailnetLiveEvent
  status: TailnetRemoteStatus
  live: TailnetLiveState
}

export const TAILNET_EVENT_CHANNEL = 'tailnet:event'
export const TAILNET_GET_LIVE_STATE_CHANNEL = 'tailnet:get-live-state'
