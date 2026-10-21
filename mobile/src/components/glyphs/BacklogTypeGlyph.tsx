import type { ReactElement } from "react";
import { Path, Rect } from "react-native-svg";

import { useTheme } from "../../theme/ThemeProvider";
import type { ThemeColors } from "../../theme/tokens";
import { GlyphFrame, iconSize, type GlyphProps } from "./Glyph";

// Port of ../multicode/src/renderer/src/components/backlog/BacklogTypeGlyph.tsx.
// Shape-coded glyph for a Backlog item's *type*, the companion to the lifecycle
// (status) glyph. The display id is `KEY-number` and no longer encodes the type,
// so the type is read at a glance from this glyph instead. Each type reads by
// shape, never colour alone: epic = stacked layers, feature = spark, bug =
// beetle, mockup = framed artboard, spike = bolt.
//
// Structurally identical to `MobileControlBacklogItemType`, restated here so a
// UI primitive never depends on the wire protocol.
export type BacklogType = "epic" | "feature" | "bug" | "mockup" | "spike";

export const BACKLOG_TYPE_LABEL: Record<BacklogType, string> = {
  epic: "Epic",
  feature: "Feature",
  bug: "Bug",
  mockup: "Mockup",
  spike: "Spike",
};

interface BacklogTypeGlyphProps extends GlyphProps {
  type: BacklogType;
  /** Ink token. Type is a classification, not a status — it stays neutral. */
  tone?: keyof ThemeColors;
}

export function BacklogTypeGlyph({
  type,
  tone = "textMuted",
  size = iconSize.sm,
  label,
}: BacklogTypeGlyphProps) {
  const { colors } = useTheme();

  return (
    <GlyphFrame viewBox="0 0 16 16" color={colors[tone]} size={size} label={label}>
      {TYPE_SHAPES[type]}
    </GlyphFrame>
  );
}

const TYPE_SHAPES: Record<BacklogType, ReactElement> = {
  // Stacked layers — an epic is a container that rolls up child work.
  epic: (
    <>
      <Path d="M8 2.4 13.4 5 8 7.6 2.6 5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <Path d="M3 7.6 8 10.1 13 7.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M3 10.1 8 12.6 13 10.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // Four-point spark — a new capability.
  feature: <Path d="M8 2.3 9.25 6.75 13.7 8 9.25 9.25 8 13.7 6.75 9.25 2.3 8 6.75 6.75z" fill="currentColor" />,
  // Beetle — rounded body, antennae, and legs.
  bug: (
    <>
      <Rect x="5.2" y="4.8" width="5.6" height="7.4" rx="2.8" stroke="currentColor" strokeWidth="1.2" />
      <Path d="M8 5.2v6.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <Path
        d="M5.2 6.6 3.1 5.5M5 9H2.8M5.2 11.2 3.1 12.4M10.8 6.6 12.9 5.5M11 9h2.2M10.8 11.2 12.9 12.4M6.6 4.9 5.7 3.3M9.4 4.9 10.3 3.3"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </>
  ),
  // Framed artboard — a visual mockup.
  mockup: (
    <>
      <Rect x="2.8" y="3.4" width="10.4" height="9.2" rx="1.6" stroke="currentColor" strokeWidth="1.2" />
      <Path d="M2.8 6.1h10.4" stroke="currentColor" strokeWidth="1.2" />
    </>
  ),
  // Lightning bolt — a time-boxed research spike.
  spike: <Path d="M9.2 2.3 4.4 9h3.1l-.8 4.7L11.6 7H8.4z" fill="currentColor" />,
};
