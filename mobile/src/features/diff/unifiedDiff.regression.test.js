const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  parseUnifiedDiff,
  hunkSections,
  diffDisplayRows,
  displayText,
  gutterDigits,
  readTurnDiff,
  splitPath,
  diffTotals,
} = require("../../../.mobile-test-build/src/features/diff/unifiedDiff.js");

const modified = [
  "diff --git a/src/components/Toast.tsx b/src/components/Toast.tsx",
  "index 3f1c2a4..8b0d9e1 100644",
  "--- a/src/components/Toast.tsx",
  "+++ b/src/components/Toast.tsx",
  "@@ -3,4 +3,5 @@ import { Animated } from \"react-native\";",
  " ",
  "-const AUTO_DISMISS_MS = 5_000;",
  "+const AUTO_DISMISS_MS = {",
  "+  neutral: 5_000, success: 5_000,",
  " ",
  " export function Toast() {",
  "@@ -40,3 +41,3 @@ export function Toast() {",
  "   useEffect(() => {",
  "-    const timer = setTimeout(dismiss, AUTO_DISMISS_MS);",
  "+    const timer = setTimeout(dismiss, AUTO_DISMISS_MS[tone]);",
  "   }, [tone]);",
  "",
].join("\n");

test("a modified file reads as two hunks with the parser's paths and the text after each @@", () => {
  const [file, ...rest] = parseUnifiedDiff(modified);
  assert.equal(rest.length, 0);
  assert.equal(file.oldPath, "src/components/Toast.tsx");
  assert.equal(file.newPath, "src/components/Toast.tsx");
  assert.equal(file.binary, false);
  assert.deepEqual(
    file.hunks.map((hunk) => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines, hunk.lines.length]),
    [
      [3, 4, 3, 5, 6],
      [40, 3, 41, 3, 4],
    ],
  );
  assert.deepEqual(hunkSections(modified), [['import { Animated } from "react-native";', "export function Toast() {"]]);
});

test("rows number each side as it runs: a removal advances old, an addition new, context both", () => {
  const [file] = parseUnifiedDiff(modified);
  const rows = diffDisplayRows(file, hunkSections(modified)[0]);
  const shape = rows.map((row) => (row.kind === "hunk" ? ["hunk", row.oldStart, row.newStart, row.context] : [row.kind, row.oldNo, row.newNo, row.text]));
  assert.deepEqual(shape, [
    ["hunk", 3, 3, 'import { Animated } from "react-native";'],
    ["ctx", 3, 3, ""],
    ["del", 4, null, "const AUTO_DISMISS_MS = 5_000;"],
    ["add", null, 4, "const AUTO_DISMISS_MS = {"],
    ["add", null, 5, "  neutral: 5_000, success: 5_000,"],
    ["ctx", 5, 6, ""],
    ["ctx", 6, 7, "export function Toast() {"],
    ["hunk", 40, 41, "export function Toast() {"],
    ["ctx", 40, 41, "  useEffect(() => {"],
    ["del", 41, null, "    const timer = setTimeout(dismiss, AUTO_DISMISS_MS);"],
    ["add", null, 42, "    const timer = setTimeout(dismiss, AUTO_DISMISS_MS[tone]);"],
    ["ctx", 42, 43, "  }, [tone]);"],
  ]);
  assert.equal(rows[0].header, "@@ -3,4 +3,5 @@");
  assert.equal(gutterDigits(rows), 2);
});

test("without its sections a hunk still gets its range and an empty context", () => {
  const [file] = parseUnifiedDiff(modified);
  const [hunk] = diffDisplayRows(file);
  assert.equal(hunk.kind, "hunk");
  assert.equal(hunk.context, "");
  assert.equal(hunk.header, "@@ -3,4 +3,5 @@");
});

test("an added file is all additions from line 1, with no old side", () => {
  const patch = [
    "diff --git a/src/components/toastTimers.ts b/src/components/toastTimers.ts",
    "new file mode 100644",
    "index 0000000..5d1e2f3",
    "--- /dev/null",
    "+++ b/src/components/toastTimers.ts",
    "@@ -0,0 +1,3 @@",
    "+export const HOLD_MS = 600;",
    "+",
    "+export const tick = () => Date.now();",
  ].join("\n");
  const [file] = parseUnifiedDiff(patch);
  assert.equal(file.oldPath, null);
  assert.equal(file.newPath, "src/components/toastTimers.ts");
  const rows = diffDisplayRows(file, hunkSections(patch)[0]);
  assert.deepEqual(rows[0], { kind: "hunk", header: "@@ -0,0 +1,3 @@", context: "", oldStart: 0, newStart: 1 });
  assert.deepEqual(
    rows.slice(1).map((row) => [row.kind, row.oldNo, row.newNo, row.text]),
    [
      ["add", null, 1, "export const HOLD_MS = 600;"],
      ["add", null, 2, ""],
      ["add", null, 3, "export const tick = () => Date.now();"],
    ],
  );
});

test("a deleted file is all removals from line 1, with no new side", () => {
  const patch = [
    "diff --git a/src/components/toastQueue.ts b/src/components/toastQueue.ts",
    "deleted file mode 100644",
    "index 7a6b5c4..0000000",
    "--- a/src/components/toastQueue.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-export const queue: string[] = [];",
    "-export const clear = () => queue.splice(0);",
  ].join("\n");
  const [file] = parseUnifiedDiff(patch);
  assert.equal(file.oldPath, "src/components/toastQueue.ts");
  assert.equal(file.newPath, null);
  assert.deepEqual(
    diffDisplayRows(file).slice(1).map((row) => [row.kind, row.oldNo, row.newNo]),
    [
      ["del", 1, null],
      ["del", 2, null],
    ],
  );
});

test("the no-newline marker stays with its hunk as a note and numbers nothing", () => {
  const patch = [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1 @@",
    "-Old last line",
    "\\ No newline at end of file",
    "+New last line",
    "\\ No newline at end of file",
  ].join("\n");
  const [file] = parseUnifiedDiff(patch);
  assert.equal(file.hunks[0].oldLines, 1);
  assert.equal(file.hunks[0].lines.length, 4);
  assert.deepEqual(
    diffDisplayRows(file).map((row) => (row.kind === "hunk" ? row.kind : [row.kind, row.oldNo, row.newNo, row.text])),
    [
      "hunk",
      ["del", 1, null, "Old last line"],
      ["note", null, null, "No newline at end of file"],
      ["add", null, 1, "New last line"],
      ["note", null, null, "No newline at end of file"],
    ],
  );
});

test("a binary file is flagged with no hunks and so no rows", () => {
  const patch = [
    "diff --git a/assets/icon.png b/assets/icon.png",
    "index 1111111..2222222 100644",
    "Binary files a/assets/icon.png and b/assets/icon.png differ",
  ].join("\n");
  const [file] = parseUnifiedDiff(patch);
  assert.equal(file.binary, true);
  assert.deepEqual(file.hunks, []);
  assert.deepEqual(diffDisplayRows(file), []);
});

test("a CRLF line keeps its \\r in the rows, and only the screen's text drops it", () => {
  const patch = "diff --git a/win.txt b/win.txt\n--- a/win.txt\n+++ b/win.txt\n@@ -1 +1 @@\n-one\r\n+two\r\n";
  const [file] = parseUnifiedDiff(patch);
  assert.deepEqual(file.hunks[0].lines, ["-one\r", "+two\r"]);
  const rows = diffDisplayRows(file);
  assert.equal(rows[2].text, "two\r");
  assert.equal(displayText(rows[2].text), "two");
});

test("tabs expand to the next stop so a monospace column lines up", () => {
  assert.equal(displayText("\tx"), "    x");
  assert.equal(displayText("ab\tc"), "ab  c");
  assert.equal(displayText("a\tb", 2), "a b");
  assert.equal(displayText("plain"), "plain");
});

test("empty input and text before any file read as nothing", () => {
  assert.deepEqual(parseUnifiedDiff(""), []);
  assert.deepEqual(parseUnifiedDiff("warning: something\n@@ -1 +1 @@\n+x\n"), []);
  assert.deepEqual(hunkSections("@@ -1 +1 @@ stray\n"), []);
});

test("a turn's answer is read field by field, and a refusal throws the desktop's words", () => {
  const read = readTurnDiff({
    ok: true,
    diff: {
      files: [
        { path: "src/a.ts", status: "modified", addedLines: 3, removedLines: 1, binary: false },
        { path: "assets/icon.png", status: "added", addedLines: 0, removedLines: 0, binary: true },
        { path: "src/b.ts", status: "renamed", addedLines: -2, removedLines: "4" },
        { status: "deleted" },
      ],
    },
    patch: "diff --git a/src/a.ts b/src/a.ts",
  });
  assert.deepEqual(read.files, [
    { path: "src/a.ts", status: "modified", addedLines: 3, removedLines: 1, binary: false },
    { path: "assets/icon.png", status: "added", addedLines: 0, removedLines: 0, binary: true },
    { path: "src/b.ts", status: "modified", addedLines: 0, removedLines: 0, binary: false },
  ]);
  assert.equal(read.patch, "diff --git a/src/a.ts b/src/a.ts");
  assert.equal(readTurnDiff({ ok: true, diff: { files: [] } }).patch, null);
  assert.throws(() => readTurnDiff({ ok: false, message: "File is not part of this turn." }), /File is not part of this turn\./);
  assert.throws(() => readTurnDiff(null), /could not read this turn's changes/);
});

test("a path splits into its folder and its name", () => {
  assert.deepEqual(splitPath("src/components/Toast.tsx"), { dir: "src/components", name: "Toast.tsx" });
  assert.deepEqual(splitPath("README.md"), { dir: "", name: "README.md" });
});

test("totals add each file's lines", () => {
  assert.deepEqual(diffTotals([]), { files: 0, added: 0, removed: 0 });
  assert.deepEqual(
    diffTotals([
      { addedLines: 3, removedLines: 1 },
      { addedLines: 12, removedLines: 0 },
      { addedLines: 0, removedLines: 7 },
    ]),
    { files: 3, added: 15, removed: 8 },
  );
});
