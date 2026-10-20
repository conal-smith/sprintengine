import { type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { FocusRing, useFocusRing } from "./FocusRing";
import { useThemedStyles } from "../theme/ThemeProvider";
import { hitTargetMin, radius, space, type Theme } from "../theme/tokens";

interface CircleButtonProps {
  /** Accessible name. The glyph is decorative, so this is the only name. */
  label: string;
  icon: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  /**
   * `raised` is the mockup's default — a 40pt disc in `bgSurfaceRaised`.
   * `quiet` drops the disc for a bare glyph (a back chevron in a top bar).
   * `inverse` is the compose button: the inverse-ink fill, one per screen.
   */
  variant?: "raised" | "quiet" | "inverse";
  /** Held open while a popover this button owns is showing. */
  active?: boolean;
  /** A red dot at the top-right — the bell with something waiting behind it. */
  badge?: boolean;
  /** 40 for the top bar, 60 for the floating compose button. */
  size?: number;
}

/**
 * The circular icon button, the phone's one round control: a round target reads as a control
 * floating over the content rather than part of a row, which is what the
 * header's few actions are.
 *
 * `IconButton` stays for the square 44pt header control the rest of the app
 * uses; this is the round one the 2026-09-05 language draws, and the two differ
 * in shape rather than in behaviour — same focus ring, same hit-target floor,
 * same accessible-name rule.
 */
export function CircleButton({
  label,
  icon,
  onPress,
  disabled = false,
  variant = "raised",
  active = false,
  badge = false,
  size = 40,
}: CircleButtonProps) {
  const styles = useThemedStyles(createStyles);
  const { focused, focusProps } = useFocusRing();
  // The drawn disc may be 40pt, but nothing interactive goes under the touch
  // floor: the Pressable pads out around the disc instead of shrinking to it.
  const pad = Math.max(0, (hitTargetMin - size) / 2);

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled, expanded: active }}
      disabled={disabled}
      onPress={onPress}
      {...focusProps}
      style={{ padding: pad }}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.disc,
            { width: size, height: size, borderRadius: size / 2 },
            variant === "quiet" ? styles.quiet : null,
            variant === "inverse" ? styles.inverse : null,
            active ? styles.active : null,
            pressed && !disabled ? styles.pressed : null,
            disabled ? styles.disabled : null,
          ]}
        >
          {icon}
          {badge ? <View style={styles.badge} /> : null}
          {focused && !disabled ? <FocusRing radius={radius.chip} /> : null}
        </View>
      )}
    </Pressable>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    disc: {
      position: "relative",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.bgSurfaceRaised,
    },
    quiet: {
      backgroundColor: "transparent",
    },
    inverse: {
      backgroundColor: colors.buttonBg,
    },
    // The mockup's "the button stays lit while its popover is open".
    active: {
      backgroundColor: colors.bgSelected,
    },
    pressed: {
      backgroundColor: colors.bgActive,
    },
    disabled: {
      opacity: 0.4,
    },
    // Ringed in the canvas so the dot reads as sitting on top of the glyph
    // rather than as part of it, exactly as the mockup draws it.
    badge: {
      position: "absolute",
      top: space.sm,
      right: space.sm,
      width: 8,
      height: 8,
      borderRadius: 4,
      borderWidth: 2,
      borderColor: colors.bgApp,
      backgroundColor: colors.toneError,
    },
  });
