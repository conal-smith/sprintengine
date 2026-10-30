/* global __dirname */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const compiled = path.resolve(__dirname, "../../.mobile-test-build/src/api/tailnetConversations.js");
const compiledRequire = createRequire(compiled);
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const ticketResponse = () => ({ ok: true, json: async () => ({ ticket: "test-ticket" }) });
const key = { workspaceId: "workspace", agentId: "agent" };
// The wall clock the fixture starts at: a message cached here was written then.
const T0 = Date.UTC(2026, 9, 19, 13, 25);
const HOUR = 3_600_000;
const pending = (id) => ({ commandId: id, command: { kind: "send", message: id, uploadIds: [] }, queuedAt: T0 });
const event = (seq, type, payload = {}) => ({
  type: "event", event: { id: `event-${seq}`, seq, type, sessionId: "session", ...key, createdAt: seq, payload },
});

/** Execute the compiled production API with only its native host boundary mocked. */
function fixture(fetchTicket = async () => ticketResponse()) {
  const sockets = [], states = [], frames = [], started = [], stale = [], reheld = [], waiting = [];
  const timers = new Map();
  let clock = 0, timerId = 0;
  class Socket {
    static OPEN = 1;
    readyState = 0;
    sent = [];
    constructor(url) { this.url = url; sockets.push(this); }
    send(json) {
      assert.equal(this.readyState, Socket.OPEN, "only a live socket can transmit");
      this.sent.push(JSON.parse(json));
    }
    open() { this.readyState = Socket.OPEN; this.onopen?.(); }
    frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    close() {
      this.readyState = 3;
      Promise.resolve().then(() => this.onclose?.({ code: 1000, reason: "" }));
    }
    /** The desktop closing the socket, as the phone's onclose sees it. */
    serverClose(code, reason = "") { this.readyState = 3; this.onclose?.({ code, reason }); }
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(compiled, "utf8"), {
    module, exports: module.exports,
    require: (id) => id === "expo-file-system/legacy" ? {} : compiledRequire(id),
    WebSocket: Socket, fetch: fetchTicket, AbortController, URL,
    setTimeout: (callback, delay) => {
      const id = ++timerId; timers.set(id, { at: clock + delay, callback }); return id;
    },
    clearTimeout: (id) => timers.delete(id),
  }, { filename: compiled });
  const api = module.exports.createTailnetConversationsApi({
    baseUrl: "https://example.ts.net", deviceToken: "test-token", now: () => T0 + clock,
  });
  const details = [];
  const open = (options, afterSeq = 0) => api.open(key, afterSeq, {
    onState: (state, detail) => { states.push(state); details.push(detail); }, onFrame: (frame) => frames.push(frame),
    onSendStarted: (id) => started.push(id),
    onSendStale: (id) => stale.push(id),
    onSendHeld: (id, command, heldAfter) => reheld.push({ id, command, heldAfter }),
    onSendWaiting: (id) => waiting.push(id),
  }, options);
  const advance = async (ms = 0) => {
    const end = clock + ms;
    await settle();
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); clock = next[1].at; next[1].callback(); await settle();
    }
    clock = end; await settle();
  };
  const synchronize = (socket, events = [], seq = 0) => {
    socket.open();
    socket.frame({ type: "snapshot", reset: true, page: { events, hasMore: false, beforeCursor: null } });
    socket.frame({ type: "synchronized", seq });
  };
  const commands = () => sockets.flatMap((socket) => socket.sent.filter((frame) => frame.type === "command"));
  return {
    sockets, states, details, frames, started, stale, reheld, waiting, open, advance, synchronize, commands, module,
  };
}

test("foreground reconnect preserves a newly queued send until the replacement socket synchronizes", async () => {
  const f = fixture(), stream = f.open();
  await f.advance(); f.synchronize(f.sockets[0]);
  stream.foreground(11_000);
  stream.command(pending("during-reconnect").command, "during-reconnect");
  assert.equal(f.commands().length, 0);
  await f.advance();
  assert.equal(f.sockets.length, 2);
  f.synchronize(f.sockets[1]);
  assert.deepEqual(f.commands().map((item) => item.commandId), ["during-reconnect"]);
  stream.close();
});

test("an unanswered foreground probe reconnects without retaining a stale send latch", async () => {
  const f = fixture(), stream = f.open();
  await f.advance(); f.synchronize(f.sockets[0]);
  stream.foreground(1000);
  assert.equal(f.sockets[0].sent.at(-1).type, "list");
  // Two probes' deadlines, nothing heard in either.
  await f.advance(20_000);
  stream.command(pending("after-probe").command, "after-probe");
  f.synchronize(f.sockets[1]);
  assert.deepEqual(f.commands().map((item) => item.commandId), ["after-probe"]);
  stream.close();
});

test("stale ticket completions and stale socket callbacks cannot replace or drive the current connection", async () => {
  const tickets = [];
  const f = fixture(() => new Promise((resolve) => tickets.push(resolve)));
  const stream = f.open();
  stream.foreground(11_000); await f.advance();
  assert.equal(tickets.length, 2);
  tickets[1](ticketResponse()); await settle();
  assert.equal(f.sockets.length, 1);
  f.synchronize(f.sockets[0]);
  tickets[0](ticketResponse()); await settle();
  assert.equal(f.sockets.length, 1, "an obsolete ticket must not construct a socket");
  const old = f.sockets[0];
  stream.foreground(11_000); await f.advance();
  tickets[2](ticketResponse()); await settle();
  f.synchronize(f.sockets[1]);
  const count = f.frames.length;
  old.frame(event(900, "user_message", { commandId: "stale" }));
  old.onopen?.();
  assert.equal(f.frames.length, count, "obsolete socket events are ignored");
  assert.equal(f.sockets[1].sent.filter((frame) => frame.type === "subscribe").length, 1);
  stream.command(pending("current").command, "current");
  assert.equal(f.commands().at(-1).commandId, "current");
  stream.close();
});

test("queued sends serialize through user acknowledgment and turn completion", async () => {
  const f = fixture(), stream = f.open({ pendingSends: [pending("first"), pending("second")] });
  await f.advance();
  assert.equal(f.commands().length, 0);
  f.synchronize(f.sockets[0]);
  assert.deepEqual(f.started, ["first"]);
  f.sockets[0].frame(event(1, "user_message", { commandId: "first", turnId: "turn" }));
  f.sockets[0].frame({ type: "commandResult", commandId: "first", ok: true });
  assert.equal(f.commands().length, 1);
  f.sockets[0].frame(event(2, "turn_completed", { turnId: "turn" }));
  assert.deepEqual(f.commands().map((item) => item.commandId), ["first", "second"]);
  stream.close();
});

test("obsolete ticket failures cannot take a newer live connection offline", async () => {
  const tickets = [];
  const f = fixture(() => new Promise((resolve, reject) => tickets.push({ resolve, reject })));
  const stream = f.open();
  stream.foreground(11_000); await f.advance();
  tickets[1].resolve(ticketResponse()); await settle();
  f.synchronize(f.sockets[0]);
  const count = f.states.length;
  tickets[0].reject(new Error("old request failed")); await settle();
  assert.equal(f.states.length, count);
  assert.equal(f.states.at(-1), "live");
  stream.close();
});

test("an idempotent success receipt without a live acknowledgment releases the next queued send", async () => {
  const f = fixture(), stream = f.open({ pendingSends: [pending("accepted-earlier"), pending("next")] });
  await f.advance(); f.synchronize(f.sockets[0]);
  f.sockets[0].frame({ type: "commandResult", commandId: "accepted-earlier", ok: true });
  assert.deepEqual(f.commands().map((item) => item.commandId), ["accepted-earlier", "next"]);
  stream.close();
});

test("authoritative reset acknowledges cached sends and reconstructs busy state before flushing", async () => {
  const f = fixture(), stream = f.open({ pendingSends: [pending("acknowledged"), pending("next")] });
  await f.advance();
  f.synchronize(f.sockets[0], [event(1, "user_message", { commandId: "acknowledged", turnId: "running" }).event], 1);
  assert.equal(f.commands().length, 0);
  f.sockets[0].frame(event(2, "turn_completed", { turnId: "running" }));
  assert.deepEqual(f.commands().map((item) => item.commandId), ["next"]);
  stream.close();
});

test("a recovered lower reset cursor becomes the next reconnect cursor", async () => {
  const f = fixture(), stream = f.open();
  await f.advance(); f.synchronize(f.sockets[0]);
  f.sockets[0].frame(event(500, "content_delta", { text: "not durable" }));
  stream.foreground(11_000); await f.advance();
  f.synchronize(f.sockets[1], [event(2, "content_delta", { text: "recovered" }).event], 2);
  stream.foreground(11_000); await f.advance();
  f.sockets[2].open();
  assert.equal(f.sockets[2].sent.find((frame) => frame.type === "subscribe").afterSeq, 2);
  stream.close();
});

test("failed receipts release the queue and cancellation removes only waiting sends", async () => {
  const f = fixture(), stream = f.open({ pendingSends: [pending("first"), pending("cancelled"), pending("last")] });
  await f.advance(); f.synchronize(f.sockets[0]);
  stream.cancelPending("cancelled");
  f.sockets[0].frame({ type: "commandResult", commandId: "first", ok: false });
  assert.deepEqual(f.commands().map((item) => item.commandId), ["first", "last"]);
  stream.close();
});

test("closing during ticket acquisition prevents sockets and late state publication", async () => {
  let resolveTicket;
  const f = fixture(() => new Promise((resolve) => { resolveTicket = resolve; }));
  const stream = f.open();
  stream.close();
  const stateCount = f.states.length;
  resolveTicket(ticketResponse()); await f.advance();
  assert.equal(f.sockets.length, 0);
  assert.equal(f.states.length, stateCount);
});

test("a desktop that accepts and immediately closes is redialed with growing delays, reset only by synchronized", async () => {
  const f = fixture(), stream = f.open();
  await f.advance();
  const dropAfterOpen = () => { const socket = f.sockets.at(-1); socket.open(); socket.serverClose(1006); };
  dropAfterOpen();
  await f.advance(499);
  assert.equal(f.sockets.length, 1, "no redial sooner than half a second");
  await f.advance(501);
  assert.equal(f.sockets.length, 2);
  dropAfterOpen();
  await f.advance(999);
  assert.equal(f.sockets.length, 2, "an opened socket that never synchronized does not reset the backoff");
  await f.advance(1001);
  assert.equal(f.sockets.length, 3);
  dropAfterOpen();
  await f.advance(1999);
  assert.equal(f.sockets.length, 3);
  await f.advance(2001);
  assert.equal(f.sockets.length, 4);
  f.synchronize(f.sockets[3]);
  f.sockets[3].serverClose(1006);
  await f.advance(1000);
  assert.equal(f.sockets.length, 5, "a synchronized subscription starts the backoff again");
  stream.close();
});

test("delays stay within the jittered exponential window and never undercut the desktop", () => {
  const { conversationReconnectDelay } = fixture().module.exports;
  assert.equal(conversationReconnectDelay(0, undefined, () => 0), 500);
  assert.equal(conversationReconnectDelay(0, undefined, () => 1), 1000);
  assert.equal(conversationReconnectDelay(3, undefined, () => 0), 4000);
  assert.equal(conversationReconnectDelay(50, undefined, () => 1), 30000, "capped at thirty seconds");
  assert.equal(conversationReconnectDelay(0, 7000, () => 1), 7000);
  assert.equal(conversationReconnectDelay(5, 100, () => 0), 15000);
});

test("a resync close waits for the delay in its reason, and foregrounding cannot cut it short", async () => {
  const f = fixture(), stream = f.open();
  await f.advance(); f.synchronize(f.sockets[0]);
  f.sockets[0].frame({ type: "error", code: "resync_required", message: "Behind.", retryAfterMs: 5000 });
  f.sockets[0].serverClose(4409, "resync_required;retryAfterMs=5000");
  assert.equal(f.states.at(-1), "offline");
  stream.foreground(11_000);
  await f.advance(4999);
  assert.equal(f.sockets.length, 1, "no redial before the desktop's delay");
  await f.advance(1);
  assert.equal(f.sockets.length, 2);
  stream.close();
});

test("a resync delay sent only in the error frame still governs the reconnect", async () => {
  const f = fixture(), stream = f.open();
  await f.advance(); f.synchronize(f.sockets[0]);
  f.sockets[0].frame({ type: "error", code: "resync_required", message: "Behind.", retryAfterMs: 3000 });
  f.sockets[0].serverClose(4409, "resync_required");
  await f.advance(2999);
  assert.equal(f.sockets.length, 1);
  await f.advance(1);
  assert.equal(f.sockets.length, 2);
  stream.close();
});

test("losing the read grant stops the stream in a no-access state", async () => {
  for (const drop of [
    (socket) => socket.serverClose(4403, "conversation_scope_required"),
    (socket) => {
      socket.frame({ type: "error", code: "conversation_scope_required", message: "This device has no conversation read grant." });
      socket.serverClose(4403, "conversation_scope_required");
    },
  ]) {
    const f = fixture(), stream = f.open();
    await f.advance(); f.synchronize(f.sockets[0]);
    drop(f.sockets[0]);
    await f.advance(120_000);
    assert.equal(f.states.at(-1), "blocked");
    assert.equal(f.sockets.length, 1, "no reconnect after scope loss");
    stream.foreground(11_000); await f.advance(60_000);
    assert.equal(f.sockets.length, 1, "foregrounding does not revive a stopped stream");
    stream.close();
  }
});

test("revocation stops the stream and reports it as revoked, from the socket or the ticket", async () => {
  const f = fixture(), stream = f.open();
  await f.advance(); f.synchronize(f.sockets[0]);
  f.sockets[0].serverClose(4401, "This device has been revoked.");
  await f.advance(120_000);
  assert.equal(f.states.at(-1), "revoked");
  assert.equal(f.sockets.length, 1);
  stream.close();
  const refused = fixture(async () => ({ ok: false, status: 401, json: async () => ({}) }));
  const second = refused.open();
  await refused.advance(120_000);
  assert.equal(refused.states.at(-1), "revoked");
  assert.equal(refused.sockets.length, 0);
  second.close();
});

test("a ticket refused over the tailnet node is never read as a revocation", async () => {
  const peer = (code) => async () => ({ ok: false, status: 401, json: async () => ({ error: { code, message: "refused" } }) });
  // whois could not place the phone for a moment: the stream waits and dials again.
  let calls = 0;
  const unverified = fixture(async (...args) => (++calls === 1 ? peer("peer_unverified")(...args) : ticketResponse()));
  const first = unverified.open();
  await unverified.advance();
  assert.equal(unverified.states.at(-1), "offline");
  assert.match(unverified.details.at(-1), /could not confirm through Tailscale/u);
  await unverified.advance(2_000);
  assert.equal(unverified.sockets.length, 1, "the stream dials again once whois can answer");
  unverified.synchronize(unverified.sockets[0]);
  assert.equal(unverified.states.at(-1), "live");
  assert.equal(unverified.states.includes("revoked"), false);
  first.close();
  // The pairing is known from another node: pairing again is the fix, but
  // nothing was revoked, so the stream stops without saying it was.
  const mismatch = fixture(peer("peer_mismatch"));
  const second = mismatch.open();
  await mismatch.advance(120_000);
  assert.equal(mismatch.states.at(-1), "blocked");
  assert.match(mismatch.details.at(-1), /different Tailscale device/u);
  assert.equal(mismatch.sockets.length, 0);
  second.close();
});

const refusal = (extra) => ({ type: "subscribeFailed", key, code: "busy", message: "Too many requests.", retryable: true, ...extra });

test("a retryable subscription refusal redials after the desktop's delay instead of sitting in synchronizing", async () => {
  const f = fixture(), stream = f.open();
  await f.advance(); f.sockets[0].open();
  f.sockets[0].frame(refusal({ retryAfterMs: 2500 }));
  assert.equal(f.states.at(-1), "offline");
  assert.equal(f.sockets[0].readyState, 3, "the refused socket is released");
  await f.advance(2499);
  assert.equal(f.sockets.length, 1);
  await f.advance(1);
  assert.equal(f.sockets.length, 2);
  f.synchronize(f.sockets[1]);
  assert.equal(f.states.at(-1), "live");
  stream.close();
});

test("a final subscription refusal stops in an unavailable state until retry", async () => {
  const f = fixture(), stream = f.open();
  await f.advance(); f.sockets[0].open();
  f.sockets[0].frame(refusal({ code: "not_found", message: "Conversation is unavailable.", retryable: false }));
  assert.equal(f.states.at(-1), "unavailable");
  assert.equal(f.details.at(-1), "Conversation is unavailable.");
  await f.advance(120_000);
  stream.foreground(11_000); await f.advance(60_000);
  assert.equal(f.sockets.length, 1, "nothing redials on its own");
  stream.retry(); await f.advance();
  assert.equal(f.sockets.length, 2);
  f.sockets[1].open();
  assert.equal(f.sockets[1].sent.filter((frame) => frame.type === "subscribe").length, 1);
  stream.close();
});

test("a refusal for another conversation's key does not tear down this subscription", async () => {
  const f = fixture(), stream = f.open();
  await f.advance(); f.synchronize(f.sockets[0]);
  f.sockets[0].frame(refusal({ key: { workspaceId: "workspace", agentId: "other" }, retryable: false }));
  assert.equal(f.states.at(-1), "live");
  assert.equal(f.sockets[0].readyState, 1);
  stream.close();
});

const oversized = () => ({ kind: "send", message: "x".repeat(200_001), uploadIds: [] });

test("an oversized send is refused before it reaches the outbox", async () => {
  const f = fixture(), stream = f.open();
  await f.advance(); f.synchronize(f.sockets[0]);
  assert.throws(() => stream.command(oversized(), "too-long"), /at most 200,000/);
  stream.command(pending("fits").command, "fits");
  assert.deepEqual(f.commands().map((item) => item.commandId), ["fits"]);
  stream.close();
});

test("an oversized send left in an older cache is failed once, locally, and never transmitted", async () => {
  const f = fixture();
  const stream = f.open({ pendingSends: [{ commandId: "poison", command: oversized(), queuedAt: T0 }, pending("after")] });
  await f.advance(); f.synchronize(f.sockets[0]);
  assert.deepEqual(f.commands().map((item) => item.commandId), ["after"]);
  const refused = f.frames.filter((frame) => frame.type === "commandResult" && frame.commandId === "poison");
  assert.equal(refused.length, 1);
  assert.equal(refused[0].code, "too_large");
  stream.foreground(11_000); await f.advance();
  f.synchronize(f.sockets[1]);
  assert.equal(f.commands().filter((item) => item.commandId === "poison").length, 0);
  stream.close();
});

test("a busy refusal keeps the send queued and retries it under the same id after the delay", async () => {
  const f = fixture(), stream = f.open({ pendingSends: [pending("first"), pending("second")] });
  await f.advance(); f.synchronize(f.sockets[0]);
  f.sockets[0].frame({ type: "commandResult", commandId: "first", ok: false, code: "busy", retryAfterMs: 1500 });
  assert.equal(f.frames.some((frame) => frame.type === "commandResult"), false, "a busy send has not failed");
  await f.advance(1499);
  assert.deepEqual(f.commands().map((item) => item.commandId), ["first"]);
  await f.advance(1);
  assert.deepEqual(f.commands().map((item) => item.commandId), ["first", "first"]);
  f.sockets[0].frame({ type: "commandResult", commandId: "first", ok: true });
  assert.deepEqual(f.commands().map((item) => item.commandId), ["first", "first", "second"]);
  stream.close();
});

test("a send the desktop refused as too large leaves the outbox and is not offered again after reconnect", async () => {
  const f = fixture(), stream = f.open({ pendingSends: [pending("refused"), pending("next")] });
  await f.advance(); f.synchronize(f.sockets[0]);
  f.sockets[0].frame({ type: "commandResult", commandId: "refused", ok: false, code: "too_large", message: "Too big." });
  assert.deepEqual(f.commands().map((item) => item.commandId), ["refused", "next"]);
  f.sockets[0].frame({ type: "commandResult", commandId: "next", ok: true });
  stream.foreground(11_000); await f.advance();
  f.synchronize(f.sockets[1]);
  assert.equal(f.commands().length, 2);
  stream.close();
});

const subscribes = (f) => f.sockets.flatMap((socket) => socket.sent.filter((frame) => frame.type === "subscribe"));

test("a cached cursor resumes with its generation, takes only the missed events, and treats a gap as normal", async () => {
  const f = fixture(), stream = f.open({ generation: "gen-1" }, 5);
  await f.advance(); f.sockets[0].open();
  assert.deepEqual(subscribes(f)[0], { type: "subscribe", key, afterSeq: 5, generation: "gen-1", turnLimit: 10 });
  f.sockets[0].frame(event(7, "content_delta", { text: "merged run" }));
  f.sockets[0].frame(event(12, "content_delta", { text: "after a gap" }));
  f.sockets[0].frame({ type: "synchronized", seq: 12, generation: "gen-1" });
  assert.equal(f.states.at(-1), "live");
  assert.equal(f.frames.some((frame) => frame.type === "snapshot"), false);
  // Two quiet minutes, the desktop answering each probe a silent window asks.
  for (let window = 0; window < 8; window++) {
    await f.advance(15_000);
    const probe = f.sockets[0].sent.at(-1);
    if (probe.type === "list") f.sockets[0].frame({ type: "sessions", requestId: probe.requestId, sessions: [] });
  }
  assert.equal(f.sockets.length, 1, "a sequence gap never triggers a resubscribe");
  stream.foreground(11_000); await f.advance(); f.sockets[1].open();
  assert.deepEqual(subscribes(f)[1], { type: "subscribe", key, afterSeq: 12, generation: "gen-1", turnLimit: 10 });
  stream.close();
});

test("a replay or fence for another conversation never moves this one's cursor", async () => {
  const f = fixture(), stream = f.open({ generation: "gen-1" }, 5);
  await f.advance(); f.sockets[0].open();
  const other = { workspaceId: "workspace", agentId: "other" };
  f.sockets[0].frame({ type: "snapshot", reset: true, generation: "other-gen", key: other, page: { events: [event(90, "user_message").event], hasMore: false, beforeCursor: null } });
  f.sockets[0].frame({ type: "synchronized", seq: 90, generation: "other-gen", key: other });
  assert.equal(f.frames.some((frame) => frame.type === "snapshot"), false, "another conversation's replay is not applied");
  assert.notEqual(f.states.at(-1), "live", "another conversation's fence does not synchronize this one");
  f.sockets[0].frame({ type: "synchronized", seq: 6, generation: "gen-1", key });
  assert.equal(f.states.at(-1), "live");
  stream.foreground(11_000); await f.advance(); f.sockets[1].open();
  assert.deepEqual(subscribes(f)[1], { type: "subscribe", key, afterSeq: 6, generation: "gen-1", turnLimit: 10 });
  stream.close();
});

test("a snapshot from another log generation replaces the cursor even without a reset flag", async () => {
  const f = fixture(), stream = f.open({ generation: "old" }, 50);
  await f.advance(); f.sockets[0].open();
  f.sockets[0].frame({ type: "snapshot", generation: "new", page: { events: [event(3, "user_message").event], hasMore: false, beforeCursor: null } });
  f.sockets[0].frame({ type: "synchronized", seq: 3, generation: "new" });
  assert.equal(f.frames.find((frame) => frame.type === "snapshot").reset, true);
  stream.foreground(11_000); await f.advance(); f.sockets[1].open();
  assert.deepEqual(subscribes(f)[1], { type: "subscribe", key, afterSeq: 3, generation: "new", turnLimit: 10 });
  stream.close();
});

test("a snapshot sent in parts reaches the screen once, whole, before the fence", async () => {
  const f = fixture(), stream = f.open({ pendingSends: [pending("acknowledged"), pending("next")] });
  await f.advance(); f.sockets[0].open();
  const part = (index, total, events) => ({ type: "snapshot", reset: true, generation: "gen-2", part: { index, total }, page: { events, hasMore: true, beforeCursor: 4 } });
  f.sockets[0].frame(part(0, 2, [event(4, "user_message", { commandId: "acknowledged", turnId: "t" }).event]));
  assert.equal(f.frames.length, 0, "the first part alone is not applied");
  f.sockets[0].frame(part(1, 2, [event(6, "turn_completed", { turnId: "t" }).event]));
  f.sockets[0].frame({ type: "synchronized", seq: 6, generation: "gen-2" });
  const snapshots = f.frames.filter((frame) => frame.type === "snapshot");
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0].page.events.map((item) => item.seq), [4, 6]);
  assert.deepEqual(f.commands().map((item) => item.commandId), ["next"], "acknowledgments in any part settle the outbox");
  stream.close();
});

test("a snapshot with a missing part is never applied; the phone subscribes again", async () => {
  const f = fixture(), stream = f.open();
  await f.advance(); f.sockets[0].open();
  const part = (index, total) => ({ type: "snapshot", reset: true, generation: "gen-2", part: { index, total }, page: { events: [event(index + 1, "content_delta").event], hasMore: false, beforeCursor: null } });
  f.sockets[0].frame(part(0, 3));
  f.sockets[0].frame(part(2, 3));
  assert.equal(f.frames.filter((frame) => frame.type === "snapshot").length, 0);
  assert.equal(f.states.at(-1), "offline");
  await f.advance(1000);
  assert.equal(f.sockets.length, 2);
  stream.close();
});

test("a send the desktop's runtime lost the session for is offered once more under its id, never twice", async () => {
  const f = fixture(), stream = f.open({ pendingSends: [pending("lost"), pending("after")] });
  await f.advance(); f.synchronize(f.sockets[0]);
  // The Studio server running the chat restarted between the desktop finding
  // the session and sending on it. The tailnet lane passes the runtime's words
  // on under `unavailable`; a newer one may name the code itself.
  f.sockets[0].frame({ type: "commandResult", commandId: "lost", ok: false, code: "unavailable", message: "Conversation session is invalid." });
  assert.deepEqual(f.commands().map((item) => item.commandId), ["lost", "lost"]);
  assert.equal(f.frames.some((frame) => frame.type === "commandResult"), false, "the first refusal is not a failure the screen shows");
  f.sockets[0].frame({ type: "commandResult", commandId: "lost", ok: false, code: "session_not_found", message: "Gone again." });
  assert.deepEqual(f.commands().map((item) => item.commandId), ["lost", "lost", "after"], "a second refusal stands");
  assert.equal(f.frames.filter((frame) => frame.type === "commandResult").length, 1);
  // Any other refusal is never sent again.
  f.sockets[0].frame({ type: "commandResult", commandId: "after", ok: false, code: "unavailable", message: "Conversation is unavailable." });
  assert.equal(f.commands().length, 3);
  stream.close();
});

test("a live socket that falls silent is asked whether it is there, and redialled when it does not answer", async () => {
  const f = fixture(), stream = f.open();
  await f.advance(); f.synchronize(f.sockets[0]);
  await f.advance(14_999);
  assert.equal(f.sockets[0].sent.filter((frame) => frame.type === "list").length, 0, "no probe inside the window");
  await f.advance(1);
  const probe = f.sockets[0].sent.at(-1);
  assert.equal(probe.type, "list");
  await f.advance(10_000);
  assert.equal(f.sockets.length, 1, "one unanswered probe is asked again, not redialled");
  const again = f.sockets[0].sent.at(-1);
  assert.equal(again.type, "list");
  assert.notEqual(again.requestId, probe.requestId);
  await f.advance(10_000);
  assert.equal(f.sockets.length, 2, "a second unanswered probe redials at once");
  assert.equal(f.states.at(-1), "connecting");
  stream.close();
});

test("a probe waits ten seconds for an answer, not three", async () => {
  const f = fixture(), stream = f.open();
  await f.advance(); f.synchronize(f.sockets[0]);
  await f.advance(15_000);
  const probes = () => f.sockets[0].sent.filter((frame) => frame.type === "list").length;
  assert.equal(probes(), 1);
  await f.advance(9_999);
  assert.equal(probes(), 1, "no second probe inside the deadline");
  await f.advance(1);
  assert.equal(probes(), 2);
  stream.close();
});

test("any frame that arrives while a probe waits answers it, a stream frame as much as the reply", async () => {
  const f = fixture(), stream = f.open();
  await f.advance(); f.synchronize(f.sockets[0]);
  await f.advance(15_000);
  assert.equal(f.sockets[0].sent.at(-1).type, "list");
  const live = f.states.length;
  // The desktop is slow to rebuild its list, but the chat's own stream goes on.
  await f.advance(5_000);
  f.sockets[0].frame(event(1, "content_delta", { text: "still streaming" }));
  await f.advance(30_000);
  assert.equal(f.sockets.length, 1, "a frame in the probe's wait keeps the socket");
  assert.equal(f.states.slice(live).includes("connecting"), false);
  stream.close();
});

test("a frame after one missed probe forgives the miss", async () => {
  const f = fixture(), stream = f.open();
  await f.advance(); f.synchronize(f.sockets[0]);
  await f.advance(15_000 + 10_000);
  assert.equal(f.sockets[0].sent.filter((frame) => frame.type === "list").length, 2, "asked a second time");
  f.sockets[0].frame(event(1, "content_delta", { text: "late, but here" }));
  // A fresh silence starts the count again: the next window's probe goes
  // unanswered (at 55s) and is asked again, and only that one's silence redials.
  await f.advance(30_000);
  assert.equal(f.sockets.length, 1, "the earlier miss is not held against the socket");
  await f.advance(10_000);
  assert.equal(f.sockets.length, 2);
  stream.close();
});

test("a desktop that answers hello is probed with hello, and the answer stays inside the stream", async () => {
  const f = fixture(), stream = f.open({ hello: true });
  await f.advance(); f.synchronize(f.sockets[0]);
  await f.advance(15_000);
  const probe = f.sockets[0].sent.at(-1);
  assert.deepEqual(probe, { type: "hello", requestId: probe.requestId });
  assert.equal(f.sockets[0].sent.some((frame) => frame.type === "list"), false, "no list is asked for");
  const count = f.frames.length;
  f.sockets[0].frame({
    type: "result", requestId: probe.requestId, ok: true,
    data: { protocolVersion: 1, minProtocolVersion: 1, capabilities: [] },
  });
  assert.equal(f.frames.length, count, "the probe's answer is not handed to the screen");
  await f.advance(10_000);
  assert.equal(f.sockets.length, 1, "an answered hello keeps the socket");
  stream.close();
});

test("a socket that is heard from, or answers its probe, is left alone", async () => {
  const f = fixture(), stream = f.open();
  await f.advance(); f.synchronize(f.sockets[0]);
  await f.advance(10_000);
  f.sockets[0].frame(event(1, "content_delta", { text: "still here" }));
  await f.advance(5_000);
  assert.equal(f.sockets[0].sent.filter((frame) => frame.type === "list").length, 0, "a frame in the window keeps the socket unasked");
  await f.advance(15_000);
  const probe = f.sockets[0].sent.at(-1);
  assert.equal(probe.type, "list", "a whole silent window asks");
  f.sockets[0].frame({ type: "sessions", requestId: probe.requestId, sessions: [] });
  await f.advance(10_000);
  assert.equal(f.sockets.length, 1, "an answered probe keeps the socket");
  stream.close();
});

test("coming back to the app starts the reconnect backoff again", async () => {
  const f = fixture(), stream = f.open();
  // Five dials that open and drop at once, as a phone away from its network
  // sees: the backoff is at its thirty-second ceiling.
  for (let drop = 0; drop < 5; drop++) {
    await f.advance(30_000);
    const socket = f.sockets.at(-1); socket.open(); socket.serverClose(1006);
  }
  await f.advance(30_000);
  const before = f.sockets.length;
  stream.foreground(60_000);
  await f.advance();
  assert.equal(f.sockets.length, before + 1, "the foreground dials at once");
  const socket = f.sockets.at(-1); socket.open(); socket.serverClose(1006);
  await f.advance(1000);
  assert.equal(f.sockets.length, before + 2, "and a dial that fails then retries within a second");
  stream.close();
});

// ── Messages the desktop holds (`conversation-queued-sends`) ─────────────────
const held = (id, message = id) => ({ commandId: id, command: { kind: "send", message, queue: true }, queuedAt: T0 });
const watches = (socket) => socket.sent.filter((frame) => frame.type === "watchQueued");

test("a send handed to the desktop goes at once behind a running turn, without uploads, and the queue is watched after the fence", async () => {
  const f = fixture(), stream = f.open({ queuedSends: true });
  await f.advance(); f.synchronize(f.sockets[0], [event(1, "turn_started", { turnId: "t" }).event], 1);
  assert.equal(watches(f.sockets[0]).length, 1, "asked after the fence");
  stream.command({ kind: "send", message: "after this", uploadIds: [] }, "phone-held");
  assert.equal(f.commands().length, 0, "a send held on the phone still waits on the turn");
  stream.command(held("handed", "and this too").command, "handed");
  assert.deepEqual(f.commands().map((frame) => frame.command), [{ kind: "send", message: "and this too", queue: true }]);
  assert.equal("uploadIds" in f.commands()[0].command, false, "queue never rides beside uploadIds");
  f.sockets[0].frame({ type: "commandResult", commandId: "handed", ok: true });
  assert.deepEqual(f.frames.filter((frame) => frame.type === "commandResult").map((frame) => frame.commandId), ["handed"]);
  stream.close();
});

test("without the capability a cached handed-over send waits on the turn like any other and goes without queue", async () => {
  const f = fixture(), stream = f.open({ pendingSends: [held("cached", "from before")], initiallyBusy: true });
  await f.advance(); f.synchronize(f.sockets[0], [event(1, "turn_started", { turnId: "t" }).event], 1);
  assert.equal(f.commands().length, 0);
  assert.equal(watches(f.sockets[0]).length, 0, "an older desktop is never asked to watch");
  f.sockets[0].frame(event(2, "turn_completed", { turnId: "t" }));
  assert.deepEqual(f.commands().map((frame) => frame.command), [{ kind: "send", message: "from before" }]);
  stream.close();
});

test("after a redial the queue is watched again and an unanswered hand-over is offered once more under its id", async () => {
  const f = fixture(), stream = f.open({ queuedSends: true, pendingSends: [held("answered"), held("unanswered")] });
  await f.advance(); f.synchronize(f.sockets[0]);
  assert.deepEqual(f.commands().map((frame) => frame.commandId), ["answered", "unanswered"]);
  f.sockets[0].frame({ type: "commandResult", commandId: "answered", ok: true });
  f.sockets[0].serverClose(1006);
  await f.advance(1_000);
  assert.equal(f.sockets.length, 2);
  f.synchronize(f.sockets[1]);
  assert.equal(watches(f.sockets[1]).length, 1, "a new subscription starts with no watch");
  assert.deepEqual(f.sockets[1].sent.filter((frame) => frame.type === "command").map((frame) => frame.commandId), ["unanswered"]);
  stream.close();
});

test("a hand-over whose answer was lost and which the desktop has since sent is never offered again", async () => {
  const f = fixture(), stream = f.open({ queuedSends: true }, 4);
  await f.advance(); f.synchronize(f.sockets[0], [], 4);
  stream.command(held("lost-answer", "draft the phone side").command, "lost-answer");
  f.sockets[0].serverClose(1006);
  await f.advance(1_000);
  f.sockets[1].open();
  // The turn ended while the phone was away and the desktop sent what it held,
  // joined with a line queued on the desktop itself.
  f.sockets[1].frame({ type: "snapshot", page: { events: [
    event(5, "turn_completed", { turnId: "t1" }).event,
    event(6, "user_message", { text: "check the gateway\ndraft the phone side", commandId: "desktop-own" }).event,
  ], hasMore: false, beforeCursor: null } });
  f.sockets[1].frame({ type: "synchronized", seq: 6 });
  assert.equal(f.sockets[1].sent.filter((frame) => frame.type === "command").length, 0, "not held a second time");
  assert.deepEqual(
    f.frames.filter((frame) => frame.type === "commandResult").map((frame) => [frame.commandId, frame.ok]),
    [["lost-answer", true]],
  );
  stream.close();
});

test("the same words sent before the hand-over do not count as it landing", async () => {
  const f = fixture(), stream = f.open({ queuedSends: true }, 4);
  await f.advance(); f.synchronize(f.sockets[0], [event(3, "user_message", { text: "yes" }).event], 4);
  stream.command(held("again", "yes").command, "again");
  f.sockets[0].serverClose(1006);
  await f.advance(1_000);
  f.synchronize(f.sockets[1], [event(3, "user_message", { text: "yes" }).event], 4);
  assert.deepEqual(f.sockets[1].sent.filter((frame) => frame.type === "command").map((frame) => frame.commandId), ["again"]);
  stream.close();
});

test("a busy refusal of a hand-over offers it again after the delay; a queued frame for another chat is dropped", async () => {
  const f = fixture(), stream = f.open({ queuedSends: true });
  await f.advance(); f.synchronize(f.sockets[0]);
  stream.command(held("crowded").command, "crowded");
  f.sockets[0].frame({ type: "commandResult", commandId: "crowded", ok: false, code: "busy", retryAfterMs: 500 });
  assert.equal(f.frames.some((frame) => frame.type === "commandResult"), false, "not a failure");
  await f.advance(500);
  assert.deepEqual(f.commands().map((frame) => frame.commandId), ["crowded", "crowded"]);
  f.sockets[0].frame({ type: "queued", key: { workspaceId: "workspace", agentId: "other" }, messages: [] });
  f.sockets[0].frame({ type: "queued", key, messages: [{ id: "q1", text: "crowded", createdAt: 1 }] });
  assert.deepEqual(f.frames.filter((frame) => frame.type === "queued").map((frame) => frame.key.agentId), ["agent"]);
  stream.close();
});

test("a hand-over not yet offered can be withdrawn locally; one offered is the desktop's to give back", async () => {
  const f = fixture(), stream = f.open({ queuedSends: true });
  await f.advance();
  stream.command(held("early").command, "early");
  stream.cancelPending("early");
  f.synchronize(f.sockets[0]);
  assert.equal(f.commands().length, 0);
  stream.command(held("offered").command, "offered");
  stream.cancelPending("offered");
  f.sockets[0].serverClose(1006);
  await f.advance(1_000);
  f.synchronize(f.sockets[1]);
  assert.deepEqual(f.sockets[1].sent.filter((frame) => frame.type === "command").map((frame) => frame.commandId), ["offered"]);
  stream.command({ kind: "cancelQueued", queuedId: "q1" }, "take-back");
  assert.deepEqual(f.sockets[1].sent.at(-1), { type: "command", commandId: "take-back", command: { kind: "cancelQueued", queuedId: "q1" } });
  stream.close();
});

test("a hand-over carried over from the cache is not offered again when the chat shows the desktop already sent it", async () => {
  // The first stream offered it and lost the answer with its socket; the chat
  // was then closed (or the app restarted), and the turn ended meanwhile.
  const f = fixture();
  const stream = f.open({ queuedSends: true, pendingSends: [{ ...held("carried", "draft X"), heldAfter: 4 }] }, 9);
  await f.advance(); f.sockets[0].open();
  f.sockets[0].frame({ type: "snapshot", reset: true, page: { events: [
    event(3, "user_message", { text: "draft X" }).event,
    event(5, "turn_completed", { turnId: "t1" }).event,
    event(6, "user_message", { text: "draft X", commandId: "desktop-own" }).event,
  ], hasMore: false, beforeCursor: null } });
  f.sockets[0].frame({ type: "synchronized", seq: 6 });
  assert.equal(f.commands().length, 0, "sent once, by the desktop");
  assert.deepEqual(f.frames.filter((frame) => frame.type === "commandResult").map((frame) => [frame.commandId, frame.ok]), [["carried", true]]);
  stream.close();
});

test("a carried hand-over with no recorded cursor reads the chat from where its stream starts", async () => {
  const f = fixture(), stream = f.open({ queuedSends: true, pendingSends: [held("older-cache", "draft Y")] }, 6);
  await f.advance(); f.sockets[0].open();
  f.sockets[0].frame(event(7, "user_message", { text: "draft Y" }));
  f.sockets[0].frame({ type: "synchronized", seq: 7 });
  assert.equal(f.commands().length, 0);
  stream.close();
});

test("only the first message after the offer can be the held one; the same words later are not taken for it", async () => {
  const f = fixture(), stream = f.open({ queuedSends: true, pendingSends: [{ ...held("never-held", "yes"), heldAfter: 4 }] }, 4);
  await f.advance(); f.sockets[0].open();
  f.sockets[0].frame(event(5, "user_message", { text: "something else" }));
  f.sockets[0].frame(event(6, "turn_completed", { turnId: "t" }));
  f.sockets[0].frame(event(7, "user_message", { text: "yes" }));
  f.sockets[0].frame({ type: "synchronized", seq: 7 });
  assert.deepEqual(f.commands().map((frame) => frame.commandId), ["never-held"], "offered: the desktop never had it");
  stream.close();
});

// ── A message that waited while the phone was away ───────────────────────────
// Android suspends an app in the background. A message the desktop turned
// away busy stopped being offered when the phone slept, and was offered again
// under its id when the chat next opened, a day later, as a new turn nobody
// asked for. Carried across an absence, a message now goes without asking
// only while it is young and its turn has not ended meanwhile.
const MINUTE = 60_000;
const sent = (id, message = id, queuedAt = T0) => ({
  commandId: id,
  command: { kind: "send", message, uploadIds: [], composedAt: queuedAt },
  queuedAt,
});
/** A turn's end as the desktop records it, on its own clock. */
const endedAt = (seq, at) => ({ ...event(seq, "turn_completed", { turnId: "t" }).event, createdAt: at });
const commandsOn = (socket) => socket.sent.filter((frame) => frame.type === "command");

test("a send turned away busy is not offered a day later when the chat reopens; it is handed back as not sent", async () => {
  const f = fixture();
  const first = f.open();
  await f.advance(); f.synchronize(f.sockets[0]);
  first.command(sent("X", "run the migration").command, "X");
  assert.deepEqual(commandsOn(f.sockets[0]).map((frame) => frame.commandId), ["X"]);
  // A turn the phone had not heard of is running; then the phone sleeps.
  f.sockets[0].frame({ type: "commandResult", commandId: "X", ok: false, code: "busy", retryAfterMs: 1_000 });
  first.close();
  await f.advance(23 * HOUR);
  // The app opens the chat again with what its cache kept; the chat is idle.
  const reopened = f.open({ pendingSends: [sent("X", "run the migration")] }, 0);
  await f.advance();
  f.synchronize(f.sockets[1], [endedAt(1, T0 + 5 * MINUTE)], 1);
  assert.deepEqual(commandsOn(f.sockets[1]), [], "no command for X goes out");
  assert.deepEqual(f.stale, ["X"], "X is offered to the person as not sent");
  reopened.close();
});

test("a carried send under the limit whose turn has not ended still goes when the chat is free", async () => {
  const f = fixture();
  const stream = f.open({ pendingSends: [sent("young", "young", T0 - 9 * MINUTE)] });
  await f.advance();
  f.synchronize(f.sockets[0]);
  assert.deepEqual(commandsOn(f.sockets[0]).map((frame) => frame.commandId), ["young"]);
  assert.deepEqual(f.stale, []);
  stream.close();
});

test("a send cached before the phone kept when it was written is taken for an old one", async () => {
  const f = fixture();
  const legacy = { commandId: "legacy", command: { kind: "send", message: "from an older build", uploadIds: [] } };
  const stream = f.open({ pendingSends: [legacy, sent("fresh")] });
  await f.advance();
  f.synchronize(f.sockets[0]);
  assert.deepEqual(commandsOn(f.sockets[0]).map((frame) => frame.commandId), ["fresh"]);
  assert.deepEqual(f.stale, ["legacy"]);
  stream.close();
});

test("a carried send whose turn ended while the phone was away is not offered, however young", async () => {
  const f = fixture();
  const stream = f.open({ pendingSends: [sent("behind-a-turn", "and then this", T0 - 2 * MINUTE)] }, 4);
  await f.advance();
  f.sockets[0].open();
  // What happened while no stream listened: the turn it waited on ended.
  f.sockets[0].frame({ type: "snapshot", page: { events: [endedAt(5, T0 - MINUTE)], hasMore: false, beforeCursor: null } });
  f.sockets[0].frame({ type: "synchronized", seq: 5 });
  assert.deepEqual(commandsOn(f.sockets[0]), []);
  assert.deepEqual(f.stale, ["behind-a-turn"]);
  stream.close();
});

test("a send waiting while the app is in the background is offered again only if its turn did not end meanwhile", async () => {
  const f = fixture(), stream = f.open();
  await f.advance();
  f.synchronize(f.sockets[0], [event(1, "turn_started", { turnId: "t" }).event], 1);
  stream.command(sent("waits", "after this", T0).command, "waits");
  assert.deepEqual(commandsOn(f.sockets[0]), [], "it waits on the running turn");
  // Watched in front, a turn's end sends it; here the app went away first.
  stream.foreground(3 * MINUTE);
  await f.advance();
  f.sockets[1].open();
  f.sockets[1].frame({ type: "event", event: endedAt(2, T0 + MINUTE) });
  f.sockets[1].frame({ type: "synchronized", seq: 2 });
  assert.deepEqual(commandsOn(f.sockets[1]), []);
  assert.deepEqual(f.stale, ["waits"]);
  stream.close();
});

test("a busy answer from a desktop that holds messages offers the send once more, under its id, to be held", async () => {
  const f = fixture(), stream = f.open({ queuedSends: true });
  await f.advance(); f.synchronize(f.sockets[0]);
  stream.command(sent("words", "check the logs").command, "words");
  f.sockets[0].frame({ type: "commandResult", commandId: "words", ok: false, code: "busy", retryAfterMs: 1_000 });
  assert.deepEqual(
    commandsOn(f.sockets[0]).map((frame) => [frame.commandId, frame.command]),
    [
      ["words", { kind: "send", message: "check the logs", uploadIds: [], composedAt: T0 }],
      ["words", { kind: "send", message: "check the logs", composedAt: T0, queue: true }],
    ],
    "the same id, now held by the desktop, with no uploads beside queue",
  );
  assert.deepEqual(f.reheld.map((item) => [item.id, item.command.queue]), [["words", true]]);
  // The desktop's own crowding is waited out under the same id, as a held send is.
  f.sockets[0].frame({ type: "commandResult", commandId: "words", ok: false, code: "busy", retryAfterMs: 500 });
  await f.advance(500);
  assert.equal(commandsOn(f.sockets[0]).length, 3);
  assert.equal(commandsOn(f.sockets[0]).at(-1).command.queue, true, "held once; never back to a plain send");
  assert.equal(f.reheld.length, 1);
  f.sockets[0].frame({ type: "commandResult", commandId: "words", ok: true });
  assert.deepEqual(f.frames.filter((frame) => frame.type === "commandResult").map((frame) => [frame.commandId, frame.ok]), [["words", true]]);
  stream.close();
});

test("a busy send with pictures, or from a desktop that holds nothing, waits on the phone and says so", async () => {
  const f = fixture(), stream = f.open({ queuedSends: true });
  await f.advance(); f.synchronize(f.sockets[0]);
  stream.command({ kind: "send", message: "see this", uploadIds: ["upload-1"], composedAt: T0 }, "picture");
  f.sockets[0].frame({ type: "commandResult", commandId: "picture", ok: false, code: "busy", retryAfterMs: 1_000 });
  await f.advance(1_000);
  assert.deepEqual(commandsOn(f.sockets[0]).map((frame) => frame.command.queue), [undefined, undefined]);
  assert.deepEqual(f.reheld, []);
  assert.deepEqual(f.waiting, ["picture"]);
  stream.close();
  const older = fixture(), plainStream = older.open();
  await older.advance(); older.synchronize(older.sockets[0]);
  plainStream.command(sent("words").command, "words");
  older.sockets[0].frame({ type: "commandResult", commandId: "words", ok: false, code: "busy", retryAfterMs: 1_000 });
  await older.advance(1_000);
  assert.deepEqual(commandsOn(older.sockets[0]).map((frame) => frame.command.queue), [undefined, undefined]);
  assert.deepEqual(older.waiting, ["words"]);
  plainStream.close();
});

test("a busy send with pictures goes to a desktop that holds them, pictures and all, under its id", async () => {
  const f = fixture(), stream = f.open({ queuedSends: true, queuedAttachments: true });
  await f.advance(); f.synchronize(f.sockets[0]);
  stream.command({ kind: "send", message: "see this", uploadIds: ["upload-1"], composedAt: T0 }, "picture");
  f.sockets[0].frame({ type: "commandResult", commandId: "picture", ok: false, code: "busy", retryAfterMs: 1_000 });
  assert.deepEqual(
    commandsOn(f.sockets[0]).map((frame) => [frame.commandId, frame.command]),
    [
      ["picture", { kind: "send", message: "see this", uploadIds: ["upload-1"], composedAt: T0 }],
      ["picture", { kind: "send", message: "see this", uploadIds: ["upload-1"], composedAt: T0, queue: true }],
    ],
  );
  assert.deepEqual(f.reheld.map((item) => item.id), ["picture"]);
  assert.deepEqual(f.waiting, [], "nothing waits on the phone");
  f.sockets[0].frame({ type: "commandResult", commandId: "picture", ok: true });
  await f.advance(1_000);
  assert.equal(commandsOn(f.sockets[0]).length, 2, "held once, never offered again");
  stream.close();
});

test("sends written behind a busy one go to the desktop with it, in the order they were written", async () => {
  const f = fixture(), stream = f.open({ queuedSends: true, queuedAttachments: true });
  await f.advance(); f.synchronize(f.sockets[0]);
  stream.command(sent("first", "check the logs").command, "first");
  stream.command(sent("second", "then the tests").command, "second");
  stream.command({ kind: "send", message: "and this", uploadIds: ["upload-2"], composedAt: T0 }, "third");
  assert.deepEqual(commandsOn(f.sockets[0]).map((frame) => frame.commandId), ["first"], "one send in flight at a time");
  f.sockets[0].frame({ type: "commandResult", commandId: "first", ok: false, code: "busy", retryAfterMs: 1_000 });
  assert.deepEqual(
    commandsOn(f.sockets[0]).slice(1).map((frame) => [frame.commandId, frame.command.queue, frame.command.uploadIds]),
    [["first", true, undefined], ["second", true, undefined], ["third", true, ["upload-2"]]],
  );
  assert.deepEqual(f.reheld.map((item) => item.id), ["first", "second", "third"]);
  assert.deepEqual(f.waiting, []);
  for (const id of ["first", "second", "third"]) f.sockets[0].frame({ type: "commandResult", commandId: id, ok: true });
  await f.advance(1_000);
  assert.equal(commandsOn(f.sockets[0]).length, 4, "none is offered as a plain send afterwards");
  stream.close();
});

test("a cached held send with pictures goes as a plain one to a desktop that holds only words", async () => {
  const pictured = { commandId: "cached", command: { kind: "send", message: "see this", uploadIds: ["upload-3"], queue: true }, queuedAt: T0 };
  const f = fixture(), stream = f.open({ queuedSends: true, pendingSends: [pictured] });
  await f.advance(); f.synchronize(f.sockets[0]);
  assert.deepEqual(commandsOn(f.sockets[0]).map((frame) => frame.command), [{ kind: "send", message: "see this", uploadIds: ["upload-3"] }]);
  stream.close();
});

test("a send the desktop refuses as stale is handed back, and Send now offers it under its id, confirmed", async () => {
  const f = fixture(), stream = f.open();
  await f.advance(); f.synchronize(f.sockets[0]);
  const old = sent("late", "run the migration", T0 - 2 * HOUR).command;
  stream.command(old, "late");
  f.sockets[0].frame({ type: "commandResult", commandId: "late", ok: false, code: "stale", message: "Written a while ago." });
  assert.deepEqual(f.stale, ["late"]);
  assert.equal(f.frames.some((frame) => frame.type === "commandResult"), false, "not a refusal the screen shows as failed");
  stream.foreground(11_000); await f.advance();
  f.synchronize(f.sockets[1]);
  assert.deepEqual(commandsOn(f.sockets[1]), [], "never offered again without asking");
  stream.command({ ...old, confirmedStale: true }, "late");
  assert.deepEqual(commandsOn(f.sockets[1]).map((frame) => [frame.commandId, frame.command.confirmedStale]), [["late", true]]);
  stream.close();
});

test("a stale send can be let go of, and a confirmed one is never held back by the phone's own rule", async () => {
  const f = fixture();
  const stream = f.open({
    pendingSends: [
      { ...sent("discarded", "no", T0 - 3 * HOUR), stale: true },
      { ...sent("confirmed", "yes", T0 - 3 * HOUR), command: { ...sent("confirmed", "yes", T0 - 3 * HOUR).command, confirmedStale: true } },
    ],
  });
  await f.advance();
  assert.deepEqual(f.stale, ["discarded"]);
  stream.cancelPending("discarded");
  f.synchronize(f.sockets[0]);
  assert.deepEqual(commandsOn(f.sockets[0]).map((frame) => frame.commandId), ["confirmed"]);
  stream.close();
});
