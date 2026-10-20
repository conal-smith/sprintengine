import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Platform, ScrollView, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { SvgXml } from "react-native-svg";

import { useTheme, useThemedStyles } from "../../../theme/ThemeProvider";
import { radius, space, type Theme } from "../../../theme/tokens";
import { SourceBlock, WellHeader } from "../SourceBlock";
import { diagramNote, diagramRefusal, diagramTheme, mathNote } from "./diagramSource";
import { fenceKind, replyBlockReady } from "./replyMarkup";
import { fitDrawing, renderKey, richRenderer, type RenderJob, type RenderResult } from "./richRenderer";

/**
 * Set by `MarkdownDocument` around an agent's reply, and only there: a
 * person's own message, a plan and a document never draw a diagram or a
 * formula. `streaming` is whether the reply is still arriving.
 */
export const ReplyContext = createContext<{ streaming: boolean } | null>(null);

// The face a diagram's labels are measured in on the page and drawn in on the
// phone. It has to be one both have, or every label is measured for one face
// and drawn in another: Android's sans-serif (Roboto) is both the WebView's
// and react-native-svg's; on iOS the system face has no name the page and
// react-native-svg agree on, and Helvetica is in both.
const DIAGRAM_FACE = Platform.OS === "ios" ? "Helvetica" : "sans-serif";
const DIAGRAM_TEXT_SIZE = 14;
// The reply's body size, which KaTeX sets its formulas a fifth larger than.
const MATH_TEXT_SIZE = 15.5;
// A wide diagram shrinks to the column down to this, then scrolls.
const DIAGRAM_MIN_SCALE = 0.5;

/** The drawing for a job, once it is drawn; asks for it the first time it is wanted. */
function useDrawing(job: RenderJob | null): RenderResult | undefined {
  const key = job ? renderKey(job) : null;
  const drawn = useSyncExternalStore(richRenderer.subscribe, () => (key ? richRenderer.peek(key) : undefined));
  useEffect(() => {
    if (job && !drawn) richRenderer.request(job);
    // The key is the job.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, drawn]);
  return drawn;
}

/** A reply's fence: a diagram or a formula where it asks for one, else the code it is. */
export function ReplyFence({ content, info, meta }: { content: string; info: string; meta: unknown }) {
  const reply = useContext(ReplyContext);
  const language = info.trim().split(/\s+/)[0];
  const kind = reply ? fenceKind(language) : "code";
  if (reply && kind === "diagram") return <DiagramBlock ready={replyBlockReady(meta, reply.streaming)} source={content} language={language} />;
  if (reply && kind === "math") return <DisplayMath ready={replyBlockReady(meta, reply.streaming)} tex={content} />;
  // Copy waits for the fence to close while the reply streams: until then it
  // would take half the code.
  return (
    <SourceBlock
      content={content}
      copyable={!reply || replyBlockReady(meta, reply.streaming)}
      header={language || "code"}
      language={language || undefined}
    />
  );
}

/** A reply's `$$` or `\[` block. */
export function ReplyMathBlock({ tex, meta }: { tex: string; meta: unknown }) {
  const reply = useContext(ReplyContext);
  return <DisplayMath ready={replyBlockReady(meta, reply?.streaming ?? false)} tex={tex} />;
}

/** The width a drawing has to sit in, once laid out. */
function useColumnWidth(): [number, (event: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState(0);
  return [width, (event) => setWidth(Math.round(event.nativeEvent.layout.width))];
}

/**
 * A reply's ```mermaid fence. While the reply streams and the fence is not
 * yet closed it is its source: a diagram half-typed does not parse, and
 * redrawing it every token would flicker. Then the diagram, once drawn, with
 * Source to read (and select, and copy) what it was drawn from. One that is
 * refused or does not parse keeps its source, with a note saying why.
 */
function DiagramBlock({ source, language, ready }: { source: string; language: string; ready: boolean }) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const [showSource, setShowSource] = useState(false);
  const [column, onLayout] = useColumnWidth();
  const refusal = diagramRefusal(source);
  const job = useMemo<RenderJob | null>(
    () =>
      ready && !refusal
        ? {
            kind: "mermaid",
            source,
            fontSize: DIAGRAM_TEXT_SIZE,
            fontFamily: DIAGRAM_FACE,
            color: theme.colors.textDefault,
            theme: diagramTheme(theme.colors, theme.isDark),
          }
        : null,
    [ready, refusal, source, theme],
  );
  const drawn = useDrawing(job);
  const header = language || "mermaid";
  if (ready && refusal) return <SourceBlock content={source} header={header} language="mermaid" note={refusal} />;
  if (!ready || !drawn) return <SourceBlock content={source} copyable={ready} header={header} language="mermaid" />;
  if ("error" in drawn) return <SourceBlock content={source} header={header} language="mermaid" note={diagramNote(drawn.error)} />;
  if (showSource) {
    return (
      <SourceBlock
        action={{ label: "Diagram", accessibilityLabel: "Show the diagram", onPress: () => setShowSource(false) }}
        content={source}
        header={header}
        language="mermaid"
      />
    );
  }
  // The well's padding is not the drawing's to use.
  const fit = fitDrawing(drawn, column - space.lg * 2, DIAGRAM_MIN_SCALE);
  const picture = (
    <SvgXml height={fit.height} width={fit.width} xml={drawn.svg} />
  );
  return (
    <View style={styles.well}>
      <WellHeader
        action={{ label: "Source", accessibilityLabel: "Show the diagram's source", onPress: () => setShowSource(true) }}
        copy={source}
        label={header}
      />
      <View
        accessibilityLabel={`Diagram: ${source.trim().split("\n", 1)[0]}`}
        accessibilityRole="image"
        onLayout={onLayout}
        style={styles.diagram}
      >
        {column === 0 ? null : fit.scrolls ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {picture}
          </ScrollView>
        ) : (
          picture
        )}
      </View>
    </View>
  );
}

/**
 * A display formula: typeset once its block is complete, its TeX until then
 * and wherever it does not parse, with a note saying why. Never scaled
 * down: a formula wider than the column scrolls, as on the desktop.
 */
function DisplayMath({ tex, ready }: { tex: string; ready: boolean }) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const [column, onLayout] = useColumnWidth();
  const job = useMemo<RenderJob | null>(
    () =>
      ready
        ? { kind: "math", source: tex, fontSize: MATH_TEXT_SIZE, fontFamily: DIAGRAM_FACE, color: theme.colors.textDefault, theme: {} }
        : null,
    [ready, tex, theme],
  );
  const drawn = useDrawing(job);
  if (!ready || !drawn) return <SourceBlock content={tex} copyable={ready} header="math" />;
  if ("error" in drawn) return <SourceBlock content={tex} header="math" note={mathNote(drawn.error)} />;
  const fit = fitDrawing(drawn, column, 1);
  return (
    <View accessibilityLabel={tex} accessibilityRole="image" onLayout={onLayout} style={styles.formula}>
      {column === 0 ? null : fit.scrolls ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <SvgXml height={fit.height} width={fit.width} xml={drawn.svg} />
        </ScrollView>
      ) : (
        <SvgXml height={fit.height} width={fit.width} xml={drawn.svg} />
      )}
    </View>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    // SourceBlock's chat well, so a diagram and its source are the same block.
    well: {
      backgroundColor: colors.bgHover,
      borderColor: colors.borderSubtle,
      borderRadius: radius.overlay,
      borderWidth: StyleSheet.hairlineWidth,
      marginTop: space["2xs"],
      marginBottom: space.sm,
      overflow: "hidden",
    },
    diagram: {
      alignItems: "center",
      padding: space.lg,
    },
    formula: {
      alignItems: "center",
      marginTop: space["2xs"],
      marginBottom: space.sm,
    },
  });
