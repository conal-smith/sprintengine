import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import type { HtmlPreviewStore } from '../html-preview'

// A window's scripted HTML previews (main/html-preview.ts): registered by the
// window that shows one, gone when it closes the frame or the window.
export function registerHtmlPreviewIpc(ipcMain: IpcMain, store: HtmlPreviewStore): void {
  const watched = new WeakSet<object>()
  ipcMain.handle('html-preview:open', (event: IpcMainInvokeEvent, html: unknown) => {
    const sender = event.sender
    if (!watched.has(sender)) {
      watched.add(sender)
      sender.once('destroyed', () => store.release(sender.id))
    }
    return store.open(typeof html === 'string' ? html : '', sender.id)
  })
  ipcMain.handle('html-preview:close', (event: IpcMainInvokeEvent, url: unknown) => {
    if (typeof url === 'string') store.close(url, event.sender.id)
  })
}
