const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  createTranscriptMemory,
  transcriptKey,
} = require("../../.mobile-test-build/src/storage/transcriptMemory.js");

const event = (seq, text = "hello") => ({
  id: `e-${seq}`,
  seq,
  type: "content_delta",
  sessionId: "s",
  workspaceId: "w",
  agentId: "a",
  createdAt: seq,
  payload: { text },
});
const transcript = (lastSeq, text) => ({ events: [event(lastSeq, text)], lastSeq, generation: "gen-1" });

test("the least recently opened chat is dropped first, and opening one keeps it", () => {
  const memory = createTranscriptMemory({ maxEntries: 2, maxChars: 1_000_000 });
  memory.remember("a", transcript(1));
  memory.remember("b", transcript(2));
  assert.equal(memory.recall("a").lastSeq, 1, "recalling a chat makes it the most recent");
  memory.remember("c", transcript(3));
  assert.deepEqual(memory.keys(), ["a", "c"]);
  assert.equal(memory.recall("b"), null);
});

test("the held transcripts stay under the character budget, but the newest is kept whatever its size", () => {
  const memory = createTranscriptMemory({ maxEntries: 10, maxChars: 1_000 });
  memory.remember("a", transcript(1, "x".repeat(300)));
  memory.remember("b", transcript(2, "x".repeat(300)));
  assert.deepEqual(memory.keys(), ["a", "b"]);
  memory.remember("c", transcript(3, "x".repeat(300)));
  assert.deepEqual(memory.keys(), ["b", "c"]);
  memory.remember("huge", transcript(4, "x".repeat(5_000)));
  assert.deepEqual(memory.keys(), ["huge"]);
});

test("a chat written again replaces what was held for it", () => {
  const memory = createTranscriptMemory();
  memory.remember("a", transcript(1, "before"));
  memory.remember("a", { events: [], lastSeq: 0 });
  assert.deepEqual(memory.recall("a"), { events: [], lastSeq: 0 });
  memory.forget("a");
  assert.equal(memory.recall("a"), null);
});

test("the key names the desktop as well as the chat", () => {
  const chat = { workspaceId: "w", agentId: "a" };
  assert.notEqual(transcriptKey("first", chat), transcriptKey("second", chat));
  assert.equal(transcriptKey("first", chat), transcriptKey("first", { ...chat }));
});

test("short of memory, only the chat on screen is kept", () => {
  const memory = createTranscriptMemory();
  memory.remember("a", transcript(1));
  memory.remember("b", transcript(2));
  memory.remember("c", transcript(3));
  memory.shed();
  assert.deepEqual(memory.keys(), ["c"]);
  assert.equal(memory.recall("c").lastSeq, 3);
  createTranscriptMemory().shed();
});
