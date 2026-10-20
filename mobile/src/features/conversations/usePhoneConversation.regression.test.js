/* global __dirname */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const compiled = path.resolve(
  __dirname,
  "../../../.mobile-test-build/src/features/conversations/usePhoneConversation.js",
);
const localRequire = createRequire(compiled);
const { createConversationCacheStore } = localRequire(
  "../../storage/conversationCacheModel.js",
);
const settle = () => new Promise((resolve) => setImmediate(resolve));
const thread = (agentId = "a") => ({
  workspaceId: "w",
  agentId,
  phase: "idle",
  title: agentId,
});
const event = (seq, type, payload = {}) => ({
  id: `e${seq}`,
  seq,
  type,
  sessionId: "s",
  workspaceId: "w",
  agentId: "a",
  createdAt: seq,
  payload,
});

/** Deterministic state/effect runner for production hook closures, not a native renderer. */
function fixture(options = {}) {
  const slots = [],
    effects = [],
    connections = [],
    commands = [],
    files = new Map();
  let cursor = 0,
    selected = thread(),
    serial = 0,
    holdUpdate = null;
  let list = async () => [];
  const store = createConversationCacheStore({
    keys: async () => [...files.keys()],
    read: async (key) => files.get(key) ?? null,
    write: async (key, value) => {
      files.set(key, value);
    },
    remove: async (key) => {
      files.delete(key);
    },
  });
  const react = {
    useRef(value) {
      const i = cursor++;
      return (slots[i] ??= { current: value });
    },
    useState(value) {
      const i = cursor++;
      if (!slots[i])
        slots[i] = { value: typeof value === "function" ? value() : value };
      return [
        slots[i].value,
        (next) => {
          slots[i].value =
            typeof next === "function" ? next(slots[i].value) : next;
        },
      ];
    },
    useMemo(factory, deps) {
      const i = cursor++,
        old = slots[i];
      if (
        !old ||
        deps.some((value, index) => !Object.is(value, old.deps[index]))
      )
        slots[i] = { value: factory(), deps };
      return slots[i].value;
    },
    useCallback(callback, deps) {
      return react.useMemo(() => callback, deps);
    },
    useEffect(callback, deps) {
      const i = cursor++,
        old = slots[i];
      if (
        !old ||
        deps.some((value, index) => !Object.is(value, old.deps[index]))
      )
        effects.push(() => {
          old?.cleanup?.();
          slots[i] = { deps, cleanup: callback() };
        });
    },
  };
  const api = {
    list: () => list(),
    open(key, seq, handlers, options) {
      const connection = {
        key,
        seq,
        options,
        handlers,
        command(command, id) {
          const commandId = id ?? `command-${commands.length + 1}`;
          commands.push({ key, command, id: commandId });
          return commandId;
        },
        retried: 0,
        closed: false,
        cancelPending() {},
        close() {
          connection.closed = true;
        },
        foreground() {},
        retry() {
          connection.retried++;
        },
        request() {
          return "request";
        },
      };
      connections.push(connection);
      return connection;
    },
  };
  const cache = {
    MAX_PENDING_SENDS: 20,
    loadConversationCache: (_device, key) => store.load(key.agentId),
    updateConversationCache: async (_device, key, updater) => {
      if (holdUpdate) {
        const wait = holdUpdate;
        holdUpdate = null;
        await wait;
      }
      return store.update(key.agentId, updater);
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(compiled, "utf8"),
    {
      exports: module.exports,
      module,
      setTimeout,
      clearTimeout,
      require(name) {
        if (name === "react") return react;
        if (name === "react-native")
          return {
            AppState: {
              currentState: "active",
              addEventListener: () => ({ remove() {} }),
            },
          };
        if (name === "expo-crypto")
          return { randomUUID: () => `send-${++serial}` };
        if (name.endsWith("/tailnetConversations"))
          return { createTailnetConversationsApi: () => api };
        if (name.endsWith("/conversationCache")) return cache;
        // Each fixture is its own app run: no transcript remembered by another.
        if (name.endsWith("/transcriptMemory")) {
          const memory = localRequire(name);
          return { ...memory, conversationTranscripts: memory.createTranscriptMemory() };
        }
        return localRequire(name);
      },
    },
    { filename: compiled },
  );
  const session = {
    deviceId: "device",
    baseUrl: "https://example.ts.net",
    deviceToken: "test-token",
    ...(options.capabilities ? { tailnetCapabilities: options.capabilities } : {}),
  };
  const render = (next = selected) => {
    selected = next;
    cursor = 0;
    const result = module.exports.usePhoneConversation(session, selected);
    while (effects.length) effects.shift()();
    return result;
  };
  return {
    render,
    connections,
    commands,
    store,
    hold(promise) {
      holdUpdate = promise;
    },
    list(fn) {
      list = fn;
    },
    unmount() {
      for (const slot of slots) slot?.cleanup?.();
    },
  };
}
test("raw streamed snapshots do not duplicate coalesced cached text, including pending-only writes", async () => {
  const h = fixture();
  h.render();
  await settle();
  const frames = h.connections[0].handlers;
  frames.onFrame({
    type: "snapshot",
    reset: true,
    page: {
      events: [
        event(1, "user_message", { text: "hello" }),
        event(2, "content_delta", { text: "a" }),
        event(3, "content_delta", { text: "b" }),
      ],
      hasMore: false,
      beforeCursor: null,
    },
  });
  await settle();
  frames.onFrame({
    type: "event",
    event: event(4, "content_delta", { text: "c" }),
  });
  await settle();
  await h.render().queueSend("next");
  const cached = await h.store.load("a");
  assert.equal(
    cached.events
      .filter((item) => item.type === "content_delta")
      .map((item) => item.payload.text)
      .join(""),
    "abc",
  );
  assert.equal(cached.pending.length, 1);
  h.unmount();
});
test("live and receipt acknowledgments remove durable and optimistic sends across bounded reset", async () => {
  const h = fixture();
  h.render();
  await settle();
  const id = await h.render().queueSend("first");
  const frames = h.connections[0].handlers;
  frames.onFrame({
    type: "event",
    event: event(1, "user_message", { text: "first", commandId: id }),
  });
  await settle();
  frames.onFrame({
    type: "snapshot",
    reset: true,
    page: { events: [], hasMore: false, beforeCursor: null },
  });
  await settle();
  assert.equal(h.render().optimistic.length, 0);
  const second = await h.render().queueSend("second");
  frames.onFrame({ type: "commandResult", commandId: second, ok: true });
  await settle();
  assert.equal(h.render().optimistic.length, 0);
  assert.equal((await h.store.load("a")).pending.length, 0);
  h.unmount();
});
test("a send persisted during navigation remains with its original conversation and cannot drive the replacement stream", async () => {
  const h = fixture();
  h.render();
  await settle();
  let release;
  h.hold(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const sending = h.render().queueSend("original");
  await settle();
  h.render(thread("b"));
  await settle();
  release();
  await sending;
  await settle();
  assert.equal(h.commands.length, 0);
  assert.equal(
    (await h.store.load("a")).pending[0].command.message,
    "original",
  );
  assert.equal(h.render().optimistic.length, 0);
  h.unmount();
});
/** The streams opened for chat `agentId`, the screen's and the courier's, in order. */
const streamsFor = (h, agentId) => h.connections.filter((connection) => connection.key.agentId === agentId);
test("a message queued behind a turn still goes to the desktop after the person moves to another chat", async () => {
  const h = fixture();
  h.render();
  await settle();
  const id = await h.render().queueSend("after this turn");
  h.render(thread("b"));
  await settle();
  const [screen, carried] = streamsFor(h, "a");
  assert.equal(screen.closed, true);
  assert.ok(carried, "a stream goes on offering the queued message");
  assert.deepEqual(
    carried.options.pendingSends.map((item) => [item.commandId, item.command.message]),
    [[id, "after this turn"]],
  );
  carried.handlers.onFrame({
    type: "event",
    event: event(1, "user_message", { text: "after this turn", commandId: id }),
  });
  await settle();
  assert.equal((await h.store.load("a")).pending.length, 0);
  assert.equal(carried.closed, true, "it closes once everything it carried is delivered");
  h.unmount();
});
test("opening the chat again takes its queued messages back from the stream carrying them", async () => {
  const h = fixture();
  h.render();
  await settle();
  const id = await h.render().queueSend("queued");
  h.render(thread("b"));
  await settle();
  h.render(thread("a"));
  await settle();
  const [, carried, reopened] = streamsFor(h, "a");
  assert.equal(carried.closed, true);
  assert.deepEqual(reopened.options.pendingSends.map((item) => item.commandId), [id]);
  assert.equal(reopened.closed, false);
  h.unmount();
});
test("a message the desktop refuses after its chat closed waits in the cache for the chat's screen", async () => {
  const h = fixture();
  h.render();
  await settle();
  const id = await h.render().queueSend("refused");
  h.render(thread("b"));
  await settle();
  const [, carried] = streamsFor(h, "a");
  carried.handlers.onFrame({ type: "commandResult", commandId: id, ok: false, message: "Conversation session is stopped." });
  await settle();
  assert.equal(carried.closed, true);
  assert.deepEqual((await h.store.load("a")).pending.map((item) => item.commandId), [id]);
  h.unmount();
});
test("a chat closed with nothing queued opens no stream behind it", async () => {
  const h = fixture();
  h.render();
  await settle();
  h.render(thread("b"));
  await settle();
  assert.equal(streamsFor(h, "a").length, 1);
  h.unmount();
});
test("the chat's title summary the desktop writes during the first turn is read when the turn ends", async () => {
  const h = fixture();
  let reads = 0;
  h.list(async () => {
    reads++;
    return [{ ...thread(), chatTitle: "Fix the flaky pairing test" }];
  });
  h.render();
  await settle();
  assert.equal(h.render().listedTitle, null);
  h.connections[0].handlers.onFrame({ type: "event", event: event(1, "turn_completed") });
  await settle();
  assert.equal(reads, 1);
  assert.equal(h.render().listedTitle, "Fix the flaky pairing test");
  h.render(thread("b"));
  await settle();
  assert.equal(h.render().listedTitle, null, "another chat does not wear it");
  h.unmount();
});
test("late metadata responses cannot overwrite the newly selected conversation", async () => {
  const h = fixture();
  h.render();
  await settle();
  let release;
  h.list(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  h.connections[0].handlers.onFrame({
    type: "event",
    event: event(1, "session_started"),
  });
  h.render(thread("b"));
  await settle();
  release([{ ...thread(), title: "stale metadata" }]);
  await settle();
  assert.equal(h.render().effectiveThread.agentId, "b");
  h.unmount();
});
test("an unavailable conversation keeps the desktop's reason and retries on request", async () => {
  const h = fixture();
  h.render();
  await settle();
  h.connections[0].handlers.onState("unavailable", "Conversation is unavailable.");
  let view = h.render();
  assert.equal(view.state, "unavailable");
  assert.equal(view.notice, "Conversation is unavailable.");
  view.retry();
  assert.equal(h.connections[0].retried, 1);
  assert.equal(h.render().notice, "");
  h.unmount();
});
test("an oversized message is refused before it is persisted or queued", async () => {
  const h = fixture();
  h.render();
  await settle();
  await assert.rejects(h.render().queueSend("x".repeat(200_001)), /at most 200,000/);
  assert.equal(h.commands.length, 0);
  assert.equal(await h.store.load("a"), null);
  assert.equal(h.render().optimistic.length, 0);
  h.unmount();
});
test("a refused send is shown as failed with its reason until the person removes it", async () => {
  const h = fixture();
  h.render();
  await settle();
  const id = await h.render().queueSend("hello");
  h.connections[0].handlers.onFrame({ type: "commandResult", commandId: id, ok: false, code: "too_large" });
  await settle();
  let view = h.render();
  assert.equal(view.optimistic.length, 1);
  assert.equal(view.optimistic[0].failed, "This message is too large for the desktop.");
  assert.equal(view.queued.length, 0);
  assert.equal((await h.store.load("a")).pending.length, 0, "a refused send leaves the durable outbox");
  view.dismissFailed(id);
  assert.equal(h.render().optimistic.length, 0);
  h.unmount();
});
const snapshotFrame = (events, generation, reset = true) => ({
  type: "snapshot",
  ...(reset ? { reset: true } : {}),
  generation,
  page: { events, hasMore: false, beforeCursor: null },
});
test("the fence's generation and cursor are cached and a reopened conversation resumes from them", async () => {
  const h = fixture();
  h.render();
  await settle();
  const frames = h.connections[0].handlers;
  frames.onFrame(snapshotFrame([event(2, "user_message", { text: "hi" }), event(3, "turn_completed")], "gen-1"));
  frames.onFrame({ type: "synchronized", seq: 3, generation: "gen-1" });
  await settle();
  let cached = await h.store.load("a");
  assert.equal(cached.lastSeq, 3);
  assert.equal(cached.generation, "gen-1");
  frames.onFrame({ type: "event", event: event(9, "content_delta", { text: "after a gap" }) });
  await settle();
  cached = await h.store.load("a");
  assert.equal(cached.lastSeq, 9, "a gap in sequence numbers is simply the next position");
  h.render(thread("b"));
  await settle();
  h.render(thread("a"));
  await settle();
  const reopened = h.connections.at(-1);
  assert.equal(reopened.key.agentId, "a");
  assert.equal(reopened.seq, 9);
  assert.equal(reopened.options.generation, "gen-1");
  const view = h.render();
  assert.deepEqual({ ...view.page }, { hasMore: true, beforeCursor: 2 }, "older turns stay reachable without a snapshot");
  assert.ok(view.rows.length > 0, "cached events render before the desktop answers");
  h.unmount();
});
test("a reset from a new log generation drops the cached transcript and cursor", async () => {
  const h = fixture();
  h.render();
  await settle();
  const frames = h.connections[0].handlers;
  frames.onFrame(snapshotFrame([event(40, "user_message", { text: "old log" })], "gen-1"));
  frames.onFrame({ type: "synchronized", seq: 40, generation: "gen-1" });
  await settle();
  frames.onFrame(snapshotFrame([event(1, "user_message", { text: "new log" })], "gen-2"));
  frames.onFrame({ type: "synchronized", seq: 1, generation: "gen-2" });
  await settle();
  const cached = await h.store.load("a");
  assert.deepEqual(cached.events.map((item) => item.payload.text), ["new log"]);
  assert.equal(cached.lastSeq, 1);
  assert.equal(cached.generation, "gen-2");
  h.unmount();
});

test("a model switch goes out as setModel, and the thread names the new model only once the desktop accepts it", async () => {
  const h = fixture();
  let listed = 0;
  h.list(async () => {
    listed++;
    return [{ ...thread(), modelId: "model-b" }];
  });
  h.render({ ...thread(), modelId: "model-a" });
  await settle();
  const switching = h.render().setModel("model-b");
  const sent = h.commands.at(-1);
  // Built in the hook's own realm, so compared by value rather than prototype.
  assert.equal(JSON.stringify(sent.command), JSON.stringify({ kind: "setModel", modelId: "model-b" }));
  assert.equal(h.render().effectiveThread.modelId, "model-a");
  h.connections[0].handlers.onFrame({
    type: "commandResult",
    commandId: sent.id,
    ok: true,
    notice: "The new model starts with your next message.",
  });
  assert.equal(
    JSON.stringify(await switching),
    JSON.stringify({ ok: true, notice: "The new model starts with your next message." }),
  );
  await settle();
  assert.equal(h.render().effectiveThread.modelId, "model-b");
  assert.equal(listed, 1, "the list is read again to confirm the model");
  h.unmount();
});
test("a refused model switch says why and leaves the model where it was", async () => {
  const h = fixture();
  h.render({ ...thread(), modelId: "model-a" });
  await settle();
  const switching = h.render().setModel("elsewhere");
  h.connections[0].handlers.onFrame({
    type: "commandResult",
    commandId: h.commands.at(-1).id,
    ok: false,
    code: "unsupported_model",
  });
  const result = await switching;
  assert.equal(result.ok, false);
  assert.match(result.message, /not in this chat's list/);
  assert.equal(h.render().effectiveThread.modelId, "model-a");
  assert.equal(h.render().notice, "", "the refusal belongs to the model control, not the banner");
  h.unmount();
});
test("a model switch still unanswered when the link drops settles as unconfirmed", async () => {
  const h = fixture();
  h.render({ ...thread(), modelId: "model-a" });
  await settle();
  const switching = h.render().setModel("model-b");
  h.connections[0].handlers.onState("offline", "Desktop is unavailable.");
  const result = await switching;
  assert.equal(result.ok, false);
  assert.match(result.message, /before confirming/);
  h.unmount();
});
test("a permission change goes out as setPermissionPreset, and the thread takes it only once the desktop accepts it", async () => {
  const h = fixture();
  h.render({ ...thread(), permissionPreset: "none" });
  await settle();
  const changing = h.render().setPermissionPreset("bypass");
  const sent = h.commands.at(-1);
  assert.equal(JSON.stringify(sent.command), JSON.stringify({ kind: "setPermissionPreset", preset: "bypass" }));
  assert.equal(h.render().effectiveThread.permissionPreset, "none");
  h.connections[0].handlers.onFrame({ type: "commandResult", commandId: sent.id, ok: true });
  assert.equal((await changing).ok, true);
  assert.equal(h.render().effectiveThread.permissionPreset, "bypass");
  const refused = h.render().setPermissionPreset("none");
  h.connections[0].handlers.onFrame({ type: "commandResult", commandId: h.commands.at(-1).id, ok: false });
  const result = await refused;
  assert.equal(result.ok, false);
  assert.match(result.message, /refused the permission change/);
  assert.equal(h.render().effectiveThread.permissionPreset, "bypass");
  const lost = h.render().setPermissionPreset("none");
  h.connections[0].handlers.onState("offline", "Desktop is unavailable.");
  assert.match((await lost).message, /before confirming the permission change/);
  h.unmount();
});

test("an answer to a request whose session the desktop lost says the request ended with it", async () => {
  const h = fixture();
  h.render();
  await settle();
  h.render().command({ kind: "resolveApproval", requestId: "req-1", decision: "once" });
  const sent = h.commands.at(-1);
  h.connections[0].handlers.onFrame({
    type: "commandResult",
    commandId: sent.id,
    ok: false,
    code: "unavailable",
    message: "Conversation session is invalid.",
  });
  await settle();
  assert.match(h.render().actionErrors["req-1"], /ended with the session it belonged to/);
  h.unmount();
});

// A refused request said its bare code ("unavailable", "not_found") where the
// person looked for why Load earlier, a step's detail or a diff failed.
test("a refused request says the desktop's words, or what its code means", async () => {
  const h = fixture();
  const chat = h.render();
  await settle();
  const frames = h.connections[0].handlers;
  const said = chat.request({ type: "getTurnDiff", turnSeq: 4 });
  frames.onFrame({ type: "result", requestId: "request", ok: false, code: "unavailable", message: "That turn has no checkpoint." });
  await assert.rejects(said, { message: "That turn has no checkpoint." });
  const bare = chat.request({ type: "getTurnDiff", turnSeq: 4 });
  frames.onFrame({ type: "result", requestId: "request", ok: false, code: "busy" });
  await assert.rejects(bare, { message: "The desktop is busy. Try again in a moment." });
  const unknown = chat.request({ type: "getTurnDiff", turnSeq: 4 });
  frames.onFrame({ type: "result", requestId: "request", ok: false, code: "unavailable" });
  await assert.rejects(unknown, { message: "The desktop could not answer that. Try again." });
  h.unmount();
});
test("a message with line or paragraph separators goes as one send with plain line breaks", async () => {
  const h = fixture();
  h.render();
  await settle();
  const id = await h.render().queueSend("First stretch.\u2029Second stretch.\r\nThird.\u2028Fourth.");
  const sends = h.commands.filter((item) => item.command.kind === "send");
  assert.equal(sends.length, 1, "one send, not one per line");
  assert.equal(sends[0].id, id);
  assert.equal(sends[0].command.message, "First stretch.\nSecond stretch.\nThird.\nFourth.");
  assert.equal(h.render().optimistic[0].text, "First stretch.\nSecond stretch.\nThird.\nFourth.");
  h.unmount();
});
test("streamed words are drawn together in one window, and a message lands the moment it arrives", async () => {
  const h = fixture();
  h.render();
  await settle();
  const frames = h.connections[0].handlers;
  frames.onFrame(snapshotFrame([event(1, "user_message", { text: "hi" }), event(2, "turn_started", { turnId: "t" })], "gen-1"));
  await settle();
  const said = () =>
    h
      .render()
      .rows.filter((row) => row.kind === "message" && row.role === "assistant")
      .map((row) => row.text)
      .join("");
  frames.onFrame({ type: "event", event: event(3, "content_delta", { turnId: "t", text: "one " }) });
  frames.onFrame({ type: "event", event: event(4, "content_delta", { turnId: "t", text: "two" }) });
  assert.equal(said(), "", "a delta waits for the rest of its window");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(said(), "one two", "the window's deltas are drawn in one pass");
  frames.onFrame({ type: "event", event: event(5, "content_delta", { turnId: "t", text: "!" }) });
  frames.onFrame({ type: "event", event: event(6, "turn_completed", { turnId: "t" }) });
  assert.equal(said(), "one two!", "an event that is not a delta draws at once, with the deltas before it");
  h.unmount();
});
test("a streaming reply is written once per window, and leaving the chat writes what was waiting", async () => {
  const h = fixture();
  h.render();
  await settle();
  const frames = h.connections[0].handlers;
  frames.onFrame(snapshotFrame([event(1, "user_message", { text: "hi" }), event(2, "turn_started", { turnId: "t" })], "gen-1"));
  await settle();
  const delta = (seq, text) => frames.onFrame({ type: "event", event: event(seq, "content_delta", { turnId: "t", text }) });
  delta(3, "one ");
  await settle();
  assert.equal((await h.store.load("a")).lastSeq, 3, "the first delta after a quiet spell is written at once");
  delta(4, "two ");
  delta(5, "three");
  await settle();
  assert.equal((await h.store.load("a")).lastSeq, 3, "the deltas inside the window wait");
  h.render(thread("b"));
  await settle();
  const cached = await h.store.load("a");
  assert.equal(cached.lastSeq, 5, "leaving the chat writes the newest log");
  assert.equal(
    cached.events.filter((item) => item.type === "content_delta").map((item) => item.payload.text).join(""),
    "one two three",
  );
  h.unmount();
});
test("a turn's end is written at once, with the deltas waiting before it", async () => {
  const h = fixture();
  h.render();
  await settle();
  const frames = h.connections[0].handlers;
  frames.onFrame(snapshotFrame([event(1, "turn_started", { turnId: "t" })], "gen-1"));
  await settle();
  frames.onFrame({ type: "event", event: event(2, "content_delta", { turnId: "t", text: "a" }) });
  frames.onFrame({ type: "event", event: event(3, "content_delta", { turnId: "t", text: "b" }) });
  frames.onFrame({ type: "event", event: event(4, "turn_completed", { turnId: "t" }) });
  await settle();
  await settle();
  assert.equal((await h.store.load("a")).lastSeq, 4);
  h.unmount();
});

// ── Messages the desktop holds (`conversation-queued-sends`) ─────────────────
/** Out of the hook's realm, so deepEqual compares values, not prototypes. */
const plain = (value) => JSON.parse(JSON.stringify(value));
const holding = () => fixture({ capabilities: ["conversations", "conversation-queued-sends"] });
/** A turn running on the screen's stream, as the desktop would show it. */
async function runTurn(h) {
  const frames = h.connections.at(-1).handlers;
  frames.onFrame({ type: "event", event: event(1, "user_message", { text: "go", turnId: "t1" }) });
  frames.onFrame({ type: "event", event: event(2, "turn_started", { turnId: "t1" }) });
  await settle();
  return frames;
}
test("behind a running turn, a desktop that holds messages is handed the message as queue, without uploads", async () => {
  const h = holding();
  h.render();
  await settle();
  assert.equal(h.connections[0].options.queuedSends, true, "the stream watches what the desktop holds");
  const frames = await runTurn(h);
  const id = await h.render().queueSend("draft the phone side");
  assert.deepEqual(plain(h.commands.at(-1).command), { kind: "send", message: "draft the phone side", queue: true });
  let chat = h.render();
  assert.deepEqual(plain(chat.handing), [{ commandId: id, text: "draft the phone side" }]);
  assert.deepEqual(plain(chat.queued), [], "the phone holds nothing");
  assert.equal(chat.optimistic.length, 1, "kept until the desktop answers, drawn in the queued bubble");
  assert.deepEqual(
    plain((await h.store.load("a")).pending.map((item) => [item.command.queue, item.heldAfter])),
    [[true, 2]],
    "kept on disk until answered, with the cursor it was queued at (after the turn's two events)",
  );
  // The desktop lists it, then answers.
  frames.onFrame({ type: "queued", key: { workspaceId: "w", agentId: "a" }, messages: [{ id: "q1", text: "draft the phone side", createdAt: 3 }] });
  chat = h.render();
  assert.deepEqual(chat.desktopHeld.map((message) => message.id), ["q1"]);
  assert.deepEqual(plain(chat.handing), [], "drawn from the desktop's list alone");
  assert.equal(chat.optimistic.length, 0);
  frames.onFrame({ type: "commandResult", commandId: id, ok: true });
  await settle();
  assert.equal((await h.store.load("a")).pending.length, 0, "the desktop's now: never offered by this phone again");
  // Sent when the turn ended: the desktop's list empties.
  frames.onFrame({ type: "queued", key: { workspaceId: "w", agentId: "a" }, messages: [] });
  assert.deepEqual(plain(h.render().desktopHeld), []);
  h.unmount();
});
test("a message with pictures, or with no turn running, or behind one the phone holds, is not handed over", async () => {
  const h = holding();
  h.render();
  await settle();
  await h.render().queueSend("idle");
  assert.deepEqual(plain(h.commands.at(-1).command), { kind: "send", message: "idle", uploadIds: [] });
  await runTurn(h);
  await h.render().queueSend("with a picture", ["upload-1"]);
  assert.deepEqual(plain(h.commands.at(-1).command), { kind: "send", message: "with a picture", uploadIds: ["upload-1"] });
  await h.render().queueSend("after the picture");
  assert.equal(h.commands.at(-1).command.queue, undefined, "kept in order behind the phone's own");
  assert.deepEqual(plain(h.render().queued.map((item) => item.text)), ["idle", "with a picture", "after the picture"]);
  h.unmount();
});
test("a desktop without the capability keeps the phone-held queue exactly as before", async () => {
  const h = fixture();
  h.render();
  await settle();
  assert.equal(h.connections[0].options.queuedSends, false);
  await runTurn(h);
  await h.render().queueSend("phone held");
  assert.deepEqual(plain(h.commands.at(-1).command), { kind: "send", message: "phone held", uploadIds: [] });
  assert.deepEqual(plain(h.render().queued.map((item) => item.text)), ["phone held"]);
  assert.deepEqual(plain(h.render().handing), []);
  h.unmount();
});
test("taking a held message back sends cancelQueued and says the desktop's reason when it is already on its way", async () => {
  const h = holding();
  h.render();
  await settle();
  const frames = await runTurn(h);
  const given = h.render().cancelHeld("q1");
  const first = h.commands.at(-1);
  assert.deepEqual(plain(first.command), { kind: "cancelQueued", queuedId: "q1" });
  frames.onFrame({ type: "commandResult", commandId: first.id, ok: true });
  assert.deepEqual(plain(await given), { ok: true });
  const refused = h.render().cancelHeld("q2");
  const second = h.commands.at(-1);
  frames.onFrame({ type: "commandResult", commandId: second.id, ok: false, message: "That message is already on its way into the chat." });
  assert.deepEqual(plain(await refused), { ok: false, message: "That message is already on its way into the chat." });
  assert.equal(h.render().notice, "", "said where the person asked, not as the chat's notice");
  h.unmount();
});
test("a hand-over the desktop refuses shows as not sent, with its reason", async () => {
  const h = holding();
  h.render();
  await settle();
  const frames = await runTurn(h);
  const id = await h.render().queueSend("one too many");
  frames.onFrame({ type: "commandResult", commandId: id, ok: false, message: "This chat already holds as many queued messages as it can." });
  await settle();
  const chat = h.render();
  assert.deepEqual(plain(chat.handing), []);
  assert.deepEqual(plain(chat.optimistic.map((item) => item.failed)), ["This chat already holds as many queued messages as it can."]);
  h.unmount();
});
test("an unanswered hand-over cached when the chat closed is carried as one, and reopened as one", async () => {
  const h = holding();
  h.render();
  await settle();
  await runTurn(h);
  const id = await h.render().queueSend("still on its way");
  h.render(thread("b"));
  await settle();
  const [, carried] = streamsFor(h, "a");
  assert.equal(carried.options.queuedSends, true);
  assert.deepEqual(
    plain(carried.options.pendingSends.map((item) => [item.commandId, item.command.queue, item.heldAfter])),
    [[id, true, 2]],
    "carried with the cursor it was queued at, so the courier can tell it landed",
  );
  carried.handlers.onFrame({ type: "commandResult", commandId: id, ok: true });
  await settle();
  assert.equal(carried.closed, true);
  assert.equal((await h.store.load("a")).pending.length, 0);
  h.unmount();
});
const inBackground = (fields = {}) => ({ ...thread(), phase: "completed", backgroundWork: { agents: 1, monitors: 0 }, ...fields });
test("a chat whose turn ended with work in the background reads as working, never as a turn", async () => {
  const h = holding();
  h.list(async () => [inBackground()]);
  const chat = h.render(inBackground());
  await settle();
  assert.equal(chat.busy, true, "the working line shows");
  assert.equal(chat.inBackground, true);
  assert.equal(chat.turnBusy, false);
  assert.equal(h.connections[0].options.initiallyBusy, false, "the stream holds nothing back for it");
  h.unmount();
});
test("a message sent while an agent works in the background goes straight to the desktop", async () => {
  const h = holding();
  h.list(async () => [inBackground()]);
  h.render(inBackground());
  await settle();
  await h.render().queueSend("and the docs too");
  assert.deepEqual(plain(h.commands.at(-1).command), { kind: "send", message: "and the docs too", uploadIds: [] });
  assert.deepEqual(plain(h.render().handing), [], "not handed to the desktop to hold behind a turn");
  h.unmount();
});
test("a chat from an older desktop, whose list names no background work, rests when its turn ends", async () => {
  const h = fixture();
  const chat = h.render({ ...thread(), phase: "completed" });
  await settle();
  assert.equal(chat.busy, false);
  assert.equal(chat.inBackground, false);
  h.unmount();
});
test("an agent's end reads the desktop's list again, and the chat stops working when nothing is left", async () => {
  const h = fixture();
  let reads = 0;
  let listedNow = [inBackground()];
  h.list(async () => {
    reads++;
    return listedNow;
  });
  h.render(inBackground());
  await settle();
  const frames = h.connections[0].handlers;
  frames.onFrame({ type: "event", event: event(1, "subagent_status", { toolUseId: "tool-1", status: "running", background: true }) });
  await settle();
  assert.equal(reads, 0, "an agent's progress is not a reason to read the list");
  listedNow = [{ ...thread(), phase: "completed" }];
  frames.onFrame({ type: "event", event: event(2, "subagent_status", { toolUseId: "tool-1", status: "completed", background: true }) });
  await settle();
  assert.equal(reads, 1);
  assert.equal(h.render().busy, false);
  assert.equal(h.render().inBackground, false);
  h.unmount();
});
test("a list read asked for while one is out is read again after it, so a late end is not missed", async () => {
  const h = fixture();
  const answers = [];
  h.list(() => new Promise((resolve) => answers.push(resolve)));
  h.render(inBackground());
  await settle();
  const frames = h.connections[0].handlers;
  frames.onFrame({ type: "event", event: event(1, "session_updated", { backgroundTasks: [] }) });
  frames.onFrame({ type: "event", event: event(2, "subagent_status", { toolUseId: "tool-1", status: "completed" }) });
  await settle();
  assert.equal(answers.length, 1, "one read at a time");
  answers[0]([inBackground()]);
  await settle();
  assert.equal(answers.length, 2, "the end that came while it was out is read for");
  answers[1]([{ ...thread(), phase: "completed" }]);
  await settle();
  assert.equal(h.render().inBackground, false);
  h.unmount();
});
