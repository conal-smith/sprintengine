import { type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FocusRing, useFocusRing } from "./FocusRing";
import { ChevronIcon, iconSize, StatusShape } from "./glyphs";
import { WorkingMark } from "./WorkingMark";
import { useTheme, useThemedStyles } from "../theme/ThemeProvider";
import { cardShadow, radius, space, typography, type Theme, fontWeight } from "../theme/tokens";

/**
 * The card: the unit of every surface in the sprintengine.ai language. A white
 * card on the white page in Light, lifted by a faint ring and the site's soft
 * shadow; a neutral-900 card ringed in neutral-800 on the neutral-950 page in
 * Dark. A thread, a backlog item, a desktop, a setting group — each is
 * one of these, and lists are one `Card` of hairline-separated `CardRow`s.
 *
 * `hero` is the site's landing card (`rounded-2xl p-8`): the one card on a
 * screen that carries the title and the primary action. `list` drops the
 * padding so rows can run edge to edge inside it.
 */
export function Card({
  children,
  variant = "default",
  style,
  ringTone,
}: {
  children: ReactNode;
  variant?: "default" | "hero" | "list";
  style?: StyleProp<ViewStyle>;
  /** A status ring in place of the neutral one — the needs-input card wears `warn`. */
  ringTone?: "warn" | "danger";
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const ring = ringTone === "warn" ? colors.toneWarn : ringTone === "danger" ? colors.toneError : undefined;

  return (
    <View
      style={[
        styles.card,
        variant === "hero" ? styles.hero : null,
        variant === "list" ? styles.list : null,
        ring ? { borderColor: ring } : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

/**
 * One row inside a `list` card: an optional leading mark, a title, one meta
 * line, and either a trailing value or a chevron. At most four visual elements
 * at rest, per the design system's list-row contract. Interactive when
 * `onPress` is given; the whole row is the one target.
 */
export function CardRow({
  title,
  meta,
  leading,
  trailing,
  chevron = false,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  selected = false,
  first = false,
  disabled = false,
  titleNumberOfLines = 1,
}: {
  title: ReactNode;
  meta?: ReactNode;
  leading?: ReactNode;
  /** Display-only trailing meta (an age, a count); never interactive. */
  trailing?: ReactNode;
  chevron?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  selected?: boolean;
  /** The first row in its card draws no hairline above itself. */
  first?: boolean;
  disabled?: boolean;
  titleNumberOfLines?: number;
}) {
  const styles = useThemedStyles(createStyles);
  const { focused, focusProps } = useFocusRing();

  const content = (
    <>
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.text}>
        {typeof title === "string" ? (
          <Text numberOfLines={titleNumberOfLines} style={[styles.title, selected ? styles.titleSelected : null]}>
            {title}
          </Text>
        ) : (
          title
        )}
        {meta ? (
          typeof meta === "string" ? (
            <Text numberOfLines={1} style={styles.meta}>
              {meta}
            </Text>
          ) : (
            meta
          )
        ) : null}
      </View>
      {trailing ? (
        typeof trailing === "string" ? (
          <Text numberOfLines={1} style={styles.trailing}>
            {trailing}
          </Text>
        ) : (
          <View style={styles.trailingSlot}>{trailing}</View>
        )
      ) : null}
      {chevron ? <ChevronIcon direction="right" size={iconSize.sm} tone="textSubtle" /> : null}
    </>
  );

  if (!onPress) {
    return <View style={[styles.row, first ? null : styles.rowDivider, disabled ? styles.disabled : null]}>{content}</View>;
  }

  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      {...focusProps}
      style={({ pressed }) => [
        styles.row,
        first ? null : styles.rowDivider,
        selected ? styles.rowSelected : null,
        pressed ? styles.rowPressed : null,
        disabled ? styles.disabled : null,
      ]}
    >
      {content}
      {focused ? <FocusRing radius={radius.control} /> : null}
    </Pressable>
  );
}

/** A muted section label with an optional right-aligned count, set over a card. */
export function SectionLabel({ children, count }: { children: string; count?: number | string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.sectionLabel}>
      <Text accessibilityRole="header" style={styles.sectionLabelText}>
        {children}
      </Text>
      {count !== undefined ? <Text style={styles.sectionLabelCount}>{count}</Text> : null}
    </View>
  );
}

/**
 * A row's status, as a shape: a check disc for good, a ring with ! for warn, a
 * ring with × for danger, a ring with a bar for neutral, and the working mark
 * for live. The name outlived the 6px dot it used to draw, which the desktop
 * ruled out on 2026-09-28: a disc has no shape, so every tone was the same
 * circle and working read like waiting.
 *
 * Decorative, as the dot was: the row's words say what the shape shows.
 */
export function StatusDot({
  tone = "neutral",
  seed,
}: {
  tone?: "neutral" | "live" | "good" | "warn" | "danger";
  /** What picks a live row's working-mark pattern: the row's id. */
  seed?: string;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.status}>
      {tone === "live" ? <WorkingMark seed={seed ?? "live"} /> : <StatusShape tone={tone} size={iconSize.xs} />}
    </View>
  );
}

/**
 * The card surface as a plain style object, for screens whose rows are
 * virtualized (a FlatList cannot be wrapped in one `Card`): each row wears the
 * same ring, radius and lift as a `Card`.
 */
export function cardSurface({ colors, cardShadowOpacity }: Theme): ViewStyle {
  return {
    backgroundColor: colors.bgSurface,
    borderRadius: radius.overlay,
    borderWidth: 1,
    borderColor: colors.cardRing,
    shadowColor: colors.cardShadowColor,
    shadowOpacity: cardShadowOpacity,
    shadowOffset: cardShadow.offset,
    shadowRadius: cardShadow.radius,
    // Android has no soft shadow without elevation; a small one keeps the card
    // lifted the same way in Light, and Dark's ring carries it alone.
    elevation: cardShadowOpacity > 0 ? 2 : 0,
  };
}

const createStyles = (theme: Theme) => {
  const { colors } = theme;
  return StyleSheet.create({
    card: {
      ...cardSurface(theme),
      paddingHorizontal: space.xl,
      paddingVertical: space.xl,
    },
    hero: {
      borderRadius: radius.shell,
      paddingHorizontal: space["3xl"],
      paddingVertical: space["3xl"],
    },
    list: {
      paddingHorizontal: 0,
      paddingVertical: 0,
      overflow: "hidden",
    },
    row: {
      position: "relative",
      flexDirection: "row",
      alignItems: "center",
      gap: space.lg,
      paddingHorizontal: space.xl,
      paddingVertical: space.lg,
      minHeight: 52,
    },
    rowDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.borderSubtle,
    },
    rowSelected: {
      backgroundColor: colors.bgSurfaceSelected,
    },
    rowPressed: {
      backgroundColor: colors.bgHover,
    },
    disabled: {
      opacity: 0.5,
    },
    leading: {
      alignItems: "center",
      justifyContent: "center",
    },
    text: {
      flex: 1,
      minWidth: 0,
      gap: space["3xs"],
    },
    title: {
      ...typography.body,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
    },
    titleSelected: {
      color: colors.textPrimary,
    },
    meta: {
      ...typography.meta,
      color: colors.textMuted,
    },
    trailing: {
      ...typography.meta,
      color: colors.textSubtle,
      fontVariant: ["tabular-nums"],
    },
    trailingSlot: {
      alignItems: "flex-end",
    },
    sectionLabel: {
      flexDirection: "row",
      alignItems: "baseline",
      justifyContent: "space-between",
      paddingHorizontal: space["2xs"],
      paddingTop: space.sm,
    },
    sectionLabelText: {
      ...typography.meta,
      fontWeight: fontWeight.medium,
      color: colors.textMuted,
    },
    sectionLabelCount: {
      ...typography.meta,
      color: colors.textSubtle,
      fontVariant: ["tabular-nums"],
    },
    // Every tone in the same box, so a row does not shift when its state does.
    status: {
      width: iconSize.xs,
      height: iconSize.xs,
      alignItems: "center",
      justifyContent: "center",
    },
  });
};
