const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  STUDIO_NOTICE_PREFIX,
  readMessageOrigin,
  withoutStudioNoticePrefix,
} = require("../../../.mobile-test-build/src/features/conversations/studioNotice.js");
const { projectConversation } = require("../../../.mobile-test-build/src/features/conversations/conversationLogic.js");
const {
  chatOpenedSince,
  unreadDividerRowId,
  unreadDividerTurn,
} = require("../../../.mobile-test-build/src/features/conversations/unreadDivider.js");
const { chatSections } = require("../../../.mobile-test-build/src/features/conversations/conversationListLogic.js");

let sequence = 0;
function event(type, createdAt, payload = {}) {
  sequence += 1;
  return { id: `event-${sequence}`, seq: sequence, sessionId: "session", workspaceId: "ws", agentId: "agent", createdAt, type, payload };
}
// One exchange opened by `message` (the person's words, or Studio's with an
// origin), then the agent's turn with a step and a reply.
function exchange(turnId, start, end, message) {
  return [
    event("user_message", start, { turnId, ...message }),
    event("turn_started", start, { turnId }),
    event("tool_started", start + 1, { turnId, toolUseId: `${turnId}-read`, name: "Read", input: { path: "a.ts" } }),
    event("tool_output", start + 2, { turnId, toolUseId: `${turnId}-read`, output: "…" }),
    event("content_delta", start + 3, { turnId, text: `answer ${turnId}` }),
    event("turn_completed", end, { turnId, durationMs: end - start }),
  ];
}
const RESUME = { text: `${STUDIO_NOTICE_PREFIX} Continue where you left off — your usage limit has reset.`, origin: { kind: "studio", reason: "usage-resume" } };

test("a message without an origin is the person's; a studio origin is Studio's, with its reason when it is known", () => {
  assert.equal(readMessageOrigin(undefined), null);
  assert.deepEqual(readMessageOrigin({ kind: "studio" }), { kind: "studio" });
  assert.deepEqual(readMessageOrigin({ kind: "studio", reason: "agent-notice" }), { kind: "studio", reason: "agent-notice" });
  assert.deepEqual(readMessageOrigin({ kind: "studio", reason: "usage-resume" }), { kind: "studio", reason: "usage-resume" });
  // A reason a newer desktop sends is still Studio's; only the reason is dropped.
  assert.deepEqual(readMessageOrigin({ kind: "studio", reason: "nightly-digest" }), { kind: "studio" });
  assert.deepEqual(readMessageOrigin({ kind: "studio", reason: 7 }), { kind: "studio" });
});

test("an origin in any other shape is the person's message, as before the member existed", () => {
  for (const value of [null, "studio", 1, true, [], [{ kind: "studio" }], {}, { kind: "Studio" }, { kind: "person" }, { reason: "agent-notice" }])
    assert.equal(readMessageOrigin(value), null, JSON.stringify(value));
});

test("the row leaves out the name Studio's words open with, and nothing else", () => {
  assert.equal(withoutStudioNoticePrefix(RESUME.text), "Continue where you left off — your usage limit has reset.");
  assert.equal(withoutStudioNoticePrefix(`  ${STUDIO_NOTICE_PREFIX}\nAgent audit finished.`), "Agent audit finished.");
  // Only at the start: the name quoted later stays, and so does text without it.
  assert.equal(withoutStudioNoticePrefix(`It said ${STUDIO_NOTICE_PREFIX} first.`), `It said ${STUDIO_NOTICE_PREFIX} first.`);
  assert.equal(withoutStudioNoticePrefix("[SprintEngine] hello"), "[SprintEngine] hello");
});

test("Studio's message is its own row, never the person's bubble", () => {
  const events = [
    ...exchange("t1", 100, 110, { text: "Launch an agent to audit pairing." }),
    ...exchange("t2", 200, 210, {
      text: `${STUDIO_NOTICE_PREFIX} Agent audit, which you launched, finished its turn.`,
      origin: { kind: "studio", reason: "agent-notice" },
      // Files on Studio's message are no person's cards.
      files: [{ path: "/Users/dev/notes.pdf" }],
    }),
    ...exchange("t3", 300, 310, { text: RESUME.text, origin: { kind: "studio", reason: "later-reason" } }),
  ];
  const { rows } = projectConversation(events);
  const people = rows.filter((row) => row.kind === "message" && row.role === "user");
  assert.deepEqual(people.map((row) => row.text), ["Launch an agent to audit pairing."]);
  const studio = rows.filter((row) => row.kind === "studio");
  assert.deepEqual(
    studio.map(({ text, reason, turn }) => ({ text, reason, turn })),
    [
      { text: "Agent audit, which you launched, finished its turn.", reason: "agent-notice", turn: "t2" },
      { text: "Continue where you left off — your usage limit has reset.", reason: undefined, turn: "t3" },
    ],
  );
  assert.ok(studio.every((row) => !("files" in row) && !("role" in row)));
  // A malformed origin leaves the message the person's, with its words as written.
  const odd = projectConversation(exchange("t4", 400, 410, { text: "mine", origin: "studio" })).rows;
  assert.equal(odd[0].kind, "message");
  assert.equal(odd[0].role, "user");
});

test("Studio's message still opens a turn: the chat works, and a send it acknowledges leaves the queue", () => {
  const projected = projectConversation([event("user_message", 100, { turnId: "t1", commandId: "cmd-1", ...RESUME })]);
  assert.equal(projected.turnBusy, true);
  assert.ok(projected.acknowledged.has("cmd-1"));
});

test("the New divider stands above Studio's message that opened the unseen turn, never above the person's", () => {
  const studioTurn = [
    ...exchange("t1", 100, 110, { text: "ask t1" }),
    ...exchange("t2", 200, 210, RESUME),
  ];
  const opened = { openedAt: 1_000, seenAt: 150 };
  const projected = projectConversation(studioTurn);
  const id = unreadDividerRowId(projected.rows, unreadDividerTurn(projected.replies, opened));
  const studio = projected.rows.find((row) => row.kind === "studio");
  assert.equal(id, studio.id);
  // The same turn opened by the person: the divider stays at the reply, under their message.
  const personTurn = [...exchange("t1", 100, 110, { text: "ask t1" }), ...exchange("t2", 200, 210, { text: "ask t2" })];
  const person = projectConversation(personTurn);
  assert.equal(unreadDividerRowId(person.rows, unreadDividerTurn(person.replies, opened)), "fold:t2");
  // A Studio row of another turn just above a reply is not walked over.
  const rows = [
    { kind: "studio", id: "s1", text: "earlier", at: 1, turn: "t1" },
    { kind: "message", id: "t2:r", role: "assistant", text: "reply", at: 2, turn: "t2" },
  ];
  assert.equal(unreadDividerRowId(rows, "t2"), "t2:r");
  // Studio's message alone, with no reply yet, is not new on its own.
  const pending = projectConversation([...exchange("t1", 100, 110, { text: "ask t1" }), event("user_message", 300, { turnId: "t2", ...RESUME })]);
  assert.equal(unreadDividerTurn(pending.replies, chatOpenedSince([{ lastVisitedAt: 150 }], 1_000)), null);
});

test("the list orders by the person's last message, which a Studio resume does not move", () => {
  const NOW = 10 * 24 * 3_600_000;
  const MIN = 60_000;
  const row = (agentId, thread) => ({
    deviceId: "dev",
    desktopName: "Desktop",
    projectName: null,
    lifecycle: true,
    settleable: true,
    thread: { workspaceId: agentId, agentId, title: agentId, phase: "completed", createdAt: NOW - 600 * MIN, providerId: "claude-code", modelId: "default", turnCount: 1, ...thread },
  });
  // Studio resumed "resumed" a minute ago, which moved its `updatedAt` and
  // its turn's end; the person last wrote in it three hours ago. The desktop's
  // `lastUserMessageAt` leaves Studio's message out, and the list reads only that.
  const resumed = row("resumed", { lastUserMessageAt: NOW - 180 * MIN, updatedAt: NOW - MIN, lastTurnEndedAt: NOW - MIN });
  const written = row("written", { lastUserMessageAt: NOW - 20 * MIN, updatedAt: NOW - 15 * MIN, lastTurnEndedAt: NOW - 15 * MIN });
  assert.deepEqual(chatSections([resumed, written], NOW).recent.map((entry) => entry.thread.agentId), ["written", "resumed"]);
});
