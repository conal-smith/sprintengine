import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { parseUnifiedDiff, type DiffHunk } from '../../shared/git/hunks'
import type { TourFileSnapshot } from '../../shared/tours/tour-anchor'
import type { TourFileStatus, TourRevisions } from '../../shared/tours/tour-types'
import { readFileAtRev } from '../branch-steps'
import { runGitCommand } from '../git-run'

// What a tour reads from git: which files its changes cover, and each file's
// two sides and `-U0` hunks.
//
// Two shapes of "changes", read two ways:
//
// - A committed range is `base..head`, both resolved to SHAs once, at
//   creation, and pinned. Every later read of the tour sees the same bytes.
// - The working tree (and an agent's changelist, which is a subset of it) is
//   HEAD → the files on disk, read LIVE: the base is HEAD's SHA as it was when
//   the tour was written, and the new side is whatever is on disk now. That is
//   the whole reason a step can become `moved`.
//
// Nothing here is cached. A tour re-reads only the files its steps name, and
// only when a window asks.

/** git's empty tree: the "before" of a repository with no commits yet. */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** Past this a side is not shown as text (the same ceiling the diff viewer's commit reads use). */
const MAX_TEXT_BYTES = 5 * 1024 * 1024

export type TourChangedFile = { path: string; oldPath?: string; status: TourFileStatus }

function looksLikeOption(value: string): boolean {
  return value.startsWith('-')
}

export async function resolveRepoRoot(cwd: string): Promise<string | null> {
  const result = await runGitCommand(cwd, ['rev-parse', '--show-toplevel'])
  if (!result.ok) return null
  const root = result.stdout.trim()
  return root || null
}

/** A commit-ish to its SHA, or null. Refuses anything shaped like an option. */
export async function resolveCommit(repoRoot: string, rev: string): Promise<string | null> {
  if (!rev || looksLikeOption(rev)) return null
  const result = await runGitCommand(repoRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
  if (!result.ok) return null
  return result.stdout.trim() || null
}

/** HEAD's SHA, or the empty tree for a repository with no commits. */
export async function resolveHead(repoRoot: string): Promise<string> {
  return (await resolveCommit(repoRoot, 'HEAD')) ?? EMPTY_TREE_SHA
}

/** `git diff --name-status -z` output → files. */
export function parseNameStatus(output: string): TourChangedFile[] {
  const tokens = output.split('\0')
  const files: TourChangedFile[] = []
  let i = 0
  while (i < tokens.length) {
    const code = tokens[i]
    if (!code) {
      i += 1
      continue
    }
    const letter = code[0]
    if (letter === 'R' || letter === 'C') {
      const from = tokens[i + 1]
      const to = tokens[i + 2]
      i += 3
      if (!from || !to) continue
      files.push(letter === 'R' ? { path: to, oldPath: from, status: 'renamed' } : { path: to, status: 'new' })
      continue
    }
    const path = tokens[i + 1]
    i += 2
    if (!path) continue
    files.push({ path, status: letter === 'A' ? 'new' : letter === 'D' ? 'deleted' : 'modified' })
  }
  return files
}

/** Every file in the tour's changes. */
export async function listTourFiles(
  repoRoot: string,
  revisions: TourRevisions,
): Promise<{ ok: true; files: TourChangedFile[] } | { ok: false; message: string }> {
  const base = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M']
  if (revisions.head !== 'worktree') {
    const result = await runGitCommand(repoRoot, [...base, revisions.base, revisions.head, '--'])
    if (!result.ok) return { ok: false, message: result.message ?? 'git diff failed.' }
    return { ok: true, files: parseNameStatus(result.stdout) }
  }
  const [tracked, untracked] = await Promise.all([
    runGitCommand(repoRoot, [...base, revisions.base, '--']),
    runGitCommand(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
  ])
  if (!tracked.ok) return { ok: false, message: tracked.message ?? 'git diff failed.' }
  const files = parseNameStatus(tracked.stdout)
  if (untracked.ok) {
    const known = new Set(files.map((file) => file.path))
    for (const path of untracked.stdout.split('\0')) {
      if (path && !known.has(path)) files.push({ path, status: 'new' })
    }
  }
  return { ok: true, files }
}

type SideRead = { text: string | null; unreadable: 'binary' | 'too-large' | null }

function classify(text: string): SideRead {
  return text.slice(0, 8000).includes('\0') ? { text: null, unreadable: 'binary' } : { text, unreadable: null }
}

async function readSideAtRev(repoRoot: string, rev: string, path: string): Promise<SideRead> {
  const result = await readFileAtRev(repoRoot, rev, path)
  if (result.kind === 'too-large') return { text: null, unreadable: 'too-large' }
  if (result.kind === 'absent') return { text: null, unreadable: null }
  return classify(result.content)
}

async function readSideOnDisk(repoRoot: string, path: string): Promise<SideRead> {
  const absolute = join(repoRoot, path)
  try {
    const info = await stat(absolute)
    if (info.size > MAX_TEXT_BYTES) return { text: null, unreadable: 'too-large' }
    return classify(await readFile(absolute, 'utf8'))
  } catch {
    return { text: null, unreadable: null }
  }
}

/** An untracked file's whole content as one added hunk — git has no diff to give for it. */
export function additionHunk(text: string): DiffHunk[] {
  const lines = text === '' ? [] : text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return []
  return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((line) => `+${line}`) }]
}

async function readHunks(
  repoRoot: string,
  revisions: TourRevisions,
  file: TourChangedFile,
): Promise<{ hunks: DiffHunk[]; binary: boolean } | null> {
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path]
  const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', '-M', revisions.base]
  if (revisions.head !== 'worktree') args.push(revisions.head)
  const result = await runGitCommand(repoRoot, [...args, '--', ...paths])
  if (!result.ok) return null
  const parsed = parseUnifiedDiff(result.stdout)
  const entry = parsed.find((candidate) => candidate.newPath === file.path) ?? parsed[0]
  if (!entry) return { hunks: [], binary: false }
  return { hunks: entry.hunks, binary: entry.binary }
}

/** One file, both sides and its hunks. */
export async function readTourFile(
  repoRoot: string,
  revisions: TourRevisions,
  file: TourChangedFile,
): Promise<TourFileSnapshot> {
  const oldRead: SideRead =
    file.status === 'new'
      ? { text: null, unreadable: null }
      : await readSideAtRev(repoRoot, revisions.base, file.oldPath ?? file.path)
  const newRead: SideRead =
    file.status === 'deleted'
      ? { text: null, unreadable: null }
      : revisions.head === 'worktree'
        ? await readSideOnDisk(repoRoot, file.path)
        : await readSideAtRev(repoRoot, revisions.head, file.path)
  let unreadable = oldRead.unreadable ?? newRead.unreadable
  let hunks: DiffHunk[] = []
  if (!unreadable) {
    const read = await readHunks(repoRoot, revisions, file)
    if (read?.binary) unreadable = 'binary'
    else if (read && read.hunks.length > 0) hunks = read.hunks
    // An untracked file is in no diff git will write against HEAD.
    else if (file.status === 'new' && newRead.text !== null) hunks = additionHunk(newRead.text)
  }
  return {
    path: file.path,
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    status: file.status,
    unreadable,
    oldText: unreadable ? null : oldRead.text,
    newText: unreadable ? null : newRead.text,
    hunks,
  }
}
