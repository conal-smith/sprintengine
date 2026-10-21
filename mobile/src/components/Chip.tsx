import { type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useToast } from "./Toast";
import { useThemedStyles } from "../theme/ThemeProvider";
import { monoFontFamily } from "../theme/fonts";
import { space, typography, type Theme } from "../theme/tokens";

/**
 * The chip: a glyph and a short name in a rounded 22pt slab.
 *
 * It is what replaced bare words on a row (words give way to glyphs): a project,
 * a desktop and a branch each carry the studio's own mark rather than a label
 * saying which kind of thing they are, so three facts fit on one line of a
 * 390pt row where three labelled phrases did not.
 *
 * Type is `micro` — the smallest step on the ramp — because the row's title is
 * the priority and the chips are its footnote. The design called for 11.5pt;
 * the ramp's 11 is the step, and half a point is below the rendering floor.
 */
export function Chip({
  icon,
  label,
  mono = false,
  trailing,
  accessibilityLabel,
  expandable = false,
}: {
  icon?: ReactNode;
  label: string;
  /** Branch names and paths are code, so they set in the mono family. */
  mono?: boolean;
  /** Drawn after the label, inside the slab. */
  trailing?: ReactNode;
  accessibilityLabel?: string;
  /**
   * Tapping says the whole thing (a chip on a 390pt header
   * clips, and the clipped half is often the half that identifies it).
   *
   * Only for chips that are NOT inside a pressable row. A chip in a list sits
   * on a row whose whole job is to open what it lists, and a nested
   * target there would eat taps meant for it — so those chips stay inert and
   * their full text reaches a screen reader through the row's own label.
   */
  expandable?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const toast = useToast();

  const body = (
    <>
      {icon}
      <Text numberOfLines={1} style={[styles.label, mono ? styles.mono : null]}>
        {label}
      </Text>
      {trailing}
    </>
  );

  if (!expandable) {
    return (
      <View accessibilityLabel={accessibilityLabel ?? label} accessibilityRole="text" style={styles.chip}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityHint="Says the full name."
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      // The phone's tooltip is the toast: it is the surface the app already
      // has for "one line, then gone", and a hover-shaped tooltip has no
      // gesture on a touch screen.
      onPress={() => toast.show(label)}
      style={({ pressed }) => [styles.chip, pressed ? styles.chipPressed : null]}
    >
      {body}
    </Pressable>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: space["2xs"],
      height: 22,
      paddingLeft: space.xs,
      paddingRight: space.xs,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: colors.cardRing,
      backgroundColor: colors.bgSurfaceRaised,
      flexShrink: 1,
      minWidth: 0,
    },
    chipPressed: {
      backgroundColor: colors.bgActive,
    },
    label: {
      ...typography.micro,
      color: colors.textDefault,
      flexShrink: 1,
    },
    mono: {
      fontFamily: monoFontFamily,
    },
  });
