const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  DRAFT_MAX_AGE_MS,
  MAX_DRAFTS,
  MAX_DRAFT_LENGTH,
  draftKey,
  normalizeDrafts,
  withDraft,
} = require("../../../.mobile-test-build/src/features/conversations/composerDrafts.js");

const key = (agentId, deviceId = "desk") => draftKey({ deviceId, workspaceId: "w", agentId });

test("each chat on each desktop keeps its own draft", () => {
  assert.notEqual(key("a"), key("b"));
  assert.notEqual(key("a", "desk"), key("a", "laptop"));
  let drafts = withDraft({}, key("a"), "half a thought", 1);
  drafts = withDraft(drafts, key("b"), "another", 2);
  assert.equal(drafts[key("a")].text, "half a thought");
  assert.equal(drafts[key("b")].text, "another");
});

test("an emptied box forgets its draft, and nothing changed is the same drafts back", () => {
  const drafts = withDraft({}, key("a"), "words", 1);
  assert.equal(withDraft(drafts, key("a"), "words", 5), drafts, "the same words write nothing");
  assert.equal(key("a") in withDraft(drafts, key("a"), "   \n", 2), false, "whitespace is an empty box");
  assert.equal(withDraft({}, key("a"), "", 2).constructor, Object);
  const none = {};
  assert.equal(withDraft(none, key("a"), "", 2), none, "forgetting what was never kept writes nothing");
});

test("only the newest drafts are kept", () => {
  let drafts = {};
  for (let i = 0; i < MAX_DRAFTS + 5; i++) drafts = withDraft(drafts, key(`chat-${i}`), `draft ${i}`, i);
  assert.equal(Object.keys(drafts).length, MAX_DRAFTS);
  assert.equal(key("chat-0") in drafts, false, "the oldest went first");
  assert.equal(drafts[key(`chat-${MAX_DRAFTS + 4}`)].text, `draft ${MAX_DRAFTS + 4}`);
});

test("a draft is cut at the longest message the desktop takes", () => {
  const drafts = withDraft({}, key("a"), "x".repeat(MAX_DRAFT_LENGTH + 10), 1);
  assert.equal(drafts[key("a")].text.length, MAX_DRAFT_LENGTH);
});

test("what was read from disk is drafts: the malformed, the empty and the expired are dropped", () => {
  const now = DRAFT_MAX_AGE_MS + 1_000;
  const read = normalizeDrafts(
    {
      [key("kept")]: { text: "kept", at: now - 10 },
      [key("old")]: { text: "old", at: 0 },
      [key("blank")]: { text: "  ", at: now },
      [key("wrong")]: { text: 4, at: now },
      [key("no-time")]: { text: "x" },
      [key("null")]: null,
    },
    now,
  );
  assert.deepEqual(Object.keys(read), [key("kept")]);
  for (const junk of [null, "drafts", [], 7]) assert.deepEqual(normalizeDrafts(junk, now), {});
});
