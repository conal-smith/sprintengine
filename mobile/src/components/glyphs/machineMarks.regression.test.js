/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// A machine's mark is the desktop's: the same nine kinds with the same
// drawings, the same eight colours with the same values, read from what the
// desktop sends and never decided here. This pins the kind and colour readers
// (an unknown kind still draws, as a desktop; an unknown colour is the
// neutral, never a guessed hue), the drawings against the desktop's
// design-system/glyphs, and every ink against its contrast floor in both
// themes.

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const {
  MACHINE_COLOURS,
  MACHINE_COLOUR_TOKEN,
  MACHINE_KINDS,
  MACHINE_KIND_DRAWINGS,
  MACHINE_KIND_LABELS,
  REMOTE_MACHINE_DRAWING,
  machineMarkInk,
  readMachineColour,
  readMachineKind,
  readMachineMark,
} = require(path.join(buildRoot, "src/components/glyphs/machineMarks.js"));
const { glyphSurfaces, nonTextContrastFloor } = require(path.join(buildRoot, "src/components/glyphs/lifecycleTone.js"));
const { themes } = require(path.join(buildRoot, "src/theme/tokens.js"));
const { PULL_REQUEST_TONE } = require(path.join(buildRoot, "src/features/conversations/chatMarks.js"));

const channel = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
function luminance(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `marks and surfaces must be opaque hex, got ${hex}`);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("the nine kinds and eight colours are the desktop's, in its order", () => {
  assert.deepEqual(
    [...MACHINE_KINDS],
    ["laptop", "desktop", "mini", "tower", "server", "cloud", "container", "board", "wsl"],
  );
  assert.deepEqual([...MACHINE_COLOURS], ["blue", "teal", "cyan", "orange", "yellow", "violet", "red", "neutral"]);
  for (const kind of MACHINE_KINDS) {
    assert.ok(MACHINE_KIND_LABELS[kind], `${kind} has a label`);
    assert.ok(MACHINE_KIND_DRAWINGS[kind].length > 0, `${kind} has a drawing`);
  }
  // No phone and no tablet: Studio never runs on one.
  assert.equal(MACHINE_KINDS.includes("phone"), false);
});

test("a kind the desktop sends is read as sent; an unknown one falls back to desktop", () => {
  assert.equal(readMachineKind("wsl"), "wsl");
  assert.equal(readMachineKind("Mini"), "mini");
  assert.equal(readMachineKind(" server "), "server");
  assert.equal(readMachineKind("quantum-computer"), "desktop");
  assert.equal(readMachineKind("phone"), "desktop");
  assert.equal(readMachineKind(""), "desktop");
  assert.equal(readMachineKind(undefined), "desktop");
  assert.equal(readMachineKind(7), "desktop");
});

test("a colour the desktop sends is read as sent; an unknown one is the neutral, never a guessed hue", () => {
  for (const colour of MACHINE_COLOURS) assert.equal(readMachineColour(colour), colour);
  assert.equal(readMachineColour("TEAL"), "teal");
  assert.equal(readMachineColour("magenta"), "neutral");
  assert.equal(readMachineColour("#ff0000"), "neutral");
  assert.equal(readMachineColour(null), "neutral");
});

test("a mark is read from the desktop's { kind, color }, and nothing else is a mark", () => {
  assert.deepEqual(readMachineMark({ kind: "mini", color: "orange" }), { kind: "mini", colour: "orange" });
  assert.deepEqual(readMachineMark({ kind: "toaster", color: "plaid" }), { kind: "desktop", colour: "neutral" });
  assert.equal(readMachineMark(null), null);
  assert.equal(readMachineMark("mini"), null);
  assert.equal(readMachineMark([]), null);
});

test("the drawings are the desktop's design-system/glyphs, coordinate for coordinate", () => {
  const paths = (kind) => MACHINE_KIND_DRAWINGS[kind].filter((part) => "path" in part).map((part) => part.path);
  const rects = (kind) => MACHINE_KIND_DRAWINGS[kind].filter((part) => "rect" in part).map((part) => part.rect);
  assert.deepEqual(rects("laptop"), [{ x: 3, y: 2.8, width: 10, height: 7.4, rx: 1.3 }]);
  assert.deepEqual(paths("laptop"), ["M1.8 12.2h12.4"]);
  assert.deepEqual(paths("desktop"), ["M8 11v2.4M5.4 13.4h5.2"]);
  assert.deepEqual(paths("mini"), ["M3.3 7.4 4.5 4.6h7l1.2 2.8M4.6 9.7h1.6"]);
  assert.deepEqual(paths("tower"), ["M6.6 4.6h2.8M6.6 6.8h2.8"]);
  assert.deepEqual(paths("server"), ["M2 6.07h12M2 9.93h12M4.4 4.13h1.6M4.4 8h1.6M4.4 11.87h1.6"]);
  assert.deepEqual(paths("cloud"), ["M4.4 12.2A2.6 2.6 0 0 1 4.9 7.1A3.4 3.4 0 0 1 11.3 6.7A2.8 2.8 0 0 1 11.6 12.2Z"]);
  assert.deepEqual(paths("container"), ["M8 1.9 13.4 5v6L8 14.1 2.6 11V5ZM2.6 5 8 8.1 13.4 5M8 8.1v6"]);
  assert.equal(rects("board").length, 2);
  assert.deepEqual(paths("wsl"), ["M2 5.4h12M4.8 7.8l1.8 1.6-1.8 1.6M8.4 11h2.8"]);
  // The Beam: the generic "another machine" mark.
  assert.deepEqual(
    REMOTE_MACHINE_DRAWING.map((part) => part.path),
    ["M1.8 6.6h7.4v5.2H1.8ZM5.5 11.8v1.8M3.6 13.6h3.8M10.6 3.2a2.2 2.2 0 0 1 2.2 2.2M10.6 1.4a4 4 0 0 1 4 4"],
  );
});

test("the palette is the desktop's mark hues in each theme, and the neutral is muted text", () => {
  const expected = {
    light: { blue: "#2b6cd4", teal: "#0f766e", cyan: "#0e7490", orange: "#c2410c", yellow: "#9a6000", violet: "#8957e5", red: "#d92d2d" },
    dark: { blue: "#5ea0f2", teal: "#2dd4bf", cyan: "#22d3ee", orange: "#fb923c", yellow: "#fcc030", violet: "#8957e5", red: "#fc787c" },
  };
  for (const [name, theme] of Object.entries(themes)) {
    for (const colour of MACHINE_COLOURS) {
      const ink = machineMarkInk(theme.colors, colour);
      if (colour === "neutral") assert.equal(ink, theme.colors.textMuted);
      else assert.equal(ink.toLowerCase(), expected[name][colour], `${name} ${colour}`);
      assert.equal(theme.colors[MACHINE_COLOUR_TOKEN[colour]], ink);
    }
  }
});

test("every machine colour clears the 3:1 glyph floor on every surface, in both themes", () => {
  const failures = [];
  for (const [name, theme] of Object.entries(themes)) {
    for (const colour of MACHINE_COLOURS) {
      for (const surface of glyphSurfaces) {
        const ratio = contrast(machineMarkInk(theme.colors, colour), theme.colors[surface]);
        if (ratio < nonTextContrastFloor) failures.push(`${name} ${colour} on ${surface} = ${ratio.toFixed(2)}:1`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("the pull request tones clear the glyph floor, and the send's arrow clears it on the accent", () => {
  const failures = [];
  for (const [name, theme] of Object.entries(themes)) {
    for (const [state, tone] of Object.entries(PULL_REQUEST_TONE)) {
      for (const surface of glyphSurfaces) {
        const ratio = contrast(theme.colors[tone], theme.colors[surface]);
        if (ratio < nonTextContrastFloor) failures.push(`${name} ${state} (${tone}) on ${surface} = ${ratio.toFixed(2)}:1`);
      }
    }
    const send = contrast(theme.colors.textOnAccent, theme.colors.accentPrimary);
    if (send < 4.5) failures.push(`${name} send arrow on the accent = ${send.toFixed(2)}:1`);
    const off = contrast(theme.colors.textSubtle, theme.colors.bgSelected);
    if (off < nonTextContrastFloor) failures.push(`${name} send arrow, off = ${off.toFixed(2)}:1`);
  }
  assert.deepEqual(failures, []);
});
