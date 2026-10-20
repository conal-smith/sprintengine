const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  MAX_ATTACHED_FILES,
  attachedFileName,
  attachedFileType,
  middleTruncateFileName,
  parseAttachedFiles,
} = require("../../../.mobile-test-build/src/features/conversations/attachedFiles.js");
const { projectConversation } = require("../../../.mobile-test-build/src/features/conversations/conversationLogic.js");

const POSIX = "/Users/dev/Documents/Quarterly report.pdf";
const DRIVE = "C:\\Users\\dev\\Documents\\Pairing plan.docx";
const DRIVE_SLASHED = "D:/exports/budget.xlsx";
const UNC = "\\\\build-box\\share\\finance\\Deck.pptx";

test("a message's files are absolute desktop paths on any system, each once", () => {
  assert.deepEqual(
    parseAttachedFiles([{ path: POSIX }, { path: DRIVE }, { path: DRIVE_SLASHED }, { path: UNC }, { path: POSIX, extra: true }]),
    [{ path: POSIX }, { path: DRIVE }, { path: DRIVE_SLASHED }, { path: UNC }],
  );
});

test("no list, or a list in another shape, draws no cards", () => {
  for (const value of [undefined, null, "notes.pdf", 3, { path: POSIX }, {}]) assert.deepEqual(parseAttachedFiles(value), [], JSON.stringify(value));
});

test("a malformed entry is skipped, and the message keeps its other cards", () => {
  const files = parseAttachedFiles([
    { path: POSIX },
    POSIX,
    null,
    [POSIX],
    {},
    { path: 42 },
    { path: "" },
    { path: "notes.pdf" },
    { path: "./notes.pdf" },
    { path: "C:notes.pdf" },
    { path: "\\\\\\triple" },
    { path: "/Users/dev/re\nport.pdf" },
    { path: "/Users/dev/bell\u0007.pdf" },
    { path: `/${"a".repeat(4096)}` },
    { path: UNC },
  ]);
  assert.deepEqual(files, [{ path: POSIX }, { path: UNC }]);
});

test("no more cards than the desktop lets a message attach", () => {
  assert.equal(MAX_ATTACHED_FILES, 50);
  const many = Array.from({ length: 60 }, (_, index) => ({ path: `/Users/dev/${index}.pdf` }));
  const files = parseAttachedFiles(many);
  assert.equal(files.length, 50);
  assert.equal(files[49].path, "/Users/dev/49.pdf");
  // Skipped entries do not use up the bound.
  const mixed = [...Array.from({ length: 10 }, () => ({ path: "relative.pdf" })), ...many];
  assert.equal(parseAttachedFiles(mixed).length, 50);
});

test("a card names a file by its path's last segment, whichever separator it uses", () => {
  assert.equal(attachedFileName(POSIX), "Quarterly report.pdf");
  assert.equal(attachedFileName(DRIVE), "Pairing plan.docx");
  assert.equal(attachedFileName(DRIVE_SLASHED), "budget.xlsx");
  assert.equal(attachedFileName(UNC), "Deck.pptx");
  assert.equal(attachedFileName("/Users/dev/exports/"), "exports");
  assert.equal(attachedFileName("C:\\Users\\dev\\mixed/slashes\\notes.txt"), "notes.txt");
});

test("a card says what a file is: its glyph's kind and its extension as people say it", () => {
  const cases = [
    ["report.PDF", "pdf", "PDF"],
    ["plan.docx", "document", "DOCX"],
    ["notes.pages", "document", "PAGES"],
    ["budget.xlsx", "spreadsheet", "XLSX"],
    ["rows.csv", "spreadsheet", "CSV"],
    ["deck.pptx", "presentation", "PPTX"],
    ["build.tar.gz", "archive", "GZ"],
    ["readme.md", "text", "MD"],
    ["server.log", "text", "LOG"],
    ["session-capture.trace", "generic", "TRACE"],
    ["photo.png", "generic", "PNG"],
    ["Makefile", "generic", "File"],
    [".env", "generic", "File"],
    ["archive.backup-old", "generic", "File"],
  ];
  for (const [name, kind, label] of cases) assert.deepEqual(attachedFileType(name), { kind, label }, name);
  // A Windows path is read by its name.
  assert.deepEqual(attachedFileType(DRIVE), { kind: "document", label: "DOCX" });
});

test("a long name is cut in the middle and keeps its extension", () => {
  assert.equal(middleTruncateFileName("short.pdf"), "short.pdf");
  const cut = middleTruncateFileName("Quarterly report final v3 (reviewed).pdf");
  assert.equal(cut.length, 24);
  assert.ok(cut.startsWith("Quarterly r"), cut);
  assert.ok(cut.endsWith(").pdf"), cut);
  assert.ok(cut.includes("…"), cut);
  // An "extension" too long to be one is not kept whole.
  assert.equal(middleTruncateFileName("a".repeat(30), 10).length, 10);
});

test("the person's bubble carries the files its user_message recorded; its text is only their words", () => {
  const user = (payload) => ({ id: "e1", seq: 1, sessionId: "s", workspaceId: "w", agentId: "a", type: "user_message", createdAt: 1, payload });
  const [row] = projectConversation([user({ turnId: "t1", text: "Summarise these", files: [{ path: POSIX }, { path: UNC }] })]).rows;
  assert.equal(row.kind, "message");
  assert.equal(row.role, "user");
  assert.equal(row.text, "Summarise these");
  assert.deepEqual(row.files, [{ path: POSIX }, { path: UNC }]);
  // A list the phone cannot read leaves the bubble its words, and no cards.
  const [unread] = projectConversation([user({ turnId: "t1", text: "Summarise", files: "nope" })]).rows;
  assert.equal(unread.text, "Summarise");
  assert.equal("files" in unread, false);
  // Files alone, with no words.
  const [bare] = projectConversation([user({ turnId: "t1", text: "", files: [{ path: DRIVE }] })]).rows;
  assert.equal(bare.text, "");
  assert.deepEqual(bare.files, [{ path: DRIVE }]);
});
