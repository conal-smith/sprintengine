import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { motionDurations, useReducedMotion } from "./motion";
import { useThemedStyles } from "../theme/ThemeProvider";
import { space, typography, type Theme } from "../theme/tokens";

interface SidePanelProps {
  visible: boolean;
  onClose: () => void;
  /** Panel heading, read to the screen reader as the dialog's name. */
  title: string;
  children: ReactNode;
}

/**
 * A panel that slides in from the left edge, over a scrim.
 *
 * This is `BottomSheet`'s Modal + scrim + safe-area + reduced-motion approach
 * rendered against the leading edge instead of the bottom one. It is deliberately
 * *not* `@react-navigation/drawer`: that is not a dependency, and it would pull in
 * `react-native-gesture-handler` and `react-native-reanimated` — three native deps
 * and a rebuild — to render a surface this composes from what is already here.
 *
 * It is also not a navigation destination. The drawer stays retired (the tab bar
 * is the navigation model); this only ever hosts a context switcher, so nothing
 * inside it pushes a route.
 *
 * The Modal owns the fade, and the panel owns its own slide, because Modal's only
 * built-in slide comes from the bottom edge. `useReducedMotion` collapses both to
 * an instant present.
 */
export function SidePanel({ visible, onClose, title, children }: SidePanelProps) {
  // Read here, not in the body below, and passed down.
  //
  // `useReducedMotion` reports `true` until `AccessibilityInfo` answers, which is
  // a frame or two after mount. This component is long-lived (it hangs off the
  // header for the tab's whole life), so by the time anyone taps, its value has
  // settled. The body remounts on every open — Modal renders nothing while
  // hidden — so a `useReducedMotion` call *there* would read the pessimistic
  // `true` on its first render every single time, take the "no motion" branch,
  // and the panel would never slide for anyone.
  const reducedMotion = useReducedMotion();

  return (
    <Modal animationType={reducedMotion ? "none" : "fade"} onRequestClose={onClose} transparent visible={visible}>
      <SidePanelBody onClose={onClose} reducedMotion={reducedMotion} title={title}>
        {children}
      </SidePanelBody>
    </Modal>
  );
}

function SidePanelBody({
  onClose,
  reducedMotion,
  title,
  children,
}: Omit<SidePanelProps, "visible"> & { reducedMotion: boolean }) {
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  const panelWidth = Math.min(width * 0.86, 360);
  // Fresh per open, so the panel always starts against the leading edge.
  const slide = useRef(new Animated.Value(reducedMotion ? 0 : -panelWidth)).current;

  useEffect(() => {
    if (reducedMotion) {
      slide.setValue(0);
      return;
    }
    Animated.timing(slide, {
      toValue: 0,
      duration: motionDurations.base,
      useNativeDriver: true,
    }).start();
  }, [reducedMotion, slide]);

  return (
    <View style={styles.root}>
      <Pressable accessibilityLabel={`Close ${title}`} accessibilityRole="button" onPress={onClose} style={styles.scrim} />
      <Animated.View
        // Containment: the panel is the only thing the screen reader may reach
        // while it is up. The old drawer was specifically dinged for lacking this.
        accessibilityViewIsModal
        style={[
          styles.panel,
          {
            width: panelWidth,
            paddingTop: insets.top + space.xl,
            paddingBottom: insets.bottom + space.xl,
            paddingLeft: insets.left + space.xl,
            transform: [{ translateX: slide }],
          },
        ]}
      >
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        {/* The panel is full-height, so the list takes the space the title does
            not and scrolls inside it — a fleet with many projects must not push
            its own rows off the bottom edge. */}
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" style={styles.bodyScroll}>
          {children}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    root: {
      flex: 1,
    },
    scrim: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: colors.overlayScrim,
    },
    panel: {
      position: "absolute",
      left: 0,
      top: 0,
      bottom: 0,
      borderRightWidth: 1,
      borderRightColor: colors.borderDefault,
      backgroundColor: colors.bgApp,
      paddingRight: space.xl,
    },
    title: {
      ...typography.title,
      color: colors.textPrimary,
      paddingBottom: space.lg,
    },
    bodyScroll: {
      flex: 1,
    },
    body: {
      gap: space["2xs"],
      paddingBottom: space.xl,
    },
  });
