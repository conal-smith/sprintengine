const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  QUEUED_SEND_STALE_MS,
  cancelRefusal,
  heldByDesktop,
  holdsOnDesktop,
  pendingLine,
  queuedBubbles,
  queuedLine,
  queuedSendStale,
  stillHanding,
  turnEndedSince,
} = require("../../../.mobile-test-build/src/features/conversations/queuedSends.js");
const { createQueuedSendCourier } = require("../../../.mobile-test-build/src/features/conversations/queuedSendCourier.js");

const base = { declared: true, attachments: false, turnBusy: true, uploads: 0, phoneQueued: 0 };

test("a message goes to the desktop to hold behind a running turn, with pictures where it holds them, and behind nothing the phone holds", () => {
  assert.equal(holdsOnDesktop(base), true);
  assert.equal(holdsOnDesktop({ ...base, declared: false }), false, "an older desktop: the phone holds it, as before");
  assert.equal(holdsOnDesktop({ ...base, turnBusy: false }), false, "no turn running: it goes straight into the chat");
  assert.equal(holdsOnDesktop({ ...base, uploads: 1 }), false, "a desktop that holds only words: pictures stay with their words, on the phone");
  assert.equal(holdsOnDesktop({ ...base, uploads: 1, attachments: true }), true, "a desktop that holds pictures takes them with the message");
  assert.equal(holdsOnDesktop({ ...base, phoneQueued: 1 }), false, "it would overtake the message the phone holds");
});

test("the desktop's list has taken a message when one entry carries its words as whole lines", () => {
  const held = [{ id: "q1", text: "check the gateway\ndraft the phone side", createdAt: 1 }];
  assert.equal(heldByDesktop(held, "draft the phone side"), true);
  assert.equal(heldByDesktop(held, " check the gateway \n"), true);
  assert.equal(heldByDesktop(held, "draft the phone"), false);
  assert.equal(heldByDesktop([], "anything"), false);
});

test("what is still handing over drops what the list names and keeps its identity when nothing moved", () => {
  const handing = [{ commandId: "a", text: "first" }, { commandId: "b", text: "second" }];
  assert.equal(stillHanding(handing, []), handing, "unchanged, so nothing draws again");
  assert.deepEqual(stillHanding(handing, [{ id: "q", text: "first", createdAt: 1 }]), [{ commandId: "b", text: "second" }]);
});

test("the queued bubble lists the desktop's messages, then those on their way, then the phone's", () => {
  const bubbles = queuedBubbles({
    desktop: [{ id: "q1", text: "one\ntwo", createdAt: 1 }, { id: "q2", text: "refused", createdAt: 2, failure: "The chat is stopped." }],
    handing: [{ commandId: "h1", text: "three" }],
    phone: [{ commandId: "p1", text: "", uploads: ["img"] }],
  });
  assert.deepEqual(bubbles.map((bubble) => [bubble.where, bubble.key]), [
    ["desktop", "desktop:q1"], ["desktop", "desktop:q2"], ["handing", "handing:h1"], ["phone", "phone:p1"],
  ]);
  assert.equal(bubbles[0].text, "one\ntwo", "a turn's messages read as one entry, a line apiece");
  assert.equal(bubbles[1].failure, "The chat is stopped.");
  assert.deepEqual(bubbles[3].uploads, ["img"]);
});

test("each entry says where it waits, and a refused one says why", () => {
  const [desktop, refused, handing, phone] = queuedBubbles({
    desktop: [{ id: "q1", text: "a", createdAt: 1 }, { id: "q2", text: "b", createdAt: 2, failure: "The chat is stopped." }],
    handing: [{ commandId: "h", text: "c" }],
    phone: [{ commandId: "p", text: "d", uploads: [] }],
  });
  assert.equal(queuedLine(desktop, false), "Queued on the desktop · sends when this turn ends", "the desktop sends it with the phone away");
  assert.equal(queuedLine(refused, true), "Not sent: The chat is stopped.");
  assert.equal(queuedLine(handing, true), "Queuing on the desktop…");
  assert.equal(queuedLine(handing, false), "Queued · goes to the desktop when connected");
  assert.equal(queuedLine(phone, true), "Queued · sends when this turn ends");
  assert.equal(queuedLine(phone, false), "Queued · sends when connected");
});

test("a refused take-back says the desktop's words, or that the message is already on its way", () => {
  assert.equal(cancelRefusal("That message is already on its way into the chat."), "That message is already on its way into the chat.");
  assert.match(cancelRefusal(undefined), /already on its way/);
  assert.match(cancelRefusal("  "), /already on its way/);
});

// ── A message that waited while the phone was away ───────────────────────────
const T0 = Date.UTC(2026, 9, 19, 13, 25);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const send = { kind: "send", message: "run the migration", uploadIds: [] };

test("a carried message goes without asking only while it is young, and one with no time is old", () => {
  assert.equal(QUEUED_SEND_STALE_MS, 10 * MINUTE);
  assert.equal(queuedSendStale({ queuedAt: T0, command: send }, T0 + 10 * MINUTE), false);
  assert.equal(queuedSendStale({ queuedAt: T0, command: send }, T0 + 10 * MINUTE + 1), true);
  assert.equal(queuedSendStale({ command: send }, T0), true, "cached before the phone kept when it was written");
  assert.equal(queuedSendStale({ queuedAt: T0, stale: true, command: send }, T0), true, "once found stale, stale");
  assert.equal(
    queuedSendStale({ queuedAt: T0 - 23 * HOUR, stale: true, command: { ...send, confirmedStale: true } }, T0),
    false,
    "the person said send it",
  );
  assert.equal(turnEndedSince({ queuedAt: T0 }, T0 + 1), true);
  assert.equal(turnEndedSince({ queuedAt: T0 }, T0 - 1), false, "a turn that ended before it was written was not its turn");
});

test("a sent message says whether it waits on a turn, and one not sent says when it was written", () => {
  assert.equal(pendingLine({}, T0), "Pending delivery…");
  assert.equal(pendingLine({ waiting: true }, T0), "Waiting for the agent's turn to end");
  assert.equal(pendingLine({ stale: true, queuedAt: T0 - 23 * HOUR }, T0), "Not sent · written 23h ago");
  assert.equal(pendingLine({ stale: true, waiting: true }, T0), "Not sent");
});

const settle = () => new Promise((resolve) => setImmediate(resolve));
const chat = { workspaceId: "w", agentId: "a" };
/** A courier over an in-memory cache and a fake desktop that records each stream it is asked for. */
function courierFixture(pending, now = T0) {
  const state = { cache: { lastSeq: 3, events: [], pending }, streams: [] };
  const courier = createQueuedSendCourier({
    load: async () => state.cache,
    update: async (_device, _key, updater) => (state.cache = updater(state.cache)),
    now: () => now,
  });
  const api = {
    open(key, seq, handlers, options) {
      const stream = { key, seq, handlers, options, closed: false, close() { stream.closed = true; }, foreground() {} };
      state.streams.push(stream);
      return stream;
    },
  };
  return { state, courier, carry: () => courier.carry({ deviceId: "device", key: chat, api, queuedSends: true }) };
}
const cached = (commandId, queuedAt) => ({ commandId, command: { ...send, message: commandId, composedAt: queuedAt }, ...(queuedAt === undefined ? {} : { queuedAt }) });

test("the courier keeps the reopened chat's rule: what waited too long is marked not sent and never offered", async () => {
  const f = courierFixture([cached("old", T0 - 23 * HOUR), cached("legacy"), cached("young", T0 - MINUTE)]);
  f.carry();
  await settle();
  assert.equal(f.state.streams.length, 1);
  assert.deepEqual(f.state.streams[0].options.pendingSends.map((item) => item.commandId), ["young"]);
  assert.deepEqual(f.state.cache.pending.filter((item) => item.stale).map((item) => item.commandId), ["old", "legacy"]);
  // Its stream then finds the young one's turn ended while the phone was away.
  f.state.streams[0].handlers.onSendStale("young");
  await settle();
  assert.deepEqual(f.state.cache.pending.map((item) => [item.commandId, item.stale]), [["old", true], ["legacy", true], ["young", true]]);
  assert.equal(f.state.streams[0].closed, true, "nothing left to carry");
  assert.equal(f.courier.carrying("device", chat), false);
});

test("the courier opens no stream when everything it would carry is too old to send without asking", async () => {
  const f = courierFixture([cached("old", T0 - 23 * HOUR)]);
  f.carry();
  await settle();
  assert.equal(f.state.streams.length, 0);
  assert.deepEqual(f.state.cache.pending.map((item) => item.stale), [true]);
});

test("the courier keeps a send its stream handed to the desktop to hold as held, so it is never offered plain again", async () => {
  const f = courierFixture([cached("words", T0 - MINUTE)]);
  f.carry();
  await settle();
  const held = { kind: "send", message: "words", composedAt: T0 - MINUTE, queue: true };
  f.state.streams[0].handlers.onSendHeld("words", held, 3);
  await settle();
  assert.deepEqual(f.state.cache.pending.map((item) => [item.command.queue, item.heldAfter]), [[true, 3]]);
  f.state.streams[0].handlers.onFrame({ type: "commandResult", commandId: "words", ok: true });
  await settle();
  assert.deepEqual(f.state.cache.pending, []);
  assert.equal(f.state.streams[0].closed, true);
});
