// A turn's changes, as the phone reads them: the file list the desktop sends
// for a checkpointed turn, and one file's `git diff` turned into rows to draw.
//
// `parseUnifiedDiff` and its two types MIRROR the desktop's
// src/shared/git/hunks.ts (the parser only; its staging, fingerprint and
// inclusion vocabulary has no use here). The desktop builds the patch this
// reads, so the phone reads it with the same rules rather than a second
// opinion about what a diff line is: split on `\n` only, so a CRLF line keeps
// its `\r`; a `\` line is the no-newline marker and stays with its hunk; a
// line it cannot place is header, never a throw. Keep the two in step: a
// change there is a change here.
//
// Everything below the mirror is the phone's own and stays pure, so the
// regression suite runs it on bare Node.

/* ------------------------------------------------------------------ *
 * The mirror
 * ------------------------------------------------------------------ */

/** One `@@ … @@` block of a diff. */
export type DiffHunk = {
  /** First line of the range on the OLD side (1-based; 0 for an empty range). */
  oldStart: number;
  oldLines: number;
  /** First line of the range on the NEW side (1-based; 0 for an empty range). */
  newStart: number;
  newLines: number;
  /**
   * The hunk's body exactly as git wrote it: `+`, `-` and context lines, and any
   * `\ No newline at end of file` markers. Never re-wrapped, never trimmed.
   */
  lines: string[];
};

/** One file's entry in a diff: everything before the first `@@`, then the hunks. */
export type ParsedFileDiff = {
  /** `diff --git …` and every header line after it, verbatim. */
  header: string[];
  /** From the `--- ` line; null for `/dev/null` (the file is being created). */
  oldPath: string | null;
  /** From the `+++ ` line; null for `/dev/null` (the file is being deleted). */
  newPath: string | null;
  /** git said "Binary files … differ" or emitted a binary patch. No hunks. */
  binary: boolean;
  hunks: DiffHunk[];
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function pathFromMarker(line: string, marker: string): string | null {
  const value = line.slice(marker.length).trim();
  if (value === "/dev/null") return null;
  return value.replace(/^[ab]\//, "");
}

/** Read `git diff` output into files and hunks. Forgiving: what it cannot place is header. */
export function parseUnifiedDiff(text: string): ParsedFileDiff[] {
  const files: ParsedFileDiff[] = [];
  if (!text) return files;

  // `\n` only, so a CRLF line keeps its `\r`.
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let file: ParsedFileDiff | null = null;
  let hunk: DiffHunk | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      file = { header: [line], oldPath: null, newPath: null, binary: false, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    const match = HUNK_HEADER.exec(line);
    if (match) {
      hunk = {
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }

    if (hunk) {
      if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line.startsWith("\\")) {
        hunk.lines.push(line);
        continue;
      }
      hunk = null;
    }

    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      file.binary = true;
      continue;
    }
    if (file.hunks.length > 0) continue;
    if (line.startsWith("--- ")) file.oldPath = pathFromMarker(line, "--- ");
    if (line.startsWith("+++ ")) file.newPath = pathFromMarker(line, "+++ ");
    file.header.push(line);
  }

  return files;
}

/** `@@ -3,2 +3,0 @@`: git's own spelling, `,1` omitted exactly as git omits it. */
export function formatHunkHeader(hunk: DiffHunk): string {
  const range = (start: number, count: number): string => (count === 1 ? `${start}` : `${start},${count}`);
  return `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`;
}

/* ------------------------------------------------------------------ *
 * What the phone draws
 * ------------------------------------------------------------------ */

/**
 * The text git writes after a hunk's `@@ … @@` (the enclosing function or
 * heading), per file and per hunk in the order `parseUnifiedDiff` returns them.
 *
 * The mirror drops that text: staging never needed it. The phone's hunk
 * separator is the one place that does, so it is read here, beside the mirror
 * rather than inside it. The walk uses the parser's own boundaries (a file
 * starts at `diff --git `, every `@@` line after that is a hunk; a body line
 * always starts with `+`, `-`, a space or `\`, so it can never be taken for
 * one), which is what keeps the two in the same order.
 */
export function hunkSections(text: string): string[][] {
  const files: string[][] = [];
  if (!text) return files;
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = [];
      files.push(current);
      continue;
    }
    if (!current) continue;
    const match = HUNK_HEADER.exec(line);
    if (match) current.push(line.slice(match[0].length).trim());
  }
  return files;
}

export type DiffLineKind = "add" | "del" | "ctx" | "note";
export type DiffDisplayRow =
  | {
      kind: "hunk";
      /** The `@@ … @@` range, as git spells it. */
      header: string;
      /** The enclosing function or heading git wrote after it; "" when none was given. */
      context: string;
      oldStart: number;
      newStart: number;
    }
  | {
      kind: DiffLineKind;
      /** The line's number in the file before the turn; null for an added line or a note. */
      oldNo: number | null;
      /** The line's number in the file after the turn; null for a removed line or a note. */
      newNo: number | null;
      /** The line without its `+`/`-`/space; a note without its `\ `. A CRLF line keeps its `\r`. */
      text: string;
    };

/**
 * A file's hunks as rows to draw: a separator per hunk, then each line with its
 * number on each side. A removed line advances only the old count, an added one
 * only the new, a context line both; the no-newline marker advances neither.
 * `sections` is `hunkSections(patch)[i]` for this file, when there is one.
 */
export function diffDisplayRows(file: ParsedFileDiff, sections: readonly string[] = []): DiffDisplayRow[] {
  const rows: DiffDisplayRow[] = [];
  file.hunks.forEach((hunk, index) => {
    rows.push({
      kind: "hunk",
      header: formatHunkHeader(hunk),
      context: sections[index] ?? "",
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
    });
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    for (const line of hunk.lines) {
      const text = line.slice(1);
      if (line.startsWith("+")) rows.push({ kind: "add", oldNo: null, newNo: newNo++, text });
      else if (line.startsWith("-")) rows.push({ kind: "del", oldNo: oldNo++, newNo: null, text });
      else if (line.startsWith("\\")) rows.push({ kind: "note", oldNo: null, newNo: null, text: text.trim() });
      else rows.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text });
    }
  });
  return rows;
}

/**
 * A code line as the screen sets it: the `\r` a CRLF file carries dropped (the
 * rows keep it; a `Text` would draw it as a break or a box), and tabs expanded
 * to stops of `tabSize`, because React Native's tab width differs by platform
 * and a monospace column only lines up if every character is one cell wide.
 */
export function displayText(text: string, tabSize = 4): string {
  const line = text.endsWith("\r") ? text.slice(0, -1) : text;
  if (!line.includes("\t")) return line;
  let out = "";
  for (const char of line) {
    if (char === "\t") out += " ".repeat(tabSize - (out.length % tabSize));
    else out += char;
  }
  return out;
}

/** The widest line number among the rows, in digits: the gutter's column width. */
export function gutterDigits(rows: readonly DiffDisplayRow[]): number {
  let widest = 1;
  for (const row of rows) {
    const value = row.kind === "hunk" ? 0 : Math.max(row.oldNo ?? 0, row.newNo ?? 0);
    widest = Math.max(widest, String(value).length);
  }
  return widest;
}

/* ------------------------------------------------------------------ *
 * The turn's file list, as the desktop sends it
 * ------------------------------------------------------------------ */

/** The desktop's `ConversationCheckpointFile` (src/shared/conversation-runtime.ts). */
export type ChangedFile = {
  path: string;
  status: "added" | "modified" | "deleted";
  addedLines: number;
  removedLines: number;
  binary: boolean;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const STATUSES = new Set<ChangedFile["status"]>(["added", "modified", "deleted"]);

/**
 * A `getTurnDiff` answer, read field by field: its files, and the patch when one
 * path was asked for. A refusal throws its own message, so a caller's catch
 * shows the desktop's words. An entry without a path is dropped; an unknown
 * status reads as modified, as the desktop itself falls back.
 */
export function readTurnDiff(value: unknown): { files: ChangedFile[]; patch: string | null } {
  const answer = record(value);
  const diff = record(answer.diff);
  if (answer.ok !== true || !Array.isArray(diff.files)) {
    const message = typeof answer.message === "string" ? answer.message.trim() : "";
    throw new Error(message || "The desktop could not read this turn's changes.");
  }
  const files: ChangedFile[] = [];
  for (const entry of diff.files.map(record)) {
    if (typeof entry.path !== "string" || !entry.path) continue;
    files.push({
      path: entry.path,
      status: STATUSES.has(entry.status as ChangedFile["status"]) ? (entry.status as ChangedFile["status"]) : "modified",
      addedLines: count(entry.addedLines),
      removedLines: count(entry.removedLines),
      binary: entry.binary === true,
    });
  }
  return { files, patch: typeof answer.patch === "string" ? answer.patch : null };
}

/** `src/a/b.ts` → `{ dir: "src/a", name: "b.ts" }`; a top-level file has no dir. */
export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? { dir: "", name: path } : { dir: path.slice(0, cut), name: path.slice(cut + 1) };
}

/** Files, lines added and lines removed across a turn. */
export function diffTotals(files: readonly Pick<ChangedFile, "addedLines" | "removedLines">[]) {
  return files.reduce(
    (total, file) => ({
      files: total.files + 1,
      added: total.added + file.addedLines,
      removed: total.removed + file.removedLines,
    }),
    { files: 0, added: 0, removed: 0 },
  );
}
