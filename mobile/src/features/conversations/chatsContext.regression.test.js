/* global __dirname */
// The chat list's provider under a deterministic state/effect runner (as the
// conversation hook's suite runs its hook), with desktops that count what
// they are asked for: the reads a cold start and a return to the list cost,
// and the device-notes writes the list makes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const compiled = path.resolve(__dirname, "../../../.mobile-test-build/src/features/conversations/ChatsContext.js");
const localRequire = createRequire(compiled);
const { createDeviceNotesStore } = localRequire("../../storage/sessionStore.js");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const drain = async () => {
  for (let i = 0; i < 50; i++) await tick();
};

const desktop = (deviceId) => ({
  deviceId,
  desktopName: `Desktop ${deviceId}`,
  baseUrl: `https://${deviceId}.example.ts.net`,
  deviceToken: `token-${deviceId}`,
  pairedAt: "2026-01-01T00:00:00.000Z",
  tailnetScopes: ["workspace:read", "conversation:operate"],
  tailnetCapabilities: ["conversations"],
});

function harness({ chatsPerDesktop = 3, threads = null } = {}) {
  // `threads`, when given, is what every desktop lists, read afresh each time.
  const desk = { workspaceIds: ["w"], threads };
  const toasts = [];
  const slots = [];
  const effects = [];
  let cursor = 0;
  let provided = null;
  const reads = { list: 0, workspaces: 0 };
  const storage = { reads: 0, writes: 0, values: new Map() };
  const react = {
    createContext: () => ({ Provider: "Provider" }),
    useContext: () => provided,
    useRef(value) {
      const i = cursor++;
      return (slots[i] ??= { current: value });
    },
    useState(value) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: typeof value === "function" ? value() : value };
      return [
        slots[i].value,
        (next) => {
          slots[i].value = typeof next === "function" ? next(slots[i].value) : next;
        },
      ];
    },
    useMemo(factory, deps) {
      const i = cursor++;
      const old = slots[i];
      if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) slots[i] = { value: factory(), deps };
      return slots[i].value;
    },
    useCallback(callback, deps) {
      return react.useMemo(() => callback, deps);
    },
    useEffect(callback, deps) {
      const i = cursor++;
      const old = slots[i];
      if (!old || deps.some((value, index) => !Object.is(value, old.deps[index])))
        effects.push(() => {
          old?.cleanup?.();
          slots[i] = { deps, cleanup: callback() };
        });
    },
  };
  const conversationsApi = (deviceId) => ({
    list: async () => {
      reads.list++;
      await tick();
      if (desk.threads) return desk.threads.map((thread) => ({ ...thread }));
      return Array.from({ length: chatsPerDesktop }, (_, i) => ({
        workspaceId: desk.workspaceIds[i % desk.workspaceIds.length],
        agentId: `${deviceId}-agent-${i}`,
        phase: "idle",
        title: `chat ${i}`,
      }));
    },
  });
  const workspacesApi = {
    listWorkspaces: async () => {
      reads.workspaces++;
      await tick();
      return {
        ok: true,
        data: desk.workspaceIds.map((workspaceId) => ({ workspaceId, name: workspaceId, projectName: "project", projectKey: "p" })),
      };
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(compiled, "utf8"),
    {
      exports: module.exports,
      module,
      require(name) {
        if (name === "react") return react;
        if (name === "react/jsx-runtime")
          return {
            jsx: (_type, props) => {
              provided = props.value;
              return null;
            },
          };
        if (name.endsWith("/tailnetConversations"))
          return { createTailnetConversationsApi: ({ baseUrl }) => conversationsApi(new URL(baseUrl).hostname.split(".")[0]) };
        if (name.endsWith("/tailnetWorkspaces")) return { createTailnetWorkspacesApi: () => workspacesApi };
        if (name.endsWith("/components/Toast"))
          return {
            useToast: () => ({
              show(toast) {
                toasts.push(toast);
              },
            }),
          };
        return localRequire(name);
      },
    },
    { filename: compiled },
  );
  const notesStore = createDeviceNotesStore({
    isAvailable: async () => true,
    getItem: async (key) => {
      storage.reads++;
      await tick();
      return storage.values.get(key) ?? null;
    },
    setItem: async (key, value) => {
      storage.writes++;
      await tick();
      storage.values.set(key, value);
    },
    deleteItem: async (key) => {
      storage.values.delete(key);
    },
  });
  let props = { sessions: [], activeDeviceId: null, notesStore, children: null };
  const render = (next = {}) => {
    props = { ...props, ...next };
    cursor = 0;
    module.exports.ChatsProvider(props);
    while (effects.length) effects.shift()();
    return provided;
  };
  return { render, reads, storage, desk, toasts, value: () => provided };
}

/**
 * A cold start on a phone paired to two desktops: the provider mounts before
 * the stored pairings are read, they arrive, and the list screen comes into
 * view and refreshes on focus in the same moment.
 */
async function coldStart(options) {
  const h = harness(options);
  h.render();
  await drain();
  const sessions = [desktop("one"), desktop("two")];
  h.render({ sessions, activeDeviceId: "one" });
  void h.value().refresh(); // the list screen's focus
  for (let i = 0; i < 200; i++) {
    await tick();
    h.render();
  }
  return h;
}

test("a cold start reads each desktop's chats and workspaces once", async () => {
  const h = await coldStart();
  if (process.env.MEASURE_CHATS) console.log("cold start reads", JSON.stringify(h.reads));
  assert.equal(h.value().chats.length, 6);
  assert.equal(h.value().loaded, true);
  assert.equal(h.reads.list, 2, "one chat list read per desktop");
  assert.equal(h.reads.workspaces, 2, "one workspace read per desktop");
});

test("coming back to the list reads the chats again, and the workspaces only when a chat names a new one", async () => {
  const h = await coldStart();
  let before = { ...h.reads };
  void h.value().revalidate();
  await drain();
  h.render();
  if (process.env.MEASURE_CHATS)
    console.log("return to the list", JSON.stringify({ list: h.reads.list - before.list, workspaces: h.reads.workspaces - before.workspaces }));
  assert.equal(h.reads.list - before.list, 2, "the chats are always read afresh");
  assert.equal(h.reads.workspaces - before.workspaces, 0, "the workspaces read a moment ago still name them all");

  // A chat in a workspace opened since: that desktop's list is read again.
  h.desk.workspaceIds = ["w", "opened-since"];
  before = { ...h.reads };
  void h.value().revalidate();
  for (let i = 0; i < 50; i++) {
    await tick();
    h.render();
  }
  assert.equal(h.reads.workspaces - before.workspaces, 2);
  assert.ok(h.value().chats.filter((row) => row.thread.workspaceId === "opened-since").every((row) => row.workspaceTitle === "opened-since"));

  // Pull to refresh reads everything afresh.
  before = { ...h.reads };
  void h.value().refresh();
  await drain();
  assert.equal(h.reads.list - before.list, 2);
  assert.equal(h.reads.workspaces - before.workspaces, 2);
});

test("a freshly paired phone records its first sighting of every chat in one write", async () => {
  const h = await coldStart({ chatsPerDesktop: 25 });
  for (let i = 0; i < 200; i++) {
    await tick();
    h.render();
  }
  if (process.env.MEASURE_CHATS) console.log("first sightings", JSON.stringify({ chats: h.value().chats.length, notesWrites: h.storage.writes }));
  const stored = JSON.parse(h.storage.values.get("multicode.mobile.threadsOpened.v1"));
  assert.equal(Object.keys(stored).length, 50, "every chat is stored as seen");
  assert.deepEqual(Object.keys(h.value().openedAt).sort(), Object.keys(stored).sort());
  assert.ok(h.storage.writes <= 2, `${h.storage.writes} writes`);
});

test("until the first read for the stored pairings answers, the list is still loading", async () => {
  const h = harness();
  // Mounted before the keychain has said which desktops are paired.
  h.render();
  await drain();
  h.render({ sessions: [desktop("one")], activeDeviceId: "one" });
  // The read for the pairings is out; nothing has answered.
  assert.equal(h.value().chats.length, 0);
  assert.equal(h.value().loaded, false, "an answer for no desktops is not an answer for these");
  for (let i = 0; i < 50; i++) {
    await tick();
    h.render();
  }
  assert.equal(h.value().loaded, true);
  assert.equal(h.value().chats.length, 3);
});

// Mark unread, against a desktop that advertises it. One chat, finished ten
// minutes ago and read on the desktop five minutes ago.
const MIN = 60_000;
const markUnreadDesktop = () => ({
  ...desktop("one"),
  tailnetCapabilities: ["conversations", "conversation-lifecycle", "chat-mark-unread"],
});
const finishedChat = (now, overrides = {}) => ({
  workspaceId: "w",
  agentId: "agent",
  phase: "completed",
  title: "chat",
  updatedAt: now - 10 * MIN,
  createdAt: now - 60 * MIN,
  providerId: "claude-code",
  lastTurnEndedAt: now - 10 * MIN,
  lastVisitedAt: now - 5 * MIN,
  ...overrides,
});
const settle = async (h) => {
  for (let i = 0; i < 100; i++) {
    await tick();
    h.render();
  }
};
async function markUnreadHarness({ markUnread, now = Date.now() }) {
  const h = harness({ threads: [finishedChat(now)] });
  const lifecycle = {
    calls: [],
    settle: async () => ({ ok: false }),
    visit: async (workspaceId) => ({ ok: true, data: { workspaceId, lastVisitedAt: Date.now() } }),
    markUnread: async (workspaceId) => {
      lifecycle.calls.push(workspaceId);
      return markUnread(workspaceId);
    },
  };
  h.render({ sessions: [markUnreadDesktop()], activeDeviceId: "one", lifecycleApiOverride: lifecycle });
  await settle(h);
  return { h, lifecycle, now };
}
const rowState = (h, now) => {
  const { chatRowState, chatOpenedKey } = localRequire("./conversationListLogic.js");
  const [row] = h.value().chats;
  return chatRowState(row.thread, {
    now,
    openedAt: h.value().openedAt[chatOpenedKey(row.deviceId, row.thread.agentId)] ?? null,
    lifecycle: row.lifecycle,
  });
};

test("a chat marked unread from the phone shows unread the moment the desktop answers", async () => {
  const { h, lifecycle, now } = await markUnreadHarness({
    markUnread: async (workspaceId) => ({ ok: true, data: { workspaceId, lastVisitedAt: now - 10 * MIN - 1 } }),
  });
  const [row] = h.value().chats;
  assert.equal(row.canMarkUnread, true);
  // The phone opened it a minute ago, which the desktop's clock alone would not undo.
  h.value().markChatOpened("chat:one:agent");
  h.render();
  assert.equal(rowState(h, Date.now()), "idle");
  const reads = h.reads.list;
  assert.equal(await h.value().markUnreadChat(row), true);
  h.render();
  assert.deepEqual(lifecycle.calls, ["w"]);
  // Before the list is read again: the row is already unread.
  assert.equal(rowState(h, Date.now()), "finished");
  // The desktop now lists the rewound clock; the next read keeps it unread,
  // and this phone's opened stamp is lowered in its notes for a restart.
  h.desk.threads = [finishedChat(now, { lastVisitedAt: now - 10 * MIN - 1 })];
  await settle(h);
  assert.ok(h.reads.list > reads, "the list is read again");
  assert.equal(rowState(h, Date.now()), "finished");
  const stored = JSON.parse(h.storage.values.get("multicode.mobile.threadsOpened.v1"));
  assert.equal(stored["chat:one:agent"], now - 10 * MIN - 1);
  assert.deepEqual(h.toasts, []);
  // Leaving its screen does not read it again; opening it does.
  h.value().markChatOpened("chat:one:agent");
  h.render();
  assert.equal(rowState(h, Date.now()), "finished", "nothing reads it but opening it");
  h.value().visitChat({ deviceId: "one", workspaceId: "w" }, "open", null);
  h.value().markChatOpened("chat:one:agent");
  h.render();
  assert.equal(rowState(h, Date.now()), "idle");
});

test("a refused mark unread leaves the row as it was and says why in a toast", async () => {
  const message = "No agent in this chat has finished anything yet, so there is nothing to mark unread.";
  const { h, now } = await markUnreadHarness({
    markUnread: async () => ({ ok: false, errorCode: "invalid_payload", message }),
  });
  h.value().markChatOpened("chat:one:agent");
  h.render();
  assert.equal(await h.value().markUnreadChat(h.value().chats[0]), false);
  await settle(h);
  assert.equal(rowState(h, Date.now()), "idle");
  assert.equal(h.value().chats[0].thread.lastVisitedAt, now - 5 * MIN);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].tone, "error");
  assert.equal(h.toasts[0].message, message);
  // The refusal released the chat: opening it from the list reads it as before.
  h.value().markChatOpened("chat:one:agent");
  h.render();
  assert.equal(rowState(h, Date.now()), "idle");
});

test("a desktop without chat-mark-unread offers none, and its clock going back is not read as a mark", async () => {
  const now = Date.now();
  const h = harness({ threads: [finishedChat(now)] });
  const session = { ...desktop("one"), tailnetCapabilities: ["conversations", "conversation-lifecycle"] };
  h.render({ sessions: [session], activeDeviceId: "one", lifecycleApiOverride: { markUnread: async () => assert.fail("not offered") } });
  await settle(h);
  assert.equal(h.value().chats[0].canMarkUnread, false);
  assert.equal(await h.value().markUnreadChat(h.value().chats[0]), false);
  h.value().markChatOpened("chat:one:agent");
  h.render();
  h.desk.threads = [finishedChat(now, { lastVisitedAt: now - 10 * MIN - 1 })];
  void h.value().refresh();
  await settle(h);
  assert.equal(rowState(h, Date.now()), "idle", "the later of the two, as before");
});

test("a mark unread made on the desktop after this phone opened the chat wins; one from before it does not", async () => {
  const now = Date.now();
  const { h } = await markUnreadHarness({ markUnread: async () => assert.fail("not asked"), now });
  // Opened here before the mark.
  h.value().markChatOpened("chat:one:agent");
  h.render();
  assert.equal(rowState(h, Date.now()), "idle");
  // Marked unread on the desktop: the next read lists the clock gone back.
  await new Promise((resolve) => setTimeout(resolve, 2));
  h.desk.threads = [finishedChat(now, { lastVisitedAt: now - 10 * MIN - 1 })];
  void h.value().refresh();
  await settle(h);
  assert.equal(rowState(h, Date.now()), "finished", "the rewind newer than the phone's opening wins");

  // A desktop that lists the mark's time: one older than the phone's own
  // opening leaves the chat read.
  await new Promise((resolve) => setTimeout(resolve, 2));
  h.value().markChatOpened("chat:one:agent");
  h.render();
  assert.equal(rowState(h, Date.now()), "idle");
  h.desk.threads = [finishedChat(now, { lastVisitedAt: now - 10 * MIN - 1, visitRewoundAt: now - 3 * MIN })];
  void h.value().refresh();
  await settle(h);
  assert.equal(rowState(h, Date.now()), "idle", "a rewind older than the phone's opening changes nothing");
  // ...and a newer one, listed, wins.
  h.desk.threads = [finishedChat(now, { lastVisitedAt: now - 10 * MIN - 1, visitRewoundAt: Date.now() + MIN })];
  void h.value().refresh();
  await settle(h);
  assert.equal(rowState(h, Date.now()), "finished");
});

test("a mark unread made on the desktop after this phone's own visit wins, though the listed clock went forward", async () => {
  const now = Date.now();
  // Unread when last listed: read on the desktop twenty minutes ago, finished ten.
  const h = harness({ threads: [finishedChat(now, { lastVisitedAt: now - 20 * MIN })] });
  const lifecycle = {
    settle: async () => ({ ok: false }),
    visit: async (workspaceId) => ({ ok: true, data: { workspaceId, lastVisitedAt: Date.now() } }),
    markUnread: async () => assert.fail("not asked"),
  };
  h.render({ sessions: [markUnreadDesktop()], activeDeviceId: "one", lifecycleApiOverride: lifecycle });
  await settle(h);
  // Opened here: the visit is stamped and answered, so the row reads read.
  h.value().visitChat({ deviceId: "one", workspaceId: "w" }, "open", null);
  h.value().markChatOpened("chat:one:agent");
  await settle(h);
  assert.equal(rowState(h, Date.now()), "idle");
  // Marked unread on the desktop: the clock goes back to just before the
  // finish, which is still later than the twenty minutes ago last listed.
  await new Promise((resolve) => setTimeout(resolve, 2));
  h.desk.threads = [finishedChat(now, { lastVisitedAt: now - 10 * MIN - 1 })];
  void h.value().refresh();
  await settle(h);
  assert.equal(rowState(h, Date.now()), "finished");
});

// Settle and Snooze from the list, with the Undo their toasts offer.
const rowMenuDesktop = () => ({
  ...desktop("one"),
  tailnetCapabilities: ["conversations", "conversation-lifecycle", "chat-row-menu"],
});
async function lifecycleHarness(now = Date.now()) {
  const h = harness({ threads: [finishedChat(now)] });
  const lifecycle = {
    calls: [],
    settle: async (workspaceId, settled = true) => {
      lifecycle.calls.push(["settle", workspaceId, settled]);
      return { ok: true, data: { workspaceId, settledAt: settled ? Date.now() : null } };
    },
    visit: async (workspaceId) => ({ ok: true, data: { workspaceId, lastVisitedAt: Date.now() } }),
    markUnread: async () => ({ ok: false }),
    snooze: async (workspaceId, until) => {
      lifecycle.calls.push(["snooze", workspaceId, until]);
      if (lifecycle.refuse) return { ok: false, errorCode: "invalid_payload", message: lifecycle.refuse };
      return { ok: true, data: { workspaceId, snoozedUntil: until } };
    },
  };
  h.render({ sessions: [rowMenuDesktop()], activeDeviceId: "one", lifecycleApiOverride: lifecycle });
  await settle(h);
  return { h, lifecycle, now };
}

test("a settle the desktop took says so with Undo, which un-settles the chat and brings its row back", async () => {
  const { h, lifecycle } = await lifecycleHarness();
  const [row] = h.value().chats;
  assert.equal(await h.value().settleChat(row), true);
  h.render();
  assert.equal(h.value().chats.length, 0, "the row goes at once");
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].action.label, "Undo");
  assert.ok(h.toasts[0].autoDismissMs <= 5_000, "a short toast");
  h.toasts[0].action.onPress();
  await settle(h);
  assert.deepEqual(lifecycle.calls, [
    ["settle", "w", true],
    ["settle", "w", false],
  ]);
  assert.equal(h.value().chats.length, 1, "the desktop lists it again and nothing here hides it");
});

test("a snooze moves the row to the shelf at once, and Undo wakes it; a refusal puts it back and says why", async () => {
  const { h, lifecycle } = await lifecycleHarness();
  const [row] = h.value().chats;
  assert.equal(row.snoozable, true);
  const until = Date.now() + 60 * MIN;
  const asked = h.value().snoozeChat(row, until);
  h.render();
  assert.equal(h.value().chats[0].thread.snoozedUntil, until, "drawn asleep before the desktop answers");
  assert.equal(await asked, true);
  h.render();
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].title, /^Snoozed/);
  assert.equal(h.toasts[0].action.label, "Undo");
  h.toasts[0].action.onPress();
  await settle(h);
  assert.deepEqual(lifecycle.calls.at(-1), ["snooze", "w", null], "Undo wakes a chat that was awake");
  assert.equal(h.value().chats[0].thread.snoozedUntil, undefined);
  assert.equal(h.toasts.length, 1, "an undo says nothing more");

  lifecycle.refuse = "An agent in this chat is still working. Snooze it once it has finished.";
  assert.equal(await h.value().snoozeChat(h.value().chats[0], until), false);
  h.render();
  assert.equal(h.value().chats[0].thread.snoozedUntil, undefined, "back as listed");
  assert.equal(h.toasts.at(-1).tone, "error");
  assert.equal(h.toasts.at(-1).message, lifecycle.refuse);
});

test("a desktop without chat-row-menu offers no Snooze", async () => {
  const h = harness({ threads: [finishedChat(Date.now())] });
  h.render({
    sessions: [{ ...desktop("one"), tailnetCapabilities: ["conversations", "conversation-lifecycle"] }],
    activeDeviceId: "one",
  });
  await settle(h);
  const [row] = h.value().chats;
  assert.equal(row.snoozable, false);
  assert.equal(await h.value().snoozeChat(row, Date.now() + MIN), false);
});
