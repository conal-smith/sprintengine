// One child process, prompt on stdin, collected to completion or killed at
// the deadline. Kept apart from the service so tests can substitute the run
// and the service's own logic (probe, temp files, parse, guardrail) runs for
// real against a fake CLI.

import { spawn } from 'node:child_process'

import { killProcessTree } from '../process-tree-kill'

export type CommandRunInput = {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  stdin: string
  timeoutMs: number
  /** Aborting it kills the process tree, as the deadline does: the person cancelled. */
  signal?: AbortSignal
  /** How much of each stream is kept, in characters. Defaults to MAX_OUTPUT_CHARS. */
  maxOutputChars?: number
}

/**
 * A title, a commit message or a pull request's text, with the CLI's own
 * envelope and event stream around it, is a few kilobytes and seldom more
 * than a megabyte. Past this, stdout is not an answer anyone is waiting for:
 * the CLI is stopped rather than held in memory without end. stderr is only
 * read for the reason a call failed, so it keeps its newest part instead.
 */
const MAX_OUTPUT_CHARS = 8 * 1024 * 1024

export type CommandRun = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Killed because `signal` aborted. */
  cancelled?: boolean
  /** Killed because stdout ran past `maxOutputChars`; what it printed up to then is kept. */
  overflowed?: boolean
  /** Set when the process never started (ENOENT, EACCES); `code` is then null. */
  spawnError: string | null
}

export type RunCommand = (input: CommandRunInput) => Promise<CommandRun>

export const runCommand: RunCommand = (input) =>
  new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let cancelled = false
    let overflowed = false
    let settled = false
    const cap = input.maxOutputChars ?? MAX_OUTPUT_CHARS
    const settle = (run: CommandRun): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', cancel)
      resolve({ ...run, ...(cancelled ? { cancelled: true } : {}), ...(overflowed ? { overflowed: true } : {}) })
    }
    const cancel = (): void => {
      if (cancelled || settled) return
      cancelled = true
      killProcessTree(child)
    }
    const child = spawn(input.file, input.args, {
      cwd: input.cwd,
      env: input.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, input.timeoutMs)
    // Decoded by the stream, which holds back a character's first bytes until
    // the rest arrive: a chunk decoded on its own splits one in two.
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (overflowed) return
      if (stdout.length + chunk.length > cap) {
        stdout += chunk.slice(0, cap - stdout.length)
        overflowed = true
        killProcessTree(child)
        return
      }
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > cap) stderr = stderr.slice(-cap)
    })
    child.on('error', (error) => {
      settle({ code: null, stdout, stderr, timedOut, spawnError: error.message || String(error) })
    })
    child.on('close', (code) => {
      settle({ code, stdout, stderr, timedOut, spawnError: null })
    })
    // A killed CLI is done even if a process it started still holds its pipes
    // open, which would otherwise keep `close` from ever arriving.
    child.on('exit', (code) => {
      if (timedOut || cancelled || overflowed) settle({ code, stdout, stderr, timedOut, spawnError: null })
    })
    // A closed stdin is what tells `claude -p` and `codex exec -` the prompt
    // is complete; without `end()` both wait forever.
    child.stdin?.on('error', () => {
      // EPIPE when the CLI exits before reading (bad flag, auth refusal): the
      // exit code and stderr carry the story, so the write error is noise.
    })
    child.stdin?.end(input.stdin)
    if (input.signal?.aborted) cancel()
    else input.signal?.addEventListener('abort', cancel, { once: true })
  })
