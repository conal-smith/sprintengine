/* global __dirname */
// A chat row's swipe: when a drag is the row's rather than the list's, how far
// the row follows, when a full swipe arms, and where it goes on lifting.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const buildRoot = path.resolve(__dirname, "../../.mobile-test-build");
const {
  SWIPE_ACTION_WIDTH,
  SWIPE_OVERDRAG,
  swipeArmed,
  swipeCaptures,
  swipeCommitDistance,
  swipeOffset,
  swipeRelease,
} = require(path.join(buildRoot, "src/components/swipeRowLogic.js"));

const twoActions = { actionsWidth: 2 * SWIPE_ACTION_WIDTH, rowWidth: 390, fullSwipe: true };

test("a sideways drag to the left is the row's; one more down than across is the list's", () => {
  assert.equal(swipeCaptures(-20, 3, false), true);
  assert.equal(swipeCaptures(-6, 0, false), false, "too short to be anything yet");
  assert.equal(swipeCaptures(-20, 18, false), false, "a scroll that drifts sideways stays a scroll");
  assert.equal(swipeCaptures(20, 0, false), false, "a shut row has nothing to the right");
  assert.equal(swipeCaptures(20, 0, true), true, "an open row can be pushed shut");
});

test("the row follows the finger, with a little give past shut and, without a full swipe, past open", () => {
  assert.equal(swipeOffset(0, -50, twoActions), -50);
  assert.equal(swipeOffset(-160, -40, twoActions), -200);
  assert.equal(swipeOffset(0, -1000, twoActions), -390, "no further than the row is wide");
  assert.ok(swipeOffset(0, 400, twoActions) <= SWIPE_OVERDRAG);
  assert.ok(swipeOffset(0, 40, twoActions) > 0 && swipeOffset(0, 40, twoActions) < 40, "a rubber band to the right");
  const noFull = { ...twoActions, fullSwipe: false };
  assert.equal(swipeOffset(0, -1000, noFull), -(noFull.actionsWidth + SWIPE_OVERDRAG));
});

test("a full swipe arms past most of the row, never before every action has shown, and only where it is on", () => {
  const distance = swipeCommitDistance(twoActions);
  assert.ok(distance >= twoActions.actionsWidth);
  assert.equal(swipeArmed(-distance + 1, twoActions), false);
  assert.equal(swipeArmed(-distance, twoActions), true);
  // A narrow row still shows every action before a full swipe arms.
  const narrow = { actionsWidth: 160, rowWidth: 200, fullSwipe: true };
  assert.ok(swipeCommitDistance(narrow) > narrow.actionsWidth);
  assert.equal(swipeArmed(-1000, { ...twoActions, fullSwipe: false }), false);
});

test("lifting the finger commits, opens or shuts", () => {
  assert.equal(swipeRelease(-swipeCommitDistance(twoActions), 0, twoActions), "commit");
  assert.equal(swipeRelease(-100, 0, twoActions), "open", "past half the actions");
  assert.equal(swipeRelease(-60, 0, twoActions), "shut");
  assert.equal(swipeRelease(-30, -1, twoActions), "open", "a quick throw to the left");
  assert.equal(swipeRelease(-150, 1, twoActions), "shut", "a quick throw to the right");
});
