// A ```visual block that brings its own <script>: a table that sorts, a chart
// with hover read-outs, a toggle between two views. Its scripts run, so the
// sanitizer the static path relies on (`visualDocument.ts`) cannot be the
// guard; the frame is. Four layers, each holding on its own:
//
// - The frame is sandboxed with `allow-scripts` and nothing else
//   (`SealedVisualFrame`): an opaque origin, so no cookies, no storage, no
//   reach into the app's document or its `window.api`; no popups, no top
//   navigation, no forms, no alerts or prints.
// - The document opens with a policy that refuses every load
//   (`SEALED_VISUAL_POLICY`): no fetch, socket, frame, worker, remote picture
//   or font, form target or base address. Inline script and style, and
//   pictures and fonts carried as data, are all it may use.
// - Main refuses every navigation of the frame itself, which no policy can
//   (`privileged-window-navigation.ts`, keyed on `SEALED_VISUAL_URL_PREFIX`).
// - Elements that only exist to load, frame, refresh or re-base a document
//   are taken out before it is built, so none is relied on the policy alone.
//
// The app and the frame speak only by postMessage, and only of three things:
// the content's height, the window's theme, and a link the person clicked
// (`sealedVisualMessages.ts`). A small reporter is put first in the document
// to send the height and take the theme, since without a shared origin the
// app cannot read the frame's document to measure it.

import { SEALED_VISUAL_CHANNEL, SEALED_VISUAL_URL_PREFIX } from '../../../../shared/sealed-visual'
import { baseStylesheet, MAX_VISUAL_SOURCE, VISUAL_EMPTY, VISUAL_TOO_LARGE, type VisualTheme } from './visualDocument'

/** Whether a visual's source asks to run: it carries a `<script>` element. */
export function hasVisualScript(source: string): boolean {
  return /<script[\s>/]/iu.test(source)
}

// `default-src 'none'` covers every fetch (connect, frame, child, worker,
// media, object, manifest, prefetch); `form-action` and `base-uri` do not fall
// back to it, so they are spelled out.
export const SEALED_VISUAL_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

// Elements that load, frame, refresh or re-base a document. Forms, buttons
// and inputs stay: a toggle is what a script is for, and the sandbox refuses
// to submit a form anywhere.
const REMOVED_ELEMENTS = 'meta, base, link, iframe, frame, frameset, object, embed, portal'

// Runs before anything the visual brings. Takes away peer connections, the
// one way out of a page the policy does not govern (a fresh frame could hand
// them back, so this narrows the gap rather than closing it). Sends the body's height whenever it
// changes, takes the window's theme as CSS variables on the root, and turns a
// click on a link into a request the app decides on: the frame never follows
// a link itself. The app checks every message it receives, so nothing here
// has to be trusted, and the visual's own script could send the same.
const REPORTER = `(function () {
  var host = window.parent, channel = ${JSON.stringify(SEALED_VISUAL_CHANNEL)}, last = -1;
  ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel'].forEach(function (name) {
    try { Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false }); } catch (error) {}
  });
  function send(message) { message.channel = channel; host.postMessage(message, '*'); }
  function report() {
    var body = document.body;
    if (!body) return;
    var height = Math.ceil(body.getBoundingClientRect().height);
    if (height !== last) { last = height; send({ type: 'height', height: height }); }
  }
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (event.source !== host || !data || data.channel !== channel || data.type !== 'theme') return;
    var root = document.documentElement.style, variables = data.variables || {};
    for (var name in variables) {
      if (/^--[a-z0-9-]+$/.test(name) && typeof variables[name] === 'string') root.setProperty(name, variables[name]);
    }
    if (typeof data.colorScheme === 'string') root.colorScheme = data.colorScheme;
  });
  document.addEventListener('DOMContentLoaded', function () {
    report();
    if (typeof ResizeObserver === 'function') new ResizeObserver(report).observe(document.body);
  });
  window.addEventListener('load', report);
  window.addEventListener('click', function (event) {
    var target = event.target, link = target && target.closest ? target.closest('a') : null;
    if (!link) return;
    var href = link.getAttribute('href') || link.getAttribute('xlink:href') || '';
    if (!href || href.charAt(0) === '#') return;
    event.preventDefault();
    if (event.isTrusted) send({ type: 'open-link', href: href });
  }, true);
})();`

// What a script visual adds to the static stylesheet: a link looks like one,
// since a click on it does something.
const SCRIPTED_STYLES = 'a[href] { color: var(--accent, inherit); text-decoration: underline; cursor: pointer; }'

/** A sealed visual's document as the address its frame loads, or why there is none. */
export type ScriptedVisualResult = { url: string; html: string; title: string } | { error: string }

function textOf(element: Element | null | undefined): string {
  return (element?.textContent ?? '').replace(/\s+/gu, ' ').trim()
}

/**
 * The document a ```visual block with scripts is shown as: the reporter and
 * the policy first, the base stylesheet in the theme it was built in, then the
 * block's own styles and scripts in their order. The theme is the one in force
 * when it is built; a later change is posted to the running frame, so a
 * switch of appearance does not restart the visual and lose its state.
 */
export function buildScriptedVisualDocument(source: string, theme: VisualTheme): ScriptedVisualResult {
  if (source.length > MAX_VISUAL_SOURCE) return { error: VISUAL_TOO_LARGE }
  // A parsed document runs nothing: scripts are inert until the frame loads them.
  const parsed = new DOMParser().parseFromString(source, 'text/html')
  for (const element of parsed.querySelectorAll(REMOVED_ELEMENTS)) element.remove()
  const head = [...parsed.head.querySelectorAll('style, script')].map((element) => element.outerHTML).join('')
  const body = parsed.body
  if (!textOf(body) && !body.querySelector('svg, img, canvas, script, input, button') && !head)
    return { error: VISUAL_EMPTY }
  const title =
    textOf(parsed.head.querySelector('title')) ||
    textOf(body.querySelector('h1, h2, h3, h4, h5, h6, figcaption, caption, svg > title')) ||
    'Interactive visual'
  const html =
    `<!doctype html><html><head>` +
    `<meta http-equiv="Content-Security-Policy" content="${SEALED_VISUAL_POLICY}">` +
    `<script>${REPORTER}</script>` +
    `<style>${baseStylesheet(theme)}\n${SCRIPTED_STYLES}</style>${head}</head>` +
    `<body>${body.innerHTML}</body></html>`
  return {
    url: `${SEALED_VISUAL_URL_PREFIX}${encodeURIComponent(html)}`,
    html,
    title: title.length > 120 ? `${title.slice(0, 119)}…` : title,
  }
}
