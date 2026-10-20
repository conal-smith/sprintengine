import { type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { FocusRing, useFocusRing } from "./FocusRing";
import { useThemedStyles } from "../theme/ThemeProvider";
import { hitTargetMin, radius, type Theme } from "../theme/tokens";

interface IconButtonProps {
  /** Accessible name. The glyph itself is decorative here, so this is the only name. */
  label: string;
  /** A glyph from `src/components/glyphs/`. Never a Unicode character. */
  icon: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  /**
   * `plain` for header and toolbar controls, where the glyph is the whole
   * affordance. `outlined` only when the control sits on a busy surface and
   * needs its own edge.
   */
  variant?: "plain" | "outlined";
}

/**
 * The app's one icon button. Three near-identical copies lived in BoardScreen,
 * BacklogScreen, and ArtifactReviewScreen; each drew a 40 pt outlined box around
 * a Unicode character and none of them met the 44 pt touch target.
 */
export function IconButton({ label, icon, onPress, disabled = false, variant = "plain" }: IconButtonProps) {
  const styles = useThemedStyles(createStyles);
  const { focused, focusProps } = useFocusRing();

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      {...focusProps}
      style={({ pressed }) => [
        styles.button,
        variant === "outlined" ? styles.outlined : null,
        pressed && !disabled ? styles.pressed : null,
        disabled ? styles.disabled : null,
      ]}
    >
      <View style={styles.glyph}>{icon}</View>
      {focused && !disabled ? <FocusRing radius={radius.control} /> : null}
    </Pressable>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    button: {
      // Positioning context for the focus ring, which is an absolutely-positioned
      // sibling so it costs no layout.
      position: "relative",
      width: hitTargetMin,
      height: hitTargetMin,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.control,
    },
    outlined: {
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      backgroundColor: colors.bgSurface,
    },
    pressed: {
      backgroundColor: colors.bgHover,
    },
    disabled: {
      opacity: 0.4,
    },
    glyph: {
      alignItems: "center",
      justifyContent: "center",
    },
  });
