// CSS keyframes, baked for Animated's native driver.
//
// The desktop's working marks and agent characters are CSS animations: a few
// stops per loop, a timing function between each pair, and a negative
// `animation-delay` to start a cell part-way round. The native driver takes
// none of that. It interpolates straight lines between the points it is given
// and accepts no easing, so each `ease-in-out` segment is written out as a run
// of points along its curve and each `steps(1)` hold as a flat line that drops
// at the next stop. A delay becomes a phase: the same curve, rotated so the
// loop's first frame is the point the desktop's cell would be at.
//
// Pure, so the regression suite can check the tables against the CSS without
// loading React Native.

/** The CSS timing functions the desktop's keyframes use. `step-end` is `steps(1)`. */
export type KeyframeTiming = "linear" | "ease" | "ease-in-out" | "step-end";

/** One stop: `[offset 0–1, value]`, as `35% { opacity: 1 }` is `[0.35, 1]`. */
export type KeyframeStop = readonly [offset: number, value: number];

/** An Animated interpolation table: feed a 0→1 linear clock through it. */
export interface BakedKeyframes {
  inputRange: number[];
  outputRange: number[];
}

const BEZIER: Record<"ease" | "ease-in-out", readonly [number, number, number, number]> = {
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

// Points written out per eased segment. Twelve keeps the chord within a
// hundredth of the curve for both timings (`ease` starts steeply, and eight
// left it two hundredths out), which is below what a 3pt cell or a 1px nod
// can show.
const SAMPLES_PER_EASED_SEGMENT = 12;

// How far before the next stop a `steps(1)` hold ends. Small enough that no
// frame lands inside it at 120Hz on the shortest loop (900ms).
const STEP_EDGE = 1e-4;

function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const curveX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const curveY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Newton first; the curves here are gentle enough that it lands in a few
    // steps. Bisection catches the flat ends where the slope vanishes.
    let t = x;
    for (let i = 0; i < 8; i++) {
      const error = curveX(t) - x;
      if (Math.abs(error) < 1e-6) return curveY(t);
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= error / slope;
    }
    let low = 0;
    let high = 1;
    t = x;
    for (let i = 0; i < 32; i++) {
      const value = curveX(t);
      if (Math.abs(value - x) < 1e-6) break;
      if (value < x) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return curveY(t);
  };
}

const EASE: Record<"ease" | "ease-in-out", (x: number) => number> = {
  ease: cubicBezier(...BEZIER.ease),
  "ease-in-out": cubicBezier(...BEZIER["ease-in-out"]),
};

/**
 * The value a CSS animation shows at `progress` (0–1) through one loop. The
 * stops must start at 0 and end at 1, as every keyframe the desktop uses does.
 */
export function sampleKeyframes(stops: readonly KeyframeStop[], timing: KeyframeTiming, progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  for (let index = 0; index < stops.length - 1; index++) {
    const [from, fromValue] = stops[index]!;
    const [to, toValue] = stops[index + 1]!;
    if (p >= to && index < stops.length - 2) continue;
    if (to === from) return toValue;
    const local = (p - from) / (to - from);
    if (timing === "step-end") return local >= 1 ? toValue : fromValue;
    const eased = timing === "linear" ? local : EASE[timing](local);
    return fromValue + (toValue - fromValue) * eased;
  }
  return stops[stops.length - 1]![1];
}

const wrap = (value: number) => ((value % 1) + 1) % 1;

/**
 * `stops` as an interpolation table for a 0→1 clock, starting `phase` of the
 * way through the loop. A CSS cell with `animation-delay: d` on a loop of
 * `period` ms has phase `-d / period` (wrapped into 0–1).
 */
export function bakeKeyframes(
  stops: readonly KeyframeStop[],
  timing: KeyframeTiming,
  phase = 0,
): BakedKeyframes {
  const start = wrap(phase);
  const at = (x: number) => sampleKeyframes(stops, timing, x);
  // The value just before `x`: where a hold or the loop's own wrap jumps, the
  // frame before the jump still shows the old value.
  const before = (x: number) => at(x > 0 ? x - 1e-7 : 1 - 1e-7);

  // Every point along one loop, in the animation's own time.
  const local: number[] = [];
  for (let index = 0; index < stops.length - 1; index++) {
    const from = stops[index]![0];
    const to = stops[index + 1]![0];
    if (timing === "step-end") {
      local.push(from, Math.max(from, to - STEP_EDGE));
    } else if (timing === "linear") {
      local.push(from);
    } else {
      for (let k = 0; k < SAMPLES_PER_EASED_SEGMENT; k++) {
        local.push(from + ((to - from) * k) / SAMPLES_PER_EASED_SEGMENT);
      }
    }
  }
  // The loop's end, as the frame before it wraps back to the first stop.
  local.push(1 - STEP_EDGE);

  // Rotated onto the clock, then fenced by the two ends of the loop.
  const points = local
    .map((x) => ({ t: wrap(x - start), value: at(x) }))
    .filter(({ t }) => t > 1e-9 && t < 1 - 1e-9)
    .sort((a, b) => a.t - b.t);

  const inputRange = [0];
  const outputRange = [at(start)];
  for (const point of points) {
    if (point.t <= inputRange[inputRange.length - 1]!) continue;
    inputRange.push(point.t);
    outputRange.push(point.value);
  }
  inputRange.push(1);
  outputRange.push(before(start));
  return { inputRange, outputRange };
}

/** Linear lookup in a baked table: what the native driver will draw at `t`. */
export function readBaked({ inputRange, outputRange }: BakedKeyframes, t: number): number {
  for (let index = 0; index < inputRange.length - 1; index++) {
    const from = inputRange[index]!;
    const to = inputRange[index + 1]!;
    if (t <= to) {
      if (to === from) return outputRange[index + 1]!;
      const local = (t - from) / (to - from);
      return outputRange[index]! + (outputRange[index + 1]! - outputRange[index]!) * local;
    }
  }
  return outputRange[outputRange.length - 1]!;
}
