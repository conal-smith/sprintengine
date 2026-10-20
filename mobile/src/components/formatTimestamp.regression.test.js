/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const buildRoot = path.resolve(__dirname, "../../.mobile-test-build");
const { formatTimestamp } = require(path.join(buildRoot, "src/components/formatTimestamp.js"));

// Four screens each carried a copy of this with a different fallback word.
// Consolidating them changed what the user reads on a snapshot with a missing or
// broken timestamp, so the two failure words are pinned here: they are the whole
// reason the four copies could not simply be deleted in favour of one of them.
test("a timestamp the desktop never sent reads as missing, not as a guess", () => {
  assert.equal(formatTimestamp(undefined), "Unavailable");
  assert.equal(formatTimestamp(null), "Unavailable");
  assert.equal(formatTimestamp(""), "Unavailable");
  // "recently" was one of the retired fallbacks. It claims a fact the snapshot
  // does not carry, and must never come back.
  assert.notEqual(formatTimestamp(undefined), "recently");
});

test("a timestamp the desktop sent that will not parse reads as broken", () => {
  assert.equal(formatTimestamp("not-a-date"), "Unknown");
  assert.equal(formatTimestamp("2026-13-45T99:99:99Z"), "Unknown");
});

test("missing and broken stay distinguishable from each other", () => {
  assert.notEqual(formatTimestamp(undefined), formatTimestamp("not-a-date"));
});

test("a valid ISO timestamp renders as a relative age, not the raw input", () => {
  const iso = "2026-07-08T16:34:22Z";
  const now = new Date(iso).getTime();

  // The `now` argument makes the relative math deterministic under test.
  assert.equal(formatTimestamp(iso, now + 10_000), "just now");
  assert.equal(formatTimestamp(iso, now + 5 * 60_000), "5m ago");
  assert.equal(formatTimestamp(iso, now + 3 * 3_600_000), "3h ago");
  assert.equal(formatTimestamp(iso, now + 2 * 86_400_000), "2d ago");
  assert.equal(formatTimestamp(iso, now + 3 * 7 * 86_400_000), "3w ago");
  // A future timestamp (clock skew) never reads as negative.
  assert.equal(formatTimestamp(iso, now - 60_000), "just now");

  const formatted = formatTimestamp(iso, now + 60_000);
  assert.notEqual(formatted, iso);
  assert.notEqual(formatted, "Unavailable");
  assert.notEqual(formatted, "Unknown");
});
