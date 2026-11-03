import { readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

import { servePortUse } from '../../../server/web/web-tailscale-serve'
import { runTailscale } from './tailscale-cli'
import { describeServeDiagnostic, shareLocalPort, unshareServePort, type TailscaleServeDeps } from './tailscale-serve'

// HTTPS for the tailnet listener, through Tailscale Serve.
//
// OAuth wants its endpoints on HTTPS, and MCP clients that sign in with it
// increasingly insist. The listener itself speaks plain HTTP on the tailnet
// address (the tailnet is WireGuard end to end, so nothing on it is in the
// clear between nodes, but a client cannot see that). `tailscale serve`
// terminates TLS with the tailnet's own certificate for
// `https://<node>.<tailnet>.ts.net` and proxies to a loopback listener the
// gateway opens for it; the gateway then answers there as it does on the
// tailnet address, with the caller's node taken from what Serve forwards.
//
// The front door is HTTPS port 443, the one the dev-server shares keep clear
// of (`SERVE_PORT_LADDER`). It is a write to machine state that outlives the
// app (`--bg`), so it is only made on a port that is free or already this
// Studio's, never on one that serves something else, and never on one with
// funnel on, which would put Studio on the internet. The mapping is recorded
// so that one a crash left behind, pointing at a loopback port nothing listens
// on any more, is recognised as this Studio's to replace. Turned off, it is
// removed only while it is still the one this Studio made.

export const TAILNET_HTTPS_SERVE_PORT = 443
const RECORD_FILENAME = 'tailnet-https-serve.json'
const SERVE_STATUS_TIMEOUT_MS = 4000

type ServeRecord = { servePort: number; localPort: number }

export type GatewayHttpsResult = { ok: true; origin: string } | { ok: false; message: string }

function readRecord(dir: string): ServeRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, RECORD_FILENAME), 'utf8')) as Partial<ServeRecord>
    return Number.isInteger(parsed.servePort) && Number.isInteger(parsed.localPort)
      ? { servePort: parsed.servePort!, localPort: parsed.localPort! }
      : null
  } catch {
    return null
  }
}

function forgetRecord(dir: string): void {
  try {
    unlinkSync(join(dir, RECORD_FILENAME))
  } catch {
    // Already gone.
  }
}

async function readUse(servePort: number, deps?: TailscaleServeDeps) {
  const read = deps?.read ?? runTailscale
  const raw = await read(['serve', 'status', '--json'], SERVE_STATUS_TIMEOUT_MS)
  return raw === null ? null : servePortUse(raw, servePort)
}

/** Publish the gateway's loopback listener at `https://<node>.<tailnet>.ts.net`. */
export async function publishGatewayOverHttps(input: {
  localPort: number
  /** Where the record of this Studio's mapping is kept (its user-data directory). */
  recordDir: string
  servePort?: number
  deps?: TailscaleServeDeps
  log?: (message: string) => void
}): Promise<GatewayHttpsResult> {
  const servePort = input.servePort ?? TAILNET_HTTPS_SERVE_PORT
  const use = await readUse(servePort, input.deps)
  if (use === null) return { ok: false, message: describeServeDiagnostic('unavailable') }
  if (use.funnel)
    return {
      ok: false,
      message: `Tailscale funnel is on for HTTPS port ${servePort} of this machine, which would put Studio on the internet. Turn funnel off there (tailscale funnel --https=${servePort} off) to use HTTPS.`,
    }
  const current = use.rootLoopbackPort
  if (use.others || (current !== null && current !== input.localPort)) {
    const recorded = readRecord(input.recordDir)
    const ours = !use.others && recorded?.servePort === servePort && recorded.localPort === current
    if (!ours)
      return {
        ok: false,
        message: `Tailscale already serves something else on HTTPS port ${servePort} of this machine, so Studio leaves it alone. Turn that off (tailscale serve --https=${servePort} off) to use HTTPS here.`,
      }
    input.log?.(`tailnet HTTPS: replacing this Studio's own serve mapping from an earlier run on port ${servePort}`)
  }
  const shared = await shareLocalPort({ localPort: input.localPort, servePort, localHost: '127.0.0.1' }, input.deps)
  if (!shared.ok) return { ok: false, message: shared.message }
  try {
    writeFileSync(
      join(input.recordDir, RECORD_FILENAME),
      `${JSON.stringify({ servePort, localPort: input.localPort })}\n`,
      { mode: 0o600 },
    )
  } catch (error) {
    input.log?.(`tailnet HTTPS: the serve mapping was made but not recorded: ${String(error)}`)
  }
  return { ok: true, origin: new URL(shared.share.url).origin }
}

/** Take the mapping down, if it is still the one this Studio made for `localPort`. */
export async function withdrawGatewayHttps(input: {
  localPort: number
  recordDir: string
  servePort?: number
  deps?: TailscaleServeDeps
  log?: (message: string) => void
}): Promise<void> {
  const servePort = input.servePort ?? TAILNET_HTTPS_SERVE_PORT
  const use = await readUse(servePort, input.deps)
  if (use === null) return
  if (use.rootLoopbackPort !== input.localPort || use.others || use.funnel) {
    // Pointed elsewhere, or added to, since: turning the port off would clear
    // what is someone else's.
    if (readRecord(input.recordDir)?.localPort === input.localPort) forgetRecord(input.recordDir)
    return
  }
  const result = await unshareServePort({ servePort }, input.deps)
  if (result.ok) forgetRecord(input.recordDir)
  else input.log?.(`tailnet HTTPS: the serve mapping on port ${servePort} was not turned off: ${result.message}`)
}

/**
 * Take down a mapping an earlier run recorded and did not get to remove (it
 * crashed, or was killed), while HTTPS is not wanted now. Left up, Serve would
 * keep forwarding tailnet callers, tokens and all, to a loopback port nothing
 * of Studio's listens on any more, which any process here could take. Asks
 * Tailscale nothing when there is no record.
 */
export async function withdrawRecordedGatewayHttps(input: {
  recordDir: string
  deps?: TailscaleServeDeps
  log?: (message: string) => void
}): Promise<void> {
  const recorded = readRecord(input.recordDir)
  if (!recorded) return
  input.log?.(`tailnet HTTPS: removing the serve mapping an earlier run left on port ${recorded.servePort}`)
  await withdrawGatewayHttps({ ...input, localPort: recorded.localPort, servePort: recorded.servePort })
}
