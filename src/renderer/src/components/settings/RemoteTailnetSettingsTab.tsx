import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { encodeQrCode } from '../../../../shared/qr-code'
import {
  type TailnetPairingOfferView,
  type TailnetPairingState,
  type TailnetRemoteStatus,
  type TailnetScope,
} from '../../../../shared/tailnet'
import { mergeMachines, type TailnetMachine } from '../../../../shared/tailnet-machines'
import type { TailnetPeerScan } from '../../../../shared/tailnet-peers'
import {
  GhostButton,
  InlineNotice,
  Input,
  LinkButton,
  OutlineButton,
  PrimaryButton,
  ScopePill,
  ScopePillSet,
  SplitButton,
  StatusDot,
} from '../ui'
import { SettingCard, SettingsPageHeader, SettingsSectionTitle, SettingToggle } from './SettingsAtoms'
import { outstandingPairingNote, pairingExpiry, tailnetReadiness } from './tailnetPanelModel'
import { MachineList, MachineRow } from '../remote/MachineRow'
import { PairDeviceModal, type PairDeviceTarget } from '../remote/PairDeviceModal'
import { pairRoute } from '../remote/pairRouteModel'
import { STANDARD_SCOPES } from '../remote/scopePickerModel'
import { PairRequestCard } from '../remote/PairRequestCard'
import { OutboundPairRequestCard } from '../remote/OutboundPairRequestCard'
import { useTailnetPresence } from '../workspace/topbar/useTailnetPresence'
import { hostPlatform } from '../../clientCapabilities'
import { isImeKey } from '../../utils/imeKey'

// Settings → Remote (remote-settings-rebuild): one switch and one list of
// machines.
//
// What this replaced was four sections that were really one question. "This
// machine" printed a tailnet address, a port and an endpoint nobody types;
// "Paired devices" listed the machines that may drive this one; "Machines on
// your tailnet" listed the same machines again from Tailscale's side, behind a
// Scan button; and a "Pairing" section owned the code. One machine could appear
// in three of them, with a different name and a different verb in each, and the
// thing a person actually wanted to know — what may that machine do here — was
// a bare scope count with no way to see it or change it.
//
// So: `mergeMachines` folds the three sources into one row per Tailscale node,
// the scan runs by itself, and the scope set is the one link on the row. The
// only remaining chrome is the split button that starts a pairing.
//
// Everything here is IPC-only (`tailnet:*` / `mesh:*`). The matching
// `tailnet.*` gateway tools let an agent ON THIS MACHINE drive the same
// service, but that family is refused over the tailnet itself, so no paired
// remote device can pair another device or widen its own reach.

/** The pairing code's countdown; a code with a minute left should look like it. */
const EXPIRY_TICK_MS = 1000

type ActionState = { tone: 'idle' | 'busy' | 'error'; message: string }

export function RemoteTailnetSettingsTab() {
  const [status, setStatus] = useState<TailnetRemoteStatus | null>(null)
  const [offer, setOffer] = useState<TailnetPairingOfferView | null>(null)
  const [scan, setScan] = useState<TailnetPeerScan | null>(null)
  const [pairTarget, setPairTarget] = useState<PairDeviceTarget | null>(null)
  // A pairing link carried from a machine nobody is sitting at (a server, a
  // headless box). Behind the split button's caret now rather than a footer
  // disclosure, but the same flow.
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pairingLink, setPairingLink] = useState('')
  const [action, setAction] = useState<ActionState>({ tone: 'idle', message: '' })
  const [now, setNow] = useState(() => Date.now())
  // The newest pushed revision applied, so a read that resolves after a push
  // (the mount race) cannot roll the tab back to what main knew a moment ago.
  const appliedRevision = useRef(0)

  const refresh = useCallback(async () => {
    const before = appliedRevision.current
    const read = await window.api.tailnetGetStatus()
    if (appliedRevision.current === before) setStatus(read)
  }, [])

  useEffect(() => {
    void refresh().catch((error: unknown) => {
      setAction({ tone: 'error', message: describe(error, 'Could not read tailnet remote control.') })
    })
  }, [refresh])

  // Live updates (remote-sessions-ux): every pushed payload carries fresh
  // status, so a pair request arriving — or being answered from any other
  // surface — lands here without a refetch.
  useEffect(() => {
    // Tolerant of a host without the push bridge: the tab then stays
    // fetch-on-action, exactly as it was before the channel existed.
    if (typeof window.api.onTailnetEvent !== 'function') return
    return window.api.onTailnetEvent((payload) => {
      if (payload.revision < appliedRevision.current) return
      appliedRevision.current = payload.revision
      setStatus(payload.status)
      // The local offer holds the one-time TOKEN (main never re-serves it),
      // but the pairing's existence is main's fact: cancelled or replaced
      // from any other surface, a dead QR must not stay on screen.
      setOffer((current) => (current && payload.status.pairing?.expiresAt === current.expiresAt ? current : null))
    })
  }, [])

  const outstandingPairing = status?.pairing ?? null
  const pendingRequestCount = status?.pairRequests.length ?? 0
  // The outward half — machines this Studio drives, requests it has made — from
  // the same pushed presence the Remote glyph reads, so this tab and the
  // popover cannot disagree.
  const presence = useTailnetPresence()
  const askingCount = presence.meshRequests.length

  // Only ticks while a countdown is on screen: an idle panel should not wake
  // once a second for a number nobody is looking at.
  useEffect(() => {
    if (!offer && !outstandingPairing && pendingRequestCount === 0 && askingCount === 0) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), EXPIRY_TICK_MS)
    return () => clearInterval(timer)
  }, [offer, outstandingPairing, pendingRequestCount, askingCount])

  const readiness = tailnetReadiness(status)
  const enabled = status?.enabled ?? false
  const busy = action.tone === 'busy'
  const pairRequests = status?.pairRequests ?? []

  // The scan is not a button any more. It was one because it shells out to
  // `tailscale status`, which felt like something to ask for — but the answer
  // is the LIST, and a list behind a button is a list a person has to be told
  // to fetch. It runs on mount and again whenever the listener's state moves,
  // which is the only thing that can change what a peer would answer.
  useEffect(() => {
    if (readiness.state === 'loading') return
    let cancelled = false
    void window.api
      .tailnetListPeers()
      .then((next) => {
        if (!cancelled) setScan(next)
      })
      .catch(() => {
        // Silent: the merged list still has every paired machine, and a red
        // band over a tab whose main content is fine would be the loudest
        // thing on it. A scan that failed shows as machines the tailnet knows
        // about being absent, which is what actually happened.
        if (!cancelled) setScan(null)
      })
    return () => {
      cancelled = true
    }
  }, [readiness.state])

  const machines = useMemo(
    () =>
      mergeMachines({
        // Only used when the scan produced no self row — Tailscale absent or
        // down — so the tab still says which machine you are sitting at.
        self: { name: 'This machine', os: hostPlatform() },
        devices: status?.devices ?? [],
        connections: presence.mesh,
        peers: scan?.peers ?? [],
        now,
      }),
    [status?.devices, presence.mesh, scan, now],
  )

  // The machines "Pair a device" can ask, in list order. Built here rather than
  // in the dialog because the endpoint needs the scan's address and port.
  const pairablePeers = useMemo(
    () =>
      scan
        ? machines
            .filter((machine) => pairRoute(machine).route === 'ask')
            .map((machine) => ({
              kind: 'peer' as const,
              endpoint: `${peerAddressOf(machine, scan)}:${scan.probedPort}`,
              machineName: machine.name,
            }))
        : [],
    [machines, scan],
  )

  const run = async (message: string, work: () => Promise<void>): Promise<void> => {
    setAction({ tone: 'busy', message })
    try {
      await work()
      setAction((current) => (current.tone === 'busy' ? { tone: 'idle', message: '' } : current))
    } catch (error) {
      setAction({ tone: 'error', message: describe(error, 'That did not work.') })
    }
  }

  const toggleEnabled = (next: boolean): Promise<void> =>
    run(next ? 'Starting the listener.' : 'Stopping the listener.', async () => {
      setStatus(await window.api.tailnetSetEnabled(next))
      // Turning it off drops any outstanding pairing in the main process; the
      // panel must not keep showing a code that no longer works.
      if (!next) setOffer(null)
    })

  const createPairing = (scopes: TailnetScope[], target: PairDeviceTarget): void => {
    setPairTarget(null)
    if (target.kind === 'peer') {
      // Both ways, always (owner ruling 2026-09-10): the same set is what we
      // ask for over there and what we grant back here.
      void run(`Asking ${target.machineName} to pair.`, async () => {
        const result = await window.api.meshRequestPairing(target.endpoint, {
          scopes,
          reverseScopes: scopes,
        })
        if (!result.ok) setAction({ tone: 'error', message: result.message })
      })
      return
    }
    void run('Creating a pairing code.', async () => {
      setPasteOpen(false)
      setOffer(await window.api.tailnetOfferPairing(scopes))
      setNow(Date.now())
      await refresh()
    })
  }

  const cancelPairing = (): Promise<void> =>
    run('Cancelling the pairing code.', async () => {
      setStatus(await window.api.tailnetCancelPairing())
      setOffer(null)
    })

  // Revoke ends BOTH halves: the device that machine holds here and the
  // credential this machine holds there. A row offering one Revoke that left
  // the other direction live is how a "revoked" machine kept answering.
  const forgetMachine = (machine: TailnetMachine): Promise<void> =>
    run(`Revoking ${machine.name}.`, async () => {
      const result = await window.api.tailnetForgetMachine({
        deviceId: machine.inbound?.deviceId,
        connectionId: machine.outbound?.connectionId,
      })
      setStatus(result.status)
    })

  const grantStandard = (machine: TailnetMachine): Promise<void> => {
    const deviceId = machine.inbound?.deviceId
    if (!deviceId) return Promise.resolve()
    return run(`Widening what ${machine.name} may do.`, async () => {
      setStatus(await window.api.tailnetUpdateDeviceScopes(deviceId, [...STANDARD_SCOPES]))
    })
  }

  // Pair by a carried link: the possession-based path for a machine with
  // nobody in front of it to approve a request.
  const pairByLink = (): Promise<void> => {
    const link = pairingLink.trim()
    if (!link) return Promise.resolve()
    return run('Pairing with that machine.', async () => {
      const result = await window.api.meshPair(link)
      if (!result.ok) {
        setAction({ tone: 'error', message: result.message })
        return
      }
      setPairingLink('')
      setPasteOpen(false)
      setAction({ tone: 'idle', message: `Paired with ${result.connection.machineName}.` })
    })
  }

  const copy = async (value: string, label: string): Promise<void> => {
    try {
      await window.api.clipboardWriteText(value)
      setAction({ tone: 'idle', message: `${label} copied.` })
    } catch {
      setAction({ tone: 'error', message: `Could not copy the ${label.toLowerCase()}.` })
    }
  }

  const pairing = offer ?? outstandingPairing

  return (
    <div role="tabpanel" id="settings-panel-remote" aria-labelledby="settings-tab-remote" className="space-y-5">
      {/* The listener's state is the page's only status word. No `label` on
          the dot: it sits beside text saying the same thing, which is exactly
          when the primitive asks to stay decorative. */}
      <SettingsPageHeader
        title="Remote"
        meta={
          <span className="inline-flex items-center gap-1.5">
            <StatusDot tone={readiness.tone} />
            {readiness.label}
          </span>
        }
      />

      {action.tone === 'error' ? (
        <InlineNotice tone="error">{action.message}</InlineNotice>
      ) : action.message ? (
        // Confirmations ("Pairing link copied.") need somewhere to land, or the
        // control that produced them looks like it did nothing.
        <p aria-live="polite" className="text-body leading-5 text-[color:var(--text-muted)]">
          {action.message}
        </p>
      ) : null}

      <SettingCard>
        <SettingToggle
          label="Remote control over your tailnet"
          enabled={enabled}
          onChange={(next) => void toggleEnabled(next)}
          // Turning it OFF stays available whatever the state; only turning it
          // ON is refused, and only when there is no tailnet to bind to.
          disabled={busy || (!enabled && !readiness.canTurnOn)}
          requirement={readiness.canTurnOn ? undefined : 'Needs Tailscale'}
        />
      </SettingCard>

      <section className="space-y-2">
        {pairing ? (
          <>
            {/* The header swaps rather than a second section appearing: the
                code IS what the Machines header is doing right now, and Cancel
                belongs where the action that started it stood. */}
            <SettingsSectionTitle
              action={
                <GhostButton size="xs" onClick={() => void cancelPairing()} disabled={busy}>
                  Cancel
                </GhostButton>
              }
            >
              Pair a device
            </SettingsSectionTitle>
            <PairingCodeCard
              offer={offer}
              pairing={outstandingPairing}
              now={now}
              onCopy={(value, label) => void copy(value, label)}
            />
          </>
        ) : (
          <SettingsSectionTitle
            count={machines.length}
            action={
              <SplitButton
                label="Pair a device"
                primaryAriaLabel="Pair a device"
                menuAriaLabel="More ways to pair"
                // One row, and it still earns the caret: "Paste a pairing link"
                // is another ROUTE to the same pairing, never another target,
                // so it can never become the primary (split-button, 2026-09-10).
                menuKind="alternatives"
                items={[
                  {
                    id: 'paste',
                    label: 'Paste a pairing link',
                    onSelect: () => setPasteOpen(true),
                  },
                ]}
                // A machine to ask comes first: asking needs nothing carried
                // between the two machines. The link is the fallback.
                onPrimary={() => setPairTarget(pairablePeers[0] ?? { kind: 'code' })}
              />
            }
          >
            Machines
          </SettingsSectionTitle>
        )}

        {pasteOpen && !pairing ? (
          <div className="flex items-center gap-2">
            <Input
              value={pairingLink}
              onChange={(event) => setPairingLink(event.target.value)}
              placeholder="sprintengine-tailnet://pair?…"
              aria-label="Pairing link"
              autoFocus
              onKeyDown={(event) => {
                if (isImeKey(event)) return
                if (event.key === 'Enter') void pairByLink()
                if (event.key === 'Escape') setPasteOpen(false)
              }}
            />
            <PrimaryButton size="md" onClick={() => void pairByLink()} disabled={!pairingLink.trim() || busy}>
              Pair
            </PrimaryButton>
          </div>
        ) : null}

        {/* A failed scan still leaves rows — this machine, and every machine
            already paired — so the reason cannot wait for an empty list. Shown
            that way, a scan that broke read exactly like a tailnet with no
            other Studio on it. */}
        {machines.length > 0 && scan?.unavailableReason ? (
          <p className="text-body leading-5 text-[color:var(--text-muted)]">{scan.unavailableReason}</p>
        ) : null}

        {machines.length > 0 ? (
          <MachineList ariaLabel="Machines">
            {machines.map((machine) => (
              <MachineRow
                key={machine.key}
                machine={machine}
                now={now}
                busy={busy}
                onPair={(target) =>
                  setPairTarget(pairablePeers.find((peer) => peer.machineName === target.name) ?? { kind: 'code' })
                }
                onRevoke={(target) => void forgetMachine(target)}
                onGrant={(target) => void grantStandard(target)}
              />
            ))}
          </MachineList>
        ) : (
          <p className="text-body leading-5 text-[color:var(--text-muted)]">
            {scan?.unavailableReason ?? 'No machines yet.'}
          </p>
        )}
      </section>

      {pairRequests.length > 0 ? (
        <section>
          <SettingsSectionTitle className="mb-1.5" count={pairRequests.length}>
            Waiting to be answered
          </SettingsSectionTitle>
          <SettingCard>
            {pairRequests.map((request) => (
              <PairRequestCard key={request.id} request={request} now={now} variant="flush" />
            ))}
          </SettingCard>
        </section>
      ) : null}

      {presence.meshRequests.length > 0 ? (
        <section>
          {/* Named for what the card under it is FOR. "Asking" described the
              state and hid the payload: each row carries the six digits the
              other machine is waiting to be told, and someone who has walked
              to that machine needs to find them by the heading alone. */}
          <SettingsSectionTitle className="mb-1.5" count={presence.meshRequests.length}>
            Waiting for another machine — with the code to type on it
          </SettingsSectionTitle>
          <SettingCard>
            {presence.meshRequests.map((request) => (
              <OutboundPairRequestCard key={request.requestId} request={request} now={now} variant="flush" />
            ))}
          </SettingCard>
        </section>
      ) : null}

      <PairDeviceModal
        open={pairTarget !== null}
        target={pairTarget ?? { kind: 'code' }}
        peers={pairablePeers}
        onClose={() => setPairTarget(null)}
        onCreate={createPairing}
        busy={busy}
      />
    </div>
  )
}

/** The scan row this machine came from, for the endpoint a request would dial. */
function peerAddressOf(machine: TailnetMachine, scan: TailnetPeerScan): string {
  const peer = scan.peers.find((candidate) => candidate.hostName === machine.name || candidate.dnsName === machine.key)
  return peer?.address ?? machine.name
}

/**
 * One pairing code, as a square and as a link.
 *
 * Both forms carry the same string. The square is for the common case — point
 * the other machine's camera at it — and the link is for every case a camera
 * cannot cover: a headless box, a remote session, a screen reader. The pills
 * are the point of the card: what this code will grant, in the same identifiers
 * the machine row's popover will show once it is redeemed.
 *
 * The footnote is not decoration. There are TWO pairing directions and they
 * produce different secrets: this card's offer is a LINK that the other machine
 * consumes, while a request that machine made produces six DIGITS shown on the
 * machine that asked (OutboundPairRequestCard). Someone being prompted for six
 * digits naturally comes here, finds a link, and concludes the app is broken —
 * which is exactly the report that prompted this line. Saying where the digits
 * actually are costs one sentence and ends the hunt.
 */
function PairingCodeCard({
  offer,
  pairing,
  now,
  onCopy,
}: {
  offer: TailnetPairingOfferView | null
  pairing: TailnetPairingState | null
  now: number
  onCopy: (value: string, label: string) => void
}) {
  const url = offer?.pairingUrl ?? null
  const matrix = useMemo(() => (url ? encodeQrCode(url) : null), [url])
  const scopes = offer?.scopes ?? pairing?.scopes ?? []
  const expiresAt = offer?.expiresAt ?? pairing?.expiresAt ?? null

  return (
    <div className="flex flex-wrap items-start gap-6 rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] p-4">
      {matrix ? <QrSquare matrix={matrix} label="Pairing code" /> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {offer ? (
          url ? (
            // No underline: one drawn under a mono URL collides with its
            // glyphs (design-system/components/link-button → Variants).
            <LinkButton
              underline="never"
              onClick={() => onCopy(url, 'Pairing link')}
              className="break-all font-mono"
              aria-label="Copy the pairing link"
            >
              {url}
            </LinkButton>
          ) : (
            <p className="text-body leading-5 text-[color:var(--text-muted)]">The listener is not running.</p>
          )
        ) : (
          // The token is returned once and never re-readable, so a panel
          // reopened over a live code knows one exists without knowing what it
          // says. Saying exactly that is the only honest option.
          <p className="text-body leading-5 text-[color:var(--text-muted)]">
            {pairing ? outstandingPairingNote(pairing, now) : null}
          </p>
        )}
        {expiresAt ? (
          <div className="text-meta text-[color:var(--text-muted)]">{pairingExpiry(expiresAt, now)}</div>
        ) : null}
        <p className="text-micro leading-4 text-[color:var(--text-subtle)]">
          Being asked for a six-digit code instead? That code is shown on the machine that asked, not here — read it off
          that screen and type it there.
        </p>
        {scopes.length > 0 ? (
          <ScopePillSet ariaLabel="Scopes in this code">
            {scopes.map((scope) => (
              <ScopePill key={scope} scope={scope} />
            ))}
          </ScopePillSet>
        ) : null}
        {url ? (
          <div>
            <OutlineButton size="sm" onClick={() => onCopy(url, 'Pairing link')}>
              Copy link
            </OutlineButton>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The symbol, drawn as one SVG path.
 *
 * The colours are literal black on white rather than theme tokens, and stay
 * that way in dark mode. A QR code is a machine-readable target before it is a
 * graphic: contrast and polarity are what make it scan, and a themed square on
 * a dark surface is a square a camera may refuse. The quiet zone is part of the
 * format, not padding we chose.
 */
export function QrSquare({ matrix, label }: { matrix: { size: number; modules: boolean[][] }; label: string }) {
  const QUIET_ZONE = 4
  const extent = matrix.size + QUIET_ZONE * 2
  const path = useMemo(() => {
    const segments: string[] = []
    for (let y = 0; y < matrix.size; y++) {
      for (let x = 0; x < matrix.size; x++) {
        if (matrix.modules[y][x]) segments.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`)
      }
    }
    return segments.join('')
  }, [matrix])

  return (
    <svg
      viewBox={`0 0 ${extent} ${extent}`}
      role="img"
      aria-label={label}
      className="h-32 w-32 shrink-0 rounded-sm"
      shapeRendering="crispEdges"
    >
      {/* design-tokens-allow: QR polarity is functional — a camera reads dark-on-light, so this square must not follow the theme */}
      <rect width={extent} height={extent} fill="#ffffff" />
      {/* design-tokens-allow: see above — themed modules on a dark surface are a square a scanner may refuse */}
      <path d={path} fill="#000000" />
    </svg>
  )
}

function describe(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}
