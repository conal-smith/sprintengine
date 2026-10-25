import { dirname, join } from 'node:path'

import type { ChatExportFileFormat, ChatExportInput, ChatExportResult } from '../../shared/chat-export'
import type { ConversationTranscriptInput } from '../../shared/conversation-runtime'
import { writeChatClipboardHtml } from './chat-export-clipboard'
import { buildChatExportDocument, chatExportHasMessages, type ChatExportDocument } from './chat-export-document'
import { writeChatExportDocx } from './chat-export-docx'
import { chatExportFileName, markdownAssetFolder } from './chat-export-filename'
import { paperSizeForRegion } from './chat-export-format'
import { buildChatExportHtml } from './chat-export-html'
import { writeChatExportMarkdown } from './chat-export-markdown'
import type { ChatExportSourceWire } from './chat-export-source'

// Export chat, start to end: find the chat, read its transcript, build the
// export's model, and then either ask where to save and write the file, or
// put the chat on the clipboard. Everything that touches Electron or the disk
// is handed in, so the order is tested without either
// (chat-export-electron.ts binds the real ones).

/** What the export needs to know about the chat besides its transcript, read from its workspace. */
export type ChatExportChat = {
  title: string
  project: string | null
  providerId: string | null
  modelId: string | null
  /** The folder its transcript is kept under, and its steps' paths are read against. */
  workspaceRoot: string
}

export type ChatExportDeps = {
  /** The chat in its workspace, or null when there is no such chat, or it is not a conversation. */
  chat(workspaceId: string, agentId: string): ChatExportChat | null
  readSource(
    key: ConversationTranscriptInput,
  ): Promise<{ ok: true; source: ChatExportSourceWire } | { ok: false; message: string }>
  /** The CLI's name, by the chat's provider ("Claude Code"). */
  engineName(providerId: string | null): string | null
  /** The save dialog: where to write, or null when it was dismissed. */
  pickSavePath(input: { defaultPath: string; format: ChatExportFileFormat }): Promise<string | null>
  /** The folder the dialog opens in. */
  defaultDirectory(): string
  renderPdf(html: string, paper: 'A4' | 'Letter'): Promise<Buffer>
  writeFile(path: string, data: Uint8Array | string): Promise<void>
  makeDirectory(path: string): Promise<void>
  writeClipboard(data: { text: string; html?: string }): Promise<void>
  now(): number
  locale(): string
  timeZone(): string
  /** The region the paper size follows ("US" prints on Letter). */
  region(): string | null
}

export async function runChatExport(input: ChatExportInput, deps: ChatExportDeps): Promise<ChatExportResult> {
  // A chat followed from a paired machine comes with its transcript, read
  // from that machine by the window following it; its pictures stay there.
  const { remote } = input
  const chat: ChatExportChat | null = remote
    ? {
        title: remote.title,
        project: remote.project,
        providerId: remote.providerId,
        modelId: remote.modelId,
        workspaceRoot: remote.workspaceRoot,
      }
    : deps.chat(input.workspaceId, input.agentId)
  if (!chat) return { ok: false, message: 'This chat could not be found.' }
  const read = remote
    ? { ok: true as const, source: { events: remote.events, attachments: {} } }
    : await deps.readSource({
        workspaceRoot: chat.workspaceRoot,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
      })
  if (!read.ok) return { ok: false, message: read.message }
  const exportedAt = deps.now()
  const timeZone = deps.timeZone()
  const document = buildChatExportDocument(
    {
      events: read.source.events,
      attachments: new Map(
        Object.entries(read.source.attachments).map(([ref, picture]) => [
          ref,
          { mediaType: picture.mediaType, data: new Uint8Array(Buffer.from(picture.dataBase64, 'base64')) },
        ]),
      ),
    },
    {
      title: chat.title,
      project: chat.project,
      engine: deps.engineName(chat.providerId),
      model: chat.modelId,
      workspaceRoot: chat.workspaceRoot,
      exportedAt,
      locale: deps.locale(),
      timeZone,
    },
  )
  if (!chatExportHasMessages(document)) return { ok: false, message: 'This chat has no messages to export yet.' }

  if (input.action === 'copy' || input.action === 'copy-markdown') {
    const { markdown } = writeChatExportMarkdown(document, null)
    await deps.writeClipboard(
      input.action === 'copy' ? { text: markdown, html: writeChatClipboardHtml(document) } : { text: markdown },
    )
    return { ok: true, kind: 'copied' }
  }

  const format = input.action
  const fileName = chatExportFileName(document.title, format, exportedAt, timeZone)
  const path = await deps.pickSavePath({ defaultPath: join(deps.defaultDirectory(), fileName), format })
  if (!path) return { ok: true, kind: 'cancelled' }
  try {
    await writeExport(document, format, path, deps)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'The file could not be written.' }
  }
  return { ok: true, kind: 'saved', path, fileName: path.split(/[\\/]/u).at(-1) ?? fileName }
}

async function writeExport(
  document: ChatExportDocument,
  format: ChatExportFileFormat,
  path: string,
  deps: ChatExportDeps,
): Promise<void> {
  const paper = paperSizeForRegion(deps.region())
  switch (format) {
    case 'pdf':
      return deps.writeFile(path, await deps.renderPdf(buildChatExportHtml(document), paper))
    case 'docx':
      return deps.writeFile(path, await writeChatExportDocx(document, { paper }))
    case 'markdown': {
      // The pictures go in a folder named after the file the person chose.
      const folder = markdownAssetFolder(path.split(/[\\/]/u).at(-1) ?? 'chat.md')
      const { markdown, files } = writeChatExportMarkdown(document, folder)
      if (files.length) await deps.makeDirectory(join(dirname(path), folder))
      for (const file of files) await deps.writeFile(join(dirname(path), file.path), file.data)
      return deps.writeFile(path, markdown)
    }
  }
}
