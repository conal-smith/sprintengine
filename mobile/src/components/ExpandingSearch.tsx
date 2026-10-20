import { forwardRef, useState } from "react";
import { Animated, Pressable, StyleSheet, TextInput, View } from "react-native";

import { CloseIcon, iconSize, SearchIcon } from "./glyphs";
import { useTheme, useThemedStyles } from "../theme/ThemeProvider";
import { space, typography, type Theme } from "../theme/tokens";

/** The top bar's round buttons, which the field grows out of. */
const DISC = 40;

/**
 * A top bar's search, drawn over the bar: a field that grows leftwards out of
 * the search button and covers the bar until it is closed.
 *
 * Everything that moves is a transform or an opacity on the native driver,
 * so the growth costs the JS thread nothing while the keyboard comes up. The
 * field is laid out at its full width once and slid in from the button's
 * place inside a rounded clip: the clip's right end is the field's, and the
 * field's own left end is the edge that travels. Its search mark starts on
 * the button's and rides the left edge across.
 *
 * `progress` runs 0 (closed) to 1 (open) and belongs to the screen, which
 * also fades its bar buttons out against it. `origin` is how far the search
 * button's disc starts from the bar's right content edge.
 */
export const ExpandingSearch = forwardRef<
  TextInput,
  {
    open: boolean;
    progress: Animated.Value;
    origin: number;
    value: string;
    onChangeText: (value: string) => void;
    onClose: () => void;
    placeholder: string;
    accessibilityLabel?: string;
  }
>(function ExpandingSearch({ open, progress, origin, value, onChangeText, onClose, placeholder, accessibilityLabel }, ref) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [width, setWidth] = useState(0);
  const start = Math.max(0, width - origin);

  return (
    <View
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
      accessibilityElementsHidden={!open}
      pointerEvents={open ? "box-none" : "none"}
      style={styles.bar}
    >
      <Animated.View
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={[styles.clip, { opacity: progress.interpolate({ inputRange: [0, 0.2], outputRange: [0, 1], extrapolate: "clamp" }) }]}
      >
        <Animated.View
          style={[
            styles.field,
            { transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [start, 0] }) }] },
          ]}
        >
          <SearchIcon size={iconSize.md} tone="textSubtle" />
          <Animated.View
            style={[
              styles.rest,
              { opacity: progress.interpolate({ inputRange: [0.5, 1], outputRange: [0, 1], extrapolate: "clamp" }) },
            ]}
          >
            <TextInput
              accessibilityLabel={accessibilityLabel ?? placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={onChangeText}
              placeholder={placeholder}
              placeholderTextColor={colors.textSubtle}
              ref={ref}
              returnKeyType="search"
              style={styles.input}
              value={value}
            />
            <Pressable
              accessibilityLabel="Close search"
              accessibilityRole="button"
              hitSlop={space.md}
              onPress={onClose}
              style={({ pressed }) => [styles.close, pressed ? styles.closePressed : null]}
            >
              <CloseIcon size={iconSize.md} tone="textMuted" />
            </Pressable>
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </View>
  );
});

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    // Over the bar's row, inside the same side padding as its content.
    bar: {
      ...StyleSheet.absoluteFillObject,
      justifyContent: "center",
      paddingHorizontal: space["2xl"],
    },
    clip: {
      height: DISC,
      borderRadius: DISC / 2,
      overflow: "hidden",
    },
    field: {
      ...StyleSheet.absoluteFillObject,
      flexDirection: "row",
      alignItems: "center",
      // The mark sits where the button's did: centred in a disc's width.
      paddingLeft: (DISC - iconSize.md) / 2,
      borderRadius: DISC / 2,
      borderWidth: 1,
      borderColor: colors.cardRing,
      backgroundColor: colors.bgSurfaceRaised,
    },
    rest: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      minWidth: 0,
    },
    input: {
      ...typography.body,
      flex: 1,
      minWidth: 0,
      marginLeft: space.md,
      color: colors.textPrimary,
      // Android's TextInput carries its own vertical padding, which pushes the
      // line off the field's centre.
      paddingVertical: 0,
    },
    close: {
      width: DISC,
      height: DISC,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: DISC / 2,
    },
    closePressed: {
      backgroundColor: colors.bgHover,
    },
  });
