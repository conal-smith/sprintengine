const assert = require("node:assert/strict");
const { test } = require("node:test");
const { projectConversation } = require("../../../.mobile-test-build/src/features/conversations/conversationLogic.js");
const { messageCopyText, replyCopyText } = require("../../../.mobile-test-build/src/features/conversations/copyText.js");

function event(seq, type, payload) {
  return { id: `event-${seq}`, seq, sessionId: "session", workspaceId: "workspace", agentId: "agent", createdAt: seq, type, payload };
}
const footer = (rows, turn) => rows.find((row) => row.kind === "meta" && row.turn === turn);

test("a reply copies everything the turn said, in order, as the Markdown written", () => {
  const { rows } = projectConversation([
    event(1, "user_message", { text: "fix the test" }),
    event(2, "turn_started", { turnId: "t" }),
    event(3, "reasoning_delta", { turnId: "t", text: "Look at the fixture." }),
    event(4, "content_delta", { turnId: "t", text: "Reading the test first.\n" }),
    event(5, "tool_started", { turnId: "t", toolUseId: "a", name: "Read", input: { path: "a.ts" } }),
    event(6, "tool_output", { toolUseId: "a", output: "x" }),
    event(7, "content_delta", { turnId: "t", text: "\n\nAll **green**:\n\n```ts\nexpect(a).toBe(1);\n```\n" }),
    event(8, "turn_completed", { turnId: "t" }),
  ]);
  assert.equal(
    replyCopyText(rows, "t"),
    "Reading the test first.\n\nAll **green**:\n\n```ts\nexpect(a).toBe(1);\n```",
    "the words between steps come first, the thinking and the steps never",
  );
  assert.equal(footer(rows, "t").reply, true, "its footer offers the copy");
});

test("a reply's copy is its own turn's, never the person's words or another turn's", () => {
  const { rows } = projectConversation([
    event(1, "user_message", { text: "one" }),
    event(2, "turn_started", { turnId: "a" }),
    event(3, "content_delta", { turnId: "a", text: "First answer." }),
    event(4, "turn_completed", { turnId: "a" }),
    event(5, "user_message", { text: "two" }),
    event(6, "turn_started", { turnId: "b" }),
    event(7, "content_delta", { turnId: "b", text: "Second answer." }),
    event(8, "turn_completed", { turnId: "b" }),
  ]);
  assert.equal(replyCopyText(rows, "a"), "First answer.");
  assert.equal(replyCopyText(rows, "b"), "Second answer.");
  assert.equal(replyCopyText(rows, "missing"), "");
});

test("a turn that said nothing offers no reply to copy", () => {
  const { rows } = projectConversation([
    event(1, "user_message", { text: "run it" }),
    event(2, "turn_started", { turnId: "t" }),
    event(3, "reasoning_delta", { turnId: "t", text: "Just run it." }),
    event(4, "content_delta", { turnId: "t", text: "  \n" }),
    event(5, "tool_started", { turnId: "t", toolUseId: "a", name: "Bash", input: { command: "npm test" } }),
    event(6, "tool_output", { toolUseId: "a", output: "ok" }),
    event(7, "turn_completed", { turnId: "t" }),
  ]);
  const meta = footer(rows, "t");
  assert.equal(meta.turn, "t");
  assert.equal("reply" in meta, false);
  assert.equal(replyCopyText(rows, "t"), "");
});

test("a reply's opening indent survives the copy, its blank lines do not", () => {
  const { rows } = projectConversation([
    event(1, "turn_started", { turnId: "t" }),
    event(2, "content_delta", { turnId: "t", text: "\n\n    indented code\nmore\n\n" }),
    event(3, "turn_completed", { turnId: "t" }),
  ]);
  assert.equal(replyCopyText(rows, "t"), "    indented code\nmore");
});

test("a message copies the person's words exactly, and pictures alone copy nothing", () => {
  assert.equal(messageCopyText("  Fix the *flaky* test\n"), "  Fix the *flaky* test\n");
  assert.equal(messageCopyText(""), "");
  assert.equal(messageCopyText(" \n "), "");
});
