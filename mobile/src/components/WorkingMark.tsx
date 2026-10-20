import { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, View } from "react-native";

import { bakeKeyframes, type KeyframeStop, type KeyframeTiming } from "./glyphs/agentGlyph/keyframes";
import { stablePick } from "./glyphs/agentGlyph/pick";
import { useReducedMotion } from "./motion";
import { useTheme } from "../theme/ThemeProvider";

// WorkingMark — "an agent is working right now": a 3×3 grid of cells in the
// accent, animated by one of four patterns. The desktop's mark
// (components/ui/WorkingMark.tsx and its `working-mark` keyframes), pattern for
// pattern. It replaces the three static dots: a dot has no shape, so working
// read the same as waiting.
//
// Which pattern is picked by `seed` (a chat's or an agent's id) with the
// desktop's hash, so a chat wears the same mark on both screens and a column of
// working chats does not all move in step.
//
//   orbit  — a lit cell runs round the edge, trailing a fading tail
//   ripple — a diagonal wave washes across, corner to corner
//   think  — cells light in a shuffled order, like it is working something out
//   snake  — a three-cell snake slithers round the edge
//
// One clock per mark on the native driver; each cell reads it through its own
// table, the desktop's per-cell `animation-delay` baked in as a phase. Reduced
// motion holds every pattern on the same still frame: the corners and the
// centre lit.

export const WORKING_MARK_VARIANTS = ["orbit", "ripple", "think", "snake"] as const;
export type WorkingMarkVariant = (typeof WORKING_MARK_VARIANTS)[number];

const REST_OPACITY = 0.16;
const STILL_LIT_OPACITY = 0.9;

// The edge of the grid clockwise from the top-left, as row-major cell indexes.
const RING = [0, 1, 2, 5, 8, 7, 6, 3];
// The order `think` lights its cells in.
const THINK_ORDER = [4, 0, 8, 2, 6, 1, 7, 3, 5];

interface Pattern {
  periodMs: number;
  timing: KeyframeTiming;
  opacity: readonly KeyframeStop[];
  scale?: readonly KeyframeStop[];
  /** Each cell's `animation-delay` in ms; null holds a cell still at rest. */
  delays: (number | null)[];
}

const cells = (delay: (cell: number) => number | null) => Array.from({ length: 9 }, (_, cell) => delay(cell));

const PATTERNS: Record<WorkingMarkVariant, Pattern> = {
  orbit: {
    periodMs: 1200,
    timing: "linear",
    opacity: [[0, 1], [0.12, 0.75], [0.3, 0.3], [0.45, REST_OPACITY], [1, REST_OPACITY]],
    delays: cells((cell) => (RING.includes(cell) ? -1200 + RING.indexOf(cell) * 150 : null)),
  },
  ripple: {
    periodMs: 1300,
    timing: "ease-in-out",
    opacity: [[0, REST_OPACITY], [0.35, 1], [0.7, REST_OPACITY], [1, REST_OPACITY]],
    scale: [[0, 0.7], [0.35, 1], [0.7, 0.7], [1, 0.7]],
    delays: cells((cell) => ((cell % 3) + Math.floor(cell / 3)) * 120),
  },
  think: {
    periodMs: 1800,
    timing: "ease-in-out",
    opacity: [[0, REST_OPACITY], [0.15, 1], [0.4, REST_OPACITY], [1, REST_OPACITY]],
    delays: cells((cell) => THINK_ORDER.indexOf(cell) * 200),
  },
  // Head plus two tail cells: each edge cell is lit for three of eight steps.
  snake: {
    periodMs: 1600,
    timing: "linear",
    opacity: [[0, 1], [0.37, 1], [0.375, REST_OPACITY], [1, REST_OPACITY]],
    delays: cells((cell) => (RING.includes(cell) ? -1600 + RING.indexOf(cell) * 200 : null)),
  },
};

interface CellTables {
  opacity: ReturnType<typeof bakeKeyframes>;
  scale?: ReturnType<typeof bakeKeyframes>;
}

// Baked once per pattern, not per mark: a list of working chats shares them.
const bakedCache = new Map<WorkingMarkVariant, (CellTables | null)[]>();

function bakedCells(variant: WorkingMarkVariant): (CellTables | null)[] {
  const cached = bakedCache.get(variant);
  if (cached) return cached;
  const pattern = PATTERNS[variant];
  const baked = pattern.delays.map((delay) => {
    if (delay === null) return null;
    // A negative delay starts the cell part-way through its loop. A positive
    // one is taken the same way, which differs from CSS only in the first
    // loop, before the desktop's cell would have started.
    const phase = -delay / pattern.periodMs;
    return {
      opacity: bakeKeyframes(pattern.opacity, pattern.timing, phase),
      scale: pattern.scale ? bakeKeyframes(pattern.scale, pattern.timing, phase) : undefined,
    };
  });
  bakedCache.set(variant, baked);
  return baked;
}

export function WorkingMark({
  seed,
  size = 12,
  color,
  label = "Working",
  variant,
}: {
  /** What picks the pattern: the working chat's or agent's id. */
  seed: string;
  /** The grid's box in points. 12 draws the desktop's 3pt cells with a 1.5pt gap. */
  size?: number;
  /** Cell ink. Defaults to the theme's accent. */
  color?: string;
  /** Accessible name, e.g. "Agent working". */
  label?: string;
  /** A specific pattern instead of the seeded pick (previews). */
  variant?: WorkingMarkVariant;
}) {
  const { colors } = useTheme();
  const reducedMotion = useReducedMotion();
  const pattern = variant ?? stablePick(seed, WORKING_MARK_VARIANTS);
  const clock = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reducedMotion) return;
    clock.setValue(0);
    const loop = Animated.loop(
      Animated.timing(clock, {
        toValue: 1,
        duration: PATTERNS[pattern].periodMs,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [clock, pattern, reducedMotion]);

  const cellStyles = useMemo(
    () =>
      bakedCells(pattern).map((tables, cell) => {
        if (reducedMotion) return { opacity: cell % 2 === 0 ? STILL_LIT_OPACITY : REST_OPACITY };
        if (!tables) return { opacity: REST_OPACITY };
        return {
          opacity: clock.interpolate(tables.opacity),
          transform: tables.scale ? [{ scale: clock.interpolate(tables.scale) }] : undefined,
        };
      }),
    [clock, pattern, reducedMotion],
  );

  // The desktop's proportions at any size: 3pt cells, a 1.5pt gap, a 0.8pt
  // corner, on a 12pt grid.
  const cellSize = size / 4;
  const step = cellSize * 1.5;
  const ink = color ?? colors.accentPrimary;

  return (
    <View accessibilityLabel={label} accessibilityRole="image" accessible style={{ width: size, height: size }}>
      {cellStyles.map((style, cell) => (
        <Animated.View
          key={cell}
          style={[
            {
              position: "absolute",
              left: (cell % 3) * step,
              top: Math.floor(cell / 3) * step,
              width: cellSize,
              height: cellSize,
              borderRadius: (cellSize * 0.8) / 3,
              backgroundColor: ink,
            },
            style,
          ]}
        />
      ))}
    </View>
  );
}
