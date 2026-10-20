/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const buildRoot = path.resolve(__dirname, "../../.mobile-test-build");
const {
  declaresConversationHello,
  declaresConversationImages,
  declaresConversationLifecycle,
  declaresConversationModels,
  declaresCliRuntimeCatalog,
  declaresImageDownscale,
  declaresNewChatEffort,
  declaresNewChatWorktree,
  describeTransport,
  readTransportDeclaration,
  TAILNET_TRANSPORT_KNOWN,
  TAILNET_TRANSPORT_MIN,
  transportStanding,
  transportStandingSentence,
  withTransportDeclaration,
} = require(path.join(buildRoot, "src/api/tailnetTransport.js"));

test("this build speaks transport 1 through 2", () => {
  assert.equal(TAILNET_TRANSPORT_MIN, 1);
  assert.equal(TAILNET_TRANSPORT_KNOWN, 2);
});

test("a declaration is read out of any gateway answer, and a missing field is null — never 0 and never []", () => {
  assert.deepEqual(readTransportDeclaration({ transportVersion: 2, capabilities: ["conversations", "conversation-models"] }), {
    transportVersion: 2,
    capabilities: ["conversations", "conversation-models"],
  });
  // A version-1 Studio: the version, no capabilities field.
  assert.deepEqual(readTransportDeclaration({ product: "SprintEngine Studio MCP", transportVersion: 1, protocolVersions: [] }), {
    transportVersion: 1,
    capabilities: null,
  });
  assert.deepEqual(readTransportDeclaration({ transportVersion: 2, capabilities: [] }), { transportVersion: 2, capabilities: [] });
  assert.deepEqual(readTransportDeclaration({ transportVersion: "two", capabilities: ["conversations", 3] }), { transportVersion: null, capabilities: ["conversations"] });
  assert.deepEqual(readTransportDeclaration({ transportVersion: 1.5 }), { transportVersion: null, capabilities: null });
  assert.deepEqual(readTransportDeclaration(null), { transportVersion: null, capabilities: null });
  assert.deepEqual(readTransportDeclaration([]), { transportVersion: null, capabilities: null });
});

test("the standing is a range check; an undeclared version is unknown, not old", () => {
  assert.equal(transportStanding({ tailnetTransportVersion: 1 }), "current");
  assert.equal(transportStanding({ tailnetTransportVersion: 2 }), "current");
  assert.equal(transportStanding({ tailnetTransportVersion: 0 }), "studio-older");
  assert.equal(transportStanding({ tailnetTransportVersion: 3 }), "app-older");
  assert.equal(transportStanding({}), "unknown");
});

test("out of step is one sentence naming the side to update; in step and unknown say nothing", () => {
  assert.match(transportStandingSentence("studio-older"), /Update Studio on the desktop/u);
  assert.match(transportStandingSentence("app-older"), /Update the app/u);
  assert.equal(transportStandingSentence("current"), null);
  assert.equal(transportStandingSentence("unknown"), null);
});

test("the transport line says the version and the capabilities, and tells 'declared none' from 'declared nothing'", () => {
  assert.equal(describeTransport({}), "tailnet, version not declared");
  assert.equal(describeTransport({ tailnetTransportVersion: 1 }), "tailnet v1");
  assert.equal(describeTransport({ tailnetTransportVersion: 2, tailnetCapabilities: [] }), "tailnet v2 · no extras");
  assert.equal(
    describeTransport({ tailnetTransportVersion: 2, tailnetCapabilities: ["conversations", "conversation-models"] }),
    "tailnet v2 · conversations, conversation-models",
  );
});

test("folding a fresh declaration in returns null when nothing moved, so a foreground re-read writes nothing", () => {
  const session = { deviceId: "d", tailnetTransportVersion: 2, tailnetCapabilities: ["conversations", "conversation-models"] };
  assert.equal(withTransportDeclaration(session, { transportVersion: 2, capabilities: ["conversations", "conversation-models"] }), null);
  // The gateway saying nothing about a field keeps what the session has.
  assert.equal(withTransportDeclaration(session, { transportVersion: null, capabilities: null }), null);
  assert.deepEqual(withTransportDeclaration(session, { transportVersion: 3, capabilities: ["conversations", "conversation-models"] }), {
    deviceId: "d",
    tailnetTransportVersion: 3,
    tailnetCapabilities: ["conversations", "conversation-models"],
  });
  assert.deepEqual(withTransportDeclaration(session, { transportVersion: 2, capabilities: ["conversations"] }), {
    deviceId: "d",
    tailnetTransportVersion: 2,
    tailnetCapabilities: ["conversations"],
  });
  // A session paired before the declaration existed gains one.
  assert.deepEqual(withTransportDeclaration({ deviceId: "d" }, { transportVersion: 2, capabilities: ["conversations"] }), {
    deviceId: "d",
    tailnetTransportVersion: 2,
    tailnetCapabilities: ["conversations"],
  });
  // ...and the original is untouched.
  assert.deepEqual(session, { deviceId: "d", tailnetTransportVersion: 2, tailnetCapabilities: ["conversations", "conversation-models"] });
});

test("the model control needs a desktop that declared conversation-models; silence is a no", () => {
  assert.equal(declaresConversationModels({ tailnetCapabilities: ["conversations", "conversation-models"] }), true);
  assert.equal(declaresConversationModels({ tailnetCapabilities: ["conversations"] }), false);
  assert.equal(declaresConversationModels({}), false);
});

test("a chat's pictures are fetched only from a desktop that declares it serves them", () => {
  assert.equal(declaresConversationImages({ tailnetCapabilities: ["conversations", "conversation-images"] }), true);
  // An older Studio has no route for them: no picture, and no broken placeholder.
  assert.equal(declaresConversationImages({ tailnetCapabilities: ["conversations", "conversation-models"] }), false);
  assert.equal(declaresConversationImages({}), false);
});

test("a chat probes with hello only where the desktop declared conversation-hello", () => {
  assert.equal(declaresConversationHello({ tailnetCapabilities: ["conversations", "conversation-hello"] }), true);
  // An older Studio refuses a hello it does not know; the probe stays a list there.
  assert.equal(declaresConversationHello({ tailnetCapabilities: ["conversations"] }), false);
  assert.equal(declaresConversationHello({}), false);
});

test("larger pictures go only to a desktop that declared conversation-image-downscale", () => {
  assert.equal(declaresImageDownscale({ tailnetCapabilities: ["conversations", "conversation-image-downscale"] }), true);
  // An older Studio refuses a picture over 5 MB; the phone keeps refusing it first.
  assert.equal(declaresImageDownscale({ tailnetCapabilities: ["conversations", "conversation-images"] }), false);
  assert.equal(declaresImageDownscale({}), false);
});

test("Settle and visit stamps need a desktop that declared conversation-lifecycle; silence is a no", () => {
  assert.equal(declaresConversationLifecycle({ tailnetCapabilities: ["conversations", "conversation-lifecycle"] }), true);
  // An older Studio has neither tool: nothing is offered, and nothing is sent.
  assert.equal(declaresConversationLifecycle({ tailnetCapabilities: ["conversations", "conversation-models"] }), false);
  assert.equal(declaresConversationLifecycle({}), false);
});

test("New's worktree, effort and catalog each need their own capability; silence is a no", () => {
  const current = { tailnetCapabilities: ["conversations", "new-chat-worktree", "new-chat-effort", "cli-runtime-catalog"] };
  assert.equal(declaresNewChatWorktree(current), true);
  assert.equal(declaresNewChatEffort(current), true);
  assert.equal(declaresCliRuntimeCatalog(current), true);
  // An older Studio skips an argument it does not know: a worktree sent there
  // would start the chat in the checkout without a word.
  const older = { tailnetCapabilities: ["conversations", "conversation-models"] };
  for (const declares of [declaresNewChatWorktree, declaresNewChatEffort, declaresCliRuntimeCatalog]) {
    assert.equal(declares(older), false);
    assert.equal(declares({}), false);
  }
  // Each is its own: one does not imply another.
  assert.equal(declaresNewChatEffort({ tailnetCapabilities: ["new-chat-worktree"] }), false);
});
