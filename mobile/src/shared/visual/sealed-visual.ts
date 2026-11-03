// A ```visual block that carries its own <script> runs in a sealed frame
// (`components/ui/SealedVisualFrame.tsx`): scripts on, an opaque origin, no
// network. Its document is loaded from a `data:` address that starts with this
// prefix, so main can tell the frame apart from every other frame in a window
// and refuse to let it navigate anywhere (`privileged-window-navigation.ts`).
// A page that forges the prefix only seals itself.
export const SEALED_VISUAL_URL_PREFIX = 'data:text/html;charset=utf-8;sprintengine-visual=sealed,'

/** The `channel` every message between a sealed visual and the app carries. */
export const SEALED_VISUAL_CHANNEL = 'sprintengine-visual'

/** Whether a frame's address is a sealed visual's. */
export function isSealedVisualUrl(url: string | undefined | null): boolean {
  return typeof url === 'string' && url.startsWith(SEALED_VISUAL_URL_PREFIX)
}
