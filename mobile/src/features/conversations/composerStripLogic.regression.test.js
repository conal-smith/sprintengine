/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// The strip under the composer: always one line. Only the branch shrinks, and
// from the front, dropping whole leading segments before it cuts a word; then
// items leave for the "⋮" in a fixed order (branch → diff → machine), and the
// ring never does.

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const {
  ELLIPSIS,
  MIN_BRANCH_CHARS,
  STRIP_DROP_ORDER,
  conversationChanges,
  diffPill,
  diffPillLabel,
  frontTruncateBranch,
  layoutComposerStrip,
} = require(path.join(buildRoot, "src/features/conversations/composerStripLogic.js"));

test("a branch truncates from the front, a whole leading segment at a time", () => {
  assert.equal(frontTruncateBranch("fix/cli-update-output", 40), "fix/cli-update-output", "it fits: whole");
  assert.equal(frontTruncateBranch("fix/cli-update-output", 20), `${ELLIPSIS}cli-update-output`, "the reference example");
  // The segments go one at a time (the floor set aside to show the steps).
  assert.equal(frontTruncateBranch("feat/a/b-c", 9, 0), `${ELLIPSIS}a/b-c`);
  assert.equal(frontTruncateBranch("feat/a/b-c", 5, 0), `${ELLIPSIS}b-c`);
  assert.equal(frontTruncateBranch("feat/a/b-c", 3, 0), `${ELLIPSIS}-c`);
  // Above the floor, "feat/alpha/beta-gamma" drops "feat/", then "alpha/".
  assert.equal(frontTruncateBranch("feat/alpha/beta-gamma", 20), `${ELLIPSIS}alpha/beta-gamma`);
  assert.equal(frontTruncateBranch("feat/alpha/beta-gamma", 15), `${ELLIPSIS}beta-gamma`);
  assert.equal(frontTruncateBranch("feat/alpha/beta-gamma", 11), `${ELLIPSIS}beta-gamma`);
});

test("only a last segment too long alone is cut mid-word, keeping its end", () => {
  assert.equal(frontTruncateBranch("fix/cli-update-output", 12), `${ELLIPSIS}date-output`);
  assert.equal(frontTruncateBranch("a-very-long-branch-name-without-slashes", 14), `${ELLIPSIS}thout-slashes`);
  for (const width of [10, 11, 12, 13, 17]) {
    const label = frontTruncateBranch("feat/some-long-branch-name", width);
    assert.ok(label.length <= width, `${label} is no longer than ${width}`);
    assert.ok(label.startsWith(ELLIPSIS));
    assert.ok("feat/some-long-branch-name".endsWith(label.slice(1)), "the end is kept");
  }
});

test("below the floor the branch does not shrink further: it leaves the line", () => {
  assert.equal(MIN_BRANCH_CHARS, 10);
  assert.equal(frontTruncateBranch("fix/cli-update-output", MIN_BRANCH_CHARS - 1), null);
  assert.equal(frontTruncateBranch("main", 4), "main", "a short branch that fits is never refused");
});

// A strip at phone scale: an 8pt monospace advance, a 22pt machine glyph, a
// 70pt pill, a 32pt "⋮" and a 32pt ring, 4pt apart.
const CHAR = 8;
const entries = (branch = "fix/cli-update-output") => [
  { kind: "item", id: "machine", width: 22, drop: STRIP_DROP_ORDER.machine },
  { kind: "branch", id: "branch", text: branch, charWidth: CHAR, chromeWidth: 16, drop: STRIP_DROP_ORDER.branch },
  { kind: "item", id: "diff", width: 70, drop: STRIP_DROP_ORDER.diff },
];
const layout = (width, extra = {}) =>
  layoutComposerStrip({ width, gap: 4, entries: entries(), pinnedWidth: 32, overflowWidth: 32, ...extra });
// Everything whole: 22 + (16 + 21·8) + 70 + 32 + 3 gaps of 4.
const FULL = 22 + 16 + 21 * CHAR + 70 + 32 + 3 * 4;

test("the drop order is branch, then diff, then the machine glyph, then New's Worktree; the ring is not in it", () => {
  assert.deepEqual(STRIP_DROP_ORDER, { branch: 1, diff: 2, machine: 3, worktree: 4 });
  assert.ok(!("ring" in STRIP_DROP_ORDER));
});

test("with room, everything is on the line, the branch whole, and no ⋮", () => {
  assert.deepEqual(layout(FULL), {
    visible: ["machine", "branch", "diff"],
    hidden: [],
    branchLabel: "fix/cli-update-output",
    overflow: false,
  });
});

test("as the line narrows the branch shrinks from the front first, nothing leaves", () => {
  const narrower = layout(FULL - 3 * CHAR);
  assert.equal(narrower.branchLabel, `${ELLIPSIS}cli-update-output`);
  assert.deepEqual(narrower.hidden, []);
  assert.equal(narrower.overflow, false);
  // One character short of "…cli-update-output", the last segment is cut, keeping its end.
  assert.equal(layout(FULL - 4 * CHAR).branchLabel, `${ELLIPSIS}li-update-output`);
  const cut = layout(FULL - 9 * CHAR);
  assert.equal(cut.branchLabel, `${ELLIPSIS}date-output`);
  assert.deepEqual(cut.hidden, []);
});

test("then the branch leaves, then the diff, then the machine; the ring stays", () => {
  // The branch at its floor: anything narrower moves it to the ⋮.
  const floor = FULL - (21 - MIN_BRANCH_CHARS) * CHAR;
  assert.equal(layout(floor).branchLabel?.length, MIN_BRANCH_CHARS);
  const noBranch = layout(floor - 1);
  assert.deepEqual(noBranch, { visible: ["machine", "diff"], hidden: ["branch"], branchLabel: null, overflow: true });
  // machine + diff + ⋮ + ring + 3 gaps = 22 + 70 + 32 + 32 + 12 = 168.
  assert.deepEqual(layout(168).visible, ["machine", "diff"]);
  const noDiff = layout(167);
  assert.deepEqual(noDiff.visible, ["machine"]);
  assert.deepEqual(noDiff.hidden, ["branch", "diff"]);
  // machine + ⋮ + ring + 2 gaps = 94.
  assert.deepEqual(layout(94).visible, ["machine"]);
  const bare = layout(93);
  assert.deepEqual(bare.visible, []);
  assert.deepEqual(bare.hidden, ["machine", "branch", "diff"], "hidden in the line's own order");
  assert.equal(bare.overflow, true, "everything hidden is still reachable");
});

test("the strip never wraps: whatever the width, what is shown fits on one line", () => {
  for (let width = 70; width <= FULL + 40; width += 1) {
    const result = layout(width);
    const shown = entries().filter((entry) => result.visible.includes(entry.id));
    const used =
      shown.reduce((total, entry) => total + (entry.kind === "item" ? entry.width : entry.chromeWidth + result.branchLabel.length * CHAR), 0) +
      (result.overflow ? 32 : 0) +
      32 +
      (shown.length + (result.overflow ? 1 : 0)) * 4;
    if (result.visible.length) assert.ok(used <= width, `${width}: ${used} drawn`);
    assert.equal(result.overflow, result.hidden.length > 0, "the ⋮ only when something is hidden");
    // Items leave in order: once the diff is gone the branch is gone too, and so on.
    if (result.hidden.includes("diff")) assert.ok(result.hidden.includes("branch"));
    if (result.hidden.includes("machine")) assert.ok(result.hidden.includes("diff"));
  }
});

test("a strip with no ring and only some items still drops in order", () => {
  const result = layoutComposerStrip({
    width: 60,
    gap: 4,
    pinnedWidth: 0,
    overflowWidth: 32,
    entries: [{ kind: "item", id: "diff", width: 70, drop: STRIP_DROP_ORDER.diff }],
  });
  assert.deepEqual(result, { visible: [], hidden: ["diff"], branchLabel: null, overflow: true });
  assert.deepEqual(
    layoutComposerStrip({ width: 300, gap: 4, pinnedWidth: 32, overflowWidth: 32, entries: [] }),
    { visible: [], hidden: [], branchLabel: null, overflow: false },
    "the ring alone, and no ⋮",
  );
});

test("the chat's changes add up every turn's, and only checkpointed turns open, newest first", () => {
  assert.equal(conversationChanges([]), null);
  const turns = [
    { id: "a", at: 1, turnSeq: 1, changes: { files: 2, addedLines: 10, removedLines: 2 } },
    { id: "b", at: 2, changes: { files: 1, addedLines: 5, removedLines: 0 } },
    { id: "c", at: 3, turnSeq: 3, changes: { files: 1 } },
  ];
  const changes = conversationChanges(turns);
  assert.equal(changes.files, 4);
  assert.equal(changes.addedLines, 15);
  assert.equal(changes.removedLines, 2);
  assert.deepEqual(changes.openable.map((turn) => turn.id), ["c", "a"]);
});

test("the pill draws a half only for what is there: the four cases", () => {
  const pill = (addedLines, removedLines) => diffPill({ files: 1, addedLines, removedLines, openable: [] });
  assert.deepEqual(pill(3, 2), { kind: "lines", added: 3, removed: 2, label: "3 lines added, 2 removed" });
  assert.deepEqual(pill(3, 0), { kind: "lines", added: 3, removed: null, label: "3 lines added, 0 removed" }, "no −0");
  assert.deepEqual(pill(0, 2), { kind: "lines", added: null, removed: 2, label: "0 lines added, 2 removed" }, "no +0");
  assert.equal(pill(0, 0), null, "nothing to say, no pill");
  assert.equal(diffPill(null), null);
  assert.equal(diffPillLabel(1, 1), "1 line added, 1 removed");
});

test("where no turn counted its lines the pill names the files instead", () => {
  assert.deepEqual(diffPill({ files: 3, addedLines: null, removedLines: null, openable: [] }), {
    kind: "files",
    files: 3,
    label: "3 files changed",
  });
  assert.equal(diffPill({ files: 0, addedLines: null, removedLines: null, openable: [] }), null);
});
