import { memo, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type TextStyle } from "react-native";

import { CopyButton } from "../../components/CopyButton";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { monoFontFamily } from "../../theme/fonts";
import { fontWeight, radius, space, typography, type Theme } from "../../theme/tokens";
import { displayText } from "../diff/unifiedDiff";
import {
  ansiLines,
  clipLines,
  EXPANDED_LINES,
  numberedLines,
  PREVIEW_LINES,
  showAllLabel,
  stripAnsi,
  styleAt,
  toolOutputView,
  type AnsiTone,
  type EditView,
  type ToolDetail,
  type ToolSummary,
} from "./toolOutput";

// An opened tool step, drawn the way its kind reads (`toolOutput.ts` decides
// what each shows): a command on the terminal's ground, the inset a command's
// output stands on, with its exit status on its own line; a read's text with
// its line numbers in the gutter's ink; an edit as a diff; a search's lines; a
// fetch's text. Every long output shows a slice and "Show all", and Copy
// always copies the whole of it, escapes removed.

/** Where the step's detail stands: what the note under the panel says. */
export type ToolDetailState =
  | { kind: "ready" }
  | { kind: "running" }
  | { kind: "loading" }
  | { kind: "offline" }
  | { kind: "failed"; message: string };

export const ToolOutputPanel = memo(function ToolOutputPanel({
  tool,
  detail,
  state,
}: {
  tool: ToolSummary;
  detail: ToolDetail | null;
  state: ToolDetailState;
}) {
  const styles = useThemedStyles(createStyles);
  const { view, clipped } = useMemo(() => toolOutputView(tool, detail), [tool, detail]);
  const note =
    state.kind === "running"
      ? "Showing the output as it arrives; the whole of it loads when the step finishes."
      : state.kind === "loading"
      ? "Loading the full output…"
      : state.kind === "failed"
        ? `Couldn't load the full output: ${state.message}`
        : state.kind === "offline" && !detail
          ? "The full output loads when the desktop is connected."
          : clipped
            ? "The desktop kept the start and the end of this output; the middle was cut."
            : "";
  let body: ReactNode;
  switch (view.kind) {
    case "command":
      body = (
        <View style={styles.terminal}>
          <View style={styles.commandRow}>
            <Text style={[styles.mono, styles.prompt]}>$</Text>
            <Text selectable numberOfLines={8} style={[styles.mono, styles.command]}>
              {view.command || "command"}
            </Text>
            {view.command ? <CopyButton label="Copy command" text={view.command} /> : null}
          </View>
          {view.output ? (
            <View style={styles.terminalOutput}>
              <OutputBlock output={view.output} mode="tail" ansi copyLabel="Copy output" />
            </View>
          ) : null}
          <Text style={[styles.status, view.failed ? styles.errorInk : view.running ? styles.liveInk : null]}>
            {view.running
              ? "Running…"
              : view.exitCode !== undefined
                ? `exit ${view.exitCode}`
                : view.failed
                  ? "Failed"
                  : view.output
                    ? "Done"
                    : "Done · printed nothing"}
          </Text>
        </View>
      );
      break;
    case "read":
      body = view.failed ? (
        <Panel heading={view.path} copy={view.output}>
          <Text selectable style={[styles.prose, styles.errorInk]}>
            {view.output || "The file could not be read."}
          </Text>
        </Panel>
      ) : (
        <Panel heading={view.path} copy={view.output}>
          {view.output ? <ReadBlock output={view.output} /> : <Text style={styles.empty}>The file is empty.</Text>}
        </Panel>
      );
      break;
    case "edit":
      body = view.edits.length ? (
        <>
          {view.edits.map((edit, index) => (
            <EditBlock key={`${edit.path}:${index}`} edit={edit} subject={view.path} />
          ))}
          {view.failed && view.output ? (
            <Text selectable style={[styles.prose, styles.errorInk]}>
              {view.output}
            </Text>
          ) : null}
        </>
      ) : (
        <Panel heading={view.path} copy={view.output}>
          {view.output ? (
            <OutputBlock output={view.output} mode="head" />
          ) : (
            <Text style={styles.empty}>The step recorded no change to show.</Text>
          )}
        </Panel>
      );
      break;
    case "matches":
      body = (
        <Panel heading={view.heading} copy={view.output}>
          {view.output.trim() ? <OutputBlock output={view.output} mode="head" counted /> : <Text style={styles.empty}>{view.empty}</Text>}
        </Panel>
      );
      break;
    case "web":
      body = (
        <Panel heading={view.heading} copy={view.output}>
          {view.output.trim() ? <OutputBlock output={view.output} mode="head" prose /> : <Text style={styles.empty}>Nothing came back.</Text>}
        </Panel>
      );
      break;
    case "todo":
      body = (
        <Panel>
          {view.items.map((item, index) => (
            <View key={index} style={styles.todo}>
              <Text style={[styles.todoMark, item.status === "completed" ? styles.goodInk : item.status === "in_progress" ? styles.liveInk : null]}>
                {item.status === "completed" ? "✓" : item.status === "in_progress" ? "▸" : "○"}
              </Text>
              <Text style={[styles.prose, item.status === "completed" ? styles.done : null]}>{item.text}</Text>
            </View>
          ))}
        </Panel>
      );
      break;
    case "note":
      body = <Text style={styles.empty}>{view.text}</Text>;
      break;
    default:
      body = (
        <Panel copy={view.output || view.call}>
          {view.call ? (
            <Text selectable numberOfLines={6} style={[styles.mono, styles.call]}>
              {view.call}
            </Text>
          ) : null}
          {view.output ? <OutputBlock output={view.output} mode="head" /> : null}
          {!view.call && !view.output ? <Text style={styles.empty}>Nothing to show.</Text> : null}
        </Panel>
      );
  }
  return (
    <View style={styles.wrap}>
      {body}
      {note ? (
        <Text accessibilityLiveRegion="polite" style={[styles.note, state.kind === "failed" ? styles.errorInk : null]}>
          {note}
        </Text>
      ) : null}
    </View>
  );
});

/** A contained panel: an optional heading in mono with Copy at its end, then what the step produced. */
function Panel({ heading, copy, children }: { heading?: string; copy?: string; children: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  const copyable = copy ? stripAnsi(copy) : "";
  return (
    <View style={styles.panel}>
      {heading || copyable ? (
        <View style={styles.panelHead}>
          <Text numberOfLines={2} selectable style={[styles.mono, styles.heading]}>
            {heading}
          </Text>
          {copyable ? <CopyButton label="Copy output" text={() => copyable} /> : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/**
 * A long output's slice, and the way to the rest. A command shows its last
 * lines, since its end is how it went, with how many came before; anything
 * else its first, with how many follow. Show all draws up to
 * `EXPANDED_LINES`. Terminal colours are read only in the slice drawn, from
 * the colour in force where it starts.
 */
const OutputBlock = memo(function OutputBlock({
  output,
  mode,
  ansi = false,
  prose = false,
  counted = false,
  copyLabel,
}: {
  output: string;
  mode: "head" | "tail";
  ansi?: boolean;
  /** Text to read rather than terminal text: the body face. */
  prose?: boolean;
  /** Say how many lines there are: a search's or a listing's matches. */
  counted?: boolean;
  /** Copy beside the block, when nothing above it offers one. */
  copyLabel?: string;
}) {
  const styles = useThemedStyles(createStyles);
  const [all, setAll] = useState(false);
  const clip = useMemo(() => clipLines(output, mode, all ? EXPANDED_LINES : PREVIEW_LINES), [output, mode, all]);
  const lines = useMemo(
    () => (ansi ? ansiLines(clip.text, styleAt(output, clip.offset)) : null),
    [ansi, clip, output],
  );
  const toggle =
    clip.hidden > 0 || all ? (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: all }}
        hitSlop={space.sm}
        onPress={() => setAll(!all)}
        style={({ pressed }) => [styles.toggle, pressed ? styles.pressed : null]}
      >
        <Text style={styles.toggleText}>{all ? "Show less" : showAllLabel(clip)}</Text>
      </Pressable>
    ) : null;
  const hiddenLine =
    clip.hidden > 0 ? (
      <Text style={styles.hidden}>
        {mode === "tail"
          ? `… ${clip.hidden.toLocaleString("en-US")} earlier ${clip.hidden === 1 ? "line" : "lines"}`
          : `… ${clip.hidden.toLocaleString("en-US")} more ${clip.hidden === 1 ? "line" : "lines"}`}
      </Text>
    ) : null;
  // One line above the text holds what is worth saying there (the count, or
  // how many earlier lines a command's tail leaves out) with Copy at its end,
  // rather than Copy taking a line of its own.
  const lead = counted ? (
    <Text style={styles.count}>
      {clip.total.toLocaleString("en-US")} {clip.total === 1 ? "line" : "lines"}
    </Text>
  ) : mode === "tail" ? (
    hiddenLine
  ) : null;
  return (
    <View>
      {copyLabel ? (
        <View style={styles.blockHead}>
          {lead ?? <View />}
          <CopyButton label={copyLabel} text={() => stripAnsi(output)} />
        </View>
      ) : (
        lead
      )}
      {counted && mode === "tail" ? hiddenLine : null}
      <Text selectable style={prose ? styles.prose : [styles.mono, styles.output]}>
        {lines
          ? lines.map((line, index) => (
              <Text key={index}>
                {line.map((span, at) =>
                  span.tone || span.bold ? (
                    <Text key={at} style={[span.tone ? styles[TONE_STYLE[span.tone]] : null, span.bold ? styles.bold : null]}>
                      {span.text}
                    </Text>
                  ) : (
                    span.text
                  ),
                )}
                {index < lines.length - 1 ? "\n" : null}
              </Text>
            ))
          : stripAnsi(clip.text)}
      </Text>
      {mode === "head" ? hiddenLine : null}
      {toggle}
    </View>
  );
});

const TONE_STYLE: Record<AnsiTone, "ansiRed" | "ansiGreen" | "ansiYellow" | "ansiBlue" | "ansiCyan" | "ansiMuted"> = {
  red: "ansiRed",
  green: "ansiGreen",
  yellow: "ansiYellow",
  blue: "ansiBlue",
  magenta: "ansiBlue",
  cyan: "ansiCyan",
  muted: "ansiMuted",
};

/** A read's text, line numbers in the gutter's ink, unwrapped and scrolled sideways as code is. */
const ReadBlock = memo(function ReadBlock({ output }: { output: string }) {
  const styles = useThemedStyles(createStyles);
  const [all, setAll] = useState(false);
  const clip = useMemo(() => clipLines(output, "head", all ? EXPANDED_LINES : PREVIEW_LINES), [output, all]);
  const lines = useMemo(() => numberedLines(clip.text), [clip.text]);
  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text selectable style={[styles.mono, styles.output]}>
          {lines.map((line, index) => (
            <Text key={index}>
              {line.no ? <Text style={styles.gutter}>{line.no.padStart(4)}  </Text> : null}
              {displayText(line.text)}
              {index < lines.length - 1 ? "\n" : null}
            </Text>
          ))}
        </Text>
      </ScrollView>
      {clip.hidden > 0 ? (
        <Text style={styles.hidden}>
          … {clip.hidden.toLocaleString("en-US")} more {clip.hidden === 1 ? "line" : "lines"}
        </Text>
      ) : null}
      {clip.hidden > 0 || all ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: all }}
          hitSlop={space.sm}
          onPress={() => setAll(!all)}
          style={({ pressed }) => [styles.toggle, pressed ? styles.pressed : null]}
        >
          <Text style={styles.toggleText}>{all ? "Show less" : showAllLabel(clip)}</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const EDIT_PREVIEW_ROWS = 16;
const SIGN = { add: "+", del: "−", ctx: " " } as const;

/**
 * One file's change: its name when the row does not already say it, the
 * lines in and out, then the change as diff rows, the ones it added on the
 * good tone's wash and the ones it removed on the error's.
 */
const EditBlock = memo(function EditBlock({ edit, subject }: { edit: EditView; subject: string }) {
  const styles = useThemedStyles(createStyles);
  const [all, setAll] = useState(false);
  const rows = all ? edit.rows : edit.rows.slice(0, EDIT_PREVIEW_ROWS);
  const name = edit.path && edit.path !== subject ? edit.path : "";
  const summary = [
    edit.newFile ? "New file" : edit.contentsOnly ? "Whole file written" : "",
    edit.added ? `+${edit.added}` : "",
    edit.removed ? `−${edit.removed}` : "",
  ].filter(Boolean);
  return (
    <View style={styles.panel}>
      {name || summary.length ? (
        <View style={styles.panelHead}>
          <Text numberOfLines={1} style={[styles.mono, styles.heading]}>
            {name}
          </Text>
          <Text style={styles.count}>
            {summary.map((part, index) => (
              <Text
                key={part}
                style={part.startsWith("+") ? styles.goodInk : part.startsWith("−") ? styles.errorInk : null}
              >
                {index ? "  " : ""}
                {part}
              </Text>
            ))}
          </Text>
        </View>
      ) : null}
      <View>
        {rows.map((row, index) =>
          row.kind === "gap" ? (
            <Text key={index} style={[styles.mono, styles.gap]}>
              {row.text}
            </Text>
          ) : (
            <View key={index} style={[styles.diffRow, row.kind === "add" ? styles.added : row.kind === "del" ? styles.removed : null]}>
              <Text style={[styles.mono, styles.sign, row.kind === "add" ? styles.goodInk : row.kind === "del" ? styles.errorInk : null]}>
                {SIGN[row.kind]}
              </Text>
              <Text selectable style={[styles.mono, styles.diffText]}>
                {displayText(row.text) || " "}
              </Text>
            </View>
          ),
        )}
      </View>
      {edit.rows.length > EDIT_PREVIEW_ROWS ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: all }}
          hitSlop={space.sm}
          onPress={() => setAll(!all)}
          style={({ pressed }) => [styles.toggle, pressed ? styles.pressed : null]}
        >
          <Text style={styles.toggleText}>{all ? "Show less" : `Show all ${edit.rows.length} lines`}</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const CODE_SIZE = 12;
const CODE_LINE = 17;

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    wrap: { gap: space.xs, marginTop: space["2xs"], marginBottom: space.sm },
    pressed: { opacity: 0.6 },
    mono: { fontFamily: monoFontFamily, fontSize: CODE_SIZE, lineHeight: CODE_LINE },
    // A command and its output stand on the inset a command's output takes,
    // one step off the conversation's ground.
    terminal: {
      backgroundColor: colors.agentInset,
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderSubtle,
      overflow: "hidden",
    },
    commandRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: space.sm,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
    },
    prompt: { color: colors.textSubtle },
    command: { flex: 1, color: colors.textPrimary },
    terminalOutput: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.borderSubtle,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
    },
    status: {
      ...typography.meta,
      fontSize: 12,
      fontVariant: ["tabular-nums"],
      color: colors.textSubtle,
      paddingHorizontal: space.md,
      paddingBottom: space.sm,
    },
    output: { color: colors.textDefault },
    panel: {
      backgroundColor: colors.agentInset,
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderSubtle,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      gap: space.xs,
      overflow: "hidden",
    },
    panelHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
    heading: { flex: 1, color: colors.textMuted },
    blockHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    count: { ...typography.meta, fontSize: 12, color: colors.textSubtle, fontVariant: ["tabular-nums"] },
    call: { color: colors.textSubtle },
    prose: { ...typography.body, fontSize: 14, color: colors.textDefault },
    empty: { ...typography.meta, color: colors.textMuted },
    hidden: { ...typography.meta, fontSize: 12, color: colors.textSubtle, paddingVertical: space["3xs"] },
    toggle: { alignSelf: "flex-start", paddingVertical: space["2xs"] },
    toggleText: { ...typography.meta, fontWeight: fontWeight.emphasis, color: colors.textPrimary },
    note: { ...typography.meta, fontSize: 12, color: colors.textSubtle },
    gutter: { color: colors.textDisabled },
    errorInk: { color: colors.toneError },
    goodInk: { color: colors.toneGood },
    liveInk: { color: colors.accentPrimary },
    bold: { fontWeight: fontWeight.emphasis } as TextStyle,
    ansiRed: { color: colors.toneError },
    ansiGreen: { color: colors.toneGood },
    ansiYellow: { color: colors.toneWarn },
    ansiBlue: { color: colors.toneMerged },
    ansiCyan: { color: colors.toneAccent },
    ansiMuted: { color: colors.textSubtle },
    todo: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
    todoMark: { ...typography.body, fontSize: 14, width: space.lg, color: colors.textSubtle },
    done: { color: colors.textSubtle, textDecorationLine: "line-through" },
    diffRow: { flexDirection: "row", alignItems: "flex-start" },
    added: { backgroundColor: colors.toneGoodSoft },
    removed: { backgroundColor: colors.toneErrorSoft },
    sign: { width: space.lg, textAlign: "center", color: colors.textSubtle },
    diffText: { flex: 1, color: colors.textDefault },
    gap: { color: colors.textSubtle, paddingVertical: space["3xs"] },
  });
