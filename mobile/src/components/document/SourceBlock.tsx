import { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { highlightSource } from "./sourceHighlight";

import { CopyButton } from "../CopyButton";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { monoFontFamily } from "../../theme/fonts";
import { radius, space, type Theme } from "../../theme/tokens";

interface SourceBlockProps {
  content: string;
  language?: string;
  /** Named when the block is the document itself rather than one fence inside it. */
  accessibilityLabel?: string;
  /** A well's header, the fence's language or file name, as a chat reply draws code. */
  header?: string;
  /** A control at the header's end: a drawn diagram's way back from its source. */
  action?: { label: string; accessibilityLabel: string; onPress: () => void };
  /** A line under the source saying why it is shown as source. */
  note?: string;
  /**
   * Whether a well offers Copy in its header: false while its block is still
   * arriving, when a copy would take half a fence. A block with no header
   * has nowhere to offer it.
   */
  copyable?: boolean;
}

/**
 * Monospaced, horizontally scrollable code surface. Source lines are never
 * wrapped: indentation is meaning, and a wrapped fence misreports the document.
 * Shared by the markdown `fence`/`code_block` rules and the HTML source tab.
 */
export function SourceBlock({ content, language, accessibilityLabel, header, action, note, copyable = true }: SourceBlockProps) {
  const styles = useThemedStyles(createStyles);
  const tokens = useMemo(() => highlightSource(content, language), [content, language]);

  return (
    <View style={[styles.block, header ? styles.well : null]}>
      {header ? <WellHeader action={action} copy={copyable ? content : null} label={header} /> : null}
      <ScrollView
        contentContainerStyle={styles.content}
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        <Text accessibilityLabel={accessibilityLabel} selectable style={styles.text}>
          {tokens.map((token, index) => (
            <Text key={index} style={styles[token.tone]}>
              {token.text}
            </Text>
          ))}
        </Text>
      </ScrollView>
      {note ? <Text style={styles.note}>{note}</Text> : null}
    </View>
  );
}

/**
 * A well's header: what it holds, and at its end Copy for its text and the
 * one other thing to do with it.
 */
export function WellHeader({
  label,
  action,
  copy,
}: {
  label: string;
  action?: SourceBlockProps["action"];
  /** What Copy puts on the clipboard: the source as written. No Copy without it. */
  copy?: string | null;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.headerRow}>
      <Text numberOfLines={1} style={[styles.header, styles.headerLabel]}>
        {label}
      </Text>
      {copy ? (
        <View style={[styles.copy, action ? null : styles.copyLast]}>
          <CopyButton label="Copy code" text={copy} />
        </View>
      ) : null}
      {action ? (
        <Pressable
          accessibilityLabel={action.accessibilityLabel}
          accessibilityRole="button"
          hitSlop={space.sm}
          onPress={action.onPress}
          style={({ pressed }) => (pressed ? styles.actionPressed : null)}
        >
          <Text style={[styles.header, styles.action]}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    plain: { color: colors.textDefault },
    comment: { color: colors.textMuted },
    keyword: { color: colors.toneAccent },
    string: { color: colors.toneGood },
    number: { color: colors.toneWarn },
    added: { color: colors.toneGood },
    removed: { color: colors.toneError },
    block: {
      backgroundColor: colors.bgHover,
      borderRadius: radius.control,
      marginTop: space.sm,
      marginBottom: space.lg,
      overflow: "hidden",
    },
    content: {
      padding: space.lg,
    },
    // A chat's code: a well with a hairline edge, headed by what it is.
    well: {
      borderColor: colors.borderSubtle,
      borderRadius: radius.overlay,
      borderWidth: StyleSheet.hairlineWidth,
      marginTop: space["2xs"],
      marginBottom: space.sm,
    },
    header: {
      color: colors.textSubtle,
      fontFamily: monoFontFamily,
      fontSize: 12,
      lineHeight: 16,
      paddingHorizontal: space.lg,
      paddingTop: space.md,
    },
    headerRow: { alignItems: "center", flexDirection: "row" },
    headerLabel: { flex: 1 },
    // Centred on the label's line: the label sits below the header's top
    // padding, and the glyph's box is taller than its line.
    copy: { paddingTop: space.xs, paddingLeft: space.sm },
    copyLast: { paddingRight: space.md },
    action: { color: colors.textMuted },
    actionPressed: { opacity: 0.6 },
    note: {
      color: colors.textMuted,
      fontSize: 12,
      lineHeight: 16,
      paddingBottom: space.md,
      paddingHorizontal: space.lg,
    },
    text: {
      color: colors.textDefault,
      fontFamily: monoFontFamily,
      fontSize: 13,
      lineHeight: 20,
    },
  });
