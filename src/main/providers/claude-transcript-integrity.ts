// What a Claude Code session file has to hold for a resume to bring the whole
// conversation back.
//
// The CLI rebuilds a resumed session by walking `parentUuid` back from the
// newest entry. An entry whose parent was never written (a child that outlived
// Studio, and crashed mid-turn before its assistant message reached the file)
// ends that walk early: the resume loads only what came after the gap, reports
// success, and the agent carries on with no memory of everything before it.
// `/compact` then answers "Not enough messages to compact." on a conversation
// the transcript shows as hundreds of thousands of tokens long.
//
// So before a child resumes a session, its file is read once: a broken link is
// relinked to the entry written just before it (the turn the lost message
// answered), with the original kept beside it. The same read finds the saved
// cost total the CLI restores on resume, so that total is not booked again as
// the first turn's cost.

import { copyFile, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Entries the CLI links into the conversation chain.
const CHAIN_TYPES = new Set(['user', 'assistant', 'system', 'attachment'])
// Larger than any real session; a file past it is left to the CLI unread.
const MAX_TRANSCRIPT_BYTES = 512 * 1024 * 1024

export type TranscriptCheck =
  | { kind: 'ok'; savedCostUsd: number | null }
  | { kind: 'repaired'; links: number; backupPath: string; savedCostUsd: number | null }
  | { kind: 'missing' }
  | { kind: 'unreadable' }

/** The CLI's folder for a cwd: every character outside [A-Za-z0-9] becomes `-`. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/gu, '-')
}

async function findTranscript(configDir: string, cwd: string, sessionId: string): Promise<string | null> {
  const projects = join(configDir, 'projects')
  const expected = join(projects, claudeProjectDirName(cwd), `${sessionId}.jsonl`)
  if (await isFile(expected)) return expected
  // A long cwd is shortened and hashed by the CLI, so the folder name above is
  // not always its own; the session id is unique across every project.
  const dirs = await readdir(projects).catch(() => [] as string[])
  for (const dir of dirs) {
    const candidate = join(projects, dir, `${sessionId}.jsonl`)
    if (await isFile(candidate)) return candidate
  }
  return null
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isFile(),
    () => false,
  )
}

type Row = { uuid?: unknown; parentUuid?: unknown; type?: unknown; isSidechain?: unknown; totalCostUSD?: unknown }

/**
 * Reads the session's file, relinks any entry whose parent is missing, and
 * returns the saved cost total. Never throws: a file it cannot read is the
 * CLI's to report.
 */
export async function ensureResumableTranscript(
  configDir: string,
  cwd: string,
  sessionId: string,
  clock: () => number = Date.now,
): Promise<TranscriptCheck> {
  try {
    const path = await findTranscript(configDir, cwd, sessionId)
    if (!path) return { kind: 'missing' }
    if ((await stat(path)).size > MAX_TRANSCRIPT_BYTES) return { kind: 'unreadable' }
    const text = await readFile(path, 'utf8')
    const lines = text.split('\n')
    const rows: Array<Row | null> = lines.map((line) => {
      if (!line.trim()) return null
      try {
        const parsed: unknown = JSON.parse(line)
        return parsed && typeof parsed === 'object' ? (parsed as Row) : null
      } catch {
        return null
      }
    })
    const uuids = new Set<string>()
    let savedCostUsd: number | null = null
    for (const row of rows) {
      if (typeof row?.uuid === 'string') uuids.add(row.uuid)
      if (row?.type === 'cost-state' && typeof row.totalCostUSD === 'number' && Number.isFinite(row.totalCostUSD))
        savedCostUsd = row.totalCostUSD
    }
    let previous: string | null = null
    let links = 0
    rows.forEach((row, index) => {
      if (!row || typeof row.uuid !== 'string' || row.isSidechain === true) return
      if (typeof row.type !== 'string' || !CHAIN_TYPES.has(row.type)) return
      if (typeof row.parentUuid === 'string' && !uuids.has(row.parentUuid) && previous) {
        row.parentUuid = previous
        lines[index] = JSON.stringify(row)
        links += 1
      }
      previous = row.uuid
    })
    if (links === 0) return { kind: 'ok', savedCostUsd }
    const backupPath = `${path}.before-repair-${clock()}`
    await copyFile(path, backupPath)
    const temp = `${path}.repair-${clock()}.tmp`
    await writeFile(temp, lines.join('\n'))
    await rename(temp, path)
    return { kind: 'repaired', links, backupPath, savedCostUsd }
  } catch {
    return { kind: 'unreadable' }
  }
}

/** The line the conversation shows about a check that changed something, or null. */
export function transcriptCheckNote(check: TranscriptCheck): string | null {
  if (check.kind === 'repaired')
    return 'Claude Code’s saved history for this conversation had a gap left by a crash, which would have made it resume with only its last few messages. Studio relinked it, so the whole conversation is back; the original file was kept beside it.'
  // A missing file is the CLI's to report: its resume fails on an id it has
  // no session for, and that failure ends the turn in its own words.
  return null
}
