import { Pressable, StyleSheet, View } from "react-native";

import { FocusRing, useFocusRing } from "./FocusRing";
import { useThemedStyles } from "../theme/ThemeProvider";
import { hitTargetMin, radius, space, type Theme } from "../theme/tokens";

/**
 * The settings switch.
 *
 * `accessibilityRole="switch"` rather than a button, so the screen reader says
 * "on"/"off" instead of leaving the state to the caller's label — the visual
 * state here is carried by position and fill, neither of which VoiceOver reads.
 * Accent on, `bgSelected` off: green is the app's one accent and this is the
 * only place it fills anything, which the visual reset allows for a control
 * whose whole meaning is on-versus-off.
 */
export function Toggle({
  value,
  onValueChange,
  label,
  disabled = false,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const { focused, focusProps } = useFocusRing();

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      {...focusProps}
      style={styles.hit}
    >
      <View style={[styles.track, value ? styles.trackOn : null, disabled ? styles.disabled : null]}>
        <View style={[styles.knob, value ? styles.knobOn : null]} />
        {focused && !disabled ? <FocusRing radius={radius.chip} /> : null}
      </View>
    </Pressable>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    hit: {
      minHeight: hitTargetMin,
      justifyContent: "center",
      paddingLeft: space.md,
    },
    track: {
      position: "relative",
      width: 50,
      height: 30,
      borderRadius: 15,
      justifyContent: "center",
      backgroundColor: colors.bgSelected,
    },
    trackOn: {
      backgroundColor: colors.accentPrimary,
    },
    knob: {
      position: "absolute",
      left: 3,
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: colors.textMuted,
    },
    knobOn: {
      left: 23,
      backgroundColor: colors.textOnAccent,
    },
    disabled: {
      opacity: 0.45,
    },
  });
