/* global __dirname */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../../../..");
const buildRoot = path.join(repoRoot, ".mobile-test-build");
const { createRichRenderer, fitDrawing, renderKey } = require(path.join(buildRoot, "src/components/document/rich/richRenderer.js"));
const { diagramRefusal, loadsFromElsewhere, LOADS_FROM_ELSEWHERE, diagramNote, mathNote, diagramTheme, MAX_DIAGRAM_SOURCE } = require(
  path.join(buildRoot, "src/components/document/rich/diagramSource.js"),
);
const { themes } = require(path.join(buildRoot, "src/theme/tokens.js"));
const ttfGlyphs = require(path.join(repoRoot, "src/components/document/rich/renderer/ttfGlyphs.js"));

// A clock the test turns by hand.
function manualTimers() {
  const pending = new Map();
  let next = 0;
  return {
    set(callback, ms) {
      pending.set(++next, { callback, ms });
      return next;
    },
    clear(handle) {
      pending.delete(handle);
    },
    fire() {
      for (const [handle, { callback }] of [...pending]) {
        pending.delete(handle);
        callback();
      }
    },
    get size() {
      return pending.size;
    },
  };
}

const job = (source, kind = "mermaid") => ({ kind, source, fontSize: 14, fontFamily: "sans-serif", color: "#000", theme: { a: "#fff" } });
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"><rect width="1" height="1"/></svg>';

function harness() {
  const timers = manualTimers();
  const renderer = createRichRenderer({ timers, timeoutMs: 1000 });
  const posted = [];
  let resets = 0;
  const port = { post: (sent) => posted.push(sent), reset: () => (resets += 1) };
  return { timers, renderer, posted, port, resets: () => resets };
}
const answer = (renderer, message) => renderer.receive(JSON.stringify(message));

test("nothing is drawn, and no page is wanted, until a reply asks", () => {
  const { renderer, posted, port } = harness();
  assert.equal(renderer.wanted(), false);
  renderer.attach(port);
  answer(renderer, { type: "ready" });
  assert.equal(posted.length, 0);
  renderer.request(job("flowchart TD\nA-->B"));
  assert.equal(renderer.wanted(), true);
  assert.equal(posted.length, 1);
});

test("drawings are serial, asked once, and kept", () => {
  const { renderer, posted, port } = harness();
  let changes = 0;
  renderer.subscribe(() => (changes += 1));
  const first = renderer.request(job("one"));
  renderer.request(job("two"));
  renderer.request(job("one"));
  // No page yet: nothing is posted, and nothing before the page says it is ready.
  assert.equal(posted.length, 0);
  renderer.attach(port);
  assert.equal(posted.length, 0);
  answer(renderer, { type: "ready" });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].source, "one");
  answer(renderer, { type: "result", id: posted[0].id, svg: SVG, width: 999, height: 999 });
  // The sanitiser's reading of the size, not the page's claim.
  assert.deepEqual(renderer.peek(first), { svg: SVG, width: 10, height: 20 });
  assert.equal(posted.length, 2);
  assert.equal(posted[1].source, "two");
  answer(renderer, { type: "error", id: posted[1].id, message: "Parse error on line 1:\n..." });
  assert.deepEqual(renderer.peek(renderKey(job("two"))), { error: "Parse error on line 1:\n..." });
  // Kept: asking again posts nothing.
  renderer.request(job("one"));
  renderer.request(job("two"));
  assert.equal(posted.length, 2);
  assert.ok(changes >= 3);
});

test("the look is part of what is kept", () => {
  assert.notEqual(renderKey(job("x")), renderKey({ ...job("x"), theme: { a: "#000" } }));
  assert.notEqual(renderKey(job("x", "math")), renderKey({ ...job("x", "math"), color: "#fff" }));
  // A formula does not care about a diagram's theme.
  assert.equal(renderKey(job("x", "math")), renderKey({ ...job("x", "math"), theme: { b: "#123" } }));
  assert.notEqual(renderKey(job("x", "math")), renderKey(job("x", "mermaid")));
});

test("only the job in flight is answered, and only with sanitised SVG", () => {
  const { renderer, posted, port } = harness();
  renderer.attach(port);
  answer(renderer, { type: "ready" });
  const key = renderer.request(job("one"));
  const { id } = posted[0];
  // Noise, other ids, and malformed messages change nothing.
  renderer.receive("not json");
  renderer.receive(42);
  renderer.receive(JSON.stringify(null));
  answer(renderer, { type: "result", id: "r999", svg: SVG });
  answer(renderer, { type: "result", id, svg: 5 });
  assert.deepEqual(renderer.peek(key), { error: "The drawing could not be read" });
  // A hostile answer to the next job is rebuilt before it is kept.
  const next = renderer.request(job("two"));
  answer(renderer, {
    type: "result",
    id: posted[1].id,
    svg: '<svg width="1" height="1"><script>alert(1)</script><image href="https://evil.example/x.png"/><rect width="1" height="1" fill="url(https://evil.example)"/></svg>',
  });
  const kept = renderer.peek(next);
  assert.doesNotMatch(kept.svg, /script|image|evil/);
  // A page that is not an SVG at all is not drawn.
  const third = renderer.request(job("three"));
  answer(renderer, { type: "result", id: posted[2].id, svg: "<html><body>hello</body></html>" });
  assert.deepEqual(renderer.peek(third), { error: "The drawing could not be read" });
  // Oversized answers are ignored outright.
  const fourth = renderer.request(job("four"));
  renderer.receive(JSON.stringify({ type: "result", id: posted[3].id, svg: "x".repeat(2_100_000) }));
  assert.equal(renderer.peek(fourth), undefined);
});

test("a page that does not answer in time is thrown away, and the queue goes on", () => {
  const { renderer, posted, port, timers, resets } = harness();
  renderer.attach(port);
  answer(renderer, { type: "ready" });
  const stuck = renderer.request(job("stuck"));
  renderer.request(job("after"));
  timers.fire();
  assert.deepEqual(renderer.peek(stuck), { error: "The drawing took too long" });
  assert.equal(resets(), 1);
  // Nothing is posted to the old page; the new one is told the next job once ready.
  assert.equal(posted.length, 1);
  // A late answer from the old page is ignored.
  answer(renderer, { type: "result", id: posted[0].id, svg: SVG });
  assert.deepEqual(renderer.peek(stuck), { error: "The drawing took too long" });
  answer(renderer, { type: "ready" });
  assert.equal(posted.length, 2);
  assert.equal(posted[1].source, "after");
});

test("a page whose process dies loses its job, not the queue", () => {
  const { renderer, posted, port, resets } = harness();
  renderer.attach(port);
  answer(renderer, { type: "ready" });
  const lost = renderer.request(job("lost"));
  renderer.request(job("next"));
  renderer.crashed();
  assert.deepEqual(renderer.peek(lost), { error: "The renderer stopped" });
  assert.equal(resets(), 1);
  answer(renderer, { type: "ready" });
  assert.equal(posted.at(-1).source, "next");
  // Detaching mid-job reports it, and a stale port's detach changes nothing.
  renderer.detach({ post() {}, reset() {} });
  renderer.detach(port);
  assert.deepEqual(renderer.peek(renderKey(job("next"))), { error: "The renderer closed" });
});

test("a diagram that would fetch is refused before it reaches the page", () => {
  for (const source of [
    "classDiagram\n  class A\n  style A fill:url(https://evil.example/x)",
    "stateDiagram-v2\n  classDef bad fill:url('//evil.example/x')\n  [*] --> A",
    'flowchart TD\n  A@{ img: "https://evil.example/a.png", label: "x" }',
    'flowchart TD\n  A@{ shape: rect, img: "/local.png" }',
    'sequenceDiagram\n  participant A@{ "type": "boundary", "icon": "https://evil.example/i.svg" }',
    "flowchart TD\n  A-->B\n  style A fill:\\75 rl(https://evil.example)",
    "flowchart TD\n  A-->B\n  style A fill:u\\rl(https://evil.example)",
    "%%{init: {'themeCSS': '@import \"https://evil.example/x.css\";'}}%%\nflowchart TD\n  A-->B",
    "flowchart TD\n  A-->B\n  style A background:image-set('https://evil.example/a.png' 1x)",
    "flowchart TD\n  A-->B\n  style A background:-webkit-image-set('https://evil.example/a.png' 1x)",
  ]) {
    assert.equal(loadsFromElsewhere(source), true, source);
    assert.equal(diagramRefusal(source), LOADS_FROM_ELSEWHERE, source);
  }
  // The diagram's own references, an @-named icon and plain diagrams pass.
  for (const source of [
    "flowchart TD\n  A-->B\n  style A fill:#f9f,stroke:#333",
    "flowchart TD\n  A-->B\n  linkStyle 0 stroke:url(#gradient)",
    'sequenceDiagram\n  participant A@{ "icon": "@mdi:server" }',
    "sequenceDiagram\n  Phone->>Desktop: GET https://example.com/path",
  ]) {
    assert.equal(diagramRefusal(source), null, source);
  }
  assert.match(diagramRefusal(`flowchart TD\n${"  A-->B\n".repeat(MAX_DIAGRAM_SOURCE / 8)}`), /too long/);
  assert.match(diagramRefusal("   \n"), /empty/);
});

test("why a diagram or a formula shows as source, in a line", () => {
  assert.equal(diagramNote("Parse error on line 3:\n...A -->\n---^\nExpecting 'AMP'"), "Shown as source: Parse error on line 3");
  assert.equal(diagramNote(""), "Shown as source: the diagram could not be drawn");
  assert.equal(
    mathNote("KaTeX parse error: Expected '}', got 'EOF' at end of input: \\frac{1}{"),
    "Shown as source: Expected '}', got 'EOF' at end of input: \\frac{1}{",
  );
});

test("a drawing fits its column: shrunk to it, a diagram never below half, a formula never at all", () => {
  assert.deepEqual(fitDrawing({ width: 200, height: 100 }, 300, 0.5), { width: 200, height: 100, scrolls: false });
  assert.deepEqual(fitDrawing({ width: 600, height: 300 }, 300, 0.5), { width: 300, height: 150, scrolls: false });
  assert.deepEqual(fitDrawing({ width: 1000, height: 400 }, 300, 0.5), { width: 500, height: 200, scrolls: true });
  assert.deepEqual(fitDrawing({ width: 400, height: 40 }, 300, 1), { width: 400, height: 40, scrolls: true });
  assert.deepEqual(fitDrawing({ width: 400, height: 40 }, 0, 1), { width: 400, height: 40, scrolls: false });
});

test("a diagram's colours are the theme's, in both themes", () => {
  for (const theme of [themes.light, themes.dark]) {
    const variables = diagramTheme(theme.colors, theme.isDark);
    assert.equal(variables.darkMode, theme.isDark);
    assert.equal(variables.primaryTextColor, theme.colors.textDefault);
    assert.equal(variables.lineColor, theme.colors.textMuted);
    // An edge label's box is the well the diagram sits in.
    assert.equal(variables.edgeLabelBackground, theme.colors.bgHover);
    for (const [name, value] of Object.entries(variables)) {
      if (name === "darkMode") continue;
      // Every one a colour Mermaid's colour library reads.
      assert.match(value, /^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i, name);
    }
  }
});

test("the glyph reader draws KaTeX's faces as outlines", () => {
  const fonts = path.join(repoRoot, "node_modules/katex/dist/fonts");
  const read = (name) => {
    const bytes = fs.readFileSync(path.join(fonts, name));
    return ttfGlyphs.parseFont(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  };
  const main = read("KaTeX_Main-Regular.ttf");
  assert.equal(main.unitsPerEm, 1000);
  const a = main.glyphIndex("A".codePointAt(0));
  assert.ok(a > 0);
  assert.deepEqual(ttfGlyphs.contourBounds(main.contours(a)), { xMin: 32, yMin: 0, xMax: 717, yMax: 716 });
  const data = ttfGlyphs.pathData(main.contours(a), 10, 20, 0.02);
  assert.match(data, /^M[\d.]+ [\d.]+/);
  assert.match(data, /Z$/);
  // y points down: the top of the A is above the baseline.
  assert.ok(Math.min(...data.match(/-?[\d.]+/g).filter((_, index) => index % 2 === 1).map(Number)) < 20);
  // A space has no outline; a code point the face lacks maps to nothing.
  assert.equal(ttfGlyphs.contourBounds(main.contours(main.glyphIndex(32))), null);
  assert.equal(main.glyphIndex(0x65e5), 0);
  // Every face reads, and every glyph it maps draws without throwing.
  for (const name of fs.readdirSync(fonts).filter((file) => file.endsWith(".ttf"))) {
    const face = read(name);
    for (let code = 32; code < 0x2400; code += 1) {
      const glyph = face.glyphIndex(code);
      if (glyph) ttfGlyphs.pathData(face.contours(glyph), 0, 0, 0.01);
    }
  }
});

test("the renderer page is current, offline, and runs only its own scripts", async () => {
  const { inputsDigest } = await import(path.join(repoRoot, "scripts/build-rich-renderer.mjs"));
  const generated = fs.readFileSync(path.join(repoRoot, "src/components/document/rich/richRendererDocument.generated.ts"), "utf8");
  const recorded = /RICH_RENDERER_INPUTS = "([0-9a-f]{64})"/.exec(generated)?.[1];
  assert.equal(recorded, inputsDigest(), "run `npm run build:renderer`");
  const html = JSON.parse(/RICH_RENDERER_DOCUMENT: string = (".*");\n/s.exec(generated)[1]);
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)[1];
  assert.match(policy, /^default-src 'none'; /);
  assert.ok(!/unsafe-eval|https?:|data:|\*/.test(policy), policy);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(policy), policy);
  assert.match(policy, /form-action 'none'/);
  // The policy is the first thing in <head>, and every script is admitted by its hash.
  assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<style>"));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(scripts.length, 5);
  for (const script of scripts) {
    const hash = crypto.createHash("sha256").update(script, "utf8").digest("base64");
    assert.ok(policy.includes(`'sha256-${hash}'`));
  }
  // Nothing is fetched from anywhere: no CDN, no font file, no stylesheet
  // link. (The libraries' own code mentions such things; the page does not.)
  const page = html.replace(/<script>[\s\S]*?<\/script>/g, "<script></script>");
  assert.ok(!/<link|<script src|@font-face|url\(|@import/.test(page), "the page refers to nothing outside itself");
  assert.equal(page.match(/<script/g).length, 5);
  // ASCII throughout: Hermes would keep anything else as UTF-16, doubling its weight.
  assert.ok(!/[^\x00-\x7f]/.test(html), "the page is ASCII");
  // The faces travel with it, all twenty.
  const fonts = JSON.parse(/window\.__richFonts=(\[.*?\]);<\/script>/s.exec(html)[1]);
  assert.equal(fonts.length, 20);
  // The diagram settings a directive may not change are locked.
  for (const key of ["htmlLabels", "themeCSS", "themeVariables", "fontFamily", "altFontFamily", "dompurifyConfig", "arrowMarkerAbsolute"]) {
    assert.ok(scripts[4].includes(`"${key}"`), key);
  }
  assert.match(scripts[4], /securityLevel: "strict"/);
  assert.match(scripts[4], /trust: false/);
});
