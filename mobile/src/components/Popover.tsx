import { type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useThemedStyles } from "../theme/ThemeProvider";
import { cardShadow, radius, space, type Theme } from "../theme/tokens";

/**
 * A panel hanging under the control that opened it — the chat header's
 * details.
 *
 * A popover rather than a screen, deliberately: a few lines about where a chat
 * runs are not a place you go, and pushing a route for them would put a back
 * chevron in front of them. The bottom sheet stays for choices that carry
 * description (`BottomSheet`).
 *
 * Its own Modal, so it renders above the tab bar and takes the hardware back
 * button on Android. The scrim is invisible but real — a tap anywhere outside
 * closes it, which is the affordance a popover promises.
 */
export function Popover({
  visible,
  onClose,
  children,
  align = "right",
  /** Distance from the top of the safe area to the panel — roughly the anchor's bottom edge. */
  top = 52,
  closeLabel = "Close menu",
  width,
}: {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: "left" | "right";
  top?: number;
  closeLabel?: string;
  /** Fixed panel width; omitted, it spans the gutters. */
  width?: number;
}) {
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <Pressable accessibilityLabel={closeLabel} accessibilityRole="button" onPress={onClose} style={styles.scrim} />
      <View
        pointerEvents="box-none"
        style={[
          styles.host,
          { top: insets.top + top },
          align === "left" ? styles.hostLeft : styles.hostRight,
          width ? { width } : null,
        ]}
      >
        <View style={styles.panel}>{children}</View>
      </View>
    </Modal>
  );
}

const createStyles = (theme: Theme) => {
  const { colors } = theme;
  return StyleSheet.create({
    scrim: {
      ...StyleSheet.absoluteFillObject,
    },
    host: {
      position: "absolute",
      left: space["2xl"],
      right: space["2xl"],
    },
    hostLeft: {
      alignItems: "flex-start",
    },
    hostRight: {
      alignItems: "flex-end",
    },
    panel: {
      minWidth: 220,
      maxWidth: "100%",
      borderRadius: radius.shell,
      borderWidth: 1,
      borderColor: colors.cardRing,
      backgroundColor: colors.bgSurface,
      paddingVertical: space.sm,
      shadowColor: colors.cardShadowColor,
      // A popover floats over content in both themes, so unlike a card it keeps
      // its shadow in Dark — the ring alone cannot separate it from the list
      // showing through the transparent scrim beneath it.
      shadowOpacity: theme.isDark ? 0.5 : 0.2,
      shadowOffset: cardShadow.offset,
      shadowRadius: cardShadow.radius,
      elevation: 8,
    },
  });
};
