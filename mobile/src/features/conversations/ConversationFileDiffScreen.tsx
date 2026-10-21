import { memo, useMemo, useState } from "react";
import { FlatList, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";

import { PrimaryButton } from "../../components/PrimaryButton";
import { ScreenFrame, useScreenBottomInset } from "../../components/Screen";
import { WorkingMark } from "../../components/WorkingMark";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { monoFontFamily } from "../../theme/fonts";
import { fontWeight, space, typography, type Theme } from "../../theme/tokens";
import {
  diffDisplayRows,
  displayText,
  gutterDigits,
  hunkSections,
  parseUnifiedDiff,
  splitPath,
  type DiffDisplayRow,
} from "../diff/unifiedDiff";
import { recallTurnFiles, useTurnFile } from "../diff/useTurnDiff";
import { LineCounts } from "./ConversationChangesScreen";
import { useLiveConversation, type LiveConversationKey } from "./liveConversation";

// Long lines scroll sideways rather than wrap. A wrapped line of code puts its
// continuation under the gutter's next number, which reads as a line the file
// does not have, and indentation (the one structure a diff of code has) is lost
// at the first wrap. So the whole body is one horizontal ScrollView holding one
// vertical FlatList, every row the width of the widest line: the gutter, the
// tints and the text all move together, and nothing has to keep two scroll
// positions in step. The width is counted in characters and priced with a
// measured character, which a monospace face makes exact.
//
// Past MAX_COLUMNS a line wraps after all: a minified bundle's one 40,000
// character line would otherwise make a view wider than a phone can draw, and
// is no more readable scrolled than wrapped.
const MAX_COLUMNS = 400;
const CODE_SIZE = 12.5;
const CODE_LINE = 18;
// What the character is priced by until the sample has been laid out: close
// to both platforms' mono advance at this size, and only for one frame.
const ESTIMATED_ADVANCE = CODE_SIZE * 0.6;
const SAMPLE = "0".repeat(16);

/**
 * One changed file of a turn, as a unified diff: old and new line numbers in
 * the gutter, additions and removals tinted in their tones, a separator per
 * hunk carrying the function or heading git names for it, and Previous and
 * Next to step through the turn's other files without going back to the list.
 */
export function ConversationFileDiffScreen({
  conversation,
  turnSeq,
  path,
  onBack,
  onOpenFile,
}: {
  conversation: LiveConversationKey;
  turnSeq: number;
  path: string;
  onBack: () => void;
  /** Another file of the same turn, in place of this one. */
  onOpenFile: (path: string) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const inset = useScreenBottomInset();
  const live = useLiveConversation(conversation);
  const turn = { ...conversation, turnSeq };
  const { view, retry } = useTurnFile(live, turn, path);
  const ready = view.status === "ready" ? view.value : null;
  // The list outlives the file being loaded, so the pager holds still while
  // the next file's diff is on its way.
  const files = ready?.files ?? recallTurnFiles(turn) ?? [];
  const file = ready?.file ?? files.find((candidate) => candidate.path === path);
  const index = files.findIndex((candidate) => candidate.path === path);
  const { dir, name } = splitPath(path);
  const counts = file ? (
    file.binary ? (
      "binary"
    ) : (
      <LineCounts added={file.addedLines} removed={file.removedLines} />
    )
  ) : null;
  const pager = files.length > 1 && index >= 0;
  return (
    <ScreenFrame
      title={name}
      subtitle={
        dir || counts ? (
          <Text numberOfLines={1} style={styles.subtitle}>
            {dir}
            {dir && counts ? " · " : ""}
            {counts}
          </Text>
        ) : undefined
      }
      onBack={onBack}
      backLabel="Changed files"
    >
      <View style={styles.body}>
        {view.status === "loading" ? (
          <View style={styles.state} accessibilityLiveRegion="polite">
            <View style={styles.loading}>
              <WorkingMark seed={path} label="Loading diff" />
              <Text style={styles.meta}>Loading diff…</Text>
            </View>
          </View>
        ) : view.status === "offline" ? (
          <View style={styles.state}>
            <Text style={styles.meta}>
              {view.closed
                ? "Open the chat to see what this turn changed."
                : "This chat isn't connected to the desktop right now. The diff loads when it reconnects."}
            </Text>
          </View>
        ) : view.status === "error" ? (
          <View style={styles.state}>
            <Text accessibilityRole="alert" style={styles.message}>
              {view.message}
            </Text>
            <PrimaryButton label="Try again" variant="secondary" onPress={retry} />
          </View>
        ) : view.value.patch === null ? (
          <View style={styles.state}>
            <Text style={styles.message}>{"Binary file, can't be shown as text."}</Text>
          </View>
        ) : (
          <UnifiedDiff key={path} patch={view.value.patch} bottomInset={pager ? space.xl : inset + space.xl} />
        )}
      </View>
      {pager ? (
        <View style={[styles.pager, { paddingBottom: Math.max(inset, space.md) }]}>
          <PrimaryButton
            variant="ghost"
            label="Previous file"
            disabled={index === 0}
            onPress={() => onOpenFile(files[index - 1].path)}
          />
          <Text style={styles.position}>
            {index + 1} of {files.length}
          </Text>
          <PrimaryButton
            variant="ghost"
            label="Next file"
            disabled={index >= files.length - 1}
            onPress={() => onOpenFile(files[index + 1].path)}
          />
        </View>
      ) : null}
    </ScreenFrame>
  );
}

type Widths = { content: number; number: number; sign: number };

function UnifiedDiff({ patch, bottomInset }: { patch: string; bottomInset: number }) {
  const styles = useThemedStyles(createStyles);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [advance, setAdvance] = useState(ESTIMATED_ADVANCE);
  const { rows, longest, binary } = useMemo(() => {
    const [file] = parseUnifiedDiff(patch);
    if (!file) return { rows: [], longest: 0, binary: false };
    const read = diffDisplayRows(file, hunkSections(patch)[0]);
    let widest = 0;
    for (const row of read) {
      const length = row.kind === "hunk" ? row.header.length + row.context.length + 2 : displayText(row.text).length;
      widest = Math.max(widest, length);
    }
    return { rows: read, longest: Math.min(widest, MAX_COLUMNS), binary: file.binary };
  }, [patch]);
  const widths = useMemo<Widths>(() => {
    // One character of slack: Android lays out "10" a hair wider than two
    // measured advances, and a number that wraps doubles its row's height.
    const number = (gutterDigits(rows) + 1) * advance + space.xs * 2;
    const sign = advance + space.xs * 2;
    // Two characters of slack: a sub-point rounding in the measured advance
    // must not wrap the widest line onto a second row.
    const text = (longest + 2) * advance + space.xl;
    return { number, sign, content: Math.max(viewport.width, number * 2 + sign + text) };
  }, [rows, longest, advance, viewport.width]);
  const onViewport = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width !== viewport.width || height !== viewport.height) setViewport({ width, height });
  };
  if (binary)
    return (
      <View style={styles.state}>
        <Text style={styles.message}>{"Binary file, can't be shown as text."}</Text>
      </View>
    );
  if (!rows.length)
    return (
      <View style={styles.state}>
        <Text style={styles.message}>No line changes to show: the file is empty, or only its mode changed.</Text>
      </View>
    );
  return (
    <View style={styles.body} onLayout={onViewport}>
      {/* The character the widths are priced by, laid out once and never seen. */}
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onLayout={(event) => {
          const { width } = event.nativeEvent.layout;
          if (width > 0) setAdvance(width / SAMPLE.length);
        }}
        style={[styles.code, styles.sample]}
      >
        {SAMPLE}
      </Text>
      {viewport.height ? (
        <ScrollView horizontal bounces={false} directionalLockEnabled style={styles.body}>
          <FlatList
            data={rows}
            keyExtractor={(_, position) => String(position)}
            renderItem={({ item }) => <DiffLine row={item} widths={widths} />}
            style={{ width: widths.content, height: viewport.height }}
            contentContainerStyle={{ paddingBottom: bottomInset }}
            initialNumToRender={40}
            maxToRenderPerBatch={40}
            windowSize={9}
          />
        </ScrollView>
      ) : null}
    </View>
  );
}

const SIGN: Record<Exclude<DiffDisplayRow["kind"], "hunk">, string> = { add: "+", del: "−", ctx: " ", note: " " };
const SPOKEN: Record<Exclude<DiffDisplayRow["kind"], "hunk">, string> = {
  add: "Added",
  del: "Removed",
  ctx: "Unchanged",
  note: "",
};

const DiffLine = memo(function DiffLine({ row, widths }: { row: DiffDisplayRow; widths: Widths }) {
  const styles = useThemedStyles(createStyles);
  if (row.kind === "hunk")
    return (
      <View
        accessible
        accessibilityLabel={`Changes from line ${row.newStart || row.oldStart}${row.context ? `, in ${row.context}` : ""}`}
        style={[styles.hunk, { width: widths.content }]}
      >
        <Text style={[styles.code, styles.hunkText]}>
          {row.header}
          {row.context ? <Text style={styles.hunkContext}>{`  ${row.context}`}</Text> : null}
        </Text>
      </View>
    );
  const text = displayText(row.text);
  const tint = row.kind === "add" ? styles.added : row.kind === "del" ? styles.removed : null;
  return (
    <View
      accessible
      accessibilityLabel={
        row.kind === "note" ? text : `${SPOKEN[row.kind]} line ${row.newNo ?? row.oldNo}: ${text.trim() || "blank"}`
      }
      style={[styles.line, tint, { width: widths.content }]}
    >
      <Text numberOfLines={1} style={[styles.code, styles.number, { width: widths.number }]}>
        {row.oldNo ?? ""}
      </Text>
      <Text numberOfLines={1} style={[styles.code, styles.number, { width: widths.number }]}>
        {row.newNo ?? ""}
      </Text>
      <Text
        numberOfLines={1}
        style={[
          styles.code,
          styles.sign,
          { width: widths.sign },
          row.kind === "add" ? styles.addedInk : row.kind === "del" ? styles.removedInk : null,
        ]}
      >
        {SIGN[row.kind]}
      </Text>
      <Text selectable={row.kind !== "note"} style={[styles.code, styles.text, row.kind === "note" ? styles.note : null]}>
        {text}
      </Text>
    </View>
  );
});

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    body: { flex: 1 },
    state: { gap: space.sm, paddingHorizontal: space["2xl"], paddingTop: space.xl },
    loading: { flexDirection: "row", alignItems: "center", gap: space.sm },
    meta: { ...typography.meta, color: colors.textMuted },
    message: { ...typography.body, color: colors.textPrimary },
    subtitle: { ...typography.meta, color: colors.textMuted, fontVariant: ["tabular-nums"] },
    code: { fontFamily: monoFontFamily, fontSize: CODE_SIZE, lineHeight: CODE_LINE },
    sample: { position: "absolute", top: 0, left: 0, opacity: 0 },
    line: { flexDirection: "row", alignItems: "flex-start" },
    added: { backgroundColor: colors.toneGoodSoft },
    removed: { backgroundColor: colors.toneErrorSoft },
    number: {
      paddingHorizontal: space.xs,
      textAlign: "right",
      color: colors.textSubtle,
      fontVariant: ["tabular-nums"],
    },
    sign: { paddingHorizontal: space.xs, textAlign: "center", color: colors.textSubtle },
    addedInk: { color: colors.toneGood, fontWeight: fontWeight.emphasis },
    removedInk: { color: colors.toneError, fontWeight: fontWeight.emphasis },
    text: { flex: 1, paddingRight: space.xl, color: colors.textDefault },
    note: { fontStyle: "italic", color: colors.textSubtle },
    hunk: {
      paddingVertical: space["2xs"],
      paddingHorizontal: space.lg,
      marginTop: space.sm,
      backgroundColor: colors.bgSurface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderSubtle,
    },
    hunkText: { color: colors.textSubtle },
    hunkContext: { color: colors.textMuted },
    pager: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: space.sm,
      paddingTop: space.sm,
      paddingHorizontal: space.lg,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.borderSubtle,
      backgroundColor: colors.bgApp,
    },
    position: { ...typography.meta, color: colors.textMuted, fontVariant: ["tabular-nums"] },
  });
