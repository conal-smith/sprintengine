/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const buildRoot = path.resolve(__dirname, "../../.mobile-test-build");
const {
  buildSettleArgs,
  createConversationLifecycleApi,
  readSettleAnswer,
  readVisitAnswer,
} = require(path.join(buildRoot, "src/api/conversationLifecycle.js"));

test("settle sends the workspace, and `settled` only to un-settle", () => {
  assert.deepEqual(buildSettleArgs("w1"), { workspaceId: "w1" });
  assert.deepEqual(buildSettleArgs("w1", false), { workspaceId: "w1", settled: false });
});

test("an answer counts only in the tool's shape, for the chat that was asked about", () => {
  assert.deepEqual(readSettleAnswer({ ok: true, workspaceId: "w1", settledAt: 5 }, "w1"), { workspaceId: "w1", settledAt: 5 });
  assert.deepEqual(readSettleAnswer({ ok: true, workspaceId: "w1", settledAt: null }, "w1"), { workspaceId: "w1", settledAt: null });
  assert.equal(readSettleAnswer({ ok: true, workspaceId: "w2", settledAt: 5 }, "w1"), null);
  assert.equal(readSettleAnswer({ ok: true, workspaceId: "w1", settledAt: "5" }, "w1"), null);
  assert.equal(readSettleAnswer({ ok: true, workspaceId: "w1" }, "w1"), null);
  assert.equal(readSettleAnswer({ workspaceId: "w1", settledAt: 5 }, "w1"), null);
  assert.deepEqual(readVisitAnswer({ ok: true, workspaceId: "w1", lastVisitedAt: 9 }, "w1"), { workspaceId: "w1", lastVisitedAt: 9 });
  assert.equal(readVisitAnswer({ ok: true, workspaceId: "w1", lastVisitedAt: -1 }, "w1"), null);
  assert.equal(readVisitAnswer({ ok: true, workspaceId: "w1", lastVisitedAt: null }, "w1"), null);
  assert.equal(readVisitAnswer(null, "w1"), null);
});

test("the tools go over the gateway's JSON-RPC POST with the device token", async (t) => {
  const calls = [];
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.authorization, name: body.params.name, args: body.params.arguments });
    const structuredContent =
      body.params.name === "conversation.settle"
        ? { ok: true, workspaceId: body.params.arguments.workspaceId, settledAt: 42 }
        : { ok: true, workspaceId: body.params.arguments.workspaceId, lastVisitedAt: 43 };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: body.id, result: { structuredContent } }) };
  };
  const api = createConversationLifecycleApi({ baseUrl: "http://desk:7777", deviceToken: "tok" });
  assert.deepEqual(await api.settle("w1"), { ok: true, data: { workspaceId: "w1", settledAt: 42 } });
  assert.deepEqual(await api.visit("w1"), { ok: true, data: { workspaceId: "w1", lastVisitedAt: 43 } });
  assert.deepEqual(
    calls.map((call) => [call.url, call.auth, call.name, call.args]),
    [
      ["http://desk:7777/tailnet/v1/mcp", "Bearer tok", "conversation.settle", { workspaceId: "w1" }],
      // No instant: the desktop stamps its own clock, the one its turns end on.
      ["http://desk:7777/tailnet/v1/mcp", "Bearer tok", "conversation.visit", { workspaceId: "w1" }],
    ],
  );
  // A refusal comes back as a failure with the desktop's words, never a throw.
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ result: { isError: true, structuredContent: { ok: false, error: { code: "unknown_workspace", message: "No such chat." } } } }),
  });
  const refused = await api.settle("w1");
  assert.equal(refused.ok, false);
  assert.equal(refused.message, "No such chat.");
  // A desktop that answered something else did not settle it.
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: { structuredContent: { ok: true } } }) });
  assert.equal((await api.settle("w1")).ok, false);
});
