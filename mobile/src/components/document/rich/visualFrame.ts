// A reply's ```visual block on the phone: charts, tables and annotated
// drawings an agent writes as HTML with inline SVG and CSS, and sometimes a
// <script> of its own (a table that sorts, a toggle between two views). The
// desktop draws them in its chat (`src/renderer/.../conversationVisual.tsx`);
// this is the same block drawn in a WebView in the reply (`VisualBlock.tsx`).
//
// What the visual is built from is the desktop's own, mirrored byte for byte
// into `src/shared/visual/` and held to it by `visualFrame.regression.test.js`:
// the size cap, the variables a visual colours with and the stylesheet it opens
// with (`visual-document.ts`), and the sealed document a scripted visual runs
// in, with its policy and the small reporter that sends its height and takes
// the theme (`sealed-visual-document.ts`).
//
// The WebView is a host page of the app's own, and the visual runs in a frame
// inside it, sandboxed to scripts alone, exactly as the desktop's chat runs a
// scripted visual. Every layer holds on its own:
//
// - The frame is `sandbox="allow-scripts"` and nothing else: an opaque origin,
//   so no cookies, no storage, no reach into the host page or the app; no
//   popups, no navigating the page, no forms, no dialogs. A cross-origin frame
//   is also never handed the camera or the microphone, which matters on
//   Android: there the WebView grants a page any capture permission the app
//   already holds, without asking.
// - The host page and the frame both carry the desktop's sealed policy
//   (`SEALED_VISUAL_POLICY`): no fetch, socket, frame, worker, remote picture or
//   font, form target or base address. A `srcdoc` frame inherits its host's
//   policy as well as declaring its own. Since `frame-src` falls back to
//   `default-src 'none'`, the frame cannot be navigated anywhere either: not to
//   a web address, not to `data:`, not by a meta refresh.
// - A visual without a <script> does not run anything of its own: its frame's
//   policy admits the reporter by hash and no other script, so an `onload`
//   attribute or a `javascript:` link in it is inert, as the desktop's
//   sanitizer makes it.
// - The WebView refuses every navigation but its own first load and the
//   frame's `srcdoc` (`createVisualNavigationGate`), opens no window, and
//   stores and caches nothing.
// - The elements that only load, frame, refresh or re-base a document are
//   taken out before the frame is built, in the host page, which has the
//   HTML parser the app does not (the desktop's `readVisualParts`, done the
//   same way).
//
// The host page speaks to the app only through
// `window.ReactNativeWebView.postMessage`, of three things: the visual's
// height, a link the person tapped, and that there was nothing to draw. The
// visual's own script could send the same, so every message is read as
// untrusted (`readVisualMessage`): its shape is checked, a height is capped,
// and a link opens only once the person has said yes to it.
//
// Kept free of React Native imports so it can be pinned under `node --test`.

import { createSandboxNavigationGate, type SandboxNavigationGate } from "../htmlSandbox";
import { assembleScriptedVisualDocument, hasVisualScript, SEALED_VISUAL_POLICY } from "../../../shared/visual/sealed-visual-document";
import { SEALED_VISUAL_CHANNEL } from "../../../shared/visual/sealed-visual";
import {
  MAX_VISUAL_SOURCE,
  VISUAL_EMPTY,
  VISUAL_FRAME_MAX_HEIGHT,
  VISUAL_TOO_LARGE,
  VISUAL_VARIABLES,
  type VisualTheme,
} from "../../../shared/visual/visual-document";
import { typography, type Theme, type ThemeColors } from "../../../theme/tokens";

export { MAX_VISUAL_SOURCE, VISUAL_EMPTY, VISUAL_FRAME_MAX_HEIGHT, VISUAL_TOO_LARGE };

/** Shown, after "Shown as source: ", when a frame never says how tall it is. */
export const VISUAL_DID_NOT_DRAW = "the visual did not draw";

/** How long a frame has to report its height before its source is shown instead. */
export const VISUAL_DRAW_TIMEOUT_MS = 10_000;

// The phone's own faces: its platform UI family (the app bundles no other) and
// a monospace one. Generic names, since the WebView's and the app's fonts are
// the platform's either way.
const VISUAL_FONT = "system-ui, -apple-system, sans-serif";
const VISUAL_FONT_MONO = "ui-monospace, Menlo, monospace";

/**
 * Each variable a visual colours and sets type with (`VISUAL_VARIABLES`, the
 * names the agents are told to use), read from the phone's tokens. The
 * desktop reads the same names off its semantic tokens; these are their
 * counterparts here, so one source reads alike on both screens and in both
 * modes.
 */
const VISUAL_TOKENS: Readonly<Record<string, (colors: ThemeColors) => string>> = {
  "--fg": (colors) => colors.textDefault,
  "--fg-strong": (colors) => colors.textPrimary,
  "--fg-muted": (colors) => colors.textMuted,
  "--fg-subtle": (colors) => colors.textSubtle,
  "--border": (colors) => colors.borderDefault,
  "--border-subtle": (colors) => colors.borderSubtle,
  "--bg-subtle": (colors) => colors.bgWell,
  "--accent": (colors) => colors.accentPrimary,
  "--positive": (colors) => colors.toneGood,
  "--negative": (colors) => colors.toneError,
  "--warning": (colors) => colors.toneWarn,
  "--chart-1": (colors) => colors.chart1,
  "--chart-2": (colors) => colors.chart2,
  "--chart-3": (colors) => colors.chart3,
  "--chart-4": (colors) => colors.chart4,
  "--chart-5": (colors) => colors.chart5,
  "--chart-6": (colors) => colors.chart6,
  "--chart-7": (colors) => colors.chart7,
  "--chart-8": (colors) => colors.chart8,
  "--chart-other": (colors) => colors.chartOther,
  "--font": () => VISUAL_FONT,
  "--font-mono": () => VISUAL_FONT_MONO,
  // The desktop's body, meta and heading sizes, at the phone's: a visual's
  // text sits a step under the reply's prose, as a diagram's labels do.
  "--font-size": () => `${typography.meta.fontSize}px`,
  "--font-size-small": () => `${typography.micro.fontSize}px`,
  "--font-size-heading": () => `${typography.heading.fontSize}px`,
};

/** The theme a visual is drawn in: every variable the desktop names, from the phone's tokens, and the mode's colour scheme. */
export function visualThemeFor(theme: Pick<Theme, "colors" | "isDark">): VisualTheme {
  const variables: Record<string, string> = {};
  for (const name of Object.keys(VISUAL_VARIABLES)) {
    const read = VISUAL_TOKENS[name];
    if (read) variables[name] = read(theme.colors);
  }
  return { variables, colorScheme: theme.isDark ? "dark" : "light" };
}

/**
 * The sha256 of the desktop's reporter script, as a policy source: the one
 * script a visual without its own may run. Pinned, since the phone has no
 * synchronous digest; the regression suite recomputes it from the mirrored
 * builder, so a change there fails the build instead of a visual's frame.
 */
export const VISUAL_REPORTER_HASH = "'sha256-0bA9cZ4mk0WzncfraLMnlnelhPQPfyxYWrFv6w+27Sk='";

// Where the visual's head and body go in the desktop's sealed document. The
// document is ours up to them (a theme value cannot hold a `<`), so each
// occurs once.
const HEAD_MARK = "<!--sprintengine-visual-head-->";
const BODY_MARK = "<!--sprintengine-visual-body-->";

// The desktop's `REMOVED_ELEMENTS`: elements that only load, frame, refresh
// or re-base a document. The regression suite holds the two lists together.
export const VISUAL_REMOVED_ELEMENTS = "meta, base, link, iframe, frame, frameset, object, embed, portal";

// What a static visual's links look like: the text they are.
const STATIC_LINK_STYLE = "<style>a[href] { color: inherit; text-decoration: none; cursor: default; }</style>";

/** The tallest the host lets the frame grow; past `VISUAL_FRAME_MAX_HEIGHT` the WebView scrolls it. */
const FRAME_HEIGHT_LIMIT = VISUAL_FRAME_MAX_HEIGHT * 20;

/** The sealed document for a visual, split where its own head and body go; null if the builder's shape is not the one expected. */
export function visualDocumentShell(
  theme: VisualTheme,
  scripted: boolean,
): { prefix: string; middle: string; suffix: string } | null {
  const built = assembleScriptedVisualDocument({ head: HEAD_MARK, body: BODY_MARK, title: "", empty: false }, theme);
  if ("error" in built) return null;
  const [prefix, rest, ...extraHead] = built.html.split(HEAD_MARK);
  if (rest === undefined || extraHead.length > 0) return null;
  const [middle, suffix, ...extraBody] = rest.split(BODY_MARK);
  if (suffix === undefined || extraBody.length > 0) return null;
  if (scripted) return { prefix, middle, suffix };
  // No script of its own: the reporter, by hash, and nothing else. Its links
  // open nothing, so they do not dress as links either, as the desktop's
  // static visuals do not; the visual's own styles still come after.
  const tightened = SEALED_VISUAL_POLICY.replace("script-src 'unsafe-inline'", `script-src ${VISUAL_REPORTER_HASH}`);
  if (tightened === SEALED_VISUAL_POLICY || prefix.split(SEALED_VISUAL_POLICY).length !== 2) return null;
  return { prefix: prefix.replace(SEALED_VISUAL_POLICY, tightened) + STATIC_LINK_STYLE, middle, suffix };
}

/** The reporter script in a built shell, exactly as the frame runs it; the regression suite hashes it. */
export function reporterScriptOf(prefix: string): string | null {
  const match = /<script>([\s\S]*?)<\/script>/.exec(prefix);
  return match ? match[1] : null;
}

// Data in an inline script: JSON with every `<` escaped, so it can neither end
// the element nor open a comment in it, and the two line separators escaped
// so no engine reads them as the end of a statement.
function scriptData(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// The host page's own script. It takes the visual apart in a parser that runs
// nothing (`readVisualParts` on the desktop: the same elements dropped, the
// head's styles and scripts kept, the same test for "nothing to draw"),
// builds the frame, and passes on what the frame says. A message is taken only
// from the frame's own window and only of the two shapes it may send; the app
// checks it again regardless.
const HOST_SCRIPT = `(function () {
  var data = __VISUAL_DATA__;
  function tell(message) {
    var bridge = window.ReactNativeWebView;
    message.channel = data.channel;
    if (bridge) bridge.postMessage(JSON.stringify(message));
  }
  var parsed = new DOMParser().parseFromString(data.source, 'text/html');
  Array.prototype.forEach.call(parsed.querySelectorAll(data.removed), function (element) { element.remove(); });
  var head = Array.prototype.map.call(parsed.head.querySelectorAll('style, script'), function (element) { return element.outerHTML; }).join('');
  var body = parsed.body;
  if (!(body.textContent || '').replace(/\\s+/g, ' ').trim() && !body.querySelector('svg, img, canvas, script, input, button') && !head) {
    tell({ type: 'empty' });
    return;
  }
  var frame = document.createElement('iframe'), listening = false, theme = null;
  function postTheme() {
    if (theme && listening && frame.contentWindow) frame.contentWindow.postMessage({ channel: data.channel, type: 'theme', variables: theme.variables, colorScheme: theme.colorScheme }, '*');
  }
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('title', data.title);
  window.addEventListener('message', function (event) {
    var message = event.data;
    if (event.source !== frame.contentWindow || !message || typeof message !== 'object' || message.channel !== data.channel) return;
    if (message.type === 'height' && typeof message.height === 'number' && isFinite(message.height) && message.height >= 0) {
      var height = Math.min(Math.ceil(message.height), data.limit);
      frame.style.height = height + 'px';
      tell({ type: 'height', height: height });
      if (!listening) { listening = true; postTheme(); }
    } else if (message.type === 'open-link' && typeof message.href === 'string' && message.href.length <= 2048) {
      tell({ type: 'open-link', href: message.href });
    }
  });
  window.__visualTheme = function (next) {
    theme = next;
    if (typeof next.colorScheme === 'string') document.documentElement.style.colorScheme = next.colorScheme;
    postTheme();
  };
  frame.srcdoc = data.prefix + head + data.middle + body.innerHTML + data.suffix;
  document.body.appendChild(frame);
})();`;

/** The page a visual's WebView loads, or why its source is shown instead. */
export type VisualPage = { html: string; scripted: boolean } | { error: string };

/**
 * The host page for a ```visual block's source, in the theme it is first
 * drawn in. A later change of theme reaches the running visual by message
 * (`visualThemeScript`), so a scripted visual keeps its state.
 */
export function buildVisualPage(source: string, theme: VisualTheme, title: string): VisualPage {
  if (source.length > MAX_VISUAL_SOURCE) return { error: VISUAL_TOO_LARGE };
  const scripted = hasVisualScript(source);
  const shell = visualDocumentShell(theme, scripted);
  if (!shell) return { error: VISUAL_DID_NOT_DRAW };
  const data = {
    source,
    title,
    removed: VISUAL_REMOVED_ELEMENTS,
    channel: SEALED_VISUAL_CHANNEL,
    limit: FRAME_HEIGHT_LIMIT,
    ...shell,
  };
  const scheme = theme.colorScheme === "dark" ? "dark" : "light";
  const html =
    `<!doctype html><html style="color-scheme: ${scheme}"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${SEALED_VISUAL_POLICY}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">` +
    // The frame's scheme must match its host's, or the engine paints it opaque.
    `<style>html, body { margin: 0; padding: 0; background: transparent; } iframe { display: block; width: 100%; height: 0; border: 0; }</style>` +
    `</head><body><script>${HOST_SCRIPT.replace("__VISUAL_DATA__", () => scriptData(data))}</script></body></html>`;
  return { html, scripted };
}

/** The statement that hands a running visual a new theme, for `injectJavaScript`. */
export function visualThemeScript(theme: VisualTheme): string {
  return `window.__visualTheme && window.__visualTheme(${scriptData(theme)});true;`;
}

/** What a visual's page may tell the app. */
export type VisualMessage = { type: "height"; height: number } | { type: "open-link"; href: string } | { type: "empty" };

/** Past this a message is not one the host page sent. */
const MAX_MESSAGE_LENGTH = 4096;
/** Past this length a link is not one anybody tapped. */
const MAX_LINK_LENGTH = 2048;

/** The message, when `data` is one of the three a visual's page may send; null for anything else. */
export function readVisualMessage(data: unknown): VisualMessage | null {
  if (typeof data !== "string" || data.length > MAX_MESSAGE_LENGTH) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = parsed as Record<string, unknown>;
  if (message.channel !== SEALED_VISUAL_CHANNEL) return null;
  if (message.type === "height") {
    const height = message.height;
    return typeof height === "number" && Number.isFinite(height) ? { type: "height", height } : null;
  }
  if (message.type === "open-link") {
    const href = message.href;
    return typeof href === "string" && href.length > 0 && href.length <= MAX_LINK_LENGTH ? { type: "open-link", href } : null;
  }
  if (message.type === "empty") return { type: "empty" };
  return null;
}

/** The height the visual's WebView takes for a reported one: none for nothing, and never past the desktop's cap. */
export function visualFrameHeight(reported: number): number | null {
  if (!Number.isFinite(reported) || reported <= 0) return null;
  return Math.min(Math.ceil(reported), VISUAL_FRAME_MAX_HEIGHT);
}

// A web address and nothing else: a scheme of two, a host with no
// credentials before it, and no space, control character or backslash
// anywhere (each a way to make one address read as another). React Native's
// `URL` does not parse, it pattern-matches, so the address is checked here
// whole.
const WEB_ADDRESS = /^https?:\/\/[^\s/?#@\\]+(?:[/?#][^\s\\]*)?$/i;

/** A web address a visual may hand out; null for any other scheme, for credentials, or for no address at all. */
export function externalVisualLink(href: string): string | null {
  if (href.length > MAX_LINK_LENGTH) return null;
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(href)) return null;
  return WEB_ADDRESS.test(href) ? href : null;
}

/** The host a link names, for the question asked before it opens. */
export function linkHost(href: string): string {
  return /^https?:\/\/([^/?#]+)/i.exec(href)?.[1] ?? href;
}

/**
 * One question per tap: after a link is offered, the next request waits this
 * long, so a script cannot stack up a pile of them.
 */
export const LINK_OFFER_COOLDOWN_MS = 1000;

/**
 * The address to offer for a page's link request, or null to ignore it. Only
 * from a visual that brings its own script (a static one's links are inert,
 * as the desktop strips them), only a web address, and not again within the
 * cooldown. The app cannot tell a tap from a script's request, so the person
 * is always asked before it opens.
 */
export function linkToOffer(
  href: string,
  gate: { scripted: boolean; now: number; lastOfferedAt: number | null },
): string | null {
  if (!gate.scripted) return null;
  if (gate.lastOfferedAt !== null && gate.now - gate.lastOfferedAt < LINK_OFFER_COOLDOWN_MS) return null;
  return externalVisualLink(href);
}

/**
 * The WebView's navigation gate: the host page's own first load, as the
 * artifact preview's gate admits it (`htmlSandbox.ts`), and the frame's
 * `srcdoc`, which iOS asks about as a navigation of its own. A `srcdoc` holds
 * only what the page put there and inherits its policy and its sandbox.
 * Everything else is refused, whatever it wears.
 */
export function createVisualNavigationGate(): SandboxNavigationGate {
  const page = createSandboxNavigationGate();
  return {
    allow: (url) => url === "about:srcdoc" || page.allow(url),
    noteLoadStart: () => page.noteLoadStart(),
  };
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

/** A name for the visual's frame: its title or first heading, as the desktop's frame is named. */
export function visualTitle(source: string): string {
  const match = /<(title|h[1-6]|figcaption|caption)\b[^>]*>([^<]{1,200})</i.exec(source);
  const text = match?.[2]
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ENTITIES[name] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "Visual";
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}
