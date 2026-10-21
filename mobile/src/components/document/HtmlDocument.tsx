import { useMemo, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";

import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { radius, type Theme } from "../../theme/tokens";
import { createSandboxNavigationGate, withRestrictedContentPolicy, type SandboxNavigationGate } from "./htmlSandbox";

interface HtmlDocumentProps {
  html: string;
  /** Accessible name for the preview surface, e.g. the artifact title. */
  accessibilityLabel: string;
  /** Called with the target URL whenever the sandbox refuses a navigation. */
  onNavigationBlocked: (url: string) => void;
}

// Fixed, because the only way to measure a web document's content height is to
// run JavaScript inside it — which this surface refuses to do. The preview
// scrolls within its own frame.
const previewHeight = 460;

/**
 * The document is inert: JavaScript never runs, no navigation leaves the
 * initial body, and nothing is fetched, cached, or persisted. The preview is a
 * rendering of the document under review, not a browser pointed at it.
 *
 * Everything after the initial load — link taps, `target=_blank`, form posts,
 * redirects, meta refreshes, cross-origin subframes — is a navigation away from
 * the document and is refused, whatever URL it wears. See `htmlSandbox.ts` for
 * why that decision cannot be a URL test.
 */
export function HtmlDocument({ html, accessibilityLabel, onNavigationBlocked }: HtmlDocumentProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  // A new document is a new gate: one body's spent latch must not admit the next
  // body's first navigation. Tracked by identity rather than useMemo, because the
  // gate is state keyed to `html`, not a value computed from it.
  const gateRef = useRef<{ html: string; gate: SandboxNavigationGate } | null>(null);
  if (gateRef.current?.html !== html) {
    gateRef.current = { html, gate: createSandboxNavigationGate() };
  }
  const { gate } = gateRef.current;
  const webViewRef = useRef<WebView>(null);

  // The Document tab still shows the artifact's own bytes; only what the engine
  // executes is policed.
  const policedHtml = useMemo(() => withRestrictedContentPolicy(html), [html]);

  return (
    <View style={styles.frame}>
      <WebView
        accessibilityLabel={accessibilityLabel}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        allowsLinkPreview={false}
        cacheEnabled={false}
        domStorageEnabled={false}
        incognito
        javaScriptEnabled={false}
        nestedScrollEnabled
        // `originWhitelist` must stay permissive: a URL that fails the library's
        // whitelist is handed to `Linking.openURL` — the system browser — before
        // `onShouldStartLoadWithRequest` is ever consulted. Everything passes the
        // whitelist so that the refusal below is the only exit.
        originWhitelist={["*"]}
        // iOS only: `target=_blank` arrives here with no target frame. Android
        // never fires this, because `setSupportMultipleWindows={false}` routes the
        // same anchor back through the navigation gate below.
        onOpenWindow={(event) => onNavigationBlocked(event.nativeEvent.targetUrl)}
        ref={webViewRef}
        // Android's programmatic load never reaches the gate, so the first load
        // start shuts it here instead (`onPageStarted` precedes anything the
        // document can propose). A *second* load start means something began
        // loading that the request gate never approved — on Android a
        // `<form method="post">` submit bypasses `shouldOverrideUrlLoading`
        // entirely. Stop it and say so.
        onLoadStart={(event) => {
          if (gate.noteLoadStart() === "unauthorized") {
            webViewRef.current?.stopLoading();
            onNavigationBlocked(event.nativeEvent.url);
          }
        }}
        onShouldStartLoadWithRequest={(request) => {
          if (gate.allow(request.url)) {
            return true;
          }
          onNavigationBlocked(request.url);
          return false;
        }}
        setSupportMultipleWindows={false}
        source={{ html: policedHtml, baseUrl: "" }}
        style={[styles.webView, { backgroundColor: colors.bgSurface }]}
        thirdPartyCookiesEnabled={false}
      />
    </View>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    frame: {
      backgroundColor: colors.bgSurface,
      borderColor: colors.borderSubtle,
      borderRadius: radius.overlay,
      borderWidth: 1,
      height: previewHeight,
      overflow: "hidden",
    },
    webView: {
      flex: 1,
    },
  });
