// What the app's own windows may be granted when a page in them asks.
//
// The handlers stay installed even though the app asks for almost nothing: a
// session with no permission request handler grants every request, so dropping
// them would hand the microphone and camera to whatever the window loads.
//
// One `media` request is answered yes: a request that names no capture
// device. That is how `getDisplayMedia` arrives — Chromium routes it through
// the permission handler first, with an empty `mediaTypes` — and the browser
// pane records a tab that way (`browser/recording-encoder.ts`), whose
// display-media handler then grants only the capture it armed. A request for
// the microphone or the camera names `audio` or `video` and is refused.
//
// `local-fonts` is answered yes as well, to the request and to the check, but
// only for the app's own document in the window's main frame: it is how
// Settings ▸ Appearance lists the installed font families
// (`window.queryLocalFonts`). Chromium asks the check first and refuses the
// call outright when the answer is no, so granting the request alone would
// not be enough. The session also hosts frames that are not the app — an
// agent's HTML in a sandboxed srcdoc frame, the canvas worker's page — and
// none of them has any business reading the fonts on this computer, so the
// requester is checked rather than the permission alone.

import { isAppDocument } from './privileged-window-navigation'

type PermissionDetails = { mediaTypes?: ReadonlyArray<string> }

/** Who is asking, as Electron describes it to both handlers. */
type PermissionRequester = { requestingUrl?: string; isMainFrame?: boolean }

/**
 * The app's own document in a main frame. Stricter than the navigation guard's
 * `isAppDocument`, which accepts any page on the dev server: here the page
 * must be the app's own path too, so the canvas worker's page on the same
 * origin does not count.
 */
function isAppMainFrame(requester: PermissionRequester | undefined, app: URL): boolean {
  if (requester?.isMainFrame !== true || !requester.requestingUrl) return false
  if (!isAppDocument(requester.requestingUrl, app)) return false
  try {
    return new URL(requester.requestingUrl).pathname === app.pathname
  } catch {
    return false
  }
}

export function allowAppWindowPermissionRequest(
  permission: string,
  details: (PermissionDetails & PermissionRequester) | undefined,
  app: URL,
): boolean {
  if (permission === 'local-fonts') return isAppMainFrame(details, app)
  return permission === 'media' && (details?.mediaTypes ?? []).length === 0
}

export function allowAppWindowPermissionCheck(
  permission: string,
  details: PermissionRequester | undefined,
  app: URL,
): boolean {
  return permission === 'local-fonts' && isAppMainFrame(details, app)
}
