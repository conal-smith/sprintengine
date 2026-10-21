/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const { createSandboxNavigationGate } = require(path.join(buildRoot, "src/components/document/htmlSandbox.js"));

// iOS: `loadHTMLString` asks the gate about `about:blank` before the document exists.
test("the initial document load is allowed exactly once", () => {
  const gate = createSandboxNavigationGate();
  assert.equal(gate.allow("about:blank"), true);

  // A document that navigates itself back to about:blank wears the same URL as
  // the initial load. The latch is spent, so it is refused.
  assert.equal(gate.allow("about:blank"), false);
  assert.equal(gate.allow("about:blank"), false);
});

test("an empty base-document url is treated as the initial load, and is also one-shot", () => {
  const gate = createSandboxNavigationGate();
  assert.equal(gate.allow(""), true);
  assert.equal(gate.allow(""), false);
  assert.equal(gate.allow("about:blank"), false);
});

// Android: `loadDataWithBaseURL` never reaches `shouldOverrideUrlLoading`, so the
// gate's *first* question is the document's first escape attempt. Latching "the
// first request" would admit it; only an initial-document URL may spend the latch.
test("the first request is refused when it is not the initial document url", () => {
  for (const url of [
    "https://example.com/external",
    "http://example.com/external",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "data:text/html;base64,PHNjcmlwdD4=",
    "file:///etc/passwd",
    // The app's own deep-link scheme and the one it was renamed from. A
    // sandboxed document must never be able to drive an app link.
    "sprintengine://mobile-auth/callback",
    "multicode-companion://mobile-auth/callback",
    "about:srcdoc",
    "about:blank#fragment",
    "ABOUT:BLANK",
  ]) {
    const gate = createSandboxNavigationGate();
    assert.equal(gate.allow(url), false, `${url} must never be allowed, even as the first request`);

    // and refusing it must not spend the latch in a way that admits the next one
    assert.equal(gate.allow(url), false, `${url} must stay refused`);
  }
});

// Android: `onPageStarted` fires for the programmatic load before the document
// can propose anything, so the latch is already shut by the time links exist.
test("the first load start shuts the gate even when no request ever arrived", () => {
  const gate = createSandboxNavigationGate();
  assert.equal(gate.noteLoadStart(), "initial");

  assert.equal(gate.allow("about:blank"), false);
  assert.equal(gate.allow(""), false);
  assert.equal(gate.allow("https://example.com"), false);
});

// iOS: the request gate approves `about:blank`, then the same load reports its
// start. That must still read as the initial load, not as an escape.
test("the load start following the approved initial request is not unauthorized", () => {
  const gate = createSandboxNavigationGate();
  assert.equal(gate.allow("about:blank"), true);
  assert.equal(gate.noteLoadStart(), "initial");
});

// Android: `shouldOverrideUrlLoading` never sees a POST, so a form submit reaches
// the WebView unasked and only shows up as a second load start.
test("a second load start is unauthorized — the form-POST backstop", () => {
  const gate = createSandboxNavigationGate();
  assert.equal(gate.noteLoadStart(), "initial");

  assert.equal(gate.noteLoadStart(), "unauthorized");
  assert.equal(gate.noteLoadStart(), "unauthorized");
});

test("a load start after an approved initial request still guards the second load", () => {
  const gate = createSandboxNavigationGate();
  gate.allow("about:blank");
  assert.equal(gate.noteLoadStart(), "initial");
  assert.equal(gate.noteLoadStart(), "unauthorized");
});

// A new document (the `html` prop changed) gets a new gate; one document's spent
// latch must never leak into the next one, nor a settled gate outlive its source.
test("each gate is independent", () => {
  const first = createSandboxNavigationGate();
  assert.equal(first.allow("about:blank"), true);
  assert.equal(first.allow("about:blank"), false);
  assert.equal(first.noteLoadStart(), "initial");

  const second = createSandboxNavigationGate();
  assert.equal(second.allow("about:blank"), true);
  assert.equal(second.allow("https://example.com"), false);
  assert.equal(second.noteLoadStart(), "initial");
});

// The refusal is what the reader sees: every blocked URL must reach the caller
// so the surface can say so, rather than silently doing nothing.
test("anchor, target=_blank, form post and redirect targets are all refused after load", () => {
  const gate = createSandboxNavigationGate();
  gate.allow("about:blank"); // initial load

  const blocked = [
    "https://example.com/external", // <a href>
    "https://example.com/blank", // <a target="_blank">
    "https://example.com/post", // <form method="post">
    "https://example.com/meta-refresh", // <meta http-equiv="refresh">
    "https://example.com/iframe-subframe", // cross-origin <iframe>
    "about:blank", // <meta http-equiv="refresh" content="0;url=about:blank">
    "data:text/html,<h1>replaced</h1>", // data: document swap
  ];

  for (const url of blocked) {
    assert.equal(gate.allow(url), false, `${url} must be refused`);
  }
});

// --- content security policy injection -------------------------------------

const { withRestrictedContentPolicy } = require(path.join(buildRoot, "src/components/document/htmlSandbox.js"));

const cspMarker = 'http-equiv="Content-Security-Policy"';

test("the policy is injected inside <head>, never before the doctype", () => {
  const source = '<!doctype html>\n<html>\n<head>\n<style>body{color:red}</style>\n</head>\n<body>hi</body>\n</html>';
  const policed = withRestrictedContentPolicy(source);

  assert.ok(policed.startsWith("<!doctype html>"), "doctype must stay first or the artifact renders in quirks mode");
  assert.ok(policed.includes(cspMarker));

  // and it must precede the first resource-loading element, or that element loads first
  assert.ok(policed.indexOf(cspMarker) < policed.indexOf("<style>"));
  assert.ok(policed.indexOf("<head>") < policed.indexOf(cspMarker));
});

test("the policy denies everything a review artifact does not need", () => {
  const policed = withRestrictedContentPolicy("<html><head></head><body></body></html>");

  assert.ok(policed.includes("default-src 'none'"));
  assert.ok(policed.includes("style-src 'unsafe-inline'"), "self-contained mockups inline their styles");
  assert.ok(policed.includes("img-src data:"), "no remote image may beacon the reader's IP");
  assert.ok(policed.includes("form-action 'none'"), "the only platform-independent answer to Android's POST bypass");
  assert.ok(policed.includes("base-uri 'none'"));
});

test("a <head>-less document shell gets a head, after <html> so the doctype is untouched", () => {
  const policed = withRestrictedContentPolicy("<!doctype html><html><body>hi</body></html>");

  assert.ok(policed.startsWith("<!doctype html><html>"));
  assert.ok(policed.includes(`<head>`));
  assert.ok(policed.indexOf(cspMarker) < policed.indexOf("<body>"));
});

test("a bare fragment is wrapped in a document that has a doctype", () => {
  const policed = withRestrictedContentPolicy("<h1>just a fragment</h1>");

  assert.ok(policed.startsWith("<!doctype html>"));
  assert.ok(policed.includes(cspMarker));
  assert.ok(policed.includes("<h1>just a fragment</h1>"));
  assert.ok(policed.indexOf(cspMarker) < policed.indexOf("<h1>"));
});

test("attributes on the head/html tags do not break insertion", () => {
  const withAttrs = withRestrictedContentPolicy('<!doctype html><html lang="en"><head data-x="1"><title>t</title></head><body></body></html>');
  assert.ok(withAttrs.includes('<head data-x="1">' + '<meta http-equiv="Content-Security-Policy"'));
  assert.ok(withAttrs.indexOf(cspMarker) < withAttrs.indexOf("<title>"));

  const headless = withRestrictedContentPolicy('<html lang="en"><body>x</body></html>');
  assert.ok(headless.startsWith('<html lang="en"><head>'));
});

test("the artifact's own bytes are preserved verbatim around the injection", () => {
  const source = '<!doctype html><html><head></head><body><p>&amp; &lt;script&gt; "quoted"</p></body></html>';
  const policed = withRestrictedContentPolicy(source);

  assert.ok(policed.includes('<p>&amp; &lt;script&gt; "quoted"</p>'));
  assert.equal(policed.replace(contentPolicyMetaOf(policed), ""), source);
});

// --- the policy must land in *markup*, never in a comment ---------------------
//
// `<head>` inside a comment is text. A policy injected there is inert, and the
// document loads unpoliced: subresources beacon again, and `form-action 'none'`
// — the only platform-independent answer to Android's POST bypass — goes with it.

test("a <head> named inside a comment is not the injection point", () => {
  const source =
    "<!doctype html><!-- <head> --><html><head><title>t</title></head>" +
    "<body><img src=\"https://evil.example/pixel\"></body></html>";
  const policed = withRestrictedContentPolicy(source);

  assertPolicyIsLiveMarkup(policed);
  assert.ok(policed.includes("<!-- <head> -->"), "the commented-out head must be returned verbatim");
  // it lands in the *real* head, which follows the comment
  assert.ok(policed.includes(`<head>${contentPolicyMetaOf(policed)}<title>`));
});

test("a <html> named inside a comment does not consume the head-less insertion", () => {
  // The worst shape: the old regex found `<html` inside the comment, wrapped a
  // `<head>` around the policy *there*, and returned a document with no policy.
  const source = '<!doctype html><!-- <html> --><html><body><img src="https://evil.example/pixel"></body></html>';
  const policed = withRestrictedContentPolicy(source);

  assertPolicyIsLiveMarkup(policed);
  assert.ok(policed.includes("<!-- <html> -->"));
});

test("an HTML5-Boilerplate conditional-comment shell is policed in its real <head>", () => {
  // Downlevel-hidden `<html>` is inside a comment; the downlevel-revealed one that
  // follows `<!-->` is real markup. Both must be classified correctly.
  const source =
    "<!doctype html>" +
    '<!--[if lt IE 9]><html class="no-js lt-ie9"><![endif]-->' +
    '<!--[if gt IE 8]><!--><html class="no-js"><!--<![endif]-->' +
    '<head><link rel="stylesheet" href="https://evil.example/style.css"></head>' +
    "<body>hi</body></html>";
  const policed = withRestrictedContentPolicy(source);

  assertPolicyIsLiveMarkup(policed);
  assert.ok(policed.startsWith("<!doctype html>"), "the doctype still leads, so rendering mode is unchanged");
  assert.ok(policed.includes('<html class="no-js lt-ie9">'), "the hidden shell stays inside its comment");
  assert.equal(policed.replace(contentPolicyMetaOf(policed), ""), source, "bytes verbatim around the injection");
});

test("an unterminated comment still yields a policed document", () => {
  // Everything after `<!--` is comment, so no live `<head>`/`<html>` exists and
  // the wrapper carries the policy rather than the document going unpoliced.
  const policed = withRestrictedContentPolicy('<!doctype html><!-- <head> <html> <body><img src="https://evil.example/p">');

  assertPolicyIsLiveMarkup(policed);
});

// --- the policy must be a child of the *parser's* head -----------------------
//
// Everything below shipped unpoliced behind a substring scan. Each was executed
// in Chromium — the Android WebView engine — and fired its beacon.

test("an element that opens <body> before <head> forces the wrapper", () => {
  // The parser opens <body> at the <img>, then discards the <head> token. A meta
  // injected there is parsed as a child of <body>, and the engine ignores the
  // whole policy ("delivered via a <meta> element outside the document's <head>").
  assertPolicyIsLiveMarkup(withRestrictedContentPolicy('<img src="https://evil.example/beacon-B.png"><head></head><body></body>'));
});

test("an element that opens <body> before <html> forces the wrapper", () => {
  // The `<html>` fallback had the same ordering bug as the `<head>` branch.
  assertPolicyIsLiveMarkup(withRestrictedContentPolicy('<img src="https://evil.example/beacon-B2.png"><html><body></body></html>'));
});

test("non-whitespace text before <head> forces the wrapper", () => {
  // Character tokens open <body> exactly as <img> does.
  assertPolicyIsLiveMarkup(withRestrictedContentPolicy('hello<head></head><body><img src="https://evil.example/p"></body>'));
});

test("a quoted `>` inside an attribute does not end the start tag", () => {
  // `[^>]*>` stopped at the `>` inside `data-x`, splicing the meta into the
  // attribute value, so no meta element was parsed at all.
  const policed = withRestrictedContentPolicy('<head data-x="a>b"></head><body><img src="https://evil.example/beacon-C.png"></body>');

  assertPolicyIsLiveMarkup(policed);
  assert.ok(policed.includes('<head data-x="a>b">'), "the artifact's attribute must survive verbatim");
});

test("a <head> named inside an attribute value is not the injection point", () => {
  const policed = withRestrictedContentPolicy('<!doctype html><html data-x="<head>"><head></head><body><img src="https://evil.example/p"></body></html>');

  assertPolicyIsLiveMarkup(policed);
  assert.ok(policed.includes('<html data-x="<head>">'), "the artifact's attribute must survive verbatim");
  // and it lands in the real head that follows, not in the attribute
  assert.ok(policed.includes(`<head>${contentPolicyMetaOf(policed)}`));
});

test("a <html> whose only <head> lives in an attribute still gets a synthesised head", () => {
  const policed = withRestrictedContentPolicy('<html data-x="<head>"><body><img src="https://evil.example/p"></body></html>');

  assertPolicyIsLiveMarkup(policed);
  assert.ok(policed.includes('<html data-x="<head>">'));
});

test("frame-ancestors is not delivered by meta, where the engine ignores it", () => {
  // It is a no-op that logs an engine error on every preview; default-src 'none'
  // already denies framing.
  assert.ok(!withRestrictedContentPolicy("<html><head></head></html>").includes("frame-ancestors"));
});

/**
 * The property every policed document owes, checked with a tokenizer written
 * independently of the module under test: **the policy meta is parsed as an
 * element, and it is a child of the document's `<head>`.**
 *
 * A substring test ("is it inside a comment?") is not enough, and shipping one
 * was the bug. Three contexts spell `<head>` identically without being it:
 *
 * - inside a comment, so the meta is never parsed;
 * - inside a quoted attribute value, so the meta is never parsed;
 * - after an element that has already opened `<body>` — the meta *is* parsed, but
 *   as a child of body, and the HTML spec has the engine discard a CSP meta that
 *   is not a child of head (`<img src=x><head></head>` loads with no policy).
 *
 * So this asserts on the token stream: the meta must be a real start tag, and no
 * element other than `<html>`/`<head>` — and no non-whitespace text — may precede it.
 */
function assertPolicyIsLiveMarkup(policed) {
  const tags = [...tokenizeStartTags(policed)];
  const meta = tags.find((tag) => tag.name === "meta" && /Content-Security-Policy/i.test(tag.source));

  assert.ok(meta, "the policy meta is not a parsed start tag — it is inside a comment or an attribute value");
  assert.ok(!meta.textBefore, "non-whitespace text precedes the policy, so it is parsed inside <body> and discarded");

  for (const tag of tags) {
    if (tag === meta) {
      break;
    }
    assert.ok(
      tag.name === "html" || tag.name === "head",
      `<${tag.name}> precedes the policy, so the parser has opened <body> and the CSP meta is discarded`,
    );
  }
}

/**
 * A minimal HTML start-tag tokenizer: skips comments, skips quoted attribute
 * values when looking for a tag's `>`, and reports whether non-whitespace text
 * preceded each tag. Deliberately not the module's own scanner.
 */
function* tokenizeStartTags(html) {
  let at = 0;
  let textBefore = false;

  while (at < html.length) {
    if (html.startsWith("<!--", at)) {
      const close = html.indexOf("-->", at + 4);
      at = close === -1 ? html.length : close + 3;
      continue;
    }
    if (html.startsWith("<!", at) || html.startsWith("</", at)) {
      const close = html.indexOf(">", at);
      at = close === -1 ? html.length : close + 1;
      continue;
    }
    if (html[at] === "<" && /[a-z]/i.test(html[at + 1] ?? "")) {
      let end = at + 1;
      let quote = null;
      while (end < html.length) {
        const char = html[end];
        if (quote) {
          if (char === quote) quote = null;
        } else if (char === '"' || char === "'") {
          quote = char;
        } else if (char === ">") {
          break;
        }
        end += 1;
      }
      const source = html.slice(at, end + 1);
      yield { name: /^<([^\s/>]+)/.exec(source)[1].toLowerCase(), source, textBefore };
      at = end + 1;
      continue;
    }
    if (!/\s/.test(html[at])) {
      textBefore = true;
    }
    at += 1;
  }
}

function contentPolicyMetaOf(policed) {
  const match = /<meta http-equiv="Content-Security-Policy"[^>]*>/.exec(policed);
  assert.ok(match, "expected an injected policy meta");
  return match[0];
}
