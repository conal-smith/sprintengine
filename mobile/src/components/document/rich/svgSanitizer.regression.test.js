/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const buildRoot = path.resolve(__dirname, "../../../../.mobile-test-build");
const { sanitizeSvg, safeSvgValue, SVG_LIMITS } = require(path.join(buildRoot, "src/components/document/rich/svgSanitizer.js"));

const wrap = (inner, attributes = 'width="100" height="50"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${inner}</svg>`;
const clean = (inner, attributes) => sanitizeSvg(wrap(inner, attributes)).svg;

// What must never reach react-native-svg, in any spelling.
const NEVER = [/<script/i, /<foreignObject/i, /<image/i, /<img/i, /<a[\s>]/i, /<use/i, /<style/i, /href/i, /\bsrc/i, /srcset/i, /\bon[a-z]+=/i, /javascript:/i, /@import/i, /url\((?!#)/i, /data:/i, /evil/i];
const assertInert = (out) => {
  for (const pattern of NEVER) assert.doesNotMatch(out, pattern);
};

test("a diagram's own shapes, text, markers and clips survive", () => {
  const svg = sanitizeSvg(
    wrap(
      '<defs><marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L10 5L0 10z" fill="rgb(82, 82, 82)"/></marker>' +
        '<clipPath id="c1"><rect x="0" y="0" width="10" height="10"/></clipPath></defs>' +
        '<g transform="translate(10 10)"><rect x="1" y="2" width="30" height="20" rx="3" fill="#eee" stroke="#999" stroke-width="1"/>' +
        '<path d="M0 0L10 10" marker-end="url(#arrow)" clip-path="url(#c1)" stroke-dasharray="3 3"/>' +
        '<text x="5" y="5" font-family="sans-serif" font-size="14" text-anchor="middle" fill="rgb(38, 38, 38)"><tspan x="5" dy="16.5">A &amp; B &lt;ok&gt;</tspan></text></g>',
      'width="100" height="50" viewBox="0 0 100 50"',
    ),
  );
  assert.equal(svg.width, 100);
  assert.equal(svg.height, 50);
  assert.match(svg.svg, /<marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="8" markerHeight="8" orient="auto">/);
  assert.match(svg.svg, /marker-end="url\(#arrow\)"/);
  assert.match(svg.svg, /clip-path="url\(#c1\)"/);
  assert.match(svg.svg, /<clipPath id="c1">/);
  assert.match(svg.svg, /<tspan x="5" dy="16.5">A &amp; B &lt;ok&gt;<\/tspan>/);
  assert.match(svg.svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="100" height="50" viewBox="0 0 100 50">/);
});

test("anything that runs, links or loads is gone with what it holds", () => {
  const out = clean(
    '<script>fetch("https://evil.example/x")</script>' +
      '<SCRIPT type="text/javascript">alert(1)</SCRIPT>' +
      '<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://evil.example/p.png"/>label</div></foreignObject>' +
      '<image href="https://evil.example/i.png" width="10" height="10"/>' +
      '<image xlink:href="https://evil.example/i.png"/>' +
      '<img src="https://evil.example/i.png" srcset="https://evil.example/2x.png 2x"/>' +
      '<use href="https://evil.example/s.svg#x"/><use xlink:href="#local"/>' +
      '<style>@import url("https://evil.example/s.css"); rect { fill: url(https://evil.example/f) }</style>' +
      '<iframe src="https://evil.example"></iframe><animate attributeName="href" to="javascript:alert(1)"/>' +
      '<set attributeName="fill" to="url(https://evil.example)"/><feImage href="https://evil.example"/>' +
      '<svg:script>alert(1)</svg:script><rect width="1" height="1"/>',
  );
  assertInert(out);
  assert.match(out, /<rect width="1" height="1"\/>/);
  assert.doesNotMatch(out, /label|alert|fetch/);
});

test("a link is unwrapped: what it held stays, the link does not", () => {
  const out = clean('<a href="https://evil.example" xlink:href="javascript:alert(1)" target="_blank"><rect width="5" height="5"/><text x="1" y="1">node</text></a>');
  assertInert(out);
  assert.match(out, /<rect width="5" height="5"\/><text x="1" y="1">node<\/text>/);
});

test("href, src, srcset and every handler are dropped from any element", () => {
  const out = clean(
    '<rect href="https://evil.example" src="https://evil.example" srcset="https://evil.example 1x" onclick="alert(1)" onload="x()" ONMOUSEOVER="y()" width="2" height="2"/>' +
      '<g xlink:href="#x" xml:base="https://evil.example/"><circle r="1" onfocus="z()"/></g>',
  );
  assertInert(out);
  assert.match(out, /<rect width="2" height="2"\/>/);
  assert.match(out, /<circle r="1"\/>/);
  assert.doesNotMatch(out, /xml:base/);
});

test("a url() that is not the drawing's own is neutralised in every attribute", () => {
  const out = clean(
    '<rect fill="url(https://evil.example/f)" stroke="url(\'//evil.example/s\')" width="1" height="1"/>' +
      '<rect filter="url(https://evil.example/f.svg#blur)" mask="url(data:image/svg+xml,evil)" width="2" height="2"/>' +
      '<path d="M0 0" marker-end="url( https://evil.example/m )" clip-path="url(&quot;https://evil.example&quot;)"/>' +
      '<rect fill="u\\72l(https://evil.example)" stroke="\\75 rl(https://evil.example)" width="3" height="3"/>' +
      '<rect fill="url(#ok) url(https://evil.example)" width="4" height="4"/>' +
      '<rect fill="image-set(&quot;https://evil.example/a.png&quot; 1x)" width="5" height="5"/>',
  );
  assertInert(out);
  for (const size of [1, 2, 3, 4, 5]) assert.match(out, new RegExp(`<rect width="${size}" height="${size}"/>`));
  assert.match(out, /<path d="M0 0"\/>/);
  assert.equal(safeSvgValue("url(#arrowhead)"), "url(#arrowhead)");
  assert.equal(safeSvgValue("url('#arrowhead')"), "url(#arrowhead)");
  assert.equal(safeSvgValue('url( "#a-b_c.1" )'), "url(#a-b_c.1)");
  assert.equal(safeSvgValue("url(#a\") url(https://evil.example)"), null);
  assert.equal(safeSvgValue("rgb(1, 2, 3)"), "rgb(1, 2, 3)");
});

test("a style attribute keeps only its safe presentation properties, as attributes", () => {
  const out = clean(
    '<rect width="1" height="1" fill="red" style="fill: blue; stroke:url(https://evil.example); @import url(https://evil.example/x.css); background-image: url(https://evil.example); behavior: url(x.htc); stroke-width: 2px !important; opacity:0.5"/>' +
      '<rect width="2" height="2" style="fill:u\\72l(https://evil.example)"/>' +
      '<rect width="3" height="3" style="-moz-binding:url(https://evil.example/x.xml#x); fill:expression(alert(1))"/>',
  );
  assertInert(out);
  assert.match(out, /<rect width="1" height="1" fill="blue" stroke-width="2px" opacity="0.5"\/>/);
  assert.match(out, /<rect width="2" height="2"\/>/);
  assert.match(out, /<rect width="3" height="3"\/>/);
  assert.doesNotMatch(out, /style=/);
});

test("doctypes, entities, comments, CDATA and processing instructions read nothing", () => {
  const out = sanitizeSvg(
    '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "https://evil.example/xxe"><!ENTITY lol "lol">]>' +
      '<!-- <script>alert(1)</script> --><?xml-stylesheet href="https://evil.example/s.css"?>' +
      '<svg width="10" height="10"><text x="0" y="0">&x;&lol;&#x41;&#66;<![CDATA[<script>c</script>]]></text></svg>',
  );
  assert.ok(out);
  assertInert(out.svg);
  assert.match(out.svg, /<text x="0" y="0">&amp;x;&amp;lol;AB&lt;script&gt;c&lt;\/script&gt;<\/text>/);
});

test("attribute values cannot break out of their quotes", () => {
  const out = clean('<text font-family="a&quot; onload=&quot;alert(1)" y="2">t</text><rect fill="red\'" height="1"/>');
  // The quote is escaped, so the handler is text inside the value.
  assert.doesNotMatch(out, /\sonload="/);
  assert.match(out, /font-family="a&quot; onload=&quot;alert\(1\)"/);
  assert.match(out, /<rect fill="red'" height="1"\/>/);
  // A length that is not one is not kept at all.
  assert.match(clean('<rect width="1&quot; onload=&quot;x" height="1"/>'), /<rect height="1"\/>/);
});

test("ids are names, not anything else", () => {
  const out = clean('<g id="ok-1_a.b"><rect id="x&quot;y" width="1" height="1"/><rect id="has space" width="2" height="2"/></g>');
  assert.match(out, /<g id="ok-1_a.b">/);
  assert.match(out, /<rect width="1" height="1"\/>/);
  assert.match(out, /<rect width="2" height="2"\/>/);
});

test("only an SVG document of a known size passes", () => {
  assert.equal(sanitizeSvg("<html><body>x</body></html>"), null);
  assert.equal(sanitizeSvg('<div><svg width="1" height="1"></svg></div>'), null);
  assert.equal(sanitizeSvg("<svg><rect/></svg>"), null);
  assert.equal(sanitizeSvg("not markup"), null);
  assert.equal(sanitizeSvg(42), null);
  assert.equal(sanitizeSvg('<svg width="1" height="1"><rect x="<'), null);
  const sized = sanitizeSvg('<svg viewBox="0 0 30 20"><rect/></svg>');
  assert.deepEqual([sized.width, sized.height], [30, 20]);
  // Whatever follows the root is ignored.
  const after = sanitizeSvg('<svg width="1" height="1"></svg><script>alert(1)</script><svg><rect/></svg>');
  assert.equal(after.svg, '<svg width="1" height="1" xmlns="http://www.w3.org/2000/svg"></svg>');
  // An unclosed document is closed.
  assert.equal(sanitizeSvg('<svg width="1" height="1"><g><rect/>').svg, '<svg width="1" height="1" xmlns="http://www.w3.org/2000/svg"><g><rect/></g></svg>');
});

test("inputs over the limits are refused whole", () => {
  assert.equal(sanitizeSvg(wrap("x".repeat(SVG_LIMITS.bytes))), null);
  assert.equal(sanitizeSvg(wrap("<g>".repeat(SVG_LIMITS.depth + 1))), null);
  assert.equal(sanitizeSvg(wrap("<rect/>".repeat(SVG_LIMITS.elements + 1))), null);
  assert.ok(sanitizeSvg(wrap("<rect/>".repeat(1000))));
});

test("text outside text elements, and namespaces' xmlns, are dropped", () => {
  const out = sanitizeSvg('<svg xmlns="http://evil.example" xmlns:xlink="http://www.w3.org/1999/xlink" width="1" height="1">stray<g>more</g></svg>');
  assert.equal(out.svg, '<svg width="1" height="1" xmlns="http://www.w3.org/2000/svg"><g></g></svg>');
});

// ---- what react-native-svg's native side can read ----------------------------
//
// Android parses a drawing's values where it draws, and throws on one it
// cannot read, on the UI thread: the app dies, and no error boundary sees it.
// These mirror its parsers (react-native-svg 15.15.3), written from its Java
// rather than from the sanitiser, and every value the sanitiser writes must
// pass them.

const { svgPathReads, svgTransform } = require(path.join(buildRoot, "src/components/document/rich/svgNativeValues.js"));
const mermaid = require("./mermaidOutput.fixture.js");

// `Double.valueOf` / `Double.parseDouble`: Java trims, and reads a decimal with
// an optional exponent and type suffix, NaN and Infinity; anything else throws.
function javaDouble(raw) {
  const text = String(raw).replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
  const match = /^([+-]?)(NaN|Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)[fFdD]?$/.exec(text);
  if (!match) throw new Error(`NumberFormatException: For input string: "${raw}"`);
  return Number(match[1] + match[2]);
}
const finite = (value, what) => {
  assert.ok(Number.isFinite(value) && Number.isFinite(Math.fround(value)), `${what} is finite: ${value}`);
  return value;
};
// `new SVGLength(String)`.
function javaSvgLength(raw) {
  const length = String(raw).trim();
  if (length === "" || length === "normal") return 0;
  if (length.endsWith("%")) return javaDouble(length.slice(0, -1));
  if (length.length - 2 > 0 && ["px", "em", "ex", "pt", "pc", "mm", "cm", "in"].includes(length.slice(-2))) return javaDouble(length.slice(0, -2));
  return javaDouble(length);
}
// `PropHelper.fromRelative(String, ...)`, for font sizes and spacing: no `ex`.
function javaFromRelative(raw) {
  const length = String(raw).trim();
  if (length === "" || length === "normal") return 0;
  if (length.endsWith("%")) return javaDouble(length.slice(0, -1));
  if (length.length - 2 > 0 && ["px", "em", "pt", "pc", "mm", "cm", "in"].includes(length.slice(-2))) return javaDouble(length.slice(0, -2));
  return javaDouble(length);
}
// `SVGLength.arrayFrom` on the list `extractLengthList` splits.
const javaLengthList = (raw) => String(raw).trim().replace(/,/g, " ").split(/\s+/).map(javaSvgLength);
// react-native-svg's XML reader hands any attribute that reads as a number on as one.
const readsAsNumber = (value) => value.trim() !== "" && !Number.isNaN(Number(value));
const ENUMS = {
  "text-anchor": ["start", "middle", "end"],
  "font-style": ["normal", "italic", "oblique"],
  markerUnits: ["strokeWidth", "userSpaceOnUse"],
  "alignment-baseline": "baseline text-bottom alphabetic ideographic middle central mathematical text-top bottom center top text-before-edge text-after-edge before-edge after-edge hanging".split(" "),
};

/** Every element of a sanitised drawing, checked as react-native-svg would read it; returns the elements. */
function assertNativeReadable(svg) {
  const elements = [...svg.matchAll(/<([A-Za-z]+)((?:\s[^\s=]+="[^"]*")*)\s*\/?>/g)].map((match) => ({
    name: match[1],
    attributes: Object.fromEntries([...match[2].matchAll(/\s([^\s=]+)="([^"]*)"/g)].map((pair) => [pair[1], pair[2].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&amp;/g, "&")])),
  }));
  const ids = new Set(elements.map((element) => element.attributes.id).filter(Boolean));
  for (const { name, attributes } of elements) {
    for (const [attribute, value] of Object.entries(attributes)) {
      const what = `${name} ${attribute}="${value}"`;
      switch (attribute) {
        case "x":
        case "y":
        case "dx":
        case "dy":
          if (name === "text" || name === "tspan") javaLengthList(value).forEach((length) => finite(length, what));
          else finite(javaSvgLength(value), what);
          break;
        case "x1":
        case "y1":
        case "x2":
        case "y2":
        case "cx":
        case "cy":
        case "r":
        case "rx":
        case "ry":
        case "fx":
        case "fy":
        case "width":
        case "height":
        case "refX":
        case "refY":
        case "markerWidth":
        case "markerHeight":
        case "stroke-width":
          finite(javaSvgLength(value), what);
          break;
        case "font-size":
        case "letter-spacing":
          finite(javaFromRelative(value), what);
          break;
        case "stroke-dasharray":
          if (value !== "none") javaLengthList(value).forEach((length) => assert.ok(finite(length, what) >= 0, what));
          break;
        case "opacity":
        case "fill-opacity":
        case "stroke-opacity":
        case "stop-opacity":
        case "stroke-miterlimit":
        case "stroke-dashoffset":
        case "offset":
          finite(javaDouble(value.replace(/%$/, "")), what);
          break;
        case "orient":
          // `MarkerView.renderMarker`: "auto", or `Double.parseDouble`.
          if (value !== "auto") finite(javaDouble(value), what);
          break;
        case "viewBox": {
          const box = value.trim().split(/[\s,]+/).map(Number);
          assert.equal(box.length, 4, what);
          box.forEach((number) => finite(number, what));
          break;
        }
        case "transform":
        case "gradientTransform":
          assert.equal(svgTransform(value), value.trim(), what);
          for (const number of value.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g)) finite(Number(number), what);
          break;
        case "d":
          assert.ok(svgPathReads(value), what);
          break;
        case "points":
          assert.ok(svgPathReads(`M${value.replace(/,/g, " ")}`), what);
          break;
        case "font-weight":
          if (!["normal", "bold", "bolder", "lighter"].includes(value)) finite(javaDouble(value), what);
          break;
        case "font-family":
        case "display":
        case "dominant-baseline":
        case "clipPathUnits":
        case "gradientUnits":
        case "spreadMethod":
        case "visibility":
        case "fill-rule":
        case "clip-rule":
        case "stroke-linecap":
        case "stroke-linejoin":
          // Strings, which must not arrive as numbers.
          assert.equal(readsAsNumber(value), false, what);
          break;
        case "marker-start":
        case "marker-mid":
        case "marker-end":
        case "clip-path": {
          const id = /^url\(#([A-Za-z0-9_.:-]+)\)$/.exec(value)?.[1];
          assert.ok(id, what);
          if (attribute.startsWith("marker")) assert.ok(ids.has(id), `${what} names a marker in the drawing`);
          break;
        }
        default:
          if (ENUMS[attribute]) assert.ok(ENUMS[attribute].includes(value), what);
      }
    }
  }
  return elements;
}

test("the parsers' mirrors refuse what react-native-svg's do", () => {
  assert.throws(() => javaDouble("auto-start-reverse"), /NumberFormatException/);
  assert.throws(() => javaSvgLength("calc(100% - 2px)"));
  assert.throws(() => javaFromRelative("2ex"));
  assert.equal(javaSvgLength("2ex"), 2);
  assert.equal(javaSvgLength("16px"), 16);
  // `PathParser.java`, traced by hand: where it throws, and where it does not.
  for (const d of ["M0 0", "M 1,1 l 9,9 M 10,1 l -9,9", "M0 0L10 5L0 10z", "m1 2 3 4", "M0 0 A 1 1 0 0 1 5 5", "M0 0a1 1 0 1110 10", "M1e2 .5", "M0 0 H 5 V 5 Z M1 1", "M 1em 0"]) {
    assert.equal(svgPathReads(d), d !== "M 1em 0", d);
  }
  for (const d of ["L0 0", "M0", "M0 0 L1", "M0 0 z 1 1", "M NaN NaN", "M0 0 A 1 1 0 2 0 5 5", "M0 0 A 1 1 0 0", "M-", "M-.", "M1e40 0", "M0 0 K 1 1", "M0 0", ""]) {
    assert.equal(svgPathReads(d), d === "", JSON.stringify(d));
  }
});

test("Mermaid's own flowcharts and sequence diagram reach react-native-svg in a form it reads", () => {
  for (const [name, { svg: raw }] of Object.entries(mermaid)) {
    const sanitized = sanitizeSvg(raw);
    assert.ok(sanitized, name);
    const { svg } = sanitized;
    // The value that killed the app, gone wherever it was.
    assert.ok(name !== "sequence" || raw.includes('orient="auto-start-reverse"'), "the fixture holds the crash");
    assert.doesNotMatch(svg, /auto-start-reverse/, name);
    const elements = assertNativeReadable(svg);
    // Every marker sits in a defs, where react-native-svg does not draw it in place.
    const opened = [];
    for (const match of svg.matchAll(/<(\/?)(defs|marker)\b[^>]*?(\/?)>/g)) {
      if (match[3]) continue;
      if (match[1]) opened.pop();
      else {
        if (match[2] === "marker") assert.ok(opened.includes("defs"), `${name}: a marker outside a defs`);
        opened.push(match[2]);
      }
    }
    // Each kind of arrow the source draws is still drawn.
    const markers = new Map(elements.filter((element) => element.name === "marker").map((element) => [element.attributes.id, element.attributes]));
    for (const end of name === "labels" ? ["marker-end"] : ["marker-start", "marker-end"]) {
      assert.ok(elements.some((element) => element.attributes[end]), `${name} has a ${end}`);
    }
    for (const marker of markers.values()) assert.ok(marker.orient === "auto" || marker.orient === "180", `${name} ${marker.id} orient ${marker.orient}`);
  }
});

test("a flowchart label's line is one run of text, its spaces kept, centred where Mermaid set it", () => {
  // The phone's pairing flowchart, whose labels drew as "Scan  thesquare":
  // Mermaid writes a line a tspan, and in it a tspan a word, each after the
  // first with its leading space.
  const raw = mermaid.labels.svg;
  assert.match(raw, /<tspan [^>]*>Scan<\/tspan><tspan [^>]*> the<\/tspan><tspan [^>]*> square<\/tspan>/, "the fixture holds the overlap");
  const { svg } = sanitizeSvg(raw);
  const texts = svg.match(/<text [^>]*>.*?<\/text>/g);
  const lines = [];
  for (const text of texts) {
    // A text holds its lines and nothing else: no tspan inside a tspan.
    const inner = /^<text ([^>]*)>(.*)<\/text>$/.exec(text);
    assert.match(inner[1], /text-anchor="middle"/, text);
    for (const line of inner[2].matchAll(/<tspan ([^>]*?)(?:\/>|>([^<]*)<\/tspan>)/g)) {
      assert.match(line[1], /^x="0" y="-?[\d.]+" dy="15.4" /, text);
      if (line[2] !== undefined) lines.push(line[2]);
    }
    assert.equal(inner[2].replace(/<tspan [^>]*?(?:\/>|>[^<]*<\/tspan>)/g, ""), "", text);
  }
  assert.deepEqual(lines.sort(), [
    "Name the desktop?",
    "No",
    "Nothing is sent",
    "Paired over the tailnet",
    "Scan the square",
    "Spend the one-time code",
    "Yes",
    "nothing is spent",
    "the desktop never hears of it, so",
  ]);
  // A label that wraps keeps a line a tspan, each with its own place.
  assert.match(svg, /<tspan x="0" y="-1.4" dy="15.4" [^>]*>the desktop never hears of it, so<\/tspan><tspan x="0" y="14" dy="15.4" [^>]*>nothing is spent<\/tspan>/);
  // Every flowchart and the sequence diagram: no tspan is left inside a tspan.
  for (const [name, { svg: drawn }] of Object.entries(mermaid)) assert.doesNotMatch(sanitizeSvg(drawn).svg, /<tspan[^>]*>[^<]*<tspan/, name);
});

test("an edge label sits on a solid box in the well's colour, which the edge's line does not show through", () => {
  const { themes } = require(path.join(buildRoot, "src/theme/tokens.js"));
  for (const name of ["flowchart", "labels"]) {
    const { svg } = sanitizeSvg(mermaid[name].svg);
    // An edge label's group: its box, then its text. (A node's label has an empty box.)
    const boxes = [...svg.matchAll(/<g><rect (x="[^>]*)\/><text [^>]*>(?:(?!<\/text>).)*?<tspan [^>]*>([^<]+)<\/tspan>/g)];
    assert.ok(boxes.length >= 2, name);
    for (const [, box, label] of boxes) {
      assert.match(box, new RegExp(`fill="${themes.light.colors.bgHover}"`), `${name}: ${label}`);
      assert.doesNotMatch(box, /opacity/, `${name}: ${label}`);
      assert.match(box, /width="[\d.]+" height="[\d.]+"/, `${name}: ${label}`);
    }
  }
});

test("a line's runs are joined only where nothing changes: a styled word, a placed word and an id stay their own", () => {
  const out = clean(
    '<text x="5" y="5" fill="red" font-size="14" text-anchor="middle">' +
      '<tspan x="5" dy="1" fill="red"><tspan fill="red">Mixed</tspan><tspan font-weight="700"> bold</tspan><tspan font-weight="700"> words</tspan><tspan fill="red"> and</tspan>' +
      '<tspan dx="2"> placed</tspan><tspan id="w"> named</tspan><tspan opacity="0.5"> faint</tspan><tspan> plain</tspan></tspan></text>',
  );
  assert.equal(
    out,
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><text x="5" y="5" fill="red" font-size="14" text-anchor="middle"><tspan x="5" dy="1" fill="red">Mixed' +
      '<tspan font-weight="700"> bold words</tspan> and<tspan dx="2"> placed</tspan><tspan id="w"> named</tspan><tspan opacity="0.5"> faint</tspan> plain</tspan></text></svg>',
  );
  // A tspan straight in its text is a run of it too; one whose value differs from the text's is not.
  assert.match(clean('<text font-size="14">One<tspan font-size="14"> two</tspan><tspan font-size="12"> three</tspan></text>'), /<text font-size="14">One two<tspan font-size="12"> three<\/tspan><\/text>/);
});

test("an auto-start-reverse marker is auto at its end, and a reversed copy at its start", () => {
  const raw = mermaid.sequence.svg;
  const { svg } = sanitizeSvg(raw);
  // Mermaid's own: the `<<->>` message starts and ends on `arrowhead`.
  assert.match(raw, /marker-start="url\(#arrowhead\)"/);
  assert.match(svg, /<marker id="arrowhead" refX="7.9" refY="5" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="12" orient="auto">(<path [^>]*\/>)<\/marker>/);
  const head = /<marker id="arrowhead" [^>]*>(<path [^>]*\/>)<\/marker>/.exec(svg)[1];
  // The copy: a new id, auto, its contents turned about the centre of its
  // 12 by 12 box, and its reference point with them (7.9, 5 to 4.1, 7), so
  // each point sits where turning about the reference point puts it.
  assert.ok(
    svg.includes(
      `<marker id="arrowhead-reversed" refX="4.1" refY="7" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="12" orient="auto"><g transform="rotate(180 6 6)">${head}</g></marker>`,
    ),
  );
  // Starts point at the copy; ends keep the marker.
  assert.doesNotMatch(svg, /marker-start="url\(#arrowhead\)"/);
  assert.match(svg, /marker-start="url\(#arrowhead-reversed\)"/);
  assert.match(svg, /marker-end="url\(#arrowhead\)"/);
  assert.doesNotMatch(svg, /marker-end="url\(#arrowhead-reversed\)"/);
  // As many starts as Mermaid drew, every one repointed.
  assert.equal(svg.match(/marker-start=/g).length, raw.match(/marker-start=/g).length);

  // A flowchart's `<-->` uses its own start marker, drawn backwards already: left as it is.
  const flow = sanitizeSvg(mermaid.flowchart.svg).svg;
  assert.match(flow, /marker-start="url\(#diagram1_flowchart-v2-pointStart\)"/);
  assert.doesNotMatch(flow, /-reversed/);

  // Unused at a start, no copy; a taken id is not reused; a copy is made once.
  const once = clean(
    '<defs><marker id="m" refX="2" refY="3" orient="auto-start-reverse"><path d="M0 0L4 2L0 4z"/></marker></defs><rect id="m-reversed" width="1" height="1"/>' +
      '<path d="M0 0L9 9" marker-start="url(#m)" marker-end="url(#m)"/><path d="M1 1L8 8" marker-start="url(#m)"/>',
  );
  assert.equal(once.match(/<marker /g).length, 2);
  assert.match(once, /<marker id="m-reversed-" refX="1" refY="0" orient="auto"><g transform="rotate\(180 1.5 1.5\)"><path d="M0 0L4 2L0 4z"\/><\/g><\/marker>/);
  // In a viewBox, about its centre.
  assert.match(
    clean('<defs><marker id="v" viewBox="0 0 10 10" refX="10" refY="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"/></marker></defs><path d="M0 0L9 9" marker-start="url(#v)"/>'),
    /<marker id="v-reversed" viewBox="0 0 10 10" refX="0" refY="5" orient="auto"><g transform="rotate\(180 5 5\)">/,
  );
  assert.equal(once.match(/marker-start="url\(#m-reversed-\)"/g).length, 2);
  assert.match(once, /marker-end="url\(#m\)"/);
  assert.doesNotMatch(clean('<defs><marker id="m" orient="auto-start-reverse"><path d="M0 0L4 2z"/></marker></defs><path d="M0 0L9 9" marker-end="url(#m)"/>'), /reversed/);
  // A reference point that is not a number keeps its starts as they were, readable.
  const percent = clean('<defs><marker id="m" refX="50%" orient="auto-start-reverse"><path d="M0 0L4 2z"/></marker></defs><path d="M0 0L9 9" marker-start="url(#m)"/>');
  assert.match(percent, /orient="auto"/);
  assert.match(percent, /marker-start="url\(#m\)"/);
  assertNativeReadable(percent);
});

test("a marker's fixed angle is drawn as written, and a marker outside a defs is not drawn in place", () => {
  // `MarkerView` draws a fixed angle 180° further round than it says.
  const orient = (value) => /orient="([^"]*)"/.exec(clean(`<defs><marker id="m"${value === undefined ? "" : ` orient="${value}"`}><path d="M0 0L1 1"/></marker></defs>`))[1];
  assert.equal(orient("auto"), "auto");
  assert.equal(orient(" auto "), "auto");
  assert.equal(orient("0"), "180");
  assert.equal(orient("90"), "270");
  assert.equal(orient("45deg"), "225");
  assert.equal(orient("-90"), "90");
  assert.equal(orient(undefined), "180", "SVG's default is 0");
  assert.equal(orient("sideways"), "180", "an angle it cannot read is SVG's 0");
  // Mermaid writes its markers inside a g: each is put in a defs of its own.
  assert.equal(
    clean('<g><marker id="m" orient="auto"><path d="M0 0L1 1"/></marker><marker id="n" orient="auto"/><rect width="1" height="1"/></g>'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><g><defs><marker id="m" orient="auto"><path d="M0 0L1 1"/></marker></defs><defs><marker id="n" orient="auto"/></defs><rect width="1" height="1"/></g></svg>',
  );
});

test("a value react-native-svg cannot read is dropped, and a shape without readable geometry goes", () => {
  const out = clean(
    '<defs><marker id="m" refX="auto" refY="1" markerWidth="calc(2px)" markerHeight="-1" markerUnits="5" orient="auto-start-reverse" viewBox="0 0 auto 10" preserveAspectRatio="xMidYMid bogus"><path d="M0 0L1 1"/></marker>' +
      '<linearGradient id="g" x1="0%" x2="sideways" gradientUnits="5" gradientTransform="rotate(1e400)"><stop offset="50%" stop-opacity="NaN" stop-color="red"/></linearGradient>' +
      '<clipPath id="c" clipPathUnits="userSpaceOnUse"><rect width="1" height="1"/></clipPath></defs>' +
      '<rect id="r" x="auto" y="10px" width="calc(100% - 2px)" height="50%" rx="-5" ry="1e400" stroke-width="thin" stroke-dasharray="calc(1px) 2" stroke-dashoffset="Infinity" stroke-miterlimit="0.5" opacity="0x1" fill-rule="5" clip-path="5"/>' +
      '<circle cx="1" cy="1" r="-1" stroke-dasharray="-1 2" transform="translate(10px, 5)"/>' +
      '<ellipse rx="2" ry="3" transform="scale(1e30) scale(1e30)" stroke-linecap="squared" stroke-linejoin="arcs"/>' +
      '<line x1="0" y1="0" x2="1e39" y2="2" marker-end="none" marker-start="url(#m)" transform="translate(1,)"/>' +
      '<text x="1 2 auto" y="3" dx="2ex" font-size="large" font-weight="heavy" font-style="slanted" text-anchor="center" alignment-baseline="auto" font-family="12" letter-spacing="normal" dominant-baseline="7">t</text>' +
      '<text x="1, 2 3" font-size="2ex" font-weight="600" font-style="italic" text-anchor="middle" alignment-baseline="central" font-family="sans-serif" letter-spacing="0.5px">u</text>' +
      '<path id="p1" d="M NaN NaN L 1 1"/><path id="p2" d="M0 0 L 1"/><path id="p3" d="L 0 0"/><path id="p4" d="M0 0 A 1 1 0 2 0 5 5"/><path id="p5" d="M0 0 L1 1" fill="red"/>' +
      '<polygon id="q1" points="1,2 3"/><polygon id="q2" points="0,0 10,-5 3,4"/><polyline id="q3" points="10-5 3,4"/><polyline id="q4" points="0 0 1e40 1"/>',
  );
  assertNativeReadable(out);
  assert.match(out, /<marker id="m" refY="1" orient="auto">/);
  assert.match(out, /<linearGradient id="g" x1="0%"><stop offset="50%" stop-color="red"\/><\/linearGradient>/);
  assert.match(out, /<clipPath id="c" clipPathUnits="userSpaceOnUse">/);
  assert.match(out, /<rect id="r" y="10px" height="50%"\/>/);
  assert.match(out, /<circle cx="1" cy="1"\/>/);
  assert.match(out, /<ellipse rx="2" ry="3"\/>/);
  // What could not be read is SVG's default: reference point 0, box 3 by 3, and the copy turns in that.
  assert.match(out, /<marker id="m-reversed" refY="2" orient="auto" refX="3"><g transform="rotate\(180 1.5 1.5\)">/);
  assert.match(out, /<line x1="0" y1="0" y2="2" marker-start="url\(#m-reversed\)"\/>/);
  assert.match(out, /<text y="3" letter-spacing="normal">t<\/text>/);
  assert.match(out, /<text x="1 2 3" font-weight="600" font-style="italic" text-anchor="middle" alignment-baseline="central" font-family="sans-serif" letter-spacing="0.5px">u<\/text>/);
  for (const gone of ["p1", "p2", "p3", "p4", "q1", "q3", "q4"]) assert.doesNotMatch(out, new RegExp(`id="${gone}"`), gone);
  assert.match(out, /<path id="p5" d="M0 0 L1 1" fill="red"\/>/);
  // Points are written with a separator before every number, which react-native-svg's reading keeps whole.
  assert.match(out, /<polygon id="q2" points="0,0 10,-5 3,4"\/>/);
  // Readable transforms are kept as written.
  assert.match(clean('<g transform="translate(10, 5) rotate(45 1 2)scale(2)"/>'), /<g transform="translate\(10, 5\) rotate\(45 1 2\)scale\(2\)"\/>/);
  assert.equal(svgTransform("matrix(1 0 0 1 .5 -2e1)"), "matrix(1 0 0 1 .5 -2e1)");
  for (const transform of ["translate(1 2 3)", "rotate(1 2)", "skewX()", "translate(1, )", "translate(1),", "translate (1", "Translate(1)", ""]) assert.equal(svgTransform(transform), null, transform);
});
