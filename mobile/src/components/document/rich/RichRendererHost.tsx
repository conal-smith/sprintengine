import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";

import { createSandboxNavigationGate } from "../htmlSandbox";
import { richRenderer, type RendererPort } from "./richRenderer";

/**
 * The hidden page every reply's diagrams and formulas are drawn in: one for
 * the app, mounted the first time anything asks for a drawing and kept for
 * the session. `HtmlDocument`, the artifact preview, stays as inert as it
 * was; this is a second, separate WebView, and the only one that runs script.
 *
 * It runs only its own: the document is built into the app
 * (`richRendererDocument.generated.ts`, from `scripts/build-rich-renderer.mjs`)
 * and its policy admits its five scripts by hash and nothing else — no
 * network, no frames, no fonts or images from anywhere, no forms. Every
 * navigation after the document's own load is refused, new windows are
 * refused, nothing is stored or cached. A diagram's or a formula's text
 * reaches it only as data, and what it sends back is checked and sanitised
 * by `richRenderer.ts` before anything draws it.
 *
 * It is one pixel, transparent, behind everything, and hidden from
 * accessibility: it is never looked at, only measured in.
 */
export function RichRendererHost() {
  const wanted = useSyncExternalStore(richRenderer.subscribe, richRenderer.wanted, richRenderer.wanted);
  return wanted ? <RendererPage /> : null;
}

function RendererPage() {
  // Each load is a new page with its own gate; a reset loads a new one.
  const [generation, setGeneration] = useState(0);
  const gate = useMemo(() => {
    void generation;
    return createSandboxNavigationGate();
  }, [generation]);
  const webViewRef = useRef<WebView>(null);
  // Required here rather than imported: the four megabytes of page are read
  // the first time a reply needs a drawing, not when the app starts.
  const html = useMemo(
    () =>
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require("./richRendererDocument.generated") as typeof import("./richRendererDocument.generated")).RICH_RENDERER_DOCUMENT,
    [],
  );

  useEffect(() => {
    const port: RendererPort = {
      post(job) {
        // The job is data: JSON, with the two line separators escaped so
        // no engine reads them as the end of the statement.
        const payload = JSON.stringify(job).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
        webViewRef.current?.injectJavaScript(`window.__richRender && window.__richRender(${payload});true;`);
      },
      reset() {
        setGeneration((current) => current + 1);
      },
    };
    richRenderer.attach(port);
    return () => richRenderer.detach(port);
  }, [generation]);

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={styles.frame}
    >
      <WebView
        key={generation}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        allowsInlineMediaPlayback={false}
        allowsLinkPreview={false}
        cacheEnabled={false}
        domStorageEnabled={false}
        geolocationEnabled={false}
        incognito
        javaScriptCanOpenWindowsAutomatically={false}
        javaScriptEnabled
        mediaPlaybackRequiresUserAction
        mixedContentMode="never"
        onContentProcessDidTerminate={() => richRenderer.crashed()}
        onMessage={(event) => richRenderer.receive(event.nativeEvent.data)}
        onOpenWindow={() => undefined}
        onRenderProcessGone={() => richRenderer.crashed()}
        onLoadStart={() => {
          if (gate.noteLoadStart() === "unauthorized") webViewRef.current?.stopLoading();
        }}
        onShouldStartLoadWithRequest={(request) => gate.allow(request.url)}
        // Everything passes the whitelist so the gate above is the only exit
        // (a URL that fails it is handed to the system browser), as in
        // `HtmlDocument`.
        originWhitelist={["*"]}
        ref={webViewRef}
        scrollEnabled={false}
        setSupportMultipleWindows={false}
        source={{ html, baseUrl: "" }}
        style={styles.page}
        // The page is measured in CSS pixels, which are the phone's points
        // only at 100%: a larger system text size must not swell a drawing.
        textZoom={100}
        thirdPartyCookiesEnabled={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    height: 1,
    left: 0,
    overflow: "hidden",
    position: "absolute",
    top: 0,
    width: 1,
    zIndex: -1,
  },
  page: { backgroundColor: "transparent", height: 1, width: 1 },
});
