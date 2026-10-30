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
//                        └ ten minutes: disconnected ("last reached …")
//
// The person's own click connects interactively (ssh may ask through the
// askpass dialogs); every background reconnect runs with BatchMode, and stops
// at `needs-sign-in` rather than raise a dialog over whatever they are doing.
//
// The managed server's life is not the connection's (decision R32): losing
// the session leaves it running, and its idle rule ends it when nobody comes
// back. Sleep, wake and a network change ask the session to answer at once
// instead of waiting out the keepalive on a dead socket: one that answers is
// kept, one that does not is restarted. A wake also lets a machine that gave
// up reconnecting try again, since the network it was waiting for may be back.

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
  backoffMs: [1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
  giveUpMs: 10 * 60_000,
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

function minutesAgo(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  return minutes <= 0 ? 'just now' : minutes === 1 ? '1 min ago' : `${minutes} min ago`
}

/**
 * States a background connect does not retry: each needs the person (a
 * prompt, a server to update, a machine to fix) or followed a failure the
 * person saw. Connect in Settings tries again.
 */
const HELD_STATES: ReadonlySet<SshEnvironmentState> = new Set([
  'failed',
  'needs-sign-in',
  'disconnected',
  'version-blocked',
  'unsupported',
])

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
  private connection: SshServerConnection | null = null
  private session: RemoteSession | null = null
  private endpoint: MuxEndpoint | null = null
  private running: Promise<SshServerConnection> | null = null
  private intentional = false
  private lastReachedAt: number | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private lostAt: number | null = null
  /** Background callers waiting out a reconnect's backoff: they get its next attempt. */
  private waiting: {
    promise: Promise<SshServerConnection>
    settle(attempt: Promise<SshServerConnection>): void
  } | null = null
  /** A wake's check that the connected session still answers, while it runs. */
  private livenessCheck: Promise<void> | null = null
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
  }

  get key(): string {
    return `ssh:${this.deps.id}`
  }

  summary(): SshEnvironmentView {
    return this.view
  }

  current(): SshServerConnection | null {
    return this.connection
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
    if (this.connection && this.endpoint && !this.endpoint.closed) return Promise.resolve(this.connection)
    if (this.running) return this.running
    // A background caller (a chat, the explorer, the pane) never jumps the
    // reconnect's backoff, and never retries what needs the person: polled
    // against a host that fails at once, it would run ssh at its poll rate.
    // While a reconnect waits out its backoff, it is joined instead.
    if (!options.interactive) {
      if (this.reconnectTimer !== null) return this.nextAttempt()
      if (HELD_STATES.has(this.view.state)) return Promise.reject(new Error(this.view.stateText))
    }
    return this.start(options.interactive)
  }

  private start(interactive: boolean): Promise<SshServerConnection> {
    this.intentional = false
    this.clearReconnect()
    const running = this.bootstrap(interactive).finally(() => {
      this.running = null
    })
    this.running = running
    this.settleWaiting(running)
    return running
  }

  /** The reconnect attempt after the current backoff, for a background caller to wait on. */
  private nextAttempt(): Promise<SshServerConnection> {
    if (!this.waiting) {
      let settle: (attempt: Promise<SshServerConnection>) => void = () => undefined
      const promise = new Promise<SshServerConnection>((resolve, reject) => {
        settle = (attempt) => void attempt.then(resolve, reject)
      })
      this.waiting = { promise, settle }
    }
    return this.waiting.promise
  }

  /** Hand the waiting callers an attempt, or the reason there is none. */
  private settleWaiting(attempt: Promise<SshServerConnection> | Error): void {
    const waiting = this.waiting
    this.waiting = null
    waiting?.settle(attempt instanceof Error ? Promise.reject(attempt) : attempt)
  }

  /** The backoff's own attempt, and wake's: these may start a background bootstrap. */
  private retry(): void {
    if (this.running || (this.connection && this.endpoint && !this.endpoint.closed)) return
    void this.start(false).catch(() => undefined)
  }

  private async bootstrap(interactive: boolean): Promise<SshServerConnection> {
    const label = this.deps.label()
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
        const reconnecting = this.lostAt !== null
        this.set({
          state: reconnecting ? 'reconnecting' : 'connecting',
          stateText: reconnecting ? this.reconnectingText(label) : `Connecting to ${label}…`,
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
        this.session = session
        const probe = await timed('probe', () => this.probe(session, interactive, label))
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
          await timed('install', () => this.install(session, probe, assessed.target, assessed.needs, tree, label))
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
          this.set({ state: 'upgrading', stateText: `Updating the Studio server on ${label}…`, working: true })
          decision = `upgrade ${idle} ${by}`
          deadline = this.timing.upgradeMs
        } else if (located.action === 'upgrade') {
          this.set({
            state: 'upgrading',
            stateText: `Updating the Studio server on ${label} from ${located.from} to ${this.deps.app.version}…`,
            working: true,
          })
          decision = `upgrade ${idle} ${by}`
          deadline = this.timing.upgradeMs
        } else if (located.action === 'start') {
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
        return await timed('handshake', () => this.handshake(session, relay.ready, relay.endpoint, label))
      }
    } catch (error) {
      this.session?.kill()
      this.session = null
      const step =
        error instanceof StepError
          ? error
          : new StepError('failed', error instanceof Error ? error.message : String(error))
      this.view.diagnostics.stderr = this.view.diagnostics.stderr || (error as { stderr?: string }).stderr || ''
      if (this.lostAt !== null && step.state !== 'unsupported' && step.state !== 'version-blocked') {
        // A background reconnect that failed: try again later, or say what it needs.
        if (step.failure?.code === 'needs-sign-in' || step.failure?.code === 'host-key-changed') {
          this.set({
            state: step.failure.code === 'needs-sign-in' ? 'needs-sign-in' : 'failed',
            stateText: step.failure.code === 'needs-sign-in' ? `${label} needs you to sign in.` : step.message,
            action: 'connect',
          })
          this.lostAt = null
        } else this.scheduleReconnect(label, step.message)
        throw step
      }
      // A reconnect that ends here (a server it cannot use) is not reconnecting any more.
      this.lostAt = null
      this.set({
        state: step.failure?.code === 'needs-sign-in' ? 'needs-sign-in' : step.state,
        stateText: step.message,
        action: step.state === 'version-blocked' ? (step.offerUpgrade ? 'upgrade' : null) : 'connect',
      })
      throw step
    }
  }

  private reconnectingText(label: string): string {
    return this.lastReachedAt !== null
      ? `Reconnecting to ${label} — last reached ${minutesAgo(this.now() - this.lastReachedAt)}`
      : `Reconnecting to ${label}…`
  }

  /** The probe, or the reason the session never got that far, in words. */
  private async probe(session: RemoteSession, interactive: boolean, label: string): Promise<Probe> {
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
    this.set({ state: 'probing', stateText: `Checking ${label}…`, working: true })
    return probe
  }

  private async install(
    session: RemoteSession,
    probe: Probe,
    target: RemoteNodeTarget,
    needs: { node: boolean; server: boolean },
    tree: { dir: string; digest: string },
    label: string,
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
  ): Promise<SshServerConnection> {
    if (!ready.server)
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
      environmentId: ready.server.environmentId,
      serverVersion: ready.server.version,
      open: (purpose) => endpoint.open({ kind: 'owner', purpose }),
      openTcp: (host, port) => endpoint.open({ kind: 'tcp', host, port }),
    }
    this.connection = connection
    this.endpoint = endpoint
    this.session = session
    this.lastReachedAt = this.now()
    this.lostAt = null
    this.attempt = 0
    endpoint.onClosed((reason) => this.lost(connection, reason))
    void session.closed().then(() => endpoint.close('The SSH session ended.'))
    this.set({
      state: 'connected',
      stateText: 'Connected',
      server: {
        version: ready.server.version ?? '?',
        origin: ready.server.origin ?? 'bootstrap',
        startedBy: ready.server.startedBy,
      },
    })
    if (ready.server.environmentId) this.deps.onEnvironmentId?.(ready.server.environmentId)
    try {
      this.deps.onConnected?.(connection)
    } catch (error) {
      this.log(`An SSH connection listener threw: ${error instanceof Error ? error.message : String(error)}`)
    }
    return connection
  }

  private lost(connection: SshServerConnection, reason: string): void {
    if (this.connection !== connection) return
    this.connection = null
    this.endpoint = null
    connection.backend.close()
    this.session?.kill()
    this.session = null
    if (this.intentional) {
      this.set({ state: 'idle', stateText: 'Not connected', action: 'connect' })
      return
    }
    this.log(`The connection to ${connection.label} was lost (${reason}); reconnecting.`)
    this.lostAt = this.now()
    this.scheduleReconnect(connection.label, reason)
  }

  private scheduleReconnect(label: string, reason: string): void {
    this.clearReconnect()
    if (this.lostAt !== null && this.now() - this.lostAt > this.timing.giveUpMs) {
      this.set({
        state: 'disconnected',
        stateText: `Disconnected from ${label}${this.lastReachedAt ? ` — last reached ${minutesAgo(this.now() - this.lastReachedAt)}` : ''}. ${reason}`,
        action: 'connect',
      })
      this.lostAt = null
      this.settleWaiting(new Error(this.view.stateText))
      return
    }
    const wait = this.timing.backoffMs[Math.min(this.attempt, this.timing.backoffMs.length - 1)]!
    this.attempt++
    this.set({ state: 'reconnecting', stateText: this.reconnectingText(label), working: true })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.retry()
    }, wait)
    this.reconnectTimer.unref?.()
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
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
   * asleep or offline was not time spent trying. One that already gave up
   * (`disconnected`) tries again, since what it waited for may be back. What
   * needs the person (a sign-in, a changed host key) and what the person did
   * (Disconnect, Stop server) stay held.
   */
  wake(): void {
    this.attempt = 0
    if (this.endpoint && !this.endpoint.closed) {
      void this.checkLiveness()
      return
    }
    if (this.lostAt !== null) {
      this.lostAt = this.now()
      if (!this.running) this.retry()
      return
    }
    if (this.view.state === 'disconnected' && !this.heldByPerson && !this.running) {
      this.lostAt = this.now()
      this.retry()
    }
  }

  /** Whether the connected session answers within `livenessMs`; closed, and so reconnected, when it does not. */
  private checkLiveness(): Promise<void> {
    if (this.livenessCheck) return this.livenessCheck
    const connection = this.connection
    const endpoint = this.endpoint
    if (!connection || !endpoint) return Promise.resolve()
    const check = (async () => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const answered = await Promise.race([
        connection.backend.refresh().then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), this.timing.livenessMs)
          timer.unref?.()
        }),
      ])
      if (timer) clearTimeout(timer)
      if (answered || this.endpoint !== endpoint || endpoint.closed) return
      this.log(`${connection.label} did not answer within ${this.timing.livenessMs} ms of a wake; reconnecting.`)
      endpoint.close('The connection stopped answering after the computer woke or its network changed.')
    })().finally(() => {
      this.livenessCheck = null
    })
    this.livenessCheck = check
    return check
  }

  /** Let the session go. The managed server keeps running (its idle rule ends it). */
  disconnect(): void {
    this.heldByPerson = true
    this.intentional = true
    this.clearReconnect()
    this.lostAt = null
    this.settleWaiting(new Error('Disconnected.'))
    const endpoint = this.endpoint
    if (endpoint) endpoint.close('Disconnected.')
    else {
      this.session?.kill()
      this.set({ state: 'idle', stateText: 'Not connected', action: 'connect' })
    }
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
    await this.running?.catch(() => undefined)
    const stopping = this.stopNow()
    const joined = stopping.then(
      () => Promise.reject(new Error(`The Studio server on ${this.deps.label()} was stopped.`)),
      (error: unknown) => Promise.reject(error),
    )
    joined.catch(() => undefined)
    this.running = joined
    try {
      await stopping
    } finally {
      if (this.running === joined) this.running = null
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
