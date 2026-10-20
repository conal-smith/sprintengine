/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const buildRoot = path.resolve(__dirname, "../../.mobile-test-build");
const {
  createProjectContextStore,
  createSessionListStore,
  createThemePreferenceStore,
  readStoredProjectKey,
  readStoredSessionList,
  readStoredStarredProjectKeys,
  readThemePreference,
  upsertSessionIntoList,
} = require(path.join(buildRoot, "src/storage/sessionStore.js"));
const {
  mergeLegacyTailnetSessions,
  relayCleanupMarkerKey,
  sessionFromLegacyRecord,
  sweepRelayRecords,
} = require(path.join(buildRoot, "src/storage/relayCleanup.js"));
const {
  fleetHeadline,
  orderSessionsForFleet,
  summarizeSnapshotForFleet,
} = require(path.join(buildRoot, "src/features/fleet/fleetLogic.js"));

function makeSession(overrides = {}) {
  return {
    deviceId: "device_1",
    desktopName: "Work desktop",
    baseUrl: "http://mac-mini.tail1234.ts.net:8471",
    deviceToken: "mctn_token",
    pairedAt: "2026-06-11T00:00:00.000Z",
    tailnetScopes: ["workspace:read"],
    ...overrides,
  };
}

// The shapes a relay-era build stored under the v2 list key: a tailnet pairing
// in relay-named fields, and a relay pairing.
function legacyTailnetRecord(overrides = {}) {
  return {
    deviceId: "tnd_phone1",
    desktopName: "Desktop on 100.64.0.9",
    relayUrl: "http://100.64.0.9:8471",
    pairedAt: "2026-09-02T00:00:00.000Z",
    status: "online",
    transport: "tailnet",
    tailnetScopes: ["workspace:read", "workspace:operate", "conversation:operate"],
    tailnetTransportVersion: 2,
    tailnetCapabilities: ["conversations"],
    credentials: {
      pairedDeviceId: "tnd_phone1",
      desktopRelaySessionId: "tailnet:100.64.0.9:8471",
      relayToken: "mctn_secret",
      relayTokenExpiresAt: "2126-01-01T00:00:00.000Z",
      scopes: ["relay:snapshot:read", "relay:backlog:update"],
      devicePublicKey: "",
    },
    ...overrides,
  };
}

function legacyRelayRecord(overrides = {}) {
  return {
    deviceId: "pdv_relay",
    desktopName: "Dev workstation",
    relayUrl: "https://relay.example.com",
    pairedAt: "2026-06-11T00:00:00.000Z",
    credentials: {
      pairedDeviceId: "pdv_relay",
      desktopRelaySessionId: "drs_1",
      relayToken: "relay-token",
      relayTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["relay:snapshot:read"],
      devicePublicKey: "mdev_abc",
    },
    ...overrides,
  };
}

function makeAdapter(initial = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    isAvailable: async () => true,
    getItem: async (key) => items.get(key) ?? null,
    setItem: async (key, value) => {
      items.set(key, value);
    },
    deleteItem: async (key) => {
      items.delete(key);
    },
  };
}

test("a pairing survives a relaunch, and a malformed record is dropped rather than misread", async () => {
  const adapter = makeAdapter();
  await createSessionListStore(adapter).upsertSession(makeSession({ tailnetScopes: ["workspace:operate"] }));

  const reloaded = await createSessionListStore(adapter).getSessionList();
  assert.equal(reloaded.schemaVersion, 3);
  assert.deepEqual(reloaded.sessions, [makeSession({ tailnetScopes: ["workspace:operate"] })]);
  assert.ok(adapter.items.has("multicode.mobile.sessions.v3"));

  adapter.items.set(
    "multicode.mobile.sessions.v3",
    JSON.stringify({
      schemaVersion: 3,
      sessions: [makeSession(), makeSession({ deviceId: "d2", deviceToken: "" }), makeSession({ deviceId: "d3", status: "lost" })],
      activeDeviceId: "device_1",
    }),
  );
  const filtered = await createSessionListStore(adapter).getSessionList();
  assert.deepEqual(
    filtered.sessions.map((session) => session.deviceId),
    ["device_1"],
  );
});

test("the relay sweep moves tailnet pairings into v3, drops relay pairings, and clears the relay-era keys", async () => {
  const adapter = makeAdapter({
    "multicode.mobile.sessions.v2": JSON.stringify({
      schemaVersion: 2,
      sessions: [legacyRelayRecord(), legacyTailnetRecord()],
      activeDeviceId: "pdv_relay",
    }),
    "multicode.mobile.session.v1": JSON.stringify(legacyRelayRecord({ deviceId: "pdv_old" })),
    "multicode.mobile.auth.tokens.v1": JSON.stringify({ accessToken: "a", refreshToken: "r" }),
    "multicode.mobile.auth.pending.v1": JSON.stringify({ state: "s" }),
    // What the sweep must never touch.
    "multicode.mobile.workspace.v2": "pk_1",
    "multicode.mobile.starred.v2": JSON.stringify(["pk_1"]),
    "multicode.mobile.threadsOpened.v1": JSON.stringify({ t1: 1 }),
  });

  await sweepRelayRecords(adapter);

  const list = await createSessionListStore(adapter).getSessionList();
  assert.deepEqual(list.sessions, [
    {
      deviceId: "tnd_phone1",
      desktopName: "Desktop on 100.64.0.9",
      baseUrl: "http://100.64.0.9:8471",
      deviceToken: "mctn_secret",
      pairedAt: "2026-09-02T00:00:00.000Z",
      tailnetScopes: ["workspace:read", "workspace:operate", "conversation:operate"],
      tailnetTransportVersion: 2,
      tailnetCapabilities: ["conversations"],
      status: "online",
    },
  ]);
  // The relay pairing that was active is gone, so the surviving pairing leads.
  assert.equal(list.activeDeviceId, "tnd_phone1");
  for (const key of [
    "multicode.mobile.sessions.v2",
    "multicode.mobile.session.v1",
    "multicode.mobile.auth.tokens.v1",
    "multicode.mobile.auth.pending.v1",
  ]) {
    assert.equal(adapter.items.has(key), false, `${key} is swept`);
  }
  assert.equal(adapter.items.get("multicode.mobile.workspace.v2"), "pk_1");
  assert.equal(adapter.items.get("multicode.mobile.starred.v2"), JSON.stringify(["pk_1"]));
  assert.equal(adapter.items.get("multicode.mobile.threadsOpened.v1"), JSON.stringify({ t1: 1 }));
  assert.equal(adapter.items.get(relayCleanupMarkerKey), "done");
});

test("the relay sweep runs once, and the secure list store runs it before its first read", async () => {
  const adapter = makeAdapter({
    "multicode.mobile.sessions.v2": JSON.stringify({ schemaVersion: 2, sessions: [legacyTailnetRecord()], activeDeviceId: null }),
  });
  let sweeps = 0;
  const store = createSessionListStore(adapter, {
    prepare: async () => {
      sweeps += 1;
      await sweepRelayRecords(adapter);
    },
  });
  // Two reads racing at launch still share one sweep, and both see its result.
  const [first, second] = await Promise.all([store.getSessionList(), store.getSessionList()]);
  assert.equal(sweeps, 1);
  assert.deepEqual(first.sessions.map((session) => session.deviceId), ["tnd_phone1"]);
  assert.deepEqual(second.sessions.map((session) => session.deviceId), ["tnd_phone1"]);

  // Once marked done, a relay-era key that reappears is not reread.
  adapter.items.set(
    "multicode.mobile.sessions.v2",
    JSON.stringify({ schemaVersion: 2, sessions: [legacyTailnetRecord({ deviceId: "tnd_other", relayUrl: "http://100.64.0.10:8471" })] }),
  );
  await sweepRelayRecords(adapter);
  assert.ok(adapter.items.has("multicode.mobile.sessions.v2"));
  assert.deepEqual(
    (await createSessionListStore(adapter).getSessionList()).sessions.map((session) => session.deviceId),
    ["tnd_phone1"],
  );
});

test("a sweep interrupted after writing v3 never lets a legacy copy replace a newer pairing", () => {
  const current = { schemaVersion: 3, sessions: [makeSession({ deviceId: "tnd_phone1", baseUrl: "http://100.64.0.9:8471", desktopName: "Renamed" })], activeDeviceId: "tnd_phone1" };
  const legacy = [sessionFromLegacyRecord(legacyTailnetRecord())];
  assert.equal(mergeLegacyTailnetSessions(current, legacy, "tnd_phone1"), current);

  const added = mergeLegacyTailnetSessions(
    { schemaVersion: 3, sessions: [], activeDeviceId: null },
    legacy,
    "tnd_phone1",
  );
  assert.deepEqual(added.sessions.map((session) => session.deviceId), ["tnd_phone1"]);
  assert.equal(added.activeDeviceId, "tnd_phone1");
});

test("a relay-era tailnet record without its own grant keeps what its mapped scopes allowed", () => {
  const withoutGrant = legacyTailnetRecord({ tailnetScopes: undefined });
  assert.deepEqual(sessionFromLegacyRecord(withoutGrant).tailnetScopes, ["workspace:operate"]);
  const readOnly = legacyTailnetRecord({
    tailnetScopes: undefined,
    credentials: { ...legacyTailnetRecord().credentials, scopes: ["relay:snapshot:read"] },
  });
  assert.deepEqual(sessionFromLegacyRecord(readOnly).tailnetScopes, ["workspace:read"]);

  // A relay pairing, or anything that is not a well-formed tailnet record, is not carried over.
  assert.equal(sessionFromLegacyRecord(legacyRelayRecord()), null);
  assert.equal(sessionFromLegacyRecord(legacyTailnetRecord({ transport: "relay" })), null);
  assert.equal(sessionFromLegacyRecord(legacyTailnetRecord({ credentials: {} })), null);
  assert.equal(sessionFromLegacyRecord(null), null);
});

test("pairing additional desktops is additive and selecting/removing keeps others intact", async () => {
  const adapter = makeAdapter();
  const store = createSessionListStore(adapter);

  await store.upsertSession(makeSession());
  const second = makeSession({
    deviceId: "device_2",
    desktopName: "Home desktop",
    baseUrl: "http://build-box.tail1234.ts.net:8471",
  });
  let list = await store.upsertSession(second);
  assert.equal(list.sessions.length, 2);
  assert.equal(list.activeDeviceId, "device_2", "newly paired desktop becomes active");

  list = await store.setActiveSession("device_1");
  assert.equal(list.activeDeviceId, "device_1");

  list = await store.removeSession("device_1");
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].deviceId, "device_2");
  assert.equal(list.activeDeviceId, "device_2", "active falls back to a remaining desktop");
});

test("re-pairing the same desktop replaces the stale entry instead of duplicating it", () => {
  const original = makeSession();
  const repaired = makeSession({ deviceId: "device_9", deviceToken: "mctn_new" });

  const sessions = upsertSessionIntoList([original], repaired);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].deviceId, "device_9");

  const differentDesktop = makeSession({ deviceId: "device_3", baseUrl: "http://build-box.tail1234.ts.net:8471" });
  assert.equal(upsertSessionIntoList(sessions, differentDesktop).length, 2);
});

test("readStoredSessionList drops malformed entries and falls back to the first pairing", () => {
  const list = readStoredSessionList(
    JSON.stringify({
      schemaVersion: 3,
      sessions: [makeSession(), makeSession({ deviceId: "device_2", status: "stale" }), { nonsense: true }],
      activeDeviceId: "device_missing",
    }),
  );

  assert.equal(list.sessions.length, 2);
  assert.equal(list.sessions[1].status, "stale");
  assert.equal(list.activeDeviceId, "device_1", "unknown active falls back to the first session");
  assert.deepEqual(readStoredSessionList("not json").sessions, []);
});

test("fleet ordering puts online desktops first and revoked last", () => {
  const ordered = orderSessionsForFleet([
    makeSession({ deviceId: "d_revoked", status: "revoked", desktopName: "Revoked" }),
    makeSession({ deviceId: "d_online", status: "online", desktopName: "Online" }),
    makeSession({ deviceId: "d_stale", status: "stale", desktopName: "Stale" }),
  ]);
  assert.deepEqual(
    ordered.map((session) => session.deviceId),
    ["d_online", "d_stale", "d_revoked"],
  );
});

test("fleet summary reads headline counts defensively from a snapshot", () => {
  const summary = summarizeSnapshotForFleet({
    // An older desktop still sends `sprintEngines`; the summary no longer reads
    // it, and must not trip over it either.
    // A `workspaces` key (gone from the wire at v4, and always empty before
    // that) is not counted either: projects are the backlog groups.
    sprintEngines: [{ board: { needsInput: 2 } }, { board: { needsInput: 0 } }, "junk"],
    workspaces: [{}, {}, {}],
    backlog: [{ items: [{}, {}] }, { items: "junk" }, "junk"],
  });
  assert.deepEqual(summary, { projectCount: 2, backlogItemCount: 2 });
  assert.equal(fleetHeadline(summary), "2 projects · 2 backlog items");
  assert.equal(fleetHeadline({ projectCount: 1, backlogItemCount: 0 }), "1 project");

  assert.deepEqual(summarizeSnapshotForFleet(null), {
    projectCount: 0,
    backlogItemCount: 0,
  });
});

test("theme preference reads back only known values and round-trips through the adapter", async () => {
  for (const valid of ["system", "light", "dark"]) {
    assert.equal(readThemePreference(valid), valid);
  }
  // Unknown or absent values must not resolve to a guessed theme; the provider
  // falls back to following the system appearance instead.
  for (const invalid of [null, "", "paper", "Dark", "{}"]) {
    assert.equal(readThemePreference(invalid), null);
  }
  // The light theme was called "herbarium" until 2026-09-01; a phone that pinned
  // it keeps a light theme rather than silently dropping back to system.
  assert.equal(readThemePreference("herbarium"), "light");

  const items = new Map();
  const adapter = {
    isAvailable: async () => true,
    getItem: async (key) => items.get(key) ?? null,
    setItem: async (key, value) => void items.set(key, value),
    deleteItem: async (key) => void items.delete(key),
  };

  const store = createThemePreferenceStore(adapter);
  assert.equal(await store.getPreference(), null);
  await store.savePreference("light");
  assert.equal(items.get("multicode.mobile.theme.v1"), "light");
  assert.equal(await createThemePreferenceStore(adapter).getPreference(), "light");
});

test("theme preference reports a failed write instead of a fake success when storage is unavailable", async () => {
  const adapter = {
    isAvailable: async () => false,
    getItem: async () => assert.fail("must not read unavailable storage"),
    setItem: async () => assert.fail("must not write unavailable storage"),
    deleteItem: async () => assert.fail("must not delete from unavailable storage"),
  };

  const store = createThemePreferenceStore(adapter);
  assert.equal(await store.getPreference(), null);

  // The write must reject: ThemeProvider turns that rejection into the
  // session-only warning in Settings. Resolving here would hide it.
  await assert.rejects(() => store.savePreference("dark"), /not persisted/);

  // ...and the choice still applies for the rest of this session.
  assert.equal(await store.getPreference(), "dark");
});

test("the agent characters switch round-trips beside the theme, and reads unset as never chosen", async () => {
  const items = new Map();
  const adapter = {
    isAvailable: async () => true,
    getItem: async (key) => items.get(key) ?? null,
    setItem: async (key, value) => void items.set(key, value),
    deleteItem: async (key) => void items.delete(key),
  };

  const store = createThemePreferenceStore(adapter);
  // Null, not false: the provider reads "never chosen" as on.
  assert.equal(await store.getAgentCharacters(), null);
  await store.saveAgentCharacters(false);
  assert.equal(items.get("multicode.mobile.agentCharacters.v1"), "off");
  assert.equal(await createThemePreferenceStore(adapter).getAgentCharacters(), false);
  await store.saveAgentCharacters(true);
  assert.equal(await createThemePreferenceStore(adapter).getAgentCharacters(), true);

  items.set("multicode.mobile.agentCharacters.v1", "maybe");
  assert.equal(await createThemePreferenceStore(adapter).getAgentCharacters(), null);

  // Unavailable storage rejects the write but keeps the choice for the session.
  const offline = createThemePreferenceStore({ ...adapter, isAvailable: async () => false });
  await assert.rejects(() => offline.saveAgentCharacters(false), /not persisted/);
  assert.equal(await offline.getAgentCharacters(), false);
});

test("theme preference surfaces a rejected write from the adapter itself", async () => {
  const adapter = {
    isAvailable: async () => true,
    getItem: async () => null,
    setItem: async () => {
      throw new Error("keychain locked");
    },
    deleteItem: async () => undefined,
  };

  const store = createThemePreferenceStore(adapter);
  await assert.rejects(() => store.savePreference("light"), /keychain locked/);
  assert.equal(await store.getPreference(), null, "a failed write leaves nothing durable behind");
});

// --- Project context (epic 37: current project + starred projects) -----------

test("the current project survives a relaunch", async () => {
  const adapter = makeAdapter();
  const store = createProjectContextStore(adapter);

  assert.equal(await store.getCurrentProjectKey(), null, "a cold start has chosen nothing");

  await store.saveCurrentProjectKey("/repos/alpha");

  // A fresh store over the same storage is what a relaunch actually is.
  const relaunched = createProjectContextStore(adapter);
  assert.equal(await relaunched.getCurrentProjectKey(), "/repos/alpha");
});

test("starred projects survive a relaunch, in the order they were starred", async () => {
  const adapter = makeAdapter();
  const store = createProjectContextStore(adapter);

  assert.deepEqual(await store.getStarredProjectKeys(), []);
  await store.saveStarredProjectKeys(["/repos/beta", "/repos/alpha"]);

  const relaunched = createProjectContextStore(adapter);
  assert.deepEqual(await relaunched.getStarredProjectKeys(), ["/repos/beta", "/repos/alpha"]);
});

test("a project switch still applies for the session when storage is unavailable", async () => {
  const adapter = {
    isAvailable: async () => false,
    getItem: async () => assert.fail("must not read unavailable storage"),
    setItem: async () => assert.fail("must not write unavailable storage"),
    deleteItem: async () => assert.fail("must not delete from unavailable storage"),
  };

  const store = createProjectContextStore(adapter);

  // Unlike the theme preference, this must NOT reject: the app has to follow the
  // tap even where nothing can be persisted. The choice simply does not outlive
  // the session, which beats not switching at all.
  await store.saveCurrentProjectKey("/repos/alpha");
  assert.equal(await store.getCurrentProjectKey(), "/repos/alpha");

  await store.saveStarredProjectKeys(["/repos/alpha"]);
  assert.deepEqual(await store.getStarredProjectKeys(), ["/repos/alpha"]);
});

test("an unreadable stored project key reads as 'nothing chosen'", () => {
  assert.equal(readStoredProjectKey(null), null);
  assert.equal(readStoredProjectKey(""), null);
  assert.equal(readStoredProjectKey("   "), null, "a blank key is not a project named ''");
  assert.equal(readStoredProjectKey("  /repos/alpha  "), "/repos/alpha");
});

test("a corrupt starred-projects value degrades to no stars, never to a crash", () => {
  assert.deepEqual(readStoredStarredProjectKeys(null), []);
  assert.deepEqual(readStoredStarredProjectKeys("{not json"), []);
  assert.deepEqual(readStoredStarredProjectKeys('{"a":1}'), [], "an object is not a star list");
  // Junk entries are dropped; the survivors are kept and deduped.
  assert.deepEqual(readStoredStarredProjectKeys('["/repos/a", 7, "", null, "/repos/a", "/repos/b"]'), [
    "/repos/a",
    "/repos/b",
  ]);
});
