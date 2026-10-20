import { showToast } from '../store/toastStore'

/** What to copy: the text itself, or a function that builds it at click time. */
export type ClipboardTextSource = string | (() => string | Promise<string>)

export type CopyToClipboardOptions = {
  /**
   * A `text/html` flavour written beside the plain text, so a paste into a rich
   * editor keeps its structure while a paste into a terminal still gets text.
   * A function is resolved only when the copy happens.
   */
  html?: string | (() => string)
  /**
   * How a successful copy is confirmed. `toast` (the default) raises the shared
   * "Copied" toast; `silent` leaves it to the caller, for a control that
   * confirms in place — a toast in the corner for a glyph that already swapped
   * under the pointer is the same news twice, and far from the eye. Failure
   * toasts either way: a copy that did not land must never look like one that
   * did.
   */
  success?: 'toast' | 'silent'
}

// Plain text goes through the main-process bridge when the app has one: an
// Electron renderer's `navigator.clipboard` needs document focus, so a write
// fired from a menu or a popover could resolve without landing. The browser API
// stays as the fallback for a host without the bridge (a test host, a preview).
async function writePlainText(text: string): Promise<void> {
  const bridge = typeof window === 'undefined' ? undefined : window.api?.clipboardWriteText
  if (typeof bridge === 'function') {
    await bridge(text)
    return
  }
  await navigator.clipboard.writeText(text)
}

// Both flavours, through the main-process bridge when the app has one, for the
// same reason as the plain write and one more: the window refuses the page's
// own clipboard permission, so `navigator.clipboard.write` is refused in the
// app. A host without the bridge (a browser tab) uses the browser API, where a
// click is permission enough. `false` sends the caller down the plain-text path
// rather than failing the copy: the text is the part a user can never do
// without.
async function writeRichText(text: string, html: string): Promise<boolean> {
  const bridge = typeof window === 'undefined' ? undefined : window.api?.clipboardWriteRich
  if (typeof bridge === 'function') {
    try {
      await bridge({ text, html })
      return true
    } catch {
      return false
    }
  }
  if (typeof ClipboardItem !== 'function' || typeof navigator.clipboard?.write !== 'function') return false
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      }),
    ])
    return true
  } catch {
    return false
  }
}

/**
 * The renderer's one "copy this for the user" path. Resolves the source, writes
 * it, and reports through the shared toast. Never throws; the boolean says
 * whether the text landed, so a caller can confirm only a real copy.
 */
export async function copyToClipboardWithToast(
  source: ClipboardTextSource,
  options: CopyToClipboardOptions = {},
): Promise<boolean> {
  try {
    // Resolved inside the try: a builder that throws is a failed copy and
    // reports like one, not an unhandled rejection behind a click.
    const text = typeof source === 'function' ? await source() : source
    const html = typeof options.html === 'function' ? options.html() : options.html
    if (html === undefined || !(await writeRichText(text, html))) await writePlainText(text)
    if (options.success !== 'silent') showToast({ tone: 'good', title: 'Copied' })
    return true
  } catch {
    showToast({ tone: 'error', title: 'Could not copy to clipboard' })
    return false
  }
}
