import { Pressable, StyleSheet, Text, View } from "react-native";

import { CheckIcon, iconSize } from "./glyphs";
import { useThemedStyles } from "../theme/ThemeProvider";
import { radius, space, typography, type Theme, fontWeight } from "../theme/tokens";

export interface SegmentOption<TValue extends string> {
  value: TValue;
  label: string;
}

/**
 * The two-segment pill, which the notices screen uses to split what needs
 * you from what can wait.
 *
 * Distinct from Settings' small segmented control: this one is 48pt, outlined
 * as one pill rather than sunk into a tray, and marks the chosen half with the
 * accent tick as well as the soft fill — state never reads by colour alone.
 */
export function SegmentedToggle<TValue extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly SegmentOption<TValue>[];
  value: TValue;
  onChange: (next: TValue) => void;
}) {
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.group}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            accessibilityLabel={option.label}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            key={option.value}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles.segment,
              selected ? styles.segmentOn : null,
              pressed && !selected ? styles.segmentPressed : null,
            ]}
          >
            {selected ? <CheckIcon size={iconSize.sm} tone="accentPrimary" /> : null}
            <Text numberOfLines={1} style={[styles.label, selected ? styles.labelOn : null]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    group: {
      flexDirection: "row",
      height: 48,
      borderRadius: radius.chip,
      borderWidth: 1.5,
      borderColor: colors.buttonOutline,
      overflow: "hidden",
    },
    segment: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: space.xs,
    },
    segmentOn: {
      backgroundColor: colors.accentPrimarySoft,
    },
    segmentPressed: {
      backgroundColor: colors.bgHover,
    },
    label: {
      ...typography.body,
      color: colors.textDefault,
      flexShrink: 1,
    },
    labelOn: {
      color: colors.textPrimary,
      fontWeight: fontWeight.emphasis,
    },
  });
