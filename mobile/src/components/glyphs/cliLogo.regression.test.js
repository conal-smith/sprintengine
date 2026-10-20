/* global __dirname */
// Pure
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// A runtime wears the same logo on the phone as on the desktop. This pins the
// CLI-to-logo mapping to the desktop's, plus the phone's wider Claude match.

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build/src/components/glyphs");
const { resolveCliLogoKind } = require(path.join(buildRoot, "cliLogoKind.js"));

test("each desktop CLI id resolves to its own logo", () => {
  assert.equal(resolveCliLogoKind("claude-code"), "claude-code");
  assert.equal(resolveCliLogoKind("codex"), "codex");
  assert.equal(resolveCliLogoKind("opencode"), "opencode");
  assert.equal(resolveCliLogoKind("zai"), "zai");
  assert.equal(resolveCliLogoKind("grok"), "grok");
  assert.equal(resolveCliLogoKind("cursor"), "cursor");
  assert.equal(resolveCliLogoKind("muse"), "muse");
});

test("both Kimi runtimes share the Kimi logo, including the one that runs through Claude Code", () => {
  assert.equal(resolveCliLogoKind("kimi-code"), "kimi");
  assert.equal(resolveCliLogoKind("kimi-claude"), "kimi");
});

test("a bare 'claude' and any 'claude' variant read as Claude Code", () => {
  assert.equal(resolveCliLogoKind("claude"), "claude-code");
  assert.equal(resolveCliLogoKind("claude-sonnet"), "claude-code");
});

test("an unknown, empty or missing CLI falls back to the terminal logo", () => {
  assert.equal(resolveCliLogoKind("bash"), "terminal");
  assert.equal(resolveCliLogoKind("kimi"), "terminal");
  assert.equal(resolveCliLogoKind(""), "terminal");
  assert.equal(resolveCliLogoKind(null), "terminal");
  assert.equal(resolveCliLogoKind(undefined), "terminal");
});
