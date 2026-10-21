import { Pressable, StyleSheet, Text } from "react-native";

import { FocusRing, useFocusRing } from "./FocusRing";
import { useThemedStyles } from "../theme/ThemeProvider";
import { controlSize, radius, space, typography, type Theme, fontWeight } from "../theme/tokens";

interface PrimaryButtonProps {
  label: string;
  onPress: () => void;
  /**
   * `primary` is the inverse-ink fill — the site's "Download now": neutral-900
   * on the white page, neutral-100 on the black one. One per screen.
   * `secondary` is the site's outlined "Learn more". `danger` is the same outline
   * in danger ink. `ghost` is a bare label for tertiary actions (Sign out).
   */
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  accessibilityLabel?: string;
}

export function PrimaryButton({
  label,
  onPress,
  variant = "primary",
  disabled = false,
  accessibilityLabel,
}: PrimaryButtonProps) {
  const { styles, labelStyles, pressedStyles } = useThemedStyles(createStyles);
  const { focused, focusProps } = useFocusRing();

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      {...focusProps}
      style={({ pressed }) => [
        styles.button,
        styles[variant],
        pressed && !disabled ? pressedStyles[variant] : null,
        disabled ? styles.disabled : null,
      ]}
    >
      <Text style={[styles.label, labelStyles[variant]]}>{label}</Text>
      {focused && !disabled ? <FocusRing radius={radius.control} /> : null}
    </Pressable>
  );
}

const createStyles = ({ colors }: Theme) => ({
  styles: StyleSheet.create({
    button: {
      // The ring is an absolutely-positioned sibling, so the control must be its
      // positioning context.
      position: "relative",
      minHeight: controlSize.sm,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.control,
      paddingHorizontal: space["2xl"],
      paddingVertical: space.md,
    },
    primary: {
      backgroundColor: colors.buttonBg,
    },
    secondary: {
      backgroundColor: "transparent",
      borderWidth: 1,
      borderColor: colors.buttonOutline,
    },
    danger: {
      backgroundColor: "transparent",
      borderWidth: 1,
      borderColor: colors.buttonOutline,
    },
    ghost: {
      backgroundColor: "transparent",
      paddingHorizontal: space.lg,
    },
    disabled: {
      opacity: 0.45,
    },
    label: {
      ...typography.body,
      fontWeight: fontWeight.medium,
    },
  }),
  labelStyles: StyleSheet.create({
    primary: {
      color: colors.buttonInk,
    },
    secondary: {
      color: colors.textDefault,
    },
    danger: {
      color: colors.toneError,
    },
    ghost: {
      color: colors.textMuted,
    },
  }),
  pressedStyles: StyleSheet.create({
    primary: {
      opacity: 0.85,
    },
    secondary: {
      backgroundColor: colors.bgHover,
    },
    danger: {
      backgroundColor: colors.toneErrorSoft,
    },
    ghost: {
      backgroundColor: colors.bgHover,
    },
  }),
});
