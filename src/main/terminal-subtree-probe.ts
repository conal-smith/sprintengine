// Safety detector for the idle reaper: before suspending/disposing an idle
// agent terminal, confirm there is nothing live running under its pty. Killing
// the terminal kills the CLI process, and the CLI's shutdown kills every
// background task it is tracking — so reaping a session with live background
// work aborts that work mid-flight (the resumed session then reports "No
// completion record was found for this background shell command").
//
// Three signals mark a subtree as holding live work:
//   1. A LISTENING TCP socket held by any subtree process — dev servers
//      (vite/webpack/next/…) hold a port, while stdio MCP servers do NOT, so
//      this doesn't false-positive on the MCP helpers every agent spawns.
//   2. A subtree process burning CPU — catches a busy non-server command (a
//      build/test) that holds no port.
//   3. A Claude Code tool shell (`~/.claude/shell-snapshots/…` wrapper) — the
//      signature of every shell the agent's Bash tool runs, foreground or
//      `run_in_background`. This is what protects the quiet waiters signals 1
//      and 2 cannot see: a backgrounded `sleep`/poll/blocked-on-IO shell burns
//      ~0% CPU and holds no port, but killing the CLI still kills it. MCP
//      helpers never match it, so idle sessions stay reapable.
//
// Pure core (testable without spawning); the OS reads (`ps`, `lsof`, and on
// Windows one PowerShell) are injected. A WSL session is read by its
// distribution's helper from /proc instead (`resources/wsl-helper/lib/proc.mjs`
// applies the same rule), reached through `WslHost.probeSubtrees`. Runs
// once per sweep over the small set of reap candidates, not per process, so
// the cost is a fixed handful of subprocesses regardless of candidate count.
// Any failure resolves to "live" (keep the terminal alive) — never the reverse.

import { execFile } from 'node:child_process'

import { runSpawnDescriptor, type RunOutcome } from './process-run'
import { killProcessTree } from './process-tree-kill'
import { windowsPowerShellPath } from './command-on-path'

// A subtree process above this CPU share counts as "doing work" → keep alive.
// High enough to ignore idle MCP/helper jitter, low enough to catch a build.
const SUBTREE_BUSY_CPU_PERCENT = 15

// Every shell the Claude Code Bash tool runs — foreground or backgrounded —
// sources its snapshot from this directory, making it a precise marker for
// "the agent has a shell command in flight" that idle MCP servers never match.
export const CLAUDE_TOOL_SHELL_SIGNATURE = '.claude/shell-snapshots/'

export type ProcRow = { pid: number; ppid: number; cpuPercent: number; command: string }

// Why a subtree counts as live. Carried into the reap skip audit so a held
// session names the evidence ("tool_shell" vs "listening_port" vs "busy_cpu").
export type SubtreeLiveReason = 'listening_port' | 'busy_cpu' | 'tool_shell'

export function parsePsTree(stdout: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const match = line.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuPercent: Number(match[3]),
      command: match[4],
    })
  }
  return rows
}

// `lsof -t` prints one pid per line. A pid may repeat (multiple sockets); a Set
// dedups.
export function parseListeningPids(stdout: string): Set<number> {
  const pids = new Set<number>()
  for (const raw of stdout.split('\n')) {
    const value = Number(raw.trim())
    if (Number.isInteger(value) && value > 0) pids.add(value)
  }
  return pids
}

// The first live-work reason found in `rootPid`'s descendant tree, or null when
// the subtree holds nothing live. The root itself (the pty shell) is not
// counted — we are asking whether something the shell launched is still live.
export function subtreeLiveReason(
  rootPid: number,
  procs: readonly ProcRow[],
  listeningPids: ReadonlySet<number>,
  options: { busyCpuPercent?: number } = {},
): SubtreeLiveReason | null {
  const busyCpuPercent = options.busyCpuPercent ?? SUBTREE_BUSY_CPU_PERCENT
  const childrenByParent = new Map<number, ProcRow[]>()
  for (const proc of procs) {
    const list = childrenByParent.get(proc.ppid)
    if (list) list.push(proc)
    else childrenByParent.set(proc.ppid, [proc])
  }

  const seen = new Set<number>([rootPid])
  const stack = [...(childrenByParent.get(rootPid) ?? [])]
  while (stack.length > 0) {
    const proc = stack.pop()!
    if (seen.has(proc.pid)) continue
    seen.add(proc.pid)
    if (listeningPids.has(proc.pid)) return 'listening_port'
    if (proc.cpuPercent > busyCpuPercent) return 'busy_cpu'
    if (proc.command.includes(CLAUDE_TOOL_SHELL_SIGNATURE)) return 'tool_shell'
    const children = childrenByParent.get(proc.pid)
    if (children) stack.push(...children)
  }
  return null
}

export function subtreeHasLiveProcess(
  rootPid: number,
  procs: readonly ProcRow[],
  listeningPids: ReadonlySet<number>,
  options: { busyCpuPercent?: number } = {},
): boolean {
  return subtreeLiveReason(rootPid, procs, listeningPids, options) !== null
}

// Resolves to null on any error so the caller can tell "command failed" apart
// from "command ran and returned nothing" — critical because an empty `lsof`
// result must NOT be read as "no servers" when lsof simply failed/was missing.
function execFileTextOrNull(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 3_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : stdout),
    )
  })
}

export type SubtreeProbeDeps = HostProbeDeps & {
  platform?: NodeJS.Platform
  runPs?: () => Promise<string | null>
  runLsofListening?: () => Promise<string | null>
}

// Resolves each root pid to the live-work reason found in its subtree (null =
// probed clean, safe to reap). A root absent from the returned map (or any
// failure) means "undetermined" — callers MUST treat that as live/keep-alive.
export async function probeSubtreesForLiveWork(
  rootPids: readonly number[],
  deps: SubtreeProbeDeps = {},
): Promise<Map<number, SubtreeLiveReason | null>> {
  const platform = deps.platform ?? process.platform
  const result = new Map<number, SubtreeLiveReason | null>()
  if (rootPids.length === 0) return result
  if (platform !== 'darwin' && platform !== 'linux') return result // undetermined → keep-alive

  const runPs = deps.runPs ?? (() => execFileTextOrNull('ps', ['-axo', 'pid=,ppid=,pcpu=,args=']))
  const runLsofListening =
    deps.runLsofListening ?? (() => execFileTextOrNull('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-t']))

  try {
    const [psOut, lsofOut] = await Promise.all([runPs(), runLsofListening()])
    // If EITHER read failed, we can't trust the result — an empty lsof would be
    // misread as "no servers". Leave every root undetermined → keep-alive.
    if (psOut === null || lsofOut === null) return result
    const procs = parsePsTree(psOut)
    if (procs.length === 0) return result // ps yielded nothing usable → undetermined
    const listening = parseListeningPids(lsofOut)
    for (const rootPid of rootPids) {
      result.set(rootPid, subtreeLiveReason(rootPid, procs, listening))
    }
  } catch {
    return new Map() // undetermined → keep-alive
  }
  return result
}

// Boolean projection kept for callers that only need live/not-live.
export async function probeSubtreesForLiveProcesses(
  rootPids: readonly number[],
  deps: SubtreeProbeDeps = {},
): Promise<Map<number, boolean>> {
  const reasons = await probeSubtreesForLiveWork(rootPids, deps)
  const result = new Map<number, boolean>()
  for (const [pid, reason] of reasons) result.set(pid, reason !== null)
  return result
}

// A CLI process that outlives its terminal teardown. The pty kill reaches the
// shell, but a CLI child that survives the resulting SIGHUP reparents to
// launchd and nothing tracks it afterwards — the 2026-07-26 incident leaked 15
// idle Opus agents this way. The one durable handle on such a process is its
// own argv: agent CLIs are launched with an explicit `--session-id <uuid>`,
// which survives reparenting and cannot collide.
export function matchCliSessionPids(psOutput: string, cliSessionId: string): number[] {
  if (!cliSessionId) return []
  const needle = `--session-id ${cliSessionId}`
  const pids: number[] = []
  for (const line of psOutput.split('\n')) {
    if (!line.includes(needle)) continue
    const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0] ?? '', 10)
    if (Number.isFinite(pid) && pid > 0) pids.push(pid)
  }
  return pids
}

/**
 * Post-teardown escalation: after the pty kill has had `delayMs` to propagate,
 * SIGKILL any process still carrying this terminal's `--session-id`. Callers
 * fire-and-forget it right after the kill; a clean exit means the ps sweep
 * finds nothing and this is a no-op. Returns the pids it killed (for tests
 * and audit).
 *
 * `host` says where the session ran. On Windows a native session's survivors
 * are found by command line through CIM and ended with their trees. A WSL
 * session's are killed inside its distribution by its helper
 * (`WslHost.killSessionSurvivors`), never here.
 */
export async function killCliSessionSurvivors(
  cliSessionId: string,
  deps: SubtreeProbeDeps & {
    delayMs?: number
    kill?: (pid: number, signal: NodeJS.Signals) => void
    killTree?: (pid: number) => void
    host?: HostSurvivorTarget
  } = {},
): Promise<number[]> {
  if (!cliSessionId) return []
  const platform = deps.platform ?? process.platform
  const style = deps.host?.pathStyle ?? (platform === 'win32' ? 'windows' : 'posix')
  if (style === 'wsl') return []
  const onWindows = style === 'windows'
  if (onWindows ? platform !== 'win32' : platform !== 'darwin' && platform !== 'linux') return []
  const delayMs = deps.delayMs ?? 2_000
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
  if (onWindows) {
    try {
      return await killWindowsSurvivors(cliSessionId, deps)
    } catch {
      return []
    }
  }
  const runPs = deps.runPs ?? (() => execFileTextOrNull('ps', ['-axo', 'pid=,ppid=,pcpu=,args=']))
  const psOut = await runPs()
  if (psOut === null) return [] // undetermined — never kill on a failed read
  const killImpl = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal))
  const killed: number[] = []
  for (const pid of matchCliSessionPids(psOut, cliSessionId)) {
    try {
      killImpl(pid, 'SIGKILL')
      killed.push(pid)
    } catch {
      // Already gone between the ps read and the kill — the goal state.
    }
  }
  return killed
}

// =============================================================================
// Native Windows sessions
//
// A native Windows pty runs PowerShell, and Windows has no `ps` or `lsof`, so
// a sweep reads it with one PowerShell that lists every process with its
// parent and command line (CIM `Win32_Process`), the pids holding a listening
// TCP socket (`Get-NetTCPConnection`), and CPU from two samples of each
// process's processor time half a second apart. That feeds the same
// `subtreeLiveReason`. As everywhere in this file, a read
// that failed, or a session whose root cannot be found, is undetermined —
// held, never reaped.
// =============================================================================

// How long a sweep waits on a Windows-side read. The sweep runs every three
// minutes and a held session is simply asked again next time.
const HOST_PROBE_TIMEOUT_MS = 15_000

export type HostRunner = (script: string, options: { timeoutMs: number }) => Promise<RunOutcome>

export type HostProbeDeps = {
  // Runs a PowerShell script (native Windows reads).
  runPowerShell?: HostRunner
}

function defaultRunPowerShell(script: string, options: { timeoutMs: number }): Promise<RunOutcome> {
  return runSpawnDescriptor(
    {
      file: windowsPowerShellPath(),
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
    },
    { timeoutMs: options.timeoutMs },
  )
}

function outcomeText(outcome: RunOutcome): string | null {
  return outcome.timedOut || outcome.code !== 0 ? null : outcome.stdout
}

// ── Native Windows ───────────────────────────────────────────────────────────

/**
 * One PowerShell read of every process (pid, parent, command line, CPU) and
 * every pid holding a listening TCP socket, as JSON.
 *
 * CPU is the processor time each process used between two samples at least
 * half a second apart, as a percentage of one core — the same scale `ps`
 * reports. The performance-counter classes would give it directly but can take
 * seconds to answer; two reads of `TotalProcessorTime` do not.
 */
export const WINDOWS_SUBTREE_PROBE_SCRIPT = [
  `$ErrorActionPreference = 'Stop'`,
  `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
  `$clock = [System.Diagnostics.Stopwatch]::StartNew()`,
  `$before = @{}`,
  `foreach ($p in [System.Diagnostics.Process]::GetProcesses()) { try { $before[[int]$p.Id] = $p.TotalProcessorTime.Ticks } catch {} }`,
  `$rows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CommandLine)`,
  `$listeningOk = $true`,
  `try { $listening = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique) }`,
  `catch { $listening = @(); $listeningOk = $false }`,
  `$wait = 5000000 - $clock.Elapsed.Ticks`,
  `if ($wait -gt 0) { Start-Sleep -Milliseconds ([int]($wait / 10000)) }`,
  `$elapsed = [double]$clock.Elapsed.Ticks`,
  `$cpu = @{}`,
  `foreach ($p in [System.Diagnostics.Process]::GetProcesses()) { try { $id = [int]$p.Id; if ($before.ContainsKey($id)) { $cpu[$id] = [Math]::Round(100.0 * ($p.TotalProcessorTime.Ticks - $before[$id]) / $elapsed, 1) } } catch {} }`,
  `$processes = @($rows | ForEach-Object { $id = [int]$_.ProcessId; [pscustomobject]@{ pid = $id; ppid = [int]$_.ParentProcessId; cpu = $(if ($cpu.ContainsKey($id)) { $cpu[$id] } else { 0 }); cmd = [string]$_.CommandLine } })`,
  `ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ listeningOk = $listeningOk; listening = $listening; processes = $processes })`,
].join('\n')

export type WindowsSubtreeSnapshot = { procs: ProcRow[]; listening: Set<number> }

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return value === undefined || value === null ? [] : [value]
}

/**
 * The PowerShell read as process rows, or null when it failed or its listening
 * read did. Command lines get forward slashes, so a Claude tool shell's
 * snapshot path (`.claude\shell-snapshots\…`) matches the same signature as
 * on macOS and Linux.
 */
export function parseCimProcessJson(stdout: string): WindowsSubtreeSnapshot | null {
  let data: unknown
  try {
    data = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const record = data as { listeningOk?: unknown; listening?: unknown; processes?: unknown }
  if (record.listeningOk !== true) return null
  const procs: ProcRow[] = []
  for (const raw of asArray(record.processes)) {
    const row = raw as { pid?: unknown; ppid?: unknown; cpu?: unknown; cmd?: unknown } | null
    if (!row || typeof row.pid !== 'number' || typeof row.ppid !== 'number') continue
    procs.push({
      pid: row.pid,
      ppid: row.ppid,
      cpuPercent: typeof row.cpu === 'number' && Number.isFinite(row.cpu) ? row.cpu : 0,
      command: typeof row.cmd === 'string' ? row.cmd.replace(/\\/g, '/') : '',
    })
  }
  if (procs.length === 0) return null
  const listening = new Set<number>()
  for (const pid of asArray(record.listening)) if (typeof pid === 'number' && pid > 0) listening.add(pid)
  return { procs, listening }
}

/** Live-work verdicts for native Windows sessions, by pty root pid. */
export async function probeWindowsSubtrees(
  rootPids: readonly number[],
  deps: HostProbeDeps = {},
): Promise<Map<number, SubtreeLiveReason | null>> {
  const result = new Map<number, SubtreeLiveReason | null>()
  if (rootPids.length === 0) return result
  const run = deps.runPowerShell ?? defaultRunPowerShell
  try {
    const text = outcomeText(await run(WINDOWS_SUBTREE_PROBE_SCRIPT, { timeoutMs: HOST_PROBE_TIMEOUT_MS }))
    const snapshot = text === null ? null : parseCimProcessJson(text)
    if (!snapshot) return result
    const alive = new Set(snapshot.procs.map((proc) => proc.pid))
    for (const rootPid of rootPids) {
      if (!alive.has(rootPid)) continue
      result.set(rootPid, subtreeLiveReason(rootPid, snapshot.procs, snapshot.listening))
    }
  } catch {
    return new Map()
  }
  return result
}

// ── Survivors on native Windows ──────────────────────────────────────────────

/**
 * The PowerShell that lists every process whose command line carries
 * `--session-id <id>`, one pid per line. CIM is the one place Windows keeps
 * another process's command line.
 */
export function buildWindowsSurvivorQueryScript(cliSessionId: string): string {
  const needle = `--session-id ${cliSessionId}`.replace(/'/g, "''")
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$needle = '${needle}'`,
    `Get-CimInstance -ClassName Win32_Process -Property ProcessId, CommandLine | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) -and $_.ProcessId -ne $PID } | ForEach-Object { [string]$_.ProcessId }`,
  ].join('\n')
}

export type HostSurvivorTarget = {
  pathStyle?: 'posix' | 'windows' | 'wsl'
}

async function killWindowsSurvivors(
  cliSessionId: string,
  deps: HostProbeDeps & { killTree?: (pid: number) => void },
): Promise<number[]> {
  const run = deps.runPowerShell ?? defaultRunPowerShell
  const text = outcomeText(
    await run(buildWindowsSurvivorQueryScript(cliSessionId), { timeoutMs: HOST_PROBE_TIMEOUT_MS }),
  )
  if (text === null) return [] // never kill on a failed read
  const killTree = deps.killTree ?? ((pid: number) => killProcessTree({ pid, kill: () => true }, { platform: 'win32' }))
  const killed: number[] = []
  for (const line of text.split(/\r?\n/u)) {
    const pid = Number(line.trim())
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
    try {
      killTree(pid)
      killed.push(pid)
    } catch {
      // Already gone.
    }
  }
  return killed
}
