import { appendFile, chmod, mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import type { DiagnosticLogEntry, DiagnosticLogInput } from '../shared/electron-api'
import { studioPlatform } from '../server/platform/platform'
import { redactSecrets } from './redact-secrets'

// The diagnostics log the server appends to. Opening its folder in the OS file
// manager is the shell's half (diagnostics-folder.ts).

export function getDiagnosticsLogDirectory(): string {
  return studioPlatform().paths.logsDir()
}

// The file's name before its date. The Studio server out of process writes
// `diagnostics-server-…` beside the shell's own, so two processes never append
// to one file.
let logName = 'diagnostics'

/** Name this process's diagnostics file; set once, by an entry, before anything is written. */
export function setDiagnosticsLogName(name: string): void {
  logName = name
}

function getDiagnosticsLogPath(timestamp = new Date()): string {
  const day = timestamp.toISOString().slice(0, 10)
  return join(getDiagnosticsLogDirectory(), `${logName}-${day}.jsonl`)
}

// Paths this process has already narrowed to the owner. A file or folder an
// older build made at the default mode is narrowed the first time it is written.
const narrowed = new Set<string>()

async function ownerOnly(path: string, mode: number): Promise<void> {
  if (narrowed.has(path)) return
  narrowed.add(path)
  await chmod(path, mode).catch(() => undefined)
}

/**
 * Appends one entry. Every text field goes through `redactSecrets` first, so a
 * caller that passes an error message or a command line with a token in it
 * does not put the token on disk; the entry returned is the one written. The
 * log and its folder are the owner's alone.
 */
export async function writeDiagnosticLog(input: DiagnosticLogInput): Promise<DiagnosticLogEntry> {
  const timestamp = new Date()
  const logPath = getDiagnosticsLogPath(timestamp)
  const entry: DiagnosticLogEntry = {
    ...input,
    title: redactSecrets(input.title),
    message: redactSecrets(input.message),
    ...(input.details !== undefined ? { details: redactSecrets(input.details) } : {}),
    id: `diag-${timestamp.getTime()}-${randomBytes(4).toString('hex')}`,
    timestamp: timestamp.toISOString(),
    logPath,
  }

  const dir = dirname(logPath)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await ownerOnly(dir, 0o700)
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8', mode: 0o600 })
  await ownerOnly(logPath, 0o600)
  return entry
}

/**
 * A `log(line)` for a service that narrates what it does (the worktree pool,
 * the dependency installer): each line goes to the console, as it did, and
 * into the diagnostics log under `title`, where a person reporting a problem
 * can find it after the console is gone. The returned promise settles once
 * the line is written; a line that cannot be written has nowhere else to go,
 * and is dropped.
 */
export function diagnosticLogger(
  title: string,
  level: DiagnosticLogInput['level'] = 'info',
): (line: string) => Promise<void> {
  return (line) => {
    console.info(`[${title}] ${line}`)
    return writeDiagnosticLog({ level, source: 'workspace', title, message: line }).then(
      () => undefined,
      () => undefined,
    )
  }
}
