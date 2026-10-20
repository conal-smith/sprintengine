const assert = require("node:assert/strict");
const { test } = require("node:test");
const { projectConversation } = require("../../../.mobile-test-build/src/features/conversations/conversationLogic.js");
const {
  JUMP_SLACK,
  jumpMark,
  jumpToLatest,
  newRepliesSince,
  transcriptScrollable,
} = require("../../../.mobile-test-build/src/features/conversations/jumpToLatest.js");

function event(seq, type, payload) {
  return { id: `event-${seq}`, seq, sessionId: "session", workspaceId: "workspace", agentId: "agent", createdAt: seq, type, payload };
}
// One finished exchange: the person asks, the agent answers in its own turn.
function exchange(seq, turn, words) {
  return [
    event(seq, "user_message", { text: `ask ${turn}` }),
    event(seq + 1, "turn_started", { turnId: turn }),
    event(seq + 2, "content_delta", { turnId: turn, text: words }),
    event(seq + 3, "turn_completed", { turnId: turn }),
  ];
}
// The rows as the screen holds them, with the turn still arriving.
function view(events) {
  const projected = projectConversation(events);
  const live = projected.replies.find((reply) => reply.streaming)?.turn ?? null;
  return { rows: projected.rows, live, busy: projected.turnBusy };
}
const count = (events, mark) => {
  const { rows, live, busy } = view(events);
  return newRepliesSince(rows, mark, live, busy);
};
const markOf = (events) => {
  const { rows, live, busy } = view(events);
  return jumpMark(rows, live, busy);
};

test("replies that finished after the reader left are counted, one per turn", () => {
  const events = [...exchange(1, "a", "First.")];
  const mark = markOf(events);
  assert.equal(mark.reply, "a");
  assert.equal(count(events, mark), 0, "nothing new yet");
  events.push(...exchange(10, "b", "Second."));
  assert.equal(count(events, mark), 1);
  events.push(...exchange(20, "c", "Third."));
  assert.equal(count(events, mark), 2);
});

test("a reply still arriving is not news until it ends", () => {
  const events = [...exchange(1, "a", "First."), event(10, "user_message", { text: "more" }), event(11, "turn_started", { turnId: "b" })];
  const mark = markOf(events);
  events.push(event(12, "content_delta", { turnId: "b", text: "Working on" }));
  assert.equal(count(events, mark), 0, "streaming");
  events.push(event(13, "content_delta", { turnId: "b", text: " it." }), event(14, "turn_completed", { turnId: "b" }));
  assert.equal(count(events, mark), 1, "finished while away");
});

test("leaving mid-reply counts that reply once it finishes", () => {
  const events = [...exchange(1, "a", "First."), event(10, "user_message", { text: "more" }), event(11, "turn_started", { turnId: "b" }), event(12, "content_delta", { turnId: "b", text: "Half" })];
  const mark = markOf(events);
  assert.equal(mark.reply, "a", "the reply arriving is not the one seen");
  events.push(event(13, "turn_completed", { turnId: "b" }));
  assert.equal(count(events, mark), 1);
});

test("a turn whose words are split around its steps counts as one reply", () => {
  const events = [...exchange(1, "a", "First.")];
  const mark = markOf(events);
  events.push(
    event(10, "user_message", { text: "fix it" }),
    event(11, "turn_started", { turnId: "b" }),
    event(12, "content_delta", { turnId: "b", text: "Looking." }),
    event(13, "tool_started", { turnId: "b", toolUseId: "t1", name: "Read", input: { path: "a.ts" } }),
    event(14, "tool_output", { toolUseId: "t1", output: "x" }),
    event(15, "content_delta", { turnId: "b", text: "Fixed." }),
    event(16, "turn_completed", { turnId: "b" }),
  );
  assert.equal(count(events, mark), 1);
});

test("the person's own messages, steps and footers are not replies", () => {
  const events = [...exchange(1, "a", "First.")];
  const mark = markOf(events);
  events.push(event(10, "user_message", { text: "hello?" }), event(11, "command_output", { command: "context", output: "42%" }));
  assert.equal(count(events, mark), 0);
});

test("a page of older history loaded above the mark adds nothing", () => {
  const recent = [...exchange(100, "c", "Third.")];
  const mark = markOf(recent);
  const paged = [...exchange(1, "a", "First."), ...exchange(10, "b", "Second."), ...recent];
  assert.equal(count(paged, mark), 0);
});

test("with no reply finished when the reader left, only what came after the loaded rows counts", () => {
  const events = [event(50, "user_message", { text: "start" }), event(51, "turn_started", { turnId: "x" }), event(52, "content_delta", { turnId: "x", text: "Thinking it over" })];
  const mark = markOf(events);
  assert.equal(mark.reply, null);
  assert.equal(mark.firstRow, "event-50");
  events.push(event(53, "turn_completed", { turnId: "x" }));
  assert.equal(count(events, mark), 1, "the reply that was arriving finished");
  // History above the first row loaded then is not news.
  const paged = [...exchange(1, "a", "Old."), ...events];
  assert.equal(count(paged, mark), 1);
});

test("a mark whose reply has left the transcript calls nothing new", () => {
  const mark = { reply: "gone", firstRow: "event-1" };
  assert.equal(count([...exchange(1, "a", "First."), ...exchange(10, "b", "Second.")], mark), 0);
});

test("the control is offered only while away from the end of a transcript long enough to leave", () => {
  assert.equal(jumpToLatest({ away: false, landed: true, scrollable: true, newReplies: 3 }), null, "following");
  assert.equal(jumpToLatest({ away: true, landed: false, scrollable: true, newReplies: 0 }), null, "still landing");
  assert.equal(jumpToLatest({ away: true, landed: true, scrollable: false, newReplies: 0 }), null, "short list");
  assert.deepEqual(jumpToLatest({ away: true, landed: true, scrollable: true, newReplies: 0 }), {
    label: "Jump to latest",
    accessibilityLabel: "Jump to latest",
  });
  assert.deepEqual(jumpToLatest({ away: true, landed: true, scrollable: true, newReplies: 1 }), {
    label: "1 new reply",
    accessibilityLabel: "1 new reply, jump to latest",
  });
  assert.equal(jumpToLatest({ away: true, landed: true, scrollable: true, newReplies: 2 }).label, "2 new replies");
});

test("a transcript is scrollable only once it runs past the screen by more than the end's slack", () => {
  assert.equal(transcriptScrollable(500, 0), false, "not laid out yet");
  assert.equal(transcriptScrollable(500, 700), false);
  assert.equal(transcriptScrollable(700 + JUMP_SLACK, 700), false);
  assert.equal(transcriptScrollable(701 + JUMP_SLACK, 700), true);
});
