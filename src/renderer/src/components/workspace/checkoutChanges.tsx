import React from 'react'

import type { ChangedFileCounts, WorkspaceChangeSummary } from '../../../../shared/electron-api'
import type { BranchPullRequest } from '../../../../shared/git/pull-request'
import { changedFileMarks, lineDiffOf } from './terminalLines'
import { useSidebarGitSummaries } from './useSidebarGitSummaries'
import { formatDiffCount } from '../../utils/diffCount'

// How many files a checkout carries, as "+N −M": the reading the title bar's
// branch chip used to be the only one to show, and which an open conversation's
// composer strip now shows for the checkout its agent works in. One hook and one
// badge, so the two places that say it cannot disagree about what it is.

/**
 * The change summary for one checkout — the SAME read the sidebar's lines take
 * (`getWorkspaceChangeSummary`, through `useSidebarGitSummaries`: one sweep on
 * mount, every refresh interval, and when the window becomes visible; main
 * dedupes the read per checkout), so a chip and the line for an agent on that
 * checkout cannot disagree. Everything unreadable is `undefined`, and
 * `lineDiffOf` turns that into a badge that draws nothing — never into a
 * confident zero.
 *
 * `id` keys the reading inside this hook's own poll; each reader names its own.
 */
export function useCheckoutChangeSummary(checkoutPath: string | null, id: string): WorkspaceChangeSummary | undefined {
  const entries = React.useMemo(() => (checkoutPath ? [{ id, checkoutPath }] : []), [checkoutPath, id])
  const summaries = useSidebarGitSummaries(entries)
  return checkoutPath ? summaries[id] : undefined
}

export type CheckoutChanges = {
  /** The breakdown by kind, or null where git could not say (never a confident zero). */
  files: ChangedFileCounts | null
  /** "+plus −minus": files added or updated, and files removed. Null with no breakdown. */
  marks: { plus: number; minus: number } | null
  /** Whether there is anything to show: a clean checkout draws no badge. */
  hasCounts: boolean
}

/**
 * The checkout's changes as the badge draws them. Owner, 2026-09-09: they are
 * FILES — "+5 −2" is five files added or updated and two removed — because
 * that is the question the summary level answers; the per-file line counts live
 * where a single file is in view. `pullRequests` are the ones the agent's
 * terminals carry, so a squash-merged branch shows what the checkout still
 * carries rather than the whole span again.
 */
export function useCheckoutChanges(
  checkoutPath: string | null,
  pullRequests: ReadonlyArray<BranchPullRequest>,
  id: string,
): CheckoutChanges {
  const summary = useCheckoutChangeSummary(checkoutPath, id)
  return checkoutChangesOf(summary, pullRequests)
}

/** `useCheckoutChanges` without the read, for a caller that already holds the summary. */
export function checkoutChangesOf(
  summary: WorkspaceChangeSummary | undefined,
  pullRequests: ReadonlyArray<BranchPullRequest>,
): CheckoutChanges {
  const diff = lineDiffOf(summary, pullRequests)
  // Absent counts draw NOTHING (a main that predates the breakdown, a span git
  // could not read): the numbers here mean files, and falling back to the line
  // counts would be a different unit wearing the same clothes.
  const marks = diff.files ? changedFileMarks(diff.files) : null
  return { files: diff.files, marks, hasCounts: marks !== null && (marks.plus > 0 || marks.minus > 0) }
}

/**
 * "+N −M" in the good and error inks, decorative: the control that wears it
 * says the counts in words (`changedFilesPhrase`) for assistive technology.
 */
export function ChangeCountBadge({
  marks,
  className = '',
}: {
  marks: { plus: number; minus: number }
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={`shrink-0 whitespace-nowrap font-mono text-micro font-semibold leading-none tabular-nums ${className}`}
    >
      <span className="text-[color:var(--tone-good)]">+{formatDiffCount(marks.plus)}</span>
      <span className="ml-1 text-[color:var(--tone-error)]">−{formatDiffCount(marks.minus)}</span>
    </span>
  )
}
