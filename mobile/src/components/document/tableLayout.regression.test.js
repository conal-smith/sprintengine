/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const { computeColumnWidths } = require(path.join(buildRoot, "src/components/document/tableLayout.js"));

// `spacing.sm * 2`, the th/td horizontal padding MarkdownDocument passes in.
const cellPadding = 16;

// The AST shape `react-native-markdown-display` builds: a cell's own `content` is
// empty and its text hangs off `inline` → `text` children, and `index` is the
// sibling position (node_modules/react-native-markdown-display/src/lib/util/tokensToAST.js).
const cell = (type, text) => ({ type, content: "", children: [{ type: "inline", content: "", children: [{ type: "text", content: text }] }] });
const th = (text) => cell("th", text);
const td = (text) => cell("td", text);
const tr = (cells) => ({ type: "tr", children: cells });
const table = ([header, ...body]) => ({
  type: "table",
  children: [
    { type: "thead", children: [header] },
    { type: "tbody", children: body },
  ],
});

const text = (length) => "x".repeat(length);

test("one width per column index, even when the rows are ragged", () => {
  const widths = computeColumnWidths(table([tr([th("a"), th("b"), th("c")]), tr([td("d"), td("e")]), tr([td("f"), td("g"), td("h"), td("i"), td("j")])]), cellPadding);

  assert.equal(widths.length, 5, "the widest row decides how many columns exist");
  for (let column = 0; column < widths.length; column += 1) {
    assert.equal(typeof widths[column], "number", `column ${column} must have a width, not a hole`);
  }
});

test("a column is as wide as its widest cell, across every row", () => {
  const short = computeColumnWidths(table([tr([th(text(10))]), tr([td(text(10))])]), cellPadding)[0];
  const widened = computeColumnWidths(table([tr([th(text(10))]), tr([td(text(10))]), tr([td(text(28))])]), cellPadding)[0];

  assert.ok(widened > short, "a long cell in a late row must widen the whole column");
  assert.equal(widened, Math.ceil(28 * 7.1) + cellPadding);
});

test("header cells are weighted wider than body cells of the same length", () => {
  // 600-weight text runs ~8% wider, so a header of the same length must not be
  // the cell that wraps.
  const headed = computeColumnWidths(table([tr([th(text(20))]), tr([td(text(20))])]), cellPadding)[0];
  const bodyOnly = computeColumnWidths(table([tr([td(text(20))]), tr([td(text(20))])]), cellPadding)[0];

  assert.equal(bodyOnly, Math.ceil(20 * 7.1) + cellPadding);
  assert.equal(headed, Math.ceil(20 * 7.1 * 1.08) + cellPadding);
  assert.ok(headed > bodyOnly);
});

test("widths clamp to the legible minimum and the wrap maximum", () => {
  const [narrow, wide] = computeColumnWidths(table([tr([th("#"), th("Pair")]), tr([td("1"), td(text(400))])]), cellPadding);

  assert.equal(narrow, 72, "a one-character column still has to be readable");
  assert.equal(wide, 240, "a paragraph-length cell wraps rather than pushing the table off the phone");
});

test("a th and a td at the same column index resolve to one width", () => {
  // This is the whole fix: the cell reads `widths[columnIndex]`, so the header and
  // the value below it cannot disagree, whatever either one contains.
  const widths = computeColumnWidths(table([tr([th("Before"), th(text(24))]), tr([td(text(24)), td("3.66")])]), cellPadding);

  assert.equal(widths.length, 2);
  assert.notEqual(widths[0], widths[1], "the two columns differ, so a shared width would be a false pass");
  // every cell at index 1 — the long header and the short `3.66` — reads widths[1]
  assert.equal(widths[1], Math.ceil(24 * 7.1 * 1.08) + cellPadding);
});

/**
 * A pipe table from a design-token contrast report, kept verbatim: five
 * columns, two of them short numbers between two long prose columns.
 */
const REPORT = `
| # | Pair | Before | After | Fix |
|---|---|---|---|---|
| 1 | toneError on toneErrorSoft over bgApp | 3.66 | 4.59 | Herbarium \`toneError\` #b82020 → #9c1818 |
| 2 | toneError on toneErrorSoft over bgSurface | 4.39 | 5.50 | (same) |
| 3 | textMuted on accentPrimarySoft over bgApp | 4.02 | 4.81 | new opaque \`bgSurfaceSelected\` |
| 4 | textSubtle on accentPrimarySoft over bgApp | 4.22 | 5.06 | (same) |
| 5 | toneError on accentPrimarySoft over bgApp | 3.89 | 5.95 | (same, plus #9c1818) |
`;

function readReportTable() {
  const lines = REPORT.split("\n");
  const header = lines.findIndex((line) => line.startsWith("| # | Pair | Before | After | Fix |"));
  assert.ok(header !== -1, "expected the 5-column contrast table");

  // header, then the `|---|` delimiter, then five body rows
  return [lines[header], ...lines.slice(header + 2, header + 7)].map((line) =>
    line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((value) => value.trim()),
  );
}

// A real report table that once rendered broken: `3.66` showed under the `After` header.
test("the 5-column contrast report table yields five columns", () => {
  const rows = readReportTable();
  assert.equal(rows.length, 6, "one header row and five body rows");

  const widths = computeColumnWidths(table([tr(rows[0].map(th)), ...rows.slice(1).map((row) => tr(row.map(td)))]), cellPadding);

  //  #    Pair   Before  After  Fix
  assert.deepEqual(widths, [72, 240, 72, 72, 240]);
  assert.equal(widths[2], widths[3], "Before and After are the same shape, so they get the same column");
});
