const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  highlightSource,
} = require("../../../.mobile-test-build/src/components/document/sourceHighlight.js");
test("native highlighting preserves exact source across supported grammars", () => {
  for (const [language, source] of [
    ["ts", 'const answer = "hello"; // note\nreturn 42;\n'],
    ["python", "def example():\n  # note\n  return 'yes'\n"],
    ["json", '{"count":42,"ready":true}'],
    ["bash", "# note\necho 'hello'\n"],
    ["diff", "--- a/file\n+++ b/file\n-old\n+new\n"],
    ["js", "/* unclosed\ncomment"],
    ["ts", "'unclosed\\"],
  ]) {
    const tokens = highlightSource(source, language);
    assert.equal(tokens.map((token) => token.text).join(""), source);
    assert.ok(tokens.some((token) => token.tone !== "plain"));
  }
});
test("unknown or oversized code stays intact without token expansion", () => {
  for (const [language, source] of [
    ["unknown", "return 42"],
    ["js", "x".repeat(40_000)],
    ["ts", "1 + ".repeat(6000)],
  ])
    assert.deepEqual(highlightSource(source, language), [{ text: source, tone: "plain" }]);
});
test("language metadata and diff headers do not alter source", () => {
  assert.equal(
    highlightSource("const value = 1", "language-typescript title=example.ts")[0].tone,
    "keyword",
  );
  assert.equal(highlightSource("+++ b/file\n", "diff")[0].tone, "plain");
});
