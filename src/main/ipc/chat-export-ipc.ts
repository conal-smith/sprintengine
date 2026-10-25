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
// A chat followed from a paired machine has no transcript here to read: the
// window that follows it hands over the events it read from that machine,
// each checked as the protocol checks one off the wire, and main still asks
// where to save.

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
    const remote = (raw as { remote?: unknown }).remote
    let input: ChatExportInput = parsed.input
    if (remote !== undefined) {
      const { parseChatExportRemoteSource } = await import('../chat-export/chat-export-source')
      const source = parseChatExportRemoteSource(remote)
      if (!source) return { ok: false, message: "That chat's transcript could not be read." }
      input = { ...input, remote: source }
    }
    try {
      return await deps.run(input, event.sender)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The chat could not be exported.' }
    }
  })
}
