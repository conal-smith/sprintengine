import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'

import {
  CHAT_EXPORT_CHANNEL,
  parseChatExportInput,
  type ChatExportInput,
  type ChatExportResult,
} from '../../shared/chat-export'
import { assertAppSender } from './ipc-sender'

// Export chat's channel. The window says which chat and what to make of it,
// and nothing more: no path, no title, no text. Main finds the chat in its
// workspace, reads the transcript itself, shows the save dialog itself and
// writes where the person chose, so a page that reached the preload cannot
// make this write anything anywhere. Only the app's own window is answered.

export function registerChatExportIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  deps: {
    /** The export itself, loaded when first asked for: it brings the Word writer and the typesetter. */
    run(input: ChatExportInput, sender: WebContents): Promise<ChatExportResult>
    /** Test seam; the real check refuses anything but the app's own window. */
    assertSender?: (event: IpcMainInvokeEvent) => void
  },
): void {
  const assertSender = deps.assertSender ?? assertAppSender
  ipcMain.handle(CHAT_EXPORT_CHANNEL, async (event: IpcMainInvokeEvent, raw: unknown): Promise<ChatExportResult> => {
    assertSender(event)
    const parsed = parseChatExportInput(raw)
    if (!parsed.ok) return parsed
    try {
      return await deps.run(parsed.input, event.sender)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The chat could not be exported.' }
    }
  })
}
