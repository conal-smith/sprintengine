/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const buildRoot = path.resolve(__dirname, "../../.mobile-test-build");
const {
  space,
  radius,
  iconSize,
  controlSize,
  hitTargetMin,
  touchSlop,
  focusRing,
  fontWeight,
  lineHeightRatio,
  tracking,
  zIndex,
  typography,
  themes,
} = require(path.join(buildRoot, "src/theme/tokens.js"));

// A rename moved every scale export onto its `--sem-*` counterpart and codemodded
// ~400 call sites. The rename was only safe because each of the phone's six old
// spacing steps landed EXACTLY on a design-system step — so this pins the mapping
// that made it value-preserving. If a step ever moves, the rename stops being a
// rename and becomes a visual change nobody asked for.
test("the spacing rename was value-preserving, step for step", () => {
  assert.equal(space["2xs"], 4, "was spacing.xs");
  assert.equal(space.sm, 8, "was spacing.sm");
  assert.equal(space.lg, 12, "was spacing.md");
  assert.equal(space.xl, 16, "was spacing.lg");
  assert.equal(space["3xl"], 24, "was spacing.xl");
  assert.equal(space["4xl"], 32, "was spacing.xxl");
});

test("the space scale is the design system's ten steps, on the 2px grid", () => {
  assert.deepEqual(Object.values(space), [2, 4, 6, 8, 10, 12, 16, 20, 24, 32]);
  for (const value of Object.values(space)) {
    assert.equal(value % 2, 0, `${value} is off the 2px grid`);
  }
});

test("radius carries the system's four semantic names, at the site's values, and the composer's two", () => {
  // rounded-full chips, rounded-md controls, rounded-xl cards/sheets, rounded-2xl hero;
  // then the message box and the context strip under it, the desktop's
  // `--sem-radius-composer` and `--sem-radius-composer-strip`.
  assert.deepEqual(radius, { chip: 999, control: 6, overlay: 12, shell: 16, composer: 22, composerStrip: 16 });
});

// The pointer scale's control heights are mouse targets. Every touch control must
// clear the hit-target floor, so the compact ramp lifts all three — and `md`
// landing exactly on the floor is the load-bearing part.
test("every control height clears the touch hit-target floor", () => {
  assert.equal(hitTargetMin, 44, "44pt is the iOS HIG minimum; the pointer scale's 24 is a mouse target");
  for (const [step, value] of Object.entries(controlSize)) {
    assert.ok(value >= 36, `control ${step} (${value}) is too small to press comfortably`);
  }
  assert.equal(controlSize.md, hitTargetMin, "the largest control IS the floor");
});

// The offset exists because borderFocus and accentPrimary are the same hue: drawn
// tight against an accent-filled control the ring has nothing to contrast with.
test("the focus ring is never drawn at a zero offset", () => {
  assert.ok(focusRing.offset > 0);
  assert.ok(focusRing.width > 0);
});

test("the compact type ramp is the five system steps, and body clears the 13px floor", () => {
  assert.deepEqual(Object.keys(typography), ["title", "heading", "body", "meta", "micro"]);
  assert.ok(typography.body.fontSize >= 13, "principles.md floors primary content at font.size.body");
  assert.equal(typography.heading.fontSize, typography.body.fontSize, "heading collapses onto body; weight separates them");
});

test("the ceilings the system sets are expressible: 3 weights, 3 line heights, 3 tracking steps", () => {
  assert.equal(Object.keys(fontWeight).length, 3);
  assert.equal(Object.keys(lineHeightRatio).length, 3);
  assert.equal(Object.keys(tracking).length, 3);
  assert.equal(tracking.normal, 0);
});

test("the z scale is ordered, so a surface cannot sit between two layers by accident", () => {
  const values = Object.values(zIndex);
  assert.deepEqual([...values].sort((a, b) => a - b), values);
});

test("both themes define every colour token, including the design-system ones", () => {
  for (const [name, theme] of Object.entries(themes)) {
    for (const token of ["bgSelectedResting", "accentPrimarySoftStrong", "textPrimary", "buttonBg", "buttonInk", "cardRing"]) {
      assert.ok(theme.colors[token], `${name} is missing ${token}`);
    }
  }
});

test("the icon ramp keeps the system's three upper steps", () => {
  assert.equal(iconSize.sm, 16);
  assert.equal(iconSize.md, 18);
  assert.equal(iconSize.lg, 22);
  assert.equal(iconSize.xs, 14, "the one compact divergence: 14 against the pointer scale's 13");
});

// The composer's chips (36), the access tag (32), a picture's remove cross (22)
// and a pull request's mark (one 18pt line) are drawn under the floor; each
// pads out to it, and a side already wide enough reaches into no neighbour.
test("a control drawn under the hit-target floor pads out to it, and only where it falls short", () => {
  for (const drawn of [18, 22, 32, 36]) {
    const slop = touchSlop(drawn, drawn);
    assert.ok(drawn + slop.top + slop.bottom >= hitTargetMin, `${drawn} tall reaches ${drawn + slop.top + slop.bottom}`);
    assert.ok(drawn + slop.left + slop.right >= hitTargetMin, `${drawn} wide reaches ${drawn + slop.left + slop.right}`);
  }
  assert.deepEqual(touchSlop(36), { top: 4, bottom: 4, left: 0, right: 0 });
  assert.deepEqual(touchSlop(hitTargetMin, 120), { top: 0, bottom: 0, left: 0, right: 0 });
});

// Option D of the desktop's conversation colours:
// the conversation, and New, sit on the theme's raised paper; the bubble and a
// command's output on the hover rung; the composer one step above the paper,
// white in Light and the hover rung in Dark, washing 55% toward the paper.
test("the conversation sits on the raised paper and the composer one step above it", () => {
  const hex = (value) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));
  for (const [name, theme] of Object.entries(themes)) {
    const { colors } = theme;
    assert.equal(colors.agentSurface, colors.bgSurfaceRaised, `${name}: the ground is the raised paper`);
    assert.equal(colors.agentInset, colors.bgHover, `${name}: the bubble is the hover rung`);
    assert.equal(colors.composerSurface, theme.isDark ? colors.bgHover : "#ffffff", `${name}: the composer's ground`);
    const top = hex(colors.composerSurface);
    const ground = hex(colors.agentSurface);
    const end = hex(colors.composerSurfaceEnd);
    top.forEach((channel, index) => {
      const mixed = channel * 0.55 + ground[index] * 0.45;
      assert.ok(Math.abs(end[index] - mixed) <= 1, `${name}: the wash settles 55% toward the conversation`);
    });
  }
});
