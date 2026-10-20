/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const { isPairingDeepLink, parsePairingPayload } = require(path.join(buildRoot, "src/features/pairing/pairingPayload.js"));
const { resolveGateRoute, resolveRootRoute, shouldShowSignedInNavigation } = require(path.join(
  buildRoot,
  "src/navigation/sessionFlow.js",
));


test("a revoked desktop lands on the gate's session-status root, never inside the tabs", () => {
  const revokedSession = { status: "revoked" };

  assert.equal(resolveRootRoute(revokedSession), "gate");
  assert.equal(resolveGateRoute(revokedSession), "SessionStatus");
  assert.equal(shouldShowSignedInNavigation(revokedSession), false);
});

test("no paired desktop starts the gate at the welcome screen; an online one opens the tabs", () => {
  assert.equal(resolveRootRoute(null), "gate");
  assert.equal(resolveGateRoute(null), "Welcome");
  assert.equal(resolveRootRoute({ status: "online" }), "tabs");
  assert.equal(resolveRootRoute({}), "tabs");
});

// A pairing link only reaches the pairing screen if the OS delivers it AND the
// app recognises it. The manifest half is not testable from here (it is
// AndroidManifest.xml / Info.plist); this is the recognition half, which is what
// stands between a delivered link and it being dropped as "not an auth
// callback" — the bug that made tailnet pairing links un-openable.
test("a tailnet pairing link is recognised by its scheme alone", () => {
  assert.equal(isPairingDeepLink("sprintengine-tailnet://pair?endpoint=host:8443&token=abc"), true);
  // The desktop mints it for nothing else, so even a shapeless one is claimed
  // and allowed to fail loudly on the pairing screen rather than vanish.
  assert.equal(isPairingDeepLink("sprintengine-tailnet://pair"), true);
});

test("an auth callback is not mistaken for a pairing link", () => {
  // The app's own scheme also carries auth callbacks and conversation links;
  // claiming one as a pairing would drop it on the wrong screen.
  assert.equal(isPairingDeepLink("sprintengine://auth/callback?code=abc123&state=xyz"), false);
  assert.equal(isPairingDeepLink("sprintengine://"), false);
});

test("a URL that is not ours, or not a URL, is left alone", () => {
  assert.equal(isPairingDeepLink("myapp://pair?endpoint=host:8443&token=abc"), false);
  assert.equal(isPairingDeepLink("123 456"), false);
  assert.equal(isPairingDeepLink(""), false);
  assert.equal(isPairingDeepLink("   "), false);
});

// A link that parses to ok:false disables the Pair button, and the button is
// what would otherwise set the error — so a malformed link used to land as an
// unreadable string above a dead control with no reason given. The screen
// derives its message from these two, so pin the pair together.
test("a malformed pairing link is claimed AND carries a message to show", () => {
  const malformed = new URL("sprintengine-tailnet://pair");
  malformed.searchParams.set("endpoint", "mac-mini.tail1234.ts.net:8443");
  // A tailnet link with no token is the malformed case the parser names.
  assert.equal(isPairingDeepLink(malformed.toString()), true);
  const parsed = parsePairingPayload(malformed.toString());
  assert.equal(parsed.ok, false);
  assert.ok(parsed.message, "a claimed-but-invalid link must carry copy the field can show");

  // And a half-typed code must NOT be claimed, or the field would nag with a
  // link error while someone is still typing digits.
  assert.equal(isPairingDeepLink("123"), false);
  assert.equal(isPairingDeepLink("123 45"), false);
});

test("only Studio's tailnet link pairs: a bare code or a retired link form is refused with copy that says so", () => {
  // The phone pairs over the tailnet and nowhere else, so a six-digit code has
  // no endpoint to go to and the retired link forms have no server to go to.
  for (const input of [
    "123 456",
    "123456",
    "sprintengine://mobile/pair?pairingChallengeId=c1&secret=s1",
    "multicode://mobile/pair?pairingChallengeId=c1&secret=s1",
    "https://example.com/pair?pairingPayload=%7B%7D",
    JSON.stringify({ pairingChallengeId: "c1", pairingSecret: "s1" }),
  ]) {
    const parsed = parsePairingPayload(input);
    assert.equal(parsed.ok, false, input);
    assert.match(parsed.message, /pairing link/u, input);
    assert.equal(isPairingDeepLink(input), false, `${input} must not be claimed as a pairing link`);
  }
  assert.equal(parsePairingPayload("").ok, false);
});
