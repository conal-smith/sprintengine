/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const {
  VISIT_LEAVE_DEDUPE_MS,
  VISIT_STAMP_INTERVAL_MS,
  beginSettle,
  confirmSettle,
  failSettle,
  settlesAfterRead,
  visitStampDue,
  withoutSettling,
} = require(path.join(buildRoot, "src/features/conversations/chatLifecycleLogic.js"));

const NOW = 1_800_000_000_000;
const SEC = 1_000;

const stamp = (overrides) =>
  visitStampDue({ trigger: "tick", now: NOW, lastSentAt: null, visitedAt: null, turnEndedAt: null, ...overrides });

test("a chat's first moment on screen is stamped, and then at most every ten seconds", () => {
  assert.equal(VISIT_STAMP_INTERVAL_MS, 10 * SEC);
  assert.equal(stamp({ trigger: "open" }), true);
  assert.equal(stamp({ trigger: "open", lastSentAt: NOW - 3 * SEC }), false, "reopened a moment later: the stamp stands");
  assert.equal(stamp({ lastSentAt: NOW - 9_999 }), false);
  assert.equal(stamp({ lastSentAt: NOW - VISIT_STAMP_INTERVAL_MS }), true);
  // The desktop's own visit clock does not stand in for this phone's throttle:
  // a person reading here is a visit to say, whoever looked last.
  assert.equal(stamp({ trigger: "open", visitedAt: NOW - SEC }), true);
});

test("a turn that ended after the last visit is stamped at once, whatever asked", () => {
  // Ended after this phone's last stamp: the desktop still shows it unseen.
  assert.equal(stamp({ lastSentAt: NOW - 2 * SEC, turnEndedAt: NOW - SEC }), true);
  assert.equal(stamp({ trigger: "open", lastSentAt: NOW - 2 * SEC, turnEndedAt: NOW - SEC }), true);
  // Ended after the desktop's visit clock and with no stamp from here yet.
  assert.equal(stamp({ visitedAt: NOW - 60 * SEC, turnEndedAt: NOW - 30 * SEC }), true);
  // Already covered by a stamp, or by a visit anywhere: the throttle decides.
  assert.equal(stamp({ lastSentAt: NOW - 2 * SEC, turnEndedAt: NOW - 3 * SEC }), false);
  assert.equal(stamp({ lastSentAt: NOW - 2 * SEC, visitedAt: NOW - SEC, turnEndedAt: NOW - 1_500 }), false);
  // A stamp counts from when it went: a second trigger while it is in flight sends nothing.
  assert.equal(stamp({ lastSentAt: NOW, turnEndedAt: NOW }), false);
});

test("leaving stamps once more, unless a stamp went a moment ago", () => {
  assert.equal(stamp({ trigger: "leave", lastSentAt: NOW - 4 * SEC }), true, "the time on screen since the last stamp is said");
  assert.equal(stamp({ trigger: "leave", lastSentAt: NOW - VISIT_LEAVE_DEDUPE_MS + 1 }), false, "a blur and an unmount together send one");
  assert.equal(stamp({ trigger: "leave" }), true);
});

const row = (deviceId, workspaceId, agentId = "a") => ({ deviceId, thread: { workspaceId, agentId } });

test("a settle hides its row at once, and a refusal brings it back", () => {
  const rows = [row("mac", "w1"), row("mac", "w1", "b"), row("mac", "w2"), row("box", "w1")];
  let pending = beginSettle({}, "mac|w1");
  // Every chat in the workspace goes with it; another desktop's w1 does not.
  assert.deepEqual(
    withoutSettling(rows, pending).map((r) => `${r.deviceId}/${r.thread.workspaceId}/${r.thread.agentId}`),
    ["mac/w2/a", "box/w1/a"],
  );
  pending = failSettle(pending, "mac|w1");
  assert.deepEqual(pending, {});
  assert.equal(withoutSettling(rows, pending).length, 4, "restored where it was");
  assert.equal(failSettle(pending, "mac|w1"), pending, "nothing to undo is no change");
});

test("a confirmed settle stays hidden until a list read that set out after it has landed", () => {
  let pending = beginSettle({}, "mac|w1");
  pending = beginSettle(pending, "mac|w2");
  pending = confirmSettle(pending, "mac|w1", NOW);
  assert.deepEqual(pending["mac|w1"], { state: "settled", confirmedAt: NOW });
  // A read already in flight when the desktop confirmed may still list it.
  assert.equal(settlesAfterRead(pending, NOW - SEC), pending);
  // A read that set out after: it is done with. The one still settling stays hidden.
  const after = settlesAfterRead(pending, NOW + SEC);
  assert.deepEqual(Object.keys(after), ["mac|w2"]);
  // A confirm for a settle that already failed brings nothing back to life.
  assert.deepEqual(confirmSettle({}, "mac|w9", NOW), {});
});
