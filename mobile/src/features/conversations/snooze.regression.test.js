/* global __dirname */
// Snooze from the phone: the wake times on offer (the desktop's row menu's),
// which chats sleep and on which shelf, where Snooze is offered, the
// `conversation.snooze` call and its answers, and how a snooze this phone
// asked for is drawn before the desktop's list says the same.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const {
  beginSnooze,
  confirmSnooze,
  failSnooze,
  isChatSnoozed,
  resolveSnoozePresets,
  snoozeOffered,
  snoozeWakeLabel,
  snoozeWakeWords,
  snoozesAfterRead,
  splitSnoozed,
  withPendingSnoozes,
} = require(path.join(buildRoot, "src/features/conversations/snoozeLogic.js"));
const { buildChatRows } = require(path.join(buildRoot, "src/features/conversations/conversationListLogic.js"));
const { buildSnoozeArgs, createConversationLifecycleApi, readSnoozeAnswer } = require(
  path.join(buildRoot, "src/api/conversationLifecycle.js"),
);
const { declaresChatRowMenu } = require(path.join(buildRoot, "src/api/tailnetTransport.js"));
const { parseConversationLifecycle } = require(path.join(buildRoot, "src/api/conversationWire.js"));

const MIN = 60_000;
const HOUR = 60 * MIN;
const local = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime();

const thread = (overrides = {}) => ({
  workspaceId: "w1",
  agentId: "a1",
  title: "Chat",
  phase: "completed",
  updatedAt: 0,
  createdAt: 0,
  providerId: "claude-code",
  ...overrides,
});
const rows = (threads, input = {}) =>
  buildChatRows({
    deviceId: "mac",
    desktopName: "Mac",
    threads,
    workspaces: null,
    lifecycle: true,
    canOperate: true,
    rowMenu: true,
    ...input,
  });

test("the wake times on offer are the desktop's, on the calendar of the day they are asked on", () => {
  // A Wednesday afternoon: every preset.
  const wednesday = local(2026, 10, 28, 14, 30);
  const presets = resolveSnoozePresets(wednesday);
  assert.deepEqual(
    presets.map((preset) => preset.id),
    ["hour", "three-hours", "evening", "tomorrow", "next-week"],
  );
  assert.equal(presets[0].wakeAt, wednesday + HOUR);
  assert.equal(presets[1].wakeAt, wednesday + 3 * HOUR);
  assert.equal(presets[2].wakeAt, local(2026, 10, 28, 18));
  assert.equal(presets[3].wakeAt, local(2026, 10, 29, 9));
  assert.equal(presets[4].wakeAt, local(2026, 11, 2, 9), "the coming Monday morning");
  assert.equal(presets[3].whenLabel, "9:00 AM");
  assert.equal(presets[4].whenLabel, "Mon 9:00 AM");

  // Evening less than an hour off is not offered as one.
  assert.ok(!resolveSnoozePresets(local(2026, 10, 28, 17, 15)).some((preset) => preset.id === "evening"));
  // On a Sunday, Next week is Tomorrow, and is offered once.
  const sunday = resolveSnoozePresets(local(2026, 11, 1, 10));
  assert.ok(!sunday.some((preset) => preset.id === "next-week"));
  assert.equal(sunday.find((preset) => preset.id === "tomorrow").wakeAt, local(2026, 11, 2, 9));
  // On a Monday, Next week is the Monday after.
  const monday = resolveSnoozePresets(local(2026, 11, 2, 10));
  assert.equal(monday.find((preset) => preset.id === "next-week").wakeAt, local(2026, 11, 9, 9));
});

test("a chat sleeps while its wake time is ahead, on a shelf soonest-first, and wears a countdown", () => {
  const now = 1_800_000_000_000;
  assert.equal(isChatSnoozed({ snoozedUntil: now + 1 }, now), true);
  assert.equal(isChatSnoozed({ snoozedUntil: now }, now), false, "a wake time reached is a chat awake");
  assert.equal(isChatSnoozed({}, now), false);

  const listed = rows([
    thread({ workspaceId: "a", agentId: "a", snoozedUntil: now + 3 * HOUR }),
    thread({ workspaceId: "b", agentId: "b" }),
    thread({ workspaceId: "c", agentId: "c", snoozedUntil: now + 20 * MIN }),
    thread({ workspaceId: "d", agentId: "d", snoozedUntil: now - MIN }),
  ]);
  const { awake, asleep } = splitSnoozed(listed, now);
  assert.deepEqual(
    awake.map((row) => row.thread.workspaceId),
    ["b", "d"],
  );
  assert.deepEqual(
    asleep.map((row) => row.thread.workspaceId),
    ["c", "a"],
    "soonest to wake first",
  );

  assert.equal(snoozeWakeLabel(now + 30 * 1000, now), "1m", "never 0m on a row still asleep");
  assert.equal(snoozeWakeLabel(now + 42 * MIN, now), "42m");
  assert.equal(snoozeWakeLabel(now + 90 * MIN, now), "2h");
  assert.equal(snoozeWakeLabel(now + 50 * HOUR, now), "3d");
  assert.equal(snoozeWakeLabel(now, now), "now");

  const at = local(2026, 10, 28, 14, 30);
  assert.equal(snoozeWakeWords(local(2026, 10, 28, 18), at), "today at 6:00 PM");
  assert.equal(snoozeWakeWords(local(2026, 10, 29, 9), at), "tomorrow at 9:00 AM");
  assert.equal(snoozeWakeWords(local(2026, 11, 2, 9), at), "Mon 2 Nov, 9:00 AM");
});

test("Snooze is offered only where the desktop takes it, this phone operates the chat, and nothing in it works", () => {
  assert.equal(declaresChatRowMenu({ tailnetCapabilities: ["conversation-lifecycle", "chat-row-menu"] }), true);
  assert.equal(declaresChatRowMenu({ tailnetCapabilities: ["conversation-lifecycle"] }), false);
  assert.equal(declaresChatRowMenu({}), false);

  const [row] = rows([thread()]);
  assert.equal(row.snoozable, true);
  assert.equal(snoozeOffered(row), true);
  assert.equal(rows([thread()], { rowMenu: false })[0].snoozable, false);
  assert.equal(rows([thread()], { canOperate: false })[0].snoozable, false);
  assert.equal(rows([thread()], { lifecycle: false })[0].snoozable, false);
  // The desktop ends a snoozed chat's processes, so it refuses one with an agent at work.
  assert.equal(snoozeOffered(rows([thread({ phase: "running" })])[0]), false);
  assert.equal(snoozeOffered(rows([thread({ phase: "starting" })])[0]), false);
  assert.equal(snoozeOffered(rows([thread({ backgroundWork: { agents: 1, monitors: 0 } })])[0]), false);
  // A chat waiting on the person may sleep: the question waits for it.
  assert.equal(snoozeOffered(rows([thread({ phase: "waiting_for_input" })])[0]), true);
});

test("a listed snoozedUntil is kept only in its shape", () => {
  assert.deepEqual(parseConversationLifecycle({ snoozedUntil: 1234 }), { snoozedUntil: 1234 });
  assert.deepEqual(parseConversationLifecycle({ snoozedUntil: "1234" }), {});
  assert.deepEqual(parseConversationLifecycle({ snoozedUntil: -5 }), {});
  assert.deepEqual(parseConversationLifecycle({ snoozedUntil: 1.5 }), {});
});

test("conversation.snooze goes to the desktop's gateway, and only its own answer for the chat counts", async () => {
  const calls = [];
  let refuse = false;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, name: body.params.name, args: body.params.arguments });
    const args = body.params.arguments;
    const structuredContent = refuse
      ? {
          ok: false,
          error: { code: "working", message: "An agent in this chat is still working. Snooze it once it has finished." },
        }
      : { ok: true, workspaceId: args.workspaceId, snoozedUntil: args.until };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: body.id, result: { structuredContent } }) };
  };
  const api = createConversationLifecycleApi({ baseUrl: "http://desk:7777", deviceToken: "tok" });
  assert.deepEqual(await api.snooze("w1", 5000.7), { ok: true, data: { workspaceId: "w1", snoozedUntil: 5000 } });
  assert.deepEqual(calls[0], {
    url: "http://desk:7777/tailnet/v1/mcp",
    name: "conversation.snooze",
    args: { workspaceId: "w1", until: 5000 },
  });
  assert.deepEqual(await api.snooze("w1", null), { ok: true, data: { workspaceId: "w1", snoozedUntil: null } });
  assert.deepEqual(calls[1].args, { workspaceId: "w1", until: null }, "null wakes it now");
  refuse = true;
  const refused = await api.snooze("w1", 5000);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /still working/);

  assert.deepEqual(buildSnoozeArgs("w1", null), { workspaceId: "w1", until: null });
  assert.deepEqual(readSnoozeAnswer({ ok: true, workspaceId: "w1", snoozedUntil: null }, "w1"), {
    workspaceId: "w1",
    snoozedUntil: null,
  });
  assert.equal(readSnoozeAnswer({ ok: true, workspaceId: "w2", snoozedUntil: 5 }, "w1"), null);
  assert.equal(readSnoozeAnswer({ ok: true, workspaceId: "w1", snoozedUntil: "5" }, "w1"), null);
  assert.equal(readSnoozeAnswer({ ok: true, workspaceId: "w1" }, "w1"), null);
});

test("a snooze this phone asked for is drawn at once, and until a read that set out after the answer", () => {
  const listed = rows([thread({ workspaceId: "a", agentId: "a" }), thread({ workspaceId: "b", agentId: "b", snoozedUntil: 900 })]);
  let pending = beginSnooze({}, "mac|a", 500);
  pending = beginSnooze(pending, "mac|b", null);
  const drawn = withPendingSnoozes(listed, pending);
  assert.equal(drawn[0].thread.snoozedUntil, 500);
  assert.equal("snoozedUntil" in drawn[1].thread, false, "a wake draws the chat awake");
  assert.equal(listed[1].thread.snoozedUntil, 900, "the listed row is left as it was");

  // A read that set out before the answer may still list the chat as it was.
  pending = confirmSnooze(pending, "mac|a", 500, 1000);
  assert.ok(snoozesAfterRead(pending, 999)["mac|a"]);
  assert.equal(snoozesAfterRead(pending, 1000)["mac|a"], undefined);
  assert.ok(snoozesAfterRead(pending, 1000)["mac|b"], "one still unanswered is kept");
  // A refusal puts the row back as listed.
  assert.equal(failSnooze(pending, "mac|b")["mac|b"], undefined);
  assert.equal(confirmSnooze({}, "mac|x", 1, 1)["mac|x"], undefined, "an answer for nothing asked changes nothing");
});
