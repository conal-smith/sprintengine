import type {
  AgentCli,
  CliDetectResult,
  CliInstallInput,
  CliInstallMethodInfo,
  CliInstallResult,
  CliRuntimeSettings,
} from '../shared/electron-api'
import type { PluginInstallMethod, PluginInstallPlatform, PluginManifest } from '../shared/plugin-manifest'
import { getPluginManifest } from './plugin-registry-instance'
import { chooseCliUpdateCommand, foreignPackageManager, localCliInstallFs } from './cli-version-advisory'
import { currentRuntimeEnv, ensureManagedRuntimeShims, withManagedRuntimePath } from './managed-runtime'
import { runSpawnDescriptor, type RunOutcome, type SpawnDescriptor } from './process-run'
import { knownDefaultWslDistro, resolveDefaultWslDistro, wslLoginScript, wslScriptDescriptor } from './hosts/wsl-distro'
import { hostRegistry } from './hosts/host-registry'
import { LOCAL_HOST_ID, distroOfHostId, isWslHostId, type ExecutionHostId } from '../shared/execution-host'
import { ansiPlainText } from '../shared/conversation/ansi'
import { findExecutable, searchDirectories, sharedLoginShellPath } from './login-shell-path'
import { forgetSharedGhLocation } from './github/gh'
import { access, constants as fsConstants } from 'node:fs/promises'
import { cliProbeEnv } from './cli-probe-env'

// Exit code our probe scripts use to signal "binary not found on PATH" so we
// can distinguish a missing CLI from a CLI that exists but whose --version
// failed for some other reason.
const NOT_FOUND_EXIT = 3
const PATH_SENTINEL = 'SPRINTENGINE_PATH:'

export type { SpawnDescriptor }

// Maps the OS platform + the machine a CLI runs on onto the manifest install
// bucket. A WSL distribution is a logical target (Windows host, POSIX guest)
// distinct from win32.
export function resolveInstallPlatform(
  platform: NodeJS.Platform,
  hostId: string | null | undefined,
): PluginInstallPlatform {
  if (platform === 'win32') return isWslHostId(hostId) ? 'wsl' : 'win32'
  if (platform === 'darwin') return 'darwin'
  // Treat any other POSIX-like platform (linux, and uncommon ones) as linux.
  return 'linux'
}

// The distribution a WSL descriptor passes to `-d`: the one the host names,
// else the default, read once and cached. A failed read leaves the descriptor
// without `-d`, which is the default distribution anyway.
async function wslDistroFor(target: PluginInstallPlatform, hostId: string | null | undefined): Promise<string | null> {
  if (target !== 'wsl') return null
  return distroOfHostId(hostId) ?? (await resolveDefaultWslDistro().catch(() => null))
}

/** The host a runtime override names, as a host id; absent is this machine. */
function runtimeHostId(runtime: Partial<CliRuntimeSettings> | undefined): ExecutionHostId {
  const hostId = runtime?.hostId
  return isWslHostId(hostId) ? hostId : LOCAL_HOST_ID
}

function isPosixTarget(target: PluginInstallPlatform): boolean {
  return target === 'darwin' || target === 'linux' || target === 'wsl'
}

function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function powerShellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// Wraps a shell snippet in the right host shell for the target. POSIX targets
// run through a login shell so user-local install dirs (~/.local/bin, npm
// global prefix) are on PATH. WSL routes through wsl.exe into the named
// distribution (else the default), with the script on stdin (see
// hosts/wsl-distro.ts for why never on the command line); its stdin is closed
// for everything the script runs, so a command that reads input cannot
// swallow the rest of the script.
function shellDescriptorForScript(
  target: PluginInstallPlatform,
  script: string,
  distro?: string | null,
): SpawnDescriptor {
  if (target === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    }
  }
  if (target === 'wsl') {
    return wslScriptDescriptor(distro ?? knownDefaultWslDistro(), wslLoginScript(`{\n${script}\n} </dev/null`))
  }
  return { file: 'bash', args: ['-lc', script] }
}

// Builds a script that prints the resolved path and version, or exits
// NOT_FOUND_EXIT when the binary is not on PATH.
export function buildProbeDescriptor(input: {
  binary: string
  versionArgs: string[]
  target: PluginInstallPlatform
  distro?: string | null
}): SpawnDescriptor {
  const { binary, versionArgs, target, distro } = input
  if (isPosixTarget(target)) {
    const bin = posixSingleQuote(binary)
    const versionPart = versionArgs.map(posixSingleQuote).join(' ')
    const script = [
      `command -v ${bin} >/dev/null 2>&1 || exit ${NOT_FOUND_EXIT}`,
      `printf '${PATH_SENTINEL}%s\\n' "$(command -v ${bin})"`,
      `${bin} ${versionPart} 2>&1 || true`,
    ].join('\n')
    return shellDescriptorForScript(target, script, distro)
  }
  const bin = powerShellSingleQuote(binary)
  const versionPart = versionArgs.map(powerShellSingleQuote).join(' ')
  const script = [
    `$ErrorActionPreference='SilentlyContinue'`,
    `$c = Get-Command ${bin}`,
    `if (-not $c) { exit ${NOT_FOUND_EXIT} }`,
    `'${PATH_SENTINEL}' + $c.Source`,
    `& ${bin} ${versionPart} 2>&1`,
  ].join('\n')
  return shellDescriptorForScript(target, script)
}

// Builds a script that exits NOT_FOUND_EXIT when a prerequisite binary (npm,
// brew, curl, …) is absent, without invoking it.
export function buildExistsDescriptor(input: {
  binary: string
  target: PluginInstallPlatform
  distro?: string | null
}): SpawnDescriptor {
  const { binary, target, distro } = input
  if (isPosixTarget(target)) {
    const bin = posixSingleQuote(binary)
    return shellDescriptorForScript(target, `command -v ${bin} >/dev/null 2>&1 || exit ${NOT_FOUND_EXIT}`, distro)
  }
  const bin = powerShellSingleQuote(binary)
  return shellDescriptorForScript(
    target,
    `if (-not (Get-Command ${bin} -ErrorAction SilentlyContinue)) { exit ${NOT_FOUND_EXIT} }`,
  )
}

// Builds the descriptor that runs an install method's command verbatim in the
// target shell.
export function buildInstallDescriptor(input: {
  shell: string
  target: PluginInstallPlatform
  distro?: string | null
}): SpawnDescriptor {
  return shellDescriptorForScript(input.target, input.shell, input.distro)
}

export function parseProbeOutput(
  code: number,
  stdout: string,
): { installed: boolean; version: string | null; resolvedPath: string | null } {
  if (code === NOT_FOUND_EXIT) {
    return { installed: false, version: null, resolvedPath: null }
  }
  let resolvedPath: string | null = null
  const versionLines: string[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith(PATH_SENTINEL)) {
      resolvedPath = line.slice(PATH_SENTINEL.length).trim() || null
      continue
    }
    versionLines.push(line)
  }
  // First non-path line that carries a version-looking token, else the first
  // line, else null.
  const version = versionLines.find((line) => /\d+\.\d+/.test(line)) ?? versionLines[0] ?? null
  return { installed: true, version, resolvedPath }
}

function runDescriptor(
  desc: SpawnDescriptor,
  onData?: (chunk: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  // When set, the child is killed at the deadline and the outcome reads as
  // not-found — a probe that hangs (e.g. a slow interactive shell profile)
  // must never wedge the caller. Callers that must tell "no such binary" from
  // "the probe never answered" read the outcome's `timedOut` instead.
  timeoutMs?: number,
): Promise<RunOutcome> {
  return runSpawnDescriptor(desc, {
    ...(onData ? { onData } : {}),
    env,
    ...(timeoutMs ? { timeoutMs } : {}),
    timedOutCode: NOT_FOUND_EXIT,
  })
}

function resolveBinary(manifest: PluginManifest, runtime?: Partial<CliRuntimeSettings>): string {
  const override = typeof runtime?.command === 'string' ? runtime.command.trim() : ''
  return override || manifest.binary
}

// Builds the environment used to run install commands (and the post-install
// re-detect): the managed `node`/`npm` shims and the writable npm prefix bin
// are prepended to PATH so npm-based installs (e.g. Codex) work with no user
// Node, and the freshly installed binary is discoverable on the next probe.
// Returns null when no managed runtime is vendored, so callers fall back to the
// user's own PATH unchanged.
function stringProcessEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

// Probes run shells whose profiles we do not control, and CLIs whose
// `--version` we do not control either; a hard deadline keeps a pathological
// config (a ~/.bash_profile that starts tmux, prompts, or waits on a network
// mount) or a hung binary from wedging provider listing or availability checks.
const PROBE_TIMEOUT_MS = 10_000

function managedInstallEnv(): Record<string, string> | null {
  const runtimeEnv = currentRuntimeEnv()
  const shims = ensureManagedRuntimeShims(runtimeEnv)
  if (!shims) return null
  const withShims = withManagedRuntimePath(stringProcessEnv(), shims.shimDir, runtimeEnv.platform)
  return withManagedRuntimePath(withShims, shims.prefixBinDir, runtimeEnv.platform)
}

export type ProbeVerdict = {
  parsed: ReturnType<typeof parseProbeOutput>
  // True when a probe was killed at its deadline, so an "absent" parse is a
  // non-answer rather than a verdict.
  inconclusive: boolean
}

// The login-shell PATH for the whole app session (see login-shell-path.ts): one
// shell answers it, every binary lookup after that is done in this process.
const loginShellPath = sharedLoginShellPath()

/**
 * Drop the session's login-shell PATH so the next probe asks a shell again.
 * Called on a forced availability refresh and before the re-detect that follows
 * an install or update: an installer is exactly what appends a directory to
 * `~/.zshrc`, and the verdict after it must see that directory.
 */
export function invalidateLoginShellPath(): void {
  loginShellPath.invalidate()
  cliExecutables.invalidate()
  // gh is looked up on the same PATH, and a forced re-check should see it too.
  forgetSharedGhLocation()
}

// Host macOS/Linux: resolve the binary against the session's login-shell PATH
// in this process, then run only the binary itself for its version. That is
// one process per INSTALLED CLI and none for an absent one, where this used to
// be a login shell per CLI and a second, interactive one for every CLI bash
// could not see.
async function runHostVersionProbe(input: {
  binary: string
  versionArgs: string[]
  env: NodeJS.ProcessEnv
}): Promise<ProbeVerdict> {
  const { binary, versionArgs, env } = input
  const loginPath = await loginShellPath.resolve(env)
  const directories = searchDirectories(loginPath, env.PATH)
  const resolvedPath = await findExecutable(binary, directories)
  if (!resolvedPath) {
    // Absent from the process PATH alone is not a verdict: that PATH is the one
    // a Dock launch gets, without anything the person's shell config adds.
    return { parsed: { installed: false, version: null, resolvedPath: null }, inconclusive: loginPath === null }
  }
  // The binary is run with the PATH it was found on, so a `#!/usr/bin/env node`
  // script finds the same `node` a terminal would give it.
  const outcome = await runDescriptor(
    { file: resolvedPath, args: versionArgs },
    undefined,
    { ...env, PATH: directories.join(':') },
    PROBE_TIMEOUT_MS,
  )
  // Found, whatever `--version` did: the shell probe ignored its exit code too
  // (`|| true`). A binary that would not start or answered nothing is installed
  // with no version, never "not installed".
  const printed = outcome.spawnFailed ? '' : `${outcome.stdout}\n${outcome.stderr}`
  const parsed = parseProbeOutput(0, `${PATH_SENTINEL}${resolvedPath}\n${printed}`)
  return { parsed, inconclusive: false }
}

// Windows and WSL: the shell probe, unchanged: `command -v` inside WSL's login
// bash, or `Get-Command` in PowerShell.
async function runShellVersionProbe(input: {
  binary: string
  versionArgs: string[]
  target: PluginInstallPlatform
  env: NodeJS.ProcessEnv
}): Promise<ProbeVerdict> {
  const { binary, versionArgs, target, env } = input
  const outcome = await runDescriptor(
    buildProbeDescriptor({ binary, versionArgs, target }),
    undefined,
    env,
    PROBE_TIMEOUT_MS,
  )
  return { parsed: parseProbeOutput(outcome.code, outcome.stdout), inconclusive: outcome.timedOut }
}

function isHostPosixTarget(target: PluginInstallPlatform): boolean {
  return target === 'darwin' || target === 'linux'
}

async function runVersionProbe(input: {
  binary: string
  versionArgs: string[]
  target: PluginInstallPlatform
  env: NodeJS.ProcessEnv
}): Promise<ProbeVerdict> {
  return isHostPosixTarget(input.target) ? runHostVersionProbe(input) : runShellVersionProbe(input)
}

// PATH augmentation matching what terminal launches get (the managed runtime
// shims), so a managed install is never invisible to a probe.
export function defaultProbeEnv(): NodeJS.ProcessEnv {
  return managedInstallEnv() ?? stringProcessEnv()
}

// Runs an installed CLI with fixed arguments through the same host shell the
// version probe uses (login bash on POSIX, PowerShell on Windows, wsl.exe for a
// WSL runtime), so a command that detection found is the command that runs.
// POSIX `exec`s the binary so the deadline's kill reaches the CLI itself rather
// than only the shell wrapped around it; PowerShell hands the CLI's own exit
// code back. Model discovery is the caller: `codex debug models` and siblings.
export function buildCommandDescriptor(input: {
  binary: string
  args: string[]
  target: PluginInstallPlatform
  distro?: string | null
}): SpawnDescriptor {
  const { binary, args, target, distro } = input
  if (isPosixTarget(target)) {
    return shellDescriptorForScript(target, `exec ${[binary, ...args].map(posixSingleQuote).join(' ')}`, distro)
  }
  const argv = [binary, ...args].map(powerShellSingleQuote).join(' ')
  return shellDescriptorForScript(target, `& ${argv}\nexit $LASTEXITCODE`)
}

export type CliCommandOutcome = RunOutcome

export async function runCliCommand(input: {
  binary: string
  args: string[]
  /** The machine to run on; absent is this one. */
  hostId?: string | null
  timeoutMs: number
  env?: NodeJS.ProcessEnv
  /** Variables set on top of that environment, on whichever machine runs the command. */
  setEnv?: Readonly<Record<string, string>>
}): Promise<CliCommandOutcome> {
  const target = resolveInstallPlatform(process.platform, input.hostId)
  const setEnv = Object.entries(input.setEnv ?? {})
  // A WSL machine runs it through its helper, with the person's login PATH;
  // `env` sets the variables there.
  if (target === 'wsl') {
    const argv = [input.binary, ...input.args]
    return hostRegistry()
      .get(input.hostId)
      .runCommand(setEnv.length > 0 ? ['env', ...setEnv.map(([key, value]) => `${key}=${value}`), ...argv] : argv, {
        timeoutMs: input.timeoutMs,
      })
  }
  return runDescriptor(
    buildCommandDescriptor({ binary: input.binary, args: input.args, target }),
    undefined,
    { ...(input.env ?? defaultProbeEnv()), ...input.setEnv },
    input.timeoutMs,
  )
}

// Outcome of probing a binary the app does not manage as an Agent CLI (`git`,
// `gh`). The three cases stay distinct: a probe that could not answer is never
// reported as a missing binary, and a resolved outcome always carries a real
// version line.
export type BinaryVersionProbe =
  | { outcome: 'resolved'; version: string; resolvedPath: string | null }
  | { outcome: 'not_installed' }
  | { outcome: 'probe_failed' }

// Exported so the branch that keeps a killed probe out of the not-installed
// bucket is directly asserted; probeBinaryVersion is the only caller.
export function binaryVersionProbeFrom({ parsed, inconclusive }: ProbeVerdict): BinaryVersionProbe {
  if (!parsed.installed) return inconclusive ? { outcome: 'probe_failed' } : { outcome: 'not_installed' }
  // Resolved without a version line means the probe ran but told us nothing
  // usable; reporting success with an empty version would put a placeholder on
  // screen.
  if (!parsed.version) return { outcome: 'probe_failed' }
  return { outcome: 'resolved', version: parsed.version, resolvedPath: parsed.resolvedPath }
}

// `options.userPathOnly` looks the binary up on the person's own PATH alone,
// without the app's managed node/npm shims in front of it: the question "can
// an agent's shell run `npm install` here" is about what that shell has, and
// the shims are only ever handed to the app's own installers.
export async function probeBinaryVersion(
  binary: string,
  options: { userPathOnly?: boolean } = {},
): Promise<BinaryVersionProbe> {
  try {
    return binaryVersionProbeFrom(
      await runVersionProbe({
        binary,
        versionArgs: ['--version'],
        target: resolveInstallPlatform(process.platform, LOCAL_HOST_ID),
        env: options.userPathOnly ? stringProcessEnv() : defaultProbeEnv(),
      }),
    )
  } catch {
    return { outcome: 'probe_failed' }
  }
}

// ── Batched detection (Windows and WSL) ─────────────────────────────────────
//
// On Windows every probe is a `powershell.exe`, a second or more to start, and
// the registry holds around ten CLIs. Probing them one process each cost ten
// such starts per refresh. A batch asks about every CLI in ONE PowerShell, the
// CLIs' `--version` calls side by side inside it, each with its own deadline,
// so one slow CLI costs its own answer and not everyone's.
//
// A WSL machine asks its helper instead (`WslHost.detectClis`), which walks the
// person's login PATH without a shell and runs `--version` only for a binary
// that changed since it last asked.

const BATCH_BLOCK_MARKER = '@@SPRINTENGINE_CLI '
const BATCH_NOT_FOUND = '@@SPRINTENGINE_NOT_FOUND'
const BATCH_TIMED_OUT = '@@SPRINTENGINE_TIMED_OUT'
// Each CLI's `--version` inside the batch.
export const BATCH_PER_CLI_TIMEOUT_MS = 8_000
// The whole batch: a login shell or PowerShell start, then the slowest CLI.
const BATCH_TIMEOUT_MS = 25_000

export type BatchProbeRequest = { binary: string; versionArgs: string[] }
export type BatchProbeAnswer = ReturnType<typeof parseProbeOutput> | { error: string }

function powerShellBatchProbeScript(requests: readonly BatchProbeRequest[], perCliTimeoutMs: number): string {
  const list = requests
    .map(
      (request) =>
        `@{ b = ${powerShellSingleQuote(request.binary)}; a = @(${request.versionArgs.map(powerShellSingleQuote).join(', ')}) }`,
    )
    .join(', ')
  return [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
    `$requests = @(${list})`,
    // Every found CLI's `--version` starts in its own runspace inside this one
    // process, so they run side by side and each can be abandoned alone.
    `$jobs = @()`,
    `foreach ($r in $requests) {`,
    `  $c = Get-Command $r.b | Select-Object -First 1`,
    `  if (-not $c) { $jobs += ,@{ found = $false }; continue }`,
    `  $ps = [PowerShell]::Create()`,
    `  [void]$ps.AddScript({ param($b, $a) & $b @a 2>&1 | Out-String -Width 4096 }).AddArgument($r.b).AddArgument($r.a)`,
    `  $jobs += ,@{ found = $true; source = $c.Source; ps = $ps; handle = $ps.BeginInvoke() }`,
    `}`,
    `$deadline = [DateTime]::UtcNow.AddMilliseconds(${perCliTimeoutMs})`,
    `for ($i = 0; $i -lt $jobs.Count; $i++) {`,
    `  '${BATCH_BLOCK_MARKER}' + $i`,
    `  $j = $jobs[$i]`,
    `  if (-not $j.found) { '${BATCH_NOT_FOUND}'; continue }`,
    `  '${PATH_SENTINEL}' + $j.source`,
    `  $left = [int][Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)`,
    `  if ($j.handle.AsyncWaitHandle.WaitOne($left)) { try { $j.ps.EndInvoke($j.handle) } catch {} }`,
    `  else { '${BATCH_TIMED_OUT}'; [void]$j.ps.BeginStop($null, $null) }`,
    `}`,
    `exit 0`,
  ].join('\n')
}

/** One PowerShell that probes every request; read by `parseBatchProbeOutput`. */
export function buildBatchProbeDescriptor(input: {
  requests: readonly BatchProbeRequest[]
  perCliTimeoutMs?: number
}): SpawnDescriptor {
  const script = powerShellBatchProbeScript(input.requests, input.perCliTimeoutMs ?? BATCH_PER_CLI_TIMEOUT_MS)
  return {
    file: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
  }
}

/**
 * A batch's output as one answer per request, in request order. Anything
 * before the first block (a login banner) is ignored. A request with no block
 * — the shell died part way, or printed something else — is an error, never
 * "not installed": only a probe that ran says a CLI is absent.
 */
export function parseBatchProbeOutput(stdout: string, count: number): BatchProbeAnswer[] {
  const blocks = new Map<number, string[]>()
  let current: string[] | null = null
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith(BATCH_BLOCK_MARKER)) {
      const index = Number(line.slice(BATCH_BLOCK_MARKER.length).trim())
      current = Number.isInteger(index) && index >= 0 && index < count ? [] : null
      if (current) blocks.set(index, current)
      continue
    }
    current?.push(line)
  }
  const answers: BatchProbeAnswer[] = []
  for (let index = 0; index < count; index += 1) {
    const lines = blocks.get(index)
    if (!lines) {
      answers.push({ error: 'The probe printed no answer for this CLI.' })
      continue
    }
    if (lines.includes(BATCH_NOT_FOUND)) {
      answers.push(parseProbeOutput(NOT_FOUND_EXIT, ''))
      continue
    }
    // A CLI whose `--version` hit its own deadline was still found: installed,
    // with whatever version it printed before, if any.
    answers.push(parseProbeOutput(0, lines.filter((line) => line !== BATCH_TIMED_OUT).join('\n')))
  }
  return answers
}

export type DetectCliBatchDeps = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  run?: (desc: SpawnDescriptor, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<RunOutcome>
  /** A WSL machine's own detection (its helper); absent is the host registry's. */
  detectOnHost?: (
    hostId: ExecutionHostId,
    requests: ReadonlyArray<{ cli: AgentCli; runtime?: Partial<CliRuntimeSettings> }>,
    options: { force: boolean },
  ) => Promise<CliDetectResult[]>
  /**
   * Look again rather than trust what the machine remembers: a WSL helper keeps
   * each binary's `--version` while its size and mtime stand still, and an npm
   * update can leave both of a launcher script unchanged. Re-check and the
   * detection after an install or update pass it.
   */
  force?: boolean
}

type BatchItem = { index: number; binary: string; versionArgs: string[] }

function detectResult(
  cli: AgentCli,
  binary: string,
  hostId: ExecutionHostId,
  answer: BatchProbeAnswer,
): CliDetectResult {
  if ('error' in answer) {
    return { cli, binary, installed: false, version: null, resolvedPath: null, hostId, error: answer.error }
  }
  return {
    cli,
    binary,
    installed: answer.installed,
    version: answer.version,
    resolvedPath: answer.resolvedPath,
    hostId,
    error: null,
  }
}

async function runBatchGroup(
  items: readonly BatchItem[],
  deps: DetectCliBatchDeps,
  env: NodeJS.ProcessEnv,
): Promise<BatchProbeAnswer[]> {
  const run =
    deps.run ??
    ((desc: SpawnDescriptor, runEnv: NodeJS.ProcessEnv, timeoutMs: number) =>
      runDescriptor(desc, undefined, runEnv, timeoutMs))
  try {
    const outcome = await run(buildBatchProbeDescriptor({ requests: items }), env, BATCH_TIMEOUT_MS)
    if (outcome.timedOut) {
      return items.map(() => ({ error: `The CLI check timed out after ${BATCH_TIMEOUT_MS / 1000} s.` }))
    }
    const answers = parseBatchProbeOutput(outcome.stdout, items.length)
    if (outcome.code !== 0 && answers.every((answer) => 'error' in answer)) {
      // PowerShell itself failed. Its reason is the first line it printed.
      const detail = outcome.stderr.trim().split(/\r?\n/)[0] ?? ''
      return items.map(() => ({ error: `The CLI check exited with code ${outcome.code}. ${detail}`.trim() }))
    }
    return answers
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return items.map(() => ({ error: message }))
  }
}

/**
 * `detectCli` for many CLIs at once. On Windows, this PC natively is one
 * PowerShell whatever the count, and each WSL machine is one request to its
 * helper; on macOS and Linux each CLI keeps its own probe, which has the
 * interactive-shell fallback a batch does not.
 */
export async function detectCliBatch(
  requests: ReadonlyArray<{ cli: AgentCli; runtime?: Partial<CliRuntimeSettings> }>,
  deps: DetectCliBatchDeps = {},
): Promise<CliDetectResult[]> {
  const platform = deps.platform ?? process.platform
  const results: CliDetectResult[] = []
  const windows: BatchItem[] = []
  const wsl = new Map<ExecutionHostId, number[]>()
  const posix: number[] = []
  requests.forEach(({ cli, runtime }, index) => {
    const manifest = getPluginManifest(cli)
    const hostId = runtimeHostId(runtime)
    if (!manifest) {
      results[index] = detectResult(cli, cli, hostId, { error: `No plugin manifest found for "${cli}".` })
      return
    }
    const target = resolveInstallPlatform(platform, hostId)
    if (target === 'wsl') {
      wsl.set(hostId, [...(wsl.get(hostId) ?? []), index])
      return
    }
    if (target !== 'win32') {
      posix.push(index)
      return
    }
    windows.push({
      index,
      binary: resolveBinary(manifest, runtime),
      versionArgs: manifest.detect?.versionArgs ?? ['--version'],
    })
  })

  const env = deps.env ?? defaultProbeEnv()
  // One PowerShell runs every native CLI's `--version`, so it carries what
  // each of them is checked with; each variable is read by its own CLI alone.
  const windowsEnv: NodeJS.ProcessEnv = {
    ...env,
    ...Object.fromEntries(windows.flatMap((item) => Object.entries(cliProbeEnv(requests[item.index].cli)))),
  }
  const force = deps.force === true
  const detectOnHost =
    deps.detectOnHost ??
    ((
      hostId: ExecutionHostId,
      group: ReadonlyArray<{ cli: AgentCli; runtime?: Partial<CliRuntimeSettings> }>,
      options: { force: boolean },
    ) => hostRegistry().get(hostId).detectClis(group, options))
  await Promise.all([
    ...posix.map(async (index) => {
      results[index] = await detectCli(requests[index].cli, requests[index].runtime, deps.env)
    }),
    ...(windows.length > 0
      ? [
          (async () => {
            const answers = await runBatchGroup(windows, deps, windowsEnv)
            windows.forEach((item, position) => {
              results[item.index] = detectResult(
                requests[item.index].cli,
                item.binary,
                LOCAL_HOST_ID,
                answers[position],
              )
            })
          })(),
        ]
      : []),
    ...[...wsl].map(async ([hostId, indexes]) => {
      let answers: CliDetectResult[]
      try {
        answers = await detectOnHost(
          hostId,
          indexes.map((index) => requests[index]),
          { force },
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        answers = indexes.map((index) =>
          detectResult(requests[index].cli, requests[index].cli, hostId, { error: message }),
        )
      }
      indexes.forEach((index, position) => {
        results[index] =
          answers[position] ?? detectResult(requests[index].cli, requests[index].cli, hostId, { error: 'No answer.' })
      })
    }),
  ])
  return results
}

// ── What a WSL machine's helper is asked, and what its answer means ─────────

export type CliProbeRequest =
  { cli: AgentCli; binary: string; versionArgs: string[] } | { cli: AgentCli; binary: string; error: string }

/** What the helper's `cli.detect` is asked about one CLI. */
export function cliProbeRequest(cli: AgentCli, runtime?: Partial<CliRuntimeSettings>): CliProbeRequest {
  const manifest = getPluginManifest(cli)
  if (!manifest) return { cli, binary: cli, error: `No plugin manifest found for "${cli}".` }
  return { cli, binary: resolveBinary(manifest, runtime), versionArgs: manifest.detect?.versionArgs ?? ['--version'] }
}

/** One answer from the helper's `cli.detect`. */
export type HelperProbeAnswer =
  { found: false } | { found: true; path: string; output: string; timedOut?: boolean } | { error: string }

/** A helper's answer as a detection result, read by the same parser as every other probe. */
export function detectResultFromHelper(
  probe: CliProbeRequest,
  answer: HelperProbeAnswer,
  hostId: ExecutionHostId,
): CliDetectResult {
  if ('error' in answer) return detectResult(probe.cli, probe.binary, hostId, { error: answer.error })
  if (!answer.found) return detectResult(probe.cli, probe.binary, hostId, parseProbeOutput(NOT_FOUND_EXIT, ''))
  // A CLI whose `--version` ran out of time was still found: installed, with
  // whatever it printed before.
  return detectResult(
    probe.cli,
    probe.binary,
    hostId,
    parseProbeOutput(0, `${PATH_SENTINEL}${answer.path}\n${answer.output}`),
  )
}

export async function detectCli(
  cli: AgentCli,
  runtime?: Partial<CliRuntimeSettings>,
  env?: NodeJS.ProcessEnv,
  options: { force?: boolean } = {},
): Promise<CliDetectResult> {
  const manifest = getPluginManifest(cli)
  const hostId = runtimeHostId(runtime)
  if (!manifest) {
    return {
      cli,
      binary: cli,
      installed: false,
      version: null,
      resolvedPath: null,
      hostId,
      error: `No plugin manifest found for "${cli}".`,
    }
  }
  const binary = resolveBinary(manifest, runtime)
  const target = resolveInstallPlatform(process.platform, hostId)
  // On Windows a single CLI goes through the batch too, so every probe there
  // is built, run and read one way.
  if (target === 'wsl' || target === 'win32') {
    const [result] = await detectCliBatch([{ cli, runtime }], {
      ...(env ? { env } : {}),
      ...(options.force ? { force: true } : {}),
    })
    return result
  }
  const versionArgs = manifest.detect?.versionArgs ?? ['--version']
  try {
    // An explicit caller env still wins over the default probe PATH.
    const { parsed, inconclusive } = await runVersionProbe({
      binary,
      versionArgs,
      target,
      env: { ...(env ?? defaultProbeEnv()), ...cliProbeEnv(cli) },
    })
    // On the host, a binary missing while no shell would say what PATH the
    // person has is a non-answer. Reported as an error, availability leaves it
    // out (the renderer keeps it visible as "unknown") and does not cache it,
    // rather than holding a false "not installed" for the length of the cache.
    if (inconclusive && !parsed.installed && isHostPosixTarget(target)) {
      return {
        cli,
        binary,
        installed: false,
        version: null,
        resolvedPath: null,
        hostId,
        error: 'No login shell answered with a PATH to look the binary up on.',
      }
    }
    return {
      cli,
      binary,
      installed: parsed.installed,
      version: parsed.version,
      resolvedPath: parsed.resolvedPath,
      hostId,
      error: null,
    }
  } catch (error) {
    return {
      cli,
      binary,
      installed: false,
      version: null,
      resolvedPath: null,
      hostId,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Where a CLI was found, or null with what the lookup said when it was not. */
export type CliExecutableLookup = { path: string | null; error: string | null }

export type CliExecutableResolver = {
  /** Where to start `cli` from; see CliExecutableLookup. */
  resolve(cli: AgentCli, runtime?: Partial<CliRuntimeSettings>): Promise<CliExecutableLookup>
  /** Forget resolved paths (every CLI's when none is named). */
  invalidate(cli?: AgentCli): void
}

/**
 * Where each CLI a chat starts lives, looked up once per CLI, machine and
 * command override rather than before every process start. A chat's child is
 * started on its first turn and again after every idle reap, suspend, preset
 * or mode change and command probe; a full detection there ran the CLI (or a
 * PowerShell probe) only to print a version nobody reads, which put a second
 * process on the critical path of every respawn. A remembered path that is no
 * longer an executable file is looked up again, and an install, an update or
 * a forced availability refresh forgets every path.
 */
export function createCliExecutableResolver(deps: {
  lookup(cli: AgentCli, runtime?: Partial<CliRuntimeSettings>): Promise<CliExecutableLookup>
  // Whether a remembered path is still there; null when this process cannot
  // tell (a path inside a WSL distribution), so the path is trusted.
  stillThere(path: string, runtime?: Partial<CliRuntimeSettings>): Promise<boolean | null>
}): CliExecutableResolver {
  const resolved = new Map<string, { cli: AgentCli; found: Promise<CliExecutableLookup> }>()
  const keyFor = (cli: AgentCli, runtime?: Partial<CliRuntimeSettings>) =>
    JSON.stringify([cli, runtimeHostId(runtime), typeof runtime?.command === 'string' ? runtime.command.trim() : ''])
  return {
    async resolve(cli, runtime) {
      const key = keyFor(cli, runtime)
      const known = resolved.get(key)
      if (known) {
        const found = await known.found.catch(() => null)
        if (found?.path && (await deps.stillThere(found.path, runtime).catch(() => false)) !== false) return found
        // Only the entry this call read is dropped: a newer lookup stays.
        if (resolved.get(key) === known) resolved.delete(key)
      }
      const entry = { cli, found: deps.lookup(cli, runtime) }
      resolved.set(key, entry)
      const found = await entry.found.catch((error: unknown) => {
        if (resolved.get(key) === entry) resolved.delete(key)
        throw error
      })
      // "Not found" is not remembered: the next start looks again, so a CLI
      // installed from a terminal is picked up without a refresh.
      if (!found.path && resolved.get(key) === entry) resolved.delete(key)
      return found
    },
    invalidate(cli) {
      if (!cli) resolved.clear()
      else for (const [key, entry] of resolved) if (entry.cli === cli) resolved.delete(key)
    },
  }
}

const cliExecutables = createCliExecutableResolver({
  async lookup(cli, runtime) {
    const manifest = getPluginManifest(cli)
    if (!manifest) return { path: null, error: `No plugin manifest found for "${cli}".` }
    const target = resolveInstallPlatform(process.platform, runtimeHostId(runtime))
    if (isHostPosixTarget(target)) {
      // The same lookup the version probe makes, without running the binary.
      const env = defaultProbeEnv()
      const loginPath = await loginShellPath.resolve(env)
      const path = await findExecutable(resolveBinary(manifest, runtime), searchDirectories(loginPath, env.PATH))
      return {
        path,
        error: path || loginPath !== null ? null : 'No login shell answered with a PATH to look the binary up on.',
      }
    }
    const detection = await detectCli(cli, runtime)
    return { path: detection.installed ? detection.resolvedPath : null, error: detection.error }
  },
  async stillThere(path, runtime) {
    if (resolveInstallPlatform(process.platform, runtimeHostId(runtime)) === 'wsl') return null
    return access(path, fsConstants.X_OK).then(
      () => true,
      () => false,
    )
  },
})

/** The path a chat's child for `cli` is started from; see createCliExecutableResolver. */
export function resolveCliExecutable(
  cli: AgentCli,
  runtime?: Partial<CliRuntimeSettings>,
): Promise<CliExecutableLookup> {
  return cliExecutables.resolve(cli, runtime)
}

/** Forget where `cli` (or every CLI) lives: its process could not be started from there. */
export function invalidateCliExecutable(cli?: AgentCli): void {
  cliExecutables.invalidate(cli)
}

async function prerequisiteAvailable(
  requires: string,
  target: PluginInstallPlatform,
  distro: string | null,
): Promise<boolean> {
  try {
    const outcome = await runDescriptor(buildExistsDescriptor({ binary: requires, target, distro }))
    return outcome.code !== NOT_FOUND_EXIT
  } catch {
    return false
  }
}

function selectInstallMethods(manifest: PluginManifest, target: PluginInstallPlatform): PluginInstallMethod[] {
  return manifest.install?.[target] ?? []
}

export async function cliInstallMethods(
  cli: AgentCli,
  runtime?: Partial<CliRuntimeSettings>,
): Promise<CliInstallMethodInfo[]> {
  const manifest = getPluginManifest(cli)
  if (!manifest) return []
  const target = resolveInstallPlatform(process.platform, runtime?.hostId)
  const distro = await wslDistroFor(target, runtime?.hostId)
  const methods = selectInstallMethods(manifest, target)
  const infos = await Promise.all(
    methods.map(async (method): Promise<CliInstallMethodInfo> => {
      const available = method.requires ? await prerequisiteAvailable(method.requires, target, distro) : true
      return {
        id: method.id,
        label: method.label,
        available,
        unavailableReason: available || !method.requires ? null : `Requires "${method.requires}" on PATH`,
        recommended: method.recommended ?? false,
        commandPreview: method.shell,
        platform: target,
      }
    }),
  )
  return infos
}

export async function installCli(
  input: CliInstallInput,
  runtime: Partial<CliRuntimeSettings> | undefined,
  onData?: (chunk: string) => void,
): Promise<CliInstallResult> {
  const manifest = getPluginManifest(input.cli)
  if (!manifest) {
    return {
      ok: false,
      cli: input.cli,
      installed: false,
      version: null,
      resolvedPath: null,
      log: '',
      error: `No plugin manifest found for "${input.cli}".`,
    }
  }
  const target = resolveInstallPlatform(process.platform, runtime?.hostId)
  const distro = await wslDistroFor(target, runtime?.hostId)
  const method = selectInstallMethods(manifest, target).find((entry) => entry.id === input.methodId)
  if (!method) {
    return {
      ok: false,
      cli: input.cli,
      installed: false,
      version: null,
      resolvedPath: null,
      log: '',
      error: `No install method "${input.methodId}" for ${input.cli} on ${target}.`,
    }
  }

  const banner = `$ ${method.shell}\n`
  onData?.(banner)
  let log = banner
  const capture = (chunk: string): void => {
    log += chunk
    onData?.(chunk)
  }

  // Run the install (and the re-detect below) with the managed node/npm on
  // PATH so npm-based installers work without a user Node and the resulting
  // binary is discoverable. Falls back to the user's PATH when no managed
  // runtime is vendored.
  const installEnv = managedInstallEnv() ?? undefined

  let runError: string | null = null
  try {
    const outcome = await runDescriptor(
      buildInstallDescriptor({ shell: method.shell, target, distro }),
      capture,
      installEnv,
    )
    if (outcome.code !== 0) {
      runError = `Install command exited with code ${outcome.code}.`
    }
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error)
  }

  // Re-detect regardless of exit code: some installers report a non-zero exit
  // while still placing the binary (e.g. PATH advisories). Against a freshly
  // asked login PATH, since an installer may have just added to it.
  invalidateLoginShellPath()
  const detected = await detectCli(input.cli, runtime, installEnv, { force: true })
  const ok = detected.installed && runError === null
  return {
    ok,
    cli: input.cli,
    installed: detected.installed,
    version: detected.version,
    resolvedPath: detected.resolvedPath,
    log,
    error: ok ? null : (runError ?? (detected.installed ? null : 'CLI not found on PATH after install.')),
  }
}

// Why an update failed, in the words of the command that failed. "Exited with
// code 1" alone names no cause, and the person reading it is in Settings, not
// in the terminal the command printed to: npm's EACCES, an updater refusing to
// touch a copy it did not install, a network error all used to read the same.
// The banner line (`$ …`) is what ran, not what it said, so it is left out.
export function updateFailure(code: number, log: string): string {
  // Without colour and cursor escapes or the OSC 8 hyperlinks some CLIs print,
  // and a progress bar as its last frame.
  const said = ansiPlainText(log)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('$ '))
    .slice(-3)
    .join(' ')
  return said ? `Update command exited with code ${code}: ${said}` : `Update command exited with code ${code}.`
}

// Builds the descriptor that runs the CLI's own updater: the resolved binary
// with the manifest `update.args`, in the target shell so PATH resolution
// matches detection and terminal launches.
export function buildUpdateDescriptor(input: {
  binary: string
  args: string[]
  target: PluginInstallPlatform
  distro?: string | null
}): SpawnDescriptor {
  const { binary, args, target, distro } = input
  if (isPosixTarget(target)) {
    return shellDescriptorForScript(target, [binary, ...args].map(posixSingleQuote).join(' '), distro)
  }
  return shellDescriptorForScript(target, `& ${[binary, ...args].map(powerShellSingleQuote).join(' ')}`)
}

// Run one update command and detect the CLI again once it has finished, so
// the result carries the version the update left on PATH.
async function runCliUpdate(
  cli: AgentCli,
  runtime: Partial<CliRuntimeSettings> | undefined,
  command: string,
  descriptor: SpawnDescriptor,
  onData?: (chunk: string) => void,
): Promise<CliInstallResult> {
  const banner = `$ ${command}\n`
  onData?.(banner)
  let log = banner
  const capture = (chunk: string): void => {
    log += chunk
    onData?.(chunk)
  }
  const updateEnv = managedInstallEnv() ?? undefined
  let runError: string | null = null
  try {
    const outcome = await runDescriptor(descriptor, capture, updateEnv)
    if (outcome.code !== 0) runError = updateFailure(outcome.code, log)
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error)
  }
  invalidateLoginShellPath()
  const detected = await detectCli(cli, runtime, updateEnv, { force: true })
  const ok = detected.installed && runError === null
  return {
    ok,
    cli,
    installed: detected.installed,
    version: detected.version,
    resolvedPath: detected.resolvedPath,
    log,
    error: ok ? null : (runError ?? (detected.installed ? null : 'CLI not found on PATH after update.')),
  }
}

// Update an installed CLI. No staleness detection: a CLI's "latest"
// belongs to the vendor's channel, so this is an action, not a state. Where
// the manifest declares an `update` spec the CLI's own updater runs; otherwise
// the manager that installed it updates it (chooseCliUpdateCommand), and when
// none can be named the install spec is re-run.
export async function updateCli(
  cli: AgentCli,
  runtime: Partial<CliRuntimeSettings> | undefined,
  onData?: (chunk: string) => void,
): Promise<CliInstallResult> {
  const manifest = getPluginManifest(cli)
  if (!manifest) {
    return {
      ok: false,
      cli,
      installed: false,
      version: null,
      resolvedPath: null,
      log: '',
      error: `No plugin manifest found for "${cli}".`,
    }
  }
  const target = resolveInstallPlatform(process.platform, runtime?.hostId)
  const distro = await wslDistroFor(target, runtime?.hostId)

  if (manifest.update?.args?.length) {
    const binary = resolveBinary(manifest, runtime)
    return runCliUpdate(
      cli,
      runtime,
      [binary, ...manifest.update.args].join(' '),
      buildUpdateDescriptor({ binary, args: manifest.update.args, target, distro }),
      onData,
    )
  }

  // No updater that is right for every install: update through whatever put
  // the binary where it is — brew under Homebrew, npm into the prefix npm
  // installed it under, the CLI's own updater for a vendor-script install.
  // Updating through anything else leaves the original copy ahead on PATH,
  // so the update would look like it did nothing. `brew install` on an
  // installed formula is a no-op, so brew upgrade is the only path that
  // actually moves a Homebrew-installed CLI forward. A WSL distribution's
  // files are not read from here (`fs: null`).
  const detectedBefore = await detectCli(cli, runtime)
  const fs = target === 'wsl' ? null : localCliInstallFs
  const chosen = chooseCliUpdateCommand({ manifest, resolvedPath: detectedBefore.resolvedPath, fs })
  if (chosen?.kind === 'cli-updater' && manifest.selfUpdate?.args?.length) {
    const binary = resolveBinary(manifest, runtime)
    return runCliUpdate(
      cli,
      runtime,
      [binary, ...manifest.selfUpdate.args].join(' '),
      buildUpdateDescriptor({ binary, args: manifest.selfUpdate.args, target, distro }),
      onData,
    )
  }
  if (chosen && (chosen.kind === 'brew' || chosen.kind === 'npm')) {
    return runCliUpdate(
      cli,
      runtime,
      chosen.command,
      buildInstallDescriptor({ shell: chosen.command, target, distro }),
      onData,
    )
  }
  // A package manager Studio does not drive put it there. Re-running an
  // install method would add a second copy beside it, so say whose it is.
  const resolvedBefore = detectedBefore.resolvedPath
  const manager = foreignPackageManager(resolvedBefore, resolvedBefore && fs ? fs.realPath(resolvedBefore) : null)
  if (detectedBefore.installed && manager) {
    return {
      ok: false,
      cli,
      installed: true,
      version: detectedBefore.version,
      resolvedPath: resolvedBefore,
      log: '',
      error: `${manifest.displayName} at ${resolvedBefore} was installed with ${manager}. Update it with ${manager}, the way it was installed.`,
    }
  }

  const methods = await cliInstallMethods(cli, runtime)
  const method =
    methods.find((entry) => entry.recommended && entry.available) ??
    methods.find((entry) => entry.available) ??
    methods[0]
  if (!method) {
    return {
      ok: false,
      cli,
      installed: false,
      version: null,
      resolvedPath: null,
      log: '',
      error: `No update path for ${cli} on ${target}: the manifest declares no update spec and no install methods.`,
    }
  }
  return installCli({ cli, methodId: method.id }, runtime, onData)
}
