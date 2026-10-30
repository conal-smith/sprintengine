import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'

import { BACKEND_WIRE_VERSION } from '../../../server/wsl/backend-wire'
import { wslServerTreeDir } from '../../../server/wsl/desktop-wsl-servers'
import type { SshRoutedConnection, SshRoutedServers } from '../../../server/core/routed-conversation-backend'
import {
  DEFAULT_SSH_ENVIRONMENT_SETTINGS,
  SSH_ENV_CHANNELS,
  type SavedSshEnvironment,
  type SshEnvironmentResult,
  type SshEnvironmentSettings,
  type SshEnvironmentSummary,
  type SshPromptRequest,
  type SshResolveResult,
} from '../../../shared/ssh-environments'
import { wslProfileId } from '../../hosts/wsl-helper-runtime'
import { cliForConversationProvider } from '../../../shared/conversation-harness'
import { SIGN_IN_FLOWS } from '../../../server/machine/machine-sign-in'
import {
  ASKPASS_TIMEOUT_MS,
  createAskpassBroker,
  marksRemotePrompts,
  type AskpassBroker,
  type AskpassRequest,
} from './askpass'
import {
  configHostNames,
  findSshBinary,
  parseDestination,
  resolveDestination,
  spawnSshSession,
  type SshDestination,
} from './ssh-command'
import { SshEnvironment, type SshServerConnection } from './ssh-environment'
import { ensureNodeBinary, serverTreeDigest } from './ssh-install'
import type { SessionProcess } from './ssh-session'

// The desktop's SSH machines (phase 8): what the person saved, one state
// machine each, and the askpass broker their sessions ask through. Main owns
// them (decision R65): the prompts are dialogs, and the pane's forward is a
// session proxy, both of which only main can show or set.
//
// Saved machines are client-owned (userData/ssh-environments.json) and hold
// no credential: a route, a label and settings. Forgetting one deletes that
// and, only when asked, stops the server on the machine.

const STORE_FILE = 'ssh-environments.json'

export type SshEnvironmentsDeps = {
  userDataDir: string
  app: { version: string; channel: 'latest' | 'nightly' }
  packaged: boolean
  resourcesDir: string | null
  appRoot: string | null
  /** The installed app's own profile (`data`); any other gets `data-<id>` on the remote. */
  isDefaultProfile: boolean
  /** "Studio on <this computer>", written in the remote's record. */
  startedBy: string
  /** The network stack that honours the system proxy: Electron's `net.fetch`. */
  fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>
  /** Every workspace window: prompts and changes go to all of them. */
  broadcast(channel: string, payload: unknown): void
  /** A `-F` ssh config for every session (the integration suites); null for the person's own. */
  configFile?: string | null
  sshBinary?: string | null
  /** A machine was forgotten (its pane forward closes; its browsing data goes when asked). */
  onForget?(saved: SavedSshEnvironment, options: { clearBrowsingData: boolean }): Promise<void> | void
  log?(message: string): void
}

type Prompt = { request: SshPromptRequest; resolve(answer: string | null): void }

function readStore(path: string): SavedSshEnvironment[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { v?: unknown; environments?: unknown }
    if (parsed.v !== 1 || !Array.isArray(parsed.environments)) return []
    return parsed.environments.filter(
      (entry): entry is SavedSshEnvironment =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as SavedSshEnvironment).id === 'string' &&
        typeof (entry as SavedSshEnvironment).destination === 'string' &&
        parseDestination((entry as SavedSshEnvironment).destination).ok,
    )
  } catch {
    return []
  }
}

/** `ssh -V`'s line (OpenSSH writes it to stderr), or '' when it does not answer within five seconds. */
function sshVersion(ssh: string): Promise<string> {
  return new Promise((resolve) => {
    let text = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(ssh, ['-V'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      resolve('')
      return
    }
    const timer = setTimeout(() => child.kill(), 5_000)
    const take = (chunk: Buffer) => (text = (text + chunk.toString('utf8')).slice(0, 400))
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.once('error', () => {
      clearTimeout(timer)
      resolve('')
    })
    child.once('close', () => {
      clearTimeout(timer)
      resolve(text.trim().split('\n')[0] ?? '')
    })
  })
}

/** Words for Settings › Diagnostics, with the remote user's name and SSH addresses taken out (spec 6.5). */
export function redactDiagnostics(text: string, user: string | null): string {
  let out = text
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/gu, '<address>')
    .replace(/\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b/giu, '<address>')
  out = out.replace(/seown_[A-Za-z0-9_-]+|[A-Za-z0-9_-]{43}(?=\s|$)/gu, '<token>')
  if (user && user.length > 1) out = out.split(user).join('<user>')
  return out
}

/** Each CLI's own login, as a person types it in a terminal on the machine. */
const LOGIN_COMMANDS: Readonly<Record<string, string>> = {
  'claude-code': 'claude auth login',
  codex: 'codex login --device-auth',
  cursor: 'cursor-agent login',
  opencode: 'opencode auth login',
  gemini: 'gemini',
  'kimi-code': 'kimi login',
}

/** The words for a CLI Studio cannot sign in without a terminal: the exact command, over the person's own SSH. */
export function signInOverSsh(cli: string, saved: Pick<SavedSshEnvironment, 'destination' | 'label'>): string {
  const parsed = parseDestination(saved.destination)
  const destination = parsed.ok ? parsed.destination.argv : saved.destination
  const login = LOGIN_COMMANDS[cli]
  if (!login)
    return `${cli} signs in with an API key: set it for the chat, or sign it in on ${saved.label} as its own documentation says.`
  return `Sign ${cli} in once on ${saved.label} over your own SSH session: ssh -t ${destination} ${login}`
}

export class SshEnvironments {
  private saved: SavedSshEnvironment[]
  private readonly machines = new Map<string, SshEnvironment>()
  private broker: Promise<AskpassBroker> | null = null
  /** The broker once it is listening; an interactive spawn waits for it (`askpass()`). */
  private brokerReady: AskpassBroker | null = null
  private readonly prompts = new Map<string, Prompt>()
  private readonly connectedListeners: Array<(connection: SshServerConnection) => void> = []
  private tree: { dir: string; digest: string } | null | undefined
  private readonly path: string
  private readonly log: (message: string) => void

  constructor(private readonly deps: SshEnvironmentsDeps) {
    this.path = join(deps.userDataDir, STORE_FILE)
    this.saved = readStore(this.path)
    this.log = deps.log ?? (() => undefined)
  }

  // ── The routed servers (studio-core's router reaches SSH machines through these) ──

  readonly routed: SshRoutedServers = {
    connect: async (key) => {
      const machine = this.machineFor(key)
      return machine.connect({ interactive: false })
    },
    current: (key): SshRoutedConnection | null => this.machines.get(key.slice('ssh:'.length))?.current() ?? null,
    touch: () => undefined,
  }

  onConnected(listener: (connection: SshServerConnection) => void): void {
    this.connectedListeners.push(listener)
  }

  private machineFor(key: string): SshEnvironment {
    const id = key.startsWith('ssh:') ? key.slice(4) : key
    const machine = this.machine(id)
    if (!machine) throw new Error('That SSH machine is no longer saved in Settings › Machines.')
    return machine
  }

  // ── Saved machines ─────────────────────────────────────────────────────────

  private persist(): void {
    mkdirSync(this.deps.userDataDir, { recursive: true })
    const staged = `${this.path}.${process.pid}`
    writeFileSync(staged, `${JSON.stringify({ v: 1, environments: this.saved }, null, 2)}\n`, { mode: 0o600 })
    renameSync(staged, this.path)
    this.changed()
  }

  private changed(): void {
    this.deps.broadcast(SSH_ENV_CHANNELS.changed, null)
  }

  get(id: string): SavedSshEnvironment | null {
    return this.saved.find((entry) => entry.id === id) ?? null
  }

  private destinationOf(id: string): SshDestination {
    const saved = this.get(id)
    const parsed = saved ? parseDestination(saved.destination) : null
    if (!parsed?.ok) throw new Error('That SSH machine is no longer saved in Settings › Machines.')
    return parsed.destination
  }

  private ssh(): string {
    return findSshBinary({ override: this.deps.sshBinary ?? null })
  }

  private serverTree(): { dir: string; digest: string } | null {
    if (this.tree !== undefined) return this.tree
    const dir = wslServerTreeDir(this.deps)
    this.tree = dir ? { dir, digest: serverTreeDigest(dir) } : null
    return this.tree
  }

  private dataName(): string {
    return this.deps.isDefaultProfile && this.deps.app.channel === 'latest'
      ? 'data'
      : `data-${wslProfileId(this.deps.userDataDir)}`
  }

  private askpass(): Promise<AskpassBroker> {
    if (this.broker) return this.broker
    const broker = sshVersion(this.ssh()).then((version) => {
      // Before OpenSSH 8.4 a remote's question is not marked as the remote's.
      const remoteMarked = marksRemotePrompts(version)
      if (!remoteMarked)
        this.log(
          `${version || 'This ssh'} does not mark the questions a machine asks, so its passphrase and password questions are shown as ones Studio cannot vouch for.`,
        )
      return createAskpassBroker({
        ask: (request, signal) => this.ask(request, signal),
        remoteMarked: () => remoteMarked,
        log: this.log,
      }).then((ready) => (this.brokerReady = ready))
    })
    // A broker that could not start (no ssh found, its socket refused) is
    // tried again by the next connect, not refused for the rest of the run.
    broker.catch(() => {
      if (this.broker === broker) this.broker = null
    })
    this.broker = broker
    return broker
  }

  /** Show ssh's question in every window; the first answer wins, the others close. */
  private ask(
    request: AskpassRequest & { signIn?: SshPromptRequest['signIn'] },
    signal: AbortSignal,
  ): Promise<string | null> {
    const id = randomUUID()
    const shown: SshPromptRequest = {
      id,
      label: request.label,
      kind: request.kind,
      text: request.text,
      ...(request.hostKey ? { hostKey: request.hostKey } : {}),
      ...(request.unverified ? { unverified: true } : {}),
      ...(request.signIn ? { signIn: request.signIn } : {}),
      // A login waits on a person in a browser: as long as its code lasts.
      expiresAt: Date.now() + (request.signIn ? 15 * 60_000 : ASKPASS_TIMEOUT_MS),
    }
    return new Promise((resolve) => {
      const finish = (answer: string | null) => {
        if (!this.prompts.delete(id)) return
        this.deps.broadcast(SSH_ENV_CHANNELS.promptClosed, { id })
        resolve(answer)
      }
      this.prompts.set(id, { request: shown, resolve: finish })
      signal.addEventListener('abort', () => finish(null), { once: true })
      this.deps.broadcast(SSH_ENV_CHANNELS.prompt, shown)
    })
  }

  /** A window's answer to a prompt it was shown. Unknown ids (answered elsewhere, expired) are ignored. */
  answer(id: string, answer: string | null): void {
    this.prompts.get(id)?.resolve(typeof answer === 'string' ? answer : null)
  }

  private machine(id: string): SshEnvironment | null {
    const existing = this.machines.get(id)
    if (existing) return existing
    const saved = this.get(id)
    if (!saved) return null
    const machine: SshEnvironment = new SshEnvironment({
      id,
      label: () => this.get(id)?.label ?? saved.label,
      settings: () => this.get(id)?.settings ?? DEFAULT_SSH_ENVIRONMENT_SETTINGS,
      spawn: ({ interactive }) =>
        spawnSshSession({
          ssh: this.ssh(),
          destination: this.destinationOf(id),
          label: this.get(id)?.label ?? saved.label,
          interactive,
          askpass: this.brokerReady,
          configFile: this.deps.configFile ?? null,
        }) as unknown as SessionProcess,
      app: { ...this.deps.app, backendWire: BACKEND_WIRE_VERSION },
      dataName: this.dataName(),
      startedBy: this.deps.startedBy,
      serverTree: () => this.serverTree(),
      nodeBinary: (target) =>
        ensureNodeBinary(target, {
          cacheDir: join(this.deps.userDataDir, 'ssh-runtime'),
          subject: this.get(id)?.label ?? saved.label,
          ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
        }),
      onChange: () => this.changed(),
      onConnected: (connection) => {
        for (const listener of this.connectedListeners) {
          try {
            listener(connection)
          } catch (error) {
            this.log(`An SSH connection listener threw: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      },
      onEnvironmentId: (environmentId) => {
        const entry = this.get(id)
        if (!entry || entry.environmentId === environmentId) return
        entry.environmentId = environmentId
        this.persist()
      },
      log: this.log,
    })
    this.machines.set(id, machine)
    return machine
  }

  list(): SshEnvironmentSummary[] {
    return this.saved.map((saved) => {
      const view = this.machines.get(saved.id)?.summary()
      return {
        ...saved,
        state: view?.state ?? 'idle',
        stateText: view?.stateText ?? 'Not connected',
        working: view?.working ?? false,
        action: view ? view.action : 'connect',
        server: view?.server ?? null,
        notes: view?.notes ?? [],
        gh: view?.gh ?? null,
      }
    })
  }

  async suggestions(): Promise<string[]> {
    try {
      return configHostNames(await readFile(join(homedir(), '.ssh', 'config'), 'utf8'))
    } catch {
      return []
    }
  }

  async resolve(destination: string): Promise<SshResolveResult> {
    const parsed = parseDestination(destination)
    if (!parsed.ok) return parsed
    const resolved = await resolveDestination(this.ssh(), parsed.destination, {
      configFile: this.deps.configFile ?? null,
    })
    if (!resolved.ok) return resolved
    const notes: string[] = []
    if (resolved.resolved.strictHostKeyChecking === 'no' || resolved.resolved.strictHostKeyChecking === 'false')
      notes.push(
        'Your SSH config turns host key checking off for this machine (StrictHostKeyChecking no). That is its choice; Studio does not change it.',
      )
    if (resolved.resolved.forwardAgent === 'yes')
      notes.push("Your SSH config forwards your agent here; Studio's sessions never do.")
    return {
      ok: true,
      destination: parsed.destination.display,
      resolved: {
        hostname: resolved.resolved.hostname,
        user: resolved.resolved.user,
        port: resolved.resolved.port,
        proxyJump: resolved.resolved.proxyJump,
        notes,
      },
    }
  }

  async add(input: { destination: string; label?: string }): Promise<SshEnvironmentResult & { id?: string }> {
    const resolved = await this.resolve(input.destination)
    if (!resolved.ok) return resolved
    if (this.saved.some((entry) => entry.destination === resolved.destination))
      return { ok: false, message: `${resolved.destination} is already one of your machines.` }
    const label = (input.label?.trim() || resolved.destination).slice(0, 80)
    const entry: SavedSshEnvironment = {
      id: randomBytes(8).toString('hex'),
      label,
      destination: resolved.destination,
      resolved: {
        hostname: resolved.resolved.hostname,
        user: resolved.resolved.user,
        port: resolved.resolved.port,
        proxyJump: resolved.resolved.proxyJump,
      },
      environmentId: null,
      settings: { ...DEFAULT_SSH_ENVIRONMENT_SETTINGS },
      addedAt: Date.now(),
    }
    this.saved.push(entry)
    this.persist()
    return { ok: true, id: entry.id }
  }

  update(id: string, patch: Partial<SshEnvironmentSettings> & { label?: string }): SshEnvironmentResult {
    const entry = this.get(id)
    if (!entry) return { ok: false, message: 'That SSH machine is no longer saved.' }
    if (patch.installDir !== undefined && patch.installDir !== null && !/^\/[A-Za-z0-9._/-]+$/u.test(patch.installDir))
      return {
        ok: false,
        message: 'The install directory must be an absolute path of plain characters (no spaces or quotes).',
      }
    if (patch.label !== undefined) entry.label = patch.label.trim().slice(0, 80) || entry.label
    const { label: _label, ...settings } = patch
    entry.settings = { ...entry.settings, ...settings }
    this.persist()
    return { ok: true }
  }

  async connect(id: string): Promise<SshEnvironmentResult> {
    const machine = this.machine(id)
    if (!machine) return { ok: false, message: 'That SSH machine is no longer saved.' }
    // The person asked: ssh may ask them things, so the broker listens first.
    try {
      await this.askpass()
      await machine.connect({ interactive: true })
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  disconnect(id: string): SshEnvironmentResult {
    this.machines.get(id)?.disconnect()
    return { ok: true }
  }

  async stopServer(id: string): Promise<SshEnvironmentResult> {
    const machine = this.machine(id)
    if (!machine) return { ok: false, message: 'That SSH machine is no longer saved.' }
    try {
      await this.askpass()
      await machine.stopServer()
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** The person said yes to updating an older server started outside this app (decision R31). */
  async upgradeServer(id: string): Promise<SshEnvironmentResult> {
    const machine = this.machine(id)
    if (!machine) return { ok: false, message: 'That SSH machine is no longer saved.' }
    try {
      await this.askpass()
      await machine.upgradeOnce()
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * A stream on a machine's relay for the desktop's server out of process
   * (`purpose` as the front door names it), connecting in the background
   * first when it must.
   */
  async openStream(key: string, purpose: 'backend' | 'studio'): Promise<{ stream: Duplex; label: string }> {
    const machine = this.machineFor(key)
    const connection = await machine.connect({ interactive: false })
    return { stream: await connection.open(purpose), label: connection.label }
  }

  /**
   * A machine channel (shared/machine-channels.ts) answered by that machine's
   * server, for a workspace on it. Connects in the background (never a
   * prompt) when it must; says in words when it cannot.
   */
  async machineCall(id: string, channel: string, args: unknown[]): Promise<unknown> {
    const saved = this.get(id)
    if (!saved) throw new Error('That SSH machine is no longer saved in Settings › Machines.')
    if (!this.connection(id) && !(await this.connectQuietly(id, 20_000)))
      throw new Error(`${saved.label} is not connected. Connect it in Settings › Machines.`)
    const connection = this.connection(id)
    if (!connection) throw new Error(`${saved.label} is not connected. Connect it in Settings › Machines.`)
    return connection.backend.machine(channel, args)
  }

  /**
   * Sign a chat's CLI in on the machine, with no terminal (decision R34):
   * the login runs on the machine, its link and code are shown in a dialog,
   * a pasted code goes back. A CLI with no such flow is answered with the
   * command to run once over the person's own SSH session.
   */
  async signIn(id: string, providerId: string): Promise<SshEnvironmentResult> {
    const saved = this.get(id)
    if (!saved) return { ok: false, message: 'That SSH machine is no longer saved in Settings › Machines.' }
    const cli = cliForConversationProvider(providerId)
    if (!cli) return { ok: false, message: 'This chat has no CLI to sign in.' }
    const over = signInOverSsh(cli, saved)
    if (!SIGN_IN_FLOWS[cli]) return { ok: false, message: over }
    if (!this.connection(id) && !(await this.connectQuietly(id, 20_000)))
      return { ok: false, message: `${saved.label} is not connected. Connect it in Settings › Machines.` }
    const connection = this.connection(id)
    if (!connection) return { ok: false, message: `${saved.label} is not connected.` }
    try {
      await this.askpass()
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    const started = await connection.backend.signIn({ op: 'start', cli })
    if (!started.ok) return { ok: false, message: `${started.message} ${over}` }
    const finished = new AbortController()
    const waiting = connection.backend.signIn({ op: 'wait', id: started.id }).finally(() => finished.abort())
    const answer = await this.ask(
      {
        kind: 'sign-in',
        label: saved.label,
        text: `Sign in to ${SIGN_IN_FLOWS[cli]!.binary} on ${saved.label}.`,
        signIn: { cli, url: started.url, code: started.code, paste: started.paste },
      },
      finished.signal,
    )
    if (finished.signal.aborted) return waiting
    if (answer === null || (started.paste && !answer.trim())) {
      // Nobody waits on the login any more: a wire that drops now is not an unhandled rejection.
      waiting.catch(() => undefined)
      await connection.backend.signIn({ op: 'cancel', id: started.id }).catch(() => undefined)
      return { ok: false, message: answer === null ? 'Sign-in cancelled.' : 'No code was pasted, so sign-in stopped.' }
    }
    if (started.paste) {
      const pasted = await connection.backend.signIn({ op: 'paste', id: started.id, code: answer })
      if (!pasted.ok) {
        waiting.catch(() => undefined)
        await connection.backend.signIn({ op: 'cancel', id: started.id }).catch(() => undefined)
        return { ok: false, message: 'That code could not be sent to the sign-in. Try signing in again.' }
      }
    }
    return waiting
  }

  /** The keys of the machines connected now. */
  connectedKeys(): string[] {
    return [...this.machines.values()].filter((machine) => machine.current()).map((machine) => machine.key)
  }

  /** A machine's live connection, or null; never connects. */
  connection(id: string): SshServerConnection | null {
    return this.machines.get(id)?.current() ?? null
  }

  /** Bring a machine up in the background (no prompt); true once it is, false after `ms` or on failure. */
  async connectQuietly(id: string, ms: number): Promise<boolean> {
    const machine = this.machine(id)
    if (!machine) return false
    if (machine.current()) return true
    const timer = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms).unref?.())
    return Promise.race([
      machine.connect({ interactive: false }).then(
        () => true,
        () => false,
      ),
      timer,
    ])
  }

  async forget(
    id: string,
    options: { stopServer?: boolean; clearBrowsingData?: boolean } = {},
  ): Promise<SshEnvironmentResult> {
    const machine = this.machines.get(id)
    const saved = this.get(id)
    if (options.stopServer) {
      const stopped = await this.stopServer(id)
      if (!stopped.ok) return stopped
    }
    machine?.disconnect()
    this.machines.delete(id)
    this.saved = this.saved.filter((entry) => entry.id !== id)
    this.persist()
    if (saved) await this.deps.onForget?.(saved, { clearBrowsingData: options.clearBrowsingData === true })
    return { ok: true }
  }

  diagnostics(id: string): { ok: true; text: string } | { ok: false; message: string } {
    const saved = this.get(id)
    if (!saved) return { ok: false, message: 'That SSH machine is no longer saved.' }
    const view = this.machines.get(id)?.summary()
    const probe = view?.diagnostics.probe ?? null
    const lines = [
      `Machine: ${saved.label} (${saved.destination})`,
      `ssh: ${this.ssh()}`,
      saved.resolved
        ? `Resolved: ${saved.resolved.user}@${saved.resolved.hostname}:${saved.resolved.port}${saved.resolved.proxyJump ? ` via ${saved.resolved.proxyJump}` : ''}`
        : 'Resolved: not yet',
      `State: ${view?.stateText ?? 'Not connected'}`,
      view?.server ? `Server: ${view.server.version} (${view.server.origin})` : 'Server: none reached',
      probe
        ? `Machine: ${probe.os} ${probe.machine}, ${probe.libc}; install directory ${probe.base} (${probe.exec ? 'can run programs' : 'noexec'}, ${probe.freeKb ?? '?'} KB free${probe.fstype ? `, ${probe.fstype}` : ''})`
        : 'Machine: not probed yet',
      ...(view?.notes ?? []),
      ...(view?.diagnostics.steps.length
        ? [`Last bootstrap: ${view.diagnostics.steps.map((step) => `${step.step} ${step.ms} ms`).join(', ')}`]
        : []),
      ...(view?.diagnostics.noise.trim() ? ['Printed before Studio’s first line:', view.diagnostics.noise.trim()] : []),
      ...(view?.diagnostics.stderr.trim() ? ['ssh said:', view.diagnostics.stderr.trim()] : []),
    ]
    return { ok: true, text: redactDiagnostics(lines.join('\n'), probe?.user || null) }
  }

  /** The computer woke or its network changed: every live session is checked, every reconnecting one tries now. */
  wake(): void {
    for (const machine of this.machines.values()) machine.wake()
  }

  /** At quit: let every session go. The managed servers keep running (decision R32). */
  shutdown(): void {
    for (const machine of this.machines.values()) machine.disconnect()
    for (const prompt of this.prompts.values()) prompt.resolve(null)
    void this.broker?.then(
      (broker) => broker.close(),
      () => undefined,
    )
  }
}
