/* global __dirname */
// What a cold start asks the keychain for, before the chat list can know
// which desktops are paired. The stores are the app's own, made as App.tsx
// and the providers make them, over a keychain stand-in that counts its calls
// and answers each some turns of the event loop later, as the native module does.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const buildRoot = path.resolve(__dirname, "../../.mobile-test-build");
const sessionStore = require(path.join(buildRoot, "src/storage/sessionStore.js"));
const { sweepRelayRecords, relayCleanupMarkerKey } = require(path.join(buildRoot, "src/storage/relayCleanup.js"));

const tick = () => new Promise((resolve) => setImmediate(resolve));
// Each keychain call answers ten turns later, so the turns a value takes,
// divided by ten, is how many calls stood in line before it.
const LATENCY = 10;
const native = async () => {
  for (let i = 0; i < LATENCY; i++) await tick();
};
const pairing = {
  deviceId: "d1",
  desktopName: "Desktop",
  baseUrl: "http://100.64.0.1:8471",
  deviceToken: "token",
  pairedAt: "2026-01-01T00:00:00.000Z",
  tailnetScopes: ["workspace:read"],
};

function keychain() {
  const items = new Map([
    [relayCleanupMarkerKey, "done"],
    [sessionStore.sessionListKey, JSON.stringify({ schemaVersion: 3, sessions: [pairing], activeDeviceId: "d1" })],
  ]);
  const calls = { isAvailable: 0, getItem: 0 };
  return {
    calls,
    adapter: {
      isAvailable: async () => {
        calls.isAvailable++;
        await native();
        return true;
      },
      getItem: async (key) => {
        calls.getItem++;
        await native();
        return items.get(key) ?? null;
      },
      setItem: async (key, value) => {
        await tick();
        items.set(key, value);
      },
      deleteItem: async (key) => {
        await tick();
        items.delete(key);
      },
    },
  };
}

/** Every read a cold start makes, in the order the app makes them; resolves with the turns the pairing list took. */
async function coldStart(adapter) {
  const theme = sessionStore.createThemePreferenceStore(adapter);
  const sessions = sessionStore.createSessionListStore(adapter, { prepare: () => sweepRelayRecords(adapter) });
  const project = sessionStore.createProjectContextStore(adapter);
  const notes = sessionStore.createDeviceNotesStore(adapter);
  let turns = 0;
  let pairingsAt = null;
  const reads = [
    theme.getPreference(),
    theme.getAgentCharacters(),
    sessions.getSessionList().then((list) => {
      pairingsAt = turns;
      return list;
    }),
    project.getCurrentProjectKey(),
    project.getStarredProjectKeys(),
    notes.getChatsOpened(),
    notes.getReadNoticeIds(),
  ];
  let done = false;
  const all = Promise.all(reads).then((values) => {
    done = true;
    return values;
  });
  while (!done) {
    await tick();
    turns++;
  }
  const values = await all;
  return { callsBeforePairings: Math.round(pairingsAt / LATENCY), list: values[2] };
}

test("a cold start asks whether the keychain is there once, not once per read", async () => {
  const { adapter, calls } = keychain();
  const { list, callsBeforePairings } = await coldStart(sessionStore.rememberAvailability(adapter));
  if (process.env.MEASURE_STARTUP) console.log("cold start keychain", JSON.stringify({ ...calls, callsBeforePairings }));
  assert.deepEqual(list.sessions.map((session) => session.deviceId), ["d1"]);
  assert.equal(calls.isAvailable, 1);
  assert.equal(calls.getItem, 8);
  assert.equal(callsBeforePairings, 2, "availability, then the sweep's marker and the list side by side");
});

test("on the launch that sweeps, the list is read again after the sweep wrote it", async () => {
  const { adapter } = keychain();
  const relayEra = {
    ...adapter,
    getItem: async (key) => {
      if (key === relayCleanupMarkerKey) return null;
      if (key === "multicode.mobile.sessions.v2")
        return JSON.stringify({
          schemaVersion: 2,
          sessions: [
            {
              deviceId: "tnd_moved",
              desktopName: "Desktop on 100.64.0.9",
              relayUrl: "http://100.64.0.9:8471",
              transport: "tailnet",
              pairedAt: "2026-09-02T00:00:00.000Z",
              credentials: { relayToken: "moved-token", scopes: [] },
              tailnetScopes: ["workspace:read"],
            },
          ],
          activeDeviceId: null,
        });
      return adapter.getItem(key);
    },
  };
  const { list } = await coldStart(sessionStore.rememberAvailability(relayEra));
  assert.deepEqual(list.sessions.map((session) => session.deviceId).sort(), ["d1", "tnd_moved"]);
});

test("an unavailable answer is asked again, so storage that comes back is used", async () => {
  let available = false;
  let asked = 0;
  const adapter = sessionStore.rememberAvailability({
    isAvailable: async () => {
      asked++;
      return available;
    },
    getItem: async () => null,
    setItem: async () => undefined,
    deleteItem: async () => undefined,
  });
  assert.equal(await adapter.isAvailable(), false);
  available = true;
  assert.equal(await adapter.isAvailable(), true);
  assert.equal(await adapter.isAvailable(), true);
  assert.equal(asked, 2);
});
