// The desktop motion budget, in milliseconds. Everything that moves in this app
// picks one of these three and one ease; nothing animates for decoration.
//
// `useReducedMotion` is the gate: when it is true, transitions become instant
// (stack `animation: "none"`) and the skeleton pulse holds still. It lives with
// the glyph pack because the lifecycle spinner needed it first.
export const motionDurations = {
  /** Press feedback and micro state flips. */
  fast: 120,
  /** Disclosure: a row expanding, a sheet settling. */
  base: 180,
  /** Screen transitions, the longest thing allowed to move. */
  slow: 260,
} as const;

export { useReducedMotion } from "./glyphs/Glyph";
