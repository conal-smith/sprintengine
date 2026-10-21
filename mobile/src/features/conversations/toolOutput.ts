import { presentToolItem, type PresentableTool } from "../../api/conversation-protocol/presentation";
import type { ConversationToolKind } from "../../api/conversation-protocol/tool-types";
import { formatHunkHeader, parseUnifiedDiff } from "../diff/unifiedDiff";

// What an opened tool step shows: the step's output read the way its kind
// reads, as the desktop's tool rows read it (ToolRow.tsx), rather than the
// desktop's detail record pretty-printed as JSON. A command is its command
// line, what it printed as terminal text with its colours and its exit
// status; a read is the file's path and its text; an edit is the change as
// a diff; a search or a listing is its pattern and the lines it found; a
// fetch its address and the text it brought back. Anything else keeps a
// compact JSON of what it was called with, then its output.
//
// All of it is pure so the regression suite runs it on bare Node, and all of
// it is bounded: a detail can be megabytes (the desktop keeps up to 5 MB of
// output per step), and a `Text` holding a megabyte stalls the JS thread and
// the layout for seconds. So only a slice is ever drawn (`clipLines`), each
// line is cut at `MAX_LINE_CHARS`, and terminal escapes are read only in the
// slice drawn, with the colour in force where it starts carried in.

/** The desktop's `ConversationToolDetail` as `getToolDetail` answers it, read defensively. */
export type ToolDetail = {
  input: unknown;
  /** The output as text: a string as sent, content blocks joined, anything else as JSON. */
  output: string;
  status?: "ok" | "error" | "declined" | "stopped";
  exitCode?: number;
  /** The desktop clipped the output to keep the detail under its limit. */
  clipped: boolean;
  totalBytes?: number;
};

/** The step as the transcript knows it: enough to draw it before, or without, its detail. */
export type ToolSummary = PresentableTool & { output?: string };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const read = (input: Record<string, unknown>, ...keys: string[]): string => {
  for (const key of keys) if (typeof input[key] === "string" && input[key]) return input[key] as string;
  return "";
};

/**
 * A step's output as text. Most CLIs record a string; Claude Code's results
 * can be content blocks (`[{ type: "text", text }]`), joined here a block a
 * paragraph; a `{ stdout, stderr }` reads as the terminal would show it.
 * Anything else is its JSON, indented, so it at least reads as data.
 */
export function outputText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((block) => typeof record(block).text === "string"))
    return value.map((block) => record(block).text as string).join("\n");
  const fields = record(value);
  if (typeof fields.stdout === "string" || typeof fields.stderr === "string")
    return [text(fields.stdout), text(fields.stderr)].filter(Boolean).join("\n");
  if (typeof fields.content === "string") return fields.content;
  if (Array.isArray(fields.content)) return outputText(fields.content);
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "";
  }
}

const STATUSES = new Set(["ok", "error", "declined", "stopped"]);

/** `getToolDetail`'s answer as a detail, or null when it is not one. */
export function readToolDetail(answer: unknown): ToolDetail | null {
  const result = record(answer);
  if (result.ok !== true) return null;
  const detail = record(result.detail);
  if (!("input" in detail) && !("output" in detail)) return null;
  return {
    input: detail.input,
    output: outputText(detail.output),
    ...(STATUSES.has(String(detail.status)) ? { status: detail.status as ToolDetail["status"] } : {}),
    ...(Number.isSafeInteger(detail.exitCode) ? { exitCode: detail.exitCode as number } : {}),
    clipped: detail.clipped === true,
    ...(Number.isSafeInteger(detail.totalBytes) && Number(detail.totalBytes) >= 0
      ? { totalBytes: detail.totalBytes as number }
      : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Terminal text
 * ------------------------------------------------------------------ */

/** The colours a terminal's sixteen fall into, each drawn in a theme tone. */
export type AnsiTone = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "muted";
export type OutputSpan = { text: string; tone?: AnsiTone; bold?: boolean };
export type OutputLine = OutputSpan[];
type Style = { tone?: AnsiTone; bold?: boolean };

// Index 0 is black and 7 white: neither reads on both themes, so black is
// drawn muted and white in the ordinary ink.
const PALETTE: (AnsiTone | undefined)[] = [
  "muted", "red", "green", "yellow", "blue", "magenta", "cyan", undefined,
  "muted", "red", "green", "yellow", "blue", "magenta", "cyan", undefined,
];

// Every escape a command's output carries: a CSI (colours, cursor moves,
// erasing, and the private and intermediate forms such as `ESC[>0c` and
// `ESC[2 q`), an OSC (titles, hyperlinks) ended by BEL or ST, a two-character
// escape, or a stray ESC left over. Only colours are kept; the rest is
// dropped. An OSC never runs past its line: one left unterminated (a
// hyperlink whose end a cut line lost) must not swallow the lines after it.
const ESCAPE_SOURCE =
  "\\u001b\\[([0-?]*)[ -/]*([@-~])|\\u001b\\][^\\u0007\\u001b\\r\\n]*(?:\\u0007|\\u001b\\\\)?|\\u001b[@-~]|\\u001b";
const ESCAPE = new RegExp(ESCAPE_SOURCE, "gu");
const ESCAPE_OR_BREAK = new RegExp(`${ESCAPE_SOURCE}|\\r\\n|\\r|\\n`, "gu");
// What a cut can leave at a line's end: an escape begun and not finished.
const PARTIAL_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b\r\n]*)?$/u;
// A colour (SGR) is a CSI ending in `m` whose parameters are numbers,
// separated by `;` or, as some programs write 256 and true colour, `:`.
const SGR_PARAMS = /^[0-9;:]*$/u;

/** Output with every terminal escape removed: what Copy puts on the clipboard. */
export function stripAnsi(output: string): string {
  return output.includes("\u001b") ? output.replace(ESCAPE, "") : output;
}

function applySgr(style: Style, params: string): Style {
  if (!SGR_PARAMS.test(params)) return style;
  const values = params === "" ? [0] : params.split(/[;:]/u).map((value) => (value === "" ? 0 : Number(value)));
  let next: Style = { ...style };
  for (let index = 0; index < values.length; index++) {
    const code = values[index];
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.tone = "muted";
    else if (code === 22) delete next.bold;
    else if (code === 39) delete next.tone;
    else if (code >= 30 && code <= 37) next.tone = PALETTE[code - 30];
    else if (code >= 90 && code <= 97) next.tone = PALETTE[code - 90 + 8];
    else if (code === 38 || code === 48) {
      // 256 colours name the first sixteen by index; past them, and true
      // colour, there is no theme tone to give, so the ink stays as it was.
      if (values[index + 1] === 5) {
        if (code === 38) {
          const tone = values[index + 2];
          if (Number.isInteger(tone) && tone >= 0 && tone < 16) next.tone = PALETTE[tone];
        }
        index += 2;
      } else if (values[index + 1] === 2) index += 4;
    }
    if (next.tone === undefined) delete next.tone;
  }
  return next;
}

/**
 * The colour in force at `end` in `text` (its end by default): read from the
 * last reset before it, so the slice of a long log drawn from there starts in
 * the colour it was in, without reading the megabytes before the reset.
 */
export function styleAt(text: string, end = text.length): Style {
  if (end <= 0) return {};
  const reset = Math.max(text.lastIndexOf("\u001b[0m", end - 1), text.lastIndexOf("\u001b[m", end - 1));
  const from = reset === -1 ? 0 : reset;
  const escape = text.indexOf("\u001b[", from);
  if (escape === -1 || escape >= end) return {};
  let style: Style = {};
  for (const match of text.slice(from, end).matchAll(/\u001b\[([0-9;:]*)m/gu)) style = applySgr(style, match[1]);
  return style;
}

/**
 * Terminal output as lines of coloured runs. Colours and bold are kept;
 * cursor moves, erasing and titles are dropped. A carriage return that is
 * not part of a line break starts its line again, as a progress bar redraws
 * itself, so a download's hundred updates read as the last one.
 */
export function ansiLines(output: string, start: Style = {}): OutputLine[] {
  const lines: OutputLine[] = [[]];
  let style: Style = { ...start };
  let at = 0;
  const push = (run: string) => {
    if (!run) return;
    const line = lines[lines.length - 1];
    const last = line[line.length - 1];
    if (last && last.tone === style.tone && last.bold === style.bold) last.text += run;
    else line.push({ text: run, ...(style.tone ? { tone: style.tone } : {}), ...(style.bold ? { bold: true } : {}) });
  };
  if (!output.includes("\u001b") && !output.includes("\r"))
    return output.split("\n").map((line) => (line ? [{ text: line, ...style }] : []));
  for (const match of output.matchAll(ESCAPE_OR_BREAK)) {
    push(output.slice(at, match.index));
    at = match.index + match[0].length;
    const token = match[0];
    if (token === "\n" || token === "\r\n") lines.push([]);
    else if (token === "\r") lines[lines.length - 1] = [];
    else if (match[2] === "m") style = applySgr(style, match[1] ?? "");
  }
  push(output.slice(at));
  return lines;
}

/* ------------------------------------------------------------------ *
 * Long output
 * ------------------------------------------------------------------ */

/** How many lines a closed step's output shows: enough to see how it ended. */
export const PREVIEW_LINES = 14;
/** How many lines "Show all" draws at most; Copy always has every one. */
export const EXPANDED_LINES = 600;
/** A line longer than this is cut: minified code or a base64 blob is one line. */
export const MAX_LINE_CHARS = 1_200;

export type ClippedText = {
  /** The text to draw: whole lines, each cut at `MAX_LINE_CHARS`. */
  text: string;
  /** Lines in the whole output. */
  total: number;
  /** Lines not drawn. */
  hidden: number;
  /** Where the drawn lines start in the output, in characters: what came before sets their colour. */
  offset: number;
};

/**
 * The slice of a long output to draw: its last `limit` lines for a command,
 * whose end is how it went, and its first for anything else, which reads
 * from the top. A trailing line break ends the last line rather than opening
 * an empty one. Splits once; nothing past the slice is copied or measured.
 */
export function clipLines(output: string, mode: "head" | "tail", limit: number): ClippedText {
  const body = output.endsWith("\n") ? output.slice(0, -1) : output;
  if (!body) return { text: "", total: 0, hidden: 0, offset: 0 };
  const lines = body.split("\n");
  const total = lines.length;
  const shown = total <= limit ? lines : mode === "tail" ? lines.slice(total - limit) : lines.slice(0, limit);
  let offset = 0;
  if (mode === "tail" && shown.length < total)
    for (let index = 0; index < total - shown.length; index++) offset += lines[index].length + 1;
  const cut = shown.map((line) =>
    line.length > MAX_LINE_CHARS
      ? `${line.slice(0, MAX_LINE_CHARS).replace(PARTIAL_ESCAPE, "")} … ${(line.length - MAX_LINE_CHARS).toLocaleString("en-US")} more characters`
      : line,
  );
  return { text: cut.join("\n"), total, hidden: total - shown.length, offset };
}

/** "Show all 342 lines", or how many are drawn of a longer whole. */
export function showAllLabel(clip: ClippedText): string {
  if (clip.total <= EXPANDED_LINES) return `Show all ${clip.total.toLocaleString("en-US")} lines`;
  return `Show ${EXPANDED_LINES.toLocaleString("en-US")} of ${clip.total.toLocaleString("en-US")} lines`;
}

/**
 * A file's text as Claude Code's Read returns it, `cat -n` style ("    12→code"
 * or "    12\tcode"), split into the line number and the line, so the numbers
 * can be drawn in the gutter's quiet ink. Text in no such shape is returned
 * as one unnumbered line each.
 */
export function numberedLines(content: string): { no: string; text: string }[] {
  const lines = content.split("\n");
  const numbered = /^\s*(\d+)(?:→|\t)(.*)$/u;
  const matching = lines.filter((line) => numbered.test(line)).length;
  if (!lines.length || matching < lines.length * 0.9)
    return lines.map((line) => ({ no: "", text: line }));
  return lines.map((line) => {
    const match = numbered.exec(line);
    return match ? { no: match[1], text: match[2] } : { no: "", text: line };
  });
}

/* ------------------------------------------------------------------ *
 * Edits
 * ------------------------------------------------------------------ */

export type EditRow = { kind: "add" | "del" | "ctx" | "gap"; text: string };
export type EditView = {
  path: string;
  rows: EditRow[];
  added: number;
  removed: number;
  /** The tool said the file was empty before. */
  newFile: boolean;
  /** A whole-file write whose earlier contents the tool did not report: every line reads as added. */
  contentsOnly: boolean;
};

/** Rows an edit draws at most; the rest is a count. */
export const MAX_EDIT_ROWS = 400;
/** Unchanged lines kept on either side of a change. */
const CONTEXT_LINES = 3;
/** Past this many cells the line diff gives up on alignment and shows old, then new. */
const MAX_DIFF_CELLS = 60_000;

const splitLines = (value: string): string[] => (value === "" ? [] : value.replace(/\r\n/gu, "\n").split("\n"));

/**
 * The rows of a change from `before` to `after`, line by line: the lines
 * both share at either end are context (three kept beside the change), and
 * the middle is aligned by longest common subsequence so a changed line
 * reads as removed then added beside the lines that stayed. A middle too
 * large to align on a phone reads as the old lines, then the new.
 */
export function lineDiff(before: string, after: string): EditRow[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const oldMiddle = a.slice(prefix, a.length - suffix);
  const newMiddle = b.slice(prefix, b.length - suffix);
  const rows: EditRow[] = [];
  const context = (lines: string[], keep: "end" | "start") => {
    if (lines.length <= CONTEXT_LINES) {
      for (const line of lines) rows.push({ kind: "ctx", text: line });
      return;
    }
    const hidden = lines.length - CONTEXT_LINES;
    const gap: EditRow = { kind: "gap", text: `${hidden} unchanged ${hidden === 1 ? "line" : "lines"}` };
    if (keep === "end") {
      rows.push(gap);
      for (const line of lines.slice(-CONTEXT_LINES)) rows.push({ kind: "ctx", text: line });
    } else {
      for (const line of lines.slice(0, CONTEXT_LINES)) rows.push({ kind: "ctx", text: line });
      rows.push(gap);
    }
  };
  context(a.slice(0, prefix), "end");
  if (oldMiddle.length * newMiddle.length > MAX_DIFF_CELLS) {
    for (const line of oldMiddle) rows.push({ kind: "del", text: line });
    for (const line of newMiddle) rows.push({ kind: "add", text: line });
  } else {
    // lengths[i][j]: the longest common run of oldMiddle[i..] and newMiddle[j..].
    const n = oldMiddle.length;
    const m = newMiddle.length;
    const lengths = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lengths[i][j] =
          oldMiddle[i] === newMiddle[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && oldMiddle[i] === newMiddle[j]) {
        rows.push({ kind: "ctx", text: oldMiddle[i] });
        i++;
        j++;
      } else if (j >= m || (i < n && lengths[i + 1][j] >= lengths[i][j + 1])) rows.push({ kind: "del", text: oldMiddle[i++] });
      else rows.push({ kind: "add", text: newMiddle[j++] });
    }
  }
  context(a.slice(a.length - suffix), "start");
  return rows;
}

function counted(path: string, rows: EditRow[], newFile: boolean, contentsOnly: boolean): EditView {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === "add") added++;
    else if (row.kind === "del") removed++;
  }
  const kept =
    rows.length > MAX_EDIT_ROWS
      ? [...rows.slice(0, MAX_EDIT_ROWS), { kind: "gap" as const, text: `${rows.length - MAX_EDIT_ROWS} more lines` }]
      : rows;
  return { path, rows: kept, added, removed, newFile, contentsOnly };
}

/**
 * A patch as rows. A unified diff is read by the desktop's own parser
 * (`parseUnifiedDiff`), each hunk under its range; anything else (Codex's
 * `*** Begin Patch` blocks) reads by each line's first character, with its
 * file headers as gaps.
 */
function patchViews(patch: string, path: string): EditView[] {
  const unified = patch.startsWith("diff --git ") ? patch : patch.startsWith("--- ") || patch.startsWith("@@") ? `diff --git a/${path} b/${path}\n${patch}` : "";
  const files = unified ? parseUnifiedDiff(unified).filter((file) => file.hunks.length) : [];
  if (files.length)
    return files.map((file) => {
      const rows: EditRow[] = [];
      for (const hunk of file.hunks) {
        rows.push({ kind: "gap", text: formatHunkHeader(hunk) });
        for (const line of hunk.lines) {
          if (line.startsWith("\\")) continue;
          rows.push({ kind: line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx", text: line.slice(1) });
        }
      }
      return counted(file.newPath ?? file.oldPath ?? path, rows, file.oldPath === null && file.newPath !== null, false);
    });
  const views: EditView[] = [];
  let current: { path: string; rows: EditRow[]; newFile: boolean } | null = null;
  const fileHeader = /^\*\*\* (Add|Update|Delete) File: (.+)$/u;
  for (const line of splitLines(patch)) {
    const header = fileHeader.exec(line);
    if (header) {
      if (current) views.push(counted(current.path, current.rows, current.newFile, false));
      current = { path: header[2].trim(), rows: [], newFile: header[1] === "Add" };
      continue;
    }
    if (/^\*\*\* (Begin|End) Patch/u.test(line) || line.startsWith("*** Move to:")) continue;
    current ??= { path, rows: [], newFile: false };
    if (line.startsWith("@@")) current.rows.push({ kind: "gap", text: line });
    else if (line.startsWith("+")) current.rows.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) current.rows.push({ kind: "del", text: line.slice(1) });
    else current.rows.push({ kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line });
  }
  if (current) views.push(counted(current.path, current.rows, current.newFile, false));
  return views;
}

/**
 * The changes an edit or write step made, from what it was called with, as
 * the desktop's `deriveEditHunks` reads it: several edits (`edits`), a patch,
 * or a before and an after (`old_string`/`new_string`, `oldText`/`newText`),
 * or a whole file's new contents (`content`). What the call records is all
 * there is: never the file as it is now.
 */
export function editViews(value: unknown): EditView[] {
  const input = record(value);
  const path = read(input, "path", "file_path", "filePath");
  if (Array.isArray(input.edits))
    return input.edits.flatMap((edit) => editViews({ ...record(edit), path: read(record(edit), "path", "file_path") || path }));
  if (typeof input.patch === "string") return patchViews(input.patch, path);
  if (typeof input.input === "string" && /^\*\*\* Begin Patch/u.test(input.input)) return patchViews(input.input, path);
  const reportsOld = typeof (input.oldText ?? input.old_string) === "string";
  const before = text(input.oldText ?? input.old_string);
  const after = text(input.newText ?? input.new_string ?? input.content);
  if (!before && !after) return [];
  return [counted(path, lineDiff(before, after), reportsOld && !before, !reportsOld)];
}

/* ------------------------------------------------------------------ *
 * The view
 * ------------------------------------------------------------------ */

export type ToolOutputView =
  | { kind: "command"; command: string; output: string; exitCode?: number; running: boolean; failed: boolean }
  | { kind: "read"; path: string; output: string; failed: boolean }
  | { kind: "edit"; path: string; edits: EditView[]; output: string; failed: boolean }
  | { kind: "matches"; heading: string; output: string; empty: string }
  | { kind: "web"; heading: string; output: string }
  | { kind: "todo"; items: { text: string; status: "pending" | "in_progress" | "completed" }[] }
  | { kind: "note"; text: string }
  | { kind: "data"; call: string; output: string };

/** What the opened step shows, with the desktop's word on the output, when it was cut. */
export type ToolOutput = { view: ToolOutputView; clipped: boolean };

/** The call's arguments as one compact line of JSON: `{}` says nothing, so is left out. */
function compactCall(input: unknown): string {
  if (input === undefined || input === null) return "";
  try {
    const json = JSON.stringify(input);
    if (!json || json === "{}" || json === "[]") return "";
    return json.length > 2_000 ? `${json.slice(0, 2_000)}…` : json;
  } catch {
    return "";
  }
}

/**
 * An opened step's view, from the step and, once fetched, its detail. The
 * detail's input and output are the whole of them; without it the step's
 * own input and the transcript's preview of its output stand in (the
 * desktop keeps the first 4,000 characters there), so a step reads even
 * offline, and reads again at once when the detail lands.
 */
export function toolOutputView(tool: ToolSummary, detail: ToolDetail | null): ToolOutput {
  const presented = presentToolItem(tool);
  const kind: ConversationToolKind = presented.icon;
  const input = record(detail?.input ?? tool.input);
  // A running step's output is the one still arriving in the transcript: a
  // detail fetched while it ran is a snapshot that its later output passes.
  const output = detail && tool.status !== "running" ? detail.output : (tool.output ?? "");
  const status = detail?.status ?? tool.status;
  const clipped = detail?.clipped === true;
  const failed = status === "error";
  if (status === "declined") return { view: { kind: "note", text: "The request to run this was declined." }, clipped };
  if (status === "stopped" && !output.trim()) return { view: { kind: "note", text: "Stopped before it finished." }, clipped };
  switch (kind) {
    case "command": {
      const exitCode = detail?.exitCode ?? tool.exitCode;
      return {
        view: {
          kind: "command",
          command: read(input, "command", "cmd") || (tool.summary ?? "").replace(/^[^:]+: /u, ""),
          output,
          ...(exitCode !== undefined ? { exitCode } : {}),
          running: status === "running",
          failed: failed || !!exitCode,
        },
        clipped,
      };
    }
    case "file_read":
      return { view: { kind: "read", path: read(input, "path", "file_path", "filePath"), output, failed }, clipped };
    case "file_edit":
    case "file_write":
      return {
        view: { kind: "edit", path: read(input, "path", "file_path", "filePath"), edits: editViews(input), output, failed },
        clipped,
      };
    case "search":
    case "list": {
      const pattern = read(input, "pattern", "query", "glob");
      const where = read(input, "path", "directory");
      const heading = kind === "search" ? [pattern, where && `in ${where}`].filter(Boolean).join(" ") : [pattern, where].filter(Boolean).join(" in ") || where;
      return { view: { kind: "matches", heading, output, empty: kind === "search" ? "No matches" : "Nothing listed" }, clipped };
    }
    case "web":
      return { view: { kind: "web", heading: read(input, "url", "query"), output }, clipped };
    case "todo": {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      return {
        view: {
          kind: "todo",
          items: todos
            .map((entry) => record(entry))
            .map((todo): { text: string; status: "pending" | "in_progress" | "completed" } => ({
              text: read(todo, "content", "description", "title"),
              status:
                todo.status === "completed" || todo.status === "in_progress" ? (todo.status as "completed" | "in_progress") : "pending",
            }))
            .filter((item) => item.text),
        },
        clipped,
      };
    }
    default:
      return { view: { kind: "data", call: compactCall(detail?.input ?? tool.input), output }, clipped };
  }
}

/* ------------------------------------------------------------------ *
 * Fetched details, kept
 * ------------------------------------------------------------------ */

/**
 * Which chat a step belongs to, for keeping its detail: a step's id is unique
 * only within its chat (a CLI may number its calls per turn or per session),
 * so the same id can name another step in another chat or on another desktop.
 */
export function toolDetailChat(deviceId: string, workspaceId: string, agentId: string): string {
  return `${deviceId}\0${workspaceId}\0${agentId}`;
}

/** What a kept detail holds in memory, in characters: its whole output and its whole call. */
export function toolDetailSize(detail: ToolDetail): number {
  let input = 0;
  try {
    input = JSON.stringify(detail.input ?? null)?.length ?? 0;
  } catch {
    input = 0;
  }
  return detail.output.length + input;
}

/**
 * Fetched details, kept by chat and step: the chat's list unmounts a row
 * scrolled out of view, and scrolling back must neither lose the output nor
 * ask the desktop again. Bounded by what they hold, since one detail can be
 * megabytes (a write's call carries the whole file), and by count: the least
 * recently opened go first.
 */
export function createToolDetailCache(maxChars = 8 * 1024 * 1024, maxEntries = 200) {
  const entries = new Map<string, { detail: ToolDetail; size: number }>();
  let size = 0;
  const forget = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    size -= entry.size;
  };
  return {
    get(key: string): ToolDetail | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.detail;
    },
    set(key: string, detail: ToolDetail): void {
      forget(key);
      const cost = toolDetailSize(detail);
      if (cost > maxChars) return;
      entries.set(key, { detail, size: cost });
      size += cost;
      while (size > maxChars || entries.size > maxEntries) forget(entries.keys().next().value!);
    },
    /** Characters held, for tests. */
    size: () => size,
    /** Details held, for tests. */
    count: () => entries.size,
  };
}
