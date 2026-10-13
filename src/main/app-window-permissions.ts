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
// `local-fonts` is answered yes as well, to the request and to the check: it
// is how Settings ▸ Appearance lists the installed font families
// (`window.queryLocalFonts`). Chromium asks the check first and refuses the
// call outright when the answer is no, so granting the request alone would
// not be enough. It reads the names of the fonts on this computer and nothing
// else, in a window that only ever loads the app's own document.

type PermissionDetails = { mediaTypes?: ReadonlyArray<string> }

export function allowAppWindowPermissionRequest(permission: string, details: PermissionDetails | undefined): boolean {
  if (permission === 'local-fonts') return true
  return permission === 'media' && (details?.mediaTypes ?? []).length === 0
}

export function allowAppWindowPermissionCheck(permission: string): boolean {
  return permission === 'local-fonts'
}
