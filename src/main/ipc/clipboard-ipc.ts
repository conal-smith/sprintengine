import { clipboard, ClipboardItem, type IpcMain } from 'electron'

/**
 * The most either flavour of a rich write may carry, in UTF-16 units. A whole
 * transcript copied as one stays far below it; a renderer handing main more
 * than this is not copying something a person could read.
 */
export const MAX_RICH_CLIPBOARD_CHARS = 16 * 1024 * 1024

export type RichClipboardPayload = { text: string; html: string }

/**
 * What `clipboard:write-rich` accepts: an object holding a string `text` and a
 * string `html`, each within the size above. Anything else throws, so a bad
 * call rejects in the renderer rather than writing half a clipboard.
 */
export function richClipboardPayload(value: unknown): RichClipboardPayload {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('clipboard:write-rich expects { text, html }')
  }
  const { text, html } = value as Record<string, unknown>
  if (typeof text !== 'string' || typeof html !== 'string') {
    throw new TypeError('clipboard:write-rich expects string text and html')
  }
  if (text.length > MAX_RICH_CLIPBOARD_CHARS || html.length > MAX_RICH_CLIPBOARD_CHARS) {
    throw new RangeError('clipboard:write-rich payload is too large')
  }
  return { text, html }
}

export function registerClipboardIpc(ipcMain: IpcMain): void {
  ipcMain.handle('clipboard:read-text', () => clipboard.readText())
  ipcMain.handle('clipboard:write-text', (_event, text: unknown) => {
    if (typeof text !== 'string') {
      throw new TypeError('clipboard:write-text expects a string payload')
    }
    return clipboard.writeText(text)
  })
  // Both flavours in one write, from main: the renderer's own rich write
  // (`navigator.clipboard.write`) asks the window's permission handler, which
  // refuses it, and needs the page focused besides, so a copy from a menu or a
  // glyph would land as plain text or not at all.
  ipcMain.handle('clipboard:write-rich', (_event, payload: unknown) => {
    const { text, html } = richClipboardPayload(payload)
    return clipboard.write([new ClipboardItem({ 'text/plain': text, 'text/html': html })])
  })
}
