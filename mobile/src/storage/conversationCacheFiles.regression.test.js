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

// Android's file system as it answers an async read: the call names the file
// by id, and the native queue looks the id up only once it reaches the call,
// after the reads ahead of it. A file JS has let go of by then has been
// collected and its native half released, and the read rejects.
function androidPhone() {
  const v8 = require("node:v8");
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc");
  const files = new Map();
  const released = new Set();
  const collected = new FinalizationRegistry((id) => released.add(id));
  let nextId = 0;
  // One native queue: each read waits for the one before it.
  let queue = Promise.resolve();
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
      this.id = ++nextId;
      collected.register(this, this.id);
    }
    get exists() {
      return files.has(this.path);
    }
    info() {
      return { size: files.get(this.path)?.length };
    }
    text() {
      // Only the id and path cross to the queue, as only the id crosses JSI.
      const { id, path: where } = this;
      const read = queue.then(async () => {
        // The read ahead of it takes a while, and a streaming reply makes
        // garbage meanwhile.
        await new Promise((resolve) => setTimeout(resolve, 1));
        gc();
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (released.has(id)) throw new Error("Cannot use shared object that was already released");
        return files.get(where);
      });
      queue = read.catch(() => {});
      return read;
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
            digestStringAsync: async (_algorithm, text) => createHash("sha256").update(text).digest("hex"),
          };
        if (name === "expo-file-system") return { Directory, File, Paths: { document: { path: "/documents" } } };
        return localRequire(name);
      },
    },
    { filename: compiled },
  );
  return { cache: module.exports };
}

test("a file being read is held until its read settles, so collecting it cannot fail the write", async () => {
  const { cache } = androidPhone();
  // Two copies on disk, so each write reads two files, the second behind the first.
  for (let seq = 1; seq <= 2; seq++)
    await cache.updateConversationCache("device", key, (current) => ({ ...current, lastSeq: seq, events: [...current.events, event(seq)] }));
  for (let seq = 3; seq <= 12; seq++)
    await cache.updateConversationCache("device", key, (current) => ({ ...current, lastSeq: seq, events: [...current.events, event(seq)] }));
  const loaded = await cache.loadConversationCache("device", key);
  assert.equal(loaded.lastSeq, 12);
  assert.equal(loaded.events.map((item) => item.payload.text).join(""), "123456789101112");
});
