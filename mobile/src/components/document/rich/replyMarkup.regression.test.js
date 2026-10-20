/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const MarkdownIt = require("markdown-it");

const buildRoot = path.resolve(__dirname, "../../../../.mobile-test-build");
const { installReplyMarkup, fenceKind, replyBlockReady, MAX_DISPLAY_MATH, MAX_INLINE_MATH } = require(
  path.join(buildRoot, "src/components/document/rich/replyMarkup.js"),
);
const { markdownRuns } = require(path.join(buildRoot, "src/components/document/markdownRuns.js"));
const { drawnAsReply, rowStreaming, streamingTurn } = require(
  path.join(buildRoot, "src/features/conversations/conversationLogic.js"),
);

// The two parsers MarkdownDocument draws with: Markdown alone, and a reply's.
const plain = MarkdownIt({ typographer: true, html: false, linkify: false });
const reply = MarkdownIt({ typographer: true, html: false, linkify: false });
installReplyMarkup(reply);

const flat = (tokens) => tokens.flatMap((token) => [token, ...flat(token.children ?? [])]);
const ofType = (source, type, parser = reply) => flat(parser.parse(source, {})).filter((token) => token.type === type);
const formulas = (source) => ofType(source, "math_block").map((token) => token.content);
const inline = (source) => ofType(source, "math_inline").map((token) => token.content);
const fences = (source) => ofType(source, "fence");

test("a $$ block standing on lines of its own is display math", () => {
  assert.deepEqual(formulas("Before.\n\n$$\nE = mc^2\n$$\n\nAfter."), ["E = mc^2"]);
  // Straight under a sentence, as agents write it.
  assert.deepEqual(formulas("The update is:\n$$\n\\theta \\leftarrow \\theta - \\eta \\nabla L\n$$"), [
    "\\theta \\leftarrow \\theta - \\eta \\nabla L",
  ]);
  // A line of TeX that would be a list or a heading stays TeX.
  assert.deepEqual(formulas("$$\n- x\n# y\n$$"), ["- x\n# y"]);
});

test("a \\[ block may share its lines, and fills one on its own", () => {
  assert.deepEqual(formulas("\\[ E = mc^2 \\]"), ["E = mc^2"]);
  assert.deepEqual(formulas("\\[\n\\int_0^1 x\\,dx\n\\]"), ["\\int_0^1 x\\,dx"]);
  assert.deepEqual(formulas("\\[ a +\nb \\]"), ["a +\nb"]);
});

test("a single dollar, a price or a shell variable never opens math", () => {
  for (const source of [
    "It costs $5 and $10.",
    "Between $5 and $10 a month.",
    "Run `echo $HOME` and then $PATH.",
    "Set $$ to the shell's PID, and $$5 is not money.",
    "$$5 and $$10 are two bets.\nAnd more $$",
    "$x$ is not math here.",
    "$$$\nx\n$$$",
  ]) {
    assert.deepEqual(formulas(source), [], source);
    assert.deepEqual(inline(source), [], source);
  }
});

test("math is never read inside code", () => {
  assert.deepEqual(formulas("```\n$$\nx\n$$\n```"), []);
  assert.deepEqual(formulas("    $$\n    x\n    $$"), []);
  assert.deepEqual(inline("Use `\\(x\\)` literally."), []);
  // The fence keeps its source byte for byte.
  assert.equal(fences("```sh\necho $$\n\\[1\\]\n```")[0].content, "echo $$\n\\[1\\]\n");
});

test("```latex, ```tex and ```katex stay code; ```math typesets; ```mermaid draws", () => {
  assert.equal(fenceKind("latex"), "code");
  assert.equal(fenceKind("tex"), "code");
  assert.equal(fenceKind("katex"), "code");
  assert.equal(fenceKind("math"), "math");
  assert.equal(fenceKind("Math"), "math");
  assert.equal(fenceKind("mermaid"), "diagram");
  assert.equal(fenceKind("mmd {theme}"), "diagram");
  assert.equal(fenceKind(""), "code");
  assert.equal(fenceKind(undefined), "code");
  // A whole document in a latex fence is not taken for a formula either.
  assert.deepEqual(formulas("```latex\n\\documentclass{article}\n\\[ x \\]\n```"), []);
});

test("citations and a sentence's brackets stay text", () => {
  assert.deepEqual(formulas("\\[1\\]"), []);
  assert.deepEqual(formulas("\\[2, 3\\]"), []);
  assert.deepEqual(formulas("\\[4-6\\]"), []);
  assert.deepEqual(formulas("The flag is \\[WIP\\] for now."), []);
  assert.deepEqual(formulas("\\[WIP\\] Fix the router"), []);
  assert.deepEqual(formulas("\\[a\\] and \\[b\\]"), []);
  // Markdown still reads them as escaped brackets.
  assert.match(plain.render("The flag is \\[WIP\\] for now."), /\[WIP\]/);
  assert.match(reply.render("The flag is \\[WIP\\] for now."), /\[WIP\]/);
});

test("an unclosed block is the text it is, streaming or not", () => {
  assert.deepEqual(formulas("$$\n\\frac{a}{b"), []);
  assert.deepEqual(formulas("\\[\n\\frac{a}{b"), []);
  assert.deepEqual(formulas("$$\nx\n\nmore prose"), []);
  // It is still Markdown around it.
  assert.equal(ofType("$$\n**bold**", "strong_open").length, 1);
  // Leaving the container the block opened in ends it, unclosed.
  assert.deepEqual(formulas("> $$\n> x\n\n$$"), []);
});

test("formulas past the cap stay text", () => {
  const long = "x".repeat(MAX_DISPLAY_MATH + 1);
  assert.deepEqual(formulas(`$$\n${long}\n$$`), []);
  assert.deepEqual(formulas(`\\[ ${long} \\]`), []);
  assert.equal(inline(`\\(${"y".repeat(MAX_INLINE_MATH + 1)}\\)`).length, 0);
  assert.equal(inline(`\\(${"y".repeat(MAX_INLINE_MATH)}\\)`).length, 1);
});

test("inline \\( … \\) is found on its line and gives way to a backtick or ://", () => {
  assert.deepEqual(inline("Here \\(a^2 + b^2\\) holds."), ["a^2 + b^2"]);
  assert.deepEqual(inline("A command \\(\\frac{1}{2}\\) inside."), ["\\frac{1}{2}"]);
  assert.deepEqual(inline("Across \\(a\nb\\) lines."), []);
  assert.deepEqual(inline("A \\(see `code`\\) span."), []);
  assert.deepEqual(inline("A \\(https://example.com\\) link."), []);
  assert.deepEqual(inline("Empty \\( \\) one."), []);
  // Markdown alone makes it "(…)"; the reply keeps the TeX.
  assert.match(plain.render("\\(x\\)"), /\(x\)/);
});

test("a fence says whether it closed and whether a line break follows it", () => {
  const [closed] = fences("```mermaid\nflowchart TD\n  A --> B\n```\n");
  assert.deepEqual(closed.meta, { closed: true, lineBreakAfter: true });
  const [atEnd] = fences("```mermaid\nflowchart TD\n  A --> B\n```");
  assert.deepEqual(atEnd.meta, { closed: true, lineBreakAfter: false });
  const [open] = fences("```mermaid\nflowchart TD\n  A --> ");
  assert.deepEqual(open.meta, { closed: false, lineBreakAfter: false });
  // A content line shaped like a fence but indented is not its close.
  const [indented] = fences("```mermaid\nA\n    ```");
  assert.equal(indented.meta.closed, false);
  // A longer closing run closes; a shorter one does not.
  assert.equal(fences("````mermaid\nA\n```")[0].meta.closed, false);
  assert.equal(fences("```mermaid\nA\n`````\n")[0].meta.closed, true);
  // Inside a list item, the item's end is not a close.
  assert.equal(fences("- ```mermaid\n  A\n\nafter")[0].meta.closed, false);
});

test("the streaming gate: a block draws mid-reply only once nothing can change it", () => {
  const meta = (source) => (fences(source)[0] ?? ofType(source, "math_block")[0]).meta;
  // While streaming: unclosed, or closed on the last line, waits.
  assert.equal(replyBlockReady(meta("```mermaid\nflowchart TD\n  A --> "), true), false);
  assert.equal(replyBlockReady(meta("```mermaid\nflowchart TD\n  A --> B\n```"), true), false);
  assert.equal(replyBlockReady(meta("```mermaid\nflowchart TD\n  A --> B\n```\n"), true), true);
  assert.equal(replyBlockReady(meta("$$\nx\n$$"), true), false);
  assert.equal(replyBlockReady(meta("$$\nx\n$$\nAnd so"), true), true);
  // A finished reply draws what it has.
  assert.equal(replyBlockReady(meta("```mermaid\nflowchart TD\n  A --> "), false), true);
  assert.equal(replyBlockReady(undefined, false), true);
  assert.equal(replyBlockReady(undefined, true), false);
});

test("a reply's runs never split a display block", () => {
  const paragraphs = Array.from({ length: 30 }, (_, index) => `Paragraph ${index} says something about the router.`);
  const body = [...paragraphs.slice(0, 7), "$$\na\n\nb\n\nc\n$$", ...paragraphs.slice(7)].join("\n\n");
  const runs = markdownRuns(body, reply, { perRun: 8, fromLength: 0 });
  assert.ok(runs.length > 1);
  const holding = runs.filter((run) => run.includes("$$"));
  assert.equal(holding.length, 1);
  assert.deepEqual(formulas(holding[0]), ["a\n\nb\n\nc"]);
  // A run that is not the reply's last ends in its line break, so its blocks are complete.
  const early = markdownRuns(`${"```mermaid\nA-->B\n```\n\n".repeat(10)}tail`, reply, { perRun: 2, fromLength: 0 });
  assert.equal(replyBlockReady(fences(early[0])[0].meta, true), true);
});

test("only an agent's reply is drawn as one; a person's message never is", () => {
  const user = { kind: "message", id: "u", role: "user", text: "```mermaid\nA-->B\n```\n$$\nx\n$$", at: 0, turn: "t" };
  const agent = { kind: "message", id: "a", role: "assistant", text: "hi", at: 0, turn: "t" };
  assert.equal(drawnAsReply(user), false);
  assert.equal(drawnAsReply(agent), true);
  assert.equal(drawnAsReply({ kind: "command", id: "c", output: "$$" }), false);
  // And so never streams either: it is never drawn through the reply parser.
  assert.equal(rowStreaming(user, "t", true), false);
});

test("which rows are still streaming", () => {
  const replies = [
    { turn: "one", startedAt: 0, endedAt: 5, streaming: false },
    { turn: "two", startedAt: 6, streaming: true },
  ];
  const live = streamingTurn(replies);
  assert.equal(live, "two");
  assert.equal(streamingTurn([]), null);
  const message = (turn) => ({ kind: "message", id: `${turn}:x`, role: "assistant", text: "", at: 0, ...(turn ? { turn } : {}) });
  assert.equal(rowStreaming(message("two"), live, true), true);
  assert.equal(rowStreaming(message("one"), live, true), false);
  // An older desktop's deltas name no turn: streaming while a turn is busy.
  assert.equal(rowStreaming(message(undefined), null, true), true);
  assert.equal(rowStreaming(message(undefined), null, false), false);
  assert.equal(rowStreaming({ kind: "fold", id: "f", turn: "two", label: "", failed: 0, live: true, parts: [] }, live, true), true);
  assert.equal(rowStreaming({ kind: "fold", id: "f", turn: "one", label: "", failed: 0, live: false, parts: [] }, live, true), false);
});

test("the plain parser reads none of it", () => {
  assert.deepEqual(ofType("$$\nx\n$$", "math_block", plain), []);
  assert.deepEqual(ofType("\\(x\\)", "math_inline", plain), []);
  assert.equal(fences("```mermaid\nA\n```").length, 1);
  assert.equal(ofType("```mermaid\nA\n```", "fence", plain)[0].meta, null);
});
