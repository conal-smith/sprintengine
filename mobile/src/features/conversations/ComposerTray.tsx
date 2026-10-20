import type { ReactNode } from "react";
import { Children, isValidElement } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";

import { CloseIcon, iconSize, LifecycleGlyph } from "../../components/glyphs";
import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { radius, space, typography, type Theme } from "../../theme/tokens";

// The tray tucked behind the composer's top edge, as the desktop's chat has
// it (composerTray.tsx there): everything the chat has to say about the next
// message, one row each, stacked in one surface with the most urgent row
// against the field. It replaces what was scattered around the composer: a
// switch's caveat as a bare grey sentence over it, a refused action as a third
// line in the header that nothing cleared, and the prompt cache's warning as
// an amber card.
//
// The tray is drawn before the composer and runs its bottom edge under the
// composer's top, so the composer paints over the seam and the tray reads as
// something that slid out from under the field. No row, no tray.

export type ComposerTrayTone = "warn" | "error" | "neutral";

/** How far the tray runs under the composer. */
const TUCK = space.lg;

export function ComposerTray({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  const rows = Children.toArray(children).filter(isValidElement);
  if (rows.length === 0) return null;
  return (
    <View style={styles.tray}>
      {rows.map((row, index) => (
        <View key={row.key ?? index} style={index > 0 ? styles.divided : undefined}>
          {row}
        </View>
      ))}
    </View>
  );
}

/**
 * One notice: its glyph, its sentence (wrapping when long; the sentence is the
 * notice, never shortened), and its actions on the right, with an optional ×
 * after them.
 */
export function ComposerTrayRow({
  tone = "neutral",
  actions,
  onDismiss,
  children,
}: {
  tone?: ComposerTrayTone;
  actions?: ReactNode;
  onDismiss?: () => void;
  children: ReactNode;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole={tone === "error" ? "alert" : undefined}
      style={[styles.row, tone === "warn" ? styles.warn : tone === "error" ? styles.error : null]}
    >
      <View style={styles.glyph}>
        {tone === "neutral" ? (
          <NoteGlyph color={colors.textSubtle} size={iconSize.sm} />
        ) : (
          <LifecycleGlyph live={false} size={iconSize.sm} state={tone === "error" ? "failed" : "needs_input"} />
        )}
      </View>
      {typeof children === "string" ? <Text style={styles.text}>{children}</Text> : <View style={styles.body}>{children}</View>}
      {actions || onDismiss ? (
        <View style={styles.actions}>
          {actions}
          {onDismiss ? (
            <Pressable
              accessibilityLabel="Dismiss"
              accessibilityRole="button"
              hitSlop={space.sm}
              onPress={onDismiss}
              style={({ pressed }) => [styles.dismiss, pressed ? styles.pressed : null]}
            >
              <CloseIcon size={iconSize.xs} tone="textSubtle" />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** A row's text action ("Compact"): a word in the accent, not a button slab. */
export function ComposerTrayAction({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      hitSlop={space.sm}
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed ? styles.pressed : null]}
    >
      <Text style={[styles.actionText, disabled ? styles.actionOff : null]}>{label}</Text>
    </Pressable>
  );
}

/** The note mark: an "i" in a ring, for a row that informs rather than warns. */
function NoteGlyph({ color, size }: { color: string; size: number }) {
  return (
    <Svg height={size} viewBox="0 0 16 16" width={size}>
      <Circle cx={8} cy={8} fill="none" r={6.25} stroke={color} strokeWidth={1.4} />
      <Path d="M8 7.25v4" stroke={color} strokeLinecap="round" strokeWidth={1.4} />
      <Circle cx={8} cy={5} fill={color} r={0.9} />
    </Svg>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    tray: {
      marginHorizontal: space.md,
      marginBottom: -TUCK,
      paddingBottom: TUCK,
      overflow: "hidden",
      borderTopLeftRadius: radius.overlay,
      borderTopRightRadius: radius.overlay,
      borderWidth: 1,
      borderBottomWidth: 0,
      borderColor: colors.borderDefault,
      backgroundColor: colors.bgSurface,
    },
    divided: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.borderSubtle,
    },
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: space.sm,
      paddingLeft: space.lg,
      paddingRight: space.md,
      paddingVertical: space.sm,
    },
    warn: { backgroundColor: colors.toneWarnSoft },
    error: { backgroundColor: colors.toneErrorSoft },
    glyph: { height: 20, justifyContent: "center" },
    text: { ...typography.meta, color: colors.textDefault, flex: 1, minWidth: 0 },
    body: { flex: 1, minWidth: 0 },
    actions: { flexDirection: "row", alignItems: "center", gap: space.sm, flexShrink: 0, minHeight: 20 },
    action: { paddingHorizontal: space["2xs"], borderRadius: radius.control },
    actionText: { ...typography.meta, color: colors.accentPrimary },
    actionOff: { color: colors.textDisabled },
    dismiss: { padding: space["3xs"], borderRadius: radius.control },
    pressed: { backgroundColor: colors.bgHover },
  });
