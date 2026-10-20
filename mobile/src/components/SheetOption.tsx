import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { CheckIcon, iconSize } from "./glyphs";
import { useThemedStyles } from "../theme/ThemeProvider";
import { radius, space, typography, type Theme } from "../theme/tokens";

interface SheetOptionProps {
  label: string;
  /** The line under the label: what choosing this actually does. */
  sub?: string;
  /**
   * Whether this row is the current answer. A sheet that offers actions rather
   * than a choice — "Photo, Camera, File" — passes false throughout and simply
   * never draws the tick.
   */
  selected?: boolean;
  onPress: () => void;
  /** A leading glyph, for a sheet of actions ("Choose a photo", "Take a photo"). */
  icon?: ReactNode;
  /** Off, with `sub` saying why: a row that is there but cannot be taken now. */
  disabled?: boolean;
}

/**
 * A row inside a `BottomSheet`: label, optional sub-line, and a tick when it is
 * the chosen one.
 *
 * It lived inside New until a second screen gained sheets of its own (the chat
 * now picks its model from one). Two copies of a row that carries the sheet's
 * one filled surface is exactly how the two sheets come to disagree about what
 * a choice looks like, so it moved out whole rather than being replicated.
 */
export function SheetOption({ label, sub, selected = false, onPress, icon, disabled = false }: SheetOptionProps) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.option,
        selected ? styles.optionOn : null,
        pressed && !selected && !disabled ? styles.optionPressed : null,
      ]}
    >
      {/* On a tile of its own: a glyph in a machine's colour clears its
          contrast floor on a surface, never on the chosen row's inverse slab. */}
      {icon ? <View style={[styles.iconTile, disabled ? styles.iconOff : null]}>{icon}</View> : null}
      <View style={styles.optionText}>
        <Text style={[styles.optionLabel, selected ? styles.optionLabelOn : null, disabled ? styles.optionLabelOff : null]}>
          {label}
        </Text>
        {sub ? <Text style={[styles.optionSub, selected ? styles.optionSubOn : null]}>{sub}</Text> : null}
      </View>
      {selected ? <CheckIcon size={iconSize.sm} tone="buttonInk" /> : null}
    </Pressable>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    option: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.md,
      minHeight: 48,
      borderRadius: radius.overlay,
      paddingHorizontal: space.lg,
      paddingVertical: space.lg,
    },
    // The chosen one is the inverse-ink slab the mockup draws — a sheet's one
    // filled surface, and the place a choice is loud.
    optionOn: {
      backgroundColor: colors.buttonBg,
    },
    optionPressed: {
      backgroundColor: colors.bgHover,
    },
    optionText: {
      flex: 1,
      minWidth: 0,
      gap: space["3xs"],
    },
    optionLabel: {
      ...typography.body,
      fontSize: 16,
      color: colors.textPrimary,
    },
    optionLabelOn: {
      color: colors.buttonInk,
    },
    optionSub: {
      ...typography.meta,
      color: colors.textSubtle,
    },
    optionSubOn: {
      color: colors.buttonInk,
      opacity: 0.7,
    },
    optionLabelOff: {
      color: colors.textDisabled,
    },
    iconTile: {
      width: 28,
      height: 28,
      borderRadius: radius.chip,
      borderWidth: 1,
      borderColor: colors.cardRing,
      backgroundColor: colors.bgSurfaceRaised,
      alignItems: "center",
      justifyContent: "center",
    },
    iconOff: {
      opacity: 0.5,
    },
  });
