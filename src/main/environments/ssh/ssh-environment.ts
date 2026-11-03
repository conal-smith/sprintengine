import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'

import type { MuxEndpoint } from '../../../../resources/wsl-server/relay-mux.mjs'
import { commitFailure } from '../../hosts/remote-install'
import { remoteNodeDigests, type RemoteNodeTarget } from '../../hosts/wsl-node-runtime'
import { connectRemoteConversationBackend, type RemoteConversationBackend } from '../../../server/wsl/backend-wire'
import type { FrontDoorPurpose } from '../../../server/wsl/front-door-proof'
import type { SshEnvironmentSettings, SshEnvironmentState, SshMachineGh } from '../../../shared/ssh-environments'
import type { RelayReady } from './relay-client'
import { classifySshFailure, type SshFailure } from './ssh-command'
import {
  assessProbe,
  buildConnectScript,
  locateServer,
  otherHostHolding,
  parseProbe,
  spaceFor,
  type Probe,
} from './ssh-connect-script'
import { buildInstallArchive } from './ssh-install'
import { RemoteSession, SessionClosedError, type SessionProcess } from './ssh-session'
import {
  ConnectionSupervisor,
  type ConnectionAttempt,
  type ConnectionState,
} from '../../../../packages/connection-supervisor/src/connectionSupervisor'

// One SSH machine's connection, in main (phase 8 spec, 5.6). Serialised: two
// triggers never run two bootstraps at once; a second `connect` while one
// runs waits for it.
//
//   idle ─connect─► connecting ─► probing ─┬─► installing ─► (a new session) probing
//                     │ asking (a dialog)   ├─► unsupported (musl, old glibc, Windows, noexec)
//                     └─► failed            ├─► starting | upgrading | (attach) ─► connected
//                                           └─► version-blocked
//   connected ─lost─► reconnecting (BatchMode, backoff 1 → 30 s) ─► connected
//                        │ a prompt would be needed: needs-sign-in (Connect)
//                        └ ten minutes of trying: disconnected ("last reached …"),
//                          still tried every five minutes, and at once on a wake
//
// When to try, how long to wait and what a wake does are the connection
// supervisor's (packages/connection-supervisor), the same rules every other
// reconnecting connection in the app follows; this class is the bootstrap it
// runs for each attempt and the words the machine's row says.
//
// The person's own click connects interactively (ssh may ask through the
// askpass dialogs); every background reconnect runs with BatchMode, and stops
// at `needs-sign-in` rather than raise a dialog over whatever they are doing.
//
// The managed server's life is not the connection's (decision R32): losing
// the session leaves it running, and its idle rule ends it when nobody comes
// back. Sleep, wake and a network change ask the session to answer at once
// instead of waiting out the keepalive on a dead socket: one that answers is
// kept, one that does not is restarted. A wake also lets a machine shown
// Disconnected try at once, since the network it was waiting for may be back.

export type SshServerConnection = {
  /** The router's key for this machine: `ssh:<saved id>`. */
  key: string
  id: string
  label: string
  backend: RemoteConversationBackend
  environmentId: string | null
  serverVersion: string | null
  /** A fresh, admitted Studio-server connection for `purpose`, over the same session. */
  open(purpose: FrontDoorPurpose): Promise<Duplex>
  /** A TCP connection made from the machine (the pane's traffic, spec 6.8). */
  openTcp(host: string, port: number): Promise<Duplex>
}

export type SshEnvironmentDeps = {
  id: string
  label(): string
  settings(): SshEnvironmentSettings
  /** Spawn `ssh … -- <destination> sh -s`; `interactive` gets an askpass token, a background one BatchMode. */
  spawn(options: { interactive: boolean }): SessionProcess
  app: { version: string; channel: 'latest' | 'nightly'; backendWire: number }
  /** `data`, or `data-<profile>` for a desktop on another profile. */
  dataName: string
  /** "Studio on dev-macbook-air", for the remote's record. */
  startedBy: string
  serverTree(): { dir: string; digest: string } | null
  nodeBinary(target: RemoteNodeTarget): Promise<{ binary: Buffer }>
  onChange(): void
  onConnected?(connection: SshServerConnection): void
  /** The server's environment id, once reached (the pane's partition is keyed by it). */
  onEnvironmentId?(environmentId: string): void
  log?(message: string): void
  now?(): number
  sleep?(ms: number): Promise<void>
  timing?: Partial<typeof DEFAULT_TIMING>
}

export const DEFAULT_TIMING = {
  /** ConnectTimeout plus the time a person may take in the dialogs. */
  probeInteractiveMs: 20_000 + 3 * 60_000,
  probeBackgroundMs: 45_000,
  installMs: 15 * 60_000,
  startMs: 90_000,
  upgradeMs: 150_000,
  relayMs: 15_000,
  handshakeMs: 15_000,
  /** A reconnect's waits: jittered, doubling from the base to the cap. */
  backoff: { baseMs: 1_000, maxMs: 30_000 },
  /** Trying this long (awake), a machine is shown Disconnected. It keeps trying. */
  giveUpMs: 10 * 60_000,
  /** The wait between tries once a machine is shown Disconnected. */
  disconnectedRetryMs: 5 * 60_000,
  /** How long a wake waits for a connected session to answer before calling it dead. */
  livenessMs: 10_000,
}

const IDLE_MS = 5 * 60_000

export type SshEnvironmentView = {
  state: SshEnvironmentState
  stateText: string
  working: boolean
  action: 'connect' | 'upgrade' | null
  server: { version: string; origin: string; startedBy: string | null } | null
  notes: string[]
  /** The machine's GitHub CLI as the last probe found it, with the OS it runs; null before one. */
  gh: SshMachineGh | null
  /** The last bootstrap's steps and what ssh said, for Settings › Diagnostics. */
  diagnostics: { noise: string; stderr: string; steps: Array<{ step: string; ms: number }>; probe: Probe | null }
}

class StepError extends Error {
  constructor(
    readonly state: SshEnvironmentState,
    message: string,
    readonly failure?: SshFailure,
    readonly offerUpgrade = false,
  ) {
    super(message)
  }
}

/** Any failure as a step's: what the bootstrap threw, or a loss's reason, in words. */
function asStep(error: unknown): StepError {
  return error instanceof StepError ? error : new StepError('failed', messageOf(error))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '')
}

function minutesAgo(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  return minutes <= 0 ? 'just now' : minutes === 1 ? '1 min ago' : `${minutes} min ago`
}

/**
 * States a background connect is refused in: each needs the person (a
 * prompt, a server to update, a machine to fix) or followed a failure the
 * person saw. Connect in Settings tries again. Disconnected is among them
 * although the machine is still tried every few minutes: a chat polling a
 * machine that has been away for ten minutes should hear so at once rather
 * than wait out the next try.
 */
const HELD_STATES: ReadonlySet<SshEnvironmentState> = new Set([
  'failed',
  'needs-sign-in',
  'disconnected',
  'version-blocked',
  'unsupported',
])

type BootstrapHint = { interactive: boolean }

/** A connected session as the supervisor holds it: the connection, and what carries it. */
type LiveSession = {
  connection: SshServerConnection
  endpoint: MuxEndpoint
  session: RemoteSession
  server: NonNullable<RelayReady['server']>
}

export class SshEnvironment {
  private view: SshEnvironmentView = {
    state: 'idle',
    stateText: 'Not connected',
    working: false,
    action: 'connect',
    server: null,
    notes: [],
    gh: null,
    diagnostics: { noise: '', stderr: '', steps: [], probe: null },
  }
  /** Owns the session's life: when to try, how long to wait, what a wake does, when to stop. */
  private readonly supervisor: ConnectionSupervisor<LiveSession, BootstrapHint>
  /** The session a bootstrap is building, until it is connected or fails. */
  private pending: RemoteSession | null = null
  /** The session the supervisor last said was up, so its arrival is announced once. */
  private announced: LiveSession | null = null
  private lastReachedAt: number | null = null
  /** Whether the failure that put the machine on hold ended a reconnect (its words differ). */
  private heldWhileReconnecting = false
  /** Stop server, while it runs: a connect asked for meanwhile joins it rather than start the server under it. */
  private stopping: Promise<never> | null = null
  private upgradeAsked = false
  /**
   * The person disconnected the machine or stopped its server: nothing in the
   * background (a chat, the explorer, a pane) connects again until they
   * connect in Settings, or it would undo what they just did.
   */
  private heldByPerson = false
  private readonly timing: typeof DEFAULT_TIMING
  private readonly now: () => number
  private readonly log: (message: string) => void

  constructor(private readonly deps: SshEnvironmentDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing }
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => undefined)
    const { backoff, giveUpMs, disconnectedRetryMs } = this.timing
    this.supervisor = new ConnectionSupervisor<LiveSession, BootstrapHint>({
      connect: (attempt) => this.bootstrap(attempt),
      close: (live, reason) => {
        this.log(`Closing the session to ${live.connection.label}: ${reason}`)
        live.endpoint.close(reason)
        this.release(live)
      },
      // A backend snapshot is what a session that answers can always give.
      ping: (live) => live.connection.backend.refresh(),
      classify: (error, { reconnecting }) => {
        const step = asStep(error)
        this.heldWhileReconnecting = reconnecting
        if (step.failure?.code === 'needs-sign-in') return { kind: 'needs-sign-in' }
        // A first connect that fails was seen by whoever asked: it is not retried
        // in the background. Neither is a server Studio cannot use, nor a changed
        // host key, on a reconnect: each needs the person.
        if (!reconnecting || step.state === 'unsupported' || step.state === 'version-blocked') return { kind: 'fatal' }
        if (step.failure?.code === 'host-key-changed') return { kind: 'fatal' }
        return { kind: 'transient' }
      },
      backoff: {
        ...backoff,
        // Trying this long, the machine is shown Disconnected and tried less often.
        maxMs: (state) => (state.retryingForMs >= giveUpMs ? disconnectedRetryMs : backoff.maxMs),
      },
      // Each bootstrap step has its own deadline; an install may take minutes.
      connectTimeoutMs: null,
      pingTimeoutMs: this.timing.livenessMs,
      clock: {
        now: this.now,
        setTimeout: (run, ms) => {
          const timer = setTimeout(run, ms)
          timer.unref?.()
          return timer
        },
        clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      },
    })
    this.supervisor.subscribe((state) => this.render(state))
  }

  get key(): string {
    return `ssh:${this.deps.id}`
  }

  summary(): SshEnvironmentView {
    return this.view
  }

  current(): SshServerConnection | null {
    return this.supervisor.current()?.connection ?? null
  }

  private set(next: Partial<SshEnvironmentView> & { state: SshEnvironmentState; stateText: string }): void {
    this.view = {
      ...this.view,
      working: false,
      action: null,
      ...next,
    }
    try {
      this.deps.onChange()
    } catch {
      // A listener's failure is its own.
    }
  }

  /**
   * Connect, or the connection already up. `interactive`: the person asked,
   * so ssh may ask them things; otherwise BatchMode, and a prompt it would
   * need ends at needs-sign-in.
   */
  connect(options: { interactive: boolean } = { interactive: false }): Promise<SshServerConnection> {
    if (options.interactive) this.heldByPerson = false
    else if (this.heldByPerson)
      return Promise.reject(
        new Error(`${this.deps.label()} was disconnected in Settings › Machines. Connect it there to use it again.`),
      )
    if (this.stopping) return this.stopping
    const live = this.supervisor.current()
    if (live) return Promise.resolve(live.connection)
    const { phase } = this.supervisor.state()
    // Serialised: a second connect while one runs waits for it.
    if (phase === 'connecting') return this.joinNext()
    // A background caller (a chat, the explorer, the pane) never jumps the
    // reconnect's backoff, and never retries what needs the person: polled
    // against a host that fails at once, it would run ssh at its poll rate.
    // While a reconnect waits out its backoff, it is joined instead.
    if (!options.interactive) {
      if (HELD_STATES.has(this.view.state)) return Promise.reject(new Error(this.view.stateText))
      if (phase === 'backoff') return this.joinNext()
      this.supervisor.start({ interactive: false })
      return this.joinNext()
    }
    this.supervisor.retryNow({ interactive: true })
    return this.joinNext()
  }

  /** The connection the attempt under way, or the backoff's next one, brings. */
  private joinNext(): Promise<SshServerConnection> {
    return this.supervisor.next().then((live) => live.connection)
  }

  /** What the view says between and after attempts, from the supervisor's state. Attempts say their own steps. */
  private render(state: ConnectionState): void {
    const label = this.deps.label()
    switch (state.phase) {
      case 'connecting':
        return
      case 'up': {
        const live = this.supervisor.current()
        if (live && live !== this.announced) this.announce(live)
        return
      }
      case 'idle':
      case 'stopped':
        this.set({ state: 'idle', stateText: 'Not connected', action: 'connect' })
        return
      case 'backoff':
      case 'waiting-for-wake':
        if (state.retryingForMs >= this.timing.giveUpMs) {
          // Not a give-up: it keeps trying, less often, and a wake tries at once.
          // Background callers are answered with these words meanwhile.
          this.set({
            state: 'disconnected',
            stateText: `Disconnected from ${label}${this.lastReachedAt ? ` — last reached ${minutesAgo(this.now() - this.lastReachedAt)}` : ''}. ${messageOf(state.lastError)}`,
            action: 'connect',
          })
        } else this.set({ state: 'reconnecting', stateText: this.reconnectingText(label), working: true })
        return
      case 'needs-sign-in': {
        const step = asStep(state.lastError)
        this.set({
          state: 'needs-sign-in',
          stateText: this.heldWhileReconnecting ? `${label} needs you to sign in.` : step.message,
          action: 'connect',
        })
        return
      }
      case 'failed': {
        const step = asStep(state.lastError)
        this.set({
          state: step.state,
          stateText: step.message,
          action: step.state === 'version-blocked' ? (step.offerUpgrade ? 'upgrade' : null) : 'connect',
        })
        return
      }
    }
  }

  /** One attempt, for the supervisor: probe, install if need be, start or attach, relay, handshake. */
  private async bootstrap(attempt: ConnectionAttempt<BootstrapHint>): Promise<LiveSession> {
    const interactive = attempt.hint?.interactive ?? false
    const label = this.deps.label()
    // A machine shown Disconnected is tried again without saying so, so its row
    // does not flicker to Reconnecting every few minutes; it says Connected if
    // the try succeeds. An attempt the supervisor dropped says nothing at all.
    const quiet = attempt.reconnecting && this.view.state === 'disconnected'
    const shows = (): boolean => attempt.current() && !quiet
    const steps: Array<{ step: string; ms: number }> = []
    const timed = async <T>(step: string, run: () => Promise<T>): Promise<T> => {
      const started = this.now()
      try {
        return await run()
      } finally {
        steps.push({ step, ms: this.now() - started })
      }
    }
    this.view.diagnostics = { noise: '', stderr: '', steps, probe: null }
    try {
      for (let installs = 0; ; installs++) {
        if (shows())
          this.set({
            state: attempt.reconnecting ? 'reconnecting' : 'connecting',
            stateText: attempt.reconnecting ? this.reconnectingText(label) : `Connecting to ${label}…`,
            working: true,
          })
        const session = RemoteSession.start(
          () => this.deps.spawn({ interactive }),
          buildConnectScript({
            appVersion: this.deps.app.version,
            serverDigest: this.deps.serverTree()?.digest ?? '0'.repeat(64),
            stageId: `s${randomBytes(6).toString('hex')}`,
            installDir: this.deps.settings().installDir,
            dataName: this.deps.dataName,
            channel: this.deps.app.channel,
          }),
        )
        this.pending = session
        const probe = await timed('probe', () => this.probe(session, interactive, label, shows))
        this.view.diagnostics.probe = probe
        const tree = this.deps.serverTree()
        if (!tree) {
          session.kill()
          throw new StepError(
            'failed',
            'This build of Studio has no server to install (run npm run build:server:wsl in a checkout).',
          )
        }
        const assessed = assessProbe(probe, {
          label,
          nodeDigests: remoteNodeDigests(),
          serverDigest: tree.digest,
          installDir: this.deps.settings().installDir,
        })
        this.view.notes = assessed.notes
        this.view.gh = { ...probe.gh, os: probe.os || null }
        if (!assessed.supported) {
          session.kill()
          throw new StepError('unsupported', assessed.reason)
        }
        if (assessed.needs.node || assessed.needs.server) {
          if (installs >= 2) {
            session.kill()
            throw new StepError('failed', `${label} still needs an install after two; see its diagnostics.`)
          }
          await timed('install', () =>
            this.install(session, probe, assessed.target, assessed.needs, tree, label, shows),
          )
          continue
        }
        const located = locateServer(
          probe,
          { version: this.deps.app.version, backendWire: this.deps.app.backendWire },
          label,
        )
        let decision: string
        let deadline = this.timing.relayMs
        const idle = this.deps.settings().keepRunning ? 'keep' : String(IDLE_MS)
        const by = Buffer.from(this.deps.startedBy, 'utf8').toString('base64url')
        if (located.action === 'blocked') {
          if (!(located.offerUpgrade && this.upgradeAsked)) {
            session.kill()
            throw new StepError('version-blocked', located.reason, undefined, located.offerUpgrade)
          }
          this.upgradeAsked = false
          if (shows())
            this.set({ state: 'upgrading', stateText: `Updating the Studio server on ${label}…`, working: true })
          decision = `upgrade ${idle} ${by}`
          deadline = this.timing.upgradeMs
        } else if (located.action === 'upgrade') {
          if (shows())
            this.set({
              state: 'upgrading',
              stateText: `Updating the Studio server on ${label} from ${located.from} to ${this.deps.app.version}…`,
              working: true,
            })
          decision = `upgrade ${idle} ${by}`
          deadline = this.timing.upgradeMs
        } else if (located.action === 'start') {
          if (shows())
            this.set({ state: 'starting', stateText: `Starting the Studio server on ${label}…`, working: true })
          decision = `start ${idle} ${by}`
          deadline = this.timing.startMs
        } else decision = 'attach'
        // The probe's end and SEND can come in two reads: wait for SEND itself.
        await session.waitForSend(10_000)
        session.send(decision)
        const relay = await timed('relay', () =>
          session.relay(deadline).catch((error: unknown) => {
            throw this.relayFailure(session, error, label)
          }),
        )
        return await timed('handshake', () => this.handshake(session, relay.ready, relay.endpoint, label, attempt))
      }
    } catch (error) {
      this.pending?.kill()
      this.view.diagnostics.stderr = this.view.diagnostics.stderr || (error as { stderr?: string }).stderr || ''
      // The supervisor decides what the failure means (classify) and the row
      // says so (render); here it only becomes a step's words.
      throw asStep(error)
    } finally {
      this.pending = null
    }
  }

  private reconnectingText(label: string): string {
    return this.lastReachedAt !== null
      ? `Reconnecting to ${label} — last reached ${minutesAgo(this.now() - this.lastReachedAt)}`
      : `Reconnecting to ${label}…`
  }

  /** The probe, or the reason the session never got that far, in words. */
  private async probe(
    session: RemoteSession,
    interactive: boolean,
    label: string,
    shows: () => boolean = () => true,
  ): Promise<Probe> {
    try {
      await session.waitFor(
        (line) => line === '@@SPRINTENGINE_PROBE end=1',
        interactive ? this.timing.probeInteractiveMs : this.timing.probeBackgroundMs,
        'the probe',
      )
    } catch (error) {
      session.kill()
      await session.closed()
      this.view.diagnostics.noise = session.noise
      this.view.diagnostics.stderr = session.stderr
      if (error instanceof SessionClosedError && (session.exit?.code ?? 0) !== 0) {
        const failure = classifySshFailure(session.stderr, label, { batch: !interactive })
        throw new StepError(failure.code === 'needs-sign-in' ? 'needs-sign-in' : 'failed', failure.message, failure)
      }
      throw new StepError(
        'failed',
        `Studio couldn't read ${label}'s setup${session.noise.trim() ? ` (its login printed: ${session.noise.trim().slice(0, 200)})` : ''}.`,
      )
    }
    this.view.diagnostics.noise = session.noise
    const probe = parseProbe(session.lines)
    if (!probe) throw new StepError('failed', `Studio couldn't read ${label}'s setup.`)
    if (shows()) this.set({ state: 'probing', stateText: `Checking ${label}…`, working: true })
    return probe
  }

  private async install(
    session: RemoteSession,
    probe: Probe,
    target: RemoteNodeTarget,
    needs: { node: boolean; server: boolean },
    tree: { dir: string; digest: string },
    label: string,
    shows: () => boolean,
  ): Promise<void> {
    const fetchHere = needs.node && this.deps.settings().remoteDownload
    const node = needs.node && !fetchHere ? (await this.deps.nodeBinary(target)).binary : null
    const archive = await buildInstallArchive({
      node,
      server: needs.server ? { dir: tree.dir, version: this.deps.app.version } : null,
    })
    const space = spaceFor(probe, archive.unpackedBytes + (fetchHere ? 120 * 1024 * 1024 : 0), label)
    if (space) {
      session.kill()
      throw new StepError('failed', space)
    }
    if (shows())
      this.set({
        state: 'installing',
        stateText: `Installing Studio server ${this.deps.app.version} on ${label} (${Math.max(1, Math.round(archive.bytes / (1024 * 1024)))} MB)…`,
        working: true,
      })
    await session.waitForSend(10_000)
    session.send(fetchHere ? 'install-fetch' : 'install', { body: archive.tarGz, end: true })
    try {
      await session.waitFor(
        (line) => line === '@@SPRINTENGINE_COMMITTED' || line.startsWith('@@SPRINTENGINE_FAIL'),
        this.timing.installMs,
        'the install',
      )
    } catch {
      // Its end says why, below.
    }
    await session.closed()
    if (session.lines.includes('@@SPRINTENGINE_COMMITTED')) return
    const reason = commitFailure(session.lines.join('\n'), session.stderr)
    this.view.diagnostics.stderr = session.stderr
    throw new StepError('failed', installFailureWords(reason, label))
  }

  private relayFailure(session: RemoteSession, error: unknown, label: string): StepError {
    this.view.diagnostics.stderr = session.stderr
    const fail = session.lines.find((line) => line.startsWith('@@SPRINTENGINE_FAIL '))
    if (fail) {
      const [, code = '', ...words] = fail.split(' ')
      const message =
        code === 'base-owner'
          ? `${words.join(' ')} on ${label} belongs to another user, so Studio will not run programs from it. Choose an install directory of your own.`
          : words.join(' ')
      return new StepError(
        code === 'other-host' ? 'version-blocked' : 'failed',
        message || `The Studio server on ${label} did not start.`,
      )
    }
    if (session.exit && session.exit.code !== 0 && session.exit.code !== 5) {
      const failure = classifySshFailure(session.stderr, label)
      if (failure.code !== 'unknown') return new StepError('failed', failure.message, failure)
    }
    return new StepError(
      'failed',
      `The Studio server on ${label} could not be reached (${error instanceof Error ? error.message : String(error)}).`,
    )
  }

  private async handshake(
    session: RemoteSession,
    ready: RelayReady,
    endpoint: MuxEndpoint,
    label: string,
    attempt: ConnectionAttempt<BootstrapHint>,
  ): Promise<LiveSession> {
    const server = ready.server
    if (!server)
      throw new StepError('failed', `No Studio server is running on ${label} after it was started; see its log there.`)
    const stream = await endpoint.open({ kind: 'owner', purpose: 'backend' }).catch((error: Error) => {
      throw new StepError('failed', `The Studio server on ${label} did not let Studio in: ${error.message}`)
    })
    const backend = connectRemoteConversationBackend(stream, { log: this.log })
    await Promise.race([
      backend.refresh(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new StepError('failed', `The Studio server on ${label} did not answer.`)),
          this.timing.handshakeMs,
        ),
      ),
    ])
    const connection: SshServerConnection = {
      key: this.key,
      id: this.deps.id,
      label,
      backend,
      environmentId: server.environmentId,
      serverVersion: server.version,
      open: (purpose) => endpoint.open({ kind: 'owner', purpose }),
      openTcp: (host, port) => endpoint.open({ kind: 'tcp', host, port }),
    }
    const live: LiveSession = { connection, endpoint, session, server }
    endpoint.onClosed((reason) => {
      this.release(live)
      if (attempt.current()) this.log(`The connection to ${label} was lost (${reason}); reconnecting.`)
      attempt.lost(new StepError('failed', reason))
    })
    void session.closed().then(() => endpoint.close('The SSH session ended.'))
    return live
  }

  /** A session that ended or was let go: its backend, its ssh, and the supervisor's hold on it. */
  private release(live: LiveSession): void {
    live.connection.backend.close()
    live.session.kill()
    if (this.announced === live) this.announced = null
  }

  /** The supervisor says a session is up: say so, once, to the view and to the listeners. */
  private announce(live: LiveSession): void {
    this.announced = live
    this.lastReachedAt = this.now()
    this.set({
      state: 'connected',
      stateText: 'Connected',
      server: {
        version: live.server.version ?? '?',
        origin: live.server.origin ?? 'bootstrap',
        startedBy: live.server.startedBy,
      },
    })
    if (live.server.environmentId) this.deps.onEnvironmentId?.(live.server.environmentId)
    try {
      this.deps.onConnected?.(live.connection)
    } catch (error) {
      this.log(`An SSH connection listener threw: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * The machine woke, the screen was unlocked, or the network came back. A
   * connected session may be dead, and keepalive would take up to 45 s to say
   * so: it is asked to answer now, and restarted only if it does not. Closing
   * it unasked would cost a full ssh handshake on every unlock, and a key
   * whose passphrase is not in ssh-agent cannot make one in the background,
   * so a healthy machine would end at "needs you to sign in".
   *
   * A machine reconnecting starts its backoff and its ten minutes over: time
   * asleep or offline was not time spent trying. One shown Disconnected tries
   * at once, since what it waited for may be back. What needs the person (a
   * sign-in, a changed host key) and what the person did (Disconnect, Stop
   * server) stay held.
   */
  wake(): void {
    if (this.heldByPerson) return
    this.supervisor.wake()
  }

  /** Let the session go. The managed server keeps running (its idle rule ends it). */
  disconnect(): void {
    this.heldByPerson = true
    // A bootstrap in flight ends with its ssh; what it would have brought is closed.
    this.pending?.kill()
    this.supervisor.stop('Disconnected.')
  }

  /** The person said yes to updating an older external server in place: connect once with the upgrade. */
  upgradeOnce(): Promise<SshServerConnection> {
    this.upgradeAsked = true
    return this.connect({ interactive: true })
  }

  /**
   * Drain and stop the managed server ("Stop server on build-box"). Run as
   * the machine's one operation in flight: a connect under way ends first,
   * and one asked for meanwhile joins the stop rather than starting the
   * server again under it.
   */
  async stopServer(): Promise<void> {
    this.heldByPerson = true
    if (this.supervisor.state().phase === 'connecting') await this.supervisor.next().catch(() => undefined)
    const stopping = this.stopNow()
    const joined = stopping.then(
      () => Promise.reject(new Error(`The Studio server on ${this.deps.label()} was stopped.`)),
      (error: unknown) => Promise.reject(error),
    )
    joined.catch(() => undefined)
    this.stopping = joined
    try {
      await stopping
    } finally {
      if (this.stopping === joined) this.stopping = null
    }
  }
  private async stopNow(): Promise<void> {
    const label = this.deps.label()
    this.disconnect()
    this.set({ state: 'connecting', stateText: `Stopping the Studio server on ${label}…`, working: true })
    const session = RemoteSession.start(
      () => this.deps.spawn({ interactive: true }),
      buildConnectScript({
        appVersion: this.deps.app.version,
        serverDigest: this.deps.serverTree()?.digest ?? '0'.repeat(64),
        stageId: `s${randomBytes(6).toString('hex')}`,
        installDir: this.deps.settings().installDir,
        dataName: this.deps.dataName,
        channel: this.deps.app.channel,
      }),
    )
    try {
      const probe = await this.probe(session, true, label)
      // The pid in a lock another machine holds is no process here: stopping
      // it would signal whatever on this machine has the same number.
      const otherHost = otherHostHolding(probe)
      if (otherHost) {
        session.kill()
        throw new StepError(
          'failed',
          `The Studio server for this home runs on ${otherHost}, not ${label}, so it can only be stopped there.`,
        )
      }
      if (probe.serverRecord && probe.serverRecord.origin !== 'bootstrap') {
        session.kill()
        throw new StepError(
          'failed',
          `The Studio server on ${label} was started outside this app, so this app leaves it running.`,
        )
      }
      await session.waitForSend(10_000)
      session.send('stop', { end: true })
      await session.waitFor((line) => line === '@@SPRINTENGINE_STOPPED', 90_000, 'the stop')
      this.set({
        state: 'idle',
        stateText: `The Studio server on ${label} is stopped.`,
        action: 'connect',
        server: null,
      })
    } catch (error) {
      session.kill()
      this.set({
        state: 'failed',
        stateText: error instanceof Error ? error.message : String(error),
        action: 'connect',
      })
      throw error
    }
  }
}

/** What a failed install printed, as a sentence. */
export function installFailureWords(reason: string, label: string): string {
  if (/Disk quota exceeded|No space left on device/u.test(reason))
    return `Not enough space on ${label} to install Studio (${/quota/u.test(reason) ? 'your disk quota is full' : 'the disk is full'}).`
  if (reason.startsWith('node-run'))
    return `The Node.js Studio installed can't run on ${label} (${reason.slice('node-run'.length).trim() || 'no reason given'}). Its home may be mounted noexec, or its glibc too old.`
  if (reason.startsWith('server-run') || reason.startsWith('server-version'))
    return `The Studio server Studio installed didn't start on ${label}: ${reason}.`
  if (reason.startsWith('digest '))
    return `The Node.js ${label} downloaded did not match its checksum (${reason.slice(7)}). Something between ${label} and nodejs.org changed it.`
  if (reason.startsWith('fetch-tool'))
    return `${label} has neither curl nor wget to download Node.js. Turn the remote download off for it.`
  if (reason.startsWith('fetch'))
    return `${label} couldn't download Node.js (${reason.slice(6)}). Check its network, or turn the remote download off.`
  if (reason === 'lock timeout') return `Another install on ${label} has not finished after two minutes.`
  if (reason.startsWith('base-owner'))
    return `${reason.slice('base-owner'.length).trim()} on ${label} belongs to another user, so Studio will not install there. Choose an install directory of your own.`
  return `Installing Studio on ${label} failed: ${reason || 'no reason given'}.`
}
