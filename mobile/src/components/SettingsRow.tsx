import { type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { FocusRing, useFocusRing } from "./FocusRing";
import { ChevronIcon, iconSize } from "./glyphs";
import { useThemedStyles } from "../theme/ThemeProvider";
import { radius, space, typography, type Theme, fontWeight } from "../theme/tokens";

/**
 * The settings row: an
 * outlined glyph in a disc, a title, and a value or a control on the right,
 * the shape a phone's own settings screens have taught people to scan.
 *
 * Unlike `CardRow`, these rows do not sit in a card — the group label and the
 * spacing do the grouping, which is what stops five rows reading as five boxes.
 *
 * A row's own long text goes in `meta`, under the title, the way the mockup's
 * Account row carries a name over an address. `value` is for the SHORT
 * right-hand facts — a count, "System", "Dark". The two are not
 * interchangeable: a long string in the value slot squeezes the title out of
 * existence, which is exactly what a 35-character hostname did to "Signed in".
 *
 * The multi-row explainer stays `SettingsNote` under the row, not `meta`: the
 * mockup gives exactly one row an explainer, and a meta slot used for that on
 * every row invites five.
 */
export function SettingsRow({
  icon,
  title,
  meta,
  value,
  chevron = false,
  control,
  onPress,
  tone = "default",
  accessibilityLabel,
  accessibilityHint,
}: {
  icon?: ReactNode;
  title: string;
  /** A second line under the title, for text too long to sit on the right. */
  meta?: string;
  /** SHORT right-hand display value — a count, "System". Never a URL or a sentence. */
  value?: string;
  chevron?: boolean;
  /** A control that owns its own tap (a Toggle). Rows with one are not pressable. */
  control?: ReactNode;
  onPress?: () => void;
  tone?: "default" | "danger";
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const styles = useThemedStyles(createStyles);
  const { focused, focusProps } = useFocusRing();

  const content = (
    <>
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      <View style={styles.text}>
        {/* Two lines, not one: a settings label is a sentence ("Steer while an
            agent works"), and a wrapped label reads where a clipped one
            does not. Short titles are unaffected. */}
        <Text numberOfLines={2} style={[styles.title, tone === "danger" ? styles.danger : null]}>
          {title}
        </Text>
        {meta ? (
          <Text numberOfLines={1} style={styles.meta}>
            {meta}
          </Text>
        ) : null}
      </View>
      {value ? (
        // `flexShrink` so the value yields first when the row is tight. The
        // title is the row's identity; the value is its state, and a clipped
        // "Syst…" beside a whole label is the right trade of the two.
        <Text numberOfLines={1} style={styles.value}>
          {value}
        </Text>
      ) : null}
      {control}
      {chevron ? <ChevronIcon direction="right" size={iconSize.sm} tone="textSubtle" /> : null}
    </>
  );

  if (!onPress) {
    return <View style={styles.row}>{content}</View>;
  }

  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityRole="button"
      onPress={onPress}
      {...focusProps}
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
    >
      {content}
      {focused ? <FocusRing radius={radius.overlay} /> : null}
    </Pressable>
  );
}

/** The grey label over a run of rows. */
export function SettingsGroupLabel({ children }: { children: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Text accessibilityRole="header" style={styles.group}>
      {children}
    </Text>
  );
}

/** The one grey line under the one row that needs explaining. */
export function SettingsNote({ children, centered = false }: { children: string; centered?: boolean }) {
  const styles = useThemedStyles(createStyles);
  return <Text style={[styles.note, centered ? styles.noteCentered : null]}>{children}</Text>;
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    row: {
      position: "relative",
      flexDirection: "row",
      alignItems: "center",
      gap: space.lg,
      minHeight: 56,
      paddingHorizontal: space["2xs"],
      paddingVertical: space.md,
    },
    pressed: {
      backgroundColor: colors.bgHover,
    },
    icon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.bgSurfaceRaised,
    },
    text: {
      flex: 1,
      minWidth: 0,
      gap: space["3xs"],
    },
    title: {
      ...typography.body,
      fontWeight: fontWeight.emphasis,
      color: colors.textPrimary,
    },
    meta: {
      ...typography.meta,
      color: colors.textMuted,
    },
    danger: {
      color: colors.toneError,
    },
    value: {
      ...typography.body,
      color: colors.textMuted,
      fontVariant: ["tabular-nums"],
      flexShrink: 1,
      textAlign: "right",
    },
    group: {
      ...typography.meta,
      color: colors.textMuted,
      paddingHorizontal: space["2xs"],
      paddingTop: space.lg,
      paddingBottom: space["2xs"],
    },
    note: {
      ...typography.meta,
      color: colors.textSubtle,
      paddingHorizontal: space["2xs"],
      paddingTop: space["2xs"],
    },
    noteCentered: {
      textAlign: "center",
    },
  });
