import { Circle, G, Path } from "react-native-svg";

import { useTheme } from "../../theme/ThemeProvider";
import { GlyphFrame, iconSize, type GlyphProps } from "./Glyph";
import { LifecycleGlyph } from "./LifecycleGlyph";

// A status tone as a shape, in place of the 6px dot (as on the desktop:
// "A 6px disc has no shape, so every tone was the same circle and
// 'working' read like 'waiting'"). Three tones are lifecycle shapes already
// and are drawn by LifecycleGlyph, so a check here is the same check a task
// wears; neutral had no lifecycle shape, and gets the ring with a level bar.
//
//   good    — the done disc with its check cut out
//   warn    — the needs-input ring with !
//   danger  — the failed ring with ×
//   neutral — a ring with a bar, drawn on the lifecycle ring's geometry
//
// Working is not a status shape; it is the WorkingMark (StatusDot draws it).

export type StatusShapeTone = "neutral" | "good" | "warn" | "danger";

const LIFECYCLE_FOR = {
  good: "done",
  warn: "needs_input",
  danger: "failed",
} as const;

export function StatusShape({ tone, size = iconSize.xs, label }: GlyphProps & { tone: StatusShapeTone }) {
  const { colors } = useTheme();

  if (tone !== "neutral") {
    return <LifecycleGlyph label={label} live={false} size={size} state={LIFECYCLE_FOR[tone]} />;
  }

  return (
    <GlyphFrame color={colors.textSubtle} label={label} size={size} viewBox="0 0 16 16">
      <G>
        <Circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.4" />
        <Path d="M6 8h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </G>
    </GlyphFrame>
  );
}
