const assert = require("node:assert/strict");
const { test } = require("node:test");
const { projectConversation } = require("../../../.mobile-test-build/src/features/conversations/conversationLogic.js");
const {
  chatOpenedSince,
  unreadDividerRowId,
  unreadDividerTurn,
} = require("../../../.mobile-test-build/src/features/conversations/unreadDivider.js");

// Clocks in plain numbers: the events' `createdAt` is their second argument.
let sequence = 0;
function event(type, createdAt, payload = {}) {
  sequence += 1;
  return { id: `event-${sequence}`, seq: sequence, sessionId: "session", workspaceId: "ws", agentId: "agent", createdAt, type, payload };
}
// One exchange: the person's message, then the agent's turn with a step and a
// reply, ended at `end` (or still running when `end` is null).
function exchange(turnId, start, end, extra = []) {
  const events = [
    event("user_message", start, { turnId, text: `ask ${turnId}` }),
    event("turn_started", start, { turnId }),
    ...extra,
    event("tool_started", start + 1, { turnId, toolUseId: `${turnId}-read`, name: "Read", input: { path: "a.ts" } }),
    event("tool_output", start + 2, { turnId, toolUseId: `${turnId}-read`, output: "…" }),
    event("content_delta", start + 3, { turnId, text: `answer ${turnId}` }),
  ];
  if (end !== null) events.push(event("turn_completed", end, { turnId, durationMs: end - start }));
  return events;
}
const divider = (events, opened) => {
  const projected = projectConversation(events);
  return unreadDividerRowId(projected.rows, unreadDividerTurn(projected.replies, opened));
};

test("the divider goes above the first reply that finished after the chat was last seen", () => {
  const events = [...exchange("t1", 100, 110), ...exchange("t2", 200, 210), ...exchange("t3", 300, 310)];
  const rows = projectConversation(events).rows;
  // Seen after t1 ended, before t2 did: t2's reply is the first one new.
  const id = divider(events, { openedAt: 1_000, seenAt: 150 });
  assert.equal(id, "fold:t2");
  // Above the reply's start, never inside its folded work, and below the person's own message.
  const at = rows.findIndex((row) => row.id === id);
  assert.equal(rows[at - 1].kind, "message");
  assert.equal(rows[at - 1].role, "user");
});

test("nothing new, nothing read, or no visit clock: no divider", () => {
  const events = [...exchange("t1", 100, 110), ...exchange("t2", 200, 210)];
  // Seen after everything ended.
  assert.equal(divider(events, { openedAt: 1_000, seenAt: 500 }), null);
  // Seen before any reply: the whole chat is new, and "New" above all of it says nothing.
  assert.equal(divider(events, { openedAt: 1_000, seenAt: 50 }), null);
  // Never seen anywhere, or a desktop that lists no visits.
  assert.equal(divider(events, { openedAt: 1_000, seenAt: null }), null);
});

test("the person's own messages never count, only an agent's reply", () => {
  // The person wrote at 300, after the visit; the agent has not answered yet.
  const events = [...exchange("t1", 100, 110), event("user_message", 300, { text: "and another thing" })];
  assert.equal(divider(events, { openedAt: 1_000, seenAt: 150 }), null);
});

test("it holds its row while a reply streams, and a reply that starts or ends in view never takes it", () => {
  const opened = { openedAt: 1_000, seenAt: 150 };
  const before = [...exchange("t1", 100, 110), ...exchange("t2", 200, 210), ...exchange("t3", 900, null)];
  assert.equal(divider(before, opened), "fold:t2");
  // t3 streams on and finishes in view, and t4 starts after the opening.
  const after = [
    ...before,
    event("content_delta", 1_100, { turnId: "t3", text: " more" }),
    event("turn_completed", 1_200, { turnId: "t3" }),
    ...exchange("t4", 1_300, 1_400),
  ];
  assert.equal(divider(after, opened), "fold:t2");

  // With t1 the only one seen, a reply that was running at the opening and
  // began after the visit is the new one; finishing in view does not move it.
  const watched = { openedAt: 1_000, seenAt: 500 };
  const running = [...exchange("t1", 100, 110), ...exchange("t2", 900, null)];
  assert.equal(divider(running, watched), "fold:t2");
  assert.equal(divider([...running, event("turn_completed", 1_050, { turnId: "t2" })], watched), "fold:t2");
  // One already under way when the person last looked is one they watched begin.
  const underWay = [...exchange("t1", 100, 110), ...exchange("t2", 400, null)];
  assert.equal(divider(underWay, watched), null);
  // Nor does a reply that began only after the opening, even once it ends.
  const later = [...exchange("t1", 100, 110), ...exchange("t2", 1_100, 1_200)];
  assert.equal(divider(later, { openedAt: 1_000, seenAt: 150 }), null);
});

test("a compaction on the way into the new turn goes below the divider", () => {
  const events = [
    ...exchange("t1", 100, 110),
    ...exchange("t2", 200, 210, [event("context_compacted", 200, { turnId: "t2", trigger: "auto" })]),
  ];
  const rows = projectConversation(events).rows;
  const id = divider(events, { openedAt: 1_000, seenAt: 150 });
  assert.equal(rows.find((row) => row.id === id).kind, "compaction");
  assert.equal(rows[rows.findIndex((row) => row.id === id) + 1].id, "fold:t2");
});

test("a reply with no steps lands on its prose, and a turn with no row yet waits for one", () => {
  const events = [
    ...exchange("t1", 100, 110),
    event("user_message", 200, { text: "thanks" }),
    event("turn_started", 200, { turnId: "t2" }),
    event("content_delta", 201, { turnId: "t2", text: "You're welcome." }),
    event("turn_completed", 202, { turnId: "t2" }),
  ];
  const id = divider(events, { openedAt: 1_000, seenAt: 150 });
  assert.equal(projectConversation(events).rows.find((row) => row.id === id).text, "You're welcome.");
  assert.equal(unreadDividerRowId(projectConversation(events).rows, "t9"), null);
  assert.equal(unreadDividerRowId(projectConversation(events).rows, null), null);
});

test("the reading is the later of the thread opened with and the list's, and a missing clock says nothing", () => {
  assert.deepEqual(chatOpenedSince([{ lastVisitedAt: 100 }, { lastVisitedAt: 250 }], 1_000), { openedAt: 1_000, seenAt: 250 });
  assert.deepEqual(chatOpenedSince([{ lastVisitedAt: 300 }, undefined], 1_000), { openedAt: 1_000, seenAt: 300 });
  assert.deepEqual(chatOpenedSince([{}, null], 1_000), { openedAt: 1_000, seenAt: null });
  assert.deepEqual(chatOpenedSince([{ lastVisitedAt: Number.NaN }], 1_000), { openedAt: 1_000, seenAt: null });
});

test("the projection lists each answered turn's clocks, oldest first", () => {
  const { replies } = projectConversation([...exchange("t1", 100, 110), ...exchange("t2", 200, null)]);
  assert.deepEqual(replies, [
    { turn: "t1", startedAt: 100, endedAt: 110, streaming: false },
    { turn: "t2", startedAt: 200, streaming: true },
  ]);
});

test("a reply that opens by thinking takes the divider above its thought", () => {
  const events = [
    ...exchange("t1", 100, 110),
    event("user_message", 200, { text: "and?" }),
    event("turn_started", 200, { turnId: "t2" }),
    event("reasoning_delta", 201, { turnId: "t2", text: "Consider it." }),
    event("content_delta", 202, { turnId: "t2", text: "Here." }),
    event("turn_completed", 203, { turnId: "t2" }),
  ];
  const id = divider(events, { openedAt: 1_000, seenAt: 150 });
  assert.equal(projectConversation(events).rows.find((row) => row.id === id).kind, "reasoning");
});
