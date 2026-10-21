// The strip tucked under the composer: where the chat runs and what it has
// changed, on one line, with the context ring pinned to its right. Pure, so
// the regression suite reads the same rules the strip draws by.
//
// The strip is ALWAYS one line: it never wraps at
// any width. Every item keeps its natural width except the branch, the one
// item allowed to shrink, and it shrinks from the front ("fix/cli-update-
// output" → "…cli-update-output") because the end of a branch's name is the
// part that tells two branches apart. When even that is not enough, items
// leave the line in a fixed order for the "⋮" at its end, which lists them,
// each still actionable: the branch, then the diff counts, then the machine,
// which is a glyph alone and costs the line least. The pinned end, the pull
// request and the context ring, is never dropped.
//
// Widths are measured on screen (onLayout); this file only decides.

import type { ChangedTurn, TurnChanges } from "./conversationLogic";

/** The shortest a front-truncated branch may be, its "…" included, before it leaves the line. */
export const MIN_BRANCH_CHARS = 10;
export const ELLIPSIS = "…";

/**
 * The branch as it fits in `maxChars` characters, or null when it cannot keep
 * `minChars` (`MIN_BRANCH_CHARS` on the strip). Whole leading "/" segments go first ("feat/a/b-c" →
 * "…a/b-c" → "…b-c"); only when the last segment alone does not fit is it cut
 * mid-word, keeping its end.
 */
export function frontTruncateBranch(
  branch: string,
  maxChars: number,
  minChars: number = MIN_BRANCH_CHARS,
): string | null {
  if (branch.length <= maxChars) return branch;
  if (maxChars < Math.max(2, minChars)) return null;
  const segments = branch.split("/");
  for (let from = 1; from < segments.length; from += 1) {
    const candidate = ELLIPSIS + segments.slice(from).join("/");
    if (candidate.length <= maxChars) return candidate;
  }
  return ELLIPSIS + branch.slice(-(maxChars - 1));
}

/** An item that keeps its natural width or leaves the line. */
export type StripItemSpec = { kind: "item"; id: string; width: number; drop: number };
/**
 * The branch: monospace text that may shrink from the front. `chromeWidth` is
 * everything about the item that is not its text (padding, a worktree mark).
 */
export type StripBranchSpec = {
  kind: "branch";
  id: string;
  text: string;
  /** One character's advance in the branch's monospace face. */
  charWidth: number;
  chromeWidth: number;
  drop: number;
};
export type StripEntrySpec = StripItemSpec | StripBranchSpec;

export type StripLayout = {
  /** The ids on the line, in the order given. */
  visible: string[];
  /** The ids in the "⋮", in the order given. */
  hidden: string[];
  /** What the branch reads on the line: whole, front-truncated, or null when it is hidden or absent. */
  branchLabel: string | null;
  /** Whether the "⋮" is drawn: only when something is hidden. */
  overflow: boolean;
};

/**
 * Which items stay on the line at `width`, and what the branch reads.
 *
 * Items leave in ascending `drop` order. A step that leaves anything hidden
 * pays for the "⋮" too. The pinned ring (`pinnedWidth`, 0 for none) is never
 * dropped; at a width too narrow even for it alone, everything else is hidden
 * and the line is left to clip, which no phone reaches.
 */
export function layoutComposerStrip(input: {
  width: number;
  gap: number;
  entries: readonly StripEntrySpec[];
  pinnedWidth: number;
  overflowWidth: number;
}): StripLayout {
  const { width, gap, entries, pinnedWidth, overflowWidth } = input;
  const order = [...entries].sort((a, b) => a.drop - b.drop);
  for (let dropped = 0; dropped <= order.length; dropped += 1) {
    const gone = new Set(order.slice(0, dropped).map((entry) => entry.id));
    const shown = entries.filter((entry) => !gone.has(entry.id));
    const overflow = gone.size > 0;
    const slots = shown.length + (overflow ? 1 : 0) + (pinnedWidth > 0 ? 1 : 0);
    const fixed =
      shown.reduce((total, entry) => total + (entry.kind === "item" ? entry.width : entry.chromeWidth), 0) +
      (overflow ? overflowWidth : 0) +
      pinnedWidth +
      Math.max(0, slots - 1) * gap;
    const branch = shown.find((entry): entry is StripBranchSpec => entry.kind === "branch");
    let branchLabel: string | null = null;
    if (branch) {
      const room = width - fixed;
      const chars = branch.charWidth > 0 ? Math.floor(room / branch.charWidth + 1e-6) : 0;
      branchLabel = room > 0 ? frontTruncateBranch(branch.text, chars) : null;
      if (branchLabel === null) continue;
    } else if (fixed > width) continue;
    return {
      visible: shown.map((entry) => entry.id),
      hidden: entries.filter((entry) => gone.has(entry.id)).map((entry) => entry.id),
      branchLabel,
      overflow,
    };
  }
  return { visible: [], hidden: entries.map((entry) => entry.id), branchLabel: null, overflow: entries.length > 0 };
}

/**
 * The order items leave the line in: lowest first. New's Worktree is a choice
 * rather than a fact, and leaves last; the "⋮" still toggles it. The ring
 * and the pull request are not listed: they are the line's pinned end and
 * never leave.
 */
export const STRIP_DROP_ORDER = { branch: 1, diff: 2, machine: 3, worktree: 4 } as const;

/** What the chat's turns changed, added up for the strip. */
export type ConversationChanges = {
  files: number;
  /** Lines in and out, summed over the turns that counted them; null when none did. */
  addedLines: number | null;
  removedLines: number | null;
  /** The turns whose files can be opened (the desktop kept a checkpoint), newest first. */
  openable: (ChangedTurn & { turnSeq: number })[];
};

/**
 * The chat's changes as the strip counts them: every turn's, added up. A file
 * two turns touched counts in both, and a line rewritten twice is two lines in
 * and out: it is the agent's work, not the net diff. Null when no turn
 * changed anything.
 */
export function conversationChanges(turns: readonly ChangedTurn[]): ConversationChanges | null {
  const changed = turns.filter((turn) => (turn.changes?.files ?? 0) > 0 || turn.turnSeq !== undefined);
  if (!changed.length) return null;
  const counted = changed.map((turn) => turn.changes).filter((changes): changes is TurnChanges => !!changes);
  const lined = counted.filter((changes) => changes.addedLines !== undefined && changes.removedLines !== undefined);
  const files = counted.reduce((total, changes) => total + changes.files, 0);
  const openable = changed
    .filter((turn): turn is ChangedTurn & { turnSeq: number } => turn.turnSeq !== undefined)
    .reverse();
  if (!files && !lined.length && !openable.length) return null;
  return {
    files,
    addedLines: lined.length ? lined.reduce((total, changes) => total + (changes.addedLines ?? 0), 0) : null,
    removedLines: lined.length ? lined.reduce((total, changes) => total + (changes.removedLines ?? 0), 0) : null,
    openable,
  };
}

/**
 * The strip's diff counts as a split pill (Claude
 * Code's): a green half "+N" and a red half "−M", one pill with no gap. A
 * half with nothing to say is not drawn, never "+0" or "−0"; with both at 0
 * there is no pill. Where no turn counted its lines the pill is one neutral
 * half naming the files, so changes that can be opened are not hidden for
 * want of a count.
 */
export type DiffPill =
  | { kind: "lines"; added: number | null; removed: number | null; label: string }
  | { kind: "files"; files: number; label: string };

export function diffPill(changes: ConversationChanges | null): DiffPill | null {
  if (!changes) return null;
  if (changes.addedLines !== null && changes.removedLines !== null) {
    const added = changes.addedLines > 0 ? changes.addedLines : null;
    const removed = changes.removedLines > 0 ? changes.removedLines : null;
    if (added === null && removed === null) return null;
    return { kind: "lines", added, removed, label: diffPillLabel(changes.addedLines, changes.removedLines) };
  }
  if (changes.files <= 0) return null;
  const files = `${changes.files} ${changes.files === 1 ? "file" : "files"}`;
  return { kind: "files", files: changes.files, label: `${files} changed` };
}

/** "3 lines added, 2 removed": what a screen reader says for the pill. */
export function diffPillLabel(added: number, removed: number): string {
  return `${added} ${added === 1 ? "line" : "lines"} added, ${removed} removed`;
}
