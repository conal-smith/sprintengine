import type { PullRequestDetail, PullRequestDiffPage } from "../../api/pullRequests";

// What the pull request viewer says, as words: the state, the checks, the
// reviews and comments. Kept free of React Native so the regression suite
// reads the same sentences the screen draws.

export type PullRequestTone = "toneGood" | "toneError" | "toneWarn" | "toneMerged" | "textMuted";

/** "Open", "Draft", "Merged", "Closed", with the tone the chat's mark draws it in. */
export function pullRequestStateWords(detail: Pick<PullRequestDetail, "state" | "isDraft">): {
  text: string;
  tone: PullRequestTone;
} {
  if (detail.state === "merged") return { text: "Merged", tone: "toneMerged" };
  if (detail.state === "closed") return { text: "Closed", tone: "toneError" };
  return detail.isDraft ? { text: "Draft", tone: "textMuted" } : { text: "Open", tone: "toneGood" };
}

/** The checks in one line: "2 failing, 1 running, 12 passed", or "No checks". */
export function checksSummaryWords(checks: PullRequestDetail["checks"]): {
  text: string;
  tone: "good" | "warn" | "danger" | "neutral";
} {
  const total = checks.passed + checks.failed + checks.pending;
  if (total === 0) return { text: "No checks", tone: "neutral" };
  const parts = [
    checks.failed ? `${checks.failed} failing` : null,
    checks.pending ? `${checks.pending} running` : null,
    checks.passed ? `${checks.passed} passed` : null,
  ].filter(Boolean);
  const tone = checks.failed ? "danger" : checks.pending ? "warn" : "good";
  return { text: checks.failed || checks.pending ? parts.join(", ") : `All ${total} passed`, tone };
}

/** The review state in one line: GitHub's decision, then the counts behind it. */
export function reviewSummaryWords(detail: Pick<PullRequestDetail, "reviewDecision" | "reviews">): string {
  const decision =
    detail.reviewDecision === "approved"
      ? "Approved"
      : detail.reviewDecision === "changes-requested"
        ? "Changes requested"
        : detail.reviewDecision === "review-required"
          ? "Review required"
          : null;
  const { approved, changesRequested, commented } = detail.reviews;
  const counts = [
    approved ? `${approved} ${approved === 1 ? "approval" : "approvals"}` : null,
    changesRequested ? `${changesRequested} asking for changes` : null,
    commented ? `${commented} commented` : null,
  ].filter(Boolean);
  if (!decision && !counts.length) return "No reviews yet";
  return [decision, counts.join(", ")].filter(Boolean).join(" · ");
}

/** "3 comments and reviews", "1 comment or review", "No comments yet". */
export function remarksSummaryWords(remarks: PullRequestDetail["remarks"]): string {
  if (remarks.total === 0) return "No comments yet";
  return remarks.total === 1 ? "1 comment or review" : `${remarks.total} comments and reviews`;
}

/** The base and head as the header's subtitle: "main ← feature". */
export function branchWords(detail: Pick<PullRequestDetail, "baseRefName" | "headRefName">): string | null {
  if (!detail.baseRefName || !detail.headRefName) return null;
  return `${detail.baseRefName} ← ${detail.headRefName}`;
}

/** A changed file's change as the changes list's tile draws it: added, deleted, or modified (a rename too). */
export function fileChangeStatus(change: string | null): "added" | "modified" | "deleted" {
  return change === "added" ? "added" : change === "deleted" || change === "removed" ? "deleted" : "modified";
}

/** How many files the list does not show: GitHub's count beyond the ones the desktop sent. */
export function filesNotListed(files: NonNullable<PullRequestDetail["files"]>): number {
  return Math.max(0, files.total - files.items.length);
}

/** A file's diff as read so far: whether more is left, and how much of it has been read. */
export function diffProgress(pages: readonly PullRequestDiffPage[]): { more: boolean; read: number; total: number } {
  const last = pages[pages.length - 1];
  if (!last) return { more: false, read: 0, total: 0 };
  return { more: last.nextOffset !== null, read: last.nextOffset ?? last.totalLines, total: last.totalLines };
}
