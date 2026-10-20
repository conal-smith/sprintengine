/* global __dirname */
// Mark unread, synced with the desktop: where the phone offers it, the
// `conversation.mark_unread` call and its answers, and how a visit clock the
// desktop moved back is read against this phone's own readings: the list's
// green, the bell's, and the "New" divider.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const {
  listedVisitRewind,
  markUnreadOffered,
  visitRewindApplies,
  withVisitRewind,
} = require(path.join(buildRoot, "src/features/conversations/chatLifecycleLogic.js"));
const { buildChatRows, chatMarkedUnread, chatRowState, chatSeenAt, chatSections } = require(
  path.join(buildRoot, "src/features/conversations/conversationListLogic.js"),
);
const { chatOpenedSince, unreadDividerRowId, unreadDividerTurn } = require(
  path.join(buildRoot, "src/features/conversations/unreadDivider.js"),
);
const { projectConversation } = require(path.join(buildRoot, "src/features/conversations/conversationLogic.js"));
const { createConversationLifecycleApi, readMarkUnreadAnswer } = require(
  path.join(buildRoot, "src/api/conversationLifecycle.js"),
);
const { buildNotices } = require(path.join(buildRoot, "src/features/notices/noticesLogic.js"));
const { declaresChatMarkUnread } = require(path.join(buildRoot, "src/api/tailnetTransport.js"));
const { parseConversationLifecycle } = require(path.join(buildRoot, "src/api/conversationWire.js"));

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const thread = (overrides = {}) => ({
  workspaceId: "w1",
  agentId: "a1",
  title: "Chat",
  phase: "completed",
  updatedAt: NOW - 10 * MIN,
  createdAt: NOW - 60 * MIN,
  providerId: "claude-code",
  lastTurnEndedAt: NOW - 10 * MIN,
  lastVisitedAt: NOW - 5 * MIN,
  ...overrides,
});
const rows = (input) =>
  buildChatRows({ deviceId: "mac", desktopName: "Mac", workspaces: null, lifecycle: true, canOperate: true, ...input });

test("Mark unread is offered only where the desktop advertises chat-mark-unread and this phone operates its chats", () => {
  assert.equal(declaresChatMarkUnread({ tailnetCapabilities: ["conversation-lifecycle", "chat-mark-unread"] }), true);
  assert.equal(declaresChatMarkUnread({ tailnetCapabilities: ["conversation-lifecycle"] }), false, "an older desktop answers Unknown tool");
  assert.equal(declaresChatMarkUnread({}), false, "a desktop that declared nothing is a no");

  const [offered] = rows({ threads: [thread()], markUnread: true });
  assert.equal(offered.canMarkUnread, true);
  assert.equal(markUnreadOffered(offered, { now: NOW }), true);
  const [older] = rows({ threads: [thread()] });
  assert.equal(older.canMarkUnread, false);
  assert.equal(markUnreadOffered(older, { now: NOW }), false);
  const [readOnly] = rows({ threads: [thread()], markUnread: true, canOperate: false });
  assert.equal(markUnreadOffered(readOnly, { now: NOW }), false, "a pairing that may only read its chats marks nothing");
});

test("Mark unread waits for a finished reply, and is not offered on a chat already unread", () => {
  const [nothingFinished] = rows({ threads: [thread({ lastTurnEndedAt: undefined, phase: "running" })], markUnread: true });
  assert.equal(markUnreadOffered(nothingFinished, { now: NOW }), false, "the desktop would refuse it as nothing_finished");
  // Working on its next turn, with an earlier one finished and read: offered.
  const [working] = rows({ threads: [thread({ phase: "running" })], markUnread: true });
  assert.equal(markUnreadOffered(working, { now: NOW }), true);
  // Finished after anyone last looked: it is green already.
  const [unseen] = rows({ threads: [thread({ lastVisitedAt: NOW - 20 * MIN })], markUnread: true });
  assert.equal(markUnreadOffered(unseen, { now: NOW }), false);
  // The phone opened it after the finish: read here, so offered.
  assert.equal(markUnreadOffered(unseen, { now: NOW, openedAt: NOW - MIN }), true);
});

test("mark_unread goes over the gateway's JSON-RPC POST, and its refusal keeps the desktop's words", async (t) => {
  const calls = [];
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let refuse = false;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.authorization, name: body.params.name, args: body.params.arguments });
    const structuredContent = refuse
      ? {
          ok: false,
          error: {
            code: "nothing_finished",
            message: "No agent in this chat has finished anything yet, so there is nothing to mark unread.",
          },
        }
      : { ok: true, workspaceId: body.params.arguments.workspaceId, lastVisitedAt: 41 };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: body.id, result: { structuredContent } }) };
  };
  const api = createConversationLifecycleApi({ baseUrl: "http://desk:7777", deviceToken: "tok" });
  assert.deepEqual(await api.markUnread("w1"), { ok: true, data: { workspaceId: "w1", lastVisitedAt: 41 } });
  assert.deepEqual(calls[0], {
    url: "http://desk:7777/tailnet/v1/mcp",
    auth: "Bearer tok",
    name: "conversation.mark_unread",
    args: { workspaceId: "w1" },
  });
  refuse = true;
  const refused = await api.markUnread("w1");
  assert.equal(refused.ok, false);
  assert.match(refused.message, /nothing to mark unread/);

  // Only the tool's own shape, for the chat that was asked about, counts.
  assert.deepEqual(readMarkUnreadAnswer({ ok: true, workspaceId: "w1", lastVisitedAt: 0 }, "w1"), { workspaceId: "w1", lastVisitedAt: 0 });
  assert.equal(readMarkUnreadAnswer({ ok: true, workspaceId: "w2", lastVisitedAt: 5 }, "w1"), null);
  assert.equal(readMarkUnreadAnswer({ ok: true, workspaceId: "w1", lastVisitedAt: -1 }, "w1"), null);
  assert.equal(readMarkUnreadAnswer({ ok: true, workspaceId: "w1" }, "w1"), null);
});

test("a listed visitRewoundAt is kept in its shape, beside the visit clock", () => {
  assert.deepEqual(parseConversationLifecycle({ lastVisitedAt: 10, visitRewoundAt: 20 }), { lastVisitedAt: 10, visitRewoundAt: 20 });
  assert.deepEqual(parseConversationLifecycle({ lastVisitedAt: 10, visitRewoundAt: "20" }), { lastVisitedAt: 10 });
});

test("a list read shows a mark unread made elsewhere: a listed stamp, or a clock gone back on a desktop that takes the tool", () => {
  const read = (overrides) =>
    listedVisitRewind({ thread: {}, previousVisitedAt: null, readStartedAt: NOW, markUnread: true, ...overrides });
  // The desktop lists the mark's own time: that is the mark.
  assert.deepEqual(read({ thread: { lastVisitedAt: 100, visitRewoundAt: 500 } }), { visitedAt: 100, rewoundAt: 500 });
  // It lists only the clock: gone back since the last read is a mark, timed by the read.
  assert.deepEqual(read({ thread: { lastVisitedAt: 100 }, previousVisitedAt: 300 }), { visitedAt: 100, rewoundAt: NOW });
  assert.equal(read({ thread: { lastVisitedAt: 300 }, previousVisitedAt: 300 }), null, "unchanged");
  assert.equal(read({ thread: { lastVisitedAt: 400 }, previousVisitedAt: 300 }), null, "a visit moves it forward");
  assert.equal(read({ thread: { lastVisitedAt: 100 } }), null, "a clock never listed before says nothing");
  // A desktop without the tool moves its clock only forward, as it always did.
  assert.equal(read({ thread: { lastVisitedAt: 100 }, previousVisitedAt: 300, markUnread: false }), null);
  assert.equal(read({ thread: {}, previousVisitedAt: 300 }), null, "no clock listed, nothing to read");
});

test("a mark unread newer than this phone's own visit reading resets it; an older one leaves it", () => {
  const rewind = { visitedAt: NOW - 10 * MIN - 1, rewoundAt: NOW - 2 * MIN };
  // Opened four minutes ago, before the mark: the opening is reset to the desktop's clock.
  assert.equal(visitRewindApplies(rewind, NOW - 4 * MIN), true);
  // Opened a minute ago, after the mark: read again, and it stands.
  assert.equal(visitRewindApplies(rewind, NOW - MIN), false);
  // A reading at or before the rewound clock hides nothing.
  assert.equal(visitRewindApplies(rewind, rewind.visitedAt), false);
  assert.equal(visitRewindApplies(rewind, null), false);

  // The list's green follows: the turn that ended ten minutes ago is unseen
  // again over an opening from before the mark, and read over one after it.
  const listed = withVisitRewind(thread({ lastVisitedAt: NOW - 5 * MIN }), rewind);
  assert.equal(listed.lastVisitedAt, rewind.visitedAt, "a clock read before the mark shows the mark's");
  assert.equal(listed.visitRewoundAt, rewind.rewoundAt);
  const state = (openedAt) => chatRowState(listed, { now: NOW, openedAt, lifecycle: true });
  assert.equal(state(NOW - 4 * MIN), "finished");
  assert.equal(state(NOW - MIN), "idle");
  assert.equal(chatSeenAt(listed, NOW - 4 * MIN), rewind.visitedAt);

  // A visit stamped since the mark is the chat read again, and is kept.
  const visitedSince = withVisitRewind(thread({ lastVisitedAt: NOW - MIN }), rewind);
  assert.equal(visitedSince.lastVisitedAt, NOW - MIN);
  assert.equal(chatRowState(visitedSince, { now: NOW, openedAt: NOW - 4 * MIN, lifecycle: true }), "idle");

  // Without a mark, the later of the two readings, as before.
  assert.equal(chatSeenAt(thread({ lastVisitedAt: NOW - 20 * MIN }), NOW - 4 * MIN), NOW - 4 * MIN);
  assert.equal(withVisitRewind(thread(), null).lastVisitedAt, NOW - 5 * MIN);
});

test("after a mark unread the next opening's divider sits above the latest reply", () => {
  let sequence = 0;
  const event = (type, createdAt, payload = {}) => {
    sequence += 1;
    return { id: `e${sequence}`, seq: sequence, sessionId: "s", workspaceId: "w1", agentId: "a1", createdAt, type, payload };
  };
  const exchange = (turnId, start, end) => [
    event("user_message", start, { turnId, text: `ask ${turnId}` }),
    event("turn_started", start, { turnId }),
    event("content_delta", start + 1, { turnId, text: `answer ${turnId}` }),
    event("turn_completed", end, { turnId, durationMs: end - start }),
  ];
  const events = [...exchange("t1", 100, 110), ...exchange("t2", 200, 210)];
  const projected = projectConversation(events);
  const divider = (opened) => unreadDividerRowId(projected.rows, unreadDividerTurn(projected.replies, opened));

  // Read after both: no divider.
  const before = { lastVisitedAt: 500 };
  assert.equal(divider(chatOpenedSince([before, before], 1_000)), null);

  // Marked unread: the clock goes back to just before t2's finish. The thread
  // the chat was handed before the mark still has 500; the list's has the mark.
  const marked = { lastVisitedAt: 209, visitRewoundAt: 600 };
  const opened = chatOpenedSince([before, marked], 1_000);
  assert.equal(opened.seenAt, 209, "the mark wins over a reading from before it");
  assert.deepEqual(chatOpenedSince([marked, before], 1_000), opened, "whichever thread it rides in");
  const id = divider(opened);
  assert.ok(id, "a divider is drawn");
  const row = projected.rows.find((entry) => entry.id === id);
  assert.equal(row.turn ?? row.lane?.turn, "t2", "above the latest reply");

  // A visit since the mark wins over it again.
  assert.equal(chatOpenedSince([marked, { lastVisitedAt: 700 }], 1_000).seenAt, 700);
  assert.equal(divider(chatOpenedSince([marked, { lastVisitedAt: 700 }], 1_000)), null);
});

test("a chat marked unread shows unread at any age: green under Earlier, where it stays, and no longer offered", () => {
  const DAY = 24 * 60 * MIN;
  // Finished three days ago, read a minute later, and written in no sooner.
  const old = thread({
    updatedAt: NOW - 3 * DAY,
    createdAt: NOW - 4 * DAY,
    lastUserMessageAt: NOW - 3 * DAY - 5 * MIN,
    lastTurnEndedAt: NOW - 3 * DAY,
    lastVisitedAt: NOW - 3 * DAY + MIN,
  });
  const [before] = rows({ threads: [old], markUnread: true });
  assert.equal(chatRowState(before.thread, { now: NOW, lifecycle: true }), "idle");
  assert.equal(markUnreadOffered(before, { now: NOW }), true);

  // Marked just now: the clock goes back to just before that finish.
  const rewind = { visitedAt: NOW - 3 * DAY - 1, rewoundAt: NOW - MIN };
  const opened = NOW - 3 * DAY + 2 * MIN;
  for (const marked of [
    // This phone's own mark, or one it inferred from the clock going back.
    withVisitRewind(old, rewind),
    // The desktop's, listed.
    { ...old, lastVisitedAt: rewind.visitedAt, visitRewoundAt: rewind.rewoundAt },
  ]) {
    const [row] = rows({ threads: [marked], markUnread: true });
    assert.equal(chatMarkedUnread(row.thread, opened), true);
    assert.equal(chatRowState(row.thread, { now: NOW, openedAt: opened, lifecycle: true }), "finished", "the mark is seen, however old the turn");
    assert.equal(markUnreadOffered(row, { now: NOW, openedAt: opened }), false, "it is unread already");
    // A state tints a row and never moves it: still under Earlier.
    const { recent, earlier } = chatSections([row], NOW);
    assert.deepEqual([recent.length, earlier.length], [0, 1]);
    // The bell keeps its day: an old finish is not news, marked or not.
    assert.deepEqual(buildNotices({ chats: [row], openedAt: {}, now: NOW }), []);

    // Opening it, the divider goes above the reply the mark made new: the
    // clock it is read against is the mark's, before that finish.
    const seen = chatOpenedSince([old, row.thread], NOW).seenAt;
    assert.equal(seen, rewind.visitedAt);
    assert.ok(seen < old.lastTurnEndedAt);
    // And the opening reads it: the mark is gone, and Mark unread is back.
    const [read] = rows({ threads: [row.thread], markUnread: true });
    assert.equal(chatMarkedUnread(read.thread, NOW), false);
    assert.equal(chatRowState(read.thread, { now: NOW, openedAt: NOW, lifecycle: true }), "idle");
    assert.equal(markUnreadOffered(read, { now: NOW, openedAt: NOW }), true);
    // As does a visit stamped anywhere since the mark.
    assert.equal(chatRowState({ ...row.thread, lastVisitedAt: NOW }, { now: NOW, lifecycle: true }), "idle");
  }
});

test("without a mark, a finish nobody saw still goes quiet after a day", () => {
  const DAY = 24 * 60 * MIN;
  const unseen = thread({ updatedAt: NOW - 2 * DAY, lastTurnEndedAt: NOW - 2 * DAY, lastVisitedAt: NOW - 3 * DAY });
  assert.equal(chatRowState(unseen, { now: NOW, lifecycle: true }), "idle");
  // An old mark the person has since read past does not keep a later finish green.
  const readSince = { ...unseen, visitRewoundAt: NOW - 4 * DAY, lastVisitedAt: NOW - 3 * DAY };
  assert.equal(chatMarkedUnread(readSince), false);
  assert.equal(chatRowState(readSince, { now: NOW, lifecycle: true }), "idle");
  // Within the day a marked chat rings the bell as any unseen finish does.
  const [recent] = rows({ threads: [thread({ lastVisitedAt: NOW - 10 * MIN - 1, visitRewoundAt: NOW - MIN })], markUnread: true });
  assert.equal(buildNotices({ chats: [recent], openedAt: {}, now: NOW }).length, 1);
});
