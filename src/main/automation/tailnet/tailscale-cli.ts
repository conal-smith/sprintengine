import { spawn } from 'child_process'
import { existsSync } from 'fs'

import { killProcessTree } from '../../process-tree-kill'

// One way to reach Tailscale's local API, shared by whois (who is on the other
// end of a connection) and status (which machines exist on this tailnet).
//
// Going through the CLI rather than opening the tailscaled socket directly is
// deliberate: the socket's location differs across Linux packages, the macOS
// standalone app, and the sandboxed Mac App Store build (which uses a
// port+token handshake instead of a socket), and the CLI already resolves all
// of them. It is a thin client over the same local API.
//
// Every failure mode — no binary, a non-zero exit, a timeout — is the same
// answer: null. Callers turn that into "Tailscale is not available here", never
// into a guess about the tailnet.

/** Where the macOS app installs its CLI when it is not on PATH. */
const MACOS_CLI_PATHS = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
]

/**
 * The environment every run gets.
 *
 * The macOS app's binary is the GUI and the CLI in one file, and it decides
 * which to be from its environment. Started from a terminal it sees `TERM` and
 * acts as the CLI; started by an app launched from the Dock or Finder it sees
 * neither, tries to start the GUI, and prints "The Tailscale GUI failed to
 * start" to stdout with exit code 0. Every read then failed to parse — the scan
 * listed no machines and whois named nobody — while looking like a working run.
 * `TAILSCALE_BE_CLI` is the switch the binary reads for exactly this; the
 * standalone Linux and Windows CLIs ignore it.
 */
function tailscaleEnv(): NodeJS.ProcessEnv {
  return { ...process.env, TAILSCALE_BE_CLI: '1' }
}

function resolveTailscaleBinary(): string {
  for (const candidate of MACOS_CLI_PATHS) {
    if (existsSync(candidate)) return candidate
  }
  // Fall back to PATH resolution by execFile; a missing binary surfaces as an
  // execFile error, which the caller reads as null.
  return 'tailscale'
}

type TailscaleExit = { ok: boolean; stdout: string; stderr: string; timedOut: boolean }

/** execFile's own default, which every run had before it got a deadline of its own. */
const DEFAULT_MAX_BUFFER = 1024 * 1024

/**
 * One run of the CLI, with its deadline.
 *
 * execFile's `timeout` sends one SIGTERM to the process it started, which is
 * not always the CLI: `/usr/local/bin/tailscale` is a shell wrapper that runs
 * the app's binary as its child. The wrapper dies and the binary carries on
 * orphaned, and one that ignores TERM keeps the pipes, so the run never
 * settles. So the run is spawned here, on POSIX as the leader of its own
 * process group, and the deadline ends the group (on Windows, the tree); see
 * `killProcessTree`. execFile cannot do this: it does not pass `detached` on.
 *
 * What a timed-out run printed is kept, as execFile kept it: serve with HTTPS
 * off prints where to turn it on and then waits, so that run always reaches
 * the deadline and its stdout is the only diagnosis.
 */
function execTailscale(args: readonly string[], timeoutMs: number, maxBuffer = DEFAULT_MAX_BUFFER) {
  return new Promise<TailscaleExit>((resolve) => {
    const grouped = process.platform !== 'win32'
    const child = spawn(resolveTailscaleBinary(), [...args], {
      windowsHide: true,
      env: tailscaleEnv(),
      ...(grouped ? { detached: true } : {}),
    })
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let overflowed = false
    let settled = false
    const stop = () => killProcessTree(child, { processGroup: grouped })
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    const settle = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, stdout, stderr, timedOut })
    }
    // Past the cap the run is a failure, as execFile made it.
    const overflow = (bytes: number) => {
      if (bytes <= maxBuffer || overflowed) return
      overflowed = true
      stop()
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      overflow((stdoutBytes += Buffer.byteLength(chunk)))
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      overflow((stderrBytes += Buffer.byteLength(chunk)))
    })
    // No binary: the run failed, with nothing printed.
    child.on('error', () => settle(false))
    // A killed run is over even if something it started escaped the group and
    // still holds the pipes, which would keep `close` from arriving.
    child.on('exit', () => {
      if (timedOut || overflowed) settle(false)
    })
    child.on('close', (code) => settle(code === 0 && !timedOut && !overflowed))
  })
}

/** Run a Tailscale subcommand, or null when it is unavailable or fails. */
export function runTailscale(args: readonly string[], timeoutMs: number, maxBuffer?: number): Promise<string | null> {
  return execTailscale(args, timeoutMs, maxBuffer).then((run) => (run.ok ? run.stdout : null))
}

/**
 * A run whose failure the caller must explain rather than swallow.
 *
 * `runTailscale` collapses every failure to null, which is the right answer for
 * a read (no tailnet is no tailnet). A WRITE — `serve` turning a local port
 * into a tailnet URL — fails for reasons a person can act on: HTTPS is off for
 * the tailnet, the node is logged out, the daemon wants elevation. Those need
 * to reach the UI, so this variant keeps the exit code and stderr.
 *
 * CALLERS MUST NOT SURFACE OR LOG `stderr` VERBATIM. Tailscale writes auth keys
 * (`tskey-…`) and node names into it; `tailscale-serve.ts` classifies it into a
 * fixed label and drops the text. The field is here so that classification can
 * happen, not so the text can be shown.
 */
export type TailscaleRun =
  { ok: true; stdout: string } | { ok: false; stdout: string; stderr: string; timedOut: boolean }

export function runTailscaleResult(
  args: readonly string[],
  timeoutMs: number,
  maxBuffer?: number,
): Promise<TailscaleRun> {
  return execTailscale(args, timeoutMs, maxBuffer).then(({ ok, stdout, stderr, timedOut }) =>
    ok ? { ok: true, stdout } : { ok: false, stdout, stderr, timedOut },
  )
}
