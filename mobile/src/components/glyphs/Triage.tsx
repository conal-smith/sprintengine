import { StyleSheet, Text } from "react-native";
import { Circle, Path, Rect } from "react-native-svg";

import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { monoFontFamily } from "../../theme/fonts";
import { type Theme } from "../../theme/tokens";
import { GlyphFrame, iconSize, type GlyphProps } from "./Glyph";

// The two triage indicators from the desktop Backlog row
// (../multicode/src/renderer/src/components/backlog/BacklogRow.tsx): difficulty
// as letters, criticality as bars. Both render an unset value as a calm dash —
// never a warning — because "unestimated" is a normal state, not a problem.
//
// Structurally identical to the protocol's difficulty/criticality unions,
// restated here so a UI primitive never depends on the wire protocol.
export type BacklogDifficulty = "xs" | "s" | "m" | "l" | "xl";
export type BacklogCriticality = "low" | "normal" | "high" | "critical";

export const DIFFICULTY_LABEL: Record<BacklogDifficulty, string> = {
  xs: "XS",
  s: "S",
  m: "M",
  l: "L",
  xl: "XL",
};

export const DIFFICULTY_WORD: Record<BacklogDifficulty, string> = {
  xs: "Extra small",
  s: "Small",
  m: "Medium",
  l: "Large",
  xl: "Extra large",
};

export const CRITICALITY_LABEL: Record<BacklogCriticality, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  critical: "Critical",
};

const UNSET_DASH = "–"; // en dash, matching the desktop row

// Difficulty reads as the t-shirt token itself, so it never depends on colour.
// Right-aligned, fixed-width, tabular so the column scans straight down.
export function DifficultyLabel({ difficulty }: { difficulty?: BacklogDifficulty }) {
  const styles = useThemedStyles(createStyles);

  return (
    <Text
      accessibilityRole="image"
      accessibilityLabel={difficulty ? `Size ${DIFFICULTY_WORD[difficulty]}` : "Size unestimated"}
      style={[styles.difficulty, difficulty ? styles.difficultySet : styles.unset]}
    >
      {difficulty ? DIFFICULTY_LABEL[difficulty] : UNSET_DASH}
    </Text>
  );
}

interface CriticalityBarsProps extends Omit<GlyphProps, "label"> {
  level?: BacklogCriticality;
}

// Criticality is shape-coded: low/normal/high are 1/2/3 filled ascending bars,
// critical is a distinct filled mark so it never collides with high on bar count
// alone. Level reads by shape, never colour alone.
export function CriticalityBars({ level, size = iconSize.xs }: CriticalityBarsProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  if (!level) {
    return (
      <Text accessibilityRole="image" accessibilityLabel="No priority set" style={[styles.unsetBox, styles.unset]}>
        {UNSET_DASH}
      </Text>
    );
  }

  // High and critical earn the stronger ink; low and normal stay quiet.
  const urgent = level === "high" || level === "critical";
  const color = urgent ? colors.textDefault : colors.textSubtle;
  const label = `Priority ${CRITICALITY_LABEL[level]}`;

  if (level === "critical") {
    return (
      <GlyphFrame viewBox="0 0 16 16" color={color} size={size} label={label}>
        <Rect x="3.5" y="3.5" width="9" height="9" rx="2" fill="currentColor" />
        <Path d="M8 5.5v3.2" stroke={colors.bgApp} strokeWidth="1.5" strokeLinecap="round" />
        <Circle cx="8" cy="11" r="0.85" fill={colors.bgApp} />
      </GlyphFrame>
    );
  }

  const filled = level === "high" ? 3 : level === "normal" ? 2 : 1;

  return (
    <GlyphFrame viewBox="0 0 16 16" color={color} size={size} label={label}>
      {BARS.map((bar, index) => (
        <Rect
          key={bar.x}
          x={bar.x}
          y={13 - bar.height}
          width="2.6"
          height={bar.height}
          rx="0.8"
          fill="currentColor"
          opacity={index < filled ? 1 : 0.3}
        />
      ))}
    </GlyphFrame>
  );
}

const BARS = [
  { x: 3, height: 4 },
  { x: 6.6, height: 7 },
  { x: 10.2, height: 10 },
];

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    difficulty: {
      minWidth: 20,
      textAlign: "right",
      fontFamily: monoFontFamily,
      fontSize: 11,
      lineHeight: 14,
      fontVariant: ["tabular-nums"],
    },
    difficultySet: {
      color: colors.textMuted,
    },
    unsetBox: {
      minWidth: 16,
      textAlign: "right",
      fontSize: 11,
      lineHeight: 14,
    },
    unset: {
      color: colors.textDisabled,
    },
  });
