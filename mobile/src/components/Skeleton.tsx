import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { useThemedStyles } from "../theme/ThemeProvider";
import { radius, space, type Theme } from "../theme/tokens";
import { motionDurations, useReducedMotion } from "./motion";

const restingOpacity = 0.45;

interface SkeletonRowsProps {
  /** Rows to draw. Match the shape of the list this stands in for. */
  count?: number;
  /** What is loading, for the screen reader. */
  label?: string;
}

/**
 * The loading state for a list. Replaces the "Loading snapshot…" text line: a
 * sentence tells you nothing about what is arriving, four row-shaped bars tell
 * you a list is.
 *
 * The pulse is this app's one "alive right now" motion treatment, so nothing
 * else may animate while it runs. It holds still under reduce-motion.
 */
export function SkeletonRows({ count = 4, label = "Loading" }: SkeletonRowsProps) {
  const styles = useThemedStyles(createStyles);
  const pulse = useSkeletonPulse();

  // Fixed-length placeholder: the rows never reorder, so the index is the identity.
  const rows = Array.from({ length: count }, (_, index) => index);

  return (
    <View accessibilityLabel={label} accessibilityRole="progressbar" accessible style={styles.list}>
      {rows.map((index) => (
        <Animated.View key={index} style={[styles.row, { opacity: pulse }]}>
          <View style={[styles.bar, styles.titleBar]} />
          <View style={[styles.bar, styles.metaBar]} />
        </Animated.View>
      ))}
    </View>
  );
}

/**
 * The loading state for one thing of a known size — a picture on its way —
 * with the same pulse as the rows. It fills whatever box it is given.
 */
export function SkeletonBlock({ label = "Loading", style }: { label?: string; style?: StyleProp<ViewStyle> }) {
  const styles = useThemedStyles(createStyles);
  const pulse = useSkeletonPulse();
  return (
    <Animated.View
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      accessible
      style={[styles.block, style, { opacity: pulse }]}
    />
  );
}

function useSkeletonPulse(): Animated.Value {
  const reducedMotion = useReducedMotion();
  const pulse = useRef(new Animated.Value(restingOpacity)).current;

  useEffect(() => {
    if (reducedMotion) {
      pulse.setValue(1);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: motionDurations.slow,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: restingOpacity,
          duration: motionDurations.slow,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );

    loop.start();
    return () => {
      loop.stop();
      pulse.setValue(restingOpacity);
    };
  }, [pulse, reducedMotion]);

  return pulse;
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    list: {},
    // Stands in for full-bleed hairline rows, so it is one itself — no card box.
    row: {
      gap: space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.borderSubtle,
      paddingVertical: space.xl,
    },
    bar: {
      height: 10,
      borderRadius: radius.control,
      backgroundColor: colors.bgActive,
    },
    block: {
      borderRadius: radius.overlay,
      backgroundColor: colors.bgActive,
    },
    titleBar: {
      width: "62%",
    },
    metaBar: {
      width: "34%",
    },
  });
