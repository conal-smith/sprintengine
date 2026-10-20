/* global __dirname */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// Drift guard (T10). This file's src/shared/mobile-control/protocol.ts is a
// byte-identical mirror of the desktop wire schema
// (multicode: packages/mobile-control-protocol/src/index.ts). The tailnet
// gateway's snapshot and command tools speak it, and they only work while the
// two copies agree, so both repos pin this same sha256 — the
// desktop side pins it in src/main/mobile/control/snapshot.test.ts. If you change
// the wire schema in either copy, mirror the change into the other repo and set
// both pins to the new shared hash.
//
// NOTE, and the reason this guard nearly failed to do its job: each pin hashes
// only its OWN copy. Two pins left at different values do not fail; they simply
// stop comparing anything. That is how the copies came to differ by an optional
// `rolesUnavailable` field, found and closed when protocol v3 set both pins in
// one change. Protocol v4 set both pins in one change again.
//
// 2026-09-29: this pin moved alone, with the automations removal, while the
// desktop takes them off its copy in parallel. The two copies are to be
// reconciled against the desktop's final change and both pins set together.
const PROTOCOL_SOURCE_SHA256 =
  "7bf19b9b818614df16b64f81a3294a6e6663548810b800c87c1871961e72d326";

test("mobile protocol.ts stays byte-identical to the desktop wire schema (hash pin)", () => {
  const source = fs.readFileSync(path.join(__dirname, "protocol.ts"));
  const digest = crypto.createHash("sha256").update(source).digest("hex");
  assert.equal(
    digest,
    PROTOCOL_SOURCE_SHA256,
    "protocol.ts changed — mirror the edit into the desktop copy and update both pinned hashes to the new shared value",
  );
});

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const {
  mobileControlProtocolVersion,
  validateMobileControlCommand,
  validateMobileControlDevice,
  validateMobileControlError,
  validateMobileControlSnapshot,
} = require(path.join(buildRoot, "src/shared/mobile-control/protocol.js"));
const now = "2026-05-25T21:50:00.000Z";

test("a desktop-shaped v4 snapshot validates, and carries no retired collection", () => {
  const snapshot = makeDesktopShapedSnapshot();

  const result = validateMobileControlSnapshot(snapshot);

  assert.equal(result.ok, true, result.ok === false ? result.error.message : undefined);
  assert.equal(result.value.protocolVersion, 4);
  assert.equal(result.value.backlog[0].items.length, 2);
  for (const retired of ["sprintEngines", "workspaces", "roadmaps"]) {
    assert.equal(retired in result.value, false, `${retired} is not part of a v4 snapshot`);
  }
});

// INVERTED at protocol v3, and this is the assertion the whole change turns on.
//
// At v2 this file asserted the opposite: a snapshot that OMITTED `sprintEngines`
// was rejected, because the key was a required array. That was the constraint
// that made the desktop keep emitting `sprintEngines: []` long after it could no
// longer produce a run — a desktop that dropped the key while this validator
// still demanded it failed EVERY snapshot read here with `invalid_payload`,
// taking backlog and automations down with the runs it no longer had.
//
// Pre-release, with no paired devices, both halves moved together. The key is
// gone from the wire, its absence is the ordinary case, and the phone's read must
// not depend on it in either direction.
test("a snapshot with no sprintEngines key is the ordinary snapshot", () => {
  const snapshot = makeDesktopShapedSnapshot();
  assert.equal("sprintEngines" in snapshot, false, "the producer emits no such key");

  const result = validateMobileControlSnapshot(snapshot);
  assert.equal(result.ok, true, result.ok === false ? result.error.message : undefined);

  // A stray key is an unknown field, which this validator has always ignored —
  // it is not a second, tolerated shape. The version stamp is what actually
  // keeps a v2 payload out, and it is asserted below.
  const stray = makeDesktopShapedSnapshot();
  stray.sprintEngines = [{ sprintEngineId: "se-1" }];
  assert.equal(validateMobileControlSnapshot(stray).ok, true);
  assert.equal("roleCatalogs" in snapshot, false);
  assert.equal("snapshotLimits" in snapshot, false);
});

// The whole sprint vocabulary is off the wire, so the shapes this file used to
// check field by field — a task's optional `role`, its `backlogRef`
//, its status enum, its needs-input kinds, the board counts, the
// artifact statuses — no longer have a carrier. Nothing validates them because
// nothing may send them. What is left to pin is the boundary itself.
test("the Sprint Engine's own vocabulary is no longer anywhere on the wire", () => {
  // An older snapshot is refused at the version stamp, before any shape is read.
  for (const older of [2, 3]) {
    const stale = makeDesktopShapedSnapshot();
    stale.protocolVersion = older;
    const refused = validateMobileControlSnapshot(stale);
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, "unsupported_protocol_version");
    assert.match(refused.error.message, new RegExp(`protocol version ${older} is not supported; this build speaks 4`));
  }

  // And a backlog workspace may no longer carry the launch picker's role catalog.
  // `roles` is simply an unknown field now; what matters is that nothing on this
  // wire declares it, so nothing downstream can read a catalogue into existence.
  assert.equal("roles" in makeDesktopShapedSnapshot().backlog[0], false);
});

// Protocol v4. The `workspaces` collection (always `[]` from the desktop, with its
// switchboard/watchtower kinds, workspace capabilities and detail shapes), the
// `desktopWorkspaces` snapshot collection, the `roadmaps` rider and the
// `python_tool_failed` error code had no producer, and are off the wire.
test("the members nothing produced are no longer anywhere on the wire", () => {
  // Naming the retired collection is refused, not quietly dropped.
  for (const include of [["backlog", "desktopWorkspaces"], ["sprintEngines"]]) {
    const refused = validateMobileControlCommand({
      protocolVersion: mobileControlProtocolVersion,
      commandId: "cmd-retired-collection",
      type: "snapshot.request",
      issuedAt: now,
      deviceId: "mobile-1",
      payload: { include },
    });
    assert.equal(refused.ok, false, `${include.join(",")} is not a snapshot collection`);
    assert.equal(refused.error.code, "invalid_payload");
  }

  for (const retired of ["summary.read", "detail.read", "logs.read", "tasks.move", "runner.pause", "execution.cancel"]) {
    const stale = validateMobileControlDevice({
      protocolVersion: mobileControlProtocolVersion,
      deviceId: "mobile-1",
      displayName: "Phone",
      platform: "ios",
      appVersion: "0.1.0",
      pairedAt: now,
      capabilities: ["snapshots.read", retired],
    });
    assert.equal(stale.ok, false, `${retired} is not a capability`);
  }

  const pythonFailure = validateMobileControlError({
    protocolVersion: mobileControlProtocolVersion,
    code: "python_tool_failed",
    message: "Nope.",
    retryable: false,
  });
  assert.equal(pythonFailure.ok, false);

  // A stray `workspaces` or `roadmaps` key is an unknown field, which this
  // validator has always ignored: it is not a tolerated shape, it has no type,
  // and nothing on this phone reads it. The version stamp keeps a v3 payload out.
  const stray = makeDesktopShapedSnapshot();
  stray.workspaces = [{ workspaceId: "switchboard:ws_2f6c1d", kind: "switchboard" }];
  stray.roadmaps = [{ roadmapId: "r", name: "R", lanes: [] }];
  assert.equal(validateMobileControlSnapshot(stray).ok, true);
});

test("mobile commands keep the existing narrow command contracts", () => {
  const unsupported = validateMobileControlCommand({
    protocolVersion: mobileControlProtocolVersion,
    commandId: "cmd-unsupported",
    type: "task.delete",
    issuedAt: now,
    deviceId: "mobile-1",
    payload: {},
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error.code, "invalid_payload");

  const missingTitle = validateMobileControlCommand({
    protocolVersion: mobileControlProtocolVersion,
    commandId: "cmd-missing-title",
    type: "backlog.create",
    issuedAt: now,
    deviceId: "mobile-1",
    payload: {
      workspacePath: "ws_2f6c1d",
    },
  });
  assert.equal(missingTitle.ok, false);
  assert.equal(missingTitle.error.code, "invalid_payload");
});

// INVERTED at protocol v3.
//
// Three tests stood here: `backlog.startSprintEngine` accepting a sprint config
// and enforcing its seat bounds, the same command accepting the epic and
// worktree flags, and `sprintengine.create` requiring its two fields. Each pinned
// a payload contract this mirror had to keep validating because the desktop copy
// did — the phone had stopped BUILDING those payloads when its sprint surface
// was cut (2026-09-16), but the wire still declared them.
//
// The wire does not declare them now. A payload contract for a command type that
// does not exist is not a contract, so what replaces all three is the one thing
// still worth asserting: every retired sprint command is refused at the envelope,
// by type, whatever its payload says.
test("every retired sprint command is refused by type, whatever its payload", () => {
  const retired = [
    ["sprintengine.create", { workspacePath: "/work/app", productPrompt: "Ship it" }],
    ["task.start", { sprintEngineId: "se-1", taskId: "T1", role: "developer", worktreeIsolation: "preferred" }],
    ["agent.followUp", { sprintEngineId: "se-1", agentId: "developer-1", text: "carry on" }],
    ["artifact.read", { sprintEngineId: "se-1", artifactId: "A1", previewMode: "markdown" }],
    ["artifact.approve", { sprintEngineId: "se-1", artifactId: "A1" }],
    ["artifact.requestChanges", { sprintEngineId: "se-1", artifactId: "A1", feedback: "more detail" }],
    [
      "backlog.startSprintEngine",
      {
        workspacePath: "/work/app",
        relativePath: "backlog/2026-07-09-thing.md",
        epic: true,
        useWorktrees: true,
        config: { teamName: "checkout-flow", roleCounts: { developer: 1 } },
      },
    ],
    ["sprintengine.openPullRequest", { sprintEngineId: "se-1" }],
    ["sprintengine.setAutomationMode", { sprintEngineId: "se-1", mode: "run_agents" }],
  ];

  for (const [type, payload] of retired) {
    const result = validateMobileControlCommand({
      protocolVersion: mobileControlProtocolVersion,
      commandId: `cmd-retired-${type}`,
      type,
      issuedAt: now,
      deviceId: "mobile-1",
      payload,
    });
    assert.equal(result.ok, false, `${type} is no longer a command this wire defines`);
    assert.equal(result.error.code, "invalid_payload");
  }
});

test("snapshots advertising commands newer than this client still validate (dark-launch gate)", () => {
  // The hub gates dark-launched controls on commands the mobile union does not
  // name yet. The validator must let unknown command strings through — rejecting
  // them would brick every snapshot read the moment the desktop ships a new
  // command. `snapshot.commands` is `string[]` on the wire for exactly this
  // reason, which is also why a desktop still advertising a retired sprint
  // command does not invalidate its snapshot: it is simply advertising something
  // this phone will never draw.
  const snapshot = makeDesktopShapedSnapshot();
  snapshot.commands = ["snapshot.request", "workspace.futureThing", "sprintengine.setAutomationMode"];

  const result = validateMobileControlSnapshot(snapshot);

  assert.equal(result.ok, true, result.ok === false ? result.error.message : undefined);
  assert.deepEqual(result.value.commands, [
    "snapshot.request",
    "workspace.futureThing",
    "sprintengine.setAutomationMode",
  ]);

  const nonString = makeDesktopShapedSnapshot();
  nonString.commands = ["snapshot.request", 7];
  const rejected = validateMobileControlSnapshot(nonString);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "invalid_payload");
});

test("device payloads may advertise every capability pairing grants, backlog trio included", () => {
  // Desktop pairing grants the backlog scopes, so the runtime capability list
  // must accept them — it once listed 7 of the 10 union members and rejected
  // exactly these device payloads.
  const device = validateMobileControlDevice({
    protocolVersion: mobileControlProtocolVersion,
    deviceId: "mobile-1",
    displayName: "Sprint Engine iPhone",
    platform: "ios",
    appVersion: "0.1.0",
    pairedAt: now,
    capabilities: [
      "snapshots.read",
      "devices.revoke",
      "backlog.update",
      "backlog.create",
    ],
  });

  assert.equal(device.ok, true, device.ok === false ? device.error.message : undefined);
  assert.equal(device.value.capabilities.length, 4);

  // INVERTED at protocol v3: eight of the ten capabilities this test used to
  // require the validator to ACCEPT are no longer on the wire, and a device still
  // advertising one is speaking a version this build does not.
  for (const retired of [
    "artifacts.read",
    "sprintengines.create",
    "tasks.start",
    "artifacts.review",
    "agents.followUp",
    "backlog.start",
    "sprintengines.pr",
    "sprintengines.automation",
  ]) {
    const stale = validateMobileControlDevice({
      protocolVersion: mobileControlProtocolVersion,
      deviceId: "mobile-1",
      displayName: "Sprint Engine iPhone",
      platform: "ios",
      appVersion: "0.1.0",
      pairedAt: now,
      capabilities: ["snapshots.read", retired],
    });
    assert.equal(stale.ok, false, `${retired} left the wire and must no longer validate`);
  }

  const unknownCapability = validateMobileControlDevice({
    protocolVersion: mobileControlProtocolVersion,
    deviceId: "mobile-1",
    displayName: "Sprint Engine iPhone",
    platform: "ios",
    appVersion: "0.1.0",
    pairedAt: now,
    capabilities: ["backlog.destroy"],
  });
  assert.equal(unknownCapability.ok, false);
});

// Automations left the phone entirely, and the desktop is taking them off the
// wire. Five tests stood here pinning the `automations` collection's shape and
// the `automations.control` payload; what replaces them is the boundary itself.
test("automations are no longer anywhere on the wire", () => {
  // The command is refused at the envelope, by type, whatever its payload says.
  const command = validateMobileControlCommand({
    protocolVersion: mobileControlProtocolVersion,
    commandId: "cmd-automations-pause",
    type: "automations.control",
    issuedAt: now,
    deviceId: "mobile-1",
    payload: { workspacePath: "ws_2f6c1d", automationId: "auto-1", action: "pause" },
  });
  assert.equal(command.ok, false, "automations.control is no longer a command this wire defines");
  assert.equal(command.error.code, "invalid_payload");

  // Naming the retired collection is refused, not quietly dropped.
  const scoped = validateMobileControlCommand({
    protocolVersion: mobileControlProtocolVersion,
    commandId: "cmd-automations-collection",
    type: "snapshot.request",
    issuedAt: now,
    deviceId: "mobile-1",
    payload: { include: ["backlog", "automations"] },
  });
  assert.equal(scoped.ok, false, "automations is not a snapshot collection");
  assert.equal(scoped.error.code, "invalid_payload");

  // The capability is not one a device may carry.
  const device = validateMobileControlDevice({
    protocolVersion: mobileControlProtocolVersion,
    deviceId: "mobile-1",
    displayName: "Sprint Engine iPhone",
    platform: "ios",
    appVersion: "0.1.0",
    pairedAt: now,
    capabilities: ["snapshots.read", "automations.control"],
  });
  assert.equal(device.ok, false, "automations.control is not a capability");

  // `task_not_ready` was only ever the automations controller's answer to a
  // second run-now, so it went with them.
  const notReady = validateMobileControlError({
    protocolVersion: mobileControlProtocolVersion,
    code: "task_not_ready",
    message: "A run is already in flight.",
    retryable: false,
  });
  assert.equal(notReady.ok, false);

  // A desktop that still sends the collection is read, and the key is an unknown
  // field — ignored, whatever it holds. Nothing on this phone reads it, so even a
  // shape the old validator refused must not take the backlog down with it.
  const stray = makeDesktopShapedSnapshot();
  stray.commands.push("automations.control");
  stray.automations = [{ automationId: "auto-1", name: "n", status: "disabled", nextRunAt: null }];
  const read = validateMobileControlSnapshot(stray);
  assert.equal(read.ok, true, read.ok === false ? read.error.message : undefined);
  assert.equal(read.value.backlog[0].items.length, 2);
});

// A snapshot exactly as the v4 desktop producer composes one: backlog, and no
// `sprintEngines`, `workspaces`, `roadmaps` or `automations` key to omit — see
// the tests above.
function makeDesktopShapedSnapshot() {
  return {
    protocolVersion: mobileControlProtocolVersion,
    generatedAt: now,
    desktopSessionId: "desktop-session-1",
    snapshotVersion: "snap-1",
    commands: [
      "snapshot.request",
      "device.revoke",
      "backlog.update",
      "backlog.create",
    ],
    backlog: [
      {
        workspaceId: "backlog:ws_2f6c1d",
        workspacePath: "ws_2f6c1d",
        projectKey: "ws_2f6c1d",
        workspaceName: "mobile",
        updatedAt: now,
        items: [
          {
            itemId: "MM-70",
            relativePath: "backlog/2026-09-16-sprint-leaves-the-wire.md",
            title: "The Sprint Engine leaves the wire",
            status: "in_progress",
            type: "feature",
            difficulty: "m",
            criticality: "high",
            updatedAt: now,
          },
          {
            itemId: "MM-71",
            relativePath: "backlog/2026-09-16-something-else.md",
            title: "Something else",
            status: "idea",
            updatedAt: now,
          },
        ],
        epics: [
          {
            slug: "mobile-restrained-visual-reset",
            displayId: "MM-70",
            title: "The phone becomes sprintengine.ai",
            color: "green",
            doneCount: 1,
            totalCount: 4,
          },
        ],
      },
    ],
  };
}
