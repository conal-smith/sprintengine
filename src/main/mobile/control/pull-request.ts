// The phone's pull request reads (`pullRequest.read`, `pullRequest.diff`): what
// it shows of a pull request, built from the desktop's own GitHub reads and cut
// down to the bounds in `mobilePullRequestLimits`, so nothing the phone asks
// for is ever larger than a screen of it. Read-only: nothing here writes to
// GitHub.

import {
  readPullRequestDiff,
  readPullRequestFiles,
  readPullRequestSummary,
  type PullRequestDiffRead,
  type PullRequestFilesRead,
} from '../../github/pull-request-detail-read'
import { checkKey, type PullRequestWatchRead, type WatchedCheck } from '../../github/pull-request-watch-read'
import type { PullRequestReadFailure } from '../../github/branch-pull-request'
import { MobileControlCommandError } from './command-error'
import {
  mobilePullRequestLimits as LIMITS,
  type MobileControlPullRequestCheck,
  type MobileControlPullRequestDetail,
  type MobileControlPullRequestDiffPage,
  type MobileControlPullRequestRemark,
} from './protocol'

/** Where the reads come from: `gh`, in the app; a fake in the tests. */
export type MobileControlPullRequestReader = {
  summary(url: string): Promise<PullRequestWatchRead>
  files(url: string): Promise<PullRequestFilesRead>
  diff(url: string): Promise<PullRequestDiffRead>
}

export const ghPullRequestReader: MobileControlPullRequestReader = {
  summary: (url) => readPullRequestSummary(url),
  files: (url) => readPullRequestFiles(url),
  diff: (url) => readPullRequestDiff(url),
}

/** A read that could not be made, in words the phone shows as they are. */
function readFailed(reason: PullRequestReadFailure): MobileControlCommandError {
  switch (reason) {
    case 'bad-request':
      return new MobileControlCommandError('invalid_payload', 'That is not a GitHub pull request address.', false)
    case 'gh-missing':
      return new MobileControlCommandError(
        'internal_error',
        "GitHub's command line tool (gh) is not installed on this desktop.",
        false,
      )
    case 'rate-limited':
      return new MobileControlCommandError('internal_error', "GitHub's rate limit is spent for now. Try again later.", true)
    case 'timeout':
      return new MobileControlCommandError('internal_error', 'GitHub did not answer in time.', true)
    case 'bad-output':
      return new MobileControlCommandError('internal_error', 'GitHub answered with something this desktop could not read.', true)
    case 'gh-failed':
      return new MobileControlCommandError(
        'internal_error',
        'This desktop could not read the pull request from GitHub. Check that gh is signed in there.',
        true,
      )
  }
}

export async function readMobilePullRequest(
  url: string,
  reader: MobileControlPullRequestReader = ghPullRequestReader,
): Promise<MobileControlPullRequestDetail> {
  const [summary, files] = await Promise.all([reader.summary(url), reader.files(url)])
  if (!summary.settled) throw readFailed(summary.reason)
  return buildPullRequestDetail(url, summary, files)
}

const CHECK_ORDER: Record<WatchedCheck['status'], number> = { failed: 0, pending: 1, passed: 2 }

/** The detail the phone shows, from the watch's read and the files read. Exported for the test. */
export function buildPullRequestDetail(
  url: string,
  summary: Extract<PullRequestWatchRead, { settled: true }>,
  files: PullRequestFilesRead,
): MobileControlPullRequestDetail {
  const required = new Set(summary.requiredChecks ?? [])
  const checks = { passed: 0, failed: 0, pending: 0 }
  for (const check of summary.checks) checks[check.status]++
  const items: MobileControlPullRequestCheck[] = [...summary.checks]
    .sort((a, b) => CHECK_ORDER[a.status] - CHECK_ORDER[b.status])
    .slice(0, LIMITS.checks)
    .map((check) => ({
      name: check.name,
      workflow: check.workflow,
      status: check.status,
      required: required.has(checkKey(check)),
    }))

  const reviews = { approved: 0, changesRequested: 0, commented: 0 }
  for (const remark of summary.remarks) {
    if (remark.kind !== 'review') continue
    if (remark.verdict === 'approved') reviews.approved++
    else if (remark.verdict === 'changes-requested') reviews.changesRequested++
    else reviews.commented++
  }
  const latest: MobileControlPullRequestRemark[] = [...summary.remarks]
    .sort((a, b) => b.at - a.at)
    .slice(0, LIMITS.remarks)
    .map((remark) => ({
      kind: remark.kind,
      author: remark.author,
      ...(remark.verdict ? { verdict: remark.verdict } : {}),
      excerpt: excerpt(remark.body),
      at: remark.at,
    }))

  return {
    url,
    number: summary.number,
    title: summary.title,
    state: summary.state,
    isDraft: summary.isDraft,
    author: summary.author,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    openedAt: summary.openedAt,
    endedAt: summary.endedAt ?? null,
    mergeable: summary.mergeable,
    checks: { ...checks, items },
    reviewDecision: summary.reviewDecision,
    reviews,
    remarks: { total: summary.remarks.length, latest },
    files: files.settled
      ? {
          total: files.changedFiles,
          additions: files.additions,
          deletions: files.deletions,
          items: files.files.slice(0, LIMITS.files),
        }
      : null,
  }
}

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length > LIMITS.remarkChars ? `${flat.slice(0, LIMITS.remarkChars - 1).trimEnd()}…` : flat
}

export async function readMobilePullRequestDiff(
  url: string,
  path: string,
  offset: number,
  reader: MobileControlPullRequestReader = ghPullRequestReader,
): Promise<MobileControlPullRequestDiffPage> {
  const read = await reader.diff(url)
  if (!read.settled) throw readFailed(read.reason)
  const section = fileDiffSection(read.diff, path)
  if (!section) throw new MobileControlCommandError('invalid_payload', `This pull request does not change ${path}.`, false)
  return pageFileDiff(url, path, section, offset)
}

const FILE_HEADER = /^diff --git a\/(.*) b\/(.*)$/

/**
 * The lines of `path`'s section of a whole pull request's diff, from its
 * `diff --git` line to the next one, or null when the diff has no section for
 * it. A renamed file is found by either name. Exported for the test.
 */
export function fileDiffSection(diff: string, path: string): string[] | null {
  const lines = diff.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const header = FILE_HEADER.exec(lines[i])
    if (!header) continue
    if (start >= 0) return lines.slice(start, i)
    if (header[1] === path || header[2] === path) start = i
  }
  if (start < 0) return null
  const section = lines.slice(start)
  // The diff's own last newline is not a line of the file's.
  if (section.length > 1 && section[section.length - 1] === '') section.pop()
  return section
}

/**
 * One page of a file's section: up to `diffPageLines` lines from `offset`,
 * cut back to the last hunk that starts inside the page when there is one,
 * so a page ends between hunks and the phone can lay each page's hunks out as
 * they come. A single hunk longer than a page is cut where the page ends.
 * Every line is held to `diffLineChars`. Exported for the test.
 */
export function pageFileDiff(
  url: string,
  path: string,
  section: readonly string[],
  offset: number,
): MobileControlPullRequestDiffPage {
  const start = Math.min(Math.max(0, Math.trunc(offset)), section.length)
  let end = Math.min(start + LIMITS.diffPageLines, section.length)
  if (end < section.length && !section[end].startsWith('@@')) {
    for (let i = end - 1; i > start; i--) {
      if (section[i].startsWith('@@')) {
        end = i
        break
      }
    }
  }
  const patch = section
    .slice(start, end)
    .map((line) => (line.length > LIMITS.diffLineChars ? `${line.slice(0, LIMITS.diffLineChars - 1)}…` : line))
    .join('\n')
  return {
    url,
    path,
    patch,
    offset: start,
    nextOffset: end < section.length ? end : null,
    totalLines: section.length,
  }
}
