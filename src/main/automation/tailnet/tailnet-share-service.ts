import type { MobileControlWebTargetSnapshot } from '../../mobile/control/protocol'
import {
  EMPTY_TAILNET_SHARE_STATUS,
  type TailnetShareResult,
  type TailnetShareStatus,
  type TailnetShareView,
} from '../../../shared/tailnet-share'
import {
  allocateServePort,
  buildServeUrl,
  describeServeDiagnostic,
  readSelfDnsName,
  readServedPorts,
  SERVE_PORT_LADDER,
  shareLocalPort,
  unshareServePort,
  type TailscaleServeDeps,
} from './tailscale-serve'
import { integrationLedger, recordIntegrationWrite, type IntegrationWrite } from '../../integrations/ledger'

// The service the IPC layer calls: one place that turns the serve wrapper's
// primitives into the status document every client reads.
//
// It holds NO state. Serve config lives in tailscaled, survives a Studio
// restart, and can be changed from a terminal at any moment, so every call
// re-reads it. A remembered list would be a list that lies the first time
// someone runs `tailscale serve off` by hand.

export type TailnetShareService = {
  readStatus: () => Promise<TailnetShareStatus>
  share: (localPort: number) => Promise<TailnetShareResult>
  unshare: (servePort: number) => Promise<TailnetShareResult>
}

/** The ledger's record of one `tailscale serve --bg` mapping this app published. */
export function tailnetShareLedgerWrite(servePort: number, localPort: number): IntegrationWrite {
  return {
    kind: 'tailnet-share',
    path: `tailscale-serve:https:${servePort}`,
    marker: `http://localhost:${localPort}`,
    hostId: 'local',
    detail: { servePort, localPort },
  }
}

function isUsablePort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535
}

export function createTailnetShareService(deps: TailscaleServeDeps = {}): TailnetShareService {
  async function readStatus(): Promise<TailnetShareStatus> {
    const dnsName = await readSelfDnsName(deps)
    if (!dnsName) return EMPTY_TAILNET_SHARE_STATUS
    const served = await readServedPorts(deps)
    const shares: TailnetShareView[] = []
    for (const [servePort, localPort] of served) {
      shares.push({ localPort, servePort, url: buildServeUrl(dnsName, servePort) })
    }
    shares.sort((left, right) => left.localPort - right.localPort)
    return {
      available: true,
      dnsName,
      shares,
      ladderFull: SERVE_PORT_LADDER.every((port) => served.has(port)),
    }
  }

  async function refuse(message: string): Promise<TailnetShareResult> {
    return { ok: false, message, status: await readStatus() }
  }

  return {
    readStatus,

    async share(localPort: number): Promise<TailnetShareResult> {
      if (!isUsablePort(localPort)) return refuse('That is not a port this machine can share.')
      const dnsName = await readSelfDnsName(deps)
      if (!dnsName) return refuse(describeServeDiagnostic('unavailable'))
      const served = await readServedPorts(deps)
      const servePort = allocateServePort(served, localPort)
      if (servePort === null) {
        return refuse(
          `This machine is already sharing ${SERVE_PORT_LADDER.length} ports. Stop sharing one before starting another.`,
        )
      }
      const result = await shareLocalPort({ localPort, servePort }, deps)
      if (!result.ok) return refuse(result.message)
      // `--bg` outlives the app, so the mapping is listed for the removal of the
      // app's integrations — which takes down only ports recorded here.
      recordIntegrationWrite(tailnetShareLedgerWrite(servePort, localPort))
      return { ok: true, share: result.share, status: await readStatus() }
    },

    async unshare(servePort: number): Promise<TailnetShareResult> {
      if (!isUsablePort(servePort)) return refuse('That is not a port this machine is sharing.')
      // Only ports this app could have handed out are ours to withdraw: a serve
      // mapping someone configured by hand — the tailnet front door included —
      // is not Studio's to take down.
      if (!SERVE_PORT_LADDER.includes(servePort)) {
        return refuse('That port was not shared from Studio, so Studio will not stop it.')
      }
      const result = await unshareServePort({ servePort }, deps)
      if (!result.ok) return refuse(result.message)
      void integrationLedger()
        ?.forgetWhere((entry) => entry.kind === 'tailnet-share' && entry.detail?.servePort === servePort)
        .catch(() => undefined)
      return { ok: true, share: null, status: await readStatus() }
    },
  }
}

/**
 * The shares, as the web targets a phone's snapshot carries.
 *
 * The label is the loopback port rather than the process name: the command that
 * owns a port is a per-workspace scan the browser pane runs while someone is
 * looking at it, and a snapshot read must not depend on a window being open.
 * `localhost:5173` on a named machine is already unambiguous.
 *
 * Never throws. A snapshot that cannot reach Tailscale is a snapshot with no
 * web targets, not a failed snapshot.
 */
export async function readTailnetWebTargets(service: TailnetShareService): Promise<MobileControlWebTargetSnapshot[]> {
  try {
    const status = await service.readStatus()
    if (!status.available || !status.dnsName) return []
    const machine = status.dnsName
    return status.shares.map((share) => ({
      id: `serve:${share.servePort}`,
      label: `localhost:${share.localPort}`,
      url: share.url,
      localPort: share.localPort,
      machine,
    }))
  } catch {
    return []
  }
}
