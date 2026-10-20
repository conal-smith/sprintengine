/* global __dirname */
// The phone's conversation cache over its file system, with the native hash
// and files stood in for, counting the native calls each load and write costs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const compiled = path.resolve(__dirname, "../../.mobile-test-build/src/storage/conversationCache.js");
const localRequire = createRequire(compiled);

function phone() {
  const files = new Map();
  const calls = { digests: 0 };
  class Directory {
    constructor(parent, name) {
      this.path = `${parent.path ?? parent}/${name}`;
    }
    get exists() {
      return [...files.keys()].some((key) => key.startsWith(`${this.path}/`));
    }
    create() {}
    list() {
      return [...files.keys()]
        .filter((key) => key.startsWith(`${this.path}/`))
        .map((key) => new File(this, key.slice(this.path.length + 1)));
    }
  }
  class File {
    constructor(directory, name) {
      this.name = name;
      this.path = `${directory.path}/${name}`;
    }
    get exists() {
      return files.has(this.path);
    }
    info() {
      return { size: files.get(this.path)?.length };
    }
    text() {
      return files.get(this.path);
    }
    write(text) {
      files.set(this.path, text);
    }
    delete() {
      files.delete(this.path);
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(compiled, "utf8"),
    {
      exports: module.exports,
      module,
      require(name) {
        if (name === "expo-crypto")
          return {
            CryptoDigestAlgorithm: { SHA256: "SHA-256" },
            digestStringAsync: async (_algorithm, text) => {
              calls.digests++;
              return createHash("sha256").update(text).digest("hex");
            },
          };
        if (name === "expo-file-system") return { Directory, File, Paths: { document: { path: "/documents" } } };
        return localRequire(name);
      },
    },
    { filename: compiled },
  );
  return { cache: module.exports, files, calls };
}
const key = { workspaceId: "w", agentId: "a" };
const event = (seq) => ({
  id: `e-${seq}`,
  seq,
  type: "content_delta",
  sessionId: "s",
  workspaceId: "w",
  agentId: "a",
  createdAt: seq,
  payload: { text: `${seq}` },
});

test("a chat's file name is hashed once per run, not on every load and write", async () => {
  const { cache, files, calls } = phone();
  assert.equal(await cache.loadConversationCache("device", key), null);
  for (let seq = 1; seq <= 20; seq++)
    await cache.updateConversationCache("device", key, (current) => ({ ...current, lastSeq: seq, events: [...current.events, event(seq)] }));
  const loaded = await cache.loadConversationCache("device", key);
  assert.equal(loaded.lastSeq, 20);
  // 22 native hashes before (one per load and per write).
  assert.equal(calls.digests, 1);
  const expected = createHash("sha256").update("device\0w\0a").digest("hex");
  assert.deepEqual([...files.keys()].sort(), [
    `/documents/conversation-cache/${expected}-0.json`,
    `/documents/conversation-cache/${expected}-1.json`,
  ]);
  // Another desktop's copy of the same chat ids is its own file.
  await cache.saveConversationCache("other", key, { lastSeq: 1, events: [event(1)], pending: [] });
  assert.equal(calls.digests, 2);
  assert.equal((await cache.loadConversationCache("device", key)).lastSeq, 20);
});
