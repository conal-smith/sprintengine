/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const buildRoot = path.resolve(__dirname, "../../.mobile-test-build");
const {
  TailnetControlClient,
  POLLED_SNAPSHOT_COLLECTIONS,
  completeTailnetPairing,
  knownCommandTypes,
  readSnapshotCommands,
  readTailnetIdentity,
  withTailnetScopes,
  tailnetClientForSession,
  tailnetGrantAllows,
  tailnetSupportedCommands,
} = require(path.join(buildRoot, "src/api/tailnetControlClient.js"));
const { parsePairingPayload, tailnetEndpointBaseUrl } = require(path.join(
  buildRoot,
  "src/features/pairing/pairingPayload.js",
));
const { createMobileSessionFromTailnetPairing } = require(path.join(
  buildRoot,
  "src/features/pairing/pairingSession.js",
));

const originalFetch = global.fetch;

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function toolResult(structuredContent, isError = false) {
  return { jsonrpc: "2.0", id: "srv-1", result: { content: [], structuredContent, isError } };
}

const validSnapshot = {
  protocolVersion: 4,
  generatedAt: "2026-08-31T12:00:00.000Z",
  desktopSessionId: "tailnet:studio-mac",
  snapshotVersion: "snap_abc",
  commands: ["snapshot.request", "backlog.update"],
};

test("the desktop's tailnet pairing link parses to its endpoint and one-time code", () => {
  // Exactly what tailnet-service.ts mints: two params, endpoint + token.
  const parsed = parsePairingPayload(
    "sprintengine-tailnet://pair?endpoint=100.101.102.103%3A8471&token=mcpair_abc123",
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.tailnet.endpoint, "100.101.102.103:8471");
  assert.equal(parsed.tailnet.baseUrl, "http://100.101.102.103:8471");
  assert.equal(parsed.tailnet.pairingToken, "mcpair_abc123");

  // Bracketed IPv6 survives the round trip.
  const v6 = parsePairingPayload(
    "sprintengine-tailnet://pair?endpoint=%5Bfd7a%3A115c%3Aa1e0%3A%3A1%5D%3A8471&token=mcpair_v6",
  );
  assert.equal(v6.ok, true);
  assert.equal(v6.tailnet.baseUrl, "http://[fd7a:115c:a1e0::1]:8471");

  // Missing halves are named, not guessed.
  assert.equal(parsePairingPayload("sprintengine-tailnet://pair?token=mcpair_x").ok, false);
  assert.equal(parsePairingPayload("sprintengine-tailnet://pair?endpoint=host%3A1").ok, false);
});

test("tailnet endpoints are host:port only — smuggled paths, credentials, and queries are refused", () => {
  assert.equal(tailnetEndpointBaseUrl("100.64.0.9:8471"), "http://100.64.0.9:8471");
  assert.equal(tailnetEndpointBaseUrl("studio.tail1234.ts.net:8471"), "http://studio.tail1234.ts.net:8471");
  assert.equal(tailnetEndpointBaseUrl("host:8471/evil/path"), null);
  assert.equal(tailnetEndpointBaseUrl("user:pass@host:8471"), null);
  assert.equal(tailnetEndpointBaseUrl("host:8471?x=1"), null);
  assert.equal(tailnetEndpointBaseUrl(""), null);
});

test("tailnet pairing exchanges the one-time code and stores the gateway's own grant", async () => {
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return jsonResponse(200, {
      deviceId: "tnd_phone1",
      deviceName: "Test phone",
      deviceToken: "mctn_secret",
      scopes: ["workspace:read", "workspace:operate", "horizon:read"],
    });
  };
  try {
    const result = await completeTailnetPairing({
      baseUrl: "http://100.64.0.9:8471",
      pairingToken: "mcpair_abc",
      deviceName: "Test phone",
    });
    assert.equal(result.ok, true);
    assert.equal(requests[0].url, "http://100.64.0.9:8471/tailnet/v1/pair");
    assert.deepEqual(requests[0].body, { pairingToken: "mcpair_abc", deviceName: "Test phone" });

    const session = createMobileSessionFromTailnetPairing({
      tailnet: { endpoint: "100.64.0.9:8471", baseUrl: "http://100.64.0.9:8471", pairingToken: "mcpair_abc" },
      completion: result.data,
      pairedAt: "2026-08-31T12:00:00.000Z",
    });
    assert.equal(session.baseUrl, "http://100.64.0.9:8471");
    assert.equal(session.deviceToken, "mctn_secret");
    assert.equal(session.deviceId, "tnd_phone1");
    // A version-1 Studio declares nothing on the pair answer, and that must
    // read as "not declared" — never as version 0 or as no capabilities.
    assert.deepEqual(result.data.transport, { transportVersion: null, capabilities: null });
    assert.equal(session.tailnetTransportVersion, undefined);
    assert.equal(session.tailnetCapabilities, undefined);
    // The grant is kept as the gateway said it; `tailnetGrantAllows` decides
    // what it unlocks.
    assert.deepEqual(session.tailnetScopes, ["workspace:read", "workspace:operate", "horizon:read"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("a version-2 Studio's pair answer lands its transport declaration on the session", async () => {
  global.fetch = async () =>
    jsonResponse(200, {
      deviceId: "tnd_phone2",
      deviceName: "Test phone",
      deviceToken: "mctn_secret",
      scopes: ["workspace:read", "conversation:operate"],
      transportVersion: 2,
      capabilities: ["conversations", "conversation-models"],
    });
  try {
    const result = await completeTailnetPairing({ baseUrl: "http://100.64.0.9:8471", pairingToken: "mcpair_abc", deviceName: "Test phone" });
    assert.equal(result.ok, true);
    const session = createMobileSessionFromTailnetPairing({
      tailnet: { endpoint: "100.64.0.9:8471", baseUrl: "http://100.64.0.9:8471", pairingToken: "mcpair_abc" },
      completion: result.data,
      pairedAt: "2026-09-06T12:00:00.000Z",
    });
    assert.equal(session.tailnetTransportVersion, 2);
    assert.deepEqual(session.tailnetCapabilities, ["conversations", "conversation-models"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("readTailnetIdentity carries the bearer token, keeps the declaration, and reads a 401 as the pairing being gone", async () => {
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url, init });
    return jsonResponse(200, {
      deviceId: "tnd_phone1",
      deviceName: "Test phone",
      scopes: ["conversation:read"],
      serverInfo: { name: "SprintEngine Studio MCP", version: "1.2.3" },
      transportVersion: 2,
      capabilities: ["conversations"],
      protocolVersions: ["2025-06-18"],
    });
  };
  try {
    const result = await readTailnetIdentity({ baseUrl: "http://100.64.0.9:8471", deviceToken: "mctn_secret" });
    assert.equal(requests[0].url, "http://100.64.0.9:8471/tailnet/v1/identity");
    assert.equal(requests[0].init.headers.authorization, "Bearer mctn_secret");
    assert.equal(result.ok, true);
    // A Studio that does not say how it draws itself as a machine reads as
    // no machine, never as a guessed one.
    assert.deepEqual(result.data, {
      scopes: ["conversation:read"],
      transport: { transportVersion: 2, capabilities: ["conversations"] },
      machine: null,
    });
    global.fetch = async () =>
      jsonResponse(200, { scopes: [], transportVersion: 2, machine: { kind: "mini", color: "orange" } });
    const marked = await readTailnetIdentity({ baseUrl: "http://100.64.0.9:8471", deviceToken: "mctn_secret" });
    assert.deepEqual(marked.data.machine, { kind: "mini", color: "orange" });
    // An answer without a grant says nothing about it, not that it is empty.
    global.fetch = async () => jsonResponse(200, { transportVersion: 2 });
    const silent = await readTailnetIdentity({ baseUrl: "http://100.64.0.9:8471", deviceToken: "mctn_secret" });
    assert.equal(silent.data.scopes, null);
    global.fetch = async () => jsonResponse(401, { error: { code: "unauthorized" } });
    const revoked = await readTailnetIdentity({ baseUrl: "http://100.64.0.9:8471", deviceToken: "mctn_secret" });
    assert.equal(revoked.ok, false);
    assert.equal(revoked.errorCode, "unauthenticated");
  } finally {
    global.fetch = originalFetch;
  }
});

test("a refused pairing code names the desktop and says how to get a fresh one", async () => {
  global.fetch = async () => jsonResponse(401, { error: "pairing_expired" });
  try {
    const result = await completeTailnetPairing({
      baseUrl: "http://100.64.0.9:8471",
      pairingToken: "mcpair_stale",
      deviceName: "Test phone",
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /generate a fresh one from the desktop|refused the pairing/u);
  } finally {
    global.fetch = originalFetch;
  }
});

test("the client for a session talks to that pairing's gateway with its device token", async () => {
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url, headers: init.headers });
    return jsonResponse(200, toolResult({ unchanged: true, snapshotVersion: "snap_abc" }));
  };
  try {
    const client = tailnetClientForSession({
      deviceId: "tnd_phone1",
      desktopName: "Desktop on 100.64.0.9",
      baseUrl: "http://100.64.0.9:8471",
      deviceToken: "mctn_secret",
      pairedAt: "2026-08-31T12:00:00.000Z",
      tailnetScopes: ["workspace:read"],
    });
    assert.ok(client instanceof TailnetControlClient);
    await client.readSnapshot({ knownSnapshotVersion: "snap_abc" });
    assert.equal(requests[0].url, "http://100.64.0.9:8471/tailnet/v1/mcp");
    assert.equal(requests[0].headers.authorization, "Bearer mctn_secret");
  } finally {
    global.fetch = originalFetch;
  }
});

test("readSnapshot speaks JSON-RPC tools/call with the bearer device token and validates the document", async () => {
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return jsonResponse(200, toolResult({ unchanged: false, snapshot: validSnapshot }));
  };
  try {
    const client = new TailnetControlClient({ baseUrl: "http://100.64.0.9:8471", deviceToken: "mctn_secret" });
    const result = await client.readSnapshot({ include: ["backlog"], knownSnapshotVersion: "snap_old" });
    assert.equal(result.ok, true);
    assert.equal(result.data.unchanged, false);
    assert.equal(result.data.snapshot.snapshotVersion, "snap_abc");

    const request = requests[0];
    assert.equal(request.url, "http://100.64.0.9:8471/tailnet/v1/mcp");
    assert.equal(request.headers.authorization, "Bearer mctn_secret");
    // Never an Origin header — the gateway refuses any request carrying one.
    assert.equal("origin" in request.headers || "Origin" in request.headers, false);
    assert.equal(request.body.method, "tools/call");
    assert.equal(request.body.params.name, "workspace.snapshot");
    assert.deepEqual(request.body.params.arguments, {
      include: ["backlog"],
      knownSnapshotVersion: "snap_old",
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("a matched knownSnapshotVersion comes back as the unchanged marker", async () => {
  global.fetch = async () => jsonResponse(200, toolResult({ unchanged: true, snapshotVersion: "snap_abc" }));
  try {
    const client = new TailnetControlClient({ baseUrl: "http://100.64.0.9:8471", deviceToken: "mctn_secret" });
    const result = await client.readSnapshot({ knownSnapshotVersion: "snap_abc" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { unchanged: true, snapshotVersion: "snap_abc" });
  } finally {
    global.fetch = originalFetch;
  }
});

test("sendCommand dispatches only the served set and carries an idempotency key", async () => {
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push(JSON.parse(init.body));
    return jsonResponse(
      200,
      toolResult({ ok: true, commandId: "tnc_1", commandType: "backlog.update", executedAt: "2026-08-31T12:00:01.000Z", data: { relativePath: "backlog/x.md" } }),
    );
  };
  try {
    const client = new TailnetControlClient({ baseUrl: "http://100.64.0.9:8471", deviceToken: "mctn_secret" });
    const result = await client.sendCommand({
      type: "backlog.update",
      payload: { workspacePath: "ws_abc", relativePath: "backlog/x.md", status: "ready" },
      expectedSnapshotVersion: "snap_abc",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { relativePath: "backlog/x.md" });
    const args = requests[0].params.arguments;
    assert.equal(requests[0].params.name, "workspace.mobile_command");
    assert.equal(args.type, "backlog.update");
    assert.equal(args.expectedSnapshotVersion, "snap_abc");
    assert.ok(typeof args.idempotencyKey === "string" && args.idempotencyKey.length > 0);

    // An unserved command never touches the network.
    const refused = await client.sendCommand({ type: "device.revoke", payload: { deviceId: "tnd_x" } });
    assert.equal(refused.ok, false);
    assert.equal(refused.errorCode, "command_not_supported");
    assert.equal(requests.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("gateway refusals map onto the app's error vocabulary", async () => {
  const responses = [
    toolResult({ error: { code: "tailnet_scope_required", message: "backlog:operate not granted" } }, true),
    toolResult({ error: { code: "command_not_supported", message: "not served" } }, true),
  ];
  global.fetch = async () => jsonResponse(200, responses.shift());
  try {
    const client = new TailnetControlClient({ baseUrl: "http://100.64.0.9:8471", deviceToken: "mctn_secret" });
    const scopeRefused = await client.sendCommand({ type: "backlog.update", payload: {} });
    assert.equal(scopeRefused.ok, false);
    assert.equal(scopeRefused.errorCode, "unauthorized");

    const unsupported = await client.sendCommand({ type: "backlog.create", payload: {} });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.errorCode, "command_not_supported");
  } finally {
    global.fetch = originalFetch;
  }
});

test("a revoked device reads as unauthenticated, an unreachable gateway as desktop_unavailable", async () => {
  global.fetch = async () => jsonResponse(401, {});
  try {
    const client = new TailnetControlClient({ baseUrl: "http://100.64.0.9:8471", deviceToken: "mctn_revoked" });
    const revoked = await client.readSnapshot();
    assert.equal(revoked.ok, false);
    assert.equal(revoked.errorCode, "unauthenticated");
  } finally {
    global.fetch = originalFetch;
  }

  global.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const client = new TailnetControlClient({ baseUrl: "http://100.64.0.9:8471", deviceToken: "mctn_secret" });
    const unreachable = await client.readSnapshot();
    assert.equal(unreachable.ok, false);
    assert.equal(unreachable.errorCode, "desktop_unavailable");
  } finally {
    global.fetch = originalFetch;
  }
});

test("the transport's own surface stays honest about what it does not serve", () => {
  // `sprintengine.create` was served here until the phone's sprint surface was
  // cut (2026-09-16), and is not a command type at all since protocol v3. What
  // this still pins is the shape: a command the gateway does not serve is refused
  // client-side, and the failure names the transport rather than being a mystery.
  assert.deepEqual([...tailnetSupportedCommands], ["snapshot.request", "backlog.update"]);
  // The grant mirrors the desktop's single-tool gate: workspace:operate
  // unlocks everything served; the per-family operates unlock NOTHING here —
  // a control the desktop would refuse must never be drawn.
  assert.equal(tailnetGrantAllows(["workspace:operate"], "snapshot.request"), true);
  assert.equal(tailnetGrantAllows(["workspace:operate"], "backlog.update"), true);
  assert.equal(tailnetGrantAllows(["workspace:read"], "snapshot.request"), true);
  assert.equal(tailnetGrantAllows(["workspace:read"], "backlog.update"), false);
  assert.equal(tailnetGrantAllows(["backlog:operate", "sprint:operate"], "backlog.update"), false);
  assert.equal(tailnetGrantAllows([], "snapshot.request"), false);
  assert.equal(tailnetGrantAllows(undefined, "snapshot.request"), false);
  // Commands the gateway does not serve are never granted, whatever the scopes.
  for (const unserved of ["backlog.create", "device.revoke", "automations.control"]) {
    assert.equal(tailnetGrantAllows(["workspace:operate"], unserved), false, unserved);
  }
});

test("the polled snapshot vocabulary is backlog, and nothing else", () => {
  // `automations` left with the phone's automations (2026-09-29).
  assert.deepEqual([...POLLED_SNAPSHOT_COLLECTIONS], ["backlog"]);
});

test("the capability gate reads the commands a desktop advertises, and drops what this build does not know", () => {
  assert.equal(readSnapshotCommands(undefined).size, 0);
  assert.equal(readSnapshotCommands("backlog.update").size, 0);

  // `task.start` and `agent.followUp` left the wire at protocol v3, and
  // `automations.control` left the phone on 2026-09-29; a desktop advertising a
  // retired command is advertising something no phone will draw.
  const mixed = readSnapshotCommands([
    "backlog.update",
    "automations.control",
    "task.start",
    "agent.followUp",
    "invalid-command",
    null,
    42,
  ]);
  assert.deepEqual([...mixed].sort(), ["backlog.update"]);

  for (const commandType of knownCommandTypes) {
    assert.equal(readSnapshotCommands([commandType]).has(commandType), true, commandType);
  }
  // Tolerating the wire's spelling is not tolerating any spelling.
  assert.equal(readSnapshotCommands(["backlog.Update", "BACKLOG.UPDATE", "backlog-update"]).size, 0);
});

test("a 401 about the tailnet node is not an unpairing; a plain one still is", () => {
  const { unauthorizedResult } = require(path.join(buildRoot, "src/api/tailnetControlClient.js"));
  assert.equal(unauthorizedResult({ error: { code: "peer_unverified", message: "x" } }).errorCode, "desktop_unavailable");
  const mismatch = unauthorizedResult({ error: { code: "peer_mismatch", message: "x" } });
  assert.equal(mismatch.errorCode, "unauthenticated");
  assert.match(mismatch.message, /different Tailscale device/u);
  assert.equal(unauthorizedResult({ error: { code: "unauthorized" } }).message, "This device is no longer paired with the desktop.");
  assert.equal(unauthorizedResult(null).errorCode, "unauthenticated");
});

// The desktop widens or narrows a grant after pairing; the identity read on
// foreground carries it, and the phone used to throw it away.
test("the grant the identity reports replaces the pair-time one, and only when it moved", () => {
  const session = { deviceId: "tnd_phone1", tailnetScopes: ["workspace:read", "conversation:read"] };
  assert.deepEqual(withTailnetScopes(session, ["workspace:read", "conversation:operate"]), {
    deviceId: "tnd_phone1",
    tailnetScopes: ["workspace:read", "conversation:operate"],
  });
  assert.deepEqual(withTailnetScopes(session, ["workspace:read"]).tailnetScopes, ["workspace:read"]);
  assert.equal(withTailnetScopes(session, ["conversation:read", "workspace:read"]), null);
  assert.equal(withTailnetScopes(session, null), null);
});
