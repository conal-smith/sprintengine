import { MODULE_ASSET_SCHEME } from './modules/assets'

// The desktop app window's Content-Security-Policy: a `<meta>` the renderer
// build puts at the top of index.html (renderer.vite.config.ts), so it holds
// under `file://`, where no response carries headers, and under the dev server
// alike. Every app window loads that document: the workspace windows,
// Diagnostics, and the diff, editor and pane windows.
//
// What it is for: transcripts, file previews and pull request bodies are
// written by agents and other people, and the renderer is the window with
// `window.api` on it. `react-markdown` renders no raw HTML; this is the line
// behind that. No script from anywhere but the app's own files (and the blob
// modules the app makes itself), no string evaluated as code, no plugin
// content, no `<base>` rewriting where relative URLs go, and nothing fetched
// from a server the app did not choose.
//
// What each allowance is for:
//   * script-src blob: — a trusted third-party module's renderer half is
//     imported from a blob URL (modules/third-party-loader.ts).
//   * script-src 'wasm-unsafe-eval' — code highlighting compiles its regex
//     engine from WebAssembly (lib/highlight/codeHighlight.ts). It lets a
//     WebAssembly module compile; it does not let a string become script.
//   * worker-src 'self' blob: — the editor's language workers.
//   * style-src 'unsafe-inline' — the editor, the canvas, the diagram renderer
//     and React's style props all write inline styles.
//   * img-src https: http: — avatars, and images in Markdown, from the web.
//   * studio-module: — a trusted, turned-on module's own files (its pages,
//     scripts, workers, media and fonts; main/modules/module-assets.ts), which
//     it addresses through `getAssetUrl`. Main serves nothing else there.
//   * frame-src studio-preview: — an HTML artifact shown with its scripts on,
//     as a document of its own (main/html-preview.ts); every other frame the
//     app draws is a `srcdoc`, which takes this policy with it.
//
// The browser pane's `<webview>` guests are not frames of this document and
// are not governed by it; their own policy is in browser/guest-policy.ts.
//
// Under the dev server the module graph is served by Vite, whose React
// refresh preamble is an inline script and whose hot reload is a socket to its
// own origin, so the dev policy allows both. Nothing else differs.

const MODULE_ASSET_SOURCE = `${MODULE_ASSET_SCHEME}:`
export const HTML_PREVIEW_SCHEME = 'studio-preview'

export type DesktopCspInput = {
  /** The dev server's origin, when the window is served by one. */
  devServerOrigin?: string | null
}

export function desktopContentSecurityPolicy(input: DesktopCspInput = {}): string {
  const dev = input.devServerOrigin ? new URL(input.devServerOrigin) : null
  const devSocket = dev ? `${dev.protocol === 'https:' ? 'wss:' : 'ws:'}//${dev.host}` : null
  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", 'blob:', MODULE_ASSET_SOURCE, "'wasm-unsafe-eval'", ...(dev ? ["'unsafe-inline'"] : [])]],
    ['worker-src', ["'self'", 'blob:', MODULE_ASSET_SOURCE]],
    ['style-src', ["'self'", "'unsafe-inline'", MODULE_ASSET_SOURCE]],
    ['img-src', ["'self'", 'data:', 'blob:', 'https:', 'http:', MODULE_ASSET_SOURCE]],
    ['font-src', ["'self'", 'data:', MODULE_ASSET_SOURCE]],
    ['media-src', ["'self'", 'data:', 'blob:', MODULE_ASSET_SOURCE]],
    ['connect-src', ["'self'", 'data:', 'blob:', MODULE_ASSET_SOURCE, ...(devSocket ? [devSocket] : [])]],
    ['frame-src', ["'self'", 'blob:', MODULE_ASSET_SOURCE, `${HTML_PREVIEW_SCHEME}:`]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'none'"]],
  ]
  return directives.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ')
}

/**
 * The app document with its policy right after the charset: before anything
 * the document loads, and with the charset still in the first 1024 bytes,
 * where it has to be.
 */
export function withDesktopContentSecurityPolicy(html: string, devServerOrigin: string | null = null): string {
  const charset = /<meta charset="UTF-8"\s*\/?>/i.exec(html)
  if (!charset) throw new Error('index.html has no <meta charset="UTF-8">, which the policy is placed after.')
  const at = charset.index + charset[0].length
  const policy = desktopContentSecurityPolicy({ devServerOrigin })
  return `${html.slice(0, at)}\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />${html.slice(at)}`
}
