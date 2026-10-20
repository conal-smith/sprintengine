// Files a person attached to a message by path: dropped, picked or pasted from
// the desktop's own disk into its composer. Each travels beside the words, as
// `files: [{ path }]` on the `user_message`, and never in them: the text is
// only what the person wrote (the desktop's `attachedFiles.ts` in
// conversation-timeline).
//
// `files` is an optional payload member the phone's pinned wire types do not
// name, so it is read here off the payload, defensively. The paths are
// absolute paths on the desktop (POSIX, a Windows drive, or a Windows UNC
// share), which the phone cannot open: a card names the file and its kind, and
// a long press says the whole path.
//
// The desktop refuses a send whose list breaks its rules, so a recorded list
// is a good one. The phone is only reading, and draws what it can: an entry
// that is not an absolute path within bounds is skipped rather than costing
// the message its other cards, each path once, and no more than the desktop's
// limit of cards.

export type AttachedFile = { path: string };

/** The most files one message may attach: the desktop's limit, and the most cards drawn. */
export const MAX_ATTACHED_FILES = 50;
const MAX_PATH_CHARS = 4096;

// Absolute on any system a conversation may run on: POSIX, a Windows drive,
// or a Windows UNC share.
function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\[^\\]/u.test(path);
}

/** A `user_message` payload's `files`, as the cards it draws; empty for anything else. */
export function parseAttachedFiles(value: unknown): AttachedFile[] {
  if (!Array.isArray(value)) return [];
  const files: AttachedFile[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (files.length >= MAX_ATTACHED_FILES) break;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const path = (candidate as Record<string, unknown>).path;
    if (
      typeof path !== "string" ||
      !path ||
      path.length > MAX_PATH_CHARS ||
      /[\u0000-\u001f\u007f]/u.test(path) ||
      !isAbsoluteFilePath(path) ||
      seen.has(path)
    )
      continue;
    seen.add(path);
    files.push({ path });
  }
  return files;
}

/** The last segment of a path, whichever separator it uses. */
export function attachedFileName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path;
}

/** The kinds a card's glyph tells apart: the office kinds a message usually attaches, and the rest. */
export type AttachedFileKind = "pdf" | "document" | "spreadsheet" | "presentation" | "text" | "archive" | "generic";

// The desktop's FileTypeGlyph sets for the same kinds. Each names a kind of
// document rather than the app that wrote it, so every word processor's file
// is a document.
const DOCUMENT_EXTENSIONS = new Set(["doc", "docx", "docm", "dotx", "odt", "rtf", "pages"]);
const SPREADSHEET_EXTENSIONS = new Set(["xls", "xlsx", "xlsm", "ods", "numbers", "csv", "tsv"]);
const PRESENTATION_EXTENSIONS = new Set(["ppt", "pptx", "pptm", "odp", "key"]);
const ARCHIVE_EXTENSIONS = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar"]);
const TEXT_EXTENSIONS = new Set(["txt", "log", "md", "mdx", "markdown"]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * What a card says a file is: its glyph's kind, and the extension as people
 * say it (PDF, DOCX, XLSX), or `File` when the name has none worth showing.
 */
export function attachedFileType(name: string): { kind: AttachedFileKind; label: string } {
  const extension = extensionOf(attachedFileName(name));
  const kind: AttachedFileKind =
    extension === "pdf"
      ? "pdf"
      : DOCUMENT_EXTENSIONS.has(extension)
        ? "document"
        : SPREADSHEET_EXTENSIONS.has(extension)
          ? "spreadsheet"
          : PRESENTATION_EXTENSIONS.has(extension)
            ? "presentation"
            : ARCHIVE_EXTENSIONS.has(extension)
              ? "archive"
              : TEXT_EXTENSIONS.has(extension)
                ? "text"
                : "generic";
  return { kind, label: /^[a-z0-9]{1,5}$/u.test(extension) ? extension.toUpperCase() : "File" };
}

/** How many characters of a name a card shows, as on the desktop's card. */
export const ATTACHED_FILE_NAME_CHARS = 24;

/**
 * A file name cut in the middle to at most `max` characters, keeping its start
 * and its extension: "Quarterly report final v3.pdf" keeps the words that say
 * which report and the `.pdf` that says what it is. The desktop's cut.
 */
export function middleTruncateFileName(name: string, max: number = ATTACHED_FILE_NAME_CHARS): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : "";
  const stem = name.slice(0, name.length - extension.length);
  const room = max - 1 - extension.length;
  if (room < 4) return `${name.slice(0, Math.max(1, max - 1))}…`;
  const head = Math.ceil(room * 0.6);
  return `${stem.slice(0, head)}…${stem.slice(stem.length - (room - head))}${extension}`;
}
