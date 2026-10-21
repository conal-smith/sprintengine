/* global __dirname */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// Lifecycle glyphs are informational graphics, so WCAG 2.1 SC 1.4.11 puts them at
// 3:1 against every surface they can be painted on. This runs in `npm run ci`:
// nudging a surface token or a tone token fails the build rather than silently
// dropping the idea/archived/merged glyphs below the floor.
//
// The tone map and surface list come from the built lifecycleTone module (the
// same one LifecycleGlyph renders from). The colours are parsed out of
// src/theme/tokens.ts, which cannot be required here because it imports
// react-native.

const repoRoot = path.resolve(__dirname, "../../..");
const buildRoot = path.join(repoRoot, ".mobile-test-build");
const {
  LIFECYCLE_TONE,
  glyphSurfaces,
  lifecycleStates,
  nonTextContrastFloor,
} = require(path.join(buildRoot, "src/components/glyphs/lifecycleTone.js"));

function themeTokens(constName) {
  const src = fs.readFileSync(path.join(repoRoot, "src/theme/tokens.ts"), "utf8");
  const match = new RegExp(`const ${constName}: ThemeColors = \\{([\\s\\S]*?)\\n\\};`).exec(src);
  assert.ok(match, `could not find ${constName} in src/theme/tokens.ts`);
  const out = {};
  for (const m of match[1].matchAll(/^ {2}(\w+):\s*"([^"]+)"/gm)) out[m[1]] = m[2];
  return out;
}

const THEMES = { dark: themeTokens("darkColors"), light: themeTokens("lightColors") };

const channel = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

function luminance(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `glyph tones and surfaces must be opaque hex, got ${hex}`);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("both themes define every token the lifecycle glyphs ink from", () => {
  for (const [themeName, colors] of Object.entries(THEMES)) {
    for (const state of lifecycleStates) {
      const tone = LIFECYCLE_TONE[state];
      assert.ok(colors[tone], `${themeName} is missing the ${tone} token (needed by ${state})`);
    }
    for (const surface of glyphSurfaces) {
      assert.ok(colors[surface], `${themeName} is missing the ${surface} surface`);
    }
  }
});

test("every lifecycle glyph clears the 3:1 non-text floor on every surface, in both themes", () => {
  const failures = [];

  for (const [themeName, colors] of Object.entries(THEMES)) {
    for (const state of lifecycleStates) {
      const tone = LIFECYCLE_TONE[state];
      for (const surface of glyphSurfaces) {
        const ratio = contrast(colors[tone], colors[surface]);
        if (ratio < nonTextContrastFloor) {
          failures.push(`${themeName} ${state} (${tone} ${colors[tone]}) on ${surface} = ${ratio.toFixed(2)}:1`);
        }
      }
    }
  }

  assert.deepEqual(failures, [], `glyph tones below ${nonTextContrastFloor}:1:\n  ${failures.join("\n  ")}`);
});

test("the tightest glyph pair is Dark merged-on-selected, and it still clears the floor", () => {
  // done_merged wears --tone-merged, a cross-app identity colour that must not be
  // re-themed. It has the thinnest margin in the pack, so it is pinned here: if a
  // future bgSelected tweak pushes it under, this names the exact pair.
  //
  // The guard used to carry a hardcoded upper bound (`< 3.05`) whose only job was
  // to notice when this stopped being the tightest pair — and it fired the moment
  // a later change neutralized `bgSelected`, for a change that moved the margin the SAFE
  // way (3.0004 -> 3.1088). It now finds the tightest pair itself, so it asserts
  // the fact it always meant to and needs no retuning when a value legitimately
  // moves.
  const ratio = contrast(THEMES.dark.toneMerged, THEMES.dark.bgSelected);
  assert.ok(
    ratio >= nonTextContrastFloor,
    `Dark done_merged on bgSelected fell to ${ratio.toFixed(4)}:1`,
  );

  let tightest = { label: "dark done_merged on bgSelected", ratio };
  for (const [themeName, colors] of Object.entries(THEMES)) {
    for (const state of lifecycleStates) {
      for (const surface of glyphSurfaces) {
        const candidate = contrast(colors[LIFECYCLE_TONE[state]], colors[surface]);
        if (candidate < tightest.ratio) {
          tightest = { label: `${themeName} ${state} on ${surface}`, ratio: candidate };
        }
      }
    }
  }
  assert.equal(
    tightest.label,
    "dark done_merged on bgSelected",
    `a tighter pair appeared: ${tightest.label} at ${tightest.ratio.toFixed(4)}:1 — pin THAT one instead`,
  );
});

// --- Identity color family (the epic wheel) ---------------------------------
//
// The wheel skipped the per-theme contrast pass the tone tokens got, and washed
// out on a white card (epic amber ≈ 1.4:1 as 11px text). It is theme-scoped now;
// this sweep keeps it so.

const { backlogHighlightColors, backlogHighlightHexByTheme } = require(
  path.join(buildRoot, "src/features/backlog/backlogLogic.js"),
);

test("epic wheel chip text clears the 4.5:1 small-text floor on the card surfaces it sits on", () => {
  // The chip label is 11px text (WCAG 1.4.3 small-text floor, 4.5:1). Chips
  // render on backlog row/detail cards: bgSurface and bgSurfaceRaised. The
  // band tint behind grouped rows is a 7% wash of the same hex over bgSurface,
  // close enough to bgSurface that pinning the base surfaces covers it.
  const textFloor = 4.5;
  const chipSurfaces = ["bgSurface", "bgSurfaceRaised"];
  const failures = [];

  for (const [themeName, colors] of Object.entries(THEMES)) {
    for (const slot of backlogHighlightColors) {
      const hex = backlogHighlightHexByTheme[themeName][slot];
      for (const surface of chipSurfaces) {
        const ratio = contrast(hex, colors[surface]);
        if (ratio < textFloor) {
          failures.push(`${themeName} ${slot} (${hex}) on ${surface} = ${ratio.toFixed(2)}:1`);
        }
      }
    }
  }

  assert.deepEqual(failures, [], `epic wheel below ${textFloor}:1:\n  ${failures.join("\n  ")}`);
});

// --- Text on tint: the 2026-09-05 row states --------------------------------
//
// The chat row's colour is its whole message: needs-input is the warn title on
// the warn wash, and a turn that finished while you were away is the good title
// on a 10% good wash. Both are text on a tinted surface, so WCAG 1.4.3's
// small-text floor applies — 4.5:1 — and neither wash is opaque, so each has to
// be composited over the canvas it is painted on before it can be measured.

/** `rgba(r, g, b, a)` over an opaque hex — what the phone actually renders. */
function composite(rgba, overHex) {
  const parts = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(rgba);
  assert.ok(parts, `expected an rgba() wash, got ${rgba}`);
  const alpha = parts[4] === undefined ? 1 : Number(parts[4]);
  const base = [1, 3, 5].map((i) => parseInt(overHex.slice(i, i + 2), 16));
  const out = [1, 2, 3].map((i, index) => Math.round(Number(parts[i]) * alpha + base[index] * (1 - alpha)));
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** The good wash the finished row draws: the tone at 10%, per the studio's rule. */
function goodWash(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, 0.1)`;
}

test("a chat row's tinted states keep their titles readable: warn on warn wash, good on good wash", () => {
  const textFloor = 4.5;
  const failures = [];

  for (const [themeName, colors] of Object.entries(THEMES)) {
    const pairs = [
      // Needs input: `toneWarnSoft` over the canvas, title in `toneWarn`.
      { label: "warn title on the warn wash", ink: colors.toneWarn, wash: colors.toneWarnSoft },
      // Finished while away: the good tone at 10%, title in `toneGood`.
      { label: "good title on the good wash", ink: colors.toneGood, wash: goodWash(colors.toneGood) },
    ];
    for (const pair of pairs) {
      // Both washes are drawn on the app canvas (the list) and on a card, and
      // the two surfaces differ in Dark, so both are measured.
      for (const surface of ["bgApp", "bgSurface"]) {
        const composited = composite(pair.wash, colors[surface]);
        const ratio = contrast(pair.ink, composited);
        if (ratio < textFloor) {
          failures.push(`${themeName} ${pair.label} over ${surface} (${composited}) = ${ratio.toFixed(2)}:1`);
        }
      }
    }
  }

  assert.deepEqual(failures, [], `row-state text below ${textFloor}:1:\n  ${failures.join("\n  ")}`);
});

test("the working seat's accent ink is readable beside the working mark it sits with", () => {
  // The one seat that stays is working: the working mark plus the elapsed time
  // in accent ink. The number is 11px text on the untinted row, so it
  // takes the small-text floor; the mark is non-text and takes 3:1.
  const failures = [];
  for (const [themeName, colors] of Object.entries(THEMES)) {
    for (const surface of ["bgApp", "bgSurface"]) {
      const ratio = contrast(colors.accentPrimary, colors[surface]);
      if (ratio < 4.5) failures.push(`${themeName} accent seat on ${surface} = ${ratio.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(failures, [], `working seat below 4.5:1:\n  ${failures.join("\n  ")}`);
});
