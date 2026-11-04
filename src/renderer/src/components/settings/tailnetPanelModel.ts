import type {
  TailnetHttpsState,
  TailnetMcpAccess,
  TailnetPairRequest,
  TailnetRemoteStatus,
} from '../../../../shared/tailnet'
import type { Tone } from '../ui'

// The Remote (tailnet) settings panel's view model, kept DOM-free so the rules
// that matter can be tested without mounting anything.
//
// The rule that matters most: this feature cannot be half-enabled. Tailscale
// missing or stopped is not a degraded mode you can switch on and hope — the
// listener refuses to bind anywhere but a tailnet address, so the panel must
// refuse the switch and say why, rather than flipping a toggle that quietly
// does nothing.

type TailnetPanelState = 'loading' | 'no-tailnet' | 'off' | 'not-listening' | 'listening'

export type TailnetReadiness = {
  state: TailnetPanelState
  /** Headline word for the status line. */
  label: string
  tone: Tone
  /** One sentence: what is true now, and what to do about it. */
  detail: string
  /**
   * Whether the switch may be turned ON. False with no tailnet — the listener
   * would refuse to bind, so offering the switch would be offering a lie.
   */
  canTurnOn: boolean
  /**
   * Whether a pairing code may be minted. A code is a URL pointing at a
   * listener; with nothing listening there is nothing for it to point at.
   */
  canPair: boolean
}

export function tailnetReadiness(status: TailnetRemoteStatus | null): TailnetReadiness {
  if (!status) {
    return {
      state: 'loading',
      label: 'Loading',
      tone: 'neutral',
      detail: 'Reading tailnet remote control.',
      canTurnOn: false,
      canPair: false,
    }
  }

  if (!status.tailnetAddress) {
    // The one hard prerequisite, stated in the two situations a person can be
    // in: they have not set Tailscale up, or it stopped underneath them.
    return {
      state: 'no-tailnet',
      label: 'Tailscale not detected',
      tone: status.enabled ? 'error' : 'neutral',
      detail: status.enabled
        ? 'Remote control is on, but Tailscale is not running on this machine, so nothing is listening. Start Tailscale and sign in.'
        : 'This machine is not on a Tailscale network. Install Tailscale and sign in, then remote control can be turned on.',
      canTurnOn: false,
      canPair: false,
    }
  }

  if (!status.enabled) {
    return {
      state: 'off',
      label: 'Off',
      tone: 'neutral',
      detail: 'Nothing on your tailnet can reach this Studio. Turn it on to pair a device.',
      canTurnOn: true,
      canPair: false,
    }
  }

  if (!status.running || !status.endpoint) {
    return {
      state: 'not-listening',
      label: 'Not listening',
      tone: 'error',
      detail: status.lastError ?? 'Remote control is on, but the listener did not start.',
      canTurnOn: true,
      canPair: false,
    }
  }

  return {
    state: 'listening',
    label: 'Listening',
    tone: 'good',
    detail: `Paired devices can reach this Studio at ${status.endpoint} over your tailnet.`,
    canTurnOn: true,
    canPair: true,
  }
}

/**
 * How long an outstanding pairing code has left, in words.
 *
 * Codes run to 30 days, so the unit has to climb with the remainder: "Expires
 * in 43200 min" is technically true and useless. Each step floors to its own
 * unit rather than rounding up into the next, so the words never claim more
 * time than the code has.
 */
export function pairingExpiry(expiresAt: string, now: number): string {
  const remainingMs = Date.parse(expiresAt) - now
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 'Expired'
  const days = Math.floor(remainingMs / 86_400_000)
  if (days >= 1) return `Expires in ${days} ${days === 1 ? 'day' : 'days'}`
  const hours = Math.floor(remainingMs / 3_600_000)
  if (hours >= 1) return `Expires in ${hours} ${hours === 1 ? 'hour' : 'hours'}`
  const minutes = Math.floor(remainingMs / 60_000)
  if (minutes >= 1) return `Expires in ${minutes} min`
  return `Expires in ${Math.max(1, Math.ceil(remainingMs / 1000))}s`
}

/**
 * What to say about a pairing offer the panel can see but cannot show.
 *
 * The code is returned once and never re-readable, so a panel that was closed
 * and reopened knows a code is outstanding without knowing what it says. One
 * clause, because the card around it already carries the expiry and the scope
 * pills: everything the old three-sentence version explained is now drawn.
 */
export function outstandingPairingNote(pairing: { scopes: string[]; expiresAt: string }, now: number): string {
  return `A code is already active — ${pairingExpiry(pairing.expiresAt, now).toLowerCase()}. Create a new one if you no longer have it.`
}

// `deviceOriginText` and `deviceSummary` went with the device list they were
// the second line of (remote-settings-rebuild). The machine row says platform,
// scope count and last-seen; where a pairing came from — "paired by approval
// from …", "created by an agent" — turned out to be a fact nobody ever acted
// on, and the row it padded is now one line shorter for it.

// The peer list is gone with the peer picker: Settings → Remote now draws ONE
// merged list from `shared/tailnet-machines.ts`, which is where the rows for
// paired devices, mesh connections and scanned peers are folded together.

/**
 * A waiting request's secondary line: who is asking, and from where.
 *
 * An unresolvable peer is stated as unverified rather than dropped or dressed
 * up — `whois` is unavailable on any machine without the Tailscale CLI, and a
 * request shown with an invented name would be worse than one shown with an
 * address and a caveat.
 */
export function pairRequestSummary(request: TailnetPairRequest): string {
  const from = request.peerNode ?? `${request.peerAddress || 'an unknown address'} · name unverified`
  return `Asking from ${from}`
}

/**
 * Whether a waiting request can still be answered, and what to say when it
 * cannot. A lapsed request stays on screen until the next read rather than
 * vanishing under the cursor, so the button explains itself instead of failing.
 */
export function pairRequestAnswerable(
  request: TailnetPairRequest,
  nowMs: number,
): { canAnswer: boolean; note: string | null } {
  const expiresAtMs = Date.parse(request.expiresAt)
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) {
    return { canAnswer: false, note: 'This request lapsed before it was answered.' }
  }
  return { canAnswer: true, note: null }
}

/** The help line under the MCP URL: what to do with it, and what it cannot do over plain HTTP. */
export function mcpUrlHelp(mcp: TailnetMcpAccess | null): string {
  if (!mcp?.url) return 'Turn on remote control to get the URL an MCP client connects to.'
  if (mcp.https.state === 'on')
    return 'Give this URL to Claude Code, Codex or any MCP client that signs in with OAuth. You approve each one here.'
  return 'Give this URL to an MCP client that signs in with OAuth. Most clients finish signing in only over HTTPS: turn it on below.'
}

/** The help line under the HTTPS switch, by what last happened when it was applied. */
export function mcpHttpsHelp(https: TailnetHttpsState | null): string {
  switch (https?.state) {
    case 'on':
      return `Published at ${https.origin ?? 'this machine’s tailnet name'} with this tailnet’s certificate.`
    case 'starting':
      return 'Asking Tailscale to publish it…'
    case 'error':
      return https.message ?? 'Tailscale did not publish it.'
    default:
      return 'Publishes the listener at https://<this machine>.<tailnet>.ts.net on port 443, through Tailscale Serve. Only your tailnet can reach it.'
  }
}

/** "Ends in 12 days" for an MCP client's sign-in, or null when it has none to show. */
export function signInEnds(iso: string | null, now: number): string | null {
  const endsAt = iso ? Date.parse(iso) : Number.NaN
  if (!Number.isFinite(endsAt)) return null
  const days = Math.ceil((endsAt - now) / (24 * 60 * 60 * 1000))
  if (days <= 0) return 'Sign-in ended'
  return days === 1 ? 'Ends tomorrow' : `Ends in ${days} days`
}
