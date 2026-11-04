/* global __dirname */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// A reply's ```visual block (`visualFrame.ts`, `VisualBlock.tsx`). The visual
// is built from the desktop's own builders, mirrored into src/shared/visual;
// these tests hold the mirrors to their sources, and pin what the phone adds
// around them: the host page, the frame's policy, the navigation gate, and how
// every message from the page is read.

const buildRoot = path.resolve(__dirname, "../../../../.mobile-test-build");
const repoRoot = path.resolve(__dirname, "../../../../..");
const visual = require(path.join(buildRoot, "src/components/document/rich/visualFrame.js"));
const { themes } = require(path.join(buildRoot, "src/theme/tokens.js"));
const { SEALED_VISUAL_POLICY, visualPartsScript } = require(
  path.join(buildRoot, "src/shared/visual/sealed-visual-document.js"),
);
const { SEALED_VISUAL_CHANNEL } = require(path.join(buildRoot, "src/shared/visual/sealed-visual.js"));
const { VISUAL_VARIABLES } = require(path.join(buildRoot, "src/shared/visual/visual-document.js"));

const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");
const dark = visual.visualThemeFor(themes.dark);
const light = visual.visualThemeFor(themes.light);
const message = (fields) => JSON.stringify({ channel: SEALED_VISUAL_CHANNEL, ...fields });

/** The data the host page's script was built with. */
function hostData(html) {
  const match = /var data = (\{.*?\});\n/s.exec(html);
  assert.ok(match, "the host script carries its data");
  return JSON.parse(match[1]);
}

test("the visual builders are the desktop's, byte for byte", () => {
  for (const file of ["visual-document.ts", "sealed-visual.ts", "sealed-visual-document.ts"]) {
    assert.equal(
      read(`mobile/src/shared/visual/${file}`),
      read(`src/shared/${file}`),
      `copy src/shared/${file} over mobile/src/shared/visual/${file}, then re-run: a changed reporter moves VISUAL_REPORTER_HASH`,
    );
  }
});

test("the host page drops the elements the desktop drops before a visual is built", () => {
  const removed = /\)\(""\s*,\s*("[^"]*")\)$/.exec(visualPartsScript(""));
  assert.ok(removed, "visualPartsScript ends with the removed elements");
  assert.equal(visual.VISUAL_REMOVED_ELEMENTS, JSON.parse(removed[1]));
});

test("the reporter's pinned hash is the reporter the frame runs, in either theme", () => {
  for (const theme of [dark, light]) {
    const shell = visual.visualDocumentShell(theme, true);
    assert.ok(shell);
    const reporter = visual.reporterScriptOf(shell.prefix);
    assert.ok(reporter && reporter.includes(SEALED_VISUAL_CHANNEL));
    const digest = crypto.createHash("sha256").update(reporter, "utf8").digest("base64");
    assert.equal(visual.VISUAL_REPORTER_HASH, `'sha256-${digest}'`, "update VISUAL_REPORTER_HASH in visualFrame.ts");
  }
});

test("every variable the desktop names has the phone's token, in both modes", () => {
  for (const [theme, mode] of [
    [dark, themes.dark],
    [light, themes.light],
  ]) {
    assert.deepEqual(Object.keys(theme.variables).sort(), Object.keys(VISUAL_VARIABLES).sort());
    for (const [name, value] of Object.entries(theme.variables)) {
      assert.ok(value && !/[<>{};]/.test(value), `${name} is ${value}`);
    }
    assert.equal(theme.variables["--fg"], mode.colors.textDefault);
    assert.equal(theme.variables["--accent"], mode.colors.accentPrimary);
    assert.equal(theme.variables["--chart-1"], mode.colors.chart1);
  }
  assert.equal(dark.colorScheme, "dark");
  assert.equal(light.colorScheme, "light");
});

test("the chart colours and the well are the desktop's, light and dark", () => {
  const tokens = JSON.parse(read("design-system/foundations/tokens.tokens.json"));
  const resolve = (value) => {
    const ref = /^\{ref\.color\.([^}]+)\}$/.exec(value);
    return ref ? tokens.ref.color[ref[1]].$value : value;
  };
  const modes = (token) => token.$extensions["com.sprintengine"].modes;
  const chart = tokens.sem.color.chart;
  for (const mode of ["light", "dark"]) {
    const colors = themes[mode].colors;
    for (let slot = 1; slot <= 8; slot += 1) {
      assert.equal(colors[`chart${slot}`], resolve(modes(chart[String(slot)])[mode]), `${mode} chart ${slot}`);
    }
    assert.equal(colors.chartOther, resolve(modes(chart.other)[mode]), `${mode} chart other`);
    assert.equal(colors.bgWell.replace(/\s/g, ""), modes(tokens.sem.color.bg.well)[mode].replace(/\s/g, ""), `${mode} well`);
  }
});

test("a visual with no script runs only the reporter; one with a script runs its own", () => {
  const still = visual.buildVisualPage('<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>', dark, "Bars");
  assert.equal(still.scripted, false);
  const stillData = hostData(still.html);
  const stillPolicy = SEALED_VISUAL_POLICY.replace("script-src 'unsafe-inline'", `script-src ${visual.VISUAL_REPORTER_HASH}`);
  assert.ok(stillData.prefix.includes(`content="${stillPolicy}"`));
  assert.ok(!stillData.prefix.includes("'unsafe-inline'; style"), "no inline script in a static visual's frame");

  const live = visual.buildVisualPage("<button id=b>Sort</button><script>b.onclick = () => 1</script>", dark, "Table");
  assert.equal(live.scripted, true);
  assert.ok(hostData(live.html).prefix.includes(`content="${SEALED_VISUAL_POLICY}"`));

  for (const page of [still, live]) {
    // The host page is held to the same policy, which a srcdoc frame inherits.
    assert.ok(page.html.includes(`<meta http-equiv="Content-Security-Policy" content="${SEALED_VISUAL_POLICY}">`));
    assert.ok(SEALED_VISUAL_POLICY.includes("default-src 'none'"));
    assert.ok(page.html.includes("frame.setAttribute('sandbox', 'allow-scripts');"));
    assert.ok(!page.html.includes("allow-same-origin"));
    assert.ok(!page.html.includes("allow-popups"));
    assert.ok(!page.html.includes("allow-top-navigation"));
  }
});

test("a visual's source is data in the host page: it cannot end the script or open a comment", () => {
  const source = '</script><script>alert(1)</script><!-- \u2028 \u2029 <img src=x onerror=alert(2)>';
  const page = visual.buildVisualPage(source, dark, "x");
  assert.equal(page.html.split("</script>").length, 2, "the host script is the page's only one");
  assert.ok(!page.html.includes("<!--"));
  assert.ok(!page.html.includes("\u2028") && !page.html.includes("\u2029"));
  assert.equal(hostData(page.html).source, source);
});

test("a source over the desktop's cap is shown as source", () => {
  const page = visual.buildVisualPage("x".repeat(visual.MAX_VISUAL_SOURCE + 1), dark, "x");
  assert.deepEqual(page, { error: visual.VISUAL_TOO_LARGE });
});

test("a theme handed to a running visual is data too", () => {
  const script = visual.visualThemeScript({ variables: { "--fg": "</script>" }, colorScheme: "dark" });
  assert.ok(!script.includes("<"));
  assert.ok(script.startsWith("window.__visualTheme && window.__visualTheme("));
});

test("only the three messages a visual's page sends are read, whole", () => {
  assert.deepEqual(visual.readVisualMessage(message({ type: "height", height: 240 })), { type: "height", height: 240 });
  assert.deepEqual(visual.readVisualMessage(message({ type: "open-link", href: "https://example.com" })), {
    type: "open-link",
    href: "https://example.com",
  });
  assert.deepEqual(visual.readVisualMessage(message({ type: "empty" })), { type: "empty" });

  assert.equal(visual.readVisualMessage(JSON.stringify({ channel: "other", type: "height", height: 1 })), null);
  assert.equal(visual.readVisualMessage(message({ type: "theme" })), null);
  assert.equal(visual.readVisualMessage(message({ type: "height", height: "240" })), null);
  assert.equal(visual.readVisualMessage(`{"channel":"${SEALED_VISUAL_CHANNEL}","type":"height","height":1e999}`), null);
  assert.equal(visual.readVisualMessage(message({ type: "open-link", href: "" })), null);
  assert.equal(visual.readVisualMessage(message({ type: "open-link", href: `https://a.example/${"x".repeat(2100)}` })), null);
  assert.equal(visual.readVisualMessage(message({ type: "empty", pad: "x".repeat(5000) })), null);
  assert.equal(visual.readVisualMessage("not json"), null);
  assert.equal(visual.readVisualMessage("null"), null);
  assert.equal(visual.readVisualMessage({ channel: SEALED_VISUAL_CHANNEL, type: "empty" }), null);
});

test("a reported height is capped at the desktop's 900, and nothing for nothing", () => {
  assert.equal(visual.visualFrameHeight(120.2), 121);
  assert.equal(visual.visualFrameHeight(5000), 900);
  assert.equal(visual.visualFrameHeight(0), null);
  assert.equal(visual.visualFrameHeight(-4), null);
  assert.equal(visual.visualFrameHeight(Number.NaN), null);
  assert.equal(visual.visualFrameHeight(Number.POSITIVE_INFINITY), null);
});

test("a visual hands out web addresses only, with no credentials and nothing to disguise them", () => {
  for (const href of ["https://example.com", "http://example.com/a?b=c#d", "HTTPS://Example.com/path"]) {
    assert.equal(visual.externalVisualLink(href), href);
  }
  for (const href of [
    "javascript:alert(1)",
    "data:text/html,<p>hi</p>",
    "file:///etc/passwd",
    "intent://scan#Intent;end",
    "sprintengine://conversation/1",
    "mailto:dev@example.com",
    "//example.com",
    "https://user:secret@example.com",
    "https://example.com@evil.example",
    "https://example.com\\@evil.example",
    "https://example.com/a b",
    "https://example.com/\nnext",
    "https://example.com/\u2028",
    "https://",
    "",
  ]) {
    assert.equal(visual.externalVisualLink(href), null, href);
  }
  assert.equal(visual.linkHost("https://example.com:8443/a"), "example.com:8443");
});

test("a link is offered only from a visual with a script, once a second", () => {
  const href = "https://example.com";
  assert.equal(visual.linkToOffer(href, { scripted: false, now: 10_000, lastOfferedAt: null }), null);
  assert.equal(visual.linkToOffer(href, { scripted: true, now: 10_000, lastOfferedAt: null }), href);
  assert.equal(visual.linkToOffer(href, { scripted: true, now: 10_500, lastOfferedAt: 10_000 }), null);
  assert.equal(visual.linkToOffer(href, { scripted: true, now: 11_000, lastOfferedAt: 10_000 }), href);
  assert.equal(visual.linkToOffer("javascript:alert(1)", { scripted: true, now: 20_000, lastOfferedAt: null }), null);
});

test("the WebView loads its page and the frame's srcdoc, and nothing else", () => {
  const gate = visual.createVisualNavigationGate();
  assert.equal(gate.allow("https://example.com"), false, "nothing before the page");
  assert.equal(gate.allow("about:blank"), true, "the page itself (iOS asks)");
  assert.equal(gate.allow("about:srcdoc"), true, "the frame's document");
  assert.equal(gate.allow("about:blank"), false, "the page only once");
  assert.equal(gate.allow("https://example.com"), false);
  assert.equal(gate.allow("data:text/html,<p>x</p>"), false);
  assert.equal(gate.allow("about:srcdoc"), true);

  const android = visual.createVisualNavigationGate();
  assert.equal(android.noteLoadStart(), "initial");
  assert.equal(android.allow("about:blank"), false, "Android's load never asks, so its latch is shut");
  assert.equal(android.noteLoadStart(), "unauthorized");
});

test("a visual is named by its title or first heading", () => {
  assert.equal(visual.visualTitle("<title>Build times</title><svg/>"), "Build times");
  assert.equal(visual.visualTitle('<h3 class="t">Revenue &amp; costs</h3>'), "Revenue & costs");
  assert.equal(visual.visualTitle("<svg><rect/></svg>"), "Visual");
});

test("a visual is given up on only once its page has loaded and still not reported", () => {
  // Not from mount: a page waiting on a busy shared renderer has not failed.
  assert.equal(visual.waitsForHeight({ loaded: false, reported: null, refused: false }), false);
  assert.equal(visual.waitsForHeight({ loaded: true, reported: null, refused: false }), true);
  assert.equal(visual.waitsForHeight({ loaded: true, reported: 240, refused: false }), false);
  assert.equal(visual.waitsForHeight({ loaded: true, reported: null, refused: true }), false);
});
