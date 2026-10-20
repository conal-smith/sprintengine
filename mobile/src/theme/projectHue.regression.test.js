/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const buildRoot = path.resolve(__dirname, "../../.mobile-test-build");
const { isProjectHue, projectHueColor } = require(path.join(buildRoot, "src/theme/projectHue.js"));

// The desktop names eight preset hues in `PROJECT_COLOR_PRESETS`. If this
// conversion is right, each of those degrees comes out as a colour a person
// would give that name — which is a far better check of the OKLCH pipeline than
// pinning whatever the function happened to return the day it was written.
//
// `channel` reads one component so a failure says WHICH way the colour went.
function channels(rgb) {
  const [red, green, blue] = rgb.match(/\d+/g).map(Number);
  return { red, green, blue };
}

test("each of the desktop's preset degrees comes out as the colour the desktop calls it", () => {
  const red = channels(projectHueColor(25, "light"));
  assert.ok(red.red > red.green && red.red > red.blue, `25° is red: ${JSON.stringify(red)}`);

  const green = channels(projectHueColor(145, "light"));
  assert.ok(green.green > green.red && green.green > green.blue, `145° is green: ${JSON.stringify(green)}`);

  const blue = channels(projectHueColor(255, "light"));
  assert.ok(blue.blue > blue.red && blue.blue > blue.green, `255° is blue: ${JSON.stringify(blue)}`);

  const cyan = channels(projectHueColor(200, "light"));
  assert.ok(cyan.green > cyan.red && cyan.blue > cyan.red, `200° is cyan: ${JSON.stringify(cyan)}`);

  const yellow = channels(projectHueColor(100, "light"));
  assert.ok(yellow.red > yellow.blue && yellow.green > yellow.blue, `100° is yellow: ${JSON.stringify(yellow)}`);

  const violet = channels(projectHueColor(300, "light"));
  assert.ok(violet.blue > violet.green && violet.red > violet.green, `300° is violet: ${JSON.stringify(violet)}`);
});

test("dark mode paints the same hue lighter, because the token pair says so", () => {
  // --sem-color-mark-project-lightness is 0.54 light and 0.74 dark. A hue that
  // did not brighten would mean the mode was being ignored — the failure that
  // leaves every project mark unreadable on one theme.
  for (const hue of [25, 100, 145, 200, 255, 300]) {
    const light = channels(projectHueColor(hue, "light"));
    const dark = channels(projectHueColor(hue, "dark"));
    const sum = (c) => c.red + c.green + c.blue;
    assert.ok(sum(dark) > sum(light), `${hue}° is lighter in dark mode`);
  }
});

test("every degree on the wheel resolves to a paintable colour, in both modes", () => {
  for (let hue = 0; hue < 360; hue += 1) {
    for (const mode of ["light", "dark"]) {
      const value = projectHueColor(hue, mode);
      assert.match(value, /^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/, `${hue}° ${mode}`);
      const { red, green, blue } = channels(value);
      for (const channel of [red, green, blue]) {
        assert.ok(channel >= 0 && channel <= 255, `${hue}° ${mode} channel in range`);
      }
    }
  }
});

test("only a whole degree on the wheel is a hue; everything else is no colour at all", () => {
  assert.equal(isProjectHue(0), true, "zero is red, not a missing hue");
  assert.equal(isProjectHue(359), true);
  assert.equal(isProjectHue(360), false);
  assert.equal(isProjectHue(-1), false);
  assert.equal(isProjectHue(12.5), false);
  assert.equal(isProjectHue("300"), false);
  assert.equal(isProjectHue(null), false);

  // A row with no project keeps its ordinary muted ink rather than being given
  // a colour that would imply one.
  assert.equal(projectHueColor(null, "light"), null);
  assert.equal(projectHueColor(undefined, "dark"), null);
  assert.equal(projectHueColor(360, "light"), null);
});
