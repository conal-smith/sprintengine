/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const { isOpenableTailnetUrl, readWebTargets, shortMachineName } = require(
  path.join(buildRoot, "src/features/web/webTargetsLogic.js"),
);

// A web target's URL is a string another machine put on the wire, and this phone
// hands it to the operating system. The admission rule is the security boundary
// of this feature, so it is pinned from both directions: what must open, and
// what must never.

const target = (overrides = {}) => ({
  id: "serve:8443",
  label: "localhost:5173",
  url: "https://studio-mac.tail1234.ts.net:8443/",
  localPort: 5173,
  machine: "studio-mac.tail1234.ts.net",
  ...overrides,
});

test("a real tailnet serve URL opens", () => {
  assert.equal(isOpenableTailnetUrl("https://studio-mac.tail1234.ts.net/"), true);
  assert.equal(isOpenableTailnetUrl("https://studio-mac.tail1234.ts.net:8443/"), true);
  assert.equal(isOpenableTailnetUrl("https://studio-mac.tail1234.ts.net:8443/app?x=1"), true);
});

test("anything that is not a tailnet https origin is refused", () => {
  // Cleartext: not what serve produces, and ATS would refuse it anyway.
  assert.equal(isOpenableTailnetUrl("http://studio-mac.tail1234.ts.net/"), false);
  // A public host is not a private share.
  assert.equal(isOpenableTailnetUrl("https://example.com/"), false);
  // A raw tailnet IP is not the name serve certifies.
  assert.equal(isOpenableTailnetUrl("https://100.101.102.103:8443/"), false);
  // Schemes that are not navigation at all.
  assert.equal(isOpenableTailnetUrl("javascript:alert(1)"), false);
  assert.equal(isOpenableTailnetUrl("file:///etc/passwd"), false);
  assert.equal(isOpenableTailnetUrl("data:text/html,<h1>hi"), false);
  // Not a URL.
  assert.equal(isOpenableTailnetUrl("studio-mac.tail1234.ts.net"), false);
  assert.equal(isOpenableTailnetUrl(""), false);
});

test("a lookalike registration does not pass as the MagicDNS suffix", () => {
  // `endsWith(".ts.net")` is the rule; a host that merely ENDS in those letters
  // without the dot boundary — or that only IS the suffix — is not in it.
  assert.equal(isOpenableTailnetUrl("https://evil-ts.net/"), false);
  assert.equal(isOpenableTailnetUrl("https://ts.net/"), false);
  assert.equal(isOpenableTailnetUrl("https://nottailnet.ts.net.evil.com/"), false);
});

test("credentials in the URL are refused", () => {
  assert.equal(isOpenableTailnetUrl("https://user:pass@studio-mac.tail1234.ts.net/"), false);
  assert.equal(isOpenableTailnetUrl("https://user@studio-mac.tail1234.ts.net/"), false);
});

test("host matching ignores case", () => {
  assert.equal(isOpenableTailnetUrl("https://Studio-Mac.Tail1234.TS.NET/"), true);
});

test("a snapshot without web targets is an empty list, never a throw", () => {
  assert.deepEqual(readWebTargets(null), []);
  assert.deepEqual(readWebTargets({}), []);
  assert.deepEqual(readWebTargets({ webTargets: "nope" }), []);
  assert.deepEqual(readWebTargets({ webTargets: [null, undefined, 7] }), []);
});

test("a target with a refused URL is dropped, not shown unusable", () => {
  const targets = readWebTargets({
    webTargets: [target(), target({ id: "serve:9", url: "http://studio-mac.tail1234.ts.net/" })],
  });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].id, "serve:8443");
});

test("targets are ordered by machine then local port, so the list is stable", () => {
  const targets = readWebTargets({
    webTargets: [
      target({ id: "c", localPort: 5173, machine: "yew.tail1234.ts.net", url: "https://yew.tail1234.ts.net:8443/" }),
      target({ id: "b", localPort: 9000, machine: "air.tail1234.ts.net", url: "https://air.tail1234.ts.net:10000/" }),
      target({ id: "a", localPort: 3000, machine: "air.tail1234.ts.net", url: "https://air.tail1234.ts.net:8443/" }),
    ],
  });
  assert.deepEqual(targets.map((entry) => entry.id), ["a", "b", "c"]);
});

test("a duplicate id is kept once", () => {
  const targets = readWebTargets({ webTargets: [target(), target()] });
  assert.equal(targets.length, 1);
});

test("a missing label falls back to the local port", () => {
  const targets = readWebTargets({ webTargets: [target({ label: "" })] });
  assert.equal(targets[0].label, "localhost:5173");
});

test("the machine is named the way a person names it", () => {
  assert.equal(shortMachineName("studio-mac.tail1234.ts.net"), "studio-mac");
  assert.equal(shortMachineName("studio-mac"), "studio-mac");
});
