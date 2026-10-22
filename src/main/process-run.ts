import { spawn } from 'node:child_process'

import { killProcessTree } from './process-tree-kill'

/**
 * A process to start: the executable, its argv, and optionally a script fed to
 * it on stdin.
 *
 * `stdin` exists for `wsl.exe`. It rebuilds the Linux command line from the
 * Windows one and does not keep quoting intact across that crossing, so a
 * script passed as `-e sh -c '<script>'` reaches the Linux shell mangled
 * whenever it holds quotes, `$` or backslashes. Piped to `sh -s`, the script
 * crosses as bytes and nothing re-parses it.
 */
export type SpawnDescriptor = { file: string; args: string[]; stdin?: string }

// `timedOut` is carried alongside the exit code because a killed process
// reports whatever code the caller maps a timeout to, while a caller that must
// distinguish "no answer" from "a real answer" reads this flag instead.
// `spawnFailed` is set when the process never started at all, so its "output"
// is the error message and must not be read as anything the process printed.
export type RunOutcome = { code: number; stdout: string; stderr: string; timedOut: boolean; spawnFailed?: boolean }

export type RunOptions = {
  onData?: (chunk: string) => void
  env?: NodeJS.ProcessEnv
  // When set, the process tree is killed at the deadline and the outcome
  // reports `timedOutCode` — a probe that hangs (a slow shell profile, a CLI
  // waiting on the network) must never wedge the caller.
  timeoutMs?: number
  timedOutCode?: number
  // Turns the collected stdout bytes into text. `wsl.exe` prints its own
  // messages as UTF-16LE, which the default UTF-8 decode turns into noise.
  decodeStdout?: (bytes: Buffer) => string
  // The same for stderr, where `wsl.exe` writes its errors ("no distribution
  // with the supplied name"). `onData` still sees each chunk as UTF-8.
  decodeStderr?: (bytes: Buffer) => string
  // Working directory for the started process. Left unset, the child inherits
  // this process's, which is fine for every Windows-side executable; a WSL
  // probe sets the Linux side's own with `--cd` instead.
  cwd?: string
  // POSIX only: start the process as the leader of a new session, away from
  // the terminal this app was launched from. An interactive shell (`-i`) that
  // finds a controlling terminal turns on job control and contends for it, so
  // with the app started from a terminal the shell is stopped, or takes the
  // foreground, and never answers. A timeout then ends the whole group, so what
  // the shell started does not outlive it. Never set on Windows, where
  // `detached` gives the process a console window of its own.
  detached?: boolean
}

// How long after the process exits its pipes may stay open before the outcome
// is settled without them. Normally `close` follows `exit` at once; it does not
// when something the process started (a CLI's `--version` launched through a
// `.cmd` shim, a daemon an installer leaves behind) inherited stdout and
// outlives it. Waiting on `close` alone could then never return.
const PIPE_DRAIN_GRACE_MS = 2_000

export function runSpawnDescriptor(desc: SpawnDescriptor, options: RunOptions = {}): Promise<RunOutcome> {
  const { onData, env = process.env, timeoutMs, timedOutCode = 1, decodeStdout, decodeStderr, cwd, detached } = options
  return new Promise((resolve) => {
    const child = spawn(desc.file, desc.args, {
      env,
      windowsHide: true,
      stdio: [desc.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
      ...(detached ? { detached: true } : {}),
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let timedOut = false
    let settled = false
    let drainTimer: ReturnType<typeof setTimeout> | null = null
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true
          // The whole tree: on Windows the wrapper is `powershell.exe` or
          // `wsl.exe`, and what hangs is what it launched. A detached process
          // leads its own group, and the group goes with it.
          killProcessTree(child, { processGroup: detached })
        }, timeoutMs)
      : null
    const stdoutText = (): string => {
      const bytes = Buffer.concat(stdoutChunks)
      return decodeStdout ? decodeStdout(bytes) : bytes.toString('utf8')
    }
    const stderrText = (): string => {
      const bytes = Buffer.concat(stderrChunks)
      return decodeStderr ? decodeStderr(bytes) : bytes.toString('utf8')
    }
    const settle = (outcome: RunOutcome) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (drainTimer) clearTimeout(drainTimer)
      resolve(outcome)
    }
    const settleTimedOut = () =>
      settle({
        code: timedOutCode,
        stdout: '',
        stderr: `${stderrText()}\nprocess timed out after ${timeoutMs}ms`,
        timedOut: true,
      })
    if (desc.stdin !== undefined && child.stdin) {
      // A shell that exits before reading all of its script closes the pipe;
      // that is its answer, not an error of ours.
      child.stdin.on('error', () => {})
      child.stdin.end(desc.stdin)
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
      onData?.(chunk.toString())
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
      onData?.(chunk.toString())
    })
    child.on('error', (error) => {
      settle({
        code: 1,
        stdout: stdoutText(),
        stderr: stderrText() + (error.message ?? String(error)),
        timedOut: false,
        spawnFailed: true,
      })
    })
    child.on('exit', (code) => {
      if (timedOut) {
        settleTimedOut()
        return
      }
      drainTimer = setTimeout(
        () => settle({ code: code ?? 1, stdout: stdoutText(), stderr: stderrText(), timedOut: false }),
        PIPE_DRAIN_GRACE_MS,
      )
    })
    child.on('close', (code) => {
      if (timedOut) {
        settleTimedOut()
        return
      }
      settle({ code: code ?? 1, stdout: stdoutText(), stderr: stderrText(), timedOut: false })
    })
  })
}
