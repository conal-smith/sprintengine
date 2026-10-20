import { type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useThemedStyles } from "../theme/ThemeProvider";
import { space, typography, type Theme, fontWeight } from "../theme/tokens";
import { ChevronIcon, iconSize } from "./glyphs";
import { IconButton } from "./IconButton";
import { SprintEngineWordmark } from "./SprintEngineWordmark";

interface ScreenHeaderProps {
  title?: string;
  /** Kind or scope above the title, on detail screens. */
  eyebrow?: string;
  /** Item count beside the title. Right-weighted, tabular. */
  count?: number;
  /** Present only on pushed screens; the stack owns the gesture, this owns the tap. */
  onBack?: () => void;
  backLabel?: string;
  /** Header controls: the desktop picker, a create button. Keep it to two. */
  trailing?: ReactNode;
  /** The wordmark in place of a title — the root screen that carries the brand. */
  wordmark?: boolean;
  /**
   * A line under the title, for the chips a thread carries — the project, the
   * desktop. It sits BELOW the title
   * where `eyebrow` sits above it, because these chips qualify the title rather
   * than classify it.
   */
  subtitle?: ReactNode;
  /**
   * `nav` is the 17pt bar title every pushed screen wears. `large` is the 24pt
   * one a root screen wears where it has no wordmark.
   */
  titleScale?: "nav" | "large";
  /** Drop the hairline under the bar — for a screen whose own big title follows. */
  flush?: boolean;
  /**
   * The ground the bar stands on: the app's canvas, or the conversation's
   * (`agentSurface`) on the chat and New, so the screen is one ground from
   * the status bar to the composer.
   */
  ground?: "app" | "agent";
  /**
   * Drawn over the bar's row, the whole width of it: a search that grows out
   * of a trailing button (`ExpandingSearch`) and covers the bar while open.
   */
  overlay?: ReactNode;
}

/**
 * Every screen's top chrome. It carries the safe-area top inset, so no screen
 * pads for the status bar itself — the whole reason the hand-rolled
 * `StatusBar.currentHeight` patch existed.
 */
export function ScreenHeader({
  title,
  eyebrow,
  count,
  onBack,
  backLabel,
  trailing,
  wordmark,
  subtitle,
  titleScale = "nav",
  flush = false,
  ground = "app",
  overlay,
}: ScreenHeaderProps) {
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();

  const hasContent = Boolean(title || eyebrow || onBack || trailing || wordmark || subtitle);

  return (
    <View
      style={[
        styles.header,
        ground === "agent" ? styles.agentGround : null,
        hasContent && !flush ? styles.headerBar : null,
        { paddingTop: insets.top },
      ]}
    >
      {hasContent ? (
        <View style={styles.row}>
          {onBack ? (
            <View style={styles.back}>
              <IconButton
                icon={<ChevronIcon direction="left" size={iconSize.md} tone="textPrimary" />}
                label={backLabel ?? "Go back"}
                onPress={onBack}
              />
            </View>
          ) : null}
          <View style={styles.copy}>
            {wordmark ? <SprintEngineWordmark size="header" /> : null}
            {eyebrow ? (
              <Text numberOfLines={1} style={styles.eyebrow}>
                {eyebrow}
              </Text>
            ) : null}
            {title ? (
              <View style={styles.titleRow}>
                <Text
                  accessibilityRole="header"
                  numberOfLines={1}
                  style={[styles.title, titleScale === "large" ? styles.titleLarge : null]}
                >
                  {title}
                </Text>
                {typeof count === "number" ? <Text style={styles.count}>{count}</Text> : null}
              </View>
            ) : null}
            {subtitle ? <View style={styles.subtitle}>{subtitle}</View> : null}
          </View>
          {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
          {overlay}
        </View>
      ) : null}
    </View>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    header: {
      backgroundColor: colors.bgApp,
    },
    agentGround: {
      backgroundColor: colors.agentSurface,
    },
    // The site's 56px bar: a hairline under a canvas-coloured strip, the
    // wordmark or title left and at most two icon actions right.
    headerBar: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.borderSubtle,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      minHeight: 52,
      paddingHorizontal: space["2xl"],
      paddingVertical: space.xs,
    },
    back: {
      // Pull the 44 pt target back to the content edge; the glyph, not the box,
      // is what should line up with the title below it.
      marginLeft: -space.lg,
    },
    copy: {
      flex: 1,
      gap: space["3xs"],
      minWidth: 0,
    },
    titleRow: {
      flexDirection: "row",
      alignItems: "baseline",
      gap: space.sm,
    },
    eyebrow: {
      color: colors.textMuted,
      fontSize: typography.meta.fontSize,
      fontWeight: fontWeight.medium,
    },
    title: {
      flexShrink: 1,
      color: colors.textPrimary,
      fontSize: 17,
      fontWeight: fontWeight.emphasis,
      lineHeight: 22,
      letterSpacing: -0.2,
    },
    titleLarge: {
      fontSize: 24,
      lineHeight: 30,
      letterSpacing: -0.3,
    },
    // A column, so what the line holds is held to the title's width and
    // truncates there: in a row it kept its own width, and ran on under the
    // trailing controls.
    subtitle: {
      minWidth: 0,
      paddingTop: space["3xs"],
    },
    count: {
      color: colors.textSubtle,
      fontSize: typography.meta.fontSize,
      fontWeight: fontWeight.medium,
      fontVariant: ["tabular-nums"],
    },
    trailing: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
    },
  });
