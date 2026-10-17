import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { terminateCliChild } from './cli-child-process'
import { spawnCliHostChild, type WslCliChild } from './cli-host-child'

export type RpcMessage = {
  id?: string | number
  method?: string
  params?: unknown
  result?: unknown
  error?: { message?: string; code?: number }
}
export type CodexRpcTransport = {
  request(method: string, params: unknown): Promise<unknown>
  notify(method: string, params: unknown): void
  respond(id: string | number, result: unknown): void
  reject(id: string | number, message: string): void
  close(): void
  readonly pid: number | null
}
/** How long a request waits for Codex's answer unless the caller says otherwise. */
export const CODEX_RPC_TIMEOUT_MS = 30_000

export type CodexRpcOptions = {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  onMessage(message: RpcMessage): void | Promise<void>
  onClose(error: Error): void
  // A tool Codex could not run, which it reports only on stderr.
  onToolFailure?(message: string): void
  // Passed to `codex app-server` after its own arguments.
  args?: string[]
  timeoutMs?: number
  spawnChild?: typeof spawn
  platform?: NodeJS.Platform
  // Set when the app-server runs inside a WSL distribution: `command` is its
  // Linux path there and `cwd` the folder as this machine names it.
  wsl?: WslCliChild | null
}

/** Codex answered the request with an error, as opposed to the request never
 * being answered (a timeout, or the process closing). */
export class CodexRpcError extends Error {}

/** The Codex process could not be started at all. */
export class CodexSpawnError extends Error {}

const MAX_FRAME_BYTES = 16 * 1024 * 1024

const TOOL_FAILURE_CHARS = 500

/**
 * The reason in a stderr line that says Codex's tool router failed a call, or
 * null for any other line. A call that fails before it runs (its sandbox or
 * code-mode host never answered) produces no item on the protocol, so without
 * this the chat shows nothing at all. Only the router's own error text is
 * taken; the rest of stderr can carry request details and stays unread.
 */
export function codexToolFailure(line: string): string | null {
  // oxlint-disable-next-line no-control-regex -- stripping the ANSI colours Codex logs with
  const plain = line.replace(/\u001b\[[0-9;]*m/g, '')
  const match = /\bERROR\s+codex_core::tools::router:\s*error=(.+)$/.exec(plain)
  const reason = match?.[1].trim()
  return reason ? reason.slice(0, TOOL_FAILURE_CHARS) : null
}

const STARTUP_STDERR_CHARS = 300

/**
 * A stderr line worth repeating when Codex exits before it has said anything
 * on the protocol: its colours stripped, clipped, and never one that names a
 * credential. Until the app-server answers, a failed start (a folder it may not
 * enter, a config it cannot read) is said only on stderr, and "Codex process
 * exited (1)." alone gives the person nothing to act on.
 */
export function codexStartupStderrLine(line: string): string | null {
  // oxlint-disable-next-line no-control-regex -- stripping the ANSI colours Codex logs with
  const plain = line.replace(/\u001b\[[0-9;]*m/g, '').trim()
  if (!plain) return null
  if (/secret|token|api[-_]?key|authorization|bearer|password/iu.test(plain)) return null
  return plain.length > STARTUP_STDERR_CHARS ? `${plain.slice(0, STARTUP_STDERR_CHARS - 1)}…` : plain
}

/** `SPRINTENGINE_CODEX_APP_SERVER_ARGS` split as a shell would, quotes and all. */
export function codexAppServerArgs(value: string | undefined): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const char of value?.trim() ?? '') {
    if (quote) {
      if (char === quote) quote = null
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) args.push(current)
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (started) args.push(current)
  return args
}

/** JSONL framing is confined here; protocol events never share stderr or shell parsing. */
export function createCodexRpcTransport(options: CodexRpcOptions): CodexRpcTransport {
  // In WSL the child is issued its own MCP channel token: Codex hands it to the
  // app's gateway, whose entry names it (`env_vars`).
  const child = spawnCliHostChild(
    {
      command: options.command,
      args: ['app-server', '--listen', 'stdio://', ...(options.args ?? [])],
      cwd: options.cwd,
      env: options.env,
      wsl: options.wsl,
    },
    { platform: options.platform, spawn: options.spawnChild ?? spawn },
  )
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  let sequence = 0
  // The unterminated tail of stdout, kept as the chunks it arrived in. A newline
  // byte never occurs inside a multi-byte UTF-8 sequence, so frames are split on
  // bytes and each is decoded once; a chunk is scanned only when it arrives, so a
  // multi-megabyte frame costs linear time rather than a rescan per chunk.
  let partial: Buffer[] = []
  let partialBytes = 0
  let closed = false
  let delivery = Promise.resolve()
  const finish = (error: Error) => {
    if (closed) return
    closed = true
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
    terminateCliChild(child, { platform: options.platform })
    void delivery.then(() => options.onClose(error))
  }
  const write = (message: RpcMessage) => {
    if (closed || child.stdin.destroyed) throw new Error('Codex connection is closed.')
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  child.stdin.on('error', (error) => finish(error))
  child.on('error', (error) =>
    finish(
      child.pid === undefined
        ? new CodexSpawnError(`Codex could not be started from ${options.command}: ${error.message}`)
        : error,
    ),
  )
  // Whether Codex has spoken on the protocol yet: until it has, its last
  // stderr line is kept to say why, should it exit.
  let started = false
  let startupLine: string | null = null
  // Drain diagnostics without retaining credentials or dumping them into the
  // transcript: a line is kept only until it is complete, and only a tool
  // router failure's reason, or the cleaned last line of a start that failed,
  // leaves this function.
  const stderrDecoder = new StringDecoder('utf8')
  let stderrLine = ''
  child.stderr.on('data', (chunk: Buffer) => {
    if (!options.onToolFailure && started) return
    stderrLine += stderrDecoder.write(chunk)
    // Each line is read where it lies, and the remainder cut once per chunk.
    let start = 0
    let newline: number
    while ((newline = stderrLine.indexOf('\n', start)) >= 0) {
      const line = stderrLine.slice(start, newline)
      start = newline + 1
      if (!started) startupLine = codexStartupStderrLine(line) ?? startupLine
      const reason = options.onToolFailure ? codexToolFailure(line) : null
      if (reason) options.onToolFailure?.(reason)
    }
    if (start > 0) stderrLine = stderrLine.slice(start)
    // A line this long is not a log line worth reading.
    if (stderrLine.length > 64 * 1024) stderrLine = ''
  })
  // A start that failed says why in the exit: the last line Codex wrote, or
  // the unterminated one it was writing.
  child.on('close', (code) => {
    const status = `Codex process exited${code === null ? '' : ` (${code})`}`
    const said = !started ? (startupLine ?? (stderrLine ? codexStartupStderrLine(stderrLine) : null)) : null
    finish(new Error(said ? `${status}: ${said}${/[.!?]$/u.test(said) ? '' : '.'}` : `${status}.`))
  })
  const deliver = (line: string) => {
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
    } catch {
      return
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return
    if (typeof message.method !== 'string' && typeof message.id === 'number') {
      const request = pending.get(message.id)
      if (!request) return
      clearTimeout(request.timer)
      pending.delete(message.id)
      if (message.error) request.reject(new CodexRpcError(message.error.message ?? 'Codex request failed.'))
      else request.resolve(message.result)
    } else if (typeof message.method === 'string') {
      delivery = delivery
        .then(() => options.onMessage(message))
        .catch((error: unknown) => {
          finish(error instanceof Error ? error : new Error('Codex event handling failed.'))
          child.kill()
        })
    }
  }
  child.stdout.on('data', (chunk: Buffer) => {
    if (closed) return
    // Codex is talking: what it says on stderr from here is its own business.
    if (!started) {
      started = true
      startupLine = null
    }
    let start = 0
    let newline: number
    while ((newline = chunk.indexOf(10, start)) >= 0) {
      const head = chunk.subarray(start, newline)
      const frame = partial.length === 0 ? head : Buffer.concat([...partial, head], partialBytes + head.length)
      partial = []
      partialBytes = 0
      start = newline + 1
      deliver(frame.toString('utf8'))
      if (closed) return
    }
    if (start >= chunk.length) return
    const rest = chunk.subarray(start)
    partial.push(rest)
    partialBytes += rest.length
    if (partialBytes > MAX_FRAME_BYTES) {
      partial = []
      partialBytes = 0
      finish(new Error('Codex protocol frame exceeds the size limit.'))
      child.kill()
    }
  })
  return {
    get pid() {
      return closed ? null : (child.pid ?? null)
    },
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Codex ${method} timed out.`))
        }, options.timeoutMs ?? CODEX_RPC_TIMEOUT_MS)
        pending.set(id, { resolve, reject, timer })
        try {
          write({ id, method, params })
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(error)
        }
      })
    },
    notify: (method, params) => write({ method, params }),
    respond: (id, result) => write({ id, result }),
    reject: (id, message) => write({ id, error: { code: -32601, message } }),
    close() {
      finish(new Error('Codex connection closed.'))
    },
  }
}
