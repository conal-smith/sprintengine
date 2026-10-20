import { Pressable, StyleSheet } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { radius, space, type Theme } from "../../theme/tokens";
import type { DictationState } from "./useDictation";

/** A microphone on the 16 grid, in the app's line weight. */
function MicGlyph({ color, size }: { color: string; size: number }) {
  return (
    <Svg height={size} viewBox="0 0 16 16" width={size}>
      <Rect fill="none" height={8} rx={2.5} stroke={color} strokeWidth={1.4} width={5} x={5.5} y={1.75} />
      <Path
        d="M3.25 7.5a4.75 4.75 0 0 0 9.5 0M8 12.25v2"
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeWidth={1.4}
      />
    </Svg>
  );
}

/**
 * The composer's microphone: outlined at rest, like the + beside it, and
 * filled in the accent while it listens, so the one live microphone on the
 * screen reads at a glance.
 */
export function DictationButton({
  state,
  onPress,
  disabled,
}: {
  state: DictationState;
  onPress: () => void;
  disabled?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const live = state !== "idle";
  return (
    <Pressable
      accessibilityHint={live ? "Stops listening and keeps what was heard." : "Dictate instead of typing."}
      accessibilityLabel={live ? "Stop dictating" : "Dictate"}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled, busy: state === "starting" }}
      disabled={disabled}
      hitSlop={space.xs}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        live ? styles.live : null,
        pressed ? styles.pressed : null,
        disabled ? styles.disabled : null,
      ]}
    >
      <MicGlyph color={live ? colors.textOnAccent : colors.textDefault} size={16} />
    </Pressable>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    button: {
      width: 32,
      height: 32,
      borderRadius: radius.chip,
      borderWidth: 1,
      borderColor: colors.buttonOutline,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    live: {
      backgroundColor: colors.accentPrimary,
      borderColor: colors.accentPrimary,
    },
    pressed: {
      opacity: 0.8,
    },
    disabled: {
      opacity: 0.4,
    },
  });
