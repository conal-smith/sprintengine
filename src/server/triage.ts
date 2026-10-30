import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { arch, homedir, release } from 'node:os'
import { join, posix, win32 } from 'node:path'

import { redactSecrets } from '../main/redact-secrets'

// `studio-server triage`: gather what Studio wrote about itself on this
// computer, and hand it to the person's own agent CLI with a prompt to work out
// what is wrong with their install.
//
// Everything stays local: the diagnostics are read from disk, put in the
// prompt, and the prompt goes to `claude` or `codex` running in this terminal,
// signed in as the person. Nothing is uploaded by Studio. What goes in the
// prompt is what a bug report would carry, with this computer's identity taken
// out: the home folder is written `~`, each entry's own log path is dropped,
// and every text field is passed through the same secret redaction the log
// applied when it was written, again, for a log an older build wrote.

export type TriageAgent = 'claude' | 'codex'

export const TRIAGE_AGENTS: readonly TriageAgent[] = ['claude', 'codex']

/** The newest entries carried, across the newest files: a day of a busy app is thousands. */
export const TRIAGE_MAX_ENTRIES = 200
/** The longest a single field may be in the prompt; a stack trace past this is cut. */
const MAX_FIELD_CHARS = 2_000
/** Diagnostics files read, newest first. */
const MAX_FILES = 3

export type TriageFacts = {
  studioVersion: string
  node: string
  platform: string
  osRelease: string
  arch: string
}

/** The folders Studio's diagnostics are written in on this computer: the desktop app's, then the server's own. */
export function triageLogDirectories(input: {
  platform: NodeJS.Platform
  home: string
  env: NodeJS.ProcessEnv
  serverLogsDir: string
}): string[] {
  const app = 'SprintEngine Studio'
  const desktop =
    input.platform === 'darwin'
      ? posix.join(input.home, 'Library', 'Logs', app)
      : input.platform === 'win32'
        ? win32.join(input.env.APPDATA?.trim() || win32.join(input.home, 'AppData', 'Roaming'), app, 'logs')
        : posix.join(input.env.XDG_CONFIG_HOME?.trim() || posix.join(input.home, '.config'), app, 'logs')
  return [...new Set([desktop, input.serverLogsDir])]
}

/** A string with this computer's home folder written `~`, and its secrets redacted. */
export function scrubbed(value: string, home: string): string {
  let text = redactSecrets(value)
  if (home.length > 1) {
    // Both spellings: a JSON-escaped Windows path doubles its backslashes.
    for (const spelling of new Set([home, home.replace(/\\/g, '\\\\')])) text = text.split(spelling).join('~')
  }
  return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)}… (cut)` : text
}

/** One diagnostics line as the prompt carries it, or null for a line that is not an entry. */
export function triageEntry(line: string, home: string): string | null {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return null
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const fields = entry as Record<string, unknown>
  const text = (key: string): string | null =>
    typeof fields[key] === 'string' && fields[key] ? scrubbed(fields[key] as string, home) : null
  const head = [text('timestamp'), text('level'), text('source')].filter(Boolean).join(' ')
  const body = [text('title'), text('message'), text('details')].filter(Boolean).join(' — ')
  return body ? `${head} ${body}`.trim() : null
}

/** The newest diagnostics entries in `directories`, oldest first, at most `limit`. */
export async function readTriageEntries(
  directories: readonly string[],
  home: string,
  limit = TRIAGE_MAX_ENTRIES,
): Promise<string[]> {
  const files: string[] = []
  for (const directory of directories) {
    const names = await readdir(directory).catch(() => [] as string[])
    for (const name of names) if (/^diagnostics.*\.jsonl$/u.test(name)) files.push(join(directory, name))
  }
  // The day is in the name (`diagnostics-2026-10-30.jsonl`), so the newest sort last.
  const byDay = (path: string) => path.match(/(\d{4}-\d{2}-\d{2})\.jsonl$/u)?.[1] ?? ''
  const newest = files.sort((a, b) => byDay(a).localeCompare(byDay(b))).slice(-MAX_FILES)
  const entries: string[] = []
  for (const file of newest) {
    const body = await readFile(file, 'utf8').catch(() => '')
    for (const line of body.split('\n')) {
      const entry = line.trim() ? triageEntry(line, home) : null
      if (entry) entries.push(entry)
    }
  }
  return entries.slice(-limit)
}

/** What the agent is asked, with the facts and the entries in it. */
export function triagePrompt(facts: TriageFacts, entries: readonly string[]): string {
  return [
    'You are helping someone work out what is wrong with their SprintEngine Studio install, an Electron app that runs agent CLIs (Claude Code, Codex and others) in chats and terminals.',
    'Below are the versions on this computer and the newest entries from the diagnostics log Studio writes. Read them, say what looks wrong and why, most likely cause first, and suggest the steps to fix it. Ask before running any command that changes something; reading and checking is fine.',
    'If nothing in the log points at a problem, say so, and ask the person what they saw.',
    '',
    '## This computer',
    `- SprintEngine Studio ${facts.studioVersion}`,
    `- Node ${facts.node}`,
    `- ${facts.platform} ${facts.osRelease} (${facts.arch})`,
    '',
    `## Diagnostics log (newest ${entries.length} entries, oldest first)`,
    entries.length ? entries.map((entry) => `- ${entry}`).join('\n') : '(no entries were found)',
  ].join('\n')
}

/** This process's facts. */
export function triageFacts(studioVersion: string): TriageFacts {
  return { studioVersion, node: process.versions.node, platform: process.platform, osRelease: release(), arch: arch() }
}

/**
 * Gather and either print the prompt or start the agent with it, in this
 * terminal. Resolves with the exit code.
 */
export async function runTriage(input: {
  agent: TriageAgent
  print: boolean
  studioVersion: string
  serverLogsDir: string
  logsDir: string | null
  write: (text: string) => void
}): Promise<number> {
  const home = homedir()
  const directories = input.logsDir
    ? [input.logsDir]
    : triageLogDirectories({ platform: process.platform, home, env: process.env, serverLogsDir: input.serverLogsDir })
  const entries = await readTriageEntries(directories, home)
  const prompt = triagePrompt(triageFacts(input.studioVersion), entries)
  if (input.print) {
    input.write(`${prompt}\n`)
    return 0
  }
  // The prompt is the agent's first message, as an argument: both CLIs take
  // one and open their interactive session on it. Never through a shell,
  // which would read the log's text as a command line.
  return new Promise<number>((resolve) => {
    const child = spawn(input.agent, [prompt], { stdio: 'inherit' })
    child.once('error', (error) => {
      input.write(
        `Could not start ${input.agent}: ${error.message}. Is it installed and on PATH? ` +
          'Run triage --print to get the prompt and paste it into the agent yourself.\n',
      )
      resolve(1)
    })
    child.once('exit', (code) => resolve(code ?? 1))
  })
}
