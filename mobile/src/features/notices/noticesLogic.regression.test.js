/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const { bellCount, buildNotices, pruneReadIds, splitNotices } = require(
  path.join(buildRoot, "src/features/notices/noticesLogic.js"),
);

const NOW = 1_800_000_000_000;
const minutesAgo = (minutes) => NOW - minutes * 60_000;

const chat = (overrides = {}, where = {}) => ({
  deviceId: "dev_1",
  desktopName: "Mac mini",
  projectName: "mobile",
  workspaceTitle: null,
  workspaceChats: 1,
  ...where,
  thread: {
    workspaceId: "ws",
    agentId: "a1",
    title: "Maeve Doyle",
    phase: "completed",
    updatedAt: minutesAgo(10),
    createdAt: minutesAgo(60),
    providerId: "claude-agent",
    modelId: "default",
    turnCount: 1,
    lastSeq: 4,
    ...overrides,
  },
});

test("a chat waiting on a person is a needs-you notice that opens the chat", () => {
  const notices = buildNotices({ chats: [chat({ phase: "waiting_for_input", updatedAt: minutesAgo(2) })], openedAt: {}, now: NOW });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].lane, "needs-you");
  assert.equal(notices[0].kind, "chat-waiting");
  assert.equal(notices[0].title, "Maeve Doyle asked a question");
  assert.equal(notices[0].target.deviceId, "dev_1");
  assert.equal(notices[0].target.thread.agentId, "a1");

  const [approval] = buildNotices({ chats: [chat({ phase: "waiting_for_approval" })], openedAt: {}, now: NOW });
  assert.equal(approval.title, "Maeve Doyle needs approval");
});

test("a waiting chat is not also a finished one, however recently it last opened", () => {
  const notices = buildNotices({
    chats: [chat({ phase: "waiting_for_approval", updatedAt: minutesAgo(1) })],
    openedAt: { "chat:dev_1:a1": minutesAgo(30) },
    now: NOW,
  });
  assert.deepEqual(
    notices.map((notice) => notice.kind),
    ["chat-waiting"],
  );
});

test("a turn the phone already watched end is not a notice, and nor is one from yesterday", () => {
  const unseen = buildNotices({ chats: [chat()], openedAt: {}, now: NOW });
  assert.equal(unseen.length, 1);
  assert.equal(unseen[0].lane, "can-wait");
  assert.equal(unseen[0].title, "Maeve Doyle finished");

  assert.deepEqual(buildNotices({ chats: [chat()], openedAt: { "chat:dev_1:a1": minutesAgo(9) }, now: NOW }), []);
  // The list's own rule: a chat that settled over a day ago is history, not news.
  assert.deepEqual(buildNotices({ chats: [chat({ updatedAt: minutesAgo(60 * 25) })], openedAt: {}, now: NOW }), []);
  // Working and failed chats say nothing on the bell; the list says it.
  assert.deepEqual(buildNotices({ chats: [chat({ phase: "running" }), chat({ agentId: "a2", phase: "failed" })], openedAt: {}, now: NOW }), []);
});

test("a second turn on the same chat is a second notice, so marking the first read cannot silence it", () => {
  const first = buildNotices({ chats: [chat({ updatedAt: minutesAgo(10) })], openedAt: {}, now: NOW });
  const second = buildNotices({ chats: [chat({ updatedAt: minutesAgo(4) })], openedAt: {}, now: NOW });
  assert.notEqual(first[0].id, second[0].id);
});

test("a lifecycle desktop's chat is news by its turn's end, and not once anyone has seen it there", () => {
  const lifecycle = { lifecycle: true };
  // Read on the desktop after it ended: not news here either.
  const visited = chat({ lastTurnEndedAt: minutesAgo(10), lastVisitedAt: minutesAgo(8), updatedAt: minutesAgo(1) }, lifecycle);
  assert.deepEqual(buildNotices({ chats: [visited], openedAt: {}, now: NOW }), []);
  // A rename or a usage report since moves `updatedAt`, not the turn's end:
  // the same turn keeps its id, so marking it read holds.
  const before = buildNotices({ chats: [chat({ lastTurnEndedAt: minutesAgo(10), updatedAt: minutesAgo(10) }, lifecycle)], openedAt: {}, now: NOW });
  const bumped = buildNotices({ chats: [chat({ lastTurnEndedAt: minutesAgo(10), updatedAt: minutesAgo(1) }, lifecycle)], openedAt: {}, now: NOW });
  assert.equal(before.length, 1);
  assert.equal(bumped[0].id, before[0].id);
  assert.equal(bumped[0].at, minutesAgo(10));
  // A chat such a desktop lists with no turn end has never finished one.
  assert.deepEqual(buildNotices({ chats: [chat({ updatedAt: minutesAgo(1) }, lifecycle)], openedAt: {}, now: NOW }), []);
});

test("two desktops' chats with one agent id are two notices", () => {
  const notices = buildNotices({
    chats: [chat({ phase: "waiting_for_input" }), chat({ phase: "waiting_for_input" }, { deviceId: "dev_2" })],
    openedAt: {},
    now: NOW,
  });
  assert.equal(new Set(notices.map((notice) => notice.id)).size, 2);
});

test("read state is kept for the can-wait lane only, and the bell counts both halves", () => {
  const notices = buildNotices({
    chats: [chat({ agentId: "waiting", phase: "waiting_for_input" }), chat({ agentId: "done", updatedAt: minutesAgo(5) })],
    openedAt: {},
    now: NOW,
  });

  const fresh = splitNotices(notices, []);
  assert.equal(fresh.needsYou.length, 1);
  assert.equal(fresh.canWait.length, 1);
  assert.equal(bellCount(fresh), 2);

  // Marking the can-wait row read clears the dot for it. The needs-you row is
  // NOT dismissible: it is resolved by the agent no longer waiting, which the
  // phone can see for itself.
  const afterRead = splitNotices(notices, [fresh.canWait[0].id, fresh.needsYou[0].id]);
  assert.equal(afterRead.unreadCanWait.length, 0);
  assert.equal(bellCount(afterRead), 1);
});

test("read ids are pruned against the notices that still exist, so the set cannot grow forever", () => {
  const notices = buildNotices({ chats: [chat({ updatedAt: minutesAgo(5) })], openedAt: {}, now: NOW });
  assert.deepEqual(pruneReadIds([notices[0].id, "chat-finished:gone:gone:1"], notices), [notices[0].id]);
});

test("notices are newest first, so the bell reads as a feed", () => {
  const notices = buildNotices({
    chats: [chat({ agentId: "older", updatedAt: minutesAgo(30) }), chat({ agentId: "newer", updatedAt: minutesAgo(2) })],
    openedAt: {},
    now: NOW,
  });
  assert.deepEqual(
    notices.map((notice) => notice.target.thread.agentId),
    ["newer", "older"],
  );
});

test("a notice is titled as the list titles the chat, and its chip names the agent where a workspace holds several", () => {
  const where = { workspaceTitle: "Cleaning up the repo", workspaceChats: 2 };
  const notices = buildNotices({
    chats: [
      chat({ agentId: "a1", title: "Maeve Doyle", phase: "waiting_for_input", updatedAt: minutesAgo(3) }, where),
      chat({ agentId: "a2", title: "Aoife Ryan", phase: "waiting_for_input", updatedAt: minutesAgo(4) }, where),
    ],
    openedAt: {},
    now: NOW,
  });
  assert.deepEqual(
    notices.map((notice) => notice.title),
    ["Cleaning up the repo asked a question", "Cleaning up the repo asked a question"],
  );
  assert.deepEqual(
    notices.map((notice) => notice.context),
    ["Maeve Doyle · mobile", "Aoife Ryan · mobile"],
  );

  // One chat in its workspace: the title is enough, and the chip is the project.
  const [alone] = buildNotices({
    chats: [chat({ phase: "waiting_for_input" }, { workspaceTitle: "Cleaning up the repo" })],
    openedAt: {},
    now: NOW,
  });
  assert.equal(alone.title, "Cleaning up the repo asked a question");
  assert.equal(alone.context, "mobile");
});
