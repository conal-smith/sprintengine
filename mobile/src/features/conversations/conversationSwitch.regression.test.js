/* global __dirname */
// Switching between chats: what reopening one costs. Runs the production hook
// under a deterministic state/effect runner (as usePhoneConversation's own
// suite does) against a gateway that counts what it is asked for and a disk
// whose every read and write takes a turn of the event loop, the way a phone's
// file system answers.
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
const { createConversationCacheStore } = localRequire("../../storage/conversationCacheModel.js");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const drain = async () => {
  for (let i = 0; i < 400; i++) await tick();
};
const thread = (agentId) => ({ workspaceId: "w", agentId, phase: "idle", title: agentId });
const event = (agentId, seq, type, payload = {}) => ({
  id: `${agentId}-e${seq}`,
  seq,
  type,
  sessionId: `s-${agentId}`,
  workspaceId: "w",
  agentId,
  createdAt: seq,
  payload,
});
/** Ten finished turns, as the desktop's reset snapshot carries them (turnLimit 10). */
const finishedTurns = (agentId, from = 1) => {
  const events = [];
  let seq = from;
  for (let turn = 0; turn < 10; turn++) {
    events.push(event(agentId, seq++, "user_message", { text: `question ${turn}`, turnId: `t${turn}` }));
    events.push(event(agentId, seq++, "turn_started", { turnId: `t${turn}` }));
    for (let part = 0; part < 10; part++)
      events.push(event(agentId, seq++, "content_delta", { text: `answer ${turn}.${part} `.repeat(8), turnId: `t${turn}` }));
    events.push(event(agentId, seq++, "turn_completed", { turnId: `t${turn}` }));
  }
  return events;
};

function harness({ deviceId = "device" } = {}) {
  const slots = [];
  const effects = [];
  const connections = [];
  const files = new Map();
  const disk = { reads: 0, bytesRead: 0, writes: 0 };
  let cursor = 0;
  let selected = thread("a");
  let serial = 0;
  let listed = 0;
  const store = createConversationCacheStore({
    keys: async () => {
      await tick();
      return [...files.keys()];
    },
    read: async (key) => {
      await tick();
      disk.reads++;
      const text = files.get(key) ?? null;
      disk.bytesRead += text?.length ?? 0;
      return text;
    },
    write: async (key, value) => {
      await tick();
      disk.writes++;
      files.set(key, value);
    },
    remove: async (key) => {
      await tick();
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
  const api = {
    list: async () => {
      listed++;
      return [];
    },
    open(key, seq, handlers, options) {
      const connection = { key, seq, options, handlers, cancelPending() {}, close() {}, foreground() {}, retry() {} };
      connection.sent = [];
      connection.command = (command, id) => {
        connection.sent.push(id ?? "command");
        return id ?? "command";
      };
      connection.request = () => "request";
      connections.push(connection);
      return connection;
    },
  };
  const cache = {
    MAX_PENDING_SENDS: 20,
    loadConversationCache: (_device, key) => store.load(key.agentId),
    updateConversationCache: (_device, key, updater) => store.update(key.agentId, updater),
  };
  // Each harness is its own app process: a fresh module, so nothing the hook
  // keeps between screens leaks from one test into the next.
  const module = { exports: {} };
  const fresh = new Map();
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
          return { AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } };
        if (name === "expo-crypto") return { randomUUID: () => `send-${++serial}` };
        if (name.endsWith("/tailnetConversations")) return { createTailnetConversationsApi: () => api };
        if (name.endsWith("/conversationCache")) return cache;
        if (name.endsWith("/transcriptMemory")) {
          if (!fresh.has(name)) {
            const resolved = localRequire.resolve(name);
            const source = { exports: {} };
            vm.runInNewContext(fs.readFileSync(resolved, "utf8"), { exports: source.exports, module: source, require: localRequire });
            fresh.set(name, source.exports);
          }
          return fresh.get(name);
        }
        return localRequire(name);
      },
    },
    { filename: compiled },
  );
  const session = { deviceId, baseUrl: "https://desktop.example.ts.net", deviceToken: "test-token" };
  let renders = 0;
  const render = (next = selected) => {
    selected = next;
    cursor = 0;
    renders++;
    const result = module.exports.usePhoneConversation(session, selected);
    while (effects.length) effects.shift()();
    return result;
  };
  return {
    render,
    connections,
    disk,
    store,
    get listed() {
      return listed;
    },
    get renders() {
      return renders;
    },
    /** Leave the chat: the screen unmounts, as popping it off the stack does. */
    unmount() {
      for (const slot of slots) slot?.cleanup?.();
      slots.length = 0;
    },
  };
}

/** What the desktop sends a subscription: only what follows its cursor, or a reset of the last ten turns. */
function desktopAnswer(log, generation, connection) {
  const resumes = connection.options?.generation === generation && connection.seq > 0;
  return resumes ? log.filter((item) => item.seq > connection.seq) : log.slice(-finishedTurns("x").length);
}

/**
 * Open chat A, read it to its fence, watch a reply stream in, and leave while
 * the reply is still being written to disk (or, with `stayed`, once it all
 * has been); open B the same way; then go back to A. Returns what the return
 * to A cost.
 */
async function switchBack({ streamed, stayed = false }) {
  const h = harness();
  const logs = {};
  for (const agentId of ["a", "b"]) {
    h.render(thread(agentId));
    await drain();
    const connection = h.connections.at(-1);
    const log = finishedTurns(agentId);
    connection.handlers.onFrame({ type: "snapshot", reset: true, generation: `gen-${agentId}`, page: { events: log, hasMore: true, beforeCursor: 1 } });
    connection.handlers.onFrame({ type: "synchronized", seq: log.at(-1).seq, generation: `gen-${agentId}` });
    await drain();
    // The next question, and its answer streaming in.
    let seq = log.at(-1).seq + 1;
    const live = [event(agentId, seq++, "user_message", { text: "one more", turnId: "live" }), event(agentId, seq++, "turn_started", { turnId: "live" })];
    for (let part = 0; part < streamed; part++) {
      const kind = part % 3 === 0 ? "tool_started" : part % 3 === 1 ? "tool_completed" : "content_delta";
      live.push(event(agentId, seq++, kind, { text: `step ${part}`, toolCallId: `call-${Math.floor(part / 3)}`, turnId: "live" }));
    }
    for (const item of live) connection.handlers.onFrame({ type: "event", event: item });
    // The person goes back a moment later: a few disk turns, not all of them.
    if (stayed) {
      // Until the disk has gone quiet: every queued write has landed.
      let quiet = 0;
      let seen = -1;
      while (quiet < 50) {
        await tick();
        quiet = h.disk.writes === seen ? quiet + 1 : 0;
        seen = h.disk.writes;
      }
    }
    else for (let i = 0; i < 6; i++) await tick();
    h.unmount();
    logs[agentId] = [...log, ...live];
  }
  const before = { reads: h.disk.reads, bytesRead: h.disk.bytesRead, listed: h.listed };
  const firstFrame = h.render(thread("a"));
  const firstFrameMessages = firstFrame.rows.length;
  let commits = 1;
  let view = firstFrame;
  while (!view.rows.length && commits < 50) {
    await tick();
    view = h.render();
    commits++;
  }
  await drain();
  const reopened = h.connections.at(-1);
  const resent = desktopAnswer(logs.a, "gen-a", reopened);
  reopened.handlers.onFrame({
    type: "snapshot",
    ...(reopened.options?.generation === "gen-a" && reopened.seq > 0 ? {} : { reset: true }),
    generation: "gen-a",
    page: { events: resent, hasMore: false, beforeCursor: null },
  });
  await drain();
  const result = {
    firstFrameMessages,
    commitsToFirstMessage: commits,
    diskReads: h.disk.reads - before.reads,
    jsonBytesParsed: h.disk.bytesRead - before.bytesRead,
    resumedFrom: reopened.seq,
    eventsResent: resent.length,
    bytesResent: JSON.stringify(resent).length,
    metadataReads: h.listed - before.listed,
    rowsAfterCatchUp: h.render().rows.length,
  };
  h.unmount();
  return result;
}

test("going back to a chat left while its reply streamed", async () => {
  const result = await switchBack({ streamed: 40 });
  if (process.env.MEASURE_SWITCH) console.log("switch-back, 40 streamed", JSON.stringify(result));
  // The disk was still writing the reply when the chat closed; the
  // remembered transcript was not, so nothing is fetched twice.
  assert.equal(result.firstFrameMessages, result.rowsAfterCatchUp, "the transcript is drawn on the first frame");
  assert.equal(result.commitsToFirstMessage, 1);
  assert.equal(result.resumedFrom, 172, "resumes after the last streamed event");
  assert.equal(result.eventsResent, 0);
  assert.equal(result.metadataReads, 0);
});

test("going back to a chat read to the end of its reply", async () => {
  const result = await switchBack({ streamed: 40, stayed: true });
  if (process.env.MEASURE_SWITCH) console.log("switch-back, 40 streamed, stayed", JSON.stringify(result));
  assert.equal(result.firstFrameMessages, result.rowsAfterCatchUp);
  assert.equal(result.commitsToFirstMessage, 1);
  assert.equal(result.resumedFrom, 172);
  assert.equal(result.eventsResent, 0);
});

test("going back to a chat whose live turn outgrew the disk cache", async () => {
  const result = await switchBack({ streamed: 400, stayed: true });
  if (process.env.MEASURE_SWITCH) console.log("switch-back, 400 streamed, stayed", JSON.stringify(result));
  // One turn of 400 events is past what the disk keeps whole, so the disk
  // copy starts again from nothing; the remembered one still resumes.
  assert.equal(result.firstFrameMessages, result.rowsAfterCatchUp);
  assert.equal(result.commitsToFirstMessage, 1);
  assert.equal(result.resumedFrom, 532);
  assert.equal(result.eventsResent, 0);
});

test("a desktop that forked, rewound or restarted the chat replaces the remembered transcript with its new log", async () => {
  const h = harness();
  h.render(thread("a"));
  await drain();
  let connection = h.connections.at(-1);
  connection.handlers.onFrame({
    type: "snapshot",
    reset: true,
    generation: "gen-1",
    page: { events: [event("a", 1, "user_message", { text: "before the rewind" }), event("a", 2, "turn_completed")], hasMore: false, beforeCursor: null },
  });
  connection.handlers.onFrame({ type: "synchronized", seq: 2, generation: "gen-1" });
  await drain();
  h.unmount();

  // Reopened: the old log is drawn at once and offered back with its generation.
  let view = h.render(thread("a"));
  assert.equal(view.rows.length > 0, true);
  await drain();
  connection = h.connections.at(-1);
  assert.equal(connection.seq, 2);
  assert.equal(connection.options.generation, "gen-1");
  // The desktop's log moved on, so it answers with a reset from the new one.
  connection.handlers.onFrame({
    type: "snapshot",
    reset: true,
    generation: "gen-2",
    page: { events: [event("a", 1, "user_message", { text: "after the rewind" })], hasMore: false, beforeCursor: null },
  });
  connection.handlers.onFrame({ type: "synchronized", seq: 1, generation: "gen-2" });
  await drain();
  view = h.render();
  assert.deepEqual(
    view.rows.flatMap((row) => (typeof row.text === "string" ? [row.text] : [])),
    ["after the rewind"],
  );
  h.unmount();

  // Nothing of the old log comes back on the next visit.
  view = h.render(thread("a"));
  assert.deepEqual(
    view.rows.flatMap((row) => (typeof row.text === "string" ? [row.text] : [])),
    ["after the rewind"],
  );
  await drain();
  connection = h.connections.at(-1);
  assert.equal(connection.seq, 1);
  assert.equal(connection.options.generation, "gen-2");
  h.unmount();
});

test("a reopened chat still offers its unsent messages from the disk outbox", async () => {
  const h = harness();
  h.render(thread("a"));
  await drain();
  const connection = h.connections.at(-1);
  connection.handlers.onFrame({ type: "synchronized", seq: 0 });
  await drain();
  const sending = h.render().queueSend("still to go");
  await drain();
  const commandId = await sending;
  h.unmount();
  h.render(thread("a"));
  await drain();
  const reopened = h.connections.at(-1);
  assert.deepEqual(
    reopened.options.pendingSends.map((item) => item.commandId),
    [commandId],
  );
  assert.equal(h.render().queued.length, 1);
  h.unmount();
});

test("one desktop's chat is never drawn from another's remembered transcript", async () => {
  const h = harness({ deviceId: "first" });
  h.render(thread("a"));
  await drain();
  h.connections.at(-1).handlers.onFrame({
    type: "snapshot",
    reset: true,
    generation: "gen-1",
    page: { events: [event("a", 1, "user_message", { text: "on the first desktop" })], hasMore: false, beforeCursor: null },
  });
  await drain();
  h.unmount();
  // Same workspace and agent ids, but reached through another pairing.
  const other = harness({ deviceId: "second" });
  assert.equal(other.render(thread("a")).rows.length, 0);
  other.unmount();
});

/**
 * A reply streams in, 1 event per disk turn, and halfway through the person
 * sends a message. Counts the cache writes the stream costs and how many disk
 * turns the message waits before it goes to the desktop.
 */
async function sendDuringStream(streamed) {
  const h = harness();
  h.render(thread("a"));
  await drain();
  const connection = h.connections.at(-1);
  const log = finishedTurns("a");
  connection.handlers.onFrame({ type: "snapshot", reset: true, generation: "gen-a", page: { events: log, hasMore: false, beforeCursor: null } });
  connection.handlers.onFrame({ type: "synchronized", seq: log.at(-1).seq, generation: "gen-a" });
  await drain();
  const writesBefore = h.disk.writes;
  let seq = log.at(-1).seq + 1;
  let sendStartedAt = null;
  let sentAt = null;
  let turns = 0;
  for (let part = 0; part < streamed; part++) {
    connection.handlers.onFrame({ type: "event", event: event("a", seq++, "content_delta", { text: `part ${part} `, turnId: "live" }) });
    if (part === streamed / 2) {
      sendStartedAt = turns;
      void h.render().queueSend("and another thing");
    }
    await tick();
    turns++;
    if (sentAt === null && connection.sent.length) sentAt = turns;
  }
  while (sentAt === null && turns < 100_000) {
    await tick();
    turns++;
    if (connection.sent.length) sentAt = turns;
  }
  let quiet = 0;
  let seen = -1;
  while (quiet < 50) {
    await tick();
    quiet = h.disk.writes === seen ? quiet + 1 : 0;
    seen = h.disk.writes;
  }
  // The reply is still running: its newest deltas wait out the write window
  // until the person leaves the chat, which writes them.
  h.unmount();
  await drain();
  const cached = await h.store.load("a");
  const result = {
    cacheWrites: h.disk.writes - writesBefore,
    diskTurnsBeforeSendLeft: sentAt - sendStartedAt,
    cachedThrough: cached.lastSeq,
    cachedPending: cached.pending.length,
  };
  return { result, lastSeq: seq - 1 };
}

test("a reply streaming in writes the cache without holding up a message sent meanwhile", async () => {
  const { result, lastSeq } = await sendDuringStream(60);
  if (process.env.MEASURE_SWITCH) console.log("send during a 60-event stream", JSON.stringify(result));
  assert.equal(result.cachedThrough, lastSeq, "the disk ends with every event");
  assert.equal(result.cachedPending, 1, "the message stays in the outbox until the desktop acknowledges it");
  // One write per frame was 61 writes, and the message waited 67 disk turns
  // behind them; only the newest waiting write was made, up to 25, and now a
  // streamed delta writes at most once a second: the first, the send's and
  // the one the person leaves with.
  assert.ok(result.cacheWrites <= 5, `${result.cacheWrites} cache writes`);
  assert.ok(result.diskTurnsBeforeSendLeft <= 10, `the send waited ${result.diskTurnsBeforeSendLeft} disk turns`);
});

test("an acknowledgment in a write that a newer one replaced still leaves the outbox", async () => {
  const h = harness();
  h.render(thread("a"));
  await drain();
  const connection = h.connections.at(-1);
  connection.handlers.onFrame({ type: "synchronized", seq: 0, generation: "gen-a" });
  await drain();
  const commandId = await h.render().queueSend("acknowledged mid-stream");
  await drain();
  assert.equal((await h.store.load("a")).pending.length, 1);
  // The receipt and the reply's first events land before the disk has taken any of them.
  connection.handlers.onFrame({ type: "event", event: event("a", 1, "user_message", { text: "acknowledged mid-stream", commandId }) });
  for (let seq = 2; seq < 8; seq++)
    connection.handlers.onFrame({ type: "event", event: event("a", seq, "content_delta", { text: `${seq}` }) });
  await drain();
  assert.equal((await h.store.load("a")).pending.length, 0, "the receipt is written at once");
  h.unmount();
  await drain();
  const cached = await h.store.load("a");
  assert.equal(cached.pending.length, 0);
  assert.equal(cached.lastSeq, 7, "the deltas waiting out the window are written on leaving");
});
