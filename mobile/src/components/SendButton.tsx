import { type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { FocusRing, useFocusRing } from "./FocusRing";
import { useThemedStyles } from "../theme/ThemeProvider";
import { hitTargetMin, radius, type Theme } from "../theme/tokens";

/** The drawn disc, in points. The touch target pads out to the floor around it. */
export const SEND_BUTTON_SIZE = 36;

/**
 * The composer's send: a small round button in the accent with an up arrow,
 * New's and the chat's alike. The one filled control
 * in the composer; everything else on its row is ghost.
 *
 * `stop` is the same disc in the inverse ink, for stopping a running turn: it
 * is not a send, so it does not wear the send's colour. Off, the disc drops to
 * the selected grey and the arrow to subtle ink.
 */
export function SendButton({
  label,
  hint,
  onPress,
  onLongPress,
  disabled = false,
  variant = "send",
  renderIcon,
}: {
  label: string;
  /** What the button does beyond its name, for a reader: e.g. what a long press does. */
  hint?: string;
  onPress: () => void;
  /** A long press: the other of a pair of actions, where there is one. */
  onLongPress?: () => void;
  disabled?: boolean;
  variant?: "send" | "stop";
  /** The glyph, given the ink it sits on. */
  renderIcon: (ink: "textOnAccent" | "buttonInk" | "textSubtle") => ReactNode;
}) {
  const styles = useThemedStyles(createStyles);
  const { focused, focusProps } = useFocusRing();
  const pad = Math.max(0, (hitTargetMin - SEND_BUTTON_SIZE) / 2);
  const ink = disabled ? "textSubtle" : variant === "stop" ? "buttonInk" : "textOnAccent";
  return (
    <Pressable
      accessibilityHint={hint}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={pad}
      onLongPress={onLongPress}
      onPress={onPress}
      {...focusProps}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.disc,
            variant === "stop" ? styles.stop : null,
            disabled ? styles.off : null,
            pressed && !disabled ? styles.pressed : null,
          ]}
        >
          {renderIcon(ink)}
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
      width: SEND_BUTTON_SIZE,
      height: SEND_BUTTON_SIZE,
      borderRadius: SEND_BUTTON_SIZE / 2,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
      backgroundColor: colors.accentPrimary,
    },
    stop: {
      backgroundColor: colors.buttonBg,
    },
    off: {
      backgroundColor: colors.bgSelected,
    },
    pressed: {
      opacity: 0.85,
      transform: [{ scale: 0.97 }],
    },
  });
