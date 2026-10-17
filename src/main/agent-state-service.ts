import { createHash } from 'crypto'
import { chmodSync, existsSync, unlinkSync } from 'fs'
import { createServer, type Server, type Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PluginAgentStateSpec } from '../shared/plugin-manifest'
import type { TerminalPathStyle } from '../shared/electron-api'
import type { AgentStateFrame } from './agent-state'
import {
  installAgentStateReporter,
  parseAgentStateFrame,
  removeAgentStateRegistrationAt,
  removeWorkspaceAgentStateRegistration,
} from './agent-state'
import type { HostAgentIntegration } from './hosts/execution-host'

// =============================================================================
// Agent-state service — the Electron-bound half of authoritative agent state.
//
// Owns a dedicated local socket the per-workspace reporter hook writes
// newline-delimited JSON frames to, validates each frame, and hands the valid
// ones to `onFrame` (the terminal runtime, which resolves the session and
// updates its phase). A WSL distribution's frames arrive through its helper
// instead (`ingestLine`) and are held to exactly the same validation. Also owns installing the reporter at launch — serialized
// per TARGET FILE (several CLIs can share one settings file) and run once per
// CLI per scope root and execution style per app run, so concurrent agent
// launches never race a config's read-modify-write and switching between native
// Windows and WSL rewrites the command for the shell that will execute it.
//
// All Electron specifics (userData dir, bundled reporter path) are injected, so
// this module stays free of `electron` and is unit-testable over a real socket.
// =============================================================================

// POSIX sun_path is ~104 bytes; long dev userData paths fall back to the
// per-user temp dir with a hash tying the socket to this profile. Mirrors the
// automation server's resolver so both behave identically across platforms.
const MAX_POSIX_SOCKET_PATH = 90

// A reporter frame is tiny; a client that streams an unbounded line without a
// newline is dropped rather than buffered without limit.
const MAX_LINE_BYTES = 64 * 1024

const USER_SCOPED_REMOVAL_TIMEOUT_MS = 3_000

export type AgentStateServiceOptions = {
  resolveUserDataDir: () => string
  // Resolves a CLI's manifest-declared agentStateSpec (null when the plugin is
  // unknown or declares none — install is then a no-op: the CLI cannot report
  // agent state). This single lookup replaced the old hardcoded launch gate +
  // installer map pair, which had to be kept in lock-step by hand.
  resolveAgentStateSpec: (cli: string) => PluginAgentStateSpec | null
  // Resolves the bundled shared stdin-filter reporter to copy into a workspace
  // (used by every command-hook registration kind). Returns null when the
  // script is missing from the build (install then no-ops, safely).
  resolveReporterScriptPath: () => string | null
  // Resolves the bundled status-line forwarder — the second stdin filter, for
  // the Claude-family specs that declare `statusLine: true`. Optional: a build
  // (or a test harness) without it installs hooks only.
  resolveStatusLineScriptPath?: () => string | null
  // Resolves a bundled plugin-file reporter TEMPLATE by the filename a
  // manifest's plugin-file registration names (e.g. OpenCode's in-process
  // plugin). Returns null when missing.
  resolveReporterTemplatePath: (template: string) => string | null
  // Home directory a user-scoped registration resolves against. Injected so
  // tests never write the real home; production omits it (os.homedir()).
  resolveHomeDir?: () => string
  // Whether this CLI is handed the app's own plugin directories at launch
  // (`--plugin-dir`), which carry this very reporter and its event set. True ⇒
  // install nothing into the workspace: the launch flag already registers it
  // for that session, a second registration would fire the reporter twice for
  // every event, and the person's repository keeps none of it. Absent ⇒ nothing
  // is launch-injected, which is the behaviour from before the flag existed.
  // Asked with the launch's machine: a WSL launch carries the copy inside its
  // distribution only once the helper has written it there. `integration` is
  // what that machine said when the launch prepared it, so this answer and the
  // launch's own flags come from one reading.
  resolveLaunchInjectsPlugins?: (cli: string, hostId?: string, integration?: HostAgentIntegration | null) => boolean
  // Every loaded CLI's agentStateSpec. Read only when a launch-injected CLI
  // tidies the registration an earlier build wrote into the workspace: the
  // shared reporter script there must survive while another CLI's registration
  // (Codex's config.toml, Cursor's hooks.json) still runs it. Absent ⇒ no other
  // registration is known, and the script is removed with the entry.
  listAgentStateSpecs?: () => readonly PluginAgentStateSpec[]
  onFrame: (frame: AgentStateFrame) => void
  logDiagnostic?: (diagnostic: { level: 'warning' | 'info'; title: string; message: string; details?: string }) => void
  now?: () => number
}

export function createAgentStateService(options: AgentStateServiceOptions) {
  const now = options.now ?? (() => Date.now())
  let server: Server | null = null
  const sockets = new Set<Socket>()
  let socketPath: string | null = null

  // Install state: a per-target-file serialization chain so concurrent launches
  // in the same workspace don't race the settings.local.json read-modify-write,
  // and a set so we install at most once per workspace per app run.
  const installChains = new Map<string, Promise<void>>()
  const installed = new Set<string>()
  // Workspaces whose stale registration a launch-injected CLI already took out
  // this run, keyed like the install chain (target file + workspace).
  const tidied = new Set<string>()
  // User-scoped registrations written this run (Kimi Code's user-global
  // config), by file. They apply to every session of that CLI on the machine,
  // including ones started outside the app, and the reporter they run only
  // reports for sessions the app launched — every one of which ends with the
  // app. So they are taken back out at quit, and written again by the next
  // launch that needs them.
  const userScopedWrites = new Map<
    string,
    { kind: PluginAgentStateSpec['registration']['kind']; createdFile: boolean }
  >()

  function getSocketPath(): string {
    if (!socketPath) socketPath = resolveAgentStateSocketPath(options.resolveUserDataDir())
    return socketPath
  }

  function warn(title: string, details: string): void {
    options.logDiagnostic?.({ level: 'warning', title, message: title, details })
  }

  async function initialize(): Promise<void> {
    if (server) return
    const path = getSocketPath()
    // A stale socket file from a crashed previous run would block listen();
    // remove it. A live second instance is prevented upstream by Electron's
    // single-instance lock.
    if (process.platform !== 'win32' && existsSync(path)) {
      try {
        unlinkSync(path)
      } catch {
        // listen() will surface a real conflict below.
      }
    }
    const next = createServer((socket) => handleConnection(socket))
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          next.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          next.removeListener('error', onError)
          resolve()
        }
        next.once('error', onError)
        next.once('listening', onListening)
        next.listen(path)
      })
    } catch (error) {
      warn('Agent-state socket failed to start', message(error))
      return
    }
    if (process.platform !== 'win32') {
      try {
        chmodSync(path, 0o600)
      } catch {
        // Owner-only is best-effort hardening; a failure does not break the feed.
      }
    }
    next.on('error', (error) => warn('Agent-state socket error', error.message))
    server = next
  }

  function handleConnection(socket: Socket): void {
    sockets.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_LINE_BYTES) {
        socket.destroy()
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) handleLine(line)
        newline = buffer.indexOf('\n')
      }
    })
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
  }

  // One frame line, from this machine's socket or relayed by a WSL helper.
  function handleLine(line: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      // Untrusted input: a malformed frame is dropped, never thrown on.
      return
    }
    const frame = parseAgentStateFrame(raw, now())
    if (!frame) return
    try {
      options.onFrame(frame)
    } catch (error) {
      warn('Agent-state frame handler threw', message(error))
    }
  }

  async function shutdown(): Promise<void> {
    const current = server
    server = null
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    if (current) {
      await new Promise<void>((resolve) => current.close(() => resolve()))
    }
    if (process.platform !== 'win32' && socketPath && existsSync(socketPath)) {
      try {
        unlinkSync(socketPath)
      } catch {
        // Best-effort cleanup; a stale socket is unlinked on next start.
      }
    }
    await removeUserScopedRegistrations()
  }

  // Bounded: quit must not wait on a distribution's file system.
  async function removeUserScopedRegistrations(timeoutMs = USER_SCOPED_REMOVAL_TIMEOUT_MS): Promise<void> {
    const writes = [...userScopedWrites]
    userScopedWrites.clear()
    if (writes.length === 0) return
    const removal = Promise.all(
      writes.map(([path, { kind, createdFile }]) =>
        removeAgentStateRegistrationAt(path, kind, { deleteIfEmpty: createdFile }).catch((error) => {
          warn('Agent-state hook not removed at quit', `${path}: ${message(error)}`)
          return 'skipped' as const
        }),
      ),
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      removal,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
    if (timer) clearTimeout(timer)
  }

  // Install the reporter into a workspace before an agent launches, entirely
  // from the CLI's manifest-declared agentStateSpec (registration kind + path
  // + event set). A CLI without a spec installs nothing — it cannot report
  // agent state. Serialized + run once per (cli, workspace, execution style)
  // per app run, and strictly best-effort: a failure is logged and swallowed
  // so it can never block or break the launch that awaits it.
  //
  // A launch on another host (WSL) passes that host's `integration`: its hooks
  // run the host's own Node on the host's paths and report to the helper's
  // socket, and a user-scoped registration goes into the host's home.
  async function installForWorkspace(
    workspaceRoot: string,
    cli: string,
    execution: {
      pathStyle?: TerminalPathStyle
      hostId?: string
      integration?: HostAgentIntegration | null
      launchCarriesHook?: boolean
    } = {},
  ): Promise<void> {
    const root = workspaceRoot.trim()
    if (!root) return
    const spec = options.resolveAgentStateSpec(cli)
    if (!spec) return
    // The launch hands this CLI the same reporter for the session, so the
    // workspace needs no copy of it — see `resolveLaunchInjectsPlugins`. Asked
    // per launch rather than once at wiring time, because it also answers false
    // when this build could not materialise its plugin, and that must fall back
    // to the workspace install rather than to no agent state at all.
    //
    // Not a bare return: a workspace an earlier build (or this run's startup
    // window, before the copy landed) installed into still holds that
    // registration, which would now fire beside the launch's own for every
    // event and stay in the person's repository. It is taken out instead.
    // `launchCarriesHook` is the same answer for a CLI whose hook rides its own
    // per-launch flags or environment rather than a plugin directory (Codex's
    // `-c hooks…`, OpenCode's config content).
    if (
      execution.launchCarriesHook === true ||
      options.resolveLaunchInjectsPlugins?.(cli, execution.hostId, execution.integration)
    ) {
      await tidyWorkspaceRegistration(root, spec)
      return
    }
    // A user-scoped registration writes one profile-global file whose content
    // is workspace-independent (home-scoped reporter copy + profile socket),
    // so its install-once key is per CLI, not per workspace — the first launch
    // of any workspace heals a stale config, and later workspaces skip a write
    // that would be byte-identical anyway.
    const pathStyle = execution.pathStyle ?? (process.platform === 'win32' ? 'windows' : 'posix')
    const userScoped = spec.registration.scope === 'user'
    if (userScoped && pathStyle !== 'wsl') await tidyWorkspaceRegistration(root, spec)
    const integration = pathStyle === 'wsl' ? execution.integration : null
    if (pathStyle === 'wsl' && !integration) {
      // The launch waits for the helper before it gets here; without it there
      // is no socket in the distribution to point a hook at.
      warn(
        'Agent-state hook not installed',
        `The WSL helper was not running when ${cli} launched, so its hook could not be written. It is tried again on the next launch.`,
      )
      return
    }
    // The CLI reads its user-global config, and Claude its user settings (for
    // the status line it wraps), from the home of the machine it runs on.
    const homeDir = integration ? integration.home.native : options.resolveHomeDir?.()
    // A user-scoped key names the home it wrote to: a CLI run natively and the
    // same CLI run through WSL keep separate user configurations.
    const keyRoot = userScoped ? `user:${homeDir ?? ''}` : root
    const key = `${cli}::${keyRoot}::${pathStyle}::${execution.hostId ?? ''}`
    if (installed.has(key)) return

    // Serialization is keyed by the TARGET FILE, not the CLI: claude-code, zai
    // and kimi-claude all merge into the same .claude/settings.local.json, and
    // two of them launching concurrently in one workspace must not interleave
    // that file's read-modify-write. (Their specs are identical today, so the
    // race would be benign — until the day one diverges.)
    const chainKey = userScoped
      ? `user:${homeDir ?? ''}:${spec.registration.path}`
      : `${spec.registration.path}::${root}`
    const prior = installChains.get(chainKey) ?? Promise.resolve()
    const next = prior.then(async () => {
      if (installed.has(key)) return
      const sourceScriptPath =
        spec.registration.kind === 'plugin-file'
          ? options.resolveReporterTemplatePath(spec.registration.template)
          : options.resolveReporterScriptPath()
      if (!sourceScriptPath) {
        warn('Agent-state reporter missing', 'Reporter script not found in this build; agent state cannot be reported.')
        return
      }
      const result = await installAgentStateReporter(workspaceRoot, spec, {
        sourceScriptPath,
        socketPath: integration ? integration.agentStateSocketPath : getSocketPath(),
        statusLineScriptPath: options.resolveStatusLineScriptPath?.() ?? null,
        ...(integration ? { commandRuntime: integration.commandRuntime } : {}),
        ...(homeDir ? { homeDir } : {}),
        cli,
        hostId: execution.hostId ?? 'local',
      })
      if (result.ok) {
        installed.add(key)
        if (userScoped) {
          // A file this run created goes entirely if our block was all of it.
          const previous = userScopedWrites.get(result.settingsPath)
          userScopedWrites.set(result.settingsPath, {
            kind: spec.registration.kind,
            createdFile: previous?.createdFile === true || result.createdFile === true,
          })
        }
      } else {
        warn('Agent-state hook install failed', result.message)
      }
    })
    // Keep the chain alive even if this link rejected, so a later launch retries
    // rather than inheriting a poisoned promise.
    installChains.set(
      chainKey,
      next.catch(() => {}),
    )
    await next.catch((error) => warn('Agent-state hook install threw', message(error)))
  }

  // Take a launch-injected CLI's workspace registration back out, once per
  // (target file, workspace) per app run. Serialized on the SAME chain the
  // installs use, because both read-modify-write one settings file.
  //
  // A user-scoped spec tidies the same path inside the workspace: Cursor's
  // `.cursor/hooks.json` and Grok's hook file were the repository's before they
  // moved to the home, and every worktree an earlier build launched in still
  // holds its copy.
  async function tidyWorkspaceRegistration(root: string, spec: PluginAgentStateSpec): Promise<void> {
    if (spec.registration.scope === 'user') {
      spec = { ...spec, registration: { ...spec.registration, scope: 'workspace' } }
    }
    const chainKey = `${spec.registration.path}::${root}`
    if (tidied.has(chainKey)) return
    const prior = installChains.get(chainKey) ?? Promise.resolve()
    const next = prior.then(async () => {
      if (tidied.has(chainKey)) return
      const removed = await removeWorkspaceAgentStateRegistration(root, spec.registration, {
        otherSpecs: options.listAgentStateSpecs?.() ?? [],
      })
      tidied.add(chainKey)
      if (removed.length > 0) {
        options.logDiagnostic?.({
          level: 'info',
          title: 'Workspace tidied',
          message:
            'This agent receives the agent-state hook with its launch, so the copy an earlier run wrote into the workspace was removed.',
          details: `${root}: ${removed.join(', ')}`,
        })
      }
    })
    installChains.set(
      chainKey,
      next.catch(() => {}),
    )
    await next.catch((error) => warn('Agent-state workspace tidy threw', message(error)))
  }

  return {
    initialize,
    shutdown,
    getSocketPath,
    ingestLine: handleLine,
    installForWorkspace,
    isRunning: () => server !== null,
  }
}

export function resolveAgentStateSocketPath(userDataDir: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\sprintengine-agent-state-${profileHash(userDataDir)}`
  }
  const direct = join(userDataDir, 'agent-state.sock')
  if (direct.length <= MAX_POSIX_SOCKET_PATH) return direct
  return join(tmpdir(), `sprintengine-agent-state-${profileHash(userDataDir)}.sock`)
}

function profileHash(userDataDir: string): string {
  return createHash('sha256').update(userDataDir).digest('hex').slice(0, 12)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
