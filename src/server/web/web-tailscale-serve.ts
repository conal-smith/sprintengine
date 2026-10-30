import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { runTailscale } from '../../main/automation/tailnet/tailscale-cli'
import {
  describeServeDiagnostic,
  SERVE_PORT_LADDER,
  shareLocalPort,
  unshareServePort,
  type TailscaleServeDeps,
} from '../../main/automation/tailnet/tailscale-serve'
import { isRecord } from '../../shared/records'
import { writeFileAtomicSync } from '../platform/atomic-file'

// The web client on the tailnet, over HTTPS (R19; phase 9 spec, 6.6).
// `studio-server serve --web --tailscale-serve` asks tailscaled to publish the
// loopback listener at `https://<node>.<tailnet>.ts.net`: serve terminates TLS
// with a real certificate and proxies to loopback, so the listener never
// leaves loopback and the tailnet never sees plain HTTP. The name it publishes
// becomes one of the listener's origins.
//
// The port is serve's front door, 443, unless asked otherwise; the dev-server
// shares' ports are refused, so the two never take each other's. A port
// already serving something on this machine is left alone and the server does
// not start: someone else's serve configuration is not this server's to
// replace. The exception is this server's own mapping from an earlier run
// (recorded in `run/web-tailscale.json`), which a crash can leave behind
// pointing at a port the listener no longer holds.
//
// "Something else" is anything serve holds on the port beyond one root proxy
// to this listener: another root target, a handler on a path, a raw TCP
// forward, or funnel. `serve --https=<n> <target>` replaces the root of a
// port and `serve --https=<n> off` clears the whole port, so a port that
// carries more than our one mapping is never written to; and a port with
// funnel on would publish Studio on the internet, which R19 forbids.
//
// On a clean stop the mapping is turned off, and only while it is still this
// run's listener alone on the port.

export const DEFAULT_TAILSCALE_SERVE_PORT = 443
const RECORD_FILENAME = 'web-tailscale.json'

type ServeRecord = { servePort: number; localPort: number }

export type WebTailscaleServe = {
  /** `https://<node>.<tailnet>.ts.net[:port]`, the origin serve publishes. */
  origin: string
  servePort: number
  /** Turn the mapping off, if it is still this run's. */
  stop(): Promise<void>
}

export function checkTailscaleServePort(port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '--tailscale-serve-port takes a port number.'
  if (SERVE_PORT_LADDER.includes(port))
    return `--tailscale-serve-port ${port} is one of the ports Studio shares dev servers on. Pick another, such as 443.`
  return null
}

function readRecord(runDir: string): ServeRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(join(runDir, RECORD_FILENAME), 'utf8')) as Partial<ServeRecord>
    return Number.isInteger(parsed.servePort) && Number.isInteger(parsed.localPort)
      ? { servePort: parsed.servePort!, localPort: parsed.localPort! }
      : null
  } catch {
    return null
  }
}

function writeRecord(runDir: string, record: ServeRecord): void {
  writeFileAtomicSync(join(runDir, RECORD_FILENAME), `${JSON.stringify(record)}\n`, { mode: 0o600 })
}

function forgetRecord(runDir: string): void {
  try {
    unlinkSync(join(runDir, RECORD_FILENAME))
  } catch {
    // Already gone.
  }
}

const SERVE_STATUS_TIMEOUT_MS = 4000

/** What serve holds on one HTTPS port, read from `tailscale serve status --json`. */
export type ServePortUse = {
  /** The loopback port the root of the port proxies to, when it does. */
  rootLoopbackPort: number | null
  /** Anything else on the port: a path handler, a non-loopback or non-proxy root, a TCP forward. */
  others: boolean
  /** Funnel is on for the port: what it serves is on the internet. */
  funnel: boolean
}

/** Exported for the test: one port's use across serve's config, its foreground sessions included. */
export function servePortUse(raw: string, servePort: number): ServePortUse {
  const use: ServePortUse = { rootLoopbackPort: null, others: false, funnel: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Unreadable is not "free": the caller refuses.
    return { ...use, others: true }
  }
  if (!isRecord(parsed)) return use
  const configs: Record<string, unknown>[] = [parsed]
  if (isRecord(parsed.Foreground))
    for (const value of Object.values(parsed.Foreground)) if (isRecord(value)) configs.push(value)
  const onPort = (key: string) => key.slice(key.lastIndexOf(':') + 1) === String(servePort)
  for (const config of configs) {
    if (isRecord(config.TCP)) {
      const tcp = config.TCP[String(servePort)]
      // `HTTPS: true` is what a web handler on the port looks like; anything else forwards raw TCP.
      if (isRecord(tcp) && (tcp.HTTPS !== true || tcp.TCPForward !== undefined)) use.others = true
    }
    if (isRecord(config.AllowFunnel)) {
      for (const [key, on] of Object.entries(config.AllowFunnel)) if (onPort(key) && on === true) use.funnel = true
    }
    if (!isRecord(config.Web)) continue
    for (const [key, entry] of Object.entries(config.Web)) {
      if (!onPort(key)) continue
      const handlers = isRecord(entry) && isRecord(entry.Handlers) ? entry.Handlers : {}
      for (const [path, handler] of Object.entries(handlers)) {
        const rootPort =
          path === '/' && isRecord(handler) && typeof handler.Proxy === 'string' ? loopbackPortOf(handler.Proxy) : null
        if (rootPort !== null && use.rootLoopbackPort === null) use.rootLoopbackPort = rootPort
        else use.others = true
      }
    }
  }
  return use
}

function loopbackPortOf(proxy: string): number | null {
  let url: URL
  try {
    url = new URL(proxy)
  } catch {
    return null
  }
  if (url.protocol !== 'http:') return null
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') return null
  if (url.pathname !== '/' && url.pathname !== '') return null
  const port = Number(url.port)
  return Number.isInteger(port) && port > 0 ? port : null
}

async function readServePortUse(servePort: number, deps?: TailscaleServeDeps): Promise<ServePortUse | null> {
  const read = deps?.read ?? runTailscale
  const raw = await read(['serve', 'status', '--json'], SERVE_STATUS_TIMEOUT_MS)
  return raw === null ? null : servePortUse(raw, servePort)
}

export async function serveWebOnTailnet(input: {
  localPort: number
  servePort: number
  /** The data directory's owner-only `run/`. */
  runDir: string
  log?: (message: string) => void
  deps?: TailscaleServeDeps
}): Promise<WebTailscaleServe> {
  const { localPort, servePort, runDir } = input
  const use = await readServePortUse(servePort, input.deps)
  if (use === null) throw new Error(describeServeDiagnostic('unavailable'))
  if (use.funnel)
    throw new Error(
      `Tailscale funnel is on for HTTPS port ${servePort} of this machine, which would put Studio on the internet. ` +
        `Pick another port with --tailscale-serve-port, or turn funnel off with: tailscale funnel --https=${servePort} off`,
    )
  const current = use.rootLoopbackPort
  if (use.others || (current !== null && current !== localPort)) {
    const recorded = readRecord(runDir)
    const ours = !use.others && recorded?.servePort === servePort && recorded.localPort === current
    if (!ours)
      throw new Error(
        `Tailscale already serves something else on HTTPS port ${servePort} of this machine. ` +
          `Pick another with --tailscale-serve-port, or turn that off with: tailscale serve --https=${servePort} off`,
      )
    input.log?.(`[web] replacing this server's own tailscale serve mapping from an earlier run on port ${servePort}`)
  }
  // The web listener binds 127.0.0.1 (web-listener.ts), so its address is
  // named rather than left to whatever `localhost` resolves to first.
  const shared = await shareLocalPort({ localPort, servePort, localHost: '127.0.0.1' }, input.deps)
  if (!shared.ok) throw new Error(shared.message)
  writeRecord(runDir, { servePort, localPort })
  const origin = new URL(shared.share.url).origin
  input.log?.(`[web] tailscale serve publishes the web client at ${origin}`)
  let stopped = false
  return {
    origin,
    servePort,
    async stop() {
      if (stopped) return
      stopped = true
      const now = await readServePortUse(servePort, input.deps)
      // Someone pointed the port elsewhere, or added to it, since: `off`
      // would clear what is theirs, so the port is left as it is.
      if (now !== null && (now.rootLoopbackPort !== localPort || now.others || now.funnel)) {
        if (readRecord(runDir)?.localPort === localPort) forgetRecord(runDir)
        if (now.rootLoopbackPort === localPort)
          input.log?.(`[web] tailscale serve on port ${servePort} carries more than Studio now; left on`)
        return
      }
      const result = await unshareServePort({ servePort }, input.deps)
      if (result.ok) forgetRecord(runDir)
      else input.log?.(`[web] tailscale serve on port ${servePort} was not turned off: ${result.message}`)
    },
  }
}
