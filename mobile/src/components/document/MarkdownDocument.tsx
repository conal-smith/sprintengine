import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import * as markdownLibrary from "react-native-markdown-display";
import Markdown, { AstRenderer, MarkdownIt, renderRules, type ASTNode, type RenderRules } from "react-native-markdown-display";

import { useThemedStyles } from "../../theme/ThemeProvider";
import { monoFontFamily } from "../../theme/fonts";
import { radius, space, type Theme, fontWeight } from "../../theme/tokens";
import { markdownRuns } from "./markdownRuns";
import { ReplyContext, ReplyFence, ReplyMathBlock } from "./rich/ReplyBlocks";
import { installReplyMarkup, type ReplyMarkdownIt } from "./rich/replyMarkup";
import { SourceBlock } from "./SourceBlock";
import { computeColumnWidths } from "./tableLayout";

interface MarkdownDocumentProps {
  body: string;
  /** Called with the href when a tap is refused because the scheme is not openable. */
  onLinkBlocked: (url: string) => void;
  /**
   * `chat` sets an assistant's reply at the desktop chat's scale: a roomier
   * body, headings told apart by weight rather than size, inline code as a
   * neutral pill, and each fence as a well headed by its language.
   */
  variant?: "document" | "chat";
  /**
   * An agent's reply, and only that: its ```mermaid fences draw as diagrams
   * and its display math is typeset (`rich/replyMarkup.ts`). A person's own
   * message, a plan and a document read as Markdown alone.
   */
  reply?: boolean;
  /** The reply is still arriving: a block draws only once nothing more can change it. */
  streaming?: boolean;
  /**
   * `muted` sets a chat's Markdown in the muted ink: an aside beside a reply,
   * such as the model's thinking, rather than the reply itself.
   */
  tone?: "default" | "muted";
}

// Stable instance: the library's default is constructed inside a default
// parameter, so it re-parses the whole document on every render.
// `typographer` supplies the curly quotes and em-dashes the type ramp expects;
// `html: false` keeps embedded markup inert — HTML bodies go to HtmlDocument's
// sandbox instead of being spliced into the native tree.
const markdownParser = MarkdownIt({ typographer: true, html: false, linkify: false });
// An agent's reply: the same, and its display math, inline math and each
// fence's completeness besides.
const replyParser = MarkdownIt({ typographer: true, html: false, linkify: false });
installReplyMarkup(replyParser as unknown as ReplyMarkdownIt);

const openableSchemes = /^(https?|mailto):/i;

// The renderer `Markdown` would build for itself, built here so its styles
// are merged once per theme. Given only `style` and `rules`, every `Markdown`
// merges the library's defaults under ours, flattens each style and derives
// a text-free twin for each when it mounts (and again whenever it renders,
// since its own memo leans on default props it makes afresh): a third of the
// cost of drawing a short reply, paid by every reply a chat opens with.
// `styles` and `removeTextStyleProps` are exported by the library (7.0.2)
// but not declared in its types.
const { styles: libraryStyles, removeTextStyleProps } = markdownLibrary as unknown as {
  styles: Record<string, object>;
  removeTextStyleProps: (style: object) => object;
};
const Renderer = AstRenderer as unknown as new (
  rules: RenderRules,
  styles: object,
  onLinkPress: (url: string) => boolean,
  maxTopLevelChildren: null,
  topLevelMaxExceededItem: ReactNode,
  allowedImageHandlers: string[],
  defaultImageHandler: string,
  debugPrintTree: boolean,
) => AstRenderer;
// The library's defaults for what this app never sets: no cap on top-level
// blocks, and the image handlers our own `image` rule does not consult.
const TOP_LEVEL_EXCEEDED = <Text key="dotdotdot">...</Text>;
const IMAGE_HANDLERS = ["data:image/png;base64", "data:image/gif;base64", "data:image/jpeg;base64", "https://", "http://"];

/** `getStyle(mergeStyle = true, style)` from the library's index.js, once per theme's sheet. */
const mergedStyleCache = new WeakMap<object, object>();
function mergedStyles(style: Record<string, object>): object {
  const cached = mergedStyleCache.get(style);
  if (cached) return cached;
  const merged: Record<string, object> = {};
  for (const key of Object.keys(style)) merged[key] = { ...StyleSheet.flatten(style[key]) };
  for (const key of Object.keys(libraryStyles)) merged[key] = { ...libraryStyles[key], ...StyleSheet.flatten(style[key]) };
  for (const key of Object.keys(merged)) merged[`_VIEW_SAFE_${key}`] = removeTextStyleProps(merged[key]);
  const created = StyleSheet.create(merged);
  mergedStyleCache.set(style, created);
  return created;
}
const mergedRulesCache = new WeakMap<RenderRules, RenderRules>();
function mergedRules(rules: RenderRules): RenderRules {
  let merged = mergedRulesCache.get(rules);
  if (!merged) mergedRulesCache.set(rules, (merged = { ...renderRules, ...rules }));
  return merged;
}

// The column geometry `tableLayout.ts` computes, published once per table and
// read by every cell at its column index. Without it each library `tr` is an
// independent row View and no column survives its header.
const TableColumnWidthsContext = createContext<readonly number[] | null>(null);

// `th`/`td` horizontal padding, which the geometry has to account for.
const cellPadding = space.sm * 2;

function TableCell({
  columnIndex,
  style,
  children,
}: {
  columnIndex: number;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const widths = useContext(TableColumnWidthsContext);
  const width = widths?.[columnIndex];

  return <View style={[style, width === undefined ? null : { width }]}>{children}</View>;
}

/**
 * Full markdown render — headings, emphasis, links, inline and fenced code,
 * tables, nested lists, blockquotes — on the app's theme tokens.
 */
export function MarkdownDocument({
  body,
  onLinkBlocked,
  variant = "document",
  reply = false,
  streaming = false,
  tone = "default",
}: MarkdownDocumentProps) {
  // They differ only in their values' literal types; all hand the same keys to the library.
  const factory = (
    variant === "chat" ? (tone === "muted" ? createChatMutedMarkdown : createChatMarkdown) : createMarkdown
  ) as typeof createMarkdown;
  const { markdownStyles, rules } = useThemedStyles(factory);

  // Anything the OS will not open as a document link (`javascript:`, custom app
  // schemes) is refused and reported rather than silently ignored.
  const onLinkPress = useCallback(
    (url: string) => {
      if (openableSchemes.test(url)) {
        return true;
      }
      onLinkBlocked(url);
      return false;
    },
    [onLinkBlocked],
  );

  const renderer = useMemo(
    () =>
      new Renderer(
        mergedRules(rules),
        mergedStyles(markdownStyles),
        onLinkPress,
        null,
        TOP_LEVEL_EXCEEDED,
        IMAGE_HANDLERS,
        "https://",
        false,
      ),
    [rules, markdownStyles, onLinkPress],
  );

  // A chat reply streams in. Drawn whole, every delta parsed and drew all of
  // it again; drawn in runs of blocks, a delta parses the last run, and the
  // runs before it are the same strings as last time. Documents never change
  // under the reader and are drawn whole.
  // A reply's runs are cut by the parser that draws them, so a `$$` block is
  // one block and never split between two runs.
  const parser = reply ? replyParser : markdownParser;
  const runs = useMemo(() => (variant === "chat" ? markdownRuns(body, parser) : null), [body, variant, parser]);
  const replyState = useMemo(() => (reply ? { streaming } : null), [reply, streaming]);

  // `Markdown` is memoized on prop identity; the renderer is theme-stable and
  // `onLinkPress` is pinned, so a run reparses only when its source or the
  // theme changes.
  const draw = (source: string, key?: number) => (
    <Markdown key={key} markdownit={parser} renderer={renderer}>
      {source}
    </Markdown>
  );
  // The runs stack as the whole body's View stacks its blocks: a plain
  // column, each block keeping its own margins. A reply is always held in
  // it, so growing past one run never remounts what is drawn.
  const drawn = runs ? <View>{runs.map((run, index) => draw(run, index))}</View> : draw(body);
  // The reply's state reaches its fences by context, so a reply that stops
  // streaming redraws its diagrams and formulas without reparsing the rest.
  return replyState ? <ReplyContext.Provider value={replyState}>{drawn}</ReplyContext.Provider> : drawn;
}

// Everything the library hardcodes in `lib/styles.js` (#000000 rules, #CCCCCC
// code borders, #F5F5F5 blockquote fills, `bold`) is overridden here: those
// defaults are merged under ours key-by-key, so an unlisted key keeps its
// hardcoded value.
const createMarkdown = (theme: Theme) => {
  const { colors } = theme;

  const markdownStyles = StyleSheet.create({
    body: {
      color: colors.textDefault,
      fontSize: 15,
      lineHeight: 22,
    },

    heading1: { color: colors.textPrimary, fontSize: 19, fontWeight: fontWeight.emphasis, lineHeight: 25, marginTop: space.xl, marginBottom: space.sm },
    heading2: { color: colors.textPrimary, fontSize: 17, fontWeight: fontWeight.emphasis, lineHeight: 23, marginTop: space.xl, marginBottom: space.sm },
    heading3: { color: colors.textPrimary, fontSize: 15, fontWeight: fontWeight.emphasis, lineHeight: 20, marginTop: space.lg, marginBottom: space["2xs"] },
    heading4: { color: colors.textPrimary, fontSize: 15, fontWeight: fontWeight.emphasis, lineHeight: 20, marginTop: space.lg, marginBottom: space["2xs"] },
    heading5: { color: colors.textMuted, fontSize: 15, fontWeight: fontWeight.emphasis, lineHeight: 20, marginTop: space.lg, marginBottom: space["2xs"] },
    heading6: { color: colors.textMuted, fontSize: 15, fontWeight: fontWeight.emphasis, lineHeight: 20, marginTop: space.lg, marginBottom: space["2xs"] },

    hr: { backgroundColor: colors.borderSubtle, height: 1, marginVertical: space.xl },

    strong: { color: colors.textPrimary, fontWeight: fontWeight.emphasis },
    em: { fontStyle: "italic" },

    blockquote: {
      backgroundColor: "transparent",
      borderColor: colors.borderStrong,
      borderLeftWidth: 2,
      marginLeft: 0,
      marginVertical: space.sm,
      paddingHorizontal: 0,
      paddingLeft: space.lg,
    },

    bullet_list: { marginTop: space["2xs"], marginBottom: space.sm },
    ordered_list: { marginTop: space["2xs"], marginBottom: space.sm },
    list_item: { marginBottom: space["2xs"] },
    bullet_list_icon: { color: colors.textSubtle, fontSize: 15, lineHeight: 22, marginLeft: 0, marginRight: space.sm },
    ordered_list_icon: {
      color: colors.textSubtle,
      fontSize: 15,
      fontVariant: ["tabular-nums"],
      lineHeight: 22,
      marginLeft: 0,
      marginRight: space.sm,
    },

    code_inline: {
      backgroundColor: colors.bgHover,
      borderRadius: radius.control,
      borderWidth: 0,
      color: colors.textPrimary,
      fontFamily: monoFontFamily,
      fontSize: 13,
      padding: 0,
      paddingHorizontal: space.xs,
    },

    // Tables carry one hairline idiom: a rule under every row, header cells
    // shaded rather than boxed. No outer border, no column separators.
    table: { borderRadius: 0, borderWidth: 0 },
    tableScroll: { marginVertical: space.sm },
    // The library pins every cell to `flex: 1`, which divides the phone's width
    // by the column count and shatters identifiers mid-word ("toneErro/r on").
    // `flex: 0` hands sizing to the shared column width TableCell applies.
    th: {
      backgroundColor: colors.bgHover,
      color: colors.textPrimary,
      flex: 0,
      fontSize: 13,
      fontVariant: ["tabular-nums"],
      fontWeight: fontWeight.emphasis,
      lineHeight: 18,
      padding: space.sm,
    },
    tr: { borderBottomColor: colors.borderSubtle, borderBottomWidth: 1, borderColor: colors.borderSubtle },
    td: {
      color: colors.textDefault,
      flex: 0,
      fontSize: 13,
      fontVariant: ["tabular-nums"],
      lineHeight: 18,
      padding: space.sm,
    },

    link: { color: colors.textPrimary, textDecorationLine: "underline" },
    blocklink: { borderColor: colors.borderSubtle },

    paragraph: { marginTop: 0, marginBottom: space.lg },

    imageNotice: { color: colors.textMuted, fontSize: 13, lineHeight: 20, marginVertical: space["2xs"] },
  });

  const rules: RenderRules = {
    // A single newline inside a paragraph is a *soft* break: it reflows as a
    // space, the way every other markdown renderer treats it. The library emits
    // a literal newline, which shatters hard-wrapped documents — and every
    // artifact this app reads is hard-wrapped.
    softbreak: (node) => <Text key={node.key}> </Text>,

    // Fences scroll horizontally instead of wrapping (see SourceBlock).
    fence: (node) => {
      // The renderer copies token.info onto its AST, but omits it from ASTNode's declaration.
      const info = (node as ASTNode & { sourceInfo?: unknown }).sourceInfo;
      return <SourceBlock key={node.key} content={trimTrailingNewline(node.content)} language={typeof info === "string" ? info : undefined} />;
    },
    code_block: (node) => <SourceBlock key={node.key} content={trimTrailingNewline(node.content)} />,

    // One column geometry for the whole table, so headers stay above their
    // values; wide tables scroll sideways rather than compress.
    table: (node, children, parent, styles) => (
      <ScrollView
        horizontal
        key={node.key}
        showsHorizontalScrollIndicator={false}
        style={markdownStyles.tableScroll}
      >
        <TableColumnWidthsContext.Provider value={computeColumnWidths(node, cellPadding)}>
          <View style={styles._VIEW_SAFE_table}>{children}</View>
        </TableColumnWidthsContext.Provider>
      </ScrollView>
    ),
    th: (node, children, parent, styles) => (
      <TableCell columnIndex={node.index} key={node.key} style={styles._VIEW_SAFE_th}>
        {children}
      </TableCell>
    ),
    td: (node, children, parent, styles) => (
      <TableCell columnIndex={node.index} key={node.key} style={styles._VIEW_SAFE_td}>
        {children}
      </TableCell>
    ),

    // The library picks the list marker from *any* list ancestor, so an ordered
    // list nested in a bullet list renders bullets, and a `start` attribute is
    // concatenated as a string rather than added. Both are fixed here. The
    // bullet is `•` on every platform (the library substitutes `·` on iOS).
    list_item: (node, children, parent, styles) => {
      const list = (parent as ASTNode[]).find(
        (ancestor) => ancestor.type === "bullet_list" || ancestor.type === "ordered_list",
      );

      if (list?.type === "ordered_list") {
        const start = Number(list.attributes?.start ?? 1);
        return (
          <View key={node.key} style={styles._VIEW_SAFE_list_item}>
            <Text style={styles.ordered_list_icon}>
              {(Number.isFinite(start) ? start : 1) + node.index}
              {node.markup}
            </Text>
            <View style={styles._VIEW_SAFE_ordered_list_content}>{children}</View>
          </View>
        );
      }

      return (
        <View key={node.key} style={styles._VIEW_SAFE_list_item}>
          <Text accessible={false} style={styles.bullet_list_icon}>
            {"•"}
          </Text>
          <View style={styles._VIEW_SAFE_bullet_list_content}>{children}</View>
        </View>
      );
    },

    // Documents under review are not permitted to pull remote bytes onto the
    // phone, and their relative paths resolve against the desktop workspace, not
    // the device. The reference is named instead of silently dropped.
    image: (node) => {
      const source = readAttribute(node, "alt") || readAttribute(node, "src") || "unnamed";
      return (
        <Text key={node.key} style={markdownStyles.imageNotice}>
          Image not loaded — {source}
        </Text>
      );
    },
  };

  return { markdownStyles, rules };
};

// The chat's reply scale, over the document's: 15.5 on 1.6, every heading at
// body size and told apart by weight, as the desktop's chat sets a reply.
const CHAT_BODY: { fontSize: number; lineHeight: number } = { fontSize: 15.5, lineHeight: 25 };
const createChatMarkdown = (theme: Theme) => {
  const { colors } = theme;
  const base = createMarkdown(theme);
  const heading = {
    color: colors.textPrimary,
    ...CHAT_BODY,
    fontWeight: fontWeight.emphasis,
    marginTop: space.sm,
    marginBottom: space["2xs"],
  };
  const markdownStyles = StyleSheet.create({
    ...base.markdownStyles,
    body: { ...base.markdownStyles.body, ...CHAT_BODY },
    heading1: heading,
    heading2: heading,
    heading3: heading,
    heading4: heading,
    heading5: { ...heading, color: colors.textMuted },
    heading6: { ...heading, color: colors.textMuted },
    bullet_list_icon: { ...base.markdownStyles.bullet_list_icon, ...CHAT_BODY },
    ordered_list_icon: { ...base.markdownStyles.ordered_list_icon, ...CHAT_BODY },
    code_inline: {
      ...base.markdownStyles.code_inline,
      backgroundColor: colors.bgSurfaceSelected,
      borderColor: colors.borderSubtle,
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      fontSize: 13,
    },
    paragraph: { marginTop: 0, marginBottom: space.sm },
  });
  const rules: RenderRules = {
    ...base.rules,
    // A reply's fence may be a diagram or a formula (`ReplyFence`); anywhere
    // else, and any other fence, it is the code it is.
    fence: (node) => {
      const { sourceInfo: info, sourceMeta: meta } = node as ASTNode & { sourceInfo?: unknown; sourceMeta?: unknown };
      return (
        <ReplyFence
          key={node.key}
          content={trimTrailingNewline(node.content)}
          info={typeof info === "string" ? info : ""}
          meta={meta}
        />
      );
    },
    // Only a reply's parser makes these.
    math_block: (node) => (
      <ReplyMathBlock key={node.key} meta={(node as ASTNode & { sourceMeta?: unknown }).sourceMeta} tex={node.content} />
    ),
    // Inline math is its TeX in a code pill: a text run cannot hold a typeset
    // formula without breaking its line around it.
    math_inline: (node, children, parent, styles) => (
      <Text key={node.key} accessibilityLabel={node.content} style={styles.code_inline}>
        {node.content}
      </Text>
    ),
    code_block: (node) => <SourceBlock key={node.key} content={trimTrailingNewline(node.content)} header="code" />,
  };
  return { markdownStyles, rules };
};

// The chat's scale in the muted ink, for what is said beside a reply rather
// than as it: the model's thinking. Emphasis, code and links step up one tier
// rather than to full strength, so they still read as themselves without the
// aside competing with the answer it led to.
const createChatMutedMarkdown = (theme: Theme) => {
  const { colors } = theme;
  const chat = createChatMarkdown(theme);
  const styles = chat.markdownStyles;
  const heading = { ...styles.heading1, color: colors.textMuted };
  const markdownStyles = StyleSheet.create({
    ...styles,
    body: { ...styles.body, color: colors.textMuted },
    heading1: heading,
    heading2: heading,
    heading3: heading,
    heading4: heading,
    heading5: heading,
    heading6: heading,
    strong: { ...styles.strong, color: colors.textDefault },
    code_inline: { ...styles.code_inline, color: colors.textDefault },
    link: { ...styles.link, color: colors.textDefault },
    th: { ...styles.th, color: colors.textDefault },
    td: { ...styles.td, color: colors.textMuted },
  });
  return { markdownStyles, rules: chat.rules };
};

function readAttribute(node: ASTNode, name: string): string {
  const value: unknown = node.attributes?.[name];
  return typeof value === "string" ? value.trim() : "";
}

function trimTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content.slice(0, -1) : content;
}
