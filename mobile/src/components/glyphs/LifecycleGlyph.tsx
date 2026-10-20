import { useEffect, useRef } from "react";
import { Animated, Easing } from "react-native";
import { Circle, G, Path } from "react-native-svg";

import { useTheme } from "../../theme/ThemeProvider";
import { GlyphFrame, iconSize, useReducedMotion, type GlyphProps } from "./Glyph";
import { LIFECYCLE_TONE, type LifecycleState } from "./lifecycleTone";

// Port of ../multicode/src/renderer/src/components/ui/LifecycleGlyph.tsx,
// shape for shape. Shapes and rendering only — the state set, labels, and the
// token each state inks from live in ./lifecycleTone, where a `node --test`
// contrast check can reach them without loading react-native-svg.

// The pipeline as a filling gauge: the accent arc grows as a task advances. The
// in_progress arc rotates when live; review is the same gauge, static. Paths
// start at 12 o'clock and sweep clockwise.
const PROGRESS_ARC: Partial<Record<LifecycleState, string>> = {
  in_progress: "M8 3a5 5 0 0 1 5 5", // ¼
  review: "M8 3a5 5 0 0 1 0 10", // ½
};

const SPIN_DURATION_MS = 900;

interface LifecycleGlyphProps extends GlyphProps {
  state: LifecycleState;
  /** Animate the in-progress gauge. Set false to freeze it (not a live run). */
  live?: boolean;
}

export function LifecycleGlyph({ state, live = true, size = iconSize.sm, label }: LifecycleGlyphProps) {
  const { colors } = useTheme();
  const color = colors[LIFECYCLE_TONE[state]];
  const spinning = state === "in_progress" && live;

  const glyph = (
    <GlyphFrame viewBox="0 0 16 16" color={color} size={size} label={label}>
      <LifecycleShapes state={state} knockout={colors.bgApp} />
    </GlyphFrame>
  );

  return spinning ? <SpinningGlyph size={size}>{glyph}</SpinningGlyph> : glyph;
}

// The gauge is the only animated state, and only when genuinely live — the
// app's whole "alive right now" motion budget, spent once.
function SpinningGlyph({ size, children }: { size: number; children: React.ReactNode }) {
  const reducedMotion = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reducedMotion) return;

    progress.setValue(0);
    const spin = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: SPIN_DURATION_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    spin.start();
    return () => spin.stop();
  }, [progress, reducedMotion]);

  const rotate = progress.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });

  return (
    <Animated.View style={{ width: size, height: size, transform: [{ rotate }] }}>{children}</Animated.View>
  );
}

/**
 * `knockout` is the theme's `bgApp`: the `done` disc is filled with the state's
 * tone and the check is cut *out* of it, so the tick reads in every theme
 * (near-black on bright green in Dark, near-white on deep green in Herbarium).
 */
function LifecycleShapes({ state, knockout }: { state: LifecycleState; knockout: string }) {
  if (state === "done") {
    return (
      <G>
        <Circle cx="8" cy="8" r="5.25" fill="currentColor" />
        <Path
          d="M5.5 8.2l1.7 1.7 3.4-3.9"
          stroke={knockout}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </G>
    );
  }

  // Approved by policy: the `done` check on an outline ring instead of a filled
  // disc, so an automatic approval reads a shade lighter than a manual one while
  // staying unmistakably a green tick.
  if (state === "approved_auto") {
    return (
      <G>
        <Circle cx="8" cy="8" r="5.25" stroke="currentColor" strokeWidth="1.4" />
        <Path
          d="M5.5 8.2l1.7 1.7 3.4-3.9"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </G>
    );
  }

  // Filed evidence: a document mark (page + folded corner) with a small tick, so
  // it reads as "recorded / on file", never as a pending review or a live run.
  if (state === "recorded") {
    return (
      <G>
        <Path
          d="M4.75 2.75h3.9l2.6 2.6v7.15a.75.75 0 0 1-.75.75h-5.75a.75.75 0 0 1-.75-.75V3.5a.75.75 0 0 1 .75-.75z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <Path d="M8.5 2.9v2.15a.6.6 0 0 0 .6.6h2.05" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        <Path
          d="M5.7 9.7l1.35 1.35 2.6-2.9"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </G>
    );
  }

  // Complete on a branch: a git-fork mark rather than a check, so it reads as
  // "work sitting on a branch / PR". Shape stays constant across both states;
  // TONE carries merged-ness — green while unmerged, merged-purple once the PR
  // lands. On-main completions have no branch and render the `done` disc instead.
  if (state === "done_unmerged" || state === "done_merged") {
    return (
      <G>
        <Circle cx="5" cy="3.6" r="1.55" stroke="currentColor" strokeWidth="1.3" />
        <Circle cx="5" cy="12.4" r="1.55" stroke="currentColor" strokeWidth="1.3" />
        <Circle cx="11" cy="4.2" r="1.55" stroke="currentColor" strokeWidth="1.3" />
        <Path d="M5 5.15v5.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <Path
          d="M11 5.75v.7a3.1 3.1 0 0 1-3.1 3.1H6.5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </G>
    );
  }

  const arc = PROGRESS_ARC[state];
  if (arc) {
    return (
      <G>
        <Circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.22" />
        <Path d={arc} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </G>
    );
  }

  return (
    <G>
      <Circle
        cx="8"
        cy="8"
        r="5"
        stroke="currentColor"
        strokeWidth={state === "ready" ? 1.5 : 1.4}
        strokeDasharray={state === "idea" ? [2.2, 2.2] : undefined}
      />
      {state === "needs_input" ? (
        <>
          <Path d="M8 5.3v3.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <Circle cx="8" cy="10.7" r="0.9" fill="currentColor" />
        </>
      ) : null}
      {state === "paused" ? (
        <>
          <Path d="M6.5 5.9v4.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <Path d="M9.5 5.9v4.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </>
      ) : null}
      {state === "archived" || state === "canceled" ? (
        <Path d="M4.7 11.3l6.6-6.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      ) : null}
      {state === "failed" ? (
        <Path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      ) : null}
    </G>
  );
}
