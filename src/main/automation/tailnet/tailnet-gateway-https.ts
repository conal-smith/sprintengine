import { execFileSync } from 'child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

import { servePortUse } from '../../../server/web/web-tailscale-serve'
import { runTailscale, spawnTailscaleUntilStopped } from './tailscale-cli'
import {
  buildServeUrl,
  classifyServeStderr,
  describeServeDiagnostic,
  readSelfDnsName,
  unshareServePort,
  type TailscaleServeDeps,
} from './tailscale-serve'

// HTTPS for the tailnet listener, through Tailscale Serve.
//
// OAuth wants its endpoints on HTTPS, and MCP clients that sign in with it
// insist. The listener itself speaks plain HTTP on the tailnet address (the
// tailnet is WireGuard end to end, so nothing on it is in the clear between
// nodes, but a client cannot see that). `tailscale serve` terminates TLS with
// the tailnet's own certificate for `https://<node>.<tailnet>.ts.net` and
// proxies to a loopback listener the gateway opens for it, which answers the
// OAuth routes and OAuth clients' MCP requests and nothing else.
//
// The mapping runs in the FOREGROUND, as a child of Studio, never with
// `--bg`: a foreground mapping lasts exactly as long as its `tailscale serve`
// process, and that process is made to die with Studio
// (`spawnTailscaleUntilStopped`). A background one would outlive a crash and
// keep forwarding tailnet callers, tokens and all, to a loopback port that any
// process here could then take. (A Unix socket target would close that gap
// too, but Serve requires root to proxy to one on most installs.)
//
// The front door is HTTPS port 443, the one the dev-server shares keep clear
// of (`SERVE_PORT_LADDER`). It is only taken when free, never from something
// else serving there, and never with Funnel on, which would put Studio on the
// internet. The child's pid is recorded so that a next start can end one a
// crash on a platform without the watchdog left running, and a background
// mapping an older build recorded is removed the same way.

export const TAILNET_HTTPS_SERVE_PORT = 443
const RECORD_FILENAME = 'tailnet-https-serve.json'
const SERVE_STATUS_TIMEOUT_MS = 4000
/** How long the foreground serve has to appear in Serve's status before it counts as failed. */
const PUBLISH_DEADLINE_MS = 10_000
const PUBLISH_POLL_MS = 300

type ServeRecord = { servePort: number; localPort: number; pid?: number }

export type GatewayHttps = { origin: string; stop: () => Promise<void> }
export type GatewayHttpsResult = ({ ok: true } & GatewayHttps) | { ok: false; message: string }

/** What publishing needs from the outside world; tests stand each in. */
export type GatewayHttpsDeps = TailscaleServeDeps & {
  spawn?: typeof spawnTailscaleUntilStopped
  /** Whether a pid is a `tailscale serve` this Studio started (POSIX: asks `ps`). */
  isOurServe?: (pid: number) => boolean
  kill?: (pid: number) => void
}

function readRecord(dir: string): ServeRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, RECORD_FILENAME), 'utf8')) as Partial<ServeRecord>
    if (!Number.isInteger(parsed.servePort) || !Number.isInteger(parsed.localPort)) return null
    return {
      servePort: parsed.servePort!,
      localPort: parsed.localPort!,
      ...(Number.isInteger(parsed.pid) ? { pid: parsed.pid } : {}),
    }
  } catch {
    return null
  }
}

function writeRecord(dir: string, record: ServeRecord, log?: (message: string) => void): void {
  try {
    writeFileSync(join(dir, RECORD_FILENAME), `${JSON.stringify(record)}\n`, { mode: 0o600 })
  } catch (error) {
    log?.(`tailnet HTTPS: the serve mapping was made but not recorded: ${String(error)}`)
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

/** Publish the gateway's loopback listener at `https://<node>.<tailnet>.ts.net`, for as long as `stop` is not called. */
export async function publishGatewayOverHttps(input: {
  localPort: number
  /** Where the record of this Studio's mapping is kept (its user-data directory). */
  recordDir: string
  servePort?: number
  deps?: GatewayHttpsDeps
  log?: (message: string) => void
}): Promise<GatewayHttpsResult> {
  const servePort = input.servePort ?? TAILNET_HTTPS_SERVE_PORT
  const deps = input.deps ?? {}
  const dnsName = await readSelfDnsName(deps)
  if (!dnsName) return { ok: false, message: describeServeDiagnostic('unavailable') }
  const use = await readUse(servePort, deps)
  if (use === null) return { ok: false, message: describeServeDiagnostic('unavailable') }
  if (use.funnel)
    return {
      ok: false,
      message: `Tailscale funnel is on for HTTPS port ${servePort} of this machine, which would put Studio on the internet. Turn funnel off there (tailscale funnel --https=${servePort} off) to use HTTPS.`,
    }
  if (use.others || use.rootLoopbackPort !== null)
    return {
      ok: false,
      message: `Tailscale already serves something on HTTPS port ${servePort} of this machine, so Studio leaves it alone. Turn that off (tailscale serve --https=${servePort} off) to use HTTPS here.`,
    }
  const running = (deps.spawn ?? spawnTailscaleUntilStopped)([
    'serve',
    `--https=${servePort}`,
    `http://127.0.0.1:${input.localPort}`,
  ])
  let output = ''
  let exited = false
  running.child.stdout?.on('data', (chunk: Buffer | string) => {
    if (output.length < 64 * 1024) output += chunk.toString()
  })
  running.child.stderr?.on('data', (chunk: Buffer | string) => {
    if (output.length < 64 * 1024) output += chunk.toString()
  })
  running.child.once('exit', () => {
    exited = true
  })
  running.child.once('error', () => {
    exited = true
  })
  // Up when Serve's own status shows the port proxied to our listener.
  const deadline = Date.now() + PUBLISH_DEADLINE_MS
  let up = false
  while (!exited && Date.now() < deadline) {
    const now = await readUse(servePort, deps)
    if (now?.funnel) break
    if (now && now.rootLoopbackPort === input.localPort && !now.others) {
      up = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, PUBLISH_POLL_MS))
  }
  if (!up) {
    running.stop()
    // Classified, never echoed: Tailscale's output can carry keys and names.
    const diagnostic = exited ? classifyServeStderr(output) : 'timeout'
    return { ok: false, message: describeServeDiagnostic(diagnostic) }
  }
  writeRecord(
    input.recordDir,
    { servePort, localPort: input.localPort, ...(running.child.pid ? { pid: running.child.pid } : {}) },
    input.log,
  )
  let stopped = false
  return {
    ok: true,
    origin: new URL(buildServeUrl(dnsName, servePort)).origin,
    stop: async () => {
      if (stopped) return
      stopped = true
      if (!exited) {
        const gone = new Promise<void>((resolve) => running.child.once('exit', () => resolve()))
        running.stop()
        await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 5000))])
      }
      forgetRecord(input.recordDir)
    },
  }
}

/**
 * End what an earlier run left behind: a foreground serve still running (a
 * crash on a platform without the watchdog), or a background mapping an older
 * build made with `--bg`. Run at every start, before anything is published.
 * Asks Tailscale nothing when there is no record.
 */
export async function withdrawRecordedGatewayHttps(input: {
  recordDir: string
  deps?: GatewayHttpsDeps
  log?: (message: string) => void
}): Promise<void> {
  const recorded = readRecord(input.recordDir)
  if (!recorded) return
  const deps = input.deps ?? {}
  if (recorded.pid !== undefined) {
    if ((deps.isOurServe ?? isOurServe)(recorded.pid)) {
      input.log?.(`tailnet HTTPS: ending the serve an earlier run left on port ${recorded.servePort}`)
      try {
        ;(deps.kill ?? killGroup)(recorded.pid)
      } catch {
        // Gone between the look and the kill.
      }
    }
    forgetRecord(input.recordDir)
    return
  }
  const use = await readUse(recorded.servePort, deps)
  if (use === null) return
  // Still the mapping that run made, and only it: anything else is someone else's.
  if (use.rootLoopbackPort === recorded.localPort && !use.others && !use.funnel) {
    input.log?.(`tailnet HTTPS: removing the serve mapping an earlier run left on port ${recorded.servePort}`)
    const result = await unshareServePort({ servePort: recorded.servePort }, deps)
    if (!result.ok) {
      input.log?.(`tailnet HTTPS: that mapping was not removed: ${result.message}`)
      return
    }
  }
  forgetRecord(input.recordDir)
}

/** The watchdog shell leads its own process group (`spawnTailscaleUntilStopped`): end the group. */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    process.kill(pid, 'SIGTERM')
  }
}

/** On POSIX, whether `pid` is still a `tailscale … serve` process (pids are reused). Elsewhere, never assumed. */
function isOurServe(pid: number): boolean {
  if (process.platform === 'win32') return false
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000 })
    return /tailscale/iu.test(command) && /\bserve\b/u.test(command)
  } catch {
    return false
  }
}
