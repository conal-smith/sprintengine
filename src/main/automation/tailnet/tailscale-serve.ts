import { isRecord } from '../../../shared/records'
import { parseTailscaleStatus } from './tailnet-peers'
import { runTailscale, runTailscaleResult, type TailscaleRun } from './tailscale-cli'

// Turning a dev server on THIS machine into a URL the rest of the tailnet can
// open — the read side of remote control's promise, where the listener
// was the write side.
//
// The mechanism is `tailscale serve`, and the reason it is the right one is
// binding. A dev server listens on loopback by default; the usual advice is to
// pass `--host` so it binds 0.0.0.0, which also exposes it to whatever coffee-shop
// LAN the laptop is on. `tailscale serve` never asks the dev server to move:
// tailscaled proxies to loopback from inside the machine and publishes the result
// at `https://<node>.<tailnet>.ts.net`. Loopback stays loopback, and the only
// audience is the tailnet.
//
// It also answers a question the phone's tailnet transport raised: whether iOS
// ATS refuses a cleartext `http://100.x:8471` fetch from a release build. Serve terminates real TLS with a real WebPKI cert for
// the `.ts.net` name, so ATS has nothing to object to and the app's plist is
// never touched.
//
// Everything here is a WRITE to machine state that outlives the app, so every
// failure is reported as itself and none is guessed at. See the stderr note on
// `classifyServeStderr` for the one rule that must not be relaxed.

/** `serve` reconfigures the daemon; it is local, but it is not instant. */
const SERVE_TIMEOUT_MS = 10_000
/** Reading back what is served is a plain local query. */
const SERVE_STATUS_TIMEOUT_MS = 4000
const STATUS_TIMEOUT_MS = 4000
const STATUS_MAX_BUFFER_BYTES = 8 * 1024 * 1024

/**
 * HTTPS ports we hand out, in order.
 *
 * One serve port maps to one target, so N shared dev servers need N ports. The
 * alternative — mounting them as paths under one port (`--set-path=/app`) — is
 * rejected on purpose: a Vite or Next dev server emits absolute asset paths
 * (`/@vite/client`, `/_next/…`), and those 404 under a path prefix. A port per
 * server keeps every URL a root URL, which is the only shape a dev server
 * reliably works at.
 *
 * 443 is deliberately NOT in this ladder: it is the tailnet's front door and
 * belongs to the Studio gateway, not to whichever dev server was shared first.
 */
export const SERVE_PORT_LADDER: readonly number[] = [8443, 10000, 8444, 8445, 8446, 8447]

/**
 * What went wrong, as a label that is safe to log and specific enough to act on.
 */
export type TailscaleServeDiagnostic =
  | 'unavailable'
  | 'not-logged-in'
  | 'https-not-enabled'
  | 'permission-denied'
  | 'port-unavailable'
  | 'no-existing-handler'
  | 'timeout'
  | 'unknown'

export type TailscaleShare = {
  /** The loopback port the dev server is actually listening on. */
  localPort: number
  /** The HTTPS port serve published it at. */
  servePort: number
  /** `https://<node>.<tailnet>.ts.net[:port]` — what a phone opens. */
  url: string
}

export type TailscaleServeFailure = {
  ok: false
  diagnostic: TailscaleServeDiagnostic
  /** A sentence for the UI. Never contains Tailscale's stderr. */
  message: string
}

export type TailscaleShareResult = { ok: true; share: TailscaleShare } | TailscaleServeFailure

/**
 * Matched against stderr, most specific first, anchored on Tailscale's wording.
 *
 * THE TEXT ITSELF NEVER LEAVES THIS FILE. Tailscale writes auth keys
 * (`tskey-…`), node names and tailnet names into stderr, and this app logs its
 * diagnostics and ships them to the renderer. Classifying to a fixed label and
 * dropping the text is the only thing standing between a serve failure and a
 * credential in a log file. Add patterns here; never add a branch that returns
 * the raw string.
 */
const STDERR_PATTERNS: ReadonlyArray<readonly [RegExp, TailscaleServeDiagnostic]> = [
  [
    /https:\/\/tailscale\.com\/s\/https|https is not enabled|enable https|certificate.*not.*enabled/i,
    'https-not-enabled',
  ],
  [/not logged in|logged out|needs? login|no valid node key/i, 'not-logged-in'],
  [/permission denied|access denied|must be root|operation not permitted|not permitted/i, 'permission-denied'],
  [/address already in use|port.*in use|already serving|conflict/i, 'port-unavailable'],
  [/handler does not exist|no handler|not currently serving/i, 'no-existing-handler'],
  [/failed to connect|cannot connect|is tailscaled running|connection refused/i, 'unavailable'],
]

export function classifyServeStderr(stderr: string): TailscaleServeDiagnostic {
  for (const [pattern, diagnostic] of STDERR_PATTERNS) {
    if (pattern.test(stderr)) return diagnostic
  }
  return 'unknown'
}

/** The sentence a person reads, chosen by label so no Tailscale text is echoed. */
export function describeServeDiagnostic(diagnostic: TailscaleServeDiagnostic): string {
  switch (diagnostic) {
    case 'unavailable':
      return 'Tailscale is not running on this machine.'
    case 'not-logged-in':
      return 'This machine is signed out of Tailscale. Sign in, then share again.'
    case 'https-not-enabled':
      return 'HTTPS certificates are off for this tailnet. Turn on HTTPS in the Tailscale admin console (DNS → HTTPS Certificates), then share again.'
    case 'permission-denied':
      return 'Tailscale refused the change on this machine. Sharing a port needs an account that can reconfigure Tailscale.'
    case 'port-unavailable':
      return 'That HTTPS port is already serving something else on this machine.'
    case 'no-existing-handler':
      return 'Nothing was being served on that port.'
    case 'timeout':
      return 'Tailscale did not answer in time.'
    case 'unknown':
      return 'Tailscale refused the change and did not say why.'
  }
}

function failureFrom(run: Extract<TailscaleRun, { ok: false }>): TailscaleServeFailure {
  const diagnostic = run.timedOut ? 'timeout' : classifyServeStderr(run.stderr)
  return { ok: false, diagnostic, message: describeServeDiagnostic(diagnostic) }
}

export type TailscaleServeDeps = {
  run?: (args: readonly string[], timeoutMs: number, maxBuffer?: number) => Promise<TailscaleRun>
  read?: (args: readonly string[], timeoutMs: number, maxBuffer?: number) => Promise<string | null>
}

/**
 * This machine's MagicDNS name (`node.tailnet.ts.net`), or null.
 *
 * Read from the same `tailscale status --json` the peer scanner parses, through
 * the same parser, so the name in a share URL and the name in the machine picker
 * can never disagree.
 */
export async function readSelfDnsName(deps: TailscaleServeDeps = {}): Promise<string | null> {
  const read = deps.read ?? runTailscale
  const raw = await read(['status', '--json'], STATUS_TIMEOUT_MS, STATUS_MAX_BUFFER_BYTES)
  if (raw === null) return null
  const parsed = parseTailscaleStatus(raw)
  if (!parsed.ok || !parsed.backendRunning) return null
  return parsed.peers.find((peer) => peer.isSelf)?.dnsName ?? null
}

/** `https://<name>` for 443, `https://<name>:<port>` otherwise. */
export function buildServeUrl(dnsName: string, servePort: number): string {
  return servePort === 443 ? `https://${dnsName}/` : `https://${dnsName}:${servePort}/`
}

/**
 * Publish a loopback port on the tailnet.
 *
 * `--bg` is what makes the mapping outlive this process: serve keeps running
 * when Studio quits, which is deliberate — a shared dev server should not
 * disappear because the window closed — and is why `unshareServePort` exists as
 * a first-class action rather than a teardown hook.
 */
export async function shareLocalPort(
  input: { localPort: number; servePort: number; localHost?: string },
  deps: TailscaleServeDeps = {},
): Promise<TailscaleShareResult> {
  const run = deps.run ?? runTailscaleResult
  // `localhost`, not `127.0.0.1`: a dev server bound to "localhost" by a Node
  // release that prefers IPv6 listens on `::1` alone, and tailscaled (Go)
  // dials every address the name resolves to where a literal tries only one.
  const localHost = input.localHost ?? 'localhost'
  const dnsName = await readSelfDnsName(deps)
  if (!dnsName) {
    return { ok: false, diagnostic: 'unavailable', message: describeServeDiagnostic('unavailable') }
  }
  const result = await run(
    ['serve', '--bg', `--https=${input.servePort}`, `http://${localHost}:${input.localPort}`],
    SERVE_TIMEOUT_MS,
  )
  if (!result.ok) return failureFrom(result)
  return {
    ok: true,
    share: { localPort: input.localPort, servePort: input.servePort, url: buildServeUrl(dnsName, input.servePort) },
  }
}

/** Take a port back off the tailnet. */
export async function unshareServePort(
  input: { servePort: number },
  deps: TailscaleServeDeps = {},
): Promise<{ ok: true } | TailscaleServeFailure> {
  const run = deps.run ?? runTailscaleResult
  const result = await run(['serve', `--https=${input.servePort}`, 'off'], SERVE_TIMEOUT_MS)
  if (!result.ok) {
    const failure = failureFrom(result)
    // Turning off something that was already off is the state the caller wanted.
    return failure.diagnostic === 'no-existing-handler' ? { ok: true } : failure
  }
  return { ok: true }
}

/**
 * What this machine is serving right now, keyed by HTTPS port.
 *
 * Serve state lives in the daemon, not in this app, so it survives a restart and
 * can be changed by `tailscale` on the command line. Reading it back — rather
 * than trusting a remembered list — is what keeps the UI honest about a share
 * someone turned off elsewhere.
 */
export async function readServedPorts(deps: TailscaleServeDeps = {}): Promise<Map<number, number>> {
  const read = deps.read ?? runTailscale
  const raw = await read(['serve', 'status', '--json'], SERVE_STATUS_TIMEOUT_MS)
  if (raw === null) return new Map()
  return parseServedPorts(raw)
}

/**
 * `readServedPorts`, but null when Tailscale did not answer — for a caller
 * that must not read "could not ask" as "nothing is served" (the removal of
 * the app's own shares, which would otherwise forget a share that is live).
 */
export async function readServedPortsOrNull(deps: TailscaleServeDeps = {}): Promise<Map<number, number> | null> {
  const read = deps.read ?? runTailscale
  const raw = await read(['serve', 'status', '--json'], SERVE_STATUS_TIMEOUT_MS)
  return raw === null ? null : parseServedPorts(raw)
}

/**
 * Exported for the test: the shape is Tailscale's, so pinning our reading of it
 * is the only way to notice if we are reading it wrong.
 *
 * `Web` is keyed `"<host>:<port>"` and each entry's handlers carry a `Proxy`
 * target. Only handlers mounted at the root and proxying to loopback are ours;
 * anything else on the machine is someone else's serve config and is left alone.
 */
export function parseServedPorts(raw: string): Map<number, number> {
  const served = new Map<number, number>()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return served
  }
  if (!isRecord(parsed) || !isRecord(parsed.Web)) return served
  for (const [hostPort, entry] of Object.entries(parsed.Web)) {
    const servePort = Number(hostPort.slice(hostPort.lastIndexOf(':') + 1))
    if (!Number.isInteger(servePort) || servePort <= 0) continue
    if (!isRecord(entry) || !isRecord(entry.Handlers)) continue
    const root = entry.Handlers['/']
    if (!isRecord(root) || typeof root.Proxy !== 'string') continue
    const localPort = readLoopbackPort(root.Proxy)
    if (localPort !== null) served.set(servePort, localPort)
  }
  return served
}

function readLoopbackPort(proxy: string): number | null {
  let url: URL
  try {
    url = new URL(proxy)
  } catch {
    return null
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '::1') return null
  const port = Number(url.port)
  return Number.isInteger(port) && port > 0 ? port : null
}

/**
 * The first ladder port not already in use, or null when the ladder is full.
 *
 * A port already pointing at THIS local port is reused rather than skipped, so
 * sharing the same dev server twice is idempotent instead of consuming the
 * ladder.
 */
export function allocateServePort(served: ReadonlyMap<number, number>, localPort: number): number | null {
  for (const [servePort, target] of served) {
    if (target === localPort && SERVE_PORT_LADDER.includes(servePort)) return servePort
  }
  return SERVE_PORT_LADDER.find((port) => !served.has(port)) ?? null
}
