/* global __dirname */
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

// The connection supervisor is a byte-for-byte copy of
// packages/connection-supervisor/src/connectionSupervisor.ts in SprintEngine
// Studio, whose own suite tests its behaviour. Both sides pin this digest:
// update the two copies and the two pins together.
test("the supervisor matches the desktop's source, byte for byte", () => {
  const hash = createHash("sha256");
  hash.update("connectionSupervisor.ts");
  hash.update("\0");
  hash.update(readFileSync(join(__dirname, "connectionSupervisor.ts")));
  assert.equal(hash.digest("hex"), "e67d35f24a6d79d386f96b70693ad1b7aa538e3c860f3b026c3374bc72ed459b");
});
