/* global __dirname */
// The desktop snapshot the data provider reads: how often a phone sitting on
// the chat list asks for it. The provider runs under a deterministic
// state/effect runner with its timers and app-state events in the test's
// hands, against a desktop that counts the snapshot reads it serves.
//
// The provider imports the backlog screens' types, and through them React
// Navigation, which the CommonJS test build cannot take; so this suite
// transpiles the provider alone, types dropped, and serves its imports from
// the test build.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const ts = require("typescript");
const sourcePath = path.resolve(__dirname, "SessionDataProvider.tsx");
const compiled = path.resolve(__dirname, "../../.mobile-test-build/src/navigation/SessionDataProvider.js");
const localRequire = createRequire(compiled);
const source = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  fileName: sourcePath,
}).outputText;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const desktop = {
  deviceId: "d1",
  desktopName: "Desktop",
  baseUrl: "https://desktop.example.ts.net",
  deviceToken: "token",
  pairedAt: "2026-01-01T00:00:00.000Z",
  tailnetScopes: ["workspace:operate"],
  status: "online",
};

function harness() {
  const slots = [];
  let effects = [];
  let cursor = 0;
  let provided = null;
  const reads = { snapshot: 0 };
  const intervals = new Map();
  let nextTimer = 0;
  const appState = new Set();
  const react = {
    createContext: () => ({ Provider: "Provider" }),
    useContext: () => provided,
    useRef(value) {
      const i = cursor++;
      return (slots[i] ??= { current: value });
    },
    useState(value) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: typeof value === "function" ? value() : value };
      return [
        slots[i].value,
        (next) => {
          slots[i].value = typeof next === "function" ? next(slots[i].value) : next;
        },
      ];
    },
    useMemo(factory, deps) {
      const i = cursor++;
      const old = slots[i];
      if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) slots[i] = { value: factory(), deps };
      return slots[i].value;
    },
    useCallback(callback, deps) {
      return react.useMemo(() => callback, deps);
    },
    useEffect(callback, deps) {
      const i = cursor++;
      const old = slots[i];
      if (!old || !deps || deps.some((value, index) => !Object.is(value, old.deps[index])))
        effects.push(() => {
          old?.cleanup?.();
          slots[i] = { deps, cleanup: callback() };
        });
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(
    source,
    {
      exports: module.exports,
      module,
      setInterval: (fn) => {
        const id = ++nextTimer;
        intervals.set(id, fn);
        return id;
      },
      clearInterval: (id) => intervals.delete(id),
      require(name) {
        if (name === "react") return react;
        if (name === "react/jsx-runtime")
          return {
            jsx: (_type, props) => {
              provided = props.value;
              return null;
            },
          };
        if (name === "expo-haptics") return {};
        if (name === "react-native")
          return {
            AppState: {
              addEventListener: (_event, listener) => {
                appState.add(listener);
                return { remove: () => appState.delete(listener) };
              },
            },
          };
        if (name.endsWith("/components/Toast")) return { useToast: () => ({ show() {} }) };
        if (name.endsWith("/api/tailnetControlClient")) {
          const real = localRequire(name);
          return {
            ...real,
            tailnetClientForSession: () => ({
              readSnapshot: async () => {
                reads.snapshot++;
                await tick();
                return { ok: true, data: { unchanged: true } };
              },
            }),
          };
        }
        return localRequire(name);
      },
    },
    { filename: compiled },
  );
  const noop = () => undefined;
  const props = {
    session: desktop,
    sessions: [desktop],
    activeDeviceId: "d1",
    selectedProjectKey: null,
    starredProjectKeys: [],
    onSelectProject: noop,
    onStarredProjectKeysChange: noop,
    onSelectSession: noop,
    onRemoveSession: noop,
    onRenameSession: noop,
    onSessionConnected: noop,
    onSessionRevoked: noop,
    onDisconnect: noop,
    children: null,
  };
  const render = () => {
    cursor = 0;
    module.exports.SessionDataProvider(props);
    const pending = effects;
    effects = [];
    for (const effect of pending) effect();
    return provided;
  };
  return {
    render,
    reads,
    /** Twenty seconds pass: every polling interval fires once. */
    poll() {
      for (const fn of [...intervals.values()]) fn();
    },
    foreground() {
      for (const listener of [...appState]) listener("active");
    },
  };
}

async function sitOnTheChatList(h, { minutes = 1 } = {}) {
  h.render();
  await tick();
  h.render();
  for (let i = 0; i < minutes * 3; i++) {
    h.poll();
    await tick();
    h.render();
  }
  h.foreground();
  await tick();
  h.render();
}

test("a phone on the chat list does not read the desktop snapshot nothing on it shows", async () => {
  const h = harness();
  await sitOnTheChatList(h);
  if (process.env.MEASURE_SNAPSHOT) console.log("snapshot reads, a minute on the chat list and one foreground", h.reads.snapshot);
  assert.equal(h.reads.snapshot, 0);
});

test("a screen that draws from the snapshot has it read at once, polled while open, and let go when it closes", async () => {
  const h = harness();
  h.render();
  await tick();
  const release = h.render().watchSnapshot();
  h.render();
  await tick();
  h.render();
  assert.equal(h.reads.snapshot, 1, "read when the screen opens");
  h.poll();
  await tick();
  h.foreground();
  await tick();
  h.render();
  assert.equal(h.reads.snapshot, 3, "polled, and read on foreground, while it is open");
  release();
  release();
  h.render();
  h.poll();
  h.foreground();
  await tick();
  h.render();
  assert.equal(h.reads.snapshot, 3, "nothing once it has closed");
  assert.equal(h.render().snapshotState, "ready", "what was read stays");
});
