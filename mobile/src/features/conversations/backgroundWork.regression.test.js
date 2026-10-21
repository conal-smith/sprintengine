const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  parseConversationBackgroundWork,
  parseConversationFrame,
} = require("../../../.mobile-test-build/src/api/conversationWire.js");
const {
  CHAT_EARLIER_AFTER_MS,
  chatActivity,
  chatHasUnseenTurn,
  chatRowState,
  chatSections,
  chatWorksInBackground,
} = require("../../../.mobile-test-build/src/features/conversations/conversationListLogic.js");
const { backgroundWorkLabel } = require("../../../.mobile-test-build/src/features/conversations/agentLogic.js");

// A chat whose turn is over but which still has an agent working in the
// background, or a monitor that will wake its agent, as the desktop lists it
// (`backgroundWork`). Working on the list and in the chat; never a turn.

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const listed = (fields = {}) => ({
  workspaceId: "w",
  agentId: "a",
  title: "Agent",
  phase: "completed",
  createdAt: 1,
  updatedAt: NOW - 5 * MIN,
  providerId: "claude",
  modelId: "default",
  turnCount: 1,
  lastSeq: 4,
  ...fields,
});
const row = (fields = {}) => ({ deviceId: "d", desktopName: "mac-mini", projectName: "acme", thread: listed(fields) });
const parseList = (sessions) =>
  parseConversationFrame(JSON.stringify({ type: "sessions", requestId: "list", sessions })).sessions;
const lane = (status) => ({ id: `lane-${status}-${Math.random()}`, status });

test("a listed chat's background work is kept when both counts are whole and one is above zero", () => {
  const [agents, monitors] = parseList([
    listed({ backgroundWork: { agents: 2, monitors: 0 } }),
    listed({ agentId: "b", backgroundWork: { agents: 0, monitors: 1, extra: true } }),
  ]);
  assert.deepEqual(agents.backgroundWork, { agents: 2, monitors: 0 });
  assert.deepEqual(monitors.backgroundWork, { agents: 0, monitors: 1 }, "only the two counts are kept");
});

test("background work in the wrong shape is left out, and the chat still lists", () => {
  const malformed = [true, 1, "agents", { agents: 0, monitors: 0 }, { agents: -1, monitors: 1 }, { agents: 1.5, monitors: 0 }, { agents: "1", monitors: 0 }, { agents: 1 }];
  const chats = parseList(malformed.map((backgroundWork, index) => listed({ agentId: `a${index}`, backgroundWork })));
  assert.equal(chats.length, malformed.length);
  for (const chat of chats) assert.equal("backgroundWork" in chat, false);
  assert.equal(parseConversationBackgroundWork(null), null);
});

test("an older desktop lists no background work, and its finished chat reads as at rest, as before", () => {
  const [chat] = parseList([listed()]);
  assert.equal("backgroundWork" in chat, false);
  assert.equal(chatWorksInBackground(chat), false);
  assert.deepEqual(chatActivity(chat), { tone: "quiet", text: "" });
});

test("a finished chat with background work reads as working on the list, in its own words", () => {
  const thread = listed({ backgroundWork: { agents: 1, monitors: 0 } });
  assert.deepEqual(chatActivity(thread), { tone: "working", text: "Working in background" });
  assert.equal(chatRowState(thread, { now: NOW, openedAt: null, lifecycle: true }), "working");
  assert.equal(chatWorksInBackground(listed({ phase: "idle", backgroundWork: { agents: 0, monitors: 1 } })), true);
});

test("a chat waiting on the person, or one that failed, says that over its background work", () => {
  const waiting = listed({ phase: "waiting_for_approval", backgroundWork: { agents: 1, monitors: 0 } });
  const failed = listed({ phase: "failed", backgroundWork: { agents: 1, monitors: 0 } });
  assert.equal(chatActivity(waiting).text, "Needs approval");
  assert.equal(chatRowState(waiting, { now: NOW, openedAt: null }), "needs-input");
  assert.equal(chatActivity(failed).text, "Failed");
  assert.equal(chatRowState(failed, { now: NOW, openedAt: null }), "failed");
});

test("a chat is not finished and unseen while it works in the background, and is once that ends", () => {
  const ended = { lastTurnEndedAt: NOW - 10 * MIN, lastVisitedAt: NOW - 20 * MIN };
  const working = listed({ ...ended, backgroundWork: { agents: 1, monitors: 0 } });
  const input = { now: NOW, openedAt: null, lifecycle: true };
  assert.equal(chatHasUnseenTurn(working, input), false);
  assert.equal(chatRowState(working, input), "working");
  assert.equal(chatRowState(listed(ended), input), "finished");
});

test("a chat working in the background stays out of Earlier, however long ago it was written in", () => {
  const old = NOW - 2 * CHAT_EARLIER_AFTER_MS;
  const { recent, earlier } = chatSections(
    [row({ agentId: "watching", updatedAt: old, backgroundWork: { agents: 0, monitors: 1 } }), row({ agentId: "resting", updatedAt: old })],
    NOW,
  );
  assert.deepEqual(recent.map((item) => item.thread.agentId), ["watching"]);
  assert.deepEqual(earlier.map((item) => item.thread.agentId), ["resting"]);
});

test("the open chat's working line names the agents in the background, or the work alone", () => {
  assert.equal(backgroundWorkLabel([lane("running"), lane("done")]), "1 agent working in background");
  assert.equal(backgroundWorkLabel([], 3), "3 agents working in background", "the desktop's count, where the transcript shows fewer");
  assert.equal(backgroundWorkLabel([lane("done")], 0), "Working in background", "a monitor that will wake the agent");
});
