/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const MarkdownIt = require("markdown-it");

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const { markdownRuns, RUNS_FROM_LENGTH } = require(path.join(buildRoot, "src/components/document/markdownRuns.js"));

// The parser MarkdownDocument hands the library.
const md = MarkdownIt({ typographer: true, html: false, linkify: false });

// What the library draws from: every token but its line numbers, which a run
// counts from its own first line.
const strip = (tokens) =>
  tokens.map(({ type, tag, attrs, nesting, level, content, markup, info, block, hidden, children }) => ({
    type,
    tag,
    attrs,
    nesting,
    level,
    content,
    markup,
    info,
    block,
    hidden,
    children: children ? strip(children) : children,
  }));
const drawnWhole = (body) => strip(md.parse(body, {}));
const drawnInRuns = (runs) => runs.flatMap((run) => strip(md.parse(run, {})));

const REPLY = [
  "# Fixing the router",
  "Setext heading",
  "===",
  "",
  "The handler reads **params.id** before checking it — so \"undefined\" lands in the key.",
  "A lazy line continues the paragraph.",
  "- a list may interrupt a paragraph",
  "- second item",
  "",
  "3. ordered from three",
  "4. and on",
  "",
  "   * nested under it",
  "",
  "1. a loose list",
  "",
  "2. with a gap",
  "",
  "> quoted",
  "lazily continued",
  "",
  "> second quote",
  "",
  "```ts",
  "const a = 1;",
  "",
  "const b = 2;",
  "```",
  "",
  "    indented code",
  "",
  "    still code",
  "",
  "| File | Change |",
  "| --- | ---: |",
  "| router.ts | check the id |",
  "",
  "***",
  "",
  "Some <b>markup</b> stays text, and `inline code` stays code.",
  "Paragraph",
  "---",
  "",
  "Last words with a [link](https://example.com).",
  "",
  "```",
  "an unclosed fence at the end",
].join("\n");

test("a reply drawn in runs parses as the whole reply does, at every point of its stream", () => {
  for (const perRun of [1, 2, 8])
    for (let end = 1; end <= REPLY.length; end += 3) {
      const body = REPLY.slice(0, end);
      const runs = markdownRuns(body, md, { perRun, fromLength: 0 });
      assert.deepEqual(drawnInRuns(runs), drawnWhole(body), `per run ${perRun}, at ${end}: ${JSON.stringify(body.slice(-40))}`);
    }
});

test("only a long reply is cut, and a run before the last never changes as it streams", () => {
  assert.deepEqual(markdownRuns("Short reply.", md), ["Short reply."]);
  const long = Array.from({ length: 40 }, (_, index) => `Paragraph ${index} ${"word ".repeat(10)}`).join("\n\n");
  assert.ok(long.length > RUNS_FROM_LENGTH);
  const runs = markdownRuns(long, md);
  assert.equal(runs.length, 5);
  // Another word on the last paragraph moves the last run alone.
  const grown = markdownRuns(`${long} more`, md);
  assert.deepEqual(grown.slice(0, -1), runs.slice(0, -1));
  assert.notEqual(grown.at(-1), runs.at(-1));
});

test("a reply that defines a reference link is drawn whole, and line endings are the parser's", () => {
  const body = `${"See [the docs][docs] for more.\n\n".repeat(40)}[docs]: https://example.com/docs`;
  assert.deepEqual(markdownRuns(body, md), [body]);
  const crlf = REPLY.replace(/\n/gu, "\r\n");
  assert.deepEqual(drawnInRuns(markdownRuns(crlf, md, { perRun: 1, fromLength: 0 })), drawnWhole(crlf));
  assert.deepEqual(markdownRuns("", md, { fromLength: 0 }), [""]);
  assert.deepEqual(markdownRuns("\n\n  \n", md, { fromLength: 0 }), ["\n\n  \n"]);
});
