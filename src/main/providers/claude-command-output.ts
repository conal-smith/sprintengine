import { open, readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { claudeProjectDirName } from './claude-transcript-integrity'

/**
 * A running Bash command's output in a Claude chat, as it is printed.
 *
 * Claude Code's SDK says nothing about a command until its result, so a long
 * build or test run sat as an empty step until it ended. The CLI does write the
 * output as it goes: a foreground command that runs for more than a moment is
 * registered as a `local_bash` task, announced with a `task_started` message
 * naming the task and the tool call, and its output lands in
 * `<CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>/<project>/<session>/tasks/<task>.output`
 * (Claude Code 2.1.296: the file exists from the command's start, the
 * announcement follows a few seconds in, and the file is removed once the
 * command ends). This reads that file from where it got to, on a short timer,
 * and hands each new piece on as appended output of the call, the way Codex's
 * own output deltas arrive.
 *
 * Best effort by design. A file that cannot be found or read leaves the step as
 * it was before: the tool result still carries the whole output and replaces
 * what streamed. Nothing here throws.
 */

export const COMMAND_OUTPUT_POLL_MS = 250
// A command that prints faster than this is followed a tick behind, not read whole each time.
export const COMMAND_OUTPUT_MAX_BYTES_PER_TICK = 64 * 1024
// Past this the step's preview is the tail anyway; the result brings the rest.
export const COMMAND_OUTPUT_MAX_TOTAL_BYTES = 4 * 1024 * 1024
// Ticks spent looking for the file before giving up on a command.
export const COMMAND_OUTPUT_LOCATE_ATTEMPTS = 8
// Project folders looked through when the cwd's own name does not hold the session.
const MAX_PROJECT_DIRS_SCANNED = 512
// The CLI caps a project folder's name and suffixes a hash past it; such a name is found by the scan.
const MAX_PROJECT_DIR_NAME = 200
// Session and task ids are path components here: only the shapes the CLI makes.
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Where a local Claude Code child keeps its task output for this user, or null
 * where there is none to read: Windows (no uid, and the CLI's own path there
 * is not one this process can predict).
 */
export function claudeTaskOutputRoot(
  env: Readonly<Record<string, string | undefined>>,
  host: { platform: NodeJS.Platform; uid: number | undefined } = {
    platform: process.platform,
    uid: process.getuid?.(),
  },
): string | null {
  if (host.platform === 'win32' || host.uid === undefined) return null
  return join(env.CLAUDE_CODE_TMPDIR || '/tmp', `claude-${host.uid}`)
}

export type ClaudeCommandOutputChunk = { toolUseId: string; output: string; totalBytes: number }

export type ClaudeCommandOutputOptions = {
  /** `claudeTaskOutputRoot` for the child; null turns following off. */
  root: string | null
  /** The child's cwd, which names its project folder. */
  cwd: string
  emit: (chunk: ClaudeCommandOutputChunk) => void
  pollMs?: number
  maxBytesPerTick?: number
  maxTotalBytes?: number
  locateAttempts?: number
}

export type ClaudeCommandOutput = {
  /**
   * Read one SDK message before it is mapped. A promise when the message ends
   * a followed command: awaited, the last of its output is handed on before
   * its result is.
   */
  observe(message: Record<string, unknown>): Promise<void> | undefined
  /** Stop following everything; nothing is emitted after. */
  stopAll(): void
}

type Tail = {
  taskId: string
  toolUseId: string
  sessionId: string
  path: string | null
  attempts: number
  offset: number
  decoder: StringDecoder
  timer: ReturnType<typeof setTimeout> | null
  reading: Promise<void> | null
  // Its result is in: the last read, which no tick follows.
  ending: Promise<void> | null
  stopped: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** The task's output file under `root`, or null when it is not there (yet). */
export async function locateClaudeTaskOutput(
  root: string,
  cwd: string,
  sessionId: string,
  taskId: string,
): Promise<string | null> {
  if (!SAFE_ID.test(sessionId) || !SAFE_ID.test(taskId)) return null
  const base = await realpath(root).catch(() => root)
  const leaf = join(sessionId, 'tasks', `${taskId}.output`)
  // The CLI names the folder after the cwd as it resolves it (`/tmp` is
  // `/private/tmp` on a Mac).
  const project = claudeProjectDirName(await realpath(cwd).catch(() => cwd))
  if (project.length <= MAX_PROJECT_DIR_NAME && (await isFile(join(base, project, leaf))))
    return join(base, project, leaf)
  let entries: string[]
  try {
    entries = (await readdir(base)).slice(0, MAX_PROJECT_DIRS_SCANNED)
  } catch {
    return null
  }
  for (const entry of entries) {
    if (entry === project) continue
    const candidate = join(base, entry, leaf)
    if (await isFile(candidate)) return candidate
  }
  return null
}

export function createClaudeCommandOutput(options: ClaudeCommandOutputOptions): ClaudeCommandOutput {
  const pollMs = options.pollMs ?? COMMAND_OUTPUT_POLL_MS
  const maxBytesPerTick = options.maxBytesPerTick ?? COMMAND_OUTPUT_MAX_BYTES_PER_TICK
  const maxTotalBytes = options.maxTotalBytes ?? COMMAND_OUTPUT_MAX_TOTAL_BYTES
  const locateAttempts = options.locateAttempts ?? COMMAND_OUTPUT_LOCATE_ATTEMPTS
  // The main thread's Bash calls not yet answered. A subagent's step is shown
  // in its lane and is left as it was.
  const bashCalls = new Set<string>()
  const tails = new Map<string, Tail>()
  let disposed = false

  function stop(tail: Tail): void {
    tail.stopped = true
    if (tail.timer) clearTimeout(tail.timer)
    tail.timer = null
    if (tails.get(tail.toolUseId) === tail) tails.delete(tail.toolUseId)
  }

  async function readMore(tail: Tail): Promise<void> {
    if (!tail.path) {
      tail.path = await locateClaudeTaskOutput(options.root!, options.cwd, tail.sessionId, tail.taskId).catch(
        () => null,
      )
      if (!tail.path) {
        tail.attempts += 1
        if (tail.attempts >= locateAttempts) stop(tail)
        return
      }
    }
    const room = Math.min(maxBytesPerTick, maxTotalBytes - tail.offset)
    if (room <= 0) return stop(tail)
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(tail.path, 'r')
      const size = (await handle.stat()).size
      if (size <= tail.offset) return
      const buffer = Buffer.alloc(Math.min(room, size - tail.offset))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, tail.offset)
      if (bytesRead <= 0 || tail.stopped) return
      tail.offset += bytesRead
      // A character split across two reads is held until its last byte comes.
      const output = tail.decoder.write(buffer.subarray(0, bytesRead))
      if (output) options.emit({ toolUseId: tail.toolUseId, output, totalBytes: tail.offset })
    } catch {
      // Gone (the command ended and the CLI removed it) or unreadable: the
      // result says the rest.
      stop(tail)
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  function tick(tail: Tail): void {
    tail.timer = null
    if (tail.stopped || tail.ending) return
    tail.reading = readMore(tail)
      .catch(() => stop(tail))
      .finally(() => {
        tail.reading = null
        if (!tail.stopped && !tail.ending) tail.timer = setTimeout(() => tick(tail), pollMs)
      })
  }

  function finish(tail: Tail): Promise<void> {
    tail.ending ??= (async () => {
      if (tail.timer) clearTimeout(tail.timer)
      tail.timer = null
      await tail.reading?.catch(() => undefined)
      // The last of it, when the file is still there to read.
      if (!tail.stopped && tail.path) await readMore(tail).catch(() => undefined)
      stop(tail)
    })()
    return tail.ending
  }

  function start(message: Record<string, unknown>): void {
    const toolUseId = typeof message.tool_use_id === 'string' ? message.tool_use_id : ''
    const taskId = typeof message.task_id === 'string' ? message.task_id : ''
    const sessionId = typeof message.session_id === 'string' ? message.session_id : ''
    if (!toolUseId || !taskId || !sessionId || !bashCalls.has(toolUseId) || tails.has(toolUseId)) return
    const tail: Tail = {
      taskId,
      toolUseId,
      sessionId,
      path: null,
      attempts: 0,
      offset: 0,
      decoder: new StringDecoder('utf8'),
      timer: null,
      reading: null,
      ending: null,
      stopped: false,
    }
    tails.set(toolUseId, tail)
    tick(tail)
  }

  function tailForTask(taskId: unknown): Tail | undefined {
    for (const tail of tails.values()) if (tail.taskId === taskId) return tail
    return undefined
  }

  return {
    observe(message) {
      if (disposed || !options.root) return undefined
      if (message.type === 'assistant') {
        if (message.parent_tool_use_id) return undefined
        const content = asRecord(message.message)?.content
        for (const block of Array.isArray(content) ? content.map(asRecord) : []) {
          if (block?.type === 'tool_use' && block.name === 'Bash' && typeof block.id === 'string')
            bashCalls.add(block.id)
        }
        return undefined
      }
      if (message.type === 'system') {
        if (message.subtype === 'task_started') {
          // A command started in the background has no step waiting on it;
          // its output is read when someone asks for it.
          if (message.task_type === 'local_bash' && message.is_backgrounded === false) start(message)
          return undefined
        }
        const tail = tailForTask(message.task_id)
        if (!tail) return undefined
        if (message.subtype === 'task_updated' && asRecord(message.patch)?.is_backgrounded === true) {
          // Sent to the background: its call returns now and the step ends there.
          stop(tail)
          return undefined
        }
        if (message.subtype === 'task_notification') return finish(tail)
        return undefined
      }
      if (message.type === 'user') {
        const content = asRecord(message.message)?.content
        const ending: Promise<void>[] = []
        for (const block of Array.isArray(content) ? content.map(asRecord) : []) {
          if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
          bashCalls.delete(block.tool_use_id)
          const tail = tails.get(block.tool_use_id)
          if (tail) ending.push(finish(tail))
        }
        return ending.length ? Promise.all(ending).then(() => undefined) : undefined
      }
      return undefined
    },
    stopAll() {
      disposed = true
      for (const tail of Array.from(tails.values())) stop(tail)
      bashCalls.clear()
    },
  }
}
