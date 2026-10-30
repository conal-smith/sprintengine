/* global __dirname, Buffer */
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const {
  CONVERSATION_MAX_CLIENT_FRAME_BYTES,
  CONVERSATION_MAX_MESSAGE_CHARS,
  conversationSendProblem,
  createConversationChunkAssembler,
  createSnapshotAssembler,
  heldSendLanded,
  parseConversationFrame,
  plainLineBreaks,
} = require("../../.mobile-test-build/src/api/conversationWire.js");

test("portable source matches the jointly verified desktop digest", () => {
  const hash = createHash("sha256");
  for (const name of ["index.ts", "presentation.ts", "tool-types.ts", "toolKind.ts", "commandLabel.ts"]) {
    hash.update(name); hash.update("\0");
    hash.update(readFileSync(join(__dirname, "conversation-protocol", name)));
  }
  assert.equal(hash.digest("hex"), "a1313dd4c44024e14956b1fb461ca30d0d65851ec28162453ffa888af66c5c3c");
});

function chunks(frameId, value, size = 48_000) {
  const json = JSON.stringify(value), total = Math.ceil(json.length / size);
  return Array.from({ length: total }, (_, index) => ({
    type: "chunk", frameId, index, total, json: json.slice(index * size, (index + 1) * size),
  }));
}
function push(assembler, chunk) {
  const parsed = parseConversationFrame(JSON.stringify(chunk));
  assert.ok(parsed, "each chunk satisfies the actual wire parser");
  return assembler.push(parsed);
}

test("more than 128 numbered chunks reassemble once without losing Unicode", () => {
  const original = { type: "result", requestId: "large", ok: true, data: "🙂é".repeat(50_000) };
  const parts = chunks("large", original, 1000);
  assert.ok(parts.length > 128);
  const assembler = createConversationChunkAssembler();
  for (let i = parts.length - 1; i > 0; i--) assert.equal(push(assembler, parts[i]), null);
  assert.deepEqual(push(assembler, parts[0]), original);
  assert.equal(push(assembler, parts[0]), null, "a repeated fragment alone cannot emit a duplicate frame");
});

test("logical frames above eight megabytes but below the shared limit remain readable", () => {
  const original = { type: "result", requestId: "utf8", ok: true, data: "é".repeat(4_300_000) };
  const assembler = createConversationChunkAssembler();
  let result = null;
  for (const chunk of chunks("utf8", original)) result = push(assembler, chunk);
  assert.equal(result.data, original.data);
});

test("aggregate partial-frame bytes evict the oldest unfinished group instead of exceeding the cap", () => {
  const a = chunks("first", { type: "result", requestId: "first", ok: true, data: "a".repeat(17 * 1024 * 1024) }, 128_000);
  const b = chunks("second", { type: "result", requestId: "second", ok: true, data: "b".repeat(17 * 1024 * 1024) }, 128_000);
  const assembler = createConversationChunkAssembler();
  for (const chunk of a.slice(0, -1)) assert.equal(push(assembler, chunk), null);
  let complete = null;
  for (const chunk of b) complete = push(assembler, chunk);
  assert.equal(complete.requestId, "second");
  assert.equal(complete.data.length, 17 * 1024 * 1024);
  assert.equal(push(assembler, a.at(-1)), null, "the evicted first group cannot complete from its final fragment");
});

test("fragment count, oversized frames, duplicate indices and reset stay bounded", () => {
  assert.equal(parseConversationFrame(JSON.stringify({ type: "chunk", frameId: "bad", index: 0, total: 1025, json: "x" })), null);
  assert.equal(parseConversationFrame("x".repeat(32 * 1024 * 1024 + 1)), null);
  const value = { type: "result", requestId: "small", ok: true, data: "hello" };
  const parts = chunks("small", value, Math.ceil(JSON.stringify(value).length / 2));
  assert.equal(parts.length, 2);
  const assembler = createConversationChunkAssembler();
  assert.equal(push(assembler, parts[0]), null);
  assert.equal(push(assembler, parts[0]), null);
  assert.deepEqual(push(assembler, parts[1]), value);
  assert.equal(push(assembler, parts[0]), null);
  assembler.reset();
  assert.equal(push(assembler, parts[1]), null);
});

const wireEvent = (seq) => ({ id: `e${seq}`, seq, type: "content_delta", sessionId: "s", workspaceId: "w", agentId: "a", createdAt: seq });
const snapshotPart = (index, total, seqs) => ({
  type: "snapshot", reset: true, generation: "gen-1", part: { index, total },
  page: { events: seqs.map(wireEvent), hasMore: true, beforeCursor: 4 },
});
const parse = (value) => parseConversationFrame(JSON.stringify(value));

test("resumable frames parse, and malformed cursors or delays are refused", () => {
  assert.ok(parse(snapshotPart(0, 2, [4])));
  assert.ok(parse({ type: "synchronized", seq: 9, generation: "gen-1" }));
  assert.ok(parse({ type: "subscribeFailed", key: { workspaceId: "w", agentId: "a" }, code: "busy", message: "Too many requests.", retryable: true, retryAfterMs: 250 }));
  assert.ok(parse({ type: "result", requestId: "r", ok: false, code: "too_large", message: "Too big." }));
  assert.ok(parse({ type: "commandResult", commandId: "c", ok: false, code: "busy", retryAfterMs: 250 }));
  assert.ok(parse({ type: "error", code: "resync_required", message: "Behind.", retryAfterMs: 2000 }));
  assert.equal(parse({ type: "synchronized", seq: 9, generation: "" }), null);
  assert.equal(parse({ type: "synchronized", seq: 9, generation: "g".repeat(201) }), null);
  assert.equal(parse(snapshotPart(2, 2, [4])), null, "a part index must be inside its total");
  assert.equal(parse({ type: "subscribeFailed", key: { workspaceId: "w" }, code: "busy", message: "", retryable: true }), null);
  assert.equal(parse({ type: "commandResult", commandId: "c", ok: false, retryAfterMs: -1 }), null);
});

test("a chunked snapshot is applied once, whole, from its consecutive parts", () => {
  const assembler = createSnapshotAssembler();
  assert.deepEqual(assembler.push(parse(snapshotPart(0, 3, [4, 5]))), { waiting: true });
  assert.deepEqual(assembler.push(parse(snapshotPart(1, 3, [7]))), { waiting: true });
  const { snapshot } = assembler.push(parse(snapshotPart(2, 3, [9])));
  assert.deepEqual(snapshot.page.events.map((event) => event.seq), [4, 5, 7, 9]);
  assert.equal(snapshot.generation, "gen-1");
  assert.equal(snapshot.reset, true);
  assert.equal("part" in snapshot, false, "the assembled snapshot is whole");
  const whole = parse({ type: "snapshot", page: { events: [], hasMore: false, beforeCursor: null } });
  assert.deepEqual(assembler.push(whole), { snapshot: whole });
});

test("a missing, repeated or foreign snapshot part is reported instead of applied", () => {
  const assembler = createSnapshotAssembler();
  assert.deepEqual(assembler.push(parse(snapshotPart(1, 2, [5]))), { broken: true });
  assembler.push(parse(snapshotPart(0, 3, [4])));
  assert.deepEqual(assembler.push(parse(snapshotPart(2, 3, [9]))), { broken: true });
  assembler.push(parse(snapshotPart(0, 2, [4])));
  assert.deepEqual(assembler.push(parse(snapshotPart(1, 3, [5]))), { broken: true });
  assembler.push(parse(snapshotPart(0, 2, [4])));
  assert.deepEqual(assembler.push(parse({ type: "snapshot", page: { events: [], hasMore: false, beforeCursor: null } })), { broken: true });
  assembler.push(parse(snapshotPart(0, 2, [4])));
  assembler.reset();
  assert.deepEqual(assembler.push(parse(snapshotPart(1, 2, [5]))), { broken: true });
});

test("sends are measured against the protocol's own message and frame limits", () => {
  const send = (message) => ({ kind: "send", message, uploadIds: [] });
  assert.equal(conversationSendProblem("c", send("hello")), null);
  assert.equal(conversationSendProblem("c", send("x".repeat(CONVERSATION_MAX_MESSAGE_CHARS))), null);
  assert.match(conversationSendProblem("c", send("x".repeat(CONVERSATION_MAX_MESSAGE_CHARS + 1))), /at most 200,000/);
  // Escaped control characters encode to six bytes each and still fit the frame cap by design.
  const escaped = "\u0001".repeat(CONVERSATION_MAX_MESSAGE_CHARS);
  assert.ok(Buffer.byteLength(JSON.stringify(send(escaped))) < CONVERSATION_MAX_CLIENT_FRAME_BYTES);
  assert.equal(conversationSendProblem("c", send(escaped)), null);
});

const listed = (extra) => ({
  workspaceId: "w",
  agentId: "a",
  title: "Chat",
  phase: "idle",
  createdAt: 1,
  updatedAt: 2,
  providerId: "claude-agent",
  modelId: "model-b",
  turnCount: 1,
  lastSeq: 4,
  ...extra,
});
test("a listed chat's model catalog is validated, bounded and dropped when malformed", () => {
  const catalog = {
    cli: "claude-code",
    cliLabel: "Claude Code",
    liveModelSwitch: true,
    options: [
      { id: "model-a", label: " Model A " },
      { id: "model-b" },
      { id: "default", label: "listed default is not a row" },
      { id: "", label: "no id" },
      ...Array.from({ length: 150 }, (_, index) => ({ id: `extra-${index}` })),
    ],
  };
  const frame = parse({ type: "sessions", requestId: "list", sessions: [listed({ models: catalog, permissionPreset: "bypass" })] });
  const [chat] = frame.sessions;
  assert.equal(chat.permissionPreset, "bypass");
  assert.equal(chat.models.cliLabel, "Claude Code");
  assert.equal(chat.models.liveModelSwitch, true);
  assert.deepEqual(chat.models.options.slice(0, 2), [{ id: "model-a", label: "Model A" }, { id: "model-b" }]);
  assert.equal(chat.models.options.length, 100, "a catalog is cut to the protocol's bound");
  const broken = parse({
    type: "sessions",
    requestId: "list",
    sessions: [listed({ models: { cli: "claude-code", options: [] }, permissionPreset: "yolo" })],
  }).sessions[0];
  assert.equal("models" in broken, false, "a catalog in the wrong shape hides the control");
  assert.equal("permissionPreset" in broken, false, "a preset the wire does not define is left out, not guessed at");
  assert.equal("models" in parse({ type: "sessions", requestId: "list", sessions: [listed()] }).sessions[0], false);
});
test("a desktop with four permission presets lists Manual and Auto as themselves, and what each chat's provider runs", () => {
  // Before this build the phone dropped `manual` and `auto`, and a chat on
  // either read as the CLI's default with a menu that could only offer Bypass.
  for (const preset of ["manual", "auto", "none", "bypass"])
    assert.equal(parse({ type: "sessions", requestId: "list", sessions: [listed({ permissionPreset: preset })] }).sessions[0].permissionPreset, preset);
  const [chat] = parse({
    type: "sessions",
    requestId: "list",
    sessions: [listed({ capabilities: { images: true, interrupt: true, permissionPresets: ["none", "auto", "yolo", 7, "bypass"] } })],
  }).sessions;
  assert.deepEqual(chat.capabilities.permissionPresets, ["none", "auto", "bypass"], "only presets the wire defines are kept");
  assert.equal(chat.capabilities.images, true);
  const [older] = parse({ type: "sessions", requestId: "list", sessions: [listed({ capabilities: { images: false } })] }).sessions;
  assert.equal("permissionPresets" in older.capabilities, false, "an older desktop's chat names no presets: unknown, not none");
});
test("a listed chat's title and lifecycle clocks are kept in their shape, and each is dropped alone when not", () => {
  const [chat] = parse({
    type: "sessions",
    requestId: "list",
    sessions: [
      listed({
        chatTitle: "  Phone settles a chat  ",
        lastUserMessageAt: 1_000,
        lastTurnEndedAt: 2_000,
        lastVisitedAt: 0,
      }),
    ],
  }).sessions;
  assert.equal(chat.chatTitle, "Phone settles a chat");
  assert.equal(chat.lastUserMessageAt, 1_000);
  assert.equal(chat.lastTurnEndedAt, 2_000);
  assert.equal(chat.lastVisitedAt, 0, "zero is an instant, not an absence");
  const [broken] = parse({
    type: "sessions",
    requestId: "list",
    sessions: [
      listed({ chatTitle: "   ", lastUserMessageAt: "1000", lastTurnEndedAt: -5, lastVisitedAt: 1.5 }),
    ],
  }).sessions;
  for (const field of ["chatTitle", "lastUserMessageAt", "lastTurnEndedAt", "lastVisitedAt"])
    assert.equal(field in broken, false, `${field} in the wrong shape is left out`);
  const [mixed] = parse({
    type: "sessions",
    requestId: "list",
    sessions: [listed({ chatTitle: 7, lastTurnEndedAt: 3_000, lastVisitedAt: null })],
  }).sessions;
  assert.deepEqual(
    [mixed.chatTitle, mixed.lastTurnEndedAt, "lastVisitedAt" in mixed],
    [undefined, 3_000, false],
    "one bad field does not take the good ones with it",
  );
  // An older desktop sends none of them, and the chat still lists.
  const [older] = parse({ type: "sessions", requestId: "list", sessions: [listed()] }).sessions;
  assert.equal("lastTurnEndedAt" in older, false);
});
test("an accepted command may carry a notice; a refusal's notice is dropped", () => {
  assert.equal(
    parse({ type: "commandResult", commandId: "c", ok: true, notice: "Applies from the next turn." }).notice,
    "Applies from the next turn.",
  );
  assert.equal("notice" in parse({ type: "commandResult", commandId: "c", ok: false, code: "unsupported_model", notice: "x" }), false);
  assert.equal("notice" in parse({ type: "commandResult", commandId: "c", ok: true, notice: 7 }), false);
});

test("line and paragraph separators reach the desktop as plain line breaks", () => {
  assert.equal(
    plainLineBreaks("one\u2028two\u2029three\r\nfour\rfive\u0085six"),
    "one\ntwo\nthree\nfour\nfive\nsix",
  );
  assert.equal(plainLineBreaks("one line\nand another"), "one line\nand another");
});

test("a queued frame is read entry by entry: an unreadable one is skipped, a long refusal dropped, twenty at most", () => {
  const key = { workspaceId: "w", agentId: "a" };
  const good = (id, extra = {}) => ({ id, text: `message ${id}`, createdAt: 10, ...extra });
  const frame = parseConversationFrame(JSON.stringify({
    type: "queued",
    key: { ...key, extra: true },
    messages: [
      good("one", { failure: "The chat is stopped." }),
      { id: "", text: "no id", createdAt: 1 },
      { id: "x".repeat(201), text: "long id", createdAt: 1 },
      { id: "bad-clock", text: "t", createdAt: -1 },
      { id: "too-long", text: "x".repeat(CONVERSATION_MAX_MESSAGE_CHARS + 1), createdAt: 1 },
      "not a message",
      good("two", { failure: "x".repeat(2_001) }),
    ],
  }));
  assert.deepEqual(frame, {
    type: "queued",
    key,
    messages: [
      { id: "one", text: "message one", createdAt: 10, failure: "The chat is stopped." },
      { id: "two", text: "message two", createdAt: 10 },
    ],
  });
  const many = parseConversationFrame(JSON.stringify({
    type: "queued", key, messages: Array.from({ length: 25 }, (_, index) => good(`m${index}`)),
  }));
  assert.equal(many.messages.length, 20);
  assert.deepEqual(parseConversationFrame(JSON.stringify({ type: "queued", key, messages: [] })).messages, []);
  assert.equal(parseConversationFrame(JSON.stringify({ type: "queued", messages: [] })), null, "a list must name its chat");
  assert.equal(parseConversationFrame(JSON.stringify({ type: "queued", key, messages: {} })), null);
});

test("a held send has landed only when a later user message carries its words as whole lines", () => {
  const message = (seq, text) => ({ type: "user_message", seq, payload: { text } });
  assert.equal(heldSendLanded(message(6, "draft the phone side"), "draft the phone side", 5), true);
  assert.equal(heldSendLanded(message(6, "check the gateway\ndraft the phone side"), "  draft the phone side\n", 5), true, "joined a line apiece, trimmed as the desktop holds it");
  assert.equal(heldSendLanded(message(5, "draft the phone side"), "draft the phone side", 5), false, "from before it was offered");
  assert.equal(heldSendLanded(message(6, "draft the phone sidebar"), "draft the phone side", 5), false, "part of a line is not the line");
  assert.equal(heldSendLanded({ type: "content_delta", seq: 9, payload: { text: "draft the phone side" } }, "draft the phone side", 5), false);
  assert.equal(heldSendLanded(message(6, "anything"), "   ", 5), false);
  assert.equal(heldSendLanded({ type: "user_message", payload: { text: "x" } }, "x", 0), false, "an event with no sequence cannot be placed");
});
test("a listed chat says whether its CLI can be steered only as a boolean; anything else is unknown", () => {
  const steerOf = (capabilities) => parse({ type: "sessions", requestId: "list", sessions: [listed({ capabilities })] }).sessions[0].capabilities;
  assert.equal(steerOf({ images: true, steer: true }).steer, true);
  assert.equal(steerOf({ images: true, steer: false }).steer, false);
  assert.equal("steer" in steerOf({ images: true, steer: "yes" }), false, "a wrong shape reads as unknown, which offers no Steer");
  assert.equal("steer" in steerOf({ images: true }), false, "an older desktop names no steer: unknown, not no");
});
test("a listed chat says whether one of its agents can be stopped only as a boolean; anything else is unknown", () => {
  const flagsOf = (capabilities) => parse({ type: "sessions", requestId: "list", sessions: [listed({ capabilities })] }).sessions[0].capabilities;
  assert.equal(flagsOf({ images: true, stopSubagent: true }).stopSubagent, true);
  assert.equal(flagsOf({ images: true, stopSubagent: false }).stopSubagent, false);
  assert.equal("stopSubagent" in flagsOf({ images: true, stopSubagent: "yes" }), false, "a wrong shape reads as unknown, which offers no Stop");
  assert.equal("stopSubagent" in flagsOf({ images: true }), false, "an older desktop names nothing: unknown, not no");
});
test("a steer carries its words alone, and is refused before the outbox otherwise", () => {
  assert.equal(conversationSendProblem("c1", { kind: "send", message: "and add tests", steer: true }), null);
  assert.match(conversationSendProblem("c2", { kind: "send", message: "x", steer: true, queue: true }), /words alone/);
  assert.match(conversationSendProblem("c3", { kind: "send", message: "x", steer: true, uploadIds: [] }), /words alone/);
});

test("a scheduled frame is read entry by entry, with what each says of its send", () => {
  const key = { workspaceId: "ws", agentId: "agent" };
  const good = (id, extra = {}) => ({ id, text: "Ping the release", sendAt: 2_000, createdAt: 1_000, ...extra });
  const frame = parseConversationFrame(
    JSON.stringify({
      type: "scheduled",
      key,
      messages: [
        good("a"),
        good("b", { waitingSince: 1_500, sending: true, failure: "The chat is archived." }),
        { id: "c", text: "no time", createdAt: 1 },
        good("d", { sending: "yes", failure: "x".repeat(2_001) }),
      ],
    }),
  );
  assert.equal(frame.type, "scheduled");
  assert.deepEqual(frame.key, key);
  assert.deepEqual(
    frame.messages.map((message) => message.id),
    ["a", "b", "d"],
    "one without a send time is skipped, the rest kept",
  );
  assert.deepEqual(frame.messages[1], good("b", { waitingSince: 1_500, sending: true, failure: "The chat is archived." }));
  assert.deepEqual(frame.messages[2], good("d"), "a non-true sending and an over-long refusal are dropped");
  const many = parseConversationFrame(
    JSON.stringify({ type: "scheduled", key, messages: Array.from({ length: 60 }, (_, index) => good(`m${index}`)) }),
  );
  assert.equal(many.messages.length, 50);
  assert.equal(parseConversationFrame(JSON.stringify({ type: "scheduled", messages: [] })), null, "a list must name its chat");
});
