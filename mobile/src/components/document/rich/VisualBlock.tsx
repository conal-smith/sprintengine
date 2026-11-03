import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Linking, StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { useTheme, useThemedStyles } from "../../../theme/ThemeProvider";
import { radius, space, type Theme } from "../../../theme/tokens";
import { SourceBlock, WellHeader } from "../SourceBlock";
import {
  buildVisualPage,
  createVisualNavigationGate,
  linkHost,
  linkToOffer,
  readVisualMessage,
  VISUAL_DID_NOT_DRAW,
  VISUAL_DRAW_TIMEOUT_MS,
  VISUAL_EMPTY,
  VISUAL_FRAME_MAX_HEIGHT,
  visualFrameHeight,
  visualThemeFor,
  visualThemeScript,
  visualTitle,
} from "./visualFrame";

/**
 * A reply's ```visual fence: the chart, table or drawing an agent wrote as
 * HTML and SVG, drawn in the reply as the desktop's chat draws it. While the
 * reply streams and the fence is not yet closed it is its source, since half
 * a document draws as half a chart. Then the visual, sized to what it holds
 * (up to the desktop's 900, past which it scrolls), with Source to read and
 * copy what it was drawn from. One that is too large, has nothing to draw, or
 * never draws keeps its source, with a note saying why.
 *
 * It is drawn in the theme it first opens in; a later switch of light and
 * dark is handed to the running visual, so one with a script keeps its state.
 * How the WebView is sealed is `visualFrame.ts`'s to say.
 */
export function VisualBlock({ source, language, ready }: { source: string; language: string; ready: boolean }) {
  const styles = useThemedStyles(createStyles);
  const [showSource, setShowSource] = useState(false);
  // Why it is shown as source, once something has said so; kept per source.
  const [failed, setFailed] = useState<{ source: string; note: string } | null>(null);
  const header = language || "visual";
  const note = failed?.source === source ? failed.note : null;
  const fail = useCallback((reason: string) => setFailed({ source, note: reason }), [source]);
  if (!ready) return <SourceBlock content={source} copyable={false} header={header} language="visual" />;
  if (note) return <SourceBlock content={source} header={header} language="visual" note={`Shown as source: ${note}`} />;
  if (showSource) {
    return (
      <SourceBlock
        action={{ label: "Visual", accessibilityLabel: "Show the visual", onPress: () => setShowSource(false) }}
        content={source}
        header={header}
        language="visual"
      />
    );
  }
  return (
    <View style={styles.well}>
      <WellHeader
        action={{ label: "Source", accessibilityLabel: "Show the visual's source", onPress: () => setShowSource(true) }}
        copy={source}
        label={header}
      />
      <View style={styles.visual}>
        <VisualPage onFail={fail} source={source} />
      </View>
    </View>
  );
}

function VisualPage({ source, onFail }: { source: string; onFail: (note: string) => void }) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const visualTheme = useMemo(() => visualThemeFor(theme), [theme]);
  // The page is built in the theme it first opens in; a switch is posted to it.
  const [openingTheme] = useState(visualTheme);
  const title = useMemo(() => visualTitle(source), [source]);
  const page = useMemo(() => buildVisualPage(source, openingTheme, title), [source, openingTheme, title]);
  // A new page is a new gate: one page's spent latch must not admit the next's.
  const gate = useMemo(() => {
    void page;
    return createVisualNavigationGate();
  }, [page]);
  const webViewRef = useRef<WebView>(null);
  const [reported, setReported] = useState<number | null>(null);
  const lastOffered = useRef<number | null>(null);

  const refused = "error" in page ? page.error : null;
  useEffect(() => {
    if (refused) onFail(refused);
  }, [refused, onFail]);

  // A page that never says how tall it is has not drawn.
  const drawn = reported !== null;
  useEffect(() => {
    if (drawn || refused) return;
    const timer = setTimeout(() => onFail(VISUAL_DID_NOT_DRAW), VISUAL_DRAW_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [drawn, refused, onFail]);

  // The page keeps the latest theme it is handed and passes it on once the
  // visual is listening, so a switch while it loads is not lost.
  const injectTheme = useCallback(() => {
    if (visualTheme !== openingTheme) webViewRef.current?.injectJavaScript(visualThemeScript(visualTheme));
  }, [visualTheme, openingTheme]);
  useEffect(injectTheme, [injectTheme]);

  if ("error" in page) return null;
  const scripted = page.scripted;

  const onMessage = (event: WebViewMessageEvent) => {
    const message = readVisualMessage(event.nativeEvent.data);
    if (!message) return;
    if (message.type === "empty") {
      onFail(VISUAL_EMPTY);
    } else if (message.type === "height") {
      const height = visualFrameHeight(message.height);
      if (height !== null) setReported(message.height);
    } else {
      const now = Date.now();
      const href = linkToOffer(message.href, { scripted, now, lastOfferedAt: lastOffered.current });
      if (!href) return;
      lastOffered.current = now;
      // The app cannot tell a tap from the visual's own script asking, so
      // nothing opens until the person says so.
      Alert.alert(`Open ${linkHost(href)}?`, href, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Open",
          onPress: () => {
            void Linking.openURL(href).catch(() => {
              /* No browser to hand it to. */
            });
          },
        },
      ]);
    }
  };

  const height = reported === null ? null : visualFrameHeight(reported);
  const scrolls = reported !== null && reported > VISUAL_FRAME_MAX_HEIGHT;
  return (
    <WebView
      accessibilityLabel={title}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      allowsInlineMediaPlayback={false}
      allowsLinkPreview={false}
      cacheEnabled={false}
      dataDetectorTypes="none"
      domStorageEnabled={false}
      geolocationEnabled={false}
      incognito
      javaScriptCanOpenWindowsAutomatically={false}
      // The host page measures the visual and reports its height, which
      // takes a script; the visual itself runs in a frame sealed inside it.
      javaScriptEnabled
      mediaCapturePermissionGrantType="deny"
      mediaPlaybackRequiresUserAction
      mixedContentMode="never"
      nestedScrollEnabled={scrolls}
      onContentProcessDidTerminate={() => onFail(VISUAL_DID_NOT_DRAW)}
      onError={() => onFail(VISUAL_DID_NOT_DRAW)}
      onLoadEnd={injectTheme}
      onLoadStart={() => {
        if (gate.noteLoadStart() === "unauthorized") webViewRef.current?.stopLoading();
      }}
      onMessage={onMessage}
      onOpenWindow={() => undefined}
      onRenderProcessGone={() => onFail(VISUAL_DID_NOT_DRAW)}
      onShouldStartLoadWithRequest={(request) => gate.allow(request.url)}
      // Everything passes the whitelist so the gate above is the only exit
      // (a URL that fails it is handed to the system browser), as in
      // `HtmlDocument`.
      originWhitelist={["*"]}
      overScrollMode="never"
      ref={webViewRef}
      scrollEnabled={scrolls}
      setSupportMultipleWindows={false}
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={scrolls}
      source={{ html: page.html, baseUrl: "" }}
      // One point tall until it says how tall it is: a WebView with no
      // height may never lay its page out.
      style={[styles.page, { height: height ?? 1 }]}
      thirdPartyCookiesEnabled={false}
    />
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    // The diagram's well (`ReplyBlocks.tsx`), so a visual and its source are the same block.
    well: {
      backgroundColor: colors.bgHover,
      borderColor: colors.borderSubtle,
      borderRadius: radius.overlay,
      borderWidth: StyleSheet.hairlineWidth,
      marginTop: space["2xs"],
      marginBottom: space.sm,
      overflow: "hidden",
    },
    visual: {
      padding: space.lg,
    },
    page: {
      backgroundColor: "transparent",
    },
  });
