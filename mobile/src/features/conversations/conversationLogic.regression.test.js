const assert = require("node:assert/strict");
const { test } = require("node:test");
const { projectConversation, keepUnchangedRows, mergeConversationEvents, parseConversationLink, parseChatLink, parseAppLink, conversationEnabled, conversationCanOperate, modelControl, modelLabel, compactionLabel, turnMetaParts, planTitle, planBody, describeToolGroup, toolStep, cliModelLabel, permissionLabel, permissionChoices, retryLabel, turnChangesLabel, turnFoldLabel, composerActionKind, SEND_SETTLE_MS, reasoningPreview, rowStreaming } = require("../../../.mobile-test-build/src/features/conversations/conversationLogic.js");

// A turn's steps rest inside its fold; these tests read the groups as the fold
// holds them, in place, as the fold draws them when it is opened.
const unfold = (rows) =>
  rows.flatMap((row) =>
    row.kind === "fold"
      ? row.parts.map((part) =>
          part.kind === "tools"
            ? { kind: "tools", id: part.id, tools: part.tools }
            : part.kind === "reasoning"
              ? { kind: "reasoning", id: part.id, text: part.text }
              : { kind: "message", role: "assistant", id: part.id, text: part.text },
        )
      : [row],
  );
function event(seq, type, payload) { return { id: `event-${seq}`, seq, sessionId: "session", workspaceId: "workspace", agentId: "agent", createdAt: seq, type, payload }; }
test("sequence replay merges old pages without duplicates", () => {
  const existing = [event(3, "user_message", { text: "third" })];
  const merged = mergeConversationEvents(existing, [event(1, "user_message", { text: "first" }), event(3, "user_message", { text: "third" })]);
  assert.deepEqual(merged.map((item) => item.seq), [1, 3]);
  assert.equal(mergeConversationEvents(merged, [existing[0]]), merged);
});
test("prose divides collapsed work groups and acknowledgements use exact command ids", () => {
  const value = projectConversation([
    event(1, "user_message", { text: "inspect", commandId: "uuid-send", turnId: "turn" }),
    event(2, "turn_started", { turnId: "turn" }),
    event(3, "tool_started", { toolUseId: "read", name: "Read", input: { path: "a.ts" } }),
    event(4, "tool_output", { toolUseId: "read", output: "hello" }),
    event(5, "content_delta", { turnId: "turn", text: "Now check it." }),
    event(6, "tool_started", { toolUseId: "test", name: "Bash", input: { command: "npm test" } }),
  ]);
  const rows = unfold(value.rows);
  assert.deepEqual(rows.map((row) => row.kind), ["message", "tools", "message", "tools"]);
  assert.equal(rows[1].tools[0].status, "ok");
  assert.equal(rows[3].tools[0].status, "running");
  assert.equal(value.acknowledged.has("uuid-send"), true);
  assert.equal(value.acknowledged.has("different-uuid"), false);
  assert.equal(value.busy, true);
});
test("multiple pending requests retain their order and resolve independently", () => {
  const events = [event(1, "turn_started", { turnId: "turn" }), ...["a", "b", "c"].map((id, index) => event(index + 2, "approval_requested", { requestId: id, kind: "tool" }))];
  assert.deepEqual(projectConversation(events).pending.map((item) => item.id), ["a", "b", "c"]);
  events.push(event(5, "approval_resolved", { requestId: "b" }));
  assert.deepEqual(projectConversation(events).pending.map((item) => item.id), ["a", "c"]);
  events.push(event(6, "turn_failed", { message: "Interrupted" }));
  assert.equal(projectConversation(events).pending.length, 0);
  assert.equal(projectConversation(events).busy, false);
});
test("the conversation capability and the operate grant are separate", () => {
  const paired = { tailnetCapabilities: ["conversations"], tailnetScopes: ["conversation:read"] };
  assert.equal(conversationEnabled(paired), true);
  assert.equal(conversationCanOperate(paired), false);
  assert.equal(conversationEnabled({ ...paired, tailnetCapabilities: ["conversation-models"] }), false);
  assert.equal(conversationCanOperate({ ...paired, tailnetScopes: ["conversation:operate"] }), true);
  assert.equal(conversationEnabled({ ...paired, status: "revoked" }), false);
  // The desktop refuses the socket to a grant without conversation:read; a
  // phone that dialled anyway read the bare close as a dropped link forever.
  assert.equal(conversationEnabled({ ...paired, tailnetScopes: ["workspace:read", "backlog:read"] }), false);
  assert.equal(conversationEnabled({ ...paired, tailnetScopes: ["conversation:operate"] }), true);
});
test("deep links contain only paired desktop and conversation identifiers", () => {
  assert.deepEqual(parseConversationLink("sprintengine://conversation/device/workspace/agent"), { deviceId: "device", workspaceId: "workspace", agentId: "agent" });
  for (const url of ["https://example.com/conversation/a/b/c", "sprintengine://conversation/a/b", "sprintengine://conversation/a/b/%00", "sprintengine://user:secret@conversation/a/b/c"]) assert.equal(parseConversationLink(url), null);
});

// The desktop's chat link (`sprintengine://chat/<workspaceId>[?agent=<agentId>]`),
// read with the desktop's own strictness: these cases are its suite's.
const chatLink = (workspaceId, agentId = null) => ({ workspaceId, agentId });
test("a desktop's chat link names its workspace, and its agent when it has one", () => {
  assert.deepEqual(parseChatLink("sprintengine://chat/V1StGXR8_Z5jdHi6B-myT"), chatLink("V1StGXR8_Z5jdHi6B-myT"));
  assert.deepEqual(parseChatLink("sprintengine://chat/ws-1?agent=agent-claude-0a1b2c3d4e5f6g7h"), chatLink("ws-1", "agent-claude-0a1b2c3d4e5f6g7h"));
  // Scheme and host in any case, the ids exactly as written; the trailing slash a browser adds.
  assert.deepEqual(parseChatLink("SprintEngine://CHAT/AbC"), chatLink("AbC"));
  assert.deepEqual(parseChatLink("sprintengine://chat/ws-1/"), chatLink("ws-1"));
  assert.deepEqual(parseChatLink("sprintengine://chat/ws-1/?agent=a1"), chatLink("ws-1", "a1"));
});
test("a chat link's other parameters and fragment are ignored, and a bad agent is dropped", () => {
  assert.deepEqual(parseChatLink("sprintengine://chat/ws-1?prompt=rm%20-rf%20~&send=1&agent=a1#top"), chatLink("ws-1", "a1"));
  for (const url of [
    "sprintengine://chat/ws-1?agent=../../etc",
    "sprintengine://chat/ws-1?agent=",
    "sprintengine://chat/ws-1?agent",
    "sprintengine://chat/ws-1?agent=a1&agent=a2",
    "sprintengine://chat/ws-1?agent=a%20b",
    "sprintengine://chat/ws-1?agent=a+b",
    "sprintengine://chat/ws-1?agent=%E0%A4%A",
  ])
    assert.deepEqual(parseChatLink(url), chatLink("ws-1"), url);
  // A key spelled with an escape is the same key, as URLSearchParams reads it.
  assert.deepEqual(parseChatLink("sprintengine://chat/ws-1?ag%65nt=a1"), chatLink("ws-1", "a1"));
});
test("a chat link refuses any other host, path, scheme, authority or id", () => {
  for (const url of [
    "sprintengine://new?project=/Users/dev/app&prompt=hello",
    "sprintengine://chat",
    "sprintengine://chat/",
    "sprintengine://chat/ws-1/agent-1",
    "sprintengine://chats/ws-1",
    "sprintengine:chat/ws-1",
    "sprintengine:///chat/ws-1",
    "sprintengine://auth/callback?code=abc",
    "sprintengine://verify/chat/ws-1",
    "https://chat/ws-1",
    "javascript://chat/ws-1",
    "sprintengine2://chat/ws-1",
    "sprintengine-tailnet://chat/ws-1",
    "sprintengine://evil@chat/ws-1",
    "sprintengine://user:pass@chat/ws-1",
    "sprintengine://chat:80/ws-1",
    "sprintengine://chat.example.com/ws-1",
    "sprintengine://chat/..",
    "sprintengine://chat/../../etc/passwd",
    "sprintengine://chat/ws-1/../ws-2",
    "sprintengine://chat/%2e%2e",
    "sprintengine://chat/ws%2F1",
    "sprintengine://chat/ws-1;rm",
    "sprintengine://chat/$(id)",
    "sprintengine://chat/ws\"1",
    "sprintengine://chat/ws.1",
    "sprintengine://chat/ws\\1",
    `sprintengine://chat/${"a".repeat(129)}`,
    " sprintengine://chat/ws-1",
    "sprintengine://chat/ws-1 ",
    "sprintengine://chat/ws 1",
    "sprintengine://chat/ws-1\n--inspect",
    "sprintengine://chat/ws-1\u0000",
    "sprintengine://chat/ws-1\u007f",
    `sprintengine://chat/ws-1?pad=${"x".repeat(2048)}`,
    "",
  ])
    assert.equal(parseChatLink(url), null, JSON.stringify(url));
  for (const raw of [undefined, null, 42, {}, ["sprintengine://chat/ws-1"]]) assert.equal(parseChatLink(raw), null);
});
test("an app link is a conversation on a named desktop, or a desktop's chat link", () => {
  assert.deepEqual(parseAppLink("sprintengine://conversation/device/workspace/agent"), {
    kind: "conversation",
    link: { deviceId: "device", workspaceId: "workspace", agentId: "agent" },
  });
  assert.deepEqual(parseAppLink("sprintengine://chat/ws-1?agent=a1"), { kind: "chat", link: chatLink("ws-1", "a1") });
  assert.equal(parseAppLink("sprintengine://verify/notices"), null);
  assert.equal(parseAppLink("sprintengine-tailnet://pair?code=x"), null);
});

test("canonical tool kinds and final statuses survive wire projection", () => {
  const rows = projectConversation([
    event(1, "turn_started", { turnId: "turn" }),
    event(2, "tool_started", { toolUseId: "custom", name: "read_workspace", kind: "file_read", input: { path: "src/app.ts" } }),
    event(3, "tool_output", { toolUseId: "custom", status: "declined", preview: "Permission declined" }),
    event(4, "tool_started", { toolUseId: "custom", name: "read_workspace", kind: "file_read" }),
    event(5, "tool_started", { toolUseId: "shell", tool: "Bash", kind: "command" }),
    event(6, "tool_output", { toolUseId: "shell", status: "error", preview: "Failed", exitCode: 1 }),
  ]).rows.flatMap((row) => unfold([row]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tools.length, 2);
  assert.equal(rows[0].tools[0].kind, "file_read");
  assert.equal(rows[0].tools[0].status, "declined");
  assert.deepEqual(rows[0].tools[0].input, { path: "src/app.ts" });
  assert.equal(rows[0].tools[0].output, "Permission declined");
  assert.equal(rows[0].tools[1].name, "Bash");
  assert.equal(rows[0].tools[1].status, "error");
  assert.equal(rows[0].tools[1].exitCode, 1);
});

test("session close clears pending work and stops unfinished tool rows", () => {
  const value = projectConversation([
    event(1, "turn_started", { turnId: "turn" }),
    event(2, "tool_started", { toolUseId: "read", name: "Read" }),
    event(3, "approval_requested", { requestId: "request" }),
    event(4, "session_closed"),
  ]);
  assert.equal(value.busy, false);
  assert.deepEqual(value.pending, []);
  assert.equal(unfold(value.rows)[0].tools[0].status, "stopped");
});

test("tool-only turns remain separate groups and output updates are linear keyed lookups", () => {
  const value = projectConversation([
    event(1, "turn_started", { turnId: "first" }),
    event(2, "tool_started", { toolUseId: "one", name: "Read" }),
    event(3, "turn_completed", { turnId: "first" }),
    event(4, "turn_started", { turnId: "second" }),
    event(5, "tool_started", { toolUseId: "two", name: "Read" }),
    event(6, "tool_output", { toolUseId: "two", status: "stopped" }),
  ]);
  // The first turn's footer sits between them.
  const rows = unfold(value.rows);
  const groups = rows.filter((row) => row.kind === "tools");
  assert.deepEqual(value.rows.map((row) => row.kind), ["fold", "meta", "fold"]);
  assert.deepEqual(rows.map((row) => row.kind), ["tools", "meta", "tools"]);
  assert.equal(groups[0].tools[0].status, "running", "a background tool may finish after the turn result");
  assert.equal(groups[1].tools[0].status, "stopped");
});

test("automatic grants are not human requests and a published user send acquires busy immediately", () => {
  const value = projectConversation([
    event(1, "user_message", { turnId: "turn", text: "hello" }),
    event(2, "approval_requested", { requestId: "auto", autoApproved: true }),
    event(3, "approval_requested", { requestId: "human" }),
    event(4, "approval_resolved", { requestId: "auto", autoApproved: true }),
  ]);
  assert.equal(value.busy, true);
  assert.deepEqual(value.pending.map((item) => item.id), ["human"]);
});

test("the model control names the current model and offers the CLI's catalog only where it may be used", () => {
  const session = { tailnetCapabilities: ["conversations", "conversation-models"], tailnetScopes: ["conversation:operate"] };
  const models = { cli: "claude-code", cliLabel: "Claude Code", liveModelSwitch: true, options: [{ id: "model-a", label: "Model A" }, { id: "model-b" }] };
  const chat = { workspaceId: "w", agentId: "a", modelId: "model-a", models };
  const control = modelControl(session, chat);
  assert.equal(control.label, "Model A");
  assert.equal(control.editable, true);
  assert.deepEqual(control.choices.map((choice) => [choice.id, choice.label, choice.current]), [
    ["default", "Claude Code default", false],
    ["model-a", "Model A", true],
    ["model-b", "model-b", false],
  ]);
  assert.equal(modelLabel({ ...chat, modelId: "default" }), "Claude Code default");
  assert.equal(modelLabel({ ...chat, modelId: "unlisted-model" }), "unlisted-model");
  // Hidden: an undeclared or older desktop, no catalog, or a read-only pairing.
  assert.equal(modelControl({ ...session, tailnetCapabilities: ["conversations"] }, chat), null);
  assert.equal(modelControl({ ...session, tailnetCapabilities: undefined }, chat), null);
  assert.equal(modelControl(session, { ...chat, models: undefined }), null);
  assert.equal(modelControl({ ...session, tailnetScopes: ["conversation:read"] }, chat), null);
  // A provider that cannot switch mid-chat shows its model read-only: the
  // desktop refuses a switch for it.
  const fixed = { ...chat, models: { ...models, liveModelSwitch: false } };
  assert.equal(modelControl(session, fixed).editable, false);
});

const agentEvent = (seq, type, payload, extra = {}) => ({ ...event(seq, type, payload), ...extra });
test("an agent is a lane of its own, its steps nest under it, and the main groups keep only the turn's own steps", () => {
  const value = projectConversation([
    event(1, "user_message", { text: "look", turnId: "turn" }),
    event(2, "turn_started", { turnId: "turn" }),
    event(3, "tool_started", { turnId: "turn", toolUseId: "read", name: "Read", input: { path: "a.ts" } }),
    event(4, "tool_started", { turnId: "turn", toolUseId: "task", name: "Task", subagentLane: true, subagentType: "Explore", input: { description: "Map the tools" } }),
    event(5, "subagent_status", { toolUseId: "task", status: "running", background: true, progressSummary: "Reading tools.ts" }),
    event(6, "tool_started", { turnId: "turn", toolUseId: "child", name: "Grep", parentToolUseId: "task", input: { pattern: "create" } }),
    event(7, "tool_started", { turnId: "turn", toolUseId: "after", name: "Read", input: { path: "b.ts" } }),
  ]);
  // The turn's own steps rest in its fold; the agent is a card outside it.
  assert.deepEqual(value.rows.map((row) => row.kind), ["message", "fold", "agent"]);
  assert.deepEqual(value.rows[1].parts.map((part) => part.tools.map((tool) => tool.id)), [["read"], ["after"]]);
  assert.equal(value.rows[1].parts.flatMap((part) => part.tools).some((tool) => tool.id === "child"), false, "an agent's step never joins the turn's groups");
  const lane = value.rows[2].lane;
  assert.equal(lane.subagentType, "Explore");
  assert.equal(lane.task, "Map the tools");
  assert.deepEqual(lane.steps.map((step) => step.id), ["child"]);
  assert.equal(lane.agent.progressSummary, "Reading tools.ts");
  assert.equal(value.lanes.length, 1);
});

test("a background agent hides its launch notice, keeps the chat working after its turn, and its result becomes the report", () => {
  const events = [
    event(1, "user_message", { text: "go", turnId: "turn" }),
    event(2, "turn_started", { turnId: "turn" }),
    event(3, "tool_started", { turnId: "turn", toolUseId: "task", name: "Agent", subagentLane: true, input: { description: "Survey" } }),
    event(4, "subagent_status", { toolUseId: "task", status: "running", background: true }),
    event(5, "tool_output", { turnId: "turn", toolUseId: "task", output: "Async agent launched successfully. agentId: x" }),
    event(6, "turn_completed", { turnId: "turn" }),
  ];
  let value = projectConversation(events);
  const lane = value.lanes[0];
  assert.equal(lane.status, "running");
  assert.equal(lane.report, undefined, "the launch notice is for the model");
  assert.equal(value.turnBusy, false);
  assert.equal(value.busy, true, "a background agent keeps the chat working");
  assert.equal(value.workingSince, 3);
  events.push(
    event(7, "subagent_message", { parentToolUseId: "task", text: "Found it." }),
    event(8, "tool_output", { toolUseId: "task", output: "It is mapped in mesh.ts", backgroundResult: true, status: "ok" }),
    event(9, "subagent_status", { toolUseId: "task", status: "completed", usage: { totalTokens: 12000, toolUses: 7, durationMs: 89000 } }),
  );
  value = projectConversation(events);
  assert.equal(value.busy, false);
  assert.equal(value.lanes[0].status, "done");
  assert.equal(value.lanes[0].outcome, "ok");
  assert.equal(value.lanes[0].report, "It is mapped in mesh.ts");
  assert.deepEqual(value.lanes[0].messages.map((message) => message.text), ["Found it."]);
  assert.equal(value.lanes[0].agent.usage.toolUses, 7);
});

test("reports, words and steps that arrive before their lane are kept for it", () => {
  const value = projectConversation([
    event(1, "turn_started", { turnId: "turn" }),
    event(2, "subagent_message", { parentToolUseId: "task", text: "Starting." }),
    event(3, "subagent_status", { toolUseId: "task", status: "failed", error: "vitest exited with 1" }),
    event(4, "tool_started", { turnId: "turn", toolUseId: "early", name: "Bash", parentToolUseId: "task" }),
    event(5, "tool_started", { turnId: "turn", toolUseId: "task", name: "Task", input: { description: "Run the tests" } }),
  ]);
  const lane = value.lanes[0];
  assert.deepEqual(lane.messages.map((message) => message.text), ["Starting."]);
  assert.equal(lane.status, "done");
  assert.equal(lane.outcome, "error");
  assert.equal(lane.agent.error, "vitest exited with 1");
  assert.deepEqual(lane.steps.map((step) => step.id), ["early"]);
  assert.deepEqual(value.rows.map((row) => row.kind), ["agent"], "the emptied group leaves no row behind");
});

test("a late progress report does not reopen a finished agent, and a failed turn stops only foreground agents", () => {
  const value = projectConversation([
    event(1, "turn_started", { turnId: "turn" }),
    event(2, "tool_started", { turnId: "turn", toolUseId: "fore", name: "Task" }),
    event(3, "tool_started", { turnId: "turn", toolUseId: "back", name: "Task" }),
    event(4, "subagent_status", { toolUseId: "back", status: "running", background: true }),
    event(5, "tool_started", { turnId: "turn", toolUseId: "done", name: "Task" }),
    event(6, "subagent_status", { toolUseId: "done", status: "completed" }),
    event(7, "subagent_status", { toolUseId: "done", status: "running", lastToolName: "Read" }),
    event(8, "turn_failed", { turnId: "turn", message: "Interrupted" }),
  ]);
  const byId = Object.fromEntries(value.lanes.map((lane) => [lane.id, lane]));
  assert.equal(byId.done.status, "done");
  assert.equal(byId.done.agent.state, "completed");
  assert.equal(byId.fore.status, "done");
  assert.equal(byId.fore.outcome, "stopped");
  assert.equal(byId.back.status, "running");
  assert.equal(value.busy, true);
  const closed = projectConversation([
    event(1, "turn_started", { turnId: "turn" }),
    event(2, "tool_started", { turnId: "turn", toolUseId: "back", name: "Task" }),
    event(3, "subagent_status", { toolUseId: "back", status: "running", background: true }),
    event(4, "session_closed", {}),
  ]);
  assert.equal(closed.lanes[0].status, "done", "a closed session has no agents left");
  assert.equal(closed.busy, false);
});

test("compaction, command output, turn meta and plans are rows in the order they happened", () => {
  const value = projectConversation([
    event(1, "user_message", { text: "go", turnId: "turn" }),
    agentEvent(2, "turn_started", { turnId: "turn" }, { modelId: "claude-opus-5-5-20260901" }),
    event(3, "context_compacted", { turnId: "turn", trigger: "auto", preTokens: 182000, postTokens: 24000 }),
    event(4, "command_output", { turnId: "turn", command: "context", output: "## Context" }),
    event(5, "approval_requested", { turnId: "turn", requestId: "plan", kind: "plan", plan: "# Pair by link\n\nSteps" }),
    event(6, "approval_resolved", { requestId: "plan", approved: true }),
    event(7, "content_delta", { turnId: "turn", text: "Done." }),
    event(8, "turn_completed", { turnId: "turn", durationMs: 134000 }),
  ]);
  assert.deepEqual(value.rows.map((row) => row.kind), ["message", "compaction", "command", "plan", "message", "meta"]);
  assert.equal(compactionLabel(value.rows[1]), "Context compacted · automatically · 182k → 24k");
  assert.equal(value.rows[2].command, "context");
  assert.equal(value.rows[3].status, "approved");
  assert.equal(value.plans.plan.plan, "# Pair by link\n\nSteps");
  assert.deepEqual(turnMetaParts(value.rows[5]), ["claude-opus-5-5", "2m 14s"]);
  const thread = { models: { cli: "claude-code", cliLabel: "Claude Code", liveModelSwitch: true, options: [{ id: "claude-opus-5-5-20260901", label: "Opus 5.5" }] } };
  assert.deepEqual(turnMetaParts(value.rows[5], thread), ["Opus 5.5", "2m 14s"]);
  assert.equal(planTitle("# Pair by link\n\nSteps"), "Pair by link");
  assert.equal(planBody("# Pair by link\n\nSteps"), "Steps");
});

test("an unanswered plan is cancelled with its turn, and the prompt cache folds from usage reports", () => {
  const value = projectConversation([
    event(1, "turn_started", { turnId: "turn" }),
    event(2, "approval_requested", { requestId: "plan", kind: "plan", plan: "Plan" }),
    event(3, "usage_updated", { turnId: "turn", promptCache: { ttl: "5m", cached: true, recacheTokens: 412000 } }),
    event(4, "turn_failed", { turnId: "turn" }),
  ]);
  assert.equal(value.rows[0].status, "cancelled");
  assert.deepEqual(value.promptCache, { ttl: "5m", expiresAt: 3 + 300000, recacheTokens: 412000 });
});

test("a settled group says what it did and how much of it went wrong", () => {
  const tools = [
    { id: "1", name: "Read", status: "ok", input: { path: "src/a.ts" } },
    { id: "2", name: "Read", status: "ok", input: { path: "src/b.ts" } },
    { id: "3", name: "Grep", status: "ok", input: { pattern: "x" } },
    { id: "4", name: "Bash", status: "ok", exitCode: 1, input: { command: "npm test" } },
    { id: "5", name: "Edit", status: "error", input: { path: "src/c.ts" } },
  ];
  const group = describeToolGroup(tools);
  assert.equal(group.kind, "file_read");
  assert.equal(group.head, "Read 2 files");
  assert.deepEqual(group.rest, ["1 search", "ran 1 command"]);
  assert.equal(group.failed, 2, "a non-zero exit and an error both count");
  assert.deepEqual(
    describeToolGroup([{ id: "e", name: "Edit", status: "ok" }, { id: "f", name: "Edit", status: "ok" }, { id: "g", name: "Bash", status: "ok" }]),
    { kind: "file_edit", head: "Edited 2 files", rest: ["ran 1 command"], failed: 0 },
  );
  const step = toolStep({ id: "r", name: "Read", status: "running", input: { path: "src/tools/conversation-tools.ts" } });
  assert.deepEqual(step, { kind: "file_read", label: "Reading", detail: "conversation-tools.ts", end: "", failed: false, live: true });
  assert.equal(toolStep(tools[3]).end, "exit 1");
  assert.equal(toolStep({ id: "s", name: "Grep", status: "ok", input: { pattern: "conversation.create" } }).detail, "conversation.create");
});

test("the header names the CLI and model, and the permission chip names the preset", () => {
  const models = { cli: "claude-code", cliLabel: "Claude Code", liveModelSwitch: true, options: [{ id: "opus", label: "Opus 5.5" }] };
  assert.equal(cliModelLabel({ modelId: "opus", models }), "Claude Code · Opus 5.5");
  assert.equal(cliModelLabel({ modelId: "default", models }), "Claude Code · default model");
  assert.equal(cliModelLabel({ modelId: "default" }), "");
  assert.equal(permissionLabel("bypass"), "Bypass");
  assert.equal(permissionLabel("none"), "No flag");
  assert.equal(permissionLabel("manual"), "Manual");
  assert.equal(permissionLabel("auto"), "Auto");
});

test("a chat's permission menu offers what its desktop and provider run, and always the chat's own preset", () => {
  const ids = (session, thread) => permissionChoices(session, thread).map((choice) => choice.id);
  const older = { tailnetCapabilities: ["conversations"] };
  const current = { tailnetCapabilities: ["conversations", "conversation-permission-modes"] };
  assert.deepEqual(ids(older, { permissionPreset: "none" }), ["bypass", "none"]);
  assert.deepEqual(ids(current, { permissionPreset: "auto" }), ["manual", "auto", "bypass", "none"]);
  assert.deepEqual(
    ids(current, { permissionPreset: "none", capabilities: { permissionPresets: ["none", "bypass"] } }),
    ["bypass", "none"],
    "a provider that runs two presets is offered two",
  );
  // A Cursor chat with no live session lists nothing; its CLI still decides.
  assert.deepEqual(ids(current, { providerId: "cursor-agent", permissionPreset: "auto" }), ["auto", "bypass", "none"]);
  assert.deepEqual(ids(current, { providerId: "claude-agent", permissionPreset: "auto" }), ["manual", "auto", "bypass", "none"]);
});

test("a finished turn's steps and in-between prose rest behind one line, and its reply stays as written", () => {
  const value = projectConversation([
    event(1, "user_message", { text: "fix the tests", turnId: "turn" }),
    { ...event(2, "turn_started", { turnId: "turn" }), createdAt: 1_000 },
    event(3, "content_delta", { turnId: "turn", text: "Let me look." }),
    event(4, "tool_started", { turnId: "turn", toolUseId: "read", name: "Read", input: { path: "a.ts" } }),
    event(5, "tool_output", { turnId: "turn", toolUseId: "read", output: "x" }),
    event(6, "content_delta", { turnId: "turn", text: "Now the tests." }),
    event(7, "tool_started", { turnId: "turn", toolUseId: "test", name: "Bash", input: { command: "npm test" } }),
    event(8, "tool_output", { turnId: "turn", toolUseId: "test", output: "1 failed", exitCode: 1, isError: true }),
    event(9, "tool_started", { turnId: "turn", toolUseId: "picture", name: "GenerateImage", input: { path: "out.png", prompt: "a chart" } }),
    event(10, "tool_output", { turnId: "turn", toolUseId: "picture", output: "ok" }),
    event(11, "content_delta", { turnId: "turn", text: "Fixed. Here it is: ![chart](out.png)" }),
    {
      ...event(12, "turn_completed", {
        turnId: "turn",
        checkpointAvailable: true,
        checkpointTurnSeq: 1,
        checkpointSummary: { files: 3, addedLines: 42, removedLines: 7 },
      }),
      createdAt: 135_000,
    },
  ]);
  assert.deepEqual(value.rows.map((row) => row.kind), ["message", "fold", "message", "meta", "diff"]);
  const fold = value.rows[1];
  // The generated picture is drawn under the line, not counted as a step.
  assert.equal(fold.label, "Worked for 2m 14s · 2 steps");
  assert.equal(fold.failed, 1, "a failure inside the fold still shows on it");
  assert.equal(fold.live, false);
  assert.deepEqual(fold.parts.map((part) => part.kind), ["prose", "tools", "prose", "tools"]);
  assert.match(value.rows[2].text, /^Fixed\./u, "the reply after the last step is not folded");
  assert.deepEqual(value.rows[4].changes, { files: 3, addedLines: 42, removedLines: 7 });
  assert.equal(value.rows[4].turnSeq, 1);
  assert.equal(turnChangesLabel(value.rows[4].changes), "3 files changed · +42 \u22127");
});

test("the running turn folds too, an agent stays a card, and a turn without steps has no fold", () => {
  const running = projectConversation([
    event(1, "user_message", { text: "go", turnId: "turn" }),
    event(2, "turn_started", { turnId: "turn" }),
    event(3, "tool_started", { turnId: "turn", toolUseId: "read", name: "Read" }),
    event(4, "tool_started", { turnId: "turn", toolUseId: "task", name: "Task", subagentLane: true, input: { description: "Map it" } }),
  ]);
  assert.deepEqual(running.rows.map((row) => row.kind), ["message", "fold", "agent"]);
  assert.equal(running.rows[1].label, "Working · 1 step");
  assert.equal(running.rows[1].live, true);
  const plain = projectConversation([
    event(1, "user_message", { text: "hi", turnId: "t" }),
    event(2, "turn_started", { turnId: "t" }),
    event(3, "content_delta", { turnId: "t", text: "Hello." }),
    event(4, "turn_completed", { turnId: "t" }),
  ]);
  assert.deepEqual(plain.rows.map((row) => row.kind), ["message", "message", "meta"]);
  assert.equal(turnFoldLabel({ status: "interrupted", durationMs: 4_000 }, 3), "You stopped after 4s · 3 steps");
  assert.equal(turnFoldLabel({ status: "failed" }, 1), "Failed · 1 step");
});

test("a turn's file counts come from the desktop's checkpoint, else from what its steps reported", () => {
  const unchanged = projectConversation([
    event(1, "turn_started", { turnId: "t" }),
    event(2, "turn_completed", { turnId: "t", checkpointAvailable: true, checkpointTurnSeq: 1, checkpointSummary: { files: 0, addedLines: 0, removedLines: 0 } }),
  ]);
  assert.equal(unchanged.rows.some((row) => row.kind === "diff"), false, "a checkpoint that changed nothing earns no row");
  const older = projectConversation([
    event(1, "user_message", { text: "go" }),
    event(2, "turn_started", { turnId: "t" }),
    event(3, "turn_completed", { turnId: "t", checkpointAvailable: true }),
  ]);
  assert.equal(older.rows.find((row) => row.kind === "diff").turnSeq, 1, "a desktop that sends no summary still opens the turn's files");
  const reported = projectConversation([
    event(1, "turn_started", { turnId: "t" }),
    event(2, "tool_started", { turnId: "t", toolUseId: "edit", name: "Edit" }),
    event(3, "tool_output", { turnId: "t", toolUseId: "edit", output: "ok", fileChanges: [{ path: "/Users/dev/app/a.ts", additions: 3, deletions: 1 }, { path: "/Users/dev/app/b.ts", additions: 2, deletions: 0 }] }),
    event(4, "tool_started", { turnId: "t", toolUseId: "edit-2", name: "Edit" }),
    event(5, "tool_output", { turnId: "t", toolUseId: "edit-2", output: "ok", fileChanges: [{ path: "/Users/dev/app/a.ts", additions: 1, deletions: 1 }] }),
    event(6, "turn_completed", { turnId: "t" }),
  ]);
  const diff = reported.rows.find((row) => row.kind === "diff");
  assert.deepEqual(diff.changes, { files: 2, addedLines: 6, removedLines: 2 });
  assert.equal("turnSeq" in diff, false, "without a checkpoint the counts are all there is");
});

test("a provider retrying a failed call says why until the turn reports anything else", () => {
  const events = [
    event(1, "user_message", { text: "go", turnId: "t" }),
    event(2, "turn_started", { turnId: "t" }),
    event(3, "turn_retrying", { turnId: "t", attempt: 3, maxAttempts: 10, retryInMs: 8000, error: "authentication_failed", status: 401 }),
  ];
  const waiting = projectConversation(events);
  assert.equal(retryLabel(waiting.retrying), "Couldn\u2019t authenticate · retrying (3 of 10)…");
  assert.equal(waiting.rows.some((row) => row.kind === "message" && row.role === "assistant"), false, "a retry notice is never a row");
  // An event without the turn's id says nothing about the call.
  events.push(event(4, "usage_updated", { promptCache: {} }));
  assert.ok(projectConversation(events).retrying);
  events.push(event(5, "content_delta", { turnId: "t", text: "Here." }));
  assert.equal(projectConversation(events).retrying, null);
  assert.equal(retryLabel({ attempt: 1, maxAttempts: 5 }), "Couldn\u2019t connect · retrying (1 of 5)…");
  assert.equal(retryLabel({ attempt: 2, maxAttempts: 5, status: 500 }), "Request failed (500) · retrying (2 of 5)…");
  const ended = projectConversation([...events.slice(0, 3), event(6, "turn_failed", { turnId: "t", message: "Gave up." })]);
  assert.equal(ended.retrying, null, "a turn that ended is not retrying");
});

test("a step's changed files count once, however often it is reported, and only once it finished", () => {
  const value = projectConversation([
    event(1, "turn_started", { turnId: "t" }),
    event(2, "tool_started", { turnId: "t", toolUseId: "edit", name: "Edit" }),
    // A step still running has changed nothing yet, as the desktop reads it.
    event(3, "tool_output", { turnId: "t", toolUseId: "edit", partial: true, fileChanges: [{ path: "/Users/dev/app/a.ts", additions: 3, deletions: 1 }, { path: "/Users/dev/app/c.ts", additions: 9, deletions: 0 }] }),
    event(4, "tool_output", { turnId: "t", toolUseId: "edit", output: "ok", fileChanges: [{ path: "/Users/dev/app/a.ts", additions: 3, deletions: 1 }] }),
    // The same finished step again, as a retransmission brings it.
    event(5, "tool_output", { turnId: "t", toolUseId: "edit", output: "ok", fileChanges: [{ path: "/Users/dev/app/a.ts", additions: 3, deletions: 1 }] }),
    event(6, "turn_completed", { turnId: "t" }),
  ]);
  assert.deepEqual(value.rows.find((row) => row.kind === "diff").changes, { files: 1, addedLines: 3, removedLines: 1 });
  const uncounted = projectConversation([
    event(1, "turn_started", { turnId: "t" }),
    event(2, "tool_output", { turnId: "t", toolUseId: "one", output: "ok", fileChanges: [{ path: "/Users/dev/app/a.ts", additions: 2, deletions: 0 }] }),
    event(3, "tool_output", { turnId: "t", toolUseId: "two", output: "ok", fileChanges: [{ path: "/Users/dev/app/a.ts" }] }),
    event(4, "turn_completed", { turnId: "t" }),
  ]);
  assert.deepEqual(uncounted.rows.find((row) => row.kind === "diff").changes, { files: 1 }, "a step that gave no lines leaves the turn's lines uncounted");
});

test("a retry notice ends with its turn, even when the stop names no turn", () => {
  const value = projectConversation([
    event(1, "user_message", { text: "go" }),
    event(2, "turn_started", { turnId: "t1" }),
    event(3, "turn_retrying", { turnId: "t1", attempt: 2, maxAttempts: 10, retryInMs: 1000, error: "rate_limit", status: 429 }),
    // Stop, as an interrupt can arrive: without the turn's id.
    event(4, "turn_failed", { reason: "interrupted" }),
    event(5, "user_message", { text: "again" }),
    event(6, "turn_started", { turnId: "t2" }),
  ]);
  assert.equal(value.busy, true);
  assert.equal(value.retrying, null, "the next turn is not said to be retrying the last one's call");
});

test("a turn whose only step made a picture has nothing to fold, as on the desktop", () => {
  const value = projectConversation([
    event(1, "turn_started", { turnId: "t" }),
    event(2, "tool_started", { turnId: "t", toolUseId: "img", name: "GenerateImage", input: { prompt: "a chart" } }),
    event(3, "tool_output", { turnId: "t", toolUseId: "img", output: "ok" }),
    event(4, "turn_completed", { turnId: "t" }),
  ]);
  assert.deepEqual(value.rows.map((row) => row.kind), ["tools", "meta"]);
  // A picture beside real work is folded with it and drawn under the line.
  const mixed = projectConversation([
    event(1, "turn_started", { turnId: "t" }),
    event(2, "tool_started", { turnId: "t", toolUseId: "read", name: "Read", input: { path: "a.ts" } }),
    event(3, "tool_started", { turnId: "t", toolUseId: "img", name: "GenerateImage", input: { prompt: "a chart" } }),
    event(4, "turn_completed", { turnId: "t" }),
  ]);
  assert.equal(mixed.rows[0].kind, "fold");
  assert.match(mixed.rows[0].label, /· 1 step$/u);
});

test("the composer's button turns to Stop only when no Send could have been meant", () => {
  const at = (overrides) =>
    composerActionKind({ hasText: false, stoppable: true, dictating: false, sending: false, justSent: false, ...overrides });
  assert.equal(at({}), "stop", "an empty box under a running reply stops it");
  assert.equal(at({ hasText: true }), "send");
  assert.equal(at({ stoppable: false }), "send");
  // The microphone's words lag the voice; the box can be empty mid-sentence.
  assert.equal(at({ dictating: true }), "send");
  // A send waiting on the microphone, or one that has just emptied the box:
  // a second tap of the same button must not break off the reply.
  assert.equal(at({ sending: true }), "send");
  assert.equal(at({ justSent: true }), "send");
  assert.ok(SEND_SETTLE_MS >= 1_000 && SEND_SETTLE_MS <= 3_000, "long enough for a second tap, short enough to stop a reply");
});

test("a streamed delta hands the list one new row and keeps every other as it was", () => {
  const events = [];
  for (let turn = 0; turn < 3; turn++) {
    const base = turn * 10;
    events.push(
      event(base + 1, "user_message", { text: `question ${turn}`, turnId: `t${turn}` }),
      event(base + 2, "turn_started", { turnId: `t${turn}` }),
      event(base + 3, "content_delta", { turnId: `t${turn}`, text: "Reading." }),
      event(base + 4, "tool_started", { turnId: `t${turn}`, toolUseId: `read${turn}`, name: "Read", input: { path: "a.ts" } }),
      event(base + 5, "tool_output", { turnId: `t${turn}`, toolUseId: `read${turn}`, output: "x" }),
      event(base + 6, "content_delta", { turnId: `t${turn}`, text: "Done." }),
    );
    if (turn < 2) events.push(event(base + 7, "turn_completed", { turnId: `t${turn}` }));
  }
  const before = projectConversation(events).rows;
  const after = keepUnchangedRows(before, projectConversation([...events, event(40, "content_delta", { turnId: "t2", text: " More." })]).rows);
  assert.deepEqual(after.map((row) => row.id), before.map((row) => row.id));
  const changed = after.filter((row, index) => row !== before[index]);
  assert.deepEqual(changed.map((row) => row.kind === "message" && row.text), ["Done. More."]);
  // Nothing moved: the same list, so the list itself is not handed anything new.
  assert.equal(keepUnchangedRows(after, projectConversation([...events, event(40, "content_delta", { turnId: "t2", text: " More." })]).rows), after);
  // A step finishing inside a fold changes the fold, and only it.
  const running = [...events.slice(0, -2), event(41, "content_delta", { turnId: "t2", text: "Checking." })];
  const first = projectConversation(running).rows;
  const settled = keepUnchangedRows(first, projectConversation([...running, event(42, "tool_output", { turnId: "t2", toolUseId: "read2", output: "x" })]).rows);
  assert.deepEqual(settled.filter((row, index) => row !== first[index]).map((row) => row.kind), ["fold"]);
});

test("an agent that takes another step keeps its earlier steps as they were drawn", () => {
  const { keepUnchanged } = require("../../../.mobile-test-build/src/features/conversations/keepUnchanged.js");
  const events = [
    event(1, "turn_started", { turnId: "t" }),
    event(2, "tool_started", { turnId: "t", toolUseId: "agent", name: "Task", subagentLane: true, input: { description: "Look around" } }),
    event(3, "tool_started", { turnId: "t", toolUseId: "s1", parentToolUseId: "agent", name: "Read", input: { path: "a.ts" } }),
    event(4, "tool_output", { turnId: "t", toolUseId: "s1", output: "x" }),
  ];
  const before = projectConversation(events).lanes;
  const after = keepUnchanged(before, projectConversation([...events, event(5, "tool_started", { turnId: "t", toolUseId: "s2", parentToolUseId: "agent", name: "Grep", input: { pattern: "cache" } })]).lanes, (lane) => lane.id);
  assert.notEqual(after[0], before[0], "the lane moved");
  assert.equal(after[0].steps.length, 2);
  assert.equal(after[0].steps[0], before[0].steps[0], "its first step is the object drawn before");
  assert.equal(after[0].messages, before[0].messages, "and what it said, unchanged, is too");
});

test("an event merged on its own lands where the full merge puts it", () => {
  // The merge as it was before its one-event path: sets, then a stable sort.
  const reference = (current, incoming) => {
    const ids = new Set(current.map((item) => item.id));
    const seqs = new Set(current.flatMap((item) => (item.seq === undefined ? [] : [item.seq])));
    const added = incoming.filter((item) => {
      if (ids.has(item.id) || (item.seq !== undefined && seqs.has(item.seq))) return false;
      ids.add(item.id);
      if (item.seq !== undefined) seqs.add(item.seq);
      return true;
    });
    return added.length ? [...current, ...added].sort((a, b) => (a.seq ?? a.createdAt) - (b.seq ?? b.createdAt)) : current;
  };
  const legacy = (id, createdAt) => ({ id, createdAt, type: "content_delta", payload: {} });
  const sorted = [event(1, "user_message", {}), event(2, "turn_started", {}), event(3, "content_delta", {})];
  const cases = [
    [[], event(1, "user_message", {})],
    [sorted, event(4, "content_delta", {})],
    [sorted, event(3, "content_delta", {})], // a resend of the newest
    [sorted, { ...event(9, "content_delta", {}), id: "event-2" }], // a known id under a new sequence
    [sorted, event(0, "content_delta", {})], // older than the log's end
    [[sorted[2], sorted[0], sorted[1]], event(4, "content_delta", {})], // a log out of order
    [[legacy("a", 5), legacy("b", 9)], legacy("c", 7)],
    [[legacy("a", 5), legacy("b", 9)], legacy("c", 9)],
    [[legacy("a", 5)], { ...legacy("b", 2), seq: 3 }],
  ];
  for (const [current, incoming] of cases) {
    const merged = mergeConversationEvents(current, [incoming]);
    assert.deepEqual(merged, reference(current, [incoming]));
    if (reference(current, [incoming]) === current) assert.equal(merged, current, "a known event leaves the log as it was");
  }
});

// ── Thinking ───────────────────────────────────────────────────────────────

test("reasoning becomes a row of its own, ahead of the reply it led to", () => {
  const value = projectConversation([
    event(1, "user_message", { text: "why?" }),
    event(2, "turn_started", { turnId: "t" }),
    event(3, "reasoning_delta", { turnId: "t", text: "Check the fixture first." }),
    event(4, "content_delta", { turnId: "t", text: "The fixture is stale." }),
    event(5, "turn_completed", { turnId: "t" }),
  ]);
  assert.deepEqual(value.rows.map((row) => row.kind), ["message", "reasoning", "message", "meta"]);
  const thought = value.rows[1];
  assert.equal(thought.text, "Check the fixture first.");
  assert.equal(thought.turn, "t");
  assert.equal(thought.live, false);
  assert.equal(rowStreaming(thought, null, false), false);
  assert.equal(value.rows[2].text, "The fixture is stale.", "the reply's words are untouched");
  assert.deepEqual(value.replies.map((reply) => reply.turn), ["t"]);
});

test("consecutive reasoning deltas merge into one row, across events that draw nothing", () => {
  const split = projectConversation([
    event(1, "turn_started", { turnId: "t" }),
    event(2, "reasoning_delta", { turnId: "t", text: "Read the" }),
    event(3, "usage_updated", { turnId: "t", contextUsed: 10 }),
    event(4, "reasoning_delta", { turnId: "t", delta: " plan" }),
    event(5, "reasoning_delta", { turnId: "t", text: ", then the tests." }),
  ]);
  const thoughts = split.rows.filter((row) => row.kind === "reasoning");
  assert.equal(thoughts.length, 1);
  assert.equal(thoughts[0].text, "Read the plan, then the tests.");
  // The cache keeps a run of deltas as one event; the row reads the same.
  const merged = projectConversation([
    event(1, "turn_started", { turnId: "t" }),
    event(5, "reasoning_delta", { turnId: "t", text: "Read the plan, then the tests." }),
  ]);
  assert.equal(merged.rows.find((row) => row.kind === "reasoning").text, thoughts[0].text);
});

test("thinking is live only while it is the last thing the running turn said", () => {
  const events = [
    event(1, "user_message", { text: "go" }),
    event(2, "turn_started", { turnId: "t" }),
    event(3, "reasoning_delta", { turnId: "t", text: "Hmm" }),
  ];
  const thinking = projectConversation(events).rows.find((row) => row.kind === "reasoning");
  assert.equal(thinking.live, true);
  assert.equal(rowStreaming(thinking, "t", true), true);
  events.push(event(4, "content_delta", { turnId: "t", text: "Done." }));
  assert.equal(projectConversation(events).rows.find((row) => row.kind === "reasoning").live, false, "words came after it");
  const stopped = [...events.slice(0, 3), event(4, "turn_failed", { turnId: "t", reason: "interrupted" })];
  assert.equal(projectConversation(stopped).rows.find((row) => row.kind === "reasoning").live, false, "the turn ended");
});

test("each stretch of thinking keeps its place among the turn's words and steps", () => {
  const value = projectConversation([
    event(1, "user_message", { text: "fix it" }),
    event(2, "turn_started", { turnId: "t" }),
    event(3, "reasoning_delta", { turnId: "t", text: "Look at the test." }),
    event(4, "tool_started", { turnId: "t", toolUseId: "a", name: "Read", input: { path: "a.ts" } }),
    event(5, "tool_output", { toolUseId: "a", output: "x" }),
    event(6, "reasoning_delta", { turnId: "t", text: "The fixture is stale." }),
    event(7, "content_delta", { turnId: "t", text: "Updating it." }),
    event(8, "tool_started", { turnId: "t", toolUseId: "b", name: "Edit", input: { path: "a.ts" } }),
    event(9, "tool_output", { toolUseId: "b", output: "ok" }),
    event(10, "reasoning_delta", { turnId: "t", text: "Now it passes." }),
    event(11, "content_delta", { turnId: "t", text: "Fixed." }),
    event(12, "turn_completed", { turnId: "t" }),
  ]);
  // Thinking before the last step folds with the work; the thinking after it
  // stays in view above the reply.
  assert.deepEqual(value.rows.map((row) => row.kind), ["message", "fold", "reasoning", "message", "meta"]);
  const fold = value.rows[1];
  assert.deepEqual(
    fold.parts.map((part) => [part.kind, part.kind === "tools" ? part.tools.map((tool) => tool.id).join() : part.text]),
    [
      ["reasoning", "Look at the test."],
      ["tools", "a"],
      ["reasoning", "The fixture is stale."],
      ["prose", "Updating it."],
      ["tools", "b"],
    ],
  );
  assert.match(fold.label, / · 2 steps$/, "a thought is not a step");
  assert.equal(value.rows[2].text, "Now it passes.");
  assert.equal(value.rows[3].text, "Fixed.");
});

test("thinking between steps splits their group, as the agent's words do", () => {
  const rows = unfold(
    projectConversation([
      event(1, "turn_started", { turnId: "t" }),
      event(2, "tool_started", { turnId: "t", toolUseId: "a", name: "Read", input: { path: "a.ts" } }),
      event(3, "reasoning_delta", { turnId: "t", text: "Next file." }),
      event(4, "tool_started", { turnId: "t", toolUseId: "b", name: "Read", input: { path: "b.ts" } }),
    ]).rows,
  );
  assert.deepEqual(rows.map((row) => row.kind), ["tools", "reasoning", "tools"]);
});

test("empty reasoning produces no row, and a stretch that opens blank starts at its words", () => {
  const blank = projectConversation([
    event(1, "turn_started", { turnId: "t" }),
    event(2, "reasoning_delta", { turnId: "t", text: "  \n\n" }),
    event(3, "reasoning_delta", { turnId: "t", text: "" }),
    event(4, "content_delta", { turnId: "t", text: "Hi." }),
  ]);
  assert.equal(blank.rows.some((row) => row.kind === "reasoning"), false);
  const opened = projectConversation([
    event(1, "turn_started", { turnId: "t" }),
    event(2, "reasoning_delta", { turnId: "t", text: "\n" }),
    event(3, "reasoning_delta", { turnId: "t", text: "\n  First thought" }),
    event(4, "reasoning_delta", { turnId: "t", text: "\n\nsecond line" }),
  ]);
  const thoughts = opened.rows.filter((row) => row.kind === "reasoning");
  assert.equal(thoughts.length, 1);
  assert.equal(thoughts[0].text, "First thought\n\nsecond line");
});

test("a thought arriving keeps every other row as it was drawn", () => {
  const events = [
    event(1, "user_message", { text: "go" }),
    event(2, "turn_started", { turnId: "t" }),
    event(3, "reasoning_delta", { turnId: "t", text: "One" }),
  ];
  const before = projectConversation(events).rows;
  events.push(event(4, "reasoning_delta", { turnId: "t", text: " two" }));
  const after = keepUnchangedRows(before, projectConversation(events).rows);
  assert.equal(after[0], before[0], "the person's message is the object it was");
  assert.notEqual(after[1], before[1]);
  assert.equal(after[1].text, "One two");
});

test("a closed thought previews its first line as plain words", () => {
  assert.equal(reasoningPreview("**Check** the `fixture`\nthen more"), "Check the fixture");
  assert.equal(reasoningPreview("\n\n## Plan\n- step"), "Plan");
  assert.equal(reasoningPreview("```ts\nconst a = 1;\n```"), "const a = 1;");
  assert.equal(reasoningPreview("- see [the docs](https://example.com)"), "see the docs");
  assert.equal(reasoningPreview("   "), "");
  const long = reasoningPreview("word ".repeat(2_000));
  assert.ok(long.length <= 160 && long.endsWith("…"), "a long first line is cut to what fits");
});
