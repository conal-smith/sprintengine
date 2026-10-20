import type { KeyframeStop, KeyframeTiming } from "./keyframes";
import type { AgentCharacterId } from "./seasons";

// How each character moves while its agent works: the desktop's
// `agent-glyph-*` keyframes and the per-character rules that play them
// (index.css there, design-system/components/agent-glyph/component.css),
// written as data AgentGlyph turns into native-driver loops.
//
// Pivots. The desktop turns and scales each part about its own box
// (`transform-box: fill-box`) at the `transform-origin` its rule names. A phone
// layer is the whole 16×16 glyph, so each named origin is resolved here to the
// point on the part's box it means, in glyph units. Rules that only translate
// name no origin, as on the desktop.

/** A transform or opacity channel one keyframe drives. Translations are in glyph units, turns in degrees. */
export type MotionChannel = "translateX" | "translateY" | "scaleX" | "scaleY" | "rotate" | "skewX" | "opacity";

export type AgentKeyframes = Partial<Record<MotionChannel, readonly KeyframeStop[]>>;

export const AGENT_KEYFRAMES = {
  float: { translateY: [[0, 0], [0.5, -1.2], [1, 0]] },
  blink: { scaleY: [[0, 1], [0.9, 1], [0.94, 0.1], [1, 1]] },
  look: { translateX: [[0, 0], [0.2, 0], [0.3, 1], [0.55, 1], [0.65, -1], [0.85, -1], [1, 0]] },
  scan: { translateX: [[0, -0.9], [0.5, 0.9], [1, -0.9]] },
  nod: { rotate: [[0, 0], [0.25, -3], [0.75, 3], [1, 0]] },
  rock: { rotate: [[0, -4], [0.5, 4], [1, -4]] },
  squish: {
    scaleX: [[0, 1], [0.4, 1.07], [0.7, 0.96], [1, 1]],
    scaleY: [[0, 1], [0.4, 0.92], [0.7, 1.05], [1, 1]],
  },
  antenna: { opacity: [[0, 1], [0.49, 1], [0.5, 0.25], [1, 0.25]] },
  flicker: { opacity: [[0, 1], [0.3, 0.55], [0.45, 0.9], [0.7, 0.65], [1, 1]] },
  flop: { rotate: [[0, -4], [0.5, 5], [1, -4]] },
  hoho: { translateY: [[0, 0], [0.12, -1.1], [0.24, 0], [0.36, -1.1], [0.48, 0], [1, 0]] },
  wiggle: { skewX: [[0, -6], [0.5, 6], [1, -6]] },
  twitch: { rotate: [[0, 0], [0.8, 0], [0.85, -6], [0.9, 4], [1, 0]] },
  tilt: { rotate: [[0, 0], [0.3, -8], [0.6, 6], [1, 0]] },
  peer: {
    translateX: [[0, 0], [0.25, 0.5], [0.5, -0.5], [0.75, 0.4], [1, 0]],
    translateY: [[0, 0], [0.25, -0.3], [0.5, 0.2], [0.75, 0.4], [1, 0]],
  },
} as const satisfies Record<string, AgentKeyframes>;

export type AgentKeyframeName = keyof typeof AGENT_KEYFRAMES;

export interface AgentLoop {
  keyframes: AgentKeyframeName;
  durationMs: number;
  timing: KeyframeTiming;
  /** The pivot, in glyph units on the 16 grid. */
  origin?: readonly [x: number, y: number];
}

export interface AgentMotion {
  whole: AgentLoop;
  eyes: AgentLoop;
  antenna?: AgentLoop;
  legs?: AgentLoop;
  whiskers?: AgentLoop;
  hat?: AgentLoop;
}

const easeInOut = (keyframes: AgentKeyframeName, durationMs: number, origin?: AgentLoop["origin"]): AgentLoop => ({
  keyframes,
  durationMs,
  timing: "ease-in-out",
  origin,
});

// `blink` names no timing function on the desktop, so it runs on CSS's `ease`.
const blink = (durationMs: number, centreY: number): AgentLoop => ({
  keyframes: "blink",
  durationMs,
  timing: "ease",
  origin: [8, centreY],
});

export const AGENT_MOTION: Record<AgentCharacterId, AgentMotion> = {
  // Centre bottom of the head, antenna and side bolts: x 2.1–13.9, y to 13.2.
  robot: {
    whole: easeInOut("nod", 1600, [8, 13.2]),
    eyes: easeInOut("scan", 1600),
    antenna: { keyframes: "antenna", durationMs: 1000, timing: "step-end" },
  },
  blob: {
    whole: easeInOut("squish", 1100, [8, 13.2]),
    eyes: easeInOut("look", 2600),
  },
  octopus: {
    whole: easeInOut("float", 1600),
    // Centre top of the tentacles: x 2–14, from y 9.4.
    legs: easeInOut("wiggle", 800, [8, 9.4]),
    eyes: blink(3000, 7),
  },
  owl: {
    // The body's curves reach x 2.99–13.01 and y 13.8.
    whole: easeInOut("tilt", 2400, [8, 13.8]),
    eyes: easeInOut("peer", 2400),
  },
  ghost: {
    whole: easeInOut("float", 1800),
    eyes: blink(3200, 7.6),
  },
  pumpkin: {
    whole: easeInOut("rock", 1400, [8, 14]),
    eyes: { keyframes: "flicker", durationMs: 900, timing: "step-end" },
  },
  cat: {
    whole: easeInOut("float", 2000),
    eyes: easeInOut("look", 2800),
    // Centre of the whiskers: x 1.6–14.4, y 9.8–11.8.
    whiskers: easeInOut("twitch", 2200, [8, 10.8]),
  },
  elf: {
    whole: easeInOut("float", 1200),
    // Centre bottom of the hat and its bobble: x 3.8–13.15, down to y 7.5.
    hat: easeInOut("flop", 1200, [8.475, 7.5]),
    eyes: blink(2800, 10.3),
  },
  santa: {
    whole: easeInOut("hoho", 1800),
    // Left bottom of the hat and its bobble: from x 4.6, down to y 6.9.
    hat: easeInOut("flop", 1800, [4.6, 6.9]),
    eyes: blink(3400, 9.6),
  },
};
