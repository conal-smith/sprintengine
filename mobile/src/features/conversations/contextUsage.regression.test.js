/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// The context ring's reading, from `usage_updated`: `contextWindow` and
// `contextUsed` where the desktop sends them (ACP already does), else the
// latest report's input plus output, never a sum across turns. No window, no
// ring.

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const {
  CONTEXT_RING_WARN_PERCENTAGE,
  applyContextEvent,
  contextRingLabel,
  contextRingValue,
} = require(path.join(buildRoot, "src/features/conversations/contextUsage.js"));
const { projectConversation } = require(path.join(buildRoot, "src/features/conversations/conversationLogic.js"));

const usage = (payload) => ({ type: "usage_updated", payload });
const fold = (events) => events.reduce(applyContextEvent, null);

test("contextWindow and contextUsed are read as they are sent", () => {
  assert.deepEqual(fold([usage({ contextWindow: 200_000, contextUsed: 76_000 })]), { used: 76_000, window: 200_000 });
});

test("without contextUsed, used is the latest report's input plus output, not a sum across turns", () => {
  const reading = fold([
    usage({ contextWindow: 200_000, inputTokens: 40_000, outputTokens: 1_000 }),
    usage({ inputTokens: 60_000, outputTokens: 2_000 }),
  ]);
  assert.deepEqual(reading, { used: 62_000, window: 200_000 }, "the window holds; used is the second report's alone");
});

test("a report that names no count (the prompt cache's own) leaves the reading as it was", () => {
  const before = fold([usage({ contextWindow: 200_000, contextUsed: 76_000 })]);
  assert.equal(applyContextEvent(before, usage({ promptCache: { cached: true } })), before);
  assert.equal(applyContextEvent(null, usage({ promptCache: { cached: true } })), null);
});

test("a compaction gives context back: its after-size, else unknown until the next report", () => {
  const before = fold([usage({ contextWindow: 200_000, contextUsed: 180_000 })]);
  assert.deepEqual(applyContextEvent(before, { type: "context_compacted", payload: { postTokens: 20_000 } }), {
    used: 20_000,
    window: 200_000,
  });
  const unknown = applyContextEvent(before, { type: "context_compacted", payload: {} });
  assert.equal(contextRingValue(unknown), null, "no ring until a report says how much is left");
});

test("a handoff starts a new session, whose size is unknown until it reports", () => {
  const before = fold([usage({ contextWindow: 1_000_000, contextUsed: 221_000 })]);
  const after = applyContextEvent(before, { type: "context_handed_off", payload: { path: "/Users/dev/handoff.md" } });
  assert.deepEqual(after, { used: null, window: 1_000_000 });
  assert.equal(contextRingValue(after), null);
});

test("bad numbers are ignored rather than drawn", () => {
  assert.deepEqual(fold([usage({ contextWindow: -1, contextUsed: "lots", inputTokens: 5 })]), { used: 5, window: null });
  assert.deepEqual(fold([usage({ contextWindow: 0, contextUsed: 10 })]), { used: 10, window: null });
});

test("no window, no ring; past 80% the ring warns", () => {
  assert.equal(contextRingValue(fold([usage({ inputTokens: 1_000, outputTokens: 10 })])), null);
  assert.equal(contextRingValue(null), null);
  assert.deepEqual(contextRingValue({ used: 76_000, window: 200_000 }), { used: 76_000, total: 200_000, percentage: 38, high: false });
  assert.equal(CONTEXT_RING_WARN_PERCENTAGE, 80);
  assert.equal(contextRingValue({ used: 160_000, window: 200_000 }).high, true);
  assert.equal(contextRingValue({ used: 400_000, window: 200_000 }).percentage, 100, "clamped");
});

test("the long press says the tokens and nothing else", () => {
  assert.equal(contextRingLabel({ used: 76_000, total: 200_000 }), "76,000 / 200,000 tokens");
  assert.equal(contextRingLabel({ used: 950, total: 1_000_000 }), "950 / 1,000,000 tokens");
});

test("the projection carries the reading, so the chat's strip reads it off the hook", () => {
  const event = (seq, type, payload) => ({ id: `e${seq}`, seq, sessionId: "s", workspaceId: "w", type, createdAt: seq, payload });
  const projected = projectConversation([
    event(1, "turn_started", { turnId: "t" }),
    event(2, "usage_updated", { turnId: "t", inputTokens: 70_000, outputTokens: 6_000, contextWindow: 200_000 }),
    event(3, "turn_completed", { turnId: "t", checkpointSummary: { files: 2, addedLines: 3, removedLines: 1 } }),
  ]);
  assert.deepEqual(projected.context, { used: 76_000, window: 200_000 });
  assert.equal(projected.changedTurns.length, 1);
  assert.deepEqual(projected.changedTurns[0].changes, { files: 2, addedLines: 3, removedLines: 1 });
});
