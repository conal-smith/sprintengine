import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'

import { readStudioEnv } from '../shared/studio-env'
import { writeDiagnosticLog } from '../main/diagnostics-service'
import { ignoreMacosTypeOfServiceEinval, raiseConnectAttemptTimeout } from '../main/network-defaults'
import { defaultServerLocations } from './platform/studio-paths'
import { installFatalHandlers } from './bootstrap/fatal'
import { startHeadlessServer } from './bootstrap/headless'
import { serveOnChannel } from './bootstrap/serve'
import { keepStderrInLogsDir, stdioChannel } from './bootstrap/stdio'
import { startDetached } from './bootstrap/detached-start'
import type { ServerBoot } from './bootstrap/envelope'
import { readWebRunFile } from './web/web-run-file'
import { normalizeOrigin } from './web/web-origins'
import { checkTailscaleServePort, DEFAULT_TAILSCALE_SERVE_PORT } from './web/web-tailscale-serve'
import {
  EXIT_DATA_DIR_BUSY,
  EXIT_FAILED,
  EXIT_USAGE,
  startStudioServer,
  StudioServerStartError,
  type StudioServer,
  type StudioServerOptions,
} from './studio-server'

// `studio-server`: the Studio core under plain Node.
//
//   node out/server/server.cjs [serve] [--data-dir <dir>] [--logs-dir <dir>]
//        [--app-root <dir>] [--resources-dir <dir> --packaged]
//        [--share-desktop-data-dir] [--stdio]
//   node out/server/server.cjs --bootstrap stdio
//   node out/server/server.cjs start --detach --data-dir <dir> [--idle-ms <n> | --keep-running]
//        [--started-by-b64 <label>] [--replace] [--channel latest|nightly]
//   node out/server/server.cjs --version
//   node out/server/server.cjs serve --web [--web-port <n>] [--public-origin <url>]…
//        [--tailscale-serve [--tailscale-serve-port <n>]]
//   node out/server/server.cjs pair [--data-dir <dir>] [--origin <url>]
//   node out/server/server.cjs embed --workspace <id> --agent <id> [--frame-origin <url>]… [--ttl-hours <n>]
//   node out/server/server.cjs embed --list | --revoke <embed id>
//
// `--web` turns on the web client's listener on a loopback port (phase 9),
// off by default. `pair` asks the server running on a data directory for a
// one-time link that pairs a browser, and prints it.
//
// Once its gateway is listening it prints one JSON line on stdout,
// `{"ready":{…}}`, and keeps stdout for such lines; everything said to a person
// goes to stderr. With `--stdio` its parent drives it over stdin instead of a
// terminal: `{"t":"shutdown"}` stops it, and stdin closing (the parent gone)
// stops it too. SIGINT and SIGTERM stop it gracefully; a second one does not
// wait. The exit codes say whether trying again can help (studio-server.ts).
//
// `--bootstrap stdio` is how a parent that holds its stdio starts it (a WSL
// distribution's front door, an SSH session, CI): the first line on stdin is
// the bootstrap envelope (bootstrap/envelope.ts), and from then on stdin and
// stdout carry control frames, one JSON line each, until a `shutdown` frame or
// stdin's end. The desktop's own server is the same core forked as a utility
// process (desktop-main.ts), with the envelope on its parent port.

// The same server as a library, for a process that embeds it rather than
// starting it from a shell: a later phase's bootstrap, and the smoke test,
// which requires this bundle and drives a chat on the core it returns.
export { startStudioServer, StudioServerStartError } from './studio-server'
export type { StudioServer, StudioServerOptions, StudioServerReady } from './studio-server'

/** Baked in by scripts/build-server.mjs. */
declare const __STUDIO_SERVER_BUILD__: { version: string; commit: string | null; builtAt: string } | undefined

// How long a graceful stop may take before the process leaves anyway: the
// chats' children are told to stop and the registry is flushed in that time.
const SHUTDOWN_BUDGET_MS = 10_000

const USAGE = `Usage: studio-server [serve] [options]

  --data-dir <dir>           Where the server keeps its data (default: the XDG data directory,
                             or SPRINTENGINE_USER_DATA_DIR)
  --logs-dir <dir>           Where it writes diagnostics (default: logs/ in a data directory given
                             by flag or SPRINTENGINE_USER_DATA_DIR, else the XDG state directory)
  --app-root <dir>           The checkout or install the server runs from (default: beside the bundle)
  --resources-dir <dir>      An installed build's resources directory
  --packaged                 This is an installed build, not a source checkout
  --share-desktop-data-dir   Run against the desktop app's data directory, with saved keys off
  --stdio                    Driven by a parent over stdin: stop on {"t":"shutdown"} or when stdin closes
  --bootstrap stdio          Read a bootstrap envelope on stdin and speak control frames on stdout
  --web                      Serve the web client on a loopback port (off by default)
  --web-port <n>             The web listener's port (default 4791; 0 picks one)
  --public-origin <url>      An HTTPS origin a proxy serves the web client on, such as the
                             tailscale serve name (repeatable). Never plain HTTP off loopback.
  --tailscale-serve          Publish the web client on this machine's tailnet name over HTTPS
                             with tailscale serve; the listener stays on loopback
  --tailscale-serve-port <n> The HTTPS port serve publishes it on (default 443)
  --web-root <dir>           Where the web bundle is (default: out/web beside this bundle)
  --version                  Print the version and exit

Usage: studio-server pair [--data-dir <dir>] [--origin <url>]

  Print a one-time link that pairs a browser with the server running on the data
  directory. The link works once, within five minutes.

Usage: studio-server embed --workspace <id> --agent <id> [--frame-origin <url>]... [--ttl-hours <n>]
       studio-server embed --list
       studio-server embed --revoke <embed id>

  Print a link that shows one conversation, read-only, in another page's iframe;
  list the embeds the server holds; or revoke one, which closes it at once.

Usage: studio-server start --detach --data-dir <dir> [options]

  Start a server that outlives this command (an SSH machine's managed server),
  or report the one already running on that data directory.

  --idle-ms <n>              Stop after this long with no client and no chat working (default 5 minutes)
  --keep-running             Never stop for being idle
  --started-by-b64 <label>   Who started it, base64url, for Settings ("Studio on dev-macbook-air")
  --replace                  Drain and stop a running server first (an upgrade)
  --channel <latest|nightly> The release channel of the client that starts it
`

/** How long a managed server on an SSH machine waits with no client and no chat working (phase 8 spec, 6.4). */
const DEFAULT_DETACHED_IDLE_MS = 5 * 60_000

function bundledBuild(): { version: string; commit: string | null; builtAt: string } | null {
  return typeof __STUDIO_SERVER_BUILD__ === 'undefined' ? null : __STUDIO_SERVER_BUILD__
}

/** The checkout this bundle was built in: `out/server/` sits two levels below it. */
function defaultAppRoot(): string | null {
  const candidate = resolve(__dirname, '..', '..')
  return existsSync(join(candidate, 'resources', 'automation')) ? candidate : null
}

function versionFrom(appRoot: string | null): string {
  const baked = bundledBuild()?.version
  if (baked) return baked
  try {
    const manifest = JSON.parse(readFileSync(join(appRoot ?? '', 'package.json'), 'utf8')) as { version?: unknown }
    if (typeof manifest.version === 'string') return manifest.version
  } catch {
    // Not a checkout.
  }
  return '0.0.0'
}

type Command =
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'pair'; dataDir: string; origin: string | null }
  | { kind: 'embed-list'; dataDir: string }
  | { kind: 'embed-revoke'; dataDir: string; embedId: string }
  | {
      kind: 'embed'
      dataDir: string
      workspaceId: string
      agentId: string
      frameOrigins: string[]
      ttlHours: number | null
    }
  | { kind: 'bootstrap'; carrier: 'stdio' }
  | {
      kind: 'start-detached'
      dataDir: string
      logsDir: string
      idleMs: number | null
      startedBy: string
      replace: boolean
      channel: 'latest' | 'nightly'
    }
  | { kind: 'serve'; options: StudioServerOptions; stdio: boolean }

export function parseServerArgs(argv: string[], env = process.env): Command {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      'data-dir': { type: 'string' },
      'logs-dir': { type: 'string' },
      'app-root': { type: 'string' },
      'resources-dir': { type: 'string' },
      packaged: { type: 'boolean' },
      'share-desktop-data-dir': { type: 'boolean' },
      stdio: { type: 'boolean' },
      bootstrap: { type: 'string' },
      detach: { type: 'boolean' },
      'idle-ms': { type: 'string' },
      'keep-running': { type: 'boolean' },
      'started-by-b64': { type: 'string' },
      replace: { type: 'boolean' },
      channel: { type: 'string' },
      version: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      web: { type: 'boolean' },
      'web-port': { type: 'string' },
      'public-origin': { type: 'string', multiple: true },
      'web-root': { type: 'string' },
      'tailscale-serve': { type: 'boolean' },
      'tailscale-serve-port': { type: 'string' },
      origin: { type: 'string' },
      workspace: { type: 'string' },
      agent: { type: 'string' },
      'frame-origin': { type: 'string', multiple: true },
      'ttl-hours': { type: 'string' },
      list: { type: 'boolean' },
      revoke: { type: 'string' },
    },
  })
  if (values.version) return { kind: 'version' }
  if (values.help) return { kind: 'help' }
  if (values.bootstrap !== undefined) {
    if (values.bootstrap !== 'stdio') throw new Error(`Unknown bootstrap carrier: ${values.bootstrap}`)
    // Everything a flag would say, the envelope says instead.
    if (positionals.length > 0 || Object.keys(values).some((key) => key !== 'bootstrap')) {
      throw new Error('--bootstrap takes no other options: the envelope carries them.')
    }
    return { kind: 'bootstrap', carrier: 'stdio' }
  }
  const [command = 'serve', ...rest] = positionals
  if (command === 'start' && rest.length === 0) return parseDetachedStart(values)
  for (const name of ['detach', 'idle-ms', 'keep-running', 'started-by-b64', 'replace', 'channel'] as const) {
    if (values[name] !== undefined) throw new Error(`--${name} goes with start --detach.`)
  }
  if ((command !== 'serve' && command !== 'pair' && command !== 'embed') || rest.length > 0)
    throw new Error(`Unknown command: ${positionals.join(' ')}`)
  if (values.packaged && !values['resources-dir']) throw new Error('--packaged needs --resources-dir.')

  const defaults = defaultServerLocations({ env })
  const profile = readStudioEnv('SPRINTENGINE_USER_DATA_DIR', env)?.trim()
  const appRoot = values['app-root'] ? resolve(values['app-root']) : defaultAppRoot()
  const chosenDataDir = values['data-dir'] ?? (profile || null)
  // A server pointed at a directory keeps everything in it; one on the default
  // locations logs where XDG puts state.
  const dataDir = resolve(chosenDataDir ?? defaults.dataDir)
  if (command === 'pair') return { kind: 'pair', dataDir, origin: values.origin ?? null }
  if (command === 'embed') {
    if (values.list === true) return { kind: 'embed-list', dataDir }
    if (values.revoke !== undefined) return { kind: 'embed-revoke', dataDir, embedId: values.revoke }
    if (!values.workspace || !values.agent) throw new Error('embed needs --workspace and --agent.')
    const ttlHours = values['ttl-hours'] === undefined ? null : Number(values['ttl-hours'])
    if (ttlHours !== null && !(ttlHours > 0)) throw new Error('--ttl-hours takes a positive number.')
    return {
      kind: 'embed',
      dataDir,
      workspaceId: values.workspace,
      agentId: values.agent,
      frameOrigins: values['frame-origin'] ?? [],
      ttlHours,
    }
  }
  const web = values.web === true ? parseWebOptions(values) : null
  return {
    kind: 'serve',
    stdio: values.stdio === true,
    options: {
      dataDir,
      logsDir: resolve(values['logs-dir'] ?? (chosenDataDir ? join(dataDir, 'logs') : defaults.logsDir)),
      version: versionFrom(appRoot),
      packaged: values.packaged === true,
      resourcesDir: values['resources-dir'] ? resolve(values['resources-dir']) : null,
      appRoot,
      shareDesktopDataDir: values['share-desktop-data-dir'] === true,
      web,
    },
  }
}

const DEFAULT_WEB_PORT = 4791

function parseWebOptions(values: {
  'web-port'?: string
  'public-origin'?: string[]
  'web-root'?: string
  'tailscale-serve'?: boolean
  'tailscale-serve-port'?: string
}): NonNullable<StudioServerOptions['web']> {
  const port = values['web-port'] === undefined ? DEFAULT_WEB_PORT : Number(values['web-port'])
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--web-port takes a port number.')
  const publicOrigins = (values['public-origin'] ?? []).map((value) => {
    const origin = normalizeOrigin(value)
    // Off loopback the web client is served over HTTPS or not at all (R19):
    // plain HTTP is not a secure context, and the cookie could not be Secure.
    if (!origin || !origin.startsWith('https://'))
      throw new Error(`--public-origin takes an https:// origin with no path: ${value}`)
    return origin
  })
  if (values['tailscale-serve-port'] !== undefined && values['tailscale-serve'] !== true)
    throw new Error('--tailscale-serve-port goes with --tailscale-serve.')
  let tailscaleServe: { port: number } | null = null
  if (values['tailscale-serve'] === true) {
    const servePort =
      values['tailscale-serve-port'] === undefined
        ? DEFAULT_TAILSCALE_SERVE_PORT
        : Number(values['tailscale-serve-port'])
    const refused = checkTailscaleServePort(servePort)
    if (refused) throw new Error(refused)
    tailscaleServe = { port: servePort }
  }
  return {
    port,
    publicOrigins,
    staticDir: resolve(values['web-root'] ?? join(__dirname, '..', 'web')),
    tailscaleServe,
  }
}

/** `studio-server embed`: a link to one conversation, read-only, for another page to frame. */
async function mintEmbed(command: Extract<Command, { kind: 'embed' }>): Promise<number> {
  const run = readWebRunFile(command.dataDir)
  if (!run) {
    say(
      `No Studio server with its web listener on is running on ${command.dataDir}. Start one with: studio-server serve --web`,
    )
    return EXIT_FAILED
  }
  try {
    const response = await fetch(`${run.url}/embed/mint`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${run.mintKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: command.workspaceId,
        agentId: command.agentId,
        origins: command.frameOrigins,
        ...(command.ttlHours === null ? {} : { ttlMs: command.ttlHours * 60 * 60 * 1000 }),
      }),
    })
    const body = (await response.json()) as {
      ok?: boolean
      url?: string
      message?: string
      embed?: { expiresAt?: string }
    }
    if (!response.ok || !body.ok || typeof body.url !== 'string') {
      say(body.message ?? `The server refused (${response.status}).`)
      return EXIT_FAILED
    }
    process.stdout.write(`${body.url}\n`)
    say(`Anyone with the link can read this conversation until ${body.embed?.expiresAt ?? 'it expires'}.`)
    return 0
  } catch (error) {
    say(`The server on ${run.url} did not answer: ${error instanceof Error ? error.message : String(error)}`)
    return EXIT_FAILED
  }
}

/** `studio-server embed --list` and `--revoke`: the embeds a server holds, and taking one back. */
async function manageEmbeds(
  command: Extract<Command, { kind: 'embed-list' } | { kind: 'embed-revoke' }>,
): Promise<number> {
  const run = readWebRunFile(command.dataDir)
  if (!run) {
    say(
      `No Studio server with its web listener on is running on ${command.dataDir}. Start one with: studio-server serve --web`,
    )
    return EXIT_FAILED
  }
  const listing = command.kind === 'embed-list'
  try {
    const response = await fetch(`${run.url}/embed/${listing ? 'list' : 'revoke'}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${run.mintKey}`, 'Content-Type': 'application/json' },
      body: listing ? '{}' : JSON.stringify({ embedId: command.embedId }),
    })
    const body = (await response.json()) as {
      ok?: boolean
      message?: string
      embeds?: Array<{
        embedId: string
        conversation: { workspaceId: string; agentId: string }
        origins: string[]
        expiresAt: string
      }>
    }
    if (!response.ok || !body.ok) {
      say(body.message ?? `The server refused (${response.status}).`)
      return EXIT_FAILED
    }
    if (!listing) {
      say(`Embed ${command.embedId} was revoked; pages showing it lost it at once.`)
      return 0
    }
    for (const embed of body.embeds ?? []) {
      process.stdout.write(
        `${embed.embedId}  ${embed.conversation.workspaceId}/${embed.conversation.agentId}  until ${embed.expiresAt}  ` +
          `framed by ${embed.origins.length > 0 ? embed.origins.join(' ') : 'no page'}\n`,
      )
    }
    if ((body.embeds ?? []).length === 0) say('No embeds.')
    return 0
  } catch (error) {
    say(`The server on ${run.url} did not answer: ${error instanceof Error ? error.message : String(error)}`)
    return EXIT_FAILED
  }
}

/** `studio-server pair`: a one-time pairing link from the server running on a data directory. */
async function pairBrowser(dataDir: string, origin: string | null): Promise<number> {
  const run = readWebRunFile(dataDir)
  if (!run) {
    say(`No Studio server with its web listener on is running on ${dataDir}. Start one with: studio-server serve --web`)
    return EXIT_FAILED
  }
  const target = origin ? normalizeOrigin(origin) : null
  if (origin && (!target || !run.origins.includes(target))) {
    say(`${origin} is not one of the server's origins: ${run.origins.join(', ')}`)
    return EXIT_USAGE
  }
  try {
    const response = await fetch(`${run.url}/pair/mint`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${run.mintKey}` },
    })
    const body = (await response.json()) as { ok?: boolean; url?: string; expiresAt?: string; message?: string }
    if (!response.ok || !body.ok || typeof body.url !== 'string') {
      say(body.message ?? `The server refused (${response.status}).`)
      return EXIT_FAILED
    }
    const link = target ? body.url.replace(run.url, target) : body.url
    process.stdout.write(`${link}\n`)
    say(`Open the link in the browser to pair. It works once, until ${body.expiresAt ?? 'five minutes from now'}.`)
    return 0
  } catch (error) {
    say(`The server on ${run.url} did not answer: ${error instanceof Error ? error.message : String(error)}`)
    return EXIT_FAILED
  }
}

function parseDetachedStart(values: Record<string, string | boolean | string[] | undefined>): Command {
  if (values.detach !== true) throw new Error('start runs a server detached: give --detach.')
  // A managed server on an SSH machine is reached through the desktop's SSH
  // session, never by a browser, so it serves no web client and pairs none.
  for (const name of [
    'web',
    'web-port',
    'public-origin',
    'web-root',
    'tailscale-serve',
    'tailscale-serve-port',
  ] as const) {
    if (values[name] !== undefined) throw new Error(`--${name} goes with serve --web, not start --detach.`)
  }
  const dataDir = values['data-dir']
  if (typeof dataDir !== 'string' || !dataDir.startsWith('/'))
    throw new Error('start --detach needs an absolute --data-dir.')
  let idleMs: number | null = DEFAULT_DETACHED_IDLE_MS
  if (values['keep-running'] === true) idleMs = null
  else if (typeof values['idle-ms'] === 'string') {
    idleMs = Number(values['idle-ms'])
    if (!Number.isInteger(idleMs) || idleMs <= 0) throw new Error('--idle-ms must be a whole number of milliseconds.')
  }
  const label = values['started-by-b64']
  if (label !== undefined && (typeof label !== 'string' || !/^[A-Za-z0-9_-]{0,400}$/u.test(label)))
    throw new Error('--started-by-b64 must be base64url.')
  const channel = values.channel ?? 'latest'
  if (channel !== 'latest' && channel !== 'nightly') throw new Error('--channel is latest or nightly.')
  const resolved = resolve(dataDir)
  const logsDir =
    typeof values['logs-dir'] === 'string'
      ? resolve(values['logs-dir'])
      : join(homedir(), '.local', 'state', 'sprintengine-studio', 'logs', basename(resolved))
  return {
    kind: 'start-detached',
    dataDir: resolved,
    logsDir,
    idleMs,
    startedBy: label ? Buffer.from(label, 'base64url').toString('utf8').slice(0, 200) : '',
    replace: values.replace === true,
    channel,
  }
}

function say(message: string): void {
  process.stderr.write(`[studio-server] ${message}\n`)
}

function emit(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`)
}

async function main(argv: string[]): Promise<number> {
  let command: Command
  try {
    command = parseServerArgs(argv)
  } catch (error) {
    say(error instanceof Error ? error.message : String(error))
    process.stderr.write(USAGE)
    return EXIT_USAGE
  }
  if (command.kind === 'help') {
    process.stdout.write(USAGE)
    return 0
  }
  if (command.kind === 'version') {
    process.stdout.write(`${versionFrom(defaultAppRoot())}\n`)
    return 0
  }
  if (command.kind === 'bootstrap') return serveOverStdio()
  if (command.kind === 'pair') return pairBrowser(command.dataDir, command.origin)
  if (command.kind === 'embed') return mintEmbed(command)
  if (command.kind === 'embed-list' || command.kind === 'embed-revoke') return manageEmbeds(command)
  if (command.kind === 'start-detached')
    return startDetached({
      ...command,
      entry: __filename,
      execPath: process.execPath,
      appDir: __dirname,
      version: versionFrom(defaultAppRoot()),
      print: (line) => process.stdout.write(`${line}\n`),
    })

  // Installed before the server starts, so a signal or a closed stdin during
  // startup is not lost: the stop waits for the start to finish, then runs.
  let server: StudioServer | null = null
  let stopping = false
  let settle: (code: number) => void = () => undefined
  const exited = new Promise<number>((resolve) => {
    settle = resolve
  })
  let pending: { reason: string; code: number } | null = null
  const stop = (reason: string, code = 0): void => {
    if (!server) {
      pending ??= { reason, code }
      return
    }
    if (stopping) return
    stopping = true
    say(`stopping (${reason})`)
    const budget = setTimeout(() => {
      // The lock stays: the chats' transcripts may still be closing, and the
      // next process to start finds the lock abandoned once this one is gone.
      say(`stop took longer than ${SHUTDOWN_BUDGET_MS / 1000}s; leaving anyway`)
      settle(code)
    }, SHUTDOWN_BUDGET_MS)
    budget.unref()
    void server.stop().then(
      () => {
        clearTimeout(budget)
        settle(code)
      },
      (error: unknown) => {
        clearTimeout(budget)
        say(`stop failed: ${error instanceof Error ? error.message : String(error)}`)
        settle(EXIT_FAILED)
      },
    )
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      // A second signal: the person does not want to wait. The lock is left
      // for the next start to find abandoned rather than let go mid-write.
      if (stopping) process.exit(EXIT_FAILED)
      stop(signal)
    })
  }
  process.on('uncaughtException', (error) => {
    say(`uncaught: ${error.stack ?? error.message}`)
    void writeDiagnosticLog({ level: 'error', source: 'workspace', title: 'Studio server', message: error.message })
    stop('uncaught exception', EXIT_FAILED)
  })
  process.on('unhandledRejection', (reason) => {
    // Logged, not fatal: the desktop runs the same code, where an unhandled
    // rejection has never ended the process.
    say(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
  })
  if (command.stdio) {
    const lines = createInterface({ input: process.stdin })
    lines.on('line', (line) => {
      let message: { t?: unknown }
      try {
        message = JSON.parse(line) as { t?: unknown }
      } catch {
        say('ignored a stdin line that is not JSON')
        return
      }
      if (message.t === 'shutdown') stop('asked to')
    })
    lines.on('close', () => stop('stdin closed'))
  }

  try {
    server = await startStudioServer({
      ...command.options,
      // The desktop app opened this data directory and took its lock: it is the
      // one writer there now, and waits for this process to go.
      onDataDirLost: () => stop('SprintEngine Studio opened this data directory', EXIT_DATA_DIR_BUSY),
      log: say,
    })
  } catch (error) {
    const code = error instanceof StudioServerStartError ? error.exitCode : EXIT_FAILED
    const message = error instanceof Error ? error.message : String(error)
    say(message)
    emit({ fatal: { code, message } })
    return code
  }
  const { ready } = server
  emit({ ready })
  say(
    `ready: ${ready.dataDir}, gateway ${ready.gatewaySocket ?? 'not running'}` +
      (ready.secrets ? '' : ', saved keys off (desktop data directory)'),
  )
  if (server.web) {
    // No pairing code is printed here: stderr may be a service's log, which
    // keeps it. `studio-server pair` prints one link to whoever asks.
    say(`web client on ${server.web.url}; pair a browser with: studio-server pair --data-dir ${ready.dataDir}`)
  }
  const asked = pending as { reason: string; code: number } | null
  if (asked) stop(asked.reason, asked.code)
  return exited
}

/** `--bootstrap stdio`: the envelope on stdin, control frames each way, until told to stop. */
function serveOverStdio(): Promise<number> {
  const channel = stdioChannel(process.stdin, process.stdout)
  installFatalHandlers(channel, say)
  // Said before anything is read: the starter writes the envelope only after
  // this, so the shell that exec'd the server cannot have read part of it.
  channel.send(serverBoot(bundledBuild()))
  return serveOnChannel(channel, {
    starters: { headless: startHeadlessServer },
    unwrapEnvelope: false,
    buildStamp: bundledBuild()?.commit ?? null,
    log: say,
    // A WSL distribution's server keeps its own log, in the logs directory
    // its envelope names (`~/.local/state/sprintengine-studio/logs/<data
    // name>/server-YYYY-MM-DD.log`), rotated as the desktop's server log is.
    // A detached server's stderr is that file already (detached-start.ts).
    onEnvelope: (envelope) => {
      if (envelope.wsl && !envelope.detached) keepStderrInLogsDir(envelope.logsDir)
    },
  })
}

/** The boot frame: who this server is and where it runs. */
export function serverBoot(build: { commit: string | null; builtAt: string } | null): ServerBoot {
  return {
    t: 'boot',
    pid: process.pid,
    version: versionFrom(defaultAppRoot()),
    buildStamp: build?.commit ?? null,
    builtAt: build?.builtAt ?? null,
    home: homedir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    execPath: process.execPath,
    appDir: __dirname,
  }
}

if (require.main === module) {
  raiseConnectAttemptTimeout()
  ignoreMacosTypeOfServiceEinval()
  void main(process.argv.slice(2)).then((code) => process.exit(code))
}
