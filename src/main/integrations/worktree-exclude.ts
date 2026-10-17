// Excluding files from ONE linked worktree's git, and nothing else's.
//
// A connector run's worktree gets a generated `.mcp.json` and
// `.codex/config.toml`, which must never show up in that run's `git status`.
// The obvious home for that — `info/exclude` — is shared: git reads the
// repository's common `info/exclude` for every worktree and ignores one in a
// linked worktree's private git directory (measured against git 2.50). Lines
// written there hid a person's own untracked `.mcp.json` in their main
// checkout, and every other worktree of the repository, for as long as the
// repository existed.
//
// What git does read per worktree is its `config.worktree`, once the
// repository has `extensions.worktreeConfig` on. So the worktree gets its own
// `core.excludesFile`, pointing at a file in its own private git directory.
// That setting REPLACES the person's global excludes file for this worktree,
// so the file carries a copy of it beneath our lines; the copy is taken when
// the worktree is set up, which is also when a connector run starts.
//
// `extensions.worktreeConfig` is a repository-wide switch. Turning it on
// changes nothing by itself (no `config.worktree` exists until something writes
// one), git has understood it since 2.20, and it is recorded in the ledger
// together with whether this app was the one to turn it on, so the removal can
// turn it back off when nothing else uses it.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { writeFileAtomically } from '../config-file-write'
import type { GitCommandResult } from '../git'
import { runGitCommand } from '../git-utils'
import { runGitWorktreeListPorcelain } from '../git-worktree-list'
import { hostIdForPath, recordIntegrationWrite } from './ledger'

type RunGit = (cwd: string, args: string[]) => Promise<GitCommandResult>

/** The file name, inside the worktree's private git directory. */
export const WORKTREE_EXCLUDE_FILE = 'sprintengine-exclude'
export const WORKTREE_EXCLUDE_START = '# >>> sprintengine worktree excludes'
export const WORKTREE_EXCLUDE_END = '# <<< sprintengine worktree excludes'
const INHERITED_PREFIX = '# inherited from: '

/**
 * The exact lines an earlier build appended to the SHARED `info/exclude`, in
 * the order it appended them. Only this contiguous pair is ever taken back
 * out: either line alone may be the person's own.
 */
export const LEGACY_SHARED_EXCLUDE_LINES = ['.mcp.json', '.codex/config.toml'] as const

async function gitOut(runGit: RunGit, cwd: string, args: string[]): Promise<string | null> {
  const result = await runGit(cwd, args)
  return result.ok ? result.stdout.trim() : null
}

function absoluteFrom(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/** Git's default global excludes file when `core.excludesFile` is unset. */
function defaultGlobalExcludes(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim()
  return join(xdg ? xdg : join(homedir(), '.config'), 'git', 'ignore')
}

export function renderWorktreeExcludeFile(
  entries: readonly string[],
  inherited: { path: string; text: string } | null,
): string {
  const lines = [
    WORKTREE_EXCLUDE_START,
    '# Written by SprintEngine Studio for this worktree only (its config.worktree names this',
    '# file as core.excludesFile). Removing the worktree removes it.',
    ...entries,
    WORKTREE_EXCLUDE_END,
  ]
  if (inherited) {
    lines.push(`${INHERITED_PREFIX}${inherited.path}`, inherited.text.replace(/\n+$/u, ''))
  }
  return `${lines.join('\n')}\n`
}

function readInheritedPath(text: string): string | null {
  const line = text.split('\n').find((candidate) => candidate.startsWith(INHERITED_PREFIX))
  return line ? line.slice(INHERITED_PREFIX.length) : null
}

export type WorktreeExcludeResult =
  { scope: 'worktree'; file: string; enabledWorktreeConfig: boolean } | { scope: 'shared'; file: string }

/**
 * Keep `entries` out of one worktree's git. A linked worktree gets its own
 * excludes file as above. The main worktree has no private directory to give
 * it, so its entries go into the shared `info/exclude` between markers the
 * removal can find — the one case where shared and own are the same thing.
 *
 * Also takes back the unmarked pair an earlier build appended to the shared
 * file for this repository. Throws when git fails; callers treat it as
 * best-effort.
 */
export async function excludeFromWorktree(
  worktreePath: string,
  entries: readonly string[],
  runGit: RunGit = runGitCommand,
  options: { skipLegacy?: boolean } = {},
): Promise<WorktreeExcludeResult> {
  const gitDirRaw = await gitOut(runGit, worktreePath, ['rev-parse', '--absolute-git-dir'])
  const commonRaw = await gitOut(runGit, worktreePath, ['rev-parse', '--git-common-dir'])
  if (!gitDirRaw || !commonRaw) throw new Error('git could not resolve the worktree’s git directories.')
  const gitDir = resolve(gitDirRaw)
  const commonDir = resolve(absoluteFrom(worktreePath, commonRaw))
  const sharedExclude = join(commonDir, 'info', 'exclude')
  if (!options.skipLegacy && (await sharedHasLegacyPair(sharedExclude))) {
    // Every linked worktree the old pair was hiding the files in keeps them
    // hidden — each gets its own excludes first — and only then does the pair
    // come out of the file every worktree, and the main checkout, reads.
    for (const other of await linkedWorktrees(worktreePath, runGit)) {
      if (resolve(other) === resolve(worktreePath)) continue
      await excludeFromWorktree(other, entries, runGit, { skipLegacy: true }).catch(() => undefined)
    }
    await removeLegacySharedExcludeLines(sharedExclude)
  }

  if (gitDir === commonDir) {
    await writeMarkedSharedExcludes(sharedExclude, entries)
    recordIntegrationWrite({
      kind: 'git-exclude',
      path: sharedExclude,
      marker: WORKTREE_EXCLUDE_START,
      hostId: hostIdForPath(worktreePath),
      repo: worktreePath,
    })
    return { scope: 'shared', file: sharedExclude }
  }

  const file = join(gitDir, WORKTREE_EXCLUDE_FILE)
  const enabled = (await gitOut(runGit, worktreePath, ['config', '--get', 'extensions.worktreeConfig'])) === 'true'
  if (!enabled) {
    const set = await runGit(worktreePath, ['config', 'extensions.worktreeConfig', 'true'])
    if (!set.ok) throw new Error(set.message ?? 'git could not turn on per-worktree configuration.')
  }

  // The excludes file the worktree would read without us: remembered from our
  // own file on a repeat, read from git's configuration the first time.
  const existing = await readFile(file, 'utf8').catch(() => null)
  let inheritedPath = existing ? readInheritedPath(existing) : null
  if (inheritedPath === null) {
    const configured = await gitOut(runGit, worktreePath, ['config', '--get', 'core.excludesFile'])
    inheritedPath =
      configured && resolve(expandHome(configured)) !== file ? expandHome(configured) : defaultGlobalExcludes()
  }
  const inheritedText =
    inheritedPath && existsSync(inheritedPath) ? await readFile(inheritedPath, 'utf8').catch(() => null) : null
  await writeFileAtomically(
    file,
    renderWorktreeExcludeFile(entries, inheritedText === null ? null : { path: inheritedPath, text: inheritedText }),
  )
  const setFile = await runGit(worktreePath, ['config', '--worktree', 'core.excludesFile', file.split('\\').join('/')])
  if (!setFile.ok) throw new Error(setFile.message ?? 'git could not set the worktree’s excludes file.')

  recordIntegrationWrite({
    kind: 'git-exclude',
    path: file,
    marker: 'owned',
    hostId: hostIdForPath(worktreePath),
    repo: worktreePath,
    createdFile: true,
    detail: { worktree: worktreePath, commonDir, enabledWorktreeConfig: !enabled },
  })
  return { scope: 'worktree', file, enabledWorktreeConfig: !enabled }
}

async function writeMarkedSharedExcludes(path: string, entries: readonly string[]): Promise<void> {
  const text = (await readFile(path, 'utf8').catch(() => null)) ?? ''
  const block = [WORKTREE_EXCLUDE_START, ...entries, WORKTREE_EXCLUDE_END].join('\n')
  const without = removeMarkedBlock(text)
  const base = without.replace(/\n*$/u, '')
  await writeFileAtomically(path, `${base}${base ? '\n' : ''}${block}\n`)
}

/** `text` without our marked block, byte for byte otherwise. */
export function removeMarkedBlock(text: string): string {
  const start = text.indexOf(WORKTREE_EXCLUDE_START)
  if (start < 0) return text
  const endMarker = text.indexOf(WORKTREE_EXCLUDE_END, start)
  if (endMarker < 0) return text
  let end = endMarker + WORKTREE_EXCLUDE_END.length
  if (text[end] === '\n') end += 1
  return text.slice(0, start) + text.slice(end)
}

/**
 * `text` without the unmarked pair an earlier build appended: the two lines,
 * adjacent and in that order, each a whole line. Returns null when the pair
 * is not there.
 */
export function withoutLegacySharedPair(text: string): string | null {
  const lines = text.split('\n')
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (
      lines[index].trim() === LEGACY_SHARED_EXCLUDE_LINES[0] &&
      lines[index + 1].trim() === LEGACY_SHARED_EXCLUDE_LINES[1]
    ) {
      lines.splice(index, 2)
      return lines.join('\n')
    }
  }
  return null
}

async function sharedHasLegacyPair(sharedExclude: string): Promise<boolean> {
  const text = await readFile(sharedExclude, 'utf8').catch(() => null)
  return text !== null && withoutLegacySharedPair(text) !== null
}

/** Every linked worktree of the repository (the main checkout, listed first, excluded). */
async function linkedWorktrees(worktreePath: string, runGit: RunGit): Promise<string[]> {
  const listing = await runGitWorktreeListPorcelain(runGit, worktreePath)
  if (!listing.ok) return []
  const paths = listing.stdout
    .split('\0')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
  return paths.slice(1).filter((path) => existsSync(path))
}

/** Take the earlier build's pair back out of a shared exclude file. True when it was there. */
export async function removeLegacySharedExcludeLines(sharedExclude: string): Promise<boolean> {
  const text = await readFile(sharedExclude, 'utf8').catch(() => null)
  if (text === null) return false
  const next = withoutLegacySharedPair(text)
  if (next === null) return false
  await writeFileAtomically(sharedExclude, next)
  return true
}
