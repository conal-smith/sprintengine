import { StyleSheet, Text } from "react-native";

import { useThemedStyles } from "../theme/ThemeProvider";
import { typography, type Theme, fontWeight } from "../theme/tokens";

interface StatusPillProps {
  label: string;
  tone?: "neutral" | "success" | "warning" | "danger";
}

// Status reads as calibrated text, not a colored-background chip
// (brand: "status is earned, not decorated"). Neutral states stay muted;
// tones only mark states that genuinely need attention.
export function StatusPill({ label, tone = "neutral" }: StatusPillProps) {
  const styles = useThemedStyles(createStyles);

  return (
    <Text numberOfLines={1} style={[styles.label, styles[tone]]}>
      {label}
    </Text>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    label: {
      ...typography.meta,
      fontWeight: fontWeight.medium,
      fontVariant: ["tabular-nums"],
    },
    neutral: {
      color: colors.toneNeutral,
    },
    success: {
      color: colors.toneGood,
    },
    warning: {
      color: colors.toneWarn,
    },
    danger: {
      color: colors.toneError,
    },
  });
