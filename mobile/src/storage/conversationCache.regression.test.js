const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  boundedConversationCache,
  createConversationCacheStore,
} = require("../../.mobile-test-build/src/storage/conversationCacheModel.js");
const event = (
  seq,
  type = "user_message",
  turnId = `turn-${seq}`,
  text = "hello",
) => ({
  id: `e-${seq}`,
  seq,
  type,
  sessionId: "s",
  workspaceId: "w",
  agentId: "a",
  createdAt: seq,
  payload: { turnId, text },
});
const pending = (id) => ({
  commandId: id,
  command: { kind: "send", message: "hello", uploadIds: [] },
});
const value = (id = "one") => ({
  lastSeq: 1,
  events: [event(1)],
  pending: [pending(id)],
});
function fixture() {
  const files = new Map();
  const adapter = {
    keys: async () => [...files.keys()],
    read: async (key) => files.get(key) ?? null,
    write: async (key, text) => {
      files.set(key, text);
    },
    remove: async (key) => {
      files.delete(key);
    },
  };
  return { files, adapter, store: createConversationCacheStore(adapter) };
}
test("revision order survives timestamp ties and one corrupt copy", async () => {
  const { files, store } = fixture();
  await store.save("aa", value("first"));
  await store.save("aa", value("second"));
  for (const [key, text] of files) {
    const data = JSON.parse(text);
    data.savedAt = 1;
    files.set(key, JSON.stringify(data));
  }
  assert.equal((await store.load("aa")).pending[0].commandId, "second");
  files.set("aa-1.json", "{torn");
  assert.equal((await store.load("aa")).pending[0].commandId, "first");
});
test("an interrupted write preserves the other valid copy", async () => {
  const { files, adapter, store } = fixture();
  await store.save("bb", value("saved"));
  adapter.write = async (key) => {
    files.set(key, "{");
    throw new Error("disk full");
  };
  await assert.rejects(store.save("bb", value("new")), /disk full/);
  assert.equal((await store.load("bb")).pending[0].commandId, "saved");
});
test("serial cache transactions preserve the newest concurrent write", async () => {
  const { store } = fixture();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => store.save("cc", value(`send-${i}`))),
  );
  assert.equal((await store.load("cc")).pending[0].commandId, "send-19");
});
test("atomic updates preserve other screens' queued sends and explicit acknowledgements", async () => {
  const { store } = fixture();
  await Promise.all(
    ["first", "second"].map((id) =>
      store.update("aa", (current) => ({
        ...current,
        pending: [...current.pending, pending(id)],
      })),
    ),
  );
  await store.update("aa", (current) => ({
    ...current,
    events: [event(2)],
    lastSeq: 2,
  }));
  assert.deepEqual(
    (await store.load("aa")).pending.map((item) => item.commandId),
    ["first", "second"],
  );
  await store.update("aa", (current) => ({
    ...current,
    pending: current.pending.filter((item) => item.commandId !== "first"),
  }));
  await store.update("aa", (current) => ({
    ...current,
    events: [event(3)],
    lastSeq: 3,
  }));
  assert.deepEqual(
    (await store.load("aa")).pending.map((item) => item.commandId),
    ["second"],
  );
});
test("transient read errors cannot evict or overwrite an unread queue", async () => {
  const { store, files, adapter } = fixture();
  for (let i = 1; i <= 20; i++)
    await store.save(i.toString(16), value(`send-${i}`));
  const before = [...files];
  const read = adapter.read;
  adapter.read = async (key) => {
    if (key.startsWith("1-")) throw new Error("storage unavailable");
    return read(key);
  };
  await assert.rejects(store.save("ff", value("new")), /storage unavailable/);
  await assert.rejects(
    store.update("1", (current) => ({ ...current, pending: [] })),
    /storage unavailable/,
  );
  assert.deepEqual([...files], before);
});
test("unknown corrupt copies are protected from eviction and replacement", async () => {
  const { store, files } = fixture();
  for (let i = 1; i <= 20; i++)
    files.set(`${i.toString(16)}-0.json`, "{unreadable");
  const before = [...files];
  await assert.rejects(store.save("ff", value("new")), /queue is full/);
  await assert.rejects(store.save("1", value("replacement")), /unreadable/);
  assert.deepEqual([...files], before);
});
test("eviction never removes pending sends and refuses overflow before accepting it", async () => {
  const { store, files } = fixture();
  for (let i = 1; i <= 20; i++)
    await store.save(i.toString(16), value(`send-${i}`));
  await assert.rejects(store.save("ff", value("overflow")), /queue is full/);
  await store.save("ff", { ...value(), pending: [] });
  assert.equal(files.size, 20);
  for (let i = 1; i <= 20; i++)
    assert.equal(
      (await store.load(i.toString(16))).pending[0].commandId,
      `send-${i}`,
    );
  await store.save("1", { ...value(), pending: [] });
  await store.save("ff", value("accepted"));
  assert.equal(await store.load("1"), null);
  assert.equal((await store.load("ff")).pending[0].commandId, "accepted");
});
test("cache boundaries retain user/turn pairs and coalesce a streamed current turn", () => {
  const events = [];
  for (let i = 0; i < 200; i++)
    events.push(
      event(i * 3 + 1, "user_message", `t${i}`),
      event(i * 3 + 2, "turn_started", `t${i}`),
      event(i * 3 + 3, "turn_completed", `t${i}`),
    );
  const cached = boundedConversationCache({
    lastSeq: 600,
    events,
    pending: [],
  });
  assert.equal(cached.events.length, 300);
  assert.equal(cached.events[0].type, "user_message");
  assert.equal(cached.events[1].type, "turn_started");
  const streamed = [
    event(1),
    event(2, "turn_started", "turn-1"),
    ...Array.from({ length: 1000 }, (_, i) =>
      event(i + 3, "content_delta", "turn-1", "a"),
    ),
  ];
  const merged = boundedConversationCache({
    lastSeq: 1002,
    events: streamed,
    pending: [],
  });
  assert.equal(merged.events.length, 3);
  assert.equal(merged.events[2].payload.text.length, 1000);
  assert.equal(merged.lastSeq, 1002);
});
test("oversized active turns refetch without dropping pending sends; invalid queued images are rejected", () => {
  const oversized = boundedConversationCache({
    lastSeq: 2,
    events: [
      event(1),
      event(2, "content_delta", "turn-1", "x".repeat(1_100_000)),
    ],
    pending: [pending("keep")],
  });
  assert.equal(oversized.lastSeq, 0);
  assert.deepEqual(oversized.events, []);
  assert.equal(oversized.pending.length, 1);
  assert.throws(
    () =>
      boundedConversationCache({
        ...value(),
        pending: [
          {
            commandId: "bad",
            command: { kind: "send", message: "hello", uploadIds: [42] },
          },
        ],
      }),
    /Invalid/,
  );
  assert.throws(
    () =>
      boundedConversationCache({
        ...value(),
        pending: Array.from({ length: 21 }, (_, i) => pending(String(i))),
      }),
    /Invalid/,
  );
});
test("the resume cursor survives trimming, and is dropped with the events when nothing fits", () => {
  const events = [];
  for (let i = 0; i < 200; i++)
    events.push(event(i * 3 + 1, "user_message", `t${i}`), event(i * 3 + 3, "turn_completed", `t${i}`));
  const trimmed = boundedConversationCache({ lastSeq: 601, generation: "gen-1", events, pending: [] });
  assert.ok(trimmed.events.length < events.length);
  assert.equal(trimmed.lastSeq, 601, "the fence may sit past the newest held event");
  assert.equal(trimmed.generation, "gen-1");
  const emptied = boundedConversationCache({
    lastSeq: 2,
    generation: "gen-1",
    events: [event(1), event(2, "content_delta", "turn-1", "x".repeat(1_100_000))],
    pending: [],
  });
  assert.deepEqual(emptied, { lastSeq: 0, events: [], pending: [] });
  assert.throws(() => boundedConversationCache({ ...value(), generation: "" }), /Invalid/);
  assert.throws(() => boundedConversationCache({ ...value(), generation: "g".repeat(201) }), /Invalid/);
});

test("a handed-over send keeps the cursor it was queued at, and a malformed one is refused", () => {
  const held = { commandId: "h", command: { kind: "send", message: "draft X", queue: true }, heldAfter: 7 };
  const kept = boundedConversationCache({ lastSeq: 7, events: [], pending: [held] });
  assert.deepEqual(kept.pending, [held]);
  for (const heldAfter of [-1, 1.5, "7", null])
    assert.throws(() => boundedConversationCache({ lastSeq: 7, events: [], pending: [{ ...held, heldAfter }] }), /Invalid/);
});

test("an event the wire takes is one the cache keeps, and one it cannot keep costs the transcript, not the write", async () => {
  const { store } = fixture();
  // The wire never asked for these ids: an event without them is on screen.
  const { sessionId: _s, workspaceId: _w, agentId: _a, ...bare } = event(2, "content_delta", "turn-1");
  const kept = await store.update("aa", () => ({ lastSeq: 2, generation: "g", events: [event(1), bare], pending: [pending("keep")] }));
  assert.equal(kept.events.length, 2);
  assert.equal(kept.lastSeq, 2);
  // Something no frame carries: the write lands, the queue is kept, and the
  // cursor goes with the transcript so the next subscription asks afresh.
  const broken = await store.update("aa", (current) => ({
    ...current,
    lastSeq: 3,
    events: [...current.events, { ...event(3), createdAt: 1.5 }],
  }));
  assert.deepEqual(broken, { lastSeq: 0, events: [], pending: [pending("keep")] });
  assert.deepEqual((await store.load("aa")).pending.map((item) => item.commandId), ["keep"]);
});

test("a copy whose transcript is damaged still reads, keeping its queue, so the chat is not refused every write", async () => {
  const { store, files } = fixture();
  await store.save("aa", value("queued"));
  const [key, text] = [...files][0];
  const copy = JSON.parse(text);
  copy.data.events[0].createdAt = "yesterday";
  files.set(key, JSON.stringify(copy));
  assert.deepEqual((await store.load("aa")).pending.map((item) => item.commandId), ["queued"]);
  const saved = await store.update("aa", (current) => ({ ...current, lastSeq: 2, events: [event(2)] }));
  assert.deepEqual(saved.pending.map((item) => item.commandId), ["queued"]);
});

test("a failed read of one copy is not left running into the next write", async () => {
  const { store, adapter } = fixture();
  await store.save("aa", value("first"));
  await store.save("aa", value("second"));
  const read = adapter.read;
  const running = new Set();
  const overlaps = [];
  adapter.read = async (key) => {
    running.add(key);
    try {
      if (key.endsWith("-0.json")) throw new Error("storage unavailable");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await read(key);
    } finally {
      running.delete(key);
    }
  };
  const write = adapter.write;
  adapter.write = async (key, text) => {
    if (running.size) overlaps.push([...running]);
    return write(key, text);
  };
  await assert.rejects(store.save("aa", value("third")), /storage unavailable/);
  adapter.read = read;
  await store.save("aa", value("fourth"));
  assert.deepEqual(overlaps, []);
  assert.equal((await store.load("aa")).pending[0].commandId, "fourth");
});
