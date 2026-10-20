const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  buildConversationCreateArgs,
  createConversation,
  findLaunchedThread,
  readConversationCreateAnswer,
  threadFromLaunch,
} = require("../../.mobile-test-build/src/api/conversationLaunch.js");

const launched = {
  workspaceId: "workspace-1",
  agentId: "agent-claude-code-abc123",
  name: "Juniper",
  cli: "claude-code",
  providerId: "claude-agent",
  modelId: "default",
  sessionId: "session-1",
};
const success = { jsonrpc: "2.0", id: "1", result: { structuredContent: { ok: true, conversation: launched } } };
const toolError = (code, message) => ({
  jsonrpc: "2.0",
  id: "1",
  result: { isError: true, structuredContent: { ok: false, error: { code, message } } },
});

test("the arguments carry only what was chosen, trimmed", () => {
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: " workspace-1 " }), { workspaceId: "workspace-1" });
  assert.deepEqual(
    buildConversationCreateArgs({
      workspaceId: "workspace-1",
      prompt: "  Tidy the toast store.  ",
      cli: "claude-code",
      cliModel: "opus",
      permissionPreset: "bypass",
    }),
    { workspaceId: "workspace-1", prompt: "Tidy the toast store.", cli: "claude-code", cliModel: "opus", permissionPreset: "bypass" },
  );
  assert.deepEqual(
    buildConversationCreateArgs({ workspaceId: "workspace-1", prompt: "   ", cli: "", cliModel: " ", permissionPreset: "none" }),
    { workspaceId: "workspace-1", permissionPreset: "none" },
  );
  // Manual and Auto are presets of their own on a desktop that runs them.
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "w", permissionPreset: "auto" }), { workspaceId: "w", permissionPreset: "auto" });
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "w", permissionPreset: "manual" }), { workspaceId: "w", permissionPreset: "manual" });
  // A preset the tool does not know is never sent; the desktop's own applies.
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "w", permissionPreset: "yolo" }), { workspaceId: "w" });
  // New asks for a chat of its own; the workspace only names the folder.
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "w", newChat: true }), { workspaceId: "w", newChat: true });
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "w", newChat: false }), { workspaceId: "w" });
});

test("a worktree rides only with a new chat, and an effort only when one was picked", () => {
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "w", newChat: true, worktree: true }), {
    workspaceId: "w",
    newChat: true,
    worktree: true,
  });
  // The desktop refuses a worktree for a chat joining a workspace: never sent alone.
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "w", worktree: true }), { workspaceId: "w" });
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "w", newChat: true, worktree: false }), { workspaceId: "w", newChat: true });
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "w", effort: " high " }), { workspaceId: "w", effort: "high" });
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "w", effort: "  " }), { workspaceId: "w" });
});

test("a launched chat is read from the tool's structured result", () => {
  assert.deepEqual(readConversationCreateAnswer(200, success, "mac-mini"), { ok: true, conversation: launched });
});

test("an older desktop without the tool reads as unsupported, and says to update Studio", () => {
  const unknownTool = { jsonrpc: "2.0", id: "1", error: { code: -32602, message: 'Unknown tool "conversation.create".' } };
  const expected = {
    ok: false,
    failure: "unsupported",
    title: "build-box cannot start chat agents yet.",
    message: "Update SprintEngine Studio there to start one from the phone.",
  };
  assert.deepEqual(readConversationCreateAnswer(200, unknownTool, "build-box"), expected);
  assert.deepEqual(readConversationCreateAnswer(200, { jsonrpc: "2.0", id: "1", error: { code: -32601, message: "Method not found" } }, "build-box"), expected);
  // An answer with no conversation in it is not the tool this phone called.
  assert.deepEqual(readConversationCreateAnswer(200, { jsonrpc: "2.0", id: "1", result: { content: [] } }, "build-box"), expected);
  assert.deepEqual(readConversationCreateAnswer(200, { jsonrpc: "2.0", id: "1", result: { structuredContent: { ok: true } } }, "build-box"), expected);
});

test("the desktop's refusals become plain sentences a person can act on", () => {
  const read = (code, message = "raw desktop words") => readConversationCreateAnswer(200, toolError(code, message), "mac-mini");
  assert.deepEqual(read("tailnet_scope_required"), {
    ok: false,
    failure: "refused",
    title: "This phone may not start chats on mac-mini.",
    message: "Pair again with chat control to start one here.",
  });
  assert.equal(read("unknown_workspace").title, "That project is no longer open on mac-mini.");
  assert.equal(read("workspace_folder_missing").title, "That project has no folder on mac-mini, so there is nowhere to start the chat.");
  assert.equal(read("no_cli_selected").message, "Pick one under Agent and model.");
  assert.equal(read("cli_not_conversational").title, "That CLI cannot run as a chat on mac-mini.");
  // Nothing was started, and the desktop's reason says which kind of folder
  // it was; New reads the code to offer starting without a worktree.
  assert.deepEqual(read("worktree_unavailable", "/srv/notes is not a git repository, so a worktree cannot be created. Start the chat without one."), {
    ok: false,
    failure: "refused",
    title: "mac-mini could not make a worktree for the chat.",
    message: "/srv/notes is not a git repository, so a worktree cannot be created. Start the chat without one.",
    code: "worktree_unavailable",
  });
  assert.equal(read("unsupported_effort").code, "unsupported_effort");
  assert.equal(read("unsupported_effort", "").message, "Pick another under Agent and model.");
  // Only the codes New acts on are carried.
  assert.equal("code" in read("unknown_workspace"), false);
  // A code this phone does not know keeps the desktop's own sentence.
  assert.deepEqual(read("session_start_failed", "The CLI exited before the session was up."), {
    ok: false,
    failure: "refused",
    title: "mac-mini could not start the chat.",
    message: "The CLI exited before the session was up.",
  });
  assert.equal(read("", "").message, undefined);
});

test("transport answers: unpaired, a bad status, a conversation with no identity", () => {
  assert.equal(readConversationCreateAnswer(401, null, "mac-mini").failure, "unpaired");
  // The desktop holds a token to the tailnet node it was paired from. A
  // moment when whois cannot place the phone is not an unpairing.
  assert.equal(
    readConversationCreateAnswer(401, { error: { code: "peer_unverified", message: "x" } }, "mac-mini").failure,
    "unavailable",
  );
  assert.match(
    readConversationCreateAnswer(401, { error: { code: "peer_mismatch", message: "x" } }, "mac-mini").title,
    /different Tailscale device/u,
  );
  assert.deepEqual(readConversationCreateAnswer(502, null, "mac-mini"), {
    ok: false,
    failure: "unavailable",
    title: "mac-mini could not start the chat.",
    message: "It answered 502.",
  });
  const nameless = { result: { structuredContent: { ok: true, conversation: { name: "Juniper" } } } };
  assert.equal(readConversationCreateAnswer(200, nameless, "mac-mini").title, "mac-mini started the chat but did not say which one it is.");
  // A JSON-RPC error that is not about the tool keeps its own words.
  assert.deepEqual(readConversationCreateAnswer(200, { error: { code: -32603, message: "Internal error: boom" } }, " "), {
    ok: false,
    failure: "refused",
    title: "The desktop could not start the chat.",
    message: "Internal error: boom",
  });
});

test("the call posts the tool over the gateway and never throws", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, json: async () => success };
  };
  const result = await createConversation(
    { baseUrl: "http://mac-mini:4100", deviceToken: "mctn_example", machineName: "mac-mini" },
    { workspaceId: "workspace-1", prompt: "Go", permissionPreset: "bypass" },
    { fetchImpl, requestId: "chat-1" },
  );
  assert.deepEqual(result, { ok: true, conversation: launched });
  assert.equal(calls[0].url, "http://mac-mini:4100/tailnet/v1/mcp");
  assert.equal(calls[0].init.headers.authorization, "Bearer mctn_example");
  assert.equal(calls[0].init.headers.origin, undefined, "the gateway refuses any Origin");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    jsonrpc: "2.0",
    id: "chat-1",
    method: "tools/call",
    params: { name: "conversation.create", arguments: { workspaceId: "workspace-1", prompt: "Go", permissionPreset: "bypass" } },
  });

  const offline = await createConversation(
    { baseUrl: "http://mac-mini:4100", deviceToken: "t", machineName: "mac-mini" },
    { workspaceId: "w" },
    { fetchImpl: async () => { throw new TypeError("Network request failed"); } },
  );
  assert.deepEqual(offline, { ok: false, failure: "unavailable", title: "mac-mini did not answer.", message: "Is Tailscale up on both devices?" });

  const slow = await createConversation(
    { baseUrl: "http://mac-mini:4100", deviceToken: "t", machineName: "mac-mini" },
    { workspaceId: "w" },
    {
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    },
  );
  assert.equal(slow.title, "mac-mini took too long to start the chat.");

  const garbled = await createConversation(
    { baseUrl: "http://mac-mini:4100", deviceToken: "t", machineName: "mac-mini" },
    { workspaceId: "w" },
    { fetchImpl: async () => ({ status: 200, json: async () => { throw new SyntaxError("bad json"); } }) },
  );
  assert.equal(garbled.failure, "unavailable");
});

test("the thread to open: the listed one when it is there, else what the tool said", () => {
  const listed = { ...threadFromLaunch(launched, { now: 1 }), title: "Listed", phase: "running", lastSeq: 3 };
  assert.equal(findLaunchedThread([listed], launched), listed);
  assert.equal(findLaunchedThread([{ ...listed, agentId: "other" }], launched), null);
  assert.deepEqual(threadFromLaunch(launched, { now: 1_790_000_000_000, permissionPreset: "bypass" }), {
    workspaceId: "workspace-1",
    agentId: "agent-claude-code-abc123",
    sessionId: "session-1",
    title: "Juniper",
    phase: "starting",
    updatedAt: 1_790_000_000_000,
    createdAt: 1_790_000_000_000,
    providerId: "claude-agent",
    modelId: "default",
    turnCount: 0,
    lastSeq: 0,
    permissionPreset: "bypass",
  });
  const bare = threadFromLaunch({ ...launched, name: "", sessionId: "" }, { now: 5 });
  assert.equal(bare.title, "Chat");
  assert.equal("sessionId" in bare, false);
  assert.equal("permissionPreset" in bare, false);
});

test("a first message with paragraph separators starts the chat with plain line breaks", () => {
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "workspace-1", prompt: " Plan it.\u2029Then build it.\r\n" }), {
    workspaceId: "workspace-1",
    prompt: "Plan it.\nThen build it.",
  });
});
