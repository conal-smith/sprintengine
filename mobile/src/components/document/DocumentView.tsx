import { useCallback, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { useThemedStyles } from "../../theme/ThemeProvider";
import { monoFontFamily } from "../../theme/fonts";
import { space, type Theme } from "../../theme/tokens";
import { DocumentModeToggle, type DocumentViewMode } from "./DocumentModeToggle";
import { HtmlDocument } from "./HtmlDocument";
import { MarkdownDocument } from "./MarkdownDocument";
import { SourceBlock } from "./SourceBlock";

/**
 * How a document body should be read. Structurally the protocol's
 * `ArtifactPreviewMode`, kept independent because backlog item bodies are
 * rendered by the same component and are not artifacts.
 */
export type DocumentKind = "text" | "markdown" | "restrictedHtml";

interface DocumentViewProps {
  kind: DocumentKind;
  body: string;
  /** Names the document to screen readers, e.g. the artifact or item title. */
  title: string;
}

/** A refusal the reader needs to see; never a silent no-op. */
type BlockedLink = { reason: "scheme" | "navigation"; url: string };

// The refusal names what refused. Nothing here consults `Linking.canOpenURL`, so
// a `tel:` or `slack://` link is refused by this app's allowlist, not by the phone.
const blockedMessage: Record<BlockedLink["reason"], string> = {
  scheme: "Not opened — documents only open web and email links.",
  navigation: "Not opened — the preview sandbox does not follow links.",
};

/**
 * The one place a document body becomes a screen. Presentation only: fetching,
 * loading, and error states belong to the caller. Shared by artifact review and
 * backlog item detail.
 */
export function DocumentView({ kind, body, title }: DocumentViewProps) {
  const styles = useThemedStyles(createStyles);
  const [mode, setMode] = useState<DocumentViewMode>("preview");
  const [blocked, setBlocked] = useState<BlockedLink | null>(null);

  // A new document must not inherit the previous one's mode or refusal notice.
  const [source, setSource] = useState({ kind, body });
  if (source.kind !== kind || source.body !== body) {
    setSource({ kind, body });
    setMode("preview");
    setBlocked(null);
  }

  const onLinkBlocked = useCallback((url: string) => setBlocked({ reason: "scheme", url }), []);
  const onNavigationBlocked = useCallback((url: string) => setBlocked({ reason: "navigation", url }), []);
  const onModeChange = useCallback((next: DocumentViewMode) => {
    setMode(next);
    setBlocked(null);
  }, []);

  if (!body.trim()) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>This document is empty.</Text>
      </View>
    );
  }

  if (kind === "restrictedHtml") {
    return (
      <View style={styles.document}>
        <DocumentModeToggle onChange={onModeChange} value={mode} />
        {blocked ? <BlockedNotice blocked={blocked} /> : null}
        {mode === "preview" ? (
          <HtmlDocument accessibilityLabel={title} html={body} onNavigationBlocked={onNavigationBlocked} />
        ) : (
          <SourceBlock accessibilityLabel={`${title} source`} content={body} />
        )}
      </View>
    );
  }

  return (
    <View style={styles.document}>
      {blocked ? <BlockedNotice blocked={blocked} /> : null}
      {kind === "markdown" ? (
        <MarkdownDocument body={body} onLinkBlocked={onLinkBlocked} />
      ) : (
        <Text accessibilityLabel={title} selectable style={styles.plainText}>
          {body}
        </Text>
      )}
    </View>
  );
}

function BlockedNotice({ blocked }: { blocked: BlockedLink }) {
  const styles = useThemedStyles(createStyles);

  return (
    <View accessibilityRole="alert" style={styles.notice}>
      <Text style={styles.noticeText}>{blockedMessage[blocked.reason]}</Text>
      <Text numberOfLines={1} style={styles.noticeUrl}>
        {blocked.url}
      </Text>
    </View>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    document: {
      gap: space.lg,
    },
    plainText: {
      color: colors.textDefault,
      fontSize: 15,
      lineHeight: 22,
    },
    empty: {
      paddingVertical: space.lg,
    },
    emptyText: {
      color: colors.textMuted,
      fontSize: 13,
      lineHeight: 19,
    },
    notice: {
      backgroundColor: colors.bgHover,
      gap: space["3xs"],
      paddingHorizontal: space.lg,
      paddingVertical: space.sm,
    },
    noticeText: {
      color: colors.textDefault,
      fontSize: 13,
      lineHeight: 19,
    },
    noticeUrl: {
      color: colors.textSubtle,
      fontFamily: monoFontFamily,
      fontSize: 11,
      lineHeight: 16,
    },
  });
