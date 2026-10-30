const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PERMISSION_PRESET_OPTIONS, newChatWorktreeOffered, offeredPermissionPresets, readCliRuntimes } = require("../../../.mobile-test-build/src/features/conversations/launchLogic.js");

test("cli.runtime.list is read strictly: only launchable CLIs, only named models", () => {
  const runtimes = readCliRuntimes({
    clis: [
      {
        id: "claude-code",
        displayName: "Claude Code",
        agentSelectable: true,
        supportsModelSelection: true,
        models: [{ id: "claude-opus-5", label: "Opus 5" }, { id: "opus[1m]" }, { label: "no id" }, "nope"],
      },
      // Registry-held for install/detect only. Every launch door refuses it, so
      // offering it would be drawing a button that cannot work.
      { id: "detect-only", displayName: "Detect Only", agentSelectable: false, models: [{ id: "m", label: "M" }] },
      { displayName: "no id", agentSelectable: true },
      "not a row",
    ],
  });

  assert.equal(runtimes.length, 1);
  assert.equal(runtimes[0].id, "claude-code");
  assert.equal(runtimes[0].supportsModelSelection, true);
  // A model with no label falls back to its id rather than rendering blank.
  assert.deepEqual(runtimes[0].models, [
    { id: "claude-opus-5", label: "Opus 5" },
    { id: "opus[1m]", label: "opus[1m]" },
  ]);

  assert.deepEqual(readCliRuntimes({ clis: "nope" }), []);
  assert.deepEqual(readCliRuntimes(null), []);
});

test("the permission presets are the desktop's four, in its menu's order and words", () => {
  const ids = PERMISSION_PRESET_OPTIONS.map((entry) => entry.id);
  assert.deepEqual(ids, ["manual", "auto", "bypass", "none"]);
  assert.deepEqual(
    PERMISSION_PRESET_OPTIONS.map((entry) => entry.chip),
    ["Manual", "Auto", "Bypass", "No flag"],
  );
  for (const entry of PERMISSION_PRESET_OPTIONS) {
    assert.ok(entry.label, "every preset needs a label for the pill");
    assert.ok(entry.hint, "and a hint for the picker row");
  }
});

test("Manual and Auto are offered only where the desktop runs them, and only what the CLI lists", () => {
  const ids = (input) => offeredPermissionPresets(input).map((entry) => entry.id);
  // A desktop without `conversation-permission-modes` reads Manual and Auto as
  // No flag: offering them there would promise a mode the chat never runs.
  assert.deepEqual(ids({ fourPresets: false }), ["bypass", "none"]);
  assert.deepEqual(ids({ fourPresets: false, listed: ["manual", "auto"] }), ["bypass", "none"]);
  assert.deepEqual(ids({ fourPresets: true }), ["manual", "auto", "bypass", "none"]);
  // A CLI that names no setting for Auto does not get it offered.
  assert.deepEqual(ids({ fourPresets: true, listed: ["none", "bypass", "manual"] }), ["manual", "bypass", "none"]);
  // An empty list is the desktop not saying, never "nothing may run".
  assert.deepEqual(ids({ fourPresets: true, listed: [] }), ["manual", "auto", "bypass", "none"]);
  // The preset a chat runs on is always in its menu.
  assert.deepEqual(ids({ fourPresets: false, current: "auto" }), ["auto", "bypass", "none"]);
});

test("cli.runtime.list names the presets each CLI can launch with, where the desktop lists them", () => {
  const [listed, older] = readCliRuntimes({
    clis: [
      { id: "codex", agentSelectable: true, permissionPresets: ["none", "auto", "bypass", "yolo"] },
      { id: "claude-code", agentSelectable: true },
    ],
  });
  assert.deepEqual(listed.permissionPresets, ["none", "auto", "bypass"]);
  assert.equal("permissionPresets" in older, false);
});

test("a CLI's chat that cannot run a preset is not offered it where the desktop listed nothing", () => {
  const ids = (input) => offeredPermissionPresets(input).map((entry) => entry.id);
  // Cursor edits without asking, so its chat refuses Manual; New with Cursor
  // on a desktop that sent no list, or a Cursor chat with no live session,
  // would otherwise offer it and get that refusal back.
  assert.deepEqual(ids({ fourPresets: true, cli: "cursor" }), ["auto", "bypass", "none"]);
  assert.deepEqual(ids({ fourPresets: true, cli: "claude-code" }), ["manual", "auto", "bypass", "none"]);
  // The desktop's own list for the chat is the answer when it gives one.
  assert.deepEqual(ids({ fourPresets: true, cli: "cursor", listed: ["none", "manual"] }), ["manual", "none"]);
  // And the chat's own preset always stays in its menu.
  assert.deepEqual(ids({ fourPresets: true, cli: "cursor", current: "manual" }), ["manual", "auto", "bypass", "none"]);
});

test("a started chat replaces the whole New flow, so Back returns to the list", () => {
  const { routesAfterNewChat } = require("../../../.mobile-test-build/src/features/conversations/launchLogic.js");
  const chat = { name: "Conversation" };
  const names = (routes) => routes.map((route) => route.name);
  assert.deepEqual(
    names(routesAfterNewChat([{ name: "HomeOverview" }, { name: "ChooseProject" }, { name: "NewChat" }], chat)),
    ["HomeOverview", "Conversation"],
    "the picker under the composer leaves too",
  );
  assert.deepEqual(
    names(routesAfterNewChat([{ name: "HomeOverview" }, { name: "Notices" }, { name: "NewChat" }], chat)),
    ["HomeOverview", "Notices", "Conversation"],
    "whatever opened New is where Back lands",
  );
  assert.deepEqual(names(routesAfterNewChat([{ name: "HomeOverview" }], chat)), ["HomeOverview", "Conversation"]);
});

test("a schedule made in New lands on the Scheduled list, once", () => {
  const { routesAfterSchedule } = require("../../../.mobile-test-build/src/features/conversations/launchLogic.js");
  const names = (routes) => routes.map((route) => route.name);
  assert.deepEqual(
    names(routesAfterSchedule([{ name: "HomeOverview" }, { name: "ChooseProject" }, { name: "NewChat" }], { name: "Scheduled" })),
    ["HomeOverview", "Scheduled"],
    "from the list's +: New leaves, and Back from the schedules is the chat list",
  );
  assert.deepEqual(
    names(
      routesAfterSchedule(
        [{ name: "HomeOverview" }, { name: "SettingsHome" }, { name: "Scheduled" }, { name: "ChooseProject" }, { name: "NewChat" }],
        { name: "Scheduled" },
      ),
    ),
    ["HomeOverview", "SettingsHome", "Scheduled"],
    "from the Scheduled list's New: back to that list, not a second one",
  );
});

test("New offers Worktree where the desktop takes it and the folder can be forked, and defaults to offering it", () => {
  const offered = (input) => newChatWorktreeOffered({ advertised: true, folderPath: "/Users/dev/app", git: true, ...input });
  assert.equal(offered({}), true);
  // An older desktop would start the chat in the checkout without a word.
  assert.equal(offered({ advertised: false }), false);
  // A folder on an SSH machine is not the desktop's to fork, as its New chat says.
  assert.equal(offered({ folderPath: "ssh://build-box/home/dev/app" }), false);
  // The checkout read found no repository.
  assert.equal(offered({ git: false }), false);
  // Not read yet, or the read failed: offered, and the desktop's refusal says why if it cannot.
  assert.equal(offered({ git: null }), true);
  assert.equal(offered({ folderPath: null, git: null }), true);
});
