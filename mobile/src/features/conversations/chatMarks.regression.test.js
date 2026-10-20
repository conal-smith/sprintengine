/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// What a chat wears beside its title, from what the desktop lists: the
// machine it runs on (`host`) and its pull requests. Every field is optional on
// the wire, and a desktop that sends none must leave the chat exactly as it
// was: no mark, and no colour guessed from a hash that could disagree with the
// desktop's.

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const {
  CONVERSATION_MAX_PULL_REQUESTS,
  parseConversationFrame,
  parseConversationHost,
  parseConversationPullRequests,
  pullRequestUrl,
} = require(path.join(buildRoot, "src/api/conversationWire.js"));
const {
  PULL_REQUEST_TONE,
  chatHostMark,
  desktopMachineMark,
  pullRequestMark,
  stripPullRequest,
} = require(path.join(buildRoot, "src/features/conversations/chatMarks.js"));
const { readIdentityMachine } = require(path.join(buildRoot, "src/api/tailnetControlClient.js"));
const { withMachineMark } = require(path.join(buildRoot, "src/api/tailnetTransport.js"));
const { readStoredSessionList } = require(path.join(buildRoot, "src/storage/sessionStore.js"));
const { readWorkspaceCheckout } = require(path.join(buildRoot, "src/api/tailnetWorkspaces.js"));

function listed(overrides = {}) {
  return {
    workspaceId: "ws-1",
    agentId: "agent-1",
    title: "Fix the login",
    phase: "completed",
    createdAt: 1,
    updatedAt: 2,
    lastSeq: 3,
    providerId: "claude-agent",
    modelId: "default",
    turnCount: 1,
    ...overrides,
  };
}
function listOf(...sessions) {
  return parseConversationFrame(JSON.stringify({ type: "sessions", requestId: "list", sessions })).sessions;
}

const UBUNTU = { id: "wsl:Ubuntu", kind: "wsl", label: "WSL: Ubuntu", color: "teal" };
const PR = (number, state, extra = {}) => ({
  number,
  state,
  url: `https://github.com/acme/app/pull/${number}`,
  title: `Change ${number}`,
  ...extra,
});

// ── host ──────────────────────────────────────────────────────────────────

test("a listed host is kept as the desktop sent it", () => {
  const [chat] = listOf(listed({ host: UBUNTU }));
  assert.deepEqual(chat.host, UBUNTU);
});

test("a chat from a desktop that sends no host lists exactly as before, with no host at all", () => {
  const [chat] = listOf(listed());
  assert.equal("host" in chat, false);
  assert.equal(chatHostMark(chat.host), null);
});

test("a malformed host is dropped, and the chat still lists", () => {
  for (const host of [
    "wsl:Ubuntu",
    { id: "wsl:Ubuntu" },
    { id: "", kind: "wsl", label: "WSL: Ubuntu", color: "teal" },
    { id: "wsl:Ubuntu", kind: "wsl", label: "   ", color: "teal" },
    { id: 7, kind: "wsl", label: "WSL: Ubuntu", color: "teal" },
    [],
    null,
  ]) {
    const [chat] = listOf(listed({ host }));
    assert.equal(chat.title, "Fix the login");
    assert.equal("host" in chat, false, JSON.stringify(host));
  }
  assert.equal(parseConversationHost(undefined), null);
});

test("the desktop itself is the unmarked default: a local chat wears no mark", () => {
  assert.equal(chatHostMark({ id: "local", kind: "laptop", label: "This Mac", color: "blue" }), null);
  assert.equal(chatHostMark(undefined), null);
  assert.equal(chatHostMark(null), null);
});

test("a chat that runs elsewhere wears its machine's kind and colour, and its name", () => {
  assert.deepEqual(chatHostMark(UBUNTU), { id: "wsl:Ubuntu", kind: "wsl", colour: "teal", label: "WSL: Ubuntu" });
  assert.deepEqual(chatHostMark({ id: "ssh:build-box", kind: "server", label: "build-box", color: "orange" }), {
    id: "ssh:build-box",
    kind: "server",
    colour: "orange",
    label: "build-box",
  });
  assert.deepEqual(chatHostMark({ id: "tailnet:mac-mini", kind: "mini", label: "mac-mini", color: "violet" }).kind, "mini");
});

test("a host with a kind or colour this build does not know still marks the chat, as a neutral desktop", () => {
  const [chat] = listOf(listed({ host: { id: "tailnet:build-box", kind: "mainframe", label: "build-box", color: "plaid" } }));
  assert.deepEqual(chatHostMark(chat.host), {
    id: "tailnet:build-box",
    kind: "desktop",
    colour: "neutral",
    label: "build-box",
  });
});

// ── the paired desktop's own mark ─────────────────────────────────────────

test("the identity's machine is read as strings, and anything else is no machine", () => {
  assert.deepEqual(readIdentityMachine({ kind: "mini", color: "orange" }), { kind: "mini", color: "orange" });
  assert.equal(readIdentityMachine(undefined), null);
  assert.equal(readIdentityMachine({ kind: "mini" }), null);
  assert.equal(readIdentityMachine("mini"), null);
});

test("a desktop's mark is folded into its pairing only when it changed, and dropped when the desktop stops sending it", () => {
  const paired = { deviceId: "d1", desktopName: "mac-mini" };
  const marked = withMachineMark(paired, { kind: "mini", color: "orange" });
  assert.deepEqual(marked.machineMark, { kind: "mini", color: "orange" });
  assert.equal(withMachineMark(marked, { kind: "mini", color: "orange" }), null);
  assert.deepEqual(withMachineMark(marked, { kind: "mini", color: "blue" }).machineMark, { kind: "mini", color: "blue" });
  const dropped = withMachineMark(marked, null);
  assert.equal("machineMark" in dropped, false);
  assert.equal(withMachineMark(paired, null), null);
});

test("a stored pairing keeps its machine mark, and a malformed one drops the pairing rather than misreading it", () => {
  const base = {
    deviceId: "d1",
    desktopName: "mac-mini",
    baseUrl: "http://mac-mini.tail1234.ts.net:4100",
    deviceToken: "mctn_fixture",
    pairedAt: "2026-10-01T10:00:00.000Z",
    tailnetScopes: ["workspace:read"],
  };
  const kept = readStoredSessionList(
    JSON.stringify({ schemaVersion: 3, sessions: [{ ...base, machineMark: { kind: "mini", color: "orange" } }], activeDeviceId: "d1" }),
  );
  assert.deepEqual(kept.sessions[0].machineMark, { kind: "mini", color: "orange" });
  const none = readStoredSessionList(JSON.stringify({ schemaVersion: 3, sessions: [base], activeDeviceId: "d1" }));
  assert.equal(none.sessions.length, 1);
  const bad = readStoredSessionList(
    JSON.stringify({ schemaVersion: 3, sessions: [{ ...base, machineMark: { kind: 3 } }], activeDeviceId: "d1" }),
  );
  assert.equal(bad.sessions.length, 0);
});

test("a paired desktop wears its own mark where the phone chooses between desktops, and none when it sent none", () => {
  assert.deepEqual(desktopMachineMark({ deviceId: "d1", name: "mac-mini", machineMark: { kind: "mini", color: "orange" } }), {
    id: "d1",
    kind: "mini",
    colour: "orange",
    label: "mac-mini",
  });
  assert.equal(desktopMachineMark({ deviceId: "d1", name: "mac-mini", machineMark: null }), null);
  assert.equal(desktopMachineMark({ deviceId: "d1", name: "mac-mini" }), null);
});

// ── pull requests ─────────────────────────────────────────────────────────

test("listed pull requests are validated one by one and capped at the desktop's 20", () => {
  const prs = parseConversationPullRequests([
    PR(12, "open"),
    PR(0, "open"),
    PR(13, "draft"),
    PR(14, "merged", { url: "javascript:alert(1)" }),
    { number: "15", state: "open", url: "https://github.com/acme/app/pull/15", title: "x" },
    PR(16, "closed", { title: 9 }),
    "PR 17",
  ]);
  assert.deepEqual(
    prs.map((pr) => [pr.number, pr.state, pr.title]),
    [
      [12, "open", "Change 12"],
      [16, "closed", ""],
    ],
  );
  const many = parseConversationPullRequests(Array.from({ length: 30 }, (_, index) => PR(index + 1, "merged")));
  assert.equal(many.length, CONVERSATION_MAX_PULL_REQUESTS);
  assert.deepEqual(parseConversationPullRequests(undefined), []);
});

test("a chat with no pull requests, or a desktop that sends none, wears no mark", () => {
  const [plain, empty] = listOf(listed(), listed({ agentId: "agent-2", pullRequests: [] }));
  assert.equal("pullRequests" in plain, false);
  assert.equal("pullRequests" in empty, false);
  assert.equal(pullRequestMark(plain.pullRequests, { includeClosed: true }), null);
});

test("each state draws its own mark in its own tone, with the number beside it", () => {
  assert.deepEqual(PULL_REQUEST_TONE, { open: "accentPrimary", merged: "toneMerged", closed: "toneError" });
  for (const state of ["open", "merged", "closed"]) {
    const mark = pullRequestMark([PR(42, state)], { includeClosed: true });
    assert.equal(mark.state, state);
    assert.equal(mark.tone, PULL_REQUEST_TONE[state]);
    assert.equal(mark.text, "#42");
    assert.equal(mark.url, "https://github.com/acme/app/pull/42");
  }
  assert.match(pullRequestMark([PR(42, "closed")], { includeClosed: true }).accessibilityLabel, /closed without merging/);
});

test("an open pull request leads; otherwise the newest; the row leaves a closed one out", () => {
  const list = [PR(30, "merged"), PR(12, "open"), PR(40, "closed")];
  assert.equal(pullRequestMark(list, { includeClosed: true }).number, 12);
  assert.equal(pullRequestMark([PR(30, "merged"), PR(40, "closed")], { includeClosed: true }).number, 40);
  // The list row: open asks for you, merged says it went in, closed says neither.
  assert.equal(pullRequestMark([PR(30, "merged"), PR(40, "closed")], { includeClosed: false }).number, 30);
  assert.equal(pullRequestMark([PR(40, "closed")], { includeClosed: false }), null);
  const mark = pullRequestMark(list, { includeClosed: true });
  assert.equal(mark.others, 2);
  assert.equal(mark.accessibilityLabel, "Pull request #12, open: Change 12. 2 more on this chat. Opens it in the browser.");
});

// A pull request's address goes straight to the system browser. Anything that
// is not a plain web page, or that dresses another host up as GitHub with
// credentials before an "@", is left out rather than opened.
test("a pull request's address is a web page on the host it names, or the pull request is left out", () => {
  assert.equal(pullRequestUrl(" https://github.com/acme/app/pull/1 "), "https://github.com/acme/app/pull/1");
  assert.equal(pullRequestUrl("http://git.example.com/acme/app/pull/1"), "http://git.example.com/acme/app/pull/1");
  for (const bad of [
    "https://github.com@evil.example/acme/app/pull/1",
    "https://user:pass@github.com/acme/app/pull/1",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "intent://github.com/#Intent;end",
    "https:///no-host",
    "https://github.com/acme/app/pull/1 extra",
    `https://github.com/${"a".repeat(2_000)}`,
    42,
  ]) {
    assert.equal(pullRequestUrl(bad), null, String(bad).slice(0, 60));
  }
  assert.deepEqual(parseConversationPullRequests([PR(5, "open", { url: "https://github.com@evil.example/x" })]), []);
});

test("a list row speaks its pull request among its facts, since the mark inside it is out of a screen reader's reach", () => {
  assert.equal(pullRequestMark([PR(42, "open")], { includeClosed: false }).spokenInRow, "pull request #42 open");
  assert.equal(pullRequestMark([PR(7, "merged")], { includeClosed: false }).spokenInRow, "pull request #7 merged");
});

test("an open chat's strip offers its pull request in the desktop's words, open before merged, never a closed one", () => {
  assert.equal(stripPullRequest([PR(42, "open"), PR(39, "merged")]).text, "Open PR #42");
  assert.equal(stripPullRequest([PR(39, "merged"), PR(37, "closed")]).text, "Merged PR #39");
  // A newer closed one does not outrank the open one, nor stand in for it.
  assert.equal(stripPullRequest([PR(50, "closed"), PR(42, "open")]).text, "Open PR #42");
  assert.equal(stripPullRequest([PR(37, "closed")]), null);
  assert.equal(stripPullRequest(undefined), null);
  assert.equal(stripPullRequest([PR(42, "open")]).mark.url, "https://github.com/acme/app/pull/42");
});

// ── the strip's checkout ──────────────────────────────────────────────────

test("the strip's branch and worktree come from workspace.checkout, and a folder that is no repository has neither", () => {
  const answer = {
    workspaceId: "ws-1",
    git: true,
    branch: "feat/login",
    worktrees: [
      { path: "/Users/dev/app", branch: "main", isMain: true },
      { path: "/Users/dev/app-login/", branch: "feat/login", isMain: false },
    ],
  };
  // From a worktree, the main checkout's branch is still what New's worktree is cut from.
  assert.deepEqual(readWorkspaceCheckout(answer, "/Users/dev/app-login"), { branch: "feat/login", worktree: "app-login", mainBranch: "main" });
  assert.deepEqual(readWorkspaceCheckout({ ...answer, branch: "main" }, "/Users/dev/app"), { branch: "main", worktree: null, mainBranch: "main" });
  assert.equal(readWorkspaceCheckout({ git: false }, "/Users/dev/app"), null);
  assert.equal(readWorkspaceCheckout(null, "/Users/dev/app"), null);
  // No worktree list: a folder that is not a worktree is the main checkout.
  assert.deepEqual(readWorkspaceCheckout({ git: true, branch: "trunk" }, "/Users/dev/app"), { branch: "trunk", worktree: null, mainBranch: "trunk" });
  assert.deepEqual(readWorkspaceCheckout({ git: true, branch: 5 }, null), { branch: null, worktree: null, mainBranch: null });
});
