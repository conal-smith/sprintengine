import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { GitCommandResult } from './git'
import { runGitCommand, type GitRepoConfigEntry, type GitRunOptions } from './git-run'

// The programs a repository's own git config can make git run. A repository
// that arrives as a folder or an archive with its `.git` included, or one an
// agent edited, can name any program here, and git would run it for the app's
// own background reads and checkouts with nobody asking: a filter on every
// status that rehashes a file, a merge driver on every merge-tree, a hooks
// folder on every checkout. What is read here is only what the repository
// itself says (its `.git/config`, its worktree's `config.worktree`, and what
// they include); the person's own global and system config is theirs.
//
// Reading it runs nothing: `git config` reads files.

/**
 * One entry of a config listing, as git names it: the scope (`local`,
 * `worktree`, `global`, `system`, `command`), the key with its section and
 * variable lower-cased and a subsection as written (`filter.lfs.smudge`), and
 * the value.
 */
export type GitConfigEntry = GitRepoConfigEntry

/**
 * The settings asked for, in git's extended regular expressions. A
 * `credential.helper` is asked for in every form and kept only when the
 * repository's own value is a shell command (`!…`); a plain helper name runs
 * `git credential-<name>`, a program the person installed.
 */
export const REPO_PROGRAM_KEY_PATTERN =
  '^(filter\\..+\\.(clean|smudge|process)|merge\\..+\\.driver|diff\\..+\\.(textconv|command)|core\\.(hookspath|sshcommand|gitproxy|askpass|pager|editor)|credential(\\..+)?\\.helper)$'

const REPO_PROGRAM_KEY = new RegExp(REPO_PROGRAM_KEY_PATTERN, 'u')
const CREDENTIAL_HELPER = /^credential(\..+)?\.helper$/u
const REPOSITORY_SCOPES = new Set(['local', 'worktree'])

/**
 * `git config --show-scope --null --get-regexp`: each entry is the scope, a
 * NUL, the key, then a newline and the value, ended by a NUL; a key written
 * with no `=` has no newline and no value.
 */
export function parseConfigListing(stdout: string): GitConfigEntry[] {
  const fields = stdout.split('\0')
  const entries: GitConfigEntry[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const scope = fields[index]
    const pair = fields[index + 1]
    if (!scope) continue
    const newline = pair.indexOf('\n')
    const key = newline === -1 ? pair : pair.slice(0, newline)
    const value = newline === -1 ? '' : pair.slice(newline + 1)
    if (key) entries.push({ scope, key, value })
  }
  return entries
}

/** The repository's own entries among `entries` that name a program for git to run. */
export function repoProgramSettings(entries: readonly GitConfigEntry[]): GitConfigEntry[] {
  return entries.filter(
    (entry) =>
      REPOSITORY_SCOPES.has(entry.scope) &&
      REPO_PROGRAM_KEY.test(entry.key) &&
      (!CREDENTIAL_HELPER.test(entry.key) || entry.value.trimStart().startsWith('!')),
  )
}

/** One hash of the settings and their values, so a change to any of them asks again. */
export function repoProgramsHash(settings: readonly GitConfigEntry[]): string {
  const lines = settings.map((entry) => `${entry.scope}\0${entry.key}\0${entry.value}`).sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/** What a repository's config says about programs, read for one folder in it. */
export type RepoProgramsRead = {
  /** The repository as its trust is stored: the main checkout, or a bare repository's folder. */
  repoPath: string
  /** Every entry the pattern matched, the person's own included. */
  entries: GitConfigEntry[]
  /** The repository's own entries that name a program. */
  settings: GitConfigEntry[]
  hash: string
}

type Run = (cwd: string, args: string[], env?: NodeJS.ProcessEnv, options?: GitRunOptions) => Promise<GitCommandResult>

/**
 * Reads, for the repository `cwd` is in, which programs its config names.
 * Null when `cwd` is not in a repository git will open, or git cannot be run.
 * Read under the repository's own settings: reading config runs none of them.
 */
async function readRepoProgramsOnce(cwd: string, run: Run): Promise<Held | null> {
  const dirs = await run(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--absolute-git-dir'])
  if (!dirs.ok) return null
  const [commonDir, gitDir] = dirs.stdout.split(/\r?\n/u).map((line) => line.trim())
  if (!commonDir || !gitDir) return null
  const files = [join(commonDir, 'config'), join(gitDir, 'config.worktree')]
  // Taken before the read, so a change made while git reads is seen next time.
  const stamps = await stampsOf(files)
  const listed = await run(cwd, [
    'config',
    '--show-scope',
    '--null',
    '--includes',
    '--get-regexp',
    REPO_PROGRAM_KEY_PATTERN,
  ])
  // Exit status 1 with nothing printed is "no such setting".
  if (!listed.ok && listed.stdout.trim() !== '') return null
  if (!listed.ok && listed.stderr.trim() !== '') return null
  const entries = listed.ok ? parseConfigListing(listed.stdout) : []
  const settings = repoProgramSettings(entries)
  return {
    repoPath: basename(commonDir) === '.git' ? dirname(commonDir) : commonDir,
    entries,
    settings,
    hash: repoProgramsHash(settings),
    files,
    stamps,
  }
}

// A folder's answer is reused while the config files it came from are
// unchanged; past a few minutes it is read again whatever the files say, for
// a setting that came in through an `include`.
const RECHECK_MS = 2_000
const MAX_AGE_MS = 5 * 60_000

type Held = RepoProgramsRead & { files: string[]; stamps: string }
type Cached = { at: number; checkedAt: number; read: Promise<Held | null> }

async function stampsOf(files: readonly string[]): Promise<string> {
  const parts = await Promise.all(
    files.map((file) =>
      stat(file).then(
        (info) => `${info.mtimeMs}:${info.size}`,
        () => '-',
      ),
    ),
  )
  return parts.join('|')
}

export type RepoProgramsReader = {
  read(cwd: string): Promise<RepoProgramsRead | null>
  /** Drops what is known about every folder, so the next read asks git. */
  forget(): void
}

export function createRepoProgramsReader(
  deps: { run?: Run; now?: () => number; maxEntries?: number } = {},
): RepoProgramsReader {
  const run = deps.run ?? runGitCommand
  const now = deps.now ?? Date.now
  const maxEntries = deps.maxEntries ?? 256
  const cache = new Map<string, Cached>()

  const fresh = (cwd: string): Cached => {
    const read = readRepoProgramsOnce(cwd, run).catch(() => null)
    const entry: Cached = { at: now(), checkedAt: now(), read }
    // A folder that is not a repository now may be one in a moment.
    void read.then((value) => {
      if (!value && cache.get(cwd) === entry) cache.delete(cwd)
    })
    cache.delete(cwd)
    cache.set(cwd, entry)
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    return entry
  }

  return {
    async read(cwd) {
      const held = cache.get(cwd)
      if (!held || now() - held.at > MAX_AGE_MS) return (await fresh(cwd).read) ?? null
      if (now() - held.checkedAt < RECHECK_MS) return (await held.read) ?? null
      const value = await held.read
      if (!value) return (await fresh(cwd).read) ?? null
      held.checkedAt = now()
      if ((await stampsOf(value.files)) !== value.stamps) return (await fresh(cwd).read) ?? null
      return value
    },
    forget() {
      cache.clear()
    },
  }
}
