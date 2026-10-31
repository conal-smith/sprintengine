// A pull request as a person looking at it from the phone reads it: what the
// watch reads (`pull-request-watch-read.ts`: its state, checks, reviews and
// comments), the files it changes, and one file's diff. Thin on purpose: the
// state, checks and remarks are the watch's own read, so the phone and the
// watch never disagree about a pull request; this adds the two `gh` calls the
// watch does not make.
//
// - `gh pr view <url> --json files,additions,deletions,changedFiles`: the
//   changed files with their line counts. gh lists at most the first hundred
//   files; `changedFiles` says how many there are.
// - `gh pr diff <url> --color never`: the whole diff, as text. The caller
//   cuts one file's section out of it and pages that (`mobile/control/pull-request.ts`).

import { canonicalPullRequestUrl, parsePullRequestUrl } from '../../shared/git/pr-url'
import { isRecord } from '../../shared/records'
import {
  parseJsonDocument,
  runGh,
  type BranchPullRequestDeps,
  type PullRequestReadFailure,
} from './branch-pull-request'
import { readPullRequestWatch, type PullRequestWatchRead } from './pull-request-watch-read'

const FILES_FIELDS = 'files,additions,deletions,changedFiles'

export type PullRequestChangedFile = {
  path: string
  additions: number
  deletions: number
  /** GitHub's word for the change (`ADDED`, `MODIFIED`, `DELETED`, `RENAMED`, …), lower-cased; null when gh did not say. */
  change: string | null
}

export type PullRequestFilesRead =
  | { settled: true; files: PullRequestChangedFile[]; additions: number; deletions: number; changedFiles: number }
  | { settled: false; reason: PullRequestReadFailure }

export type PullRequestDiffRead = { settled: true; diff: string } | { settled: false; reason: PullRequestReadFailure }

/** The pull request named by `url`, as gh can be asked about it, or null when it names none. */
function targetOf(url: string): string | null {
  const parsed = parsePullRequestUrl(url?.trim() ?? '')
  if (!parsed || 'unsupported' in parsed) return null
  return canonicalPullRequestUrl(parsed)
}

/** The watch's read of the pull request: state, checks, reviews and comments. */
export function readPullRequestSummary(url: string, deps: BranchPullRequestDeps = {}): Promise<PullRequestWatchRead> {
  return readPullRequestWatch(url, deps)
}

export async function readPullRequestFiles(
  url: string,
  deps: BranchPullRequestDeps = {},
): Promise<PullRequestFilesRead> {
  const target = targetOf(url)
  if (!target) return { settled: false, reason: 'bad-request' }
  const viewed = await runGh(['pr', 'view', target, '--json', FILES_FIELDS], {}, deps)
  if (!viewed.ok) return { settled: false, reason: viewed.reason }
  const json = parseJsonDocument(viewed.stdout)
  if (!isRecord(json)) return { settled: false, reason: 'bad-output' }
  return parseFilesView(json)
}

export async function readPullRequestDiff(url: string, deps: BranchPullRequestDeps = {}): Promise<PullRequestDiffRead> {
  const target = targetOf(url)
  if (!target) return { settled: false, reason: 'bad-request' }
  const diffed = await runGh(['pr', 'diff', target, '--color', 'never'], {}, deps)
  if (!diffed.ok) return { settled: false, reason: diffed.reason }
  return { settled: true, diff: diffed.stdout }
}

/** `gh pr view --json files,…` → the files read. Exported for the test. */
export function parseFilesView(json: Record<string, unknown>): PullRequestFilesRead {
  const files: PullRequestChangedFile[] = []
  for (const row of Array.isArray(json.files) ? json.files : []) {
    if (!isRecord(row) || typeof row.path !== 'string' || !row.path) continue
    files.push({
      path: row.path,
      additions: count(row.additions),
      deletions: count(row.deletions),
      change: typeof row.changeType === 'string' && row.changeType ? row.changeType.toLowerCase() : null,
    })
  }
  return {
    settled: true,
    files,
    additions: count(json.additions),
    deletions: count(json.deletions),
    changedFiles: Math.max(count(json.changedFiles), files.length),
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}
