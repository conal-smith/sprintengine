import type { ChatExportFileFormat } from '../../shared/chat-export'

// The name an export is offered under: the chat's title made safe as a file
// name on every system the file may travel to, then the day it was exported,
// "Release SprintEngine Studio – 2026-10-20.pdf". The save dialog lets the
// person change it; this is only the suggestion, and what a test run writes.

export const CHAT_EXPORT_EXTENSIONS: Readonly<Record<ChatExportFileFormat, string>> = {
  pdf: 'pdf',
  docx: 'docx',
  markdown: 'md',
}

/** Long enough to say what the chat was, short enough to leave room for the date and the folder. */
const MAX_TITLE_LENGTH = 80

// Names Windows keeps for devices, whatever their extension.
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu

/**
 * A title as a file name: no path separators or characters Windows refuses, no
 * control characters, no leading dot that would hide it, no trailing dot or
 * space Windows drops, runs of space as one, at most `MAX_TITLE_LENGTH`
 * characters. "Chat" when nothing is left.
 */
export function sanitizeExportTitle(title: string): string {
  let name = title
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/[<>:"/\\|?*]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^[.\s]+/u, '')
  if ([...name].length > MAX_TITLE_LENGTH) name = [...name].slice(0, MAX_TITLE_LENGTH).join('').trim()
  name = name.replace(/[.\s]+$/u, '')
  if (!name || RESERVED.test(name)) return name ? `${name} chat` : 'Chat'
  return name
}

/** The local calendar day, as a file name sorts it. */
export function exportDateStamp(at: number, timeZone?: string): string {
  try {
    // Swedish writes a date as ISO does.
    return new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(at)
  } catch {
    return new Date(at).toISOString().slice(0, 10)
  }
}

export function chatExportFileName(
  title: string,
  format: ChatExportFileFormat,
  exportedAt: number,
  timeZone?: string,
): string {
  return `${sanitizeExportTitle(title)} – ${exportDateStamp(exportedAt, timeZone)}.${CHAT_EXPORT_EXTENSIONS[format]}`
}

/** The folder a Markdown export's pictures go in, beside it: its name without the extension. */
export function markdownAssetFolder(fileName: string): string {
  return `${fileName.replace(/\.[^.]+$/u, '')}-files`
}
