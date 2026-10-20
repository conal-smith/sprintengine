import { Fragment, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Animated, Easing, View, type ViewStyle } from "react-native";

import { useAgentCharacters, useTheme } from "../../theme/ThemeProvider";
import { WorkingMark } from "../WorkingMark";
import { GlyphFrame, iconSize, useReducedMotion } from "./Glyph";
import { LifecycleGlyph } from "./LifecycleGlyph";
import {
  AGENT_CHARACTERS,
  doneEyes,
  failedEyes,
  stoppedEyes,
  type AgentCharacterId,
  type AgentPart,
} from "./agentGlyph/characters";
import { bakeKeyframes } from "./agentGlyph/keyframes";
import { AGENT_KEYFRAMES, AGENT_MOTION, type AgentKeyframes, type AgentLoop } from "./agentGlyph/motion";
import { pickAgentCharacter } from "./agentGlyph/seasons";
import type { LifecycleState } from "./lifecycleTone";

// A spawned agent drawn as a small character: working while its agent runs
// (it moves; reduced motion holds it still), content when it is done, crossed
// out when it failed, switched off when it was stopped. The desktop's
// AgentGlyph, character for character. Which character is picked from the
// season's pool by the agent's id, so an agent keeps its face for as long as
// it is on screen, and wears the same one it does on the desktop.
//
// It sits beside the agent's name and its state in words, never instead of
// them: the character and its motion carry no state a screen reader needs.

export type AgentGlyphState = "working" | "done" | "failed" | "stopped" | "unknown";

const INK = {
  working: "accentPrimary",
  done: "textSubtle",
  failed: "toneError",
  stopped: "textSubtle",
  unknown: "textSubtle",
} as const satisfies Record<AgentGlyphState, string>;

// With characters turned off, a finished agent wears the lifecycle shape for
// how it ended. Unknown is an agent whose end was never recorded, which the
// desktop draws as done.
const PLAIN_SHAPE: Record<Exclude<AgentGlyphState, "working">, LifecycleState> = {
  done: "done",
  failed: "failed",
  stopped: "canceled",
  unknown: "done",
};

export function AgentGlyph({
  agentId,
  state,
  size = iconSize.sm,
  label,
  character,
}: {
  /** What the character is picked by: the id of the call that spawned the agent. */
  agentId: string;
  state: AgentGlyphState;
  size?: number;
  /** Accessible name; omit when adjacent text already names the agent and its state. */
  label?: string;
  /** A specific character instead of the season's pick (previews). */
  character?: AgentCharacterId;
}) {
  const { colors } = useTheme();
  const characters = useAgentCharacters();
  const reducedMotion = useReducedMotion();

  if (!characters) {
    if (state === "working") {
      // The mark's 12pt grid in the glyph's 16pt box, as the desktop sets it.
      return (
        <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
          <WorkingMark label={label ?? "Agent working"} seed={agentId} size={(size * 3) / 4} />
        </View>
      );
    }
    return <LifecycleGlyph label={label} size={size} state={PLAIN_SHAPE[state]} />;
  }

  const id = character ?? pickAgentCharacter(agentId);
  const drawing = AGENT_CHARACTERS[id];
  const color = colors[INK[state]];

  if (state === "working" && !reducedMotion) {
    return <MovingCharacter color={color} id={id} label={label} size={size} />;
  }

  const face =
    state === "working" ? null : state === "failed" ? (
      failedEyes(drawing.eyes, drawing.crossSize)
    ) : state === "stopped" ? (
      stoppedEyes(drawing.eyes)
    ) : (
      <>
        {doneEyes(drawing.eyes)}
        {drawing.doneExtra}
      </>
    );

  return (
    <GlyphFrame color={color} label={label} size={size} viewBox="0 0 16 16">
      {drawing.body}
      {state === "working" ? (
        <>
          {drawing.still}
          {partsOf(id).map((part) => (
            <Fragment key={part}>{drawing.parts[part]}</Fragment>
          ))}
        </>
      ) : (
        <>
          {drawing.rest}
          {face}
        </>
      )}
    </GlyphFrame>
  );
}

/** The drawing's moving parts, in the order the desktop draws them. */
function partsOf(id: AgentCharacterId): AgentPart[] {
  return Object.keys(AGENT_CHARACTERS[id].parts) as AgentPart[];
}

/**
 * A working character, one layer per moving part. The desktop moves `<g>`s
 * inside one SVG with CSS; here each part is its own SVG in an Animated.View,
 * so every loop runs on the native driver and nothing re-renders per frame.
 * The body's layer holds the parts' layers, so the parts move with it.
 */
function MovingCharacter({
  id,
  size,
  color,
  label,
}: {
  id: AgentCharacterId;
  size: number;
  color: string;
  label?: string;
}) {
  const drawing = AGENT_CHARACTERS[id];
  const motion = AGENT_MOTION[id];
  const a11y = label
    ? ({ accessible: true, accessibilityRole: "image", accessibilityLabel: label } as const)
    : ({ accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" } as const);

  return (
    <View {...a11y} style={{ width: size, height: size }}>
      <LoopLayer loop={motion.whole} size={size}>
        <GlyphFrame color={color} size={size} viewBox="0 0 16 16">
          {drawing.body}
          {drawing.still}
        </GlyphFrame>
        {partsOf(id).map((part) => (
          <LoopLayer key={part} loop={motion[part]} size={size}>
            <GlyphFrame color={color} size={size} viewBox="0 0 16 16">
              {drawing.parts[part]}
            </GlyphFrame>
          </LoopLayer>
        ))}
      </LoopLayer>
    </View>
  );
}

/** One part on its own loop: a full-glyph layer, turned about the part's pivot. */
function LoopLayer({ loop, size, children }: { loop: AgentLoop | undefined; size: number; children: ReactNode }) {
  const clock = useRef(new Animated.Value(0)).current;
  const durationMs = loop?.durationMs;

  useEffect(() => {
    if (durationMs === undefined) return;
    clock.setValue(0);
    const run = Animated.loop(
      Animated.timing(clock, { toValue: 1, duration: durationMs, easing: Easing.linear, useNativeDriver: true }),
    );
    run.start();
    return () => run.stop();
  }, [clock, durationMs]);

  const style = useMemo(() => (loop ? loopStyle(loop, clock, size) : null), [clock, loop, size]);

  return (
    <Animated.View style={[{ position: "absolute", left: 0, top: 0, width: size, height: size }, style]}>
      {children}
    </Animated.View>
  );
}

// The glyph is drawn on a 16 grid at `size` points, so a 1.2-unit float is
// 1.2pt at 16 and more at a hero size, as the desktop's SVG scales it.
const GRID = 16;

function loopStyle(loop: AgentLoop, clock: Animated.Value, size: number): Animated.WithAnimatedValue<ViewStyle> {
  const frames: AgentKeyframes = AGENT_KEYFRAMES[loop.keyframes];
  const table = (stops: NonNullable<AgentKeyframes[keyof AgentKeyframes]>, scale = 1) => {
    const baked = bakeKeyframes(stops, loop.timing);
    return { inputRange: baked.inputRange, outputRange: baked.outputRange.map((value) => value * scale) };
  };
  const degrees = (stops: NonNullable<AgentKeyframes[keyof AgentKeyframes]>) => {
    const baked = bakeKeyframes(stops, loop.timing);
    return { inputRange: baked.inputRange, outputRange: baked.outputRange.map((value) => `${value}deg`) };
  };
  const unit = size / GRID;

  const transform = [
    ...(frames.translateX ? [{ translateX: clock.interpolate(table(frames.translateX, unit)) }] : []),
    ...(frames.translateY ? [{ translateY: clock.interpolate(table(frames.translateY, unit)) }] : []),
    ...(frames.rotate ? [{ rotate: clock.interpolate(degrees(frames.rotate)) }] : []),
    ...(frames.skewX ? [{ skewX: clock.interpolate(degrees(frames.skewX)) }] : []),
    ...(frames.scaleX ? [{ scaleX: clock.interpolate(table(frames.scaleX)) }] : []),
    ...(frames.scaleY ? [{ scaleY: clock.interpolate(table(frames.scaleY)) }] : []),
  ];

  return {
    opacity: frames.opacity ? clock.interpolate(table(frames.opacity)) : undefined,
    transform: transform.length > 0 ? transform : undefined,
    transformOrigin: loop.origin
      ? `${(loop.origin[0] / GRID) * 100}% ${(loop.origin[1] / GRID) * 100}%`
      : undefined,
  };
}
