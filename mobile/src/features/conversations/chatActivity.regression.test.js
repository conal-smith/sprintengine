const assert = require("node:assert/strict");
const { test } = require("node:test");
const { phoneChatActivity, studioToolName, urlHost } = require("../../../.mobile-test-build/src/features/conversations/chatActivity.js");

const tools = (id, list) => ({ kind: "tools", id, tools: list });
const tool = (id, name, extra = {}) => ({ id, name, status: "ok", ...extra });
const lane = (id, status) => ({ id, turn: "t1", task: "Map the router", status, startedAt: 1 });

test("a studio tool is read by its own name on every runtime, and no other server's is", () => {
  assert.equal(studioToolName({ name: "mcp__sprintengine-studio__browser_open" }), "browser_open");
  assert.equal(studioToolName({ name: "sprintengine-studio.canvas_edit" }), "canvas_edit");
  assert.equal(studioToolName({ name: "browser_open", serverName: "sprintengine-studio" }), "browser_open");
  assert.equal(studioToolName({ name: "mcp__playwright__browser_navigate" }), null);
});

test("a chat that touched nothing has no rows", () => {
  const activity = phoneChatActivity([{ kind: "message", id: "m1", role: "user", text: "hi", at: 1 }], []);
  assert.deepEqual(activity.order, []);
  assert.equal(activity.agents, null);
});

test("rows come in the order the agent first touched each thing, the Library last", () => {
  const activity = phoneChatActivity(
    [
      { kind: "message", id: "m1", role: "user", text: "fix it", at: 1, images: [{ id: "u1", ref: "c/u1.png" }] },
      tools("r1", [tool("e1", "Edit", { kind: "file_edit", input: { file_path: "src/a.ts" } })]),
      tools("r2", [tool("b1", "mcp__sprintengine-studio__browser_open", { status: "running", input: { url: "http://localhost:5173/export" } })]),
      { kind: "agent", id: "a1", lane: lane("l1", "running") },
      tools("r3", [tool("c1", "mcp__sprintengine-studio__canvas_edit", { input: { board: "export-flow" } })]),
      tools("r4", [tool("g1", "GenerateImage", { input: { path: "out/flow.png", prompt: "the export flow" } })]),
    ],
    [lane("l1", "running"), lane("l2", "done")],
  );
  assert.deepEqual(activity.order, ["changes", "browser", "agents", "canvas", "library"]);
  assert.deepEqual(activity.browser, { live: true, url: "http://localhost:5173/export" });
  assert.deepEqual(activity.canvas, { live: false, board: "export-flow" });
  assert.deepEqual(activity.agents, { total: 2, working: 1 });
  assert.equal(activity.sent.length, 1);
  assert.deepEqual(activity.steps.map((step) => step.tool.id), ["g1"]);
});

test("a step inside a folded turn counts, and an edit still running is live", () => {
  const activity = phoneChatActivity(
    [{ kind: "fold", id: "f1", turn: "t1", label: "Worked", failed: 0, live: true, parts: [{ kind: "tools", id: "p1", tools: [tool("e1", "Write", { kind: "file_write", status: "running", input: { file_path: "a.ts" } })] }] }],
    [],
  );
  assert.deepEqual(activity.order, ["changes"]);
  assert.equal(activity.editing, true);
});

test("the Browser row names the page's host", () => {
  assert.equal(urlHost("http://localhost:5173/export?x=1"), "localhost:5173");
  assert.equal(urlHost("localhost:5173/export"), "localhost:5173");
  assert.equal(urlHost(null), null);
});
