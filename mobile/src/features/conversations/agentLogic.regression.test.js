const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  readSubagentStatus,
  isBackgroundLaunchAck,
  laneStatus,
  laneDetail,
  laneLabel,
  laneGlyphState,
  placeAgentMessages,
  summarizeAgents,
  workingLabel,
  formatDuration,
  formatElapsed,
  reportPreview,
  agentTypeDescription,
  agentStopOffer,
} = require("../../../.mobile-test-build/src/features/conversations/agentLogic.js");

const lane = (overrides = {}) => ({
  id: "task",
  turn: "turn",
  task: "Map the gateway's conversation tools",
  status: "running",
  startedAt: 1_000,
  messages: [],
  steps: [],
  ...overrides,
});

test("a status payload is read field by field and a malformed one is refused", () => {
  assert.equal(readSubagentStatus({ toolUseId: "t", status: "exploding" }), null);
  assert.equal(readSubagentStatus({ status: "running" }), null);
  assert.equal(readSubagentStatus("nope"), null);
  assert.deepEqual(
    readSubagentStatus({ toolUseId: "t", status: "completed", background: true, subagentType: "Explore", usage: { totalTokens: 12000, toolUses: "7" }, endedAt: 9 }),
    { toolUseId: "t", state: "completed", background: true, subagentType: "Explore", endedAt: 9, usage: { totalTokens: 12000, toolUses: 0, durationMs: 0 } },
  );
  assert.equal(isBackgroundLaunchAck("  Async agent launched successfully. agentId: x"), true);
  assert.equal(isBackgroundLaunchAck("It is mapped in mesh.ts"), false);
});

test("an agent's status reads working with a live clock, or how and when it ended", () => {
  assert.deepEqual(laneStatus(lane(), 43_000), { text: "Working · 42s", tone: "working" });
  assert.deepEqual(laneStatus(lane({ status: "done", outcome: "ok", completedAt: 90_000 }), 0), { text: "Done in 1m 29s", tone: "quiet" });
  assert.deepEqual(laneStatus(lane({ status: "done", outcome: "error", completedAt: 10_000 }), 0), { text: "Failed after 9s", tone: "failed" });
  assert.deepEqual(laneStatus(lane({ status: "done", outcome: "stopped", completedAt: 181_000 }), 0), { text: "Stopped after 3m", tone: "quiet" });
  assert.deepEqual(laneStatus(lane({ status: "done", agent: { state: "unknown", background: true } }), 0), { text: "Ran in the background", tone: "quiet" });
  assert.equal(laneGlyphState(lane({ status: "done", agent: { state: "failed" } })), "failed");
  assert.equal(laneLabel({ subagentType: "Explore" }), "Explore agent");
  assert.equal(laneLabel({}), "Agent");
});

test("the line under an agent says what it is doing, why it failed, or the first line of its report", () => {
  assert.deepEqual(laneDetail(lane({ agent: { state: "running", lastToolName: "Grep" } })), { text: "Now: using Grep", error: false });
  assert.deepEqual(laneDetail(lane({ agent: { state: "running", progressSummary: "reading conversation-tools.ts" } })), { text: "Now: reading conversation-tools.ts", error: false });
  assert.deepEqual(laneDetail(lane({ status: "done", outcome: "error", agent: { state: "failed", error: "vitest exited with 1" } })), { text: "vitest exited with 1", error: true });
  assert.deepEqual(laneDetail(lane({ status: "done", outcome: "ok", report: "\n## **It is mapped in mesh.ts**\nMore" })), { text: "It is mapped in mesh.ts", error: false });
  assert.equal(reportPreview("- first point"), "first point");
});

test("an agent's words sit before the first step it started after, and its last words are not said twice", () => {
  const steps = [
    { id: "s1", name: "Grep", startedAt: 20 },
    { id: "s2", name: "Read", startedAt: 40 },
  ];
  const messages = [
    { at: 10, text: "Starting with the tool table." },
    { at: 30, text: "Now the launch service." },
    { at: 50, text: "It is mapped in mesh.ts" },
  ];
  const running = placeAgentMessages(lane({ steps, messages }));
  assert.deepEqual(running.beforeSteps, [
    { text: "Starting with the tool table.", beforeToolUseId: "s1" },
    { text: "Now the launch service.", beforeToolUseId: "s2" },
  ]);
  assert.deepEqual(running.afterSteps, ["It is mapped in mesh.ts"]);
  const finished = placeAgentMessages(lane({ steps, messages, status: "done", report: "It is mapped in mesh.ts, createConversation…" }));
  assert.deepEqual(finished.afterSteps, [], "the report already says it");
});

test("the Agents screen lists the working first and the finished newest first, with totals", () => {
  const lanes = [
    lane({ id: "a", status: "done", agent: { state: "completed", usage: { totalTokens: 20000, toolUses: 4, durationMs: 0 } } }),
    lane({ id: "b", agent: { state: "running", usage: { totalTokens: 12000, toolUses: 7, durationMs: 0 } } }),
    lane({ id: "c", status: "done", agent: { state: "failed", usage: { totalTokens: 13000, toolUses: 1, durationMs: 0 } } }),
    lane({ id: "d" }),
  ];
  const summary = summarizeAgents(lanes);
  assert.deepEqual(summary.working.map((item) => item.id), ["b", "d"]);
  assert.deepEqual(summary.finished.map((item) => item.id), ["c", "a"]);
  assert.equal(summary.footer, "2 working · 2 finished · 45k tokens");
  assert.equal(summarizeAgents([]).footer, "");
  assert.equal(workingLabel(lanes), "2 agents working");
  assert.equal(workingLabel([lanes[1]]), "1 agent working");
  assert.equal(workingLabel([lanes[0]]), "Working");
});

test("durations and clocks read the way the desktop reads them", () => {
  assert.equal(formatDuration(300), "0.3s");
  assert.equal(formatDuration(119_700), "2m");
  assert.equal(formatDuration(134_000), "2m 14s");
  assert.equal(formatElapsed(252_000), "4m 12s");
  assert.equal(formatElapsed(-5), "0s");
  assert.equal(agentTypeDescription("Explore", {}), "A read-only helper that searches the code and reports back.");
  assert.equal(agentTypeDescription("Custom", { Custom: "Checks things. Then more." }), "Checks things.");
  assert.equal(agentTypeDescription(undefined, {}), undefined);
});

test("an agent's own Stop is offered only for one running, where the desktop and the chat's CLI can stop it", () => {
  const can = { stopsAgents: true, chatCanStop: true, live: true, stopping: false };
  assert.deepEqual(agentStopOffer(lane(), can), { label: "Stop this agent", disabled: false });
  assert.equal(agentStopOffer(lane({ status: "done" }), can), null, "an ended agent has nothing to stop");
  assert.equal(agentStopOffer(lane(), { ...can, stopsAgents: false }), null, "an older desktop, or a pairing that only follows");
  assert.equal(agentStopOffer(lane(), { ...can, chatCanStop: false }), null, "a CLI that cannot stop one agent");
  assert.deepEqual(agentStopOffer(lane(), { ...can, live: false }), { label: "Stop this agent", disabled: true });
  assert.deepEqual(agentStopOffer(lane(), { ...can, stopping: true }), { label: "Stopping…", disabled: true });
});
