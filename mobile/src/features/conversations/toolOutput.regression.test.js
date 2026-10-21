const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  ansiLines,
  clipLines,
  createToolDetailCache,
  editViews,
  EXPANDED_LINES,
  lineDiff,
  MAX_EDIT_ROWS,
  MAX_LINE_CHARS,
  numberedLines,
  outputText,
  readToolDetail,
  showAllLabel,
  stripAnsi,
  styleAt,
  toolDetailChat,
  toolDetailSize,
  toolOutputView,
} = require("../../../.mobile-test-build/src/features/conversations/toolOutput.js");

const ESC = "\u001b";

test("terminal escapes are removed for copying: colours, cursor moves, titles and hyperlinks", () => {
  assert.equal(stripAnsi(`${ESC}[31mred${ESC}[0m plain`), "red plain");
  assert.equal(stripAnsi(`${ESC}[2K${ESC}[1Gdone`), "done");
  assert.equal(stripAnsi(`${ESC}]0;title${ESC}\\text`), "text");
  assert.equal(stripAnsi(`${ESC}]8;;https://x.test${ESC}\\link${ESC}]8;;${ESC}\\`), "link");
  assert.equal(stripAnsi("no escapes"), "no escapes");
});

test("colours and bold become runs, the sixteen colours fold into theme tones, and the rest is dropped", () => {
  const lines = ansiLines(`${ESC}[1;31mFAIL${ESC}[0m src/a.test.ts\n${ESC}[32m✓${ESC}[39m passes ${ESC}[90m(3ms)${ESC}[0m`);
  assert.deepEqual(JSON.parse(JSON.stringify(lines)), [
    [{ text: "FAIL", tone: "red", bold: true }, { text: " src/a.test.ts" }],
    [{ text: "✓", tone: "green" }, { text: " passes " }, { text: "(3ms)", tone: "muted" }],
  ]);
  const extended = ansiLines(`${ESC}[38;5;3mwarn${ESC}[38;5;200mpink${ESC}[38;2;1;2;3mrgb`);
  assert.deepEqual(JSON.parse(JSON.stringify(extended[0])), [{ text: "warnpinkrgb", tone: "yellow" }], "past the sixteen the ink stays as it was");
});

test("a carriage return redraws its line, as a progress bar does; CRLF is one break", () => {
  const lines = ansiLines("downloading 10%\rdownloading 50%\rdownloading 100%\r\nok\n");
  assert.deepEqual(JSON.parse(JSON.stringify(lines)), [[{ text: "downloading 100%" }], [{ text: "ok" }], []]);
});

test("the colour in force where a slice starts is read from the last reset before it", () => {
  const output = `${ESC}[31mstill red\nline two\n${ESC}[0m${ESC}[33myellow\nafter`;
  assert.deepEqual(styleAt(output, output.indexOf("line two")), { tone: "red" });
  assert.deepEqual(styleAt(output, output.indexOf("after")), { tone: "yellow" });
  assert.deepEqual(styleAt("plain", 3), {});
  const carried = ansiLines("line two", styleAt(output, output.indexOf("line two")));
  assert.equal(carried[0][0].tone, "red");
});

test("a long output shows its last lines for a command and its first otherwise, with the offset of the slice", () => {
  const output = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  const tail = clipLines(output, "tail", 3);
  assert.equal(tail.text, "line 98\nline 99\nline 100");
  assert.equal(tail.total, 100);
  assert.equal(tail.hidden, 97);
  assert.equal(output.slice(tail.offset).startsWith("line 98"), true);
  const head = clipLines(output, "head", 2);
  assert.equal(head.text, "line 1\nline 2");
  assert.equal(head.offset, 0);
  assert.deepEqual(clipLines("", "tail", 5), { text: "", total: 0, hidden: 0, offset: 0 });
  assert.equal(clipLines("one\ntwo", "head", 5).hidden, 0);
  assert.equal(showAllLabel(head), "Show all 100 lines");
  assert.equal(showAllLabel({ ...head, total: 5_000 }), `Show ${EXPANDED_LINES} of 5,000 lines`);
});

test("a megabyte on one line is cut, and a megabyte of lines draws only its slice", () => {
  const blob = "x".repeat(1_000_000);
  const clip = clipLines(blob, "head", 14);
  assert.equal(clip.text.length < MAX_LINE_CHARS + 60, true);
  assert.match(clip.text, /998,800 more characters$/);
  const many = Array.from({ length: 200_000 }, (_, index) => `row ${index}`).join("\n");
  const started = Date.now();
  const tail = clipLines(many, "tail", EXPANDED_LINES);
  assert.equal(tail.text.split("\n").length, EXPANDED_LINES);
  assert.equal(tail.hidden, 200_000 - EXPANDED_LINES);
  assert.ok(Date.now() - started < 1_000, "a slice of a big log is cheap");
});

test("Claude Code's numbered read splits into gutter and line; other text stays whole", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(numberedLines("     1→const a = 1;\n     2→\texport { a };"))), [
    { no: "1", text: "const a = 1;" },
    { no: "2", text: "\texport { a };" },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(numberedLines("    10\tline"))), [{ no: "10", text: "line" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(numberedLines("plain\ntext"))), [{ no: "", text: "plain" }, { no: "", text: "text" }]);
});

test("an output reads as text: strings as sent, content blocks joined, stdout before stderr, else JSON", () => {
  assert.equal(outputText("hi"), "hi");
  assert.equal(outputText(null), "");
  assert.equal(outputText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(outputText({ stdout: "out", stderr: "err" }), "out\nerr");
  assert.equal(outputText({ content: [{ type: "text", text: "inner" }] }), "inner");
  assert.equal(outputText({ count: 2 }), '{\n  "count": 2\n}');
});

test("getToolDetail's answer is read defensively", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(readToolDetail({
    ok: true,
    detail: { input: { command: "ls" }, output: "a\nb", status: "ok", exitCode: 0, clipped: false, totalBytes: 4 },
  }))), { input: { command: "ls" }, output: "a\nb", status: "ok", exitCode: 0, clipped: false, totalBytes: 4 });
  assert.equal(readToolDetail({ ok: false, message: "gone" }), null);
  assert.equal(readToolDetail({ ok: true }), null);
  const odd = readToolDetail({ ok: true, detail: { input: {}, output: 7, status: "weird", exitCode: 1.5, clipped: "yes" } });
  assert.deepEqual(JSON.parse(JSON.stringify(odd)), { input: {}, output: "7", clipped: false });
});

test("a line diff keeps three lines of context, aligns the middle, and names what it skipped", () => {
  const before = ["a", "b", "c", "d", "e", "old", "f", "g", "h", "i"].join("\n");
  const after = ["a", "b", "c", "d", "e", "new", "added", "f", "g", "h", "i"].join("\n");
  assert.deepEqual(JSON.parse(JSON.stringify(lineDiff(before, after))), [
    { kind: "gap", text: "2 unchanged lines" },
    { kind: "ctx", text: "c" }, { kind: "ctx", text: "d" }, { kind: "ctx", text: "e" },
    { kind: "del", text: "old" }, { kind: "add", text: "new" }, { kind: "add", text: "added" },
    { kind: "ctx", text: "f" }, { kind: "ctx", text: "g" }, { kind: "ctx", text: "h" },
    { kind: "gap", text: "1 unchanged line" },
  ]);
  const interleaved = lineDiff("x\nkeep\ny", "x2\nkeep\ny2");
  assert.deepEqual(JSON.parse(JSON.stringify(interleaved.map((row) => `${row.kind}:${row.text}`))), ["del:x", "add:x2", "ctx:keep", "del:y", "add:y2"]);
  const huge = lineDiff(Array.from({ length: 400 }, (_, i) => `o${i}`).join("\n"), Array.from({ length: 400 }, (_, i) => `n${i}`).join("\n"));
  assert.equal(huge.length, 800, "too big to align: old, then new");
});

test("edits are read from what the step was called with: before and after, several, a patch, or whole contents", () => {
  const [edit] = editViews({ file_path: "/r/src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" });
  assert.equal(edit.path, "/r/src/a.ts");
  assert.equal(edit.added, 1);
  assert.equal(edit.removed, 1);
  assert.equal(edit.newFile, false);
  assert.equal(edit.contentsOnly, false);
  const multi = editViews({ file_path: "/r/b.ts", edits: [{ old_string: "x", new_string: "y" }, { old_string: "p", new_string: "" }] });
  assert.equal(multi.length, 2);
  assert.equal(multi[1].path, "/r/b.ts");
  const write = editViews({ file_path: "/r/new.md", content: "# Title\n\nBody" })[0];
  assert.equal(write.contentsOnly, true);
  assert.equal(write.added, 3);
  const created = editViews({ path: "/r/c.ts", oldText: "", newText: "x" })[0];
  assert.equal(created.newFile, true);
  const unified = editViews({ path: "src/d.ts", patch: "--- a/src/d.ts\n+++ b/src/d.ts\n@@ -1,2 +1,2 @@\n keep\n-gone\n+here\n\\ No newline at end of file" });
  assert.deepEqual(JSON.parse(JSON.stringify(unified[0].rows.map((row) => row.kind))), ["gap", "ctx", "del", "add"]);
  assert.equal(unified[0].path, "src/d.ts");
  const codex = editViews({ input: "*** Begin Patch\n*** Update File: src/e.ts\n@@\n-old\n+new\n*** Add File: src/f.ts\n+fresh\n*** End Patch" });
  assert.deepEqual(JSON.parse(JSON.stringify(codex.map((view) => [view.path, view.added, view.removed, view.newFile]))), [
    ["src/e.ts", 1, 1, false],
    ["src/f.ts", 1, 0, true],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(editViews({ path: "x" }))), []);
  const long = editViews({ path: "big", content: Array.from({ length: 1_000 }, (_, i) => `l${i}`).join("\n") })[0];
  assert.equal(long.rows.length, MAX_EDIT_ROWS + 1);
  assert.equal(long.added, 1_000, "counted in full, drawn in part");
  assert.deepEqual(JSON.parse(JSON.stringify(long.rows.at(-1))), { kind: "gap", text: "600 more lines" });
});

const tool = (name, input, extra = {}) => ({ name, input, status: "ok", ...extra });

test("each kind of step reads as itself", () => {
  const command = toolOutputView(tool("Bash", { command: "npm test" }, { exitCode: 1, output: "preview" }), {
    input: { command: "npm test" }, output: "full output", exitCode: 1, clipped: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(command)), {
    view: { kind: "command", command: "npm test", output: "full output", exitCode: 1, running: false, failed: true },
    clipped: true,
  });
  const preview = toolOutputView(tool("Bash", { command: "ls" }, { status: "running", output: "a" }), null);
  assert.equal(preview.view.output, "a", "the transcript's preview stands in until the detail lands");
  assert.equal(preview.view.running, true);
  assert.equal(toolOutputView(tool("Read", { file_path: "/r/a.ts" }), null).view.kind, "read");
  assert.equal(toolOutputView(tool("Edit", { file_path: "/r/a.ts", old_string: "a", new_string: "b" }), null).view.edits.length, 1);
  const search = toolOutputView(tool("Grep", { pattern: "queue", path: "src" }, { output: "src/a.ts\nsrc/b.ts" }), null).view;
  assert.deepEqual(JSON.parse(JSON.stringify(search)), { kind: "matches", heading: "queue in src", output: "src/a.ts\nsrc/b.ts", empty: "No matches" });
  assert.equal(toolOutputView(tool("Glob", { pattern: "**/*.ts" }), null).view.heading, "**/*.ts");
  assert.equal(toolOutputView(tool("WebFetch", { url: "https://example.test/a" }), null).view.heading, "https://example.test/a");
  const todo = toolOutputView(tool("TodoWrite", { todos: [{ content: "one", status: "completed" }, { content: "two", status: "in_progress" }, { content: "" }] }), null).view;
  assert.deepEqual(JSON.parse(JSON.stringify(todo.items)), [{ text: "one", status: "completed" }, { text: "two", status: "in_progress" }]);
  const other = toolOutputView(tool("mcp__github__list_prs", { repo: "a/b" }, { output: "[]" }), null).view;
  assert.deepEqual(JSON.parse(JSON.stringify(other)), { kind: "data", call: '{"repo":"a/b"}', output: "[]" });
  assert.equal(toolOutputView(tool("Screenshot", {}), null).view.call, "", "an empty call says nothing");
  assert.equal(toolOutputView(tool("Bash", { command: "rm" }, { status: "declined" }), null).view.kind, "note");
});

test("fetched details are kept by size, the least recently opened first to go", () => {
  const cache = createToolDetailCache(100);
  const detail = (size) => ({ input: undefined, output: "x".repeat(size), clipped: false });
  cache.set("a", detail(40));
  cache.set("b", detail(40));
  assert.ok(cache.get("a"), "reading one keeps it");
  cache.set("c", detail(40));
  assert.equal(cache.get("b"), undefined, "the least recently opened went");
  assert.ok(cache.get("a"));
  cache.set("huge", detail(500));
  assert.equal(cache.get("huge"), undefined, "one larger than the whole cache is never held");
  assert.equal(cache.size(), 88, "each output and its call, `null` included");
});

test("a running step shows the output still arriving, not a detail fetched earlier", () => {
  const early = { input: { command: "npm test" }, output: "first line", clipped: false };
  const running = toolOutputView(tool("Bash", { command: "npm test" }, { status: "running", output: "first line\nsecond line" }), early);
  assert.equal(running.view.output, "first line\nsecond line");
  const finished = toolOutputView(tool("Bash", { command: "npm test" }, { output: "preview" }), { ...early, output: "the whole output" });
  assert.equal(finished.view.output, "the whole output");
});

test("kept details are keyed by chat, sized by all they hold, and capped in number", () => {
  assert.notEqual(toolDetailChat("dev-a", "w", "a"), toolDetailChat("dev-b", "w", "a"));
  assert.notEqual(toolDetailChat("d", "w", "a1"), toolDetailChat("d", "w", "a2"));
  const write = { input: { file_path: "big.txt", content: "x".repeat(100_000) }, output: "Wrote", clipped: false };
  assert.ok(toolDetailSize(write) > 100_000, "a write's whole call is counted, not a summary of it");
  const cache = createToolDetailCache(150_000, 3);
  cache.set("one", write);
  cache.set("two", write);
  assert.equal(cache.get("one"), undefined, "two writes of 100,000 characters do not fit in 150,000");
  const small = { input: {}, output: "ok", clipped: false };
  const counted = createToolDetailCache(1_000_000, 3);
  for (const key of ["a", "b", "c", "d"]) counted.set(key, small);
  assert.equal(counted.count(), 3);
  assert.equal(counted.get("a"), undefined, "the oldest goes past the cap");
});

test("escapes a terminal sends beyond colours are dropped, and a cut never leaves half of one", () => {
  // An OSC 8 hyperlink whose end was lost must not swallow the next lines.
  assert.equal(stripAnsi(`${ESC}]8;;https://x.test/a\nnext line\nlast`), "\nnext line\nlast");
  assert.deepEqual(JSON.parse(JSON.stringify(ansiLines(`${ESC}]8;;https://x.test\nnext`))), [[], [{ text: "next" }]]);
  // Private and intermediate CSI forms, and a two-character escape.
  assert.equal(stripAnsi(`${ESC}[>0c${ESC}[2 q${ESC}[?25lshown${ESC}[?25h${ESC}c`), "shown");
  // Colours written with colons.
  assert.deepEqual(JSON.parse(JSON.stringify(ansiLines(`${ESC}[38:5:1mred${ESC}[0m`))), [[{ text: "red", tone: "red" }]]);
  assert.deepEqual(styleAt(`${ESC}[38:5:2mgreen`), { tone: "green" });
  // A stray ESC is not drawn.
  assert.equal(stripAnsi(`a${ESC}`), "a");
  // A long line cut in the middle of an escape keeps none of it.
  const line = "x".repeat(MAX_LINE_CHARS - 3) + `${ESC}[31mred and more`;
  const clip = clipLines(line, "head", 5);
  assert.equal(clip.text.includes(ESC), false);
  assert.match(clip.text, /^x+ … \d+ more characters$/);
});
