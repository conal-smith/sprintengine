/* global __dirname */
// Pure
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// An agent wears the same character, and a chat the same working mark, on the
// phone as on the desktop: both pick with the same FNV-1a hash from the same
// seasonal pools. This pins the hash, the pools and the season boundaries to
// the desktop's, and checks the baked keyframe tables the marks and characters
// animate from against the CSS they were written from.

const buildRoot = path.resolve(__dirname, "../../../../.mobile-test-build/src/components/glyphs/agentGlyph");
const { stablePick } = require(path.join(buildRoot, "pick.js"));
const { AGENT_CHARACTER_IDS, AGENT_SEASON_POOLS, pickAgentCharacter, seasonFor } = require(
  path.join(buildRoot, "seasons.js"),
);
const { bakeKeyframes, readBaked, sampleKeyframes } = require(path.join(buildRoot, "keyframes.js"));
const { AGENT_KEYFRAMES, AGENT_MOTION } = require(path.join(buildRoot, "motion.js"));

test("stablePick is FNV-1a: the empty seed and 'a' land where the desktop's hash puts them", () => {
  // FNV-1a 32-bit: "" is the offset basis 2166136261, "a" is 0xe40c292c.
  const items = Array.from({ length: 1000 }, (_, index) => index);
  assert.equal(stablePick("", items), 2166136261 % 1000);
  assert.equal(stablePick("a", items), 0xe40c292c % 1000);
});

test("stablePick gives a seed the same item every time, and spreads seeds that differ in one character", () => {
  const pool = ["orbit", "ripple", "think", "snake"];
  for (const seed of ["toolu_01", "chat-mac-mini-7", "build-box:session:42"]) {
    assert.equal(stablePick(seed, pool), stablePick(seed, pool));
  }
  const picks = new Set(Array.from({ length: 16 }, (_, index) => stablePick(`toolu_0${index.toString(16)}`, pool)));
  assert.equal(picks.size, pool.length, "sixteen neighbouring ids should reach every pattern");
});

test("the season pools are the desktop's: the robot in every pool, at least three in each", () => {
  assert.deepEqual(AGENT_SEASON_POOLS, {
    everyday: ["robot", "blob", "octopus", "owl"],
    halloween: ["robot", "pumpkin", "ghost", "cat"],
    christmas: ["robot", "elf", "santa"],
  });
  for (const [season, pool] of Object.entries(AGENT_SEASON_POOLS)) {
    assert.ok(pool.includes("robot"), `${season} has no robot`);
    assert.ok(pool.length >= 3, `${season} has fewer than three characters`);
    for (const id of pool) assert.ok(AGENT_CHARACTER_IDS.includes(id), `${season} names unknown ${id}`);
  }
  const pooled = new Set(Object.values(AGENT_SEASON_POOLS).flat());
  assert.deepEqual([...pooled].sort(), [...AGENT_CHARACTER_IDS].sort(), "every character belongs to a pool");
});

test("seasonFor: October is Halloween, 1–26 December is Christmas, the rest is everyday", () => {
  const on = (month, day) => seasonFor(new Date(2026, month - 1, day, 12));
  assert.equal(on(9, 30), "everyday");
  assert.equal(on(10, 1), "halloween");
  assert.equal(on(10, 31), "halloween");
  assert.equal(on(11, 1), "everyday");
  assert.equal(on(11, 30), "everyday");
  assert.equal(on(12, 1), "christmas");
  assert.equal(on(12, 26), "christmas");
  assert.equal(on(12, 27), "everyday");
  assert.equal(on(1, 1), "everyday");
  // The local calendar, to the minute: the season turns at local midnight.
  assert.equal(seasonFor(new Date(2026, 9, 31, 23, 59)), "halloween");
  assert.equal(seasonFor(new Date(2026, 10, 1, 0, 0)), "everyday");
});

test("pickAgentCharacter picks from the date's pool, stably", () => {
  const halloween = new Date(2026, 9, 15);
  const christmas = new Date(2026, 11, 20);
  for (const id of ["toolu_01", "toolu_02", "toolu_03", "toolu_04", "toolu_05"]) {
    assert.ok(AGENT_SEASON_POOLS.halloween.includes(pickAgentCharacter(id, halloween)));
    assert.ok(AGENT_SEASON_POOLS.christmas.includes(pickAgentCharacter(id, christmas)));
    assert.equal(pickAgentCharacter(id, halloween), stablePick(id, AGENT_SEASON_POOLS.halloween));
  }
});

test("sampleKeyframes reads a CSS track: stops exactly, steps(1) holds, ease-in-out is symmetric", () => {
  const orbit = [[0, 1], [0.12, 0.75], [0.3, 0.3], [0.45, 0.16], [1, 0.16]];
  assert.equal(sampleKeyframes(orbit, "linear", 0), 1);
  assert.equal(sampleKeyframes(orbit, "linear", 0.12), 0.75);
  assert.ok(Math.abs(sampleKeyframes(orbit, "linear", 0.06) - 0.875) < 1e-9);
  assert.equal(sampleKeyframes(orbit, "linear", 0.8), 0.16);

  const antenna = AGENT_KEYFRAMES.antenna.opacity;
  assert.equal(sampleKeyframes(antenna, "step-end", 0.495), 1);
  assert.equal(sampleKeyframes(antenna, "step-end", 0.5), 0.25);
  assert.equal(sampleKeyframes(antenna, "step-end", 0.99), 0.25);

  const scan = AGENT_KEYFRAMES.scan.translateX;
  assert.ok(Math.abs(sampleKeyframes(scan, "ease-in-out", 0.25)) < 1e-6, "halfway through a segment is its midpoint");
  assert.ok(sampleKeyframes(scan, "ease-in-out", 0.05) < -0.85, "ease-in-out starts slowly");
});

test("a baked table draws what the CSS would, at any phase", () => {
  const cases = [
    { stops: [[0, 1], [0.12, 0.75], [0.3, 0.3], [0.45, 0.16], [1, 0.16]], timing: "linear" },
    { stops: [[0, 1], [0.37, 1], [0.375, 0.16], [1, 0.16]], timing: "linear" },
    { stops: [[0, 0.16], [0.35, 1], [0.7, 0.16], [1, 0.16]], timing: "ease-in-out" },
    { stops: AGENT_KEYFRAMES.blink.scaleY, timing: "ease" },
    { stops: AGENT_KEYFRAMES.flicker.opacity, timing: "step-end" },
  ];
  for (const { stops, timing } of cases) {
    for (const phase of [0, 0.125, 0.5, 0.875, -0.3]) {
      const table = bakeKeyframes(stops, timing, phase);
      assert.equal(table.inputRange[0], 0);
      assert.equal(table.inputRange[table.inputRange.length - 1], 1);
      for (let i = 1; i < table.inputRange.length; i++) {
        assert.ok(table.inputRange[i] > table.inputRange[i - 1], "the native driver needs a rising input range");
      }
      const span = Math.max(...stops.map(([, v]) => v)) - Math.min(...stops.map(([, v]) => v));
      for (let step = 0; step < 200; step++) {
        const t = (step + 0.5) / 200;
        const local = ((((t + phase) % 1) + 1) % 1);
        // Skip the instant of a jump, where the two sides legitimately differ.
        const nearJump = stops.some(([offset]) => Math.abs(local - offset) < 0.002) || local > 0.998;
        if (nearJump) continue;
        const want = sampleKeyframes(stops, timing, local);
        const got = readBaked(table, t);
        assert.ok(
          Math.abs(got - want) <= span * 0.02 + 1e-9,
          `${timing} phase ${phase} at ${t.toFixed(3)}: baked ${got}, CSS ${want}`,
        );
      }
    }
  }
});

test("every character moves its whole body and its eyes, on keyframes that exist, about pivots on the glyph", () => {
  assert.deepEqual(Object.keys(AGENT_MOTION).sort(), [...AGENT_CHARACTER_IDS].sort());
  for (const [id, motion] of Object.entries(AGENT_MOTION)) {
    assert.ok(motion.whole && motion.eyes, `${id} is missing its whole-body or eye loop`);
    for (const [part, loop] of Object.entries(motion)) {
      assert.ok(AGENT_KEYFRAMES[loop.keyframes], `${id} ${part} names unknown keyframes ${loop.keyframes}`);
      assert.ok(loop.durationMs >= 800 && loop.durationMs <= 3400, `${id} ${part} runs ${loop.durationMs}ms`);
      if (loop.origin) {
        for (const value of loop.origin) assert.ok(value >= 0 && value <= 16, `${id} ${part} pivots off the grid`);
      }
    }
  }
});
